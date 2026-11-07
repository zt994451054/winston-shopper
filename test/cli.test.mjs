import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';
import { rawProduct } from '../test-support/product-fixture.mjs';
import { rawDetails } from '../test-support/detail-fixture.mjs';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; }, environment: { inspectBackend: async () => ({ installed: true, lock_verified: true }) } });
  return { code, value: JSON.parse(output), output };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('detail tasks run through the CLI, cache results and reject incompatible modes before browser reads', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  assert.equal((await run(['bind', ...common, '--tab', '41', '--binding', 'sample'])).code, 0);
  const before = state.commands.length;
  for (const args of [['--bindings', 'sample', '--reviews'], ['--search', 'mouse', '--tab', '41'], ['--plan', 'missing.json']]) {
    const result = await run(['task-start', ...common, '--task', 'invalid', '--details', ...args]);
    assert.equal(result.value.error.code, 'INVALID_ARGUMENTS');
  }
  const tooMany = await run(['task-start', ...common, '--task', 'invalid', '--details', '--bindings', new Array(11).fill('sample').join(',')]);
  assert.equal(tooMany.value.error.code, 'INVALID_BINDINGS');
  assert.equal(state.commands.length, before);
  const started = await run(['task-start', ...common, '--task', 'details', '--bindings', 'sample', '--details']);
  assert.equal(started.value.task_kind, 'product_details');
  state.metadata = { state: 'verification_required' };
  const paused = await run(['task-run', ...common, '--task', 'details']);
  assert.equal(paused.value.status, 'waiting_user');
  const gatedReads = state.commands.length;
  await run(['task-run', ...common, '--task', 'details']);
  assert.equal(state.commands.length, gatedReads);
  state.metadata = rawDetails();
  const completed = await run(['task-resume', ...common, '--task', 'details', '--after-user']);
  assert.equal(completed.value.status, 'complete');
  assert.equal(completed.value.operations[0].result.details.gallery.items.length, 2);
  const reads = state.commands.length;
  assert.equal((await run(['task-run', ...common, '--task', 'details'])).value.status, 'complete');
  assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'details'])).code, 0);
  assert.equal(state.commands.length, reads);
  const filename = path.join(directory, 'tasks/details.json');
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  saved.operations[0].result.details.coverage.full_description = true;
  await writeFile(filename, JSON.stringify(saved));
  assert.equal((await run(['task-run', ...common, '--task', 'details'])).value.error.code, 'INVALID_CHECKPOINT');
  assert.equal(state.commands.length, reads);
});

test('doctor reports bridge readiness separately from account login', async t => {
  const { endpoint } = await mockBridge(t);
  const { value, code } = await run(['doctor', '--endpoint', endpoint]);
  assert.equal(code, 0);
  assert.equal(value.status, 'ready');
  assert.equal(value.login_verified, false);
  assert.equal(value.connection.tab_count, undefined);
  assert.equal(value.connection.inventory_scope, 'playwright_connected_pages');
});

test('tab command redacts titles, tracking parameters, order identifiers, and other sites', async t => {
  const { endpoint } = await mockBridge(t);
  const { value, output } = await run(['tabs', '--endpoint', endpoint]);
  assert.equal(value.tabs.length, 2);
  assert.equal(value.inventory_scope, 'playwright_connected_pages');
  assert.ok(!output.includes('PRIVATE'));
  assert.ok(!output.includes('mail.example'));
});

test('binding persists across commands, disconnect and reconnect, without claiming account continuity', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory, '--binding', 'sample'];
  const bound = await run(['bind', ...common, '--tab', '41']);
  assert.equal(bound.value.status, 'bound');
  const before = await readFile(path.join(directory, 'sample.json'), 'utf8');
  assert.ok(!before.includes('PRIVATE'));
  const firstProbe = await run(['probe', ...common]);
  assert.equal(firstProbe.value.metadata.product_id, '123');
  state.connected = false;
  const priorCommands = state.commands.length;
  const disconnected = await run(['probe', ...common]);
  assert.equal(disconnected.value.error.code, 'EXTENSION_DISCONNECTED');
  assert.equal(state.commands.length, priorCommands);
  assert.equal(await readFile(path.join(directory, 'sample.json'), 'utf8'), before);
  state.connected = true;
  const restored = await run(['probe', ...common]);
  assert.equal(restored.code, 0);
  assert.equal(restored.value.automatic_retries, 0);
  assert.equal(restored.value.login_verified, false);
});

test('changed product fails before eval and never falls back to another tab', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['bind', ...common, '--tab', '41']);
  const before = state.commands.filter(command => command.action === 'eval').length;
  state.tabs[0].url = 'https://detail.tmall.com/item.htm?id=999';
  state.tabs.push({ id: 45, url: 'https://detail.tmall.com/item.htm?id=123' });
  const result = await run(['probe', ...common]);
  assert.equal(result.value.error.code, 'TARGET_CHANGED');
  assert.equal(state.commands.filter(command => command.action === 'eval').length, before);
});

