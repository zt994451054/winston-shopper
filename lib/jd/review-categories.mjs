import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { parseJdProductUrl } from './targets.mjs';

// Returned cards and tags are capped; tags_seen and cards_seen keep the painted count before the cap.
const LIMITS = Object.freeze({
  tags: 30, cards: 10, name: 80, count: 40, date: 40, spec: 120, body: 2000,
  interval: 80, sort: 40, sku: 40, rating: 80, bodyLength: 100000,
});
const OBSERVATION_KEYS = ['cards', 'cards_seen', 'entry', 'panel', 'sort_text', 'sku_select_text', 'state', 'tags', 'tags_seen', 'visible'];
const TAG_KEYS = ['count_text', 'name', 'selected'];
const CARD_KEYS = ['body', 'body_length', 'date_text', 'followup', 'media', 'position', 'rating_mark', 'spec_text'];
const MEDIA_KEYS = ['count', 'videos'];
const FOLLOW_KEYS = ['body', 'body_length', 'interval_text'];

/** Shown when a review read or an open/switch click stops because the JD tab is not visible. */
export const PAGE_NOT_VISIBLE_NEXT_ACTION = 'Bring the 购物助手 window to the foreground and show this JD tab, then run task-resume --after-user once.';

/**
 * @returns {ShoppingError} PAGE_NOT_VISIBLE. Classification as a user pause is applied by the task runner.
 * @example pageNotVisibleError()
 */
export function pageNotVisibleError() {
  return new ShoppingError('PAGE_NOT_VISIBLE', 'The JD page is not visible, so the review list cannot be read.', PAGE_NOT_VISIBLE_NEXT_ACTION);
}

const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The JD review response does not match the supported page shape.');

function expectedProduct(target) {
  const expected = parseJdProductUrl(target?.url);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_TARGET', 'Use a canonical JD product target.');
  return { product_id: expected.product_id };
}

/**
 * Read the 全部评价 overlay. A hidden document still reports whether #rateList and the entry exist:
 * the virtual list simply does not paint cards, so cards stay empty instead of failing the read.
 * Hashed class suffixes are matched by substring inside #rateList (2026-10-15 probes). The buyer block is never queried.
 * @param {{product_id: string}} expected @param {Function} gate jdPageGate @param {object} limits Caps copied into the page.
 * @returns {object} Gate or target state, or one observation.
 */
