import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { layoutFixture, observeLayout, proposalFor, layoutTarget, node } from '../test-support/layout-fixture.mjs';
import { validateProduct } from '../lib/product.mjs';
import { validateLayoutEvidence, layoutEvidenceId } from '../lib/layout-evidence.mjs';
import { checkLayoutProposal } from '../lib/layout-proposal.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { saveBinding } from '../lib/state.mjs';
import { loadTask, validateTask } from '../lib/task-store.mjs';
import { main } from '../lib/cli.mjs';
import { publicError } from '../lib/errors.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

function sample() {
  const fixture = layoutFixture(), raw = observeLayout([fixture.panel]);
  const evidence = validateLayoutEvidence(raw.layout_evidence, layoutTarget);
  return { fixture, raw, evidence, proposal: proposalFor(evidence) };
}

test('a synthetic unknown body yields bounded source evidence in the same failed read', () => {
  const { raw, evidence } = sample();
  assert.equal(raw.reason, 'title_ambiguous');
  assert.deepEqual(evidence.counts, { title: 2, specification: 1, price: 1 });
  assert.equal(evidence.regions[0].excluded_reason, 'fixed_summary');
  assert.equal(evidence.regions[0].nodes[0].text, '');
  assert.throws(() => validateProduct(raw, layoutTarget), error => {
    assert.equal(error.code, 'PAGE_STRUCTURE_CHANGED');
    assert.deepEqual(error.layoutEvidence, evidence);
    assert.ok(!JSON.stringify(publicError(error)).includes('示例商品'));
    return true;
  });
});

test('identity and access gates never collect layout text; legacy reads do not gain evidence', () => {
  const f = layoutFixture();
  assert.deepEqual(observeLayout([f.panel], { url: 'https://detail.tmall.com/item.htm?id=999' }), { state: 'target_changed' });
  for (const text of ['请登录', '安全验证', '访问频繁', 'Unrecognized dialog']) {
    const raw = observeLayout([node('', text, [], { role: 'dialog' }), f.panel]);
    assert.equal(Object.hasOwn(raw, 'layout_evidence'), false);
  }
  const legacy = observeLayout([f.panel], { diagnostics: false });
  assert.deepEqual(Object.keys(legacy).sort(), ['reason', 'state']);
});

test('diagnostics exclude hidden, form, delivery, other-product and video content before reading text', () => {
  const f = layoutFixture();
  for (const item of [node('deliveryAddrWrap', 'PRIVATE'), node('', 'PRIVATE', [], { tagName: 'INPUT' }),
    node('', 'PRIVATE', [], { tagName: 'VIDEO' }), node('', 'PRIVATE', [], { hidden: true }),
    node('', 'PRIVATE', [node('', 'PRIVATE')], { tagName: 'A', href: 'https://item.taobao.com/item.htm?id=456' })]) {
    Object.defineProperty(item, 'childNodes', { get() { throw Error('Excluded content read'); } });
    item.parentElement = f.specifications; f.specifications.children.push(item);
  }
  const raw = observeLayout([f.panel]);
  validateLayoutEvidence(raw.layout_evidence, layoutTarget);
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE/);
});

test('diagnostics cap candidate roots, subtree nodes, depth and direct text', () => {
  const f = layoutFixture();
  for (let i = 0; i < 60; i++) { const item = node('', 'x'.repeat(600)); item.parentElement = f.specifications; f.specifications.children.push(item); }
  const evidence = observeLayout([f.panel]).layout_evidence;
  validateLayoutEvidence(evidence, layoutTarget);
  const region = evidence.regions.find(item => item.kind === 'specification');
  assert.equal(region.nodes.length, 40); assert.equal(region.traversal_truncated, true);
  assert.ok(region.nodes.some(item => item.text_truncated && item.text.length === 400));
  const raw = observeLayout([f.panel, ...Array.from({ length: 6 }, () => node('ItemTitle', 'other'))]);
  validateLayoutEvidence(raw.layout_evidence, layoutTarget);
  assert.equal(raw.layout_evidence.counts.title, 8);
  assert.equal(raw.layout_evidence.regions.filter(item => item.kind === 'title').length, 3);
  let deep = node('', 'deep'); for (let i = 0; i < 10; i++) deep = node('', '', [deep]);
  const another = layoutFixture(); another.specifications.children.push(deep); deep.parentElement = another.specifications;
  assert.equal(observeLayout([another.panel]).layout_evidence.regions.find(item => item.kind === 'specification').traversal_truncated, true);
});

