import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectPlaywrightBackend, preparePlaywrightBackend } from '../lib/setup.mjs';
import { ShoppingError, publicError } from '../lib/errors.mjs';

const VERSION = '1.65.0-alpha-2026-10-30';
const PACKAGES = {
  '@playwright/mcp': { name: '@playwright/mcp', version: '0.0.84', dependencies: { playwright: VERSION, 'playwright-core': VERSION } },
  playwright: { name: 'playwright', version: VERSION, dependencies: { 'playwright-core': VERSION } },
  'playwright-core': { name: 'playwright-core', version: VERSION },
};
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: {} });
const FORBIDDEN_TEXT = 'synthetic-installer-private-text';

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping playwright setup '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function installPackages(root) {
  for (const [name, manifest] of Object.entries(PACKAGES)) {
    const location = path.join(root, 'node_modules', name);
    await mkdir(location, { recursive: true });
    await writeFile(path.join(location, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(location, 'cli.js'), '// Synthetic component; never executed.\n');
  }
}

async function fixture(t, { installed = false, stamped = false } = {}) {
  const root = await directory(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@playwright/mcp': '0.0.84' } }));
  await writeFile(path.join(root, 'package-lock.json'), LOCK);
  if (installed) await installPackages(root);
  if (stamped) await writeFile(path.join(root, '.install-stamp.json'), JSON.stringify({
    schema_version: 1, lock_hash: createHash('sha256').update(LOCK).digest('hex'),
  }));
  return root;
}

function installer(root, { action = installPackages, code = 0, error = false } = {}) {
  const calls = [];
  const dependencies = {
    findNpmCli: async () => path.join(root, 'synthetic-npm-cli.js'),
    spawnProcess(executable, args, options) {
      calls.push({ executable, args, options });
      const child = new EventEmitter();
      child.kill = () => { throw new Error('Unexpected installer kill.'); };
      queueMicrotask(async () => {
        try {
          await action(root);
          if (error) child.emit('error', new Error(FORBIDDEN_TEXT));
          else child.emit('exit', code);
        } catch (failure) { child.emit('error', failure); }
      });
      return child;
    },
  };
  return { calls, dependencies };
}

const noInstaller = {
  findNpmCli: async () => { throw new Error('Inspection must not locate npm.'); },
  spawnProcess: () => { throw new Error('Inspection must not start a process.'); },
};

test('Playwright inspection of an absent directory does not create files or run an installer', async t => {
  const root = path.join(await directory(t), 'absent');
  const plan = await preparePlaywrightBackend({ directory: root }, noInstaller);
  assert.equal(plan.installed, false);
  assert.equal(plan.changed, false);
  assert.equal(plan.install_requested, false);
  assert.deepEqual(plan.expected_versions, { '@playwright/mcp': '0.0.84', playwright: VERSION, 'playwright-core': VERSION });
  await assert.rejects(access(root), { code: 'ENOENT' });
});

test('Playwright inspection does not resolve packages from a parent or global installation', async t => {
  const parent = await fixture(t, { installed: true, stamped: true });
  const child = path.join(parent, 'nested-backend');
  assert.equal((await inspectPlaywrightBackend(child)).installed, false);
});

test('all three pinned packages, dependency links and entry points are required', async t => {
  for (const name of Object.keys(PACKAGES)) {
    await t.test(name, async t => {
      const root = await fixture(t, { installed: true, stamped: true });
      const packageRoot = path.join(root, 'node_modules', name);
      assert.equal((await inspectPlaywrightBackend(root)).installed, true);
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ ...PACKAGES[name], version: '99.0.0' }));
      assert.equal((await inspectPlaywrightBackend(root)).installed, false);
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ ...PACKAGES[name], name: 'unrelated' }));
      assert.equal((await inspectPlaywrightBackend(root)).installed, false);
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(PACKAGES[name]));
      await rm(path.join(packageRoot, 'cli.js'));
      assert.equal((await inspectPlaywrightBackend(root)).installed, false);
      await mkdir(path.join(packageRoot, 'cli.js'));
      assert.equal((await inspectPlaywrightBackend(root)).installed, false);
    });
  }
  for (const name of ['@playwright/mcp', 'playwright']) {
    const root = await fixture(t, { installed: true, stamped: true });
    await writeFile(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ ...PACKAGES[name], dependencies: {} }));
    assert.equal((await inspectPlaywrightBackend(root)).installed, false);
  }
});

test('malformed and missing package manifests report an incomplete installation', async t => {
  for (const text of ['{', 'null', '[]']) {
    const root = await fixture(t, { installed: true });
    await writeFile(path.join(root, 'node_modules/@playwright/mcp/package.json'), text);
    assert.equal((await inspectPlaywrightBackend(root)).installed, false);
  }
  const root = await fixture(t, { installed: true });
  await rm(path.join(root, 'node_modules/playwright-core/package.json'));
  assert.equal((await inspectPlaywrightBackend(root)).installed, false);
});

test('lock verification distinguishes a complete installation from a stamped one', async t => {
  const root = await fixture(t, { installed: true });
  const initial = await inspectPlaywrightBackend(root);
  assert.equal(initial.installed, true);
  assert.equal(initial.lock_verified, false);
  assert.equal(initial.cli, path.join(root, 'node_modules/@playwright/mcp/cli.js'));
  for (const stamp of ['{', JSON.stringify({ schema_version: 2, lock_hash: createHash('sha256').update(LOCK).digest('hex') })]) {
    await writeFile(path.join(root, '.install-stamp.json'), stamp);
    assert.equal((await inspectPlaywrightBackend(root)).lock_verified, false);
  }
});

