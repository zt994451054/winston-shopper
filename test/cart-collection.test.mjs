import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, runTask, taskStatus, rebindTask } from '../lib/tasks.mjs';
import { loadTask, validateTask, withTaskStore } from '../lib/task-store.mjs';
import { cartBatchScript, cartRowGuard, validateCartBatch, validateSavedCartBatch } from '../lib/cart-rows.mjs';
import { newCartCollection, cartCollectionPlan } from '../lib/cart-collection.mjs';
import { parseCartUrl } from '../lib/cart-target.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { cartRow, cartNode, observeCart } from '../test-support/cart-fixture.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseCartUrl('https://cart.taobao.com/cart.htm');
const rows = count => Array.from({ length: count }, (_, i) => cartRow(i + 1));
const batch = (items, plan) => validateCartBatch(observeCart(items.map(item => item.row), { plan }), target, plan);
const firstPlan = limit => ({ start: 1, limit, loaded_rows_seen: null, guards: [] });
const fail = code => { throw new ShoppingError(code, 'Synthetic private exception'); };

async function directory(t) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'cart collection '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  return stateDirectory;
}
async function fixture(t, { limit = 12, count = 14, action } = {}) {
  const stateDirectory = await directory(t), items = rows(count), calls = [], waits = [];
  let time = Date.parse('2026-10-04T00:00:00Z');
  const tabs = [{ id: 41, url: target.url }, { id: 42, url: target.url }];
  const bridge = { endpoint: 'http://127.0.0.1:19824', connected: true,
    async requireConnected() { if (!this.connected) fail('EXTENSION_DISCONNECTED'); },
    async listTabs() { return tabs; },
    async readCartBatch(id, expected, plan) {
      const saved = await loadTask(stateDirectory, 'cart'), op = saved.operations[0];
      assert.equal(op.status, 'running'); assert.deepEqual(expected, target);
      assert.deepEqual(plan, cartCollectionPlan(op.cart_collection, op.cart_read.row_limit));
      calls.push({ id, plan, attempt: op.attempts });
      return action ? action(calls.length, plan, items) : batch(items, plan);
    } };
  const options = { stateDirectory, task: 'cart', cart: true, cartRows: limit, tabId: 41, bridge };
  const clock = { now: () => time, wait: async ms => { waits.push(ms); time += ms; } };
  await createTask(options);
  return { options, clock, bridge, tabs, calls, waits, items };
}
const next = f => runTask({ ...f.options, nextBatch: true }, f.clock);

test('range collector reads five new rows and identity-only prefix fields, with no prices outside its range', () => {
  const items = rows(13), state = newCartCollection();
  state.batches.push({ attempt: 1, snapshot: batch(items, firstPlan(5)) });
  const plan = cartCollectionPlan(state, 12);
  for (const item of [...items.slice(0, 5), ...items.slice(10)]) {
    const query = item.priceRegion.querySelectorAll;
    item.priceRegion.querySelectorAll = selector => {
      if (selector === '.trade-price-container') throw Error('price outside selected range');
      return query(selector);
    };
    Object.defineProperty(item.priceQuantity, 'childNodes', { get: () => { throw Error('subtree text outside selected range'); } });
  }
  const value = batch(items, plan);
  assert.deepEqual(value.rows.map(row => row.position), [6, 7, 8, 9, 10]);
  assert.equal(value.prefix_guard.positions_checked, 5);
  assert.equal(value.prefix_guard.physical_row_identity_verified, false);
});

