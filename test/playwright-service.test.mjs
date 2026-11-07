import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseAriaReferences, parseRunResult, PlaywrightService, serveBridgeProtocol } from '../lib/playwright-service.mjs';

const resultText = value => `### Result\n${JSON.stringify(JSON.stringify(value))}\n### Ran Playwright code\n\`\`\`js\nignored\n\`\`\``;

/** A small Page model; the service's generated code runs against it for real. */
function fakeBrowser(initial = []) {
  const log = [];
  const makePage = url => {
    const page = { address: url, url: () => page.address, context: () => context,
      goto: async target => { log.push(['goto', target]); page.address = target; },
      close: async () => { log.push(['close', page.address]); context.items = context.items.filter(item => item !== page); },
      evaluate: async script => {
        if (typeof script === 'function') return page.visibility ?? 'visible';
        log.push(['evaluate', script]); return page.evalResult;
      },
      bringToFront: async () => { log.push(['front', page.address]); },
      locator: selector => ({
        first() { return this; },
        ariaSnapshot: async options => { log.push(['snapshot', selector, options.mode]); return page.snapshot; },
        hover: async () => { log.push(['hover', selector]); },
        click: async () => { log.push(['click', selector]); },
        fill: async text => { log.push(['fill', selector, text]); page.value = text; },
        inputValue: async () => page.value,
      }) };
    return page;
  };
  const context = { items: initial.map(makePage), pages: () => context.items,
    newPage: async () => { const page = makePage('about:blank'); context.items.push(page); return page; } };
  const current = makePage('chrome-extension://abc/connect.html');
  context.items.unshift(current);
  const tools = { stopped: false, calls: [],
    async call(name, input) {
      tools.calls.push(name);
      if (name === 'browser_tabs') return '';
      const value = await new Function(`return (${input.code})`)()(current);
      return resultText(JSON.parse(value));
    },
    stop() { tools.stopped = true; } };
  return { tools, context, log, current };
}

const serviceFor = async (browser, firstTabId = 500) => {
  const service = new PlaywrightService({ tools: browser.tools, firstTabId, settleMs: 0 });
  await service.connect();
  return service;
};

test('parseRunResult reads the result line and refuses anything else', () => {
  assert.deepEqual(parseRunResult(resultText({ a: '### Result\n"x"' })), { a: '### Result\n"x"' });
  assert.throws(() => parseRunResult('### Error\nboom'), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseRunResult('### Result\nnot json'), { code: 'INVALID_RESPONSE' });
});

test('parseAriaReferences keeps interactive elements with role, name and a positive number', () => {
  const text = '- tablist [ref=e1]:\n  - tab "价格" [active] [ref=e2]\n  - link "a \\"b\\"" [ref=e30] [cursor=pointer]:\n    - button "深" [ref=e4]\n- textbox [ref=e5]';
  assert.deepEqual(parseAriaReferences(text), {
    e2: { role: 'tab', name: '价格', backendDOMNodeId: 2 },
    e30: { role: 'link', name: 'a "b"', backendDOMNodeId: 30 },
    e4: { role: 'button', name: '深', backendDOMNodeId: 4 },
    e5: { role: 'textbox', name: '', backendDOMNodeId: 5 },
  });
  assert.deepEqual(Object.keys(parseAriaReferences(text, 1)), ['e2', 'e30', 'e5']);
});

test('tab IDs start from the run offset, stay stable, and hide the connect tab', async () => {
  const browser = fakeBrowser(['https://a.example/', 'https://b.example/']);
  const service = await serviceFor(browser);
  const first = await service.command('tab_list');
  assert.deepEqual(first.tabs, [{ id: 500, url: 'https://a.example/' }, { id: 501, url: 'https://b.example/' }]);
  browser.context.items.splice(1, 1);
  assert.deepEqual((await service.command('tab_list')).tabs, [{ id: 501, url: 'https://b.example/' }]);
  await assert.rejects(service.command('eval', { tabId: 500, script: '1' }));
});

