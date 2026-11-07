import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, runTask, taskStatus, rebindTask } from '../lib/tasks.mjs';
import { loadTask, validateTask, withTaskStore } from '../lib/task-store.mjs';
import { orderBatchScript, orderGuard, validateOrderBatch, validateSavedOrderBatch } from '../lib/order-rows.mjs';
import { newOrderCollection, orderCollectionPlan } from '../lib/order-collection.mjs';
import { parseOrderListUrl } from '../lib/order-target.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { main } from '../lib/cli.mjs';
import { orderGroup, observeOrders, orderTarget } from '../test-support/order-fixture.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseOrderListUrl(orderTarget.url);
const groups = count => Array.from({ length: count }, (_, i) => orderGroup(i + 1, { itemCount: i === 1 ? 8 : 1 }));
const batch = (items, plan) => validateOrderBatch(observeOrders(items.map(item => item.group), { plan }), target, plan);
const firstPlan = limit => ({ start: 1, limit, loaded_orders_seen: null, guards: [] });
const fail = code => { throw new ShoppingError(code, 'Synthetic private order exception'); };
const setText = (node, value) => Object.defineProperty(node, 'innerText', { value, configurable: true });
async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), 'order collection '));
  t.after(() => rm(value, { recursive: true, force: true })); return value;
}
async function fixture(t, { limit = 12, count = 14, action } = {}) {
  const stateDirectory = await directory(t), items = groups(count), calls = [], waits = [];
  let time = Date.parse('2026-10-06T00:00:00Z');
  const tabs = [{ id: 41, url: target.url }, { id: 42, url: target.url }];
  const bridge = { endpoint: 'http://127.0.0.1:19824', connected: true,
    async requireConnected() { if (!this.connected) fail('EXTENSION_DISCONNECTED'); },
    async listTabs() { return tabs; },
    async readOrderBatch(id, expected, plan) {
      const saved = await loadTask(stateDirectory, 'orders'), op = saved.operations[0];
      assert.equal(op.status, 'running'); assert.deepEqual(expected, target);
      assert.deepEqual(plan, orderCollectionPlan(op.order_collection, op.order_read.order_limit));
      calls.push({ id, plan, attempt: op.attempts });
      return action ? action(calls.length, plan, items) : batch(items, plan);
    } };
  const options = { stateDirectory, task: 'orders', orders: true, orderRows: limit, tabId: 41, bridge };
  const clock = { now: () => time, wait: async ms => { waits.push(ms); time += ms; } };
  await createTask(options); return { options, clock, bridge, tabs, calls, waits, items };
}
const next = f => runTask({ ...f.options, nextBatch: true }, f.clock);

