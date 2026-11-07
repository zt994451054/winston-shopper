import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { validateDescriptionImageObservation, validateDescriptionImageScroll } from '../lib/description-image-loading.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { main } from '../lib/cli.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { rawDescriptionImage } from '../test-support/description-image-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const fail = code => { throw new ShoppingError(code, 'Synthetic image loading failure'); };
async function fixture(t, configure = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping description image '));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.now(), reads = 0, actions = 0, scrolled = false;
  const clock = { now: () => time, wait: async ms => { time += ms; } };
  const bridge = { endpoint: 'http://127.0.0.1:19824',
    async readDescriptionImageLoading() {
      reads++; return validateDescriptionImageObservation(await (configure.read?.(reads, scrolled) ?? rawDescriptionImage({ normal: scrolled, inView: scrolled })), target, 1);
    },
    async scrollDescriptionImage(tabId, product, position, initial) {
      actions++;
      const saved = (await loadTask(root, 'loading')).operations[0].description_image_read;
      assert.equal(saved.action_reserved, true); assert(saved.observations >= 2);
      scrolled = true;
      return configure.act ? configure.act(initial) : validateDescriptionImageScroll({ observation: rawDescriptionImage(), scrolled: true, reason: 'offscreen_resource' }, target, 1, initial);
    } };
  await saveBinding(root, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint, tab_id: 41, target, created_at: new Date(time).toISOString() });
  const options = { stateDirectory: root, task: 'loading', bindings: ['sample'], descriptionImageLoad: 1, bridge };
  await createTask(options);
  return { root, options, clock, reads: () => reads, actions: () => actions, filename: path.join(root, 'tasks/loading.json') };
}