test('first, next and final short batches retain global positions, times and one shared budget', async t => {
  const f = await fixture(t), first = await runTask(f.options, f.clock);
  assert.equal(first.status, 'awaiting_batch'); assert.equal(first.operations[0].cart_collection.rows.length, 5);
  assert.equal(first.operations[0].cart_budget.read_limit, 5);
  const original = structuredClone(first.operations[0].cart_collection.batches[0]);
  assert.equal((await next(f)).status, 'awaiting_batch');
  const final = await next(f), op = final.operations[0];
  assert.equal(final.status, 'complete'); assert.equal(op.attempts, 3);
  assert.deepEqual(op.result.rows.map(row => row.position), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(op.result.batches.map(item => item.snapshot.rows.length), [5, 5, 2]);
  assert.deepEqual(op.result.batches[0], original);
  assert.equal(op.result.coverage.rows_omitted, 2); assert.equal(op.result.coverage.page_total_rows, null);
  assert.equal(op.result.coverage.full_cart, false);
  assert.ok(op.result.rows.every(row => row.observed_at));
  assert.deepEqual(f.waits, [1500, 1500]);
  assert.equal(op.cart_budget.recoveries_reserved, 0);
});

test('awaiting_batch task-run and status return identical caches without saving or reading', async t => {
  const f = await fixture(t), report = await runTask(f.options, f.clock);
  const filename = path.join(f.options.stateDirectory, 'tasks/cart.json'), before = await readFile(filename);
  f.bridge.connected = false;
  assert.deepEqual(await runTask(f.options, f.clock), report);
  assert.deepEqual(await taskStatus(f.options), report);
  assert.deepEqual(await readFile(filename), before); assert.equal(f.calls.length, 1);
});

test('completion returns cache even for next-batch and cannot consume unused observations', async t => {
  const f = await fixture(t, { limit: 6 });
  await runTask(f.options, f.clock); const report = await next(f);
  const before = await readFile(path.join(f.options.stateDirectory, 'tasks/cart.json'));
  f.bridge.connected = false;
  assert.deepEqual(await next(f), report); assert.equal(f.calls.length, 2);
  assert.deepEqual(await readFile(path.join(f.options.stateDirectory, 'tasks/cart.json')), before);
});

test('requested range ends at observed loaded rows without claiming the page or full cart total', async t => {
  const f = await fixture(t, { limit: 20, count: 7 });
  await runTask(f.options, f.clock); const report = await next(f), coverage = report.operations[0].result.coverage;
  assert.equal(report.status, 'complete'); assert.equal(coverage.returned_rows, 7);
  assert.equal(coverage.requested_limit_reached, false); assert.equal(coverage.requested_loaded_range_read, true);
  assert.equal(coverage.full_cart, false); assert.equal(coverage.rows_omitted, 0);
});

test('same-product rows remain separate across batches', async t => {
  const f = await fixture(t, { limit: 6, action: (call, plan) => batch(Array.from({ length: 8 }, (_, i) =>
    cartRow(i + 1, { productId: '123', quantity: String(i + 1) })), plan) });
  await runTask(f.options, f.clock); const result = (await next(f)).operations[0].result;
  assert.equal(new Set(result.rows.map(row => row.product_id)).size, 1);
  assert.deepEqual(result.rows.map(row => row.quantity.value), [1, 2, 3, 4, 5, 6]);
});

for (const change of ['count', 'order', 'quantity', 'specification', 'title', 'shop']) {
  test(`changed ${change} stops before collecting new rows and retains the preceding batch`, async t => {
    const f = await fixture(t); const first = await runTask(f.options, f.clock);
    if (change === 'count') f.items.pop();
    if (change === 'order') [f.items[0], f.items[1]] = [f.items[1], f.items[0]];
    if (change === 'quantity') f.items[0].input.value = '2';
    if (change === 'specification') f.items[0].row.children[1] = cartNode('trade-cart-item-sku-old', 'changed');
    if (change === 'title') Object.defineProperty(f.items[0].anchor, 'innerText', { get: () => 'changed' });
    const savedAction = f.bridge.readCartBatch;
    if (change === 'shop') f.bridge.readCartBatch = async (id, expected, plan) => {
      const raw = observeCart(f.items.map(item => item.row), { plan, shops: [cartNode('trade-cart-shop-container', '',
        [cartNode('trade-cart-shop-info', 'changed'), ...f.items.map(item => item.row)])] });
      return validateCartBatch(raw, expected, plan);
    };
    for (const item of f.items.slice(5)) {
      const query = item.row.querySelectorAll;
      item.row.querySelectorAll = selector => {
        if (selector !== '*') throw Error('new row fields must not be read after guard failure');
        return query(selector);
      };
    }
    const report = await next(f), op = report.operations[0];
    assert.equal(report.status, 'stopped'); assert.equal(op.error.code, 'CART_ROWS_CHANGED');
    assert.equal(op.attempts, 2); assert.equal(report.automatic_retries, 0);
    assert.deepEqual(op.cart_collection.batches, first.operations[0].cart_collection.batches);
    assert.equal(op.cart_collection.rows.length, 5);
    f.bridge.readCartBatch = savedAction;
  });
}

test('changed price alone does not invalidate observed row identity or overwrite a previous price', async t => {
  const f = await fixture(t, { limit: 6 }); const first = await runTask(f.options, f.clock);
  Object.defineProperty(f.items[0].price, 'innerText', { get: () => '￥9.90' });
  const final = await next(f);
  assert.equal(final.status, 'complete');
  assert.deepEqual(final.operations[0].result.batches[0], first.operations[0].cart_collection.batches[0]);
});

test('missing prefix identity fields keep the first partial batch but prohibit unsafe continuation', async t => {
  const f = await fixture(t, { action: (call, plan, items) => {
    items[0].input.value = ''; return batch(items, plan);
  } });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'CART_CONTINUITY_UNVERIFIED');
  assert.equal(report.operations[0].cart_collection.rows.length, 5); assert.equal(f.calls.length, 1);
  assert.deepEqual(await next(f), report);
});

