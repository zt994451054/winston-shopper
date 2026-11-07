import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge, PACED_METHODS } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { failureCategory } from '../lib/task-policy.mjs';
import { runTask } from '../lib/tasks.mjs';
import { jdSearchScript } from '../lib/jd/search.mjs';
import { jdNextPageScript, validateJdNextPage } from '../lib/jd/search-pages.mjs';
import {
  jdPriceRangeConfirmScript, jdPriceRangeHoverScript, jdPriceRangePanelScript, jdSortClickScript, jdSortedSearchScript, validateJdPriceRangeConfirm,
  validateJdPriceRangeHover, validateJdPriceRangePanel, validateJdSortClick, validateJdSortedSearch,
} from '../lib/jd/search-sort.mjs';
import {
  directionShown, jdSearchSortResult, newJdSearchSortState, runJdSearchSortRead, validateJdSearchSortResult, validateJdSearchSortState,
} from '../lib/jd/search-sort-read.mjs';
import { jdSearchTarget } from '../lib/jd/targets.mjs';
import { jdSearchPage } from '../test-support/jd-search-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const QUERY = 'Synthetic mouse';
const TARGET = jdSearchTarget(QUERY);
// Icon file names seen on 2026-10-21; the flow only compares them, it never interprets them.
const ICONS = { comprehensiveOn: '8eb8645cb942affc.png', comprehensiveOff: 'd9815dcfaaa3da77.png', salesOff: '7f009b5b5d60b2a5.png',
  salesOn: '768e7ede703e335a.png', priceOff: '81f7897adff0fc6e.png', priceDesc: 'db0b7f451cb43530.png', priceAsc: 'ddf53912cae6970e.png' };
const cards = (prefix, grays) => grays.map((gray, index) => ({ sku: `${prefix}${index + 1}`, price: String(Math.max(Number(gray) - 1, 1)), other: `¥${gray}` }));
// Cards per sort and page, shaped like the 2026-10-21 reads: JD orders by the gray amount.
const CARDS = {
  comprehensive: [cards('100000', ['129', '89', '99', '45'])],
  sales: [cards('200000', ['49', '129', '89', '59']), cards('210000', ['39', '69', '99', '79'])],
  'price-desc': [cards('300000', ['979', '959', '959', '880', '870', '851']), cards('310000', ['850', '830', '799', '492', '492', '400'])],
  'price-asc': [cards('400000', ['39', '39', '40', '43', '46', '48']), cards('410000', ['49', '49', '50', '52', '55', '60'])],
  unclear: [cards('500000', ['979', '120', '880', '40', '870', '30'])],
};

function clock() {
  let time = 1_000_000;
  return { now: () => time, wait: async ms => { time += ms; } };
}

/**
 * Browser stand-in. The real card script runs on a synthetic page; the sort bar and pager are the raw shapes the page
 * scripts return. `firstPrice` is what the first 价格 click shows (JD: price-desc), `lag` reads still show the old sort,
 * `stuck` ignores sort clicks, `loseSortOnPage` drops back to 综合 when that page is reached.
 */
function fakeBrowser({ start = 'comprehensive', startPage = 1, firstPrice = 'price-desc', lag = 0, stuck = false, loseSortOnPage = null, total = 17, hooks = {} } = {}) {
  const calls = [];
  let sort = start, page = startPage, pending = null, lagLeft = 0, sortClicks = 0, pageClicks = 0, reads = 0;
  const activeSort = () => (sort.startsWith('price') ? 'price' : sort);
  const icons = () => ({ price: { 'price-desc': ICONS.priceDesc, 'price-asc': ICONS.priceAsc }[sort] ?? ICONS.priceOff,
    sales: sort === 'sales' ? ICONS.salesOn : ICONS.salesOff, comprehensive: sort === 'comprehensive' ? ICONS.comprehensiveOn : ICONS.comprehensiveOff });
  const raw = () => {
    const shown = sort === 'price-desc' && firstPrice === 'unclear' ? 'unclear' : sort;
    const group = CARDS[shown][page - 1] ?? CARDS[shown][0];
    return {
      sort_bar: { state: 'observed', comprehensive: { text: '综合', active: sort === 'comprehensive', icon: icons().comprehensive },
        sales: { active: sort === 'sales', icon: icons().sales }, price: { active: activeSort() === 'price', icon: icons().price },
        range: { text: '价格区间', active: false, icon: ICONS.comprehensiveOff } },
      pager: { state: 'observed', active_page: page, active_text: String(page), total_pages: total, total_text: `共${total}页`,
        previous: page === 1 ? 'disabled' : 'enabled', next: page === total ? 'disabled' : 'enabled' },
      search: jdSearchPage({ query: QUERY, cards: group }).evaluate(jdSearchScript(TARGET)),
    };
  };
  const refuse = (code, extra = {}) => Object.assign(new ShoppingError(code, 'x'), { actionNotDispatched: true }, extra);
  return {
    calls, sortClicks: () => sortClicks, pageClicks: () => pageClicks,
    async readJdSortedSearch(tabId, target) {
      if (hooks.beforeRead) hooks.beforeRead();
      if (pending && lagLeft-- <= 0) { ({ sort, page } = pending); pending = null; }
      calls.push(`read:${sort}:${page}`);
      reads += 1;
      const value = raw();
      const observedAt = new Date(Date.UTC(2026, 9, 22, 9, reads)).toISOString();
      validateJdSortedSearch(value, target, { observedAt });
      return { observed_at: observedAt, raw: value };
    },
    async clickJdSortTag(tabId, target, label, before) {
      calls.push(`sort:${label}`);
      if (hooks.refuse) throw hooks.refuse;
      if (before.active_sort !== activeSort() || before.price_icon !== icons().price) throw refuse('SEARCH_SORT_STATE_CHANGED');
      sortClicks += 1;
      const next = label === '销量' ? 'sales' : sort === 'price-desc' ? 'price-asc' : sort === 'price-asc' ? 'price-desc'
        : firstPrice === 'price-asc' ? 'price-asc' : 'price-desc';
      if (!stuck) { pending = { sort: next, page: 1 }; lagLeft = lag; }
      if (hooks.afterClick) hooks.afterClick();
      return { clicked: true };
    },
    async clickJdNextPage(tabId, target, fromPage) {
      calls.push(`next:${fromPage}`);
      if (page !== fromPage) throw refuse('SEARCH_PAGE_MISMATCH');
      if (page === total) throw refuse('SEARCH_LAST_PAGE', { lastPage: true });
      pageClicks += 1;
      pending = { sort: loseSortOnPage === fromPage + 1 ? 'comprehensive' : sort, page: fromPage + 1 };
      lagLeft = 0;
      return { clicked: true };
    },
  };
}

