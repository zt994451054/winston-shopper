import { recordPausedDisplay, assertPausedDisplays } from '../test-support/paused-display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createTask, runTask, taskStatus, rebindTask, endTask } from '../lib/tasks.mjs';
import { loadTask, withTaskStore, validateTask } from '../lib/task-store.mjs';
import { validateCartRows, validateSavedCartRows } from '../lib/cart-rows.mjs';
import { parseCartUrl } from '../lib/cart-target.mjs';
import { summarizeTab } from '../lib/targets.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { main } from '../lib/cli.mjs';
import { cartRow, observeCart } from '../test-support/cart-fixture.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseCartUrl('https://cart.taobao.com/cart.htm');
const snapshot = () => validateCartRows(observeCart(Array.from({ length: 7 }, (_, i) =>
  cartRow(i + 1, { productId: '123', quantity: String(i + 1), displayQuantity: i % 2 === 0 }).row)), target);
function fail(code) { throw new ShoppingError(code, 'Synthetic private error'); }

async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), 'shopping cart '));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

async function fixture(t, action = async () => snapshot()) {
  const stateDirectory = await directory(t), calls = [], waits = [];
  let time = Date.parse('2026-10-04T00:00:00Z');
  const tabs = [{ id: 41, url: target.url }, { id: 42, url: target.url }];
  const bridge = { endpoint: 'http://127.0.0.1:19824', inventories: 0, connected: true,
    async requireConnected() { if (!this.connected) fail('EXTENSION_DISCONNECTED'); },
    async listTabs() { this.inventories += 1; return tabs; },
    async readCartRows(id, expected) {
      calls.push(id); assert.deepEqual(expected, target);
      const saved = await loadTask(stateDirectory, 'cart');
      assert.equal(saved.operations[0].status, 'running');
      assert.ok(saved.operations[0].attempts >= calls.length);
      return action(calls.length);
    } };
  const options = { stateDirectory, task: 'cart', cart: true, tabId: 41, bridge };
  const clock = { now: () => time, wait: async ms => { waits.push(ms); time += ms; } };
  await createTask(options);
  return { options, bridge, tabs, calls, waits, clock };
}

async function changeTask(f, change) {
  return withTaskStore(f.options.stateDirectory, 'cart', async store => {
    const task = await store.load(); change(task); await store.save(task);
  });
}

test('cart task creation is local, needs no product binding and saves its fixed scope', async t => {
  const f = await fixture(t);
  const saved = await loadTask(f.options.stateDirectory, 'cart');
  assert.equal(saved.kind, 'cart_snapshot'); assert.equal(saved.operations.length, 1);
  assert.deepEqual(saved.operations[0].target, target);
  assert.equal(saved.operations[0].cart_read.read_limit, 6);
  assert.equal(saved.operations[0].cart_read.recovery_limit, 2);
  assert.equal(f.bridge.inventories, 0); assert.equal(f.calls.length, 0);
  assert.equal(Object.hasOwn(saved.operations[0].target, 'product_id'), false);
});

test('saved cart results preserve separate same-product rows and return offline without new reads', async t => {
  const f = await fixture(t), report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.operations[0].result.rows.map(row => row.quantity.value), [1, 2, 3, 4, 5]);
  assert.equal(report.operations[0].result.coverage.rows_omitted, 2);
  assert.equal(report.operations[0].result.coverage.full_cart, false);
  const filename = path.join(f.options.stateDirectory, 'tasks/cart.json'), before = await readFile(filename);
  f.bridge.connected = false;
  assert.deepEqual(await runTask(f.options, f.clock), report);
  assert.deepEqual(await taskStatus(f.options), report);
  assert.deepEqual(await readFile(filename), before);
  assert.deepEqual(f.calls, [41]); assert.equal(f.bridge.inventories, 1);
});

