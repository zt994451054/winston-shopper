import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createTask, runTask, taskStatus} from '../lib/tasks.mjs';
import {loadTask} from '../lib/task-store.mjs';
import {saveBinding} from '../lib/state.mjs';
import {parseProductUrl} from '../lib/targets.mjs';
import {validateDetails} from '../lib/details.mjs';
import {ShoppingError} from '../lib/errors.mjs';
import {BrowserBridge} from '../lib/bridge.mjs';
import {main} from '../lib/cli.mjs';
import {rawDetails} from '../test-support/detail-fixture.mjs';
import { playwrightStatus,mockBridge} from '../test-support/mock-bridge.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
function rawService(open = false, expanded = open) {
  const raw = rawDetails();
  raw.details.services.terms = {schema_version: 1, panel_observed: open, entry_expanded: expanded, items_seen: Number(open),
    items: open ? [{label: '7天无理由退换', header_text: '7天无理由退换', body_text: '剪标后不支持', body_clipped: false,
      body_truncated: false, additional_entry_labels: []}] : []};
  return raw;
}
async function fixture(t, configure = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping services '));
  t.after(() => rm(root, {recursive: true, force: true}));
  let time = Date.now(), reads = 0, actions = 0, opened = false;
  const clock = {now: () => time, wait: async ms => {time += ms;}};
  const bridge = {endpoint: 'http://127.0.0.1:19824',
    async readDetails() {reads++; return validateDetails(await (configure.read?.(reads, opened) ?? rawService(opened)), target);},
    async expandServices() {
      actions++;
      const saved = await loadTask(root, 'services');
      assert.equal(saved.operations[0].service_read.action_reserved, true);
      assert.deepEqual(saved.operations[0].service_read.labels, ['7天无理由退换']);
      opened = true;
      if (configure.act) return configure.act();
      return {clicked: true};
    }};
  await saveBinding(root, 'sample', {schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint, tab_id: 41, target, created_at: new Date(time).toISOString()});
  const options = {stateDirectory: root, task: 'services', bindings: ['sample'], services: true, bridge};
  await createTask(options);
  return {root, options, clock, reads: () => reads, actions: () => actions, filename: path.join(root, 'tasks/services.json')};
}
const fail = code => {throw new ShoppingError(code, 'Synthetic service failure');};

test('service task saves intent before one expansion and caches the resulting terms', async t => {
  const f = await fixture(t), result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete');assert.equal(f.reads(), 2);assert.equal(f.actions(), 1);
  assert.equal(result.operations[0].actions_reserved, 1);
  assert.equal(result.operations[0].result.details.services.terms.full_terms_verified, false);
  const saved = await readFile(f.filename);
  await runTask(f.options, f.clock);assert.equal(f.reads(), 2);assert.deepEqual(await readFile(f.filename), saved);
});

test('an already open panel needs no action; an expanded loading panel is only observed', async t => {
  for (const delayed of [false, true]) {
    const f = await fixture(t, {read: count => rawService(!delayed || count > 1, true)});
    assert.equal((await runTask(f.options, f.clock)).status, 'complete');
    assert.equal(f.actions(), 0);assert.equal(f.reads(), delayed ? 2 : 1);
  }
});

test('lost service acknowledgement is retained and followed by a read, never another click', async t => {
  const f = await fixture(t, {act: () => fail('BRIDGE_TIMEOUT')});
  const r = await runTask(f.options, f.clock);
  assert.equal(r.status, 'complete');assert.equal(f.actions(), 1);
  assert.equal(r.operations[0].result.service_evidence.acknowledgement_error, 'BRIDGE_TIMEOUT');
});

