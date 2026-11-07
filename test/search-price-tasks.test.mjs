import test from 'node:test';
import { searchTarget } from '../lib/search.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask, rebindTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { priceSearchPage } from '../test-support/search-price-fixture.mjs';

// The real daemon returns objects with alphabetically ordered keys; validators must not depend on key order.
function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, reorder(value[key])]));
}

/** A loopback stand-in for the Playwright service, driving the synthetic page with the fixed commands the bridge sends. */
async function fixture(t, { gateAfterPick = false } = {}) {
  const page = priceSearchPage();
  const counts = { eval: 0, snapshot: 0, hover: 0, fill: 0, picks: 0, confirms: 0 };
  let refs = {}, tab = 41;
  const server = await mockBridge(t, { handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(reorder(value)));
    if (req.url === '/status') return send(playwrightStatus());
    const reply = data => send({ id: body.id, success: true, data });
    if (body.action === 'tab_list') return reply({ tabs: [{ id: tab, url: page.context.location.href }] });
    if (body.tabId !== tab) return send({ id: body.id, success: false, error: 'No such tab' });
    counts[body.action] += 1;
    if (body.action === 'eval') {
      const result = JSON.parse(JSON.stringify(vm.runInNewContext(body.script, page.context)));
      if (result.state === 'action_dispatched') {
        if (body.script.includes('directionOption')) {
          counts.picks += 1;
          if (gateAfterPick) { page.state.gate = 'slider'; page.refresh(); }
        } else counts.confirms += 1;
      }
      return reply({ result });
    }
    if (body.action === 'snapshot') {
      const nodes = page.context.document.querySelectorAll(body.selector);
      if (nodes.length !== 1) return reply({ url: page.context.location.href, snapshotData: { snapshot: '(empty)', refs: {} } });
      const node = nodes[0], input = node.tagName === 'INPUT';
      refs = { 0: { backendDOMNodeId: 7, role: input ? 'textbox' : 'tab', name: input ? node.getAttribute('placeholder') : node.innerText } };
      return reply({ url: page.context.location.href, snapshotData: { snapshot: '- ref', refs } });
    }
    if (body.action === 'hover') { page.hover(refs[body.ref].name); return reply({ role: 'tab', name: refs[body.ref].name }); }
    if (body.action === 'fill') {
      page.fill(refs[body.ref].name === '¥ 最低价' ? 'minimum' : 'maximum', body.text);
      return reply({ role: 'textbox', name: refs[body.ref].name, filledText: body.text });
    }
    return send({ id: body.id, success: false, error: 'Unexpected command' });
  } });
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping price '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let now = Date.now();
  return { page, server, counts, stateDirectory, bridge: new BrowserBridge(server.endpoint),
    clock: { now: () => now, wait: async ms => { now += ms; } }, move: id => { tab = id; } };
}

test('a saved price task applies descending order and a range through the real bridge, then serves only its cache', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.stateDirectory, task: 'price', search: 'Synthetic mouse', tabId: 41, sort: 'price-desc',
    minPrice: '40', maxPrice: '60', bridge: f.bridge };
  const created = await createTask(options);
  assert.equal(created.task_kind, 'search_price');
  const result = await runTask(options, f.clock);
  assert.equal(result.status, 'complete');
  // A search task binds no product, so the per-product count does not apply (it used to read 0).
  assert.equal(result.distinct_products, null);
  const data = result.operations[0].result;
  assert.equal(data.applied.price_sort.marked_option, '从高到低');
  assert.deepEqual(data.applied.price_range.reopened_input_text, { minimum_text: '40', maximum_text: '60' });
  assert.equal(data.coverage.platform_ui_applied, true); assert.equal(data.coverage.sort_verified, false);
  // Both range bounds are one recorded action (schema 4) but still two typed inputs.
  assert.equal(result.operations[0].actions_reserved, 11);
  assert.deepEqual([f.counts.picks, f.counts.confirms, f.counts.hover, f.counts.fill], [1, 1, 8, 2]);
  assert.equal((await loadTask(f.stateDirectory, 'price')).status, 'complete');
  assert.deepEqual((await taskStatus(options)).operations[0].result, data);
  const requests = f.server.state.requests.length;
  assert.deepEqual((await runTask(options, f.clock)).operations[0].result, data);
  assert.equal(f.server.state.requests.length, requests);
});

