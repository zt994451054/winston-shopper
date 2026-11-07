import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { jdSearchScript, validateJdSearch, validateSavedJdSearch } from '../lib/jd/search.mjs';
import { readThrottleObservations } from '../lib/throttle-log.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';
import { DEFAULT_CARDS, element, jdSearchPage } from '../test-support/jd-search-fixture.mjs';

const QUERY = 'Synthetic mouse';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd search '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the first JD screen is read into the shared search fields, with JD marks kept apart and no click or scroll', () => {
  const page = jdSearchPage();
  const script = jdSearchScript(page.target);
  assert.doesNotMatch(script, /\.click\(|scrollIntoView|scrollTo|scrollBy|fetch\(|XMLHttpRequest|cookie|Storage|location\.assign/);
  const result = validateJdSearch(page.evaluate(script), page.target, { observedAt: '2026-10-15T00:00:00.000Z' });
  assert.equal(result.platform, 'jd');
  assert.deepEqual(result.items.map(item => [item.position, item.product_id, item.url]), [
    [1, '3290995', 'https://item.jd.com/3290995.html'], [2, '10221084529885', 'https://item.jd.com/10221084529885.html'],
    [3, '10068477063146', 'https://item.jd.com/10068477063146.html']]);
  assert.equal(result.schema_version, 2);
  assert.deepEqual(result.items[1].price, { raw: '¥89.90 补贴到手价 ¥99', amount_text: '¥89.90', label: '补贴到手价', kind: 'single_displayed',
    amount: '89.90', minimum: null, maximum: null, currency: 'CNY', eligibility_verified: false, sku_price_binding_verified: false });
  // The second amount stays out of the label, with its own line-through state; its meaning is not shown on the page.
  assert.deepEqual(result.items.map(item => item.jd), [
    { self_operated: true, sponsored: false, tags: ['包邮'], other_amounts: [{ text: '¥139', line_through: true }] },
    { self_operated: false, sponsored: false, tags: ['包邮'], other_amounts: [{ text: '¥99', line_through: false }] },
    { self_operated: false, sponsored: true, tags: [], other_amounts: [] }]);
  assert.equal(result.items[0].shop, 'Shop 3290995'); assert.equal(result.items[0].sales_text, '已售1万+');
  assert.deepEqual(result.coverage, { status: 'partial', scope: 'first_screen_loaded_cards', sort_verified: false, filters_verified: false,
    total_results_known: false, in_stock_only: true });
  assert.ok(result.missing.includes('cards_below_first_screen'));
  assert.equal(validateJdSearch(jdSearchPage({ inStockActive: false }).evaluate(script), page.target).coverage.in_stock_only, false);
});

test('cards without a product number are counted, repeated products are kept once, and an inconsistent saved copy is rejected', () => {
  const page = jdSearchPage({ cards: [...DEFAULT_CARDS, { sku: 'not-a-number' }, { sku: '3290995' }] });
  const observation = page.evaluate(jdSearchScript(page.target));
  const result = validateJdSearch(observation, page.target);
  assert.deepEqual([result.items.length, result.cards_scanned, result.unsupported_cards_omitted, result.duplicates_omitted], [3, 5, 1, 1]);
  validateSavedJdSearch(result, page.target);
  // Format 1 results (the first live run on 2026-10-15) have no schema_version and no other_amounts; they are still read back.
  const formatOne = validateJdSearch(observation, page.target, { schemaVersion: 1 });
  assert.deepEqual([formatOne.schema_version, formatOne.items[0].jd.other_amounts], [undefined, undefined]);
  validateSavedJdSearch(formatOne, page.target);
  // The saved copy is rebuilt from its own fields, as for Taobao, so edits that break its internal consistency are caught.
  for (const edit of [value => { value.items[0].url = 'https://item.jd.com/1.html'; }, value => { value.items[1].position = 9; },
    value => { value.cards_scanned = 4; }, value => { value.items[0].price.amount = '1.00'; }, value => { value.items[0].extra = true; },
    value => { value.platform = 'taobao'; }, value => { value.items[0].jd.sponsored = 'yes'; }, value => { delete value.schema_version; },
    value => { value.schema_version = 3; }, value => { value.items[0].jd.other_amounts[0].line_through = 'no'; },
    value => { value.items[0].jd.other_amounts = [1, 2, 3, 4]; }]) {
    const copy = structuredClone(result);
    edit(copy);
    assert.throws(() => validateSavedJdSearch(copy, page.target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('another page, a login or limit page, a slider and an empty result shell stop the read with their own codes', () => {
  const { target } = jdSearchPage();
  const read = options => () => {
    const page = jdSearchPage(options);
    return validateJdSearch(page.evaluate(jdSearchScript(target)), target);
  };
  assert.throws(read({ href: 'https://search.jd.com/Search?keyword=other&enc=utf-8' }), { code: 'TARGET_CHANGED' });
  assert.throws(read({ href: 'https://passport.jd.com/new/login.aspx' }), { code: 'LOGIN_REQUIRED' });
  assert.throws(read({ extra: [element('div', { text: '访问频繁导致无法搜索' })] }), { code: 'RATE_LIMITED' });
  assert.throws(read({ extra: [element('div', { cls: 'JDJRV-wrap' })] }), { code: 'VERIFICATION_REQUIRED' });
  assert.throws(read({ cards: [] }), { code: 'PAGE_STRUCTURE_CHANGED' });
});

function jdTabs(state, url = jdSearchPage().target.url) {
  state.tabs = [{ id: 88, url }, { id: 41, url: 'https://s.taobao.com/search?q=mouse&page=1&tab=all' }];
}

test('a JD search task runs on the JD ledger, saves its result, reports its query and exports Markdown and CSV', async t => {
  const { endpoint, state } = await mockBridge(t);
  jdTabs(state);
  const page = jdSearchPage();
  state.metadata = page.evaluate(jdSearchScript(page.target));
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  const created = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-mouse', '--search', QUERY, '--tab', '88']);
  assert.deepEqual([created.code, created.value.task_kind, created.value.platform], [0, 'jd_search', 'jd']);
  const ran = await run(['task-run', ...common, '--task', 'jd-mouse']);
  assert.deepEqual([ran.code, ran.value.status, ran.value.platform, ran.value.operations[0].query], [0, 'complete', 'jd', QUERY]);
  assert.equal(ran.value.operations[0].result.items.length, 3);
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false, 'the JD read uses the JD ledger');
  assert.ok(existsSync(path.join(directory, 'pacing-jd.json')));
  const status = await run(['task-status', '--state-dir', directory, '--task', 'jd-mouse']);
  assert.deepEqual(status.value.operations[0].result, ran.value.operations[0].result);
  const markdown = path.join(directory, '..', `jd-report-${path.basename(directory)}.md`);
  t.after(() => rm(markdown, { force: true }));
  const exported = await run(['report-export', '--state-dir', directory, '--task', 'jd-mouse', '--format', 'markdown', '--output', markdown]);
  assert.equal(exported.code, 0);
  const text = await readFile(markdown, 'utf8');
  assert.match(text, /jd\\_search/); assert.match(text, /self\\_operated=true; sponsored=false; tags=包邮/); assert.match(text, /in\\_stock\\_only/);
  assert.match(text, /search\\_other\\_amount/); assert.match(text, /line\\_through/);
  const csv = path.join(directory, '..', `jd-report-${path.basename(directory)}.csv`);
  t.after(() => rm(csv, { force: true }));
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-mouse', '--format', 'csv', '--output', csv])).code, 0);
  const rows = await readFile(csv, 'utf8');
  assert.match(rows, /search_marks/); assert.match(rows, /"search_other_amount",[^\n]*"no_line_through","¥99"/);
});

test('an unfinished JD task holds only JD tasks; a JD limit pauses the task and records the load counts before it', async t => {
  const { endpoint, state } = await mockBridge(t);
  jdTabs(state);
  state.metadata = { state: 'rate_limited' };
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-limited', '--search', QUERY, '--tab', '88']);
  const paused = await run(['task-run', ...common, '--task', 'jd-limited']);
  assert.deepEqual([paused.value.status, paused.value.operations[0].error.code], ['waiting_cooldown', 'RATE_LIMITED']);
  const log = await readThrottleObservations(directory);
  assert.deepEqual(log.observations.map(entry => [entry.platform, entry.signal, entry.page_kind]), [['jd', 'rate_limited', 'search']]);
  assert.deepEqual(log.observations[0].loads, { search: { last_10_minutes: 0, last_hour: 0 }, page: { last_10_minutes: 0, last_hour: 0 } });
  const blocked = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-second', '--search', QUERY, '--tab', '88']);
  assert.equal(blocked.value.error.code, 'PLATFORM_TASK_UNFINISHED');
  const taobao = await run(['task-start', ...common, '--task', 'taobao-search', '--search', 'mouse', '--tab', '41']);
  assert.deepEqual([taobao.code, taobao.value.task_kind], [0, 'search'], 'the paused JD task does not hold Taobao');
  const taobaoBlocked = await run(['task-start', ...common, '--task', 'taobao-second', '--search', 'mouse', '--tab', '41']);
  assert.equal(taobaoBlocked.value.error.code, 'PLATFORM_TASK_UNFINISHED', 'the unfinished Taobao task still holds Taobao');
  assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-limited', '--search', QUERY, '--tab', '88'])).value.error.code, 'TASK_EXISTS');
});

test('Taobao-only task options on JD, and Taobao-only commands on a JD task, are refused before any browser read', async t => {
  const { endpoint, state } = await mockBridge(t);
  jdTabs(state);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const extra of [['--bindings', 'mouse', '--details', '--pages', '2'], ['--bindings', 'mouse', '--details', '--sort', 'sales'],
    ['--bindings', 'mouse', '--services'], ['--cart', '--cart-rows', '5', '--tab', '88']]) {
    assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, 'UNSUPPORTED_PLATFORM');
  }
  assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', '--search', QUERY])).value.error.code, 'INVALID_ARGUMENTS');
  await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-ok', '--search', QUERY, '--tab', '88']);
  const reads = state.commands.filter(command => command.action === 'eval').length;
  assert.equal((await run(['task-diagnose', ...common, '--task', 'jd-ok'])).value.error.code, 'UNSUPPORTED_PLATFORM');
  assert.equal((await run(['task-rebind', ...common, '--task', 'jd-ok', '--tab', '88'])).value.error.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(state.commands.filter(command => command.action === 'eval').length, reads);
});

test('a saved JD task with an unknown field, another platform or a changed target is rejected', async t => {
  const { endpoint, state } = await mockBridge(t);
  jdTabs(state);
  const directory = await stateDirectory(t);
  await run(['task-start', '--platform', 'jd', '--endpoint', endpoint, '--state-dir', directory, '--task', 'jd-saved', '--search', QUERY, '--tab', '88']);
  const file = path.join(directory, 'tasks', 'jd-saved.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  for (const edit of [task => { task.extra = 1; }, task => { task.platform = 'taobao'; }, task => { task.operations[0].target.query = 'other'; },
    task => { task.operations[0].selection = null; }, task => { task.status = 'complete'; }]) {
    const copy = structuredClone(saved);
    edit(copy);
    await writeFile(file, JSON.stringify(copy));
    assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'jd-saved'])).value.error.code, 'INVALID_CHECKPOINT');
  }
});
