import { ShoppingError } from './errors.mjs';
import { detailUrl } from './details.mjs';

/**
 * Collect only the current main review or follow-up's visible album thumbnails.
 * Serialized into the page; covered slots and recognized video nodes never expose image URLs.
 * @param {Element} owner @param {object} dom Page-local helpers.
 * @returns {object} Bounded raw slot observations, without clicks or downloads.
 * @throws {Error} Ambiguous album or thumbnail structure.
 * @example collectReviewImages(comment, dom);
 */
export function collectReviewImages(owner, dom) {
  const comment = owner.closest(dom.selector('Comment'));
  const append = owner.closest(dom.selector('append'));
  const owned = node => node.closest(dom.selector('Comment')) === comment &&
    node.closest(dom.selector('append')) === append && !node.closest(dom.selector('reply'));
  const albums = dom.all(owner, dom.selector('album')).filter(owned);
  if (albums.length > 1) throw new Error('Ambiguous review album');
  const photos = albums.length ? dom.all(albums[0], dom.selector('photo')).filter(owned) : [];
  const items = photos.slice(0, 6).map(photo => {
    if (photo.matches(dom.selector('cover'))) return { state: 'covered' };
    if (photo.matches(dom.selector('video')) || dom.all(photo, `video, ${dom.selector('video')}, ${dom.selector('videoIcon')}`).length) {
      return { state: 'video_excluded' };
    }
    const images = dom.all(photo, 'img').filter(node => node.closest(dom.selector('photo')) === photo && owned(node));
    if (images.length > 1) throw new Error('Ambiguous review thumbnail');
    if (!images.length) return { state: 'image_not_observed' };
    const image = images[0];
    return { state: 'image_observed', url: image.currentSrc || image.getAttribute('src') || '',
      loaded: image.complete === true && image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight };
  });
  return { album_observed: albums.length === 1, slots_seen: photos.length, items };
}

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The review image observations are inconsistent.');
const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/**
 * Normalize observed slots without treating cover assets as buyer photos or inferring original URLs.
 * @param {unknown} value @returns {object} Thumbnail links and explicit slot coverage.
 * @throws {ShoppingError} INVALID_RESPONSE for contradictory counts, states or dimensions.
 * @example normalizeReviewImages({ album_observed: false, slots_seen: 0, items: [] });
 */
export function normalizeReviewImages(value) {
  if (!value || typeof value.album_observed !== 'boolean' || !count(value.slots_seen, 10000) ||
      !Array.isArray(value.items) || value.items.length !== Math.min(value.slots_seen, 6) ||
      (!value.album_observed && value.slots_seen !== 0)) throw invalid();
  const slots = value.items.map((item, index) => {
    if (['covered', 'video_excluded', 'image_not_observed'].includes(item?.state)) {
      if (Object.keys(item).length !== 1) throw invalid();
      return { position: index + 1, state: item.state, image: null };
    }
    if (item?.state !== 'image_observed' || Object.keys(item).sort().join(',') !== 'height,loaded,state,url,width' ||
        typeof item.url !== 'string' || typeof item.loaded !== 'boolean' || !count(item.width, 1000000) ||
        !count(item.height, 1000000) || (item.loaded && (!item.width || !item.height))) throw invalid();
    const url = detailUrl(item.url, 'image');
    if (!url || !url.startsWith('https://')) return { position: index + 1, state: 'unsupported_url', image: null };
    return { position: index + 1, state: 'thumbnail_observed', image: {
      url, loaded: item.loaded, width: item.width, height: item.height, source: 'review_album_thumbnail',
    } };
  });
  return { schema_version: 1, album_observed: value.album_observed,
    slots_seen: value.slots_seen, slots_scanned: slots.length, slots_omitted: value.slots_seen - slots.length,
    image_links_returned: slots.filter(slot => slot.image !== null).length,
    covered_slots: slots.filter(slot => slot.state === 'covered').length, slots,
    original_images_verified: false, image_text_extracted: false, limit: 6 };
}

/**
 * Restore a saved image observation for exact schema validation; never upgrades missing legacy data.
 * @param {object} value @returns {object} Raw observations for normalizeReviewImages.
 * @throws {ShoppingError} INVALID_RESPONSE for unsupported states or positions.
 * @example restoreReviewImages(savedReview.images);
 */
export function restoreReviewImages(value) {
  if (!Array.isArray(value?.slots)) throw invalid();
  return { album_observed: value.album_observed, slots_seen: value.slots_seen,
    items: value.slots.map((slot, index) => {
      if (slot.position !== index + 1) throw invalid();
      if (slot.state === 'thumbnail_observed') {
        const image = slot.image;
        return { state: 'image_observed', url: image?.url, loaded: image?.loaded, width: image?.width, height: image?.height };
      }
      if (slot.state === 'unsupported_url') return { state: 'image_observed', url: '', loaded: false, width: 0, height: 0 };
      return { state: slot.state };
    }) };
}
