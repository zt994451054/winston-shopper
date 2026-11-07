import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge, PACED_METHODS } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { failureCategory } from '../lib/task-policy.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { jdOrdersScript, validateJdOrders } from '../lib/jd/orders.mjs';
import { jdOrderDetailClickScript, validateJdOrderDetailClick } from '../lib/jd/order-entry.mjs';
import { jdOrderDetailScript, validateJdOrderDetail } from '../lib/jd/order-detail.mjs';
import {
  jdOrderDetailResult, newJdOrderDetailReadState, runJdOrderDetailRead, validateJdOrderDetailReadState, validateJdOrderDetailResult,
} from '../lib/jd/order-detail-read.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { jdOrdersPage } from '../test-support/jd-orders-fixture.mjs';
import { SYNTHETIC_PHONE, jdOrderDetailPage } from '../test-support/jd-order-detail-fixture.mjs';

const ORDER_LIST = 'https://order.jd.com/center/list.action';
// The first default card on the synthetic order list.
const ORDER_ID = '123456789012';
const detailUrl = (orderId = ORDER_ID) => `https://details.jd.com/normal/item.action?orderid=${orderId}&PassKey=SYNTHETICKEY`;
const PRIVATE = ['合成收货人', '合成路1号', '138****0000', '合成配送员', `${SYNTHETIC_PHONE}`, '合成代付人', '合成签收人', '合成昵称甲',
  '在线支付', 'PassKey', 'SYNTHETICKEY', 'img.synthetic.invalid', '合成收货地址示例路1号', '立即购买', '查看发票'];

function absent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of PRIVATE) assert.equal(text.includes(secret), false, `${secret} must not be kept`);
}

function clock() {
  let time = 1_000_000;
  return { now: () => time, wait: async ms => { time += ms; } };
}

/**
 * Browser stand-in: the real page scripts run against the synthetic list and detail pages. `opens` says what the click
 * does to the tab inventory: one detail tab (default), nothing, two detail tabs or a login page.
 */
function fakeBrowser({ opens = 'detail', openAfterChecks = 0, list = jdOrdersPage(), detail = jdOrderDetailPage({ orderId: ORDER_ID }), hooks = {} } = {}) {
  const calls = [];
  const tabs = [{ id: 89, url: ORDER_LIST }, { id: 41, url: 'https://www.jd.com/' }];
  let listings = 0, clickedAt = null;
  const opened = {
    detail: [{ id: 90, url: detailUrl() }],
    none: [],
    two: [{ id: 90, url: detailUrl() }, { id: 91, url: detailUrl() }],
    login: [{ id: 90, url: 'https://passport.jd.com/new/login.aspx?ReturnUrl=x' }],
    risk: [{ id: 90, url: 'https://pc-frequent-pro.pf.jd.com/' }],
    loginTwo: [{ id: 90, url: 'https://passport.jd.com/new/login.aspx' }, { id: 91, url: 'https://passport.jd.com/new/login.aspx' }],
    other: [{ id: 90, url: detailUrl('999999999999') }],
  }[opens];
  return {
    calls, tabs, detail,
    async readJdOrders(tabId, target) {
      calls.push('list');
      return validateJdOrders(list.evaluate(jdOrdersScript(target)), target);
    },
    async listTabs() {
      listings += 1;
      if (clickedAt !== null && listings - clickedAt > openAfterChecks) {
        for (const tab of opened) if (!tabs.some(item => item.id === tab.id)) tabs.push(tab);
      }
      return tabs.map(tab => ({ ...tab }));
    },
    async clickJdOrderDetail(tabId, target, position, orderId) {
      calls.push('click');
      if (hooks.beforeClick) hooks.beforeClick();
      const result = validateJdOrderDetailClick(list.evaluate(jdOrderDetailClickScript(target, position, orderId)));
      clickedAt = listings;
      if (hooks.afterClick) hooks.afterClick();
      return result;
    },
    async readJdOrderDetail(tabId, orderId) {
      calls.push(`read:${tabId}`);
      const raw = detail.evaluate(jdOrderDetailScript(orderId));
      const observedAt = '2026-10-19T09:00:00.000Z';
      validateJdOrderDetail(raw, orderId, { observedAt });
      return { observed_at: observedAt, raw };
    },
    async closeJdOrderDetailTab(tabId) {
      calls.push(`close:${tabId}`);
      if (hooks.closeError) throw hooks.closeError;
      tabs.splice(tabs.findIndex(tab => tab.id === tabId), 1);
      return { closed: true };
    },
  };
}

