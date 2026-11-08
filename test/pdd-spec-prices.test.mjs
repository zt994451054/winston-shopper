import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { pddSpecClickScript, pddSpecHeader, pddSpecPage, pddSpecStateScript, validatePddSpecClick, validatePddSpecState } from '../lib/pdd/spec-prices.mjs';
import { validatePddTask } from '../lib/pdd/task-state.mjs';
import { PDD_GOODS_ID, pddPage, pddProductBody, pddProductUrl } from '../test-support/pdd-product-fixture.mjs';
import { defaultPddCards, node, pddSearchPage } from '../test-support/pdd-search-fixture.mjs';
import { playwrightStatus, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pdd spec '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const GROUPS = ['颜色分类', '尺码'];
const RED = 'rgb(224, 46, 36)';
const span = (text, onClick = null) => node('span', { text, onClick });

/**
 * A product page with the 2026-10-28 drawers: the bottom bar shows 单独购买 and 免拼购买, each opening its own drawer
 * (header with close icon, price and 已选 line; the groups; its own bottom button). The selection is shared and the
 * price depends on the drawer and the selection. `clicks` records every click; `onOpen` runs after a buy button.
 * `unavailable` greys one label, or every label for which it returns true given the current selection.
 */
function drawerBody({ clicks, onOpen = null, drawers = true, unavailable = null, selection = { 颜色分类: '黑色常规款', 尺码: 'S 80-100斤' } } = {}) {
  const options = { 颜色分类: ['黑色常规款', '咖色常规款'], 尺码: ['S 80-100斤', 'M 100-115斤'] };
  const base = { alone: 99.9, group: 89.9 };
  const price = kind => (base[kind] + (selection.颜色分类 === '咖色常规款' ? 10 : 0) + (selection.尺码 === 'M 100-115斤' ? 5 : 0)).toFixed(1);
  const built = {};
  const render = () => {
    for (const [kind, drawer] of Object.entries(built)) {
      const lines = [span(`¥${price(kind)}`), ...(kind === 'group' ? [span('2件9.9折')] : []), span(`已选：${selection.颜色分类} ${selection.尺码}`)];
      drawer.text.children.splice(0, drawer.text.children.length, ...lines);
      for (const line of lines) line.parentElement = drawer.text;
      for (const option of drawer.options) {
        const chosen = selection[option.group] === option.label;
        option.color = chosen ? RED : 'rgb(21, 21, 22)';
        option.border = chosen ? RED : 'rgba(0, 0, 0, 0)';
        const greyed = typeof unavailable === 'function' ? unavailable(option.label, selection) : option.label === unavailable;
        option.opacity = greyed ? '0.4' : '1';
      }
    }
  };
  const makeDrawer = (kind, footer) => {
    const text = node('div', {}, []);
    const close = node('div', { width: 27, onClick: () => { clicks.push(`close ${kind}`); root.hidden = true; } }, [node('svg', {})]);
    const made = [];
    const groups = GROUPS.map(name => node('div', {}, [span(name), node('div', {}, options[name].map(label => {
      const option = node('div', { text: label, onClick: () => { clicks.push(`option ${label}`); selection[name] = label; render(); } });
      Object.assign(option, { group: name, label });
      made.push(option);
      return option;
    }))]));
    const root = node('div', { hidden: true }, [node('div', {}, [close, text]), node('div', {}, groups),
      node('div', {}, footer.map(label => span(label, () => clicks.push(`FORBIDDEN ${label}`))))]);
    built[kind] = { root, text, options: made };
    return root;
  };
  const open = kind => () => { clicks.push(`open ${kind}`); built[kind].root.hidden = false; onOpen?.(kind); };
  const bar = node('div', { width: 100 }, [span('更多'), span('收藏'), span('客服'), span('¥'), span('99.9'), span('单独购买', open('alone')),
    span('¥'), span('89.9'), span('最后4件 免拼购买', open('group'))]);
  bar.fixed = true;
  const body = node('body', {}, [span('商品详情'), span('去拼单', () => clicks.push('FORBIDDEN 去拼单')), bar,
    ...(drawers ? [makeDrawer('alone', ['拼单购买无需等待，立省10元', '去拼单', '单独购买']), makeDrawer('group', ['确定'])] : [])]);
  render();
  return body;
}

function drawerPage(options) {
  const page = pddPage({ href: pddProductUrl(), body: drawerBody(options) });
  page.context.getComputedStyle = element => ({ display: 'block', visibility: element?.hidden ? 'hidden' : 'visible', position: element?.fixed ? 'fixed' : 'static',
    color: element?.color ?? 'rgb(21, 21, 22)', borderColor: element?.border ?? 'rgba(0, 0, 0, 0)', opacity: element?.opacity ?? '1', pointerEvents: 'auto',
    textDecorationLine: 'none' });
  return page;
}

test('the drawer reader lists the buy buttons, reads an open drawer, and clicks only buttons, unselected options and the close icon', () => {
  const clicks = [];
  const page = drawerPage({ clicks, unavailable: 'M 100-115斤' });
  const read = () => validatePddSpecState(page.evaluate(pddSpecStateScript(PDD_GOODS_ID, GROUPS)), GROUPS);
  const click = action => validatePddSpecClick(page.evaluate(pddSpecClickScript(PDD_GOODS_ID, GROUPS, action)));
  assert.deepEqual(read(), { drawers_in_page: 2, buttons: ['单独购买', '最后4件 免拼购买'], buttons_cut: false, open: null });
  assert.throws(() => click({ kind: 'option', group: '尺码', text: 'S 80-100斤' }), error => error.code === 'SPEC_DRAWER_STATE_CHANGED' && error.actionNotDispatched);
  assert.deepEqual(click({ kind: 'open', label: '最后4件 免拼购买' }), { clicked: true });
  const open = read().open;
  assert.deepEqual(open.header, ['¥89.9', '2件9.9折', '已选：黑色常规款 S 80-100斤']);
  assert.deepEqual(open.groups.map(group => group.options.map(option => [option.text, option.selected, option.unavailable])),
    [[['黑色常规款', true, false], ['咖色常规款', false, false]], [['S 80-100斤', true, false], ['M 100-115斤', false, true]]]);
  assert.deepEqual(open.other_lines, ['确定']);
  assert.throws(() => click({ kind: 'open', label: '单独购买' }), { code: 'SPEC_DRAWER_STATE_CHANGED' });
  assert.throws(() => click({ kind: 'option', group: '颜色分类', text: '黑色常规款' }), { code: 'SPEC_OPTION_SELECTED' });
  assert.throws(() => click({ kind: 'option', group: '尺码', text: 'M 100-115斤' }), { code: 'SPEC_OPTION_UNAVAILABLE' });
  assert.deepEqual(click({ kind: 'option', group: '颜色分类', text: '咖色常规款' }), { clicked: true });
  assert.equal(read().open.header[0], '¥99.9');
  assert.deepEqual(click({ kind: 'close' }), { clicked: true });
  assert.equal(read().open, null);
  assert.deepEqual(clicks, ['open group', 'option 咖色常规款', 'close group']);
  assert.throws(() => pddSpecClickScript(PDD_GOODS_ID, GROUPS, { kind: 'open', label: '去拼单' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => pddSpecClickScript(PDD_GOODS_ID, GROUPS, { kind: 'open', label: '确定' }), { code: 'INVALID_ARGUMENTS' });
  assert.doesNotMatch(pddSpecPage.toString(), /scroll|fetch\(|XMLHttpRequest|cookie|Storage|确定/);
});

test('a buy button is not clicked when the page holds no drawer with the saved groups', () => {
  const clicks = [];
  const page = drawerPage({ clicks, drawers: false });
  assert.equal(validatePddSpecState(page.evaluate(pddSpecStateScript(PDD_GOODS_ID, GROUPS)), GROUPS).drawers_in_page, 0);
  assert.throws(() => validatePddSpecClick(page.evaluate(pddSpecClickScript(PDD_GOODS_ID, GROUPS, { kind: 'open', label: '单独购买' }))),
    error => error.code === 'SPEC_DRAWER_UNAVAILABLE' && error.actionNotDispatched);
  assert.deepEqual(clicks, []);
  const other = drawerPage({ clicks });
  other.context.location.href = pddProductUrl('700000000002');
  assert.throws(() => validatePddSpecState(other.evaluate(pddSpecStateScript(PDD_GOODS_ID, GROUPS)), GROUPS), { code: 'TARGET_CHANGED' });
});

test('the drawer header gives the price of the selection, a range while a group is not chosen, and keeps the other lines', () => {
  assert.deepEqual(pddSpecHeader(['券后¥332.99', '券前¥340.99', '2件9.5折', '已选：单壳 苹果18Pro']), { chosen: '已选：单壳 苹果18Pro', notes: ['券前¥340.99', '2件9.5折'],
    price: { raw: '券后¥332.99', label: '券后', amount_text: '332.99', kind: 'single', amount: 332.99, minimum: 332.99, maximum: 332.99, currency: 'CNY' } });
  const range = pddSpecHeader(['¥336.99-341.99', '请选择 颜色 型号']);
  assert.deepEqual([range.price.kind, range.price.amount, range.price.minimum, range.price.maximum, range.chosen], ['range', null, 336.99, 341.99, '请选择 颜色 型号']);
  assert.equal(pddSpecHeader(['已选：黑色']).price, null);
});

/** A bridge whose tab shows a PDD search page; card 2 opens the product page, later swapped for the drawer page. */
function specBridge(t, { onOpen = null, unavailable = null } = {}) {
  const tab = { id: 88, url: '' };
  const clicks = [];
  const cards = defaultPddCards().map((card, index) => ({ ...card, onClick: index === 1 ? () => { tab.url = pddProductUrl(); } : null }));
  const searchPage = pddSearchPage({ query: 'Synthetic mouse', cards });
  tab.url = searchPage.context.location.href;
  let productPage = pddPage({ href: pddProductUrl(), body: pddProductBody({ title: '罗技M330静音无线光电鼠标办公' }) });
  const server = mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    state.tabs = [tab];
    if (req.url === '/status') return send(playwrightStatus());
    if (isAddressProbe(body)) return send({ id: body.id, success: true, data: { result: { state: 'tab_address', url: tab.url } } });
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: state.tabs } });
    if (body.action === 'eval') {
      const current = tab.url.includes('/goods.html') ? productPage : searchPage;
      return send({ id: body.id, success: true, data: { result: current.evaluate(body.script) } });
    }
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
  const toDrawers = () => { productPage = drawerPage({ clicks, unavailable, onOpen: kind => onOpen?.(kind, tab) }); };
  return { server, clicks, toDrawers };
}

async function productThenSpecPrices(bridge, directory) {
  const server = await bridge.server;
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'pdd', '--task', 'pdd-search', '--search', 'Synthetic mouse', '--tab', '88', ...common]);
  assert.equal((await run(['task-run', '--task', 'pdd-search', ...common])).value.status, 'complete');
  await run(['task-start', '--platform', 'pdd', '--task', 'pdd-card-2', '--source-task', 'pdd-search', '--position', '2', ...common]);
  assert.equal((await run(['task-run', '--task', 'pdd-card-2', ...common])).value.status, 'complete');
  bridge.toDrawers();
  const created = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-card-2-specs', '--source-task', 'pdd-card-2', '--spec-prices', ...common]);
  assert.deepEqual([created.code, created.value.task_kind], [0, 'pdd_spec_prices'], JSON.stringify(created.value));
  return { server, common, ran: await run(['task-run', '--task', 'pdd-card-2-specs', ...common]) };
}

