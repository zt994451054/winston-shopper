import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeCartAvailability, cartAvailabilitySummary } from '../lib/cart-availability.mjs';
import { validateCartRows, validateCartBatch, validateSavedCartRows, validateSavedCartBatch } from '../lib/cart-rows.mjs';
import { newCartCollection, cartCollectionPlan, cartCollectionResult, validateCartCollection } from '../lib/cart-collection.mjs';
import { newCartReadState } from '../lib/cart-read.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { loadTask, withTaskStore } from '../lib/task-store.mjs';
import { buildCachedReport, renderCachedReport } from '../lib/cached-report.mjs';
import { cartRow, cartNode, observeCart } from '../test-support/cart-fixture.mjs';

const target = {url:'https://cart.taobao.com/cart.htm'};
const firstPlan = limit => ({start:1, limit, loaded_rows_seen:null, guards:[]});
// The five live layouts of 2026-10-13: normal, variant out of stock and three cannot-buy reasons.
const liveRows = () => [
  cartRow(1),
  cartRow(2, {availability:'variant_out_of_stock'}),
  cartRow(3, {availability:'cannot_buy'}),
  cartRow(4, {availability:'cannot_buy', imageText:'不可购买', message:'商品库存不足'}),
  cartRow(5, {availability:'cannot_buy', imageText:'不可购买', message:'店铺已关闭，宝贝不能购买，请谅解'}),
];
const signals = (overrides = {}) => ({image_texts:{items:[], truncated:false}, messages:{items:[], truncated:false},
  checkboxes:{items:[{disabled:false}], truncated:false}, specification_invalid:false, price_invalid:false, quantity_disabled:false, ...overrides});
const text = value => ({text:value, truncated:false});
function append(parent, ...nodes) {
  for (const node of nodes) { node.parentElement = parent; parent.children.push(node); }
}

test('the live marker layouts classify as cannot buy, variant out of stock or no marker seen, keeping raw texts', () => {
  const snapshot = validateCartRows(observeCart(liveRows().map(item => item.row)), target);
  assert.equal(snapshot.schema_version, 4);
  assert.deepEqual(snapshot.rows.map(row => row.availability.status),
    ['no_marker_seen', 'variant_out_of_stock', 'cannot_buy', 'cannot_buy', 'cannot_buy']);
  assert.deepEqual(snapshot.rows.map(row => row.availability.reason?.text ?? null),
    [null, null, '宝贝已不能购买', '商品库存不足', '店铺已关闭，宝贝不能购买，请谅解']);
  assert.deepEqual(snapshot.rows.map(row => row.availability.signals.image_texts.items.map(item => item.text)),
    [[], ['款式缺货'], ['商品下架'], ['不可购买'], ['不可购买']]);
  assert.ok(snapshot.rows.every(row => row.availability.purchase_verified === false));
  assert.deepEqual(snapshot.availability_summary, {cannot_buy:3, variant_out_of_stock:1, no_marker_seen:1, unrecognized:0});
  assert.deepEqual(snapshot.rows[2].availability.signals, {image_texts:{items:[text('商品下架')], truncated:false},
    messages:{items:[text('宝贝已不能购买')], truncated:false}, checkboxes:{items:[{disabled:true}], truncated:false},
    specification_invalid:true, price_invalid:true, quantity_disabled:true});
  // Quantity and price reading are unchanged on unavailable rows.
  assert.ok(snapshot.rows.every(row => row.quantity.value === 1 && row.price_region_observations.items.length === 1));
  assert.equal(validateSavedCartRows(snapshot, target), snapshot);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'), 'checkbox values and tracking parameters stay unread');
});

