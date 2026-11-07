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
import { validateJdSearchPage } from '../lib/jd/search-pages.mjs';
import {
  jdSearchPagesResult, newJdSearchPagesState, runJdSearchPagesRead, validateJdSearchPagesResult, validateJdSearchPagesState,
} from '../lib/jd/search-pages-read.mjs';
import { jdSearchTarget } from '../lib/jd/targets.mjs';
import { jdSearchPage } from '../test-support/jd-search-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const QUERY = 'Synthetic mouse';
const TARGET = jdSearchTarget(QUERY);
// Three cards per synthetic page; page 2 repeats one product from page 1.
const PAGE_CARDS = {
  1: [{ sku: '1000001' }, { sku: '1000002' }, { sku: '1000003' }],
  2: [{ sku: '2000001' }, { sku: '1000002' }, { sku: '2000003' }],
  3: [{ sku: '3000001' }, { sku: '3000002' }, { sku: '3000003' }],
  4: [{ sku: '4000001' }],
};

function clock() {
  let time = 1_000_000;
  return { now: () => time, wait: async ms => { time += ms; } };
}

const pager = (page, total) => ({ state: 'observed', active_page: page, active_text: String(page), total_pages: total, total_text: `共${total}页`,
  previous: page === 1 ? 'disabled' : 'enabled', next: page === total ? 'disabled' : 'enabled' });

/**
 * Browser stand-in. The real card script runs on a synthetic page and the pager is the raw shape the page script returns.
 * `lag` reads still show the old page after a click; `stuck` never changes it; `jumpTo` shows another page number.
 */
function fakeBrowser({ total = 17, start = 1, lag = 0, stuck = false, jumpTo = null, hooks = {} } = {}) {
  const calls = [];
  let shown = start, pendingPage = null, lagLeft = 0, clicks = 0, reads = 0;
  return {
    calls, clicks: () => clicks,
    async readJdSearchPage(tabId, target) {
      if (hooks.beforeRead) hooks.beforeRead();
      if (pendingPage !== null && lagLeft-- <= 0) { shown = pendingPage; pendingPage = null; }
      calls.push(`read:${shown}`);
      const search = jdSearchPage({ query: target.query, cards: PAGE_CARDS[shown] ?? PAGE_CARDS[1] }).evaluate(jdSearchScript(target));
      const raw = { pager: pager(shown, total), search };
      reads += 1;
      const observedAt = new Date(Date.UTC(2026, 9, 21, 8, reads)).toISOString();
      validateJdSearchPage(raw, target, { observedAt });
      return { observed_at: observedAt, raw };
    },
    async clickJdNextPage(tabId, target, fromPage) {
      calls.push(`click:${fromPage}`);
      const refuse = (code, extra = {}) => Object.assign(new ShoppingError(code, 'x'), { actionNotDispatched: true }, extra);
      if (hooks.refuse) throw hooks.refuse;
      if (shown !== fromPage) throw refuse('SEARCH_PAGE_MISMATCH');
      if (shown === total) throw refuse('SEARCH_LAST_PAGE', { lastPage: true });
      clicks += 1;
      if (!stuck) { pendingPage = jumpTo ?? fromPage + 1; lagLeft = lag; }
      if (hooks.afterClick) hooks.afterClick();
      return { clicked: true };
    },
  };
}

function operation(pages = 3) {
  return { tab_id: 88, target: TARGET, recovery_kind: null, search_pages_read: newJdSearchPagesState(pages) };
}

/** Run one visit; every commit checks the journal, and a stop must leave it valid. */
async function drive(browser, op = operation(), timer = clock()) {
  const commit = async () => { validateJdSearchPagesState(op.search_pages_read, op.target); };
  try {
    const result = await runJdSearchPagesRead({ bridge: browser, op, commit, now: timer.now, wait: timer.wait });
    validateJdSearchPagesResult(result, op.target, op.search_pages_read);
    return { result, op };
  } catch (error) {
    validateJdSearchPagesState(op.search_pages_read, op.target);
    error.op = op;
    throw error;
  }
}

