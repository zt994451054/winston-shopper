import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShoppingError } from './errors.mjs';
import { PLATFORMS } from './platforms.mjs';
import { timeText } from './local-time.mjs';

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
    if (error.code === 'ENOENT') return { schema_version: 1, locks: {}, search_holds: {} };
    throw invalidState();
  }
  const holds = value?.search_holds ?? {};
  if (value?.schema_version !== 1 || !value.locks || typeof value.locks !== 'object' ||
    !Object.entries(value.locks).every(([platform, lock]) => PLATFORMS.includes(platform) && validLock(lock)) ||
    typeof holds !== 'object' || Array.isArray(holds) ||
    !Object.entries(holds).every(([platform, until]) => PLATFORMS.includes(platform) && Number.isSafeInteger(until))) throw invalidState();
  return { ...value, search_holds: { ...holds } };
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
  const error = new ShoppingError('PLATFORM_LOCKED', `${name} showed a ${lock.reason.replace('_', ' ')} page recently; no new ${name} page work is started until ${timeText(lock.until)}.`,
    `Stop ${name} work and tell the user. Do not switch keywords or tabs to continue. After the user says the page is handled, run platform-unlock --platform ${platform}, or resume the paused task with task-resume.`);
  error.allowedAt = lock.until; error.actionNotDispatched = true;
  throw error;
}

/**
 * End a platform lock early, after the user says the page is handled. With holdSearches (platform-unlock), new search
 * pages on that platform still wait until the lock would have ended: on 2026-11-08 the user could search JD by hand right
 * after a limit, but a new search the program opened a minute later met the limit again; 37 minutes later it read fine.
 * @param {string} stateDirectory @param {string} platform @param {{holdSearches?: boolean, now?: Function}} [options]
 * @returns {Promise<{unlocked: boolean, searches_wait_until?: string}>} unlocked is false when it was not locked.
 */
export async function unlockPlatform(stateDirectory, platform, { holdSearches = false, now = Date.now } = {}) {
  if (!PLATFORMS.includes(platform)) throw new ShoppingError('INVALID_ARGUMENTS', 'Unlock a known platform.');
  const file = path.join(stateDirectory, FILE), record = await load(file);
  const lock = record.locks[platform];
  if (!lock) return { unlocked: false };
  delete record.locks[platform];
  const held = holdSearches && lock.until > now();
  if (held) record.search_holds[platform] = lock.until;
  await save(file, record);
  return { unlocked: true, ...(held ? { searches_wait_until: timeText(lock.until) } : {}) };
}

/**
 * Refuse a new search page on a platform whose lock the user ended early, until the lock would have ended.
 * @param {string} stateDirectory @param {string} platform @param {{now?: Function}} [clock] @returns {Promise<void>}
 * @throws {ShoppingError} PACING_LIMIT (marked undispatched, with allowedAt) or INVALID_PACING_STATE.
 */
export async function requireSearchHoldOver(stateDirectory, platform, { now = Date.now } = {}) {
  const until = (await load(path.join(stateDirectory, FILE))).search_holds[platform];
  if (!until || until <= now()) return;
  const name = NAMES[platform] ?? platform;
  const error = new ShoppingError('PACING_LIMIT', `${name} showed a limit page less than 15 minutes ago; a new ${name} search waits until ${timeText(until)}. Pages already open can still be read.`,
    `Tell the user when the ${name} search can start, and do other work meanwhile. Do not switch keywords or platforms to get around it.`);
  error.allowedAt = until; error.actionNotDispatched = true;
  throw error;
}
