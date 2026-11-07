import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BrowserBridge } from '../lib/bridge.mjs';
import { DEFAULT_BRIDGE_ENDPOINT, isExtensionProtocol } from '../lib/bridge-protocol.mjs';
import { inspectExtensionToken } from '../lib/playwright-config.mjs';
import { main } from '../lib/cli.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { loadTask, withTaskStore } from '../lib/task-store.mjs';
import { createOrderWorkflow } from '../lib/order-workflow.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { productResult } from '../test-support/product-fixture.mjs';
import { playwrightStatus } from '../test-support/mock-bridge.mjs';

const ENDPOINT = 'http://127.0.0.1:19825';
const TOKEN = 'synthetic_extension_token_for_tests';
const BACKEND = { installed: true, lock_verified: true, expected_version: '0.0.84', version: '0.0.84' };
const noServices = { start: () => assert.fail('No service may be started or reconnected.'), stop: () => assert.fail('No service may be stopped.') };

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping channel '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function metadataClient(t, initial = playwrightStatus()) {
  const state = { value: initial, requests: [] };
  t.mock.method(http, 'request', (url, options, respond) => {
    const outgoing = new EventEmitter();
    outgoing.end = body => {
      state.requests.push({ url, options, body });
      queueMicrotask(() => {
        if (state.value instanceof Error) { outgoing.emit('error', state.value); return; }
        const response = Readable.from([Buffer.from(JSON.stringify(state.value))]);
        response.statusCode = 200; respond(response);
      });
    };
    return outgoing;
  });
  return state;
}

async function run(args, environment = {}, services = noServices) {
  let output = '';
  const code = await main(args, { write: text => { output += text; }, services,
    environment: { inspectBackend: async () => ({ ...BACKEND }), ...environment } });
  return { code, output, value: JSON.parse(output) };
}

test('the current channel reports its actual protocol and page scope, redacting unrelated status fields', async t => {
  const client = metadataClient(t, { ...playwrightStatus(), token: TOKEN, profile: TOKEN, page_title: TOKEN });
  const bridge = new BrowserBridge(ENDPOINT);
  assert.equal(bridge.protocol, 'playwright-extension');
  assert.equal(bridge.inventoryScope, 'playwright_connected_pages');
  const status = await bridge.requireConnected();
  assert.equal(status.state, 'ready');
  assert.equal(status.capabilities.length, 9);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  assert.equal(client.requests.length, 1);
  assert.ok(isExtensionProtocol('bb-browser-extension'));
  assert.ok(isExtensionProtocol('playwright-extension'));
  assert.ok(!isExtensionProtocol('owned-chrome-cdp'));
});

test('service states and first connection failures retain fixed codes without page commands or retries', async t => {
  const client = metadataClient(t);
  const bridge = new BrowserBridge(ENDPOINT);
  for (const [state, errorCode, expected] of [
    ['starting', null, 'SERVICE_STARTING'], ['connecting', null, 'SERVICE_STARTING'],
    ['failed', 'PLAYWRIGHT_CONNECT_FAILED', 'PLAYWRIGHT_CONNECT_FAILED'],
    ['failed', 'MCP_TIMEOUT', 'MCP_TIMEOUT'], ['failed', TOKEN, 'SERVICE_NOT_READY'],
    ['disconnected', 'EXTENSION_DISCONNECTED', 'EXTENSION_DISCONNECTED'],
    ['stopping', null, 'SERVICE_STOPPING'], ['stopped', null, 'SERVICE_STOPPED'],
  ]) {
    client.value = { ...playwrightStatus(false), state, error_code: errorCode, running: state !== 'stopped' };
    await assert.rejects(bridge.requireConnected(), error => error.code === expected && !String(error).includes(TOKEN));
  }
  assert.equal(client.requests.length, 8);
  assert.ok(client.requests.every(request => request.url.endsWith('/status') && request.options.method === 'GET'));
});

