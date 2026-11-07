import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask, withTaskStore, validateTask } from '../lib/task-store.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { productResult } from '../test-support/product-fixture.mjs';
import { validateProduct } from '../lib/product.mjs';
import { retryDecision, TASK_POLICY } from '../lib/task-policy.mjs';
import { rebindTask, endTask } from '../lib/tasks.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function fixture(t, ids = ['123'], action = async id => productResult(id)) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping tasks '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const calls = [], waits = [];
  let time = Date.parse('2026-09-15T00:00:00Z');
  const clock = { now: () => time, wait: async ms => { waits.push(ms); time += ms; } };
  const bridge = { endpoint: 'http://127.0.0.1:19824', async readProduct(tabId, target) {
    calls.push(target.product_id); return action(target.product_id, calls.length);
  } };
  const bindings = [];
  for (const [index, id] of ids.entries()) {
    const binding = `p${index}`;
    bindings.push(binding);
    await saveBinding(stateDirectory, binding, { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint,
      tab_id: index + 1, target: parseProductUrl(`https://detail.tmall.com/item.htm?id=${id}`), created_at: new Date(time).toISOString() });
  }
  const options = { task: 'sample', stateDirectory, bridge, bindings };
  await createTask(options);
  return { options, calls, waits, clock };
}

function fail(code) { throw new ShoppingError(code, 'Synthetic failure'); }

test('structure reasons survive checkpoint and cached reports without retries or reads of the next product', async t => {
  const f = await fixture(t, ['123', '456'], () => validateProduct({ state: 'structure_changed', reason: 'price_region_ambiguous' },
    parseProductUrl('https://detail.tmall.com/item.htm?id=123')));
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.operations[0].error, { code: 'PAGE_STRUCTURE_CHANGED', category: 'diagnostic', reason: 'price_region_ambiguous' });
  assert.equal(result.operations[1].attempts, 0);
  assert.equal(result.automatic_retries + result.wait_reserved_ms, 0);
  const saved = await loadTask(f.options.stateDirectory, 'sample');
  assert.deepEqual(saved.operations[0].error, result.operations[0].error);
  assert.deepEqual((await runTask(f.options, f.clock)).operations[0].error, result.operations[0].error);
  assert.deepEqual(f.calls, ['123']); assert.deepEqual(f.waits, []);
});

test('old checkpoints do not acquire invented structure reasons; invalid reasons are rejected', async t => {
  const f = await fixture(t, ['123'], () => fail('PAGE_STRUCTURE_CHANGED'));
  await runTask(f.options, f.clock);
  const saved = await loadTask(f.options.stateDirectory, 'sample'), before = JSON.stringify(saved);
  validateTask(saved);
  assert.equal(JSON.stringify(saved), before);
  assert.equal(Object.hasOwn(saved.operations[0].error, 'reason'), false);
  for (const reason of ['PRIVATE_TEXT', '__proto__', null, undefined, {}, ['title_missing']]) {
    const changed = structuredClone(saved); changed.operations[0].error.reason = reason;
    assert.throws(() => validateTask(changed), { code: 'INVALID_CHECKPOINT' });
  }
  for (const error of [
    { code: 'BRIDGE_TIMEOUT', category: 'transient', reason: 'title_missing' },
    { code: 'PAGE_STRUCTURE_CHANGED', category: 'transient', reason: 'title_missing' },
  ]) {
    const changed = structuredClone(saved); changed.operations[0].error = error;
    assert.throws(() => validateTask(changed), { code: 'INVALID_CHECKPOINT' });
  }
});

test('untrusted error details are not persisted as structure reasons', async t => {
  const f = await fixture(t, ['123'], () => {
    const error = new ShoppingError('PAGE_STRUCTURE_CHANGED', 'PRIVATE_TEXT');
    error.productStructureReason = 'PRIVATE_TEXT'; throw error;
  });
  const result = await runTask(f.options, f.clock);
  assert.deepEqual(result.operations[0].error, { code: 'PAGE_STRUCTURE_CHANGED', category: 'diagnostic' });
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TEXT'));
});

