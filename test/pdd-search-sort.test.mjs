import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { pddPriceRangeCheck, pddRangeConfirmScript, pddSortClickScript, pddSortOrderCheck, pddSortStateScript, validatePddSortClick,
  validatePddSortState } from '../lib/pdd/search-sort.mjs';
import { pddSortResult, validatePddSortResult } from '../lib/pdd/search-sort-read.mjs';
import { validatePddTask } from '../lib/pdd/task-state.mjs';
import { pddSearchTarget } from '../lib/pdd/targets.mjs';
import { node, pddSearchPage } from '../test-support/pdd-search-fixture.mjs';
import { playwrightStatus, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pdd sort '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const QUERY = 'Synthetic mouse';
const RED = 'rgb(224, 46, 36)';
const card = (title, amount, label = null) => ({ title, amount, label, labels: [], sales: '已抢10件' });
// The loaded cards under each sort_type, shaped like the 2026-10-27 probe (券后 amounts sort with the others).
const CARDS = {
  none: [card('鼠标甲', '67'), card('鼠标乙', '24', '券后'), card('鼠标丙', '99'), card('鼠标丁', '35'), card('鼠标戊', '48'), card('鼠标己', '31')],
  _sales: [card('鼠标乙', '24', '券后'), card('鼠标戊', '48'), card('鼠标甲', '67'), card('鼠标丁', '35'), card('鼠标丙', '99'), card('鼠标己', '31')],
  price: [card('鼠标乙', '24', '券后'), card('鼠标己', '31'), card('鼠标丁', '35'), card('鼠标戊', '48'), card('鼠标甲', '67'), card('鼠标丙', '99')],
  _price: [card('鼠标丙', '99'), card('鼠标甲', '67'), card('鼠标戊', '48'), card('鼠标丁', '35'), card('鼠标己', '31'), card('鼠标乙', '24', '券后')],
};
const params = href => new URL(href).searchParams;
const withParams = (href, values) => { const url = new URL(href); for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value); return url.href; };

/**
 * A fresh search tab: the sort bar marks its item red, 价格 sorts up first and then down, 筛选 opens a panel whose 确认
 * writes price=A,B and sort_type=default into the address and closes it, and 筛选 then stays red (2026-10-27/28).
 */
function newTab() {
  return { id: 88, url: `${pddSearchTarget(QUERY).url}&refer_page_name=index`, panelOpen: false, inputs: { 最低价: '', 最高价: '' } };
}

function pageFor(tab, { ignore = false, reverse = false, ignoreConfirm = false } = {}) {
  const query = params(tab.url);
  const current = query.get('sort_type') === 'default' ? null : query.get('sort_type');
  const range = query.get('price')?.split(',').map(Number) ?? null;
  const selected = { _sales: '销量', price: '价格', _price: '价格' }[current] ?? '综合';
  const next = { 销量: () => '_sales', 价格: () => current === 'price' ? '_price' : 'price' };
  const items = ['综合', '销量', '价格', '品牌', '筛选'].map(text => {
    const onClick = text === '筛选' ? () => { tab.panelOpen = true; } : next[text] && !ignore ? () => { tab.url = withParams(tab.url, { sort_type: next[text]() }); } : null;
    const item = node('div', { text, width: 40, onClick });
    if (text === selected || (text === '筛选' && range)) item.color = RED;
    return item;
  });
  const inputs = ['最低价', '最高价'].map(placeholder => Object.assign(node('input', { width: 80 }), { placeholder, value: tab.inputs[placeholder] }));
  const confirm = node('div', { text: '确认 (1万+件商品)', width: 80, onClick: ignoreConfirm ? null : () => {
    tab.url = withParams(tab.url, { price: `${tab.inputs.最低价},${tab.inputs.最高价}`, sort_type: params(tab.url).get('sort_type') ?? 'default' });
    tab.panelOpen = false;
  } });
  const panel = node('div', { width: 300, hidden: !tab.panelOpen }, [node('div', { text: '价格区间(元)', width: 80 }), ...inputs, confirm]);
  let cards = reverse && current === 'price' ? CARDS._price : CARDS[current ?? 'none'];
  if (range) cards = cards.filter(item => Number(item.amount) >= range[0] && Number(item.amount) <= range[1]);
  return pddSearchPage({ query: QUERY, cards, href: tab.url, bar: node('div', { width: 300 }, items), extra: [panel] });
}

