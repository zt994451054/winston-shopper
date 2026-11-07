import { recordPausedDisplay, assertPausedDisplays } from '../test-support/paused-display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask, taskStatus, rebindTask } from '../lib/tasks.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { searchTarget } from '../lib/search.mjs';
import { rawSearch, rawReviews } from '../test-support/search-review-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

async function fixture(t, kind, { loseAcknowledgement = false, gated = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping reading actions ')), displays = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = kind === 'search' ? searchTarget('Synthetic mouse') : parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  let dispatched = false, actionCount = 0, readCount = 0, gate = gated, activeTab = 41, resolveDispatched;
  const dispatch = new Promise(resolve => { resolveDispatched = resolve; });
  const server = await mockBridge(t, { async handler({ req, res, body }) {
    const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_show') return send({ id: body.id, success: true, data: await recordPausedDisplay(body, root, 'round', displays) });
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: activeTab,
      url: kind === 'search' && !dispatched ? 'https://www.taobao.com/' : target.url }] } });
    if (body.tabId !== activeTab) return reply({ state: 'target_changed' });
    if (body.script.includes(`}, true, (`)) {
      if (gate) return reply({ state: gate });
      actionCount += 1; dispatched = true;
      if (loseAcknowledgement) req.socket.destroy();
      else reply({ state: 'action_dispatched', clicked: true });
      resolveDispatched(); return;
    }
    readCount += 1;
    if (gate) return reply({ state: gate });
    reply(dispatched ? (kind === 'search' ? rawSearch(target) : rawReviews(target)) : { state: 'action_required' });
  } });
  const bridge = new BrowserBridge(server.endpoint);
  const options = { stateDirectory: root, task: 'round', bridge,
    ...(kind === 'search' ? { search: target.query, tabId: 41 } : { bindings: ['sample'], reviews: true }) };
  if (kind !== 'search') await saveBinding(root, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint,
    tab_id: 41, target, created_at: new Date().toISOString() });
  await createTask(options);
  let time = Date.now();
  return { options, root, dispatch, target, displays, clock: { now: () => time, wait: async ms => { time += ms; } },
    actions: () => actionCount, reads: () => readCount, setGate: value => { gate = value; },
    moveTab: () => { activeTab = 42; dispatched = true; } };
}

test('offscreen review content stops once and retains its read reservation without expansion or automatic retry', async t => {
  const f = await fixture(t, 'product_reviews', { gated: 'review_drawer_not_visible' });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(result.operations[0].error.code, 'REVIEW_DRAWER_NOT_VISIBLE');
  assert.equal(result.automatic_retries, 0);
  assert.equal(f.reads(), 1);
  assert.equal(f.actions(), 0);
  assertPausedDisplays(f.displays, []);
  const checkpoint = await readFile(path.join(f.root, 'tasks/round.json'));
  const saved = JSON.parse(checkpoint);
  assert.equal(saved.operations[0].read_action.observations, 1);
  assert.equal(saved.operations[0].read_action.action_reserved, false);
  f.setGate(false);
  await runTask(f.options, f.clock);
  assert.equal(f.reads(), 1);
  assert.equal(f.actions(), 0);
  assert.deepEqual(await readFile(path.join(f.root, 'tasks/round.json')), checkpoint);
});

for (const kind of ['search', 'product_reviews']) {
  test(`${kind}: lost action reply returns validated results, cache never reruns the action`, async t => {
    const f = await fixture(t, kind, { loseAcknowledgement: true });
    const result = await runTask(f.options, f.clock);
    assert.equal(result.status, 'complete');
    assert.equal(f.actions(), 1);
    assertPausedDisplays(f.displays, []);
    assert.equal(result.operations[0].result.action_evidence.actions_reserved, 1);
    assert.equal((await taskStatus(f.options)).status, 'complete');
    const reads = f.reads();
    await runTask(f.options, f.clock);
    assert.equal(f.reads(), reads);
    assert.equal(f.actions(), 1);
  });

  test(`${kind}: killing CLI after dispatch preserves intent and counts on recovery`, { timeout: 15000 }, async t => {
    const f = await fixture(t, kind);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url)),
      'task-run', '--task', 'round', '--state-dir', f.root, '--endpoint', f.options.bridge.endpoint], { stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await Promise.race([f.dispatch, once(child, 'exit').then(() => { throw new Error('CLI exited before dispatch'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const result = await runTask(f.options, f.clock);
    assert.equal(result.status, 'complete');
    assert.equal(result.operations[0].attempts, 2);
    assert.equal(result.automatic_retries, 1);
    assert.equal(f.actions(), 1);
  });

  test(`${kind}: verification pauses before action; resuming still respects the same journal`, async t => {
    const f = await fixture(t, kind, { gated: 'verification_required' });
    assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user');
    const expectedDisplay = [{ tabId: 41, status: 'waiting_user', code: 'VERIFICATION_REQUIRED' }];
    assertPausedDisplays(f.displays, expectedDisplay);
    assert.equal(f.actions(), 0);
    await assert.rejects(createTask({ ...f.options, task: 'bypass' }), { code: 'PLATFORM_TASK_UNFINISHED' });
    f.setGate(false);
    assert.equal((await runTask({ ...f.options, recovery: 'user' }, f.clock)).status, 'complete');
    assert.equal(f.actions(), 1);
    assertPausedDisplays(f.displays, expectedDisplay);
  });

  test(`${kind}: tampered journals and cached extra fields fail before browser access`, async t => {
    const f = await fixture(t, kind);
    const filename = path.join(f.root, 'tasks/round.json');
    const original = await readFile(filename, 'utf8');
    const bad = JSON.parse(original); bad.operations[0].read_action.observations = 100;
    await writeFile(filename, JSON.stringify(bad));
    await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
    assert.equal(f.reads(), 0);
    await writeFile(filename, original);
    await runTask(f.options, f.clock);
    const saved = JSON.parse(await readFile(filename, 'utf8')); saved.operations[0].result.token = 'PRIVATE';
    await writeFile(filename, JSON.stringify(saved));
    await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
  });
}

test('search reattachment accepts only the same query and keeps its action reservation', async t => {
  const f = await fixture(t, 'search');
  f.moveTab();
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_connection');
  await rebindTask({ ...f.options, tabId: 42 });
  const result = await runTask({ ...f.options, recovery: 'connection' }, f.clock);
  assert.equal(result.status, 'complete');
  assert.equal(result.operations[0].attempts, 2);
  assert.equal(f.actions(), 0);
});

test('search frequency gate shares the platform stop and grants no automatic navigation', async t => {
  const f = await fixture(t, 'search', { gated: 'rate_limited' });
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_cooldown');
  const firstDisplay = { tabId: 41, status: 'waiting_cooldown', code: 'RATE_LIMITED' };
  assertPausedDisplays(f.displays, [firstDisplay]);
  assert.equal((await runTask({ ...f.options, recovery: 'cooldown' }, f.clock)).status, 'stopped');
  assert.equal(f.actions(), 0);
  assert.equal(f.reads(), 2);
  assertPausedDisplays(f.displays, [firstDisplay, { tabId: 41, status: 'stopped', code: 'RATE_LIMITED' }]);
});
