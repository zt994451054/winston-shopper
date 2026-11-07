import { recordPausedDisplay, assertPausedDisplays } from '../test-support/paused-display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask, rebindTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { main } from '../lib/cli.mjs';
import { searchTarget, searchPageTarget, searchSortTarget, parseSearchPageUrl, parseSortableSearchUrl } from '../lib/search.mjs';
import { validateSearchSort, newSearchSortState, runSearchSort, validateSearchSortState } from '../lib/search-sort.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';

function rawSorted(target, sorted, { stale = false, token = 'synthetic-sales', page = sorted ? 1 : 2 } = {}) {
  const actual = sorted && token ? searchSortTarget(target.query, page, token) : searchPageTarget(target.query, page);
  const raw = rawSearch(actual);
  if (sorted && !stale) raw.items.reverse();
  raw.pagination = { current_page: page, total_pages_displayed: 100, next_disabled: false,
    previous_disabled: page === 1, selected_sort_label: sorted ? '销量' : '综合' };
  return raw;
}

function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, reorder(value[key])]));
}

async function fixture(t, { loseReply = false, gateAfterClick = null, stale = false, token = 'synthetic-sales', otherWindow = false } = {}) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping sort ')), displays = [];
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const target = searchTarget('Synthetic mouse');
  let sorted = false, tab = 41, gate = null, reads = 0, clicks = 0, resolveDispatch;
  const dispatched = new Promise(resolve => { resolveDispatch = resolve; });
  const server = await mockBridge(t, { async handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(reorder(value)));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: otherWindow ? [] : [{ id: tab, url: rawSorted(target, sorted, { token }).url }] } });
    if (body.action === 'tab_show') return send({ id: body.id, success: true, data: await recordPausedDisplay(body, stateDirectory, 'sales-sort', displays) });
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (body.tabId !== tab) return reply({ state: 'target_changed' });
    if (body.script.includes('function inspectSortTarget(')) return reply({ state: 'observed', url: rawSorted(target, sorted, { token }).url });
    if (gate) return reply({ state: gate });
    if (body.script.includes('"urls":[')) {
      clicks += 1; sorted = true; gate = gateAfterClick;
      if (loseReply) req.socket.destroy(); else reply({ state: 'action_dispatched', clicked: true });
      resolveDispatch(); return;
    }
    reads += 1; reply(rawSorted(target, sorted, { stale, token }));
  } });
  const options = { stateDirectory, task: 'sales-sort', search: target.query, sort: 'sales', tabId: 41, bridge: new BrowserBridge(server.endpoint) };
  await createTask(options);
  let now = Date.now();
  return { options, target, dispatched, server, displays, clock: { now: () => now, wait: async ms => { now += ms; } },
    reads: () => reads, clicks: () => clicks, setGate: value => { gate = value; }, move: value => { tab = value; } };
}

test('sort tokens are bounded observed data and do not weaken ordinary search URL guards', () => {
  const root = searchTarget('mouse');
  assert.equal(parseSortableSearchUrl(`${root.url}&sort=observed-token`).sort_parameter, 'observed-token');
  assert.equal(parseSearchPageUrl(`${root.url}&sort=observed-token`), null);
  for (const suffix of ['&sort=', '&sort=x&sort=y', '&sort=x&minPrice=1', '&sort=a%20b', '&sort=a%2Fb', '&sort=' + 'a'.repeat(41)]) {
    assert.equal(parseSortableSearchUrl(root.url + suffix), null);
  }
});

for (const token of ['synthetic-sales', null]) {
  test(`one lost-reply click confirms only sales UI evidence, with URL token ${token}`, async t => {
    const f = await fixture(t, { loseReply: true, token });
    const result = await runTask(f.options, f.clock);
    assert.equal(result.status, 'complete');
    const data = result.operations[0].result;
    assert.equal(data.before.search.page, 2); assert.equal(data.after.search.page, 1);
    assert.equal(data.coverage.sort_ui_verified, true); assert.equal(data.coverage.sort_verified, false);
    assert.equal(data.after.search.coverage.sort_verified, false);
    assert.equal(data.after.search.items[0].price.eligibility_verified, false);
    assert.equal(data.action_evidence.acknowledgement_error, 'BRIDGE_UNAVAILABLE');
    assert.equal(f.clicks(), 1); assert.equal(f.reads(), 3);
    assertPausedDisplays(f.displays, []);
    const requests = f.server.state.requests.length;
    await runTask(f.options, f.clock);
    assert.equal(f.server.state.requests.length, requests);
  });
}

