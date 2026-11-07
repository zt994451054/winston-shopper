import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { startMcpTools, runMcpChild, singleConnectionFactory } from '../lib/playwright-service.mjs';
import { publicError } from '../lib/errors.mjs';

const PRIVATE_TEXT = 'synthetic_private_mcp_token';
const protocolVersion = '2025-06-18';

function fakeChild({ initialize, inventory, tool, response, termExits = true } = {}) {
  const child = new EventEmitter(), requests = [], kills = [];
  child.stdout = new PassThrough();
  const reply = (id, result) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  child.stdin = new Writable({ write(data, encoding, done) {
    for (const line of String(data).trim().split('\n')) {
      const request = JSON.parse(line);
      requests.push(request);
      queueMicrotask(() => {
        if (response?.(request, child, reply) === false || !Object.hasOwn(request, 'id')) return;
        if (request.method === 'initialize') reply(request.id, initialize ?? { protocolVersion, capabilities: { tools: {} } });
        else if (request.method === 'tools/list') reply(request.id, inventory ?? { tools: [{ name: 'browser_tabs' }, { name: 'browser_run_code_unsafe' }] });
        else reply(request.id, tool ?? { content: [{ type: 'text', text: 'synthetic-result' }] });
      });
    }
    done();
  } });
  child.kill = signal => {
    kills.push(signal);
    if (termExits || signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  return { child, requests, kills };
}

async function connect(t, fixture = fakeChild(), options = {}) {
  let spawned;
  const tools = await startMcpTools(['--extension', '--profile-dir-name', 'Synthetic Profile'], {
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: PRIVATE_TEXT },
    spawnProcess: (executable, args, settings) => { spawned = { executable, args, settings }; return fixture.child; },
    stopTimeoutMs: 10, ...options,
  });
  t.after(() => tools.stop());
  return { ...fixture, tools, spawned };
}

test('the MCP handshake checks protocol and tools without connecting a browser', async t => {
  const { tools, requests, spawned } = await connect(t);
  assert.deepEqual(requests.map(request => request.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(spawned.executable, process.execPath);
  assert.ok(spawned.args.includes('--mcp-child'));
  assert.ok(spawned.args.every(value => !value.includes(PRIVATE_TEXT)));
  assert.deepEqual(spawned.settings.stdio, ['pipe', 'pipe', 'ignore', 'ipc']);
  assert.equal(spawned.settings.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, PRIVATE_TEXT);
  assert.equal(tools.alive, true);
  assert.equal(await tools.call('browser_tabs', { action: 'list' }), 'synthetic-result');
  await assert.rejects(tools.call('browser_tabs', { action: 'select' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(tools.call('browser_navigate', {}), { code: 'INVALID_ARGUMENTS' });
});

test('unsupported protocol, capabilities and tool inventory stop the owned child', async () => {
  for (const values of [
    { initialize: { protocolVersion: 'unsupported', capabilities: { tools: {} } } },
    { initialize: { protocolVersion, capabilities: {} } },
    { initialize: { protocolVersion, capabilities: { tools: null } } },
    { inventory: { tools: [{ name: 'browser_tabs' }] } },
    { inventory: { tools: {} } },
  ]) {
    const fixture = fakeChild(values);
    await assert.rejects(startMcpTools([], { spawnProcess: () => fixture.child, stopTimeoutMs: 10 }), { code: 'MCP_PROTOCOL_INCOMPATIBLE' });
    assert.deepEqual(fixture.kills, ['SIGTERM']);
    assert.equal(fixture.child.stdin.destroyed, true);
    assert.equal(fixture.child.stdout.destroyed, true);
  }
});

test('child spawn errors and malformed handshake output have fixed errors', async () => {
  await assert.rejects(startMcpTools([], { spawnProcess: () => { throw new Error(PRIVATE_TEXT); } }), { code: 'BACKEND_MISSING' });
  const fixture = fakeChild({ response: (request, child) => {
    if (request.method !== 'initialize') return;
    child.stdout.write(`${PRIVATE_TEXT}\n`); return false;
  } });
  await assert.rejects(startMcpTools([], { spawnProcess: () => fixture.child, stopTimeoutMs: 10 }), error => {
    assert.equal(error.code, 'MCP_PROTOCOL_ERROR');
    assert.ok(!JSON.stringify(publicError(error)).includes(PRIVATE_TEXT));
    return true;
  });
  assert.deepEqual(fixture.kills, ['SIGTERM']);
});

test('an IPC browser loss rejects pending work while the MCP process is still alive, without resending', async t => {
  const fixture = fakeChild({ response: request => request.method === 'tools/call' ? false : undefined });
  const { tools, child, requests } = await connect(t, fixture);
  let notifications = 0;
  tools.onDisconnect(() => notifications++);
  const pending = tools.call('browser_run_code_unsafe', { code: 'synthetic-code' });
  const rejected = assert.rejects(pending, { code: 'EXTENSION_DISCONNECTED' });
  child.emit('message', { type: 'shopper_browser_disconnected' });
  await rejected;
  assert.equal(tools.alive, true);
  assert.equal(tools.closed, true);
  assert.equal(notifications, 1);
  const sent = requests.length;
  child.emit('message', { type: 'shopper_browser_disconnected' });
  await assert.rejects(tools.call('browser_run_code_unsafe', { code: 'must-not-run' }), { code: 'MCP_DISCONNECTED' });
  assert.equal(requests.length, sent);
  assert.equal(notifications, 1);
});

test('child exit rejects pending calls immediately and notifies only once', async t => {
  const fixture = fakeChild({ response: request => request.method === 'tools/call' ? false : undefined });
  let exits = 0;
  const { tools, child } = await connect(t, fixture, { onExit: () => exits++ });
  const rejected = assert.rejects(tools.call('browser_run_code_unsafe', { code: 'synthetic-code' }), { code: 'MCP_DISCONNECTED' });
  child.emit('exit', 1);
  child.emit('error', new Error(PRIVATE_TEXT));
  await rejected;
  assert.equal(tools.alive, false);
  assert.equal(exits, 1);
});

test('an MCP timeout closes the call channel and does not replay timed-out commands', async t => {
  const fixture = fakeChild({ response: request => request.method === 'tools/call' ? false : undefined });
  const { tools, requests } = await connect(t, fixture, { callTimeoutMs: 10 });
  await assert.rejects(tools.call('browser_run_code_unsafe', { code: 'synthetic-code' }), { code: 'MCP_TIMEOUT' });
  assert.equal(tools.closed, true);
  assert.equal(requests.filter(request => request.method === 'tools/call').length, 1);
});

test('MCP and page error bodies are withheld, and a normal tool error does not imply disconnection', async t => {
  const fixture = fakeChild({ tool: { isError: true, content: [{ type: 'text', text: PRIVATE_TEXT }] } });
  const { tools } = await connect(t, fixture);
  await assert.rejects(tools.call('browser_tabs', { action: 'list' }), error => {
    assert.equal(error.code, 'BROWSER_COMMAND_FAILED');
    assert.ok(!JSON.stringify(publicError(error)).includes(PRIVATE_TEXT));
    return true;
  });
  assert.equal(tools.closed, false);
});

test('RPC errors, malformed tool content and stdin failure do not leak external text', async t => {
  const rpc = fakeChild({ response: (request, child) => {
    if (request.method !== 'tools/call') return;
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: PRIVATE_TEXT } })}\n`);
    return false;
  } });
  const { tools } = await connect(t, rpc);
  await assert.rejects(tools.call('browser_tabs', { action: 'list' }), error => {
    assert.equal(error.code, 'MCP_REQUEST_FAILED');
    assert.ok(!JSON.stringify(publicError(error)).includes(PRIVATE_TEXT)); return true;
  });
  const malformed = await connect(t, fakeChild({ tool: { content: [null] } }));
  await assert.rejects(malformed.tools.call('browser_tabs', { action: 'list' }), { code: 'MCP_PROTOCOL_ERROR' });
  const input = await connect(t);
  input.child.stdin.emit('error', new Error(PRIVATE_TEXT));
  await assert.rejects(input.tools.call('browser_tabs', { action: 'list' }), { code: 'MCP_DISCONNECTED' });
});

test('stop is idempotent, escalates when needed and abort cancels initialization', async t => {
  const fixture = await connect(t, fakeChild({ termExits: false }));
  const first = fixture.tools.stop();
  assert.equal(fixture.tools.stop(), first);
  await first;
  assert.deepEqual(fixture.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(fixture.tools.alive, false);
  assert.equal(fixture.child.stdout.listenerCount('data'), 0);
  const abort = new AbortController();
  const initializing = fakeChild({ response: () => false });
  const pending = startMcpTools([], { spawnProcess: () => initializing.child, signal: abort.signal, stopTimeoutMs: 10 });
  const rejected = assert.rejects(pending, { code: 'MCP_DISCONNECTED' });
  abort.abort();
  await rejected;
  assert.deepEqual(initializing.kills, ['SIGTERM']);
});

function backendFixture() {
  let creates = 0, browserCloses = 0;
  const context = {}, instances = [], notifications = [];
  const backend = {
    filteredTools: () => [{ schema: { name: 'browser_tabs' } }],
    createBrowserWithInfo: async () => { creates++; return { ownership: 'attached',
      browser: { contexts: () => [context], close: async () => { browserCloses++; } } }; },
    BrowserBackend: class extends EventEmitter {
      constructor(config, givenContext, tools, options) { super(); this.context = givenContext; this.options = options; instances.push(this); }
    },
  };
  return { backend, config: { browser: {} }, options: { extension: true, profileDirName: 'Synthetic Profile' },
    onDisconnect: () => notifications.push('disconnected'), instances, notifications,
    get creates() { return creates; }, get browserCloses() { return browserCloses; } };
}

test('the child factory refuses a second creation even before the parent receives the disconnect message', async () => {
  const fixture = backendFixture();
  const factory = singleConnectionFactory(fixture);
  const original = await factory.create({ clientName: 'synthetic', cwd: '.' });
  original.emit('disconnected');
  await assert.rejects(factory.create({ clientName: 'synthetic', cwd: '.' }), { code: 'EXTENSION_DISCONNECTED' });
  assert.equal(fixture.creates, 1);
  assert.deepEqual(fixture.notifications, ['disconnected']);
  assert.equal(original.options.dispose, undefined);
  assert.equal(fixture.browserCloses, 0);
});

test('a failed first backend creation also cannot be retried implicitly', async () => {
  const fixture = backendFixture();
  fixture.backend.createBrowserWithInfo = async () => { throw new Error('synthetic-connect-failure'); };
  const factory = singleConnectionFactory(fixture);
  await assert.rejects(factory.create({}), /synthetic-connect-failure/);
  await assert.rejects(factory.create({}), { code: 'EXTENSION_DISCONNECTED' });
});

test('the child adapter uses pinned exports and IPC notifications without editing dependencies', async () => {
  const fixture = backendFixture(), messages = [];
  let options, factory;
  fixture.backend.resolveCLIConfigForMCP = async values => { options = values; return fixture.config; };
  fixture.backend.start = async value => { factory = value; };
  await runMcpChild(['--extension', '--profile-dir-name', 'Synthetic Profile'], {
    loadBackend: () => fixture.backend, notify: value => messages.push(value),
  });
  assert.equal(options.profileDirName, 'Synthetic Profile');
  const original = await factory.create({ clientName: 'synthetic', cwd: '.' });
  original.emit('disconnected');
  assert.deepEqual(messages, [{ type: 'shopper_browser_disconnected' }]);
  await assert.rejects(runMcpChild(['--extension'], { loadBackend: () => { throw new Error('must-not-load'); } }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(runMcpChild(['--extension', '--profile-dir-name', 'Synthetic Profile'], { loadBackend: () => ({}) }), { code: 'MCP_PROTOCOL_INCOMPATIBLE' });
});
