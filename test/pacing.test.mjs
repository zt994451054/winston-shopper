import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Pacer, PACING_POLICY } from '../lib/pacing.mjs';

async function harness(t, { random = () => 0.5 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pacing '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 12, 12, 0, 0);
  const waits = [];
  const clock = { now: () => now, wait: async ms => { waits.push(ms); now += ms; }, advance: ms => { now += ms; } };
  const file = path.join(directory, 'pacing.json');
  const pacer = new Pacer({ file, now: clock.now, wait: clock.wait, random });
  return { file, pacer, clock, waits, directory, again: options => new Pacer({ file, now: clock.now, wait: clock.wait, random, ...options }) };
}

test('the approved policy: random gaps per kind, a longer gap after loads, and quota per category', () => {
  assert.deepEqual(PACING_POLICY.gap_ms, { read: [2000, 4000], action: [3000, 6000], after_load: [6000, 12000] });
  assert.deepEqual(PACING_POLICY.limits, { search: { per_10_minutes: 5, per_hour: 15 }, page: { per_10_minutes: 10, per_hour: 40 } });
  assert.ok(Object.isFrozen(PACING_POLICY) && Object.isFrozen(PACING_POLICY.limits.search));
});

test('gaps are drawn inside each range, saved before waiting, and reused after a restart', async t => {
  const h = await harness(t, { random: () => 0.25 });
  await h.pacer.before('read'); await h.pacer.after('read');
  assert.deepEqual(h.waits, [], 'the first interaction has no earlier interaction to space from');
  h.clock.advance(100);
  // Interrupt during the wait: the drawn gap is already on disk.
  const interrupted = h.again({ wait: async () => { throw new Error('killed'); } });
  await assert.rejects(interrupted.before('action'), /killed/);
  const saved = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(saved.gap.ms, 3000 + 0.25 * 3000);
  const resumed = h.again({ random: () => 0.99 });
  await resumed.before('action');
  assert.deepEqual(h.waits, [3750 - 100]);
});

test('after a load, the next interaction waits the after-load range', async t => {
  const h = await harness(t, { random: () => 0.5 });
  await h.pacer.before('load', 'search'); await h.pacer.after('load', { dispatched: true });
  await h.pacer.before('read');
  assert.deepEqual(h.waits, [9000]);
});

test('search quota allows five loads per ten minutes, waits briefly inline, and otherwise reports when to continue', async t => {
  const h = await harness(t, { random: () => 0 });
  for (let index = 0; index < 5; index++) {
    await h.pacer.before('load', 'search'); await h.pacer.after('load', { dispatched: true });
    h.clock.advance(60_000);
  }
  // The first load is 5 minutes old; the window frees 5 minutes from now, beyond the inline wait.
  const error = await h.pacer.before('load', 'search').catch(value => value);
  assert.equal(error.code, 'PACING_LIMIT'); assert.equal(error.actionNotDispatched, true);
  assert.equal(error.allowedAt, Date.UTC(2026, 9, 12, 12, 10, 0));
  assert.match(error.nextAction, /2026-10-12T12:10:00.000Z/);
  // Page opens have their own quota.
  await h.pacer.before('load', 'page');
  h.clock.advance(5 * 60_000 - 60_000);
  const before = h.waits.length;
  await h.pacer.before('load', 'search');
  assert.equal(h.waits.length > before, true, 'a short remaining window is waited inline');
});

test('the hourly search cap applies even when each ten-minute window has room', async t => {
  const h = await harness(t, { random: () => 0 });
  for (let index = 0; index < 15; index++) {
    await h.pacer.before('load', 'search'); await h.pacer.after('load', { dispatched: true });
    h.clock.advance(3 * 60_000);
  }
  const error = await h.pacer.before('load', 'search').catch(value => value);
  assert.equal(error.code, 'PACING_LIMIT');
  assert.equal(error.allowedAt, Date.UTC(2026, 9, 12, 13, 0, 0));
  h.clock.advance(Date.UTC(2026, 9, 12, 13, 0, 0) - h.clock.now());
  await h.pacer.before('load', 'search');
});

test('an action that was certainly not dispatched gives its quota back and does not count as a load', async t => {
  const h = await harness(t, { random: () => 0 });
  for (let index = 0; index < 5; index++) {
    await h.pacer.before('load', 'search');
    await h.pacer.after('load', { dispatched: false });
  }
  await h.pacer.before('load', 'search');
  const saved = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(saved.loads.length, 1); assert.equal(saved.last_load_at, 0);
});

test('invalid kinds, categories or ledgers fail closed instead of guessing', async t => {
  const h = await harness(t);
  await assert.rejects(h.pacer.before('click'), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(h.pacer.before('load', 'cart'), { code: 'INVALID_ARGUMENTS' });
  await writeFile(h.file, '{"schema_version":1,"loads":"x"}');
  await assert.rejects(h.pacer.before('read'), { code: 'INVALID_PACING_STATE' });
});
