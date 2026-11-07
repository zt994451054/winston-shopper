import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { PlaywrightService, bridgeProtocolHandler, startPlaywrightService } from '../lib/playwright-service.mjs';
import { ShoppingError } from '../lib/errors.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const result = value => `### Result\n${JSON.stringify(JSON.stringify(value))}`;

function fakeTools() {
  const calls = [], listeners = new Set();
  const tools = { alive: true, closed: false, stops: 0,
    async call(name, input) { calls.push({ name, input }); return name === 'browser_tabs' ? '' : result(true); },
    async stop() { tools.stops++; tools.alive = false; tools.closed = true; },
    onDisconnect(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    disconnect() { tools.closed = true; for (const listener of listeners) listener(); },
  };
  return { tools, calls, listeners };
}

test('starting and connecting reject commands; concurrent connects share one attempt and status does no IO', async () => {
  const { tools, calls } = fakeTools(), settle = deferred();
  const service = new PlaywrightService({ tools, wait: () => settle.promise });
  assert.equal(service.status().state, 'starting');
  await assert.rejects(service.command('tab_list'), { code: 'SERVICE_NOT_READY' });
  const first = service.connect();
  assert.equal(service.connect(), first);
  assert.equal(service.status().extensionConnected, false);
  assert.equal(service.status().state, 'connecting');
  await assert.rejects(service.command('eval', { tabId: 1, script: 'must-not-run' }), { code: 'SERVICE_NOT_READY' });
  service.status(); service.status();
  assert.equal(calls.length, 1);
  settle.resolve(); await first;
  assert.equal(service.status().state, 'ready');
  assert.equal(service.status().running, true);
  assert.equal(service.status().extensionConnected, true);
  assert.equal(service.status().mcp_running, true);
  assert.equal(service.status().protocol_version, 1);
  assert.ok(service.status().capabilities.includes('tab_show'));
  await service.stop();
});

test('disconnect during the settle wait cannot subsequently become ready or reconnect', async () => {
  const { tools, calls } = fakeTools(), settle = deferred();
  const service = new PlaywrightService({ tools, wait: () => settle.promise });
  const pending = service.connect();
  const rejected = assert.rejects(pending, { code: 'EXTENSION_DISCONNECTED' });
  tools.disconnect(); settle.resolve(); await rejected;
  assert.equal(service.state, 'disconnected');
  assert.equal(service.status().mcp_running, true);
  await assert.rejects(service.connect(), { code: 'EXTENSION_DISCONNECTED' });
  await assert.rejects(service.command('tab_list'), { code: 'EXTENSION_DISCONNECTED' });
  assert.equal(calls.length, 1);
  await service.stop();
});

test('stop lets one running command finish, rejects queued work and only then closes the connect page', async () => {
  const { tools, calls, listeners } = fakeTools(), active = deferred(), dispatched = deferred();
  const original = tools.call;
  tools.call = async (name, input) => {
    if (input?.code?.includes('synthetic-pending')) { dispatched.resolve(); await active.promise; }
    return original(name, input);
  };
  const service = new PlaywrightService({ tools, settleMs: 0 });
  await service.connect();
  const running = service.command('eval', { tabId: 1, script: 'synthetic-pending' });
  await dispatched.promise;
  const queued = assert.rejects(service.command('eval', { tabId: 1, script: 'must-not-run' }), { code: 'SERVICE_STOPPING' });
  const stopping = service.stop();
  assert.equal(service.stop(), stopping);
  await assert.rejects(service.command('tab_list'), { code: 'SERVICE_STOPPING' });
  assert.equal(tools.stops, 0);
  active.resolve(); await running; await queued; await stopping;
  assert.equal(tools.stops, 1);
  assert.equal(listeners.size, 0);
  assert.ok(calls.at(-1).input.code.includes("'/connect.html'"));
  assert.ok(!calls.some(call => call.input?.code?.includes('must-not-run')));
  assert.equal(service.state, 'stopped');
});

test('stop is bounded when a command or connect-page cleanup never finishes', async () => {
  for (const hangCleanup of [false, true]) {
    const { tools } = fakeTools(), active = deferred(), sent = deferred();
    tools.call = async (name, input) => {
      if (name === 'browser_tabs') return '';
      sent.resolve(); await active.promise; return result(true);
    };
    const service = new PlaywrightService({ tools, settleMs: 0, stopTimeoutMs: 10 });
    await service.connect();
    let pending;
    if (!hangCleanup) { pending = service.command('eval', { tabId: 1, script: 'synthetic-pending' }); await sent.promise; }
    await service.stop();
    assert.equal(tools.stops, 1);
    active.resolve(); await pending;
  }
});

test('a malformed run-code result fails the service and cannot dispatch a later queued command', async () => {
  const { tools, calls } = fakeTools();
  const original = tools.call;
  tools.call = async (name, input) => name === 'browser_tabs' ? original(name, input) : 'synthetic-unreadable-result';
  const service = new PlaywrightService({ tools, settleMs: 0 });
  await service.connect();
  await assert.rejects(service.command('eval', { tabId: 1, script: 'synthetic' }), { code: 'INVALID_RESPONSE' });
  assert.equal(service.state, 'failed');
  assert.equal(service.status().error_code, 'INVALID_RESPONSE');
  await assert.rejects(service.command('tab_list'), { code: 'SERVICE_NOT_READY' });
  assert.equal(calls.length, 1);
  await service.stop();
});

test('stopping during settle closes the connect page after attachment but never reports ready', async () => {
  const { tools, calls } = fakeTools(), settling = deferred();
  const service = new PlaywrightService({ tools, wait: () => settling.promise });
  const pending = service.connect();
  const rejected = assert.rejects(pending, { code: 'SERVICE_STOPPING' });
  await Promise.resolve();
  await service.stop();
  settling.resolve(); await rejected;
  assert.ok(calls.some(call => call.input?.code?.includes("'/connect.html'")));
  assert.equal(service.status().extensionConnected, false);
});

test('HTTP status is additive, refuses unready commands and retains fixed host/origin/body guards', async () => {
  const { tools, calls } = fakeTools();
  const service = new PlaywrightService({ tools, settleMs: 0, instanceId: 'synthetic-instance' });
  const handler = bridgeProtocolHandler(service, () => ({ port: 12345 }));
  const request = async ({ method = 'GET', url = '/status', headers = {}, body } = {}) => {
    const incoming = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(incoming, { method, url, headers: { host: '127.0.0.1:12345', ...headers } });
    const response = { writeHead(code) { this.code = code; }, end(text) { this.body = JSON.parse(text); } };
    await handler(incoming, response); return response;
  };
  const starting = await request();
  assert.equal(starting.body.running, true);
  assert.equal(starting.body.extensionConnected, false);
  assert.equal(starting.body.instance_id, 'synthetic-instance');
  assert.equal(calls.length, 0);
  const json = { 'content-type': 'application/json' };
  const blocked = await request({ method: 'POST', url: '/command', headers: json, body: JSON.stringify({ id: 'x', action: 'tab_list' }) });
  assert.deepEqual(blocked.body, { id: 'x', success: false, error: { code: 'SERVICE_NOT_READY' } });
  assert.equal((await request({ headers: { origin: 'https://synthetic.example' } })).code, 403);
  assert.equal((await request({ headers: { host: 'synthetic.example' } })).code, 403);
  for (const body of ['null', '[]', '{', JSON.stringify({ action: 'tab_list' }), 'x'.repeat(1048577)]) {
    assert.equal((await request({ method: 'POST', url: '/command', headers: json, body })).code, 400);
  }
  await service.connect(); tools.disconnect();
  assert.equal((await request()).body.state, 'disconnected');
  assert.equal((await request()).body.extensionConnected, false);
  assert.equal(calls.length, 1);
  await service.stop();
});

function startupFixture() {
  const fixture = fakeTools(), events = [], signals = new EventEmitter();
  const server = { closes: 0, close(callback) { this.closes++; events.push('close-server'); callback?.(); }, closeAllConnections() {} };
  const dependencies = { signals, serviceOptions: { settleMs: 0 },
    listen: async service => { events.push('bind'); fixture.service = service; return server; },
    readToken: async () => { events.push('token'); return 'synthetic-startup-token'; },
    startTools: async () => { events.push('mcp'); return fixture.tools; },
  };
  return { ...fixture, events, signals, server, dependencies, service: () => fixture.service };
}

test('startup binds before reading a token or starting MCP, and removes signal listeners on explicit stop', async () => {
  const fixture = startupFixture();
  const running = await startPlaywrightService({ profile: 'Synthetic Profile' }, fixture.dependencies);
  assert.deepEqual(fixture.events, ['bind', 'token', 'mcp']);
  assert.equal(running.service.state, 'ready');
  assert.equal(fixture.signals.listenerCount('SIGTERM'), 1);
  await running.stop();
  assert.equal(fixture.server.closes, 1);
  assert.equal(fixture.tools.stops, 1);
  assert.equal(fixture.signals.listenerCount('SIGTERM'), 0);
  assert.equal(fixture.signals.listenerCount('SIGINT'), 0);
});

test('port conflicts never read the token or start a child; later initialization failures release the listener', async () => {
  const conflict = startupFixture();
  conflict.dependencies.listen = async () => { throw new ShoppingError('BRIDGE_PORT_IN_USE', 'Synthetic conflict.'); };
  await assert.rejects(startPlaywrightService({ profile: 'Synthetic Profile' }, conflict.dependencies), { code: 'BRIDGE_PORT_IN_USE' });
  assert.deepEqual(conflict.events, []);
  assert.equal(conflict.signals.listenerCount('SIGTERM'), 0);
  for (const step of ['readToken', 'startTools']) {
    const fixture = startupFixture();
    fixture.dependencies[step] = async () => { throw new ShoppingError('SYNTHETIC_START_FAILED', 'Synthetic failure.'); };
    await assert.rejects(startPlaywrightService({ profile: 'Synthetic Profile' }, fixture.dependencies), { code: 'SYNTHETIC_START_FAILED' });
    assert.equal(fixture.server.closes, 1);
    assert.equal(fixture.signals.listenerCount('SIGTERM'), 0);
  }
});

test('first connection failure is reported after cleanup with no implicit retry', async () => {
  const fixture = startupFixture();
  let connections = 0;
  fixture.tools.call = async () => { connections++; throw new Error('synthetic-private-error'); };
  await assert.rejects(startPlaywrightService({ profile: 'Synthetic Profile' }, fixture.dependencies), error => {
    assert.equal(error.code, 'PLAYWRIGHT_CONNECT_FAILED');
    assert.ok(!error.message.includes('synthetic-private-error')); return true;
  });
  assert.equal(connections, 1);
  assert.equal(fixture.tools.stops, 1);
  assert.equal(fixture.server.closes, 1);
});

test('SIGTERM during initialization aborts the child and closes the listener without starting again', async () => {
  const fixture = startupFixture(), entered = deferred();
  fixture.dependencies.startTools = async (args, { signal }) => {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new ShoppingError('MCP_DISCONNECTED', 'Synthetic aborted initialization.');
  };
  const pending = startPlaywrightService({ profile: 'Synthetic Profile' }, fixture.dependencies);
  const rejected = assert.rejects(pending, { code: 'MCP_DISCONNECTED' });
  await entered.promise; fixture.signals.emit('SIGTERM'); await rejected;
  assert.equal(fixture.server.closes, 1);
  assert.equal(fixture.signals.listenerCount('SIGTERM'), 0);
});

test('a listener returned after an early stop is still closed, and no MCP is started', async () => {
  const fixture = startupFixture(), bound = deferred();
  fixture.dependencies.listen = () => bound.promise;
  const pending = startPlaywrightService({ profile: 'Synthetic Profile' }, fixture.dependencies);
  const rejected = assert.rejects(pending, { code: 'SERVICE_STOPPING' });
  fixture.signals.emit('SIGINT'); bound.resolve(fixture.server); await rejected;
  assert.equal(fixture.server.closes, 1);
  assert.deepEqual(fixture.events, ['close-server']);
  assert.equal(fixture.tools.stops, 0);
});

test('shutdown failures from a signal are surfaced through the safe error callback', async () => {
  const fixture = startupFixture(), reported = deferred();
  fixture.tools.stop = async () => { throw new ShoppingError('MCP_STOP_FAILED', 'Synthetic stop failure.'); };
  fixture.dependencies.onStopError = error => reported.resolve(error.code);
  await startPlaywrightService({ profile: 'Synthetic Profile' }, fixture.dependencies);
  fixture.signals.emit('SIGTERM');
  assert.equal(await reported.promise, 'MCP_STOP_FAILED');
  assert.equal(fixture.signals.listenerCount('SIGTERM'), 0);
});