test('historical metadata is recognized without authorizing the active channel', async t => {
  const client = metadataClient(t, { running: true, extensionConnected: true });
  const bridge = new BrowserBridge(ENDPOINT);
  assert.equal((await bridge.status()).backend, 'bb-browser-extension');
  await assert.rejects(bridge.requireConnected(), { code: 'INCOMPATIBLE_BRIDGE' });
  assert.equal(bridge.protocol, 'playwright-extension');
  assert.equal(client.requests.length, 2);
});

test('incompatible or contradictory metadata and missing capabilities never count as ready', async t => {
  const client = metadataClient(t), bridge = new BrowserBridge(ENDPOINT);
  for (const changes of [{ backend: 'unknown' }, { protocol_version: 2 }, { instance_id: TOKEN },
    { extensionConnected: false }, { running: false }, { state: 'unknown' }, { capabilities: ['eval', 'eval'] }]) {
    client.value = { ...playwrightStatus(), ...changes };
    await assert.rejects(bridge.requireConnected(), { code: 'INCOMPATIBLE_BRIDGE' });
  }
  client.value = { ...playwrightStatus(), capabilities: ['eval'] };
  await assert.rejects(bridge.requireConnected(), { code: 'UNSUPPORTED_CAPABILITY' });
  client.value = { ...playwrightStatus(), mcp_running: false };
  await assert.rejects(bridge.requireConnected(), { code: 'SERVICE_NOT_READY' });
  assert.equal(client.requests.length, 9);
});

test('default endpoint and explicit overrides apply to both service commands without legacy fallback', async t => {
  const original = process.env.SHOPPING_BRIDGE_ENDPOINT;
  t.after(() => {
    if (original === undefined) delete process.env.SHOPPING_BRIDGE_ENDPOINT;
    else process.env.SHOPPING_BRIDGE_ENDPOINT = original;
  });
  delete process.env.SHOPPING_BRIDGE_ENDPOINT;
  const calls = [], services = Object.fromEntries(['start', 'stop'].map(name => [name, async options => {
    calls.push({ name, ...options }); return { ok: true };
  }]));
  await run(['bridge-start', '--profile', 'Synthetic Profile'], {}, services);
  await run(['bridge-stop'], {}, services);
  assert.equal(DEFAULT_BRIDGE_ENDPOINT, ENDPOINT);
  assert.ok(calls.every(call => call.endpoint === ENDPOINT));
  process.env.SHOPPING_BRIDGE_ENDPOINT = 'http://127.0.0.1:19998';
  await run(['bridge-stop'], {}, services);
  await run(['bridge-start', '--endpoint', 'http://127.0.0.1:19999'], {}, services);
  assert.equal(calls[2].endpoint, 'http://127.0.0.1:19998');
  assert.equal(calls[3].endpoint, 'http://127.0.0.1:19999');
});

test('doctor is ready with zero pages using one metadata read and no browser command', async t => {
  const client = metadataClient(t);
  const result = await run(['doctor', '--endpoint', ENDPOINT]);
  assert.equal(result.code, 0);
  assert.equal(result.value.status, 'ready');
  assert.equal(result.value.login_verified, false);
  assert.equal(result.value.connection.protocol, 'playwright-extension');
  assert.equal(result.value.connection.inventory_scope, 'playwright_connected_pages');
  assert.equal(result.value.connection.tab_count, undefined);
  assert.equal(result.value.connection.capabilities.length, 9);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].url, `${ENDPOINT}/status`);
  assert.equal(client.requests[0].options.method, 'GET');
});

