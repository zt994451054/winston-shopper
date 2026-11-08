import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs, { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startBridgeService, stopBridgeService, loadBridgeBootstrap, runManagedBridge, createBridgeLogger } from '../lib/bridge-service.mjs';
import { PlaywrightService, bridgeProtocolHandler } from '../lib/playwright-service.mjs';
import { main } from '../lib/cli.mjs';

const TOKEN = 'synthetic_extension_token_for_tests';
const ENDPOINT = 'http://127.0.0.1:19825';
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const writeJson = (filename, value) => writeFile(filename, JSON.stringify(value), { mode: 0o600 });

async function fixture(t, { mode = 'ready' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping bridge service '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, 'pw-ext-token'), TOKEN, { mode: 0o600 });
  const live = new Set([process.pid]), states = new Map(), children = [], probes = [], shutdowns = [];
  let clock = 0, inspections = 0;
  const options = { endpoint: ENDPOINT, runtimeDirectory: directory, skillDirectory: root };
  const hooks = {
    now: () => clock,
    wait: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)); },
    isAlive: pid => live.has(pid), timeoutMs: 90000,
    probe: async endpoint => { probes.push(endpoint); return states.get(endpoint) ?? null; },
    inspectBackend: async () => { inspections++; return { installed: true, lock_verified: true }; },
    spawnProcess(executable, args, settings) {
      const child = new EventEmitter();
      Object.assign(child, { pid: 900000 + children.length, connected: true, executable, args, settings, unrefs: 0, disconnects: 0 });
      child.unref = () => { child.unrefs++; };
      child.disconnect = () => { child.connected = false; child.disconnects++; };
      child.kill = () => { throw new Error('A service manager must not signal a recorded PID.'); };
      child.send = (message, callback) => {
        child.message = message;
        void (async () => {
          const record = await readJson(path.join(directory, 'bridge-service.json'));
          live.add(child.pid);
          if (mode === 'failed') {
            child.emit('message', { type: 'bridge_failed', instance_id: record.instance_id, error_code: 'PLAYWRIGHT_CONNECT_FAILED' });
            live.delete(child.pid); child.emit('exit', 1); callback(); return;
          }
          states.set(record.endpoint, { running: true, extensionConnected: mode === 'ready', backend: 'playwright-extension',
            protocol_version: 1, instance_id: record.instance_id, install_id: record.install_id, pid: child.pid,
            managed: true, state: mode === 'ready' ? 'ready' : 'connecting', error_code: null });
          callback();
        })().catch(callback);
      };
      children.push(child); return child;
    },
    shutdown: async (endpoint, body) => {
      shutdowns.push({ endpoint, body });
      const status = states.get(endpoint);
      states.delete(endpoint); live.delete(status.pid);
      return { stopping: true, instance_id: status.instance_id };
    },
  };
  return { root, directory, options, hooks, live, states, children, probes, shutdowns,
    get inspections() { return inspections; },
    start: profile => startBridgeService({ ...options, ...(profile === undefined ? {} : { profile }) }, hooks),
    stop: () => stopBridgeService(options, hooks),
  };
}

test('first launch commits private configuration and identity before detached spawn and IPC bootstrap', async t => {
  const f = await fixture(t);
  const result = await f.start('Synthetic Profile');
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.state, 'ready');
  const config = await readJson(path.join(f.directory, 'playwright-service-config.json'));
  assert.deepEqual(config, { schema_version: 1, profile: 'Synthetic Profile' });
  const record = await readJson(path.join(f.directory, 'bridge-service.json'));
  assert.equal(record.phase, 'ready');
  assert.equal(record.pid, f.children[0].pid);
  assert.match(record.management_key, /^[a-f0-9]{64}$/);
  assert.notEqual(record.management_key, TOKEN);
  assert.ok(!JSON.stringify(result).includes(record.management_key));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  const [child] = f.children;
  assert.equal(child.executable, process.execPath);
  assert.deepEqual(child.args.slice(-1), ['--managed']);
  assert.equal(child.settings.detached, true);
  assert.deepEqual(child.settings.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(child.unrefs, 1);
  assert.equal(child.disconnects, 1);
  assert.ok(!JSON.stringify(child.message).includes(record.management_key));
  assert.ok(!JSON.stringify(child.args).includes(TOKEN));
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    for (const name of ['bridge-service.json', 'playwright-service-config.json', 'bridge-service.log']) {
      assert.equal((await stat(path.join(f.directory, name))).mode & 0o777, 0o600);
    }
  }
  assert.ok(!(await readdir(f.directory)).includes('bridge-service.lock'));
});