test('duplicate logical products run once; completed tasks return cached results without reading again', async t => {
  const f = await fixture(t, ['123', '123', '456']);
  const first = await runTask(f.options, f.clock);
  assert.equal(first.status, 'complete');
  assert.deepEqual(f.calls, ['123', '456']);
  assert.deepEqual(f.waits, [1500]);
  assert.equal((await runTask(f.options, f.clock)).completed, 2);
  assert.equal(f.calls.length, 2);
  await assert.rejects(createTask(f.options), { code: 'TASK_EXISTS' });
});

test('a transient operation gets at most three total reads, with 5s and 15s persisted waits', async t => {
  const f = await fixture(t, ['123'], () => fail('BRIDGE_TIMEOUT'));
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'partial');
  assert.equal(result.operations[0].error.code, 'OPERATION_RETRY_LIMIT');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.waits, [5000, 15000]);
  assert.equal(result.automatic_retries, 2);
  assert.equal(result.wait_reserved_ms, 20000);
  await runTask(f.options, f.clock);
  assert.equal(f.calls.length, 3);
});

test('platform retry ceiling includes failures on different products and stops the remaining queue', async t => {
  const f = await fixture(t, ['123', '456', '789', '999'], () => fail('PAGE_LOADING'));
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(result.automatic_retries, 5);
  assert.deepEqual(f.calls, ['123', '123', '123', '456', '456', '456', '789', '789']);
  assert.equal(result.operations[2].error.code, 'PLATFORM_RETRY_LIMIT');
  assert.equal(result.operations[3].attempts, 0);
});

test('verification pauses all pending reads, and only explicit user recovery permits one check', async t => {
  let blocked = true;
  const f = await fixture(t, ['123', '456'], id => blocked ? fail('VERIFICATION_REQUIRED') : productResult(id));
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user');
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.calls.length, 1);
  const checked = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(checked.status, 'waiting_user');
  assert.equal(f.calls.length, 2);
  assert.equal(checked.automatic_retries, 0);
  blocked = false;
  assert.equal((await runTask({ ...f.options, recovery: 'user' }, f.clock)).status, 'complete');
  assert.deepEqual(f.calls, ['123', '123', '123', '456']);
});

test('a transient failure in a user recovery check pauses without automatically repeating that check', async t => {
  const f = await fixture(t, ['123'], (id, call) => fail(call === 1 ? 'LOGIN_REQUIRED' : 'BRIDGE_TIMEOUT'));
  await runTask(f.options, f.clock);
  const result = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(result.status, 'waiting_user');
  assert.equal(f.calls.length, 2);
  assert.equal(result.automatic_retries, 0);
});

