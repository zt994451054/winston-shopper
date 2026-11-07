import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { createTask, runTask, rebindTask, taskStatus, endTask } from '../lib/tasks.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { withTaskStore, loadTask, validateTask } from '../lib/task-store.mjs';
import { failureCategory } from '../lib/task-policy.mjs';
import { validateSearch } from '../lib/search.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';
import * as setup from '../lib/setup.mjs';

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping archived browser '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function denyHttp(t) {
  const requests = [];
  t.mock.method(http, 'request', (...args) => { requests.push(args); throw new Error('Browser IO is forbidden for retired task tests.'); });
  return requests;
}

async function cli(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output), output };
}

async function legacyTask(t, { complete = false, status = 'pending', errorCode = 'BROWSER_DISCONNECTED' } = {}) {
  const stateDirectory = await directory(t), endpoint = 'http://127.0.0.1:45678';
  const bridge = { endpoint, protocol: 'playwright-extension', readSearch: async (_id, target) => validateSearch(rawSearch(target), target) };
  const options = { stateDirectory, task: 'sample', bridge };
  await createTask({ ...options, search: 'synthetic', tabId: 1 });
  if (complete) await runTask(options);
  // Old schema-1 checkpoints retain this marker; creating a new CDP task is no longer an available fixture path.
  await withTaskStore(stateDirectory, 'sample', async store => {
    const saved = await store.load(); saved.browser_session = 'dedicated';
    if (!complete && status !== 'pending') {
      saved.status = status;
      saved.operations[0].attempts = 1;
      saved.operations[0].read_action.observations = 1;
      saved.operations[0].error = { code: errorCode, category: failureCategory(errorCode) };
    }
    await store.save(saved);
  });
  bridge.readSearch = () => assert.fail('An archived task must never be read again from a browser.');
  return { options, bridge, stateDirectory, filename: path.join(stateDirectory, 'tasks/sample.json') };
}

test('retired commands and flags fail before browser IO or state-directory access and no longer appear in help', async t => {
  const requests = denyHttp(t), root = await directory(t), stateDirectory = path.join(root, 'absent');
  for (const args of [
    ['browser-start'], ['browser-status'], ['browser-start', '--relaunch'], ['task-connect', '--task', 'sample'],
    ['doctor', '--dedicated'], ['tabs', '--dedicated'], ['page-open', '--dedicated', '--search', 'synthetic'],
    ['task-start', '--task', 'sample', '--search', 'synthetic', '--tab', '1', '--dedicated'],
    ['bridge-start', '--browser-executable', '/synthetic/chrome'], ['bridge-start', '--relaunch'],
  ]) {
    const result = await cli([...args, '--state-dir', stateDirectory]);
    assert.equal(result.code, 2);
    assert.equal(result.value.error.code, 'INVALID_ARGUMENTS');
    assert.ok(!result.output.includes('/synthetic/chrome'));
  }
  await assert.rejects(readFile(stateDirectory), { code: 'ENOENT' });
  let help = '';
  assert.equal(await main(['--help'], { write: text => { help += text; } }), 0);
  for (const removed of ['browser-start', 'browser-status', 'task-connect', '--dedicated', '--relaunch', '--browser-executable']) assert.ok(!help.includes(removed));
  assert.equal(requests.length, 0);
});

test('the bridge rejects the retired transport option instead of falling back to or invoking it', async t => {
  const requests = denyHttp(t);
  for (const transport of [null, {}, { protocol: 'owned-chrome-cdp', endpoint: 'http://127.0.0.1:45678',
    status: () => assert.fail('Retired transport selected'), command: () => assert.fail('Retired transport selected') }]) {
    assert.throws(() => new BrowserBridge('http://127.0.0.1:19825', { transport }), { code: 'INVALID_TRANSPORT' });
  }
  assert.equal(new BrowserBridge('http://127.0.0.1:19825').protocol, 'playwright-extension');
  assert.equal(requests.length, 0);
});

test('new tasks cannot acquire a retired browser marker through the removed protocol', async t => {
  const requests = denyHttp(t), root = await directory(t), stateDirectory = path.join(root, 'absent');
  await assert.rejects(createTask({ stateDirectory, task: 'sample', search: 'synthetic', tabId: 1,
    bridge: { endpoint: 'http://127.0.0.1:45678', protocol: 'owned-chrome-cdp' } }), { code: 'INVALID_TRANSPORT' });
  await assert.rejects(readFile(stateDirectory), { code: 'ENOENT' });
  assert.equal(requests.length, 0);
});