test('separate CLI invocations reuse one live instance without inspecting dependencies or reading the token again', async t => {
  const f = await fixture(t);
  const first = await f.start('Synthetic Profile');
  await rm(path.join(f.directory, 'pw-ext-token'));
  f.hooks.inspectBackend = async () => { throw new Error('Reuse must not inspect or install dependencies.'); };
  const second = await f.start();
  assert.equal(second.started, false);
  assert.equal(second.instance_id, first.instance_id);
  assert.equal(second.pid, first.pid);
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].disconnects, 1);
});

test('concurrent launches serialize and create only one browser-service process', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.start('Synthetic Profile'), f.start('Synthetic Profile')]);
  assert.equal(results.filter(result => result.started).length, 1);
  assert.equal(results[0].instance_id, results[1].instance_id);
  assert.equal(f.children.length, 1);
});

test('a paused lock writer exposes no incomplete owner record and concurrent launchers still share one service', async t => {
  const f = await fixture(t);
  const openFile = fs.open;
  let writing, resume, held = false;
  const paused = new Promise(resolve => { writing = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  t.mock.method(fs, 'open', async (filename, ...options) => {
    const file = await openFile(filename, ...options);
    if (!held && path.basename(filename).includes('bridge-service.lock') && options[0] === 'wx') {
      held = true;
      const write = file.writeFile.bind(file);
      t.mock.method(file, 'writeFile', async (...args) => { writing(); await released; return write(...args); });
    }
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const pending = f.start('Synthetic Profile');
  await paused;
  let first, second;
  try {
    await assert.rejects(stat(path.join(f.directory, 'bridge-service.lock')), { code: 'ENOENT' });
    second = await f.start('Synthetic Profile');
    assert.equal(second.started, true);
    assert.equal(f.children.length, 1);
  } finally { resume(); first = await pending; }
  assert.equal(first.started, false);
  assert.equal(first.instance_id, second.instance_id);
  assert.equal(f.children.length, 1);
  assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
});

test('a lock released after exclusive creation fails is retried instead of being treated as incomplete', async t => {
  const f = await fixture(t);
  const first = await f.start('Synthetic Profile');
  const filename = path.join(f.directory, 'bridge-service.lock');
  await writeJson(filename, { schema_version: 1, pid: process.pid, lock_id: randomUUID() });
  const inspect = fs.lstat;
  let removed = false;
  t.mock.method(fs, 'lstat', async (target, ...options) => {
    if (target === filename && !removed) { removed = true; await rm(filename); }
    return inspect(target, ...options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const second = await f.start();
  assert.equal(removed, true);
  assert.equal(second.started, false);
  assert.equal(second.instance_id, first.instance_id);
  assert.equal(f.children.length, 1);
});

test('initial profile is explicit and malformed profile names never start a process', async t => {
  const f = await fixture(t);
  for (const profile of [undefined, '', '..', '../another', 'bad\nprofile']) {
    await assert.rejects(f.start(profile), { code: 'PLAYWRIGHT_PROFILE_REQUIRED' });
  }
  assert.equal(f.children.length, 0);
  assert.equal(f.inspections, 0);
});

test('a live profile or endpoint cannot be silently replaced', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  await assert.rejects(f.start('Another Profile'), { code: 'BRIDGE_CONFIG_MISMATCH' });
  await assert.rejects(startBridgeService({ ...f.options, endpoint: 'http://127.0.0.1:19999' }, f.hooks), { code: 'BRIDGE_CONFIG_MISMATCH' });
  assert.equal(f.children.length, 1);
  assert.equal(f.shutdowns.length, 0);
});

test('bb-browser, manually started Playwright and another installation are all foreign services', async t => {
  for (const status of [
    { running: true, extensionConnected: true },
    { running: true, extensionConnected: true, backend: 'playwright-extension', protocol_version: 1, state: 'ready', instance_id: randomUUID() },
    { running: true, extensionConnected: true, backend: 'playwright-extension', protocol_version: 1, managed: true, install_id: 'a'.repeat(64) },
  ]) {
    const f = await fixture(t);
    f.states.set(ENDPOINT, status);
    await assert.rejects(f.start('Synthetic Profile'), { code: 'BRIDGE_PORT_IN_USE' });
    await assert.rejects(f.stop(), { code: 'BRIDGE_PORT_IN_USE' });
    assert.equal(f.children.length, 0);
    assert.equal(f.inspections, 0);
    assert.equal(f.shutdowns.length, 0);
  }
});

test('an unavailable or unverified backend and a missing token stop before launch', async t => {
  const f = await fixture(t);
  f.hooks.inspectBackend = async () => ({ installed: true, lock_verified: false });
  await assert.rejects(f.start('Synthetic Profile'), { code: 'BACKEND_MISSING' });
  f.hooks.inspectBackend = async () => ({ installed: true, lock_verified: true });
  await rm(path.join(f.directory, 'pw-ext-token'));
  await assert.rejects(f.start('Synthetic Profile'), { code: 'PLAYWRIGHT_TOKEN_MISSING' });
  assert.equal(f.children.length, 0);
  assert.ok(!(await readdir(f.directory)).includes('bridge-service.lock'));
});

test('startup failure preserves the first fixed code and never retries or leaks the credential', async t => {
  const f = await fixture(t, { mode: 'failed' });
  await assert.rejects(f.start('Synthetic Profile'), error => {
    assert.equal(error.code, 'PLAYWRIGHT_CONNECT_FAILED');
    assert.match(error.nextAction ?? error.next_action, /open the Chrome window.*Do not read files in the Chrome profile/s);
    assert.ok(!error.message.includes(TOKEN)); return true;
  });
  assert.equal(f.children.length, 1);
  assert.equal((await readJson(path.join(f.directory, 'bridge-service.json'))).phase, 'failed');
});

test('spawn failure leaves a failed reservation and safe log, without a child or stale launch lock', async t => {
  const f = await fixture(t);
  f.hooks.spawnProcess = () => { throw new Error(TOKEN); };
  await assert.rejects(f.start('Synthetic Profile'), { code: 'BRIDGE_START_FAILED' });
  const record = await readJson(path.join(f.directory, 'bridge-service.json'));
  assert.equal(record.phase, 'failed');
  assert.equal(record.pid, null);
  const log = await readFile(path.join(f.directory, 'bridge-service.log'), 'utf8');
  assert.ok(log.includes('service_failed'));
  assert.ok(!log.includes(TOKEN));
  assert.ok(!(await readdir(f.directory)).includes('bridge-service.lock'));
});

test('startup timeout keeps the original process and returns uncertainty; a later start reuses it', async t => {
  const f = await fixture(t, { mode: 'starting' });
  f.hooks.timeoutMs = 300;
  const first = await f.start('Synthetic Profile');
  assert.equal(first.ok, false);
  assert.equal(first.status, 'bridge_starting');
  assert.equal(f.children[0].disconnects, 1);
  f.states.get(ENDPOINT).state = 'ready'; f.states.get(ENDPOINT).extensionConnected = true;
  const second = await f.start();
  assert.equal(second.ok, true);
  assert.equal(second.started, false);
  assert.equal(second.instance_id, first.instance_id);
  assert.equal(f.children.length, 1);
  assert.equal((await readJson(path.join(f.directory, 'bridge-service.json'))).phase, 'ready');
});

test('a disconnected live instance is never reconnected or replaced by repeated start', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  Object.assign(f.states.get(ENDPOINT), { state: 'disconnected', extensionConnected: false, error_code: 'EXTENSION_DISCONNECTED' });
  await assert.rejects(f.start(), { code: 'EXTENSION_DISCONNECTED' });
  assert.equal(f.children.length, 1);
  assert.equal(f.shutdowns.length, 0);
});

test('a reused PID with no responding endpoint is never killed or adopted as a healthy service', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  f.states.delete(ENDPOINT);
  f.hooks.timeoutMs = 300;
  assert.equal((await f.start()).ok, false);
  await assert.rejects(f.stop(), { code: 'BRIDGE_START_UNCERTAIN' });
  assert.equal(f.children.length, 1);
  assert.equal(f.shutdowns.length, 0);
});

test('stale launch lock recovery requires both a dead launcher and compatible or absent service metadata', async t => {
  const f = await fixture(t);
  const first = await f.start('Synthetic Profile');
  const stale = { schema_version: 1, pid: 999999, lock_id: randomUUID() };
  await writeJson(path.join(f.directory, 'bridge-service.lock'), stale);
  const reused = await f.start();
  assert.equal(reused.instance_id, first.instance_id);
  assert.equal(f.children.length, 1);
  assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.lock')));
  f.states.set(ENDPOINT, { running: true, extensionConnected: true });
  await writeJson(path.join(f.directory, 'bridge-service.lock'), stale);
  await assert.rejects(f.start(), { code: 'BRIDGE_PORT_IN_USE' });
  assert.deepEqual(await readJson(path.join(f.directory, 'bridge-service.lock')), stale);
});

test('active locks, incomplete recovery reservations and unsafe runtime files do not refresh ownership', async t => {
  const f = await fixture(t);
  f.hooks.timeoutMs = 300;
  await writeJson(path.join(f.directory, 'bridge-service.lock'), { schema_version: 1, pid: process.pid, lock_id: randomUUID() });
  await assert.rejects(f.start('Synthetic Profile'), { code: 'BRIDGE_START_IN_PROGRESS' });
  await rm(path.join(f.directory, 'bridge-service.lock'));
  await writeJson(path.join(f.directory, 'bridge-service-recovery.lock'), { pid: 999999 });
  await assert.rejects(f.start('Synthetic Profile'), { code: 'BRIDGE_LOCK_UNCERTAIN' });
  await rm(path.join(f.directory, 'bridge-service-recovery.lock'));
  const target = path.join(f.root, 'synthetic-config.json');
  await writeJson(target, { schema_version: 1, profile: 'Synthetic Profile' });
  await symlink(target, path.join(f.directory, 'playwright-service-config.json'));
  await assert.rejects(f.start(), { code: 'INVALID_BRIDGE_RECORD' });
  assert.equal(f.children.length, 0);
});

test('stop sends one independent management credential, confirms exit and is idempotent', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  const record = await readJson(path.join(f.directory, 'bridge-service.json'));
  const result = await f.stop();
  assert.equal(result.stopped, true);
  assert.deepEqual(f.shutdowns, [{ endpoint: ENDPOINT, body: { instance_id: record.instance_id, management_key: record.management_key } }]);
  assert.notEqual(f.shutdowns[0].body.management_key, TOKEN);
  assert.ok(!JSON.stringify(result).includes(record.management_key));
  assert.equal((await readJson(path.join(f.directory, 'bridge-service.json'))).phase, 'stopped');
  assert.equal((await f.stop()).stopped, false);
  assert.equal(f.shutdowns.length, 1);
  assert.equal((await readJson(path.join(f.directory, 'playwright-service-config.json'))).profile, 'Synthetic Profile');
});

test('wrong instance identity and uncertain stop acknowledgements never cause signals or repeated stop requests', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  const original = f.states.get(ENDPOINT).instance_id;
  f.states.get(ENDPOINT).instance_id = randomUUID();
  await assert.rejects(f.stop(), { code: 'BRIDGE_PORT_IN_USE' });
  assert.equal(f.shutdowns.length, 0);
  f.states.get(ENDPOINT).instance_id = original;
  let requests = 0;
  f.hooks.shutdown = async () => { requests++; return { stopping: true, instance_id: randomUUID() }; };
  await assert.rejects(f.stop(), { code: 'BRIDGE_STOP_UNCERTAIN' });
  assert.equal(requests, 1);
});

test('stop timeout preserves the record, without killing or automatically retrying', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  const before = await readFile(path.join(f.directory, 'bridge-service.json'));
  let requests = 0;
  f.hooks.timeoutMs = 300;
  f.hooks.shutdown = async () => { requests++; return { stopping: true, instance_id: f.states.get(ENDPOINT).instance_id }; };
  await assert.rejects(f.stop(), { code: 'BRIDGE_STOP_UNCERTAIN' });
  assert.equal(requests, 1);
  assert.deepEqual(await readFile(path.join(f.directory, 'bridge-service.json')), before);
});

test('logs roll over within their size cap and accept only fixed events and sanitized codes', async t => {
  const f = await fixture(t);
  const logger = createBridgeLogger(f.directory, { maxBytes: 512 });
  for (let index = 0; index < 30; index++) await logger.event('service_failed', TOKEN);
  await logger.flush();
  const file = path.join(f.directory, 'bridge-service.log'), text = await readFile(file, 'utf8');
  assert.ok((await stat(file)).size <= 512);
  assert.ok(!text.includes(TOKEN));
  for (const line of text.trim().split('\n')) assert.equal(JSON.parse(line).error_code, 'BRIDGE_START_FAILED');
  await assert.rejects(logger.event(TOKEN), { code: 'INVALID_ARGUMENTS' });
});

test('runtime and credential-record permissions are checked without silently repairing them', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await chmod(f.directory, 0o755);
  await assert.rejects(f.start('Synthetic Profile'), { code: 'BRIDGE_RUNTIME_INVALID' });
  assert.equal((await stat(f.directory)).mode & 0o777, 0o755);
  await chmod(f.directory, 0o700);
  await f.start('Synthetic Profile');
  await chmod(path.join(f.directory, 'bridge-service.json'), 0o644);
  await assert.rejects(f.stop(), { code: 'INVALID_BRIDGE_RECORD' });
  assert.equal(f.shutdowns.length, 0);
});