export function collectJdReviewOverlay(expected, gate, limits) {
  const textOf = node => String(node?.textContent ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const cssShown = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const painted = element => cssShown(element) && element.getClientRects().length > 0;
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  if (current.hostname !== 'item.jd.com' || current.pathname !== `/${expected.product_id}.html`) return { state: 'target_changed' };
  const visible = document.visibilityState === 'visible';
  const entryNodes = [...document.querySelectorAll('#comment-root .all-btn')].filter(node => textOf(node) === '全部评价' && (visible ? painted(node) : cssShown(node)));
  const entry = entryNodes.length === 1 ? 'present' : entryNodes.length === 0 ? 'missing' : 'ambiguous';
  const root = document.querySelector('#rateList');
  const panelOpen = Boolean(root && cssShown(root));
  if (!panelOpen) {
    return { state: 'observed', visible, entry, panel: 'closed', tags: [], tags_seen: 0, sort_text: '', sku_select_text: '', cards: [], cards_seen: 0 };
  }
  const named = [];
  for (const chip of root.querySelectorAll('[class*="_tag_"]')) {
    if (!cssShown(chip)) continue;
    const nameNode = chip.querySelector('[class*="_tag-name_"]');
    const name = textOf(nameNode);
    if (!nameNode || !name || name.length > limits.name) continue;
    const count = textOf(chip.querySelector('[class*="_tag-comment_"]')).slice(0, limits.count);
    const selected = String(chip.className || '').split(/\s+/).some(token => token.includes('_tag-active_'));
    named.push({ name, count_text: count, selected });
  }
  const firstText = (selector, max) => {
    const node = [...root.querySelectorAll(selector)].find(cssShown);
    return textOf(node).slice(0, max);
  };
  const readCard = (node, index) => {
    const content = node.querySelector('.jdc-pc-rate-card-content');
    const tokens = [];
    const take = element => {
      for (const token of String(element.className || '').split(/\s+/)) if (token.includes('star')) tokens.push(token);
      for (const child of element.children || []) take(child);
    };
    if (content) take(content);
    const rating = tokens.find(token => token.startsWith('star')) || tokens[0] || '';
    const field = (selector, max) => textOf(content ? content.querySelector(selector) : null).slice(0, max);
    const bodyText = textOf(content ? content.querySelector('.jdc-pc-rate-card-main-desc') : null);
    const items = content ? [...content.querySelectorAll('.jd-content-pc-media-list-item')] : [];
    const after = content ? content.querySelector('.jdc-pc-rate-card-after') : null;
    let followup = null;
    if (after) {
      const icon = after.querySelector('.jdc-pc-rate-card-after-icon');
      const other = [...after.querySelectorAll('span')].find(span => span !== icon);
      const followText = textOf(other);
      followup = { interval_text: textOf(icon).slice(0, limits.interval), body: followText.slice(0, limits.body), body_length: Math.min(followText.length, limits.bodyLength) };
    }
    return {
      position: index + 1, rating_mark: rating.slice(0, limits.rating),
      date_text: field('.jdc-pc-rate-card-info-left span.date', limits.date),
      spec_text: field('.jdc-pc-rate-card-info-left span.info', limits.spec),
      body: bodyText.slice(0, limits.body), body_length: Math.min(bodyText.length, limits.bodyLength),
      media: { count: items.length, videos: items.filter(item => item.querySelector('.jd-content-pc-media-list-play')).length },
      followup,
    };
  };
  let cards = [], cardsSeen = 0;
  // Cards are not painted while the document is hidden, so they are not read either.
  if (visible) {
    const nodes = [...root.querySelectorAll('div[data-index]')].map(node => ({ node, index: Number(node.getAttribute('data-index')) }))
      .filter(item => Number.isInteger(item.index) && item.index >= 0 && item.index <= 100000 && item.node.querySelector('.jdc-pc-rate-card'))
      .sort((left, right) => left.index - right.index);
    cardsSeen = nodes.length;
    cards = nodes.slice(0, limits.cards).map(item => readCard(item.node, item.index));
  }
  return {
    state: 'observed', visible, entry, panel: 'open', tags: named.slice(0, limits.tags), tags_seen: named.length,
    sort_text: firstText('[class*="_sort_"]', limits.sort), sku_select_text: firstText('[class*="_skuSelect_"]', limits.sku),
    cards, cards_seen: cardsSeen,
  };
}

/**
 * Click open, one category tag, or close. Open and switch refuse unless the document is visible and the control is painted.
 * Close does not: #rateList can be removed while the window is hidden, when client rects are empty.
 * @param {{product_id: string}} expected @param {Function} gate jdPageGate
 * @param {{action: 'open'|'select'|'close', label?: string}} request
 * @returns {object} A gate state, or clicked / not_dispatched. Nothing else on the page is clicked.
 */
export function jdReviewClick(expected, gate, request) {
  const textOf = node => String(node?.textContent ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Own text nodes only. The 2026-10-15 probe opened the panel by clicking the inner label, not the .all-btn that also wraps an icon.
  const directText = node => [...(node?.childNodes ?? [])].filter(child => child.nodeType === 3).map(child => String(child.nodeValue ?? ''))
    .join('').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const cssShown = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const painted = element => cssShown(element) && element.getClientRects().length > 0;
  const action = request && typeof request === 'object' ? request.action : null;
  const refuse = reason => ({ state: 'not_dispatched', action, reason });
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  if (current.hostname !== 'item.jd.com' || current.pathname !== `/${expected.product_id}.html`) return { state: 'target_changed' };
  if (action !== 'close' && document.visibilityState !== 'visible') return refuse('page_not_visible');
  const root = document.querySelector('#rateList');
  const panelOpen = Boolean(root && cssShown(root));
  if (action === 'open') {
    if (panelOpen) return refuse('panel_open');
    const entries = [];
    for (const button of document.querySelectorAll('#comment-root .all-btn')) {
      for (const node of [button, ...button.querySelectorAll('*')]) {
        if (painted(node) && directText(node) === '全部评价') entries.push(node);
      }
    }
    if (entries.length === 0) return refuse('entry_missing');
    if (entries.length > 1) return refuse('entry_ambiguous');
    entries[0].click();
    return { state: 'clicked', action: 'open' };
  }
  if (action === 'select') {
    const label = request.label;
    if (typeof label !== 'string' || !label || label !== label.trim() || label.length > 80) return refuse('bad_label');
    if (!panelOpen) return refuse('panel_closed');
    // A tag the read skips (not CSS-shown) is not on the panel. Empty client rects are a separate, later refusal.
    const matches = [...root.querySelectorAll('[class*="_tag_"]')].filter(chip => cssShown(chip) && textOf(chip.querySelector('[class*="_tag-name_"]')) === label);
    if (matches.length === 0) return refuse('category_unavailable');
    if (matches.length > 1) return refuse('category_ambiguous');
    const chip = matches[0];
    if (String(chip.className || '').split(/\s+/).some(token => token.includes('_tag-active_'))) return refuse('already_selected');
    // The same probe switched categories by clicking span._tag-name_, not the outer _tag_ chip.
    const nameNode = chip.querySelector('[class*="_tag-name_"]');
    if (!nameNode || !painted(nameNode)) return refuse('category_unpainted');
    nameNode.click();
    return { state: 'clicked', action: 'select' };
  }
  if (action === 'close') {
    if (!panelOpen) return refuse('panel_closed');
    const buttons = [...root.querySelectorAll('[class*="_closeIcon_"]')].filter(cssShown);
    if (buttons.length === 0) return refuse('close_missing');
    if (buttons.length > 1) return refuse('close_ambiguous');
    buttons[0].click();
    return { state: 'clicked', action: 'close' };
  }
  return refuse('bad_label');
}

/** @param {object} target Canonical JD product target. @returns {string} The read expression. @throws {ShoppingError} INVALID_TARGET. */
export function jdReviewReadScript(target) {
  return `(${collectJdReviewOverlay})(${JSON.stringify(expectedProduct(target))}, ${jdPageGate}, ${JSON.stringify(LIMITS)})`;
}

/** @param {object} target @returns {string} The open-panel expression. @throws {ShoppingError} INVALID_TARGET. */
export function jdReviewOpenScript(target) {
  return `(${jdReviewClick})(${JSON.stringify(expectedProduct(target))}, ${jdPageGate}, ${JSON.stringify({ action: 'open' })})`;
}

/**
 * @param {object} target @param {string} label Exact category name.
 * @returns {string} The category-switch expression.
 * @throws {ShoppingError} INVALID_TARGET or INVALID_ARGUMENTS before any page script is built for a bad label.
 */
export function jdReviewSelectScript(target, label) {
  if (typeof label !== 'string' || !label || label !== label.trim() || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'The review category label is invalid.');
  }
  return `(${jdReviewClick})(${JSON.stringify(expectedProduct(target))}, ${jdPageGate}, ${JSON.stringify({ action: 'select', label })})`;
}

/** @param {object} target @returns {string} The close-panel expression. It does not require a visible document. @throws {ShoppingError} INVALID_TARGET. */
export function jdReviewCloseScript(target) {
  return `(${jdReviewClick})(${JSON.stringify(expectedProduct(target))}, ${jdPageGate}, ${JSON.stringify({ action: 'close' })})`;
}

function textOk(value, max) {
  try { return responseText(value, max) === value; } catch { return false; }
}
function boundedCount(value, max) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }

