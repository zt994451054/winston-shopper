import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseOrderDetailUrl, orderDetailTargetScript, validateOrderDetailTarget } from '../lib/order-target.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

const routes = ['https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=123',
  'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=123'];
const inspect = (target, url) => vm.runInNewContext(orderDetailTargetScript(target), { URL, location: { href:url },
  get document() { throw Error('No document access is allowed'); } });

for (const route of routes) {
  test('detail address binds the single string ID without returning unrelated parameters: ' + new URL(route).hostname, () => {
    const target = parseOrderDetailUrl(route), raw = inspect(target, route + '&account=PRIVATE#PRIVATE');
    const result = validateOrderDetailTarget(raw, target);
    assert.equal(result.order_id, '123'); assert.equal(result.url, route);
    assert.equal(result.route_order_binding_verified, true); assert.equal(result.printed_order_id_verified, false);
    assert.equal(result.account_identity_verified, false); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });
}

for (const url of [routes[0].replace('=123','=124'), routes[0] + '&bizOrderId=123', routes[0].replace('bizOrderId','other'),
  routes[0].replace('https:','http:'), routes[0].replace('trade.tmall.com','trade.tmall.com.example.test'),
  routes[0].replace('trade.tmall.com','user:secret@trade.tmall.com'), routes[0].replace('trade.tmall.com','trade.tmall.com:8443'), routes[1]]) {
  test('changed/ambiguous detail identity fails before DOM: ' + url, () => {
    const target = parseOrderDetailUrl(routes[0]);
    assert.throws(() => validateOrderDetailTarget(inspect(target,url),target), {code:'TARGET_CHANGED'});
  });
}

test('detail login navigation remains an explicit user gate', () => {
  const target = parseOrderDetailUrl(routes[0]);
  for (const host of ['login.taobao.com','login.tmall.com']) {
    assert.throws(() => validateOrderDetailTarget(inspect(target,`https://${host}/?account=PRIVATE`),target), {code:'LOGIN_REQUIRED'});
  }
});

test('missing or mismatched saved detail IDs fail before IO', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  for (const target of [null,{}, {url:routes[0]}, {url:routes[0],order_id:'124'}, {url:routes[0],order_id:123}]) {
    assert.throws(() => orderDetailTargetScript(target), {code:'INVALID_TARGET'});
    await assert.rejects(bridge.readOrderDetailTarget(41,target), {code:'INVALID_TARGET'});
  }
  await assert.rejects(bridge.readOrderDetailTarget(0,parseOrderDetailUrl(routes[0])), {code:'INVALID_TAB'});
  assert.equal(server.state.requests.length,0);
});

test('untrusted detail responses cannot claim printed identity or leak account fields', () => {
  const target = parseOrderDetailUrl(routes[0]);
  for (const value of [null,[], {state:'observed',...target,printed_order_id_verified:true},
    {state:'observed',...target,order_id:'124'}, {state:'observed',...target,url:routes[0]+'&account=PRIVATE'},
    {state:'login_required',account:'PRIVATE'}]) assert.throws(() => validateOrderDetailTarget(value,target), {code:'INVALID_RESPONSE'});
});

test('detail bridge performs exactly one evaluation and never retries changed identity', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint), target = parseOrderDetailUrl(routes[0]);
  server.state.metadata = {state:'observed',...target};
  assert.equal((await bridge.readOrderDetailTarget(41,target)).printed_order_id_verified,false);
  assert.deepEqual(server.state.commands.map(command=>command.action),['eval']);
  server.state.metadata = {state:'target_changed'};
  await assert.rejects(bridge.readOrderDetailTarget(41,target), {code:'TARGET_CHANGED'});
  assert.equal(server.state.commands.length,2);
});
