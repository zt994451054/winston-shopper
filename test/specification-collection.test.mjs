import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, runTask } from '../lib/tasks.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { validateTask, loadTask } from '../lib/task-store.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { validateSpecificationCollectionObservation } from '../lib/specification-images.mjs';
import { newSpecificationCollection, reserveSpecificationCollectionRead, acceptSpecificationCollectionRead,
  specificationCollectionResult, specificationCollectionPlan, validateSpecificationCollection } from '../lib/specification-collection.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
function rawObservation(total, plan, call, mutate = () => {}) {
  const inventory = { groups_seen: 1, groups: [{ position: 1, name: '颜色', options_seen: total,
    options: Array.from({ length: Math.min(total, 100) }, (_, index) => ({ position: index + 1,
      label: `颜色${index + 1}`, image_regions_seen: 1 })) }] };
  const positions = plan.positions ?? inventory.groups[0].options.slice(0, 5).map(option => ({ group_position: 1, position: option.position }));
  const samples = positions.map(position => ({ ...position, label: `颜色${position.position}`, selected: null, disabled: null,
    image_regions_seen: 1, image_elements_seen: 1,
    image: { url: `https://img.alicdn.com/option-${position.position}.jpg`, loaded: true, width: 800, height: 800 } }));
  const raw = { state: 'observed', product_id: target.product_id, url: target.url,
    observed_at: new Date(Date.UTC(2026, 8, 29, 1, 0, call)).toISOString(), inventory, samples };
  mutate(raw, call, plan);
  return raw;
}

async function fixture(t, total = 32, mutate, failure, version = 1) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping collection '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const filename = path.join(stateDirectory, 'tasks/collection.json');
  let reads = 0, now = Date.now();
  const plans = [], waits = [];
  const bridge = { endpoint: 'http://127.0.0.1:19824', async readSpecificationCollection(tab, identity, plan) {
    reads++; plans.push(structuredClone(plan));
    const saved = JSON.parse(await readFile(filename));
    assert.equal(saved.operations[0].attempts, reads);
    assert.equal(saved.operations[0].specification_collection.reads.length, reads);
    assert.equal(saved.operations[0].specification_collection.reads.at(-1).observation, null);
    if (failure) failure(reads);
    return validateSpecificationCollectionObservation(rawObservation(total, plan, reads, mutate), identity);
  } };
  await saveBinding(stateDirectory, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint,
    tab_id: 41, target, created_at: new Date(now).toISOString() });
  const options = { stateDirectory, task: 'collection', bindings: ['sample'], specificationImages: true, bridge };
  await createTask(options);
  if (version < 3) {
    const legacy = JSON.parse(await readFile(filename));
    legacy.operations[0].specification_collection = newSpecificationCollection(version);
    await writeFile(filename, JSON.stringify(legacy));
  }
  const clock = { now: () => now, wait: async ms => { waits.push(ms); now += ms; } };
  return { options, filename, plans, waits, reads: () => reads,
    read: extra => runTask({ ...options, ...extra }, clock) };
}

test('format 1 tasks retain their automatic read-only collection and cached completion', async t => {
  const f = await fixture(t);
  const result = await f.read();
  assert.equal(result.status, 'complete');
  assert.equal(f.reads(), 7);
  assert.deepEqual(f.waits, [1500, 1500, 1500, 1500, 1500, 1500]);
  const data = result.operations[0].result;
  assert.equal(data.options.length, 32);
  assert.equal(data.coverage.loaded_image_links, 32);
  assert.equal(data.coverage.full_option_images, false);
  assert.equal(data.collection.stop_reason, 'scanned_image_options_obtained');
  const before = await readFile(f.filename, 'utf8');
  await f.read(); await f.read({ nextBatch: true });
  assert.equal(f.reads(), 7); assert.equal(await readFile(f.filename, 'utf8'), before);
});

test('32 options with 14 tiny images return all labels, 18 useful links and explicit gaps at ten reads', async t => {
  const f = await fixture(t, 32, raw => { for (const sample of raw.samples) if (sample.position >= 19) {
    sample.image.url = 'https://img.alicdn.com/tiny.png'; sample.image.width = 2; sample.image.height = 2;
  } });
  const report = await f.read(), data = report.operations[0].image_collection;
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 10);
  assert.equal(data.options.length, 32); assert.equal(data.coverage.loaded_image_links, 18);
  assert.equal(data.missing_images.length, 14);
  assert.ok(data.missing_images.every(image => image.reason === 'tiny_image_unresolved' && image.attempts === 2));
  assert.equal(data.collection.stop_reason, 'content_read_limit');
  assert.equal(report.automatic_retries, 0);
  const before = await readFile(f.filename, 'utf8');
  await f.read(); assert.equal(await readFile(f.filename, 'utf8'), before);
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});

