import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask, rebindTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask, withTaskStore } from '../lib/task-store.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { main } from '../lib/cli.mjs';
import { searchTarget, searchPageTarget, parseSearchUrl, parseSearchPageUrl } from '../lib/search.mjs';
import { validateSearchPage, newSearchPagesState, runSearchPages, validateSearchPagesState } from '../lib/search-pages.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { playwrightStatus, answerAddressProbe, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';

function rawPage(target, page, stale = false) {
  const raw = rawSearch(searchPageTarget(target.query, page));
  if (page === 2 && !stale) raw.items[0].url = 'https://detail.tmall.com/item.htm?id=789';
  raw.pagination = { current_page: page, total_pages_displayed: 100, next_disabled: false,
    previous_disabled: page === 1, selected_sort_label: '综合' };
  return raw;
}

function reorderObjects(value) {
  if (Array.isArray(value)) return value.map(reorderObjects);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, reorderObjects(value[key])]));
}

async function fixture(t, { loseReply = false, gateAfterClick = null, unchanged = false } = {}) {
  const target = searchTarget('Synthetic mouse');
  let page = 1, tab = 41, gate = null, reads = 0, clicks = 0, resolves;
  const dispatched = new Promise(resolve => { resolves = resolve; });
  const server = await mockBridge(t, { handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(reorderObjects(value)));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: tab, url: searchPageTarget(target.query, page).url }] } });
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (isAddressProbe(body)) return answerAddressProbe(body, { otherWindowTabs: [] }, send);
    if (gate) return reply({ state: gate });
    if (body.script.includes('"urls":[')) {
      clicks += 1; page = 2; gate = gateAfterClick;
      if (loseReply) req.socket.destroy(); else reply({ state: 'action_dispatched', clicked: true });
      resolves(); return;
    }
    reads += 1;
    reply(rawPage(target, page, unchanged));
  } });
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping pages '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const options = { stateDirectory, task: 'two-pages', search: target.query, pages: 2, tabId: 41, bridge: new BrowserBridge(server.endpoint) };
  await createTask(options);
  await withTaskStore(stateDirectory, options.task, async store => {
    const task = await store.load();
    task.kind = 'search_pages';
    delete task.operations[0].search_collection;
    task.operations[0].search_pages = newSearchPagesState();
    await store.save(task);
  });
  let now = Date.now();
  return { options, target, dispatched, server, clock: { now: () => now, wait: async ms => { now += ms; } },
    reads: () => reads, clicks: () => clicks, setGate: value => { gate = value; }, move: (id, number) => { tab = id; page = number; } };
}

test('bounded page parser preserves first-page API and rejects arbitrary pages, filters and ambiguous identities', () => {
  const second = searchPageTarget('mouse', 2);
  assert.equal(parseSearchPageUrl(`${second.url}&spm=PRIVATE`).url, second.url);
  assert.equal(parseSearchUrl(second.url), null);
  for (const url of [second.url.replace('page=2', 'page=3'), `${second.url}&page=1`, `${second.url}&sort=sales`,
    second.url.replace('tab=all', 'tab=mall'), second.url.replace('s.taobao.com', 's.taobao.com.evil'), `${second.url}#other`]) {
    assert.equal(parseSearchPageUrl(url), null);
  }
});

test('page validation rejects extra pagination fields, contradictory controls and oversized card samples', () => {
  const target = searchTarget('mouse');
  for (const mutate of [raw => { raw.pagination.token = 'PRIVATE'; }, raw => { raw.pagination.current_page = 2; },
    raw => { raw.pagination.previous_disabled = false; }, raw => { raw.pagination.selected_sort_label = '销量'; },
    raw => { raw.items = Array.from({ length: 26 }, () => raw.items[0]); raw.cards_seen = 26; }]) {
    const raw = rawPage(target, 1); mutate(raw);
    assert.throws(() => validateSearchPage(raw, target, false));
  }
});

test('browser response field order has no semantic meaning and normalizes to the same saved pagination', () => {
  const target = searchTarget('mouse');
  const raw = rawPage(target, 1);
  const original = validateSearchPage(raw, target, false).page;
  const reordered = validateSearchPage(reorderObjects(raw), target, false).page;
  reordered.search.observed_at = original.search.observed_at;
  assert.deepEqual(reordered, original);
});

