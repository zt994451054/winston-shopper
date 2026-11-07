import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ShoppingError } from '../lib/errors.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { validateProduct, selectionScript, validateSelectionAcknowledgement } from '../lib/product.mjs';
import { normalizeSelection, selectionKey, newSelectionState, readSelectedProduct, validateSelectedResult } from '../lib/selections.mjs';
import { rawProduct } from '../test-support/product-fixture.mjs';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { saveBinding } from '../lib/state.mjs';
import { loadSelectionPlan } from '../lib/selection-plan.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const selection = [{ group: '颜色分类', option: '白色' }];

function snapshot(selected, amount = '10') {
  const raw = rawProduct();
  raw.groups[0].options.forEach(option => { option.selected = option.label === selected ? true : null; option.disabled = null; });
  raw.prices = [{ raw: `优惠后 ￥${amount}`, label: '优惠后', amount_text: amount, qualifier: '' }];
  return validateProduct(raw, target);
}

function context({ selected = '黑色', price = (time, color) => color === '白色' ? '20' : '10', clickError = null, applyClick = true, readError = null } = {}) {
  let time = 100000;
  const calls = [], commits = [];
  const op = { tab_id: 41, target, selection, selection_state: newSelectionState(), recovery_kind: null };
  const bridge = {
    async readProduct() {
      calls.push({ type: 'read', time });
      if (readError) readError(calls);
      return snapshot(selected, price(time, selected));
    },
    async selectOption(tab, target, choice) {
      calls.push({ type: 'click', choice, time });
      if (applyClick) selected = choice.option;
      if (clickError) throw clickError;
      return { clicked: true };
    },
  };
  return { bridge, op, calls, commits, now: () => time,
    wait: async ms => { time += ms; }, commit: async () => { commits.push(structuredClone(op)); } };
}

test('selection key deduplicates reordered input but preserves distinct combinations', () => {
  const one = [{ group: '颜色', option: '黑' }, { group: '尺寸', option: '大' }];
  assert.equal(selectionKey('123', one), selectionKey('123', [...one].reverse()));
  assert.notEqual(selectionKey('123', one), selectionKey('123', [{ group: '颜色', option: '白' }, one[1]]));
  assert.throws(() => normalizeSelection([one[0], one[0]]), { code: 'INVALID_SELECTION' });
});

test('price changes after selection are observed until stable, without claiming a verified SKU price', async () => {
  const f = context({ price: (time, color) => color === '白色' && time >= 102000 ? '20' : '10' });
  const result = await readSelectedProduct(f);
  assert.equal(result.prices[0].amount, '20');
  assert.equal(result.selection_evidence.price_state, 'changed_and_stable');
  assert.equal(result.selection_evidence.status, 'confirmed');
  assert.equal(result.prices[0].sku_price_binding_verified, false);
  assert.equal(f.calls.filter(call => call.type === 'click').length, 1);
  assert.ok(f.commits.some(op => op.selection_state.dispatches[0]?.status === 'reserved'));
  validateSelectedResult(result, target, selection);
});

test('an already selected option is observed without toggling it off', async () => {
  const f = context({ selected: '白色' });
  const result = await readSelectedProduct(f);
  assert.equal(result.selection_evidence.price_state, 'existing_selection_stable');
  assert.equal(f.calls.filter(call => call.type === 'click').length, 0);
});

test('truncated option lists cannot dispatch or confirm a selection, including already selected and cached results', async () => {
  const raw=rawProduct();
  raw.groups[0].options=Array.from({length:100},(_,index)=>({label:index===0?'白色':`Option ${index}`,selected:index===0?true:null,disabled:null}));
  raw.specification_counts={region_observed:true,groups_seen:1,options_seen:[101]};
  const partial=validateProduct(raw,target);
  for(const alreadySelected of [true,false]) {
    const f=context();const value=structuredClone(partial);
    if(!alreadySelected)value.specification_groups[0].options[0].selected=null;
    f.bridge.readProduct=async()=>value;
    await assert.rejects(readSelectedProduct(f),{code:'SELECTION_AMBIGUOUS'});
    assert.equal(f.op.selection_state.dispatches.length,0);
    assert.equal(f.calls.filter(call=>call.type==='click').length,0);
  }
  const complete=await readSelectedProduct(context({selected:'白色'}));
  assert.throws(()=>validateSelectedResult({...partial,selection_evidence:complete.selection_evidence},target,selection),{code:'INVALID_CHECKPOINT'});
});

