import test from 'node:test';
import assert from 'node:assert/strict';
import { describeImageReadiness, normalizeImageReadiness, validateImageReadinessMapping } from '../lib/image-readiness.mjs';
import { detailUrl, validateDetails, validateSavedDetails } from '../lib/details.mjs';
import { rawDetails } from '../test-support/detail-fixture.mjs';
import { parseProductUrl } from '../lib/targets.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const url = value => detailUrl(value, 'image');
const image = (patch = {}) => ({ url: 'https://img.alicdn.com/example.jpg', loaded: true, width: 800, height: 800, ...patch });
const region = items => ({ observed: true, elements_seen: items.length, items });

test('resource loading and normal image readiness remain distinct for 1x1 and 2x2 assets', () => {
  const result = describeImageReadiness(region([image({ width: 1, height: 1 }), image({ width: 2 }), image()]), url);
  assert.deepEqual(result.entries.map(entry => entry.status), ['tiny_image_unresolved', 'tiny_image_unresolved', 'normal_size_loaded']);
  assert.ok(result.entries.every(entry => entry.loaded === true));
  assert.equal(result.counts.tiny_image_unresolved, 2); assert.equal(result.counts.normal_size_loaded, 1);
  assert.equal(result.full_description_verified, false);
});
test('absent and unsupported URLs retain positions and loading evidence without exposing their values', () => {
  const result = describeImageReadiness(region([image({ url: '' }), image({ url: 'https://example.test/a?token=PRIVATE' }), image({ loaded: false, width: 0, height: 0 })]), url);
  assert.deepEqual(result.entries.map(entry => [entry.position, entry.url_state, entry.status]), [[1, 'absent', 'url_not_observed'], [2, 'unsupported', 'unsupported_url'], [3, 'supported', 'not_loaded']]);
  assert.equal(result.entries[0].url, null); assert.equal(result.entries[1].url, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|example\.test/);
});
test('unscanned elements, empty observed regions and absent regions have explicit scope', () => {
  const result = describeImageReadiness({ ...region([image()]), elements_seen: 63 }, url);
  assert.equal(result.unscanned_elements, 62); assert.equal(result.elements_scanned, 1);
  assert.equal(describeImageReadiness(region([]), url).region_observed, true);
  assert.equal(describeImageReadiness({ observed: false, elements_seen: 0, items: [] }, url).region_observed, false);
});
test('duplicate links retain separate element readiness and do not inflate the deduplicated delivery', () => {
  const raw = rawDetails(); raw.details.description = { ...raw.details.description, ...region([image({ width: 1, height: 1 }), image(), image({ url: '' })]), image_readiness_observed: true };
  const result = validateDetails(raw, target);
  assert.equal(result.details.description.items.length, 1);
  assert.equal(result.details.description.duplicates_omitted, 1);
  assert.equal(result.details.description.image_readiness.elements_scanned, 3);
  assert.equal(result.details.description.image_readiness.counts.normal_size_loaded, 1);
  assert.equal(result.details.description.items[0].width, 1);
  validateSavedDetails(result, target);
});
test('new observations expose readiness while preserving the original availability loading count', () => {
  const raw = rawDetails(); raw.details.description.items[0].width = 1; raw.details.description.items[0].height = 1;
  raw.details.description.image_readiness_observed = true;
  const result = validateDetails(raw, target);
  assert.equal(result.details.schema_version, 2);
  assert.equal(result.details.availability.description.loaded_returned_images, 1);
  assert.equal(result.details.description.image_readiness.counts.normal_size_loaded, 0);
  assert.equal(result.details.description.image_readiness.counts.tiny_image_unresolved, 1);
  validateSavedDetails(result, target);
});
test('old schema 1 and 2 caches without readiness stay unchanged during validation', () => {
  for (const version of [1, 2]) {
    const result = validateDetails(rawDetails(), target); result.details.schema_version = version;
    if (version === 1) delete result.details.availability;
    const before = JSON.stringify(result); validateSavedDetails(result, target);
    assert.equal(JSON.stringify(result), before); assert.equal(result.details.description.image_readiness, undefined);
  }
});
test('malformed observation sizes, counters and loading flags fail explicitly', () => {
  for (const raw of [{ observed: false, elements_seen: 1, items: [image()] },
    region(Array.from({ length: 61 }, () => image())), region([image({ loaded: true, width: 0 })]),
    region([image({ loaded: 'true' })]), { ...region([image()]), elements_seen: 0 }]) {
    assert.throws(() => describeImageReadiness(raw, url), { code: 'INVALID_RESPONSE' });
  }
});
test('saved counts, status, URL policy and full coverage cannot be upgraded', () => {
  const original = describeImageReadiness(region([image({ width: 1, height: 1 })]), url);
  for (const mutate of [value => { value.counts.normal_size_loaded = 1; }, value => { value.entries[0].status = 'normal_size_loaded'; },
    value => { value.entries[0].url = 'https://example.test/private'; }, value => { value.full_description_verified = true; },
    value => { value.entries[0].position = 2; }, value => { value.private_state = 'PRIVATE'; }]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => normalizeImageReadiness(value, url), { code: 'INVALID_RESPONSE' });
  }
});
test('readiness entries must correspond to the same returned URLs, dimensions and original positions', () => {
  const raw = rawDetails(); raw.details.description.image_readiness_observed = true;
  const result = validateDetails(raw, target), description = result.details.description;
  validateImageReadinessMapping(description.image_readiness, description);
  for (const mutate of [value => { value.entries[0].width = 799; }, value => { value.elements_seen += 1; value.unscanned_elements += 1; },
    value => { value.entries[0].url = 'https://img.alicdn.com/other.jpg'; }]) {
    const value = structuredClone(description.image_readiness); mutate(value);
    assert.throws(() => validateImageReadinessMapping(value, description), { code: 'INVALID_RESPONSE' });
  }
});
test('saved readiness tampering is rejected as an invalid checkpoint', () => {
  const raw = rawDetails(); raw.details.description.image_readiness_observed = true;
  const result = validateDetails(raw, target); result.details.description.image_readiness.entries[0].width = 801;
  assert.throws(() => validateSavedDetails(result, target), { code: 'INVALID_CHECKPOINT' });
});
