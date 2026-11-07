import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateOrderRows, validateSavedOrderRows, validateOrderBatch, validateSavedOrderBatch } from '../lib/order-rows.mjs';
import { newOrderCollection, orderCollectionPlan, orderCollectionResult, validateOrderCollection } from '../lib/order-collection.mjs';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask, validateTask } from '../lib/task-store.mjs';
import { orderGroup, observeOrders, orderTarget as target } from '../test-support/order-fixture.mjs';
import { emptyListObservation } from '../test-support/list-empty-fixture.mjs';

const firstPlan = { start: 1, limit: 5, loaded_orders_seen: null, guards: [] };
const emptyRaw = plan => emptyListObservation('orders', plan);
const emptySnapshot = () => validateOrderRows(emptyRaw(), target);
const emptyBatch = plan => validateOrderBatch(emptyRaw(plan), target, plan);

test('explicit empty orders use schema three and verify only the current empty list view', () => {
  const raw = emptyRaw(), result = validateOrderRows(raw, target);
  assert.equal(result.schema_version, 3);
  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.empty_evidence, raw.empty_evidence);
  assert.notEqual(result.empty_evidence, raw.empty_evidence);
  assert.notEqual(result.empty_evidence.message, raw.empty_evidence.message);
  assert.deepEqual(result.coverage, { status: 'partial', loaded_orders_seen: 0, returned_orders: 0,
    orders_omitted: 0, page_total_orders: null, full_order_history: false, empty_orders_verified: true,
    account_identity_verified: false, filters_verified: false, settlement_verified: false });
  assert.deepEqual(result.privacy, { local_only: true, contact_fields_read: false, account_profile_read: false });
  assert.equal(validateSavedOrderRows(result, target), result);
});

test('zero DOM groups and old observed responses never manufacture empty evidence', () => {
  assert.deepEqual(observeOrders([]), { state: 'structure_changed' });
  assert.throws(() => validateOrderRows(observeOrders([]), target), { code: 'PAGE_STRUCTURE_CHANGED' });
  const raw = emptyRaw(); raw.state = 'observed'; delete raw.empty_evidence;
  assert.throws(() => validateOrderRows(raw, target), { code: 'INVALID_RESPONSE' });
});

test('empty orders reject missing, ambiguous, truncated, hidden, loading or gate evidence', () => {
  const changes = [
    v => { delete v.empty_evidence; }, v => { v.empty_evidence = null; },
    v => { v.empty_evidence.extra = true; }, v => { delete v.empty_evidence.scope; },
    v => { v.empty_evidence.scope = 'account'; }, v => { v.empty_evidence.basis = 'zero_rows'; },
    v => { v.empty_evidence.message = null; }, v => { v.empty_evidence.message.extra = true; },
    v => { v.empty_evidence.message.text = ''; }, v => { v.empty_evidence.message.text = ' notice '; },
    v => { v.empty_evidence.message.text = 'x'.repeat(501); }, v => { v.empty_evidence.message.text = 'notice\n'; },
    v => { v.empty_evidence.message.text = 'notice\ttext'; }, v => { v.empty_evidence.message.text = 'notice\u0000'; },
    v => { v.empty_evidence.message.truncated = true; }, v => { v.empty_evidence.message.truncated = 'false'; },
    v => { v.empty_evidence.list_root_count = 0; }, v => { v.empty_evidence.list_root_count = 2; },
    v => { v.empty_evidence.notice_count = 2; }, v => { v.empty_evidence.notice_visible = false; },
    v => { v.empty_evidence.notice_within_list = false; }, v => { v.empty_evidence.document_ready = false; },
    v => { v.empty_evidence.gates_clear = false; }, v => { v.empty_evidence.gates_clear = 'true'; },
    v => { v.loaded_orders_seen = 1; }, v => { v.orders = [{}]; },
    v => { v.source = 'inferred_empty'; }, v => { v.observed_at = 'unknown'; }, v => { v.account = 'PRIVATE'; },
  ];
  for (const change of changes) {
    const raw = emptyRaw(); change(raw);
    assert.throws(() => validateOrderRows(raw, target), { code: 'INVALID_RESPONSE' });
  }
});

