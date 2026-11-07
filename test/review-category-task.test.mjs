import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { loadReviewCategoryPlan } from '../lib/review-category-plan.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { rawReviewCategories, reviewCategoryObservation } from '../test-support/review-category-fixture.mjs';
import { validateReviewCategoryObservation } from '../lib/review-categories.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const fail = code => { throw new ShoppingError(code, 'Synthetic category failure'); };

async function fixture(t, settings = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping category '));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.now(), reads = 0, actions = 0, openings = 0, cleanups = 0, closings = 0, selected = '全部';
  const clock = { now: () => time, wait: async ms => { time += ms; } };
  const bridge = { endpoint: 'http://127.0.0.1:19824',
    async readReviewPanelState() {
      cleanups++;
      const saved = await loadTask(root, 'categories');
      assert.equal(saved.operations[0].category_read.panel_lifecycle.observations, cleanups);
      return settings.cleanupRead ? settings.cleanupRead(cleanups) : { state: closings ? 'closed' : 'open' };
    },
    async closeReviewPanel() {
      const saved = await loadTask(root, 'categories');
      assert.equal(saved.operations[0].category_read.panel_lifecycle.action_reserved, true);
      closings++; return { clicked: true };
    },
    async openReviewPanel() {
      const saved = await loadTask(root, 'categories');
      assert.equal(saved.operations[0].category_read.panel.action_reserved, true);
      openings++; return settings.open?.() ?? { clicked: true };
    },
    async readReviewCategories() {
      reads++;
      return settings.read ? settings.read(reads, selected) : reviewCategoryObservation(target, selected);
    },
    async selectReviewCategory(_tab, _target, _before, label) {
      actions++;
      const saved = await loadTask(root, 'categories');
      const step = saved.operations[0].category_read.steps.find(step => !step.after);
      assert.equal(step.action_reserved, true); assert.equal(step.requested, label);
      selected = label;
      return settings.act?.() ?? { clicked: true };
    } };
  await saveBinding(root, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint,
    tab_id: 41, target, created_at: new Date(time).toISOString() });
  const planFile = path.join(root, 'categories-plan.json');
  await writeFile(planFile, JSON.stringify(settings.plan ?? ['全部', '追评']));
  const options = { stateDirectory: root, task: 'categories', bindings: ['sample'], reviewCategories: planFile, bridge };
  await createTask(options);
  return { root, planFile, options, clock, reads: () => reads, actions: () => actions, openings: () => openings,
    cleanups: () => cleanups, closings: () => closings,
    filename: path.join(root, 'tasks/categories.json') };
}

test('category tasks persist intent before IO and return immutable cached text samples', async t => {
  const f = await fixture(t), result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(f.reads(), 5); assert.equal(f.actions(), 1);
  assert.equal(result.operations[0].result.samples[1].reviews.schema_version, 4);
  const saved = await readFile(f.filename);
  await runTask(f.options, f.clock); await taskStatus(f.options);
  assert.equal(f.reads(), 5); assert.deepEqual(await readFile(f.filename), saved);
  const tampered = JSON.parse(saved); tampered.operations[0].result.coverage.unique_review_count = 4;
  await writeFile(f.filename, JSON.stringify(tampered));
  await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  assert.equal(f.reads(), 5);
});

test('new category tasks persist panel ownership, close and confirmations before returning complete', async t => {
  const f = await fixture(t, { plan: [null], read: count => count === 1 ? { state: 'panel_action_required' } : reviewCategoryObservation(target) });
  const report = await runTask(f.options, f.clock), op = report.operations[0];
  assert.equal(report.status, 'complete'); assert.equal(f.closings(), 1); assert.equal(f.cleanups(), 3);
  assert.equal(op.total_dom_observations_reserved, 6); assert.equal(op.dom_observations_reserved, 3);
  assert.equal(op.panel_lifecycle.status, 'closed_confirmed');
  const saved = await readFile(f.filename); await runTask(f.options, f.clock);
  assert.deepEqual(await readFile(f.filename), saved); assert.equal(f.closings(), 1); assert.equal(f.cleanups(), 3);
});