test('doctor diagnoses starting, failed, disconnected, incompatible and unavailable services without recovery actions', async t => {
  const client = metadataClient(t);
  for (const [metadata, expected] of [
    [{ ...playwrightStatus(false), state: 'connecting', error_code: null }, 'SERVICE_STARTING'],
    [{ ...playwrightStatus(false), state: 'failed', error_code: 'PLAYWRIGHT_CONNECT_FAILED' }, 'PLAYWRIGHT_CONNECT_FAILED'],
    [playwrightStatus(false), 'EXTENSION_DISCONNECTED'],
    [{ running: true, extensionConnected: true }, 'INCOMPATIBLE_BRIDGE'],
    [{ Browser: 'Chrome' }, 'INCOMPATIBLE_BRIDGE'],
    [new Error(TOKEN), 'BRIDGE_UNAVAILABLE'],
  ]) {
    client.value = metadata;
    const result = await run(['doctor', '--endpoint', ENDPOINT]);
    assert.equal(result.code, 2);
    assert.equal(result.value.error.code, expected);
    assert.equal(result.value.backend.lock_verified, true);
    assert.ok(!result.output.includes(TOKEN));
  }
  assert.equal(client.requests.length, 6);
  assert.ok(client.requests.every(request => request.url === `${ENDPOINT}/status`));
});

