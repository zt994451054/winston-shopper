import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseOrderListUrl, orderListTargetScript, validateOrderListTarget } from '../lib/order-target.mjs';
import { summarizeTab } from '../lib/targets.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

const route = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const target = parseOrderListUrl(route);
const inspect = url => vm.runInNewContext(orderListTargetScript(target), { URL, location: { href: url } });

test('order-list target removes private query values but asserts no page, filter or account state', () => {
  const parsed = parseOrderListUrl(route + '?buyer=PRIVATE&order=PRIVATE#PRIVATE');
  assert.deepEqual(parsed, target);
  const result = validateOrderListTarget(inspect(route + '?buyer=PRIVATE'), target);
  assert.equal(result.page_state, 'not_assessed'); assert.equal(result.filters_verified, false);
  assert.equal(result.account_identity_verified, false); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

for (const url of ['http://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
  'https://sellertrade.taobao.com/trade/itemlist/list_sold_items.htm',
  'https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=123',
  'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm/',
  'https://buyertrade.taobao.com:8443/trade/itemlist/list_bought_items.htm',
  'https://user:secret@buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
  'https://buyertrade.taobao.com.example.test/trade/itemlist/list_bought_items.htm']) {
  test(`reject unsupported list identity ${url.split('?')[0]}`, () => {
    assert.equal(parseOrderListUrl(url), null);
    assert.throws(() => orderListTargetScript({ url }), { code: 'INVALID_TARGET' });
    assert.throws(() => validateOrderListTarget({ state: 'observed', url }, { url }), { code: 'INVALID_TARGET' });
  });
}

test('address expression rejects unrelated/private pages without reading their documents', () => {
  const raw = inspect('https://mail.example.test/inbox?secret=PRIVATE');
  assert.throws(() => validateOrderListTarget(raw, target), { code: 'TARGET_CHANGED' });
  assert.equal(JSON.stringify(raw).includes('PRIVATE'), false);
});

test('official login navigation preserves the user gate rather than claiming a loaded order list', () => {
  for (const host of ['login.taobao.com', 'login.tmall.com']) {
    assert.throws(() => validateOrderListTarget(inspect(`https://${host}/?account=PRIVATE`), target), { code: 'LOGIN_REQUIRED' });
  }
});

test('untrusted page responses cannot add account or order fields to an address-only observation', () => {
  for (const value of [null, [], { state: 'observed', url: route, account: 'PRIVATE' },
    { state: 'observed', url: route + '?buyer=PRIVATE' }, { state: 'login_required', token: 'PRIVATE' }]) {
    assert.throws(() => validateOrderListTarget(value, target), { code: 'INVALID_RESPONSE' });
  }
});

test('fresh inventory marks only the buyer list and never leaks its query or a detail order ID', () => {
  assert.deepEqual(summarizeTab({ id: 41, url: route + '?buyer=PRIVATE#PRIVATE' }),
    { tab_id: 41, origin: target.origin, kind: 'orders_list', url: route });
  const detail = summarizeTab({ id: 42, url: 'https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=PRIVATE' });
  assert.deepEqual(detail, { tab_id: 42, origin: target.origin, kind: 'other' });
});

test('production address bridge performs one fixed evaluation and returns no order fields', async t => {
  const server = await mockBridge(t); server.state.metadata = { state: 'observed', url: route };
  const bridge = new BrowserBridge(server.endpoint);
  assert.equal((await bridge.readOrderListTarget(41, target)).page_state, 'not_assessed');
  assert.deepEqual(server.state.commands.map(command => command.action), ['eval']);
  assert.equal(server.state.commands[0].tabId, 41);
});

test('invalid target/tab fail before any browser request and bridge never retries a changed target', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  await assert.rejects(bridge.readOrderListTarget(41, { url: 'https://mail.example.test/' }), { code: 'INVALID_TARGET' });
  await assert.rejects(bridge.readOrderListTarget(0, target), { code: 'INVALID_TAB' });
  assert.equal(server.state.requests.length, 0);
  server.state.metadata = { state: 'target_changed' };
  await assert.rejects(bridge.readOrderListTarget(41, target), { code: 'TARGET_CHANGED' });
  assert.equal(server.state.commands.length, 1);
});
