import { access, readFile, writeFile, open, unlink, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ShoppingError } from './errors.mjs';
import { PLAYWRIGHT_BACKEND_DIRECTORY } from './playwright-config.mjs';

const PLAYWRIGHT_VERSIONS = Object.freeze({
  '@playwright/mcp': '0.0.84',
  playwright: '1.65.0-alpha-2026-10-30',
  'playwright-core': '1.65.0-alpha-2026-10-30',
});

async function lockHash(directory) {
  return createHash('sha256').update(await readFile(path.join(directory, 'package-lock.json'))).digest('hex');
}

async function lockVerified(directory) {
  try {
    const stamp = JSON.parse(await readFile(path.join(directory, '.install-stamp.json'), 'utf8'));
    return stamp.schema_version === 1 && stamp.lock_hash === await lockHash(directory);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw new ShoppingError('DEPENDENCY_ACCESS_FAILED', 'The dependency installation stamp is not readable.');
  }
}

async function exists(filename) {
  try { await access(filename); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new ShoppingError('DEPENDENCY_ACCESS_FAILED', 'A dependency file is not accessible.');
  }
}

/**
 * Inspect only the pinned project-local Playwright packages; never import them or connect to a browser.
 * @param {string} [directory] Absolute backend directory, defaulting to runtime/playwright-backend/.
 * @returns {Promise<object>} Installation state, lock verification, expected versions and the MCP entry point.
 * @throws {ShoppingError} INVALID_BACKEND_DIRECTORY or DEPENDENCY_ACCESS_FAILED.
 * @example const backend = await inspectPlaywrightBackend();
 */
export async function inspectPlaywrightBackend(directory = PLAYWRIGHT_BACKEND_DIRECTORY) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new ShoppingError('INVALID_BACKEND_DIRECTORY', 'Use an absolute project-local backend directory.');
  }
  const result = { installed: false, lock_verified: false, expected_version: PLAYWRIGHT_VERSIONS['@playwright/mcp'],
    expected_versions: { ...PLAYWRIGHT_VERSIONS }, directory };
  try {
    const manifests = {};
    for (const [name, version] of Object.entries(PLAYWRIGHT_VERSIONS)) {
      const root = path.join(directory, 'node_modules', name);
      const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      if (manifest?.name !== name || manifest?.version !== version || !(await stat(path.join(root, 'cli.js'))).isFile()) {
        return { ...result, reason: 'incomplete_or_invalid_installation' };
      }
      manifests[name] = manifest;
    }
    if (manifests['@playwright/mcp'].dependencies?.playwright !== PLAYWRIGHT_VERSIONS.playwright ||
        manifests['@playwright/mcp'].dependencies?.['playwright-core'] !== PLAYWRIGHT_VERSIONS['playwright-core'] ||
        manifests.playwright.dependencies?.['playwright-core'] !== PLAYWRIGHT_VERSIONS['playwright-core']) {
      return { ...result, reason: 'incomplete_or_invalid_installation' };
    }
    return { ...result, installed: true, lock_verified: await lockVerified(directory),
      version: PLAYWRIGHT_VERSIONS['@playwright/mcp'], versions: { ...PLAYWRIGHT_VERSIONS },
      cli: path.join(directory, 'node_modules', '@playwright', 'mcp', 'cli.js') };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) {
      return { ...result, reason: 'incomplete_or_invalid_installation' };
    }
    if (error instanceof ShoppingError) throw error;
    throw new ShoppingError('DEPENDENCY_ACCESS_FAILED', 'The Playwright backend files could not be inspected.');
  }
}

async function findNpmCli() {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  if (process.env.npm_execpath?.endsWith(`${path.sep}npm-cli.js`)) candidates.push(process.env.npm_execpath);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new ShoppingError('NPM_MISSING', 'npm could not be located for the running Node installation.', 'Use a Node.js 22+ installation that includes npm, then rerun setup.');
}

