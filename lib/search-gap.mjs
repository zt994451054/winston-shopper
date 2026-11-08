import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShoppingError } from './errors.mjs';
import { timeText } from './local-time.mjs';

/**
 * A random gap between opening two new search pages, shared by all platforms (user, 2026-11-08). Before this, a caller
 * could open searches on Taobao, JD and PDD one or two minutes apart within each platform's quota; JD then showed a
 * limit page. The gap applies to page-open --search only; sorting, ranges and page turns inside a task keep the
 * per-step spacing of lib/pacing.mjs.
 */
export const SEARCH_GAP_POLICY = Object.freeze({ gap_ms: Object.freeze([120_000, 240_000]), inline_wait_ms: 90_000 });
const FILE = 'search-gap.json';

function invalidState() {
  return new ShoppingError('INVALID_PACING_STATE', 'The local search spacing record is unreadable; no page was opened.',
    'Inspect search-gap.json in the state directory. Do not delete it to skip the wait.');
}

async function load(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { schema_version: 1, next_allowed_at: 0 };
    throw invalidState();
  }
  if (value?.schema_version !== 1 || !Number.isSafeInteger(value.next_allowed_at) || value.next_allowed_at < 0 ||
    Object.keys(value).length !== 2) throw invalidState();
  return value;
}

async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Wait for the random gap since the last new search page of any platform, or refuse when it ends too late.
 * @param {string} stateDirectory @param {{now?: Function, wait?: Function, policy?: object}} [clock]
 * @returns {Promise<void>} @throws {ShoppingError} PACING_LIMIT (marked undispatched, with allowedAt) or INVALID_PACING_STATE.
 */
export async function waitForSearchGap(stateDirectory, { now = Date.now, wait = sleep, policy = SEARCH_GAP_POLICY } = {}) {
  const { next_allowed_at: allowedAt } = await load(path.join(stateDirectory, FILE));
  const delay = allowedAt - now();
  if (delay <= 0) return;
  if (delay > policy.inline_wait_ms) {
    const error = new ShoppingError('PACING_LIMIT', 'A new search page was opened shortly before; nothing was sent.',
      `Wait until ${timeText(allowedAt)}, then open the next search. Searches on all platforms share this spacing.`);
    error.allowedAt = allowedAt; error.actionNotDispatched = true;
    throw error;
  }
  await wait(delay);
}

/**
 * Record that a new search page was sent and draw the gap before the next one.
 * @param {string} stateDirectory @param {{now?: Function, random?: Function, policy?: object}} [clock] @returns {Promise<number>} next_allowed_at.
 */
export async function recordSearchOpened(stateDirectory, { now = Date.now, random = Math.random, policy = SEARCH_GAP_POLICY } = {}) {
  const [low, high] = policy.gap_ms;
  const next = now() + Math.round(low + random() * (high - low));
  await save(path.join(stateDirectory, FILE), { schema_version: 1, next_allowed_at: next });
  return next;
}