function operation(sort = 'price-asc', pages = 1) {
  return { tab_id: 88, target: TARGET, recovery_kind: null, search_sort_read: newJdSearchSortState(sort, pages) };
}

/** Run one visit; every commit checks the journal, and a stop must leave it valid. */
async function drive(browser, op = operation(), timer = clock()) {
  const commit = async () => { validateJdSearchSortState(op.search_sort_read, op.target); };
  try {
    const result = await runJdSearchSortRead({ bridge: browser, op, commit, now: timer.now, wait: timer.wait });
    validateJdSearchSortResult(result, op.target, op.search_sort_read);
    return { result, op };
  } catch (error) {
    validateJdSearchSortState(op.search_sort_read, op.target);
    error.op = op;
    throw error;
  }
}

test('价格 low to high over two pages: two 价格 clicks each confirmed on the sort bar, the cards and their order, then paging', async () => {
  const browser = fakeBrowser({ lag: 1 });
  const { result, op } = await drive(browser, operation('price-asc', 2));
  assert.deepEqual(browser.calls, ['read:comprehensive:1', 'sort:价格', 'read:comprehensive:1', 'read:price-desc:1', 'sort:价格', 'read:price-desc:1',
    'read:price-asc:1', 'read:price-asc:1', 'next:1', 'read:price-asc:2']);
  assert.deepEqual([browser.sortClicks(), browser.pageClicks()], [2, 1]);
  const journal = op.search_sort_read;
  assert.deepEqual(journal.steps.map(step => [step.label, step.before, step.acknowledgement, step.checks, step.confirmed]), [
    ['价格', { active_sort: 'comprehensive', price_icon: ICONS.priceOff }, 'clicked', 2, true],
    ['价格', { active_sort: 'price', price_icon: ICONS.priceDesc }, 'clicked', 2, true],
  ]);
  assert.deepEqual([journal.reads, journal.paging.reads, journal.paging.end], [5, 2, 'requested_pages_read']);
  assert.deepEqual([result.source, result.requested_sort, result.requested_pages, result.pages_read, result.end_reason, result.distinct_products],
    ['jd_search_sort', 'price-asc', 2, 2, 'requested_pages_read', 12]);
  assert.deepEqual(result.sort.steps.map(step => [step.label, step.active_after, step.price_icon_before, step.price_icon_after, step.direction_check.direction,
    step.direction_check.status]), [
    ['价格', 'price', ICONS.priceOff, ICONS.priceDesc, 'desc', 'ordered'],
    ['价格', 'price', ICONS.priceDesc, ICONS.priceAsc, 'asc', 'ordered'],
  ]);
  assert.equal(result.sort.basis, 'gray_amount_or_displayed_price');
  assert.deepEqual(result.pages.map(page => [page.page, page.active_sort, page.direction_check.status, page.pager.active_page, page.search.items.length]),
    [[1, 'price', 'ordered', 1, 6], [2, 'price', 'ordered', 2, 6]]);
  assert.deepEqual(result.coverage, { status: 'partial', scope: 'first_screen_loaded_cards_per_page', url_reflects_sort: false, url_reflects_page: false,
    sort_verified: true, sort_direction_verified: true, page_transition_verified: true, filters_verified: false, all_listed_pages_read: false, in_stock_only: true });
  assert.deepEqual(result.missing, ['cards_below_first_screen', 'subsequent_pages', 'verified_filters', 'verified_payable_prices']);
  assert.deepEqual(result, jdSearchSortResult(journal, op.target));
});