test('the sort bar shows sort_type, the range and the red item, and each action is sent only from the expected state', () => {
  const target = pddSearchTarget(QUERY);
  const tab = newTab();
  const evaluate = script => pageFor(tab).evaluate(script);
  const closed = { open: false, minimum: null, maximum: null };
  assert.deepEqual(validatePddSortState(evaluate(pddSortStateScript(target))), { sort_type: null, selected: ['综合'], price_range: null, panel: closed });
  assert.throws(() => validatePddSortClick(evaluate(pddSortClickScript(target, { label: '价格', from: 'price' }))),
    error => error.code === 'SEARCH_SORT_STATE_CHANGED' && error.actionNotDispatched);
  assert.throws(() => validatePddSortClick(evaluate(pddRangeConfirmScript(target, 30, 60))), error => error.code === 'SEARCH_PRICE_RANGE_STATE_CHANGED' && error.actionNotDispatched);
  assert.deepEqual(validatePddSortClick(evaluate(pddSortClickScript(target, { label: '筛选', from: null }))), { clicked: true });
  assert.deepEqual(validatePddSortState(evaluate(pddSortStateScript(target))).panel, { open: true, minimum: '', maximum: '' });
  tab.inputs = { 最低价: '30', 最高价: '60' };
  assert.deepEqual(validatePddSortClick(evaluate(pddRangeConfirmScript(target, 30, 60))), { clicked: true });
  assert.deepEqual(validatePddSortState(evaluate(pddSortStateScript(target))), { sort_type: null, selected: ['综合', '筛选'], price_range: '30,60', panel: closed },
    'sort_type default reads as 综合');
  assert.throws(() => validatePddSortClick(evaluate(pddSortClickScript(target, { label: '价格', from: null }))), { code: 'SEARCH_SORT_STATE_CHANGED' },
    'a sort click must name the range the page shows');
  assert.deepEqual(validatePddSortClick(evaluate(pddSortClickScript(target, { label: '价格', from: null, range: '30,60' }))), { clicked: true });
  assert.deepEqual(validatePddSortState(evaluate(pddSortStateScript(target))).selected, ['价格', '筛选']);
  assert.throws(() => pddSortClickScript(target, { label: '品牌', from: null }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => pddRangeConfirmScript(target, 60, 30), { code: 'INVALID_ARGUMENTS' });

  const amounts = values => values.map(amount => ({ price: { amount } }));
  assert.equal(pddSortOrderCheck(amounts(['8.45', '19.59', '19.8', '24.39']), 'asc').status, 'ordered');
  assert.equal(pddSortOrderCheck(amounts(['8.45', '19.59', '19.8', '24.39']), 'desc').status, 'opposite');
  assert.deepEqual(pddSortOrderCheck(amounts(['699', '579', null, '600', '449']), 'desc').pairs, { in_order: 2, against: 1, equal: 0 });
  assert.equal(pddSortOrderCheck(amounts(['1', '2']), 'asc').status, 'too_few');
  assert.deepEqual(pddPriceRangeCheck(amounts(['32.8', '58.39', null, '61']), 30, 60),
    { basis: 'displayed_amount', minimum: 30, maximum: 60, cards_checked: 3, outside: 1, unparsed_skipped: 1 });
});

/** A bridge whose tab 88 shows a fresh PDD search page; snapshot and fill reach the panel inputs while it is open. */
function sortBridge(t, options = {}) {
  const tab = newTab();
  return mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    state.tabs = [tab];
    if (req.url === '/status') return send(playwrightStatus());
    if (isAddressProbe(body)) return send({ id: body.id, success: true, data: { result: { state: 'tab_address', url: tab.url } } });
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: state.tabs } });
    if (body.action === 'eval') return send({ id: body.id, success: true, data: { result: pageFor(tab, options).evaluate(body.script) } });
    if (body.action === 'snapshot') {
      const placeholder = body.selector.match(/placeholder="(.+)"/)[1];
      return send({ id: body.id, success: true, data: { snapshotData: { refs: tab.panelOpen ? { [`e${placeholder.length}${placeholder === '最低价' ? 1 : 2}`]: { role: 'textbox', name: placeholder } } : {} } } });
    }
    if (body.action === 'fill') {
      const placeholder = body.ref.endsWith('1') ? '最低价' : '最高价';
      tab.inputs[placeholder] = body.text;
      return send({ id: body.id, success: true, data: { role: 'textbox', name: placeholder, filledText: body.text } });
    }
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

const evalsWith = (server, name) => server.state.commands.filter(command => command.action === 'eval' && command.script?.includes(name));

async function startSort(server, directory, name, args) {
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  const created = await run(['task-start', '--platform', 'pdd', '--task', name, '--search', QUERY, '--tab', '88', ...args, ...common]);
  assert.deepEqual([created.code, created.value.task_kind], [0, 'pdd_search_sort'], JSON.stringify(created.value));
  return run(['task-run', '--task', name, ...common]);
}

