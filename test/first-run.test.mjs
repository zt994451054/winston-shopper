import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { EXTENSION_ID, EXTENSION_STORE_URL, NEW_PROFILE_NAME, chromeUserDataDirectory, findExtensionProfiles, openExtensionStore,
  saveTokenFromClipboard, saveTokenFromDialog } from '../lib/first-run.mjs';
import { parseExtensionToken, readExtensionToken } from '../lib/playwright-config.mjs';

// Synthetic values only; assembled so no real token shape is committed.
const TOKEN = ['synthetic', 'token', 'value', '0123456789'].join('_');
const BACKEND = { installed: true, lock_verified: true };

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping-first-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function run(argv, environment = {}, services) {
  let output = '';
  const code = await main(argv, { write: text => { output += text; }, environment, ...(services ? { services } : {}) });
  return { code, output, value: JSON.parse(output) };
}

test('copied token text keeps only the bare token and errors never repeat the input', () => {
  assert.equal(parseExtensionToken(`PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`), TOKEN);
  assert.equal(parseExtensionToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(parseExtensionToken(`PLAYWRIGHT_MCP_EXTENSION_TOKEN="${TOKEN}"`), TOKEN);
  for (const bad of ['', 'short', `${TOKEN} extra`, `OTHER_NAME=${TOKEN}`]) {
    assert.throws(() => parseExtensionToken(bad), error => error.code === 'PLAYWRIGHT_TOKEN_INVALID' && !error.message.includes(TOKEN));
  }
});

test('a saved token file with the copied prefix is accepted', async t => {
  const filename = path.join(await directory(t), 'token');
  await writeFile(filename, `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`, { mode: 0o600 });
  assert.equal(await readExtensionToken(filename), TOKEN);
});

test('profiles are found only by the extension install folder', async t => {
  const root = await directory(t);
  for (const name of ['Default', 'Profile 1', 'Shopping Assistant', 'System Profile']) await mkdir(path.join(root, name, 'Extensions'), { recursive: true });
  for (const name of ['Profile 1', 'Shopping Assistant', 'System Profile']) await mkdir(path.join(root, name, 'Extensions', EXTENSION_ID));
  await mkdir(path.join(root, 'Default', 'Extensions', 'another-extension'));
  assert.deepEqual(await findExtensionProfiles({ userDataDirectory: root }), ['Profile 1', 'Shopping Assistant']);
  assert.deepEqual(await findExtensionProfiles({ userDataDirectory: path.join(root, 'absent') }), []);
  assert.deepEqual(await findExtensionProfiles({ userDataDirectory: null }), []);
  assert.equal(chromeUserDataDirectory({ platform: 'darwin', home: '/h' }), path.join('/h', 'Library', 'Application Support', 'Google', 'Chrome'));
  assert.equal(chromeUserDataDirectory({ platform: 'freebsd', home: '/h' }), null);
});

test('the store page opens in the current Chrome profile or in a new, unused profile name', async t => {
  const root = await directory(t), calls = [];
  const runCommand = async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; };
  assert.deepEqual(await openExtensionStore({ platform: 'darwin', userDataDirectory: root, runCommand }), { opened: true, url: EXTENSION_STORE_URL, profile: null });
  await mkdir(path.join(root, NEW_PROFILE_NAME));
  const created = await openExtensionStore({ newProfile: true, platform: 'darwin', userDataDirectory: root, runCommand });
  assert.equal(created.profile, `${NEW_PROFILE_NAME} 2`);
  assert.deepEqual(calls, [['open', '-a', 'Google Chrome', EXTENSION_STORE_URL],
    ['open', '-na', 'Google Chrome', '--args', `--profile-directory=${NEW_PROFILE_NAME} 2`, EXTENSION_STORE_URL]]);
  assert.deepEqual(await openExtensionStore({ platform: 'linux', runCommand }), { opened: false, url: EXTENSION_STORE_URL, profile: null });
  await assert.rejects(openExtensionStore({ platform: 'darwin', userDataDirectory: root, runCommand: async () => { throw new Error('no chrome'); } }),
    { code: 'STORE_OPEN_FAILED' });
});

test('the token dialog saves a bare token with permissions 0600 and reports nothing of it', async t => {
  const root = await directory(t), tokenFile = path.join(root, '.runtime', 'pw-ext-token');
  let script = '';
  const result = await saveTokenFromDialog({ tokenFile, platform: 'darwin', runCommand: async (file, args) => {
    script = args.join(' '); assert.equal(file, 'osascript'); return { stdout: `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}\n` };
  } });
  assert.deepEqual(result, { saved: true });
  assert.match(script, /with hidden answer/);
  assert.equal(await readFile(tokenFile, 'utf8'), TOKEN);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(tokenFile))).mode & 0o777, 0o700);
});

