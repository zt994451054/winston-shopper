import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { createTask, runTask, taskStatus, rebindTask } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { loadMainImagePlan } from '../lib/main-image-plan.mjs';
import { mainImageScript, normalizeMainImages, validateMainImageObservation } from '../lib/main-images.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { mainImageObservation } from '../test-support/main-image-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseProductUrl('https://item.taobao.com/item.htm?id=123');
const thumbnail = 'https://img.alicdn.com/thumb.jpg';
const fail = code => { throw new ShoppingError(code, 'Synthetic main image failure'); };

async function fixture(t, settings = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping main image '));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.now(), reads = 0, actions = 0;
  const clock = { now: () => time, wait: async ms => { time += ms; } };
  const bridge = { endpoint: 'http://127.0.0.1:19824',
    async readMainImage(_tab, _target, source) {
      reads++;
      const state = (await loadTask(root, 'main')).operations[0].main_image_read;
      assert.equal(state.observations, reads);
      const observed = mainImageObservation(target, source, { observed_at: new Date(time).toISOString(),
        ...(reads === 1 && !settings.initiallySelected ? { selected: false, image: null } : {}) });
      return settings.read ? settings.read(reads, observed) : observed;
    },
    async selectMainImage() {
      const state = (await loadTask(root, 'main')).operations[0].main_image_read;
      assert.equal(state.steps.find(step => !step.after).action_reserved, true);
      actions++; return settings.act?.() ?? { clicked: true };
    } };
  const binding = { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint, tab_id: 41, target, created_at: new Date(time).toISOString() };
  await saveBinding(root, 'sample', binding);
  const planFile = path.join(root, 'plan.json');
  await writeFile(planFile, JSON.stringify(settings.plan ?? [thumbnail]));
  const options = { stateDirectory: root, task: 'main', bindings: ['sample'], mainImages: planFile, bridge };
  await createTask(options);
  return { root, options, planFile, binding, clock, reads: () => reads, actions: () => actions, filename: path.join(root, 'tasks/main.json') };
}

test('main image tasks save reservations before IO and return cached selected-image evidence', async t => {
  const f = await fixture(t), report = await runTask(f.options, f.clock), result = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 3); assert.equal(f.actions(), 1);
  assert.equal(result.samples[0].image.width, 1280);
  assert.equal(result.samples[0].association.image_url_changed_after_intent, true);
  assert.equal(result.samples[0].association.sku_id, null); assert.equal(result.coverage.full_gallery, false);
  assert.equal(result.coverage.file_downloaded, false);
  const bytes = await readFile(f.filename);
  assert.deepEqual(await taskStatus(f.options), report); assert.deepEqual(await runTask(f.options, f.clock), report);
  assert.equal(f.reads(), 3); assert.deepEqual(await readFile(f.filename), bytes);
});

test('an already selected static image requires two reads and no selection or panel cleanup', async t => {
  const f = await fixture(t, { initiallySelected: true });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 2); assert.equal(f.actions(), 0);
  assert.equal(report.operations[0].result.samples[0].association.initially_selected, true);
  assert.equal(report.operations[0].result.samples[0].association.image_url_changed_after_intent, null);
});

test('a selected marker with an unchanged previous main URL cannot confirm a switch', async t => {
  const f = await fixture(t, { read: (count, observation) => ({ ...mainImageObservation(target, thumbnail), selected: count !== 1, observed_at: observation.observed_at }) });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'MAIN_IMAGE_UNCONFIRMED');
  assert.equal(f.reads(), 4); assert.equal(f.actions(), 1); assert.equal(report.operations[0].partial_main_images.length, 0);
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }), { code: 'PLATFORM_TASK_UNFINISHED' });
  await runTask(f.options, f.clock); assert.equal(f.reads(), 4);
});