test('transient retry counters and failure history carry across successive batches', async t => {
  const f = await fixture(t, { limit: 11, action: (call, plan, items) => {
    if ([1, 3, 5].includes(call)) fail('BRIDGE_TIMEOUT'); return batch(items, plan);
  } });
  await runTask(f.options, f.clock); await next(f); const report = await next(f);
  assert.equal(report.status, 'stopped'); assert.equal(report.automatic_retries, 2);
  assert.equal(report.operations[0].error.code, 'CART_READ_LIMIT');
  assert.equal(report.operations[0].cart_collection.rows.length, 10);
  assert.equal(report.operations[0].cart_budget.failures.length, 3); assert.equal(f.calls.length, 5);
});

test('a user recovery within the second batch preserves the original first batch and shared recovery count', async t => {
  const f = await fixture(t, { limit: 10, action: (call, plan, items) => call === 2 ? fail('VERIFICATION_REQUIRED') : batch(items, plan) });
  const first = await runTask(f.options, f.clock); assert.equal((await next(f)).status, 'waiting_user');
  await assert.rejects(next(f), { code: 'RECOVERY_REQUIRED' });
  const final = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(final.status, 'complete'); assert.equal(final.operations[0].attempts, 3);
  assert.equal(final.operations[0].cart_budget.recoveries_reserved, 1);
  assert.equal(final.wait_reserved_ms, 5000);
  assert.deepEqual(final.operations[0].result.batches[0], first.operations[0].cart_collection.batches[0]);
  assert.deepEqual(f.waits, [1500, 5000]);
});

test('a missing saved tab cannot use a same-address substitute; explicit rebind preserves progress and guards', async t => {
  const f = await fixture(t, { limit: 6 }); const first = await runTask(f.options, f.clock); f.tabs.shift();
  assert.equal((await next(f)).status, 'waiting_connection'); assert.equal(f.calls.length, 1);
  const diagnosis = await diagnoseTask(f.options); assert.deepEqual(diagnosis.operations[0].matching_tab_ids, [42]);
  await rebindTask({ ...f.options, tabId: 42 });
  const report = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(report.operations[0].attempts, 3);
  assert.equal(f.calls[1].id, 42);
  assert.deepEqual(report.operations[0].result.batches[0], first.operations[0].cart_collection.batches[0]);
});

test('interrupted batch consumes its reserved read without discarding previous progress', async t => {
  const f = await fixture(t, { limit: 10 }); await runTask(f.options, f.clock);
  await withTaskStore(f.options.stateDirectory, 'cart', async store => {
    const task = await store.load(); task.status = 'running'; task.operations[0].status = 'running';
    task.operations[0].attempts += 1; await store.save(task);
  });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(report.operations[0].attempts, 3);
  assert.equal(report.automatic_retries, 1); assert.equal(report.operations[0].result.rows.length, 10);
  assert.equal(report.operations[0].cart_budget.failures[0].code, 'READ_INTERRUPTED');
});

