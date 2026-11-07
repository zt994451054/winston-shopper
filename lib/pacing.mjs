import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShoppingError } from './errors.mjs';

/**
 * Pacing approved by the user on 2026-10-12, after a suspected short throttle followed about ten search pages and many
 * sort/range actions within an hour. Values are conservative guesses: the platform's real thresholds are unknown.
 * Only operations that make the platform load data count towards a quota; reading the local DOM sends no request.
 * JD starts with the same values in its own ledger (user decision, 2026-10-14) and is lowered after observed limits.
 */
export const PACING_POLICY = Object.freeze({
  gap_ms: Object.freeze({ read: Object.freeze([2000, 4000]), action: Object.freeze([3000, 6000]), after_load: Object.freeze([6000, 12000]) }),
  limits: Object.freeze({
    search: Object.freeze({ per_10_minutes: 5, per_hour: 15 }),
    page: Object.freeze({ per_10_minutes: 10, per_hour: 40 }),
  }),
  inline_quota_wait_ms: 90000,
});

/**
 * PDD starts with lower load quotas than Taobao and JD (user decision, 2026-10-27): its risk control is reputed to be
 * stricter and an account limit costs more. Spacing between operations is the same.
 */
export const PDD_PACING_POLICY = Object.freeze({
  ...PACING_POLICY,
  limits: Object.freeze({
    search: Object.freeze({ per_10_minutes: 3, per_hour: 10 }),
    page: Object.freeze({ per_10_minutes: 6, per_hour: 24 }),
  }),
});

const TEN_MINUTES = 600000, HOUR = 3600000;
const KINDS = new Set(['read', 'action', 'load']);

function invalidState() {
  return new ShoppingError('INVALID_PACING_STATE', 'The local pacing ledger is unreadable or inconsistent; no page operation was sent.',
    'Inspect pacing.json in the state directory. Do not delete it to regain quota.');
}

function emptyLedger() {
  return { schema_version: 1, last_interaction_at: 0, last_load_at: 0, gap: null, load_gap: null, loads: [] };
}

function validLedger(value) {
  const time = item => Number.isSafeInteger(item) && item >= 0;
  const drawn = item => item === null || (item && time(item.basis) && time(item.ms) &&
    (item.kind === undefined || KINDS.has(item.kind)) && Object.keys(item).every(key => ['basis', 'ms', 'kind'].includes(key)));
  return value && value.schema_version === 1 && time(value.last_interaction_at) && time(value.last_load_at) &&
    drawn(value.gap) && drawn(value.load_gap) && Array.isArray(value.loads) && value.loads.length <= 1000 &&
    value.loads.every(load => load && time(load.at) && Object.hasOwn(PACING_POLICY.limits, load.category) && Object.keys(load).length === 2);
}

/**
 * Persistent cross-task pacing for one state directory: random spacing between page operations, a longer pause after
 * operations that make the platform load data, and per-category load quotas over ten minutes and one hour.
 */
export class Pacer {
  #file; #now; #wait; #random; #policy; #reserved = null;

  /**
   * @param {{file: string, now?: Function, wait?: Function, random?: Function, policy?: object}} options
   * @example new Pacer({ file: path.join(stateDirectory, 'pacing.json') });
   */
  constructor({ file, now = Date.now, wait = sleep, random = Math.random, policy = PACING_POLICY }) {
    this.#file = file; this.#now = now; this.#wait = wait; this.#random = random; this.#policy = policy;
  }

  async #load() {
    let value;
    try { value = JSON.parse(await readFile(this.#file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return emptyLedger();
      throw invalidState();
    }
    if (!validLedger(value)) throw invalidState();
    return value;
  }

  async #save(ledger) {
    const now = this.#now();
    ledger.loads = ledger.loads.filter(load => now - load.at < HOUR);
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.#file);
  }

  #draw([low, high]) { return Math.round(low + this.#random() * (high - low)); }