test('SVG icons and long hidden subtrees stay bounded without replacing the primary failure', () => {
  const f = layoutFixture();
  const svg = node('', 'PRIVATE', [], { tagName: 'svg' });
  Object.defineProperty(svg, 'childNodes', { get() { throw Error('SVG contents must be excluded'); } });
  svg.parentElement = f.specifications; f.specifications.children.push(svg);
  for (let i = 0; i < 200; i++) {
    const hidden = node('', 'PRIVATE', [], { hidden: true }); hidden.parentElement = f.specifications; f.specifications.children.push(hidden);
  }
  const raw = observeLayout([f.panel]);
  validateLayoutEvidence(raw.layout_evidence, layoutTarget);
  assert.equal(raw.reason, 'title_ambiguous');
  const region = raw.layout_evidence.regions.find(item => item.kind === 'specification');
  assert.equal(region.traversal_truncated, true);
  assert.ok(region.nodes.some(item => item.tag === 'SVG' && item.excluded_reason === 'unsupported_content'));
});

test('diagnostic collection errors preserve the original structural stop and do not expose exceptions', () => {
  const f = layoutFixture();
  Object.defineProperty(f.title, 'childNodes', { get() { throw Error('PRIVATE ERROR'); } });
  const raw = observeLayout([f.panel]);
  assert.deepEqual(raw, { state: 'structure_changed', reason: 'title_ambiguous', layout_evidence_error: 'COLLECTION_FAILED' });
  assert.throws(() => validateProduct(raw, layoutTarget), error => {
    assert.equal(error.code, 'PAGE_STRUCTURE_CHANGED'); assert.equal(error.layoutEvidenceError, 'COLLECTION_FAILED'); return true;
  });
});

test('malformed topology, wrong identity, extra fields and hostile image URLs fail evidence validation', () => {
  const { evidence } = sample();
  const spec = value => value.regions.find(region => region.kind === 'specification');
  for (const mutate of [e => e.product_id = '456', e => e.url += '&secret=x', e => e.reason = 'PRIVATE', e => e.counts.title++,
    e => e.regions[1].nodes[0].ref = 99, e => spec(e).nodes[1].parent_ref = 999,
    e => spec(e).nodes[1].parent_ref = spec(e).nodes[1].ref, e => e.regions[1].nodes[0].text = 'x'.repeat(401),
    e => e.extra = {}, e => spec(e).nodes.find(n => n.image).image.url = 'https://alicdn.com.evil.example/image',
    e => spec(e).nodes.find(n => n.image).image.url += '?token=private']) {
    const changed = structuredClone(evidence); mutate(changed);
    assert.throws(() => validateLayoutEvidence(changed, layoutTarget), { code: 'INVALID_LAYOUT_EVIDENCE' });
  }
});

test('node proposals return source-matched candidates without promoting SKU, price, semantic or live guarantees', () => {
  const { evidence, proposal } = sample();
  const result = checkLayoutProposal(proposal, evidence, layoutTarget);
  assert.equal(result.fields.length, 5); assert.deepEqual(result.missing_field_kinds, []);
  assert.equal(result.fields[0].raw, '示例商品');
  assert.equal(result.fields[3].image.url, 'https://img.alicdn.com/black.jpg');
  for (const key of ['snapshot_updated', 'live_rechecked', 'field_interpretation_verified', 'full_coverage_verified',
    'additional_reads_authorized', 'sku_price_binding_verified', 'eligibility_verified']) assert.equal(result[key], false);
  assert.equal(result.sku_id, null);
});

test('evidence IDs bind the complete observation and are independent of JSON key order', () => {
  const { evidence, proposal } = sample();
  assert.equal(layoutEvidenceId(Object.fromEntries(Object.entries(evidence).reverse())), proposal.evidence_id);
  const changed = structuredClone(evidence); changed.observed_at = '2026-10-01T00:00:00Z';
  assert.throws(() => checkLayoutProposal(proposal, changed, layoutTarget), { code: 'INVALID_LAYOUT_PROPOSAL' });
});

test('invented values, executable selectors, wrong products, missing nodes and duplicate references are rejected', () => {
  const { evidence, proposal } = sample();
  for (const mutate of [p => p.product_id = '456', p => p.evidence_id = 'fake', p => p.fields[0].raw = 'invented',
    p => p.fields[0].selector = 'body', p => p.fields[0].node_ref = 999, p => p.sku_id = '123',
    p => p.fields.push(p.fields[0]), p => p.fields[0].field = '__proto__']) {
    const changed = structuredClone(proposal); mutate(changed);
    assert.throws(() => checkLayoutProposal(changed, evidence, layoutTarget), { code: 'INVALID_LAYOUT_PROPOSAL' });
  }
});

