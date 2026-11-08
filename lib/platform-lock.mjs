import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShoppingError } from './errors.mjs';
import { PLATFORMS } from './platforms.mjs';

/**
 * After a platform shows a limit, verification or login page, no new page work is started on it for a while (user,
 * 2026-11-08: 15 minutes). On 2026-11-07 a caller met a JD limit and kept searching on other keywords and, seven
 * minutes later, on JD again. Resuming the paused task with the user's flags stays possible; the lock only stops new
 * page opens and new task runs. platform-unlock ends it early once the user says the page is handled.
 */
export const PLATFORM_LOCK_MS = 15 * 60_000;
export const LOCK_REASONS = Object.freeze(['rate_limited', 'verification_required', 'login_required']);
const FILE = 'platform-locks.json';
const NAMES = { taobao: 'Taobao', jd: 'JD', pdd: 'PDD' };

function invalidState() {
  return new ShoppingError('INVALID_PACING_STATE', 'The local platform lock record is unreadable; nothing was sent.',
    'Inspect platform-locks.json in the state directory. Do not delete it to skip a lock.');
}

const validLock = lock => lock && Object.keys(lock).length === 3 && Number.isSafeInteger(lock.locked_at) &&
  Number.isSafeInteger(lock.until) && lock.until >= lock.locked_at && LOCK_REASONS.includes(lock.reason);

async function load(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { schema_version: 1, locks: {} };
    throw invalidState();
  }
  if (value?.schema_version !== 1 || !value.locks || typeof value.locks !== 'object' ||
    !Object.entries(value.locks).every(([platform, lock]) => PLATFORMS.includes(platform) && validLock(lock))) throw invalidState();
  return value;
}

async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Lock one platform from now on; a later signal extends the lock.
 * @param {string} stateDirectory @param {string} platform @param {'rate_limited'|'verification_required'|'login_required'} reason
 * @param {{now?: Function}} [clock] @returns {Promise<{platform: string, reason: string, until: number}>}
 */
export async function lockPlatform(stateDirectory, platform, reason, { now = Date.now } = {}) {
  if (!PLATFORMS.includes(platform) || !LOCK_REASONS.includes(reason)) throw new ShoppingError('INVALID_ARGUMENTS', 'Lock a known platform for a known reason.');
  const file = path.join(stateDirectory, FILE), record = await load(file), at = now();
  record.locks[platform] = { locked_at: at, until: at + PLATFORM_LOCK_MS, reason };
  await save(file, record);
  return { platform, reason, until: at + PLATFORM_LOCK_MS };
}

/**
 * Refuse new page work on a locked platform.
 * @param {string} stateDirectory @param {string} platform @param {{now?: Function}} [clock] @returns {Promise<void>}
 * @throws {ShoppingError} PLATFORM_LOCKED (marked undispatched, with allowedAt) or INVALID_PACING_STATE.
 */
export async function requirePlatformUnlocked(stateDirectory, platform, { now = Date.now } = {}) {
  const lock = (await load(path.join(stateDirectory, FILE))).locks[platform];
  if (!lock || lock.until <= now()) return;
  const name = NAMES[platform] ?? platform;
  const error = new ShoppingError('PLATFORM_LOCKED', `${name} showed a ${lock.reason.replace('_', ' ')} page recently; no new ${name} page work is started until ${new Date(lock.until).toISOString()}.`,
    `Stop ${name} work and tell the user. Do not switch keywords or tabs to continue. After the user says the page is handled, run platform-unlock --platform ${platform}, or resume the paused task with task-resume.`);
  error.allowedAt = lock.until; error.actionNotDispatched = true;
  throw error;
}

/**
 * End a platform lock early, after the user says the page is handled.
 * @param {string} stateDirectory @param {string} platform @returns {Promise<{unlocked: boolean}>} false when it was not locked.
 */
export async function unlockPlatform(stateDirectory, platform) {
  if (!PLATFORMS.includes(platform)) throw new ShoppingError('INVALID_ARGUMENTS', 'Unlock a known platform.');
  const file = path.join(stateDirectory, FILE), record = await load(file);
  if (!record.locks[platform]) return { unlocked: false };
  delete record.locks[platform];
  await save(file, record);
  return { unlocked: true };
}