test('销量 needs one click and no order check; 价格 high to low needs one click; one page reads page 1 again after the sort', async () => {
  const sales = fakeBrowser();
  const { result } = await drive(sales, operation('sales'));
  assert.deepEqual(sales.calls, ['read:comprehensive:1', 'sort:销量', 'read:sales:1', 'read:sales:1']);
  assert.deepEqual([result.sort.basis, result.sort.steps[0].direction_check, result.pages[0].direction_check, result.coverage.sort_direction_verified],
    [null, null, null, null]);
  assert.ok(result.missing.includes('sales_ranking_basis'));
  const down = fakeBrowser();
  const { result: descending } = await drive(down, operation('price-desc'));
  assert.deepEqual([down.sortClicks(), descending.pages[0].direction_check.status, descending.pages[0].sort_bar.price.icon], [1, 'ordered', ICONS.priceDesc]);
});

test('a first 价格 click that sorts low to high, or shows no clear order, stops before any second click', async () => {
  const opposite = fakeBrowser({ firstPrice: 'price-asc' });
  const flipped = await drive(opposite, operation('price-desc')).catch(error => error);
  assert.equal(flipped.code, 'SEARCH_SORT_DIRECTION_MISMATCH');
  assert.equal(failureCategory(flipped.code), 'diagnostic');
  assert.equal(opposite.sortClicks(), 1);
  assert.equal(flipped.op.search_sort_read.steps[0].confirmed, false);

  const unclear = fakeBrowser({ firstPrice: 'unclear' });
  const stopped = await drive(unclear, operation('price-asc')).catch(error => error);
  assert.equal(stopped.code, 'SEARCH_SORT_DIRECTION_UNVERIFIED');
  assert.equal(unclear.sortClicks(), 1, 'the second 价格 click is never sent');
  // Rerunning stops the same way without another click.
  await assert.rejects(drive(unclear, stopped.op), { code: 'SEARCH_SORT_DIRECTION_UNVERIFIED' });
  assert.equal(unclear.sortClicks(), 1);
});

test('a tab not in the default view or not on page 1 is refused before any click', async () => {
  for (const [options, code] of [[{ start: 'sales' }, 'SEARCH_SORT_NOT_DEFAULT'], [{ startPage: 2 }, 'SEARCH_NOT_FIRST_PAGE']]) {
    const browser = fakeBrowser(options);
    const error = await drive(browser).catch(value => value);
    assert.equal(error.code, code);
    assert.deepEqual([browser.sortClicks(), error.op.search_sort_read.start], [0, null]);
  }
});

test('a sort that does not change after three checks stops the task, and a later run never clicks again', async () => {
  const browser = fakeBrowser({ stuck: true });
  const error = await drive(browser, operation('sales')).catch(value => value);
  assert.equal(error.code, 'SEARCH_SORT_NOT_CHANGED');
  assert.equal(failureCategory(error.code), 'diagnostic');
  assert.deepEqual(browser.calls, ['read:comprehensive:1', 'sort:销量', 'read:comprehensive:1', 'read:comprehensive:1', 'read:comprehensive:1']);
  await assert.rejects(drive(browser, error.op), { code: 'SEARCH_SORT_NOT_CHANGED' });
  assert.equal(browser.sortClicks(), 1);
});

test('a refused click releases its reservation; an unacknowledged or interrupted click is spent and never repeated', async () => {
  const refused = fakeBrowser({ hooks: { refuse: Object.assign(new ShoppingError('SEARCH_SORT_STATE_CHANGED', 'x'), { actionNotDispatched: true }) } });
  const op = operation('sales');
  await assert.rejects(drive(refused, op), { code: 'SEARCH_SORT_STATE_CHANGED' });
  assert.deepEqual([op.search_sort_read.steps.length, op.search_sort_read.start !== null], [0, true]);

  const timeout = fakeBrowser({ hooks: { afterClick: () => { throw new ShoppingError('BRIDGE_TIMEOUT', 'x'); } } });
  const { result } = await drive(timeout, operation('sales'));
  assert.deepEqual([result.sort.steps[0].acknowledgement, result.sort.steps[0].error, timeout.sortClicks()], ['uncertain', 'BRIDGE_TIMEOUT', 1]);

  // A process killed after the reservation: the click may have happened, so the resumed run only looks.
  const interrupted = fakeBrowser();
  const saved = operation('sales');
  const start = await interrupted.readJdSortedSearch(88, TARGET);
  await interrupted.clickJdSortTag(88, TARGET, '销量', { active_sort: 'comprehensive', price_icon: ICONS.priceOff });
  interrupted.calls.length = 0;
  Object.assign(saved.search_sort_read, { reads: 1, start,
    steps: [{ label: '销量', before: { active_sort: 'comprehensive', price_icon: ICONS.priceOff }, acknowledgement: null, error: null, checks: 0, confirmed: false, observed: null }] });
  const resumed = await drive(interrupted, saved);
  assert.deepEqual(interrupted.calls, ['read:sales:1', 'read:sales:1']);
  assert.deepEqual([resumed.result.sort.steps[0].acknowledgement, resumed.result.sort.steps[0].error], ['uncertain', 'READ_INTERRUPTED']);
});