function operation(position = 1) {
  return { tab_id: 89, target: { platform: 'jd', url: ORDER_LIST }, recovery_kind: null, order_detail_read: newJdOrderDetailReadState(position) };
}

/** Run one visit; every commit checks the journal, and a refusal must leave it valid. */
async function drive(browser, op = operation(), timer = clock()) {
  const commit = async () => validateJdOrderDetailReadState(op.order_detail_read, op.tab_id);
  try {
    const result = await runJdOrderDetailRead({ bridge: browser, op, commit, now: timer.now, wait: timer.wait });
    validateJdOrderDetailResult(result, op.target, op.order_detail_read, op.tab_id);
    return { result, op };
  } catch (error) {
    validateJdOrderDetailReadState(op.order_detail_read, op.tab_id);
    error.op = op;
    throw error;
  }
}

const clicksOn = page => page.evaluate('[...document.querySelectorAll(\'[class*="detailLink-"]\')].map(node => node.clicks)').reduce((a, b) => a + b, 0);

test('new JD login and risk tabs are displayed only after pausing, without adopting them as detail pages or choosing ambiguous tabs', async t => {
  for (const opens of ['login', 'risk', 'loginTwo', 'detail']) {
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd blocked order '));
    t.after(() => rm(stateDirectory, { recursive: true, force: true }));
    const bridge = Object.assign(fakeBrowser({ opens }), { endpoint: 'http://127.0.0.1:19825', protocol: 'playwright-extension' });
    if (opens === 'detail') bridge.readJdOrderDetail = async () => { throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic verification'); };
    const options = { stateDirectory, task: 'sample', platform: 'jd', orderDetail: true, tabId: 89, orderPosition: 1, bridge };
    await createTask(options);
    const seen = [];
    bridge.showTab = async tabId => { seen.push({ tabId, saved: await loadTask(stateDirectory, 'sample') }); throw new Error('Synthetic display failure'); };
    const paused = await runTask(options, clock());
    assert.equal(paused.operations[0].error.code, opens === 'risk' ? 'RATE_LIMITED' : opens === 'detail' ? 'VERIFICATION_REQUIRED' : 'LOGIN_REQUIRED');
    assert.equal(seen.length, opens === 'loginTwo' ? 0 : 1);
    if (seen.length) { assert.equal(seen[0].tabId, 90); assert.equal(seen[0].saved.status, opens === 'risk' ? 'waiting_cooldown' : 'waiting_user'); }
    const saved = await loadTask(stateDirectory, 'sample');
    assert.equal(saved.operations[0].order_detail_read.detail_tab_id, opens === 'detail' ? 90 : null);
    assert.ok(!JSON.stringify(saved).includes('blockedTabId'));
    assert.equal(bridge.calls.filter(call => call === 'click').length, 1);
  }
});

test('one order detail: read the list, click once, find the new tab, read it and close it', async () => {
  const browser = fakeBrowser({ openAfterChecks: 1 });
  const { result, op } = await drive(browser);
  assert.deepEqual(browser.calls, ['list', 'click', 'read:90', 'close:90']);
  assert.equal(browser.tabs.some(tab => tab.id === 90), false, 'the detail tab is closed');
  const journal = op.order_detail_read;
  assert.deepEqual([journal.reads, journal.checks, journal.click, journal.click_error, journal.detail_tab_id, journal.close],
    [2, 1, 'clicked', null, 90, 'closed']);
  assert.deepEqual(journal.tabs_before, [89, 41]);
  assert.deepEqual([result.schema_version, result.platform, result.source, result.order_list_url, result.order_position, result.order_id,
    result.order_id_on_page, result.split_order, result.status_text], [1, 'jd', 'jd_order_detail_page', ORDER_LIST, 1, ORDER_ID, ORDER_ID, false, '完成']);
  assert.deepEqual(result.items.map(item => [item.product_id, item.url, item.quantity]),
    [['10086011', 'https://item.jd.com/10086011.html', 1], ['10086012', 'https://item.jd.com/10086012.html', 2]]);
  assert.deepEqual(result.amounts.map(amount => amount.label), ['商品总价', '运费', '实付款']);
  assert.deepEqual(result.opening, { list_observed_at: journal.entry.observed_at, click: 'clicked', click_error: null, tab_checks: 1,
    reads_reserved: 2, detail_tab_closed: true, close_error: null });
  assert.deepEqual(result.coverage, { status: 'partial', scope: 'single_order_detail_page', consignee_read: false, tracking_records_read: false,
    payment_tab_read: false, invoice_read: false, amount_meaning_verified: false });
  assert.ok(result.excluded.includes('pass_key') && result.excluded.includes('consignee') && result.excluded.includes('tracking_records'));
  assert.deepEqual(result, jdOrderDetailResult(journal, op.target));
  absent(result);
  absent(journal);
});

test('a split child order keeps its flag; a different printed order id is a changed target', async () => {
  const split = await drive(fakeBrowser({ detail: jdOrderDetailPage({ orderId: '1234567890123456' }), opens: 'none' }), operation(3)).catch(error => error);
  // The fake opens no tab, so the run stops after the checks; the list entry itself is what this case checks.
  assert.equal(split.code, 'ORDER_DETAIL_NOT_OPENED');
  assert.deepEqual(split.op.order_detail_read.entry.split_order, true);
  assert.equal(split.op.order_detail_read.entry.order_id, '1234567890123456');

  const printed = jdOrderDetailPage({ orderId: ORDER_ID, orderIdText: '订单号：880000000009' });
  await assert.rejects(drive(fakeBrowser({ detail: printed })), { code: 'TARGET_CHANGED' });
});

test('no detail tab after three checks stops the task, and a later run never clicks again', async () => {
  const list = jdOrdersPage();
  const browser = fakeBrowser({ opens: 'none', list });
  const error = await drive(browser).catch(value => value);
  assert.equal(error.code, 'ORDER_DETAIL_NOT_OPENED');
  assert.equal(failureCategory(error.code), 'diagnostic');
  assert.match(error.nextAction, /pop-ups for order\.jd\.com/);
  assert.deepEqual(browser.calls, ['list', 'click']);
  assert.equal(error.op.order_detail_read.checks, 3);
  assert.equal(clicksOn(list), 1);
  await assert.rejects(drive(browser, error.op), { code: 'ORDER_DETAIL_NOT_OPENED' });
  assert.deepEqual(browser.calls, ['list', 'click']);
  assert.equal(clicksOn(list), 1);
});

test('two new detail tabs, a login page or another order are never chosen', async () => {
  await assert.rejects(drive(fakeBrowser({ opens: 'two' })), { code: 'ORDER_DETAIL_TAB_AMBIGUOUS' });
  const login = await drive(fakeBrowser({ opens: 'login' })).catch(value => value);
  assert.equal(login.code, 'LOGIN_REQUIRED');
  assert.equal(login.op.order_detail_read.checks, 0, 'a login page pauses without spending a check');
  const other = await drive(fakeBrowser({ opens: 'other' })).catch(value => value);
  assert.equal(other.code, 'ORDER_DETAIL_NOT_OPENED');
});

test('a refused click releases its reservation; an unacknowledged or interrupted click is spent and never repeated', async () => {
  const changed = fakeBrowser({ hooks: {} });
  const op = operation();
  // Read the list first, then change the saved order id so the page refuses the click.
  const entryOnly = { ...changed, clickJdOrderDetail: async () => { throw Object.assign(new ShoppingError('BRIDGE_UNAVAILABLE', 'x'), { actionNotDispatched: true }); } };
  await assert.rejects(drive(entryOnly, op), { code: 'BRIDGE_UNAVAILABLE' });
  assert.deepEqual([op.order_detail_read.click_reserved, op.order_detail_read.tabs_before, op.order_detail_read.click], [false, null, null]);
  op.order_detail_read.entry.order_id = '999999999999';
  await assert.rejects(drive(changed, op), { code: 'ORDER_DETAIL_ENTRY_CHANGED' });
  assert.deepEqual([op.order_detail_read.click_reserved, op.order_detail_read.click], [false, null]);

  const timeout = fakeBrowser({ hooks: { afterClick: () => { throw new ShoppingError('BRIDGE_TIMEOUT', 'x'); } } });
  const { result } = await drive(timeout);
  assert.deepEqual([result.opening.click, result.opening.click_error], ['uncertain', 'BRIDGE_TIMEOUT']);

  const interrupted = fakeBrowser();
  const saved = operation();
  Object.assign(saved.order_detail_read, { entry: { observed_at: '2026-10-19T08:59:00.000Z', order_id: ORDER_ID, split_order: false }, reads: 1,
    tabs_before: [89, 41], click_reserved: true });
  // The earlier process may have clicked: the detail tab is already there.
  interrupted.tabs.push({ id: 90, url: detailUrl() });
  const resumed = await drive(interrupted, saved);
  assert.deepEqual(interrupted.calls, ['read:90', 'close:90']);
  assert.deepEqual([resumed.result.opening.click, resumed.result.opening.click_error], ['uncertain', 'READ_INTERRUPTED']);
});

test('the list position must be loaded and have an entry; a failed close is recorded, not retried', async () => {
  await assert.rejects(drive(fakeBrowser(), operation(5)), { code: 'ORDER_POSITION_NOT_LOADED' });
  // The second default card has no 订单详情 entry.
  await assert.rejects(drive(fakeBrowser(), operation(2)), { code: 'ORDER_DETAIL_ENTRY_MISSING' });
  const browser = fakeBrowser({ hooks: { closeError: Object.assign(new ShoppingError('TAB_ADDRESS_CHANGED', 'x'), { actionNotDispatched: true }) } });
  const { result } = await drive(browser);
  assert.deepEqual([result.opening.detail_tab_closed, result.opening.close_error], [false, 'TAB_ADDRESS_CHANGED']);
  assert.equal(browser.calls.filter(call => call.startsWith('close')).length, 1);
  assert.throws(() => newJdOrderDetailReadState(0), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => newJdOrderDetailReadState(11), { code: 'INVALID_ARGUMENTS' });
});

test('the journal refuses steps out of order, foreign tabs and a result it does not yield', async () => {
  const { result, op } = await drive(fakeBrowser());
  const good = op.order_detail_read;
  for (const change of [
    state => { state.detail_tab_id = 89; },
    state => { state.detail_tab_id = 41; },
    state => { state.detail = null; },
    state => { state.click = 'uncertain'; },
    state => { state.click_reserved = false; state.tabs_before = null; },
    state => { state.entry.order_id = 'abc'; },
    state => { state.reads = 5; },
    state => { state.checks = 4; },
    state => { state.close = 'closed later'; },
    state => { state.extra = 1; },
    state => { state.detail.raw.items[0].product_id = 'x'; },
  ]) {
    const state = structuredClone(good);
    change(state);
    assert.throws(() => validateJdOrderDetailReadState(state, 89), { code: 'INVALID_CHECKPOINT' });
  }
  const forged = structuredClone(result);
  forged.amounts[0].value_text = '¥1.00';
  assert.throws(() => validateJdOrderDetailResult(forged, op.target, good, 89), { code: 'INVALID_CHECKPOINT' });
  const open = structuredClone(good);
  open.close = null;
  assert.throws(() => validateJdOrderDetailResult(result, op.target, open, 89), { code: 'INVALID_CHECKPOINT' });
});

test('the click is paced as a page load, the detail read as a read; closing and tab listing are not paced', () => {
  assert.deepEqual(PACED_METHODS.clickJdOrderDetail, ['load', 'page']);
  assert.deepEqual(PACED_METHODS.readJdOrderDetail, ['read']);
  assert.equal(Object.hasOwn(PACED_METHODS, 'closeJdOrderDetailTab'), false);
  assert.equal(Object.hasOwn(PACED_METHODS, 'listTabs'), false);
});

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

/** Loopback bridge: list tab 89 and, after the click script runs on it, a detail tab 90. tab_close removes a tab. */
function browserServer(t, list, detail) {
  return mockBridge(t, { handler: ({ req, res, body, state }) => {
    res.setHeader('Content-Type', 'application/json');
    const send = data => res.end(JSON.stringify({ id: body.id, success: true, data }));
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return send({ tabs: state.tabs });
    if (body.action === 'tab_close') {
      state.tabs = state.tabs.filter(tab => tab.id !== body.tabId);
      return send({});
    }
    if (body.action === 'eval' && body.script.includes('"tab_address"')) return res.end(JSON.stringify({ id: body.id, success: false, error: 'No tab with id' }));
    if (body.action === 'eval' && body.tabId === 89) {
      const result = list.evaluate(body.script);
      if (result?.state === 'clicked') state.tabs.push({ id: 90, url: detailUrl() });
      return send({ result });
    }
    if (body.action === 'eval' && body.tabId === 90) return send({ result: detail.evaluate(body.script) });
    res.end(JSON.stringify({ id: body.id, success: false, error: 'unsupported' }));
  } });
}

test('a JD order detail task runs through the bridge, saves a checked result and exports Markdown and CSV without private text', async t => {
  const list = jdOrdersPage();
  const detail = jdOrderDetailPage({ orderId: ORDER_ID });
  const { endpoint, state } = await browserServer(t, list, detail);
  state.tabs = [{ id: 89, url: ORDER_LIST }, { id: 41, url: 'https://s.taobao.com/search?q=mouse&page=1&tab=all' }];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd order detail '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const [extra, code] of [
    [['--order-detail', '--tab', '89'], 'INVALID_ARGUMENTS'],
    [['--order-detail', '--order-position', '1'], 'INVALID_ARGUMENTS'],
    [['--orders', '--tab', '89', '--order-position', '1'], 'INVALID_ARGUMENTS'],
    [['--order-detail', '--orders', '--tab', '89', '--order-position', '1'], 'INVALID_ARGUMENTS'],
    [['--order-detail', '--tab', '89', '--order-position', '11'], 'INVALID_ARGUMENTS'],
    [['--order-detail', '--tab', '89', '--order-position', '1', '--source-task', 'x'], 'UNSUPPORTED_PLATFORM'],
    [['--order-detail', '--tab', '89', '--order-position', '1', '--order-body'], 'UNSUPPORTED_PLATFORM'],
  ]) {
    assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, code, extra.join(' '));
  }
  const created = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-order-1', '--order-detail', '--tab', '89', '--order-position', '1']);
  assert.deepEqual([created.code, created.value.task_kind, created.value.platform, created.value.products], [0, 'jd_order_detail', 'jd', 0]);

  const timer = clock();
  const bridge = new BrowserBridge(endpoint);
  const ran = await runTask({ stateDirectory: directory, task: 'jd-order-1', bridge }, timer);
  assert.equal(ran.status, 'complete', JSON.stringify(ran.operations[0].error));
  const operation = ran.operations[0];
  assert.deepEqual([operation.order_list_url, operation.order_position, operation.actions_reserved, operation.dom_observations_reserved, ran.distinct_products],
    [ORDER_LIST, 1, 1, 2, null]);
  assert.deepEqual(state.tabs.map(tab => tab.id), [89, 41], 'only the detail tab the task opened is closed');
  assert.deepEqual(state.commands.filter(command => command.action === 'tab_close').map(command => command.tabId), [90]);
  const evals = state.commands.filter(command => command.action === 'eval' && !command.script.includes('"tab_address"'));
  assert.deepEqual(evals.map(command => [command.tabId, /^\(function (\w+)/.exec(command.script)?.[1]]),
    [[89, 'collectJdOrders'], [89, 'clickJdOrderDetailEntry'], [90, 'collectJdOrderDetail']]);
  assert.equal(clicksOn(list), 1);
  absent(operation.result);

  const status = await run(['task-status', '--state-dir', directory, '--task', 'jd-order-1']);
  assert.deepEqual(status.value.operations[0].result, operation.result);
  const markdown = path.join(directory, '..', `jd-order-1-${path.basename(directory)}.md`);
  const csv = path.join(directory, '..', `jd-order-1-${path.basename(directory)}.csv`);
  t.after(() => Promise.all([rm(markdown, { force: true }), rm(csv, { force: true })]));
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-order-1', '--format', 'markdown', '--output', markdown])).code, 0);
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-order-1', '--format', 'csv', '--output', csv])).code, 0);
  const rows = await readFile(csv, 'utf8');
  for (const pattern of [/"order",[^\n]*"'123456789012"[^\n]*split_order=false; order_id_on_page=123456789012/,
    /"order_detail_opening",[^\n]*"clicked"[^\n]*tab_checks=0; reads_reserved=2; detail_tab_closed=true/,
    /"order_status",[^\n]*"完成"/, /"order_progress",[^\n]*"合成提交订单"[^\n]*"2026-09-20 16:24:17"/,
    /"order_shipping",[^\n]*"送货方式： 承运人：合成运输"/,
    /"order_item",[^\n]*"'10086012"[^\n]*"合成耳机收纳盒","https:\/\/item.jd.com\/10086012.html"[^\n]*京东价=¥29.00; 京豆数量=3/,
    /"order_amount",[^\n]*"实付款","¥152.00"/, /"coverage",[^\n]*"scope","single_order_detail_page"/,
    /"coverage",[^\n]*"consignee_read","false"/, /"missing_field",[^\n]*"tracking_records"/]) {
    assert.match(rows, pattern);
  }
  absent(rows);
  absent(await readFile(markdown, 'utf8'));

  const file = path.join(directory, 'tasks', 'jd-order-1.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.operations[0].result.amounts[0].value_text = '¥1.00';
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'jd-order-1'])).value.error.code, 'INVALID_CHECKPOINT');
});

