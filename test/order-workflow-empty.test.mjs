import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOrderWorkflow, runOrderWorkflow, orderWorkflowStatus } from '../lib/order-workflow.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { validateOrderRows } from '../lib/order-rows.mjs';
import { emptyListObservation } from '../test-support/list-empty-fixture.mjs';
import { observeOrders, orderGroup, orderTarget } from '../test-support/order-fixture.mjs';

async function fixture(t, raw = emptyListObservation('order'), orderPosition = 1) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping empty workflow '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const calls = [];
  let time = Date.parse('2026-10-10T01:00:00.000Z');
  const bridge = {
    endpoint: 'http://127.0.0.1:19824', protocol: 'playwright-extension',
    async requireConnected() { calls.push('status'); },
    async listTabs() { calls.push('tabs'); return [{ id: 41, url: orderTarget.url }]; },
    async readOrderRows() { calls.push('list'); return validateOrderRows(raw, orderTarget); },
    async inspectOrderDetailEntry() { assert.fail('An absent selected order cannot prepare a detail entry.'); },
    async openOrderDetailEntry() { assert.fail('An absent selected order cannot dispatch a click.'); },
    async readOrderDetailPageState() { assert.fail('An absent selected order cannot inspect a detail page.'); },
    async readOrderDetailBody() { assert.fail('An absent selected order cannot read a detail body.'); },
  };
  const options = { stateDirectory, workflow: 'empty-round', tabId: 41, orderPosition, bridge };
  const clock = { now: () => time, wait: async milliseconds => { time += milliseconds; } };
  await createOrderWorkflow(options);
  return { stateDirectory, options, clock, calls, raw };
}

test('an explicitly empty workflow list retains its evidence and stops before creating an entry or body', async t => {
  const f = await fixture(t);
  const result = await runOrderWorkflow(f.options, f.clock);
  const listTask = await loadTask(f.stateDirectory, 'empty-round-list');
  const snapshot = listTask.operations[0].result;
  assert.equal(result.status, 'stopped');
  assert.equal(result.error.code, 'ORDER_DETAIL_SOURCE_UNVERIFIED');
  assert.equal(listTask.status, 'complete');
  assert.equal(snapshot.schema_version, 3);
  assert.deepEqual(result.result.observations.list, {
    task: listTask.id, observed_at: snapshot.observed_at, order: null,
    empty_evidence: snapshot.empty_evidence, coverage: snapshot.coverage,
  });
  assert.equal(result.result.observations.entry, null);
  assert.equal(result.result.observations.body, null);
  assert.deepEqual(await readdir(path.join(f.stateDirectory, 'tasks')), ['empty-round-list.json']);
  assert.deepEqual(f.calls, ['status', 'tabs', 'list']);
  assert.equal(result.budget.content_reads_reserved, 1);
  assert.equal(result.budget.actions_reserved, 0);
  assert.equal(result.budget.explicit_recoveries, 0);
  assert.equal(result.result.coverage.workflow_complete, false);
});

test('stopped empty workflow run and status preserve the original evidence, budgets and checkpoint bytes without IO', async t => {
  const f = await fixture(t);
  const result = await runOrderWorkflow(f.options, f.clock);
  const taskFile = path.join(f.stateDirectory, 'tasks/empty-round-list.json');
  const workflowFile = path.join(f.stateDirectory, 'order-workflows/empty-round.json');
  const taskBytes = await readFile(taskFile), workflowBytes = await readFile(workflowFile);
  f.calls.length = 0;
  f.options.bridge.requireConnected = async () => assert.fail('Cached empty workflows must not access the browser.');
  assert.deepEqual(await runOrderWorkflow(f.options, f.clock), result);
  assert.deepEqual(await orderWorkflowStatus(f.options), result);
  assert.equal(result.result.observations.list?.empty_evidence?.scope, 'current_list_view');
  assert.deepEqual(await readFile(taskFile), taskBytes);
  assert.deepEqual(await readFile(workflowFile), workflowBytes);
  assert.deepEqual(f.calls, []);
});

test('a nonempty list missing the selected position keeps the original unavailable summary shape', async t => {
  const f = await fixture(t, observeOrders([orderGroup(1).group]), 5);
  const result = await runOrderWorkflow(f.options, f.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(result.error.code, 'ORDER_DETAIL_SOURCE_UNVERIFIED');
  assert.equal(result.result.observations.list, null);
  assert.equal(result.result.observations.entry, null);
  assert.equal(result.result.observations.body, null);
  assert.deepEqual(await readdir(path.join(f.stateDirectory, 'tasks')), ['empty-round-list.json']);
  assert.deepEqual(f.calls, ['status', 'tabs', 'list']);
});