test('a page that no longer shows the sort stops the paging; a login page pauses without using a check', async () => {
  const lost = fakeBrowser({ loseSortOnPage: 2 });
  const error = await drive(lost, operation('sales', 3)).catch(value => value);
  assert.equal(error.code, 'SEARCH_SORT_LOST');
  assert.equal(failureCategory(error.code), 'diagnostic');
  assert.deepEqual([lost.pageClicks(), error.op.search_sort_read.paging.pages.length], [1, 1]);

  const browser = fakeBrowser();
  let block = 0;
  const gated = { ...browser, async readJdSortedSearch(tabId, target) {
    if (block === 1) { block = 2; throw new ShoppingError('LOGIN_REQUIRED', 'x'); }
    return browser.readJdSortedSearch(tabId, target);
  }, async clickJdSortTag(...args) { const value = await browser.clickJdSortTag(...args); block = 1; return value; } };
  const op = operation('sales');
  const paused = await drive(gated, op).catch(value => value);
  assert.equal(paused.code, 'LOGIN_REQUIRED');
  assert.deepEqual([op.search_sort_read.steps[0].checks, op.search_sort_read.reads], [0, 2]);
  const { result } = await drive(gated, op);
  assert.deepEqual([result.sort.steps[0].checks, browser.sortClicks()], [1, 1]);
});

test('the sort, page count, read budget and clock are bounded; the direction rule accepts a few cards out of order', async () => {
  for (const [sort, pages] of [['price', 1], ['综合', 1], ['sales', 0], ['sales', 6], ['sales', 2.5]]) {
    assert.throws(() => newJdSearchSortState(sort, pages), { code: 'INVALID_ARGUMENTS' }, `${sort} ${pages}`);
  }
  const op = operation('sales');
  op.search_sort_read.reads = 7;
  await assert.rejects(drive(fakeBrowser(), op), { code: 'ACTION_OBSERVATION_LIMIT' });
  const waiting = operation('sales');
  waiting.search_sort_read.not_before = 10_000_000;
  await assert.rejects(drive(fakeBrowser(), waiting), { code: 'CLOCK_CHANGED' });
  const check = (status, inOrder, against) => ({ status, pairs: { in_order: inOrder, against, equal: 0 } });
  assert.deepEqual([directionShown(check('ordered', 5, 0)), directionShown(check('mixed', 8, 2)), directionShown(check('mixed', 7, 2)),
    directionShown(check('too_few', 2, 0)), directionShown(check('opposite', 0, 5))], [true, true, false, false, false]);
});

test('the journal refuses steps out of order, a forged start or step and a result it does not yield', async () => {
  const { result, op } = await drive(fakeBrowser(), operation('price-asc', 2));
  const good = op.search_sort_read;
  for (const change of [
    state => { state.sort = 'sales'; },
    state => { state.steps[0].label = '销量'; },
    state => { state.steps[1].before.price_icon = 'other.png'; },
    state => { state.steps[0].checks = 0; },
    state => { state.steps[0].confirmed = false; },
    state => { state.steps[0].observed = state.start; },
    state => { state.steps[1].observed = state.steps[0].observed; },
    state => { state.start.raw.sort_bar.comprehensive.active = false; state.start.raw.sort_bar.sales.active = true; },
    state => { state.steps.pop(); },
    state => { state.reads = 2; },
    state => { state.paging.pages[0].raw.sort_bar.price.active = false; state.paging.pages[0].raw.sort_bar.comprehensive.active = true; },
    state => { state.extra = 1; },
  ]) {
    const state = structuredClone(good);
    change(state);
    assert.throws(() => validateJdSearchSortState(state, TARGET), { code: 'INVALID_CHECKPOINT' }, change.toString());
  }
  const forged = structuredClone(result);
  forged.pages[0].search.items[0].title = 'Edited';
  assert.throws(() => validateJdSearchSortResult(forged, TARGET, good), { code: 'INVALID_CHECKPOINT' });
  const unfinished = structuredClone(good);
  unfinished.paging = newJdSearchSortState('price-asc', 2).paging;
  validateJdSearchSortState(unfinished, TARGET);
  assert.throws(() => validateJdSearchSortResult(result, TARGET, unfinished), { code: 'INVALID_CHECKPOINT' });
});

test('the sorted read is paced as a read and a sort click as a search load', () => {
  assert.deepEqual(PACED_METHODS.readJdSortedSearch, ['read']);
  assert.deepEqual(PACED_METHODS.clickJdSortTag, ['load', 'search']);
  // 确定 refilters the results like a sort click; opening, reading and typing into the dropdown stay on the page.
  assert.deepEqual([PACED_METHODS.confirmJdPriceRange, PACED_METHODS.hoverJdPriceRange, PACED_METHODS.fillJdPriceRange, PACED_METHODS.readJdPriceRangePanel],
    [['load', 'search'], ['action'], ['action'], ['read']]);
});

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

