import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseCartUrl, cartTargetScript, validateCartTarget } from '../lib/cart-target.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const target = { platform: 'taobao', origin: 'https://cart.taobao.com', pathname: '/cart.htm', url: 'https://cart.taobao.com/cart.htm' };

test('cart identity removes query and fragment values without inventing a product ID', () => {
  assert.deepEqual(parseCartUrl(`${target.url}?account=PRIVATE&token=PRIVATE#PRIVATE`), target);
  assert.equal(Object.hasOwn(target, 'product_id'), false);
});

test('only the observed HTTPS cart route is accepted', () => {
  for (const value of [null, {}, 'x'.repeat(16385), 'http://cart.taobao.com/cart.htm',
    'https://cart.taobao.com.evil.test/cart.htm', 'https://user:PRIVATE@cart.taobao.com/cart.htm',
    'https://cart.taobao.com:999/cart.htm', 'https://cart.taobao.com/cart.html',
    'https://cart.taobao.com/cart.htm/other', 'https://buyertrade.taobao.com/private', 'javascript:alert(1)']) {
    assert.equal(parseCartUrl(value), null);
  }
});

test('cart address check touches neither document, storage, network nor window selection', () => {
  const forbidden = new Proxy({}, { get() { throw new Error('Unexpected private page access'); } });
  const result = vm.runInNewContext(cartTargetScript(target), {
    URL, location: { href: `${target.url}?token=PRIVATE` }, document: forbidden, localStorage: forbidden,
    sessionStorage: forbidden, window: forbidden, fetch: forbidden,
  });
  assert.equal(result.state, 'observed');
  assert.equal(result.url, target.url);
  assert.equal(Object.keys(result).length, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('known login hosts return only the login state', () => {
  for (const host of ['login.taobao.com', 'login.tmall.com']) {
    const result = vm.runInNewContext(cartTargetScript(target), { URL, location: { href: `https://${host}/member/login.jhtml?account=PRIVATE` } });
    assert.equal(result.state, 'login_required');
    assert.equal(Object.keys(result).length, 1);
  }
});

test('changed addresses cannot expose an unrelated location or claim an empty cart', () => {
  for (const value of ['https://private.test/PRIVATE', 'https://cart.taobao.com/private?token=PRIVATE',
    'http://cart.taobao.com/cart.htm', 'https://login.taobao.com.evil.test/?token=PRIVATE',
    'https://user:PRIVATE@cart.taobao.com/cart.htm', 'https://cart.taobao.com:999/cart.htm']) {
    const result = vm.runInNewContext(cartTargetScript(target), { URL, location: { href: value } });
    assert.equal(result.state, 'target_changed');
    assert.equal(Object.keys(result).length, 1);
  }
});

test('invalid requested targets fail before generating a browser expression', () => {
  for (const value of [null, {}, {url:'https://private.test/'}]) assert.throws(() => cartTargetScript(value), {code:'INVALID_TARGET'});
});

test('valid address result proves identity only and returns no account or readiness evidence', () => {
  assert.deepEqual(validateCartTarget({state:'observed',url:target.url}, target), {url:target.url,page_state:'not_assessed'});
});

test('malformed and overclaimed address responses fail without returning external values', () => {
  for (const value of [null, {}, {state:'observed'}, {state:'observed',url:`${target.url}?token=PRIVATE`},
    {state:'observed',url:target.url,account:'PRIVATE'}, {state:'empty',url:target.url}, {state:'PRIVATE'}]) {
    assert.throws(() => validateCartTarget(value, target), {code:'INVALID_RESPONSE'});
  }
});

test('known login and changed states are reported with fixed safe errors', () => {
  assert.throws(() => validateCartTarget({state:'login_required'}, target), {code:'LOGIN_REQUIRED'});
  assert.throws(() => validateCartTarget({state:'target_changed'}, target), {code:'TARGET_CHANGED'});
});

test('bridge performs one fixed address-only read on the requested tab', async t => {
  const {endpoint,state} = await mockBridge(t);
  state.metadata = {state:'observed',url:target.url};
  const result = await new BrowserBridge(endpoint).readCartTarget(51, target);
  assert.deepEqual(result, {url:target.url,page_state:'not_assessed'});
  assert.deepEqual(state.commands.map(command => command.action), ['eval']);
  assert.equal(state.commands[0].tabId, 51);
  assert.equal(state.commands[0].script.includes('document'), false);
  assert.equal(state.commands[0].script.includes('storage'), false);
});

test('invalid cart input fails locally before the bridge or page is contacted', async t => {
  const {endpoint,state} = await mockBridge(t);
  const bridge = new BrowserBridge(endpoint);
  await assert.rejects(bridge.readCartTarget(51, {url:'https://private.test/'}), {code:'INVALID_TARGET'});
  await assert.rejects(bridge.readCartTarget(0, target), {code:'INVALID_TAB'});
  assert.equal(state.requests.length, 0);
});

test('disconnected extension cannot dispatch a cart address read', async t => {
  const {endpoint,state} = await mockBridge(t);
  state.connected = false;
  await assert.rejects(new BrowserBridge(endpoint).readCartTarget(51, target), {code:'EXTENSION_DISCONNECTED'});
  assert.equal(state.commands.length, 0);
});

test('failed cart address command never retries or exposes external error details', async t => {
  const {endpoint,state} = await mockBridge(t, {handler:({req,res,body})=>{
    if(req.url==='/status')return res.end(JSON.stringify(playwrightStatus()));
    res.end(JSON.stringify({id:body.id,success:false,error:'PRIVATE account or page failure'}));
  }});
  await assert.rejects(new BrowserBridge(endpoint).readCartTarget(51, target), error => {
    assert.equal(error.code, 'BROWSER_COMMAND_FAILED');
    assert.equal(error.message.includes('PRIVATE'), false);
    return true;
  });
  assert.equal(state.commands.length, 1);
});

test('login and navigation races stop at address validation without reading cart rows', async t => {
  const {endpoint,state} = await mockBridge(t);
  const bridge = new BrowserBridge(endpoint);
  for (const [reply,code] of [[{state:'login_required'},'LOGIN_REQUIRED'],[{state:'target_changed'},'TARGET_CHANGED'],
    [{state:'observed',url:'https://private.test/PRIVATE'},'INVALID_RESPONSE']]) {
    state.metadata = reply;
    const before = state.commands.length;
    await assert.rejects(bridge.readCartTarget(51, target), {code});
    assert.equal(state.commands.length, before + 1);
  }
});
