import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateCartRows, validateCartBatch, validateSavedCartRows, validateSavedCartBatch } from '../lib/cart-rows.mjs';
import { cartCollectionPlan, cartCollectionResult, newCartCollection, validateCartCollection } from '../lib/cart-collection.mjs';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { newCartReadState } from '../lib/cart-read.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { cartRow, observeCart } from '../test-support/cart-fixture.mjs';

const target = {url:'https://cart.taobao.com/cart.htm'};
const observedAt = '2026-10-10T00:00:00Z';
const firstPlan = {start:1, limit:5, loaded_rows_seen:null, guards:[]};
function emptyEvidence() {
  return {scope:'current_list_view', basis:'explicit_empty_notice', message:{text:'购物车中没有商品', truncated:false},
    list_root_count:1, notice_count:1, notice_visible:true, notice_within_list:true, document_ready:true, gates_clear:true};
}
function emptyRaw(plan = null) {
  return {state:'observed_empty', url:target.url, source:'trade_cart_item_info_dom', observed_at:observedAt,
    loaded_rows_seen:0, rows:[], empty_evidence:emptyEvidence(),
    ...(plan ? {start:plan.start,limit:plan.limit,prefix:plan.guards} : {})};
}
function firstNonempty() {
  const rows = Array.from({length:6}, (_, index) => cartRow(index + 1).row);
  return validateCartBatch(observeCart(rows, {plan:firstPlan}), target, firstPlan);
}
function freeze(value) {
  if (value && typeof value === 'object') {Object.freeze(value); Object.values(value).forEach(freeze);}
  return value;
}

test('explicit current-view empty cart has versioned evidence and no full-account or total claim', () => {
  const raw = freeze(emptyRaw()), saved = validateCartRows(raw, target);
  assert.equal(saved.schema_version,3);
  assert.deepEqual(saved.rows,[]);
  assert.deepEqual(saved.empty_evidence,raw.empty_evidence);
  assert.equal(saved.observed_at,observedAt);
  assert.equal(saved.coverage.empty_cart_verified,true);
  assert.equal(saved.coverage.status,'partial');
  for (const field of ['loaded_rows_seen','returned_rows','rows_omitted']) assert.equal(saved.coverage[field],0);
  assert.equal(saved.coverage.page_total_rows,null);
  for (const field of ['full_cart','account_identity_verified','row_id_verified','shop_name_verified','display_price_kind_verified','payment_verified']) {
    assert.equal(saved.coverage[field],false);
  }
  assert.equal(saved.range,undefined);
  assert.equal(validateSavedCartRows(saved,target),saved);
  saved.empty_evidence.message.text = '独立副本';
  assert.equal(raw.empty_evidence.message.text,'购物车中没有商品');
});

test('a verified empty first batch ends the loaded range without consuming another batch', () => {
  const saved = validateCartBatch(emptyRaw(firstPlan), target, firstPlan);
  assert.equal(saved.schema_version,3);
  assert.deepEqual(saved.range,{start:1,limit:5});
  assert.deepEqual(saved.prefix_guard,{positions_checked:0,observed_values_match:true,physical_row_identity_verified:false});
  assert.equal(validateSavedCartBatch(saved,target,firstPlan),saved);
  const state = newCartCollection(); state.batches.push({attempt:1,snapshot:saved});
  assert.equal(cartCollectionPlan(state,10),null);
  const result = cartCollectionResult(state,target,10);
  assert.equal(result.schema_version,3);
  assert.deepEqual(result.empty_evidence,saved.empty_evidence);
  assert.equal(result.requested_rows,10);
  assert.equal(result.coverage.empty_cart_verified,true);
  assert.equal(result.coverage.requested_loaded_range_read,true);
  assert.equal(result.coverage.requested_limit_reached,false);
  assert.equal(result.coverage.full_cart,false);
  assert.equal(result.coverage.page_total_rows,null);
  const op = {cart_read:newCartReadState(10),attempts:1,status:'succeeded',result,error:null};
  assert.doesNotThrow(() => validateCartCollection(state,target,op,'complete'));
});

