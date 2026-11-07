import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BrowserBridge, PACED_METHODS } from '../lib/bridge.mjs';
import { searchTarget } from '../lib/search.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { priceSearchPage } from '../test-support/search-price-fixture.mjs';

const root = searchTarget('Synthetic mouse');
const searchUrl = 'https://s.taobao.com/search?page=1&q=Synthetic%20mouse&tab=all';

function recordingPacer({ limitOnLoad = false } = {}) {
  const calls = [];
  return { calls,
    async before(kind, category) {
      calls.push(['before', kind, category ?? null]);
      if (limitOnLoad && kind === 'load') {
        const error = new ShoppingError('PACING_LIMIT', 'synthetic quota'); error.actionNotDispatched = true; error.allowedAt = 1; throw error;
      }
    },
    async after(kind, outcome = {}) { calls.push(['after', kind, outcome.dispatched ?? true]); } };
}

async function daemon(t, page) {
  const server = await mockBridge(t, { handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: 41, url: searchUrl }] } });
    if (body.action === 'eval') return send({ id: body.id, success: true, data: { result: JSON.parse(JSON.stringify(vm.runInNewContext(body.script, page.context))) } });
    if (body.action === 'tab_new') return send({ id: body.id, success: true, data: { tabId: 88, title: 'x', url: body.url.includes('item.htm') ? `${body.url}&spm=tracking` : body.url } });
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
  return server;
}

test('every public page method is classified for pacing; metadata methods are deliberately unpaced', () => {
  // closeTab, closeJdOrderDetailTab, readTabAddress and showTab only touch the local tab and send nothing to the platform.
  const unpaced = new Set(['constructor', 'status', 'requireConnected', 'listTabs', 'usePacer', 'closeTab', 'closeJdOrderDetailTab', 'readTabAddress', 'showTab']);
  const methods = Object.getOwnPropertyNames(BrowserBridge.prototype).filter(name => !unpaced.has(name));
  assert.deepEqual(methods.filter(name => !Object.hasOwn(PACED_METHODS, name)), []);
  for (const [name, [kind, category]] of Object.entries(PACED_METHODS)) {
    assert.ok(['read', 'action', 'load'].includes(kind), name);
    assert.equal(kind === 'load', ['search', 'page'].includes(category), name);
  }
  for (const name of ['pickPriceDirection', 'confirmPriceRange', 'selectSalesSort', 'nextSearchCollectionPage', 'navigateSearch', 'openSearchPage']) {
    assert.deepEqual(PACED_METHODS[name], ['load', 'search'], name);
  }
  for (const name of ['openOrderDetailEntry', 'openProductPage', 'openOrderListPage']) assert.deepEqual(PACED_METHODS[name], ['load', 'page'], name);
});

test('reads and loads are paced around the real call; certain non-dispatch is reported to the pacer', async t => {
  const page = priceSearchPage(), server = await daemon(t, page), pacer = recordingPacer();
  const bridge = new BrowserBridge(server.endpoint).usePacer(pacer);
  await bridge.readSearchPrice(41, root);
  await assert.rejects(bridge.pickPriceDirection(41, root, '从低到高'), { code: 'PRICE_CONTROL_UNAVAILABLE' });
  page.hover('价格');
  await bridge.pickPriceDirection(41, root, '从低到高');
  assert.deepEqual(pacer.calls, [['before', 'read', null], ['after', 'read', true], ['before', 'load', 'search'], ['after', 'load', false],
    ['before', 'load', 'search'], ['after', 'load', true]]);
  assert.throws(() => bridge.usePacer(pacer), { code: 'INVALID_ARGUMENTS' });
});

test('an exhausted quota sends no command at all and is marked undispatched', async t => {
  const page = priceSearchPage(), server = await daemon(t, page);
  page.hover('价格');
  const bridge = new BrowserBridge(server.endpoint).usePacer(recordingPacer({ limitOnLoad: true }));
  const before = server.state.commands.length;
  const error = await bridge.pickPriceDirection(41, root, '从低到高').catch(value => value);
  assert.equal(error.code, 'PACING_LIMIT'); assert.equal(error.actionNotDispatched, true);
  assert.equal(server.state.commands.length, before); assert.equal(page.state.direction, null);
});

test('the skill opens canonical search and product pages itself, as metered loads', async t => {
  const page = priceSearchPage(), server = await daemon(t, page), pacer = recordingPacer();
  const bridge = new BrowserBridge(server.endpoint).usePacer(pacer);
  assert.deepEqual(await bridge.openSearchPage('Synthetic mouse'), { tab_id: 88, kind: 'search', url_matches: true });
  assert.equal(server.state.commands.at(-1).url, 'https://s.taobao.com/search?q=Synthetic%20mouse&page=1&tab=all');
  assert.deepEqual(await bridge.openProductPage('https://detail.tmall.com/item.htm?id=123&spm=a&skuId=9'), { tab_id: 88, kind: 'product', url_matches: true });
  assert.equal(server.state.commands.at(-1).url, 'https://detail.tmall.com/item.htm?id=123');
  const commands = server.state.commands.length;
  await assert.rejects(bridge.openProductPage('https://example.test/item.htm?id=1'), error => error.code === 'INVALID_ARGUMENTS' && error.actionNotDispatched);
  assert.equal(server.state.commands.length, commands);
  assert.deepEqual(pacer.calls.filter(call => call[0] === 'before'), [['before', 'load', 'search'], ['before', 'load', 'page'], ['before', 'load', 'page']]);
  assert.deepEqual(await bridge.openOrderListPage(), { tab_id: 88, kind: 'orders', url_matches: true });
  assert.equal(server.state.commands.at(-1).url, 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm');
});
