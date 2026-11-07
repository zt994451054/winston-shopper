import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { validateDescriptionObservation } from '../lib/description-entry.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { rawDescription } from '../test-support/description-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const fail = code => { throw new ShoppingError(code, 'Synthetic description failure'); };
async function fixture(t, configure = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping description '));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.now(), reads = 0, actions = 0, opened = false;
  const clock = { now: () => time, wait: async ms => { time += ms; } };
  const bridge = { endpoint: 'http://127.0.0.1:19824',
    async readDescriptionExpansion() {
      reads++; return validateDescriptionObservation(await (configure.read?.(reads, opened) ?? rawDescription({ expanded: opened })), target);
    },
    async expandDescription() {
      actions++;
      const state = (await loadTask(root, 'description')).operations[0].description_read;
      assert.equal(state.action_reserved, true); assert.equal(state.observations, 2);
      assert.equal(state.initial.entry.entries[0].target_id, 'description-body');
      opened = true;
      return configure.act ? configure.act() : { clicked: true };
    } };
  await saveBinding(root, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint, tab_id: 41, target, created_at: new Date(time).toISOString() });
  const options = { stateDirectory: root, task: 'description', bindings: ['sample'], descriptionExpand: true, bridge };
  await createTask(options);
  return { root, options, clock, reads: () => reads, actions: () => actions, filename: path.join(root, 'tasks/description.json') };
}