test('an unconfirmed service action stops after three checks and blocks task-name bypass', async t => {
  const f = await fixture(t, {read: () => rawService(false)});
  const r = await runTask(f.options, f.clock);
  assert.equal(r.status, 'stopped');assert.equal(r.operations[0].error.code, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(f.actions(), 1);assert.equal(f.reads(), 4);
  await assert.rejects(createTask({...f.options, task: 'bypass'}), {code: 'PLATFORM_TASK_UNFINISHED'});
});

test('service read failures retain observations and the usual 5/15 second recovery budget', async t => {
  const f = await fixture(t, {read: () => fail('BRIDGE_TIMEOUT')});
  const r = await runTask(f.options, f.clock);
  assert.equal(r.status, 'partial');assert.equal(r.automatic_retries, 2);assert.equal(r.wait_reserved_ms, 20000);
  assert.equal(r.operations[0].dom_observations_reserved, 3);assert.equal(f.actions(), 0);
});

test('verification and rate limits after dispatch pause before any follow-up, without refunding intent', async t => {
  for (const [code, status, recovery] of [['VERIFICATION_REQUIRED', 'waiting_user', 'user'], ['RATE_LIMITED', 'waiting_cooldown', 'cooldown']]) {
    const f = await fixture(t, {act: () => fail(code)});
    assert.equal((await runTask(f.options, f.clock)).status, status);assert.equal(f.reads(), 1);
    assert.equal((await runTask({...f.options, recovery}, f.clock)).status, 'complete');assert.equal(f.actions(), 1);
  }
});

test('known undispatched guards and malformed acknowledgements keep the reservation and stop safely', async t => {
  for (const code of ['PAGE_STRUCTURE_CHANGED', 'INVALID_RESPONSE']) {
    const f = await fixture(t, {act: () => {const e = new ShoppingError(code, 'Guard');e.actionNotDispatched = true;throw e;}});
    const r = await runTask(f.options, f.clock);
    assert.equal(r.status, 'stopped');assert.equal(r.operations[0].actions_reserved, 1);assert.equal(f.reads(), 1);
  }
});

test('changed labels after dispatch cannot be accepted as the original service panel', async t => {
  const f = await fixture(t, {read: count => {
    const raw = rawService(count > 1);
    if (count > 1) {raw.details.services.labels = ['另一服务'];Object.assign(raw.details.services.terms.items[0], {label: '另一服务', header_text: '另一服务'});}
    return raw;
  }});
  const r = await runTask(f.options, f.clock);assert.equal(r.status, 'stopped');
  assert.equal(r.operations[0].error.code, 'PAGE_STRUCTURE_CHANGED');assert.equal(f.actions(), 1);
});

test('tampered service journals and result guarantees fail before browser calls', async t => {
  const f = await fixture(t), original = await readFile(f.filename, 'utf8');
  for (const mutate of [s => {s.observations = 9;}, s => {s.labels = ['x'];}, s => {s.action_reserved = true;}, s => {s.checks = 1;}]) {
    const bad = JSON.parse(original);mutate(bad.operations[0].service_read);
    await writeFile(f.filename, JSON.stringify(bad));
    await assert.rejects(runTask(f.options, f.clock), {code: 'INVALID_CHECKPOINT'});
  }
  assert.equal(f.reads(), 0);await writeFile(f.filename, original);await runTask(f.options, f.clock);
  const complete = JSON.parse(await readFile(f.filename, 'utf8'));
  for (const mutate of [r => {r.service_evidence.actions_reserved = 0;}, r => {r.details.services.terms.full_terms_verified = true;}]) {
    const bad = structuredClone(complete);mutate(bad.operations[0].result);await writeFile(f.filename, JSON.stringify(bad));
    await assert.rejects(taskStatus(f.options), {code: 'INVALID_CHECKPOINT'});
  }
  assert.equal(f.reads(), 2);
});

test('services CLI validates exclusive modes and returns a saved open-panel observation', async t => {
  const f = await fixture(t);
  const {endpoint, state} = await mockBridge(t);
  await saveBinding(f.root, 'cli', {schema_version: 1, platform: 'taobao', endpoint, tab_id: 41, target, created_at: new Date().toISOString()});
  const run = async args => {let text = '';await main(args, {write: part => {text += part;}});return JSON.parse(text);};
  const common = ['--endpoint', endpoint, '--state-dir', f.root];
  for (const extra of [['--details'], ['--reviews'], ['--search', 'x', '--tab', '41'], ['--plan', 'absent.json']]) {
    const r = await run(['task-start', ...common, '--task', 'bad', '--services', '--bindings', 'cli', ...extra]);
    assert.equal(r.error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal(state.commands.length, 0);
  // Complete the independent fixture task before creating the CLI task in the same state directory.
  await runTask(f.options, f.clock);
  state.metadata = rawService(true);
  const r = await run(['task-start', ...common, '--task', 'cli', '--services', '--bindings', 'cli']);
  assert.equal(r.task_kind, 'product_services');
  assert.equal((await run(['task-run', ...common, '--task', 'cli'])).status, 'complete');
});

test('killing the services CLI after dispatch preserves intent and resumes with observation only', {timeout: 15000}, async t => {
  const f = await fixture(t);
  let dispatched = false, actions = 0, resolveDispatch;
  const dispatch = new Promise(resolve => {resolveDispatch = resolve;});
  const mock = await mockBridge(t, {handler: ({req, res, body}) => {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    const reply = result => send({id: body.id, success: true, data: {result}});
    if (body.action === 'tab_list') return send({id: body.id, success: true, data: {tabs: [{id: 41, url: target.url}]}});
    if (body.script.includes('(function inspectEntry(')) {
      dispatched = true;actions++;reply({state: 'action_dispatched', clicked: true});resolveDispatch();return;
    }
    reply(rawService(dispatched));
  }});
  const saved = JSON.parse(await readFile(f.filename, 'utf8'));saved.endpoint = mock.endpoint;await writeFile(f.filename, JSON.stringify(saved));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url)), 'task-run', '--task', 'services', '--state-dir', f.root, '--endpoint', mock.endpoint], {stdio: 'ignore'});
  t.after(() => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');});
  await Promise.race([dispatch, once(child, 'exit').then(() => {throw new Error('CLI exited before dispatch');})]);
  const exited = once(child, 'exit');child.kill('SIGKILL');await exited;
  const r = await runTask({...f.options, bridge: new BrowserBridge(mock.endpoint)}, f.clock);
  assert.equal(r.status, 'complete');assert.equal(r.operations[0].attempts, 2);assert.equal(r.automatic_retries, 1);
  assert.equal(r.wait_reserved_ms, 5000);assert.equal(actions, 1);
});