test('cleanup verification pauses with saved text and cannot replay the close on recovery', async t => {
  const f = await fixture(t, { plan: [null], read: count => count === 1 ? { state: 'panel_action_required' } : reviewCategoryObservation(target),
    cleanupRead: count => count === 1 ? { state: 'open' } : count === 2 ? fail('VERIFICATION_REQUIRED') : { state: 'closed' } });
  const paused = await runTask(f.options, f.clock);
  assert.equal(paused.status, 'waiting_user'); assert.equal(paused.operations[0].partial_category_samples.length, 1);
  assert.equal(paused.operations[0].panel_lifecycle.last_read_error, 'VERIFICATION_REQUIRED');
  const result = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'REVIEW_PANEL_CLEANUP_UNCONFIRMED');
  assert.equal(f.closings(), 1); assert.equal(f.cleanups(), 3); assert.equal(f.reads(), 3);
  assert.equal(result.operations[0].partial_category_samples.length, 1);
});

test('offscreen panels stop once, retain their read and prevent replacement tasks', async t => {
  const f = await fixture(t, { read: () => fail('REVIEW_DRAWER_NOT_VISIBLE') });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.automatic_retries, 0);
  assert.equal(result.operations[0].dom_observations_reserved, 1); assert.equal(f.actions(), 0);
  await runTask(f.options, f.clock); assert.equal(f.reads(), 1);
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});

test('an overlapping category retains the confirmed sample and stops without relabelling or replay', async t => {
  const f = await fixture(t, { plan: ['全部', '图/视频'], read: (_count, selected) => {
    const raw = rawReviewCategories(target, '全部', 'Shared text');
    raw.categories = ['全部', '图/视频', '追评'].map((label, index) => ({ position: index + 1, label,
      count_text: ['', '2', '0'][index], selected: label === selected, disabled: false, in_viewport: true }));
    raw.reviews.fold_notice_text = '已折叠253条对你帮助不大的评价';
    return validateReviewCategoryObservation(raw, target);
  } });
  const result = await runTask(f.options, f.clock), op = result.operations[0];
  assert.equal(result.status, 'stopped'); assert.equal(op.error.code, 'REVIEW_CATEGORY_OUTCOME_UNKNOWN');
  assert.equal(result.automatic_retries, 0); assert.equal(f.actions(), 1); assert.equal(f.reads(), 6);
  assert.equal(op.result, null); assert.equal(op.partial_category_samples.length, 1);
  const sample = op.partial_category_samples[0];
  assert.equal(sample.category, '全部'); assert.equal(sample.snapshot.reviews.returned_count, 2);
  assert.equal(sample.snapshot.reviews.media_read, false);
  assert.equal(sample.snapshot.reviews.fold_notice_text, '已折叠253条对你帮助不大的评价');
  const unconfirmed = op.unconfirmed_category_observations;
  assert.equal(unconfirmed.length, 1); assert.equal(unconfirmed[0].requested_category, '图/视频');
  assert.equal(unconfirmed[0].selected_category_observed, '图/视频');
  assert.equal(unconfirmed[0].snapshot.reviews.returned_count, 2);
  assert.equal(unconfirmed[0].association.category_ui_verified, false);
  assert.deepEqual(unconfirmed[0].association.reasons, ['text_unchanged_after_switch']);
  assert.equal(unconfirmed[0].read_index, 6); assert.equal(unconfirmed[0].observation_is_latest_read, true);
  const saved = await readFile(f.filename), journal = JSON.parse(saved).operations[0].category_read;
  assert.equal(journal.steps[1].checks, 3); assert.equal(journal.steps[1].candidate, null);
  assert.equal(journal.steps[1].after, null);
  const cached = await runTask(f.options, f.clock);
  assert.deepEqual(cached, result); assert.deepEqual(await readFile(f.filename), saved);
  assert.equal(f.actions(), 1); assert.equal(f.reads(), 6);
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});

