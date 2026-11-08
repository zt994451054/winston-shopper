import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { PLAYWRIGHT_TOKEN_FILE, parseExtensionToken } from './playwright-config.mjs';

const run = promisify(execFile);

export const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export const EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;
// Chrome creates a profile directory the first time it is started with an unknown --profile-directory name.
export const NEW_PROFILE_NAME = 'Shopping Assistant';
const IGNORED_PROFILES = new Set(['System Profile', 'Guest Profile']);
const DIALOG_TIMEOUT_MS = 10 * 60_000;

/**
 * Chrome's user data directory for the current account; only directory names are read from it.
 * @param {{platform?: string, home?: string, env?: object}} [system] @returns {string|null} null on unsupported systems.
 */
export function chromeUserDataDirectory({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (platform === 'linux') return path.join(home, '.config', 'google-chrome');
  if (platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  return null;
}

async function isDirectory(filename) {
  try { return (await lstat(filename)).isDirectory(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

/**
 * Profile directory names that have the store-installed Playwright extension. Only the presence of the extension's
 * install folder is checked; no profile preferences, cookies or storage are opened.
 * @param {{userDataDirectory?: string|null}} [options] @returns {Promise<string[]>} Sorted profile directory names.
 */
export async function findExtensionProfiles({ userDataDirectory = chromeUserDataDirectory() } = {}) {
  if (!userDataDirectory || !(await isDirectory(userDataDirectory))) return [];
  const names = [];
  for (const entry of await readdir(userDataDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_PROFILES.has(entry.name)) continue;
    if (await isDirectory(path.join(userDataDirectory, entry.name, 'Extensions', EXTENSION_ID))) names.push(entry.name);
  }
  return names.sort();
}

/**
 * The names the user sees in Chrome's profile menu for the given profile directories, from the profile list in Chrome's
 * Local State file. Only each listed profile's display name is taken; nothing else in the file or the profiles is used.
 * Any problem only leaves names out (2026-11-08: users know their profile as 购物助手, not as Profile 8).
 * @param {string[]} profiles Directory names. @param {{userDataDirectory?: string|null}} [options]
 * @returns {Promise<Record<string, string>>} Directory name to display name, for the profiles that have one.
 */
export async function profileDisplayNames(profiles, { userDataDirectory = chromeUserDataDirectory() } = {}) {
  if (!userDataDirectory || profiles.length === 0) return {};
  let cache;
  try { cache = JSON.parse(await readFile(path.join(userDataDirectory, 'Local State'), 'utf8'))?.profile?.info_cache; }
  catch { return {}; }
  if (!cache || typeof cache !== 'object') return {};
  return Object.fromEntries(profiles.filter(name => Object.hasOwn(cache, name) && typeof cache[name]?.name === 'string' && cache[name].name.trim())
    .map(name => [name, cache[name].name.trim().slice(0, 80)]));
}

async function unusedProfileName(userDataDirectory) {
  for (let index = 1; index < 100; index += 1) {
    const name = index === 1 ? NEW_PROFILE_NAME : `${NEW_PROFILE_NAME} ${index}`;
    if (!userDataDirectory || !(await isDirectory(path.join(userDataDirectory, name)))) return name;
  }
  throw new ShoppingError('PROFILE_NAME_UNAVAILABLE', 'No free name for a new shopping profile was found.', 'Create a Chrome profile by hand, then rerun setup.');
}

/**
 * Open the extension's store page so the user only has to click 添加至 Chrome. With newProfile, Chrome is started with
 * a fresh profile directory, which Chrome creates itself; nothing in the browser's own files is written by this skill.
 * @param {{newProfile?: boolean, platform?: string, userDataDirectory?: string|null, runCommand?: Function}} [options]
 * @returns {Promise<{opened: boolean, url: string, profile: string|null}>} profile is the new directory name, if any.
 * @throws {ShoppingError} STORE_OPEN_FAILED when Chrome could not be started.
 */
export async function openExtensionStore({ newProfile = false, platform = process.platform, userDataDirectory = chromeUserDataDirectory({ platform }),
  runCommand = run } = {}) {
  if (platform !== 'darwin') return { opened: false, url: EXTENSION_STORE_URL, profile: null };
  const profile = newProfile ? await unusedProfileName(userDataDirectory) : null;
  const args = profile ? ['-na', 'Google Chrome', '--args', `--profile-directory=${profile}`, EXTENSION_STORE_URL]
    : ['-a', 'Google Chrome', EXTENSION_STORE_URL];
  try { await runCommand('open', args); }
  catch { throw new ShoppingError('STORE_OPEN_FAILED', 'Chrome could not be opened on the extension store page.', `Install Google Chrome, or open ${EXTENSION_STORE_URL} by hand.`); }
  return { opened: true, url: EXTENSION_STORE_URL, profile };
}

const DIALOG_SCRIPT = [
  'activate',
  'set answer to text returned of (display dialog "请在 Playwright 扩展里点“复制”，把令牌粘贴到这里。令牌只保存在这台电脑上。" ' +
    'default answer "" with hidden answer with title "购物助手：保存扩展令牌" buttons {"取消", "保存"} default button "保存" cancel button "取消")',
  'return answer',
];

async function askWithDialog(runCommand) {
  try {
    const { stdout } = await runCommand('osascript', DIALOG_SCRIPT.flatMap(line => ['-e', line]), { timeout: DIALOG_TIMEOUT_MS, maxBuffer: 4096 });
    return stdout;
  } catch (error) {
    if (/-128/.test(String(error.stderr ?? ''))) {
      throw new ShoppingError('TOKEN_ENTRY_CANCELLED', 'The token dialog was cancelled. Nothing was saved.', 'Run token-save again when the token is copied.');
    }
    throw new ShoppingError('TOKEN_DIALOG_UNAVAILABLE', 'The token dialog could not be shown in this session.', TERMINAL_FALLBACK);
  }
}

async function writePrivateFile(filename, text) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new ShoppingError('PLAYWRIGHT_TOKEN_FILE_INVALID', 'The token directory must be a real directory.', 'Remove the link at .runtime and retry.');
  }
  const temporary = path.join(directory, `.pw-ext-token-${process.pid}-${Date.now()}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await file.writeFile(text); }
  finally { await file.close(); }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function savePrivateToken(tokenFile, text) {
  const token = parseExtensionToken(text);
  await writePrivateFile(tokenFile, token);
  const metadata = await stat(tokenFile);
  if ((metadata.mode & 0o777) !== 0o600) await chmod(tokenFile, 0o600);
}

const TERMINAL_FALLBACK = 'Ask the user to save the token with the hidden terminal input in references/setup.md. Never ask for the token in chat.';
const CLIPBOARD_LIMIT_BYTES = 64 * 1024;

async function readClipboard(runCommand) {
  try {
    const { stdout } = await runCommand('pbpaste', [], { timeout: 10_000, maxBuffer: CLIPBOARD_LIMIT_BYTES });
    return stdout;
  } catch (error) {
    // Anything larger than the limit is certainly not a token; report it as such without echoing it.
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return '';
    throw new ShoppingError('TOKEN_CLIPBOARD_UNAVAILABLE', 'The clipboard could not be read in this session.', 'Run token-save --dialog, or ' + TERMINAL_FALLBACK);
  }
}

/**
 * Save the extension token the user just copied with the extension's Copy button, read straight from the clipboard.
 * The token never reaches the chat, command arguments, output or logs. The clipboard is cleared after a successful save;
 * anything else on the clipboard is left untouched and never reported.
 * @param {{tokenFile?: string, platform?: string, runCommand?: Function}} [options]
 * @returns {Promise<{saved: true, clipboard_cleared: boolean}>}
 * @throws {ShoppingError} TOKEN_CLIPBOARD_UNAVAILABLE, TOKEN_CLIPBOARD_NOT_TOKEN or file errors.
 */
export async function saveTokenFromClipboard({ tokenFile = PLAYWRIGHT_TOKEN_FILE, platform = process.platform, runCommand = run } = {}) {
  if (platform !== 'darwin') {
    throw new ShoppingError('TOKEN_CLIPBOARD_UNAVAILABLE', 'Reading the token from the clipboard is only available on macOS.', TERMINAL_FALLBACK);
  }
  const text = await readClipboard(runCommand);
  try { await savePrivateToken(tokenFile, text); }
  catch (error) {
    if (error.code !== 'PLAYWRIGHT_TOKEN_INVALID') throw error;
    throw new ShoppingError('TOKEN_CLIPBOARD_NOT_TOKEN', 'The clipboard does not hold an extension token. Nothing was saved.',
      'Ask the user to click the Playwright extension icon and press Copy again, then rerun token-save. If the user did copy it and this repeats, this session cannot see the desktop clipboard (for example over SSH): run token-save --dialog.');
  }
  let cleared = true;
  try { await runCommand('osascript', ['-e', 'set the clipboard to ""'], { timeout: 10_000 }); }
  catch { cleared = false; }
  return { saved: true, clipboard_cleared: cleared };
}

/**
 * Ask the user for the extension token in a hidden system dialog and save it with permissions 0600. The token never
 * reaches the command output, arguments or logs; the AI caller only sees whether it was saved.
 * @param {{tokenFile?: string, platform?: string, runCommand?: Function}} [options]
 * @returns {Promise<{saved: true}>}
 * @throws {ShoppingError} TOKEN_ENTRY_CANCELLED, TOKEN_DIALOG_UNAVAILABLE, PLAYWRIGHT_TOKEN_INVALID or file errors.
 */
export async function saveTokenFromDialog({ tokenFile = PLAYWRIGHT_TOKEN_FILE, platform = process.platform, runCommand = run } = {}) {
  if (platform !== 'darwin') {
    throw new ShoppingError('TOKEN_DIALOG_UNAVAILABLE', 'The token dialog is only available on macOS.', TERMINAL_FALLBACK);
  }
  await savePrivateToken(tokenFile, await askWithDialog(runCommand));
  return { saved: true };
}
