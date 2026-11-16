import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findPrivateMarkers, selectPackageFiles, stripOutsideLinks } from '../lib/package-contents.mjs';
import { buildPackage } from '../lib/package-build.mjs';

const run = promisify(execFile);
// Assembled at runtime so this file itself passes the package privacy check.
const HOME_PATH = ['', 'Users', 'alice', 'state'].join('/');
const WINDOWS_HOME = ['C:', 'Users', 'bob', 'skill'].join('\\');
const PHONE = '138' + '12345678';
const git = (cwd, ...args) => run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });

test('the package keeps the allowlisted skill files and leaves history, state and dependencies out', () => {
  const tracked = ['SKILL.md', 'SKILL-HISTORY.md', 'README.md', 'README.en.md', 'LICENSE', 'README-HISTORY.md', 'package.json', '.gitignore',
    'lib/cli.mjs', 'scripts/shopping.mjs', 'references/tasks.md', 'examples/data/a.json', 'test/a.test.mjs', 'test-support/f.mjs',
    'runtime/playwright-backend/package.json', 'runtime/playwright-backend/package-lock.json', 'runtime/playwright-backend/node_modules/x.js',
    'runtime/playwright-backend/.install-stamp.json', 'runtime/browser-backend/package.json', 'runtime/browser-backend/package-lock.json',
    '.runtime/state.json', '.runtime/pw-ext-token', 'notes.md'];
  assert.deepEqual(selectPackageFiles(tracked), ['.gitignore', 'LICENSE', 'README.en.md', 'README.md', 'SKILL.md', 'examples/data/a.json', 'lib/cli.mjs', 'package.json',
    'references/tasks.md', 'runtime/playwright-backend/package-lock.json', 'runtime/playwright-backend/package.json', 'scripts/shopping.mjs',
    'test-support/f.mjs', 'test/a.test.mjs']);
  for (const unsafe of ['../outside.md', '/etc/passwd', 'lib\\cli.mjs']) {
    assert.throws(() => selectPackageFiles([unsafe]), { code: 'INVALID_PACKAGE_PATH' });
  }
});

test('links to files outside the package become plain text while package, web and anchor links stay', () => {
  const packaged = new Set(['references/tasks.md', 'examples/data/a.json', 'SKILL.md']);
  const markdown = ['[任务](tasks.md#恢复)', '[记录](../../output/r.md#结果)', '[网页](https://example.com/a)', '[本节](#用法)',
    '[历史](../SKILL-HISTORY.md)', '[示例目录](../examples/)', '![截图](../../output/p.png)', '[入口](../SKILL.md)'].join('\n');
  const { text, removed } = stripOutsideLinks(markdown, 'references/x.md', packaged);
  assert.equal(removed, 3);
  assert.equal(text, ['[任务](tasks.md#恢复)', '记录', '[网页](https://example.com/a)', '[本节](#用法)', '历史', '[示例目录](../examples/)',
    '截图', '[入口](../SKILL.md)'].join('\n'));
});

test('private markers name local home paths and phone numbers without flagging product IDs', () => {
  assert.deepEqual(findPrivateMarkers(`saved in ${HOME_PATH}`), ['absolute_home_path']);
  assert.deepEqual(findPrivateMarkers(WINDOWS_HOME), ['absolute_home_path']);
  assert.deepEqual(findPrivateMarkers(`联系 ${PHONE}`), ['phone_number']);
  assert.deepEqual(findPrivateMarkers('商品 1040479270864，SKU 6270968490579，测试 user@example.com'), []);
});

async function sourceRepository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'shopping package ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'repo', 'skill');
  const write = async (file, text) => { await mkdir(path.dirname(path.join(source, file)), { recursive: true }); await writeFile(path.join(source, file), text); };
  await write('package.json', '{"name":"consumer-shopping-skill","version":"9.9.9"}\n');
  await write('SKILL.md', '# 入口\n\n见[任务](references/tasks.md)和[研究](../output/r.md)。\n');
  await write('SKILL-HISTORY.md', '# 历史\n');
  await write('references/tasks.md', '# 任务\n');
  await write('scripts/shopping.mjs', '#!/usr/bin/env node\n');
  await chmod(path.join(source, 'scripts/shopping.mjs'), 0o755);
  await write('examples/data/a.json', '{}\n');
  await git(path.join(root, 'repo'), 'init', '-q');
  await git(path.join(root, 'repo'), 'add', '.');
  await git(path.join(root, 'repo'), 'commit', '-q', '-m', 'fixture');
  return { root, source, output: path.join(root, 'dist'), write };
}

