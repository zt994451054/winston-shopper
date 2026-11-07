import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTarget } from '../lib/search.mjs';
import { searchRangeTarget, validateSearchCollectionPage } from '../lib/search-page-range.mjs';
import { newSearchCollectionState, runSearchCollection, validateSearchCollectionState,
  validateSearchCollectionResult, searchCollectionTargets, searchCollectionCachedResult,
  invalidateSearchCollectionCandidate } from '../lib/search-collection.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';
import { ShoppingError } from '../lib/errors.mjs';

function page(number, total = 10, ids = [String(number * 100), '456'], cardLimit = 50, cardsSeen = null) {
  const target = searchRangeTarget('Synthetic range', number), raw = rawSearch(target);
  raw.items = raw.items.slice(0, ids.length).map((item, index) => ({ ...item, url: `https://item.taobao.com/item.htm?id=${ids[index]}` }));
  if (cardsSeen !== null) raw.cards_seen = cardsSeen;
  raw.pagination = { current_page: number, total_pages_displayed: total, next_disabled: number === total,
    previous_disabled: number === 1, selected_sort_label: '综合' };
  return validateSearchCollectionPage(raw, searchTarget(target.query), [number], { cardLimit }).page;
}

function fixture(requested = 3, total = 10) {
  const target = searchTarget('Synthetic range');
  const op = { target, tab_id: 41, attempts: 1, status: 'running', recovery_kind: null,
    search_collection: newSearchCollectionState(requested) };
  let current = 1, clock = 1000, reads = 0, clicks = 0;
  const commits = [], allowed = [];
  const bridge = {
    async readSearchCollectionPage(tab, expected, pages) {
      reads++; allowed.push([...pages]); assert.equal(tab, 41); assert.deepEqual(expected, target);
      assert.ok(pages.includes(current)); return { state: 'observed', page: page(current, total) };
    },
    async nextSearchCollectionPage(tab, expected, before) {
      clicks++; assert.equal(before.search.page, current);
      const persisted = commits.at(-1).search_collection;
      assert.equal(persisted.transitions.at(-1).from_page, current);
      assert.ok(persisted.observations >= reads + clicks);
      current++;
    },
  };
  const context = { bridge, op, now: () => clock, wait: async ms => { clock += ms; },
    commit: async () => { validateSearchCollectionState(op.search_collection, target, op); commits.push(structuredClone(op)); } };
  return { op, target, context, commits, allowed, bridge, reads: () => reads, clicks: () => clicks,
    setPage: n => { current = n; } };
}

test('new search collections validate integer 1–5 scope and independent observation/recovery limits', () => {
  for (const value of [undefined, 0, 6, 1.5, '3', null]) assert.throws(() => newSearchCollectionState(value), { code: 'INVALID_ARGUMENTS' });
  for (let requested = 1; requested <= 5; requested++) {
    const state = newSearchCollectionState(requested);
    assert.equal(state.requested_pages, requested); assert.equal(state.cards_per_page, 50);
    assert.equal(state.recovery_limit, 2); assert.equal(state.recovery_wait_ms, 5000);
    assert.equal(state.read_limit, 6); assert.ok(state.observation_limit >= 1 + 4 * (requested - 1));
    validateSearchCollectionState(state, searchTarget('Synthetic range'), { attempts: 0, status: 'pending', recovery_kind: null });
  }
});

test('a collection started with twenty-five cards per page keeps that limit, and fifty-card pages drop unscanned cards', async () => {
  const legacy = fixture(2), limits = [];
  let shown = 1;
  legacy.op.search_collection.cards_per_page = 25;
  legacy.bridge.readSearchCollectionPage = async (tab, expected, pages, options) => {
    limits.push(options); return { state: 'observed', page: page(shown, 10, undefined, options.cardLimit) };
  };
  legacy.bridge.nextSearchCollectionPage = async () => { shown++; };
  const old = await runSearchCollection(legacy.context);
  assert.deepEqual(limits.map(options => options.cardLimit), [25, 25, 25]);
  assert.equal(old.limits.cards_per_page, 25); assert.ok(old.missing.includes('unscanned_cards'));
  for (const [cardsSeen, unscanned] of [[2, false], [60, true]]) {
    const run = fixture(1);
    run.bridge.readSearchCollectionPage = async () => ({ state: 'observed', page: page(1, 10, undefined, 50, cardsSeen) });
    const result = await runSearchCollection(run.context);
    assert.equal(result.limits.cards_per_page, 50); assert.equal(result.missing.includes('unscanned_cards'), unscanned);
  }
  const mixed = fixture(2); mixed.op.search_collection.cards_per_page = 25;
  await assert.rejects(runSearchCollection(mixed.context), { code: 'INVALID_RESPONSE' });
});