test('fixed summaries, other-product nodes and unscoped panels cannot be used as target fields', () => {
  const { evidence, proposal } = sample();
  const summary = evidence.regions.find(region => region.excluded_reason === 'fixed_summary');
  const changed = structuredClone(proposal); changed.fields[0].region_ref = summary.ref; changed.fields[0].node_ref = summary.nodes[0].ref;
  assert.throws(() => checkLayoutProposal(changed, evidence, layoutTarget), { code: 'INVALID_LAYOUT_PROPOSAL' });
  const f = layoutFixture(); f.title.tagName = 'A'; f.title.getAttribute = name => name === 'class' ? f.title.className : name === 'href' ? 'https://item.taobao.com/item.htm?id=456' : null;
  const other = observeLayout([f.panel]).layout_evidence;
  const another = structuredClone(proposal); another.evidence_id = layoutEvidenceId(other);
  assert.throws(() => checkLayoutProposal(another, other, layoutTarget), { code: 'INVALID_LAYOUT_PROPOSAL' });
  const unscoped = structuredClone(evidence); unscoped.regions[1].panel_ref = null;
  const unscopedProposal = structuredClone(proposal); unscopedProposal.evidence_id = layoutEvidenceId(unscoped);
  assert.throws(() => checkLayoutProposal(unscopedProposal, unscoped, layoutTarget), { code: 'INVALID_LAYOUT_PROPOSAL' });
});

test('wrong group and image owners fail, including missing owner fields', () => {
  const { evidence, proposal } = sample();
  for (const mutate of [p => p.fields[2].group_ref = p.fields[2].container_ref,
    p => p.fields[3].option_ref = p.fields[1].container_ref, p => p.fields.splice(1, 1),
    p => p.fields[2].container_ref = p.fields[1].container_ref]) {
    const changed = structuredClone(proposal); mutate(changed);
    assert.throws(() => checkLayoutProposal(changed, evidence, layoutTarget), { code: 'INVALID_LAYOUT_PROPOSAL' });
  }
});

test('truncated regions, truncated labels and tiny images stay unconfirmed', () => {
  const { evidence, proposal } = sample();
  for (const mutate of [e => e.regions[1].traversal_truncated = true, e => e.regions[1].nodes[0].text_truncated = true,
    e => e.regions.find(r => r.kind === 'specification').nodes.find(n => n.image).image.width = 2]) {
    const changed = structuredClone(evidence); mutate(changed);
    const updated = structuredClone(proposal); updated.evidence_id = layoutEvidenceId(changed);
    assert.throws(() => checkLayoutProposal(updated, changed, layoutTarget), { code: 'INVALID_LAYOUT_PROPOSAL' });
  }
});

test('multiple eligible title regions and cross-panel field proposals remain ambiguous', () => {
  const { evidence, proposal } = sample();
  for (const mutate of [e => { e.regions[0].excluded_reason = null; e.regions[0].nodes[0].excluded_reason = null; },
    e => e.regions.find(r => r.kind === 'price').panel_ref = 2]) {
    const changed = structuredClone(evidence); mutate(changed);
    const updated = structuredClone(proposal); updated.evidence_id = layoutEvidenceId(changed);
    assert.throws(() => checkLayoutProposal(updated, changed, layoutTarget), { code: 'INVALID_LAYOUT_PROPOSAL' });
  }
});

async function savedFailure(t, { legacy = false } = {}) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'layout-assistance-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const { raw, evidence, proposal } = sample(); let calls = 0;
  const bridge = { endpoint: 'http://127.0.0.1:19824', async readProduct(tab, target, options) {
    calls++; assert.equal(options.layoutDiagnostics, !legacy); return validateProduct(raw, target);
  } };
  await saveBinding(stateDirectory, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint,
    tab_id: 41, target: layoutTarget, created_at: new Date().toISOString() });
  const options = { stateDirectory, task: 'sample', bindings: ['sample'], bridge };
  await createTask(options);
  const filename = path.join(stateDirectory, 'tasks/sample.json');
  if (legacy) { const task = JSON.parse(await readFile(filename)); delete task.layout_diagnostics_version; await writeFile(filename, JSON.stringify(task)); }
  const result = await runTask(options);
  return { options, evidence, proposal, result, filename, calls: () => calls };
}

