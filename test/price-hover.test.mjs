import { recordPausedDisplay, assertPausedDisplays } from '../test-support/paused-display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { main } from '../lib/cli.mjs';
import { searchTarget } from '../lib/search.mjs';
import { newPriceEntryState, runPriceEntry } from '../lib/price-entry.mjs';
import { normalizePriceDirections, validatePriceHoverReference, validateHoverPreparation } from '../lib/price-hover.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';

const selector = ':is([class^="sortBarWrapper--"], [class*=" sortBarWrapper--"]) [role="tab"]:is([class^="customTabItemWithArr--"], [class*=" customTabItemWithArr--"]):nth-child(3)';
function candidate(label = '价格从低到高') {
  return { label, tag: 'DIV', class_name: 'synthetic', role: '', parent_class: 'synthetic-popup', within_price_tab: false, within_sort_bar: true };
}
function observation(target, hovered) {
  return { ...rawSearch(target), pagination: { current_page: 1, total_pages_displayed: 11, next_disabled: false, previous_disabled: true, selected_sort_label: '销量' },
    controls: ['综合', '销量', '价格', '区间'].map(text => ({ tag: 'LI', class_name: '', text, role: 'tab', aria_label: '', aria_sort: '', aria_haspopup: '', aria_expanded: '', selected: text === '销量', disabled: false, children: [] })),
    price_entry: { menu_candidates: [], sort_bar_text: '综合 销量 价格 区间' },
    price_directions: { scan_truncated: false, candidates: hovered ? [candidate(), candidate('价格从高到低')] : [] } };
}
async function fixture(t, { uncertain = false, hoverTimeout = false, gate = null, invalidReference = false, changedGuard = false } = {}) {
  const target = searchTarget('mouse'), stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping hover '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let hovers = 0, reads = 0, references = 0, guards = 0;
  const displays = [];
  const server = await mockBridge(t, { handler: async ({ req, res, body }) => {
    const send = value => res.end(JSON.stringify(value));
    const reply = result => send({ id: body.id, success: true, data: { result } });
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [] } });
    if (body.action === 'tab_show') return send({ id: body.id, success: true, data: await recordPausedDisplay(body, stateDirectory, 'hover', displays) });
    if (body.action === 'snapshot') {
      references += 1; assert.equal(body.selector, selector); assert.equal(body.interactive, true);
      const saved = await loadTask(stateDirectory, 'hover');
      assert.equal(saved.operations[0].price_entry.action_reserved, true); assert.equal(saved.operations[0].price_entry.observations, 2);
      return send({ id: body.id, success: true, data: { url: target.url, snapshotData: { refs: invalidReference ? {} : { '0': { role: 'tab', name: '价格', backendDOMNodeId: 120 } } } } });
    }
    if (body.action === 'hover') {
      hovers += 1; assert.equal(body.ref, '0'); assert.equal(body.tabId, 41);
      if (hoverTimeout) return;
      return send({ id: body.id, success: !uncertain, data: { role: 'tab', name: '价格' } });
    }
    if (body.script.includes('function inspectSortTarget(')) return reply({ state: 'observed', url: target.url });
    if (body.script.includes('"urls":')) { guards += 1; return reply(changedGuard && guards > 1 ? { state: 'target_changed' } : { state: 'hover_prepared', selector }); }
    reads += 1; return reply(hovers && gate ? { state: gate } : observation(target, hovers > 0));
  } });
  const options = { stateDirectory, task: 'hover', search: target.query, tabId: 41, inspectPriceHover: true,
    bridge: new BrowserBridge(server.endpoint, { timeoutMs: hoverTimeout ? 200 : 5000 }) };
  await createTask(options); let now = Date.now();
  return { options, target, server, displays, clock: { now: () => now, wait: async ms => { now += ms; } }, counts: () => ({ hovers, reads, references, guards }), setGate: value => { gate = value; } };
}

test('hover uses one scoped fresh reference and two guards, persists its budget, then caches descriptive evidence', async t => {
  const f = await fixture(t), result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(result.task_kind, 'search_price_hover');
  assertPausedDisplays(f.displays, []);
  assert.deepEqual(f.counts(), { hovers: 1, reads: 2, references: 1, guards: 2 });
  assert.equal(result.operations[0].dom_observations_reserved, 3);
  assert.equal(result.operations[0].result.after.directions.candidates.length, 2);
  assert.equal(result.operations[0].result.price_direction, null);
  assert.equal(result.operations[0].result.coverage.menu_relation_verified, false);
  assert.equal(result.operations[0].result.limits.price_tab_clicks, 0);
  const requests = f.server.state.requests.length; await runTask(f.options); assert.equal(f.server.state.requests.length, requests);
  assert.equal(f.server.state.commands.filter(command => command.action === 'click').length, 0);
});