test('zero rows alone, unsupported DOM and known gates cannot become verified empty evidence', () => {
  const dom = observeCart([]);
  assert.equal(dom.state,'structure_changed');
  assert.throws(() => validateCartRows(dom,target),{code:'PAGE_STRUCTURE_CHANGED'});
  const withoutEvidence = emptyRaw(); delete withoutEvidence.empty_evidence;
  assert.throws(() => validateCartRows(withoutEvidence,target),{code:'INVALID_RESPONSE'});
  const ambiguous = emptyRaw(); ambiguous.state = 'observed'; delete ambiguous.empty_evidence;
  assert.throws(() => validateCartRows(ambiguous,target),{code:'INVALID_RESPONSE'});
  for (const [state,code] of [['loading','PAGE_LOADING'],['login_required','LOGIN_REQUIRED'],
    ['verification_required','VERIFICATION_REQUIRED'],['rate_limited','RATE_LIMITED']]) {
    assert.throws(() => validateCartRows({state},target),{code});
  }
});

test('empty evidence rejects altered scope, ambiguous counts, hidden notices, clipping and unsafe text', () => {
  for (const change of [value => value.scope = 'account', value => value.basis = 'zero_rows',
    value => value.list_root_count = 0, value => value.list_root_count = 2, value => value.notice_count = 2,
    value => value.notice_count = 1.5, value => value.notice_visible = false, value => value.notice_within_list = false,
    value => value.document_ready = false, value => value.gates_clear = false, value => value.account_id = 'PRIVATE',
    value => value.message.text = '', value => value.message.text = ' 空 ', value => value.message.text = 'x'.repeat(501),
    value => value.message.text = '空\n状态', value => value.message.truncated = true, value => value.message.private = 'PRIVATE',
    value => value.message = null]) {
    const raw = emptyRaw(); change(raw.empty_evidence);
    assert.throws(() => validateCartRows(raw,target),{code:'INVALID_RESPONSE'});
  }
});

test('empty raw response rejects contradictory rows, counts, source, timestamps and extra fields', () => {
  for (const change of [value => value.rows = [cartRow().row], value => value.loaded_rows_seen = 1,
    value => value.loaded_rows_seen = null, value => value.source = 'unrelated_region', value => value.observed_at = 'unknown',
    value => value.account = 'PRIVATE', value => value.state = 'empty']) {
    const raw = emptyRaw(); change(raw);
    assert.throws(() => validateCartRows(raw,target),{code:'INVALID_RESPONSE'});
  }
  assert.throws(() => validateCartRows(emptyRaw(),{url:'https://example.test/'}),{code:'INVALID_TARGET'});
});

test('saved empty cart validation reconstructs evidence and rejects invented coverage or format claims', () => {
  const snapshot = validateCartRows(emptyRaw(),target);
  for (const change of [value => value.schema_version = 1, value => value.schema_version = 2,
    value => delete value.empty_evidence, value => value.empty_evidence.notice_visible = false,
    value => value.coverage.empty_cart_verified = false, value => value.coverage.full_cart = true,
    value => value.coverage.account_identity_verified = true, value => value.coverage.page_total_rows = 0,
    value => value.coverage.status = 'complete', value => value.coverage.returned_rows = 1,
    value => value.rows = [cartRow().row], value => value.private = 'PRIVATE']) {
    const altered = structuredClone(snapshot); change(altered);
    assert.throws(() => validateSavedCartRows(altered,target),{code:'INVALID_CHECKPOINT'});
  }
  const batch = validateCartBatch(emptyRaw(firstPlan),target,firstPlan);
  for (const change of [value => value.range.start = 2, value => value.range.limit = 3,
    value => value.prefix_guard.positions_checked = 1, value => value.prefix_guard.physical_row_identity_verified = true]) {
    const altered = structuredClone(batch); change(altered);
    assert.throws(() => validateSavedCartBatch(altered,target,firstPlan),{code:'INVALID_CHECKPOINT'});
  }
});

