import { mkdir, open, readFile, link, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShoppingError } from './errors.mjs';
import { normalizeEndpoint } from './bridge.mjs';
import { parseTabId } from './targets.mjs';
import { productParserOf } from './platform-targets.mjs';
import { PLATFORMS } from './platforms.mjs';

function bindingPath(directory, name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new ShoppingError('INVALID_BINDING_NAME', 'Binding names must use 1–64 lowercase letters, digits, underscores, or hyphens.');
  }
  return path.join(directory, `${name}.json`);
}

function validateBinding(value) {
  if (value?.schema_version !== 1 || !PLATFORMS.includes(value?.platform) ||
      typeof value?.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) {
    throw new ShoppingError('INVALID_BINDING', 'The saved binding has an unsupported or invalid format.', 'Create a new binding for the intended public product page.');
  }
  const target = productParserOf(value.platform)(value.target?.url);
  if (!target || target.url !== value.target.url) {
    throw new ShoppingError('INVALID_BINDING', 'The saved target is not a canonical supported product page.');
  }
  return {
    schema_version: 1, platform: value.platform, endpoint: normalizeEndpoint(value.endpoint),
    tab_id: parseTabId(value.tab_id), target, created_at: value.created_at,
  };
}

/**
 * Atomically save a public-page binding; existing bindings require explicit replacement.
 * @param {string} directory @param {string} name @param {object} binding
 * @param {{replace?: boolean}} options
 * @returns {Promise<string>} Saved path; no cookies, titles, or account identity are stored.
 * @throws {ShoppingError} Invalid input, BINDING_EXISTS, or STATE_WRITE_FAILED.
 */
export async function saveBinding(directory, name, binding, { replace = false } = {}) {
  const destination = bindingPath(directory, name);
  const clean = validateBinding(binding);
  const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
  let created = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ShoppingError('INVALID_STATE_DIRECTORY', 'Use a real directory for binding state.');
    }
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(`${JSON.stringify(clean, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    if (replace) await rename(temporary, destination);
    else await link(temporary, destination);
    return destination;
  } catch (error) {
    if (error instanceof ShoppingError) throw error;
    if (error.code === 'EEXIST') {
      throw new ShoppingError('BINDING_EXISTS', 'A binding with this name already exists.', 'Use a different --binding name, or --replace for the intended new target.');
    }
    throw new ShoppingError('STATE_WRITE_FAILED', 'The binding could not be saved.', 'Check that the state directory is writable.');
  } finally {
    if (created) await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw new ShoppingError('STATE_CLEANUP_FAILED', 'A temporary binding file could not be removed.');
    });
  }
}

/**
 * Load and validate a binding without permitting path traversal or symlink files.
 * @param {string} directory @param {string} name
 * @returns {Promise<object>} Validated binding.
 * @throws {ShoppingError} BINDING_MISSING, INVALID_BINDING, or STATE_READ_FAILED.
 */
export async function loadBinding(directory, name) {
  const filename = bindingPath(directory, name);
  try {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8192) {
      throw new ShoppingError('INVALID_BINDING', 'The binding must be a small regular JSON file.');
    }
    let value;
    try { value = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw new ShoppingError('INVALID_BINDING', 'The binding contains invalid JSON.');
      throw error;
    }
    return validateBinding(value);
  } catch (error) {
    if (error instanceof ShoppingError) throw error;
    if (error.code === 'ENOENT') {
      throw new ShoppingError('BINDING_MISSING', 'No saved binding exists with this name.', 'Run tabs, then bind the intended product tab.');
    }
    throw new ShoppingError('STATE_READ_FAILED', 'The binding could not be read.');
  }
}
