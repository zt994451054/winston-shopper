import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BrowserBridge } from '../lib/bridge.mjs';
import { savedTabUrl } from '../lib/saved-tab.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { validateCartRows } from '../lib/cart-rows.mjs';
import { parseCartUrl } from '../lib/cart-target.mjs';
import { cartRow, observeCart } from '../test-support/cart-fixture.mjs';
import { isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

const CART_URL = 'https://cart.taobao.com/cart.htm';

test('a saved tab is found in the current window first, then by its ID in another window, and is missing otherwise', async () => {
  let probes = 0;
  const bridge = (listed, address) => ({ listTabs: async () => listed, readTabAddress: async () => { probes += 1; return address; } });
  assert.equal(await savedTabUrl(bridge([{ id: 41, url: CART_URL }], null), 41), CART_URL);
  assert.equal(probes, 0, 'a listed tab needs no probe');
  assert.equal(await savedTabUrl(bridge([{ id: 42, url: 'https://example.test/' }], CART_URL), 41), CART_URL);
  await assert.rejects(savedTabUrl(bridge([], null), 41, 'gone'), { code: 'TARGET_MISSING', message: 'gone' });
  await assert.rejects(savedTabUrl({ listTabs: async () => [] }, 41), { code: 'TARGET_MISSING' }, 'bridges that cannot read other windows behave as before');
  await assert.rejects(savedTabUrl(bridge([], CART_URL), 0), { code: 'INVALID_TAB' });
});

test('the extension bridge reads an unlisted tab address by ID, treats an unreachable tab as missing and keeps other failures', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  server.state.otherWindowTabs = [{ id: 77, url: CART_URL }];
  assert.equal(await bridge.readTabAddress(77), CART_URL);
  assert.equal(await bridge.readTabAddress(78), null);
  assert.deepEqual(server.state.commands.filter(isAddressProbe).map(command => command.tabId), [77, 78]);
  const unsupported = new BrowserBridge(server.endpoint);
  Object.defineProperty(unsupported, 'protocol', { value: 'unsupported' });
  const before = server.state.commands.length;
  assert.equal(await unsupported.readTabAddress(77), null);
  assert.equal(server.state.commands.length, before, 'other backends send nothing');
  const broken = await mockBridge(t, { handler({ res }) { res.statusCode = 500; res.end('{}'); } });
  await assert.rejects(new BrowserBridge(broken.endpoint).readTabAddress(77), { code: 'BRIDGE_HTTP_ERROR' });
});

test('a cart task keeps reading when the user has switched to another window, and still pauses when the tab is gone', async t => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping saved tab '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const target = parseCartUrl(CART_URL);
  const rows = validateCartRows(observeCart([cartRow(1).row]), target);
  let reachable = true;
  const bridge = { endpoint: 'http://127.0.0.1:19824', protocol: 'playwright-extension', async requireConnected() {},
    async listTabs() { return [{ id: 9, url: 'https://example.test/' }]; },
    async readTabAddress(id) { return reachable && id === 41 ? CART_URL : null; },
    async readCartRows() { return rows; } };
  await createTask({ stateDirectory, task: 'cart', cart: true, tabId: 41, bridge });
  assert.equal((await runTask({ stateDirectory, task: 'cart', bridge })).status, 'complete');
  await createTask({ stateDirectory, task: 'cart-again', cart: true, tabId: 41, bridge });
  reachable = false;
  assert.equal((await runTask({ stateDirectory, task: 'cart-again', bridge })).status, 'waiting_connection');
});