test('price-desc clicks 价格 twice, confirming 价格 low to high before the second click, and saves the cards high to low', async t => {
  const server = await sortBridge(t);
  const directory = await stateDirectory(t);
  const ran = await startSort(server, directory, 'pdd-sort-desc', ['--sort', 'price-desc']);
  assert.deepEqual([ran.code, ran.value.status], [0, 'complete'], JSON.stringify(ran.value));
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-sort-desc.json'), 'utf8'));
  validatePddTask(saved);
  const { result, sort_read: journal } = saved.operations[0];
  assert.deepEqual([result.schema_version, result.sort, result.price_range, result.sort_type, result.selected,
    result.actions.map(action => [action.kind, action.label, action.to, action.outcome, action.checks])],
  [2, 'price-desc', null, '_price', ['价格'], [['sort', '价格', 'price', 'clicked', 1], ['sort', '价格', '_price', 'clicked', 1]]]);
  assert.deepEqual([result.order_check.status, result.range_check, result.search.items.map(item => item.price.amount)],
    ['ordered', null, ['99', '67', '48', '35', '31', '24']]);
  assert.deepEqual([result.coverage.sort_ui_verified, result.coverage.url_reflects_sort, result.coverage.sort_direction_verified, result.coverage.price_range_verified],
    [true, true, true, null]);
  assert.equal(journal.reads, 1);
  assert.equal(evalsWith(server, 'clickPddSortItem').length, 2);
  const ledger = JSON.parse(await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['search', 'search'], 'each sort click re-sorts the results');
  for (const edit of [task => { task.operations[0].result.search.items[0].title = 'Edited'; }, task => { task.operations[0].sort_read.actions[1].confirmed = false; },
    task => { task.operations[0].result.order_check.status = 'mixed'; }]) {
    const broken = structuredClone(saved); edit(broken);
    assert.throws(() => validatePddTask(broken), { code: 'INVALID_CHECKPOINT' });
  }

  // A format 1 journal, saved on 2026-10-28 before the range, still yields its format 1 result.
  const v1 = { schema_version: 1, sort: 'price-desc', reads: 1, not_before: 0,
    clicks: journal.actions.map(({ kind, ...click }) => click),
    page: { ...journal.page, sort_state: { sort_type: journal.page.sort_state.sort_type, selected: journal.page.sort_state.selected } } };
  const old = pddSortResult(v1);
  assert.deepEqual([old.schema_version, old.clicks.length, old.coverage.sort_direction_verified, 'actions' in old], [1, 2, true, false]);
  validatePddSortResult(old, v1, saved.operations[0].target);
  assert.throws(() => validatePddSortResult({ ...old, sort_type: 'price' }, v1, saved.operations[0].target), { code: 'INVALID_CHECKPOINT' });
});

test('a range then price-asc opens 筛选, fills, confirms, sorts within the range and exports the checks', async t => {
  const server = await sortBridge(t);
  const directory = await stateDirectory(t);
  const ran = await startSort(server, directory, 'pdd-range-asc', ['--min-price', '25', '--max-price', '70', '--sort', 'price-asc']);
  assert.deepEqual([ran.code, ran.value.status], [0, 'complete'], JSON.stringify(ran.value));
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-range-asc.json'), 'utf8'));
  validatePddTask(saved);
  const { result } = saved.operations[0];
  assert.deepEqual(result.actions.map(action => [action.kind, action.outcome, action.checks]),
    [['open_filter', 'clicked', 1], ['fill', 'clicked', 1], ['confirm', 'clicked', 1], ['sort', 'clicked', 1]]);
  assert.deepEqual([result.price_range, result.address_price_range, result.sort_type, result.selected, result.search.items.map(item => item.price.amount)],
    [{ minimum: 25, maximum: 70 }, '25,70', 'price', ['价格', '筛选'], ['31', '35', '48', '67']]);
  assert.deepEqual([result.range_check.outside, result.order_check.status, result.coverage.price_range_verified, result.coverage.sort_ui_verified], [0, 'ordered', true, true]);
  const ledger = JSON.parse(await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['search', 'search'], '确认 and the sort click are search loads; opening 筛选 and typing are not');
  const output = path.join(directory, '..', `pdd-range-${process.pid}-${Date.now()}.md`);
  t.after(() => rm(output, { force: true }));
  const exported = await run(['report-export', '--task', 'pdd-range-asc', '--state-dir', directory, '--format', 'markdown', '--output', output]);
  assert.equal(exported.code, 0, JSON.stringify(exported.value));
  const report = await readFile(output, 'utf8');
  assert.match(report, /search\\_price\\_range\\_check/);
  assert.match(report, /address\\_price=25,70/);
  assert.match(report, /search\\_sort\\_click/);

  const only = await sortBridge(t);
  const onlyDirectory = await stateDirectory(t);
  const ranged = await startSort(only, onlyDirectory, 'pdd-range-only', ['--min-price', '30', '--max-price', '60']);
  assert.equal(ranged.value.status, 'complete', JSON.stringify(ranged.value));
  const onlyResult = ranged.value.operations[0].result;
  assert.deepEqual([onlyResult.sort, onlyResult.sort_type, onlyResult.selected, onlyResult.order_check, onlyResult.coverage.sort_ui_verified, onlyResult.coverage.price_range_verified],
    [null, null, ['综合', '筛选'], null, null, true]);
});

