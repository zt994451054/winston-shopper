import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, runTask } from '../lib/tasks.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { validateSpecificationImages, specificationImageContinuation, specificationImageBatchScript } from '../lib/specification-images.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { main } from '../lib/cli.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { newSpecificationImageBatches } from '../lib/specification-image-batches.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
function rawPage(total, offset) {
  return { state: 'observed', product_id: '123', url: target.url,
    observed_at: new Date(Date.UTC(2026, 8, 28, 12, 0, offset)).toISOString(), batch_offset: offset,
    groups_seen: 1, groups: [{ name: '颜色', options_seen: total, options_scanned: total, image_options_seen: total,
      options: Array.from({ length: Math.min(5, total - offset) }, (_, index) => ({ position: offset + index + 1,
        label: `颜色${offset + index}`, selected: null, disabled: null, image_regions_seen: 1, image_elements_seen: 1,
        image: { url: `https://img.alicdn.com/option-${offset + index}.jpg`, loaded: true, width: 80, height: 80 } })) }] };
}

async function fixture(t, total = 32, behavior) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping image batches '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const filename = path.join(stateDirectory, 'tasks/batch.json');
  let reads = 0, now = Date.now();
  const offsets = [], waits = [];
  const bridge = { endpoint: 'http://127.0.0.1:19824', async readSpecificationImages(tab, identity, batches) {
    reads++;
    const stored = JSON.parse(await readFile(filename));
    assert.equal(stored.operations[0].status, 'running');
    assert.equal(stored.operations[0].attempts, reads);
    const offset = specificationImageContinuation(batches, target).offset;
    offsets.push(offset);
    if (behavior) behavior(reads, offset);
    return validateSpecificationImages(rawPage(total, offset), target);
  } };
  await saveBinding(stateDirectory, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint,
    tab_id: 41, target, created_at: new Date(now).toISOString() });
  const options = { stateDirectory, task: 'batch', bindings: ['sample'], specificationImages: true, bridge };
  await createTask(options);
  const legacy = JSON.parse(await readFile(filename));
  delete legacy.operations[0].specification_collection;
  legacy.operations[0].specification_image_batches = newSpecificationImageBatches();
  await writeFile(filename, JSON.stringify(legacy));
  const clock = { now: () => now, wait: async ms => { waits.push(ms); now += ms; } };
  return { options, filename, clock, offsets, waits, reads: () => reads,
    read: extra => runTask({ ...options, ...extra }, clock) };
}

test('32 image options are read in seven explicit batches with saved progress and no duplicate reads', async t => {
  const f = await fixture(t);
  let report = await f.read();
  assert.equal(report.status, 'awaiting_batch');
  assert.equal(report.operations[0].image_batches.coverage.image_options_remaining, 27);
  const before = await readFile(f.filename, 'utf8');
  await f.read(); await f.read();
  assert.equal(f.reads(), 1); assert.equal(await readFile(f.filename, 'utf8'), before);
  const first = structuredClone(report.operations[0].image_batches.batches[0]);
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }), { code: 'PLATFORM_TASK_UNFINISHED' });
  for (let index = 0; index < 6; index++) report = await f.read({ nextBatch: true });
  assert.equal(report.status, 'complete');
  assert.equal(report.operations[0].result.coverage.image_options_sampled, 32);
  assert.equal(report.operations[0].result.coverage.image_options_remaining, 0);
  assert.equal(report.operations[0].result.coverage.full_option_images, false);
  assert.deepEqual(report.operations[0].result.batches[0], first);
  assert.deepEqual(f.offsets, [0, 5, 10, 15, 20, 25, 30]);
  const completeBytes = await readFile(f.filename, 'utf8');
  await f.read(); await f.read({ nextBatch: true });
  assert.equal(f.reads(), 7); assert.equal(await readFile(f.filename, 'utf8'), completeBytes);
});

