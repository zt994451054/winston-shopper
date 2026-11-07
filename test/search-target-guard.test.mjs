import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BrowserBridge } from '../lib/bridge.mjs';
import { searchTarget } from '../lib/search.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const target = searchTarget('books');
async function fixture(t, url = target.url, next = rawSearch(target), tabs = []) {
  const server = await mockBridge(t, { handler: ({ req, res, body }) => {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs } });
    let value;
    if (body.script.includes('function inspectSortTarget')) {
      const document = new Proxy({}, { get() { throw new Error('Address probe must not read DOM'); } });
      value = vm.runInNewContext(body.script, { URL, location: { href: url }, document });
    } else value = next;
    send({ id: body.id, success: true, data: { result: value } });
  } });
  return { bridge: new BrowserBridge(server.endpoint), state: server.state };
}

test('first-page search missing from currentWindow checks the exact saved address and reads once', async t => {
  const f = await fixture(t, target.url + '&spm=PRIVATE_TRACKING');
  const result = await f.bridge.readSearch(51, target);
  assert.equal(result.state, 'ready');
  assert.deepEqual(f.state.commands.map(c => c.action), ['tab_list', 'eval', 'eval']);
  assert.ok(f.state.commands.slice(1).every(c => c.tabId === 51));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TRACKING'));
});

test('first-page fallback rejects later pages, different queries, filters and homepages before content reads', async t => {
  for (const url of [target.url.replace('page=1', 'page=2'), target.url.replace('books', 'other'),
    target.url + '&sort=price', target.url + '&filter=private', 'https://www.taobao.com/', 'https://example.com/']) {
    const f = await fixture(t, url);
    await assert.rejects(f.bridge.readSearch(51, target), { code: 'TARGET_CHANGED' });
    assert.deepEqual(f.state.commands.map(c => c.action), ['tab_list', 'eval']);
  }
});

test('login address and content gates pause search reads without being treated as inventory failures', async t => {
  const login = await fixture(t, 'https://login.taobao.com/member/login.jhtml');
  await assert.rejects(login.bridge.readSearch(51, target), { code: 'LOGIN_REQUIRED' });
  for (const [state, code] of [['verification_required', 'VERIFICATION_REQUIRED'], ['target_changed', 'TARGET_CHANGED'], ['rate_limited', 'RATE_LIMITED']]) {
    const f = await fixture(t, target.url, { state });
    await assert.rejects(f.bridge.readSearch(51, target), { code });
    assert.equal(f.state.commands.length, 3);
  }
});

test('a listed different target is never overridden by the saved-address fallback', async t => {
  const f = await fixture(t, target.url, rawSearch(target), [{ id: 51, url: 'https://example.com/' }]);
  await assert.rejects(f.bridge.readSearch(51, target), { code: 'TARGET_CHANGED' });
  assert.deepEqual(f.state.commands.map(c => c.action), ['tab_list']);
});

test('unlisted search navigation refuses the action before dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.navigateSearch(51, target), error => error.code === 'TARGET_MISSING' && error.actionNotDispatched === true);
  assert.deepEqual(f.state.commands.map(c => c.action), ['tab_list']);
});