test('a JD sorted search runs through the bridge on one tab, saves a checked result and exports the clicks and pages', async t => {
  const page = jdSearchPage({ query: QUERY, pager: { pages: 17, active: 1 },
    sort: { active: 'comprehensive', cards: { comprehensive: CARDS.comprehensive[0], 'price-desc': CARDS['price-desc'][0], 'price-asc': CARDS['price-asc'] } } });
  const { endpoint, state } = await mockBridge(t, { handler: ({ req, res, body, state: shared }) => {
    res.setHeader('Content-Type', 'application/json');
    const send = data => res.end(JSON.stringify({ id: body.id, success: true, data }));
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return send({ tabs: shared.tabs });
    if (body.action === 'eval' && body.tabId === 88 && !body.script.includes('"tab_address"')) return send({ result: page.evaluate(body.script) });
    res.end(JSON.stringify({ id: body.id, success: false, error: 'unsupported' }));
  } });
  state.tabs = [{ id: 88, url: TARGET.url }];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd search sort '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const [extra, code] of [
    [['--search', QUERY, '--tab', '88', '--sort', 'price'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--tab', '88', '--sort', 'sales', '--pages', '6'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--sort', 'sales'], 'INVALID_ARGUMENTS'],
    [['--orders', '--tab', '88', '--sort', 'sales'], 'UNSUPPORTED_PLATFORM'],
  ]) {
    assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, code, extra.join(' '));
  }
  const created = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-sort', '--search', QUERY, '--tab', '88', '--sort', 'price-asc', '--pages', '2']);
  assert.deepEqual([created.code, created.value.task_kind, created.value.platform], [0, 'jd_search_sort', 'jd']);

  const ran = await runTask({ stateDirectory: directory, task: 'jd-sort', bridge: new BrowserBridge(endpoint) }, clock());
  assert.equal(ran.status, 'complete', JSON.stringify(ran.operations[0].error));
  const operation = ran.operations[0];
  assert.deepEqual([operation.query, operation.requested_sort, operation.requested_pages, operation.sort_clicks_reserved, operation.actions_reserved,
    operation.pages_observed], [QUERY, 'price-asc', 2, 2, 3, 2]);
  assert.deepEqual(operation.result.pages.map(item => item.search.items.map(card => card.product_id)),
    [CARDS['price-asc'][0].map(card => card.sku), CARDS['price-asc'][1].map(card => card.sku)]);
  assert.deepEqual([page.sortClicks(), page.clicks(), page.sortState()], [2, 1, 'price-asc']);
  const evals = state.commands.filter(command => command.action === 'eval' && !command.script.includes('"tab_address"'));
  assert.deepEqual(evals.map(command => /^\(\{ sort_bar: \(function (\w+)|^\(function (\w+)/.exec(command.script)?.slice(1).find(Boolean)),
    ['collectJdSortBar', 'clickJdSortTag', 'collectJdSortBar', 'clickJdSortTag', 'collectJdSortBar', 'collectJdSortBar', 'clickJdNextPage', 'collectJdSortBar']);
  assert.deepEqual(state.commands.filter(command => !['tab_list', 'eval'].includes(command.action)), [], 'nothing is opened, closed or navigated');

  const status = await run(['task-status', '--state-dir', directory, '--task', 'jd-sort']);
  assert.deepEqual(status.value.operations[0].result, operation.result);
  const csv = path.join(directory, '..', `jd-sort-${path.basename(directory)}.csv`);
  const markdown = path.join(directory, '..', `jd-sort-${path.basename(directory)}.md`);
  t.after(() => Promise.all([rm(markdown, { force: true }), rm(csv, { force: true })]));
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-sort', '--format', 'csv', '--output', csv])).code, 0);
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-sort', '--format', 'markdown', '--output', markdown])).code, 0);
  const rows = await readFile(csv, 'utf8');
  for (const pattern of [
    /"search_sort_click",[^\n]*"价格","active_after=price","click=clicked; checks=1; error=null; price_icon=81f7897adff0fc6e.png->db0b7f451cb43530.png; direction=desc; status=ordered/,
    /"search_sort_click",[^\n]*"价格","active_after=price","click=clicked; checks=1; error=null; price_icon=db0b7f451cb43530.png->ddf53912cae6970e.png; direction=asc; status=ordered/,
    /"search_sort_state",[^\n]*"price","comprehensive=false; sales=false; price=true; price_icon=ddf53912cae6970e.png","direction=asc; status=ordered/,
    /"search_pagination",[^\n]*"pager","active_page=2; total=共17页; previous=enabled; next=enabled","from_page=1; click=clicked; checks=1; error=null"/,
    /"collection_coverage",[^\n]*"url_reflects_sort","false"/,
    /"collection_coverage",[^\n]*"sort_direction_verified","true"/,
    /"missing_field",[^\n]*"collection.subsequent_pages"/,
  ]) {
    assert.match(rows, pattern);
  }
  assert.equal((rows.match(/"search_sort_click"/g) ?? []).length, 2, 'sort clicks are listed once, on page 1');
  assert.match(await readFile(markdown, 'utf8'), /jd\\_search\\_sort/);

  const file = path.join(directory, 'tasks', 'jd-sort.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.operations[0].result.sort.steps[0].checks = 2;
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'jd-sort'])).value.error.code, 'INVALID_CHECKPOINT');
});

