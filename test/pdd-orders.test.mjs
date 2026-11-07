import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { collectPddOrders, pddOrdersScript, validatePddOrders, validateSavedPddOrders } from '../lib/pdd/orders.mjs';
import { collectPddOrderDetail, pddOrderCardClickScript, pddOrderDetailScript, pddOrderExpandScript, validatePddOrderClick,
  validatePddOrderDetail } from '../lib/pdd/order-detail.mjs';
import { pddOrderDetailResult } from '../lib/pdd/order-detail-read.mjs';
import { validatePddTask } from '../lib/pdd/task-state.mjs';
import { pddPage } from '../test-support/pdd-product-fixture.mjs';
import { PDD_ORDER_SN, defaultPddOrders, pddOrderDetailBody, pddOrderDetailUrl, pddOrderListUrl, pddOrdersBody } from '../test-support/pdd-order-fixture.mjs';
import { playwrightStatus, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pdd orders '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const PRIVATE = /PRIVATE|微信|YT|物流公司|快递单号|支付方式/;

test('the order list reader keeps shop, status, items and the amount line, and leaves avatars, buttons, the hidden copy and recommendations out', () => {
  const raw = pddPage({ href: pddOrderListUrl(), body: pddOrdersBody() }).evaluate(pddOrdersScript());
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE|删除订单|再次拼单|精选推荐/);
  const list = validatePddOrders(raw, { observedAt: '2026-10-27T09:00:00.000Z' });
  assert.deepEqual([list.url, list.loaded_count, list.orders_cut, list.end_shown, list.coverage.status, list.missing],
    ['https://mobile.pinduoduo.com/orders.html', 2, false, true, 'complete', ['order_ids', 'order_times']]);
  const [first, second] = list.orders;
  assert.deepEqual([first.order_id, first.shop, first.status, first.items[0].spec, first.items[0].quantity, first.items[0].tags],
    [null, '优尚一家', '极速退款成功', '白色', 2, ['7天价保']]);
  assert.deepEqual([first.amount.label, first.amount.amount_text, first.group_avatars_skipped, first.other_rows_skipped], ['实付', '0', 2, 2],
    'the hidden copy and the buttons are counted, not read');
  assert.deepEqual([second.items.map(item => [item.title, item.spec, item.quantity]), second.amount.amount_text, second.amount.pay_later_shown,
    second.amount.shipping_note], [[['静音无线鼠标', '黑色【全新】', 1], ['鼠标垫', '蓝色', 1]], '6.77', true, '免运费'],
    'the list shows ×N before the spec (2026-10-27); SPEC ×N is still read');
  assert.doesNotMatch(collectPddOrders.toString(), /\.click\(|scroll|fetch\(|XMLHttpRequest|cookie|Storage/);
  validateSavedPddOrders(list);
  const edited = structuredClone(list);
  edited.orders[0].amount.amount_text = '9';
  assert.throws(() => validateSavedPddOrders(edited), { code: 'INVALID_CHECKPOINT' });
  // A format 1 result, saved before ×N，SPEC was known, is rebuilt as format 1.
  const first1 = validatePddOrders(raw, { observedAt: '2026-10-27T09:00:00.000Z', version: 1 });
  assert.deepEqual([first1.schema_version, first1.orders[0].items[0].spec, first1.orders[0].items[0].tags], [1, null, ['×2，白色', '7天价保']]);
  validateSavedPddOrders(first1);
  assert.throws(() => validateSavedPddOrders({ ...list, schema_version: 1 }), { code: 'INVALID_CHECKPOINT' });

  const unfinished = validatePddOrders(pddPage({ href: pddOrderListUrl(), body: pddOrdersBody({ end: false }) }).evaluate(pddOrdersScript()));
  assert.deepEqual([unfinished.coverage.status, unfinished.missing.at(-1)], ['partial', 'orders_not_loaded']);
  const empty = pddPage({ href: pddOrderListUrl(), body: pddOrdersBody({ orders: [], end: false }) });
  assert.throws(() => validatePddOrders(empty.evaluate(pddOrdersScript())), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('an order card is clicked only while it shows the saved shop, status and title', () => {
  const clicks = [];
  const page = pddPage({ href: pddOrderListUrl(), body: pddOrdersBody({ orders: defaultPddOrders(() => clicks.push('title')) }) });
  const click = card => validatePddOrderClick(page.evaluate(pddOrderCardClickScript(1, card)));
  assert.throws(() => click({ shop: '优尚一家', status: '交易成功', title: '断桥锁点密封条' }), error => error.code === 'ORDER_CHANGED' && error.actionNotDispatched);
  assert.throws(() => validatePddOrderClick(page.evaluate(pddOrderCardClickScript(5, { shop: 'a', status: 'b', title: 'c' }))), { code: 'ORDER_NOT_LOADED' });
  assert.deepEqual(clicks, []);
  assert.deepEqual(click({ shop: '优尚一家', status: '极速退款成功', title: '断桥锁点密封条' }), { clicked: true });
  assert.deepEqual(clicks, ['title']);
  assert.throws(() => pddOrderCardClickScript(0, { shop: 'a', status: 'b', title: 'c' }), { code: 'INVALID_ARGUMENTS' });
});

test('the order page reader keeps status words, amounts and the unfolded times, and never the consignee, payment or logistics rows', () => {
  const page = pddPage({ href: pddOrderDetailUrl(), body: pddOrderDetailBody() });
  const folded = validatePddOrderDetail(page.evaluate(pddOrderDetailScript(PDD_ORDER_SN, '优尚一家')), PDD_ORDER_SN);
  assert.deepEqual([folded.status_words, folded.top_parts_skipped, folded.order_number_shown, folded.amount.amount_text, folded.times, folded.info_folded],
    [['已签收'], 2, PDD_ORDER_SN, '3.34', [], true]);
  assert.deepEqual(folded.discount_lines, ['大促后共优惠 ¥0.02']);

  assert.deepEqual(validatePddOrderClick(page.evaluate(pddOrderExpandScript(PDD_ORDER_SN)), true), { clicked: true });
  const raw = page.evaluate(pddOrderDetailScript(PDD_ORDER_SN, '优尚一家'));
  assert.doesNotMatch(JSON.stringify(raw), PRIVATE);
  const order = validatePddOrderDetail(raw, PDD_ORDER_SN, { observedAt: '2026-10-27T09:00:00.000Z' });
  assert.deepEqual(order.times.map(time => time.label), ['下单时间', '拼单时间', '发货时间', '成交时间']);
  assert.deepEqual([order.times[0].value, order.rows_skipped, order.info_folded, order.url],
    ['2026-10-20 10:00:00', 5, false, `https://mobile.pinduoduo.com/order.html?order_sn=${PDD_ORDER_SN}`]);
  assert.ok(!order.lines.some(line => ['联系商家', '删除订单', '复制'].includes(line)), 'buttons are not kept');
  assert.doesNotMatch(collectPddOrderDetail.toString(), /\.click\(|scroll|fetch\(|XMLHttpRequest|cookie|Storage/);

  const other = pddPage({ href: pddOrderDetailUrl(), body: pddOrderDetailBody({ shownNumber: '261020-999999999999999' }) });
  assert.throws(() => validatePddOrderDetail(other.evaluate(pddOrderDetailScript(PDD_ORDER_SN, '优尚一家')), PDD_ORDER_SN), { code: 'ORDER_NUMBER_MISMATCH' });
  const bare = pddPage({ href: pddOrderDetailUrl(), body: pddOrderDetailBody({ expandable: false }) });
  assert.deepEqual(validatePddOrderClick(bare.evaluate(pddOrderExpandScript(PDD_ORDER_SN)), true), { clicked: false });
  // An order without discounts labels the fold entry 查看更多订单信息 (2026-11-07).
  const short = pddPage({ href: pddOrderDetailUrl(), body: pddOrderDetailBody({ expandLabel: '查看更多订单信息' }) });
  const shortFolded = validatePddOrderDetail(short.evaluate(pddOrderDetailScript(PDD_ORDER_SN, '优尚一家')), PDD_ORDER_SN);
  assert.deepEqual([shortFolded.info_folded, shortFolded.lines.includes('查看更多订单信息')], [true, false]);
  assert.deepEqual(validatePddOrderClick(short.evaluate(pddOrderExpandScript(PDD_ORDER_SN)), true), { clicked: true });
  const shortOpen = validatePddOrderDetail(short.evaluate(pddOrderDetailScript(PDD_ORDER_SN, '优尚一家')), PDD_ORDER_SN);
  assert.deepEqual([shortOpen.times.length, shortOpen.info_folded], [4, false]);
  const wrongShop = page.evaluate(pddOrderDetailScript(PDD_ORDER_SN, '另一家店'));
  assert.throws(() => validatePddOrderDetail(wrongShop, PDD_ORDER_SN), { code: 'PAGE_STRUCTURE_CHANGED' });
});

/**
 * A bridge whose tab 88 shows the order list; the first card's title opens its order page in the same tab, or
 * `landing` instead.
 */
function ordersBridge(t, { landing = null, expandable = true } = {}) {
  const tab = { id: 88, url: pddOrderListUrl() };
  const listPage = pddPage({ href: pddOrderListUrl(), body: pddOrdersBody({ orders: defaultPddOrders(() => { tab.url = landing ?? pddOrderDetailUrl(); }) }) });
  const detailPage = pddPage({ href: pddOrderDetailUrl(), body: pddOrderDetailBody({ expandable }) });
  return mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    state.tabs = [tab];
    if (req.url === '/status') return send(playwrightStatus());
    if (isAddressProbe(body)) return send({ id: body.id, success: true, data: { result: { state: 'tab_address', url: tab.url } } });
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: state.tabs } });
    if (body.action === 'eval') {
      const current = tab.url.includes('/order.html') ? detailPage : listPage;
      current.context.location.href = tab.url;
      return send({ id: body.id, success: true, data: { result: current.evaluate(body.script) } });
    }
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

async function listThenDetail(server, directory) {
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  const created = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-orders', '--orders', '--tab', '88', ...common]);
  assert.deepEqual([created.code, created.value.task_kind], [0, 'pdd_orders'], JSON.stringify(created.value));
  assert.equal((await run(['task-run', '--task', 'pdd-orders', ...common])).value.status, 'complete');
  const detail = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-order-1', '--source-task', 'pdd-orders', '--order-position', '1', ...common]);
  assert.deepEqual([detail.code, detail.value.task_kind], [0, 'pdd_order_detail'], JSON.stringify(detail.value));
  return run(['task-run', '--task', 'pdd-order-1', ...common]);
}

const cardClicks = server => server.state.commands.filter(command => command.action === 'eval' && command.script?.includes('clickPddOrderCard'));
const expandClicks = server => server.state.commands.filter(command => command.action === 'eval' && command.script?.includes('expandPddOrderInfo'));

test('an order list task and a detail task from it click the title and 查看更多 once each and export no private rows', async t => {
  const server = await ordersBridge(t);
  const directory = await stateDirectory(t);
  const ran = await listThenDetail(server, directory);
  assert.deepEqual([ran.code, ran.value.status], [0, 'complete'], JSON.stringify(ran.value));
  const list = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-orders.json'), 'utf8'));
  validatePddTask(list);
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-order-1.json'), 'utf8'));
  validatePddTask(saved);
  const { result, order_detail_read: journal } = saved.operations[0];
  assert.deepEqual([result.order_id, result.entry.card_shop, result.entry.click, result.entry.expand, result.coverage.info_expanded, result.times.length],
    [PDD_ORDER_SN, '优尚一家', 'clicked', 'clicked', true, 4]);
  assert.deepEqual([journal.checks, journal.reads], [0, 1]);
  assert.deepEqual([cardClicks(server).length, expandClicks(server).length], [1, 1]);
  assert.doesNotMatch(JSON.stringify([list, saved]), PRIVATE);
  const ledger = JSON.parse(await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['page'], 'only the title click is a page load');
  for (const edit of [task => { task.operations[0].result.times[0].value = 'Edited'; }, task => { task.operations[0].order_detail_read.expand = null; },
    task => { task.operations[0].result.status_words = []; }]) {
    const broken = structuredClone(saved); edit(broken);
    assert.throws(() => validatePddTask(broken), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(result.schema_version, 2);

  // A format 1 result saved when 查看更多订单信息 was not yet known (the entry stayed folded and its label was kept as a
  // line) is still rebuilt and accepted as format 1; format 2 drops the label and reports the fold.
  const short = pddPage({ href: pddOrderDetailUrl(), body: pddOrderDetailBody({ expandLabel: '查看更多订单信息' }) });
  const old = structuredClone(saved);
  const oldJournal = old.operations[0].order_detail_read;
  oldJournal.expand = 'not_shown';
  oldJournal.page.raw = short.evaluate(pddOrderDetailScript(PDD_ORDER_SN, '优尚一家'));
  old.operations[0].result = pddOrderDetailResult(oldJournal, 1);
  assert.deepEqual([old.operations[0].result.info_folded, old.operations[0].result.lines.includes('查看更多订单信息')], [false, true]);
  validatePddTask(old);
  assert.deepEqual([pddOrderDetailResult(oldJournal).info_folded, pddOrderDetailResult(oldJournal).lines.includes('查看更多订单信息')], [true, false]);
  for (const version of [2, 3]) {
    const relabelled = structuredClone(old); relabelled.operations[0].result.schema_version = version;
    assert.throws(() => validatePddTask(relabelled), { code: 'INVALID_CHECKPOINT' });
  }

  const status = await run(['task-status', '--task', 'pdd-order-1', '--state-dir', directory]);
  assert.deepEqual([status.value.operations[0].order_list_url, status.value.operations[0].order_position], ['https://mobile.pinduoduo.com/orders.html', 1]);

  for (const task of ['pdd-orders', 'pdd-order-1']) {
    const output = path.join(directory, '..', `${task}-${process.pid}-${Date.now()}.md`);
    t.after(() => rm(output, { force: true }));
    const exported = await run(['report-export', '--task', task, '--state-dir', directory, '--format', 'markdown', '--output', output]);
    assert.equal(exported.code, 0, JSON.stringify(exported.value));
    const report = await readFile(output, 'utf8');
    assert.match(report, task === 'pdd-orders' ? /极速退款成功/ : /下单时间/);
    assert.doesNotMatch(report, PRIVATE);
  }

  // The tab now shows the order page, so a second detail task refuses before clicking.
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'pdd', '--task', 'pdd-order-1-again', '--source-task', 'pdd-orders', '--order-position', '1', ...common]);
  const again = await run(['task-run', '--task', 'pdd-order-1-again', ...common]);
  assert.notEqual(again.value.status, 'complete');
  assert.equal(cardClicks(server).length, 1);
});

test('an order page without 查看更多 is read without times; a login page after the click stops without a second click', async t => {
  const bare = await ordersBridge(t, { expandable: false });
  const bareDirectory = await stateDirectory(t);
  const unfolded = await listThenDetail(bare, bareDirectory);
  assert.equal(unfolded.value.status, 'complete', JSON.stringify(unfolded.value));
  const result = unfolded.value.operations[0].result;
  assert.deepEqual([result.entry.expand, result.times, result.coverage.info_expanded, result.missing.at(-1)], ['not_shown', [], false, 'order_times']);

  const server = await ordersBridge(t, { landing: 'https://mobile.pinduoduo.com/login.html?from=PRIVATE' });
  const directory = await stateDirectory(t);
  const ran = await listThenDetail(server, directory);
  assert.notEqual(ran.value.status, 'complete');
  assert.equal(ran.value.operations[0].error.code, 'LOGIN_REQUIRED');
  assert.deepEqual([cardClicks(server).length, expandClicks(server).length], [1, 0]);

  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  for (const [index, [args, code]] of [[['--orders'], 'INVALID_ARGUMENTS'], [['--orders', '--tab', '88', '--search', 'x'], 'INVALID_ARGUMENTS'],
    [['--order-position', '1'], 'INVALID_ARGUMENTS'], [['--source-task', 'pdd-orders', '--order-position', '9'], 'INVALID_ARGUMENTS'],
    [['--source-task', 'pdd-order-1', '--order-position', '1'], 'SOURCE_TASK_NOT_READY']].entries()) {
    assert.equal((await run(['task-start', '--platform', 'pdd', '--task', `pdd-refused-${index}`, ...args, ...common])).value.error.code, code, args.join(' '));
  }
});