test('three pages: read page 1, then click 下一页 once per page and read each page after its pager and cards changed', async () => {
  const browser = fakeBrowser({ lag: 1 });
  const { result, op } = await drive(browser);
  assert.deepEqual(browser.calls, ['read:1', 'click:1', 'read:1', 'read:2', 'click:2', 'read:2', 'read:3']);
  assert.equal(browser.clicks(), 2);
  const journal = op.search_pages_read;
  assert.deepEqual([journal.reads, journal.pages.length, journal.end], [5, 3, 'requested_pages_read']);
  assert.deepEqual(journal.transitions.map(step => [step.from_page, step.acknowledgement, step.checks, step.confirmed]),
    [[1, 'clicked', 2, true], [2, 'clicked', 2, true]]);
  assert.deepEqual([result.schema_version, result.platform, result.query, result.source, result.requested_pages, result.pages_read, result.end_reason,
    result.total_pages_text, result.total_pages, result.distinct_products, result.cross_page_duplicates_omitted],
  [1, 'jd', QUERY, 'jd_search_pages', 3, 3, 'requested_pages_read', '共17页', 17, 8, 1]);
  assert.deepEqual(result.pages.map(page => [page.page, page.pager.active_page, page.search.page, page.search.items.map(item => item.product_id),
    page.search.cross_page_duplicates_omitted]), [
    [1, 1, 1, ['1000001', '1000002', '1000003'], 0],
    [2, 2, 2, ['2000001', '2000003'], 1],
    [3, 3, 3, ['3000001', '3000002', '3000003'], 0],
  ]);
  // Positions stay the platform's own order on that page.
  assert.deepEqual(result.pages[1].search.items.map(item => item.position), [1, 3]);
  assert.deepEqual(result.pages.map(page => page.transition), [null,
    { from_page: 1, acknowledgement: 'clicked', error: null, checks: 2 }, { from_page: 2, acknowledgement: 'clicked', error: null, checks: 2 }]);
  assert.equal(result.pages.every(page => !page.search.missing.includes('subsequent_pages')), true);
  assert.deepEqual(result.coverage, { status: 'partial', scope: 'first_screen_loaded_cards_per_page', url_reflects_page: false,
    page_transition_verified: true, sort_verified: false, filters_verified: false, all_listed_pages_read: false, in_stock_only: true });
  assert.deepEqual(result.missing, ['cards_below_first_screen', 'subsequent_pages', 'verified_sort_and_filters', 'verified_payable_prices']);
  assert.equal(result.observed_at, result.pages[2].search.observed_at);
  assert.deepEqual(result, jdSearchPagesResult(journal, op.target));
});

test('a disabled 下一页 ends the read early with the pages already read, whether the pager or the click says so', async () => {
  const { result } = await drive(fakeBrowser({ total: 2 }), operation(5));
  assert.deepEqual([result.pages_read, result.end_reason, result.coverage.all_listed_pages_read], [2, 'last_page', true]);
  assert.equal(result.missing.includes('subsequent_pages'), false);

  // The pager read before the click still showed 下一页 enabled; the click script then found it disabled.
  const browser = fakeBrowser({ total: 3 });
  const op = operation(3);
  const refusing = { ...browser, async clickJdNextPage(tabId, target, fromPage) {
    if (fromPage === 2) throw Object.assign(new ShoppingError('SEARCH_LAST_PAGE', 'x'), { actionNotDispatched: true, lastPage: true });
    return browser.clickJdNextPage(tabId, target, fromPage);
  } };
  const early = await drive(refusing, op);
  assert.deepEqual([early.result.pages_read, early.result.end_reason], [2, 'last_page']);
  assert.equal(op.search_pages_read.transitions.length, 1, 'the refused click left no reservation');
});

