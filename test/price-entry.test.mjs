import { recordPausedDisplay, assertPausedDisplays } from '../test-support/paused-display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask, rebindTask } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { searchTarget } from '../lib/search.mjs';
import { newPriceEntryState, runPriceEntry, validatePriceEntry } from '../lib/price-entry.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { main } from '../lib/cli.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';

function raw(target) {
  return { ...rawSearch(target), pagination: { current_page: 1, total_pages_displayed: 11, previous_disabled: true, next_disabled: false, selected_sort_label: '销量' },
    controls: ['综合', '销量', '价格', '区间'].map(text => ({ tag: 'LI', class_name: '', text, role: 'tab', aria_label: '', aria_sort: '', aria_haspopup: '', aria_expanded: '', selected: text === '销量', disabled: false, children: [] })),
    price_entry: { sort_bar_text: '综合 销量 价格 区间', menu_candidates: [] } };
}

test('browser responses may reorder price-entry object keys without changing their meaning', () => {
  const target = searchTarget('mouse'), value = raw(target);
  value.price_entry = { menu_candidates: [], sort_bar_text: '综合 销量 价格 区间' };
  assert.equal(validatePriceEntry(value, target).entry.sort_bar_text, '综合 销量 价格 区间');
});
async function fixture(t, { uncertain = false, actionGate = null, afterGate = null } = {}) {
  const target = searchTarget('mouse'); let actions = 0, reads = 0, tabs = [];
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping price '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const task = 'price', displays = [];
  const server = await mockBridge(t, { handler: async ({ req, res, body }) => {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs } });
    if (body.action === 'tab_show') return send({ id: body.id, success: true, data: await recordPausedDisplay(body, stateDirectory, task, displays) });
    if (body.script.includes('function inspectSortTarget(')) return send({ id: body.id, success: true, data: { result: { state: 'observed', url: target.url } } });
    if (body.script.includes('"urls":')) {
      const saved = await loadTask(stateDirectory, task);
      assert.equal(saved.operations[0].price_entry.action_reserved, true);
      assert.ok(saved.operations[0].price_entry.before);
      if (actionGate) return send({ id: body.id, success: true, data: { result: { state: actionGate } } });
      actions += 1;
      return send({ id: body.id, success: !uncertain, data: { result: { state: 'action_dispatched', clicked: true } } });
    }
    reads += 1;
    send({ id: body.id, success: true, data: { result: actions && afterGate ? { state: afterGate } : raw(target) } });
  } });
  const options = { stateDirectory, task, search: target.query, tabId: 41, inspectPrice: true, bridge: new BrowserBridge(server.endpoint) };
  await createTask(options);
  let now = 100000;
  return { options, target, server, displays, clock: { now: () => now, wait: async ms => { now += ms; } }, actions: () => actions, reads: () => reads,
    setAfterGate: value => { afterGate = value; }, setTabs: value => { tabs = value; } };
}

test('price entry commits one click, waits and describes unchanged UI without claiming a direction; completed reads are cached', async t => {
  const f = await fixture(t), report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(f.actions(), 1); assert.equal(f.reads(), 2);
  assertPausedDisplays(f.displays, []);
  assert.equal(report.operations[0].result.price_direction, null);
  assert.equal(report.operations[0].result.coverage.control_behavior_verified, false);
  const requests = f.server.state.requests.length;
  await runTask(f.options); assert.equal(f.server.state.requests.length, requests);
});

test('uncertain price click followed by verification resumes observation only with original counters', async t => {
  const f = await fixture(t, { uncertain: true, afterGate: 'verification_required' });
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user');
  const expectedDisplay = [{ tabId: 41, status: 'waiting_user', code: 'VERIFICATION_REQUIRED' }];
  assertPausedDisplays(f.displays, expectedDisplay);
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  f.setAfterGate(null);
  const result = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(f.actions(), 1); assert.equal(f.reads(), 3);
  assert.equal(result.automatic_retries, 0);
  assert.equal(result.operations[0].result.action_evidence.acknowledgement_error, 'BROWSER_COMMAND_FAILED');
  assertPausedDisplays(f.displays, expectedDisplay);
});

test('unsupported price click releases only the undispatched intent and ends the operation without retry', async t => {
  const f = await fixture(t, { actionGate: 'unsupported' });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'partial'); assert.equal(result.operations[0].actions_reserved, 0); assert.equal(f.actions(), 0);
  assert.equal(result.automatic_retries, 0);
});

test('price-entry recovery diagnoses and rebinds the original query second page without resetting intent', async t => {
  const f = await fixture(t, { afterGate: 'target_changed' });
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_connection');
  f.setTabs([{ id: 99, url: f.target.url.replace('page=1', 'page=2') + '&sort=observed' }]);
  const diagnostic = await diagnoseTask(f.options);
  assert.deepEqual(diagnostic.operations[0].matching_tab_ids, [99]);
  await rebindTask({ ...f.options, tabId: 99 });
  f.setAfterGate(null);
  assert.equal((await runTask({ ...f.options, recovery: 'connection' }, f.clock)).status, 'complete');
  assert.equal(f.actions(), 1);
});

test('price entry validates finite menus, immutable results and cumulative observation budgets', async t => {
  const f = await fixture(t); await runTask(f.options, f.clock);
  const file = path.join(f.options.stateDirectory, 'tasks/price.json');
  const original = await readFile(file, 'utf8');
  for (const alter of [v => { v.operations[0].price_entry.action_reserved = false; }, v => { v.operations[0].result.price_direction = 'ascending'; }, v => { v.operations[0].price_entry.after = null; }]) {
    const value = JSON.parse(original); alter(value); await writeFile(file, JSON.stringify(value));
    await assert.rejects(loadTask(f.options.stateDirectory, 'price'), { code: 'INVALID_CHECKPOINT' });
  }
  for (const candidate of [Array(7).fill('价格'), ['unrelated'], ['价格' + 'x'.repeat(600)]]) {
    const value = raw(f.target); value.price_entry.menu_candidates = candidate;
    assert.throws(() => validatePriceEntry(value, f.target), { code: 'INVALID_RESPONSE' });
  }
  const op = { tab_id: 41, target: f.target, price_entry: { ...newPriceEntryState(), observations: 8 } };
  await assert.rejects(runPriceEntry({ op, bridge: {}, commit: async () => {}, ...f.clock }), { code: 'ACTION_OBSERVATION_LIMIT' });
});

test('price-entry CLI rejects mixed actions and persists the independent inspection kind', async t => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping price cli '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const run = async args => { let output = ''; await main(args, { write: value => { output += value; } }); return JSON.parse(output); };
  const base = ['task-start', '--task', 'price', '--state-dir', stateDirectory, '--search', 'mouse', '--tab', '41', '--inspect-price'];
  for (const args of [['--pages', '2'], ['--sort', 'sales'], ['--inspect-controls'], ['--details']]) assert.equal((await run([...base, ...args])).error.code, 'INVALID_ARGUMENTS');
  assert.equal((await run(base)).task_kind, 'search_price_entry');
});