// Price range (2026-10-22): the comprehensive first screen has cards outside 60-90; after 确定 every card lies inside it.
const RANGE_CARDS = {
  comprehensive: cards('600000', ['89', '64.8', '65', '79.9', '89.1', '69']),
  'price-desc': cards('610000', ['89.1', '89', '85', '79.9', '69', '65']),
  sales: [cards('650000', ['69', '89', '65', '79.9', '72', '88']), cards('660000', ['61', '75', '89', '80', '70', '66'])],
  'price-asc': [cards('620000', ['60', '61', '63', '64.8', '65', '66']), cards('630000', ['67', '69', '72', '79', '85', '89'])],
};

/** Browser stand-in that runs the real page scripts on the synthetic page; fill types as the extension's fill command does. */
function fixtureBrowser(page) {
  const calls = [];
  let reads = 0;
  const run = script => page.evaluate(script);
  return {
    calls,
    async readJdSortedSearch(tabId, target) {
      calls.push('read');
      reads += 1;
      const raw = run(jdSortedSearchScript(target));
      const observedAt = new Date(Date.UTC(2026, 9, 22, 10, reads)).toISOString();
      validateJdSortedSearch(raw, target, { observedAt });
      return { observed_at: observedAt, raw };
    },
    async readJdPriceRangePanel(tabId, target) { calls.push('panel'); return validateJdPriceRangePanel(run(jdPriceRangePanelScript(target))); },
    async hoverJdPriceRange(tabId, target) { calls.push('hover'); return validateJdPriceRangeHover(run(jdPriceRangeHoverScript(target))); },
    async fillJdPriceRange(tabId, target, minimum, maximum) {
      calls.push('fill');
      if (validateJdPriceRangePanel(run(jdPriceRangePanelScript(target))).inputs.some(input => input.value !== '')) {
        throw Object.assign(new ShoppingError('SEARCH_PRICE_RANGE_NOT_EMPTY', 'x'), { actionNotDispatched: true });
      }
      page.fill('minimum', String(minimum));
      page.fill('maximum', String(maximum));
      return { filled: true };
    },
    async confirmJdPriceRange(tabId, target, minimum, maximum) { calls.push('confirm'); return validateJdPriceRangeConfirm(run(jdPriceRangeConfirmScript(target, minimum, maximum))); },
    async clickJdSortTag(tabId, target, label, before) { calls.push(`sort:${label}`); return validateJdSortClick(run(jdSortClickScript(target, label, before))); },
    async clickJdNextPage(tabId, target, fromPage) { calls.push(`next:${fromPage}`); return validateJdNextPage(run(jdNextPageScript(target, fromPage))); },
  };
}

function rangePage(sort = {}) {
  return jdSearchPage({ query: QUERY, pager: { pages: 17, active: 1 },
    sort: { active: 'comprehensive', cards: { comprehensive: CARDS.comprehensive[0], 'price-desc': CARDS['price-desc'][0], 'price-asc': CARDS['price-asc'] },
      rangeCards: RANGE_CARDS, ...sort } });
}

function rangeOperation(sort = 'price-asc', pages = 1, range = { minimum: 60, maximum: 90 }) {
  return { tab_id: 88, target: TARGET, recovery_kind: null, search_sort_read: newJdSearchSortState(sort, pages, range) };
}