test('a later empty cart is a continuity failure and keeps the previously saved rows', () => {
  const state = freeze({schema_version:1,batches:[{attempt:1,snapshot:firstNonempty()}]});
  const before = JSON.stringify(state), plan = cartCollectionPlan(state,6);
  assert.equal(plan.start,6);
  assert.throws(() => validateCartBatch(emptyRaw(plan),target,plan),{code:'CART_ROWS_CHANGED'});
  assert.equal(JSON.stringify(state),before);
  const saved = validateCartBatch(emptyRaw(firstPlan),target,firstPlan);
  assert.throws(() => validateSavedCartBatch(saved,target,plan),{code:'INVALID_CHECKPOINT'});
});

test('collection checkpoints reject empty rows without evidence, second empty batches and claimed full cart', () => {
  const saved = validateCartBatch(emptyRaw(firstPlan),target,firstPlan);
  const state = {schema_version:1,batches:[{attempt:1,snapshot:saved}]};
  const op = {cart_read:newCartReadState(10),attempts:1,status:'succeeded',result:cartCollectionResult(state,target,10),error:null};
  for (const change of [value => value.batches[0].snapshot.schema_version = 2,
    value => delete value.batches[0].snapshot.empty_evidence, value => value.batches.push({attempt:2,snapshot:saved})]) {
    const altered = structuredClone(state); change(altered);
    assert.throws(() => validateCartCollection(altered,target,{...op,attempts:2},'complete'),{code:'INVALID_CHECKPOINT'});
  }
  const altered = structuredClone(op); altered.result.coverage.full_cart = true;
  assert.throws(() => validateCartCollection(state,target,altered,'complete'),{code:'INVALID_CHECKPOINT'});
});

test('formal empty collection completes one reserved read and subsequent requests return unchanged cache', async t => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(),'cart empty contract '));
  t.after(() => rm(stateDirectory,{recursive:true,force:true}));
  let reads = 0; const waits = [];
  const bridge = {endpoint:'http://127.0.0.1:19824', async requireConnected() {},
    async listTabs() {return [{id:41,url:target.url}];},
    async readCartBatch(id, expected, plan) {reads++; return validateCartBatch(emptyRaw(plan),expected,plan);}};
  const options = {stateDirectory,task:'empty-cart',cart:true,cartRows:10,tabId:41,bridge};
  const clock = {now:() => Date.parse(observedAt),wait:async ms => {waits.push(ms);}};
  await createTask(options);
  const report = await runTask(options,clock), filename = path.join(stateDirectory,'tasks','empty-cart.json');
  assert.equal(report.status,'complete');
  assert.equal(report.operations[0].attempts,1);
  assert.equal(report.operations[0].cart_budget.read_limit,4);
  assert.equal(report.operations[0].cart_budget.recoveries_reserved,0);
  assert.equal(report.operations[0].result.coverage.empty_cart_verified,true);
  assert.deepEqual(report.operations[0].result.rows,[]);
  const before = await readFile(filename);
  bridge.requireConnected = async () => {throw Error('Unexpected browser access after completion');};
  assert.deepEqual(await runTask({...options,nextBatch:true},clock),report);
  assert.deepEqual(await taskStatus(options),report);
  assert.deepEqual(await readFile(filename),before);
  assert.equal((await loadTask(stateDirectory,'empty-cart')).status,'complete');
  assert.equal(reads,1);
  assert.deepEqual(waits,[]);
});

