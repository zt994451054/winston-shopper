import { recordPausedDisplay, assertPausedDisplays } from '../test-support/paused-display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask, rebindTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { searchTarget } from '../lib/search.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { playwrightStatus, answerAddressProbe, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';

const script = fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url));

async function cli(args, preload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolve({ code, value: JSON.parse(output), stderr }); } catch (error) { reject(new Error(`CLI produced invalid JSON: ${stderr}`, { cause: error })); }
    });
  });
}

function pageUrl(target, page) { return target.url.replace('&page=1&', `&page=${page}&`); }

function rawPage(target, page, total) {
  const raw = rawSearch({ query: target.query, url: pageUrl(target, page) });
  raw.items = raw.items.slice(0, 2).map((item, index) => ({ ...item, url: `https://item.taobao.com/item.htm?id=${page * 100 + index}` }));
  raw.cards_seen = 2;
  raw.pagination = { current_page: page, total_pages_displayed: total,
    next_disabled: page === total, previous_disabled: page === 1, selected_sort_label: '综合' };
  return raw;
}

async function cliFixture(t, pages, total = 10) {
  const f = await fixture(t, pages);
  const displays = [];
  let current = 1, tabId = 41, reads = 0, actions = 0, gateOnRead = null, gateState = 'verification_required';
  const server = await mockBridge(t, { async handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: tabId, url: pageUrl(f.target, current) }] } });
    if (body.action === 'tab_show') return send({ id: body.id, success: true, data: await recordPausedDisplay(body, f.options.stateDirectory, f.options.task, displays) });
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (isAddressProbe(body)) return answerAddressProbe(body, { otherWindowTabs: [] }, send);
    if (body.script.includes('"cards_scanned":')) {
      actions++; current++; return reply({ state: 'action_dispatched', clicked: true });
    }
    reads++;
    if (gateOnRead === reads) return reply({ state: gateState });
    return reply(rawPage(f.target, current, total));
  } });
  f.options.bridge = new BrowserBridge(server.endpoint);
  const args = ['--task', f.options.task, '--state-dir', f.options.stateDirectory];
  const invoke = (command, extra = [], preload) => cli([command, ...args,
    ...(command === 'task-status' ? [] : ['--endpoint', server.endpoint]), ...extra], preload);
  return { ...f, server, invoke, displays, reads: () => reads, actions: () => actions,
    move: (id, number) => { tabId = id; current = number; },
    setGateOnRead: (value, state = 'verification_required') => { gateOnRead = value; gateState = state; } };
}

async function fixture(t, pages = 2) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping search collection '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const target = searchTarget('Synthetic mouse');
  let reads = 0, inventoryCalls = 0, failure = 'TARGET_MISSING', now = 10000;
  const bridge = { endpoint: 'http://127.0.0.1:19999', protocol: 'playwright-extension',
    requireConnected: async () => {},
    listTabs: async () => { inventoryCalls += 1; return [{ id: 41, url: target.url }]; },
    readSearchCollectionPage: async () => { reads += 1; throw new ShoppingError(failure, 'Synthetic failure.'); },
  };
  const options = { stateDirectory, task: 'collection', search: target.query, pages, tabId: 41, bridge };
  return { options, target, bridge, reads: () => reads, inventoryCalls: () => inventoryCalls,
    setFailure: value => { failure = value; }, clock: { now: () => now, wait: async ms => { now += ms; } } };
}

for (const pages of [1, 2, 3, 4, 5]) {
  test(`explicit --pages ${pages} creates a bounded collection without browser access`, async t => {
    const f = await fixture(t, pages);
    const created = await createTask(f.options);
    assert.equal(created.task_kind, 'search_collection');
    const task = await loadTask(f.options.stateDirectory, f.options.task);
    const state = task.operations[0].search_collection;
    assert.equal(state.requested_pages, pages);
    assert.equal(state.cards_per_page, 50);
    assert.equal(state.read_limit, 6);
    assert.equal(state.recovery_limit, 2);
    assert.equal(state.recovery_wait_ms, 5000);
    assert.equal(state.recoveries_reserved, 0);
    assert.deepEqual(state.failures, []);
    assert.deepEqual(state.pages, []);
    assert.deepEqual(state.transitions, []);
    assert.equal(task.operations[0].read_action, undefined);
    assert.equal(f.reads(), 0); assert.equal(f.inventoryCalls(), 0);
  });
}