test('eight-batch budget stops with saved partial results and cannot be renewed by next-batch', async t => {
  const f = await fixture(t, 41);
  let report = await f.read();
  for (let index = 0; index < 7; index++) report = await f.read({ nextBatch: true });
  assert.equal(report.status, 'stopped');
  assert.equal(report.operations[0].error.code, 'SPECIFICATION_IMAGE_BATCH_LIMIT');
  assert.equal(report.operations[0].image_batches.coverage.image_options_sampled, 40);
  assert.equal(report.operations[0].image_batches.coverage.image_options_remaining, 1);
  await f.read({ nextBatch: true });
  assert.equal(f.reads(), 8);
});

test('automatic retry budget is shared across batches and earlier images survive later exhaustion', async t => {
  const f = await fixture(t, 20, count => { if ([2, 4, 6].includes(count)) throw new ShoppingError('PAGE_LOADING', 'Synthetic'); });
  await f.read(); await f.read({ nextBatch: true }); await f.read({ nextBatch: true });
  const report = await f.read({ nextBatch: true });
  assert.equal(report.status, 'partial');
  assert.equal(report.automatic_retries, 2); assert.equal(report.wait_reserved_ms, 20000);
  assert.deepEqual(f.waits.filter(ms => ms > 1500), [5000, 15000]);
  assert.deepEqual(f.offsets, [0, 5, 5, 10, 10, 15]);
  assert.equal(report.operations[0].image_batches.coverage.image_options_sampled, 15);
  assert.equal(report.operations[0].image_batches.coverage.image_options_remaining, 5);
});

