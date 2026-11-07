import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOfferNotices } from '../lib/offer-notices.mjs';
import { validateDetails, validateSavedDetails } from '../lib/details.mjs';
import { rawDetails } from '../test-support/detail-fixture.mjs';
import { parseProductUrl } from '../lib/targets.mjs';

const notices = (text = '有货') => ({ schema_version: 1, observed: true, labels_seen: 1,
  labels: [{ text, text_truncated: false }] });
const withNotices = () => {
  const raw = rawDetails(); raw.details.purchase = notices();
  raw.details.shipping.dispatch = notices('48小时内发货'); return raw;
};

test('purchase and dispatch labels retain original wording without inventory, SKU or arrival guarantees', () => {
  const raw = withNotices(), target = parseProductUrl(raw.url);
  const result = validateDetails(raw, target); validateSavedDetails(result, target);
  const purchase = result.details.purchase, dispatch = result.details.shipping.dispatch;
  assert.equal(purchase.labels[0].text, '有货'); assert.equal(purchase.stock_quantity, null);
  assert.equal(purchase.purchase_limit, null); assert.equal(purchase.sku_id, null);
  assert.equal(purchase.availability_verified, false);
  assert.equal(dispatch.labels[0].text, '48小时内发货'); assert.equal(dispatch.arrival_time, null);
  assert.equal(dispatch.address_read, false); assert.equal(dispatch.conditions_verified, false);
});

test('notice sources and scope cannot acquire stronger claims in raw or saved results', () => {
  const raw = withNotices(), target = parseProductUrl(raw.url), result = validateDetails(raw, target);
  for (const [kind, mutations] of [['purchase', [v => { v.stock_quantity = 1; }, v => { v.sku_id = '999'; },
    v => { v.availability_verified = true; }, v => { v.purchase_limit = 10; }]],
  ['dispatch', [v => { v.arrival_time = 'tomorrow'; }, v => { v.address_read = true; }, v => { v.conditions_verified = true; }]]]) {
    for (const mutate of [...mutations, v => { v.source = 'unknown'; }, v => { v.labels_returned = 2; }]) {
      const value = structuredClone(result), block = kind === 'purchase' ? value.details.purchase : value.details.shipping.dispatch;
      mutate(block); assert.throws(() => normalizeOfferNotices(block, kind), { code: 'INVALID_RESPONSE' });
      assert.throws(() => validateSavedDetails(value, target), { code: 'INVALID_CHECKPOINT' });
    }
  }
});

test('missing regions, empty observed regions and absent historical fields remain distinct', () => {
  for (const observed of [false, true]) {
    const value = normalizeOfferNotices({ schema_version: 1, observed, labels_seen: 0, labels: [] }, 'purchase');
    assert.equal(value.observed, observed); assert.equal(value.labels.length, 0); assert.equal(value.stock_quantity, null);
  }
  const raw = rawDetails(), target = parseProductUrl(raw.url);
  for (const version of [1, 2]) {
    const result = validateDetails(raw, target); result.details.schema_version = version;
    if (version === 1) delete result.details.availability;
    const before = JSON.stringify(result); validateSavedDetails(result, target);
    assert.equal(JSON.stringify(result), before); assert.equal(result.details.purchase, undefined);
    assert.equal(result.details.shipping.dispatch, undefined);
    if (version === 1) {
      result.details.purchase = normalizeOfferNotices(notices(), 'purchase');
      assert.throws(() => validateSavedDetails(result, target), { code: 'INVALID_CHECKPOINT' });
    }
  }
});

test('long and repeated labels retain ordering, truncation and omitted counts through caches', () => {
  const raw = withNotices(), target = parseProductUrl(raw.url);
  raw.details.purchase.labels_seen = 7;
  raw.details.purchase.labels = Array.from({ length: 5 }, () => ({ text: 'x'.repeat(199) + ' ', text_truncated: true }));
  const result = validateDetails(raw, target); validateSavedDetails(result, target);
  assert.equal(result.details.purchase.labels_omitted, 2);
  assert.equal(result.details.purchase.labels.length, 5);
  assert.equal(result.details.purchase.labels[0].text_truncated, true);
});

test('bad notice bounds, unknown fields and missing dispatch parent evidence are rejected', () => {
  for (const mutate of [v => { v.observed = false; }, v => { v.labels_seen = 2; }, v => { v.labels_seen = -1; },
    v => { v.extra = 'unknown'; }, v => { v.labels[0].text = ''; }, v => { v.labels[0].text = 'x'.repeat(201); },
    v => { v.labels[0].extra = true; }, v => { v.limits = null; }, v => { v.limits = { labels: 6, label_characters: 200 }; }]) {
    const value = notices(); mutate(value);
    assert.throws(() => normalizeOfferNotices(value, 'purchase'), { code: 'INVALID_RESPONSE' });
  }
  const raw = withNotices(); raw.details.shipping.dispatch.observed = false;
  raw.details.shipping.dispatch.labels_seen = 0; raw.details.shipping.dispatch.labels = [];
  assert.throws(() => validateDetails(raw, parseProductUrl(raw.url)), { code: 'INVALID_RESPONSE' });
});
