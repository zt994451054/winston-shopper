import { recordPausedDisplay, assertPausedDisplays } from '../test-support/paused-display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, runTask, taskStatus, rebindTask, endTask } from '../lib/tasks.mjs';
import { loadTask, withTaskStore, validateTask } from '../lib/task-store.mjs';
import { validateOrderRows } from '../lib/order-rows.mjs';
import { parseOrderListUrl } from '../lib/order-target.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { main } from '../lib/cli.mjs';
import { orderGroup, observeOrders, orderTarget } from '../test-support/order-fixture.mjs';
import { isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseOrderListUrl(orderTarget.url);
const snapshot = () => validateOrderRows(observeOrders(Array.from({ length: 7 }, (_, index) =>
  orderGroup(index + 1, { itemCount: index === 1 ? 3 : 1 }).group)), target);
function fail(code) { throw new ShoppingError(code, 'PRIVATE external account data'); }
async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), 'shopping orders '));
  t.after(() => rm(value, { recursive: true, force: true })); return value;
}
async function fixture(t, action = async () => snapshot()) {
  const stateDirectory = await directory(t), calls = [], waits = [];
  let time = Date.parse('2026-10-05T00:00:00Z');
  const tabs = [{ id: 41, url: target.url }, { id: 42, url: target.url }];
  const bridge = { endpoint: 'http://127.0.0.1:19824', inventories: 0, connected: true,
    async requireConnected() { if (!this.connected) fail('EXTENSION_DISCONNECTED'); },
    async listTabs() { this.inventories++; return tabs; },
    async readOrderRows(id, expected) {
      calls.push(id); assert.deepEqual(expected, target);
      const saved = await loadTask(stateDirectory, 'orders');
      assert.equal(saved.operations[0].status, 'running'); assert.ok(saved.operations[0].attempts >= calls.length);
      return action(calls.length);
    } };
  const options = { stateDirectory, task: 'orders', orders: true, tabId: 41, bridge };
  const clock = { now: () => time, wait: async ms => { waits.push(ms); time += ms; } };
  await createTask(options); return { options, bridge, tabs, calls, waits, clock };
}
async function changeTask(f, change) {
  return withTaskStore(f.options.stateDirectory, 'orders', async store => {
    const task = await store.load(); change(task); await store.save(task);
  });
}