test('combinations outside the live layouts stay unrecognized instead of being guessed', () => {
  const cases = [
    signals({checkboxes:{items:[{disabled:true}], truncated:false}}),
    signals({checkboxes:{items:[], truncated:false}}),
    signals({checkboxes:{items:[{disabled:false}, {disabled:false}], truncated:false}}),
    signals({price_invalid:true}),
    signals({image_texts:null}),
    signals({messages:null}),
    signals({price_invalid:null}),
    signals({image_texts:{items:[text('款式缺货')], truncated:false}, checkboxes:{items:[{disabled:true}], truncated:false}, price_invalid:true,
      messages:{items:[text('宝贝已不能购买')], truncated:false}}),
    signals({image_texts:{items:[text('款式缺货')], truncated:false}, checkboxes:{items:[{disabled:true}], truncated:false},
      price_invalid:true, specification_invalid:true, quantity_disabled:true, messages:{items:[text('宝贝已不能购买')], truncated:false}}),
    signals({image_texts:{items:[text('商品下架')], truncated:false}, checkboxes:{items:[{disabled:true}], truncated:false},
      price_invalid:true, specification_invalid:true, quantity_disabled:true}),
    signals({image_texts:{items:[text('商品下架')], truncated:false}, checkboxes:{items:[{disabled:true}], truncated:false},
      price_invalid:true, specification_invalid:true, quantity_disabled:true, messages:{items:[{text:'宝贝已不能', truncated:true}], truncated:false}}),
    signals({image_texts:{items:[text('商品下架')], truncated:false}, checkboxes:{items:[{disabled:true}], truncated:false},
      price_invalid:true, specification_invalid:false, quantity_disabled:true, messages:{items:[text('宝贝已不能购买')], truncated:false}}),
  ];
  for (const value of cases) {
    for (const rules of [1, 2]) {
      const result = normalizeCartAvailability(value, {rules});
      assert.equal(result.status, 'unrecognized', JSON.stringify(value));
      assert.equal(result.reason, null);
      assert.deepEqual(result.signals, value);
    }
  }
});

test('rule 2 accepts promotional overlay text on an enabled unmarked row and keeps the text', () => {
  const promotion = signals({image_texts:{items:[text('全网低价')], truncated:false}});
  assert.deepEqual(normalizeCartAvailability(promotion), {status:'no_marker_seen', reason:null, classification_version:2,
    signals:promotion, purchase_verified:false});
  // Rule 1 results keep their original shape, without a classification_version.
  assert.deepEqual(normalizeCartAvailability(promotion, {rules:1}), {status:'unrecognized', reason:null, signals:promotion, purchase_verified:false});
  assert.equal(normalizeCartAvailability(signals()).classification_version, 2);
  for (const value of [
    signals({image_texts:{items:[text('商品下架')], truncated:false}}),
    signals({image_texts:{items:[text('全网低价'), text('不可购买')], truncated:false}}),
    signals({image_texts:{items:[text('款式缺货')], truncated:false}}),
    signals({image_texts:{items:[{text:'全网低', truncated:true}], truncated:false}}),
    signals({image_texts:{items:Array.from({length:5}, () => text('全网低价')), truncated:true}}),
    signals({image_texts:{items:[text('全网低价')], truncated:false}, checkboxes:{items:[{disabled:true}], truncated:false}}),
    signals({image_texts:{items:[text('全网低价')], truncated:false}, price_invalid:true}),
    signals({image_texts:{items:[text('全网低价')], truncated:false}, messages:{items:[text('宝贝已不能购买')], truncated:false}}),
  ]) assert.equal(normalizeCartAvailability(value).status, 'unrecognized', JSON.stringify(value));
  for (const rules of [0, 3, '2', null]) assert.throws(() => normalizeCartAvailability(signals(), {rules}), {code:'INVALID_RESPONSE'});
});

test('snapshots saved under rule 1 revalidate with rule 1, and rules cannot be swapped or mixed', () => {
  const rows = () => [cartRow(1, {imageText:'全网低价'}).row, cartRow(2).row];
  const old = validateCartRows(observeCart(rows()), target, {availabilityRules:1});
  assert.deepEqual(old.rows.map(row => [row.availability.status, row.availability.classification_version]),
    [['unrecognized', undefined], ['no_marker_seen', undefined]]);
  assert.equal(validateSavedCartRows(old, target), old);
  const current = validateCartRows(observeCart(rows()), target);
  assert.deepEqual(current.rows.map(row => [row.availability.status, row.availability.classification_version]),
    [['no_marker_seen', 2], ['no_marker_seen', 2]]);
  assert.deepEqual(current.availability_summary, {cannot_buy:0, variant_out_of_stock:0, no_marker_seen:2, unrecognized:0});
  assert.equal(validateSavedCartRows(current, target), current);
  for (const change of [value => { value.rows[0].availability.classification_version = 2; },
    value => { value.rows[0].availability.status = 'no_marker_seen'; value.availability_summary = current.availability_summary; },
    value => { value.rows[1].availability = current.rows[1].availability; },
    value => { value.rows[0].availability.classification_version = 1; }]) {
    const copy = structuredClone(old); change(copy);
    assert.throws(() => validateSavedCartRows(copy, target), {code:'INVALID_CHECKPOINT'});
  }
  const downgraded = structuredClone(current);
  for (const row of downgraded.rows) delete row.availability.classification_version;
  assert.throws(() => validateSavedCartRows(downgraded, target), {code:'INVALID_CHECKPOINT'});
});