test('legacy stopped category tasks retain the exact old report and checkpoint without observation backfill', async t => {
  const f = await fixture(t, { read: () => fail('REVIEW_DRAWER_NOT_VISIBLE') });
  const original = JSON.parse(await readFile(f.filename));
  delete original.operations[0].category_read.observation_delivery;
  delete original.operations[0].category_read.panel_lifecycle;
  await writeFile(f.filename, JSON.stringify(original));
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(f.reads(), 1);
  assert.equal(Object.hasOwn(result.operations[0], 'unconfirmed_category_observations'), false);
  const saved = await readFile(f.filename);
  assert.equal(Object.hasOwn(JSON.parse(saved).operations[0].category_read, 'observation_delivery'), false);
  assert.deepEqual(await taskStatus(f.options), result);
  assert.deepEqual(await runTask(f.options, f.clock), result);
  assert.deepEqual(await readFile(f.filename), saved); assert.equal(f.reads(), 1);
});

test('category tasks automatically open the verified entry once with a durable journal', async t => {
  const f = await fixture(t, { plan: [null], read: count => count === 1
    ? { state: 'panel_action_required' } : reviewCategoryObservation(target), open: () => fail('BRIDGE_TIMEOUT') });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(f.openings(), 1); assert.equal(f.reads(), 3);
  assert.equal(result.operations[0].panel_actions_reserved, 1);
  assert.equal(result.operations[0].result.action_evidence.panel.acknowledgement_error, 'BRIDGE_TIMEOUT');
  const saved = await readFile(f.filename); await runTask(f.options, f.clock);
  assert.equal(f.openings(), 1); assert.deepEqual(await readFile(f.filename), saved);
});

test('category gates pause immediately after dispatch while partial samples and intent survive recovery', async t => {
  for (const [code, status, recovery] of [['VERIFICATION_REQUIRED', 'waiting_user', 'user'], ['RATE_LIMITED', 'waiting_cooldown', 'cooldown']]) {
    const f = await fixture(t, { act: () => fail(code) });
    const paused = await runTask(f.options, f.clock);
    assert.equal(paused.status, status); assert.equal(f.reads(), 3); assert.equal(f.actions(), 1);
    assert.equal(paused.operations[0].partial_category_samples[0].category, '全部');
    await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' }); assert.equal(f.reads(), 3);
    const result = await runTask({ ...f.options, recovery }, f.clock);
    assert.equal(result.status, 'complete'); assert.equal(f.actions(), 1); assert.equal(f.reads(), 5);
    assert.equal(result.operations[0].result.action_evidence.categories[1].acknowledgement_error, code);
  }
});

test('a failed read breaks consecutive category confirmation and retains the original retry budget', async t => {
  const f = await fixture(t, { plan: ['追评'], read: (count, selected) =>
    count === 3 ? fail('BRIDGE_TIMEOUT') : reviewCategoryObservation(target, selected) });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(f.reads(), 5); assert.equal(f.actions(), 1);
  assert.equal(result.automatic_retries, 1); assert.equal(result.wait_reserved_ms, 5000);
  assert.equal(result.operations[0].dom_observations_reserved, 5);
});

test('repeated category read failures stop at the existing two retries, without actions', async t => {
  const f = await fixture(t, { read: () => fail('BRIDGE_TIMEOUT') });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'partial'); assert.equal(result.automatic_retries, 2);
  assert.equal(result.wait_reserved_ms, 20000); assert.equal(f.reads(), 3); assert.equal(f.actions(), 0);
});