test('Playwright installation uses the running Node, locked npm ci and no browser download', async t => {
  const root = await fixture(t);
  const beforeLock = await readFile(path.join(root, 'package-lock.json'));
  const fake = installer(root);
  const result = await preparePlaywrightBackend({ directory: root, install: true }, fake.dependencies);
  assert.equal(result.installed, true);
  assert.equal(result.lock_verified, true);
  assert.equal(result.changed, true);
  assert.equal(result.install_requested, true);
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call.executable, process.execPath);
  assert.deepEqual(call.args, [path.join(root, 'synthetic-npm-cli.js'), 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', '--fetch-retries=1', '--fetch-timeout=20000', '--cache', path.join(root, '.npm-cache')]);
  assert.equal(call.options.cwd, root);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
  const stampPath = path.join(root, '.install-stamp.json');
  assert.deepEqual(JSON.parse(await readFile(stampPath, 'utf8')), {
    schema_version: 1, lock_hash: createHash('sha256').update(beforeLock).digest('hex'),
  });
  if (process.platform !== 'win32') assert.equal((await stat(stampPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(path.join(root, 'package-lock.json')), beforeLock);
  await assert.rejects(access(path.join(root, '.install.lock')), { code: 'ENOENT' });
  const reused = await preparePlaywrightBackend({ directory: root, install: true }, noInstaller);
  assert.equal(reused.changed, false);
  assert.equal(reused.lock_verified, true);
});

test('a changed lock triggers installation again, then stamps the new lock', async t => {
  const root = await fixture(t, { installed: true, stamped: true });
  await writeFile(path.join(root, 'package-lock.json'), `${LOCK}\n`);
  assert.equal((await inspectPlaywrightBackend(root)).lock_verified, false);
  const fake = installer(root);
  const result = await preparePlaywrightBackend({ directory: root, install: true }, fake.dependencies);
  assert.equal(result.changed, true);
  assert.equal(fake.calls.length, 1);
  assert.equal((await inspectPlaywrightBackend(root)).lock_verified, true);
});

test('a missing lock or invalid options fail without invoking an installer', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'package-lock.json'));
  await assert.rejects(preparePlaywrightBackend({ directory: root, install: true }, noInstaller), { code: 'DEPENDENCY_LOCK_MISSING' });
  await assert.rejects(preparePlaywrightBackend({ directory: root, install: 'yes' }, noInstaller), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(inspectPlaywrightBackend('relative'), { code: 'INVALID_BACKEND_DIRECTORY' });
});

test('an installation lock prevents a second installer and is not removed by it', async t => {
  const root = await fixture(t);
  const lock = path.join(root, '.install.lock');
  await writeFile(lock, 'synthetic-active-installation');
  const fake = installer(root);
  await assert.rejects(preparePlaywrightBackend({ directory: root, install: true }, fake.dependencies), { code: 'INSTALL_IN_PROGRESS' });
  assert.equal(fake.calls.length, 0);
  assert.equal(await readFile(lock, 'utf8'), 'synthetic-active-installation');
});

test('installer errors are safe, release the lock and allow an explicit later install', async t => {
  for (const scenario of [{ code: 1 }, { error: true }]) {
    const root = await fixture(t);
    const fake = installer(root, { action: async () => {}, ...scenario });
    await assert.rejects(preparePlaywrightBackend({ directory: root, install: true }, fake.dependencies), error => {
      assert.equal(error.code, 'INSTALL_FAILED');
      assert.ok(!JSON.stringify(publicError(error)).includes(FORBIDDEN_TEXT));
      return true;
    });
    await assert.rejects(access(path.join(root, '.install.lock')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(root, '.install-stamp.json')), { code: 'ENOENT' });
    const retry = installer(root);
    assert.equal((await preparePlaywrightBackend({ directory: root, install: true }, retry.dependencies)).lock_verified, true);
  }
});

test('a synchronous spawn failure and missing npm are reported without installation stamps', async t => {
  const root = await fixture(t);
  const dependencies = { findNpmCli: async () => 'synthetic-npm-cli.js', spawnProcess: () => { throw new Error(FORBIDDEN_TEXT); } };
  await assert.rejects(preparePlaywrightBackend({ directory: root, install: true }, dependencies), { code: 'INSTALL_FAILED' });
  dependencies.findNpmCli = async () => { throw new ShoppingError('NPM_MISSING', 'Synthetic npm is absent.'); };
  await assert.rejects(preparePlaywrightBackend({ directory: root, install: true }, dependencies), { code: 'NPM_MISSING' });
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.install')));
});

test('an incomplete npm result is not marked installed and leaves no temporary files', async t => {
  const root = await fixture(t);
  const fake = installer(root, { action: async root => {
    await installPackages(root);
    await rm(path.join(root, 'node_modules/playwright/cli.js'));
  } });
  await assert.rejects(preparePlaywrightBackend({ directory: root, install: true }, fake.dependencies), { code: 'INSTALL_INCOMPLETE' });
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.install')));
});

test('installation timeout terminates only the fake installer and clears its timers and lock', async t => {
  const root = await fixture(t);
  const child = new EventEmitter();
  const killed = [], timers = [];
  let spawned;
  const started = new Promise(resolve => { spawned = resolve; });
  child.kill = signal => { killed.push(signal ?? 'SIGTERM'); return true; };
  const pending = preparePlaywrightBackend({ directory: root, install: true }, {
    findNpmCli: async () => 'synthetic-npm-cli.js',
    spawnProcess: () => { spawned(); return child; },
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; },
  });
  const rejected = assert.rejects(pending, { code: 'INSTALL_TIMEOUT' });
  await started;
  assert.equal(timers[0].ms, 120000);
  timers[0].callback();
  assert.equal(timers[1].ms, 3000);
  timers[1].callback();
  child.emit('exit', null);
  await rejected;
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']);
  assert.ok(timers.every(timer => timer.cleared));
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.install')));
});
