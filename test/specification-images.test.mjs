import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseProductUrl } from '../lib/targets.mjs';
import { specificationImagesScript, validateSpecificationImages, validateSavedSpecificationImages } from '../lib/specification-images.mjs';
import { rawSpecificationImages as raw } from '../test-support/specification-image-fixture.mjs';

const target = parseProductUrl(raw().url);

test('option images preserve sparse positions and duplicate URLs across distinct option containers', () => {
  const result = validateSpecificationImages(raw(), target);
  assert.deepEqual(result.groups[0].options.map(option => option.position), [1, 3]);
  assert.deepEqual(result.groups[0].options.map(option => option.label), ['黑色', '白色']);
  assert.equal(result.availability.returned_images, 2);
  for (const option of result.groups[0].options) {
    assert.equal(option.association.option_binding_verified, true);
    assert.equal(option.association.sku_id, null);
    assert.equal(option.association.sku_binding_verified, false);
    assert.equal(option.association.sku_price_binding_verified, false);
    assert.equal(option.image.url, raw().groups[0].options[0].image.url);
  }
  assert.equal(result.prices, undefined);
  assert.equal(result.coverage.selected_combination_verified, false);
  const bytes = JSON.stringify(result); validateSavedSpecificationImages(result, target);
  assert.equal(JSON.stringify(result), bytes);
});

test('unloaded and unsupported image URLs retain dimensions without guessing or leaking URLs', () => {
  const value = raw();
  value.groups[0].options[0].image = { url: 'https://img.alicdn.com/pending.webp', loaded: false, width: 0, height: 0 };
  value.groups[0].options[1].image.url = 'https://example.test/private?token=SECRET';
  const result = validateSpecificationImages(value, target);
  assert.equal(result.availability.not_loaded_returned_images, 1);
  const rejected = result.groups[0].options[1];
  assert.equal(rejected.image.status, 'unsupported_image_url');
  assert.equal(rejected.image.url, null);
  assert.equal(rejected.association.option_binding_verified, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|example.test/);
  validateSavedSpecificationImages(result, target);
});

test('missing image elements and ambiguous regions or images retain option labels with no asserted image binding', () => {
  for (const [regions, elements, status] of [[1, 0, 'image_element_not_observed'], [1, 2, 'ambiguous_image_elements'], [2, null, 'ambiguous_image_regions']]) {
    const value = raw();
    Object.assign(value.groups[0].options[0], { image_regions_seen: regions, image_elements_seen: elements, image: null });
    const result = validateSpecificationImages(value, target), option = result.groups[0].options[0];
    assert.equal(option.label, '黑色'); assert.equal(option.image.status, status);
    assert.equal(option.image.url, null); assert.equal(option.image.loaded, null);
    assert.equal(option.association.option_binding_verified, false);
    validateSavedSpecificationImages(result, target);
  }
});

test('group, option and five image-option caps are explicit and empty observations are not full coverage', () => {
  const value = raw(), option = value.groups[0].options[0];
  value.groups_seen = 9;
  value.groups = Array.from({ length: 8 }, (_, index) => ({ name: `规格${index}`, options_seen: 120,
    options_scanned: 100, image_options_seen: 7,
    options: index === 0 ? Array.from({ length: 5 }, (_, i) => ({ ...structuredClone(option), position: i + 1 })) : [] }));
  const result = validateSpecificationImages(value, target);
  assert.equal(result.scope.groups_omitted, 1);
  assert.equal(result.scope.options_unscanned_in_scanned_groups, 160);
  assert.equal(result.scope.image_options_omitted, 51);
  assert.equal(result.scope.image_options_sampled, 5);
  validateSavedSpecificationImages(result, target);
  value.groups_seen = 0; value.groups = [];
  const empty = validateSpecificationImages(value, target);
  assert.deepEqual(empty.missing, ['specification_option_image_links']);
  assert.equal(empty.coverage.full_option_images, false);
  validateSavedSpecificationImages(empty, target);
});

test('identity, inconsistent counts, ambiguous positions and malformed flags cannot enter results', () => {
  const mutations = [v => { v.product_id = '999'; }, v => { v.observed_at = 'invalid'; },
    v => { v.groups_seen++; }, v => { v.groups[0].options_scanned--; },
    v => { v.groups[0].image_options_seen = 1; }, v => { v.groups[0].options[1].position = 1; },
    v => { v.groups[0].options[1].position = 4; }, v => { v.groups[0].options[0].selected = false; },
    v => { v.groups[0].options[0].image.width = 0; }, v => { v.groups[0].name = ' '; },
    v => { v.groups[0].options[0].image_regions_seen = 0; }, v => { v.secret = 'private'; },
    v => { v.groups[0].options[0].image_elements_seen = 2; },
    v => { v.groups[0].options[0].image.height = 1000001; }];
  for (const mutate of mutations) {
    const value = raw(); mutate(value);
    assert.throws(() => validateSpecificationImages(value, target), { code: 'INVALID_RESPONSE' });
  }
});

test('saved option results reject altered coverage, image status, local positions or platform claims', () => {
  for (const mutate of [v => { v.coverage.full_option_images = true; }, v => { v.groups[0].position = 9; },
    v => { v.groups[0].options[0].association.sku_id = '123'; },
    v => { v.groups[0].options[0].association.sku_price_binding_verified = true; },
    v => { v.groups[0].options[0].image.status = 'ambiguous_image_elements'; },
    v => { v.scope.image_options_sampled = 5; }, v => { v.groups[0].image_options_omitted = 1; },
    v => { v.groups[0].options[1].position = 1; }, v => { v.availability.returned_images--; }]) {
    const saved = validateSpecificationImages(raw(), target); mutate(saved);
    assert.throws(() => validateSavedSpecificationImages(saved, target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('specification image reader guards identity before DOM access and preserves explicit gates', () => {
  const document = new Proxy({}, { get() { throw new Error('DOM must not be read'); } });
  const result = vm.runInNewContext(specificationImagesScript(target), { URL, document, location: { href: 'https://example.test/' } });
  assert.equal(result.state, 'target_changed');
  assert.throws(() => specificationImagesScript({ url: 'https://example.test/' }), { code: 'INVALID_TARGET' });
  for (const [state, code] of [['verification_required', 'VERIFICATION_REQUIRED'], ['login_required', 'LOGIN_REQUIRED'],
    ['rate_limited', 'RATE_LIMITED'], ['unsupported', 'UNSUPPORTED_CAPABILITY']]) {
    assert.throws(() => validateSpecificationImages({ state }, target), { code });
  }
});