test('sales clicks 销量 once and has no price order check', async t => {
  const server = await sortBridge(t);
  const directory = await stateDirectory(t);
  const ran = await startSort(server, directory, 'pdd-sort-sales', ['--sort', 'sales']);
  assert.equal(ran.value.status, 'complete', JSON.stringify(ran.value));
  const result = ran.value.operations[0].result;
  assert.deepEqual([result.sort_type, result.selected, result.order_check, result.coverage.sort_direction_verified, evalsWith(server, 'clickPddSortItem').length],
    [ '_sales', ['销量'], null, null, 1]);
});

test('an ignored click or 确认 stops after three checks without repeating it; reversed cards are not saved', async t => {
  const server = await sortBridge(t, { ignore: true });
  const directory = await stateDirectory(t);
  const ran = await startSort(server, directory, 'pdd-sort-ignored', ['--sort', 'price-asc']);
  assert.equal(ran.value.operations[0].error.code, 'SEARCH_SORT_NOT_APPLIED');
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  const again = await run(['task-run', '--task', 'pdd-sort-ignored', ...common]);
  assert.notEqual(again.value.status, 'complete');
  assert.equal(evalsWith(server, 'clickPddSortItem').length, 1);

  const stuck = await sortBridge(t, { ignoreConfirm: true });
  const stuckDirectory = await stateDirectory(t);
  const unconfirmed = await startSort(stuck, stuckDirectory, 'pdd-range-ignored', ['--min-price', '30', '--max-price', '60']);
  assert.equal(unconfirmed.value.operations[0].error.code, 'SEARCH_PRICE_RANGE_NOT_APPLIED');
  assert.equal(evalsWith(stuck, 'clickPddRangeConfirm').length, 1);

  const reversed = await sortBridge(t, { reverse: true });
  const reversedDirectory = await stateDirectory(t);
  const opposite = await startSort(reversed, reversedDirectory, 'pdd-sort-reversed', ['--sort', 'price-asc']);
  assert.equal(opposite.value.operations[0].error.code, 'SEARCH_SORT_DIRECTION_MISMATCH');

  for (const [index, [args, code]] of [[['--sort', 'price-asc', '--tab', '88'], 'INVALID_ARGUMENTS'], [['--search', QUERY, '--tab', '88', '--sort', 'popular'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--tab', '88', '--min-price', '60', '--max-price', '30'], 'INVALID_ARGUMENTS'], [['--search', QUERY, '--tab', '88', '--min-price', '30'], 'INVALID_ARGUMENTS'],
    [['--search', QUERY, '--tab', '88', '--pages', '2'], 'UNSUPPORTED_PLATFORM']].entries()) {
    assert.equal((await run(['task-start', '--platform', 'pdd', '--task', `pdd-sort-refused-${index}`, ...args, ...common])).value.error.code, code, args.join(' '));
  }
});

// 2026-11-08: a caller sorted by price and then could not open the cheapest card, because product tasks took only plain
// searches as their source. A sorted or ranged search keeps its cards in the same order the page shows.
test('a product task can start from a sorted search and takes the card at that position in the sorted order', async t => {
  const server = await sortBridge(t);
  const directory = await stateDirectory(t);
  const ran = await startSort(server, directory, 'pdd-sort-asc', ['--sort', 'price-asc']);
  assert.equal(ran.value.status, 'complete', JSON.stringify(ran.value));
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  const created = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-sorted-card-2', '--source-task', 'pdd-sort-asc', '--position', '2', ...common]);
  assert.deepEqual([created.code, created.value.task_kind], [0, 'pdd_product'], JSON.stringify(created.value));
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-sorted-card-2.json'), 'utf8'));
  assert.deepEqual([saved.operations[0].product_read.card.title, saved.operations[0].product_read.card.amount_text], ['鼠标己', '31']);
  validatePddTask(saved);
  const outside = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-sorted-card-9', '--source-task', 'pdd-sort-asc', '--position', '9', ...common]);
  assert.equal(outside.value.error.code, 'INVALID_ARGUMENTS');
});