test('frequency restriction has one explicit cooldown probe and cannot be reset by another task name', async t => {
  const f = await fixture(t, ['123', '456'], () => fail('RATE_LIMITED'));
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_cooldown');
  await assert.rejects(createTask({ ...f.options, task: 'new-name' }), { code: 'PLATFORM_TASK_UNFINISHED' });
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  const result = await runTask({ ...f.options, recovery: 'cooldown' }, f.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(result.automatic_retries, 1);
  assert.equal(result.cooldown_probes, 1);
  assert.equal(f.calls.length, 2);
  await runTask(f.options, f.clock);
  assert.equal(f.calls.length, 2);
});

test('frequency restriction after a successful recovery stops instead of granting another cooldown probe', async t => {
  const f = await fixture(t, ['123', '456'], (id, call) => call === 2 ? productResult(id) : fail('RATE_LIMITED'));
  await runTask(f.options, f.clock);
  const result = await runTask({ ...f.options, recovery: 'cooldown' }, f.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(result.completed, 1);
  assert.equal(result.cooldown_probes, 1);
  assert.deepEqual(f.calls, ['123', '123', '456']);
});

test('disconnection preserves completed results and resumes only the unfinished item', async t => {
  let connected = false;
  const f = await fixture(t, ['123', '456'], id => id === '456' && !connected ? fail('EXTENSION_DISCONNECTED') : productResult(id));
  assert.equal((await runTask(f.options, f.clock)).completed, 1);
  assert.equal((await taskStatus(f.options)).status, 'waiting_connection');
  connected = true;
  assert.equal((await runTask({ ...f.options, recovery: 'connection' }, f.clock)).status, 'complete');
  assert.deepEqual(f.calls, ['123', '456', '456']);
});

test('unknown failures do not retry or leak external text', async t => {
  const f = await fixture(t, ['123', '456'], () => { throw new Error('PRIVATE_TOKEN'); });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(result.operations[0].error.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
  assert.equal(f.calls.length, 1);
});

test('an unavailable product fails once while later products can complete', async t => {
  const f = await fixture(t, ['123', '456'], id => id === '123' ? fail('PRODUCT_UNAVAILABLE') : productResult(id));
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'partial');
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.automatic_retries, 0);
});

test('interruption after reserving a retry preserves its count and remaining wait across a fresh run', async t => {
  const f = await fixture(t, ['123'], (id, call) => call === 1 ? fail('BRIDGE_TIMEOUT') : productResult(id));
  await assert.rejects(runTask(f.options, { ...f.clock, wait: async () => { throw new Error('simulated process interruption'); } }));
  const saved = await loadTask(f.options.stateDirectory, f.options.task);
  assert.equal(saved.status, 'retry_wait');
  assert.equal(saved.retries, 1);
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete');
  assert.equal(result.automatic_retries, 1);
  assert.equal(result.operations[0].attempts, 2);
  assert.deepEqual(f.waits, [5000]);
});

test('an in-flight read with an uncommitted outcome is budgeted before a safe re-observation', async t => {
  const f = await fixture(t);
  await withTaskStore(f.options.stateDirectory, f.options.task, async store => {
    const task = await store.load();
    task.status = 'running'; task.operations[0].status = 'running'; task.operations[0].attempts = 1;
    await store.save(task);
  });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.automatic_retries, 1);
  assert.equal(result.operations[0].attempts, 2);
  assert.deepEqual(f.waits, [5000]);
});

test('platform lock prevents overlapping execution across tasks and releases on ordinary errors', async t => {
  const f = await fixture(t);
  await withTaskStore(f.options.stateDirectory, 'sample', async () => {
    await assert.rejects(runTask(f.options, f.clock), { code: 'TASK_BUSY' });
    await assert.rejects(createTask({ ...f.options, task: 'another' }), { code: 'TASK_BUSY' });
  });
  assert.equal((await runTask(f.options, f.clock)).status, 'complete');
  assert.ok(!(await readdir(path.join(f.options.stateDirectory, 'tasks'))).includes('.taobao.lock'));
});

test('tampered policy or inconsistent counters fail before browser reads', async t => {
  const f = await fixture(t);
  const filename = path.join(f.options.stateDirectory, 'tasks', 'sample.json');
  const clean = await readFile(filename, 'utf8');
  for (const mutate of [task => { task.retries = 1; }, task => { task.policy.platform_retries = 100; }, task => { task.operations[0].target.product_id = '999'; }]) {
    const task = JSON.parse(clean); mutate(task);
    await writeFile(filename, JSON.stringify(task));
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.calls.length, 0);
});