test('a price range then 价格 low to high over two pages: one 确定 confirmed on the button and the cards, then the sort and the pages keep it', async () => {
  const page = rangePage();
  const browser = fixtureBrowser(page);
  const { result, op } = await drive(browser, rangeOperation('price-asc', 2));
  assert.deepEqual(browser.calls, ['read', 'hover', 'panel', 'fill', 'panel', 'confirm', 'read', 'sort:价格', 'read', 'sort:价格', 'read', 'read', 'next:1', 'read']);
  assert.deepEqual([page.confirmClicks(), page.sortClicks(), page.clicks()], [1, 2, 1]);
  const range = op.search_sort_read.price_range;
  assert.deepEqual([op.search_sort_read.schema_version, range.reserved, range.acknowledgement, range.checks, range.confirmed], [2, true, 'clicked', 1, true]);
  assert.deepEqual([result.schema_version, result.requested_sort, result.price_range], [2, 'price-asc', { minimum: 60, maximum: 90, acknowledgement: 'clicked', error: null,
    checks: 1, label_text: '价格区间(¥60-90)', check: { basis: 'gray_amount_or_displayed_price', minimum: 60, maximum: 90, cards_checked: 6, outside: 0,
      sponsored_skipped: 0, unparsed_skipped: 0 } }]);
  assert.deepEqual(result.sort.steps.map(step => [step.price_icon_before, step.price_icon_after, step.direction_check.status]),
    [[ICONS.priceOff, ICONS.priceDesc, 'ordered'], [ICONS.priceDesc, ICONS.priceAsc, 'ordered']]);
  assert.deepEqual(result.pages.map(item => [item.page, item.sort_bar.range.text, item.price_range_check.outside, item.direction_check.status]),
    [[1, '价格区间(¥60-90)', 0, 'ordered'], [2, '价格区间(¥60-90)', 0, 'ordered']]);
  assert.deepEqual(result.coverage, { status: 'partial', scope: 'first_screen_loaded_cards_per_page', url_reflects_sort: false, url_reflects_page: false,
    sort_verified: true, sort_direction_verified: true, price_range_verified: true, page_transition_verified: true, filters_verified: false,
    all_listed_pages_read: false, in_stock_only: true });
  assert.deepEqual(result, jdSearchSortResult(op.search_sort_read, TARGET));
});

test('a price range alone needs no sort click; bounds already typed are not typed again', async () => {
  const page = rangePage();
  const { result } = await drive(fixtureBrowser(page), rangeOperation(null, 1));
  assert.deepEqual([result.requested_sort, result.sort.steps, result.sort.basis, result.coverage.sort_verified, result.coverage.sort_direction_verified,
    result.pages[0].direction_check, page.sortClicks()], [null, [], null, null, null, null, 0]);
  assert.ok(!result.missing.includes('sales_ranking_basis'));
  const typed = rangePage();
  typed.evaluate(jdPriceRangeHoverScript(TARGET));
  typed.fill('minimum', '60'); typed.fill('maximum', '90');
  const browser = fixtureBrowser(typed);
  await drive(browser, rangeOperation('sales', 1));
  assert.deepEqual(browser.calls.slice(0, 6), ['read', 'hover', 'panel', 'confirm', 'read', 'sort:销量']);
});

test('the range stops without 确定 when the inputs hold other text, a range is already set or 确定 changes nothing', async () => {
  const other = rangePage();
  other.evaluate(jdPriceRangeHoverScript(TARGET));
  other.fill('minimum', '10');
  const filled = await drive(fixtureBrowser(other), rangeOperation()).catch(error => error);
  assert.deepEqual([filled.code, other.confirmClicks(), filled.op.search_sort_read.price_range.reserved], ['SEARCH_PRICE_RANGE_NOT_EMPTY', 0, false]);

  const set = rangePage({ range: { minimum: 60, maximum: 90 } });
  assert.equal((await drive(fixtureBrowser(set), rangeOperation()).catch(error => error)).code, 'SEARCH_SORT_NOT_DEFAULT');

  const ignored = rangePage({ ignoreConfirm: true });
  const browser = fixtureBrowser(ignored);
  const stuck = await drive(browser, rangeOperation()).catch(error => error);
  assert.deepEqual([stuck.code, failureCategory(stuck.code), ignored.confirmClicks(), stuck.op.search_sort_read.price_range.checks],
    ['SEARCH_PRICE_RANGE_NOT_CHANGED', 'diagnostic', 1, 3]);
  await assert.rejects(drive(browser, stuck.op), { code: 'SEARCH_PRICE_RANGE_NOT_CHANGED' });
  assert.equal(ignored.confirmClicks(), 1, 'a later run never clicks 确定 again');
});

test('cards outside the range stop the task; an interrupted 确定 is spent and only looked at', async () => {
  const outside = rangePage({ rangeCards: { ...RANGE_CARDS, comprehensive: cards('640000', ['89', '64.8', '95', '79.9', '89.1', '69']) } });
  const error = await drive(fixtureBrowser(outside), rangeOperation()).catch(value => value);
  assert.deepEqual([error.code, failureCategory(error.code), outside.sortClicks()], ['SEARCH_PRICE_RANGE_NOT_APPLIED', 'diagnostic', 0]);

  const page = rangePage();
  const op = rangeOperation('sales', 1);
  const browser = fixtureBrowser(page);
  // A process killed after the reservation: 确定 may have been clicked, so the resumed run only looks.
  const start = await browser.readJdSortedSearch(88, TARGET);
  page.evaluate(jdPriceRangeHoverScript(TARGET));
  page.fill('minimum', '60'); page.fill('maximum', '90');
  page.evaluate(jdPriceRangeConfirmScript(TARGET, 60, 90));
  Object.assign(op.search_sort_read, { reads: 3, start });
  op.search_sort_read.price_range.reserved = true;
  browser.calls.length = 0;
  const { result } = await drive(browser, op);
  assert.deepEqual(browser.calls.slice(0, 2), ['read', 'sort:销量']);
  assert.deepEqual([result.price_range.acknowledgement, result.price_range.error, page.confirmClicks()], ['uncertain', 'READ_INTERRUPTED', 1]);
});

