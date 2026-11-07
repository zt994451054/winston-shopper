import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { validateCartRows, validateCartBatch } from '../lib/cart-rows.mjs';
import { validateOrderRows, validateOrderBatch } from '../lib/order-rows.mjs';
import { parseCartUrl } from '../lib/cart-target.mjs';
import { parseOrderListUrl } from '../lib/order-target.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { emptyListObservation } from '../test-support/list-empty-fixture.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

const execute = promisify(execFile);
const script = new URL('../scripts/shopping.mjs', import.meta.url).pathname;
const families = {
  cart: { mode: 'cart', limit: 'cartRows', resultKey: 'rows', readKey: 'cart_read', budgetKey: 'cart_budget',
    flag: 'empty_cart_verified', single: validateCartRows, batch: validateCartBatch, parse: parseCartUrl,
    singleMethod: 'readCartRows', batchMethod: 'readCartBatch' },
  orders: { mode: 'orders', limit: 'orderRows', resultKey: 'orders', readKey: 'order_read', budgetKey: 'order_budget',
    flag: 'empty_orders_verified', single: validateOrderRows, batch: validateOrderBatch, parse: parseOrderListUrl,
    singleMethod: 'readOrderRows', batchMethod: 'readOrderBatch' },
};
async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), 'shopping empty contract '));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
async function fixture(t, kind, collection, gate) {
  const config = families[kind], stateDirectory = path.join(await directory(t), 'state');
  const target = config.parse(emptyListObservation(kind).url), calls = [], waits = [], inventories = [];
  let gated = Boolean(gate), time = Date.parse('2026-10-10T00:00:00.000Z');
  const bridge = { endpoint: 'http://127.0.0.1:19824',
    async requireConnected() {
      if (gated && gate === 'connection') throw new ShoppingError('EXTENSION_DISCONNECTED', 'Synthetic gate');
    },
    async listTabs() { inventories.push(41); return [{ id: 41, url: target.url }]; },
    async [collection ? config.batchMethod : config.singleMethod](id, expected, plan) {
      const saved = await loadTask(stateDirectory, 'empty-list');
      assert.equal(saved.operations[0].status, 'running');
      assert.equal(saved.operations[0].attempts, gate === 'connection' ? 2 : calls.length + 1);
      assert.equal(id, 41); assert.deepEqual(expected, target); calls.push(41);
      if (gated && gate === 'user') { gated = false; throw new ShoppingError('LOGIN_REQUIRED', 'Synthetic gate'); }
      const raw = emptyListObservation(kind, plan);
      return collection ? config.batch(raw, target, plan) : config.single(raw, target);
    } };
  const options = { stateDirectory, task: 'empty-list', [config.mode]: true, tabId: 41, bridge,
    ...(collection ? { [config.limit]: 10 } : {}) };
  const clock = { now: () => time, wait: async ms => { waits.push(ms); time += ms; } };
  await createTask(options);
  return { options, bridge, clock, calls, waits, inventories, recover: () => { gated = false; } };
}

for (const [kind, config] of Object.entries(families)) {
  for (const collection of [false, true]) {
    for (const gate of ['user', 'connection']) {
      test(`${kind} ${collection ? 'collection' : 'snapshot'} resumes the original gated task to an explicit empty cache`, async t => {
        const f = await fixture(t, kind, collection, gate);
        assert.equal((await runTask(f.options, f.clock)).status, gate === 'user' ? 'waiting_user' : 'waiting_connection');
        await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
        f.recover();
        const report = await runTask({ ...f.options, recovery: gate }, f.clock), op = report.operations[0];
        assert.equal(report.status, 'complete'); assert.equal(op.attempts, 2);
        assert.equal(op.result.coverage[config.flag], true); assert.deepEqual(op.result[config.resultKey], []);
        assert.equal(op[config.budgetKey].recoveries_reserved, 1);
        assert.equal(op[config.budgetKey].failures.length, 1);
        assert.equal(report.wait_reserved_ms, 5000); assert.deepEqual(f.waits, [5000]);
        assert.equal(report.automatic_retries, 0);
        if (collection) {
          assert.equal(op.result.batches.length, 1);
          assert.equal(op.result.coverage.requested_limit_reached, false);
          assert.equal(op.result.coverage.requested_loaded_range_read, true);
        }
        const file = path.join(f.options.stateDirectory, 'tasks/empty-list.json'), before = await readFile(file);
        const counts = [f.calls.length, f.inventories.length];
        f.bridge.requireConnected = () => { throw Error('completed empty task must use its cache'); };
        assert.deepEqual(await taskStatus(f.options), report);
        assert.deepEqual(await runTask(f.options, f.clock), report);
        assert.deepEqual(await readFile(file), before);
        assert.deepEqual([f.calls.length, f.inventories.length], counts);
      });
    }
  }
}

