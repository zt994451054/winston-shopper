import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBridge, normalizeEndpoint } from '../lib/bridge.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawDetails } from '../test-support/detail-fixture.mjs';
import { searchTarget } from '../lib/search.mjs';

test('details absent from the current window use the exact saved tab, check its address then read once', async t => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123'); let evaluations = 0;
  const { endpoint, state } = await mockBridge(t, { handler: ({req, res, body}) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    const data = body.action === 'tab_list' ? {tabs:[]} : {result: ++evaluations === 1 ? {url:target.url,state:'observed'} : rawDetails()};
    res.end(JSON.stringify({id:body.id,success:true,data}));
  }});
  const result = await new BrowserBridge(endpoint).readDetails(41, target);
  assert.equal(result.product_id, '123'); assert.equal(result.details.schema_version, 2);
  assert.deepEqual(state.commands.map(c => c.action), ['tab_list','eval','eval']);
  assert.ok(state.commands.slice(1).every(c => c.tabId === 41));
  assert.ok(!state.commands[1].script.includes('document'));
});

test('failed, mismatched or login address checks stop before detail DOM and do not retry', async t => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  for (const [reply, code] of [[{state:'target_changed'},'TARGET_CHANGED'],[{state:'login_required'},'LOGIN_REQUIRED'],
    [{state:'observed',url:'https://detail.tmall.com/item.htm?id=999'},'INVALID_RESPONSE'],[null,'BROWSER_COMMAND_FAILED']]) {
    let evaluations = 0;
    const {endpoint} = await mockBridge(t, {handler:({req,res,body})=>{
      if(req.url==='/status') return res.end(JSON.stringify(playwrightStatus()));
      if(body.action==='tab_list') return res.end(JSON.stringify({id:body.id,success:true,data:{tabs:[]}}));
      evaluations += 1;
      res.end(JSON.stringify(reply ? {id:body.id,success:true,data:{result:reply}} : {id:body.id,success:false,error:'PRIVATE'}));
    }});
    await assert.rejects(new BrowserBridge(endpoint).readDetails(41,target),{code}); assert.equal(evaluations,1);
  }
});

test('a product navigation race after a valid saved-address check cannot produce details', async t => {
  const target=parseProductUrl('https://detail.tmall.com/item.htm?id=123');let evaluations=0;
  const {endpoint}=await mockBridge(t,{handler:({req,res,body})=>{
    if(req.url==='/status')return res.end(JSON.stringify(playwrightStatus()));
    const data=body.action==='tab_list'?{tabs:[]}:{result:++evaluations===1?{state:'observed',url:target.url}:{state:'target_changed'}};
    res.end(JSON.stringify({id:body.id,success:true,data}));
  }});
  await assert.rejects(new BrowserBridge(endpoint).readDetails(41,target),{code:'TARGET_CHANGED'});assert.equal(evaluations,2);
});

test('price-region diagnostics recheck the saved target and send one fixed read without pointer commands', async t => {
  const { endpoint, state } = await mockBridge(t), target = searchTarget('mouse');
  state.tabs = [{ id: 41, url: target.url }];
  state.metadata = { state: 'observed', price_region: { price_direction: null } };
  const bridge = new BrowserBridge(endpoint);
  assert.equal((await bridge.inspectPriceRegion(41, target)).price_region.price_direction, null);
  assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval']);
  assert.equal(state.commands[1].tabId, 41);
  assert.ok(state.commands[1].script.includes('elementsFromPoint'));
  state.commands.length = 0; state.tabs[0].url = 'https://example.com/';
  await assert.rejects(bridge.inspectPriceRegion(41, target), { code: 'TARGET_CHANGED' });
  assert.deepEqual(state.commands.map(command => command.action), ['tab_list']);
});

test('only explicit loopback origins are accepted', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:19824/'), 'http://127.0.0.1:19824');
  assert.equal(normalizeEndpoint('http://[::1]:19824'), 'http://[::1]:19824');
  for (const url of ['https://example.com', 'http://localhost:19824', 'http://127.0.0.1@evil.test',
    'http://secret:token@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?q=token',
    'http://127.0.0.1#token', 'file:///tmp/x', 'not a url']) {
    assert.throws(() => normalizeEndpoint(url), { code: 'INVALID_ENDPOINT' });
  }
});

test('running daemon without extension does not issue browser commands', async t => {
  const { endpoint, state } = await mockBridge(t);
  state.connected = false;
  await assert.rejects(new BrowserBridge(endpoint).requireConnected(), { code: 'EXTENSION_DISCONNECTED' });
  assert.equal(state.commands.length, 0);
});

test('a CDP-like status is not mistaken for an extension bridge', async t => {
  const { endpoint } = await mockBridge(t, { handler: ({ res }) => res.end(JSON.stringify({ Browser: 'Chrome', running: true })) });
  await assert.rejects(new BrowserBridge(endpoint).status(), { code: 'INCOMPATIBLE_BRIDGE' });
});

