import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShoppingError } from './errors.mjs';

/**
 * A random gap before opening a product, order or cart page, counted from the last page of any kind opened on the same
 * platform (user, 2026-11-14). On 2026-11-13 a caller opened three Taobao product pages 13 and 9 seconds apart, within
 * the 6-12 second after-load spacing of lib/pacing.mjs, and the last two showed Taobao's inline 访问异常提示. The gap is
 * always waited in place, so callers need no change; new searches keep their own longer gap (lib/search-gap.mjs).
 */
export const PAGE_GAP_POLICY = Object.freeze({ gap_ms: Object.freeze([15_000, 20_000]) });
const FILE = 'page-gap.json';
const PLATFORMS = new Set(['taobao', 'jd', 'pdd']);

function invalidState() {
  return new ShoppingError('INVALID_PACING_STATE', 'The local page spacing record is unreadable; no page was opened.',
    'Inspect page-gap.json in the state directory. Do not delete it to skip the wait.');
}

async function load(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { schema_version: 1, next_allowed_at: {} };
    throw invalidState();
  }
  const times = value?.next_allowed_at;
  if (value?.schema_version !== 1 || Object.keys(value).length !== 2 || !times || typeof times !== 'object' || Array.isArray(times) ||
    !Object.entries(times).every(([platform, at]) => PLATFORMS.has(platform) && Number.isSafeInteger(at) && at >= 0)) throw invalidState();
  return value;
}

async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Wait out the rest of the gap since the last page opened on this platform.
 * @param {string} stateDirectory @param {'taobao'|'jd'|'pdd'} platform
 * @param {{now?: Function, wait?: Function, policy?: object}} [clock] @returns {Promise<number>} The milliseconds waited.
 * @throws {ShoppingError} INVALID_PACING_STATE.
 */
export async function waitForPageGap(stateDirectory, platform, { now = Date.now, wait = sleep, policy = PAGE_GAP_POLICY } = {}) {
  const allowedAt = (await load(path.join(stateDirectory, FILE))).next_allowed_at[platform] ?? 0;
  // A clock set back must not turn into a long wait: no single gap is longer than the policy's upper bound.
  const delay = Math.min(allowedAt - now(), policy.gap_ms[1]);
  if (delay <= 0) return 0;
  await wait(delay);
  return delay;
}

/**
 * Record that a page of any kind was sent on this platform and draw the gap before its next product, order or cart page.
 * @param {string} stateDirectory @param {'taobao'|'jd'|'pdd'} platform
 * @param {{now?: Function, random?: Function, policy?: object}} [clock] @returns {Promise<number>} next_allowed_at.
 */
export async function recordPageOpened(stateDirectory, platform, { now = Date.now, random = Math.random, policy = PAGE_GAP_POLICY } = {}) {
  const file = path.join(stateDirectory, FILE), record = await load(file), [low, high] = policy.gap_ms;
  const next = now() + Math.round(low + random() * (high - low));
  await save(file, { schema_version: 1, next_allowed_at: { ...record.next_allowed_at, [platform]: next } });
  return next;
}
