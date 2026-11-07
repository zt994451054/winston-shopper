import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, throwPageError } from './page-dom.mjs';
import { detailUrl } from './details.mjs';

/** @param {unknown} value @returns {string[]} One to three distinct, exact observed thumbnail URLs. @throws {ShoppingError} INVALID_MAIN_IMAGES. @example normalizeMainImages(['https://img.alicdn.com/thumb.jpg']); */
export function normalizeMainImages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length ||
      value.some(url => typeof url !== 'string' || detailUrl(url, 'image') !== url)) {
    throw new ShoppingError('INVALID_MAIN_IMAGES', 'Use one to three distinct exact URLs observed in the product thumbnail region.');
  }
  return [...value];
}

function inspectMainImage(target, source, select, dom) {
  const url = new URL(location.href);
  if (url.origin !== target.origin || url.pathname !== target.pathname || url.searchParams.getAll('id').length !== 1 ||
      url.searchParams.get('id') !== target.product_id) return { state: 'target_changed' };
  const gate = dom.gate(null, { readOnly: !select });
  if (gate) return { state: gate };
  const roots = dom.all(document, dom.selector('picGallery'));
  if (roots.length !== 1) return { state: 'structure_changed' };
  const root = roots[0], mains = dom.all(root, dom.selector('mainPicWrap'));
  const thumbnails = dom.all(root, dom.selector('thumbnailPic'));
  if (thumbnails.length > 20) return { state: 'structure_changed' };
  const candidates = thumbnails.filter(node => node.tagName === 'IMG' && (node.currentSrc || node.getAttribute('src')) === source);
  if (mains.length !== 1 || candidates.length !== 1) return { state: 'structure_changed' };
  const img = candidates[0], item = img.parentElement, thumb = item?.parentElement;
  // Only the observed plain static-image shape is actionable; posters, links and other media controls are not.
  if (!thumb || thumb.tagName !== 'DIV' || !thumb.matches(dom.selector('thumbnail')) ||
      item.tagName !== 'DIV' || !item.matches(dom.selector('thumbnailItem')) ||
      thumb.children.length !== 1 || item.children.length !== 1 || !root.contains(thumb)) return { state: 'unsupported' };
  const usable = node => {
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (!dom.visible(parent) || style.opacity === '0' || parent.hidden || parent.inert || parent.disabled === true ||
          parent.getAttribute('aria-hidden') === 'true' || parent.getAttribute('aria-disabled') === 'true' ||
          parent.getAttribute('data-disabled') === 'true' || ['A', 'BUTTON', 'INPUT'].includes(parent.tagName) ||
          ['link', 'button'].includes(parent.getAttribute('role'))) return false;
    }
    return true;
  };
  const selected = dom.all(root, dom.selector('thumbnailActive'));
  if (selected.length !== 1 || !selected[0].matches(dom.selector('thumbnail'))) return { state: 'structure_changed' };
  const isSelected = selected[0] === thumb;
  const uncovered = node => {
    const rect = node.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const hit = document.elementsFromPoint(x, y)[0];
    return Boolean(hit && node.contains(hit));
  };
  if (select) {
    // DOM data remains readable under overlays; only an actual click needs a usable, uncovered target.
    if (!usable(img) || !uncovered(img)) return { state: 'blocked_unknown' };
    if (isSelected) return { state: 'action_dispatched', clicked: false };
    img.click();
    return { state: 'action_dispatched', clicked: true };
  }
  const images = [];
  let scanned = 0, truncated = false, videosExcluded = 0, unsupportedImage = false;
  const visit = (node, depth) => {
    if (scanned >= 60 || depth > 6) { truncated = true; return; }
    scanned++;
    if (!dom.visible(node)) return;
    if (node.tagName === 'VIDEO' || ['mainPicVideo', 'videoPicWrap', 'videoPic'].some(prefix => node.matches(dom.selector(prefix)))) {
      videosExcluded++; return;
    }
    if (node.tagName === 'IMG') {
      if (!node.matches(dom.selector('mainPic')) || node.parentElement !== mains[0]) { unsupportedImage = true; return; }
      const bounds = node.getBoundingClientRect();
      images.push({ url: node.currentSrc || node.getAttribute('src') || '',
        width: node.naturalWidth, height: node.naturalHeight,
        displayed_width: bounds.width, displayed_height: bounds.height,
        loaded: Boolean(node.complete && node.naturalWidth > 0 && node.naturalHeight > 0),
        uncovered: usable(node) && uncovered(node) });
      return;
    }
    for (const child of node.children) {
      if (scanned >= 60) { truncated = true; break; }
      visit(child, depth + 1);
    }
  };
  visit(mains[0], 0);
  if (truncated || unsupportedImage || images.length > 1) return { state: 'structure_changed' };
  return { state: 'observed', product_id: target.product_id, url: target.url, observed_at: new Date().toISOString(),
    thumbnail_url: source, selected: isSelected, image: images[0] ?? null,
    nodes_scanned: scanned, excluded_video_regions: videosExcluded };
}

/** @param {object} target @param {string} thumbnail @param {boolean} [select=false] @returns {string} Read loaded main-image DOM data regardless of occlusion, or request one guarded thumbnail click. Explicit access gates still stop both modes; no scroll or panel cleanup. @throws {ShoppingError} INVALID_TARGET or INVALID_MAIN_IMAGES. @example mainImageScript(target, thumbnail); */
export function mainImageScript(target, thumbnail, select = false) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required.');
  normalizeMainImages([thumbnail]);
  if (typeof select !== 'boolean') throw new ShoppingError('INVALID_ARGUMENTS', 'The main-image action mode must be boolean.');
  return `(${inspectMainImage.toString()})(${JSON.stringify(expected)}, ${JSON.stringify(thumbnail)}, ${select}, (${pageDom.toString()})())`;
}

function invalid() { return new ShoppingError('INVALID_RESPONSE', 'The main image observation is invalid.'); }
const keys = (value, expected) => value && Object.keys(value).sort().join(',') === expected.split(',').sort().join(',');
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;

/** @param {unknown} value @param {object} target @param {string} thumbnail @returns {object} Validated observation, without inferring thumbnail or SKU binding. @throws {ShoppingError} Page gates or INVALID_RESPONSE. @example validateMainImageObservation(raw, target, thumbnail); */
export function validateMainImageObservation(value, target, thumbnail) {
  throwPageError(value?.state);
  if (!keys(value, 'state,product_id,url,observed_at,thumbnail_url,selected,image,nodes_scanned,excluded_video_regions') ||
      value.state !== 'observed' || value.product_id !== target.product_id || value.url !== target.url || value.thumbnail_url !== thumbnail ||
      typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) ||
      typeof value.selected !== 'boolean' || !count(value.nodes_scanned, 60) || value.nodes_scanned < 1 ||
      !count(value.excluded_video_regions, value.nodes_scanned)) throw invalid();
  const image = value.image;
  if (image !== null && (!keys(image, 'url,width,height,displayed_width,displayed_height,loaded,uncovered') ||
      typeof image.url !== 'string' || detailUrl(image.url, 'image') !== image.url ||
      !count(image.width, 1000000) || !count(image.height, 1000000) ||
      ![image.displayed_width, image.displayed_height].every(n => Number.isFinite(n) && n >= 0 && n <= 1000000) ||
      typeof image.loaded !== 'boolean' || typeof image.uncovered !== 'boolean' ||
      image.loaded && (!image.width || !image.height) || image.uncovered && (!image.displayed_width || !image.displayed_height))) throw invalid();
  return structuredClone(value);
}