test('cart modes cannot be combined with product/search/action modes or an omitted tab', async t => {
  const f = await fixture(t);
  for (const addition of [{ bindings: ['missing'] }, { plan: 'missing.json' }, { search: 'query' },
    { details: true }, { gallery: true }, { reviews: true }, { services: true }, { mainImages: 'missing.json' },
    { reviewCategories: 'missing.json' }, { specificationImages: true }, { descriptionExpand: true },
    { descriptionImageLoad: 1 }, { pages: 2 }, { sort: 'sales' }, { inspectControls: true },
    { inspectPrice: true }, { inspectPriceHover: true }, { tabId: undefined }, { cart: 'yes' }]) {
    await assert.rejects(createTask({ ...f.options, task: 'invalid', ...addition }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});

test('login/verification pauses require explicit reports and reserve a five-second bounded recovery', async t => {
  const f = await fixture(t, call => call === 1 ? fail('VERIFICATION_REQUIRED') : snapshot());
  const first = await runTask(f.options, f.clock);
  assert.equal(first.status, 'waiting_user');
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(runTask({ ...f.options, recovery: 'connection' }, f.clock), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.calls.length, 1);
  const report = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(report.wait_reserved_ms, 5000);
  assert.deepEqual(f.waits, [5000]);
  assert.equal(report.operations[0].cart_budget.recoveries_reserved, 1);
  assert.deepEqual(report.operations[0].cart_budget.failures, [{ attempt: 1, code: 'VERIFICATION_REQUIRED', category: 'user' }]);
  assert.equal(JSON.stringify(report).includes('Synthetic private error'), false);
});

test('repeated user gates exhaust explicit recoveries without issuing another read or resetting history', async t => {
  const f = await fixture(t, () => fail('LOGIN_REQUIRED'));
  await runTask(f.options, f.clock);
  await runTask({ ...f.options, recovery: 'user' }, f.clock);
  await runTask({ ...f.options, recovery: 'user' }, f.clock);
  const report = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'CART_RECOVERY_LIMIT');
  assert.equal(f.calls.length, 3); assert.deepEqual(f.waits, [5000, 5000]);
  assert.equal(report.operations[0].cart_budget.failures.length, 3);
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }), { code: 'PLATFORM_TASK_UNFINISHED' });
  await assert.rejects(runTask({ ...f.options, recovery: 'user' }, f.clock), { code: 'INVALID_RECOVERY' });
});

test('transient faults keep the existing two retries and persisted 5/15-second waits', async t => {
  const f = await fixture(t, () => fail('BRIDGE_TIMEOUT'));
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'partial'); assert.equal(report.operations[0].error.code, 'OPERATION_RETRY_LIMIT');
  assert.equal(report.automatic_retries, 2); assert.equal(report.wait_reserved_ms, 20000);
  assert.equal(report.operations[0].cart_budget.failures.length, 3);
  assert.deepEqual(f.waits, [5000, 15000]); assert.equal(f.calls.length, 3);
});

test('a transient user recovery is one check and stays paused without automatic retries', async t => {
  const f = await fixture(t, call => fail(call === 1 ? 'LOGIN_REQUIRED' : 'BRIDGE_TIMEOUT'));
  await runTask(f.options, f.clock);
  const report = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(report.status, 'waiting_user'); assert.equal(report.automatic_retries, 0);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.waits, [5000]);
});

test('missing selected tabs pause without silently using another cart tab', async t => {
  const f = await fixture(t); f.tabs.shift();
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'waiting_connection'); assert.equal(report.operations[0].error.code, 'TARGET_MISSING');
  assert.equal(report.operations[0].attempts, 1); assert.equal(f.calls.length, 0);
});

test('cart reattachment checks the original route and endpoint while preserving all budgets', async t => {
  const f = await fixture(t); f.tabs[0].url = 'https://mail.example.test/?private=PRIVATE';
  await runTask(f.options, f.clock);
  await assert.rejects(rebindTask({ ...f.options, tabId: 41 }), { code: 'TASK_TARGET_MISMATCH' });
  const inventory = f.bridge.inventories;
  await assert.rejects(rebindTask({ ...f.options, tabId: 42, bridge: { ...f.bridge, endpoint: 'http://127.0.0.1:19825' } }),
    { code: 'BINDING_ENDPOINT_MISMATCH' });
  assert.equal(f.bridge.inventories, inventory);
  const before = await loadTask(f.options.stateDirectory, 'cart');
  const report = await rebindTask({ ...f.options, tabId: 42 });
  assert.equal(report.status, 'task_rebound'); assert.equal(f.calls.length, 0);
  const after = await loadTask(f.options.stateDirectory, 'cart');
  assert.deepEqual(after.operations[0].cart_read, before.operations[0].cart_read);
  assert.equal(after.operations[0].attempts, before.operations[0].attempts);
  const resumed = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  // One earlier address check and one row read both count, despite the changed tab ID.
  assert.equal(resumed.operations[0].attempts, 2);
  assert.equal(resumed.status, 'complete'); assert.deepEqual(f.calls, [42]);
});

