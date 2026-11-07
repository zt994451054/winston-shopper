import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseProductUrl } from '../lib/targets.mjs';
import { productScript, validateProduct, validateSavedProduct, parseDisplayedPrice } from '../lib/product.mjs';
import { rawProduct } from '../test-support/product-fixture.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');

test('purchase region scope rejects forged coverage and preserves legacy snapshots without inventing exclusions', () => {
  const scope = { schema_version: 1, source: 'scrolling_purchase_panel', excluded_region: 'ItemHeadFixed',
    title_regions_seen: 2, price_regions_seen: 2, excluded_title_regions: 1, excluded_price_regions: 1 };
  const legacy = validateProduct(rawProduct(), target), before = JSON.stringify(legacy);
  assert.equal(JSON.stringify(validateSavedProduct(legacy, target)), before);
  assert.equal(legacy.product_region_scope, undefined);
  const result = validateProduct({ ...rawProduct(), product_region_scope: scope }, target);
  assert.deepEqual(validateSavedProduct(result, target), result);
  for (const invalid of [null, { ...scope, schema_version: 2 }, { ...scope, source: 'guessed' },
    { ...scope, excluded_region: 'Unknown' }, { ...scope, title_regions_seen: 3 },
    { ...scope, excluded_title_regions: 0 }, { ...scope, price_regions_seen: 1 },
    { ...scope, excluded_price_regions: 2 }, { ...scope, extra: true }]) {
    assert.throws(() => validateProduct({ ...rawProduct(), product_region_scope: invalid }, target), { code: 'INVALID_RESPONSE' });
    assert.throws(() => validateSavedProduct({ ...result, product_region_scope: invalid }, target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('empty product fields identify their region while keeping invalid snapshots rejected', () => {
  for (const [mutate, reason] of [
    [raw => { raw.title = ''; }, 'title_empty'],
    [raw => { raw.groups[0].name = ''; }, 'specification_group_name_empty'],
    [raw => { raw.groups[0].options[0].label = ''; }, 'specification_option_label_empty'],
    [raw => { raw.reviews[0].body = ''; }, 'review_preview_body_empty'],
  ]) {
    const raw = rawProduct(); mutate(raw);
    assert.throws(() => validateProduct(raw, target), { code: 'PAGE_STRUCTURE_CHANGED', productStructureReason: reason });
  }
});

test('legacy and unrecognized structure reasons remain generic without echoing untrusted data', () => {
  for (const reason of [undefined, null, 'PRIVATE_PAGE_TEXT', '__proto__', ['title_missing'], { title_missing: true }]) {
    assert.throws(() => validateProduct({ state: 'structure_changed', reason }, target), error => {
      assert.equal(error.code, 'PAGE_STRUCTURE_CHANGED');
      assert.equal(error.productStructureReason, undefined);
      assert.equal(error.message, 'A supported product region is missing or ambiguous.');
      return true;
    });
  }
});

test('specification scope separates returned lists from unobserved SKU combinations and preserves old caches', () => {
  const legacy = validateProduct(rawProduct(), target), before = JSON.stringify(legacy);
  validateSavedProduct(legacy, target);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(legacy.specification_scope, undefined);
  const raw = rawProduct();
  raw.specification_counts = { options_seen: [2], groups_seen: 1, region_observed: true };
  const result = validateProduct(raw, target);
  assert.deepEqual(result.specification_scope, { schema_version: 1, region_observed: true,
    groups_seen: 1, groups_returned: 1, groups_omitted: 0,
    groups: [{ group_index: 1, options_seen: 2, options_returned: 2, options_omitted: 0 }], full_sku_matrix_verified: false });
  assert.equal(result.specification_groups[0].options[1].selected, null);
  assert.equal(result.specification_groups[0].options[1].disabled, true);
  assert.equal(result.specification_groups[0].options[1].sku_id, null);
  assert.deepEqual(validateSavedProduct(result, target), result);
});

test('specification truncation records omitted groups and options without estimating their combinations', () => {
  const raw = rawProduct();
  raw.groups = Array.from({length:8}, (_, index) => ({name:`Group ${index}`,options:Array.from({length:100},(_, i)=>({label:`Option ${i}`,selected:null,disabled:null}))}));
  raw.specification_counts = {region_observed:true,groups_seen:10,options_seen:[102,100,100,100,100,100,100,100]};
  const result = validateProduct(raw,target);
  assert.equal(result.specification_scope.groups_omitted,2);
  assert.equal(result.specification_scope.groups[0].options_omitted,2);
  assert.equal(result.specification_scope.full_sku_matrix_verified,false);
  assert.deepEqual(validateSavedProduct(result,target),result);
});

test('specification scope distinguishes a missing region from an observed region without options', () => {
  for(const observed of [true,false]) {
    const raw=rawProduct();raw.groups=[];
    raw.specification_counts={region_observed:observed,groups_seen:0,options_seen:[]};
    const result=validateProduct(raw,target);
    assert.equal(result.specification_scope.region_observed,observed);
    assert.equal(result.specification_scope.full_sku_matrix_verified,false);
    assert.equal(result.coverage.specifications,'not_observed');
  }
});

test('inconsistent specification counts and inflated cached guarantees are rejected', () => {
  for(const counts of [null,{region_observed:false,groups_seen:1,options_seen:[2]},
    {region_observed:true,groups_seen:2,options_seen:[2]}, {region_observed:true,groups_seen:1,options_seen:[3]},
    {region_observed:true,groups_seen:1,options_seen:[-1]}, {region_observed:true,groups_seen:1,options_seen:[2,2]},
    {region_observed:true,groups_seen:1.5,options_seen:[2]}, {region_observed:true,groups_seen:1,options_seen:[2],extra:true}]) {
    assert.throws(()=>validateProduct({...rawProduct(),specification_counts:counts},target),{code:'INVALID_RESPONSE'});
  }
  const result=validateProduct({...rawProduct(),specification_counts:{region_observed:true,groups_seen:1,options_seen:[2]}},target);
  for(const mutate of [s=>{s.full_sku_matrix_verified=true;},s=>{s.groups_omitted=1;},s=>{s.groups[0].group_index=2;},
    s=>{s.groups[0].options_returned=3;},s=>{s.groups[0].options_omitted=1;},s=>{s.schema_version=2;},s=>{s.extra=true;}]) {
    const changed=structuredClone(result);mutate(changed.specification_scope);
    assert.throws(()=>validateSavedProduct(changed,target),{code:'INVALID_CHECKPOINT'});
  }
});

test('starting prices, ranges and unparseable amounts never become definite payable prices', () => {
  assert.deepEqual(parseDisplayedPrice('￥89', '起'), { kind: 'starting_from', amount: null, minimum: '89', maximum: null });
  assert.deepEqual(parseDisplayedPrice('89.00～179.00', ''), { kind: 'range', amount: null, minimum: '89.00', maximum: '179.00' });
  for (const value of ['179-89', '1e3', '89 券', '89,179', '', 'Infinity', '-2']) {
    assert.equal(parseDisplayedPrice(value, '').kind, 'unparsed');
  }
});

test('snapshot keeps conditions and explicitly leaves SKU mapping, identity and full reviews unverified', () => {
  const result = validateProduct(rawProduct(), target);
  assert.equal(result.prices[0].amount, null);
  assert.equal(result.prices[0].label, '店铺优惠后');
  assert.equal(result.prices[0].sku_price_binding_verified, false);
  assert.equal(result.specification_groups[0].options[0].sku_id, null);
  assert.equal(result.specification_groups[0].options[1].disabled, true);
  assert.equal(result.review_previews[0].review_id, null);
  assert.equal(result.coverage.reviews, 'preview_only');
  assert.equal(result.login_verified, false);
});

test('missing price and review regions remain explicit missing data, not zero price or zero reviews', () => {
  const raw = rawProduct(); raw.prices = []; raw.reviews = [];
  const result = validateProduct(raw, target);
  assert.equal(result.coverage.prices, 'not_observed');
  assert.ok(result.missing.includes('price_region'));
  assert.equal(result.coverage.reviews, 'not_observed');
});

test('untrusted extra fields and reviewer identities are dropped at the response boundary', () => {
  const raw = rawProduct(); raw.token = 'PRIVATE'; raw.reviews[0].username = 'PRIVATE';
  const result = validateProduct(raw, target);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('same-text reviews remain distinct observations without inventing stable review IDs', () => {
  const raw = rawProduct(); raw.reviews.push({ ...raw.reviews[0] });
  assert.equal(validateProduct(raw, target).review_previews.length, 2);
});

test('page gates fail even when a response also contains plausible product data', () => {
  for (const [state, code] of [['verification_required', 'VERIFICATION_REQUIRED'], ['login_required', 'LOGIN_REQUIRED'],
    ['rate_limited', 'RATE_LIMITED'], ['structure_changed', 'PAGE_STRUCTURE_CHANGED']]) {
    assert.throws(() => validateProduct({ ...rawProduct(), state }, target), { code });
  }
});

test('malformed fields and oversized arrays are rejected instead of silently normalizing incorrect records', () => {
  for (const mutate of [raw => { raw.product_id = '456'; }, raw => { raw.groups[0].options[0].label = ''; },
    raw => { raw.prices = new Array(7).fill(raw.prices[0]); }, raw => { raw.groups[0].options[0].selected = 'yes'; },
    raw => { raw.reviews[0].body = 'x'.repeat(2001); }]) {
    const raw = rawProduct(); mutate(raw);
    assert.throws(() => validateProduct(raw, target));
  }
});

test('the in-page identity guard runs before reading any DOM content', () => {
  const document = new Proxy({}, { get() { throw new Error('DOM must not be read'); } });
  const result = vm.runInNewContext(productScript(target), { URL, location: { href: 'https://detail.tmall.com/item.htm?id=999' }, document });
  assert.equal(result.state, 'target_changed');
});

test('URL SKU candidates preserve their source without promoting any selection or price binding', () => {
  const raw = rawProduct();
  raw.sku_url = { status: 'candidate_only', candidate_sku_id: '90071992547409931234', sku_properties_present: false };
  const result = validateProduct(raw, target);
  assert.equal(result.sku_evidence.candidate_sku_id, '90071992547409931234');
  assert.equal(result.sku_evidence.source, 'current_product_url');
  assert.equal(result.sku_evidence.parameter, 'skuId');
  assert.equal(result.sku_evidence.selection_binding_verified, false);
  assert.equal(result.sku_evidence.sku_price_binding_verified, false);
  assert.equal(result.prices[0].sku_id, null);
  assert.equal(result.prices[0].eligibility_verified, false);
  assert.ok(result.missing.includes('verified_sku_price_mapping'));
  assert.ok(result.missing.includes('platform_sku_ids'));
  assert.deepEqual(validateSavedProduct(result, target), result);
});

test('malformed or contradictory SKU evidence is rejected at the response boundary', () => {
  const valid = { status: 'candidate_only', candidate_sku_id: '456', sku_properties_present: false };
  for (const value of [null, { ...valid, candidate_sku_id: '123' }, { ...valid, candidate_sku_id: 456 },
    { ...valid, candidate_sku_id: '1627207:28340' }, { ...valid, candidate_sku_id: '4'.repeat(65) },
    { ...valid, candidate_sku_id: '0' }, { ...valid, status: 'parameter_absent' },
    { ...valid, sku_properties_present: null }, { ...valid, unexpected: true },
    { ...valid, status: 'verified' }]) {
    assert.throws(() => validateProduct({ ...rawProduct(), sku_url: value }, target), { code: 'INVALID_RESPONSE' });
  }
});

test('legacy snapshots remain unchanged and cached SKU evidence cannot be promoted or relabeled', () => {
  const legacy = validateProduct(rawProduct(), target);
  assert.equal(Object.hasOwn(validateSavedProduct(legacy, target), 'sku_evidence'), false);
  const result = validateProduct({ ...rawProduct(), sku_url: {
    status: 'candidate_only', candidate_sku_id: '456', sku_properties_present: false,
  } }, target);
  for (const mutate of [e => { e.source = 'official_api'; }, e => { e.selection_binding_verified = true; },
    e => { e.sku_price_binding_verified = true; }, e => { e.schema_version = 2; },
    e => { e.parameter = 'sku_properties'; }, e => { e.extra = 'unexpected'; }]) {
    const changed = structuredClone(result); mutate(changed.sku_evidence);
    assert.throws(() => validateSavedProduct(changed, target), { code: 'INVALID_CHECKPOINT' });
  }
});