test('task-start --spec-prices opens each drawer once, clicks each unselected option, closes the drawer and exports the prices', async t => {
  const bridge = specBridge(t);
  const directory = await stateDirectory(t);
  const { ran } = await productThenSpecPrices(bridge, directory);
  assert.deepEqual([ran.code, ran.value.status], [0, 'complete'], JSON.stringify(ran.value));
  assert.deepEqual(bridge.clicks, ['open alone', 'option 咖色常规款', 'option M 100-115斤', 'close alone',
    'open group', 'option 黑色常规款', 'option S 80-100斤', 'close group']);
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-card-2-specs.json'), 'utf8'));
  validatePddTask(saved);
  const { result } = saved.operations[0];
  assert.deepEqual([result.outcome, result.buttons, result.entry.clicks, result.coverage.status, result.coverage.drawers_closed],
    ['read', ['单独购买', '最后4件 免拼购买'], 8, 'complete', true]);
  assert.deepEqual(result.drawers.map(drawer => [drawer.kind, drawer.closed, drawer.readings.map(reading => [reading.chosen, reading.price.amount, reading.confirmed])]), [
    ['alone', true, [['已选：黑色常规款 S 80-100斤', 99.9, true], ['已选：咖色常规款 S 80-100斤', 109.9, true], ['已选：咖色常规款 M 100-115斤', 114.9, true]]],
    // The selection is shared, so the 免拼 drawer opens on 咖色 M and its unselected options are 黑色 and S.
    ['group', true, [['已选：咖色常规款 M 100-115斤', 104.9, true], ['已选：黑色常规款 M 100-115斤', 94.9, true], ['已选：黑色常规款 S 80-100斤', 89.9, true]]],
  ]);
  assert.deepEqual(result.drawers[1].readings[0].notes, ['2件9.9折']);
  assert.deepEqual([result.schema_version, result.coverage.options_skipped_greyed, result.drawers[0].skipped_greyed], [2, 0, []]);
  const ledger = JSON.parse(await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['page'], 'only the card click loads a page; drawer clicks are actions');
  for (const edit of [task => { task.operations[0].result.drawers[0].readings[1].price.amount = 1; },
    task => { task.operations[0].spec_read.steps[2].option = '黑色常规款'; }, task => { task.operations[0].spec_read.steps.pop(); }]) {
    const broken = structuredClone(saved); edit(broken);
    assert.throws(() => validatePddTask(broken), { code: 'INVALID_CHECKPOINT' });
  }
  const output = path.join(directory, '..', `pdd-spec-${process.pid}-${Date.now()}.md`);
  t.after(() => rm(output, { force: true }));
  const exported = await run(['report-export', '--task', 'pdd-card-2-specs', '--state-dir', directory, '--format', 'markdown', '--output', output]);
  assert.equal(exported.code, 0, JSON.stringify(exported.value));
  const report = await readFile(output, 'utf8');
  assert.match(report, /spec\\_price/);
  assert.match(report, /¥114\.9/);
});