test('a delayed main URL can confirm within the remaining two observations', async t => {
  const f = await fixture(t, { read: (count, observed) => ({ ...observed,
    image: { ...mainImageObservation(target, thumbnail).image, url: count <= 2 ? 'https://img.alicdn.com/old.jpg' : 'https://img.alicdn.com/new.jpg' } }) });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 4); assert.equal(f.actions(), 1);
  assert.equal(report.operations[0].result.samples[0].image.url, 'https://img.alicdn.com/new.jpg');
});

test('ambiguous click acknowledgement is observed without a repeated click', async t => {
  const f = await fixture(t, { act: () => fail('BRIDGE_TIMEOUT') });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(f.actions(), 1); assert.equal(report.automatic_retries, 0);
  assert.equal(report.operations[0].result.samples[0].action.error, 'BRIDGE_TIMEOUT');
});

test('verification pauses, breaks confirmations and preserves the same bounded task', async t => {
  const f = await fixture(t, { initiallySelected: true, read: (count, observed) => count === 2 ? fail('VERIFICATION_REQUIRED') : observed });
  const paused = await runTask(f.options, f.clock);
  assert.equal(paused.status, 'waiting_user'); assert.equal(f.reads(), 2);
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  const report = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 4); assert.equal(f.actions(), 0);
  const step = (await loadTask(f.root, 'main')).operations[0].main_image_read.steps[0];
  assert.equal(step.after.first.read_index, 3); assert.equal(step.after.second.read_index, 4);
});

test('a late failed confirmation cannot borrow another image budget or reuse stale evidence', async t => {
  const f = await fixture(t, { read: (count, observed) => count === 3 ? fail('BRIDGE_TIMEOUT') : observed });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 4); assert.equal(f.actions(), 1);
  assert.equal(report.automatic_retries, 1); assert.equal(report.wait_reserved_ms, 5000);
  assert.equal(report.operations[0].partial_main_images.length, 0);
});

test('a later blocked image retains the earlier confirmed samples', async t => {
  const plan = [thumbnail, 'https://img.alicdn.com/two.jpg', 'https://img.alicdn.com/three.jpg'];
  const f = await fixture(t, { plan, initiallySelected: true,
    read: (count, observed) => count === 5 ? fail('ACCESS_BLOCKED') : observed });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].partial_main_images.length, 2);
  assert.equal(f.reads(), 5); assert.equal(f.actions(), 0);
});

test('three delayed image switches share exactly twelve reads and never select a thumbnail twice', async t => {
  const plan = [thumbnail, 'https://img.alicdn.com/two.jpg', 'https://img.alicdn.com/three.jpg'];
  const f = await fixture(t, { plan, read: (count, observed) => {
    const phase = (count - 1) % 4, imageIndex = Math.floor((count - 1) / 4);
    return { ...observed, selected: phase !== 0, image: { ...mainImageObservation(target, thumbnail).image,
      url: `https://img.alicdn.com/${phase < 2 ? 'old' : imageIndex}.jpg` } };
  } });
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 12); assert.equal(f.actions(), 3);
  assert.equal(report.operations[0].result.samples.length, 3);
  assert.equal(report.operations[0].result.coverage.full_gallery, false);
});

test('loading, oscillating or video main elements cannot become confirmed samples', async t => {
  for (const mode of ['loading', 'oscillating', 'video']) {
    const f = await fixture(t, { initiallySelected: true, read: (count, observed) => ({ ...observed,
      image: mode === 'video' ? null : { ...observed.image, loaded: mode !== 'loading',
        url: `https://img.alicdn.com/${mode === 'oscillating' ? count : 'same'}.jpg` } }) });
    const report = await runTask(f.options, f.clock);
    assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 4); assert.equal(f.actions(), 0);
  }
});

