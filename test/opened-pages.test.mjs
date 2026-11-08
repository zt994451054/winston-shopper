import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../lib/cli.mjs';
import { closeDecision, pageStillMatches } from '../lib/opened-pages.mjs';
import { playwrightStatus, answerAddressProbe, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

const QUERY = 'Synthetic mouse';
const SEARCH_URL = `https://s.taobao.com/search?q=${encodeURIComponent(QUERY)}&page=1&tab=all`;

test('a recorded page still matches after later pages, sorting or tracking, but not after it shows something else', () => {
  const search = { kind: 'search', key: QUERY };
  assert.equal(pageStillMatches(search, SEARCH_URL), true);
  assert.equal(pageStillMatches(search, `https://s.taobao.com/search?q=${encodeURIComponent(QUERY)}&page=3&sort=sale-desc&spm=a1`), true);
  assert.equal(pageStillMatches(search, 'https://s.taobao.com/search?q=other&page=1'), false);
  assert.equal(pageStillMatches(search, `https://login.taobao.com/search?q=${encodeURIComponent(QUERY)}`), false);
  assert.equal(pageStillMatches({ kind: 'product', key: '5' }, 'https://item.taobao.com/item.htm?id=5&spm=x'), true);
  assert.equal(pageStillMatches({ kind: 'product', key: '5' }, 'https://item.taobao.com/item.htm?id=6'), false);
  assert.equal(pageStillMatches({ kind: 'orders', key: null }, 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'), true);
  assert.equal(pageStillMatches({ kind: 'orders', key: null }, 'https://login.taobao.com/member/login.jhtml'), false);
  assert.equal(pageStillMatches({ kind: 'cart', key: null }, 'https://cart.taobao.com/cart.htm?spm=a1'), true);
  assert.equal(pageStillMatches({ kind: 'cart', key: null }, 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'), false);
  assert.equal(pageStillMatches({ kind: 'order_detail', key: '77' }, 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=77&spm=a'), true);
  assert.equal(pageStillMatches({ kind: 'order_detail', key: '77' }, 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=78'), false);
});

test('only tabs opened by page-open or an order entry task may close, and never while an unfinished task uses them', () => {
  const page = { tab_id: 88, kind: 'search', key: QUERY, opened_at: '2026-10-13T00:00:00.000Z', url_matches: true, closed_at: null };
  const task = (id, status, kind, tabId, detailTabId) => ({ id, status, kind, updated_at: '2026-10-13T00:00:00.000Z',
    operations: [{ tab_id: tabId, target: { order_id: '77' }, ...(detailTabId ? { order_detail_check: { detail_tab_id: detailTabId } } : {}) }] });
  assert.deepEqual(closeDecision({ tabId: 88, pages: [page], tasks: [task('done', 'complete', 'search', 88)] }),
    { source: 'page_open', platform: 'taobao', kind: 'search', key: QUERY }, 'an entry without a platform is a Taobao page');
  assert.deepEqual(closeDecision({ tabId: 90, pages: [], tasks: [task('entry', 'complete', 'order_detail_check', 43, 90)] }),
    { source: 'order_entry_task', platform: 'taobao', kind: 'order_detail', key: '77', task: 'entry' });
  for (const status of ['pending', 'waiting_user', 'awaiting_batch', 'stopped']) {
    assert.throws(() => closeDecision({ tabId: 88, pages: [page], tasks: [task('busy', status, 'search', 88)] }), { code: 'TAB_IN_USE' });
  }
  assert.throws(() => closeDecision({ tabId: 90, pages: [], tasks: [task('entry', 'waiting_connection', 'order_detail_check', 43, 90)] }), { code: 'TAB_IN_USE' });
  assert.throws(() => closeDecision({ tabId: 88, pages: [{ ...page, closed_at: '2026-10-13T00:01:00.000Z' }], tasks: [] }), { code: 'TAB_NOT_OPENED_BY_PROGRAM' });
  const workflow = status => ({ id: 'order-read', status, tab_id: 88 });
  assert.throws(() => closeDecision({ tabId: 88, pages: [page], tasks: [], workflows: [workflow('pending')] }), { code: 'TAB_IN_USE' });
  assert.equal(closeDecision({ tabId: 88, pages: [page], tasks: [], workflows: [workflow('complete'), workflow('ended')] }).source, 'page_open');
  assert.throws(() => closeDecision({ tabId: 41, pages: [page], tasks: [] }), { code: 'TAB_NOT_OPENED_BY_PROGRAM' });
});

async function browser(t) {
  return mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_new') { state.tabs.push({ id: 88, url: body.url }); return send({ id: body.id, success: true, data: { tabId: 88, url: body.url } }); }
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: state.tabs } });
    if (body.action === 'tab_close') {
      state.tabs = state.tabs.filter(tab => tab.id !== body.tabId);
      state.otherWindowTabs = state.otherWindowTabs.filter(tab => tab.id !== body.tabId);
      return send({ id: body.id, success: true, data: {} });
    }
    if (isAddressProbe(body)) return answerAddressProbe(body, state, send);
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

async function cli(t, server) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping page close '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const run = async (...args) => {
    let output = '';
    const local = args[0] === 'task-end';
    const code = await main([...args, '--state-dir', stateDirectory, ...(local ? [] : ['--endpoint', server.endpoint])], { write: value => { output += value; } });
    return { code, value: JSON.parse(output) };
  };
  return { stateDirectory, run };
}

const closes = server => server.state.commands.filter(command => command.action === 'tab_close');

test('page-open records the tab and page-close closes it once, always naming the tab ID', async t => {
  const server = await browser(t);
  const { stateDirectory, run } = await cli(t, server);
  assert.equal((await run('page-open', '--search', ` ${QUERY} `)).value.tab_id, 88);
  const ledger = JSON.parse(await readFile(path.join(stateDirectory, 'opened-pages.json'), 'utf8'));
  assert.deepEqual(ledger.pages.map(page => [page.tab_id, page.kind, page.key, page.closed_at]), [[88, 'search', QUERY, null]]);
  const closed = await run('page-close', '--tab', '88');
  assert.equal(closed.code, 0);
  assert.deepEqual(closed.value, { schema_version: 1, command: 'page-close', ok: true, status: 'page_closed', tab_id: 88, platform: 'taobao', kind: 'search', source: 'page_open' });
  assert.deepEqual(closes(server).map(command => command.tabId), [88]);
  assert.ok(!server.state.tabs.some(tab => tab.id === 88));
  const again = await run('page-close', '--tab', '88');
  assert.equal(again.value.error.code, 'TAB_NOT_OPENED_BY_PROGRAM');
  assert.equal(closes(server).length, 1);
});

test('page-close refuses unrecorded tabs, changed addresses, missing tabs and tabs an unfinished task uses, sending no close', async t => {
  const server = await browser(t);
  const { stateDirectory, run } = await cli(t, server);
  assert.equal((await run('page-close', '--tab', '41')).value.error.code, 'TAB_NOT_OPENED_BY_PROGRAM');
  assert.equal((await run('page-close')).value.error.code, 'INVALID_ARGUMENTS');
  await run('page-open', '--search', QUERY);
  const created = await run('task-start', '--task', 'busy-search', '--search', QUERY, '--tab', '88');
  assert.equal(created.value.status, 'task_created');
  const busy = await run('page-close', '--tab', '88');
  assert.equal(busy.value.error.code, 'TAB_IN_USE');
  assert.match(busy.value.error.message, /busy-search/);
  assert.equal((await run('task-end', '--task', 'busy-search')).value.status, 'ended');
  server.state.tabs.find(tab => tab.id === 88).url = 'https://s.taobao.com/search?q=other&page=1';
  assert.equal((await run('page-close', '--tab', '88')).value.error.code, 'TAB_ADDRESS_CHANGED');
  server.state.tabs = server.state.tabs.filter(tab => tab.id !== 88);
  assert.equal((await run('page-close', '--tab', '88')).value.error.code, 'TARGET_MISSING');
  assert.equal(closes(server).length, 0);
  const ledger = JSON.parse(await readFile(path.join(stateDirectory, 'opened-pages.json'), 'utf8'));
  assert.equal(ledger.pages[0].closed_at, null);
});

test('an unreadable record stops page-open before any tab is created', async t => {
  const server = await browser(t);
  const { stateDirectory, run } = await cli(t, server);
  await writeFile(path.join(stateDirectory, 'opened-pages.json'), '{"schema_version":1,"pages":[{"tab_id":"x"}]}');
  const result = await run('page-open', '--search', QUERY);
  assert.equal(result.value.error.code, 'INVALID_OPENED_PAGES');
  assert.equal(server.state.commands.filter(command => command.action === 'tab_new').length, 0);
});

test('page-close also closes a recorded tab that is now in another browser window, checking its address by ID', async t => {
  const server = await browser(t);
  const { run } = await cli(t, server);
  await run('page-open', '--search', QUERY);
  // The user switched windows: the tab is no longer in the extension's current-window list.
  server.state.otherWindowTabs = server.state.tabs.filter(tab => tab.id === 88);
  server.state.tabs = server.state.tabs.filter(tab => tab.id !== 88);
  const closed = await run('page-close', '--tab', '88');
  assert.equal(closed.value.status, 'page_closed');
  assert.deepEqual(closes(server).map(command => command.tabId), [88]);
  assert.equal(server.state.otherWindowTabs.length, 0);
});

// 2026-11-08: a PDD order list tab moved to the order detail through the program's own click, and page-close refused it.
test('a PDD tab may be closed on the pages the program reaches by clicking in that tab', () => {
  const orders = { platform: 'pdd', kind: 'orders', key: null };
  assert.equal(pageStillMatches(orders, 'https://mobile.pinduoduo.com/orders.html'), true);
  assert.equal(pageStillMatches(orders, 'https://mobile.pinduoduo.com/order.html?order_sn=261105-123456789012345'), true);
  const search = { platform: 'pdd', kind: 'search', key: '无线鼠标' };
  assert.equal(pageStillMatches(search, 'https://mobile.pinduoduo.com/goods.html?goods_id=123456'), true);
  assert.equal(pageStillMatches(search, 'https://mobile.pinduoduo.com/goods_comments.html?goods_id=123456'), true);
  assert.equal(pageStillMatches(search, 'https://mobile.pinduoduo.com/order.html?order_sn=261105-123456789012345'), false);
  assert.equal(pageStillMatches(orders, 'https://mobile.pinduoduo.com/goods.html?goods_id=123456'), false);
  assert.equal(pageStillMatches(orders, 'https://mobile.pinduoduo.com/login.html'), false);
});

// 2026-11-08: a 海外自营 JD product tab left item.jd.com and page-close refused it; the same product number on another JD site may close.
test('a JD product tab may be closed after the product moved to another JD site, but not on another product or site', () => {
  const product = { platform: 'jd', kind: 'product', key: '2669346' };
  assert.equal(pageStillMatches(product, 'https://item.jd.com/2669346.html'), true);
  assert.equal(pageStillMatches(product, 'https://npcitem.jd.hk/2669346.html?from=item'), true);
  assert.equal(pageStillMatches(product, 'https://npcitem.jd.hk/2669347.html'), false);
  assert.equal(pageStillMatches(product, 'https://pc-frequent-pro.pf.jd.com/?reason=403'), false);
  assert.equal(pageStillMatches(product, 'https://item.jd.hk.example.com/2669346.html'), false);
});
