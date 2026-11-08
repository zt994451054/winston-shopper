import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShoppingError } from './errors.mjs';

export const PLAYWRIGHT_BACKEND_DIRECTORY = fileURLToPath(new URL('../runtime/playwright-backend/', import.meta.url));
export const PLAYWRIGHT_TOKEN_FILE = fileURLToPath(new URL('../.runtime/pw-ext-token', import.meta.url));

const MAX_TOKEN_FILE_BYTES = 1024;
const TOKEN_GUIDANCE = 'Ask the user to press Copy in the Playwright extension and say when done, then run token-save, which reads it from the clipboard (token-save --dialog or the hidden terminal input in references/setup.md as fallbacks). Never ask for the token in chat or a command argument.';

/** Inspect the token without exposing its contents or changing the file.
 * @param {string} [tokenFile] This installation's token path. @returns {Promise<object>} Validity and a fixed error code.
 * File errors are returned as diagnostic state.
 */
export async function inspectExtensionToken(tokenFile = PLAYWRIGHT_TOKEN_FILE) {
  try {
    await readExtensionToken(tokenFile);
    return { valid: true, status: 'valid', error_code: null };
  } catch (error) {
    const statuses = { PLAYWRIGHT_TOKEN_MISSING: 'missing', PLAYWRIGHT_TOKEN_ACCESS_FAILED: 'unreadable',
      PLAYWRIGHT_TOKEN_FILE_INVALID: 'invalid', PLAYWRIGHT_TOKEN_PERMISSIONS: 'permissions', PLAYWRIGHT_TOKEN_INVALID: 'invalid' };
    const code = Object.hasOwn(statuses, error.code) ? error.code : 'PLAYWRIGHT_TOKEN_ACCESS_FAILED';
    return { valid: false, status: statuses[code], error_code: code, next_action: code === 'PLAYWRIGHT_TOKEN_PERMISSIONS'
      ? 'Set permissions to 0600 on .runtime/pw-ext-token, then retry. The file was not changed.' : TOKEN_GUIDANCE };
  }
}

// The extension's copy button puts an environment line on the clipboard (seen 2026-11-07 on a clean machine).
const TOKEN_PREFIX = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=';

/**
 * Normalize copied token text: surrounding space, the extension's PLAYWRIGHT_MCP_EXTENSION_TOKEN= prefix and quotes.
 * @param {string} text Copied or saved text. @returns {string} The bare token.
 * @throws {ShoppingError} PLAYWRIGHT_TOKEN_INVALID; the message never repeats the input.
 * @example parseExtensionToken('PLAYWRIGHT_MCP_EXTENSION_TOKEN=abcdefghijklmnop') // 'abcdefghijklmnop'
 */
export function parseExtensionToken(text) {
  let token = String(text ?? '').trim();
  if (token.startsWith(TOKEN_PREFIX)) token = token.slice(TOKEN_PREFIX.length).trim();
  if (/^(["']).*\1$/.test(token)) token = token.slice(1, -1);
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) {
    throw new ShoppingError('PLAYWRIGHT_TOKEN_INVALID', 'The Playwright extension token has an invalid format.', TOKEN_GUIDANCE);
  }
  return token;
}

function invalidTokenFile() {
  return new ShoppingError('PLAYWRIGHT_TOKEN_FILE_INVALID', 'The extension token must be a small regular file in a real directory, without symbolic links.', TOKEN_GUIDANCE);
}

function checkTokenFile(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_TOKEN_FILE_BYTES) throw invalidTokenFile();
  if (process.platform !== 'win32' && (metadata.mode & 0o7777) !== 0o600) {
    throw new ShoppingError('PLAYWRIGHT_TOKEN_PERMISSIONS', 'The extension token file must have permissions 0600.',
      'Set permissions to 0600 on .runtime/pw-ext-token, then retry. The file was not changed.');
  }
}

/**
 * Read the local extension token without following a token-file or immediate-parent symlink.
 * @param {string} [tokenFile] Defaults to this skill's .runtime/pw-ext-token, independently of task state settings.
 *   Explicit relative paths retain the existing service launcher's current-directory semantics.
 * @returns {Promise<string>} The validated token; callers must not print it or pass it in command arguments.
 * @throws {ShoppingError} PLAYWRIGHT_TOKEN_MISSING, PLAYWRIGHT_TOKEN_ACCESS_FAILED, PLAYWRIGHT_TOKEN_FILE_INVALID,
 *   PLAYWRIGHT_TOKEN_PERMISSIONS or PLAYWRIGHT_TOKEN_INVALID. No file is created or modified.
 * @example const token = await readExtensionToken(); // Pass only to the MCP child's environment.
 */
export async function readExtensionToken(tokenFile = PLAYWRIGHT_TOKEN_FILE) {
  if (typeof tokenFile !== 'string' || tokenFile.length === 0) throw invalidTokenFile();
  const filename = path.resolve(tokenFile);
  let file;
  try {
    const parent = await lstat(path.dirname(filename));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw invalidTokenFile();
    const before = await lstat(filename);
    checkTokenFile(before);
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const metadata = await file.stat();
    checkTokenFile(metadata);
    if (metadata.dev !== before.dev || metadata.ino !== before.ino) throw invalidTokenFile();
    // A bounded buffer also limits reads when another process grows the file after the size check.
    const buffer = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== metadata.size || bytesRead > MAX_TOKEN_FILE_BYTES) throw invalidTokenFile();
    return parseExtensionToken(buffer.toString('utf8', 0, bytesRead));
  } catch (error) {
    if (error instanceof ShoppingError) throw error;
    if (error.code === 'ENOENT') throw new ShoppingError('PLAYWRIGHT_TOKEN_MISSING', 'The Playwright extension token file is missing.', TOKEN_GUIDANCE);
    if (error.code === 'ELOOP') throw invalidTokenFile();
    throw new ShoppingError('PLAYWRIGHT_TOKEN_ACCESS_FAILED', 'The Playwright extension token file could not be read.',
      'Check local file access to .runtime/pw-ext-token. Do not share its contents.');
  } finally {
    if (file) {
      try { await file.close(); }
      catch { throw new ShoppingError('PLAYWRIGHT_TOKEN_ACCESS_FAILED', 'The extension token file could not be closed.'); }
    }
  }
}

// On 2026-11-08 a caller read the extension's files in the Chrome profile after a failed first connection; the same token
// connected once the user had the profile's window open. Point at that first, and keep callers out of profile files.
export const CONNECT_FAILED_ACTION = 'Ask the user to open the Chrome window of the profile that has the extension and keep it open, then run bridge-start once more. If it fails again, run setup to check the extension and token. Do not read files in the Chrome profile directory.';