test('formal first-five empty snapshot completes without requesting continuation or restoring a budget', async t => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(),'cart empty snapshot '));
  t.after(() => rm(stateDirectory,{recursive:true,force:true}));
  let reads = 0;
  const bridge = {endpoint:'http://127.0.0.1:19824',async requireConnected() {},
    async listTabs() {return [{id:41,url:target.url}];},
    async readCartRows(id, expected) {reads++; return validateCartRows(emptyRaw(),expected);}};
  const options = {stateDirectory,task:'empty-cart-snapshot',cart:true,tabId:41,bridge};
  await createTask(options);
  const report = await runTask(options,{now:() => Date.parse(observedAt),wait:async () => {throw Error('Unexpected wait');}});
  assert.equal(report.status,'complete');
  assert.equal(report.operations[0].result.schema_version,3);
  assert.equal(report.operations[0].result.coverage.empty_cart_verified,true);
  assert.equal(report.operations[0].cart_budget.read_limit,6);
  assert.equal(report.operations[0].attempts,1);
  assert.equal(report.operations[0].cart_budget.recoveries_reserved,0);
  const before = await readFile(path.join(stateDirectory,'tasks','empty-cart-snapshot.json'));
  assert.deepEqual(await taskStatus(options),report);
  assert.deepEqual(await readFile(path.join(stateDirectory,'tasks','empty-cart-snapshot.json')),before);
  assert.equal(reads,1);
});

test('formal later empty response stops once while preserving the original successful batch and budget', async t => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(),'cart later empty '));
  t.after(() => rm(stateDirectory,{recursive:true,force:true}));
  let reads = 0, time = Date.parse(observedAt);
  const bridge = {endpoint:'http://127.0.0.1:19824',async requireConnected() {},
    async listTabs() {return [{id:41,url:target.url}];},
    async readCartBatch(id,expected,plan) {
      reads++;
      return reads === 1 ? firstNonempty() : validateCartBatch(emptyRaw(plan),expected,plan);
    }};
  const options = {stateDirectory,task:'later-empty-cart',cart:true,cartRows:6,tabId:41,bridge};
  const clock = {now:() => time,wait:async ms => {time += ms;}};
  await createTask(options);
  const first = await runTask(options,clock), firstBatch = structuredClone(first.operations[0].cart_collection.batches[0]);
  assert.equal(first.status,'awaiting_batch');
  const report = await runTask({...options,nextBatch:true},clock), op = report.operations[0];
  assert.equal(report.status,'stopped');
  assert.equal(op.error.code,'CART_ROWS_CHANGED');
  assert.equal(op.attempts,2);
  assert.equal(report.automatic_retries,0);
  assert.equal(op.cart_budget.read_limit,4);
  assert.equal(op.cart_budget.recoveries_reserved,0);
  assert.deepEqual(op.cart_collection.batches,[firstBatch]);
  assert.equal(op.cart_collection.rows.length,5);
  assert.equal(op.result,null);
  const before = await readFile(path.join(stateDirectory,'tasks','later-empty-cart.json'));
  assert.deepEqual(await runTask({...options,nextBatch:true},clock),report);
  assert.deepEqual(await readFile(path.join(stateDirectory,'tasks','later-empty-cart.json')),before);
  assert.equal(reads,2);
});

test('legacy nonempty snapshots and batches retain their existing versions and structure', () => {
  const rows = [cartRow().row];
  const legacy = {availability:false};
  const snapshot = validateCartRows(observeCart(rows,legacy),target,legacy);
  const batch = validateCartBatch(observeCart(rows,{plan:firstPlan,...legacy}),target,firstPlan,legacy);
  assert.equal(snapshot.schema_version,1); assert.equal(batch.schema_version,2);
  assert.equal(snapshot.rows[0].availability,undefined); assert.equal(batch.rows[0].availability,undefined);
  assert.equal(snapshot.empty_evidence,undefined); assert.equal(batch.empty_evidence,undefined);
  assert.equal(snapshot.coverage.empty_cart_verified,false);
  assert.equal(validateSavedCartRows(snapshot,target),snapshot);
  assert.equal(validateSavedCartBatch(batch,target,firstPlan),batch);
});
