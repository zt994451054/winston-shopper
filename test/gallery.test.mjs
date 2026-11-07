import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { galleryScript, validateGallery, validateSavedGallery } from '../lib/gallery.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawDetails } from '../test-support/detail-fixture.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const raw = () => ({ state: 'observed', product_id: target.product_id, url: target.url,
  observed_at: '2026-09-28T01:00:00.000Z', gallery: rawDetails().details.gallery });

test('gallery-only result preserves exact links, deduplicated positions and partial scope', () => {
  const result = validateGallery(raw(), target);
  assert.deepEqual(result.gallery.items.map(item => item.position), [1, 4]);
  assert.equal(result.gallery.duplicates_omitted, 1);
  assert.equal(result.gallery.unsupported_urls_omitted, 1);
  assert.equal(result.coverage.current_main_image_read, false);
  assert.equal(result.coverage.full_gallery, false);
  assert.equal(result.association.sku_id, null);
  assert.equal(result.association.sku_binding_verified, false);
  assert.equal(result.availability.content_kind, 'image_links_observed');
  const before = JSON.stringify(result); validateSavedGallery(result, target);
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.details, undefined);
  assert.equal(result.prices, undefined);
});

test('unloaded and unscanned image elements remain distinct from an empty collection', () => {
  const value = raw(); value.gallery.elements_seen = 24;
  value.gallery.items[3] = { url: 'https://img.alicdn.com/pending.jpg', loaded: false, width: 0, height: 0 };
  const result = validateGallery(value, target);
  assert.equal(result.availability.not_loaded_returned_images, 1);
  assert.equal(result.availability.unscanned_elements, 20);
  assert.equal(result.availability.returned_images, 2);
  validateSavedGallery(result, target);
  value.gallery = { observed: true, elements_seen: 0, items: [] };
  const empty = validateGallery(value, target);
  assert.equal(empty.availability.content_kind, 'no_supported_image_links_observed');
  assert.deepEqual(empty.missing, ['gallery_image_links']);
  validateSavedGallery(empty, target);
});

test('invalid identity, time, collection and claimed guarantees cannot enter gallery results', () => {
  for (const change of [v => { v.product_id = '999'; }, v => { v.observed_at = 'invalid'; },
    v => { v.gallery.items[0].width = 0; }, v => { v.gallery.elements_seen = 0; },
    v => { v.url = 'https://detail.tmall.com/item.htm?id=999'; }, v => { v.token = 'PRIVATE'; }]) {
    const value = raw(); change(value);
    assert.throws(() => validateGallery(value, target), { code: 'INVALID_RESPONSE' });
  }
  const missing = raw(); missing.gallery = { observed: false, elements_seen: 0, items: [] };
  assert.throws(() => validateGallery(missing, target), { code: 'UNSUPPORTED_CAPABILITY' });
  for (const change of [v => { v.coverage.full_gallery = true; }, v => { v.gallery.items[1].position = 1; },
    v => { v.association.sku_id = 'invented'; }, v => { v.availability.loaded_returned_images++; },
    v => { v.gallery.duplicates_omitted = 0; }, v => { v.observed_at = ''; },
    v => { v.gallery.items[0].url = 'https://example.test/a.jpg'; }]) {
    const saved = validateGallery(raw(), target); change(saved);
    assert.throws(() => validateSavedGallery(saved, target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('gallery identity is checked before DOM access and explicit gates remain errors', () => {
  const document = new Proxy({}, { get() { throw new Error('DOM must not be read'); } });
  assert.equal(vm.runInNewContext(galleryScript(target), { URL, document, location: { href: 'https://example.test/' } }).state, 'target_changed');
  for (const [state, code] of [['verification_required', 'VERIFICATION_REQUIRED'], ['login_required', 'LOGIN_REQUIRED'], ['rate_limited', 'RATE_LIMITED']]) {
    assert.throws(() => validateGallery({ state }, target), { code });
  }
  assert.throws(() => galleryScript({ url: 'https://example.test/' }), { code: 'INVALID_TARGET' });
});