test('managed bootstrap checks the committed instance, installation and actual child PID', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  const recordPath = path.join(f.directory, 'bridge-service.json'), record = await readJson(recordPath);
  record.phase = 'starting'; await writeJson(recordPath, record);
  const bootstrap = f.children[0].message;
  const options = { runtimeDirectory: f.directory, skillDirectory: f.root, pid: record.pid };
  assert.equal((await loadBridgeBootstrap(bootstrap, options)).instance_id, record.instance_id);
  await assert.rejects(loadBridgeBootstrap(bootstrap, { ...options, pid: record.pid + 1 }), { code: 'BRIDGE_BOOTSTRAP_FAILED' });
  await assert.rejects(loadBridgeBootstrap({ ...bootstrap, instance_id: randomUUID() }, options), { code: 'BRIDGE_BOOTSTRAP_FAILED' });
});

test('the detached runner survives launcher IPC disconnect and keeps credentials out of messages and logs', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  const filename = path.join(f.directory, 'bridge-service.json'), record = await readJson(filename);
  record.phase = 'starting'; await writeJson(filename, record);
  const channel = new EventEmitter(), messages = [];
  channel.connected = true; channel.send = (value, callback) => { messages.push(value); callback(); };
  let givenOptions, givenHooks, stopped = 0;
  const running = { stop: async () => { stopped++; await givenHooks.onStopping(); await givenHooks.onStopped(); } };
  const pending = runManagedBridge({ channel, bootstrapOptions: { runtimeDirectory: f.directory, skillDirectory: f.root, pid: record.pid },
    startService: async (options, hooks) => { givenOptions = options; givenHooks = hooks; return running; } });
  channel.emit('message', f.children[0].message);
  assert.equal(await pending, running);
  assert.equal(givenOptions.management.key, record.management_key);
  assert.equal(givenOptions.profile, 'Synthetic Profile');
  channel.connected = false; channel.emit('disconnect');
  assert.equal(stopped, 0);
  await running.stop();
  assert.ok(!JSON.stringify(messages).includes(record.management_key));
  assert.ok(!(await readFile(path.join(f.directory, 'bridge-service.log'), 'utf8')).includes(record.management_key));
});