test('selected loaded DOM images confirm without actions even when their occlusion changes', async t => {
  const f = await fixture(t, { initiallySelected: true, read: (count, observation) => ({ ...observation,
    image: { ...observation.image, uncovered: count === 1 } }) });
  const report = await runTask(f.options, f.clock), result = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(result.schema_version, 2);
  assert.equal(result.source, 'loaded_main_image_dom'); assert.equal(result.samples[0].image.uncovered, false);
  assert.equal(result.samples[0].association.two_matching_observations, true);
  assert.equal(result.samples[0].association.sku_id, null);
  assert.equal(f.reads(), 2); assert.equal(f.actions(), 0);
  const bytes = await readFile(f.filename);
  assert.deepEqual(await taskStatus(f.options), report); assert.deepEqual(await readFile(f.filename), bytes);
});

test('a blocked switch preserves the current DOM image without assigning it to the requested thumbnail', async t => {
  const f = await fixture(t, { read: (_count, observation) => ({ ...observation, selected: false,
    image: { ...mainImageObservation(target, thumbnail).image, uncovered: false } }),
    act: () => { const error = new ShoppingError('ACCESS_BLOCKED', 'Synthetic overlay'); error.actionNotDispatched = true; throw error; } });
  const report = await runTask(f.options, f.clock), operation = report.operations[0];
  assert.equal(report.status, 'stopped'); assert.equal(operation.error.code, 'ACCESS_BLOCKED');
  assert.equal(f.reads(), 1); assert.equal(f.actions(), 1);
  assert.equal(operation.actions_reserved, 1); assert.equal(operation.partial_main_images.length, 0);
  const delivered = operation.unconfirmed_main_image_observations;
  assert.equal(delivered.length, 1); assert.equal(delivered[0].snapshot.selected, false);
  assert.equal(delivered[0].snapshot.image.url, 'https://img.alicdn.com/displayed.jpg');
  assert.equal(delivered[0].snapshot.image.uncovered, false);
  assert.equal(delivered[0].observation_is_latest_read, true);
  assert.equal(delivered[0].association.requested_image_confirmed, false);
  const saved = await readFile(f.filename);
  assert.deepEqual(await runTask(f.options, f.clock), report);
  assert.deepEqual(await readFile(f.filename), saved); assert.equal(f.actions(), 1);
});

test('a later failed read marks the last DOM image as earlier evidence without completing confirmation', async t => {
  const f = await fixture(t, { initiallySelected: true,
    read: (count, observation) => count === 2 ? fail('VERIFICATION_REQUIRED') : observation });
  const report = await runTask(f.options, f.clock), delivered = report.operations[0].unconfirmed_main_image_observations;
  assert.equal(report.status, 'waiting_user'); assert.equal(delivered.length, 1);
  assert.equal(delivered[0].observation_is_latest_read, false);
  assert.equal(delivered[0].association.requested_image_confirmed, false);
  assert.equal(report.operations[0].partial_main_images.length, 0);
  assert.equal(f.reads(), 2); assert.equal(f.actions(), 0);
});

test('legacy main-image journals keep their original confirmation rule and cached output format', async t => {
  const f = await fixture(t, { initiallySelected: true, read: (_count, observation) => ({ ...observation,
    image: { ...observation.image, uncovered: false } }) });
  const task = JSON.parse(await readFile(f.filename));
  task.operations[0].main_image_read.schema_version = 1;
  for (const step of task.operations[0].main_image_read.steps) delete step.last_observation;
  await writeFile(f.filename, JSON.stringify(task));
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 4); assert.equal(f.actions(), 0);
  assert.equal('unconfirmed_main_image_observations' in report.operations[0], false);
  const plain = await fixture(t, { initiallySelected: true });
  const original = JSON.parse(await readFile(plain.filename));
  original.operations[0].main_image_read.schema_version = 1;
  for (const step of original.operations[0].main_image_read.steps) delete step.last_observation;
  await writeFile(plain.filename, JSON.stringify(original));
  const completed = await runTask(plain.options, plain.clock), bytes = await readFile(plain.filename);
  assert.equal(completed.operations[0].result.schema_version, 1);
  assert.equal(completed.operations[0].result.source, 'visible_main_image_dom');
  assert.deepEqual(await taskStatus(plain.options), completed); assert.deepEqual(await readFile(plain.filename), bytes);
});