test('a verification gate after the direction click pauses; the explicit resume observes without clicking again', async t => {
  const f = await fixture(t, { gateAfterPick: true });
  const options = { stateDirectory: f.stateDirectory, task: 'gated', search: 'Synthetic mouse', tabId: 41, sort: 'price-asc', bridge: f.bridge };
  await createTask(options);
  assert.equal((await runTask(options, f.clock)).status, 'waiting_user');
  f.page.state.gate = null; f.page.refresh();
  const resumed = await runTask({ ...options, recovery: 'user' }, f.clock);
  assert.equal(resumed.status, 'complete'); assert.equal(f.counts.picks, 1);
  assert.equal(resumed.operations[0].result.applied.price_sort.marked_option, '从低到高');
});

test('rebinding is allowed only before the first pointer action; diagnosis reports that the action never repeats', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.stateDirectory, task: 'moved', search: 'Synthetic mouse', tabId: 41, maxPrice: '50', bridge: f.bridge };
  await createTask(options);
  f.move(77);
  assert.equal((await runTask(options, f.clock)).status, 'waiting_connection');
  let diagnosis = await diagnoseTask(options);
  assert.equal(diagnosis.operations[0].replacement_allowed, true); assert.deepEqual(diagnosis.operations[0].matching_tab_ids, [77]);
  await rebindTask({ ...options, tabId: 77 });
  assert.equal((await loadTask(f.stateDirectory, 'moved')).operations[0].tab_id, 77);
  const run = await runTask({ ...options, recovery: 'connection' }, f.clock);
  assert.equal(run.status, 'complete');
  diagnosis = await diagnoseTask(options);
  assert.equal(diagnosis.operations.length, 0);
});

test('price tasks require a search tab on the extension connection, read 1-5 pages and cannot mix with sales or inspections', async t => {
  const f = await fixture(t);
  const base = { stateDirectory: f.stateDirectory, search: 'Synthetic mouse', tabId: 41, bridge: f.bridge };
  for (const [task, extra] of [['pages', { sort: 'price-asc', pages: 6 }], ['sales-pages', { sort: 'sales', pages: 2 }], ['sales', { sort: 'sales', minPrice: '1' }],
    ['inspect', { inspectPrice: true, maxPrice: '9' }], ['cart', { search: undefined, cart: true, minPrice: '1' }],
    ['owned', { sort: 'price-asc', bridge: { endpoint: f.bridge.endpoint, protocol: 'owned-chrome-cdp' } }]]) {
    await assert.rejects(createTask({ ...base, task, ...extra }), { code: task === 'owned' ? 'INVALID_TRANSPORT' : 'INVALID_ARGUMENTS' }, task);
  }
  await assert.rejects(createTask({ ...base, task: 'inverted', minPrice: '9', maxPrice: '1' }), { code: 'INVALID_ARGUMENTS' });
  const paged = await createTask({ ...base, task: 'paged', sort: 'price-asc', maxPrice: '90', pages: 3 });
  assert.equal(paged.task_kind, 'search_price');
  assert.equal((await taskStatus({ stateDirectory: f.stateDirectory, task: 'paged' })).operations[0].requested_pages, 3);
});

test('a price task reads three sorted pages through the real bridge, guarding each page address', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.stateDirectory, task: 'paged-price', search: 'Synthetic mouse', tabId: 41, sort: 'price-asc', pages: 3, bridge: f.bridge };
  await createTask(options);
  const result = await runTask(options, f.clock);
  assert.equal(result.status, 'complete');
  const data = result.operations[0].result;
  assert.deepEqual(data.pages.map(page => page.search.page), [2, 3]);
  assert.equal(data.paging.end_reason, 'requested_pages');
  assert.equal(data.paging.last_page_checks.marked_option, '从低到高');
  assert.equal(f.page.state.page, 3);
  assert.deepEqual((await runTask(options, f.clock)).operations[0].result, data, 'a completed task only serves its cache');
});