test('a blocked pop-up stops the JD order detail task with its own code and holds no other platform', async t => {
  const list = jdOrdersPage();
  const { endpoint, state } = await mockBridge(t, { handler: ({ req, res, body, state: shared }) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: shared.tabs } }));
    if (body.action === 'eval' && body.tabId === 89) return res.end(JSON.stringify({ id: body.id, success: true, data: { result: list.evaluate(body.script) } }));
    res.end(JSON.stringify({ id: body.id, success: false, error: 'unsupported' }));
  } });
  state.tabs = [{ id: 89, url: ORDER_LIST }, { id: 41, url: 'https://s.taobao.com/search?q=mouse&page=1&tab=all' }];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd order detail '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-order-1', '--order-detail', '--tab', '89', '--order-position', '1']);
  const ran = await runTask({ stateDirectory: directory, task: 'jd-order-1', bridge: new BrowserBridge(endpoint) }, clock());
  assert.deepEqual([ran.status, ran.operations[0].error.code, ran.operations[0].order_detail_tab_checks], ['stopped', 'ORDER_DETAIL_NOT_OPENED', 3]);
  assert.equal(clicksOn(list), 1);
  const taobao = await run(['task-start', ...common, '--task', 'taobao-search', '--search', 'mouse', '--tab', '41']);
  assert.deepEqual([taobao.code, taobao.value.task_kind], [0, 'search']);
});