test('shutdown HTTP guard requires the independent key and never returns it', async () => {
  const management = { instanceId: randomUUID(), installId: 'b'.repeat(64), pid: 900001, key: 'a'.repeat(64) };
  const service = new PlaywrightService({ instanceId: management.instanceId });
  let stops = 0;
  const handler = bridgeProtocolHandler(service, () => ({ port: 19825 }), '127.0.0.1', { management,
    onShutdown: async () => { stops++; } });
  const request = async (body, headers = {}) => {
    const incoming = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(incoming, { method: 'POST', url: '/shutdown', headers: { host: '127.0.0.1:19825', 'content-type': 'application/json', ...headers } });
    const response = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await handler(incoming, response); await Promise.resolve(); return response;
  };
  assert.equal((await request({ instance_id: management.instanceId, management_key: TOKEN })).status, 403);
  assert.equal((await request({ instance_id: randomUUID(), management_key: management.key })).status, 403);
  assert.equal((await request({ instance_id: management.instanceId, management_key: management.key }, { origin: 'https://synthetic.example' })).status, 403);
  assert.equal(stops, 0);
  const allowed = await request({ instance_id: management.instanceId, management_key: management.key });
  assert.equal(allowed.status, 200);
  assert.equal(stops, 1);
  assert.ok(!JSON.stringify(allowed).includes(management.key));
  await service.stop();
});