test('the task stops without another click when the tab leaves the product page after a buy button', async t => {
  const bridge = specBridge(t, { onOpen: (kind, tab) => { tab.url = 'https://mobile.pinduoduo.com/order_checkout.html?goods_id=700000000001'; } });
  const directory = await stateDirectory(t);
  const { ran } = await productThenSpecPrices(bridge, directory);
  assert.notEqual(ran.value.status, 'complete');
  assert.equal(ran.value.operations[0].error.code, 'TARGET_CHANGED');
  assert.deepEqual(bridge.clicks, ['open alone']);
});

test('an option an earlier choice greys out is skipped and listed, not clicked, and the drawers still close', async t => {
  // 2026-11-08: once another colour was picked, sizes 43-45 of a shoe went grey and the old plan stopped on them.
  const bridge = specBridge(t, { unavailable: (label, selection) => label === 'M 100-115斤' && selection.颜色分类 === '咖色常规款' });
  const directory = await stateDirectory(t);
  const { ran } = await productThenSpecPrices(bridge, directory);
  assert.deepEqual([ran.code, ran.value.status], [0, 'complete'], JSON.stringify(ran.value));
  assert.deepEqual(bridge.clicks, ['open alone', 'option 咖色常规款', 'close alone', 'open group', 'option 黑色常规款', 'close group']);
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-card-2-specs.json'), 'utf8'));
  validatePddTask(saved);
  const { result } = saved.operations[0];
  assert.deepEqual(result.drawers.map(drawer => drawer.skipped_greyed), [[{ group: '尺码', option: 'M 100-115斤' }], []]);
  assert.deepEqual([result.coverage.status, result.coverage.options_skipped_greyed, result.coverage.drawers_closed], ['partial', 1, true]);
  assert.ok(result.missing.includes('options_greyed_after_earlier_choice'));
  // The 免拼 drawer opens on 咖色 S, where M is already grey, so it is never planned there.
  assert.deepEqual(result.drawers[1].groups[1].unavailable, ['M 100-115斤']);
});