test('batch collector checks preceding identity text without reading prior or following prices', () => {
  const items = groups(13), state = newOrderCollection();
  state.batches.push({ attempt: 1, snapshot: batch(items, firstPlan(5)) });
  const plan = orderCollectionPlan(state, 12);
  for (const order of [...items.slice(0, 5), ...items.slice(10)]) {
    Object.defineProperty(order.paymentPrice, 'innerText', { get: () => { throw Error('out-of-range order price'); } });
    for (const item of order.items) Object.defineProperty(item.price, 'innerText', { get: () => { throw Error('out-of-range item price'); } });
  }
  const value = batch(items, plan);
  assert.deepEqual(value.orders.map(order => order.position), [6, 7, 8, 9, 10]);
  assert.equal(value.prefix_guard.positions_checked, 5);
  assert.equal(value.prefix_guard.physical_order_identity_verified, false);
});
test('interactive batches preserve global positions, multi-item orders, original times and shared budget', async t => {
  const f = await fixture(t), first = await runTask(f.options, f.clock);
  assert.equal(first.status, 'awaiting_batch'); assert.equal(first.task_kind, 'order_collection');
  assert.equal(first.operations[0].order_collection.orders.length, 5);
  assert.equal(first.operations[0].order_budget.read_limit, 5);
  const original = structuredClone(first.operations[0].order_collection.batches[0]);
  assert.equal((await next(f)).status, 'awaiting_batch');
  const final = await next(f), result = final.operations[0].result;
  assert.equal(final.status, 'complete'); assert.equal(final.operations[0].attempts, 3);
  assert.deepEqual(result.orders.map(order => order.position), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(result.batches.map(value => value.snapshot.orders.length), [5, 5, 2]);
  assert.deepEqual(result.batches[0], original); assert.equal(result.orders[1].items.length, 8);
  assert.equal(result.coverage.orders_omitted, 2); assert.equal(result.coverage.page_total_orders, null);
  assert.equal(result.coverage.full_order_history, false); assert.ok(result.orders.every(order => order.observed_at));
  assert.deepEqual(f.waits, [1500, 1500]); assert.equal(final.operations[0].order_budget.recoveries_reserved, 0);
});
test('waiting and completed task run/status return byte-identical caches with the connection unavailable', async t => {
  const f = await fixture(t, { limit: 6 }), first = await runTask(f.options, f.clock);
  const file = path.join(f.options.stateDirectory, 'tasks/orders.json'), before = await readFile(file);
  f.bridge.connected = false;
  assert.deepEqual(await runTask(f.options, f.clock), first); assert.deepEqual(await taskStatus(f.options), first);
  assert.deepEqual(await readFile(file), before); assert.equal(f.calls.length, 1);
  f.bridge.connected = true; const complete = await next(f), final = await readFile(file);
  f.bridge.connected = false;
  assert.deepEqual(await next(f), complete); assert.deepEqual(await taskStatus(f.options), complete);
  assert.deepEqual(await readFile(file), final); assert.equal(f.calls.length, 2);
});
test('requested range ends at current loaded groups without claiming full history', async t => {
  const f = await fixture(t, { limit: 20, count: 7 }); await runTask(f.options, f.clock);
  const final = await next(f);
  assert.equal(final.status, 'complete'); assert.equal(final.operations[0].result.orders.length, 7);
  assert.equal(final.operations[0].result.coverage.requested_limit_reached, false);
  assert.equal(final.operations[0].result.coverage.requested_loaded_range_read, true);
  assert.equal(final.operations[0].result.coverage.full_order_history, false);
});
for (const [label, change] of [
  ['loaded count', items => items.pop()], ['order identifier', items => setText(items[0].id, '订单号：9999')],
  ['date', items => setText(items[0].time, '2026-01-02')], ['shop', items => setText(items[0].shop, 'Other shop')],
  ['status', items => setText(items[0].status, '待付款')], ['title', items => setText(items[0].items[0].titleText, 'Other title')],
  ['link', items => items[0].items[0].anchor.attributes.href = 'https://item.taobao.com/item.htm?id=9999'],
  ['quantity', items => setText(items[0].items[0].quantity, 'x3')],
  ['information', items => setText(items[0].items[0].information, 'Other specification')],
  ['item count', items => { items[1].detail.children.pop(); }],
]) {
  test(`changed preceding ${label} stops continuation and retains the original batch`, async t => {
    const f = await fixture(t), first = await runTask(f.options, f.clock), old = structuredClone(first.operations[0].order_collection.batches);
    change(f.items); const result = await next(f);
    assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'ORDER_ROWS_CHANGED');
    assert.deepEqual(result.operations[0].order_collection.batches, old); assert.equal(result.operations[0].attempts, 2);
    assert.equal(result.automatic_retries, 0);
  });
}
test('duplicate or unknown order IDs stop locally after preserving acquired positions', async t => {
  for (const missing of [true, false]) {
    const f = await fixture(t, { action: (call, plan, items) => {
      setText(items[0].id, missing ? '订单编号未知' : items[1].id.innerText); return batch(items, plan);
    } });
    const result = await runTask(f.options, f.clock);
    assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'ORDER_CONTINUITY_UNVERIFIED');
    assert.equal(result.operations[0].order_collection.orders.length, 5); assert.equal(f.calls.length, 1);
  }
});
test('a final single group may retain unknown fields without requiring unused continuation guards', async t => {
  const f = await fixture(t, { limit: 1, action: (call, plan, items) => {
    setText(items[0].id, '订单编号未知'); setText(items[0].items[0].quantity, '未知'); return batch(items, plan);
  } });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(result.operations[0].result.orders[0].order_id, null);
  assert.equal(result.operations[0].result.orders[0].items[0].quantity.value, null);
});
test('missing target has no same-address fallback; explicit rebind retains batches and original counters', async t => {
  const f = await fixture(t), first = await runTask(f.options, f.clock); f.tabs.shift();
  const paused = await next(f); assert.equal(paused.status, 'waiting_connection'); assert.equal(f.calls.length, 1);
  await rebindTask({ ...f.options, tabId: 42 });
  const result = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(result.status, 'awaiting_batch'); assert.equal(result.operations[0].attempts, 3);
  assert.deepEqual(result.operations[0].order_collection.batches[0], first.operations[0].order_collection.batches[0]);
  assert.equal(result.operations[0].order_budget.recoveries_reserved, 1);
  assert.equal(result.wait_reserved_ms, 5000);
});
test('verification after a batch requires explicit recovery and does not reset shared retry/wait counters', async t => {
  const f = await fixture(t, { action: (call, plan, items) => {
    if (call === 2) fail('VERIFICATION_REQUIRED'); return batch(items, plan);
  } });
  await runTask(f.options, f.clock); assert.equal((await next(f)).status, 'waiting_user');
  await assert.rejects(next(f), { code: 'RECOVERY_REQUIRED' });
  const result = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(result.status, 'awaiting_batch'); assert.equal(result.operations[0].attempts, 3);
  assert.equal(result.operations[0].order_budget.recoveries_reserved, 1); assert.equal(result.wait_reserved_ms, 5000);
  assert.equal(result.operations[0].order_budget.failures[0].attempt, 2);
  assert.equal(JSON.stringify(result).includes('Synthetic private'), false);
});
test('transient retry allowance is shared across batches and exhaustion preserves all successful batches', async t => {
  const f = await fixture(t, { action: (call, plan, items) => {
    if ([2, 4, 5].includes(call)) fail('BRIDGE_TIMEOUT'); return batch(items, plan);
  } });
  await runTask(f.options, f.clock); assert.equal((await next(f)).status, 'awaiting_batch');
  const result = await next(f);
  assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'ORDER_READ_LIMIT');
  assert.equal(result.operations[0].order_collection.orders.length, 10);
  assert.equal(result.operations[0].attempts, 5); assert.equal(result.automatic_retries, 2);
});
test('running interruption charges the previous attempt and safely resumes the same next range', async t => {
  const f = await fixture(t); await runTask(f.options, f.clock);
  await withTaskStore(f.options.stateDirectory, 'orders', async store => {
    const task = await store.load(); task.status = 'running'; task.operations[0].status = 'running'; task.operations[0].attempts++;
    await store.save(task);
  });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'awaiting_batch'); assert.equal(result.operations[0].attempts, 3);
  assert.deepEqual(result.operations[0].order_budget.failures, [{ attempt: 2, code: 'READ_INTERRUPTED', category: 'transient' }]);
  assert.equal(f.calls[1].plan.start, 6);
});
test('maximum fifty groups use ten batches and protect all forty-five preceding positions', async t => {
  const f = await fixture(t, { limit: 50, count: 53 }); let result = await runTask(f.options, f.clock);
  while (result.status === 'awaiting_batch') result = await next(f);
  assert.equal(result.status, 'complete'); assert.equal(result.operations[0].attempts, 10);
  assert.equal(result.operations[0].order_budget.read_limit, 12); assert.equal(result.operations[0].result.orders.length, 50);
  assert.equal(f.calls[9].plan.guards.length, 45); assert.equal(f.calls[9].plan.start, 46);
});
for (const limit of [0, 51, 1.5, NaN, '10', null]) {
  test(`invalid requested order range ${String(limit)} fails before creating a task`, async t => {
    await assert.rejects(createTask({ stateDirectory: await directory(t), task: 'bad', orders: true, orderRows: limit,
      tabId: 41, bridge: { endpoint: 'http://127.0.0.1:19824' } }), { code: 'INVALID_ARGUMENTS' });
  });
}
test('order range alone cannot enable collection on a cart or product mode', async t => {
  const stateDirectory = await directory(t);
  await assert.rejects(createTask({ stateDirectory, task: 'bad', cart: true, orderRows: 10, tabId: 41,
    bridge: { endpoint: 'http://127.0.0.1:19824' } }), { code: 'INVALID_ARGUMENTS' });
});
test('unbounded, skipped, private or missing guard plans fail before bridge calls', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  for (const plan of [{ ...firstPlan(5), limit: 6 }, { ...firstPlan(5), start: 6 },
    { ...firstPlan(5), account: 'PRIVATE' }, { ...firstPlan(5), loaded_orders_seen: 20 }, { ...firstPlan(5), limit: 0 }]) {
    assert.throws(() => orderBatchScript(target, plan), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(bridge.readOrderBatch(41, target, plan), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(server.state.requests.length, 0);
});
test('saved batches reject forged range, identity, coverage, quantities, private fields and legacy format', () => {
  const plan = firstPlan(5), value = batch(groups(7), plan);
  for (const change of [v => v.range.start++, v => v.prefix_guard.physical_order_identity_verified = true,
    v => v.coverage.full_order_history = true, v => v.orders[0].items[0].quantity.value = 3,
    v => v.orders[0].account_id = 'PRIVATE', v => v.schema_version = 1]) {
    const corrupted = structuredClone(value); change(corrupted);
    assert.throws(() => validateSavedOrderBatch(corrupted, target, plan), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(orderGuard(value.orders[0]).position, 1);
});
test('checkpoints reject reordered batches, invented attempts, budget mixing and mismatched saved results', async t => {
  const f = await fixture(t); await runTask(f.options, f.clock); await next(f);
  const saved = await loadTask(f.options.stateDirectory, 'orders');
  for (const change of [op => op.order_collection.batches.reverse(), op => op.order_collection.batches[1].attempt = 1,
    op => op.order_read.read_limit++, op => op.order_read.schema_version = 1, op => op.order_collection.account = 'PRIVATE',
    op => op.order_collection.batches[1].snapshot.orders[0].position = 1,
    op => op.order_collection.batches[1].snapshot.prefix_guard.positions_checked = 0,
    op => op.order_read.failures.push({ attempt: 2, code: 'BRIDGE_TIMEOUT', category: 'transient' })]) {
    const corrupted = structuredClone(saved); change(corrupted.operations[0]);
    assert.throws(() => validateTask(corrupted), { code: 'INVALID_CHECKPOINT' });
  }
  f.tabs.splice(0, 1); assert.equal((await diagnoseTask(f.options)).operations[0].reason, 'tab_not_in_current_window');
});
test('actual CLI and production bridge complete two explicit batches and then return only cache', async t => {
  const stateDirectory = await directory(t), server = await mockBridge(t), items = groups(9);
  server.state.tabs = [{ id: 41, url: target.url }];
  const common = ['--task', 'cli-orders', '--state-dir', stateDirectory, '--endpoint', server.endpoint];
  const invoke = async args => {
    let text = ''; const code = await main(args, { write: value => { text += value; } });
    const value = JSON.parse(text); assert.equal(code, value.ok ? 0 : 2); return value;
  };
  await invoke(['task-start', ...common, '--orders', '--order-rows', '6', '--tab', '41']);
  server.state.metadata = observeOrders(items.map(item => item.group), { plan: firstPlan(5) });
  const first = await invoke(['task-run', ...common]); assert.equal(first.status, 'awaiting_batch');
  const requests = server.state.requests.length; assert.deepEqual(await invoke(['task-run', ...common]), first);
  assert.equal(server.state.requests.length, requests);
  const saved = await loadTask(stateDirectory, 'cli-orders'), plan = orderCollectionPlan(saved.operations[0].order_collection, 6);
  server.state.metadata = observeOrders(items.map(item => item.group), { plan });
  const final = await invoke(['task-next-batch', ...common]); assert.equal(final.status, 'complete', JSON.stringify(final));
  const after = server.state.requests.length, cached = await invoke(['task-status', ...common.slice(0, -2)]);
  assert.equal(cached.status, 'complete', JSON.stringify(cached));
  assert.equal(server.state.requests.length, after);
  assert.equal(server.state.commands.filter(value => value.action === 'eval').length, 2);
  assert.ok(server.state.commands.every(value => ['eval', 'tab_list'].includes(value.action)));
});

test('batch identity and login gates run before order fields without reading other routes', () => {
  const items = groups(8), plan = firstPlan(5);
  assert.throws(() => validateOrderBatch(observeOrders(items.map(item => item.group), { plan,
    url: 'https://buyertrade.taobao.com/another.htm' }), target, plan), { code: 'TARGET_CHANGED' });
  assert.throws(() => validateOrderBatch(observeOrders(items.map(item => item.group), { plan,
    url: 'https://login.taobao.com/member/login.jhtml' }), target, plan), { code: 'LOGIN_REQUIRED' });
});

test('forged nested prefix fields and private guard keys fail before production bridge access', async t => {
  const state = newOrderCollection(), items = groups(8);
  state.batches.push({ attempt: 1, snapshot: batch(items, firstPlan(5)) });
  const original = orderCollectionPlan(state, 8), server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  for (const change of [plan => plan.guards[0].account_id = 'PRIVATE',
    plan => plan.guards[0].items[0].information.push(null), plan => plan.guards[0].items[0].url += '&private=value',
    plan => plan.guards[0].items[0].quantity = 0, plan => plan.guards[1].order_id = plan.guards[0].order_id]) {
    const plan = structuredClone(original); change(plan);
    await assert.rejects(bridge.readOrderBatch(41, target, plan), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(server.state.requests.length, 0);
});
