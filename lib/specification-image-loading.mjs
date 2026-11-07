import { ShoppingError } from './errors.mjs';
import { detailUrl } from './details.mjs';

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The specification image loading observation is inconsistent.');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');

/**
 * Validate the single previously observed tiny image eligible for a scroll guard.
 * @param {object} plan Reserved collection plan with inventory and one position.
 * @returns {void} @throws {ShoppingError} INVALID_ARGUMENTS.
 * @example validateSpecificationLoadingPlan(plan);
 */
export function validateSpecificationLoadingPlan(plan) {
  const expected = plan?.scroll?.expected_image;
  if (!plan?.inventory || !Array.isArray(plan.positions) || plan.positions.length !== 1 ||
      !Array.isArray(plan.inventory.groups) || plan.inventory.groups_seen !== plan.inventory.groups.length ||
      plan.inventory.groups.length > 8 || plan.inventory.groups.some(group => !Array.isArray(group?.options) ||
        group.options.length !== group.options_seen || group.options.length > 100) ||
      !exactKeys(plan.scroll, 'expected_image') || !exactKeys(expected, 'url,width,height') ||
      typeof expected.url !== 'string' || expected.url !== detailUrl(expected.url, 'image') ||
      ![expected.width, expected.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1000000) ||
      expected.width > 2 && expected.height > 2) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A single observed tiny image and its inventory are required for scrolling.');
  }
}

/**
 * Serialized page helper; reads geometry and scrolls only the guarded offscreen tiny IMG.
 * @param {object} dom Page helpers. @param {Element|null} image Unique owned IMG.
 * @param {object} sample Source captured before this action. @param {object} expected Prior source.
 * @returns {object} Pre-action geometry and one dispatch acknowledgement; never a post-scroll image.
 * @example inspectSpecificationImageLoading(dom, image, sample, expected);
 */
export function inspectSpecificationImageLoading(dom, image, sample, expected) {
  const skipped = reason => ({ action: 'skipped', reason, geometry: null, action_observed_at: null });
  if (!image || !sample.image) return skipped('source_unavailable');
  const source = sample.image;
  if (!source.loaded || source.url !== expected.url || source.width !== expected.width || source.height !== expected.height) return skipped('source_changed');
  const rect = node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('Invalid image geometry');
    return { x, y, width, height };
  };
  if (![innerWidth, innerHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid viewport');
  const box = rect(image);
  let left = Math.max(box.x, 0), top = Math.max(box.y, 0);
  let right = Math.min(box.x + box.width, innerWidth), bottom = Math.min(box.y + box.height, innerHeight);
  let ancestors = 0, clipped = 0;
  for (let parent = image.parentElement; parent; parent = parent.parentElement) {
    if (++ancestors > 64) throw new Error('Ancestor bound');
    const style = getComputedStyle(parent);
    const clipX = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX || style.overflow);
    const clipY = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY || style.overflow);
    if (!clipX && !clipY) continue;
    const bounds = rect(parent);
    if (![parent.clientLeft, parent.clientTop, parent.clientWidth, parent.clientHeight].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid clip geometry');
    if (clipX) { left = Math.max(left, bounds.x + parent.clientLeft); right = Math.min(right, bounds.x + parent.clientLeft + parent.clientWidth); }
    if (clipY) { top = Math.max(top, bounds.y + parent.clientTop); bottom = Math.min(bottom, bounds.y + parent.clientTop + parent.clientHeight); }
    clipped++;
  }
  const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
  const geometry = { image_box: box, viewport: { width: innerWidth, height: innerHeight }, clip_ancestors: clipped,
    intersection: { width, height }, fully_in_view: width >= box.width - 0.5 && height >= box.height - 0.5 };
  if (geometry.fully_in_view) return { ...skipped('already_in_view'), geometry };
  const gate = dom.gate();
  if (gate) return { state: gate };
  image.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  return { action: 'scrolled', reason: 'offscreen_tiny_image', geometry, action_observed_at: new Date().toISOString() };
}

function geometryOf(value) {
  if (!exactKeys(value, 'image_box,viewport,clip_ancestors,intersection,fully_in_view') ||
      !exactKeys(value.image_box, 'x,y,width,height') || !exactKeys(value.viewport, 'width,height') ||
      !exactKeys(value.intersection, 'width,height') || typeof value.fully_in_view !== 'boolean') throw invalid();
  const box = value.image_box;
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0 ||
      !Number.isSafeInteger(value.clip_ancestors) || value.clip_ancestors < 0 || value.clip_ancestors > 64) throw invalid();
  for (const key of ['width', 'height']) {
    if (!Number.isFinite(value.viewport[key]) || value.viewport[key] <= 0 || !Number.isFinite(value.intersection[key]) ||
        value.intersection[key] < 0 || value.intersection[key] > Math.min(box[key], value.viewport[key]) + 0.001) throw invalid();
  }
  if (value.fully_in_view !== (value.intersection.width >= box.width - 0.5 && value.intersection.height >= box.height - 0.5)) throw invalid();
  return { image_box: { x: box.x, y: box.y, width: box.width, height: box.height },
    viewport: { width: value.viewport.width, height: value.viewport.height }, clip_ancestors: value.clip_ancestors,
    intersection: { width: value.intersection.width, height: value.intersection.height }, fully_in_view: value.fully_in_view };
}

/**
 * Normalize a bounded scroll acknowledgement against the source read before the action.
 * @param {object} value Raw loading fields. @param {object[]} samples One normalized image sample.
 * @returns {object} Canonical action/geometry; does not assert successful loading.
 * @throws {ShoppingError} INVALID_RESPONSE. @example validateSpecificationLoading(raw.loading, samples);
 */
export function validateSpecificationLoading(value, samples) {
  if (!exactKeys(value, 'action,reason,geometry,action_observed_at') || !Array.isArray(samples) || samples.length !== 1) throw invalid();
  const scrolled = value.action === 'scrolled';
  if (scrolled ? value.reason !== 'offscreen_tiny_image' : value.action !== 'skipped' ||
      !['source_unavailable', 'source_changed', 'already_in_view'].includes(value.reason)) throw invalid();
  const geometry = value.geometry === null ? null : geometryOf(value.geometry);
  const geometric = scrolled || value.reason === 'already_in_view';
  if (Boolean(geometry) !== geometric || geometry && geometry.fully_in_view === scrolled) throw invalid();
  if (geometric) {
    const image = samples[0]?.image;
    if (image?.status !== 'observed' || !image.loaded || image.width > 2 && image.height > 2) throw invalid();
  }
  if (scrolled) {
    if (typeof value.action_observed_at !== 'string' || !Number.isFinite(Date.parse(value.action_observed_at)) ||
        new Date(value.action_observed_at).toISOString() !== value.action_observed_at) throw invalid();
  } else if (value.action_observed_at !== null) throw invalid();
  return { action: value.action, reason: value.reason, geometry, action_observed_at: value.action_observed_at };
}