test('a range journal refuses a forged range, a sort before the range and a page without the range', async () => {
  assert.throws(() => newJdSearchSortState(null, 1), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => newJdSearchSortState('sales', 1, { minimum: 90, maximum: 60 }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(newJdSearchSortState('sales', 1).schema_version, 1, 'a task without a range keeps the first journal version');
  const { op } = await drive(fixtureBrowser(rangePage()), rangeOperation('sales', 2));
  const good = op.search_sort_read;
  for (const change of [
    state => { state.price_range.maximum = 95; },
    state => { state.price_range.confirmed = false; },
    state => { state.price_range.observed = state.start; },
    state => { state.price_range.reserved = false; },
    state => { delete state.price_range; },
    state => { state.schema_version = 1; },
    state => { state.paging.pages[1].raw.sort_bar.range.active = false; },
    state => { state.price_range.observed.raw.sort_bar.range.text = '价格区间(¥60-99)'; },
  ]) {
    const state = structuredClone(good);
    change(state);
    assert.throws(() => validateJdSearchSortState(state, TARGET), { code: 'INVALID_CHECKPOINT' }, change.toString());
  }
});

test('a JD price range and sort task runs through the bridge, types through the extension fill command and exports the range', async t => {
  const page = rangePage();
  const { endpoint, state } = await mockBridge(t, { handler: ({ req, res, body, state: shared }) => {
    res.setHeader('Content-Type', 'application/json');
    const send = data => res.end(JSON.stringify({ id: body.id, success: true, data }));
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return send({ tabs: shared.tabs });
    if (body.action === 'eval' && body.tabId === 88 && !body.script.includes('"tab_address"')) return send({ result: page.evaluate(body.script) });
    const placeholder = /^input\[placeholder="(最低价|最高价)"\]$/.exec(body.selector ?? '')?.[1];
    if (body.action === 'snapshot' && body.tabId === 88 && placeholder) return send({ snapshotData: { refs: { [placeholder === '最低价' ? 'e1' : 'e2']: { role: 'textbox', name: placeholder } } } });
    if (body.action === 'fill' && body.tabId === 88 && ['e1', 'e2'].includes(body.ref)) {
      page.fill(body.ref === 'e1' ? 'minimum' : 'maximum', body.text);
      return send({ role: 'textbox', name: body.ref === 'e1' ? '最低价' : '最高价', filledText: body.text });
    }
    res.end(JSON.stringify({ id: body.id, success: false, error: 'unsupported' }));
  } });
  state.tabs = [{ id: 88, url: TARGET.url }];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd search range '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const [extra, code] of [
    [['--search', QUERY, '--tab', '88', '--min-price', '60'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--tab', '88', '--min-price', '60.5', '--max-price', '90'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--tab', '88', '--min-price', '90', '--max-price', '60'], 'INVALID_ARGUMENTS'],
    [['--cart', '--tab', '88', '--min-price', '60', '--max-price', '90'], 'UNSUPPORTED_PLATFORM'],
  ]) {
    assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, code, extra.join(' '));
  }
  const created = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-range', '--search', QUERY, '--tab', '88', '--min-price', '60', '--max-price', '90', '--sort', 'price-asc']);
  assert.deepEqual([created.code, created.value.task_kind], [0, 'jd_search_sort']);
  const ran = await runTask({ stateDirectory: directory, task: 'jd-range', bridge: new BrowserBridge(endpoint) }, clock());
  assert.equal(ran.status, 'complete', JSON.stringify(ran.operations[0].error));
  const operation = ran.operations[0];
  assert.deepEqual([operation.requested_price_range, operation.price_range_confirm_reserved, operation.sort_clicks_reserved, operation.actions_reserved],
    [{ minimum: 60, maximum: 90 }, true, 2, 3]);
  assert.deepEqual(state.commands.filter(command => ['snapshot', 'fill'].includes(command.action)).map(command => [command.action, command.selector ?? command.text]),
    [['snapshot', 'input[placeholder="最低价"]'], ['fill', '60'], ['snapshot', 'input[placeholder="最高价"]'], ['fill', '90']]);
  assert.deepEqual([page.confirmClicks(), page.sortClicks(), page.range()], [1, 2, { minimum: 60, maximum: 90 }]);
  const csv = path.join(directory, '..', `jd-range-${path.basename(directory)}.csv`);
  t.after(() => rm(csv, { force: true }));
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-range', '--format', 'csv', '--output', csv])).code, 0);
  const rows = await readFile(csv, 'utf8');
  for (const pattern of [
    /"search_price_range",[^\n]*"60-90","价格区间\(¥60-90\)","click=clicked; checks=1; error=null; checked=6; outside=0; sponsored_skipped=0; unparsed_skipped=0"/,
    /"search_price_range_check",[^\n]*"60-90","range_button=价格区间\(¥60-90\)","checked=6; outside=0/,
    /"collection_coverage",[^\n]*"price_range_verified","true"/,
  ]) {
    assert.match(rows, pattern);
  }
});