test('forged latest DOM observations cannot bypass checkpoint validation', async t => {
  const f = await fixture(t, { initiallySelected: true });
  await runTask(f.options, f.clock);
  const original = JSON.parse(await readFile(f.filename));
  for (const alter of [last => { last.read_index++; }, last => { last.observation.product_id = '999'; },
    last => { last.observation.selected = false; }, last => { last.observation.image.url = 'https://example.com/unsafe'; }]) {
    const changed = structuredClone(original); alter(changed.operations[0].main_image_read.steps[0].last_observation);
    await writeFile(f.filename, JSON.stringify(changed));
    await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.reads(), 2); assert.equal(f.actions(), 0);
});

test('replacement tabs do not inherit the original main-image selection evidence', async t => {
  const f = await fixture(t, { read: (count, observed) => count === 2 ? fail('TARGET_MISSING') : observed });
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_connection');
  await saveBinding(f.root, 'replacement', { ...f.binding, tab_id: 42 });
  await rebindTask({ ...f.options, binding: 'replacement' });
  const report = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'MAIN_IMAGE_TAB_CHANGED');
  assert.equal(f.reads(), 2); assert.equal(f.actions(), 1);
});

test('invalid plans, incompatible modes and forged saved evidence reject before browser IO', async t => {
  const f = await fixture(t);
  for (const value of [[], [thumbnail, thumbnail], new Array(4).fill(thumbnail), ['https://example.com/x'], [thumbnail + '?token=secret'], [null]]) {
    assert.throws(() => normalizeMainImages(value), { code: 'INVALID_MAIN_IMAGES' });
    await writeFile(f.planFile, JSON.stringify(value));
    await assert.rejects(loadMainImagePlan(f.planFile), { code: 'INVALID_MAIN_IMAGES' });
  }
  const link = path.join(f.root, 'link.json'); await symlink(f.planFile, link);
  await assert.rejects(loadMainImagePlan(link), { code: 'INVALID_MAIN_IMAGES' });
  await writeFile(f.planFile, ' '.repeat(8193));
  await assert.rejects(loadMainImagePlan(f.planFile), { code: 'INVALID_MAIN_IMAGES' });
  for (const extra of [{ details: true }, { reviews: true }, { services: true }, { reviewCategories: f.planFile }, { plan: f.planFile }]) {
    await assert.rejects(createTask({ ...f.options, task: 'invalid', ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(createTask({ ...f.options, task: 'invalid', bindings: ['sample', 'sample'] }), { code: 'INVALID_BINDINGS' });
  const report = await runTask(f.options, f.clock); assert.equal(report.status, 'complete');
  const original = JSON.parse(await readFile(f.filename));
  for (const alter of [task => { task.operations[0].main_image_read.observations--; },
    task => { task.operations[0].main_image_read.steps[0].after.first.read_index = 1; },
    task => { task.operations[0].result.samples[0].association.sku_id = '123'; },
    task => { task.operations[0].result.coverage.full_gallery = true; }]) {
    const forged = structuredClone(original); alter(forged); await writeFile(f.filename, JSON.stringify(forged));
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.reads(), 3);
});

test('invalid transport image fields and untrusted plan text cannot be accepted or injected', () => {
  for (const alteration of [{ product_id: '999' }, { selected: 'yes' }, { nodes_scanned: 61 },
    { image: { ...mainImageObservation(target, thumbnail).image, url: 'https://example.com/private' } },
    { image: { ...mainImageObservation(target, thumbnail).image, width: 0 } }]) {
    assert.throws(() => validateMainImageObservation(mainImageObservation(target, thumbnail, alteration), target, thumbnail), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => mainImageScript({ url: 'https://example.com' }, thumbnail), { code: 'INVALID_TARGET' });
  assert.throws(() => mainImageScript(target, '\"); fetch("https://example.com")'), { code: 'INVALID_MAIN_IMAGES' });
});

test('the bridge checks tabs then the saved exact address and never acts after a target mismatch', async t => {
  let evaluations = 0;
  const { endpoint, state } = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    const data = body.action === 'tab_list' ? { tabs: [] } : { result: ++evaluations === 1 ? { state: 'observed', url: target.url } : mainImageObservation(target, thumbnail) };
    res.end(JSON.stringify({ id: body.id, success: true, data }));
  } });
  assert.equal((await new BrowserBridge(endpoint).readMainImage(41, target, thumbnail)).image.width, 1280);
  assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval', 'eval']);
  const bad = await mockBridge(t);
  await assert.rejects(new BrowserBridge(bad.endpoint).selectMainImage(41, target, thumbnail), { code: 'TARGET_CHANGED', actionNotDispatched: true });
  assert.deepEqual(bad.state.commands.map(command => command.action), ['tab_list']);
});

test('the formal CLI starts, pauses and resumes main-image tasks and caches results', async t => {
  const f = await fixture(t);
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 41, url: target.url }];
  await saveBinding(f.root, 'cli', { ...f.binding, endpoint });
  const old = JSON.parse(await readFile(f.filename)); old.status = 'ended'; await writeFile(f.filename, JSON.stringify(old));
  const invoke = async args => {
    let output = ''; await main([...args, '--state-dir', f.root, ...(args[0] === 'task-status' ? [] : ['--endpoint', endpoint])], { write: text => { output += text; } });
    return JSON.parse(output);
  };
  const start = await invoke(['task-start', '--task', 'cli', '--bindings', 'cli', '--main-images', f.planFile]);
  assert.equal(start.task_kind, 'product_main_images'); assert.equal(state.commands.length, 0);
  state.metadata = { state: 'verification_required' };
  assert.equal((await invoke(['task-run', '--task', 'cli'])).status, 'waiting_user');
  state.metadata = mainImageObservation(target, thumbnail);
  assert.equal((await invoke(['task-resume', '--task', 'cli', '--after-user'])).status, 'complete');
  const commands = state.commands.length;
  assert.equal((await invoke(['task-status', '--task', 'cli'])).status, 'complete');
  assert.equal((await invoke(['task-run', '--task', 'cli'])).status, 'complete');
  assert.equal(state.commands.length, commands);
});