test('after a pointer action, a replacement tab is refused even with the same search URL', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.stateDirectory, task: 'locked', search: 'Synthetic mouse', tabId: 41, sort: 'price-asc', bridge: f.bridge };
  await createTask(options);
  let moved = false;
  // The tab disappears right after the pointer reached 价格, before the direction menu is read.
  const wait = async ms => { await f.clock.wait(ms); if (f.counts.hover === 2 && !moved) { moved = true; f.move(78); } };
  const result = await runTask(options, { now: f.clock.now, wait });
  assert.equal(result.status, 'waiting_connection');
  assert.ok(result.operations[0].actions_reserved >= 1);
  await assert.rejects(rebindTask({ ...options, tabId: 78 }), { code: 'INVALID_RECOVERY' });
  assert.equal((await diagnoseTask(options)).operations[0].replacement_allowed, false);
});

test('a slow pointer acknowledgement gets its own longer deadline while ordinary reads keep the configured one', async t => {
  const f = await fixture(t);
  const slow = await mockBridge(t, { async handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(reorder(value)));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: 41, url: 'https://s.taobao.com/search?page=1&q=Synthetic%20mouse&tab=all' }] } });
    if (body.action === 'eval' && body.script.includes('tabPointerSelector')) {
      return send({ id: body.id, success: true, data: { result: JSON.parse(JSON.stringify(vm.runInNewContext(body.script, f.page.context))) } });
    }
    if (body.action === 'snapshot') {
      return send({ id: body.id, success: true, data: { url: f.page.target.url, snapshotData: { refs: { 0: { backendDOMNodeId: 7, role: 'tab', name: '价格' } } } } });
    }
    // Hovers and ordinary reads both answer after 300 ms; only the pointer deadline tolerates it.
    await new Promise(resolve => setTimeout(resolve, 300));
    return send({ id: body.id, success: true, data: body.action === 'hover' ? { role: 'tab', name: '价格' } : { result: { state: 'loading' } } });
  } });
  const bridge = new BrowserBridge(slow.endpoint, { timeoutMs: 100 });
  const target = (await import('../lib/search.mjs')).searchTarget('Synthetic mouse');
  assert.deepEqual(await bridge.hoverPriceTab(41, target, '价格'), { hovered: true });
  await assert.rejects(bridge.readSearchPrice(41, target), { code: 'BRIDGE_TIMEOUT' });
});

test('a results load failure during a price task pauses the platform for an explicit later resume', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.stateDirectory, task: 'throttled', search: 'Synthetic mouse', tabId: 41, sort: 'price-asc', bridge: f.bridge };
  await createTask(options);
  f.page.state.resultsFailed = true; f.page.refresh();
  const paused = await runTask(options, f.clock);
  assert.equal(paused.status, 'waiting_cooldown');
  assert.equal(paused.operations[0].error.code, 'SEARCH_RESULTS_UNAVAILABLE'); assert.equal(paused.operations[0].actions_reserved, 0);
  const requests = f.server.state.requests.length;
  await assert.rejects(runTask(options, f.clock), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.server.state.requests.length, requests);
});

test('a stopped price task reports the recorded mismatch reasons in its status', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.stateDirectory, task: 'ignored', search: 'Synthetic mouse', tabId: 41, sort: 'price-asc', bridge: f.bridge };
  await createTask(options);
  f.page.state.ignoreClicks = true;
  const stopped = await runTask(options, f.clock);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.operations[0].error.code, 'ACTION_OUTCOME_UNKNOWN');
  const mismatches = stopped.operations[0].observation_mismatches;
  assert.equal(mismatches.length, 4);
  assert.deepEqual(mismatches[0].reasons, ['comprehensive_selected', 'list_unchanged']);
  assert.equal(mismatches[0].expect, 'direction_applied');
});