test('a page that does not change after three checks stops the task, and a later run never clicks again', async () => {
  const browser = fakeBrowser({ stuck: true });
  const error = await drive(browser).catch(value => value);
  assert.equal(error.code, 'SEARCH_PAGE_NOT_CHANGED');
  assert.equal(failureCategory(error.code), 'diagnostic');
  assert.deepEqual(browser.calls, ['read:1', 'click:1', 'read:1', 'read:1', 'read:1']);
  assert.deepEqual([error.op.search_pages_read.transitions[0].checks, error.op.search_pages_read.reads], [3, 4]);
  await assert.rejects(drive(browser, error.op), { code: 'SEARCH_PAGE_NOT_CHANGED' });
  assert.equal(browser.clicks(), 1);
  assert.equal(browser.calls.length, 5);
});

test('another page number, or a tab not on page 1, stops without a further click', async () => {
  const jumped = fakeBrowser({ jumpTo: 5 });
  const error = await drive(jumped).catch(value => value);
  assert.equal(error.code, 'SEARCH_PAGE_MISMATCH');
  assert.equal(failureCategory(error.code), 'diagnostic');
  assert.equal(jumped.clicks(), 1);

  const later = fakeBrowser({ start: 2 });
  const notFirst = await drive(later).catch(value => value);
  assert.equal(notFirst.code, 'SEARCH_NOT_FIRST_PAGE');
  assert.deepEqual([later.calls, notFirst.op.search_pages_read.pages.length], [['read:2'], 0]);
});

test('a login page during a check pauses without using the check; the run resumes and confirms the page', async () => {
  const browser = fakeBrowser();
  let block = false;
  const gated = { ...browser, async readJdSearchPage(tabId, target) {
    if (block) { block = false; throw new ShoppingError('LOGIN_REQUIRED', 'x'); }
    return browser.readJdSearchPage(tabId, target);
  }, async clickJdNextPage(...args) { const value = await browser.clickJdNextPage(...args); block = true; return value; } };
  const op = operation(2);
  const paused = await drive(gated, op).catch(value => value);
  assert.equal(paused.code, 'LOGIN_REQUIRED');
  assert.deepEqual([op.search_pages_read.transitions[0].checks, op.search_pages_read.reads], [0, 2]);
  const { result } = await drive(gated, op);
  assert.deepEqual([result.pages_read, result.pages[1].transition.checks, browser.clicks()], [2, 1, 1]);
});

test('a refused click releases its reservation; an unacknowledged or interrupted click is spent and never repeated', async () => {
  const refused = fakeBrowser({ hooks: { refuse: Object.assign(new ShoppingError('SEARCH_PAGE_CONTROLS_MISMATCH', 'x'), { actionNotDispatched: true }) } });
  const op = operation(2);
  await assert.rejects(drive(refused, op), { code: 'SEARCH_PAGE_CONTROLS_MISMATCH' });
  assert.deepEqual([op.search_pages_read.transitions.length, op.search_pages_read.pages.length], [0, 1]);

  const timeout = fakeBrowser({ hooks: { afterClick: () => { throw new ShoppingError('BRIDGE_TIMEOUT', 'x'); } } });
  const { result } = await drive(timeout, operation(2));
  assert.deepEqual(result.pages[1].transition, { from_page: 1, acknowledgement: 'uncertain', error: 'BRIDGE_TIMEOUT', checks: 1 });
  assert.equal(timeout.clicks(), 1);

  // A process killed after the reservation: the click may have happened, so the resumed run only looks.
  const interrupted = fakeBrowser();
  const saved = operation(2);
  const first = await interrupted.readJdSearchPage(88, TARGET);
  await interrupted.clickJdNextPage(88, TARGET, 1);
  interrupted.calls.length = 0;
  Object.assign(saved.search_pages_read, { reads: 1, pages: [first],
    transitions: [{ from_page: 1, acknowledgement: null, error: null, checks: 0, confirmed: false }] });
  const resumed = await drive(interrupted, saved);
  assert.deepEqual(interrupted.calls, ['read:2']);
  assert.deepEqual(resumed.result.pages[1].transition, { from_page: 1, acknowledgement: 'uncertain', error: 'READ_INTERRUPTED', checks: 1 });
});