test('three pages preserve each observation and cumulative unique and record counts, with durable click intent', async () => {
  const f = fixture(), result = await runSearchCollection(f.context);
  assert.deepEqual(result.pages.map(p => p.search.page), [1, 2, 3]);
  assert.equal(f.clicks(), 2); assert.equal(f.reads(), 5);
  assert.equal(result.records, 6); assert.equal(result.distinct_products, 4);
  assert.equal(result.action_evidence.observations_reserved, 7);
  assert.equal(result.coverage.status, 'partial'); assert.equal(result.coverage.requested_bound_reached, true);
  assert.equal(result.coverage.visible_last_page_verified, false);
  assert.equal(result.coverage.total_results_known, false);
  validateSearchCollectionResult(result, f.target, f.op.search_collection);
  const reads = f.reads(); assert.deepEqual(await runSearchCollection(f.context), result); assert.equal(f.reads(), reads);
});

test('one-page request reserves no clicks and visible last page can finish a larger request', async () => {
  const one = fixture(1), a = await runSearchCollection(one.context);
  assert.equal(one.clicks(), 0); assert.equal(one.reads(), 1); assert.equal(a.end_reason, 'requested_pages');
  assert.equal(a.coverage.page_transition_verified, false);
  const last = fixture(5, 3), b = await runSearchCollection(last.context);
  assert.equal(last.clicks(), 2); assert.equal(b.pages.length, 3);
  assert.equal(b.limits.requested_pages, 5); assert.equal(b.end_reason, 'visible_last_page');
  assert.equal(b.coverage.visible_last_page_verified, true); assert.equal(b.coverage.requested_bound_reached, false);
});

test('five-page request uses four actions and never permits arbitrary previous or future pages', async () => {
  const f = fixture(5), result = await runSearchCollection(f.context);
  assert.equal(result.pages.length, 5); assert.equal(f.clicks(), 4);
  assert.deepEqual(f.allowed, [[1], [1, 2], [1, 2], [2, 3], [2, 3], [3, 4], [3, 4], [4, 5], [4, 5]]);
  assert.deepEqual(searchCollectionTargets(f.target, f.op.search_collection).map(p => p.page), [5]);
});

test('lost action acknowledgement is recorded per transition and never repeats a click', async () => {
  const f = fixture(), original = f.bridge.nextSearchCollectionPage;
  f.bridge.nextSearchCollectionPage = async (...args) => { await original(...args); throw new ShoppingError('BRIDGE_UNAVAILABLE', 'lost'); };
  const result = await runSearchCollection(f.context);
  assert.equal(f.clicks(), 2);
  assert.deepEqual(result.action_evidence.transitions.map(t => t.acknowledgement_error), ['BRIDGE_UNAVAILABLE', 'BRIDGE_UNAVAILABLE']);
});

test('interruption immediately after dispatch resumes original intent without repeating action', async () => {
  const f = fixture(), original = f.bridge.nextSearchCollectionPage;
  let interrupt = true;
  f.bridge.nextSearchCollectionPage = async (...args) => { await original(...args); if (interrupt) throw new ShoppingError('HOST_INTERRUPTED', 'stop'); };
  // A host disappearing after dispatch cannot write an acknowledgement; the already saved intent is sufficient.
  let commits = 0, normalCommit = f.context.commit;
  f.context.commit = async () => { await normalCommit(); if (++commits === 4) throw new ShoppingError('HOST_INTERRUPTED', 'stop'); };
  await assert.rejects(runSearchCollection(f.context), { code: 'HOST_INTERRUPTED' });
  interrupt = false; f.context.commit = normalCommit;
  const result = await runSearchCollection(f.context);
  assert.equal(f.clicks(), 2); assert.equal(result.pages.length, 3);
});