test('human verification pauses a later batch and explicit recovery resumes its same offset', async t => {
  const f = await fixture(t, 12, count => { if (count === 2) throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic'); });
  await f.read();
  const paused = await f.read({ nextBatch: true });
  assert.equal(paused.status, 'waiting_user');
  assert.equal(paused.operations[0].image_batches.batches.length, 1);
  await assert.rejects(f.read({ nextBatch: true }), { code: 'RECOVERY_REQUIRED' });
  assert.equal((await f.read({ recovery: 'user' })).status, 'awaiting_batch');
  assert.deepEqual(f.offsets, [0, 5, 5]);
  assert.equal((await f.read({ nextBatch: true })).status, 'complete');
});

test('changed inventory stops after one later attempt while preserving the completed first batch', async t => {
  const f = await fixture(t, 12, count => { if (count === 2) throw new ShoppingError('SPECIFICATION_IMAGE_INVENTORY_CHANGED', 'Synthetic'); });
  await f.read();
  const report = await f.read({ nextBatch: true });
  assert.equal(report.status, 'stopped'); assert.equal(report.automatic_retries, 0);
  assert.equal(report.operations[0].image_batches.batches.length, 1);
  assert.equal(f.reads(), 2);
});

test('repeated explicit verification recovery cannot exceed the ten-read task budget', async t => {
  const f = await fixture(t, 12, () => { throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic'); });
  await f.read();
  for (let index = 0; index < 9; index++) assert.equal((await f.read({ recovery: 'user' })).status, 'waiting_user');
  const stopped = await f.read({ recovery: 'user' });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.operations[0].error.code, 'SPECIFICATION_IMAGE_READ_LIMIT');
  assert.equal(f.reads(), 10);
});

test('an interrupted later batch preserves the prefix and counts its retry before dispatch', async t => {
  const f = await fixture(t, 12); await f.read();
  const stored = JSON.parse(await readFile(f.filename));
  stored.status = 'running'; stored.operations[0].status = 'running'; stored.operations[0].attempts = 2;
  await writeFile(f.filename, JSON.stringify(stored));
  let resumed = 0;
  f.options.bridge.readSpecificationImages = async (tab, identity, batches) => {
    resumed++;
    const current = JSON.parse(await readFile(f.filename));
    assert.equal(current.operations[0].attempts, 3);
    assert.equal(current.operations[0].retries, 1);
    assert.equal(specificationImageContinuation(batches, target).offset, 5);
    return validateSpecificationImages(rawPage(12, 5), target);
  };
  const report = await f.read();
  assert.equal(report.status, 'awaiting_batch');
  assert.equal(report.operations[0].image_batches.coverage.image_options_sampled, 10);
  assert.equal(report.wait_reserved_ms, 5000);
  assert.equal(resumed, 1);
});

test('tampered batch limits and consumed offsets are rejected before task browser IO', async t => {
  const f = await fixture(t, 12); await f.read();
  const valid = JSON.parse(await readFile(f.filename));
  for (const mutate of [v => { v.operations[0].specification_image_batches.read_limit = 99; },
    v => { v.operations[0].specification_image_batches.batch_limit = 9; },
    v => { v.operations[0].specification_image_batches.batches[0].batch.offset = 5; },
    v => { v.operations[0].attempts = 0; }]) {
    const changed = structuredClone(valid); mutate(changed);
    await writeFile(f.filename, JSON.stringify(changed));
    await assert.rejects(f.read({ nextBatch: true }), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.reads(), 1);
});

test('legacy completed snapshots stay byte-identical and are never automatically converted to batches', async t => {
  const f = await fixture(t, 2); await f.read();
  const task = JSON.parse(await readFile(f.filename)), raw = rawPage(2, 0);
  delete raw.batch_offset;
  delete task.operations[0].specification_image_batches;
  task.operations[0].result = validateSpecificationImages(raw, target);
  await writeFile(f.filename, JSON.stringify(task));
  const before = await readFile(f.filename, 'utf8');
  const report = await f.read({ nextBatch: true });
  assert.equal(report.operations[0].result.schema_version, 1);
  assert.equal(report.operations[0].image_batches, undefined);
  assert.equal(await readFile(f.filename, 'utf8'), before);
  assert.equal(f.reads(), 1);
});

test('continuation rejects reordered, overlapping or changed-layout saved batches', () => {
  const first = validateSpecificationImages(rawPage(12, 0), target), second = validateSpecificationImages(rawPage(12, 5), target);
  assert.equal(specificationImageContinuation([first, second], target).offset, 10);
  for (const batches of [[second], [first, first], [second, first]]) {
    assert.throws(() => specificationImageContinuation(batches, target), { code: 'INVALID_CHECKPOINT' });
  }
  const changed = validateSpecificationImages(rawPage(13, 5), target);
  assert.throws(() => specificationImageContinuation([first, changed], target), { code: 'INVALID_CHECKPOINT' });
  const complete = validateSpecificationImages(rawPage(2, 0), target);
  assert.throws(() => specificationImageBatchScript(target, [complete]), { code: 'SPECIFICATION_IMAGE_BATCH_LIMIT' });
});

test('CLI next-batch is explicit and task-run between batches returns cache without platform commands', async t => {
  const f = await fixture(t, 7);
  let offset = 0;
  const server = await mockBridge(t, { handler({ req, res, body, state }) {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    const data = body.action === 'tab_list' ? { tabs: state.tabs } : { result: rawPage(7, offset) };
    if (body.action === 'eval') offset += 5;
    res.end(JSON.stringify({ id: body.id, success: true, data }));
  } });
  const stored = JSON.parse(await readFile(f.filename)); stored.endpoint = server.endpoint;
  await writeFile(f.filename, JSON.stringify(stored));
  const run = async command => {
    let output = '';
    const code = await main([command, '--task', 'batch', '--state-dir', f.options.stateDirectory, '--endpoint', server.endpoint], { write: text => { output += text; } });
    const value = JSON.parse(output);
    assert.equal(code, value.status === 'complete' ? 0 : 2); return value;
  };
  assert.equal((await run('task-run')).status, 'awaiting_batch');
  assert.equal((await run('task-run')).status, 'awaiting_batch');
  assert.equal(server.state.commands.length, 2);
  const final = await run('task-next-batch');
  assert.equal(final.status, 'complete');
  assert.equal(final.operations[0].result.coverage.image_options_sampled, 7);
  assert.equal(server.state.commands.length, 4);
});
