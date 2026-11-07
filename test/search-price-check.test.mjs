import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, runTask } from '../lib/tasks.mjs';
import { loadTask, withTaskStore } from '../lib/task-store.mjs';
import { searchTarget, validateSearch } from '../lib/search.mjs';
import { validateSearchPage, newSearchPagesState } from '../lib/search-pages.mjs';
import { validateSearchCollectionPage } from '../lib/search-page-range.mjs';
import { buildSearchPriceCheck, checkCachedSearchPrices } from '../lib/search-price-check.mjs';

const reviewedAt = '2026-10-10T08:00:00.000Z';

function raw(target, amounts, page = 1, total = 2) {
  return { state: 'observed', query: target.query, url: target.url.replace('&page=1&', `&page=${page}&`),
    cards_seen: amounts.length,
    items: amounts.map((amount, index) => ({ url: `https://item.taobao.com/item.htm?id=${index === 0 ? 100 : page * 100 + index}`,
      title: `Synthetic ${index}`, shop: 'Synthetic shop', sales_text: '',
      price: { raw: amount, amount_text: amount.replace(/起$/, ''), label: '' } })),
    pagination: { current_page: page, total_pages_displayed: total, next_disabled: page === total,
      previous_disabled: page === 1, selected_sort_label: '综合' } };
}

async function fixture(t, amounts = ['10', '20'], kind = 'search') {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping price check '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const target = searchTarget('Synthetic mouse');
  let page = 1, calls = 0, now = 1000;
  const bridge = { endpoint: 'http://127.0.0.1:19999', async requireConnected() { calls++; },
    async listTabs() { calls++; return [{ id: 41, url: target.url.replace('&page=1&', `&page=${page}&`) }]; },
    async readSearch() { calls++; const data = raw(target, amounts); delete data.pagination; return validateSearch(data, target); },
    async readSearchPage() { calls++; return validateSearchPage(raw(target, amounts, page), target, page !== 1); },
    async nextSearchPage() { calls++; page++; },
    async readSearchCollectionPage() { calls++; return validateSearchCollectionPage(raw(target, amounts, page), target, [1, 2]); },
    async nextSearchCollectionPage() { calls++; page++; },
  };
  const options = { stateDirectory, task: 'sample', search: target.query, tabId: 41, bridge,
    ...(kind === 'search' ? {} : { pages: 2 }) };
  await createTask(options);
  if (kind === 'search_pages') await withTaskStore(stateDirectory, 'sample', async store => {
    const task = await store.load(); task.kind = kind;
    delete task.operations[0].search_collection;
    task.operations[0].search_pages = newSearchPagesState(); await store.save(task);
  });
  const result = await runTask(options, { now: () => now, wait: async ms => { now += ms; } });
  assert.equal(result.status, 'complete');
  const saved = await loadTask(stateDirectory, 'sample');
  return { options, saved, calls: () => calls, source: path.join(stateDirectory, 'tasks/sample.json') };
}

test('checks exact ascending prices and inclusive bounds without changing source records', async t => {
  const f = await fixture(t, ['0.10', '0.20', '0.20']);
  const original = structuredClone(f.saved);
  const checked = buildSearchPriceCheck(f.saved, { sort: 'price-asc', minPrice: '0.1', maxPrice: '0.20', reviewedAt });
  assert.equal(checked.order_check.status, 'matched_sample');
  assert.equal(checked.range_check.status, 'matched_sample');
  assert.equal(checked.overall_status, 'matched_sample');
  assert.deepEqual(checked.records.map(row => row.comparable_price.cents), [10, 20, 20]);
  assert.deepEqual(checked.records.map(row => row.position), [1, 2, 3]);
  assert.equal(checked.records[0].observed_at, f.saved.operations[0].result.observed_at);
  assert.equal(checked.reviewed_at, reviewedAt);
  assert.equal(checked.platform_applied, false);
  assert.equal(checked.platform_sort_verified, false);
  assert.equal(checked.platform_filter_verified, false);
  assert.equal(checked.browser_accessed, false);
  assert.equal(checked.state_changed, false);
  assert.deepEqual(f.saved, original);
});