test('a killed process after durable selection intent never repeats the selection', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const tasksUrl = new URL('../lib/tasks.mjs', import.meta.url).href;
  const fixtureUrl = new URL('../test-support/main-image-fixture.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runTask } from ${JSON.stringify(tasksUrl)};
    import { mainImageObservation } from ${JSON.stringify(fixtureUrl)};
    setInterval(() => {}, 1000);
    await runTask({stateDirectory:${JSON.stringify(f.root)},task:'main',bridge:{endpoint:'http://127.0.0.1:19824',
      readMainImage:async(_tab,target,source)=>mainImageObservation(target,source,{selected:false,image:null}),
      selectMainImage:async()=>{process.stdout.write('intent-saved');await new Promise(()=>{});}}});
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const data = await once(child.stdout, 'data'); assert.match(data[0].toString(), /intent-saved/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  let reads = 0, actions = 0;
  const bridge = { endpoint: f.options.bridge.endpoint,
    readMainImage: async () => { reads++; return mainImageObservation(target, thumbnail); },
    selectMainImage: async () => { actions++; throw new Error('Must not repeat'); } };
  const report = await runTask({ ...f.options, bridge }, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(reads, 2); assert.equal(actions, 0);
  assert.equal(report.automatic_retries, 1); assert.equal(report.wait_reserved_ms, 5000);
  assert.equal(report.operations[0].actions_reserved, 1);
});