  #quotaAllowedAt(ledger, category) {
    const now = this.#now(), limit = this.#policy.limits[category];
    const recent = ledger.loads.filter(load => load.category === category).map(load => load.at).sort((a, b) => a - b);
    let allowedAt = now;
    const inTen = recent.filter(at => now - at < TEN_MINUTES), inHour = recent.filter(at => now - at < HOUR);
    if (inTen.length >= limit.per_10_minutes) allowedAt = Math.max(allowedAt, inTen[inTen.length - limit.per_10_minutes] + TEN_MINUTES);
    if (inHour.length >= limit.per_hour) allowedAt = Math.max(allowedAt, inHour[inHour.length - limit.per_hour] + HOUR);
    return allowedAt;
  }

  /**
   * Wait for the spacing before one page operation; for a load, first take one unit of its category quota.
   * @param {'read'|'action'|'load'} kind @param {'search'|'page'} [category] Required for loads.
   * @returns {Promise<void>} @throws {ShoppingError} PACING_LIMIT (marked undispatched) when the quota frees too late.
   */
  async before(kind, category) {
    if (!KINDS.has(kind) || (kind === 'load') !== Object.hasOwn(this.#policy.limits, category ?? '')) {
      throw new ShoppingError('INVALID_ARGUMENTS', 'Pacing needs read, action, or load with a search/page category.');
    }
    let ledger = await this.#load();
    if (kind === 'load') {
      const allowedAt = this.#quotaAllowedAt(ledger, category), delay = allowedAt - this.#now();
      if (delay > this.#policy.inline_quota_wait_ms) {
        const error = new ShoppingError('PACING_LIMIT', 'The local pacing quota for this kind of platform load is used up; nothing was sent.',
          `Wait until ${new Date(allowedAt).toISOString()}, then run the same command again.`);
        error.allowedAt = allowedAt; error.actionNotDispatched = true;
        throw error;
      }
      if (delay > 0) await this.#wait(delay);
    }
    // A drawn gap is saved before waiting, so an interrupted run resumes with the same draw.
    const gapKind = kind === 'load' ? 'action' : kind;
    if (!ledger.gap || ledger.gap.basis !== ledger.last_interaction_at || ledger.gap.kind !== gapKind) {
      ledger.gap = { basis: ledger.last_interaction_at, kind: gapKind, ms: this.#draw(this.#policy.gap_ms[gapKind]) };
    }
    if (ledger.last_load_at && (!ledger.load_gap || ledger.load_gap.basis !== ledger.last_load_at)) {
      ledger.load_gap = { basis: ledger.last_load_at, ms: this.#draw(this.#policy.gap_ms.after_load) };
    }
    await this.#save(ledger);
    const due = Math.max(ledger.last_interaction_at ? ledger.last_interaction_at + ledger.gap.ms : 0,
      ledger.last_load_at ? ledger.last_load_at + ledger.load_gap.ms : 0);
    const delay = due - this.#now();
    if (delay > 0) await this.#wait(delay);
    if (kind === 'load') {
      ledger = await this.#load();
      this.#reserved = { at: this.#now(), category };
      ledger.loads.push(this.#reserved);
      await this.#save(ledger);
    }
  }

  /**
   * Count this ledger's loads per category over the last ten minutes and hour, to record next to an observed platform limit.
   * @returns {Promise<Record<string, {last_10_minutes: number, last_hour: number}>>}
   */
  async recentLoads() {
    const ledger = await this.#load(), now = this.#now();
    return Object.fromEntries(Object.keys(this.#policy.limits).map(category => {
      const ages = ledger.loads.filter(load => load.category === category).map(load => now - load.at);
      return [category, { last_10_minutes: ages.filter(age => age < TEN_MINUTES).length, last_hour: ages.filter(age => age < HOUR).length }];
    }));
  }

  /**
   * Record the end of one page operation. A load that was certainly not dispatched returns its quota unit.
   * @param {'read'|'action'|'load'} kind @param {{dispatched?: boolean}} [outcome] @returns {Promise<void>}
   */
  async after(kind, { dispatched = true } = {}) {
    const ledger = await this.#load(), now = this.#now();
    ledger.last_interaction_at = now;
    if (kind === 'load') {
      const reserved = this.#reserved;
      this.#reserved = null;
      if (dispatched) ledger.last_load_at = now;
      else if (reserved) {
        const index = ledger.loads.findIndex(load => load.at === reserved.at && load.category === reserved.category);
        if (index >= 0) ledger.loads.splice(index, 1);
      }
    }
    await this.#save(ledger);
  }
}