test('description image workflow reserves one scroll before dispatch and confirms two later images', async t => {
  const f = await fixture(t), report = await runTask(f.options, f.clock), result = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 3); assert.equal(f.actions(), 1);
  assert.equal(report.operations[0].dom_observations_reserved, 4);
  assert.equal(result.description_image_loading.status, 'normal_image_confirmed');
  assert.equal(result.description_image_loading.initial_image.width, 1); assert.equal(result.description_image_loading.final_image.width, 800);
  assert.equal(result.description_image_loading.normal_image_stability_confirmed, true);
  assert.equal(result.description_image_loading.scrolling_caused_loading_verified, false); assert.equal(result.description_image_loading.sku_id, null);
  const before = await readFile(f.filename); await runTask(f.options, f.clock); await taskStatus(f.options);
  assert.equal(f.reads(), 3); assert.deepEqual(await readFile(f.filename), before);
});
test('already-normal images and unverified positions finish without scrolling', async t => {
  for (const [raw, status] of [[rawDescriptionImage({ normal: true }), 'already_ready'], [rawDescriptionImage({ owned: false }), 'target_unverified'],
    [rawDescriptionImage({ inView: true }), 'target_unverified'], [rawDescriptionImage({ count: 61 }), 'target_unverified']]) {
    const f = await fixture(t, { read: () => raw });
    const report = await runTask(f.options, f.clock); assert.equal(report.status, 'complete');
    assert.equal(report.operations[0].result.description_image_loading.status, status); assert.equal(f.actions(), 0); assert.equal(f.reads(), 1);
  }
});
test('tiny images which remain unresolved are returned after exactly three post-checks', async t => {
  const f = await fixture(t, { read: () => rawDescriptionImage() });
  const report = await runTask(f.options, f.clock); assert.equal(report.status, 'complete'); assert.equal(f.actions(), 1);
  assert.equal(report.operations[0].dom_observations_reserved, 5);
  assert.equal(report.operations[0].result.description_image_loading.status, 'image_unresolved');
  assert.equal(report.operations[0].result.description_image_loading.normal_image_stability_confirmed, false);
});
test('unknown scroll acknowledgement permits only observations and never repeats the action', async t => {
  const f = await fixture(t, { act: () => fail('BRIDGE_TIMEOUT') });
  const report = await runTask(f.options, f.clock); assert.equal(report.status, 'complete'); assert.equal(f.actions(), 1);
  const result = report.operations[0].result.description_image_loading;
  assert.equal(result.scrolled, null); assert.equal(result.acknowledgement_error, 'BRIDGE_TIMEOUT'); assert.equal(report.automatic_retries, 0);
});
test('a guard detecting an already-ready image skips its scroll and still requires post-confirmation', async t => {
  const f = await fixture(t, { act: initial => validateDescriptionImageScroll({ observation: rawDescriptionImage({ normal: true, url: 'https://img.alicdn.com/tiny.png' }),
    scrolled: false, reason: 'already_ready' }, target, 1, initial) });
  const report = await runTask(f.options, f.clock); assert.equal(report.status, 'complete');
  assert.equal(report.operations[0].result.description_image_loading.scrolled, false); assert.equal(f.reads(), 3);
});
test('changed container/image counts stop and preserve the last unconfirmed observation', async t => {
  const f = await fixture(t, { read: count => rawDescriptionImage({ normal: count > 1, count: count > 1 ? 2 : 1 }) });
  const report = await runTask(f.options, f.clock); assert.equal(report.status, 'stopped'); assert.equal(f.actions(), 1);
  assert.equal(report.operations[0].error.code, 'PAGE_STRUCTURE_CHANGED');
  assert.equal(report.operations[0].unconfirmed_description_image_observations.last.scope.images_seen, 2);
  assert.equal(report.operations[0].unconfirmed_description_image_observations.normal_image_stability_confirmed, false);
  await assert.rejects(createTask({ ...f.options, task: 'bypass' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});
test('changing normal image URLs require two consecutive identical later observations', async t => {
  const f = await fixture(t, { read: count => rawDescriptionImage({ normal: count > 1, url: count === 1 ? 'https://img.alicdn.com/tiny.png' : count === 2 ? 'https://img.alicdn.com/first.jpg' : 'https://img.alicdn.com/final.jpg' }) });
  const report = await runTask(f.options, f.clock); assert.equal(report.status, 'complete'); assert.equal(f.reads(), 4);
  assert.equal(report.operations[0].result.description_image_loading.final_image.url, 'https://img.alicdn.com/final.jpg');
});
test('initial read faults consume the shared 5/15 second retries and never scroll', async t => {
  const f = await fixture(t, { read: () => fail('BRIDGE_TIMEOUT') });
  const report = await runTask(f.options, f.clock); assert.equal(report.status, 'partial'); assert.equal(f.actions(), 0);
  assert.equal(report.automatic_retries, 2); assert.equal(report.wait_reserved_ms, 20000); assert.equal(report.operations[0].dom_observations_reserved, 3);
});
test('a failed post-read breaks confirmation and retains an unresolved outcome', async t => {
  const f = await fixture(t, { read: count => count === 3 ? fail('BRIDGE_TIMEOUT') : rawDescriptionImage({ normal: count > 1 }) });
  const report = await runTask(f.options, f.clock); assert.equal(report.status, 'complete'); assert.equal(f.actions(), 1);
  assert.equal(report.automatic_retries, 1); assert.equal(report.wait_reserved_ms, 5000);
  assert.equal(report.operations[0].result.description_image_loading.status, 'image_unresolved');
});
test('verification pauses preserve the original action and resume using only reads', async t => {
  let released = false;
  const f = await fixture(t, { read: count => count > 1 && !released ? fail('VERIFICATION_REQUIRED') : rawDescriptionImage({ normal: count > 1 }) });
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user'); assert.equal(f.actions(), 1);
  released = true;
  const report = await runTask({ ...f.options, recovery: 'user' }, f.clock); assert.equal(report.status, 'complete'); assert.equal(f.actions(), 1);
});
test('an interrupted pacing wait does not refund or repeat the scroll', async t => {
  const f = await fixture(t); let interrupted = false;
  const clock = { ...f.clock, wait: async ms => { if (!interrupted) { interrupted = true; fail('READ_INTERRUPTED'); } await f.clock.wait(ms); } };
  const report = await runTask(f.options, clock); assert.equal(report.status, 'complete'); assert.equal(f.actions(), 1);
  assert.equal(report.automatic_retries, 1); assert.equal(report.operations[0].dom_observations_reserved, 4);
});
test('undispatched source guards stay stopped without a replacement scroll', async t => {
  const f = await fixture(t, { act: () => { const error = new ShoppingError('PAGE_STRUCTURE_CHANGED', 'Synthetic changed source'); error.actionNotDispatched = true; throw error; } });
  const first = await runTask(f.options, f.clock); assert.equal(first.status, 'stopped'); await runTask(f.options, f.clock);
  assert.equal(f.actions(), 1); assert.equal(first.operations[0].dom_observations_reserved, 2);
});
test('forged journals and completed delivery claims fail before browser access', async t => {
  const f = await fixture(t), before = await readFile(f.filename, 'utf8');
  for (const change of [s => { s.observations = 7; }, s => { s.scrolled = true; }, s => { s.position = 61; },
    s => { s.confirmations = 2; }, s => { s.guard_reason = 'invented'; }]) {
    const task = JSON.parse(before); change(task.operations[0].description_image_read); await writeFile(f.filename, JSON.stringify(task));
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.reads(), 0); await writeFile(f.filename, before); await runTask(f.options, f.clock);
  const task = JSON.parse(await readFile(f.filename)); task.operations[0].result.description_image_loading.sku_price_binding_verified = true;
  await writeFile(f.filename, JSON.stringify(task)); await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
});
test('description image CLI accepts one position and excludes other modes before connecting', async t => {
  const f = await fixture(t); await runTask(f.options, f.clock);
  const mock = await mockBridge(t);
  await saveBinding(f.root, 'cli', { schema_version: 1, platform: 'taobao', endpoint: mock.endpoint, tab_id: 41, target, created_at: new Date().toISOString() });
  const command = async args => { let text = ''; await main(args, { write: part => { text += part; } }); return JSON.parse(text); };
  const common = ['--endpoint', mock.endpoint, '--state-dir', f.root, '--bindings', 'cli'];
  for (const extra of [['--details'], ['--services'], ['--description-expand'], ['--reviews'], ['--gallery']]) {
    assert.equal((await command(['task-start', ...common, '--task', 'bad', '--description-image-load', '1', ...extra])).error.code, 'INVALID_ARGUMENTS');
  }
  for (const value of ['0', '61', '1.5', 'x']) assert.equal((await command(['task-start', ...common, '--task', 'bad', '--description-image-load', value])).error.code, 'INVALID_ARGUMENTS');
  assert.equal(mock.state.commands.length, 0); mock.state.metadata = rawDescriptionImage({ normal: true });
  assert.equal((await command(['task-start', ...common, '--task', 'cli', '--description-image-load', '1'])).task_kind, 'product_description_image_loading');
  const run = await command(['task-run', '--endpoint', mock.endpoint, '--state-dir', f.root, '--task', 'cli']);
  assert.equal(run.status, 'complete'); assert.equal(run.operations[0].result.description_image_loading.status, 'already_ready');
});

test('killing the CLI during the scroll response preserves one intent and resumes using reads', { timeout: 15000 }, async t => {
  const f = await fixture(t); let dispatched = false, actions = 0, resolveDispatch;
  const dispatch = new Promise(resolve => { resolveDispatch = resolve; });
  const mock = await mockBridge(t, { handler: ({ req, res, body }) => {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: 41, url: target.url }] } });
    if (body.script.includes('(function scrollImage(')) {
      dispatched = true; actions++;
      reply({ observation: rawDescriptionImage(), scrolled: true, reason: 'offscreen_resource' }); resolveDispatch(); return;
    }
    reply(rawDescriptionImage({ normal: dispatched }));
  } });
  const saved = JSON.parse(await readFile(f.filename)); saved.endpoint = mock.endpoint; await writeFile(f.filename, JSON.stringify(saved));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url)), 'task-run', '--task', 'loading', '--state-dir', f.root, '--endpoint', mock.endpoint], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([dispatch, once(child, 'exit').then(() => { throw Error('CLI exited before dispatch'); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const result = await runTask({ ...f.options, bridge: new BrowserBridge(mock.endpoint) }, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(actions, 1); assert.equal(result.automatic_retries, 1);
  assert.equal(result.wait_reserved_ms, 5000); assert.equal(result.operations[0].dom_observations_reserved, 4);
});