async function cli(args) {
  let output = ''; const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

test('new failed snapshot stores diagnostics once; offline delivery and proposal checking preserve checkpoint and budgets', async t => {
  const f = await savedFailure(t);
  assert.equal(f.result.status, 'stopped'); assert.deepEqual(f.result.operations[0].layout_evidence, f.evidence);
  assert.equal(f.result.operations[0].attempts, 1); assert.equal(f.result.automatic_retries + f.result.wait_reserved_ms, 0);
  const before = await readFile(f.filename, 'utf8');
  const common = ['--state-dir', f.options.stateDirectory, '--task', 'sample', '--operation', '1'];
  const diagnosis = await cli(['layout-diagnosis', ...common]);
  assert.equal(diagnosis.code, 0); assert.equal(diagnosis.value.evidence_id, layoutEvidenceId(f.evidence));
  assert.equal(diagnosis.value.budget.additional_reads_authorized, false);
  const filename = path.join(f.options.stateDirectory, 'proposal.json'); await writeFile(filename, JSON.stringify(f.proposal));
  const checked = await cli(['layout-check', ...common, '--proposal', filename]);
  assert.equal(checked.code, 0); assert.equal(checked.value.fields.length, 5); assert.equal(checked.value.state_changed, false);
  await runTask(f.options); assert.equal(f.calls(), 1);
  assert.equal(await readFile(f.filename, 'utf8'), before);
});

test('legacy failures remain evidence-free and are not upgraded by offline commands', async t => {
  const f = await savedFailure(t, { legacy: true });
  assert.equal(Object.hasOwn(f.result.operations[0], 'layout_evidence'), false);
  const before = await readFile(f.filename, 'utf8');
  const common = ['--state-dir', f.options.stateDirectory, '--task', 'sample', '--operation', '1'];
  const diagnosis = await cli(['layout-diagnosis', ...common]);
  assert.equal(diagnosis.value.status, 'layout_evidence_unavailable');
  assert.equal((await cli(['layout-check', ...common, '--proposal', 'absent.json'])).value.error.code, 'LAYOUT_EVIDENCE_MISSING');
  assert.equal(await readFile(f.filename, 'utf8'), before);
});

test('corrupted saved evidence, mismatched stop reasons and diagnostics on unsupported task kinds are rejected', async t => {
  const f = await savedFailure(t), saved = await loadTask(f.options.stateDirectory, 'sample');
  for (const mutate of [s => delete s.layout_diagnostics_version, s => s.layout_diagnostics_version = 2,
    s => s.operations[0].layout_evidence.product_id = '456', s => s.operations[0].error.reason = 'title_missing',
    s => s.operations[0].attempts = 0, s => s.status = 'waiting_user']) {
    const changed = structuredClone(saved); mutate(changed);
    assert.throws(() => validateTask(changed), { code: 'INVALID_CHECKPOINT' });
  }
});

test('offline CLI rejects browser options, bad indexes, invalid JSON, oversized and symlinked proposal files', async t => {
  const f = await savedFailure(t), common = ['--state-dir', f.options.stateDirectory, '--task', 'sample'];
  for (const index of ['0', '2', '1.5', 'NaN']) assert.notEqual((await cli(['layout-diagnosis', ...common, '--operation', index])).code, 0);
  assert.equal((await cli(['layout-diagnosis', ...common, '--operation', '1', '--dedicated'])).value.error.code, 'INVALID_ARGUMENTS');
  const filename = path.join(f.options.stateDirectory, 'bad.json');
  for (const value of ['not JSON', ' '.repeat(65537)]) {
    await writeFile(filename, value);
    assert.equal((await cli(['layout-check', ...common, '--operation', '1', '--proposal', filename])).value.error.code, 'INVALID_LAYOUT_PROPOSAL');
  }
  const link = path.join(f.options.stateDirectory, 'link.json'); await symlink(filename, link);
  assert.equal((await cli(['layout-check', ...common, '--operation', '1', '--proposal', link])).value.error.code, 'INVALID_LAYOUT_PROPOSAL');
  assert.equal(f.calls(), 1);
});

test('CLI and production bridge opt new tasks into same-read diagnostics, then serve them offline', async t => {
  const { state, endpoint } = await mockBridge(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'layout-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = ['--state-dir', directory, '--endpoint', endpoint];
  assert.equal((await cli(['bind', ...common, '--tab', '41', '--binding', 'sample'])).code, 0);
  assert.equal((await cli(['task-start', ...common, '--task', 'sample', '--bindings', 'sample'])).code, 0);
  state.metadata = sample().raw;
  const before = state.commands.length;
  const result = await cli(['task-run', ...common, '--task', 'sample']);
  assert.equal(result.value.status, 'stopped');
  const reads = state.commands.slice(before).filter(command => command.action === 'eval');
  assert.equal(reads.length, 1); assert.match(reads[0].script, /function collectEvidence/);
  assert.equal(result.value.operations[0].layout_evidence.reason, 'title_ambiguous');
  const count = state.requests.length;
  assert.equal((await cli(['layout-diagnosis', '--state-dir', directory, '--task', 'sample', '--operation', '1'])).code, 0);
  assert.equal(state.requests.length, count);
});