test('order creation is local and saves a fixed five-order ten-item scope without a product binding', async t => {
  const f = await fixture(t), saved = await loadTask(f.options.stateDirectory, 'orders');
  assert.equal(saved.kind, 'order_snapshot'); assert.equal(saved.operations.length, 1);
  assert.deepEqual(saved.operations[0].target, target);
  assert.deepEqual(saved.operations[0].order_read, { schema_version: 1, order_limit: 5, item_limit: 10,
    read_limit: 6, recovery_limit: 2, recovery_wait_ms: 5000, recoveries_reserved: 0, failures: [] });
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});
test('success saves multi-item orders and finished run/status/next-batch use cache without touching the connection', async t => {
  const f = await fixture(t), value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'complete'); assert.equal(value.task_kind, 'order_snapshot');
  assert.equal(value.operations[0].order_list_url, target.url); assert.equal(value.operations[0].result.orders.length, 5);
  assert.equal(value.operations[0].result.orders[1].items.length, 3);
  assert.equal(value.operations[0].order_budget.reads_reserved, 1); assert.equal(value.operations[0].actions_reserved, 0);
  const file = path.join(f.options.stateDirectory, 'tasks/orders.json'), before = await readFile(file);
  f.bridge.connected = false;
  assert.deepEqual(await runTask(f.options, f.clock), value); assert.deepEqual(await taskStatus(f.options), value);
  assert.deepEqual(await runTask({ ...f.options, nextBatch: true }, f.clock), value);
  assert.deepEqual(await readFile(file), before); assert.deepEqual(f.calls, [41]); assert.equal(f.bridge.inventories, 1);
});
test('orders reject mixed modes, an omitted tab and collection/action flags before any IO', async t => {
  const f = await fixture(t);
  for (const addition of [{ cart: true }, { cartRows: 10 }, { bindings: ['missing'] }, { plan: 'missing.json' },
    { search: 'query' }, { details: true }, { reviews: true }, { services: true }, { gallery: true },
    { mainImages: 'missing.json' }, { reviewCategories: 'missing.json' }, { specificationImages: true },
    { descriptionExpand: true }, { descriptionImageLoad: 1 }, { pages: 11 }, { pages: 2, orderRows: 10 }, { sort: 'sales' },
    { inspectControls: true }, { inspectPrice: true }, { inspectPriceHover: true }, { tabId: undefined }, { orders: 'yes' }]) {
    await assert.rejects(createTask({ ...f.options, task: 'invalid', ...addition }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});
test('verification pauses until an explicit user recovery, whose reservation is saved before the wait', async t => {
  const f = await fixture(t, call => call === 1 ? fail('VERIFICATION_REQUIRED') : snapshot());
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user');
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(runTask({ ...f.options, recovery: 'connection' }, f.clock), { code: 'RECOVERY_REQUIRED' });
  const report = await runTask({ ...f.options, recovery: 'user' }, { ...f.clock, wait: async ms => {
    const saved = await loadTask(f.options.stateDirectory, 'orders');
    assert.equal(saved.operations[0].order_read.recoveries_reserved, 1); assert.equal(saved.wait_reserved_ms, 5000);
    return f.clock.wait(ms);
  } });
  assert.equal(report.status, 'complete'); assert.deepEqual(f.waits, [5000]);
  assert.deepEqual(report.operations[0].order_budget.failures, [{ attempt: 1, code: 'VERIFICATION_REQUIRED', category: 'user' }]);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});
test('all explicit recoveries share a two-use limit and cannot be bypassed by renaming a stopped task', async t => {
  const f = await fixture(t, () => fail('LOGIN_REQUIRED'));
  await runTask(f.options, f.clock); await runTask({ ...f.options, recovery: 'user' }, f.clock);
  await runTask({ ...f.options, recovery: 'user' }, f.clock);
  const report = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'ORDER_RECOVERY_LIMIT');
  assert.equal(f.calls.length, 3); assert.deepEqual(f.waits, [5000, 5000]);
  assert.equal(report.operations[0].order_budget.failures.length, 3);
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }), { code: 'PLATFORM_TASK_UNFINISHED' });
  await assert.rejects(runTask({ ...f.options, recovery: 'user' }, f.clock), { code: 'INVALID_RECOVERY' });
});
test('user and connection recoveries draw from the same saved two-use counter', async t => {
  const f = await fixture(t, () => fail('LOGIN_REQUIRED'));
  await runTask(f.options, f.clock); f.tabs.shift();
  assert.equal((await runTask({ ...f.options, recovery: 'user' }, f.clock)).status, 'waiting_connection');
  await rebindTask({ ...f.options, tabId: 42 });
  const second = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(second.status, 'waiting_user'); assert.equal(second.operations[0].order_budget.recoveries_reserved, 2);
  const stopped = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.operations[0].error.code, 'ORDER_RECOVERY_LIMIT');
  assert.deepEqual(f.calls, [41, 42]); assert.equal(stopped.operations[0].attempts, 3);
});
test('an unfinished order task cannot request additional batches or rebind outside a connection pause', async t => {
  const f = await fixture(t);
  await assert.rejects(runTask({ ...f.options, nextBatch: true }, f.clock), { code: 'INVALID_RECOVERY' });
  await assert.rejects(rebindTask({ ...f.options, tabId: 42 }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});
test('ordinary transient faults use only the shared two retries with durable five/fifteen-second waits', async t => {
  const f = await fixture(t, () => fail('BRIDGE_TIMEOUT')), value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'partial'); assert.equal(value.operations[0].error.code, 'OPERATION_RETRY_LIMIT');
  assert.equal(value.automatic_retries, 2); assert.equal(value.wait_reserved_ms, 20000);
  assert.deepEqual(f.waits, [5000, 15000]); assert.equal(f.calls.length, 3); assert.equal(value.operations[0].order_budget.failures.length, 3);
});
test('an explicit user recovery that times out remains paused instead of automatically retrying', async t => {
  const f = await fixture(t, call => fail(call === 1 ? 'LOGIN_REQUIRED' : 'BRIDGE_TIMEOUT'));
  await runTask(f.options, f.clock);
  const value = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(value.status, 'waiting_user'); assert.equal(value.automatic_retries, 0); assert.equal(f.calls.length, 2);
});
test('a missing saved tab consumes its reservation and never selects another same-route tab', async t => {
  const f = await fixture(t); f.tabs.shift();
  const value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'waiting_connection'); assert.equal(value.operations[0].error.code, 'TARGET_MISSING');
  assert.equal(value.operations[0].attempts, 1); assert.equal(f.calls.length, 0);
});
test('order rebind is explicit, checks the saved endpoint/route and retains every counter', async t => {
  const f = await fixture(t); f.tabs[0].url = 'https://mail.example.test/?account=PRIVATE';
  await runTask(f.options, f.clock);
  await assert.rejects(rebindTask({ ...f.options, tabId: 41 }), { code: 'TASK_TARGET_MISMATCH' });
  const inventory = f.bridge.inventories;
  await assert.rejects(rebindTask({ ...f.options, tabId: 42, bridge: { ...f.bridge, endpoint: 'http://127.0.0.1:19825' } }), { code: 'BINDING_ENDPOINT_MISMATCH' });
  assert.equal(f.bridge.inventories, inventory);
  await assert.rejects(rebindTask({ ...f.options, tabId: 42, binding: 'missing' }), { code: 'INVALID_ARGUMENTS' });
  const before = await loadTask(f.options.stateDirectory, 'orders');
  const report = await rebindTask({ ...f.options, tabId: 42 }); assert.equal(report.status, 'task_rebound');
  const after = await loadTask(f.options.stateDirectory, 'orders');
  assert.deepEqual(after.operations[0].order_read, before.operations[0].order_read); assert.equal(after.operations[0].attempts, before.operations[0].attempts);
  assert.equal((await runTask({ ...f.options, recovery: 'connection' }, f.clock)).status, 'complete');
  assert.deepEqual(f.calls, [42]); assert.deepEqual(f.waits, [5000]);
});
test('connection recovery timeout pauses once without another automatic request', async t => {
  const f = await fixture(t, () => fail('BRIDGE_TIMEOUT')); f.bridge.connected = false;
  await runTask(f.options, f.clock); f.bridge.connected = true;
  const value = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(value.status, 'waiting_connection'); assert.equal(value.automatic_retries, 0); assert.equal(f.calls.length, 1);
});
test('official login navigation is reported without reading the login document or exposing query values', async t => {
  const f = await fixture(t); f.tabs[0].url = 'https://login.taobao.com/?account=PRIVATE';
  const value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'waiting_user'); assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
});
test('order address diagnostics only report redacted matching tab IDs and preserve checkpoint bytes', async t => {
  const f = await fixture(t); f.tabs[1].url += '?account=PRIVATE#PRIVATE';
  const file = path.join(f.options.stateDirectory, 'tasks/orders.json'), before = await readFile(file);
  const value = await diagnoseTask(f.options);
  assert.deepEqual(value.operations[0].matching_tab_ids, [41, 42]); assert.equal(value.operations[0].reason, 'matching_target');
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false); assert.deepEqual(await readFile(file), before);
  assert.equal(f.calls.length, 0);
});
test('ordinary interrupted reads are retained in failure history before one bounded retry', async t => {
  const f = await fixture(t);
  await changeTask(f, task => { task.status = 'running'; task.operations[0].status = 'running'; task.operations[0].attempts = 1; });
  const value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'complete'); assert.equal(value.operations[0].attempts, 2);
  assert.deepEqual(f.waits, [5000]); assert.equal(value.operations[0].order_budget.failures[0].code, 'READ_INTERRUPTED');
});
test('an interrupted explicit user check remains paused without refunding recovery', async t => {
  const f = await fixture(t);
  await changeTask(f, task => { task.status = 'running'; const op = task.operations[0]; op.status = 'running'; op.attempts = 1;
    op.recovery_kind = 'user'; op.order_read.recoveries_reserved = 1; task.wait_reserved_ms = 5000; });
  const value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'waiting_user'); assert.equal(value.operations[0].order_budget.recoveries_reserved, 1);
  assert.equal(f.calls.length, 0);
});
test('a last reserved read with no committed result stops before a seventh inventory or content request', async t => {
  const f = await fixture(t);
  await changeTask(f, task => { task.status = 'running'; task.operations[0].status = 'running'; task.operations[0].attempts = 6; });
  const value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'stopped'); assert.equal(value.operations[0].error.code, 'ORDER_READ_LIMIT');
  assert.equal(value.operations[0].error.cause, 'READ_INTERRUPTED'); assert.equal(f.calls.length + f.bridge.inventories, 0);
});
test('a reserved recovery wait survives interruption without a second reservation', async t => {
  const f = await fixture(t, call => call === 1 ? fail('LOGIN_REQUIRED') : snapshot()); await runTask(f.options, f.clock);
  await assert.rejects(runTask({ ...f.options, recovery: 'user' }, { ...f.clock, wait: async () => { throw Error('Interrupted clock'); } }));
  const saved = await loadTask(f.options.stateDirectory, 'orders'); assert.equal(saved.operations[0].order_read.recoveries_reserved, 1);
  const value = await runTask(f.options, f.clock); assert.equal(value.status, 'complete'); assert.equal(value.wait_reserved_ms, 5000);
  assert.deepEqual(f.waits, [5000]);
});
test('cooldown permits one explicitly requested probe, then stops without further retries', async t => {
  const f = await fixture(t, call => fail(call === 1 ? 'RATE_LIMITED' : 'BRIDGE_TIMEOUT')); await runTask(f.options, f.clock);
  const value = await runTask({ ...f.options, recovery: 'cooldown' }, f.clock);
  assert.equal(value.status, 'stopped'); assert.equal(value.cooldown_probes, 1); assert.equal(value.operations[0].automatic_retries, 0);
  assert.equal(value.operations[0].order_budget.recoveries_reserved, 1); assert.deepEqual(f.waits, [5000]); assert.equal(f.calls.length, 2);
});
test('insufficient waiting budget stops without reserving another recovery or read', async t => {
  const f = await fixture(t, () => fail('LOGIN_REQUIRED')); await runTask(f.options, f.clock);
  await changeTask(f, task => { task.wait_reserved_ms = 118000; });
  const value = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(value.status, 'stopped'); assert.equal(value.operations[0].error.code, 'WAIT_BUDGET_EXHAUSTED');
  assert.equal(value.operations[0].order_budget.recoveries_reserved, 0); assert.equal(f.calls.length, 1);
});
test('malformed adapter results stop once without saving extra account fields or external error text', async t => {
  const f = await fixture(t, () => ({ ...snapshot(), account: 'PRIVATE' })); const value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'stopped'); assert.equal(value.operations[0].error.code, 'INVALID_RESPONSE');
  assert.equal(value.operations[0].result, null); assert.equal(JSON.stringify(value).includes('PRIVATE'), false); assert.equal(f.calls.length, 1);
});
test('unsupported order structure stops without retry or an invented empty history', async t => {
  const f = await fixture(t, () => fail('PAGE_STRUCTURE_CHANGED')), value = await runTask(f.options, f.clock);
  assert.equal(value.status, 'stopped'); assert.equal(value.operations[0].result, null);
  assert.equal(value.automatic_retries + value.wait_reserved_ms, 0); assert.equal(f.calls.length, 1);
});
test('explicitly ending an order task retains its operations and refuses later recovery', async t => {
  const f = await fixture(t, () => fail('LOGIN_REQUIRED')); await runTask(f.options, f.clock);
  const before = await loadTask(f.options.stateDirectory, 'orders'); await endTask(f.options);
  const after = await loadTask(f.options.stateDirectory, 'orders'); assert.deepEqual(after.operations, before.operations);
  assert.equal(after.wait_reserved_ms, before.wait_reserved_ms);
  await assert.rejects(runTask({ ...f.options, recovery: 'user' }, f.clock), { code: 'INVALID_RECOVERY' });
  assert.equal((await runTask(f.options, f.clock)).status, 'ended');
});
test('an endpoint change is rejected before inventory or order reads', async t => {
  const f = await fixture(t);
  await assert.rejects(runTask({ ...f.options, bridge: { ...f.bridge, endpoint: 'http://127.0.0.1:19825' } }, f.clock), { code: 'BINDING_ENDPOINT_MISMATCH' });
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});
test('enlarged scope, unknown operation fields, unreserved recoveries and unsafe failure history cannot pass checkpoint validation', async t => {
  const f = await fixture(t), base = await loadTask(f.options.stateDirectory, 'orders');
  for (const change of [v => { v.operations[0].order_read.read_limit = 7; }, v => { v.operations[0].order_read.order_limit = 6; },
    v => { v.operations[0].order_read.item_limit = 11; }, v => { v.operations[0].order_read.recoveries_reserved = 3; },
    v => { v.operations[0].recovery_kind = 'user'; }, v => { v.operations[0].attempts = 7; },
    v => { v.operations[0].order_read.failures.push({ attempt: 0, code: 'LOGIN_REQUIRED', category: 'transient' }); },
    v => { v.operations[0].account = 'PRIVATE'; }, v => { v.account = 'PRIVATE'; }, v => { v.operations[0].cart_read = {}; }]) {
    const value = structuredClone(base); change(value); assert.throws(() => validateTask(value), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});
test('order recovery reservations cannot survive a forged refund of their saved waiting budget', async t => {
  const f = await fixture(t, () => fail('LOGIN_REQUIRED')); await runTask(f.options, f.clock);
  await runTask({ ...f.options, recovery: 'user' }, f.clock);
  const saved = await loadTask(f.options.stateDirectory, 'orders'); saved.wait_reserved_ms = 0;
  assert.throws(() => validateTask(saved), { code: 'INVALID_CHECKPOINT' });
});
const invalidSnapshots = {
  'private fields': value => { value.account = 'PRIVATE'; },
  'a false full-history claim': value => { value.coverage.full_order_history = true; },
  'a guessed page total': value => { value.coverage.page_total_orders = 7; },
  'quantity changed without its source': value => { value.orders[0].items[0].quantity.value = 99; },
  'an invented order ID': value => { value.orders[0].order_id = '123'; },
  'a false payment claim': value => { value.orders[0].payment_observations.settlement_verified = true; },
  'a wrong detail association': value => { value.orders[0].detail_entry.url = 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=999'; },
  'a fabricated filter proof': value => { value.coverage.filters_verified = true; },
  'a price reassigned to order scope': value => { value.orders[0].items[0].price_observations.items[0].level = 'order'; },
};
for (const [name, change] of Object.entries(invalidSnapshots)) {
  test(`saved order task rejects ${name} before any browser IO`, async t => {
    const f = await fixture(t); await runTask(f.options, f.clock);
    const file = path.join(f.options.stateDirectory, 'tasks/orders.json'), value = JSON.parse(await readFile(file, 'utf8'));
    change(value.operations[0].result); await writeFile(file, JSON.stringify(value));
    await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' }); assert.equal(f.calls.length, 1);
  });
}
test('actual CLI and bridge use inventory/eval commands and one committed-pause display through recovery and cached reads', async t => {
  const stateDirectory = await directory(t), displays = [];
  const server = await mockBridge(t, { onTabShow: body => recordPausedDisplay(body, stateDirectory, 'orders', displays) }), state = server.state;
  state.tabs = [{ id: 41, url: target.url + '?account=PRIVATE', title: 'PRIVATE' }];
  const common = ['--endpoint', server.endpoint, '--state-dir', stateDirectory, '--task', 'orders'];
  const cli = async args => { let text = ''; const code = await main(args, { write: value => { text += value; } }); return { code, ...JSON.parse(text) }; };
  for (const args of [[], ['--tab', '41', '--cart'], ['--tab', '41', '--bindings', 'missing'], ['--tab', '41', '--cart-rows', '10'], ['--tab', '41', '--search', 'query']]) {
    assert.equal((await cli(['task-start', ...common, '--orders', ...args])).error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal(state.requests.length, 0); assert.equal((await cli(['task-start', ...common, '--orders', '--tab', '41'])).status, 'task_created');
  assert.equal(state.requests.length, 0); state.metadata = { state: 'verification_required' };
  assertPausedDisplays(displays, []);
  assert.equal((await cli(['task-run', ...common])).status, 'waiting_user');
  const expectedDisplay = [{ tabId: 41, status: 'waiting_user', code: 'VERIFICATION_REQUIRED' }];
  assertPausedDisplays(displays, expectedDisplay);
  const before = state.requests.length;
  assert.equal((await cli(['task-run', ...common])).error.code, 'RECOVERY_REQUIRED'); assert.equal(state.requests.length, before);
  state.metadata = observeOrders(Array.from({ length: 7 }, (_, index) => orderGroup(index + 1).group));
  const result = await cli(['task-resume', ...common, '--after-user']);
  assert.equal(result.status, 'complete'); assert.equal(result.operations[0].result.orders.length, 5);
  assert.equal(result.operations[0].order_budget.reads_reserved, 2); assert.equal(result.operations[0].order_budget.recoveries_reserved, 1);
  const after = state.requests.length; await cli(['task-run', ...common]); await cli(['task-status', '--state-dir', stateDirectory, '--task', 'orders']);
  assert.equal(state.requests.length, after);
  assertPausedDisplays(displays, expectedDisplay);
  assert.deepEqual(state.commands.filter(command => command.action === 'tab_show').map(command => command.tabId), [41]);
  assert.ok(state.commands.filter(command => command.action !== 'tab_show').every(command => ['tab_list', 'eval'].includes(command.action)));
});
test('CLI order rebind accepts an explicit same-route tab without inventing a product binding', async t => {
  const server = await mockBridge(t), stateDirectory = await directory(t);
  const common = ['--endpoint', server.endpoint, '--state-dir', stateDirectory, '--task', 'orders'];
  const cli = async args => { let text = ''; await main(args, { write: value => { text += value; } }); return JSON.parse(text); };
  await cli(['task-start', ...common, '--orders', '--tab', '41']);
  server.state.tabs = [{ id: 42, url: target.url + '?account=PRIVATE', title: 'PRIVATE' }];
  assert.equal((await cli(['task-run', ...common])).status, 'waiting_connection');
  const before = await loadTask(stateDirectory, 'orders');
  assert.equal((await cli(['task-rebind', ...common, '--tab', '42'])).status, 'task_rebound');
  assert.equal((await loadTask(stateDirectory, 'orders')).operations[0].tab_id, 42);
  assert.deepEqual((await loadTask(stateDirectory, 'orders')).operations[0].order_read, before.operations[0].order_read);
  assert.equal(server.state.commands.filter(command => command.action === 'eval' && !isAddressProbe(command)).length, 0);
  assert.equal((await cli(['task-rebind', ...common, '--tab', '42', '--binding', 'default'])).error.code, 'INVALID_ARGUMENTS');
});