test('a journal saved by the old plan, stopped before a greyed option, is accepted and goes on with the new plan', async t => {
  const bridge = specBridge(t, { unavailable: (label, selection) => label === 'M 100-115斤' && selection.颜色分类 === '咖色常规款',
    onOpen: (kind, tab) => { if (kind === 'group') tab.url = 'https://mobile.pinduoduo.com/order_checkout.html?goods_id=700000000001'; } });
  const directory = await stateDirectory(t);
  const { ran } = await productThenSpecPrices(bridge, directory);
  assert.equal(ran.value.operations[0].error.code, 'TARGET_CHANGED');
  const file = path.join(directory, 'tasks', 'pdd-card-2-specs.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  // Stopped before the 免拼 drawer was read, the task still shows what the 单独购买 drawer gave.
  assert.deepEqual(ran.value.operations[0].partial_readings.map(drawer => [drawer.button, drawer.readings.map(reading => reading.price.amount)]),
    [['单独购买', [99.9, 109.9]], ['最后4件 免拼购买', []]].slice(0, ran.value.operations[0].partial_readings.length));
  assert.equal(ran.value.operations[0].partial_readings[0].readings.length, 2);
  // Rebuild the old plan's last step: after 咖色 it would have clicked M, which the page greys out.
  const steps = saved.operations[0].spec_read.steps;
  const legacy = structuredClone(saved);
  legacy.operations[0].spec_read.steps = [...steps.slice(0, 3), { ...steps[3], kind: 'option', group: '尺码', option: 'M 100-115斤', reserved: false,
    outcome: null, error: null, checks: 0, confirmed: false, done: false, observed: null }];
  validatePddTask(legacy);
  const advanced = structuredClone(legacy);
  advanced.operations[0].spec_read.steps.at(-1).reserved = true;
  assert.throws(() => validatePddTask(advanced), { code: 'INVALID_CHECKPOINT' }, 'a reserved click must match the current plan');
});

test('--spec-prices needs a completed PDD product task and is refused on other platforms', async t => {
  const directory = await stateDirectory(t);
  const refused = await run(['task-start', '--task', 'tb-specs', '--source-task', 'x', '--spec-prices', '--state-dir', directory]);
  assert.equal(refused.value.error.code, 'UNSUPPORTED_PLATFORM');
  const both = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-specs', '--source-task', 'x', '--spec-prices', '--reviews', '--state-dir', directory]);
  assert.equal(both.value.error.code, 'INVALID_ARGUMENTS');
});