test('missing image, detail or price regions leave their signals null and the row unrecognized', () => {
  const noImage = cartRow(1); noImage.row.children.splice(0, 1);
  const noPrice = cartRow(2); noPrice.priceQuantity.children.splice(0, 1);
  const hiddenMessage = cartRow(3, {availability:'cannot_buy'});
  hiddenMessage.detail.children[1].children[0].hidden = true;
  const snapshot = validateCartRows(observeCart([noImage.row, noPrice.row, hiddenMessage.row]), target);
  assert.equal(snapshot.rows[0].availability.signals.image_texts, null);
  assert.equal(snapshot.rows[1].availability.signals.price_invalid, null);
  assert.deepEqual(snapshot.rows[2].availability.signals.messages, {items:[], truncated:false});
  assert.deepEqual(snapshot.rows.map(row => row.availability.status), ['unrecognized', 'unrecognized', 'unrecognized']);
  assert.equal(validateSavedCartRows(snapshot, target), snapshot);
});

test('notices are read only from their own row regions and bounded', () => {
  const item = cartRow(1);
  // An overlay-like text outside the image region and a message outside the detail region are not row notices.
  append(item.row, cartNode('imageTxt--fixture', '商品下架'), cartNode('msgWrapper--fixture', '宝贝已不能购买'));
  const many = cartRow(2, {availability:'cannot_buy'});
  append(many.detail.children[1], ...Array.from({length:5}, () => cartNode('msgWrapper--fixture', '另一条提示')));
  const snapshot = validateCartRows(observeCart([item.row, many.row]), target);
  assert.equal(snapshot.rows[0].availability.status, 'no_marker_seen');
  assert.deepEqual(snapshot.rows[0].availability.signals.image_texts.items, []);
  assert.equal(snapshot.rows[1].availability.signals.messages.items.length, 5);
  assert.equal(snapshot.rows[1].availability.signals.messages.truncated, true);
  assert.equal(snapshot.rows[1].availability.status, 'unrecognized');
});

test('malformed availability evidence is rejected, and saved statuses cannot be altered', () => {
  for (const value of [undefined, {...signals(), extra:true}, signals({price_invalid:'yes'}),
    signals({checkboxes:{items:[{disabled:true, value:'PRIVATE'}], truncated:false}}),
    signals({image_texts:{items:Array.from({length:6}, () => text('x')), truncated:true}}),
    signals({messages:{items:[text('x'.repeat(201))], truncated:false}})]) {
    assert.throws(() => normalizeCartAvailability(value), {code:'INVALID_RESPONSE'});
  }
  const raw = observeCart([cartRow(1).row]);
  delete raw.rows[0].availability;
  assert.throws(() => validateCartRows(raw, target), {code:'INVALID_RESPONSE'});
  assert.throws(() => validateCartRows(observeCart([cartRow(1).row]), target, {availability:false}), {code:'INVALID_RESPONSE'});
  const snapshot = validateCartRows(observeCart(liveRows().map(item => item.row)), target);
  for (const change of [value => { value.rows[0].availability.status = 'cannot_buy'; },
    value => { value.rows[2].availability.reason.text = '其他原因'; },
    value => { value.rows[1].availability.purchase_verified = true; },
    value => { delete value.rows[0].availability; },
    value => { value.availability_summary.cannot_buy = 0; },
    value => { delete value.availability_summary; },
    value => { value.schema_version = 1; }]) {
    const copy = structuredClone(snapshot); change(copy);
    assert.throws(() => validateSavedCartRows(copy, target), {code:'INVALID_CHECKPOINT'});
  }
  assert.deepEqual(cartAvailabilitySummary([]), {cannot_buy:0, variant_out_of_stock:0, no_marker_seen:0, unrecognized:0});
});