test('CLI routes start and stop using the official default endpoint without touching real runtime state', async t => {
  const previousEndpoint = process.env.SHOPPING_BRIDGE_ENDPOINT;
  delete process.env.SHOPPING_BRIDGE_ENDPOINT;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.SHOPPING_BRIDGE_ENDPOINT;
    else process.env.SHOPPING_BRIDGE_ENDPOINT = previousEndpoint;
  });
  const calls = [];
  const services = {
    start: async options => { calls.push(['start', options]); return { ok: true, status: 'bridge_connected', started: false }; },
    stop: async options => { calls.push(['stop', options]); return { ok: true, status: 'bridge_stopped', stopped: true }; },
  };
  const run = async args => {
    let output = '';
    const code = await main(args, { write: text => { output += text; }, services });
    return { code, value: JSON.parse(output) };
  };
  assert.equal((await run(['bridge-start', '--profile', 'Synthetic Profile'])).code, 0);
  assert.equal(calls[0][1].endpoint, 'http://127.0.0.1:19825');
  assert.equal(calls[0][1].profile, 'Synthetic Profile');
  assert.equal((await run(['bridge-stop', '--endpoint', ENDPOINT])).code, 0);
  assert.deepEqual(calls[1], ['stop', { endpoint: ENDPOINT }]);
  assert.equal((await run(['bridge-stop', '--profile', 'Synthetic Profile'])).value.error.code, 'INVALID_ARGUMENTS');
  assert.equal(calls.length, 2);
});

