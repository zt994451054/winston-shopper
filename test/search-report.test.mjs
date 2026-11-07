import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { searchTarget } from '../lib/search.mjs';
import { buildCachedReport, renderCachedReport } from '../lib/cached-report.mjs';
import { exportReport } from '../lib/report-export.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';

const target = searchTarget('Synthetic mouse');
const pageUrl = page => target.url.replace('&page=1&', `&page=${page}&`);

function rawPage(page, withPagination) {
  const raw = rawSearch({ query: target.query, url: pageUrl(page) });
  raw.items = raw.items.slice(0, 2).map((item, index) => ({ ...item, url: `https://item.taobao.com/item.htm?id=${page * 100 + index}`,
    shop: `Synthetic shop ${page}-${index}` }));
  raw.cards_seen = 2;
  if (withPagination) raw.pagination = { current_page: page, total_pages_displayed: 10, next_disabled: false, previous_disabled: page === 1, selected_sort_label: '综合' };
  return raw;
}

/** Create and run a real search task against a local mocked browser, so the report reads a validated saved cache. */
async function savedSearch(t, pages) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping search report '));
  t.after(() => rm(root, { recursive: true, force: true }));
  let current = 1;
  const server = await mockBridge(t, { handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: 41, url: pageUrl(current) }] } });
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (body.script.includes('"cards_scanned":')) { current += 1; return reply({ state: 'action_dispatched', clicked: true }); }
    return reply(rawPage(current, pages !== undefined));
  } });
  const stateDirectory = path.join(root, 'state');
  const options = { stateDirectory, task: 'saved-search', search: target.query, tabId: 41, bridge: new BrowserBridge(server.endpoint),
    ...(pages === undefined ? {} : { pages }) };
  await createTask(options);
  let now = 10000;
  await runTask(options, { now: () => now, wait: async ms => { now += ms; } });
  return { root, stateDirectory, task: await loadTask(stateDirectory, 'saved-search') };
}

const recordsOf = (report, type) => report.records.filter(row => row.record_type === type);

test('a first-page search report keeps the platform order, each card shop and sales text, the scan counts and coverage', async t => {
  const { task } = await savedSearch(t);
  const result = task.operations[0].result;
  const report = buildCachedReport(task);
  assert.equal(report.observations.length, 1);
  assert.equal(report.observations[0].observed_at, result.observed_at);
  assert.equal(report.observations[0].coverage.status, 'partial');
  assert.deepEqual(report.observations[0].missing, result.missing);
  assert.deepEqual(recordsOf(report, 'search_scan').map(row => [row.label, row.text]),
    ['cards_seen', 'cards_scanned', 'duplicates_omitted', 'unsupported_cards_omitted'].map(key => [key, String(result[key])]));
  assert.deepEqual(recordsOf(report, 'search_item').map(row => [row.item_position, row.product_id, row.title, row.url, row.label, row.text, row.verified]),
    result.items.map(item => [item.position, item.product_id, item.title, item.url, item.price.label, item.price.raw, false]));
  assert.deepEqual(recordsOf(report, 'search_shop').map(row => [row.item_position, row.text]), result.items.map(item => [item.position, item.shop]));
  assert.deepEqual(recordsOf(report, 'search_sales').map(row => row.text), result.items.map(item => item.sales_text));
  assert.equal(recordsOf(report, 'search_pagination').length, 0);
  const csv = renderCachedReport(report, 'csv');
  assert.match(csv, new RegExp(`"'${result.items[0].product_id}"`), 'product IDs stay text in spreadsheets');
  assert.match(renderCachedReport(report, 'markdown'), /search\\_shop/);
});

test('a multi-page search report has one observation per page with its own time and pagination, plus collection counts', async t => {
  const { task } = await savedSearch(t, 3);
  const result = task.operations[0].result;
  const report = buildCachedReport(task);
  assert.deepEqual(report.observations.map(row => [row.batch_position, row.observed_at, row.url]),
    result.pages.map((page, index) => [index + 1, page.search.observed_at, page.search.url]));
  for (const observation of report.observations) {
    assert.deepEqual([observation.collection_coverage.records, observation.collection_coverage.distinct_products, observation.collection_coverage.end_reason],
      [result.records, result.distinct_products, result.end_reason]);
    assert.equal(observation.collection_coverage.page_transition_verified, result.coverage.page_transition_verified);
    assert.ok(result.missing.every(name => observation.missing.includes(`collection.${name}`)));
  }
  assert.deepEqual(recordsOf(report, 'search_pagination').map(row => row.observation_position), [1, 2, 3]);
  assert.match(recordsOf(report, 'search_pagination')[1].text, /^current_page=2; /);
  assert.deepEqual(recordsOf(report, 'search_item').map(row => row.product_id), result.pages.flatMap(page => page.search.items.map(item => item.product_id)));
});

test('an unfinished collection reports only the pages already saved, without collection totals', () => {
  const page = { search: { observed_at: '2026-10-13T00:00:00.000Z', url: pageUrl(1), source: 'loaded_search_cards', coverage: { status: 'partial' },
    missing: ['subsequent_pages'], cards_seen: 1, items: [{ position: 1, product_id: '100', title: 'Synthetic', url: 'https://item.taobao.com/item.htm?id=100',
      shop: 'Synthetic shop', sales_text: null, price: { raw: '¥ 9', label: '' } }] }, pagination: { current_page: 1 } };
  const report = buildCachedReport({ id: 'partial-search', kind: 'search_collection', status: 'waiting_connection', created_at: 'a', updated_at: 'b',
    operations: [{ status: 'pending', result: null, search_collection: { pages: [page] } }] });
  assert.equal(report.observations.length, 1);
  assert.deepEqual(report.observations[0].collection_coverage, {});
  assert.deepEqual(report.observations[0].missing, ['subsequent_pages']);
  assert.deepEqual(recordsOf(report, 'search_item').map(row => row.product_id), ['100']);
  assert.equal(recordsOf(report, 'search_sales').length, 0);
});

test('report-export writes a search report from the validated saved task without changing it', async t => {
  const { root, stateDirectory } = await savedSearch(t);
  const source = path.join(stateDirectory, 'tasks', 'saved-search.json');
  const before = await readFile(source);
  const exported = await exportReport({ stateDirectory, task: 'saved-search', format: 'markdown', output: path.join(root, 'search.md') });
  assert.equal(exported.status, 'report_exported');
  assert.match(await readFile(path.join(root, 'search.md'), 'utf8'), /search\\_item/);
  assert.deepEqual(await readFile(source), before);
});