test('page changes between tab listing and DOM read produce TARGET_CHANGED', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['bind', ...common, '--tab', '41']);
  state.metadata = { state: 'target_changed' };
  const result = await run(['probe', ...common]);
  assert.equal(result.value.error.code, 'TARGET_CHANGED');
});

test('closed bound tab produces TARGET_MISSING', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['bind', ...common, '--tab', '41']);
  state.tabs = [];
  const result = await run(['probe', ...common]);
  assert.equal(result.value.error.code, 'TARGET_MISSING');
});

test('endpoint mismatch stops before contacting a second service', async t => {
  const first = await mockBridge(t);
  const second = await mockBridge(t);
  const directory = await stateDirectory(t);
  await run(['bind', '--endpoint', first.endpoint, '--state-dir', directory, '--tab', '41']);
  const result = await run(['probe', '--endpoint', second.endpoint, '--state-dir', directory]);
  assert.equal(result.value.error.code, 'BINDING_ENDPOINT_MISMATCH');
  assert.equal(second.state.requests.length, 0);
});

test('corrupt binding fails before any browser request', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  await writeFile(path.join(directory, 'default.json'), 'invalid private data');
  const result = await run(['probe', '--endpoint', endpoint, '--state-dir', directory]);
  assert.equal(result.value.error.code, 'INVALID_BINDING');
  assert.equal(state.requests.length, 0);
  assert.ok(!result.output.includes('private data'));
});

test('invalid arguments fail without reflecting potentially sensitive values', async t => {
  const { endpoint, state } = await mockBridge(t);
  for (const args of [
    ['tabs', '--endpoint', endpoint, '--unknown', 'PRIVATE_SECRET'],
    ['bind', '--endpoint', endpoint, '--tab', '1', '--binding', '../../PRIVATE_SECRET'],
    ['tabs', '--endpoint', 'http://user:PRIVATE_SECRET@127.0.0.1:19824'],
    ['doctor', '--endpoint', endpoint, '--tab', '41'],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.ok(!result.output.includes('PRIVATE_SECRET'));
  }
  assert.equal(state.requests.length, 0);
});

test('task CLI reads product regions through the actual bridge adapter and later returns saved results', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['bind', ...common, '--tab', '41']);
  const created = await run(['task-start', ...common, '--task', 'sample', '--bindings', 'default']);
  assert.equal(created.value.status, 'task_created');
  state.metadata = rawProduct();
  const observed = await run(['task-run', ...common, '--task', 'sample']);
  assert.equal(observed.code, 0);
  assert.equal(observed.value.operations[0].result.prices[0].minimum, '89');
  assert.equal(observed.value.operations[0].result.prices[0].amount, null);
  const requests = state.requests.length;
  assert.equal((await run(['task-run', ...common, '--task', 'sample'])).value.completed, 1);
  assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'sample'])).value.completed, 1);
  assert.equal(state.requests.length, requests);
});

test('verification returned by the bridge stops the CLI and requires an explicit recovery flag', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['bind', ...common, '--tab', '41']);
  await run(['task-start', ...common, '--task', 'sample', '--bindings', 'default']);
  state.metadata = { state: 'verification_required' };
  assert.equal((await run(['task-run', ...common, '--task', 'sample'])).value.status, 'waiting_user');
  const before = state.requests.length;
  assert.equal((await run(['task-run', ...common, '--task', 'sample'])).value.error.code, 'RECOVERY_REQUIRED');
  assert.equal((await run(['task-resume', ...common, '--task', 'sample'])).value.error.code, 'INVALID_RECOVERY');
  assert.equal(state.requests.length, before);
  state.metadata = rawProduct();
  const resumed = await run(['task-resume', ...common, '--task', 'sample', '--after-user']);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.value.operations[0].attempts, 2);
  assert.equal(resumed.value.automatic_retries, 0);
});

test('login navigation is classified without evaluating login contents and recovers only on the original product', async t => {
  const { endpoint, state } = await mockBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['bind', ...common, '--tab', '41']);
  await run(['task-start', ...common, '--task', 'sample', '--bindings', 'default']);
  const before = state.commands.filter(command => command.action === 'eval').length;
  state.tabs[0].url = 'https://login.taobao.com/member/login.jhtml?token=PRIVATE';
  const result = await run(['task-run', ...common, '--task', 'sample']);
  assert.equal(result.value.operations[0].error.code, 'LOGIN_REQUIRED');
  assert.equal(state.commands.filter(command => command.action === 'eval').length, before);
  assert.ok(!result.output.includes('PRIVATE'));
  state.tabs[0].url = rawProduct().url;
  state.metadata = rawProduct();
  assert.equal((await run(['task-resume', ...common, '--task', 'sample', '--after-user'])).code, 0);
});