test('unchanged prices after a successful selection remain explicitly unconfirmed', async () => {
  const f = context({ price: () => '10' });
  const result = await readSelectedProduct(f);
  assert.equal(result.selection_evidence.price_state, 'unchanged_after_selection');
  assert.equal(result.selection_evidence.sku_price_binding_verified, false);
});

test('confirmed selection and stable prices do not authenticate a stale URL SKU candidate', async () => {
  const f = context();
  const read = f.bridge.readProduct;
  f.bridge.readProduct = async () => ({ ...await read(), sku_evidence: validateProduct({
    ...rawProduct(), sku_url: { status: 'candidate_only', candidate_sku_id: '456', sku_properties_present: false },
  }, target).sku_evidence });
  const result = await readSelectedProduct(f);
  assert.equal(result.selection_evidence.status, 'confirmed');
  assert.equal(result.selection_evidence.price_state, 'changed_and_stable');
  assert.equal(result.sku_evidence.candidate_sku_id, '456');
  assert.equal(result.sku_evidence.selection_binding_verified, false);
  assert.equal(result.selection_evidence.sku_price_binding_verified, false);
  assert.equal(result.prices[0].sku_id, null);
  validateSelectedResult(result, target, selection, f.op.selection_state);
});

test('a fresh URL candidate can coexist with a price whose update falls outside the observation window', async () => {
  const f = context({ price: time => time < 110000 ? '10' : '20' });
  const read = f.bridge.readProduct;
  f.bridge.readProduct = async () => {
    const value = await read();
    const selected = value.specification_groups[0].options.find(option => option.label === '白色').selected === true;
    return { ...value, sku_evidence: validateProduct({ ...rawProduct(), sku_url: {
      status: 'candidate_only', candidate_sku_id: selected ? '789' : '456', sku_properties_present: false,
    } }, target).sku_evidence };
  };
  const result = await readSelectedProduct(f);
  assert.ok(f.now() < 110000);
  assert.equal(result.sku_evidence.candidate_sku_id, '789');
  assert.equal(result.prices[0].amount, '10');
  assert.equal(result.selection_evidence.price_state, 'unchanged_after_selection');
  assert.equal(result.selection_evidence.sku_price_binding_verified, false);
  assert.equal(result.prices[0].sku_id, null);
  assert.equal(result.prices[0].eligibility_verified, false);
  validateSelectedResult(result, target, selection, f.op.selection_state);
});

test('multiple selected options cannot confirm a requested combination or resolve an uncertain click', async () => {
  for (const pending of [false, true]) {
    const f = context();
    const read = f.bridge.readProduct;
    f.bridge.readProduct = async () => {
      const value = await read();
      value.specification_groups[0].options.forEach(option => { option.selected = true; });
      return value;
    };
    if (pending) f.op.selection_state.dispatches.push({ choice_index: 0, status: 'reserved', checks: 0, error_code: null });
    await assert.rejects(readSelectedProduct(f), { code: 'SELECTION_STATE_CONFLICT' });
    assert.equal(f.op.selection_state.reads, 1);
    assert.equal(f.calls.filter(call => call.type === 'click').length, 0);
    if (pending) assert.equal(f.op.selection_state.dispatches[0].status, 'reserved');
  }
});

test('saved confirmed combinations reject contradictory selected flags', async () => {
  const result = await readSelectedProduct(context());
  result.specification_groups[0].options.forEach(option => { option.selected = true; });
  assert.throws(() => validateSelectedResult(result, target, selection), { code: 'INVALID_CHECKPOINT' });
});