test('a new collection keeps availability across batches and sums it in the result', () => {
  const items = Array.from({length:7}, (_, index) => cartRow(index + 1, {availability:index % 3 === 1 ? 'variant_out_of_stock' : index % 3 === 2 ? 'cannot_buy' : 'normal'}));
  const state = newCartCollection();
  assert.equal(state.schema_version, 3);
  for (let attempt = 1; ; attempt++) {
    const plan = cartCollectionPlan(state, 7);
    if (!plan) break;
    const snapshot = validateCartBatch(observeCart(items.map(item => item.row), {plan}), target, plan);
    assert.equal(snapshot.schema_version, 5);
    assert.equal(validateSavedCartBatch(snapshot, target, plan), snapshot);
    state.batches.push({attempt, snapshot});
  }
  const result = cartCollectionResult(state, target, 7);
  assert.equal(result.schema_version, 2);
  assert.deepEqual(result.rows.map(row => row.availability.status), ['no_marker_seen', 'variant_out_of_stock', 'cannot_buy',
    'no_marker_seen', 'variant_out_of_stock', 'cannot_buy', 'no_marker_seen']);
  assert.deepEqual(result.availability_summary, {cannot_buy:2, variant_out_of_stock:2, no_marker_seen:3, unrecognized:0});
  const op = {cart_read:{...newCartReadState(7)}, attempts:2, status:'succeeded', result};
  validateCartCollection(state, target, op, 'complete');
  for (const version of [1, 2]) {
    const mixed = {schema_version:version, batches:state.batches};
    assert.throws(() => validateCartCollection(mixed, target, {...op, result:cartCollectionResult(mixed, target, 7)}, 'complete'), {code:'INVALID_CHECKPOINT'});
  }
});

async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), 'cart availability '));
  t.after(() => rm(value, {recursive:true, force:true}));
  return value;
}
function clock() {
  let time = Date.parse('2026-10-13T00:00:00Z');
  return {now:() => time, wait:async ms => { time += ms; }};
}
function bridgeFor(items, options) {
  return {endpoint:'http://127.0.0.1:19824', async requireConnected() {}, async listTabs() { return [{id:41, url:target.url}]; },
    async readCartRows(id, expected) { return validateCartRows(observeCart(items.map(item => item.row)), expected); },
    async readCartBatch(id, expected, plan, received) {
      options.push(received);
      return validateCartBatch(observeCart(items.map(item => item.row), {plan, ...received}), expected, plan, received);
    }};
}

test('new cart tasks save availability, and the report lists each status with its raw reason', async t => {
  const stateDirectory = await directory(t), options = [];
  const base = {stateDirectory, cart:true, tabId:41, bridge:bridgeFor(liveRows(), options)};
  await createTask({...base, task:'cart-snapshot'});
  const snapshot = await runTask({...base, task:'cart-snapshot'}, clock());
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.operations[0].result.schema_version, 4);
  await createTask({...base, task:'cart-rows', cartRows:5});
  const collection = await runTask({...base, task:'cart-rows'}, clock());
  assert.equal(collection.status, 'complete');
  assert.deepEqual(options, [{availability:true, availabilityRules:2}]);
  assert.deepEqual(collection.operations[0].result.availability_summary, {cannot_buy:3, variant_out_of_stock:1, no_marker_seen:1, unrecognized:0});
  const report = buildCachedReport(await loadTask(stateDirectory, 'cart-rows'));
  const records = report.records.filter(record => record.record_type === 'cart_availability');
  assert.deepEqual(records.map(record => [record.item_position, record.label, record.text, record.qualifier, record.disabled]), [
    [1, 'no_marker_seen', null, null, false], [2, 'variant_out_of_stock', null, 'image_text=款式缺货', true],
    [3, 'cannot_buy', '宝贝已不能购买', 'image_text=商品下架', true], [4, 'cannot_buy', '商品库存不足', 'image_text=不可购买', true],
    [5, 'cannot_buy', '店铺已关闭，宝贝不能购买，请谅解', 'image_text=不可购买', true]]);
  assert.ok(records.every(record => record.verified === false));
  assert.equal(report.observations[0].coverage['availability.cannot_buy'], 3);
  assert.equal(report.observations[0].collection_coverage['availability.no_marker_seen'], 1);
  const csv = renderCachedReport(report, 'csv'), markdown = renderCachedReport(report, 'markdown');
  assert.ok(csv.includes('"cart_availability"') && csv.includes('"店铺已关闭，宝贝不能购买，请谅解"'));
  assert.ok(markdown.includes('cart\\_availability') && markdown.includes('collection.availability.cannot\\_buy'));
});