test('unread options precede retries and a recovered image retains its earlier tiny observation', async t => {
  const f = await fixture(t, 12, (raw, call) => { for (const sample of raw.samples) if (sample.position === 2 && call < 4) {
    sample.image.width = 2; sample.image.height = 2;
  } });
  const report = await f.read(), data = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 4);
  assert.deepEqual(f.plans.slice(1).map(plan => plan.positions.map(option => option.position)), [[6, 7, 8, 9, 10], [11, 12], [2]]);
  assert.equal(data.options[1].observations.length, 2);
  assert.equal(data.options[1].observations[0].image.width, 2);
  assert.notEqual(data.options[1].observations[0].observed_at, data.options[1].observations[1].observed_at);
});

test('per-option limit ends unchanged missing images after three reads without spending remaining budget', async t => {
  const f = await fixture(t, 2, raw => { raw.samples.forEach(sample => { sample.image.loaded = false; sample.image.width = 0; sample.image.height = 0; }); });
  const report = await f.read(), data = report.operations[0].image_collection;
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 3);
  assert.equal(data.collection.stop_reason, 'per_option_read_limit');
  assert.ok(data.missing_images.every(image => image.attempts === 3 && image.reason === 'image_not_loaded'));
});

test('over fifty image options retain the whole scanned label list and separately identify unread images', async t => {
  const f = await fixture(t, 61), report = await f.read(), data = report.operations[0].image_collection;
  assert.equal(f.reads(), 10); assert.equal(report.status, 'stopped');
  assert.equal(data.options.length, 61); assert.equal(data.coverage.loaded_image_links, 50);
  assert.equal(data.coverage.unread_image_options, 11);
  assert.ok(data.missing_images.every(image => image.reason === 'not_read' && image.attempts === 0));
});