test('the read budget, the page count and the clock are bounded', async () => {
  for (const pages of [1, 6, 2.5, '3']) assert.throws(() => newJdSearchPagesState(pages), { code: 'INVALID_ARGUMENTS' });
  const op = operation(2);
  op.search_pages_read.reads = 13;
  await assert.rejects(drive(fakeBrowser(), op), { code: 'ACTION_OBSERVATION_LIMIT' });
  const waiting = operation(2);
  waiting.search_pages_read.not_before = 10_000_000;
  await assert.rejects(drive(fakeBrowser(), waiting), { code: 'CLOCK_CHANGED' });
});

test('the journal refuses pages out of order, repeated cards and a result it does not yield', async () => {
  const { result, op } = await drive(fakeBrowser());
  const good = op.search_pages_read;
  for (const change of [
    state => { state.pages[1].raw.pager.active_page = 3; state.pages[1].raw.pager.active_text = '3'; },
    state => { state.pages[2] = structuredClone(state.pages[1]); state.pages[2].raw.pager = pager(3, 17); },
    state => { state.transitions[0].confirmed = false; },
    state => { state.transitions[1].checks = 0; },
    state => { state.transitions[0].acknowledgement = null; },
    state => { state.transitions[0].error = 'BRIDGE_TIMEOUT'; },
    state => { state.transitions.push({ from_page: 3, acknowledgement: null, error: null, checks: 0, confirmed: false }); },
    state => { state.end = null; },
    state => { state.pages.pop(); state.transitions.pop(); },
    state => { state.reads = 2; },
    state => { state.requested_pages = 6; },
    state => { state.extra = 1; },
    state => { state.pages[0].raw.search.query = 'Another mouse'; },
    state => { state.pages[0].observed_at = 'yesterday'; },
  ]) {
    const state = structuredClone(good);
    change(state);
    assert.throws(() => validateJdSearchPagesState(state, TARGET), { code: 'INVALID_CHECKPOINT' }, change.toString());
  }
  const forged = structuredClone(result);
  forged.pages[0].search.items[0].title = 'Edited';
  assert.throws(() => validateJdSearchPagesResult(forged, TARGET, good), { code: 'INVALID_CHECKPOINT' });
  const unfinished = structuredClone(good);
  unfinished.end = null; unfinished.pages.pop(); unfinished.transitions[1].confirmed = false;
  validateJdSearchPagesState(unfinished, TARGET);
  assert.throws(() => validateJdSearchPagesResult(result, TARGET, unfinished), { code: 'INVALID_CHECKPOINT' });
});

test('the page read is paced as a read and 下一页 as a search load', () => {
  assert.deepEqual(PACED_METHODS.readJdSearchPage, ['read']);
  assert.deepEqual(PACED_METHODS.clickJdNextPage, ['load', 'search']);
});

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

