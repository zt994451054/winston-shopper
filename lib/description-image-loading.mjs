import { ShoppingError } from './errors.mjs';
import { detailsScript, detailUrl, validateDetails, validateSavedDetails } from './details.mjs';
import { pageDom } from './page-dom.mjs';

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The description image loading evidence is invalid.');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;

/** @param {number} position Original scanned IMG position, 1–60. @returns {number} Validated position. @throws {ShoppingError} INVALID_ARGUMENTS. @example descriptionImagePosition(2); */
export function descriptionImagePosition(position) {
  if (!Number.isSafeInteger(position) || position < 1 || position > 60) throw new ShoppingError('INVALID_ARGUMENTS', 'Choose one description image position from 1 to 60.');
  return position;
}

/**
 * Inspect one IMG within its unique description container; geometry includes clipping ancestors.
 * @param {object} dom Page helpers. @param {number} position Original scanned position.
 * @returns {{scope: object, node: Element|null}} Bounded source/geometry; no action.
 * @example inspectDescriptionImage(pageDom(), 1);
 */
export function inspectDescriptionImage(dom, position) {
  const roots = dom.all(document, dom.selector('imageTextInfo'));
  if (roots.length > 1) throw new Error('Ambiguous description region');
  const root = roots[0] ?? null;
  const containers = root ? [...root.querySelectorAll('.descV8-container')] : [];
  // Same images and order as the details description scan (lib/details.mjs), whose positions callers pass here.
  const images = root ? dom.all(root, '.descV8-singleImage-image, .descV8-richtext img, .descV8-picJumper-image').filter(node => node.tagName === 'IMG') : [];
  const node = position <= 60 ? images[position - 1] ?? null : null;
  const owned = Boolean(node && containers.length === 1 && node.closest('.descV8-container') === containers[0]);
  const scope = { schema_version: 1, position, region_observed: root !== null, containers_seen: containers.length,
    images_seen: images.length, images_scanned: Math.min(images.length, 60), owned, geometry: null };
  if (!owned) return { scope, node: null };
  const rect = element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('Invalid geometry');
    return { x, y, width, height };
  };
  const box = rect(node);
  if (![innerWidth, innerHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid viewport');
  let left = Math.max(box.x, 0), top = Math.max(box.y, 0), right = Math.min(box.x + box.width, innerWidth), bottom = Math.min(box.y + box.height, innerHeight);
  let ancestors = 0, clipped = 0, reached = false;
  for (let parent = node; parent; parent = parent.parentElement) {
    if (++ancestors > 64) throw new Error('Ancestor bound');
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' ||
        parent.hasAttribute('hidden') || parent.hasAttribute('inert') || parent.getAttribute('aria-hidden') === 'true' ||
        parent.tagName === 'VIDEO' || /video|charity|公益/i.test(parent.getAttribute('class') ?? '')) return { scope, node: null };
    const clipX = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX || style.overflow);
    const clipY = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY || style.overflow);
    if (parent !== node && (clipX || clipY)) {
      const bounds = rect(parent);
      if (![parent.clientLeft, parent.clientTop, parent.clientWidth, parent.clientHeight].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid clipping box');
      if (clipX) { left = Math.max(left, bounds.x + parent.clientLeft); right = Math.min(right, bounds.x + parent.clientLeft + parent.clientWidth); }
      if (clipY) { top = Math.max(top, bounds.y + parent.clientTop); bottom = Math.min(bottom, bounds.y + parent.clientTop + parent.clientHeight); }
      clipped++;
    }
    if (parent === document.body) { reached = true; break; }
  }
  if (!reached) return { scope, node: null };
  const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
  scope.geometry = { image_box: box, viewport: { width: innerWidth, height: innerHeight }, clip_ancestors: clipped,
    intersection: { width, height }, fully_in_view: width >= box.width - 0.5 && height >= box.height - 0.5 };
  return { scope, node };
}