test('successful early images survive a later gate and user recovery keeps the same accounting', async t => {
  const f = await fixture(t, 12, undefined, call => { if (call === 2) throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic'); });
  const paused = await f.read();
  assert.equal(paused.status, 'waiting_user'); assert.equal(f.reads(), 2);
  assert.equal(paused.operations[0].image_collection.coverage.loaded_image_links, 5);
  await assert.rejects(f.read(), { code: 'RECOVERY_REQUIRED' });
  const finished = await f.read({ recovery: 'user' });
  assert.equal(finished.status, 'complete'); assert.equal(finished.operations[0].attempts, 4);
  assert.equal(finished.automatic_retries, 0);
  assert.equal(finished.operations[0].result.options[5].attempts, 2);
});

test('transport failures share the original two retries across all batches and retain acquired images', async t => {
  const f = await fixture(t, 32, undefined, call => { if ([2, 4, 6].includes(call)) throw new ShoppingError('PAGE_LOADING', 'Synthetic'); });
  const report = await f.read();
  assert.equal(report.status, 'partial'); assert.equal(report.automatic_retries, 2);
  assert.equal(report.wait_reserved_ms, 20000); assert.equal(f.reads(), 6);
  assert.equal(report.operations[0].image_collection.coverage.loaded_image_links, 15);
});

test('inventory changes stop before merging or retrying a wrong option response', async t => {
  const f = await fixture(t, 12, (raw, call) => { if (call === 2) raw.inventory.groups[0].name = '另一组'; });
  const report = await f.read();
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'SPECIFICATION_IMAGE_INVENTORY_CHANGED');
  assert.equal(f.reads(), 2); assert.equal(report.automatic_retries, 0);
  assert.equal(report.operations[0].image_collection.inventory.groups[0].name, '颜色');
});

test('interrupted reservations count against per-option and total limits before a resumed read', async t => {
  const f = await fixture(t, 12, undefined, call => { if (call === 2) throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic'); });
  await f.read();
  const saved = JSON.parse(await readFile(f.filename));
  saved.status = 'running'; saved.operations[0].status = 'running'; saved.operations[0].error = null;
  await writeFile(f.filename, JSON.stringify(saved));
  const report = await f.read();
  assert.equal(report.status, 'complete'); assert.equal(report.automatic_retries, 1);
  assert.equal(report.wait_reserved_ms, 5000);
  assert.equal(report.operations[0].result.options[5].attempts, 2);
});

test('forged limits, reservations, results or source associations fail before IO', async t => {
  const f = await fixture(t, 2); await f.read();
  const original = JSON.parse(await readFile(f.filename));
  for (const mutate of [s => { s.operations[0].specification_collection.read_limit = 100; },
    s => { s.operations[0].specification_collection.per_option_read_limit = 10; },
    s => { s.operations[0].attempts = 0; },
    s => { s.operations[0].result.coverage.full_option_images = true; },
    s => { s.operations[0].specification_collection.reads[0].observation.samples[0].association.sku_id = '123'; }]) {
    const saved = structuredClone(original); mutate(saved); await writeFile(f.filename, JSON.stringify(saved));
    await assert.rejects(f.read(), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.reads(), 1);
});

test('text-only options are retained without inventing image absence or Cartesian SKU combinations', () => {
  const state = newSpecificationCollection(1), plan = reserveSpecificationCollectionRead(state);
  const raw = rawObservation(3, plan, 1);
  raw.inventory.groups[0].options[1].image_regions_seen = 0;
  raw.samples.splice(1, 1);
  acceptSpecificationCollectionRead(state, validateSpecificationCollectionObservation(raw, target), target);
  validateSpecificationCollection(state, target, 1);
  const result = specificationCollectionResult(state, target);
  assert.equal(result.options.length, 3);
  assert.equal(result.unsupported_image_options[0].position, 2);
  assert.equal(result.coverage.scanned_supported_image_links_complete, true);
  assert.equal(result.coverage.full_option_images, false);
  assert.equal(result.options[1].association.sku_id, null);
});

test('missing, ambiguous, unsupported and repeated image sources remain separate option observations', () => {
  const state = newSpecificationCollection(1), plan = reserveSpecificationCollectionRead(state);
  const raw = rawObservation(5, plan, 1);
  raw.samples[0].image_elements_seen = 0; raw.samples[0].image = null;
  raw.samples[1].image_elements_seen = 2; raw.samples[1].image = null;
  raw.samples[2].image.url = 'https://untrusted.invalid/private.png';
  raw.samples[4].image.url = raw.samples[3].image.url;
  acceptSpecificationCollectionRead(state, validateSpecificationCollectionObservation(raw, target), target);
  const result = specificationCollectionResult(state, target);
  assert.deepEqual(result.missing_images.map(image => image.reason), ['image_element_not_observed', 'ambiguous_image_elements', 'unsupported_image_url']);
  assert.equal(result.coverage.loaded_image_links, 2);
  assert.equal(result.options[3].image.url, result.options[4].image.url);
  assert.equal(result.options[2].image.url, null);
});

test('malformed or reordered samples cannot replace the reserved option owners', async t => {
  const f = await fixture(t, 12, (raw, call) => { if (call === 2) raw.samples.reverse(); });
  const report = await f.read();
  assert.equal(report.status, 'stopped'); assert.equal(report.operations[0].error.code, 'INVALID_RESPONSE');
  assert.equal(report.operations[0].image_collection.coverage.loaded_image_links, 5);
  assert.equal(f.reads(), 2);
});

test('repeated human recovery uses the same ten-read budget and never sends an eleventh read', async t => {
  const f = await fixture(t, 12, undefined, () => { throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic'); });
  assert.equal((await f.read()).status, 'waiting_user');
  for (let i = 0; i < 9; i++) assert.equal((await f.read({ recovery: 'user' })).status, 'waiting_user');
  assert.equal((await f.read({ recovery: 'user' })).status, 'stopped');
  assert.equal(f.reads(), 10);
});

test('structural truncation is never a complete inventory even when every supported image has been obtained', () => {
  const state = newSpecificationCollection(1), plan = reserveSpecificationCollectionRead(state);
  const raw = rawObservation(101, plan, 1);
  for (const option of raw.inventory.groups[0].options) if (option.position > 5) option.image_regions_seen = 0;
  acceptSpecificationCollectionRead(state, validateSpecificationCollectionObservation(raw, target), target);
  const result = specificationCollectionResult(state, target);
  assert.equal(result.options.length, 100);
  assert.equal(result.collection.next_read_available, false);
  assert.equal(result.collection.stop_reason, 'structure_scan_limit');
  assert.equal(result.coverage.options_omitted_in_scanned_groups, 1);
  assert.equal(result.coverage.scanned_inventory_complete, false);
});

test('a selected marker may change without rewriting the first observation or claiming current SKU identity', () => {
  const state = newSpecificationCollection(1);
  const raw = rawObservation(2, reserveSpecificationCollectionRead(state), 1);
  raw.samples[0].selected = true; raw.samples[0].image.width = 2;
  acceptSpecificationCollectionRead(state, validateSpecificationCollectionObservation(raw, target), target);
  const next = rawObservation(2, reserveSpecificationCollectionRead(state), 2);
  acceptSpecificationCollectionRead(state, validateSpecificationCollectionObservation(next, target), target);
  validateSpecificationCollection(state, target, 2);
  const result = specificationCollectionResult(state, target);
  assert.equal(result.options[0].observations[0].selected, true);
  assert.equal(result.options[0].observations[1].selected, null);
  assert.equal(result.coverage.cross_read_image_state_verified, false);
  assert.equal(result.options[0].association.sku_id, null);
});

function loadingAcknowledgement(raw, inView = false) {
  return { action: inView ? 'skipped' : 'scrolled', reason: inView ? 'already_in_view' : 'offscreen_tiny_image',
    geometry: { image_box: { x: 100, y: inView ? 200 : 1200, width: 32, height: 32 },
      viewport: { width: 1000, height: 800 }, clip_ancestors: 0,
      intersection: { width: 32, height: inView ? 32 : 0 }, fully_in_view: inView },
    action_observed_at: inView ? null : raw.observed_at };
}

function tinyImages(raw, call, plan) {
  for (const sample of raw.samples) { sample.image.width = 2; sample.image.height = 2; }
  if (plan.scroll) raw.loading = loadingAcknowledgement(raw);
}

test('new format 2 tasks collect normal images without reserving any scrolling', async t => {
  const f = await fixture(t, 32, undefined, undefined, 2), report = await f.read();
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 7);
  assert.equal(report.operations[0].result.schema_version, 2);
  assert.deepEqual(report.operations[0].result.collection.loading_actions, []);
  assert.ok(f.plans.every(plan => !plan.scroll));
});

test('a missing tiny image gets one persisted scroll guard followed by a separate paced read', async t => {
  const f = await fixture(t, 1, (raw, call, plan) => { if (call < 3) tinyImages(raw, call, plan); }, undefined, 2);
  const report = await f.read(), data = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 3);
  assert.ok(f.plans[1].scroll); assert.equal(f.plans[2].scroll, undefined); assert.equal(f.plans[2].after_scroll, 2);
  assert.deepEqual(f.waits, [1500, 1500]); assert.equal(data.options[0].attempts, 3);
  assert.deepEqual(data.options[0].observations.map(row => row.image.width), [2, 2, 800]);
  assert.equal(data.options[0].observations[1].source_timing, 'before_scroll');
  assert.equal(data.collection.loading_actions[0].after_read, 3);
  assert.equal(data.options[0].association.sku_id, null); assert.equal(data.coverage.sku_price_binding_verified, false);
  const before = await readFile(f.filename, 'utf8'); await f.read();
  assert.equal(await readFile(f.filename, 'utf8'), before); assert.equal(f.reads(), 3);
});

test('39 colors fit eight initial reads, one guard and a five-option follow-up in the unchanged ten-read budget', async t => {
  const f = await fixture(t, 39, (raw, call, plan) => {
    for (const sample of raw.samples) if (sample.position >= 13 && call < 10) { sample.image.width = 2; sample.image.height = 2; }
    if (plan.scroll) raw.loading = loadingAcknowledgement(raw);
  }, undefined, 2);
  const report = await f.read(), data = report.operations[0].image_collection;
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 10);
  assert.ok(f.plans.slice(0, 8).every(plan => !plan.scroll)); assert.ok(f.plans[8].scroll);
  assert.deepEqual(f.plans[9].positions.map(row => row.position), [13, 14, 15, 16, 17]);
  assert.equal(data.coverage.loaded_image_links, 17); assert.equal(data.missing_images.length, 22);
  assert.equal(data.options[12].attempts, 3); assert.equal(report.automatic_retries, 0);
});

test('already visible and unchanged tiny images stop after three reservations without repeating a scroll', async t => {
  const f = await fixture(t, 1, (raw, call, plan) => { tinyImages(raw, call, plan); if (plan.scroll) raw.loading = loadingAcknowledgement(raw, true); }, undefined, 2);
  const report = await f.read(), data = report.operations[0].image_collection;
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 3);
  assert.equal(data.collection.stop_reason, 'per_option_read_limit');
  assert.equal(data.collection.loading_actions[0].observation.action, 'skipped');
  assert.equal(data.options[0].image_status, 'tiny_image_unresolved');
});

test('a resource already loaded at the guard is retained without a scroll or an unnecessary follow-up', async t => {
  const f = await fixture(t, 1, (raw, call, plan) => {
    if (call === 1) tinyImages(raw, call, plan);
    if (plan.scroll) raw.loading = { action: 'skipped', reason: 'source_changed', geometry: null, action_observed_at: null };
  }, undefined, 2);
  const report = await f.read(); assert.equal(report.status, 'complete'); assert.equal(f.reads(), 2);
  assert.equal(report.operations[0].result.collection.loading_actions[0].after_read, null);
});

test('scrolling requires room for both its guard and a later read, and never displaces unread options', async t => {
  const f = await fixture(t, 44, tinyImages, undefined, 2), report = await f.read();
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 10);
  assert.ok(f.plans.every(plan => !plan.scroll));
  assert.equal(report.operations[0].image_collection.options.length, 44);
});

test('many missing options share two scroll intents and the original ten-read limit', async t => {
  const f = await fixture(t, 20, tinyImages, undefined, 2), report = await f.read();
  const actions = report.operations[0].image_collection.collection.loading_actions;
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 10); assert.equal(actions.length, 2);
  assert.equal(new Set(actions.map(row => row.position.position)).size, 2);
  assert.ok(report.operations[0].image_collection.options.every(row => row.attempts <= 3));
});