test('unfinished retired checkpoints reject run, resume, next batch, rebind and diagnosis without mutation or connection', async t => {
  const requests = denyHttp(t);
  for (const status of ['pending', 'waiting_connection']) {
    const f = await legacyTask(t, { status }), bytes = await readFile(f.filename);
    for (const command of ['task-run', 'task-next-batch', 'task-rebind', 'task-diagnose']) {
      const result = await cli([command, '--task', 'sample', '--state-dir', f.stateDirectory]);
      assert.equal(result.value.error.code, 'LEGACY_BROWSER_TASK');
      assert.deepEqual(await readFile(f.filename), bytes);
    }
    const result = await cli(['task-resume', '--task', 'sample', '--state-dir', f.stateDirectory, '--after-connection']);
    assert.equal(result.value.error.code, 'LEGACY_BROWSER_TASK');
    for (const operation of [() => runTask(f.options), () => runTask({ ...f.options, recovery: 'connection' }),
      () => rebindTask({ ...f.options, tabId: 2 }), () => diagnoseTask(f.options)]) {
      await assert.rejects(operation(), { code: 'LEGACY_BROWSER_TASK' });
      assert.deepEqual(await readFile(f.filename), bytes);
    }
    assert.equal((await taskStatus(f.options)).status, status);
    assert.equal(requests.length, 0);
  }
});

test('completed retired search caches remain readable through CLI run, next batch, status and exports without a session file', async t => {
  const requests = denyHttp(t), f = await legacyTask(t, { complete: true });
  const bytes = await readFile(f.filename), original = await taskStatus(f.options);
  for (const command of ['task-run', 'task-next-batch', 'task-status']) {
    const result = await cli([command, '--task', 'sample', '--state-dir', f.stateDirectory]);
    assert.equal(result.code, 0);
    assert.equal(result.value.status, 'complete');
    assert.deepEqual(result.value.operations[0].result, original.operations[0].result);
    assert.deepEqual(await readFile(f.filename), bytes);
  }
  const outputDirectory = await directory(t);
  for (const format of ['markdown', 'csv']) {
    const result = await cli(['report-export', '--task', 'sample', '--state-dir', f.stateDirectory, '--format', format,
      '--output', path.join(outputDirectory, `report.${format}`)]);
    assert.equal(result.code, 0);
    assert.equal(result.value.browser_accessed, false);
    assert.deepEqual(await readFile(f.filename), bytes);
  }
  assert.equal((await loadTask(f.stateDirectory, 'sample')).browser_session, 'dedicated');
  assert.equal(requests.length, 0);
});

test('stopped retired rounds preserve original connection errors and can only be ended locally', async t => {
  const requests = denyHttp(t);
  for (const errorCode of ['BROWSER_DISCONNECTED', 'BROWSER_SESSION_CHANGED']) {
    const f = await legacyTask(t, { status: 'stopped', errorCode }), bytes = await readFile(f.filename);
    const saved = await loadTask(f.stateDirectory, 'sample');
    assert.equal(failureCategory(errorCode), 'connection');
    validateTask(saved);
    const cached = await cli(['task-run', '--task', 'sample', '--state-dir', f.stateDirectory]);
    assert.equal(cached.code, 2);
    assert.equal(cached.value.status, 'stopped');
    assert.deepEqual(cached.value.operations[0].error, { code: errorCode, category: 'connection' });
    assert.deepEqual(await readFile(f.filename), bytes);
    const ended = await endTask(f.options);
    assert.equal(ended.status, 'ended');
    assert.equal((await loadTask(f.stateDirectory, 'sample')).browser_session, 'dedicated');
    assert.deepEqual(ended.operations[0].error, cached.value.operations[0].error);
  }
  assert.equal(requests.length, 0);
});

test('setup exposes only the Playwright dependency preparation and inspection APIs', () => {
  assert.deepEqual(Object.keys(setup).sort(), ['inspectPlaywrightBackend', 'preparePlaywrightBackend']);
});