test('unknown category command errors retain intent and stop instead of being swallowed', async t => {
  const f = await fixture(t, { plan: ['追评'], act: () => fail('INVALID_RESPONSE') });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped'); assert.equal(result.operations[0].error.code, 'INVALID_RESPONSE');
  assert.equal(f.reads(), 1); assert.equal(f.actions(), 1);
});

test('category plans reject malformed, oversized and linked files before browser access', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'invalid.json');
  for (const body of ['{', '["全部","全部"]', '[null,"全部"]', ' '.repeat(8193)]) {
    await writeFile(filename, body);
    await assert.rejects(loadReviewCategoryPlan(filename), { code: 'INVALID_REVIEW_CATEGORIES' });
  }
  const linked = path.join(f.root, 'linked.json'); await symlink(f.planFile, linked);
  for (const name of [linked, f.root, path.join(f.root, 'missing.json')]) {
    await assert.rejects(loadReviewCategoryPlan(name), { code: 'INVALID_REVIEW_CATEGORIES' });
  }
  assert.equal(f.reads(), 0);
});

test('category CLI bounds input to one product and runs the current text category without clicks', async t => {
  const f = await fixture(t); await runTask(f.options, f.clock);
  const mock = await mockBridge(t);
  await saveBinding(f.root, 'cli', { schema_version: 1, platform: 'taobao', endpoint: mock.endpoint,
    tab_id: 41, target, created_at: new Date().toISOString() });
  const run = async args => { let output = ''; await main(args, { write: part => { output += part; } }); return JSON.parse(output); };
  const common = ['--endpoint', mock.endpoint, '--state-dir', f.root, '--task', 'cli', '--review-categories', f.planFile];
  for (const extra of [['--details'], ['--reviews'], ['--services'], ['--plan', 'missing.json'], ['--search', 'mouse', '--tab', '41']]) {
    assert.equal((await run(['task-start', ...common, '--bindings', 'cli', ...extra])).error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal((await run(['task-start', ...common, '--bindings', 'cli,cli'])).error.code, 'INVALID_BINDINGS');
  assert.equal(mock.state.commands.length, 0);
  await writeFile(f.planFile, '[null]'); mock.state.metadata = rawReviewCategories(target);
  assert.equal((await run(['task-start', ...common, '--bindings', 'cli'])).task_kind, 'product_review_categories');
  const result = await run(['task-run', '--endpoint', mock.endpoint, '--state-dir', f.root, '--task', 'cli']);
  assert.equal(result.status, 'complete'); assert.equal(result.operations[0].actions_reserved, 0);
  assert.equal(result.operations[0].result.samples[0].category, '全部');
  assert.equal(mock.state.commands.filter(command => command.action === 'eval').length, 2);
});

test('killing category CLI after dispatch resumes with reads and never repeats the click', { timeout: 15000 }, async t => {
  const f = await fixture(t, { plan: ['追评'] });
  let selected = '全部', actions = 0, resolveDispatch;
  const dispatched = new Promise(resolve => { resolveDispatch = resolve; });
  const mock = await mockBridge(t, { handler: ({ req, res, body }) => {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: 41, url: target.url }] } });
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (body.script.includes('"list_key":')) {
      selected = '追评'; actions++; reply({ state: 'action_dispatched', clicked: true }); resolveDispatch();
    } else reply(rawReviewCategories(target, selected));
  } });
  const saved = JSON.parse(await readFile(f.filename, 'utf8')); saved.endpoint = mock.endpoint;
  await writeFile(f.filename, JSON.stringify(saved));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url)),
    'task-run', '--task', 'categories', '--state-dir', f.root, '--endpoint', mock.endpoint], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([dispatched, once(child, 'exit').then(() => { throw new Error('CLI exited before category dispatch'); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const result = await runTask({ ...f.options, bridge: new BrowserBridge(mock.endpoint) }, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(actions, 1);
  assert.equal(result.operations[0].attempts, 2); assert.equal(result.automatic_retries, 1);
  assert.equal(result.wait_reserved_ms, 5000);
});