test('an uncertain scroll response uses the existing retry delay but resumes with a read only', async t => {
  const f = await fixture(t, 1, (raw, call, plan) => { if (call === 1) tinyImages(raw, call, plan); },
    call => { if (call === 2) throw new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic lost action reply'); }, 2);
  const report = await f.read(); assert.equal(report.status, 'complete'); assert.equal(report.automatic_retries, 1);
  assert.equal(report.wait_reserved_ms, 5000); assert.equal(f.plans.filter(plan => plan.scroll).length, 1);
  const action = report.operations[0].result.collection.loading_actions[0];
  assert.equal(action.acknowledgement, 'unconfirmed'); assert.equal(action.observation, null); assert.equal(action.after_read, 3);
});

test('verification at a scroll guard pauses and manual recovery cannot dispatch the same scroll again', async t => {
  const f = await fixture(t, 1, (raw, call, plan) => { if (call === 1) tinyImages(raw, call, plan); },
    call => { if (call === 2) throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic gate'); }, 2);
  assert.equal((await f.read()).status, 'waiting_user'); await assert.rejects(f.read(), { code: 'RECOVERY_REQUIRED' });
  const report = await f.read({ recovery: 'user' }); assert.equal(report.status, 'complete'); assert.equal(f.reads(), 3);
  assert.equal(f.plans.filter(plan => plan.scroll).length, 1); assert.equal(report.automatic_retries, 0);
});

test('forged loading limits, action sources and duplicate scroll reservations fail before IO', async t => {
  const f = await fixture(t, 1, (raw, call, plan) => { if (call < 3) tinyImages(raw, call, plan); }, undefined, 2);
  await f.read(); const original = JSON.parse(await readFile(f.filename));
  for (const mutate of [s => { s.scroll_limit = 3; }, s => { s.reads[1].scroll.expected_image.url = 'https://img.alicdn.com/wrong.jpg'; },
    s => { s.reads[2].scroll = s.reads[1].scroll; }, s => { s.reads[1].observation.loading.geometry.fully_in_view = true; }]) {
    const saved = structuredClone(original); mutate(saved.operations[0].specification_collection);
    await writeFile(f.filename, JSON.stringify(saved)); await assert.rejects(f.read(), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.reads(), 3);
});

for (const version of [2, 3]) test(`format ${version} real CLI persists a scroll before a killed process and resumes without replay`, async t => {
  const f = await fixture(t, 1, undefined, undefined, version);
  let signalScroll, scrollCalls = 0, reads = 0;
  const dispatched = new Promise(resolve => { signalScroll = resolve; });
  const mock = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 41, url: target.url }] } }));
    if (body.script.includes('scrollIntoView')) { scrollCalls++; signalScroll(); return; }
    const namesOnly = body.script.includes('\"inventory_only\":true');
    const raw = rawObservation(1, { positions: namesOnly ? [] : null }, ++reads);
    if (reads === (version === 3 ? 2 : 1)) tinyImages(raw, 1, {});
    res.end(JSON.stringify({ id: body.id, success: true, data: { result: raw } }));
  } });
  const task = JSON.parse(await readFile(f.filename)); task.endpoint = mock.endpoint; await writeFile(f.filename, JSON.stringify(task));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url)),
    'task-run', '--task', 'collection', '--state-dir', f.options.stateDirectory, '--endpoint', mock.endpoint], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([dispatched, once(child, 'exit').then(() => { throw Error('CLI exited before scroll'); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('No scroll dispatched')), 10000); timer.unref(); })]);
  const reserved = JSON.parse(await readFile(f.filename));
  assert.equal(reserved.operations[0].attempts, version === 3 ? 3 : 2); assert.ok(reserved.operations[0].specification_collection.reads.at(-1).scroll);
  assert.equal(reserved.operations[0].specification_collection.reads.at(-1).observation, null);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  let now = Date.now() + 20000;
  const report = await runTask({ ...f.options, bridge: new BrowserBridge(mock.endpoint) }, { now: () => now, wait: async ms => { now += ms; } });
  assert.equal(report.status, 'complete'); assert.equal(scrollCalls, 1); assert.equal(reads, version === 3 ? 3 : 2);
  assert.equal(report.automatic_retries, 1); assert.equal(report.wait_reserved_ms, 5000);
  assert.equal(report.operations[0].result.collection.loading_actions[0].acknowledgement, 'unconfirmed');
});

