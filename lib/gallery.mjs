import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, throwPageError } from './page-dom.mjs';
import { collectGalleryImages } from './gallery-dom.mjs';
import { normalizeImageCollection, restoreImageCollection, imageAvailability } from './details.mjs';

function inspectGallery(target, dom, collect) {
  const url = new URL(location.href);
  if (url.origin !== target.origin || url.pathname !== target.pathname || url.searchParams.getAll('id').length !== 1 ||
      url.searchParams.get('id') !== target.product_id) return { state: 'target_changed' };
  const gate = dom.gate(null, { readOnly: true });
  if (gate) return { state: gate };
  const roots = dom.all(document, dom.selector('picGallery'));
  if (!roots.length) return { state: 'unsupported' };
  if (roots.length !== 1) return { state: 'structure_changed' };
  try {
    return { state: 'observed', product_id: target.product_id, url: target.url,
      observed_at: new Date().toISOString(), gallery: collect(roots[0], dom) };
  } catch { return { state: 'structure_changed' }; }
}

/**
 * @param {{url:string}} target Public product identity.
 * @returns {string} Fixed read of the top thumbnail gallery; no title, price, details, selection or hit test.
 * @throws {ShoppingError} INVALID_TARGET for an unsupported product URL.
 * @example galleryScript({url:'https://detail.tmall.com/item.htm?id=123'});
 */
export function galleryScript(target) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required.');
  return `(${inspectGallery.toString()})(${JSON.stringify(expected)}, (${pageDom.toString()})(), ${collectGalleryImages.toString()})`;
}

function result(target, observedAt, gallery) {
  return { schema_version: 1, product_id: target.product_id, url: target.url, observed_at: observedAt,
    source: 'loaded_gallery_thumbnail_dom', gallery,
    availability: { ...imageAvailability(gallery),
      content_kind: gallery.items.length ? 'image_links_observed' : 'no_supported_image_links_observed' },
    association: { sku_id: null, sku_binding_verified: false },
    coverage: { status: 'partial', full_gallery: false, current_main_image_read: false,
      selected_image_relation_verified: false, original_resolution_verified: false,
      file_downloaded: false, image_semantics_read: false, video_read: false },
    missing: gallery.items.length ? [] : ['gallery_image_links'], limits: { gallery_images: 20 } };
}

/**
 * @param {unknown} value Raw page observation. @param {object} target Expected product identity.
 * @returns {object} Gallery-only snapshot with deduplicated positions and explicit coverage.
 * @throws {ShoppingError} Page gates, INVALID_RESPONSE, or UNSUPPORTED_CAPABILITY when no gallery was observed.
 * @example validateGallery(raw, target);
 */
export function validateGallery(value, target) {
  throwPageError(value?.state);
  if (!value || Object.keys(value).sort().join(',') !== 'gallery,observed_at,product_id,state,url' ||
      value.state !== 'observed' || value.product_id !== target.product_id || value.url !== target.url ||
      typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at))) {
    throw new ShoppingError('INVALID_RESPONSE', 'The gallery observation does not match its expected identity or schema.');
  }
  const gallery = normalizeImageCollection(value.gallery, 20, 'gallery_thumbnail');
  if (!gallery.observed) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'No supported thumbnail gallery was observed.');
  return result(target, value.observed_at, gallery);
}

/**
 * @param {object} saved Gallery-only snapshot. @param {object} target Expected product identity.
 * @returns {void} Preserves saved bytes and observation time; does not refresh or add fields.
 * @throws {ShoppingError} INVALID_CHECKPOINT for altered positions, identity, counts or coverage.
 * @example validateSavedGallery(saved, target);
 */
export function validateSavedGallery(saved, target) {
  try {
    const normalized = validateGallery({ state: 'observed', product_id: saved.product_id, url: saved.url,
      observed_at: saved.observed_at, gallery: restoreImageCollection(saved.gallery, 20) }, target);
    for (const field of ['elements_scanned', 'duplicates_omitted', 'unsupported_urls_omitted']) normalized.gallery[field] = saved.gallery[field];
    normalized.gallery.items.forEach((item, index) => { item.position = saved.gallery.items[index].position; });
    const expected = result(target, saved.observed_at, normalized.gallery);
    if (JSON.stringify(expected) !== JSON.stringify(saved)) throw new Error('Gallery checkpoint mismatch');
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved gallery does not match its source or supported schema.'); }
}