test('the local metadata and shutdown client uses bounded direct HTTP and sends the key only after ownership matches', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  const requests = [];
  t.mock.method(http, 'request', (url, options, onResponse) => {
    const outgoing = new EventEmitter();
    outgoing.end = body => {
      requests.push({ url, options, body });
      queueMicrotask(() => {
        let value;
        if (url.endsWith('/status')) {
          value = f.states.get(ENDPOINT);
          if (!value) { outgoing.emit('error', Object.assign(new Error('Synthetic refused'), { code: 'ECONNREFUSED' })); return; }
        } else {
          const credential = JSON.parse(body), status = f.states.get(ENDPOINT);
          value = { stopping: true, instance_id: credential.instance_id };
          f.states.delete(ENDPOINT); f.live.delete(status.pid);
        }
        const response = Readable.from([Buffer.from(JSON.stringify(value))]);
        response.statusCode = 200; onResponse(response);
      });
    };
    return outgoing;
  });
  const { probe, shutdown, ...hooks } = f.hooks;
  assert.equal((await stopBridgeService(f.options, hooks)).stopped, true);
  const posts = requests.filter(request => request.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/shutdown'));
  assert.ok(!posts[0].body.includes(TOKEN));
  assert.ok(requests.every(request => request.options.agent === false));
  assert.ok(requests.filter(request => request.options.method === 'GET').every(request => request.body === undefined));
});

test('redirects, malformed or oversized metadata and uncertain transport errors never trigger a launch or retry', async t => {
  const f = await fixture(t);
  let mode = 'redirect', requests = 0;
  t.mock.method(http, 'request', (url, options, onResponse) => {
    const outgoing = new EventEmitter();
    outgoing.end = () => queueMicrotask(() => {
      requests++;
      if (mode === 'uncertain') { outgoing.emit('error', new Error(TOKEN)); return; }
      const response = Readable.from([Buffer.from(mode === 'oversized' ? 'x'.repeat(8193) : '{')]);
      response.statusCode = mode === 'redirect' ? 302 : 200;
      onResponse(response);
    });
    return outgoing;
  });
  const { probe, ...hooks } = f.hooks;
  for (mode of ['redirect', 'malformed', 'oversized', 'uncertain']) {
    const before = requests;
    await assert.rejects(startBridgeService({ ...f.options, profile: 'Synthetic Profile' }, hooks),
      { code: mode === 'uncertain' ? 'BRIDGE_STATUS_UNCERTAIN' : 'BRIDGE_PORT_IN_USE' });
    assert.equal(requests, before + 1);
  }
  assert.equal(f.children.length, 0);
});

test('a status probe reset while the service closes does not end the stop confirmation', async t => {
  const f = await fixture(t);
  await f.start('Synthetic Profile');
  const { ShoppingError } = await import('../lib/errors.mjs');
  let resets = 0;
  const probe = f.hooks.probe;
  const hooks = { ...f.hooks, probe: async endpoint => {
    // The first probe after shutdown lands on the closing server and is reset, as on the clean machine 2026-11-07.
    if (f.shutdowns.length === 1 && resets === 0) { resets++; throw new ShoppingError('BRIDGE_STATUS_UNCERTAIN', 'reset'); }
    return probe(endpoint);
  } };
  const result = await stopBridgeService(f.options, hooks);
  assert.equal(result.stopped, true);
  assert.equal(resets, 1);
  assert.equal((await readJson(path.join(f.directory, 'bridge-service.json'))).phase, 'stopped');
  assert.equal(f.shutdowns.length, 1);
});