test('a used-up pacing quota pauses the task until the allowed time; earlier runs send nothing and the click happens once', async t => {
  const { Pacer } = await import('../lib/pacing.mjs');
  const { writeFile } = await import('node:fs/promises');
  const f = await fixture(t);
  const file = path.join(f.stateDirectory, 'pacing.json'), start = f.clock.now();
  // Five search loads in the last ten minutes: the earliest frees its slot five minutes from now.
  await writeFile(file, JSON.stringify({ schema_version: 1, last_interaction_at: 0, last_load_at: 0, gap: null, load_gap: null,
    loads: [5, 4, 3, 2, 1].map(minutes => ({ at: start - minutes * 60_000, category: 'search' })) }));
  const bridge = new BrowserBridge(f.server.endpoint).usePacer(new Pacer({ file, now: f.clock.now, wait: f.clock.wait, random: () => 0 }));
  const options = { stateDirectory: f.stateDirectory, task: 'paced', search: 'Synthetic mouse', tabId: 41, sort: 'price-asc', bridge };
  await createTask(options);
  const held = await runTask(options, f.clock);
  assert.equal(held.status, 'pending'); assert.equal(held.operations[0].error.code, 'PACING_LIMIT');
  assert.equal(held.pacing_hold.allowed_after, new Date(start + 5 * 60_000).toISOString());
  assert.equal(f.counts.picks, 0);
  const requests = f.server.state.requests.length;
  assert.equal((await runTask(options, f.clock)).status, 'pending');
  assert.equal(f.server.state.requests.length, requests, 'a held task makes no request before its allowed time');
  f.clock.wait(5 * 60_000);
  const done = await runTask(options, f.clock);
  assert.equal(done.status, 'complete'); assert.equal(done.pacing_hold, undefined);
  assert.equal(f.counts.picks, 1); assert.equal(done.operations[0].error, null);
});

test('the bridge types range bounds only into an open, empty panel, and refuses before typing otherwise', async t => {
  const f = await fixture(t);
  const root = searchTarget('Synthetic mouse');
  const fields = [{ field: 'minimum', text: '40' }, { field: 'maximum', text: '60' }];
  await assert.rejects(f.bridge.fillPriceRange(41, root, fields), error => error.code === 'PRICE_CONTROL_UNAVAILABLE' && error.actionNotDispatched === true);
  f.page.hover('区间'); f.page.fill('minimum', '5');
  await assert.rejects(f.bridge.fillPriceRange(41, root, fields), error => error.code === 'PRICE_CONTROL_NOT_CONFIRMED' && error.actionNotDispatched === true);
  for (const invalid of [[], [{ field: 'maximum', text: '60' }, { field: 'minimum', text: '40' }], [{ field: 'minimum', text: '-1' }]]) {
    await assert.rejects(f.bridge.fillPriceRange(41, root, invalid), error => error.code === 'INVALID_ARGUMENTS' && error.actionNotDispatched === true);
  }
  assert.equal(f.counts.fill, 0);
  f.page.fill('minimum', '');
  assert.deepEqual(await f.bridge.fillPriceRange(41, root, fields), { filled: true });
  assert.equal(f.counts.fill, 2);
  assert.deepEqual([f.page.state.minimum, f.page.state.maximum], ['40', '60']);
});

test('search conditions are accepted alone or with price behavior, refused elsewhere, and run through the real bridge', async t => {
  const f = await fixture(t);
  const base = { stateDirectory: f.stateDirectory, search: 'Synthetic mouse', tabId: 41, bridge: f.bridge };
  for (const [task, extra] of [['bad-source', { source: 'taobao' }], ['bad-filter', { filters: ['明日达'] }], ['sales', { sort: 'sales', filters: ['包邮'] }],
    ['inspect', { inspectPrice: true, source: 'tmall' }], ['cart', { search: undefined, cart: true, filters: ['包邮'] }]]) {
    await assert.rejects(createTask({ ...base, task, ...extra }), { code: 'INVALID_ARGUMENTS' }, task);
  }
  const options = { ...base, task: 'conditions', source: 'tmall', filters: ['包邮'], sort: 'price-asc', pages: 2 };
  assert.equal((await createTask(options)).task_kind, 'search_price');
  assert.deepEqual((await taskStatus(options)).operations[0].requested_conditions, { source: 'tmall', filters: ['包邮'] });
  const result = await runTask(options, f.clock);
  assert.equal(result.status, 'complete');
  const data = result.operations[0].result;
  assert.deepEqual([data.applied.source.source, data.applied.filters.map(item => item.label)], ['tmall', ['包邮']]);
  assert.deepEqual([f.page.state.source, f.page.state.filters, f.page.state.page], ['tmall', ['包邮'], 2]);
});
