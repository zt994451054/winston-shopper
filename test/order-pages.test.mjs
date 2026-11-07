import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, runTask, rebindTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { validateOrderPage } from '../lib/order-page-view.mjs';
import { validateReadActionAcknowledgement } from '../lib/read-action.mjs';
import { buildCachedReport, renderCachedReport } from '../lib/cached-report.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { observeOrderPage, orderPageGroups, orderTarget } from '../test-support/order-fixture.mjs';

/**
 * A synthetic order list behind a fake bridge. `lag` reads after each click still show the previous page;
 * `staleList` reads show the new page number over the previous page's orders.
 */
function orderWorld({ total = 3, totalFor = () => total, lastCount = 30, lag = 0, staleList = 0, stuck = false, idsFor = () => null,
  viewFor = () => ({}), emptyPages = [] } = {}) {
  let current = 1, lagLeft = 0, staleLeft = 0, clicks = 0, reads = 0;
  const groupsFor = page => emptyPages.includes(page) ? [] : orderPageGroups(page, page === totalFor(page) ? lastCount : 30, idsFor(page));
  const bridge = { endpoint: 'http://127.0.0.1:19999', protocol: 'playwright-extension',
    requireConnected: async () => {},
    listTabs: async () => [{ id: 43, url: orderTarget.url }],
    readOrderPage: async (tabId, target, allowed) => {
      reads++;
      const shown = lagLeft > 0 ? (lagLeft--, current - 1) : current;
      const listed = staleLeft > 0 && shown === current ? (staleLeft--, current - 1) : shown;
      const raw = observeOrderPage(groupsFor(listed), { page: shown, total: totalFor(shown), view: viewFor(shown), allowedPages: allowed }).value;
      return validateOrderPage(raw, target, allowed);
    },
    nextOrderPage: async (tabId, target, before) => {
      const result = observeOrderPage(groupsFor(current), { page: current, total: totalFor(current), view: viewFor(current), before });
      const acknowledgement = validateReadActionAcknowledgement(result.value);
      clicks += result.clicks.length;
      if (!stuck) { current++; lagLeft = lag; staleLeft = staleList; }
      return acknowledgement;
    } };
  return { bridge, clicks: () => clicks, reads: () => reads, page: () => current, setPage: value => { current = value; } };
}

async function fixture(t, pages = 3, worldOptions = {}) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping order pages '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const world = orderWorld(worldOptions);
  let now = 10000;
  const options = { stateDirectory, task: 'pages', orders: true, pages, tabId: 43, bridge: world.bridge };
  return { options, world, filename: path.join(stateDirectory, 'tasks', 'pages.json'),
    clock: { now: () => now, wait: async ms => { now += ms; } }, advance: ms => { now += ms; } };
}

test('--orders --pages creates a bounded paging journal without browser access', async t => {
  const f = await fixture(t, 3);
  const created = await createTask(f.options);
  assert.equal(created.task_kind, 'order_pages');
  const op = (await loadTask(f.options.stateDirectory, 'pages')).operations[0];
  assert.equal(op.order_read, undefined);
  assert.deepEqual(op.order_pages, { schema_version: 2, requested_pages: 3, orders_per_page: 50, read_limit: 6, recovery_limit: 2,
    recovery_wait_ms: 5000, recoveries_reserved: 0, failures: [], observation_limit: 13, observations: 0, not_before: 0, pages: [], transitions: [],
    empty_last_page: null });
  assert.equal(f.world.reads() + f.world.clicks(), 0);
});