test('gate after a candidate clears its consecutive proof but preserves confirmed pages and intent', async () => {
  const f = fixture(), original = f.bridge.readSearchCollectionPage;
  let calls = 0;
  f.bridge.readSearchCollectionPage = async (...args) => { if (++calls === 3) throw new ShoppingError('LOGIN_REQUIRED', 'gate'); return original(...args); };
  await assert.rejects(runSearchCollection(f.context), { code: 'LOGIN_REQUIRED' });
  assert.equal(f.op.search_collection.pages.length, 1);
  invalidateSearchCollectionCandidate(f.op.search_collection);
  f.bridge.readSearchCollectionPage = original;
  const result = await runSearchCollection(f.context);
  assert.equal(result.pages.length, 3); assert.equal(f.clicks(), 2);
});

test('unchanged cards on a new page stop after three checks and retain the prior page', async () => {
  const f = fixture();
  f.bridge.readSearchCollectionPage = async (tab, target, allowed) => ({ state: 'observed', page: page(allowed.at(-1), 10, ['100', '456']) });
  await assert.rejects(runSearchCollection(f.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(f.clicks(), 1); assert.equal(f.op.search_collection.pages.length, 1);
  assert.equal(f.op.search_collection.transitions[0].checks, 3);
});

test('changing candidate identity order requires a new consecutive pair and preserves earliest confirmed page', async () => {
  const f = fixture(2); let calls = 0;
  f.bridge.readSearchCollectionPage = async () => ({ state: 'observed', page: ++calls === 1 ? page(1) : page(2, 10, calls === 2 ? ['200', '456'] : ['456', '200']) });
  const result = await runSearchCollection(f.context);
  assert.deepEqual(result.pages[1].search.items.map(item => item.product_id), ['456', '200']);
  assert.equal(f.op.search_collection.transitions[0].checks, 3);
});

test('malformed adapter output cannot enter a durable page snapshot', async () => {
  const f = fixture(); f.bridge.readSearchCollectionPage = async () => ({ state: 'observed', page: { search: {} } });
  await assert.rejects(runSearchCollection(f.context), { code: 'INVALID_RESPONSE' });
  assert.equal(f.op.search_collection.pages.length, 0); assert.equal(f.clicks(), 0);
});

test('changed displayed page count stops without claiming a natural last page or changing saved snapshots', async () => {
  const f = fixture(5);
  let reads = 0;
  f.bridge.readSearchCollectionPage = async () => ({ state: 'observed', page: ++reads === 1 ? page(1, 10) : page(2, 2) });
  await assert.rejects(runSearchCollection(f.context), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.equal(f.op.search_collection.pages.length, 1); assert.equal(f.clicks(), 1);
  assert.equal(f.op.search_collection.pages[0].pagination.total_pages_displayed, 10);
});

test('checkpoint validation rejects altered limits, discontinuous pages, extra state and refunded observation budgets', async () => {
  const f = fixture(); await runSearchCollection(f.context);
  for (const mutate of [s => { s.requested_pages = 6; }, s => { s.cards_per_page = 25; }, s => { s.cards_per_page = 40; }, s => { s.observation_limit++; },
    s => { s.observations = 0; }, s => { s.pages.reverse(); }, s => { s.transitions[0].from_page = 2; },
    s => { s.transitions[0].confirmed = false; }, s => { s.transitions[0].checks = 1; }, s => { s.extra = true; },
    s => { s.recoveries_reserved = 3; }, s => { s.failures = [{ attempt: 1, code: 'BRIDGE_TIMEOUT', category: 'item' }]; }]) {
    const state = structuredClone(f.op.search_collection); mutate(state);
    assert.throws(() => validateSearchCollectionState(state, f.target, f.op), { code: 'INVALID_CHECKPOINT' });
  }
});

test('cached result must equal the journal including individual times, counts and coverage', async () => {
  const f = fixture(), result = await runSearchCollection(f.context);
  for (const mutate of [r => { r.records++; }, r => { r.distinct_products++; }, r => { r.coverage.status = 'complete'; },
    r => { r.pages[0].search.observed_at = '2020-01-01T00:00:00.000Z'; }, r => { r.pages.pop(); }, r => { r.login_verified = true; }]) {
    const value = structuredClone(result); mutate(value);
    assert.throws(() => validateSearchCollectionResult(value, f.target, f.op.search_collection), { code: 'INVALID_CHECKPOINT' });
  }
});

test('complete journal can publish its local result without a new execution or observation', async () => {
  const f = fixture(); assert.equal(searchCollectionCachedResult(f.target, f.op.search_collection), null);
  const result = await runSearchCollection(f.context), before = structuredClone(f.op);
  assert.deepEqual(searchCollectionCachedResult(f.target, f.op.search_collection), result);
  assert.deepEqual(f.op, before);
});

test('pending candidates require an actual snapshot and the unchanged displayed total', async () => {
  const f = fixture(); const original = f.bridge.readSearchCollectionPage; let reads = 0;
  f.bridge.readSearchCollectionPage = async (...args) => {
    if (++reads === 3) throw new ShoppingError('LOGIN_REQUIRED', 'gate');
    return original(...args);
  };
  await assert.rejects(runSearchCollection(f.context));
  for (const candidate of [false, 0, '', page(2, 9)]) {
    const state = structuredClone(f.op.search_collection); state.transitions[0].candidate = candidate;
    assert.throws(() => validateSearchCollectionState(state, f.target, f.op), { code: 'INVALID_CHECKPOINT' });
  }
  assert.deepEqual(searchCollectionTargets(f.target, f.op.search_collection).map(target => target.page), [1, 2]);
});

test('known undispatched action retains its reservation and cannot produce a second click on recovery', async () => {
  const f = fixture(2); let calls = 0;
  f.bridge.nextSearchCollectionPage = async () => {
    calls++; const error = new ShoppingError('TARGET_MISSING', 'preparation failed'); error.actionNotDispatched = true; throw error;
  };
  await assert.rejects(runSearchCollection(f.context), { code: 'TARGET_MISSING' });
  assert.equal(f.op.search_collection.transitions.length, 1);
  assert.equal(f.op.search_collection.transitions[0].acknowledgement_error, 'TARGET_MISSING');
  await assert.rejects(runSearchCollection(f.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
});

test('a next-page call held by the local pacing quota releases its intent, so a later run clicks once', async () => {
  const f = fixture(2), original = f.bridge.nextSearchCollectionPage; let calls = 0;
  f.bridge.nextSearchCollectionPage = async (...args) => {
    if (!calls++) {
      const error = new ShoppingError('PACING_LIMIT', 'Synthetic quota.'); error.actionNotDispatched = true; error.allowedAt = 600000; throw error;
    }
    return original(...args);
  };
  await assert.rejects(runSearchCollection(f.context), { code: 'PACING_LIMIT' });
  assert.equal(f.op.search_collection.transitions.length, 0);
  assert.equal(f.op.search_collection.pages.length, 1);
  assert.equal(f.clicks(), 0);
  const result = await runSearchCollection(f.context);
  assert.deepEqual(result.pages.map(p => p.search.page), [1, 2]);
  assert.equal(result.action_evidence.transitions.length, 1);
  assert.equal(f.clicks(), 1);
});

test('a transient display marker consumes a confirmation check but never becomes a successful page', async () => {
  const f = fixture(2), original = f.bridge.readSearchCollectionPage; let reads = 0;
  f.bridge.readSearchCollectionPage = async (...args) => ++reads === 2 ? { state: 'page_transition' } : original(...args);
  const result = await runSearchCollection(f.context);
  assert.equal(result.pages.length, 2); assert.equal(f.op.search_collection.transitions[0].checks, 3);
});

test('persisted wait and exhausted observation budgets fail without new page IO', async () => {
  const f = fixture(); f.op.search_collection.not_before = 20000;
  await assert.rejects(runSearchCollection(f.context), { code: 'CLOCK_CHANGED' }); assert.equal(f.reads(), 0);
  f.op.search_collection.not_before = 0; f.op.search_collection.observations = f.op.search_collection.observation_limit;
  await assert.rejects(runSearchCollection(f.context), { code: 'SEARCH_OBSERVATION_LIMIT' }); assert.equal(f.reads(), 0);
});