test('a cancelled, unavailable or invalid dialog entry leaves the token file untouched', async t => {
  const root = await directory(t), tokenFile = path.join(root, 'pw-ext-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const cancelled = async () => { throw Object.assign(new Error('cancel'), { stderr: 'execution error: User canceled. (-128)' }); };
  await assert.rejects(saveTokenFromDialog({ tokenFile, platform: 'darwin', runCommand: cancelled }), { code: 'TOKEN_ENTRY_CANCELLED' });
  const headless = async () => { throw Object.assign(new Error('no ui'), { stderr: 'No user interaction allowed. (-1713)' }); };
  await assert.rejects(saveTokenFromDialog({ tokenFile, platform: 'darwin', runCommand: headless }), { code: 'TOKEN_DIALOG_UNAVAILABLE' });
  await assert.rejects(saveTokenFromDialog({ tokenFile, platform: 'darwin', runCommand: async () => ({ stdout: 'not a token' }) }),
    { code: 'PLAYWRIGHT_TOKEN_INVALID' });
  await assert.rejects(saveTokenFromDialog({ tokenFile, platform: 'linux' }), { code: 'TOKEN_DIALOG_UNAVAILABLE' });
  assert.equal(await readFile(tokenFile, 'utf8'), TOKEN);
});

test('the copied token is read from the clipboard, saved with 0600 and the clipboard is cleared', async t => {
  const root = await directory(t), tokenFile = path.join(root, '.runtime', 'pw-ext-token'), calls = [];
  const runCommand = async (file, args) => { calls.push([file, ...args]); return { stdout: file === 'pbpaste' ? `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}\n` : '' }; };
  const result = await saveTokenFromClipboard({ tokenFile, platform: 'darwin', runCommand });
  assert.deepEqual(result, { saved: true, clipboard_cleared: true });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(await readFile(tokenFile, 'utf8'), TOKEN);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.deepEqual(calls, [['pbpaste'], ['osascript', '-e', 'set the clipboard to ""']]);

  const keepsClipboard = await saveTokenFromClipboard({ tokenFile, platform: 'darwin', runCommand: async file => {
    if (file === 'osascript') throw new Error('no ui'); return { stdout: TOKEN };
  } });
  assert.deepEqual(keepsClipboard, { saved: true, clipboard_cleared: false });
});

test('an empty, foreign, oversized or unreadable clipboard saves nothing and never echoes its content', async t => {
  const root = await directory(t), tokenFile = path.join(root, 'pw-ext-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const secret = 'my private note that is not a token';
  for (const stdout of ['', '   \n', secret]) {
    const cleared = [];
    await assert.rejects(saveTokenFromClipboard({ tokenFile, platform: 'darwin', runCommand: async file => { cleared.push(file); return { stdout }; } }),
      error => error.code === 'TOKEN_CLIPBOARD_NOT_TOKEN' && !error.message.includes(secret));
    assert.deepEqual(cleared, ['pbpaste']);
  }
  const oversized = async () => { throw Object.assign(new Error('too big'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }); };
  await assert.rejects(saveTokenFromClipboard({ tokenFile, platform: 'darwin', runCommand: oversized }), { code: 'TOKEN_CLIPBOARD_NOT_TOKEN' });
  const failing = async () => { throw new Error('no pasteboard'); };
  await assert.rejects(saveTokenFromClipboard({ tokenFile, platform: 'darwin', runCommand: failing }), { code: 'TOKEN_CLIPBOARD_UNAVAILABLE' });
  await assert.rejects(saveTokenFromClipboard({ tokenFile, platform: 'linux' }), { code: 'TOKEN_CLIPBOARD_UNAVAILABLE' });
  assert.equal(await readFile(tokenFile, 'utf8'), TOKEN);
});

test('setup walks first use in order: dependencies, extension, token, service', async () => {
  let profiles = [], tokenValid = false;
  const opened = [];
  const environment = {
    prepareBackend: async () => BACKEND, findProfiles: async () => profiles, profileScanUnsupported: false,
    inspectToken: async () => tokenValid ? { valid: true, status: 'valid', error_code: null } : { valid: false, status: 'missing', error_code: 'PLAYWRIGHT_TOKEN_MISSING', next_action: 'x' },
    openStore: async options => { opened.push(options); return { opened: true, url: EXTENSION_STORE_URL, profile: options.newProfile ? NEW_PROFILE_NAME : null }; },
  };
  assert.equal((await run(['setup'], { ...environment, prepareBackend: async () => ({ installed: false, lock_verified: false }) })).value.status, 'installation_plan');
  const noExtension = await run(['setup'], environment);
  assert.equal(noExtension.value.status, 'needs_extension');
  assert.match(noExtension.value.next_action, /--open-store/);
  const store = await run(['setup', '--open-store', '--new-profile'], environment);
  assert.equal(store.value.status, 'store_opened');
  assert.equal(store.value.extension.new_profile, NEW_PROFILE_NAME);
  assert.deepEqual(opened, [{ newProfile: true }]);
  profiles = [NEW_PROFILE_NAME];
  const token = await run(['setup'], environment);
  assert.equal(token.value.status, 'needs_token');
  assert.match(token.value.next_action, /token-save/);
  assert.match(token.value.next_action, /Copy/);
  tokenValid = true;
  const ready = await run(['setup'], environment);
  assert.equal(ready.value.status, 'ready_for_bridge_start');
  assert.equal(ready.value.ready, true);
  assert.deepEqual(ready.value.extension.profiles, [NEW_PROFILE_NAME]);
});

test('token-save reads the clipboard by default, shows the dialog with --dialog, and reports only that the token was saved', async () => {
  const used = [];
  const environment = { saveToken: async () => { used.push('clipboard'); return { saved: true, clipboard_cleared: true }; },
    saveTokenWithDialog: async () => { used.push('dialog'); return { saved: true }; } };
  const result = await run(['token-save'], environment);
  assert.equal(result.code, 0);
  assert.equal(result.value.status, 'token_saved');
  assert.equal(result.value.clipboard_cleared, true);
  assert.equal((await run(['token-save', '--dialog'], environment)).value.status, 'token_saved');
  assert.deepEqual(used, ['clipboard', 'dialog']);
  const failed = await run(['token-save'], { saveToken: async () => { throw new ShoppingError('TOKEN_ENTRY_CANCELLED', 'cancelled'); } });
  assert.equal(failed.code, 2);
  assert.equal(failed.value.error.code, 'TOKEN_ENTRY_CANCELLED');
});

test('bridge-start without a saved profile uses the only profile with the extension and asks when there are several', async () => {
  const calls = [];
  const services = { stop: async () => ({ ok: true }), start: async options => {
    calls.push(options.profile);
    if (options.profile === undefined) throw new ShoppingError('PLAYWRIGHT_PROFILE_REQUIRED', 'profile');
    return { ok: true, status: 'bridge_connected', profile: options.profile };
  } };
  const single = await run(['bridge-start'], { findProfiles: async () => ['Profile 1'] }, services);
  assert.equal(single.value.profile, 'Profile 1');
  assert.deepEqual(calls, [undefined, 'Profile 1']);
  const several = await run(['bridge-start'], { findProfiles: async () => ['Default', 'Profile 1'] }, services);
  assert.equal(several.value.error.code, 'PLAYWRIGHT_PROFILE_REQUIRED');
  assert.match(several.value.error.message, /Default, Profile 1/);
  const none = await run(['bridge-start'], { findProfiles: async () => [] }, services);
  assert.match(none.value.error.next_action, /setup/);
  const explicit = await run(['bridge-start', '--profile', 'Default'], { findProfiles: async () => { throw new Error('not scanned'); } }, services);
  assert.equal(explicit.value.profile, 'Default');
});

test('a failed first connection with several extension profiles explains that each profile has its own token', async () => {
  const services = { stop: async () => ({ ok: true }), start: async () => {
    throw new ShoppingError('PLAYWRIGHT_CONNECT_FAILED', 'The first Playwright service startup failed. It was not retried.', 'Inspect.');
  } };
  const several = await run(['bridge-start'], { findProfiles: async () => ['Profile 1', 'Shopping Assistant'] }, services);
  assert.equal(several.value.error.code, 'PLAYWRIGHT_CONNECT_FAILED');
  assert.match(several.value.error.message, /Profile 1, Shopping Assistant/);
  assert.match(several.value.error.next_action, /token-save.*--profile/);
  const single = await run(['bridge-start', '--profile', 'Profile 1'], { findProfiles: async () => ['Profile 1'] }, services);
  assert.equal(single.value.error.next_action, 'Inspect.');
  const unscanned = await run(['bridge-start'], { findProfiles: async () => { throw new Error('unsupported'); } }, services);
  assert.equal(unscanned.value.error.next_action, 'Inspect.');
});