test('redirects are rejected without following the destination', async t => {
  let followed = 0;
  const destination = await mockBridge(t, { handler: ({ res }) => { followed++; res.end('{}'); } });
  const source = await mockBridge(t, { handler: ({ res }) => { res.writeHead(302, { Location: destination.endpoint }); res.end(); } });
  await assert.rejects(new BrowserBridge(source.endpoint).status(), { code: 'BRIDGE_REDIRECT' });
  assert.equal(followed, 0);
  assert.equal(source.state.requests.length, 1);
});

test('a stalled response reaches a deadline with no retry', async t => {
  const { endpoint, state } = await mockBridge(t, { handler: () => {} });
  await assert.rejects(new BrowserBridge(endpoint, { timeoutMs: 80 }).status(), { code: 'BRIDGE_TIMEOUT' });
  assert.equal(state.requests.length, 1);
});

test('response size is bounded', async t => {
  const { endpoint } = await mockBridge(t, { handler: ({ res }) => res.end('x'.repeat(262145)) });
  await assert.rejects(new BrowserBridge(endpoint).status(), { code: 'RESPONSE_TOO_LARGE' });
});

test('detail reads accept bounded long parameters and reject responses above 1 MiB', async t => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const raw = rawDetails();
  raw.details.attributes = { observed: true, rows_seen: 100,
    items: Array.from({ length: 100 }, (_, index) => ({ name: `参数${index}`, value: '字'.repeat(1500), source: 'general_parameters' })) };
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > 262144);
  const { endpoint, state } = await mockBridge(t);
  state.metadata = raw;
  const bridge = new BrowserBridge(endpoint);
  assert.equal((await bridge.readDetails(41, target)).details.attributes.items.length, 100);
  state.metadata = { oversized: 'x'.repeat(1048577) };
  await assert.rejects(bridge.readDetails(41, target), { code: 'RESPONSE_TOO_LARGE' });
});

test('related review reads allow a bounded larger payload while still rejecting responses above 1 MiB', async t => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const reply = { raw: '商家回复：' + '字'.repeat(995) };
  const raw = { schema_version: 2, state: 'observed', product_id: target.product_id, url: target.url,
    total_text: '用户评价·100+', loaded_count: 20, fold_notice_text: '',
    reviews: new Array(20).fill({ body: '字'.repeat(2000), purchase_text: '', seller_replies: [reply, reply],
      followups: [{ raw: '7天后追评：' + '字'.repeat(994), interval_text: '7天后追评：', seller_replies: [reply, reply] }] }) };
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > 262144);
  let oversized = false;
  const { endpoint } = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 41, url: target.url }] } }));
    if (oversized) return res.end('x'.repeat(1048577));
    res.end(JSON.stringify({ id: body.id, success: true, data: { result: raw } }));
  } });
  const bridge = new BrowserBridge(endpoint);
  assert.equal((await bridge.readReviews(41, target)).result.returned_count, 20);
  oversized = true;
  await assert.rejects(bridge.readReviews(41, target), { code: 'RESPONSE_TOO_LARGE' });
});

test('invalid JSON produces a stable error', async t => {
  const { endpoint } = await mockBridge(t, { handler: ({ res }) => res.end('secret-token: not json') });
  await assert.rejects(new BrowserBridge(endpoint).status(), { code: 'INVALID_RESPONSE' });
});

test('mismatched command ID is rejected', async t => {
  const { endpoint } = await mockBridge(t, { handler: ({ res }) => res.end(JSON.stringify({ id: 'wrong', success: true, data: { tabs: [] } })) });
  await assert.rejects(new BrowserBridge(endpoint).listTabs(), { code: 'INVALID_RESPONSE' });
});

test('duplicate tab IDs are not accepted as an unambiguous inventory', async t => {
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [state.tabs[0], state.tabs[0]];
  await assert.rejects(new BrowserBridge(endpoint).listTabs(), { code: 'INVALID_RESPONSE' });
});

test('browser error bodies are withheld from public errors', async t => {
  const { endpoint } = await mockBridge(t, { handler: ({ res, body }) => res.end(JSON.stringify({
    id: body.id, success: false, error: 'cookie=PRIVATE_SECRET',
  })) });
  await assert.rejects(new BrowserBridge(endpoint).listTabs(), error => {
    assert.equal(error.code, 'BROWSER_COMMAND_FAILED');
    assert.ok(!String(error).includes('PRIVATE_SECRET'));
    return true;
  });
});

test('loopback bridge traffic does not use an outbound proxy from the environment', async t => {
  const destination = await mockBridge(t);
  let proxied = 0;
  const proxy = await mockBridge(t, { handler: ({ res }) => { proxied++; res.end('{}'); } });
  const moduleUrl = new URL('../lib/bridge.mjs', import.meta.url).href;
  const source = `import { BrowserBridge } from ${JSON.stringify(moduleUrl)};
    const result = await new BrowserBridge(${JSON.stringify(destination.endpoint)}).status();
    process.stdout.write(JSON.stringify(result));`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 10000,
    env: { ...process.env, HTTP_PROXY: proxy.endpoint, HTTPS_PROXY: proxy.endpoint, ALL_PROXY: proxy.endpoint,
      http_proxy: proxy.endpoint, https_proxy: proxy.endpoint, all_proxy: proxy.endpoint,
      NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' },
  });
  assert.equal(JSON.parse(result.stdout).extensionConnected, true);
  assert.equal(proxied, 0);
});