test('a build copies committed allowlisted files, records their checksums and writes an archive', async t => {
  const { source, output } = await sourceRepository(t);
  const result = await buildPackage({ sourceRoot: source, outputDirectory: output, now: () => new Date('2026-10-13T00:00:00Z') });
  assert.equal(result.version, '9.9.9');
  assert.equal(result.files, 5);
  assert.equal(result.links_removed, 1);
  const manifest = JSON.parse(await readFile(path.join(result.directory, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.built_at, '2026-10-13T00:00:00.000Z');
  assert.match(manifest.source_commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.files.map(entry => entry.path),
    ['SKILL.md', 'examples/data/a.json', 'package.json', 'references/tasks.md', 'scripts/shopping.mjs']);
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(result.directory, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  assert.equal(await readFile(path.join(result.directory, 'SKILL.md'), 'utf8'), '# 入口\n\n见[任务](references/tasks.md)和研究。\n');
  assert.equal((await stat(path.join(result.directory, 'scripts/shopping.mjs'))).mode & 0o111, 0o111);
  const listing = (await run('tar', ['-tzf', result.archive])).stdout.split('\n');
  assert.ok(listing.includes('winston-shopper/MANIFEST.json'));
  assert.ok(!listing.some(entry => entry.includes('HISTORY')));
  assert.equal(createHash('sha256').update(await readFile(result.archive)).digest('hex'), result.archive_sha256);
  await assert.rejects(buildPackage({ sourceRoot: source, outputDirectory: output }), { code: 'PACKAGE_OUTPUT_EXISTS' });
});

test('a build refuses uncommitted changes, private markers and an output inside the skill', async t => {
  const { root, source, output, write } = await sourceRepository(t);
  await assert.rejects(buildPackage({ sourceRoot: source, outputDirectory: path.join(source, 'dist') }), { code: 'PACKAGE_OUTPUT_PROTECTED' });
  await write('references/tasks.md', `# 任务\n保存在 ${HOME_PATH}\n`);
  await assert.rejects(buildPackage({ sourceRoot: source, outputDirectory: output }), { code: 'PACKAGE_SOURCE_DIRTY' });
  await git(path.join(root, 'repo'), 'commit', '-q', '-am', 'leak');
  await assert.rejects(buildPackage({ sourceRoot: source, outputDirectory: output }), { code: 'PACKAGE_PRIVATE_MARKER' });
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('the real package carries the Playwright lock and no retired browser backend', async t => {
  const skillRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  let listing;
  // An installed package has no git checkout; this check guards the development source only.
  try { listing = await run('git', ['ls-files', '-z', '--', '.'], { cwd: skillRoot }); }
  catch { t.skip('not a git checkout'); return; }
  const tracked = listing.stdout.split('\0').filter(Boolean);
  const files = selectPackageFiles(tracked);
  for (const required of ['runtime/playwright-backend/package.json', 'runtime/playwright-backend/package-lock.json']) {
    assert.ok(files.includes(required), required);
  }
  assert.deepEqual(files.filter(file => /(^|\/)(node_modules|\.runtime)\/|browser-backend\/|pw-ext-token|install-stamp/.test(file)), []);
  // Runtime code may only recognise the old protocol name; tests and the legacy-results note may still mention it.
  for (const file of files.filter(name => /^(lib|scripts)\//.test(name))) {
    const text = await readFile(path.join(skillRoot, file), 'utf8');
    assert.doesNotMatch(text, /19824|browser-backend/, file);
    if (file !== 'lib/bridge-protocol.mjs') assert.doesNotMatch(text, /bb-browser/, file);
  }
  const lock = JSON.parse(await readFile(path.join(skillRoot, 'runtime/playwright-backend/package-lock.json'), 'utf8'));
  const resolved = Object.values(lock.packages).map(entry => entry.resolved).filter(Boolean);
  assert.ok(resolved.length > 0);
  assert.deepEqual(resolved.filter(url => !url.startsWith('https://registry.npmjs.org/')), []);
});