async function cli(args, extraEnvironment = {}) {
  const result = await execute(process.execPath, [script, ...args], {
    env: { ...process.env, ...extraEnvironment }, maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

for (const [kind, config] of Object.entries(families)) {
  for (const collection of [false, true]) {
    test(`real CLI ${kind} ${collection ? 'collection' : 'snapshot'} saves synthetic adapter evidence and exports it without browser IO`, async t => {
      const parent = await directory(t), stateDirectory = path.join(parent, 'state');
      const { endpoint, state } = await mockBridge(t);
      state.tabs = [{ id: 41, url: emptyListObservation(kind).url }];
      state.metadata = emptyListObservation(kind, collection ? { start: 1, limit: 5, guards: [] } : null);
      const common = ['--endpoint', endpoint, '--state-dir', stateDirectory, '--task', 'empty-list'];
      assert.equal((await cli(['task-start', ...common, '--' + config.mode, '--tab', '41',
        ...(collection ? ['--' + (kind === 'cart' ? 'cart-rows' : 'order-rows'), '10'] : [])])).status, 'task_created');
      assert.equal(state.requests.length, 0);
      const report = await cli(['task-run', ...common]);
      assert.equal(report.status, 'complete');
      assert.equal(report.operations[0].result.coverage[config.flag], true);
      assert.equal(state.commands.filter(command => command.action === 'eval').length, 1);
      const file = path.join(stateDirectory, 'tasks/empty-list.json'), bytes = await readFile(file), count = state.requests.length;
      state.connected = false;
      assert.deepEqual(await cli(['task-run', ...common]), report);
      assert.deepEqual(await cli(['task-status', '--state-dir', stateDirectory, '--task', 'empty-list']), { ...report, command: 'task-status' });
      for (const format of ['markdown', 'csv']) {
        const output = path.join(parent, 'empty.' + (format === 'markdown' ? 'md' : 'csv'));
        await cli(['report-export', '--state-dir', stateDirectory, '--task', 'empty-list', '--format', format, '--output', output],
          { BROWSER_BRIDGE_ENDPOINT: 'http://127.0.0.1:1' });
        const text = await readFile(output, 'utf8');
        assert.ok(text.includes(emptyListObservation(kind).empty_evidence.message.text));
        assert.ok(text.includes(emptyListObservation(kind).observed_at));
        assert.ok(text.includes('当前列表视图')); assert.equal(text.includes('无已缓存内容记录'), false);
        assert.equal((await stat(output)).mode & 0o777, 0o600);
      }
      assert.equal(state.requests.length, count); assert.deepEqual(await readFile(file), bytes);
      const forged = JSON.parse(bytes);
      if (collection) forged.operations[0][kind === 'cart' ? 'cart_collection' : 'order_collection'].batches[0].snapshot.empty_evidence.notice_visible = false;
      else forged.operations[0].result.empty_evidence.notice_visible = false;
      await writeFile(file, JSON.stringify(forged));
      await assert.rejects(cli(['task-status', '--state-dir', stateDirectory, '--task', 'empty-list']), error => {
        assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_CHECKPOINT'); return true;
      });
      assert.equal(state.requests.length, count);
    });
  }
}