function normalizeScope(value, snapshot, position) {
  const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  const readiness = snapshot.details.description.image_readiness;
  if (!exact(value, 'containers_seen,geometry,images_scanned,images_seen,owned,position,region_observed,schema_version') || !readiness ||
      value.schema_version !== 1 || value.position !== position || value.region_observed !== readiness.region_observed ||
      !integer(value.containers_seen, 10000) || value.images_seen !== readiness.elements_seen || value.images_scanned !== readiness.elements_scanned ||
      typeof value.owned !== 'boolean' || value.owned && (value.containers_seen !== 1 || position > value.images_scanned) ||
      !value.region_observed && value.containers_seen) throw invalid();
  const geometry = value.geometry;
  if (geometry !== null) {
    if (!value.owned || !exact(geometry, 'clip_ancestors,fully_in_view,image_box,intersection,viewport') ||
        !exact(geometry.image_box, 'height,width,x,y') || !exact(geometry.viewport, 'height,width') ||
        !exact(geometry.intersection, 'height,width') || !integer(geometry.clip_ancestors, 64) || typeof geometry.fully_in_view !== 'boolean' ||
        ![geometry.image_box.x, geometry.image_box.y].every(Number.isFinite)) throw invalid();
    for (const key of ['width', 'height']) {
      const box = geometry.image_box[key], viewport = geometry.viewport[key], intersection = geometry.intersection[key];
      if (!Number.isFinite(box) || box <= 0 || !Number.isFinite(viewport) || viewport <= 0 || !Number.isFinite(intersection) ||
          intersection < 0 || intersection > Math.min(box, viewport) + 0.001) throw invalid();
    }
    if (geometry.fully_in_view !== (geometry.intersection.width >= geometry.image_box.width - 0.5 && geometry.intersection.height >= geometry.image_box.height - 0.5)) throw invalid();
  }
  return structuredClone(value);
}

/** @param {object} observation Validated same-read evidence. @returns {object|null} Original scan entry, including unsupported URLs. @example descriptionImageEntry(observation); */
export function descriptionImageEntry(observation) {
  return observation.snapshot.details.description.image_readiness.entries[observation.scope.position - 1] ?? null;
}

/** @param {object} observation Validated observation. @returns {boolean} Complete owned scope with one offscreen tiny/unloaded supported resource. @example canLoadDescriptionImage(observation); */
export function canLoadDescriptionImage(observation) {
  const entry = descriptionImageEntry(observation), scope = observation.scope;
  return Boolean(entry?.url_state === 'supported' && ['tiny_image_unresolved', 'not_loaded'].includes(entry.status) &&
    scope.owned && scope.images_seen === scope.images_scanned && scope.geometry && !scope.geometry.fully_in_view);
}

/** @param {object} before Initial observation. @param {object} after Later observation. @returns {boolean} Same bounded position/container counts, not physical element identity. @example sameDescriptionImageScope(before, after); */
export function sameDescriptionImageScope(before, after) {
  return before.scope.owned && after.scope.owned && ['position', 'containers_seen', 'images_seen', 'images_scanned'].every(key => before.scope[key] === after.scope[key]);
}

function scrollImage(dom, raw, inspection, expected) {
  const gate = dom.gate();
  if (gate) return { state: gate };
  const scope = inspection.scope, previous = expected.scope;
  const entry = raw.details.description.items[scope.position - 1];
  const saved = expected.image;
  if (!scope.owned || !scope.geometry || !inspection.node || ['position', 'containers_seen', 'images_seen', 'images_scanned'].some(key => scope[key] !== previous[key]) ||
      !entry || entry.url !== saved.url) return { state: 'structure_changed' };
  const observation = { snapshot: raw, scope };
  if (entry.loaded && entry.width > 2 && entry.height > 2) return { observation, scrolled: false, reason: 'already_ready' };
  if (entry.loaded !== saved.loaded || entry.width !== saved.width || entry.height !== saved.height || !scope.geometry) return { state: 'structure_changed' };
  if (scope.geometry.fully_in_view) return { observation, scrolled: false, reason: 'already_in_view' };
  inspection.node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  return { observation, scrolled: true, reason: 'offscreen_resource' };
}