test('one next-page click survives a lost reply, requires two matching observations and serves an offline cache', async t => {
  const f = await fixture(t, { loseReply: true });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete');
  assert.equal(f.clicks(), 1); assert.equal(f.reads(), 3);
  const data = result.operations[0].result;
  assert.deepEqual(data.pages.map(page => page.search.page), [1, 2]);
  assert.equal(data.coverage.page_transition_verified, true);
  assert.equal(data.coverage.sort_verified, false);
  assert.equal(data.action_evidence.actions_reserved, 1);
  assert.equal(data.action_evidence.acknowledgement_error, 'BRIDGE_UNAVAILABLE');
  assert.equal(result.automatic_retries, 0);
  const requests = f.server.state.requests.length;
  await runTask(f.options, f.clock);
  assert.equal((await taskStatus(f.options)).status, 'complete');
  assert.equal(f.server.state.requests.length, requests);
});

test('new URL and page display with unchanged old cards stop without a second click or a verified page', async t => {
  const f = await fixture(t, { unchanged: true });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'stopped');
  assert.equal(result.operations[0].error.code, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(f.clicks(), 1); assert.equal(f.reads(), 4);
  assert.equal(result.operations[0].partial_pages.length, 1);
  assert.equal(result.operations[0].result, null);
  await assert.rejects(createTask({ ...f.options, task: 'bypass' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});

for (const [gate, status, recovery] of [['verification_required', 'waiting_user', 'user'], ['rate_limited', 'waiting_cooldown', 'cooldown']]) {
  test(`${gate} after clicking preserves the first page and original action through explicit recovery`, async t => {
    const f = await fixture(t, { gateAfterClick: gate });
    const paused = await runTask(f.options, f.clock);
    assert.equal(paused.status, status);
    assert.equal(paused.operations[0].partial_pages.length, 1);
    assert.equal(f.clicks(), 1);
    const requests = f.server.state.requests.length;
    await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
    assert.equal(f.server.state.requests.length, requests);
    f.setGate(null);
    assert.equal((await runTask({ ...f.options, recovery }, f.clock)).status, 'complete');
    assert.equal(f.clicks(), 1);
  });
}

test('saved page-2 intent allows diagnosis and reattachment without resetting observations or redispatching', async t => {
  const f = await fixture(t, { gateAfterClick: 'verification_required' });
  await runTask(f.options, f.clock);
  f.setGate(null); f.move(42, 2);
  assert.equal((await runTask({ ...f.options, recovery: 'user' }, f.clock)).status, 'waiting_connection');
  const saved = await loadTask(f.options.stateDirectory, f.options.task);
  const diagnosis = await diagnoseTask(f.options);
  assert.deepEqual(diagnosis.operations[0].matching_tab_ids, [42]);
  assert.equal(diagnosis.operations[0].allowed_urls.length, 2);
  await rebindTask({ ...f.options, tabId: 42 });
  assert.equal((await loadTask(f.options.stateDirectory, f.options.task)).operations[0].search_pages.observations,
    saved.operations[0].search_pages.observations);
  assert.equal((await runTask({ ...f.options, recovery: 'connection' }, f.clock)).status, 'complete');
  assert.equal(f.clicks(), 1);
});

test('page 2 cannot be adopted before a persisted click intent', async t => {
  const f = await fixture(t);
  f.move(42, 2);
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_connection');
  await assert.rejects(rebindTask({ ...f.options, tabId: 42 }), { code: 'TASK_TARGET_MISMATCH' });
  assert.deepEqual((await diagnoseTask(f.options)).operations[0].matching_tab_ids, []);
  assert.equal(f.clicks(), 0); assert.equal(f.reads(), 0);
});

test('invalid journals and tampered result evidence fail before any browser call', async t => {
  const f = await fixture(t);
  const filename = path.join(f.options.stateDirectory, 'tasks/two-pages.json');
  const pending = await readFile(filename, 'utf8');
  const bad = JSON.parse(pending); bad.operations[0].search_pages.action_reserved = true;
  await writeFile(filename, JSON.stringify(bad));
  await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  assert.equal(f.server.state.requests.length, 0);
  await writeFile(filename, pending);
  await runTask(f.options, f.clock);
  const complete = JSON.parse(await readFile(filename, 'utf8'));
  complete.operations[0].result.coverage.sort_verified = true;
  await writeFile(filename, JSON.stringify(complete));
  await assert.rejects(taskStatus(f.options), { code: 'INVALID_CHECKPOINT' });
});

test('killing the actual CLI after next-page dispatch preserves the reservation and recovery budget', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url)),
    'task-run', '--task', f.options.task, '--state-dir', f.options.stateDirectory, '--endpoint', f.options.bridge.endpoint], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([f.dispatched, once(child, 'exit').then(() => { throw new Error('CLI exited before dispatch.'); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete');
  assert.equal(result.operations[0].attempts, 2);
  assert.equal(result.automatic_retries, 1);
  assert.equal(result.wait_reserved_ms, 5000);
  assert.equal(f.clicks(), 1);
});

test('CLI accepts --pages 1 to 5 with search and stores the new bounded collection kind', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pages cli '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = async args => { let output = ''; const code = await main(args, { write: value => { output += value; } }); return { code, value: JSON.parse(output) }; };
  for (const args of [['--search', 'mouse', '--tab', '41', '--pages', '6'], ['--search', 'mouse', '--tab', '41', '--pages', '0'],
    ['--search', 'mouse', '--tab', '41', '--pages', '1.5'], ['--bindings', 'mouse', '--pages', '2']]) {
    const result = await run(['task-start', '--task', 'invalid', '--state-dir', directory, ...args]);
    assert.equal(result.value.error.code, 'INVALID_ARGUMENTS');
  }
  const result = await run(['task-start', '--task', 'pages', '--state-dir', directory, '--search', 'mouse', '--tab', '41', '--pages', '2']);
  assert.equal(result.code, 0); assert.equal(result.value.task_kind, 'search_collection');
});

test('slow dispatches still leave 1.5 seconds before confirmation, and unstable page-2 cards cannot confirm', async () => {
  const target = searchTarget('mouse');
  for (const unstable of [false, true]) {
    let now = 10000, reads = 0, clickedAt;
    const readTimes = [];
    const op = { tab_id: 41, target, search_pages: newSearchPagesState() };
    const context = { op, now: () => now, wait: async ms => { now += ms; }, commit: async () => validateSearchPagesState(op.search_pages, target),
      bridge: {
        readSearchPage: async () => {
          readTimes.push(now); reads += 1;
          const raw = rawPage(target, reads === 1 ? 1 : 2);
          if (unstable && reads > 1) raw.items[0].url = `https://detail.tmall.com/item.htm?id=${900 + reads}`;
          return validateSearchPage(raw, target, reads > 1);
        },
        nextSearchPage: async () => { now += 6000; clickedAt = now; },
      } };
    if (unstable) await assert.rejects(runSearchPages(context), { code: 'ACTION_OUTCOME_UNKNOWN' });
    else assert.equal((await runSearchPages(context)).coverage.page_transition_verified, true);
    assert.ok(readTimes[1] - clickedAt >= 1500);
  }
});

test('observation budget persists across repeated connection failures and never sends a ninth read', async () => {
  const target = searchTarget('mouse');
  let reads = 0, now = 10000;
  const op = { tab_id: 41, target, search_pages: newSearchPagesState() };
  const context = { op, now: () => now, wait: async ms => { now += ms; }, commit: async () => validateSearchPagesState(op.search_pages, target),
    bridge: { readSearchPage: async () => { reads += 1; throw new ShoppingError('TARGET_MISSING', 'Synthetic'); } } };
  for (let count = 0; count < 8; count += 1) await assert.rejects(runSearchPages(context), { code: 'TARGET_MISSING' });
  await assert.rejects(runSearchPages(context), { code: 'ACTION_OBSERVATION_LIMIT' });
  assert.equal(reads, 8);
  assert.equal(op.search_pages.action_reserved, false);
});
