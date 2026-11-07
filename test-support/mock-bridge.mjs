import http from 'node:http';
import { BRIDGE_CAPABILITIES } from '../lib/bridge-protocol.mjs';

/** @param {boolean} [connected] Synthetic connection state. @returns {object} Current service status, without browser IO. */
export function playwrightStatus(connected = true) {
  return { running: true, extensionConnected: connected, backend: 'playwright-extension', protocol_version: 1,
    instance_id: '11111111-1111-4111-8111-111111111111', state: connected ? 'ready' : 'disconnected',
    mcp_running: true, capabilities: [...BRIDGE_CAPABILITIES], error_code: connected ? null : 'EXTENSION_DISCONNECTED' };
}

/** @param {object} body A command body. @returns {boolean} Whether it is the bridge's read of one saved tab's address by ID. */
export function isAddressProbe(body) {
  return body?.action === 'eval' && typeof body.script === 'string' && body.script.includes('"tab_address"');
}

/**
 * Answer an address probe like the extension: a tab in another window (state.otherWindowTabs) reports its address,
 * and any other unlisted tab is unreachable.
 */
export function answerAddressProbe(body, state, send) {
  const tab = (state.otherWindowTabs ?? []).find(item => item.id === body.tabId);
  send(tab ? { id: body.id, success: true, data: { result: { state: 'tab_address', url: tab.url } } } : { id: body.id, success: false, error: 'No tab with id' });
}

/** Create a loopback test server. onTabShow observes the default handler's synthetic display acknowledgement. */
export async function mockBridge(t, { handler, onTabShow } = {}) {
  const state = {
    connected: true, commands: [], requests: [], otherWindowTabs: [],
    tabs: [
      { id: 41, url: 'https://detail.tmall.com/item.htm?id=123&token=PRIVATE_TRACKING', title: 'Unneeded title' },
      { id: 42, url: 'https://mail.example.test/inbox?token=PRIVATE_TOKEN', title: 'PRIVATE_MAIL_TITLE' },
      { id: 43, url: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?buyer=PRIVATE_BUYER', title: 'PRIVATE_ORDER_TITLE' },
    ],
    metadata: { state: 'observed', origin: 'https://detail.tmall.com', pathname: '/item.htm', product_id: '123', title: 'Example mouse' },
  };
  const server = http.createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : null;
    state.requests.push({ method: req.method, url: req.url });
    if (body) state.commands.push(body);
    if (handler) return handler({ req, res, body, state });
    res.setHeader('Content-Type', 'application/json');
    if (isAddressProbe(body)) return answerAddressProbe(body, state, value => res.end(JSON.stringify(value)));
    if (req.url === '/status') {
      res.end(JSON.stringify(playwrightStatus(state.connected)));
      return;
    }
    if (body.action === 'tab_show') {
      const data = onTabShow ? await onTabShow(body) : { visible: true };
      res.end(JSON.stringify({ id: body.id, success: true, data }));
      return;
    }
    res.end(JSON.stringify({ id: body.id, success: true,
      data: body.action === 'tab_list' ? { tabs: state.tabs } : { result: state.metadata } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { state, server, endpoint: `http://127.0.0.1:${server.address().port}` };
}