function validFollowup(value) {
  return value === null || (sameKeys(value, FOLLOW_KEYS) && textOk(value.interval_text, LIMITS.interval) && textOk(value.body, LIMITS.body) &&
    boundedCount(value.body_length, LIMITS.bodyLength) && value.body_length >= value.body.length);
}

function validCard(card) {
  return sameKeys(card, CARD_KEYS) && boundedCount(card.position, 100001) && card.position >= 1 && textOk(card.rating_mark, LIMITS.rating) &&
    textOk(card.date_text, LIMITS.date) && textOk(card.spec_text, LIMITS.spec) && textOk(card.body, LIMITS.body) &&
    boundedCount(card.body_length, LIMITS.bodyLength) && card.body_length >= card.body.length &&
    sameKeys(card.media, MEDIA_KEYS) && boundedCount(card.media.count, 1000) && boundedCount(card.media.videos, card.media.count) &&
    validFollowup(card.followup);
}

/**
 * @param {unknown} value Raw read. @returns {object} The same observation when it matches the overlay shape.
 * @throws {ShoppingError} Page gates, TARGET_CHANGED, or INVALID_RESPONSE. A hidden page is valid and is not PAGE_NOT_VISIBLE.
 */
export function validateJdReviewObservation(value) {
  throwPageError(value?.state);
  try {
    if (!sameKeys(value, OBSERVATION_KEYS) || value.state !== 'observed' || typeof value.visible !== 'boolean' ||
        !['present', 'missing', 'ambiguous'].includes(value.entry) || !['open', 'closed'].includes(value.panel) ||
        !Array.isArray(value.tags) || !Array.isArray(value.cards) || !boundedCount(value.tags_seen, 10000) || !boundedCount(value.cards_seen, 10000) ||
        value.tags.length > LIMITS.tags || value.cards.length > LIMITS.cards || value.tags_seen < value.tags.length || value.cards_seen < value.cards.length) throw invalid();
    if (value.panel === 'closed' && (value.tags.length || value.cards.length || value.tags_seen || value.cards_seen || value.sort_text || value.sku_select_text)) throw invalid();
    if (!value.visible && (value.cards.length || value.cards_seen)) throw invalid();
    if (!textOk(value.sort_text, LIMITS.sort) || !textOk(value.sku_select_text, LIMITS.sku)) throw invalid();
    for (const tag of value.tags) {
      if (!sameKeys(tag, TAG_KEYS) || typeof tag.selected !== 'boolean' || !textOk(tag.name, LIMITS.name) || !tag.name || !textOk(tag.count_text, LIMITS.count)) throw invalid();
    }
    let last = 0;
    for (const card of value.cards) {
      if (!validCard(card) || card.position < last) throw invalid();
      last = card.position;
    }
  } catch (error) {
    if (error instanceof ShoppingError) throw error;
    throw invalid();
  }
  return value;
}