/**
 * Read one description IMG source/geometry or guard one reserved normal scroll.
 * @param {object} target Bound product. @param {number} position Original IMG scan position.
 * @param {object|null} expected Previously validated eligible observation.
 * @returns {string} Fixed script without navigation, downloads, selection or hidden state.
 * @throws {ShoppingError} INVALID_ARGUMENTS/INVALID_RESPONSE for an unsupported position or source.
 * @example descriptionImageLoadingScript(target, 1, saved);
 */
export function descriptionImageLoadingScript(target, position, expected = null) {
  descriptionImagePosition(position);
  if (expected !== null) {
    validateSavedDescriptionImageObservation(expected, target, position);
    if (!canLoadDescriptionImage(expected)) throw invalid();
  }
  const source = expected === null ? null : { scope: expected.scope, image: descriptionImageEntry(expected) };
  return `(() => { const snapshot = ${detailsScript(target)};
    if (snapshot.state !== 'observed') return snapshot;
    const dom = (${pageDom.toString()})();
    let inspection; try { inspection = (${inspectDescriptionImage.toString()})(dom, ${position}); } catch { return { state:'structure_changed' }; }
    return ${expected === null ? '{snapshot, scope:inspection.scope}' : `(${scrollImage.toString()})(dom, snapshot, inspection, ${JSON.stringify(source)})`};
  })()`;
}

/** @param {object} value Page response. @param {object} target Bound product. @param {number} position Requested scan position. @returns {object} Normalized same-read observation. @throws {ShoppingError} Identity, gate or schema errors. @example validateDescriptionImageObservation(raw, target, 1); */
export function validateDescriptionImageObservation(value, target, position) {
  descriptionImagePosition(position);
  const snapshot = validateDetails(value?.snapshot ?? value, target);
  return { snapshot, scope: normalizeScope(value?.scope, snapshot, position) };
}

/** @param {object} value Saved observation. @param {object} target Bound product. @param {number} position Requested position. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT. @example validateSavedDescriptionImageObservation(saved, target, 1); */
export function validateSavedDescriptionImageObservation(value, target, position) {
  try {
    descriptionImagePosition(position);
    if (!exact(value, 'scope,snapshot')) throw invalid();
    validateSavedDetails(value.snapshot, target);
    normalizeScope(value.scope, value.snapshot, position);
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved description image observation is invalid.'); }
}

/** @param {object} value Guard response. @param {object} target Bound product. @param {number} position Requested position. @param {object} expected Prior source. @returns {object} Pre-action observation and dispatch acknowledgement, never loading proof. @throws {ShoppingError} INVALID_RESPONSE or page gates. @example validateDescriptionImageScroll(raw, target, 1, initial); */
export function validateDescriptionImageScroll(value, target, position, expected) {
  const observation = validateDescriptionImageObservation(value?.observation ?? value, target, position);
  const entry = descriptionImageEntry(observation), before = descriptionImageEntry(expected);
  if (!exact(value, 'observation,reason,scrolled') || !sameDescriptionImageScope(expected, observation) || !observation.scope.geometry || entry?.url !== before?.url ||
      typeof value.scrolled !== 'boolean' || !['already_ready', 'already_in_view', 'offscreen_resource'].includes(value.reason) ||
      (value.scrolled ? value.reason !== 'offscreen_resource' || !canLoadDescriptionImage(observation)
        : value.reason === 'already_ready' ? entry.status !== 'normal_size_loaded' : !observation.scope.geometry?.fully_in_view) ||
      value.reason !== 'already_ready' && ['loaded', 'width', 'height'].some(key => entry[key] !== before[key])) throw invalid();
  return { observation, scrolled: value.scrolled, reason: value.reason };
}