test('format 3 saves names before image IO and obtains all 61 images beyond ten content reads', async t => {
  const f = await fixture(t, 61, undefined, undefined, 3), report = await f.read();
  const data = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 14);
  assert.deepEqual(f.plans[0], { inventory: null, positions: [], inventory_only: true });
  assert.equal(data.schema_version, 3); assert.equal(data.options.length, 61);
  assert.ok(data.options.every(option => option.attempts === 1 && option.observations.length === 1));
  assert.equal(data.coverage.loaded_image_links, 61);
  assert.equal(data.collection.inventory_reads_reserved, 1); assert.equal(data.collection.image_reads_reserved, 13);
  assert.equal(data.collection.limits.content_reads, 186); assert.equal(data.collection.limits.scroll_intents, 61);
  assert.equal(data.collection.budget_basis.image_options, 61); assert.equal(data.collection.budget_basis.finalized, true);
  assert.equal(data.inventory_observed_at, '2026-09-29T01:00:01.000Z');
  assert.ok(data.options.every(option => option.observations[0].observed_at > data.inventory_observed_at));
  const before = await readFile(f.filename, 'utf8'); await f.read();
  assert.equal(await readFile(f.filename, 'utf8'), before); assert.equal(f.reads(), 14);
});

test('39 tiny images each get an independent guard and last read, with no unused sibling charged', async t => {
  const f = await fixture(t, 39, tinyImages, undefined, 3), report = await f.read();
  const data = report.operations[0].image_collection;
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 87);
  assert.equal(data.collection.stop_reason, 'per_option_read_limit');
  assert.equal(data.collection.loading_actions.length, 39);
  assert.ok(f.plans.slice(0, 9).every(plan => !plan.scroll));
  assert.equal(f.plans[9].positions[0].position, 1);
  assert.ok(f.plans.filter(plan => plan.after_scroll).every(plan => plan.positions.length === 1));
  assert.ok(data.options.every(option => option.attempts === 3));
  assert.equal(data.coverage.unread_image_options, 0); assert.equal(report.automatic_retries, 0);
  const before = await readFile(f.filename, 'utf8'); await f.read();
  assert.equal(await readFile(f.filename, 'utf8'), before); assert.equal(f.reads(), 87);
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});