test('a JD search pages task runs through the bridge on one tab, saves a checked result and exports each page', async t => {
  const page = jdSearchPage({ query: QUERY, pager: { pages: 17, active: 1 }, pageCards: [PAGE_CARDS[1], PAGE_CARDS[2], PAGE_CARDS[3]] });
  const { endpoint, state } = await mockBridge(t, { handler: ({ req, res, body, state: shared }) => {
    res.setHeader('Content-Type', 'application/json');
    const send = data => res.end(JSON.stringify({ id: body.id, success: true, data }));
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return send({ tabs: shared.tabs });
    if (body.action === 'eval' && body.tabId === 88 && !body.script.includes('"tab_address"')) return send({ result: page.evaluate(body.script) });
    res.end(JSON.stringify({ id: body.id, success: false, error: 'unsupported' }));
  } });
  state.tabs = [{ id: 88, url: TARGET.url }];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd search pages '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const [extra, code] of [
    [['--search', QUERY, '--tab', '88', '--pages', '1'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--tab', '88', '--pages', '6'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--pages', '3'], 'INVALID_ARGUMENTS'],
    [['--orders', '--tab', '88', '--pages', '2'], 'UNSUPPORTED_PLATFORM'],
    [['--search', QUERY, '--tab', '88', '--pages', '3', '--min-price', '10'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--tab', '88', '--pages', '3', '--source', 'tmall'], 'UNSUPPORTED_PLATFORM'],
  ]) {
    assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, code, extra.join(' '));
  }
  const created = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-pages', '--search', QUERY, '--tab', '88', '--pages', '3']);
  assert.deepEqual([created.code, created.value.task_kind, created.value.platform, created.value.products], [0, 'jd_search_pages', 'jd', 0]);

  const ran = await runTask({ stateDirectory: directory, task: 'jd-pages', bridge: new BrowserBridge(endpoint) }, clock());
  assert.equal(ran.status, 'complete', JSON.stringify(ran.operations[0].error));
  const operation = ran.operations[0];
  assert.deepEqual([operation.query, operation.requested_pages, operation.actions_reserved, operation.dom_observations_reserved, operation.pages_observed,
    ran.distinct_products], [QUERY, 3, 2, 3, 3, null]);
  assert.deepEqual(operation.result.pages.map(item => item.search.items.map(card => card.product_id)),
    [['1000001', '1000002', '1000003'], ['2000001', '2000003'], ['3000001', '3000002', '3000003']]);
  assert.equal(page.clicks(), 2);
  const evals = state.commands.filter(command => command.action === 'eval' && !command.script.includes('"tab_address"'));
  assert.deepEqual(evals.map(command => /^\(\{ pager: \(function (\w+)|^\(function (\w+)/.exec(command.script)?.slice(1).find(Boolean)),
    ['collectJdSearchPager', 'clickJdNextPage', 'collectJdSearchPager', 'clickJdNextPage', 'collectJdSearchPager']);
  assert.deepEqual(state.commands.filter(command => !['tab_list', 'eval'].includes(command.action)), [], 'nothing is opened, closed or navigated');

  const status = await run(['task-status', '--state-dir', directory, '--task', 'jd-pages']);
  assert.deepEqual(status.value.operations[0].result, operation.result);
  const markdown = path.join(directory, '..', `jd-pages-${path.basename(directory)}.md`);
  const csv = path.join(directory, '..', `jd-pages-${path.basename(directory)}.csv`);
  t.after(() => Promise.all([rm(markdown, { force: true }), rm(csv, { force: true })]));
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-pages', '--format', 'markdown', '--output', markdown])).code, 0);
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-pages', '--format', 'csv', '--output', csv])).code, 0);
  const rows = await readFile(csv, 'utf8');
  for (const pattern of [
    /"search_pagination",[^\n]*"pager","active_page=1; total=共17页; previous=disabled; next=enabled","start_page"/,
    /"search_pagination",[^\n]*"pager","active_page=2; total=共17页; previous=enabled; next=enabled","from_page=1; click=clicked; checks=1; error=null"/,
    /"search_scan",[^\n]*"cross_page_duplicates_omitted","1"/,
    /"search_item",[^\n]*,"2","[^"]*",[^\n]*"'2000001"/,
    /"collection_coverage",[^\n]*"url_reflects_page","false"/,
    /"collection_coverage",[^\n]*"distinct_products","8"/,
    /"collection_coverage",[^\n]*"total_pages_text","共17页"/,
    /"missing_field",[^\n]*"collection.subsequent_pages"/,
  ]) {
    assert.match(rows, pattern);
  }
  assert.match(await readFile(markdown, 'utf8'), /jd\\_search\\_pages/);

  const file = path.join(directory, 'tasks', 'jd-pages.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.operations[0].result.pages[1].search.items[0].title = 'Edited';
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'jd-pages'])).value.error.code, 'INVALID_CHECKPOINT');
});