test('omitting --pages retains the original single-page search task', async t => {
  const f = await fixture(t, undefined);
  delete f.options.pages;
  assert.equal((await createTask(f.options)).task_kind, 'search');
  assert.equal((await loadTask(f.options.stateDirectory, f.options.task)).operations[0].search_collection, undefined);
});

test('collection range rejects nonintegers, out-of-range values and conflicting modes before browser access', async t => {
  const f = await fixture(t);
  for (const pages of [0, 6, -1, 1.5, NaN, Infinity, '2', null]) {
    await assert.rejects(createTask({ ...f.options, pages }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const extra of [{ sort: 'sales' }, { inspectControls: true }, { inspectPrice: true },
    { inspectPriceHover: true }, { cart: true }, { orders: true }, { reviews: true }, { details: true }]) {
    await assert.rejects(createTask({ ...f.options, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(f.reads(), 0); assert.equal(f.inventoryCalls(), 0);
});

test('connection recovery preserves its category and shares two reservations across failures', async t => {
  const f = await fixture(t);
  await createTask(f.options);
  const initial = await runTask(f.options, f.clock);
  assert.equal(initial.status, 'waiting_connection');
  f.setFailure('READ_INTERRUPTED');
  for (const recovery of [1, 2]) {
    const result = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
    assert.equal(result.status, 'waiting_connection');
    assert.equal(result.operations[0].search_budget.recoveries_reserved, recovery);
    assert.equal(result.operations[0].attempts, recovery + 1);
    assert.equal(result.automatic_retries, 0);
    assert.equal(result.wait_reserved_ms, recovery * 5000);
  }
  const calls = f.inventoryCalls() + f.reads();
  const stopped = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.operations[0].error.code, 'SEARCH_RECOVERY_LIMIT');
  assert.equal(f.inventoryCalls() + f.reads(), calls);
  const saved = await loadTask(f.options.stateDirectory, f.options.task);
  assert.deepEqual(saved.operations[0].search_collection.failures.map(value => value.category), ['connection', 'transient', 'transient']);
});

test('tampered collection budget, failure journal and reserved waits reject before IO', async t => {
  const f = await fixture(t);
  await createTask(f.options);
  await runTask(f.options, f.clock);
  await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  const filename = path.join(f.options.stateDirectory, 'tasks', 'collection.json');
  const original = await readFile(filename, 'utf8');
  const calls = f.inventoryCalls() + f.reads();
  for (const mutate of [
    task => { task.operations[0].search_collection.read_limit = 7; },
    task => { task.operations[0].search_collection.failures[0].category = 'item'; },
    task => { task.operations[0].search_collection.failures[1].attempt = 1; },
    task => { task.operations[0].search_collection.failures.push({ attempt: 3, code: 'TARGET_MISSING', category: 'connection' }); },
    task => { task.wait_reserved_ms = 4999; },
    task => { delete task.operations[0].recovery_kind; },
    task => { task.operations[0].search_collection.extra = true; },
  ]) {
    const task = JSON.parse(original); mutate(task); await writeFile(filename, JSON.stringify(task));
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.inventoryCalls() + f.reads(), calls);
  await writeFile(filename, original);
  assert.equal((await taskStatus(f.options)).status, 'waiting_connection');
});

test('persisted wait covers both automatic retry reservations and subsequent connection recovery', async t => {
  const f = await fixture(t);
  let reads = 0;
  f.bridge.readSearchCollectionPage = async () => { throw new ShoppingError(++reads <= 2 ? 'BRIDGE_TIMEOUT' : 'TARGET_MISSING', 'Synthetic failure.'); };
  await createTask(f.options);
  const paused = await runTask(f.options, f.clock);
  assert.equal(paused.status, 'waiting_connection');
  assert.equal(paused.operations[0].attempts, 3);
  assert.equal(paused.automatic_retries, 2); assert.equal(paused.wait_reserved_ms, 20000);
  const filename = path.join(f.options.stateDirectory, 'tasks', 'collection.json');
  const original = await readFile(filename, 'utf8'), bad = JSON.parse(original);
  bad.wait_reserved_ms = 19999;
  await writeFile(filename, JSON.stringify(bad));
  await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  assert.equal(reads, 3);
  await writeFile(filename, original);
  const recovered = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(recovered.status, 'waiting_connection');
  assert.equal(recovered.wait_reserved_ms, 25000);
  assert.equal(recovered.operations[0].search_budget.recoveries_reserved, 1);
  assert.equal(recovered.automatic_retries, 2);
});

test('initial collection diagnostics and rebind reject every unreserved later page', async t => {
  const f = await fixture(t, 5);
  await createTask(f.options);
  await runTask(f.options, f.clock);
  f.bridge.listTabs = async () => [2, 3, 4, 5].map(page => ({ id: 40 + page, url: pageUrl(f.target, page) }));
  for (const page of [2, 3, 4, 5]) {
    await assert.rejects(rebindTask({ ...f.options, tabId: 40 + page }), { code: 'TASK_TARGET_MISMATCH' });
  }
  const diagnosed = await diagnoseTask(f.options);
  assert.deepEqual(diagnosed.operations[0].allowed_urls, [f.target.url]);
  assert.deepEqual(diagnosed.operations[0].matching_tab_ids, []);
  assert.equal(diagnosed.page_content_read, false);
});

// The real CLI paces every page operation (2-4 s reads, 6-12 s after each next-page load), so this end-to-end run needs minutes.
test('real CLI creates and completes three pages then serves run/status with HTTP and fetch disabled', { timeout: 180000 }, async t => {
  const f = await cliFixture(t, 3);
  const created = await f.invoke('task-start', ['--search', f.target.query, '--tab', '41', '--pages', '3']);
  assert.equal(created.code, 0); assert.equal(created.value.task_kind, 'search_collection');
  assert.equal(f.server.state.requests.length, 0);
  const completed = await f.invoke('task-run');
  assert.equal(completed.code, 0); assert.equal(completed.value.status, 'complete');
  assert.deepEqual(completed.value.operations[0].result.pages.map(page => page.search.page), [1, 2, 3]);
  assert.equal(completed.value.operations[0].result.records, 6);
  assert.equal(completed.value.operations[0].actions_reserved, 2);
  assert.equal(completed.value.operations[0].dom_observations_reserved, 7);
  assert.equal(completed.value.operations[0].search_budget.reads_reserved, 1);
  assert.equal(f.actions(), 2); assert.equal(f.reads(), 5);
  // The two next-page clicks are the only platform loads recorded by the CLI pacer.
  const ledger = JSON.parse(await readFile(path.join(f.options.stateDirectory, 'pacing.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['search', 'search']);
  const preload = path.join(f.options.stateDirectory, 'forbid-http.mjs');
  await writeFile(preload, "import http from 'node:http';\nimport https from 'node:https';\nimport {syncBuiltinESMExports} from 'node:module';\nconst deny=()=>{throw new Error('HTTP forbidden in completed cache test');};\nhttp.request=http.get=https.request=https.get=globalThis.fetch=deny;\nsyncBuiltinESMExports();\n");
  const calls = f.server.state.requests.length;
  for (const command of ['task-run', 'task-status']) {
    const cached = await f.invoke(command, [], preload);
    assert.equal(cached.code, 0); assert.equal(cached.value.status, 'complete');
    assert.deepEqual(cached.value.operations[0].result, completed.value.operations[0].result);
  }
  assert.equal(f.server.state.requests.length, calls);
});

test('real CLI five-page request finishes on a visible earlier last page', { timeout: 120000 }, async t => {
  const f = await cliFixture(t, 5, 2);
  await f.invoke('task-start', ['--search', f.target.query, '--tab', '41', '--pages', '5']);
  const result = await f.invoke('task-run');
  assert.equal(result.code, 0); assert.equal(result.value.status, 'complete');
  assert.equal(result.value.operations[0].requested_pages, 5);
  assert.equal(result.value.operations[0].pages_observed, 2);
  assert.equal(result.value.operations[0].result.end_reason, 'visible_last_page');
  assert.equal(result.value.operations[0].result.coverage.requested_bound_reached, false);
  assert.equal(result.value.operations[0].result.coverage.visible_last_page_verified, true);
  assert.equal(f.actions(), 1); assert.equal(f.reads(), 3);
});

test('pending page-three intent permits only confirmed page two or next page three for diagnosis and rebind', async t => {
  const f = await cliFixture(t, 5);
  await createTask(f.options);
  f.setGateOnRead(5);
  const paused = await runTask(f.options, f.clock);
  assert.equal(paused.status, 'waiting_user');
  const expectedDisplay = [{ tabId: 41, status: 'waiting_user', code: 'VERIFICATION_REQUIRED' }];
  assertPausedDisplays(f.displays, expectedDisplay);
  assert.deepEqual(paused.operations[0].partial_pages.map(page => page.search.page), [1, 2]);
  assert.equal(paused.operations[0].actions_reserved, 2);
  const before = await loadTask(f.options.stateDirectory, f.options.task);
  assert.equal(before.operations[0].search_collection.transitions.at(-1).candidate, null);
  const reads = f.reads(), actions = f.actions();
  f.move(42, 3); f.setGateOnRead(null);
  assert.equal((await runTask({ ...f.options, recovery: 'user' }, f.clock)).status, 'waiting_connection');
  for (const page of [1, 4, 5]) {
    f.move(42, page);
    assert.deepEqual((await diagnoseTask(f.options)).operations[0].matching_tab_ids, []);
    await assert.rejects(rebindTask({ ...f.options, tabId: 42 }), { code: 'TASK_TARGET_MISMATCH' });
  }
  for (const page of [2, 3]) {
    f.move(42, page);
    const diagnosed = await diagnoseTask(f.options);
    assert.deepEqual(diagnosed.operations[0].allowed_urls, [pageUrl(f.target, 2), pageUrl(f.target, 3)]);
    assert.deepEqual(diagnosed.operations[0].matching_tab_ids, [42]);
    assert.equal(diagnosed.page_content_read, false);
  }
  const saved = await loadTask(f.options.stateDirectory, f.options.task);
  await rebindTask({ ...f.options, tabId: 42 });
  const rebound = await loadTask(f.options.stateDirectory, f.options.task);
  assert.deepEqual(rebound.operations[0].search_collection, saved.operations[0].search_collection);
  assert.equal(f.reads(), reads); assert.equal(f.actions(), actions);
  const complete = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.operations[0].search_budget.recoveries_reserved, 2);
  assert.equal(complete.wait_reserved_ms, 10000);
  assert.equal(f.actions(), 4);
  assertPausedDisplays(f.displays, expectedDisplay);
});

test('last allowed attempt with a committed terminal journal converges locally after host interruption', async t => {
  const f = await cliFixture(t, 3);
  await createTask(f.options);
  const complete = await runTask(f.options, f.clock);
  assert.equal(complete.status, 'complete');
  assertPausedDisplays(f.displays, []);
  const filename = path.join(f.options.stateDirectory, 'tasks', 'collection.json');
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  saved.status = 'running';
  saved.wait_reserved_ms = 10000;
  const op = saved.operations[0];
  op.status = 'running'; op.result = null; op.attempts = 6;
  op.search_collection.recoveries_reserved = 2;
  op.search_collection.failures = [1, 2, 3, 4, 5].map(attempt => ({ attempt, code: 'TARGET_MISSING', category: 'connection' }));
  await writeFile(filename, JSON.stringify(saved));
  const calls = f.server.state.requests.length;
  const resumed = await runTask(f.options, f.clock);
  assert.equal(resumed.status, 'complete');
  assert.deepEqual(resumed.operations[0].result, complete.operations[0].result);
  assert.equal(resumed.operations[0].attempts, 6);
  assert.equal(resumed.operations[0].search_budget.recoveries_reserved, 2);
  assert.equal(resumed.operations[0].search_budget.failures.length, 5);
  assert.equal(resumed.wait_reserved_ms, 10000);
  assert.equal(f.server.state.requests.length, calls);
});

test('connection recovery remains active after page progress and pauses on a subsequent transient error', async t => {
  const f = await cliFixture(t, 3);
  await createTask(f.options);
  f.move(42, 1);
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_connection');
  await rebindTask({ ...f.options, tabId: 42 });
  f.setGateOnRead(2, 'loading');
  const paused = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(paused.status, 'waiting_connection');
  assert.equal(paused.operations[0].error.code, 'PAGE_LOADING');
  assert.equal(paused.automatic_retries, 0); assert.equal(paused.wait_reserved_ms, 5000);
  assert.equal(paused.operations[0].pages_observed, 1); assert.equal(paused.operations[0].actions_reserved, 1);
  f.setGateOnRead(null);
  const complete = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(complete.status, 'complete'); assert.equal(complete.automatic_retries, 0);
  assert.equal(complete.operations[0].search_budget.recoveries_reserved, 2);
  assert.equal(f.actions(), 2);
});