test('a connection recovery that times out stays paused without automatic repeats', async t => {
  const f = await fixture(t, () => fail('BRIDGE_TIMEOUT')); f.bridge.connected = false;
  await runTask(f.options, f.clock); f.bridge.connected = true;
  const report = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(report.status, 'waiting_connection'); assert.equal(report.automatic_retries, 0);
  assert.deepEqual(f.waits, [5000]); assert.equal(report.operations[0].attempts, 2);
});

test('a login navigation pauses before reading any login document', async t => {
  const f = await fixture(t); f.tabs[0].url = 'https://login.taobao.com/?account=PRIVATE';
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'waiting_user'); assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});

test('cart diagnostics return redacted matching IDs without reading or changing the saved state', async t => {
  const f = await fixture(t), filename = path.join(f.options.stateDirectory, 'tasks/cart.json');
  f.tabs[1].url += '?account=PRIVATE#PRIVATE';
  const before = await readFile(filename), report = await diagnoseTask(f.options);
  assert.deepEqual(report.operations[0].matching_tab_ids, [41, 42]);
  assert.equal(report.operations[0].reason, 'matching_target');
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  assert.deepEqual(await readFile(filename), before); assert.equal(f.calls.length, 0);
  assert.deepEqual(summarizeTab(f.tabs[1]), { tab_id: 42, origin: target.origin, kind: 'cart', url: target.url });
});

test('an interrupted in-flight read is counted before a new observation and preserves its fault', async t => {
  const f = await fixture(t);
  await changeTask(f, task => { task.status = 'running'; task.operations[0].status = 'running'; task.operations[0].attempts = 1; });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(report.operations[0].attempts, 2);
  assert.equal(report.automatic_retries, 1); assert.deepEqual(f.waits, [5000]);
  assert.equal(report.operations[0].cart_budget.failures[0].code, 'READ_INTERRUPTED');
});

test('an interrupted user check requires a new explicit report and does not refund recovery', async t => {
  const f = await fixture(t);
  await changeTask(f, task => { task.status = 'running'; task.operations[0].status = 'running';
    task.operations[0].attempts = 1; task.operations[0].recovery_kind = 'user';
    task.operations[0].cart_read.recoveries_reserved = 1; task.wait_reserved_ms = 5000; });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'waiting_user'); assert.equal(f.calls.length, 0);
  assert.equal(report.operations[0].cart_budget.recoveries_reserved, 1);
});