test('uncertain hover then verification resumes only an observation, preserving the counted reference read', async t => {
  const f = await fixture(t, { uncertain: true, gate: 'verification_required' });
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user');
  const expectedDisplay = [{ tabId: 41, status: 'waiting_user', code: 'VERIFICATION_REQUIRED' }];
  assertPausedDisplays(f.displays, expectedDisplay);
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  f.setGate(null);
  const result = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(result.status, 'complete'); assert.equal(result.operations[0].dom_observations_reserved, 4);
  assert.equal(f.counts().hovers, 1); assert.equal(f.counts().references, 1);
  assert.equal(result.operations[0].result.action_evidence.acknowledgement_error, 'BROWSER_COMMAND_FAILED');
  assertPausedDisplays(f.displays, expectedDisplay);
});

test('actual transport timeout after hover dispatch remains uncertain even when the following read completes', async t => {
  const f = await fixture(t, { hoverTimeout: true }), report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete'); assert.equal(f.counts().hovers, 1);
  assert.equal(report.operations[0].result.action_evidence.acknowledgement_error, 'BRIDGE_TIMEOUT');
  assert.equal(report.operations[0].result.coverage.control_behavior_verified, false);
  assert.equal(report.operations[0].result.price_direction, null);
  assert.equal(report.automatic_retries, 0); assert.equal(report.operations[0].dom_observations_reserved, 3);
});

test('missing reference or a changed second guard never sends the hover', async t => {
  for (const mode of [{ invalidReference: true }, { changedGuard: true }]) {
    const f = await fixture(t, mode), result = await runTask(f.options, f.clock);
    assert.ok(['stopped', 'waiting_connection'].includes(result.status)); assert.equal(f.counts().hovers, 0);
    assert.equal(result.operations[0].actions_reserved, 0); assert.equal(result.operations[0].dom_observations_reserved, 2);
  }
});

test('hover result cannot lose its reference reservation or invent sort guarantees', async t => {
  const f = await fixture(t); await runTask(f.options, f.clock);
  const file = path.join(f.options.stateDirectory, 'tasks/hover.json'), saved = await readFile(file, 'utf8');
  for (const change of [v => { v.operations[0].price_entry.observations = 2; }, v => { v.operations[0].result.coverage.sort_verified = true; }, v => { v.operations[0].result.after.directions.candidates[0].within_price_tab = true; }]) {
    const value = JSON.parse(saved); change(value); await writeFile(file, JSON.stringify(value));
    await assert.rejects(loadTask(f.options.stateDirectory, 'hover'), { code: 'INVALID_CHECKPOINT' });
  }
  const op = { target: f.target, tab_id: 41, price_entry: { ...newPriceEntryState(), observations: 6 } };
  let dispatches = 0;
  await assert.rejects(runPriceEntry({ op, hover: true, ...f.clock, commit: async () => {}, bridge: { readPriceEntry: async () => ({}), hoverPriceEntry: async () => { dispatches += 1; } } }), { code: 'ACTION_OBSERVATION_LIMIT' });
  assert.equal(dispatches, 0); assert.equal(op.price_entry.observations, 7);
});

test('hover protocol validates reordered fields, finite labels, ancestry, canonical identity and selectors', () => {
  assert.equal(normalizePriceDirections({ scan_truncated: false, candidates: [candidate()] }).candidates.length, 1);
  for (const value of [{ scan_truncated: false, candidates: Array(9).fill(candidate()) }, { scan_truncated: false, candidates: [candidate('unrelated')] },
    { scan_truncated: false, candidates: [{ ...candidate(), within_sort_bar: false, within_price_tab: true }] }]) assert.throws(() => normalizePriceDirections(value), { code: 'INVALID_RESPONSE' });
  assert.equal(validateHoverPreparation({ selector, state: 'hover_prepared' }), selector);
  assert.throws(() => validateHoverPreparation({ selector: 'body', state: 'hover_prepared' }), { code: 'INVALID_RESPONSE' });
  const before = { inspection: { search: { url: searchTarget('mouse').url } } };
  assert.throws(() => validatePriceHoverReference({ url: 'https://example.com/' }, before), { code: 'TARGET_CHANGED' });
});

test('hover CLI rejects combined modes and creates only the bounded hover task', async t => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping hover cli '));t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const call = async args => { let output = '';await main(args, { write: value => { output += value; } });return JSON.parse(output); };
  const base = ['task-start', '--task', 'hover', '--state-dir', stateDirectory, '--search', 'mouse', '--tab', '41', '--inspect-price-hover'];
  for (const extra of [['--inspect-price'], ['--inspect-controls'], ['--sort', 'sales'], ['--pages', '2']]) assert.equal((await call([...base, ...extra])).error.code, 'INVALID_ARGUMENTS');
  assert.equal((await call(base)).task_kind, 'search_price_hover');
});