test('a changed tab and URL without changed product order cannot confirm sorting or reset the round', async t => {
  const f = await fixture(t, { stale: true });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(result.operations[0].partial_search.search.page, 2);
  assert.equal(f.clicks(), 1); assert.equal(f.reads(), 4);
  await assert.rejects(createTask({ ...f.options, task: 'bypass' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});

for (const [gate, status, recovery] of [['verification_required', 'waiting_user', 'user'], ['rate_limited', 'waiting_cooldown', 'cooldown']]) {
  test(`${gate} pauses sorting; explicit recovery observes the original click`, async t => {
    const f = await fixture(t, { gateAfterClick: gate });
    assert.equal((await runTask(f.options, f.clock)).status, status);
    const expectedDisplay = [{ tabId: 41, status, code: gate === 'verification_required' ? 'VERIFICATION_REQUIRED' : 'RATE_LIMITED' }];
    assertPausedDisplays(f.displays, expectedDisplay);
    const requests = f.server.state.requests.length;
    await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
    assert.equal(f.server.state.requests.length, requests);
    f.setGate(null);
    assert.equal((await runTask({ ...f.options, recovery }, f.clock)).status, 'complete');
    assert.equal(f.clicks(), 1);
    assertPausedDisplays(f.displays, expectedDisplay);
  });
}

test('sort target diagnosis and rebind preserve the existing journal and its URL-token allowance', async t => {
  const f = await fixture(t, { gateAfterClick: 'verification_required' });
  await runTask(f.options, f.clock);
  const expectedDisplay = [{ tabId: 41, status: 'waiting_user', code: 'VERIFICATION_REQUIRED' }];
  assertPausedDisplays(f.displays, expectedDisplay);
  f.setGate(null); f.move(42);
  assert.equal((await runTask({ ...f.options, recovery: 'user' }, f.clock)).status, 'waiting_connection');
  const saved = await loadTask(f.options.stateDirectory, f.options.task);
  const diagnosis = await diagnoseTask(f.options);
  assert.deepEqual(diagnosis.operations[0].matching_tab_ids, [42]);
  assert.equal(diagnosis.operations[0].sort_parameter_allowed, true);
  await rebindTask({ ...f.options, tabId: 42 });
  assert.deepEqual((await loadTask(f.options.stateDirectory, f.options.task)).operations[0].search_sort, saved.operations[0].search_sort);
  assert.equal((await runTask({ ...f.options, recovery: 'connection' }, f.clock)).status, 'complete');
  assert.equal(f.clicks(), 1);
  assertPausedDisplays(f.displays, expectedDisplay);
});

test('a saved tab outside the current window is address-checked without focusing or creating tabs', async t => {
  const f = await fixture(t, { otherWindow: true });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(f.clicks(), 1); assert.equal(f.reads(), 3);
  const commands = f.server.state.commands;
  assert.ok(commands.some(command => command.script?.includes('function inspectSortTarget(')));
  assert.ok(commands.every(command => ['tab_list', 'eval'].includes(command.action)));
  assert.ok(commands.filter(command => command.action === 'eval').every(command => command.tabId === 41));
  assert.equal(result.operations[0].dom_observations_reserved, 3);
});

test('an absent saved ID never falls back to another current tab or sends a sort click', async t => {
  const f = await fixture(t, { otherWindow: true }); f.move(42);
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'waiting_connection'); assert.equal(f.clicks(), 0); assert.equal(f.reads(), 0);
  assert.equal(result.operations[0].dom_observations_reserved, 1);
});

test('sort checkpoints reject fabricated action intent and upgraded algorithm guarantees before browser access', async t => {
  const f = await fixture(t);
  const filename = path.join(f.options.stateDirectory, 'tasks/sales-sort.json');
  const pending = await readFile(filename, 'utf8');
  const bad = JSON.parse(pending); bad.operations[0].search_sort.action_reserved = true;
  await writeFile(filename, JSON.stringify(bad));
  await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  assert.equal(f.server.state.requests.length, 0);
  await writeFile(filename, pending);
  await runTask(f.options, f.clock);
  const completed = JSON.parse(await readFile(filename, 'utf8'));
  completed.operations[0].result.coverage.sort_verified = true;
  await writeFile(filename, JSON.stringify(completed));
  await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
});

test('killing the actual CLI after a sales click never dispatches another click on recovery', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url)),
    'task-run', '--task', f.options.task, '--state-dir', f.options.stateDirectory, '--endpoint', f.options.bridge.endpoint], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([f.dispatched, once(child, 'exit').then(() => { throw new Error('CLI exited before dispatch.'); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(result.operations[0].attempts, 2);
  assert.equal(result.automatic_retries, 1); assert.equal(result.wait_reserved_ms, 5000); assert.equal(f.clicks(), 1);
});

test('sort CLI accepts only sales, requires search, and cannot combine sorting with pagination', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping sort cli '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = async args => { let output = ''; const code = await main(args, { write: value => { output += value; } }); return { code, value: JSON.parse(output) }; };
  for (const args of [['--search', 'mouse', '--tab', '41', '--sort', 'price'], ['--bindings', 'mouse', '--sort', 'sales'],
    ['--search', 'mouse', '--tab', '41', '--sort', 'sales', '--pages', '2']]) {
    const result = await run(['task-start', '--task', 'invalid', '--state-dir', directory, ...args]);
    assert.equal(result.value.error.code, 'INVALID_ARGUMENTS');
  }
  const result = await run(['task-start', '--task', 'sort', '--state-dir', directory, '--search', 'mouse', '--tab', '41', '--sort', 'sales']);
  assert.equal(result.code, 0); assert.equal(result.value.task_kind, 'search_sort');
});

test('sort observation allowance persists across connection failures and prevents a ninth read', async () => {
  const target = searchTarget('mouse'); let reads = 0, now = 10000;
  const op = { tab_id: 41, target, search_sort: newSearchSortState() };
  const context = { op, now: () => now, wait: async ms => { now += ms; }, commit: async () => validateSearchSortState(op.search_sort, target),
    bridge: { readSearchSort: async () => { reads += 1; throw new ShoppingError('TARGET_MISSING', 'Synthetic'); } } };
  for (let count = 0; count < 8; count += 1) await assert.rejects(runSearchSort(context), { code: 'TARGET_MISSING' });
  await assert.rejects(runSearchSort(context), { code: 'ACTION_OBSERVATION_LIMIT' });
  assert.equal(reads, 8); assert.equal(op.search_sort.action_reserved, false);
});

test('slow sort dispatch respects spacing; unstable candidate orders never confirm', async () => {
  const target = searchTarget('mouse');
  for (const unstable of [false, true]) {
    let now = 10000, reads = 0, clickedAt; const readTimes = [];
    const op = { tab_id: 41, target, search_sort: newSearchSortState() };
    const context = { op, now: () => now, wait: async ms => { now += ms; }, commit: async () => validateSearchSortState(op.search_sort, target),
      bridge: { readSearchSort: async () => {
        readTimes.push(now); reads += 1; const raw = rawSorted(target, reads > 1);
        if (unstable && reads > 1) raw.items[0].url = `https://detail.tmall.com/item.htm?id=${900 + reads}`;
        return validateSearchSort(raw, target, reads > 1);
      }, selectSalesSort: async () => { now += 6000; clickedAt = now; } } };
    if (unstable) await assert.rejects(runSearchSort(context), { code: 'ACTION_OUTCOME_UNKNOWN' });
    else assert.equal((await runSearchSort(context)).coverage.sort_ui_verified, true);
    assert.ok(readTimes[1] - clickedAt >= 1500);
  }
});