test('a reserved last read interrupted by a killed process cannot dispatch a seventh read', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const source = `import { withTaskStore } from ${JSON.stringify(new URL('../lib/task-store.mjs', import.meta.url).href)};
    await withTaskStore(process.argv[1], 'cart', async store => {
      const task = await store.load(); task.status = 'running';
      task.operations[0].status = 'running'; task.operations[0].attempts = 6;
      await store.save(task); process.send('ready'); await new Promise(() => {});
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.options.stateDirectory],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'message'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'CART_READ_LIMIT');
  assert.equal(report.operations[0].error.cause, 'READ_INTERRUPTED');
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});

test('a reserved recovery wait survives interruption without a second reservation', async t => {
  const f = await fixture(t, call => call === 1 ? fail('LOGIN_REQUIRED') : snapshot());
  await runTask(f.options, f.clock);
  await assert.rejects(runTask({ ...f.options, recovery: 'user' }, { ...f.clock, wait: async () => { throw new Error('clock interrupted'); } }));
  const saved = await loadTask(f.options.stateDirectory, 'cart');
  assert.equal(saved.wait_reserved_ms, 5000); assert.equal(saved.operations[0].cart_read.recoveries_reserved, 1);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(report.wait_reserved_ms, 5000);
  assert.deepEqual(f.waits, [5000]);
});

test('cooldown allows one explicit probe and a failed probe does not restart retries', async t => {
  const f = await fixture(t, call => fail(call === 1 ? 'RATE_LIMITED' : 'BRIDGE_TIMEOUT'));
  await runTask(f.options, f.clock);
  const report = await runTask({ ...f.options, recovery: 'cooldown' }, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.cooldown_probes, 1);
  assert.equal(report.operations[0].automatic_retries, 0); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.waits, [5000]);
});

test('insufficient waiting budget stops before reserving or dispatching a recovery', async t => {
  const f = await fixture(t, () => fail('LOGIN_REQUIRED'));
  await runTask(f.options, f.clock);
  await changeTask(f, task => { task.wait_reserved_ms = 118000; });
  const report = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'WAIT_BUDGET_EXHAUSTED');
  assert.equal(report.operations[0].cart_budget.recoveries_reserved, 0); assert.equal(f.calls.length, 1);
});

test('unknown or malformed adapter results stop once and never persist external error text', async t => {
  const f = await fixture(t, () => ({ ...snapshot(), private_account: 'PRIVATE' }));
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'INVALID_RESPONSE');
  assert.equal(report.operations[0].result, null); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});

test('ending a cart round retains its budgets and prevents old identity recovery', async t => {
  const f = await fixture(t, () => fail('LOGIN_REQUIRED')); await runTask(f.options, f.clock);
  const before = await loadTask(f.options.stateDirectory, 'cart'); await endTask(f.options);
  const after = await loadTask(f.options.stateDirectory, 'cart');
  assert.deepEqual(after.operations, before.operations); assert.equal(after.wait_reserved_ms, before.wait_reserved_ms);
  await assert.rejects(runTask({ ...f.options, recovery: 'user' }, f.clock), { code: 'INVALID_RECOVERY' });
  assert.equal((await runTask(f.options, f.clock)).status, 'ended'); assert.equal(f.calls.length, 1);
});

test('cart execution rejects endpoint changes before any inventory or content request', async t => {
  const f = await fixture(t);
  await assert.rejects(runTask({ ...f.options, bridge: { ...f.bridge, endpoint: 'http://127.0.0.1:19825' } }, f.clock),
    { code: 'BINDING_ENDPOINT_MISMATCH' });
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});

test('unsupported cart structures stop once without pretending that the cart is empty', async t => {
  const f = await fixture(t, () => fail('PAGE_STRUCTURE_CHANGED'));
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].result, null);
  assert.equal(report.operations[0].error.code, 'PAGE_STRUCTURE_CHANGED');
  assert.equal(report.automatic_retries + report.wait_reserved_ms, 0); assert.equal(f.calls.length, 1);
});

const invalidSnapshots = {
  'extra private fields': v => { v.account = 'PRIVATE'; },
  'a false full-cart claim': v => { v.coverage.full_cart = true; },
  'an invented page total': v => { v.coverage.page_total_rows = 7; },
  'wrong omitted count': v => { v.coverage.rows_omitted = 0; },
  'quantity changed independently of its source': v => { v.rows[0].quantity.value = 9; },
  'quantity source invented': v => { v.rows[0].quantity.source = 'model'; },
  'a product URL with retained private query': v => { v.rows[0].url += '&account=PRIVATE'; },
  'an invented platform row ID': v => { v.rows[0].row_id = 'local1'; },
  'unverified prices upgraded to unit prices': v => { v.rows[0].price_region_observations.items[0].kind = 'unit_price'; },
  'an invented payment claim': v => { v.rows[0].association.payment_verified = true; },
  'extra private row fields': v => { v.rows[0].buyer = 'PRIVATE'; },
  'wrong row positions': v => { v.rows[0].position = 2; },
  'an invented empty cart': v => { v.rows = []; v.coverage.empty_cart_verified = true; },
  'an invalid observation time': v => { v.observed_at = 'unknown'; },
};
for (const [name, change] of Object.entries(invalidSnapshots)) {
  test(`saved cart validator rejects ${name} before browser access`, async t => {
    const f = await fixture(t); await runTask(f.options, f.clock);
    const filename = path.join(f.options.stateDirectory, 'tasks/cart.json');
    const task = JSON.parse(await readFile(filename, 'utf8')); change(task.operations[0].result);
    await writeFile(filename, JSON.stringify(task));
    await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
    assert.equal(f.calls.length, 1); assert.equal(f.bridge.inventories, 1);
  });
}

test('saved budgets, recovery reservations and failure history cannot be enlarged or misclassified', async t => {
  const f = await fixture(t), saved = await loadTask(f.options.stateDirectory, 'cart');
  for (const change of [v => { v.operations[0].cart_read.read_limit = 7; }, v => { v.operations[0].attempts = 7; },
    v => { v.operations[0].cart_read.recoveries_reserved = 3; }, v => { v.operations[0].recovery_kind = 'user'; },
    v => { v.operations[0].cart_read.failures.push({ attempt: 0, code: 'LOGIN_REQUIRED', category: 'transient' }); },
    v => { v.operations[0].private_account = 'PRIVATE'; }, v => { v.account = 'PRIVATE'; }]) {
    const changed = structuredClone(saved); change(changed);
    assert.throws(() => validateTask(changed), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.calls.length + f.bridge.inventories, 0);
});

test('saved unknown fields and truncated observations remain valid without retrospective upgrades', () => {
  const raw = observeCart([cartRow().row]); raw.rows[0].links = []; raw.rows[0].quantity_ambiguous = true;
  raw.rows[0].specification = { text: 'partial', truncated: true };
  const value = validateCartRows(raw, target), before = structuredClone(value);
  assert.deepEqual(validateSavedCartRows(value, target), before);
  assert.equal(value.rows[0].title, null); assert.equal(value.rows[0].quantity.value, null);
});

test('actual CLI/bridge cart workflow saves a bounded private result, handles a gate, and later uses cache', async t => {
  const stateDirectory = await directory(t), displays = [];
  const { endpoint, state } = await mockBridge(t, { onTabShow: body => recordPausedDisplay(body, stateDirectory, 'cart', displays) });
  state.tabs = [{ id: 41, url: target.url + '?private=PRIVATE', title: 'PRIVATE_TITLE' }];
  const common = ['--endpoint', endpoint, '--state-dir', stateDirectory, '--task', 'cart'];
  const cli = async args => { let output = ''; const code = await main(args, { write: text => { output += text; } }); return { code, ...JSON.parse(output) }; };
  for (const args of [[], ['--tab', '41', '--details'], ['--tab', '41', '--bindings', 'missing'],
    ['--tab', '41', '--search', 'query'], ['--tab', '41', '--rows', '10']]) {
    assert.equal((await cli(['task-start', ...common, '--cart', ...args])).error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal(state.requests.length, 0);
  const created = await cli(['task-start', ...common, '--cart', '--tab', '41']);
  assert.equal(created.status, 'task_created'); assert.equal(state.requests.length, 0);
  const inventory = await cli(['tabs', '--endpoint', endpoint]);
  assert.equal(inventory.tabs[0].kind, 'cart'); assert.equal(JSON.stringify(inventory).includes('PRIVATE'), false);
  assertPausedDisplays(displays, []);
  state.metadata = { state: 'verification_required' };
  assert.equal((await cli(['task-run', ...common])).status, 'waiting_user');
  const expectedDisplay = [{ tabId: 41, status: 'waiting_user', code: 'VERIFICATION_REQUIRED' }];
  assertPausedDisplays(displays, expectedDisplay);
  const reads = state.requests.length;
  assert.equal((await cli(['task-run', ...common])).error.code, 'RECOVERY_REQUIRED');
  assert.equal(state.requests.length, reads);
  state.metadata = observeCart(Array.from({ length: 7 }, (_, i) => cartRow(i + 1).row));
  const completed = await cli(['task-resume', ...common, '--after-user']);
  assert.equal(completed.status, 'complete'); assert.equal(completed.operations[0].result.rows.length, 5);
  assert.equal(completed.operations[0].cart_budget.reads_reserved, 2);
  assert.equal(completed.operations[0].cart_budget.recoveries_reserved, 1);
  assertPausedDisplays(displays, expectedDisplay);
  assert.deepEqual(state.commands.filter(c => c.action === 'tab_show').map(c => c.tabId), [41]);
  assert.ok(state.commands.filter(c => c.action !== 'tab_show').every(c => ['tab_list', 'eval'].includes(c.action)));
  const after = state.requests.length;
  await cli(['task-run', ...common]); await cli(['task-status', '--state-dir', stateDirectory, '--task', 'cart']);
  assert.equal(state.requests.length, after);
  assertPausedDisplays(displays, expectedDisplay);
});