test('descending direction allows equal prices and preserves zero and large exact values', async t => {
  const f = await fixture(t, ['999999999.99', '1', '1.00', '0']);
  const checked = buildSearchPriceCheck(f.saved, { sort: 'price-desc', reviewedAt });
  assert.equal(checked.order_check.status, 'matched_sample');
  assert.equal(checked.range_check.status, 'not_requested');
  assert.deepEqual(checked.records.map(row => row.comparable_price.cents), [99999999999, 100, 100, 0]);
});

test('reports price inversions and outside bounds with original positions, without sorting', async t => {
  const f = await fixture(t, ['20', '10', '30']);
  const checked = buildSearchPriceCheck(f.saved, { sort: 'price-asc', minPrice: '11', maxPrice: '25', reviewedAt });
  assert.equal(checked.overall_status, 'contradicted_sample');
  assert.equal(checked.order_check.violations.length, 1);
  assert.equal(checked.order_check.violations[0].previous.position, 1);
  assert.equal(checked.order_check.violations[0].current.position, 2);
  assert.deepEqual(checked.range_check.outside.map(row => row.position), [2, 3]);
  assert.deepEqual(checked.records.map(row => row.price.amount), ['20', '10', '30']);
});

test('starting, ranged and unparsed prices remain unknown instead of becoming definite prices', async t => {
  const f = await fixture(t, ['10', '20起', '30-40', '询价', '50']);
  const checked = buildSearchPriceCheck(f.saved, { sort: 'price-asc', minPrice: '0', maxPrice: '100', reviewedAt });
  assert.equal(checked.overall_status, 'inconclusive_sample');
  assert.equal(checked.order_check.comparable_records, 2);
  assert.equal(checked.range_check.unknown_records, 3);
  assert.deepEqual(checked.records.filter(row => row.comparable_price === null).map(row => row.uncertainty),
    ['starting_from', 'range', 'unparsed']);
  assert.deepEqual(checked.records.map(row => row.range_status), ['within', 'unknown', 'unknown', 'unknown', 'within']);
});

test('known inversion across an unknown price still contradicts requested sample order', async t => {
  const f = await fixture(t, ['50', '20起', '10']);
  const checked = buildSearchPriceCheck(f.saved, { sort: 'price-asc', reviewedAt });
  assert.equal(checked.order_check.status, 'contradicted_sample');
  assert.equal(checked.order_check.unknown_records, 1);
  assert.equal(checked.order_check.violations[0].current.position, 3);
});

test('one known price cannot establish a direction, while its range can be assessed', async t => {
  const f = await fixture(t, ['10']);
  const checked = buildSearchPriceCheck(f.saved, { sort: 'price-asc', minPrice: '10', reviewedAt });
  assert.equal(checked.order_check.status, 'inconclusive_sample');
  assert.equal(checked.range_check.status, 'matched_sample');
});

test('range-only requests leave ordering unassessed and accept a one-sided maximum', async t => {
  const f = await fixture(t, ['20', '10']);
  const checked = buildSearchPriceCheck(f.saved, { maxPrice: '20', reviewedAt });
  assert.equal(checked.order_check.status, 'not_requested');
  assert.equal(checked.overall_status, 'matched_sample');
});

for (const kind of ['search_pages', 'search_collection']) {
  test(`${kind} checks confirmed pages in sequence and retains per-page provenance`, async t => {
    const f = await fixture(t, ['10', '20'], kind);
    const checked = buildSearchPriceCheck(f.saved, { sort: 'price-asc', reviewedAt });
    assert.deepEqual(checked.records.map(row => row.page), [1, 1, 2, 2]);
    assert.deepEqual(checked.records.map(row => row.position), [1, 2, 1, 2]);
    assert.equal(checked.records[0].product_id, checked.records[2].product_id);
    assert.equal(checked.source.observations.length, 2);
    assert.equal(checked.order_check.violations[0].previous.page, 1);
    assert.equal(checked.order_check.violations[0].current.page, 2);
    assert.equal(checked.coverage.status, 'partial');
    for (const observation of checked.source.observations) assert.equal(observation.coverage.sort_verified, false);
  });
}

test('unknown-only sample remains inconclusive for both requested checks', async t => {
  const f = await fixture(t, ['10起', '20-30']);
  const checked = buildSearchPriceCheck(f.saved, { sort: 'price-desc', maxPrice: '5', reviewedAt });
  assert.equal(checked.order_check.comparable_records, 0);
  assert.equal(checked.range_check.outside.length, 0);
  assert.equal(checked.overall_status, 'inconclusive_sample');
});