test('a collection started before availability continues in its original shape', async t => {
  const stateDirectory = await directory(t), options = [];
  const items = Array.from({length:7}, (_, index) => cartRow(index + 1));
  const base = {stateDirectory, task:'old-cart', cart:true, cartRows:7, tabId:41, bridge:bridgeFor(items, options)};
  const time = clock();
  await createTask(base);
  await withTaskStore(stateDirectory, 'old-cart', async store => {
    const task = await store.load(); task.operations[0].cart_collection.schema_version = 1; await store.save(task);
  });
  assert.equal((await runTask(base, time)).status, 'awaiting_batch');
  const report = await runTask({...base, nextBatch:true}, time), result = report.operations[0].result;
  assert.equal(report.status, 'complete');
  assert.deepEqual(options, [{availability:false}, {availability:false}]);
  assert.equal(result.schema_version, 1);
  assert.equal(result.availability_summary, undefined);
  assert.ok(result.rows.every(row => row.availability === undefined));
  assert.deepEqual(report.operations[0].cart_collection.batches.map(batch => batch.snapshot.schema_version), [2, 2]);
});

test('an old collection rejects a batch carrying availability instead of mixing shapes', async t => {
  const stateDirectory = await directory(t), items = Array.from({length:3}, (_, index) => cartRow(index + 1));
  const bridge = {...bridgeFor(items, []), async readCartBatch(id, expected, plan) {
    return validateCartBatch(observeCart(items.map(item => item.row), {plan}), expected, plan);
  }};
  const base = {stateDirectory, task:'mixed-cart', cart:true, cartRows:3, tabId:41, bridge};
  await createTask(base);
  await withTaskStore(stateDirectory, 'mixed-cart', async store => {
    const task = await store.load(); task.operations[0].cart_collection.schema_version = 1; await store.save(task);
  });
  const report = await runTask(base, clock());
  assert.equal(report.operations[0].error.code, 'INVALID_RESPONSE');
  assert.deepEqual(report.operations[0].cart_collection.batches, []);
});

test('a collection started under rule 1 finishes with rule 1 and rejects a rule 2 batch', async t => {
  const stateDirectory = await directory(t), options = [];
  const items = [cartRow(1, {imageText:'全网低价'}), ...Array.from({length:6}, (_, index) => cartRow(index + 2))];
  const base = {stateDirectory, task:'rule-1-cart', cart:true, cartRows:7, tabId:41, bridge:bridgeFor(items, options)};
  const time = clock();
  await createTask(base);
  await withTaskStore(stateDirectory, 'rule-1-cart', async store => {
    const task = await store.load(); task.operations[0].cart_collection.schema_version = 2; await store.save(task);
  });
  assert.equal((await runTask(base, time)).status, 'awaiting_batch');
  const report = await runTask({...base, nextBatch:true}, time), result = report.operations[0].result;
  assert.equal(report.status, 'complete');
  assert.deepEqual(options, [{availability:true, availabilityRules:1}, {availability:true, availabilityRules:1}]);
  assert.equal(result.schema_version, 2);
  assert.deepEqual(result.availability_summary, {cannot_buy:0, variant_out_of_stock:0, no_marker_seen:6, unrecognized:1});
  assert.ok(result.rows.every(row => row.availability.classification_version === undefined));
  assert.equal((await loadTask(stateDirectory, 'rule-1-cart')).status, 'complete');

  const current = {...bridgeFor(items, []), async readCartBatch(id, expected, plan) {
    return validateCartBatch(observeCart(items.map(item => item.row), {plan}), expected, plan);
  }};
  const mixed = {stateDirectory, task:'rule-mix-cart', cart:true, cartRows:3, tabId:41, bridge:current};
  await createTask(mixed);
  await withTaskStore(stateDirectory, 'rule-mix-cart', async store => {
    const task = await store.load(); task.operations[0].cart_collection.schema_version = 2; await store.save(task);
  });
  const rejected = await runTask(mixed, clock());
  assert.equal(rejected.operations[0].error.code, 'INVALID_RESPONSE');
  assert.deepEqual(rejected.operations[0].cart_collection.batches, []);
});

test('the report keeps a promotional overlay as a qualifier of a no-marker row', async t => {
  const stateDirectory = await directory(t);
  const base = {stateDirectory, task:'promo-cart', cart:true, tabId:41, bridge:bridgeFor([cartRow(1, {imageText:'全网低价'})], [])};
  await createTask(base);
  assert.equal((await runTask(base, clock())).status, 'complete');
  const report = buildCachedReport(await loadTask(stateDirectory, 'promo-cart'));
  const records = report.records.filter(record => record.record_type === 'cart_availability');
  assert.deepEqual(records.map(record => [record.label, record.qualifier, record.disabled]), [['no_marker_seen', 'image_text=全网低价', false]]);
});