test('an interrupted last reservation stops without a further batch request or a refunded attempt', async t => {
  const f = await fixture(t); const first = await runTask(f.options, f.clock);
  await withTaskStore(f.options.stateDirectory, 'cart', async store => {
    const task = await store.load(), op = task.operations[0];
    task.status = 'running'; op.status = 'running'; op.attempts = op.cart_read.read_limit; await store.save(task);
  });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'CART_READ_LIMIT');
  assert.equal(report.operations[0].error.cause, 'READ_INTERRUPTED'); assert.equal(f.calls.length, 1);
  assert.deepEqual(report.operations[0].cart_collection.batches, first.operations[0].cart_collection.batches);
});

test('explicit recoveries remain capped at two across separate batches', async t => {
  const f = await fixture(t, { limit: 25, count: 30, action: (call, plan, items) =>
    call % 2 === 1 ? fail('LOGIN_REQUIRED') : batch(items, plan) });
  await runTask(f.options, f.clock);
  await runTask({ ...f.options, recovery: 'user' }, f.clock);
  await next(f); await runTask({ ...f.options, recovery: 'user' }, f.clock);
  await next(f);
  const report = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'CART_RECOVERY_LIMIT');
  assert.equal(report.operations[0].cart_budget.recoveries_reserved, 2); assert.equal(report.wait_reserved_ms, 10000);
  assert.equal(report.operations[0].cart_collection.rows.length, 10); assert.equal(f.calls.length, 5);
});

test('the maximum collection reads fifty positions in ten interactive batches under twelve total reads', async t => {
  const f = await fixture(t, { limit: 50, count: 53 });
  let report = await runTask(f.options, f.clock);
  while (report.status === 'awaiting_batch') report = await next(f);
  assert.equal(report.status, 'complete'); assert.equal(report.operations[0].attempts, 10);
  assert.equal(report.operations[0].cart_budget.read_limit, 12);
  assert.equal(report.operations[0].result.rows.length, 50); assert.equal(report.operations[0].result.coverage.rows_omitted, 3);
  assert.equal(f.calls[9].plan.guards.length, 45); assert.equal(f.calls[9].plan.start, 46);
});

test('row limit of one preserves unknown fields when continuation guards are unnecessary', async t => {
  const f = await fixture(t, { limit: 1, action: (call, plan, items) => {
    items[0].input.value = ''; return batch(items, plan);
  } });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(report.operations[0].result.rows.length, 1);
  assert.equal(report.operations[0].result.rows[0].quantity.value, null); assert.equal(f.calls.length, 1);
});

test('target and login gates remain ahead of row evidence in the batch expression', () => {
  const plan = firstPlan(5), items = rows(8);
  assert.throws(() => validateCartBatch(observeCart(items.map(item => item.row), { plan,
    url: 'https://cart.taobao.com/another.htm' }), target, plan), { code: 'TARGET_CHANGED' });
  assert.throws(() => validateCartBatch(observeCart(items.map(item => item.row), { plan,
    additionalRoots: [cartNode('', '', [], { tagName: 'IFRAME', attributes: { src: 'https://login.taobao.com/' } })] }),
    target, plan), { code: 'LOGIN_REQUIRED' });
});

for (const limit of [0, 51, 1.5, NaN, '10', null]) {
  test(`invalid collection row limit ${String(limit)} fails before creation or browser access`, async t => {
    const stateDirectory = await directory(t);
    await assert.rejects(createTask({ stateDirectory, task: 'bad', cart: true, cartRows: limit, tabId: 41,
      bridge: { endpoint: 'http://127.0.0.1:19824' } }), { code: 'INVALID_ARGUMENTS' });
  });
}