test('rejects modified prices, identity, and checkpoints before assessing them', async t => {
  const f = await fixture(t);
  for (const mutate of [task => { task.operations[0].result.items[0].price.amount = '0'; },
    task => { task.operations[0].result.items[0].position = 0; },
    task => { task.operations[0].result.observed_at = 'invalid'; }]) {
    const changed = structuredClone(f.saved); mutate(changed);
    assert.throws(() => buildSearchPriceCheck(changed, { sort: 'price-asc', reviewedAt }), { code: 'INVALID_CHECKPOINT' });
  }
});

test('rejects incomplete task without inspecting any unconfirmed candidates', async t => {
  const f = await fixture(t);
  await createTask({ ...f.options, task: 'pending' });
  const pending = await loadTask(f.options.stateDirectory, 'pending');
  assert.throws(() => buildSearchPriceCheck(pending, { sort: 'price-asc', reviewedAt }), { code: 'CACHE_NOT_COMPLETE' });
});

test('rejects unsupported task kinds and does not reinterpret sales or price probes', async t => {
  const f = await fixture(t);
  await createTask({ ...f.options, task: 'controls', inspectControls: true });
  const controls = await loadTask(f.options.stateDirectory, 'controls');
  assert.throws(() => buildSearchPriceCheck(controls, { sort: 'price-asc', reviewedAt }), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('invalid requests and review times fail clearly before returning a check', async t => {
  const f = await fixture(t);
  for (const options of [{}, { sort: 'sales' }, { minPrice: '20', maxPrice: '10' },
    { sort: 'price-asc', reviewedAt: 'bad' }, { sort: 'price-asc', query: 'other' }, null, []]) {
    assert.throws(() => buildSearchPriceCheck(f.saved, options), { code: 'INVALID_ARGUMENTS' });
  }
});

test('local loader validates saved bytes while performing zero browser calls and state writes', async t => {
  const f = await fixture(t);
  const before = await readFile(f.source), calls = f.calls();
  const result = await checkCachedSearchPrices({ stateDirectory: f.options.stateDirectory, task: 'sample',
    sort: 'price-asc', reviewedAt });
  assert.equal(result.status, 'cached_prices_checked');
  assert.equal(result.source.task, 'sample');
  assert.equal(f.calls(), calls);
  assert.deepEqual(await readFile(f.source), before);
  await writeFile(f.source, 'malformed checkpoint');
  await assert.rejects(checkCachedSearchPrices({ stateDirectory: f.options.stateDirectory, task: 'sample', sort: 'price-asc' }),
    { code: 'INVALID_CHECKPOINT' });
});

test('loader rejects invalid request before reading a missing cache', async () => {
  await assert.rejects(checkCachedSearchPrices({ stateDirectory: '/missing', task: 'missing', sort: 'bad' }), { code: 'INVALID_ARGUMENTS' });
  for (const options of [null, [], {}, { stateDirectory: '', task: 'sample', sort: 'price-asc' },
    { stateDirectory: '/missing', task: 'sample', sort: 'price-asc', bridge: {} }]) {
    await assert.rejects(checkCachedSearchPrices(options), { code: 'INVALID_ARGUMENTS' });
  }
});

test('legacy optional recovery fields stay absent in the caller checkpoint', async t => {
  const f = await fixture(t);
  delete f.saved.operations[0].recovery_kind;
  const before = structuredClone(f.saved);
  const checked = buildSearchPriceCheck(f.saved, { sort: 'price-asc', reviewedAt });
  assert.equal(checked.overall_status, 'matched_sample');
  assert.deepEqual(f.saved, before);
});

test('frozen valid legacy checkpoints are accepted without attempted normalization writes', async t => {
  const f = await fixture(t);
  delete f.saved.operations[0].recovery_kind;
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(f.saved);
  assert.equal(buildSearchPriceCheck(f.saved, { sort: 'price-asc', reviewedAt }).overall_status, 'matched_sample');
});

test('hidden and symbol options reject before cache IO', async () => {
  for (const extra of [{ [Symbol('bridge')]: {} }, Object.defineProperty({}, 'bridge', { value: {} })]) {
    const options = { stateDirectory: '/missing', task: 'sample', sort: 'price-asc' };
    Object.defineProperties(options, Object.getOwnPropertyDescriptors(extra));
    await assert.rejects(checkCachedSearchPrices(options), { code: 'INVALID_ARGUMENTS' });
  }
});