test('description task reserves one guard before clicking and confirms two later texts', async t => {
  const f = await fixture(t), result = await runTask(f.options, f.clock), value = result.operations[0].result;
  assert.equal(result.status, 'complete'); assert.equal(f.reads(), 3); assert.equal(f.actions(), 1);
  assert.equal(result.operations[0].dom_observations_reserved, 4); assert.equal(value.description_expansion.clicked, true);
  assert.equal(value.description_expansion.text_changed, true); assert.equal(value.description_expansion.text_stability_confirmed, true);
  assert.equal(value.description_expansion.full_description_verified, false);
  const bytes = await readFile(f.filename); await runTask(f.options, f.clock);
  assert.equal(f.reads(), 3); assert.deepEqual(await readFile(f.filename), bytes);
});
test('no potential entry or no explicit binding returns existing data without actions', async t => {
  for (const [extra, status] of [[{ present: false }, 'entry_not_observed'], [{ linked: false }, 'entry_unverified']]) {
    const f = await fixture(t, { read: () => rawDescription({ ...extra, expanded: true }) });
    const result = await runTask(f.options, f.clock);
    assert.equal(result.status, 'complete'); assert.equal(result.operations[0].result.description_expansion.status, status);
    assert.equal(f.actions(), 0); assert.equal(f.reads(), 1);
    assert.equal(result.operations[0].result.description_expansion.same_entry_expanded_verified, false);
  }
});
test('already expanded text is confirmed twice without closing or re-expanding', async t => {
  const f = await fixture(t, { read: () => rawDescription({ expanded: true }) });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(f.reads(), 2); assert.equal(f.actions(), 0);
  assert.equal(result.operations[0].result.description_expansion.status, 'already_expanded');
});
test('an uncertain action acknowledgement is preserved and never dispatched again', async t => {
  const f = await fixture(t, { act: () => fail('BRIDGE_TIMEOUT') });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(f.actions(), 1); assert.equal(result.automatic_retries, 0);
  assert.equal(result.operations[0].result.description_expansion.acknowledgement_error, 'BRIDGE_TIMEOUT');
  assert.equal(result.operations[0].result.description_expansion.clicked, null);
});
test('a guard noticing user expansion preserves a false click acknowledgement', async t => {
  const f = await fixture(t, { act: () => ({ clicked: false }) });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(result.operations[0].result.description_expansion.clicked, false);
});
test('unconfirmed expansion stops after three post-checks and blocks a fresh task name', async t => {
  const f = await fixture(t, { read: () => rawDescription() });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(result.operations[0].dom_observations_reserved, 5); assert.equal(f.actions(), 1);
  assert.ok(result.operations[0].unconfirmed_description_observations.last);
  await assert.rejects(createTask({ ...f.options, task: 'bypass' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});
test('a changed source after the action stops while preserving the last valid observation', async t => {
  const f = await fixture(t, { read: count => {
    const value = rawDescription({ expanded: count > 1 });
    if (count > 1) value.entry.entries[0].target_id = 'another-container';
    return value;
  } });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'PAGE_STRUCTURE_CHANGED');
  assert.equal(result.operations[0].unconfirmed_description_observations.text_stability_confirmed, false);
});
test('text changes require two consecutive matching post-reads', async t => {
  const f = await fixture(t, { read: count => rawDescription({ expanded: count > 1, text: count === 2 ? 'First text' : 'Later text' }) });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(f.reads(), 4); assert.equal(f.actions(), 1);
  assert.equal(result.operations[0].result.details.description.text, 'Later text');
});
test('folded or truncated text cannot confirm expansion despite an open control', async t => {
  const f = await fixture(t, { read: () => rawDescription({ expanded: true, clipped: true }) });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(f.actions(), 0);
  assert.equal(result.operations[0].unconfirmed_description_observations.text_stability_confirmed, false);
});
test('read failures keep the shared 5/15 second retry allowance and counted attempts', async t => {
  const f = await fixture(t, { read: () => fail('BRIDGE_TIMEOUT') });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'partial'); assert.equal(result.automatic_retries, 2); assert.equal(result.wait_reserved_ms, 20000);
  assert.equal(result.operations[0].dom_observations_reserved, 3); assert.equal(f.actions(), 0);
});
test('a failed read breaks consecutive confirmation rather than completing across the fault', async t => {
  const f = await fixture(t, { read: count => count === 3 ? fail('BRIDGE_TIMEOUT') : rawDescription({ expanded: count > 1 }) });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.automatic_retries, 1); assert.equal(result.wait_reserved_ms, 5000);
  assert.equal(result.operations[0].error.code, 'ACTION_OUTCOME_UNKNOWN'); assert.equal(f.actions(), 1);
});
test('an interruption after the first readable observation starts confirmation again', async t => {
  const f = await fixture(t, { read: () => rawDescription({ expanded: true }) });
  let interrupted = false;
  const clock = { ...f.clock, wait: async ms => {
    if (!interrupted) { interrupted = true; fail('READ_INTERRUPTED'); }
    await f.clock.wait(ms);
  } };
  const result = await runTask(f.options, clock);
  assert.equal(result.status, 'complete'); assert.equal(result.automatic_retries, 1);
  assert.equal(result.wait_reserved_ms, 5000); assert.equal(f.reads(), 3); assert.equal(f.actions(), 0);
  assert.equal(result.operations[0].result.description_expansion.post_checks_reserved, 2);
});
test('a remaining budget insufficient for two confirmations prevents the action guard', async t => {
  const f = await fixture(t), saved = JSON.parse(await readFile(f.filename));
  const state = saved.operations[0].description_read;
  state.initial = validateDescriptionObservation(rawDescription(), target); state.last = state.initial;
  state.observations = 4; saved.operations[0].attempts = 1; await writeFile(f.filename, JSON.stringify(saved));
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'ACTION_OBSERVATION_LIMIT');
  assert.equal(f.actions(), 0); assert.equal(f.reads(), 0); assert.equal(result.operations[0].dom_observations_reserved, 4);
});
test('login and rate guards pause after the reserved action and resume with reads only', async t => {
  for (const [code, status, recovery] of [['VERIFICATION_REQUIRED', 'waiting_user', 'user'], ['RATE_LIMITED', 'waiting_cooldown', 'cooldown']]) {
    const f = await fixture(t, { act: () => fail(code) });
    assert.equal((await runTask(f.options, f.clock)).status, status); assert.equal(f.reads(), 1);
    assert.equal((await runTask({ ...f.options, recovery }, f.clock)).status, 'complete'); assert.equal(f.actions(), 1);
  }
});
test('undispatched guards keep their intent and stop without refunding observations', async t => {
  const f = await fixture(t, { act: () => { const error = new ShoppingError('DESCRIPTION_ENTRY_UNAVAILABLE', 'Guard'); error.actionNotDispatched = true; throw error; } });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].actions_reserved, 1);
  assert.equal(result.operations[0].dom_observations_reserved, 2); assert.equal(f.reads(), 1);
});
test('forged journals and full-coverage evidence fail before browser access', async t => {
  const f = await fixture(t), before = await readFile(f.filename, 'utf8');
  for (const change of [s => { s.observations = 7; }, s => { s.action_reserved = true; }, s => { s.confirmations = 2; }, s => { s.clicked = true; }]) {
    const value = JSON.parse(before); change(value.operations[0].description_read); await writeFile(f.filename, JSON.stringify(value));
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.reads(), 0); await writeFile(f.filename, before); await runTask(f.options, f.clock);
  const value = JSON.parse(await readFile(f.filename)); value.operations[0].result.description_expansion.full_description_verified = true;
  await writeFile(f.filename, JSON.stringify(value)); await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
});
test('description CLI mode is exclusive, accepts only one binding and reads an existing open body', async t => {
  const f = await fixture(t); await runTask(f.options, f.clock);
  const mock = await mockBridge(t);
  await saveBinding(f.root, 'cli', { schema_version: 1, platform: 'taobao', endpoint: mock.endpoint, tab_id: 41, target, created_at: new Date().toISOString() });
  const command = async args => { let text = ''; await main(args, { write: part => { text += part; } }); return JSON.parse(text); };
  const common = ['--endpoint', mock.endpoint, '--state-dir', f.root];
  for (const extra of [['--details'], ['--services'], ['--reviews'], ['--gallery'], ['--plan', 'absent.json']]) {
    assert.equal((await command(['task-start', ...common, '--task', 'bad', '--description-expand', '--bindings', 'cli', ...extra])).error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal((await command(['task-start', ...common, '--task', 'bad', '--description-expand', '--bindings', 'cli,cli'])).error.code, 'INVALID_BINDINGS');
  assert.equal(mock.state.commands.length, 0);
  mock.state.metadata = rawDescription({ expanded: true });
  assert.equal((await command(['task-start', ...common, '--task', 'cli', '--description-expand', '--bindings', 'cli'])).task_kind, 'product_description_expansion');
  assert.equal((await command(['task-run', ...common, '--task', 'cli'])).status, 'complete');
});
test('killing the CLI after dispatch preserves the intent and only reads on restart', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let dispatched = false, actions = 0, resolveDispatch;
  const dispatch = new Promise(resolve => { resolveDispatch = resolve; });
  const mock = await mockBridge(t, { handler: ({ req, res, body }) => {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: 41, url: target.url }] } });
    if (body.script.includes('(function activateDescription(')) { dispatched = true; actions++; reply({ state: 'action_dispatched', clicked: true }); resolveDispatch(); return; }
    reply(rawDescription({ expanded: dispatched }));
  } });
  const saved = JSON.parse(await readFile(f.filename)); saved.endpoint = mock.endpoint; await writeFile(f.filename, JSON.stringify(saved));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url)), 'task-run', '--task', 'description', '--state-dir', f.root, '--endpoint', mock.endpoint], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([dispatch, once(child, 'exit').then(() => { throw Error('CLI exited before dispatch'); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const result = await runTask({ ...f.options, bridge: new BrowserBridge(mock.endpoint) }, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(actions, 1); assert.equal(result.automatic_retries, 1);
  assert.equal(result.wait_reserved_ms, 5000); assert.equal(result.operations[0].dom_observations_reserved, 4);
});