async function runNpm(npmCli, directory, { spawnProcess = spawn, setTimer = setTimeout, clearTimer = clearTimeout, skipBrowserDownload = false } = {}) {
  const args = [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', '--fetch-retries=1', '--fetch-timeout=20000',
    '--cache', path.join(directory, '.npm-cache')];
  await new Promise((resolve, reject) => {
    // npm is executed by the same Node binary as this program, independently of PATH.
    let child;
    try {
      child = spawnProcess(process.execPath, args, { cwd: directory, stdio: 'ignore', windowsHide: true,
        ...(skipBrowserDownload ? { env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } } : {}) });
    } catch {
      reject(new ShoppingError('INSTALL_FAILED', 'The dependency installer could not start.'));
      return;
    }
    let timedOut = false;
    let forceKill;
    const timeout = setTimer(() => {
      timedOut = true;
      forceKill = setTimer(() => child.kill('SIGKILL'), 3000);
      child.kill();
    }, 120000);
    child.once('error', () => {
      clearTimer(timeout);
      clearTimer(forceKill);
      reject(new ShoppingError('INSTALL_FAILED', 'The dependency installer could not start.'));
    });
    child.once('exit', code => {
      clearTimer(timeout);
      clearTimer(forceKill);
      if (timedOut) reject(new ShoppingError('INSTALL_TIMEOUT', 'Dependency installation exceeded two minutes.', 'Check access to the npm registry and rerun setup --install.'));
      else if (code === 0) resolve();
      else reject(new ShoppingError('INSTALL_FAILED', 'The pinned dependency installation failed.', 'Check registry connectivity and write access, then rerun setup --install.'));
    });
  });
}

/**
 * Inspect or install the pinned Playwright backend, without starting MCP, Chrome or an extension connection.
 * @param {{install?: boolean, directory?: string}} [options] Installation is opt-in; the default only inspects files.
 * @param {{findNpmCli?: Function, spawnProcess?: Function, setTimer?: Function, clearTimer?: Function}} [dependencies]
 *   Local installer and timer hooks for offline tests; defaults use the current Node installation.
 * @returns {Promise<object>} Backend state, whether it changed, and whether installation was requested.
 * @throws {ShoppingError} Invalid options, inaccessible dependencies, installation lock, installer or completion errors.
 * @example const plan = await preparePlaywrightBackend();
 */
export async function preparePlaywrightBackend({ install = false, directory = PLAYWRIGHT_BACKEND_DIRECTORY } = {}, dependencies = {}) {
  if (typeof install !== 'boolean') throw new ShoppingError('INVALID_ARGUMENTS', 'The install option must be a boolean.');
  return preparePinnedBackend({ install, directory }, inspectPlaywrightBackend, {
    locateNpm: dependencies.findNpmCli ?? findNpmCli,
    installNpm: (cli, root) => runNpm(cli, root, { ...dependencies, skipBrowserDownload: true }),
  });
}

async function preparePinnedBackend({ install, directory }, inspect, { locateNpm = findNpmCli, installNpm = runNpm } = {}) {
  const current = await inspect(directory);
  if ((current.installed && current.lock_verified) || !install) return { ...current, changed: false, install_requested: install };
  if (!await exists(path.join(directory, 'package-lock.json'))) {
    throw new ShoppingError('DEPENDENCY_LOCK_MISSING', 'The packaged dependency lockfile is missing.');
  }
  const npmCli = await locateNpm();
  const lockPath = path.join(directory, '.install.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') {
      throw new ShoppingError('INSTALL_IN_PROGRESS', 'Another dependency installation holds the local lock.', 'Wait for that installation. If its process ended, remove the stale .install.lock and rerun.');
    }
    throw new ShoppingError('INSTALL_DIRECTORY_UNWRITABLE', 'The packaged dependency directory is not writable.');
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await installNpm(npmCli, directory);
    const installed = await inspect(directory);
    if (!installed.installed) throw new ShoppingError('INSTALL_INCOMPLETE', 'The installed backend is missing required components.');
    const stampPath = path.join(directory, '.install-stamp.json');
    const temporary = `${stampPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ schema_version: 1, lock_hash: await lockHash(directory) }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, stampPath);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return { ...installed, lock_verified: true, changed: true, install_requested: true };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