test('doctor reports dependency and capability problems even when a service claims readiness', async t => {
  const client = metadataClient(t);
  const dependencies = await run(['doctor', '--endpoint', ENDPOINT], { inspectBackend: async () => ({ installed: false, lock_verified: false }) });
  assert.equal(dependencies.value.error.code, 'BACKEND_MISSING');
  assert.equal(dependencies.value.connection.state, 'ready');
  client.value = { ...playwrightStatus(), capabilities: ['eval'] };
  assert.equal((await run(['doctor', '--endpoint', ENDPOINT])).value.error.code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(client.requests.length, 2);
});

test('setup inspection and installation report Playwright dependencies and token validity separately without service IO', async t => {
  const root = await directory(t), tokenFile = path.join(root, 'synthetic-token');
  const client = metadataClient(t), calls = [];
  const environment = { prepareBackend: async ({ install }) => {
    calls.push(install); return { ...BACKEND, changed: install, install_requested: install };
  }, inspectToken: () => inspectExtensionToken(tokenFile), findProfiles: async () => ['Default'] };
  const missing = await run(['setup'], environment);
  assert.equal(missing.value.ready, false);
  assert.equal(missing.value.status, 'needs_token');
  assert.equal(missing.value.backend.lock_verified, true);
  assert.equal(missing.value.token.error_code, 'PLAYWRIGHT_TOKEN_MISSING');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const installed = await run(['setup', '--install'], environment);
  assert.equal(installed.value.ready, true);
  assert.equal(installed.value.status, 'ready_for_bridge_start');
  assert.equal(installed.value.token.valid, true);
  assert.ok(!installed.output.includes(TOKEN));
  const absent = await run(['setup'], { ...environment, prepareBackend: async () => ({ installed: false, lock_verified: false }) });
  assert.equal(absent.value.status, 'installation_plan');
  assert.equal(absent.value.token.valid, true);
  assert.deepEqual(calls, [false, true]);
  assert.equal(client.requests.length, 0);
});

test('failed Playwright installation retains the independent token diagnosis', async t => {
  const root = await directory(t);
  const result = await run(['setup', '--install'], {
    prepareBackend: async () => { throw new ShoppingError('INSTALL_FAILED', 'Synthetic installer failure'); },
    inspectToken: () => inspectExtensionToken(path.join(root, 'absent-token')),
  });
  assert.equal(result.code, 2);
  assert.equal(result.value.backend.error.code, 'INSTALL_FAILED');
  assert.equal(result.value.token.error_code, 'PLAYWRIGHT_TOKEN_MISSING');
});

test('token inspection reports invalid format and permissions without returning or rewriting token contents', async t => {
  const root = await directory(t), filename = path.join(root, 'synthetic-token');
  await writeFile(filename, 'invalid token', { mode: 0o600 });
  assert.equal((await inspectExtensionToken(filename)).error_code, 'PLAYWRIGHT_TOKEN_INVALID');
  await writeFile(filename, TOKEN);
  assert.equal((await inspectExtensionToken(filename)).valid, true);
  if (process.platform !== 'win32') {
    await chmod(filename, 0o644);
    const result = await inspectExtensionToken(filename);
    assert.equal(result.error_code, 'PLAYWRIGHT_TOKEN_PERMISSIONS');
    assert.ok(result.next_action.includes('0600'));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
  assert.equal(await readFile(filename, 'utf8'), TOKEN);
});

test('new protocol enables guarded task modes for all platforms and the order workflow', async t => {
  const root = await directory(t), bridge = { endpoint: ENDPOINT, protocol: 'playwright-extension' };
  for (const platform of ['taobao', 'jd', 'pdd']) {
    const stateDirectory = path.join(root, platform);
    const result = await createTask({ stateDirectory, bridge, platform, task: 'sample', search: 'synthetic', tabId: 41, sort: 'price-asc' });
    assert.equal(result.ok, true);
    const saved = await loadTask(stateDirectory, 'sample');
    assert.equal(saved.platform, platform);
    assert.equal(saved.endpoint, ENDPOINT);
  }
  assert.equal((await createOrderWorkflow({ stateDirectory: path.join(root, 'workflow'), workflow: 'sample', tabId: 41, orderPosition: 1, bridge })).ok, true);
});

test('historical extension and dedicated results remain byte-for-byte unchanged through cached reads and export', async t => {
  const root = await directory(t);
  for (const protocol of ['bb-browser-extension', 'owned-chrome-cdp']) {
    const stateDirectory = path.join(root, protocol), endpoint = 'http://127.0.0.1:19824';
    await mkdir(stateDirectory);
    await saveBinding(stateDirectory, 'sample', { schema_version: 1, platform: 'taobao', endpoint, tab_id: 41,
      target: parseProductUrl('https://detail.tmall.com/item.htm?id=123'), created_at: new Date().toISOString() });
    const bridge = { endpoint, protocol: 'playwright-extension', readProduct: async () => productResult('123') };
    const options = { stateDirectory, bridge, task: 'sample', bindings: ['sample'] };
    await createTask(options);
    const first = await runTask(options);
    assert.equal(first.status, 'complete');
    if (protocol === 'owned-chrome-cdp') await withTaskStore(stateDirectory, 'sample', async store => {
      const legacy = await store.load(); legacy.browser_session = 'dedicated'; await store.save(legacy);
    });
    const filename = path.join(stateDirectory, 'tasks/sample.json'), before = await readFile(filename);
    bridge.readProduct = () => assert.fail('A historical cache must not contact a browser.');
    assert.deepEqual(await runTask(options), first);
    const status = await run(['task-status', '--state-dir', stateDirectory, '--task', 'sample']);
    assert.deepEqual(status.value.operations[0].result, first.operations[0].result);
    const report = await run(['report-export', '--state-dir', stateDirectory, '--task', 'sample', '--format', 'markdown', '--output', path.join(root, `${protocol}.md`)]);
    assert.equal(report.code, 0);
    assert.deepEqual(await readFile(filename), before);
    assert.equal((await loadTask(stateDirectory, 'sample')).endpoint, endpoint);
  }
});

test('the new default never migrates unfinished tasks or rewrites their original endpoint', async t => {
  const original = process.env.SHOPPING_BRIDGE_ENDPOINT;
  delete process.env.SHOPPING_BRIDGE_ENDPOINT;
  t.after(() => {
    if (original === undefined) delete process.env.SHOPPING_BRIDGE_ENDPOINT;
    else process.env.SHOPPING_BRIDGE_ENDPOINT = original;
  });
  const stateDirectory = await directory(t), endpoint = 'http://127.0.0.1:19824';
  await createTask({ stateDirectory, task: 'sample', bridge: { endpoint }, search: 'synthetic', tabId: 41 });
  const filename = path.join(stateDirectory, 'tasks/sample.json'), before = await readFile(filename);
  const client = metadataClient(t);
  const result = await run(['task-run', '--state-dir', stateDirectory, '--task', 'sample']);
  assert.equal(result.value.error.code, 'BINDING_ENDPOINT_MISMATCH');
  assert.equal(client.requests.length, 0);
  assert.deepEqual(await readFile(filename), before);
});