function clickError(reason) {
  const errors = {
    page_not_visible: pageNotVisibleError,
    panel_open: () => new ShoppingError('REVIEW_PANEL_REQUIRED', 'The review panel is already open.'),
    panel_closed: () => new ShoppingError('REVIEW_PANEL_REQUIRED', 'The review panel is not open.'),
    entry_missing: () => new ShoppingError('REVIEW_PANEL_REQUIRED', 'The 全部评价 entry is not on the page.'),
    entry_ambiguous: () => new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The 全部评价 entry is not unique.'),
    category_unavailable: () => new ShoppingError('REVIEW_CATEGORY_UNAVAILABLE', 'The requested category is not on the panel.'),
    category_unpainted: () => new ShoppingError('REVIEW_CATEGORY_UNAVAILABLE', 'The requested category is not visible.'),
    category_ambiguous: () => new ShoppingError('REVIEW_CATEGORIES_AMBIGUOUS', 'More than one tag has the requested category name.'),
    already_selected: () => new ShoppingError('REVIEW_CATEGORY_ALREADY_SELECTED', 'The requested category is already selected.'),
    close_missing: () => new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The review panel close button is missing.'),
    close_ambiguous: () => new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The review panel close button is not unique.'),
    bad_label: () => new ShoppingError('INVALID_ARGUMENTS', 'The review category label is invalid.'),
  };
  return (errors[reason] ?? (() => new ShoppingError('INVALID_RESPONSE', 'The JD review click acknowledgement is invalid.')))();
}

function validateClick(value, action) {
  throwPageError(value?.state);
  if (value?.state === 'clicked' && value.action === action) return { clicked: true };
  if (value?.state === 'not_dispatched' && value.action === action && typeof value.reason === 'string') {
    const error = clickError(value.reason);
    error.actionNotDispatched = true;
    error.reviewClickReason = value.reason;
    throw error;
  }
  throw new ShoppingError('INVALID_RESPONSE', 'The JD review click acknowledgement is invalid.');
}

/** @param {unknown} value @returns {{clicked: true}} @throws {ShoppingError} When the open click did not happen, with actionNotDispatched set. */
export function validateJdReviewOpen(value) { return validateClick(value, 'open'); }

/** @param {unknown} value @returns {{clicked: true}} @throws {ShoppingError} When the category click did not happen, with actionNotDispatched set. */
export function validateJdReviewSelect(value) { return validateClick(value, 'select'); }

/** @param {unknown} value @returns {{clicked: true}} @throws {ShoppingError} When the close click did not happen, with actionNotDispatched set. */
export function validateJdReviewClose(value) { return validateClick(value, 'close'); }
