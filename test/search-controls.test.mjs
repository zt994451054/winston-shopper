import { recordPausedDisplay, assertPausedDisplays } from '../test-support/paused-display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { main } from '../lib/cli.mjs';
import { searchTarget } from '../lib/search.mjs';
import { runSearchControls, validateSearchControls } from '../lib/search-controls.mjs';
import { newReadActionState } from '../lib/read-action.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';

function control(text, selected = false) {
  return { tag: 'LI', class_name: 'synthetic', text, role: 'tab', aria_label: '', aria_sort: '', aria_haspopup: '',
    aria_expanded: '', selected, disabled: false, children: [] };
}
function observation(target) {
  return { ...rawSearch(target), pagination: { current_page: 1, total_pages_displayed: 11, previous_disabled: true,
    next_disabled: false, selected_sort_label: '销量' }, controls: [control('综合'), control('销量', true), control('价格'), control('区间')] };
}
async function fixture(t, gate = null) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping controls ')), displays = [];
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const target = searchTarget('mouse'); let reads = 0;
  const server = await mockBridge(t, { async handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [] } });
    if (body.action === 'tab_show') return send({ id: body.id, success: true, data: await recordPausedDisplay(body, stateDirectory, 'controls', displays) });
    if (body.script.includes('function inspectSortTarget(')) return send({ id: body.id, success: true, data: { result: { state: 'observed', url: target.url } } });
    reads += 1;
    send({ id: body.id, success: true, data: { result: gate ? { state: gate } : observation(target) } });
  } });
  const options = { stateDirectory, task: 'controls', search: target.query, tabId: 41, inspectControls: true, bridge: new BrowserBridge(server.endpoint) };
  await createTask(options);
  return { options, target, server, displays, reads: () => reads, setGate: value => { gate = value; } };
}

test('control inspection reads once outside the current inventory, caches results, and never sends an action', async t => {
  const f = await fixture(t);
  const result = await runTask(f.options);
  assert.equal(result.status, 'complete'); assert.equal(result.task_kind, 'search_controls');
  assert.equal(result.operations[0].actions_reserved, 0); assert.equal(result.operations[0].dom_observations_reserved, 1);
  assert.equal(result.operations[0].result.controls[1].text, '销量');
  assert.equal(result.operations[0].result.coverage.control_behavior_verified, false);
  assert.equal(f.reads(), 1);
  assertPausedDisplays(f.displays, []);
  assert.ok(f.server.state.commands.every(command => ['tab_list', 'eval'].includes(command.action)));
  assert.ok(f.server.state.commands.every(command => !command.script?.includes('.click(')));
  const count = f.server.state.requests.length;
  await runTask(f.options); assert.equal(f.server.state.requests.length, count);
});

test('control inspection pauses on verification and preserves observation counts on original-task recovery', async t => {
  const f = await fixture(t, 'verification_required');
  assert.equal((await runTask(f.options)).status, 'waiting_user');
  const expectedDisplay = [{ tabId: 41, status: 'waiting_user', code: 'VERIFICATION_REQUIRED' }];
  assertPausedDisplays(f.displays, expectedDisplay);
  await assert.rejects(runTask(f.options), { code: 'RECOVERY_REQUIRED' });
  f.setGate(null);
  const result = await runTask({ ...f.options, recovery: 'user' });
  assert.equal(result.status, 'complete'); assert.equal(result.operations[0].dom_observations_reserved, 2);
  assert.equal(result.operations[0].actions_reserved, 0); assert.equal(result.automatic_retries, 0);
  assertPausedDisplays(f.displays, expectedDisplay);
});

test('inspection rejects conflicting selected controls, malformed metadata, and excess descendants', () => {
  const target = searchTarget('mouse');
  for (const mutate of [v => { v.controls[0].selected = true; }, v => { v.controls[1].text = '价格'; },
    v => { v.controls[0].children = Array(13).fill({}); }, v => { v.controls[0].tag = '<SCRIPT>'; },
    v => { v.controls[0].class_name = 'x'.repeat(301); }]) {
    const raw = observation(target); mutate(raw);
    assert.throws(() => validateSearchControls(raw, target), ShoppingError);
  }
});

test('inspection checkpoint rejects invented actions and upgrades of behavior evidence', async t => {
  const f = await fixture(t);
  const file = path.join(f.options.stateDirectory, 'tasks/controls.json');
  const original = await readFile(file, 'utf8');
  const altered = JSON.parse(original); altered.operations[0].read_action.observations = 1; altered.operations[0].read_action.action_reserved = true;
  await writeFile(file, JSON.stringify(altered));
  await assert.rejects(loadTask(f.options.stateDirectory, f.options.task), { code: 'INVALID_CHECKPOINT' });
  await writeFile(file, original); await runTask(f.options);
  const completed = JSON.parse(await readFile(file, 'utf8')); completed.operations[0].result.coverage.control_behavior_verified = true;
  await writeFile(file, JSON.stringify(completed));
  await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
});

test('inspection never reserves a ninth DOM read across recoveries', async () => {
  const op = { tab_id: 41, target: searchTarget('mouse'), read_action: newReadActionState() }; let reads = 0;
  const context = { op, commit: async () => {}, bridge: { readSearchControls: async () => { reads += 1; throw new ShoppingError('TARGET_MISSING', 'Synthetic'); } } };
  for (let i = 0; i < 8; i += 1) await assert.rejects(runSearchControls(context), { code: 'TARGET_MISSING' });
  await assert.rejects(runSearchControls(context), { code: 'ACTION_OBSERVATION_LIMIT' }); assert.equal(reads, 8);
});

test('inspection CLI requires a query and rejects combination with pagination, sorting or products', async t => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping controls cli '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const run = async args => { let output = ''; const code = await main(args, { write: value => { output += value; } }); return { code, value: JSON.parse(output) }; };
  for (const args of [['--bindings', 'mouse'], ['--search', 'mouse', '--tab', '41', '--sort', 'sales'], ['--search', 'mouse', '--tab', '41', '--pages', '2']]) {
    const result = await run(['task-start', '--task', 'bad', '--state-dir', stateDirectory, '--inspect-controls', ...args]);
    assert.equal(result.value.error.code, 'INVALID_ARGUMENTS');
  }
  const result = await run(['task-start', '--task', 'inspection', '--state-dir', stateDirectory, '--inspect-controls', '--search', 'mouse', '--tab', '41']);
  assert.equal(result.code, 0); assert.equal(result.value.task_kind, 'search_controls');
});