test('order paging rejects out-of-range counts and conflicting modes before browser access', async t => {
  const f = await fixture(t);
  for (const pages of [0, 11, -1, 1.5, NaN, '2', null]) {
    await assert.rejects(createTask({ ...f.options, pages }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const extra of [{ orderRows: 10 }, { sort: 'price-asc' }, { cart: true }, { search: 'x' }, { tabId: undefined }]) {
    await assert.rejects(createTask({ ...f.options, ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(createTask({ ...f.options, orders: false, pages: 2 }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(f.world.reads(), 0);
});

test('three pages complete with one confirmed click per page and disjoint orders', async t => {
  const f = await fixture(t, 3, { total: 9 });
  await createTask(f.options);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  const op = report.operations[0], result = op.result;
  assert.deepEqual(result.pages.map(page => page.pager.current_page), [1, 2, 3]);
  assert.equal(result.returned_orders, 90); assert.equal(result.distinct_orders, 90);
  assert.equal(result.end_reason, 'requested_pages');
  assert.equal(result.coverage.all_listed_pages_read, false);
  assert.equal(result.coverage.total_pages_displayed, 9);
  assert.equal(result.coverage.total_pages_changed, false);
  assert.equal(result.coverage.full_order_history, false);
  assert.equal(result.coverage.page_transition_verified, true);
  assert.deepEqual(result.action_evidence.transitions.map(item => [item.from_page, item.to_page, item.checks, item.verified]), [[1, 2, 2, true], [2, 3, 2, true]]);
  assert.equal(op.actions_reserved, 2); assert.equal(op.dom_observations_reserved, 7); assert.equal(op.order_budget.reads_reserved, 1);
  assert.equal(f.world.clicks(), 2); assert.equal(f.world.reads(), 5);
  const calls = f.world.reads() + f.world.clicks();
  assert.deepEqual((await runTask(f.options, f.clock)).operations[0].result, result);
  assert.equal(f.world.reads() + f.world.clicks(), calls);
});

test('a shorter list ends on its visible last page and reports every listed page as read', async t => {
  const f = await fixture(t, 10, { total: 2, lastCount: 7 });
  await createTask(f.options);
  const result = (await runTask(f.options, f.clock)).operations[0].result;
  assert.equal(result.end_reason, 'last_page');
  assert.equal(result.coverage.all_listed_pages_read, true);
  assert.equal(result.coverage.visible_last_page_verified, true);
  assert.equal(result.coverage.requested_bound_reached, false);
  assert.equal(result.returned_orders, 37);
  assert.equal(f.world.clicks(), 1);
});

test('a displayed page total that the platform revises while paging is recorded, not treated as a failure', async t => {
  // Live on 2026-10-13: pages 1 and 2 showed 9 pages, page 3 showed 8.
  const f = await fixture(t, 3, { totalFor: page => page < 3 ? 9 : 8 });
  await createTask(f.options);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  const { coverage, pages } = report.operations[0].result;
  assert.deepEqual(pages.map(page => page.pager.total_pages_displayed), [9, 9, 8]);
  assert.equal(coverage.total_pages_first_displayed, 9);
  assert.equal(coverage.total_pages_displayed, 8);
  assert.equal(coverage.total_pages_changed, true);
  assert.equal(coverage.all_listed_pages_read, false);
  const shrunk = await fixture(t, 5, { totalFor: page => page === 1 ? 3 : 2, lastCount: 5 });
  await createTask(shrunk.options);
  const ended = (await runTask(shrunk.options, shrunk.clock)).operations[0].result;
  assert.equal(ended.end_reason, 'last_page');
  assert.equal(ended.coverage.all_listed_pages_read, true);
  assert.equal(shrunk.world.clicks(), 1);
});

test('a displayed last page with no orders ends the list after two matching reads', async t => {
  // Live on 2026-10-13: page 8 held 21 orders with next enabled, and the displayed last page 9 held none.
  const f = await fixture(t, 10, { total: 3, emptyPages: [3], lastCount: 0 });
  await createTask(f.options);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  const result = report.operations[0].result;
  assert.equal(result.end_reason, 'empty_last_page');
  assert.deepEqual(result.pages.map(page => page.pager.current_page), [1, 2]);
  assert.deepEqual(result.empty_last_page.pager, { current_page: 3, total_pages_displayed: 3, previous_disabled: false, next_disabled: true });
  assert.equal(result.coverage.all_listed_pages_read, true);
  assert.equal(result.coverage.visible_last_page_verified, true);
  assert.equal(result.coverage.pages_read, 2);
  assert.equal(result.returned_orders, 60);
  assert.deepEqual(result.action_evidence.transitions.map(item => [item.to_page, item.checks, item.verified]), [[2, 2, true], [3, 2, true]]);
  assert.equal(f.world.clicks(), 2);
  assert.deepEqual((await taskStatus(f.options)).operations[0].result, result);
  const report2 = buildCachedReport(await loadTask(f.options.stateDirectory, 'pages'));
  assert.deepEqual(report2.observations.map(item => [item.batch_position, item.coverage.returned_orders]), [[1, 30], [2, 30], [3, 0]]);
  assert.equal(report2.records.filter(record => record.record_type === 'order_pagination').length, 3);
});

test('an empty page that is not the displayed last page, or an empty first page, never ends the list', async t => {
  const middle = await fixture(t, 3, { total: 9, emptyPages: [2] });
  await createTask(middle.options);
  const stopped = await runTask(middle.options, middle.clock);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.operations[0].error.code, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(middle.world.clicks(), 1);
  const first = await fixture(t, 3, { emptyPages: [1] });
  await createTask(first.options);
  const empty = await runTask(first.options, first.clock);
  assert.equal(empty.status, 'stopped');
  assert.equal(empty.operations[0].error.code, 'PAGE_STRUCTURE_CHANGED');
  assert.equal(first.world.clicks(), 0);
});

test('schema 1 journals stay readable with their original result and still stop on an empty page', async t => {
  const done = await fixture(t, 2);
  await createTask(done.options);
  const completed = await runTask(done.options, done.clock);
  const task = JSON.parse(await readFile(done.filename, 'utf8'));
  task.operations[0].order_pages.schema_version = 1;
  delete task.operations[0].order_pages.empty_last_page;
  delete task.operations[0].result.empty_last_page;
  await writeFile(done.filename, JSON.stringify(task));
  const legacy = (await taskStatus(done.options)).operations[0].result;
  assert.equal(Object.hasOwn(legacy, 'empty_last_page'), false);
  assert.deepEqual({ ...legacy, empty_last_page: null }, completed.operations[0].result);
  const old = await fixture(t, 10, { total: 3, emptyPages: [3], lastCount: 0 });
  await createTask(old.options);
  const saved = JSON.parse(await readFile(old.filename, 'utf8'));
  saved.operations[0].order_pages.schema_version = 1;
  delete saved.operations[0].order_pages.empty_last_page;
  await writeFile(old.filename, JSON.stringify(saved));
  const stopped = await runTask(old.options, old.clock);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.operations[0].error.code, 'PAGE_STRUCTURE_CHANGED');
});

test('reads that still show the old page or the old orders are not counted as the new page', async t => {
  for (const options of [{ lag: 1 }, { staleList: 1 }]) {
    const f = await fixture(t, 2, { total: 3, ...options });
    await createTask(f.options);
    const report = await runTask(f.options, f.clock);
    assert.equal(report.status, 'complete');
    assert.equal(report.operations[0].result.action_evidence.transitions[0].checks, 3);
    assert.equal(f.world.clicks(), 1);
  }
});

test('a page that never turns stops without a second click', async t => {
  const f = await fixture(t, 3, { stuck: true });
  await createTask(f.options);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped');
  assert.equal(report.operations[0].error.code, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(f.world.clicks(), 1);
  assert.equal(report.operations[0].partial_pages.length, 1);
  await runTask(f.options, f.clock);
  assert.equal(f.world.clicks(), 1);
});

test('a page repeating an earlier order stops and keeps the saved pages', async t => {
  const f = await fixture(t, 3, { idsFor: page => page === 2 ? ['1005'] : null });
  await createTask(f.options);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped');
  assert.equal(report.operations[0].error.code, 'ORDER_PAGES_OVERLAP');
  assert.equal(report.operations[0].partial_pages.length, 1);
  assert.equal(f.world.clicks(), 1);
});

test('a non-default start stops before any click, and a later view change stops the reading', async t => {
  for (const [viewFor, code, clicks] of [
    [() => ({ tab: '待收货' }), 'ORDER_VIEW_NOT_DEFAULT', 0],
    [() => ({ search: 'PRIVATE_QUERY' }), 'ORDER_VIEW_NOT_DEFAULT', 0],
    [page => page === 2 ? { tab: '待付款' } : {}, 'ORDER_VIEW_CHANGED', 1],
  ]) {
    const f = await fixture(t, 3, { viewFor });
    await createTask(f.options);
    const report = await runTask(f.options, f.clock);
    assert.equal(report.status, 'stopped');
    assert.equal(report.operations[0].error.code, code);
    assert.equal(f.world.clicks(), clicks);
    assert.equal((await readFile(f.filename, 'utf8')).includes('PRIVATE_QUERY'), false);
  }
});

test('a click that was certainly not sent releases its intent, and the next run reserves it again', async t => {
  const f = await fixture(t, 3);
  const original = f.world.bridge.nextOrderPage;
  let held = false;
  f.world.bridge.nextOrderPage = async (...args) => {
    if (!held) {
      held = true;
      const error = new ShoppingError('PACING_LIMIT', 'Synthetic quota.');
      error.actionNotDispatched = true; error.allowedAt = 10000 + 600000;
      throw error;
    }
    return original(...args);
  };
  await createTask(f.options);
  const paused = await runTask(f.options, f.clock);
  assert.equal(paused.status, 'pending');
  assert.equal(paused.pacing_hold.allowed_after, new Date(610000).toISOString());
  assert.equal(paused.operations[0].actions_reserved, 0);
  assert.equal(paused.operations[0].pages_observed, 1);
  f.advance(600000);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  assert.equal(report.operations[0].actions_reserved, 2);
  assert.equal(f.world.clicks(), 2);
});

test('an uncertain click acknowledgement is observed, never repeated', async t => {
  const f = await fixture(t, 2);
  const original = f.world.bridge.nextOrderPage;
  f.world.bridge.nextOrderPage = async (...args) => { await original(...args); throw new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic lost reply.'); };
  await createTask(f.options);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  assert.equal(report.operations[0].result.action_evidence.transitions[0].acknowledgement_error, 'BRIDGE_TIMEOUT');
  assert.equal(f.world.clicks(), 1);
});

test('an interrupted run after a saved click intent only observes on resume', async t => {
  const f = await fixture(t, 2);
  const original = f.world.bridge.nextOrderPage;
  let atClick;
  // Keep the checkpoint as it was when the click went out, as if the process had died right after it.
  f.world.bridge.nextOrderPage = async (...args) => { atClick = await readFile(f.filename, 'utf8'); return original(...args); };
  await createTask(f.options);
  await runTask(f.options, f.clock);
  await writeFile(f.filename, atClick);
  const saved = await loadTask(f.options.stateDirectory, 'pages');
  assert.equal(saved.operations[0].status, 'running');
  assert.equal(saved.operations[0].order_pages.transitions.length, 1);
  f.world.bridge.nextOrderPage = async () => { throw new Error('A saved click must not be repeated'); };
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  assert.equal(report.automatic_retries, 1);
  assert.deepEqual(report.operations[0].order_budget.failures.map(item => item.code), ['READ_INTERRUPTED']);
  assert.equal(report.operations[0].result.action_evidence.transitions[0].verified, true);
  assert.equal(f.world.clicks(), 1);
});

test('tampered paging journals reject before browser access', async t => {
  const f = await fixture(t, 3);
  await createTask(f.options);
  f.world.bridge.nextOrderPage = async () => { throw new ShoppingError('TARGET_MISSING', 'Synthetic missing tab.'); };
  const paused = await runTask(f.options, f.clock);
  assert.equal(paused.status, 'waiting_connection');
  const original = await readFile(f.filename, 'utf8');
  const calls = f.world.reads() + f.world.clicks();
  for (const mutate of [
    op => { op.order_pages.requested_pages = 11; },
    op => { op.order_pages.orders_per_page = 30; },
    op => { op.order_pages.read_limit = 7; },
    op => { op.order_pages.pages[0].pager.current_page = 2; },
    op => { op.order_pages.pages[0].view.tab = '待付款'; },
    op => { op.order_pages.pages[0].rows.orders[1].order_id = op.order_pages.pages[0].rows.orders[0].order_id; },
    op => { op.order_pages.transitions.push({ from_page: 1, to_page: 2, action_reserved_at: new Date(0).toISOString(), acknowledgement_error: null, checks: 0, candidate: null, confirmed: true }); },
    op => { op.order_pages.observations = 0; },
    op => { op.order_read = { schema_version: 2 }; },
  ]) {
    const task = JSON.parse(original); mutate(task.operations[0]); await writeFile(f.filename, JSON.stringify(task));
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.world.reads() + f.world.clicks(), calls);
  await writeFile(f.filename, original);
  assert.equal((await taskStatus(f.options)).status, 'waiting_connection');
});

test('a lost tab waits for the connection; rebinding accepts only the list route and diagnostics state the allowed pages', async t => {
  const f = await fixture(t, 3);
  await createTask(f.options);
  const read = f.world.bridge.readOrderPage;
  let reads = 0;
  f.world.bridge.readOrderPage = async (...args) => {
    if (++reads === 3) throw new ShoppingError('TARGET_MISSING', 'Synthetic missing tab.');
    return read(...args);
  };
  const paused = await runTask(f.options, f.clock);
  assert.equal(paused.status, 'waiting_connection');
  const diagnosed = await diagnoseTask(f.options);
  assert.deepEqual(diagnosed.operations[0].allowed_pages, [1, 2]);
  assert.equal(diagnosed.operations[0].page_shown_in_address, false);
  assert.equal(diagnosed.operations[0].action_will_repeat, false);
  f.world.bridge.listTabs = async () => [{ id: 44, url: 'https://cart.taobao.com/cart.htm' }, { id: 45, url: `${orderTarget.url}?x=1` }];
  await assert.rejects(rebindTask({ ...f.options, tabId: 44 }), { code: 'TASK_TARGET_MISMATCH' });
  const rebound = await rebindTask({ ...f.options, tabId: 45 });
  assert.equal(rebound.status, 'task_rebound');
  const resumed = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(resumed.status, 'complete');
  assert.equal(f.world.clicks(), 2);
});

test('report export lists each page as its own observation with its pager, view and orders', async t => {
  const f = await fixture(t, 3, { total: 2, lastCount: 3 });
  await createTask(f.options);
  await runTask(f.options, f.clock);
  const report = buildCachedReport(await loadTask(f.options.stateDirectory, 'pages'));
  assert.deepEqual(report.observations.map(item => item.batch_position), [1, 2]);
  assert.deepEqual(report.observations.map(item => item.coverage.returned_orders), [30, 3]);
  assert.equal(report.observations[0].collection_coverage.end_reason, 'last_page');
  assert.equal(report.observations[0].collection_coverage.distinct_orders, 33);
  assert.equal(report.observations[0].collection_coverage.all_listed_pages_read, true);
  const pagers = report.records.filter(record => record.record_type === 'order_pagination');
  assert.deepEqual(pagers.map(record => record.text), [
    'current_page=1; total_pages_displayed=2; previous_disabled=true; next_disabled=false; tab=所有订单; order_search_empty=true',
    'current_page=2; total_pages_displayed=2; previous_disabled=false; next_disabled=true; tab=所有订单; order_search_empty=true']);
  assert.equal(report.records.filter(record => record.record_type === 'order').length, 33);
  assert.equal(new Set(report.records.filter(record => record.record_type === 'order').map(record => record.order_id)).size, 33);
  for (const format of ['markdown', 'csv']) assert.match(renderCachedReport(report, format), /order\\?_pagination/);
});