test('a click that succeeds but times out is observed and is never sent a second time', async () => {
  const f = context({ clickError: new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic timeout') });
  const result = await readSelectedProduct(f);
  assert.equal(result.selection_evidence.status, 'confirmed');
  assert.equal(f.calls.filter(call => call.type === 'click').length, 1);
  assert.equal(f.op.selection_state.dispatches[0].error_code, 'BRIDGE_TIMEOUT');
});

test('an uncertain click that never appears stops after three checks without blind replay', async () => {
  const f = context({ applyClick: false, clickError: new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic timeout') });
  await assert.rejects(readSelectedProduct(f), { code: 'SELECTION_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.filter(call => call.type === 'click').length, 1);
  assert.equal(f.op.selection_state.dispatches[0].checks, 3);
});

test('restoring a journal with a dispatched option performs observations and never redispatches', async () => {
  const f = context({ selected: '白色' });
  f.op.selection_state.dispatches = [{ choice_index: 0, status: 'reserved', checks: 0, error_code: null }];
  f.op.selection_state.baseline = '0'.repeat(64);
  const result = await readSelectedProduct(f);
  assert.equal(result.selection_evidence.status, 'confirmed');
  assert.equal(f.calls.filter(call => call.type === 'click').length, 0);
});

test('an acknowledged verification guard frees only the never-dispatched intent and pauses immediately', async () => {
  const error = new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic gate'); error.actionNotDispatched = true;
  const f = context({ applyClick: false, clickError: error });
  await assert.rejects(readSelectedProduct(f), { code: 'VERIFICATION_REQUIRED' });
  assert.equal(f.op.selection_state.dispatches.length, 0);
  assert.equal(f.calls.length, 2);
});

test('price polling has a finite budget and returns unstable evidence rather than a guessed match', async () => {
  const f = context({ price: time => String(time) });
  const result = await readSelectedProduct(f);
  assert.equal(result.selection_evidence.price_state, 'unstable');
  assert.equal(f.op.selection_state.settling_reads, 8);
});

test('disabled or incomplete combinations do not dispatch any option', async () => {
  for (const mode of ['disabled', 'incomplete']) {
    const f = context();
    f.bridge.readProduct = async () => {
      const value = snapshot('黑色');
      if (mode === 'disabled') value.specification_groups[0].options[1].disabled = true;
      else value.specification_groups.push({ name: '尺寸', options: [{ label: '大', selected: null, disabled: null }] });
      return value;
    };
    await assert.rejects(readSelectedProduct(f), { code: mode === 'disabled' ? 'SELECTION_DISABLED' : 'INCOMPLETE_SELECTION' });
    assert.equal(f.calls.length, 0);
  }
});

test('selection identity guards execute before any DOM or click access', () => {
  const document = new Proxy({}, { get() { throw new Error('must not read DOM'); } });
  const value = vm.runInNewContext(selectionScript(target, selection[0]), { URL, location: { href: 'https://detail.tmall.com/item.htm?id=999' }, document });
  assert.equal(value.state, 'target_changed');
  assert.throws(() => validateSelectionAcknowledgement(value, selection[0]), error => error.code === 'TARGET_CHANGED' && error.actionNotDispatched);
});

test('selection labels remain data even if they contain JavaScript-looking text', () => {
  const context = { URL, location: { href: 'https://detail.tmall.com/item.htm?id=999' }, marker: false };
  const result = vm.runInNewContext(selectionScript(target, { group: '颜色分类', option: '\"); globalThis.marker=true; //' }), context);
  assert.equal(result.state, 'target_changed');
  assert.equal(context.marker, false);
});

test('unknown or prototype-named acknowledgement states never claim a safe undispatched action', () => {
  for (const state of ['constructor', '__proto__', 'unrecognized']) {
    assert.throws(() => validateSelectionAcknowledgement({ state }, selection[0]), error => error.code === 'INVALID_RESPONSE' && !error.actionNotDispatched);
  }
});

test('saved evidence cannot change the selected combination or assert a stronger price guarantee', async () => {
  const result = await readSelectedProduct(context());
  result.selection_evidence.sku_price_binding_verified = true;
  assert.throws(() => validateSelectedResult(result, target, selection), { code: 'INVALID_CHECKPOINT' });
});

async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), 'shopping selection '));
  t.after(() => rm(value, { force: true, recursive: true }));
  return value;
}

test('selection plans reject executable fields and malformed choices without reflecting raw inputs', async t => {
  const root = await directory(t);
  const filename = path.join(root, 'plan.json');
  for (const value of [{ schema_version: 1, items: [], token: 'PRIVATE' }, { schema_version: 1, items: [{ binding: 'default', script: 'PRIVATE' }] }]) {
    await writeFile(filename, JSON.stringify(value));
    await assert.rejects(loadSelectionPlan(filename), error => error.code === 'INVALID_SELECTION_PLAN' && !error.message.includes('PRIVATE'));
  }
});

test('selection tasks retain distinct combinations, deduplicate equal ones, and reuse committed results', async t => {
  const root = await directory(t);
  const f = context(); f.bridge.endpoint = 'http://127.0.0.1:19824';
  await saveBinding(root, 'mouse', { schema_version: 1, platform: 'taobao', target, endpoint: f.bridge.endpoint, tab_id: 41, created_at: new Date().toISOString() });
  const plan = path.join(root, 'plan.json');
  await writeFile(plan, JSON.stringify({ schema_version: 1, items: [
    { binding: 'mouse', selection }, { binding: 'mouse', selection },
    { binding: 'mouse', selection: [{ group: '颜色分类', option: '黑色' }] },
  ] }));
  const options = { stateDirectory: root, task: 'selection', bridge: f.bridge, plan };
  const created = await createTask(options);
  assert.equal(created.products, 1);
  assert.equal(created.operations, 2);
  const result = await runTask(options, { now: f.now, wait: f.wait });
  assert.equal(result.status, 'complete');
  assert.equal(result.completed, 2);
  assert.equal(f.calls.filter(call => call.type === 'click').length, 2);
  const before = f.calls.length;
  assert.equal((await runTask(options, { now: f.now, wait: f.wait })).completed, 2);
  assert.equal((await taskStatus(options)).completed, 2);
  assert.equal(f.calls.length, before);
  const saved = JSON.parse(await readFile(path.join(root, 'tasks', 'selection.json'), 'utf8'));
  assert.equal(saved.kind, 'product_selection');
  assert.equal(saved.operations[0].selection_state.dispatches.length, 1);
});

test('a selection state conflict stops the platform queue without retries or a replacement task', async t => {
  const root = await directory(t);
  const f = context();
  f.bridge.endpoint = 'http://127.0.0.1:19824';
  const read = f.bridge.readProduct;
  f.bridge.readProduct = async () => {
    const value = await read();
    value.specification_groups[0].options.forEach(option => { option.selected = true; });
    return value;
  };
  await saveBinding(root, 'mouse', { schema_version: 1, platform: 'taobao', target,
    endpoint: f.bridge.endpoint, tab_id: 41, created_at: new Date().toISOString() });
  const plan = path.join(root, 'plan.json');
  await writeFile(plan, JSON.stringify({ schema_version: 1, items: [
    { binding: 'mouse', selection }, { binding: 'mouse', selection: [{ group: '颜色分类', option: '黑色' }] },
  ] }));
  const options = { stateDirectory: root, task: 'conflict', bridge: f.bridge, plan };
  await createTask(options);
  const result = await runTask(options, { now: f.now, wait: f.wait });
  assert.equal(result.status, 'stopped');
  assert.equal(result.operations[0].error.code, 'SELECTION_STATE_CONFLICT');
  assert.equal(result.operations[0].error.category, 'diagnostic');
  assert.equal(result.operations[1].attempts, 0);
  assert.equal(result.automatic_retries, 0);
  assert.equal(f.calls.length, 1);
  assert.equal((await taskStatus(options)).status, 'stopped');
  await runTask(options, { now: f.now, wait: f.wait });
  assert.equal(f.calls.length, 1);
  await assert.rejects(createTask({ ...options, task: 'new-name' }), { code: 'PLATFORM_TASK_UNFINISHED' });
});