test('tab_new opens and labels a page; only web addresses are accepted', async () => {
  const browser = fakeBrowser();
  const service = await serviceFor(browser);
  assert.deepEqual(await service.command('tab_new', { url: 'https://s.example/q' }), { tabId: 500, url: 'https://s.example/q' });
  await assert.rejects(service.command('tab_new', { url: 'file:///etc/hosts' }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(browser.context.items.length, 2);
});

test('eval runs the exact script in the addressed tab and returns null for undefined', async () => {
  const browser = fakeBrowser(['https://a.example/', 'https://b.example/']);
  const service = await serviceFor(browser);
  await service.command('tab_list');
  const script = '(() => "引号\\"与\\n换行")()';
  browser.context.items[2].evalResult = { state: 'observed' };
  assert.deepEqual(await service.command('eval', { tabId: 501, script }), { result: { state: 'observed' } });
  assert.deepEqual(browser.log.at(-1), ['evaluate', script]);
  browser.context.items[2].evalResult = undefined;
  assert.deepEqual(await service.command('eval', { tabId: 501, script }), { result: null });
});

test('commands that act on a page need an explicit tab ID', async () => {
  const service = await serviceFor(fakeBrowser(['https://a.example/']));
  for (const action of ['eval', 'tab_close', 'snapshot', 'hover', 'click', 'fill']) {
    await assert.rejects(service.command(action, { script: '1', selector: 'a', ref: 'e1', text: 'x' }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(service.command('download', { tabId: 1 }), { code: 'INVALID_ARGUMENTS' });
});

test('snapshot gives references that hover, click and fill then acknowledge with role and name', async () => {
  const browser = fakeBrowser(['https://a.example/']);
  const service = await serviceFor(browser);
  await service.command('tab_list');
  browser.context.items[1].snapshot = '- tab "价格" [ref=e2]';
  const shot = await service.command('snapshot', { tabId: 500, selector: '#bar', interactive: true, compact: true, maxDepth: 3 });
  assert.equal(shot.url, 'https://a.example/');
  assert.deepEqual(shot.snapshotData.refs, { e2: { role: 'tab', name: '价格', backendDOMNodeId: 2 } });
  assert.equal((await service.command('hover', { tabId: 500, ref: 'e2' })).name, '价格');
  assert.equal((await service.command('click', { tabId: 500, ref: 'e2' })).role, 'tab');
  assert.deepEqual(await service.command('fill', { tabId: 500, ref: 'e2', text: '60' }), { role: 'tab', name: '价格', backendDOMNodeId: 2, filledText: '60' });
  assert.deepEqual(browser.log.filter(entry => entry[0] === 'click'), [['click', 'aria-ref=e2']]);
});

test('a reference from no snapshot, or from another tab, sends nothing', async () => {
  const browser = fakeBrowser(['https://a.example/', 'https://b.example/']);
  const service = await serviceFor(browser);
  await service.command('tab_list');
  browser.context.items[1].snapshot = '- tab "价格" [ref=e2]';
  await service.command('snapshot', { tabId: 500, selector: '#bar' });
  await assert.rejects(service.command('click', { tabId: 501, ref: 'e2' }), { code: 'TARGET_CHANGED' });
  await assert.rejects(service.command('click', { tabId: 500, ref: 'e9' }), { code: 'TARGET_CHANGED' });
  assert.equal(browser.log.filter(entry => entry[0] === 'click').length, 0);
});

test('tab_close closes the addressed tab and forgets its references', async () => {
  const browser = fakeBrowser(['https://a.example/']);
  const service = await serviceFor(browser);
  await service.command('tab_list');
  browser.context.items[1].snapshot = '- tab "价格" [ref=e2]';
  await service.command('snapshot', { tabId: 500, selector: '#bar' });
  await service.command('tab_close', { tabId: 500 });
  assert.deepEqual((await service.command('tab_list')).tabs, []);
  await assert.rejects(service.command('hover', { tabId: 500, ref: 'e2' }), { code: 'TARGET_CHANGED' });
});

test('hover raises the window only when its page is hidden', async () => {
  const browser = fakeBrowser(['https://a.example/']);
  const service = await serviceFor(browser);
  await service.command('tab_list');
  const page = browser.context.items[1];
  page.snapshot = '- tab "价格" [ref=e2]';
  await service.command('snapshot', { tabId: 500, selector: '#bar' });
  await service.command('hover', { tabId: 500, ref: 'e2' });
  assert.equal(browser.log.filter(entry => entry[0] === 'front').length, 0);
  page.visibility = 'hidden';
  await service.command('hover', { tabId: 500, ref: 'e2' });
  assert.deepEqual(browser.log.filter(entry => entry[0] === 'front'), [['front', 'https://a.example/']]);
  assert.equal(browser.log.filter(entry => entry[0] === 'hover').length, 2);
});

test('a failed hover on a hidden page raises once and never retries the pointer action', async () => {
  const browser = fakeBrowser(['https://a.example/']);
  const service = await serviceFor(browser);
  await service.command('tab_list');
  const page = browser.context.items[1];
  page.snapshot = '- tab "价格" [ref=e2]';
  await service.command('snapshot', { tabId: 500, selector: '#bar' });
  page.visibility = 'hidden';
  let attempts = 0;
  page.locator = () => ({ hover: async () => { attempts++; throw new Error('Synthetic hover failure'); } });
  await assert.rejects(service.command('hover', { tabId: 500, ref: 'e2' }), { code: 'BROWSER_COMMAND_FAILED' });
  assert.equal(attempts, 1);
  assert.deepEqual(browser.log.filter(entry => entry[0] === 'front'), [['front', 'https://a.example/']]);
});

test('tab_show raises only a hidden page and reports whether it is visible afterwards', async () => {
  const browser = fakeBrowser(['https://a.example/']);
  const service = await serviceFor(browser);
  await service.command('tab_list');
  const page = browser.context.items[1];
  assert.deepEqual(await service.command('tab_show', { tabId: 500 }), { visible: true });
  assert.equal(browser.log.filter(entry => entry[0] === 'front').length, 0);
  page.visibility = 'hidden';
  assert.deepEqual(await service.command('tab_show', { tabId: 500 }), { visible: false });
  page.bringToFront = async () => { browser.log.push(['front', page.address]); page.visibility = 'visible'; };
  assert.deepEqual(await service.command('tab_show', { tabId: 500 }), { visible: true });
  assert.equal(browser.log.filter(entry => entry[0] === 'front').length, 2);
  page.visibility = 'hidden';
  page.bringToFront = async () => { setTimeout(() => { page.visibility = 'visible'; }, 300); };
  assert.deepEqual(await service.command('tab_show', { tabId: 500 }), { visible: true });
});

test('only hover and tab_show may raise a hidden page; ordinary commands never select a window', async () => {
  const browser = fakeBrowser(['https://a.example/']);
  const codes = [];
  const call = browser.tools.call;
  browser.tools.call = async (name, input) => { codes.push(`${name} ${JSON.stringify(input)}`); return call(name, input); };
  const service = await serviceFor(browser);
  await service.connect();
  await service.command('tab_list');
  browser.context.items[1].snapshot = '- tab "价格" [ref=e2]';
  browser.context.items[1].visibility = 'hidden';
  await service.command('snapshot', { tabId: 500, selector: '#bar' });
  await service.command('hover', { tabId: 500, ref: 'e2' });
  await service.command('tab_new', { url: 'https://s.example/' });
  await service.command('eval', { tabId: 500, script: '1' });
  await service.command('click', { tabId: 500, ref: 'e2' });
  await service.command('fill', { tabId: 500, ref: 'e2', text: 'synthetic' });
  await service.command('tab_close', { tabId: 500 });
  assert.ok(codes.length >= 5);
  assert.ok(codes.every(code => !code.includes('"action":"select"')));
  assert.equal(codes.filter(code => code.includes('bringToFront')).length, 1);
  assert.ok(codes.find(code => code.includes('bringToFront')).includes('hover('));
  assert.deepEqual(browser.log.filter(entry => entry[0] === 'front'), [['front', 'https://a.example/']]);
});

test('connect waits for the settle time before reporting connected', async () => {
  const browser = fakeBrowser();
  const waits = [];
  const service = new PlaywrightService({ tools: browser.tools, firstTabId: 1, settleMs: 5000, wait: async ms => { waits.push([ms, service.connected]); } });
  await service.connect();
  assert.deepEqual(waits, [[5000, false]]);
  assert.equal(service.connected, true);
});

test('a first connection failure has a fixed error code and is never retried', async () => {
  const browser = fakeBrowser();
  browser.tools.call = async () => { browser.tools.calls.push('failed'); throw new Error('PRIVATE_CONNECTION_TEXT'); };
  const service = new PlaywrightService({ tools: browser.tools, settleMs: 0 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(service.connect(), error => {
      assert.equal(error.code, 'PLAYWRIGHT_CONNECT_FAILED');
      assert.ok(!error.message.includes('PRIVATE_CONNECTION_TEXT'));
      return true;
    });
  }
  assert.equal(browser.tools.calls.length, 1);
  assert.equal(service.state, 'failed');
  assert.equal(service.connected, false);
});

test('commands run one at a time, and one failure does not block the next', async () => {
  const browser = fakeBrowser(['https://a.example/']);
  const service = await serviceFor(browser);
  await service.command('tab_list');
  const order = [];
  const failing = service.command('eval', { tabId: 999, script: '1' }).catch(() => order.push('failed'));
  const working = service.command('tab_list').then(() => order.push('listed'));
  await Promise.all([failing, working]);
  assert.deepEqual(order, ['failed', 'listed']);
});

test('stop closes only the connect tab and stops the connection', async () => {
  const browser = fakeBrowser(['https://a.example/']);
  const service = await serviceFor(browser);
  await service.connect();
  await service.stop();
  assert.deepEqual(browser.context.items.map(item => item.url()), ['https://a.example/']);
  assert.equal(browser.tools.stopped, true);
  assert.equal(service.connected, false);
});

const request = (port, { method = 'GET', path = '/status', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers }, async response => {
    let text = '';
    for await (const chunk of response) text += chunk;
    resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
  });
  req.once('error', reject);
  req.end(body);
});

test('the HTTP layer speaks the bridge protocol, withholds failure text and refuses web pages', async t => {
  const browser = fakeBrowser(['https://a.example/']);
  const service = await serviceFor(browser);
  const server = await serveBridgeProtocol(service, { port: 0 });
  t.after(() => server.close());
  const { port } = server.address();
  const json = { 'Content-Type': 'application/json' };
  const status = (await request(port)).body;
  assert.equal(status.running, true);
  assert.equal(status.extensionConnected, true);
  assert.equal(status.backend, 'playwright-extension');
  assert.equal(status.protocol_version, 1);
  await service.connect();
  assert.equal((await request(port)).body.extensionConnected, true);
  const listed = await request(port, { method: 'POST', path: '/command', headers: json, body: JSON.stringify({ id: 'x', action: 'tab_list' }) });
  assert.deepEqual(listed.body, { id: 'x', success: true, data: { tabs: [{ id: 500, url: 'https://a.example/' }] } });
  const failed = await request(port, { method: 'POST', path: '/command', headers: json, body: JSON.stringify({ id: 'y', action: 'eval', tabId: 999, script: '1' }) });
  assert.deepEqual(failed.body, { id: 'y', success: false });
  assert.equal((await request(port, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(port, { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await request(port, { method: 'POST', path: '/command', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 404);
  assert.equal((await request(port, { method: 'POST', path: '/command', headers: json, body: 'not json' })).status, 400);
});