test('cart-rows alone cannot enable collection on a different task mode', async t => {
  const stateDirectory = await directory(t);
  await assert.rejects(createTask({ stateDirectory, task: 'bad', search: 'mouse', cartRows: 10, tabId: 41,
    bridge: { endpoint: 'http://127.0.0.1:19824' } }), { code: 'INVALID_ARGUMENTS' });
});

test('batch plans reject unbounded, skipped, private or incomplete guard data before browser access', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  for (const plan of [{ ...firstPlan(5), limit: 6 }, { ...firstPlan(5), start: 6 },
    { ...firstPlan(5), account: 'PRIVATE' }, { ...firstPlan(5), loaded_rows_seen: 20 }, { ...firstPlan(5), limit: 0 }]) {
    assert.throws(() => cartBatchScript(target, plan), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(bridge.readCartBatch(41, target, plan), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(server.state.requests.length, 0);
});

test('saved batch validation rejects altered range, prefix claims, totals and derived quantities', () => {
  const plan = firstPlan(5), value = batch(rows(7), plan);
  for (const change of [v => v.range.start++, v => v.prefix_guard.physical_row_identity_verified = true,
    v => v.coverage.full_cart = true, v => v.rows[0].quantity.value = 2,
    v => v.rows[0].account_id = 'PRIVATE', v => v.schema_version = 1]) {
    const corrupted = structuredClone(value); change(corrupted);
    assert.throws(() => validateSavedCartBatch(corrupted, target, plan), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(cartRowGuard(value.rows[0]).position, 1);
});

test('task checkpoint rejects reordered batches, invented successes, unexpected keys and v1/v2 budget mixing', async t => {
  const f = await fixture(t); await runTask(f.options, f.clock); await next(f);
  const saved = await loadTask(f.options.stateDirectory, 'cart');
  for (const change of [op => op.cart_collection.batches.reverse(), op => op.cart_collection.batches[1].attempt = 1,
    op => op.cart_read.read_limit++, op => op.cart_read.schema_version = 1,
    op => op.cart_collection.account = 'PRIVATE', op => op.cart_collection.batches[1].snapshot.rows[0].position = 1,
    op => op.cart_collection.batches[1].snapshot.prefix_guard.positions_checked = 0,
    op => op.cart_read.failures.push({ attempt: 2, code: 'BRIDGE_TIMEOUT', category: 'transient' })]) {
    const corrupted = structuredClone(saved); change(corrupted.operations[0]);
    assert.throws(() => validateTask(corrupted), { code: 'INVALID_CHECKPOINT' });
  }
});

test('the actual CLI and production bridge execute an interactive two-batch chain with no browser actions', async t => {
  const stateDirectory = await directory(t), server = await mockBridge(t), items = rows(9);
  server.state.tabs = [{ id: 41, url: target.url }];
  const base = ['--task', 'cli-cart', '--state-dir', stateDirectory, '--endpoint', server.endpoint];
  const invoke = async args => {
    let text = ''; const code = await main(args, { write: value => { text += value; } });
    const value = JSON.parse(text); assert.equal(code, value.ok ? 0 : 2, text); return value;
  };
  await invoke(['task-start', ...base, '--cart', '--cart-rows', '6', '--tab', '41']);
  server.state.metadata = observeCart(items.map(item => item.row), { plan: firstPlan(5) });
  const first = await invoke(['task-run', ...base]); assert.equal(first.status, 'awaiting_batch');
  const requests = server.state.requests.length;
  assert.deepEqual(await invoke(['task-run', ...base]), first);
  assert.equal(server.state.requests.length, requests);
  const saved = await loadTask(stateDirectory, 'cli-cart');
  const plan = cartCollectionPlan(saved.operations[0].cart_collection, 6);
  server.state.metadata = observeCart(items.map(item => item.row), { plan });
  const final = await invoke(['task-next-batch', ...base]); assert.equal(final.status, 'complete');
  assert.equal(final.operations[0].result.rows.length, 6);
  assert.deepEqual(server.state.commands.map(command => command.action), ['tab_list', 'eval', 'tab_list', 'eval']);
  const count = server.state.requests.length;
  assert.deepEqual(await invoke(['task-next-batch', ...base]), final);
  assert.equal(server.state.requests.length, count);
});