test('empty evidence does not displace target identity checks or page gate failures', () => {
  const raw = emptyRaw(); raw.url = 'https://mail.example.test/';
  assert.throws(() => validateOrderRows(raw, target), { code: 'INVALID_RESPONSE' });
  for (const [state, code] of [['loading', 'PAGE_LOADING'], ['login_required', 'LOGIN_REQUIRED'],
    ['verification_required', 'VERIFICATION_REQUIRED'], ['rate_limited', 'RATE_LIMITED']]) {
    assert.throws(() => validateOrderRows({ state }, target), { code });
  }
});

test('saved empty orders reject forged coverage, evidence, schema, source and private fields', () => {
  const saved = emptySnapshot();
  const changes = [v => { v.schema_version = 1; }, v => { v.schema_version = 2; }, v => { delete v.empty_evidence; },
    v => { v.empty_evidence.notice_visible = false; }, v => { v.coverage.empty_orders_verified = false; },
    v => { v.coverage.full_order_history = true; }, v => { v.coverage.page_total_orders = 0; },
    v => { v.coverage.account_identity_verified = true; }, v => { v.coverage.filters_verified = true; },
    v => { v.coverage.settlement_verified = true; }, v => { v.coverage.loaded_orders_seen = 1; },
    v => { v.coverage.orders_omitted = 1; }, v => { v.orders = [{}]; },
    v => { v.source = 'guessed'; }, v => { v.privacy.contact_fields_read = true; }, v => { v.account = 'PRIVATE'; }];
  for (const change of changes) {
    const value = structuredClone(saved); change(value);
    assert.throws(() => validateSavedOrderRows(value, target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('first empty order batch preserves range and zero prefix evidence without full-history claims', () => {
  const result = emptyBatch(firstPlan);
  assert.equal(result.schema_version, 3);
  assert.deepEqual(result.range, { start: 1, limit: 5 });
  assert.deepEqual(result.prefix_guard, { positions_checked: 0, observed_values_match: true, physical_order_identity_verified: false });
  assert.equal(result.coverage.empty_orders_verified, true);
  assert.equal(validateSavedOrderBatch(result, target, firstPlan), result);
  for (const change of [v => { v.range.start = 2; }, v => { v.range.limit = 4; },
    v => { v.prefix_guard.positions_checked = 1; }, v => { v.prefix_guard.physical_order_identity_verified = true; }]) {
    const value = structuredClone(result); change(value);
    assert.throws(() => validateSavedOrderBatch(value, target, firstPlan), { code: 'INVALID_CHECKPOINT' });
  }
});

test('empty batch range fields are validated and later empty views count as changed orders', () => {
  for (const change of [v => { delete v.start; }, v => { v.start = 2; },
    v => { v.limit = 4; }, v => { v.prefix = [{}]; }]) {
    const raw = emptyRaw(firstPlan); change(raw);
    assert.throws(() => validateOrderBatch(raw, target, firstPlan), { code: 'INVALID_RESPONSE' });
  }
  const groups = Array.from({ length: 8 }, (_, index) => orderGroup(index + 1).group);
  const state = newOrderCollection();
  state.batches.push({ attempt: 1, snapshot: validateOrderBatch(observeOrders(groups, { plan: firstPlan }), target, firstPlan) });
  const later = orderCollectionPlan(state, 10);
  assert.equal(later.start, 6);
  assert.throws(() => validateOrderBatch(emptyRaw(later), target, later), { code: 'ORDER_ROWS_CHANGED' });
  const invalid = emptyRaw(later); invalid.empty_evidence.notice_count = 2;
  assert.throws(() => validateOrderBatch(invalid, target, later), { code: 'INVALID_RESPONSE' });
});

test('one first empty batch completes the loaded collection and uses schema three aggregate evidence', () => {
  const state = newOrderCollection(); state.batches.push({ attempt: 1, snapshot: emptyBatch(firstPlan) });
  assert.equal(orderCollectionPlan(state, 10), null);
  const result = orderCollectionResult(state, target, 10);
  assert.equal(result.schema_version, 3);
  assert.deepEqual(result.empty_evidence, state.batches[0].snapshot.empty_evidence);
  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.coverage, { status: 'partial', loaded_orders_seen: 0, returned_orders: 0,
    orders_omitted: 0, requested_limit_reached: false, requested_loaded_range_read: true,
    page_total_orders: null, full_order_history: false, empty_orders_verified: true, account_identity_verified: false,
    filters_verified: false, physical_order_identity_verified: false, settlement_verified: false });
});

test('empty collection checkpoints reject more batches and forged final results', () => {
  const state = newOrderCollection(); state.batches.push({ attempt: 1, snapshot: emptyBatch(firstPlan) });
  const op = { status: 'succeeded', attempts: 1, order_read: { schema_version: 2, order_limit: 10, failures: [] },
    result: orderCollectionResult(state, target, 10), error: null };
  validateOrderCollection(state, target, op, 'complete');
  const duplicate = structuredClone(state); duplicate.batches.push({ ...duplicate.batches[0], attempt: 2 });
  assert.throws(() => validateOrderCollection(duplicate, target, { ...op, attempts: 2 }, 'complete'), { code: 'INVALID_CHECKPOINT' });
  for (const change of [v => { v.result.coverage.full_order_history = true; },
    v => { delete v.result.empty_evidence; }, v => { v.result.schema_version = 1; },
    v => { v.result.coverage.empty_orders_verified = false; }]) {
    const value = structuredClone(op); change(value);
    assert.throws(() => validateOrderCollection(state, target, value, 'complete'), { code: 'INVALID_CHECKPOINT' });
  }
});

async function taskFixture(t, action) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'synthetic order empty '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let reads = 0, time = Date.parse('2026-10-10T00:00:00Z');
  const bridge = { endpoint: 'http://127.0.0.1:19824', async requireConnected() {},
    async listTabs() { return [{ id: 41, url: target.url }]; },
    async readOrderBatch(id, expected, plan) { reads++; return action(reads, plan); } };
  const options = { stateDirectory, task: 'synthetic-orders', orders: true, orderRows: 10, tabId: 41, bridge };
  const clock = { now: () => time, wait: async ms => { time += ms; } };
  await createTask(options);
  return { options, clock, reads: () => reads };
}

test('synthetic formal empty collection saves once then run/status/next-batch return only the cache', async t => {
  const fixture = await taskFixture(t, (reads, plan) => emptyBatch(plan));
  const result = await runTask(fixture.options, fixture.clock);
  assert.equal(result.status, 'complete');
  assert.equal(result.operations[0].attempts, 1);
  assert.equal(result.operations[0].result.coverage.empty_orders_verified, true);
  assert.equal(result.operations[0].result.schema_version, 3);
  assert.equal(fixture.reads(), 1);
  const saved = await loadTask(fixture.options.stateDirectory, fixture.options.task);
  assert.equal(validateTask(saved), saved);
  assert.deepEqual(await taskStatus(fixture.options), result);
  assert.deepEqual(await runTask(fixture.options, fixture.clock), result);
  assert.deepEqual(await runTask({ ...fixture.options, nextBatch: true }, fixture.clock), result);
  assert.equal(fixture.reads(), 1);
});

test('later synthetic empty observation stops and retains earlier order batch bytes and its time', async t => {
  const groups = Array.from({ length: 8 }, (_, index) => orderGroup(index + 1).group);
  const fixture = await taskFixture(t, (reads, plan) => reads === 1
    ? validateOrderBatch(observeOrders(groups, { plan }), target, plan) : emptyBatch(plan));
  const first = await runTask(fixture.options, fixture.clock);
  assert.equal(first.status, 'awaiting_batch');
  const savedBefore = await loadTask(fixture.options.stateDirectory, fixture.options.task);
  const originalBatch = JSON.stringify(savedBefore.operations[0].order_collection.batches[0]);
  const result = await runTask({ ...fixture.options, nextBatch: true }, fixture.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(result.operations[0].error.code, 'ORDER_ROWS_CHANGED');
  assert.equal(result.operations[0].order_collection.orders.length, 5);
  assert.equal(result.operations[0].attempts, 2);
  assert.equal(result.automatic_retries, 0);
  assert.equal(result.operations[0].order_collection.coverage.empty_orders_verified, false);
  const savedAfter = await loadTask(fixture.options.stateDirectory, fixture.options.task);
  assert.equal(JSON.stringify(savedAfter.operations[0].order_collection.batches[0]), originalBatch);
  assert.equal(fixture.reads(), 2);
});