test('resolved links stop early while each remaining tiny image can load on its own final read', async t => {
  const f = await fixture(t, 14, (raw, call, plan) => {
    if (!plan.after_scroll) for (const sample of raw.samples) if (sample.position > 3) {
      sample.image.width = 2; sample.image.height = 2;
    }
    if (plan.scroll) raw.loading = loadingAcknowledgement(raw);
  }, undefined, 3);
  const report = await f.read(), data = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 26);
  assert.ok(data.options.slice(0, 3).every(option => option.attempts === 1));
  assert.ok(data.options.slice(3).every(option => option.attempts === 3 && option.image.width === 800));
  assert.equal(data.collection.loading_actions.length, 11);
});

test('names remain available and uncharged when the first image read pauses for verification', async t => {
  const f = await fixture(t, 7, undefined, call => { if (call === 2) throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic gate'); }, 3);
  const paused = await f.read(), data = paused.operations[0].image_collection;
  assert.equal(paused.status, 'waiting_user'); assert.equal(data.options.length, 7);
  assert.deepEqual(data.options.map(option => option.attempts), [1, 1, 1, 1, 1, 0, 0]);
  await assert.rejects(f.read(), { code: 'RECOVERY_REQUIRED' }); assert.equal(f.reads(), 2);
  const report = await f.read({ recovery: 'user' }); assert.equal(report.status, 'complete');
  assert.deepEqual(f.plans[2].positions.map(row => row.position), [6, 7]);
  assert.equal(report.operations[0].result.collection.inventory_reads_reserved, 1);
});

test('inventory failure consumes its own allowance without using any option image attempt', async t => {
  const f = await fixture(t, 6, undefined, call => { if (call === 1) throw new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic inventory failure'); }, 3);
  const report = await f.read(), data = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(report.automatic_retries, 1); assert.equal(report.wait_reserved_ms, 5000);
  assert.equal(data.collection.inventory_reads_reserved, 2); assert.equal(data.collection.image_reads_reserved, 2);
  assert.ok(data.options.every(option => option.attempts === 1));
  assert.equal(data.collection.limits.content_reads, 21);
});

test('three unanswered inventory reservations stop without resetting on user recovery', async t => {
  const f = await fixture(t, 6, undefined, () => { throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic gate'); }, 3);
  assert.equal((await f.read()).status, 'waiting_user');
  assert.equal((await f.read({ recovery: 'user' })).status, 'waiting_user');
  assert.equal((await f.read({ recovery: 'user' })).status, 'waiting_user');
  const report = await f.read({ recovery: 'user' }), data = report.operations[0].image_collection;
  assert.equal(report.status, 'stopped'); assert.equal(f.reads(), 3);
  assert.equal(data.collection.stop_reason, 'inventory_read_limit');
  assert.equal(data.collection.budget_basis.finalized, false); assert.equal(data.options.length, 0);
  assert.equal(data.collection.image_reads_reserved, 0); assert.equal(report.automatic_retries, 0);
});

test('the shared fault budget still stops many-option work even with available per-option reads', async t => {
  const f = await fixture(t, 20, undefined, call => { if ([2, 4, 6].includes(call)) throw new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic failure'); }, 3);
  const report = await f.read(), data = report.operations[0].image_collection;
  assert.equal(report.status, 'partial'); assert.equal(f.reads(), 6);
  assert.equal(report.operations[0].error.code, 'OPERATION_RETRY_LIMIT');
  assert.equal(report.automatic_retries, 2); assert.equal(report.wait_reserved_ms, 20000);
  assert.equal(data.collection.inventory_reads_reserved, 1);
  assert.ok(data.options.every(option => option.attempts <= 3));
});

test('an uncertain format 3 loading action resumes read-only within that option three-read allowance', async t => {
  const f = await fixture(t, 1, (raw, call, plan) => { if (call === 2) tinyImages(raw, call, plan); },
    call => { if (call === 3) throw new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic lost scroll reply'); }, 3);
  const report = await f.read(), data = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 4); assert.equal(data.options[0].attempts, 3);
  assert.equal(data.collection.loading_actions.length, 1); assert.equal(data.collection.loading_actions[0].acknowledgement, 'unconfirmed');
  assert.equal(data.collection.loading_actions[0].after_read, 4); assert.equal(f.plans[3].scroll, undefined);
});

test('text-only options need only the independent name inventory and no image read or scroll allowance', async t => {
  const f = await fixture(t, 8, raw => { for (const option of raw.inventory.groups[0].options) option.image_regions_seen = 0; }, undefined, 3);
  const report = await f.read(), data = report.operations[0].result;
  assert.equal(report.status, 'complete'); assert.equal(f.reads(), 1);
  assert.equal(data.options.length, 8); assert.ok(data.options.every(option => option.attempts === 0));
  assert.equal(data.collection.limits.content_reads, 3); assert.equal(data.collection.limits.scroll_intents, 0);
  assert.equal(data.coverage.full_option_images, false); assert.equal(data.unsupported_image_options.length, 8);
});

test('format 3 derives limits across groups and reports structural omissions without claiming all names', () => {
  const state = newSpecificationCollection();
  const raw = rawObservation(101, reserveSpecificationCollectionRead(state), 1);
  raw.inventory.groups_seen = 2;
  raw.inventory.groups.push({ position: 2, name: '尺码', options_seen: 2,
    options: [{ position: 1, label: 'M', image_regions_seen: 0 }, { position: 2, label: 'L', image_regions_seen: 0 }] });
  acceptSpecificationCollectionRead(state, validateSpecificationCollectionObservation(raw, target), target);
  assert.equal(state.read_limit, 303); assert.equal(state.scroll_limit, 100);
  validateSpecificationCollection(state, target, 1);
  const data = specificationCollectionResult(state, target);
  assert.equal(data.options.length, 102); assert.equal(data.coverage.options_omitted_in_scanned_groups, 1);
  assert.equal(data.coverage.scanned_inventory_complete, false);
  assert.ok(data.options.every(option => option.attempts === 0));
});

test('forged format 3 derived limits, name reservations and image counts fail before IO', async t => {
  const f = await fixture(t, 1, undefined, undefined, 3); await f.read();
  const original = JSON.parse(await readFile(f.filename));
  for (const mutate of [s => { s.read_limit++; }, s => { s.scroll_limit++; }, s => { s.inventory_read_limit++; },
    s => { s.per_option_read_limit = 4; }, s => { delete s.reads[0].inventory_only; },
    s => { s.reads[0].positions = [{ group_position: 1, position: 1 }]; },
    s => { s.inventory.groups[0].options[0].image_regions_seen = 0; }]) {
    const saved = structuredClone(original); mutate(saved.operations[0].specification_collection);
    await writeFile(f.filename, JSON.stringify(saved)); await assert.rejects(f.read(), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(f.reads(), 2);
});

test('large inventories persist more than 1000 reservations and a result above the legacy checkpoint size', async t => {
  const f = await fixture(t, 1, undefined, undefined, 3);
  const state = newSpecificationCollection();
  const inventory = { groups_seen: 5, groups: Array.from({ length: 5 }, (_, group) => ({
    position: group + 1, name: `组${group + 1}`, options_seen: 100,
    options: Array.from({ length: 100 }, (_, option) => ({ position: option + 1, label: `选项${option + 1}`, image_regions_seen: 1 })) })) };
  const url = `https://img.alicdn.com/${'x'.repeat(1750)}.jpg`;
  while (specificationCollectionPlan(state)) {
    const plan = reserveSpecificationCollectionRead(state);
    const raw = { state: 'observed', product_id: target.product_id, url: target.url,
      observed_at: new Date(Date.UTC(2026, 8, 29, 2, 0, state.reads.length)).toISOString(), inventory,
      samples: plan.positions.map(({ group_position, position }) => ({ group_position, position, label: `选项${position}`,
        selected: null, disabled: null, image_regions_seen: 1, image_elements_seen: 1,
        image: { url, loaded: true, width: plan.after_scroll ? 800 : 2, height: plan.after_scroll ? 800 : 2 } })) };
    if (plan.scroll) raw.loading = loadingAcknowledgement(raw);
    acceptSpecificationCollectionRead(state, validateSpecificationCollectionObservation(raw, target), target);
  }
  assert.equal(state.reads.length, 1101); assert.equal(state.read_limit, 1503);
  const data = specificationCollectionResult(state, target);
  assert.ok(data.options.every(option => option.attempts === 3)); assert.equal(data.coverage.loaded_image_links, 500);
  const task = JSON.parse(await readFile(f.filename));
  Object.assign(task.operations[0], { attempts: state.reads.length, specification_collection: state, result: data, status: 'succeeded' });
  task.status = 'complete';
  const serialized = JSON.stringify(task, null, 2) + '\n';
  assert.ok(Buffer.byteLength(serialized) > 4194304); assert.ok(Buffer.byteLength(serialized) < 33554432);
  validateTask(task);
  await writeFile(f.filename, serialized);
  assert.equal((await loadTask(f.options.stateDirectory, 'collection')).operations[0].attempts, 1101);
  const before = await readFile(f.filename, 'utf8');
  assert.equal((await f.read()).status, 'complete'); assert.equal(f.reads(), 0);
  assert.equal(await readFile(f.filename, 'utf8'), before);
});

test('the format 3 safety ceiling derives from at most 800 scanned image options', () => {
  const state = newSpecificationCollection(), plan = reserveSpecificationCollectionRead(state);
  const raw = rawObservation(100, plan, 1);
  raw.inventory.groups_seen = 8;
  raw.inventory.groups = Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(raw.inventory.groups[0]), position: index + 1, name: `组${index + 1}` }));
  acceptSpecificationCollectionRead(state, validateSpecificationCollectionObservation(raw, target), target);
  assert.equal(state.read_limit, 2403); assert.equal(state.scroll_limit, 800);
  validateSpecificationCollection(state, target, 1);
  assert.equal(specificationCollectionResult(state, target).options.length, 800);
});