test('a task cannot switch endpoints during recovery', async t => {
  const f = await fixture(t);
  await assert.rejects(runTask({ ...f.options, bridge: { ...f.options.bridge, endpoint: 'http://127.0.0.1:9999' } }, f.clock), { code: 'BINDING_ENDPOINT_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('a remaining wait budget cannot be shortened to squeeze in another retry', () => {
  assert.deepEqual(retryDecision({ retries: 0, wait_reserved_ms: TASK_POLICY.wait_budget_ms - 1 }, { retries: 0 }),
    { allowed: false, code: 'WAIT_BUDGET_EXHAUSTED' });
});

test('a failed cooldown probe is never repeated as a transient retry', async t => {
  const f = await fixture(t, ['123', '456'], (id, call) => fail(call === 1 ? 'RATE_LIMITED' : 'BRIDGE_TIMEOUT'));
  await runTask(f.options, f.clock);
  const result = await runTask({ ...f.options, recovery: 'cooldown' }, f.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(f.calls.length, 2);
  assert.equal(result.automatic_retries, 1);
});

test('an interrupted cooldown probe consumes its only allowance without another browser read', async t => {
  const f = await fixture(t);
  await withTaskStore(f.options.stateDirectory, 'sample', async store => {
    const task = await store.load();
    task.status = 'running'; task.retries = 1; task.cooldown_probes = 1;
    task.operations[0].status = 'running'; task.operations[0].attempts = 2; task.operations[0].recovery_kind = 'cooldown';
    await store.save(task);
  });
  assert.equal((await runTask(f.options, f.clock)).status, 'stopped');
  assert.equal(f.calls.length, 0);
});

test('an interrupted user check stays paused until another explicit user report', async t => {
  const f = await fixture(t);
  await withTaskStore(f.options.stateDirectory, 'sample', async store => {
    const task = await store.load();
    task.status = 'running'; task.operations[0].status = 'running'; task.operations[0].attempts = 2; task.operations[0].recovery_kind = 'user';
    await store.save(task);
  });
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user');
  assert.equal(f.calls.length, 0);
});

test('reattaching a closed tab preserves attempts and only accepts the same original product', async t => {
  let missing = true;
  const f = await fixture(t, ['123'], id => missing ? fail('TARGET_MISSING') : productResult(id));
  await runTask(f.options, f.clock);
  const binding = { schema_version: 1, platform: 'taobao', endpoint: f.options.bridge.endpoint,
    tab_id: 99, target: parseProductUrl('https://detail.tmall.com/item.htm?id=999'), created_at: new Date().toISOString() };
  await saveBinding(f.options.stateDirectory, 'reopened', binding);
  await assert.rejects(rebindTask({ ...f.options, binding: 'reopened' }), { code: 'TASK_TARGET_MISMATCH' });
  binding.target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  await saveBinding(f.options.stateDirectory, 'reopened', binding, { replace: true });
  const rebound = await rebindTask({ ...f.options, binding: 'reopened' });
  assert.equal(rebound.operations[0].attempts, 1);
  assert.equal((await loadTask(f.options.stateDirectory, 'sample')).operations[0].tab_id, 99);
  missing = false;
  assert.equal((await runTask({ ...f.options, recovery: 'connection' }, f.clock)).operations[0].attempts, 2);
});

test('explicit task ending preserves counters and forbids resuming its old identity', async t => {
  const f = await fixture(t, ['123'], () => fail('RATE_LIMITED'));
  await runTask(f.options, f.clock);
  await runTask({ ...f.options, recovery: 'cooldown' }, f.clock);
  const ended = await endTask(f.options);
  assert.equal(ended.status, 'ended');
  assert.equal(ended.automatic_retries, 1);
  await createTask({ ...f.options, task: 'distinct-future-task' });
  await assert.rejects(runTask({ ...f.options, recovery: 'cooldown' }, f.clock), { code: 'INVALID_RECOVERY' });
  assert.equal(f.calls.length, 2);
});

test('cached product data is revalidated so extra fields cannot pass through task-status', async t => {
  const f = await fixture(t);
  await runTask(f.options, f.clock);
  const filename = path.join(f.options.stateDirectory, 'tasks', 'sample.json');
  const task = JSON.parse(await readFile(filename, 'utf8'));
  task.operations[0].result.token = 'PRIVATE';
  await writeFile(filename, JSON.stringify(task));
  await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
});

test('a killed process leaves a recoverable lock and a counted in-flight read', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const source = `import { withTaskStore } from ${JSON.stringify(new URL('../lib/task-store.mjs', import.meta.url).href)};
    await withTaskStore(process.argv[1], 'sample', async store => {
      const task = await store.load(); task.status = 'running';
      task.operations[0].status = 'running'; task.operations[0].attempts = 1;
      await store.save(task); setInterval(() => {}, 1000); process.send('ready');
      await new Promise(() => {});
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.options.stateDirectory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'message');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete');
  assert.equal(result.operations[0].attempts, 2);
  assert.equal(result.automatic_retries, 1);
});
