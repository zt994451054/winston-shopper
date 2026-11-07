import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShoppingError } from './errors.mjs';
import { PLATFORMS } from './platforms.mjs';

const FILE = 'throttle-observations.json';
const MAX_ENTRIES = 500;
const SIGNALS = new Set(['risk_page', 'rate_limited', 'verification_required']);
const PAGE_KINDS = new Set(['search', 'product', 'orders', 'cart']);

function invalidLog() {
  return new ShoppingError('INVALID_THROTTLE_LOG', 'The local record of platform limits is unreadable or inconsistent.',
    'Inspect throttle-observations.json in the state directory.');
}

const count = value => Number.isSafeInteger(value) && value >= 0;

function validEntry(entry) {
  return entry && Object.keys(entry).length === 5 && PLATFORMS.includes(entry.platform) && typeof entry.observed_at === 'string' &&
    !Number.isNaN(Date.parse(entry.observed_at)) && SIGNALS.has(entry.signal) && PAGE_KINDS.has(entry.page_kind) &&
    entry.loads && Object.values(entry.loads).every(item => item && Object.keys(item).length === 2 && count(item.last_10_minutes) && count(item.last_hour));
}

/**
 * Read the record of observed platform limits, oldest first.
 * @param {string} stateDirectory @returns {Promise<{schema_version: 1, observations: object[]}>}
 * @throws {ShoppingError} INVALID_THROTTLE_LOG.
 */
export async function readThrottleObservations(stateDirectory) {
  let value;
  try { value = JSON.parse(await readFile(path.join(stateDirectory, FILE), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { schema_version: 1, observations: [] };
    throw invalidLog();
  }
  if (value?.schema_version !== 1 || !Array.isArray(value.observations) || value.observations.length > MAX_ENTRIES || !value.observations.every(validEntry)) {
    throw invalidLog();
  }
  return value;
}

/**
 * Append one observed platform limit with the platform's load counts at that moment, so its quotas can be lowered from evidence.
 * @param {string} stateDirectory
 * @param {{platform: string, signal: 'risk_page'|'rate_limited'|'verification_required', page_kind: string, loads: object}} observation
 *   loads comes from Pacer.recentLoads() of the same platform.
 * @param {Date} [now] @returns {Promise<object>} The saved entry.
 * @throws {ShoppingError} INVALID_THROTTLE_LOG.
 */
export async function recordThrottleObservation(stateDirectory, { platform, signal, page_kind, loads }, now = new Date()) {
  const entry = { platform, observed_at: now.toISOString(), signal, page_kind, loads };
  if (!validEntry(entry)) throw new ShoppingError('INVALID_ARGUMENTS', 'A platform limit observation needs a platform, signal, page kind and load counts.');
  const log = await readThrottleObservations(stateDirectory);
  log.observations = [...log.observations, entry].slice(-MAX_ENTRIES);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(stateDirectory, FILE), temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(log, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return entry;
}
