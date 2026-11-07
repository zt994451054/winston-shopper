import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { searchTarget } from '../lib/search.mjs';
import { createSearchPriceRequest } from '../lib/search-price-request.mjs';
import { searchPriceScript, validateSearchPriceObservation, pickPriceDirectionScript, confirmPriceRangeScript,
  newSearchPriceState, runSearchPrice, nextPricePageScript, validateNextPriceAcknowledgement, pickSourceScript, pickFilterScript } from '../lib/search-price.mjs';
import { buildCachedReport, renderCachedReport } from '../lib/cached-report.mjs';
import { priceSearchPage } from '../test-support/search-price-fixture.mjs';

const root = searchTarget('Synthetic mouse');

/** Produce a real search_price result by running the production runner against the synthetic page. */
async function priceResult({ sort = 'price-desc', minPrice = '40', maxPrice = '60', pages = 1, conditions } = {}) {
  const page = priceSearchPage();
  const run = script => JSON.parse(JSON.stringify(vm.runInNewContext(script, page.context)));
  const bridge = {
    readSearchPrice: async (tab, target, number = 1, options = {}) => validateSearchPriceObservation(run(searchPriceScript(target, number, options)), target, number, options),
    nextPricePage: async (tab, target, from) => validateNextPriceAcknowledgement(run(nextPricePageScript(target, from))),
    pickSearchSource: async (tab, target, source) => { run(pickSourceScript(target, source)); return { clicked: true }; },
    pickSearchFilter: async (tab, target, label, source) => { run(pickFilterScript(target, label, source)); return { clicked: true }; },
    hoverPriceTab: async (tab, target, label) => { page.hover(label); return { hovered: true }; },
    pickPriceDirection: async (tab, target, label, source) => { run(pickPriceDirectionScript(target, label, source)); return { clicked: true }; },
    fillPriceRange: async (tab, target, fields) => { for (const { field, text } of fields) page.fill(field, text); return { filled: true }; },
    confirmPriceRange: async (tab, target) => { run(confirmPriceRangeScript(target)); return { clicked: true }; },
  };
  const request = createSearchPriceRequest({ query: root.query, sort, minPrice, maxPrice });
  const op = { tab_id: 41, target: root, recovery_kind: null, search_price: newSearchPriceState(request, undefined, { pages, conditions }) };
  let now = 0;
  return runSearchPrice({ bridge, op, commit: async () => {}, now: () => now, wait: async ms => { now += ms; } });
}

test('a price task report keeps the applied conditions, the platform order, the local displayed-price order and the checks', async () => {
  const result = await priceResult();
  const task = { id: 'price-report', kind: 'search_price', status: 'complete', created_at: '2026-10-12T00:00:00Z',
    updated_at: '2026-10-12T00:10:00Z', operations: [{ status: 'succeeded', result }] };
  const report = buildCachedReport(task);
  assert.equal(report.observations[0].observed_at, result.after.search.observed_at);
  assert.equal(report.observations[0].coverage.platform_ui_applied, true);
  assert.equal(report.observations[0].coverage.sort_verified, false);
  const rows = type => report.records.filter(row => row.record_type === type);
  assert.deepEqual(rows('price_condition').map(row => [row.label, row.text, row.qualifier]),
    [['price_sort', 'price-desc', 'marked=从高到低'], ['price_range', '40.00-60.00', 'reopened=40/60']]);
  assert.deepEqual(rows('search_item').map(row => row.item_position), result.after.search.items.map(item => item.position));
  assert.equal(rows('search_item')[0].product_id, result.after.search.items[0].product_id);
  assert.match(rows('search_item')[0].qualifier, /^range=(within|outside|unknown)$/);
  assert.deepEqual(rows('local_price_order').map(row => row.item_position), result.displayed_price_order.records.map(row => row.local_rank));
  assert.equal(rows('local_price_order')[0].qualifier, `platform_position=${result.displayed_price_order.records[0].platform_position}; not_platform_order`);
  assert.deepEqual(rows('price_check').map(row => [row.label, row.text]),
    [['order_check', result.displayed_price_check.order_check.status], ['range_check', result.displayed_price_check.range_check.status]]);
  const csv = renderCachedReport(report, 'csv'), markdown = renderCachedReport(report, 'markdown');
  assert.match(csv, /price_condition/); assert.match(markdown, /local\\_price\\_order/);
});

test('a multi-page price report keeps one observation per page with its own time, plus paging and page-aware local order', async () => {
  const result = await priceResult({ sort: 'price-asc', minPrice: null, maxPrice: null, pages: 3 });
  const report = buildCachedReport({ id: 'paged-price', kind: 'search_price', status: 'complete', created_at: '2026-10-13T00:00:00Z',
    updated_at: '2026-10-13T00:10:00Z', operations: [{ status: 'succeeded', result }] });
  assert.deepEqual(report.observations.map(row => [row.batch_position, row.observed_at]),
    [[1, result.after.search.observed_at], ...result.pages.map((page, index) => [index + 2, page.search.observed_at])]);
  const items = position => report.records.filter(row => row.record_type === 'search_item' && row.observation_position === position);
  assert.deepEqual(items(2).map(row => row.product_id), result.pages[0].search.items.map(item => item.product_id));
  assert.equal(report.records.filter(row => row.record_type === 'price_paging').length, 1);
  assert.match(report.records.find(row => row.record_type === 'price_paging').qualifier, /^total_pages=8; last_page=3; marked=从低到高; reopened=none$/);
  const pagesInOrder = report.records.filter(row => row.record_type === 'local_price_order').map(row => row.qualifier.match(/^platform_page=(\d)/)[1]);
  assert.deepEqual([...new Set(pagesInOrder)].sort(), ['1', '2', '3']);
  assert.ok(report.records.filter(row => ['price_condition', 'price_check', 'local_price_order'].includes(row.record_type)).every(row => row.observation_position === 1));
});

test('a report of a 天猫 + 包邮 price task lists both conditions before the price sort', async () => {
  const result = await priceResult({ sort: 'price-asc', minPrice: null, maxPrice: null, conditions: { source: 'tmall', filters: ['包邮'] } });
  const report = buildCachedReport({ id: 'conditions', kind: 'search_price', status: 'complete', created_at: '2026-10-13T00:00:00Z',
    updated_at: '2026-10-13T00:10:00Z', operations: [{ status: 'succeeded', result }] });
  assert.deepEqual(report.records.filter(row => row.record_type === 'price_condition').map(row => [row.label, row.text, row.qualifier]),
    [['source', 'tmall', 'marked=天猫; tab=mall'], ['filter', '包邮', 'marked=selected_class'], ['price_sort', 'price-asc', 'marked=从低到高']]);
  assert.match(report.observations[0].url, /&tab=mall$/);
});
