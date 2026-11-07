import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { pddPageGate } from './page-gate.mjs';
import { parsePddProductUrl, parsePddReviewsUrl } from './targets.mjs';

// Format 2 (2026-10-27) adds page_notes, the lines under the list. Format 3 (same day) keeps only known blocks of a
// review and counts the others in other_blocks_skipped. Earlier formats are rebuilt as they were saved.
const PDD_REVIEWS_SCHEMA_VERSION = 3;
// The user chose loaded reviews only, at most 20, from the 全部 list (2026-10-27).
// Lines PDD draws on a review that are controls, not content.
const CONTROLS = new Set(['赞', '评论', '展开', '收起']);
const SPEC_LINE = /^[^：:\s]{1,10}[：:]\s*\S/;
const DATE_LINE = /^(\d{4}[-./年]\d{1,2}([-./月]\d{1,2}日?)?|\d{1,2}[-./月]\d{1,2}日?|\d+(分钟|小时|天)前|昨天|今天)/;
const FOLLOW_UP = /追评/;
const MERCHANT_REPLY = /^(商家|店家|掌柜)(回复|回应)/;
const LIMITS = Object.freeze({ line: 600, cards: 20, blocks: 8, blockLines: 10, tabs: 10, tabLine: 20, notes: 5, specLine: SPEC_LINE.source,
  knownBlock: `${DATE_LINE.source}|${FOLLOW_UP.source}|${MERCHANT_REPLY.source}` });

/**
 * In-page: click 查看全部 next to 商品评价(N) once on the product page a pdd_product task read, after checking the
 * heading still shows the count that task saved. PDD then opens goods_comments.html in the same tab (2026-10-27).
 * @param {{product_id: string, count: number}} expected @param {Function} gate pddPageGate
 * @returns {{state: string}} 'clicked', a gate state, or why nothing was clicked.
 */
export function clickPddReviewsLink(expected, gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const ids = current.searchParams.getAll('goods_id');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/goods.html' || ids.length !== 1 || ids[0] !== expected.product_id) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const leaves = [...document.querySelectorAll('body *')].filter(node => node.children.length === 0);
  const head = leaves.find(node => /^商品评价\(.{1,12}\)$/.test(clip(node.textContent)));
  if (!head) return { state: 'reviews_missing' };
  // The count can carry thousands separators: 商品评价(2,669) (2026-10-27).
  if (clip(head.textContent).replace(/,/g, '') !== `商品评价(${expected.count})`) return { state: 'reviews_changed' };
  // 查看全部 shares a small header block with the heading.
  let box = head, link = null;
  for (let level = 0; level < 5 && box && !link; level += 1) {
    box = box.parentElement;
    link = box ? [...box.querySelectorAll('*')].find(node => node.children.length === 0 && clip(node.textContent) === '查看全部') : null;
  }
  if (!link) return { state: 'structure_changed' };
  link.scrollIntoView({ block: 'center' });
  link.click();
  return { state: 'clicked' };
}

/**
 * @param {string} productId goods_id of the product page. @param {number} count The 商品评价(N) count the product task saved.
 * @returns {string} One fixed single-click expression. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function pddReviewsLinkClickScript(productId, count) {
  if (!parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${productId}`) || !Number.isSafeInteger(count) || count < 1) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD goods_id and the saved review count.');
  }
  return `(${clickPddReviewsLink})(${JSON.stringify({ product_id: productId, count })}, ${pddPageGate})`;
}

const CLICK_REFUSALS = {
  reviews_missing: ['REVIEWS_NOT_SHOWN', 'The product page shows no 商品评价 heading.'],
  reviews_changed: ['REVIEWS_CHANGED', 'The 商品评价 count differs from the one the product task read.'],
};

/**
 * @param {unknown} value Page script result. @returns {{clicked: true}}
 * @throws {ShoppingError} Page gate errors, a refusal (nothing clicked, marked actionNotDispatched) or INVALID_RESPONSE.
 */
export function validatePddReviewsLinkClick(value) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  const refusal = CLICK_REFUSALS[value?.state];
  try {
    if (refusal) throw new ShoppingError(...refusal, 'Read the product again from a new search task, then start a new reviews task from it.');
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The PDD 查看全部 click returned an unexpected acknowledgement.');
  } catch (error) {
    // Every non-click state comes from the page script before it clicked anything.
    if (typeof value?.state === 'string' && value.state !== 'clicked') error.actionNotDispatched = true;
    throw error;
  }
}

/**
 * Internal serialized collector for the 查看全部 review page (goods_comments.html), as seen on 2026-10-27: category
 * labels such as 全部(142) on top, then review cards. Each card holds exactly one reviewer avatar and its blocks are,
 * in order: the avatar and the reviewer name, the bought spec, the text (cut to 5 lines by style, but whole in the page),
 * the review images and other blocks, then 赞, 评论 and their counts. The avatar block is dropped whole, so a name never
 * leaves the page; a card whose first block is not the avatar block is not read at all. The page also holds the product bottom bar and its hidden spec panel, which no card
 * contains. Nothing is clicked or scrolled.
 * @param {{product_id: string}} expected @param {Function} gate pddPageGate @param {object} limits
 * @returns {object} Raw guarded observation.
 */
export function collectPddReviews(expected, gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const ids = current.searchParams.getAll('goods_id');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/goods_comments.html' || ids.length !== 1 || ids[0] !== expected.product_id) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = (text, max = limits.line) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const leaves = [...document.querySelectorAll('body *')].filter(node => node.children.length === 0 &&
    !['SCRIPT', 'STYLE', 'NOSCRIPT', 'VIDEO', 'AUDIO'].includes(node.tagName) && !/^[-|\s]*$/.test(String(node.textContent ?? '')));
  const textOf = node => clip(node.textContent);
  const tabLine = /^[^()（）]{1,8}[(（][0-9][0-9,.]{0,12}万?\+?[)）]$|^(最新|图\/视频|有图)$/;
  // Cards never reach the category labels, the bottom bar (客服) or the spec panel (确定).
  const stops = leaves.filter(node => tabLine.test(textOf(node)) || ['客服', '确定'].includes(textOf(node)));
  // Avatars are small images from an avatar*.pddpic.com host; review text can hold 47px emoji images from other hosts (2026-10-27).
  const imageHost = image => { try { return new URL(image.getAttribute('src') || image.getAttribute('data-src') || '', location.href).hostname; } catch { return ''; } };
  const isAvatar = image => { const width = image.getBoundingClientRect().width; return width > 0 && width <= 60 && /^avatar[a-z0-9-]*\.pddpic\.com$/.test(imageHost(image)); };
  // The bottom bar (the block around 客服 that also holds its ¥) and the spec panel after it may hold small icons, so
  // only images before the bar can be avatars.
  const service = leaves.find(node => textOf(node) === '客服') ?? null;
  let bar = service;
  while (bar && ![...bar.querySelectorAll('*')].some(node => node.children.length === 0 && /^[¥￥]/.test(textOf(node)))) bar = bar.parentElement;
  const barStart = bar ? (leaves.find(node => bar.contains(node)) ?? service) : service;
  const beforeBar = image => !barStart || (!(bar && bar.contains(image)) && (image.compareDocumentPosition(barStart) & 4));
  const avatars = [...document.querySelectorAll('img')].filter(image => isAvatar(image) && beforeBar(image));
  const avatarsIn = root => avatars.filter(avatar => root.contains(avatar)).length;
  // A card is the largest block around one reviewer avatar. 赞 is not on every card: one card ends with 赞 and a
  // count, another with a count and 评论 (2026-10-27 dress), so the avatar, which every card has, delimits them.
  const cards = [];
  for (const avatar of avatars) {
    let card = avatar;
    while (card.parentElement && avatarsIn(card.parentElement) === 1 && !stops.some(stop => card.parentElement.contains(stop))) card = card.parentElement;
    // With a single review the climb reaches the list around it; its card is the only child.
    while (card.children.length === 1 && card.children[0].contains(avatar) && card.children[0] !== avatar) card = card.children[0];
    if (card.children.length < 2 || cards.includes(card)) return { state: 'structure_changed' };
    cards.push(card);
  }
  // Every 赞 and 评论 belongs to a card; one outside means a card was not recognised.
  const controls = leaves.filter(node => ['赞', '评论'].includes(textOf(node)));
  if (controls.some(node => !cards.some(card => card.contains(node)))) return { state: 'structure_changed' };
  const firstCard = cards[0] ?? null;
  const lastCard = cards.at(-1) ?? null;
  const tabs = leaves.filter(node => !firstCard || (node.compareDocumentPosition(firstCard) & 4)).map(node => textOf(node))
    .filter(text => tabLine.test(text));
  if (!cards.length && !tabs.length) return { state: 'structure_changed' };
  // Lines after the list up to the bottom bar, such as 该商品还有3条默认好评 (2026-10-27).
  const notes = [];
  if (lastCard) {
    for (const node of leaves.filter(node => lastCard.compareDocumentPosition(node) & 4 && !lastCard.contains(node))) {
      const text = textOf(node);
      if (['更多', '收藏', '客服', '确定'].includes(text) || /^[¥￥]/.test(text) || notes.length >= limits.notes) break;
      notes.push(text);
    }
  }

  const specLine = new RegExp(limits.specLine);
  const known = new RegExp(limits.knownBlock);
  const read = [];
  let namesSkipped = 0;
  for (const card of cards.slice(0, limits.cards)) {
    const header = [...card.children].find(child => avatarsIn(child) === 1);
    // A header holding 赞 or 评论 is a whole review: the climb went past the card.
    if (!header || header !== card.children[0] || controls.some(node => header.contains(node))) return { state: 'structure_changed' };
    namesSkipped += leaves.filter(node => header.contains(node)).length;
    const rest = [...card.children].slice(1);
    const lines = block => leaves.filter(node => block.contains(node)).map(node => textOf(node));
    const holdsImages = block => [...block.querySelectorAll('img')].some(image => image.getBoundingClientRect().width > 60);
    // Only known blocks leave the page: the spec line, the text right after it and before the review images, and blocks
    // that start like a date, 追评 or 商家回复. Anything else is counted and dropped: a reply preview under a review
    // starts with the replier's nickname (2026-10-27). The action block holds only 赞, 评论, icons and counts.
    const blocks = [];
    let skipped = 0, textTaken = false, imagesSeen = false;
    for (const block of rest) {
      const texts = lines(block);
      const actions = texts.length && texts.every(text => ['赞', '评论'].includes(text) || /^[0-9]{1,6}$/.test(text));
      if (!texts.length || actions) { imagesSeen = imagesSeen || holdsImages(block); continue; }
      if (!blocks.length && !textTaken && texts.length === 1 && specLine.test(texts[0])) blocks.push(texts);
      else if (!textTaken && !imagesSeen) { blocks.push(texts); textTaken = true; }
      else if (known.test(texts[0])) blocks.push(texts);
      else skipped += 1;
      imagesSeen = imagesSeen || holdsImages(block);
    }
    const images = rest.flatMap(block => [...block.querySelectorAll('img')]).filter(image => image.getBoundingClientRect().width > 60).length;
    read.push({ blocks: blocks.slice(0, limits.blocks).map(texts => texts.slice(0, limits.blockLines)), blocks_total: blocks.length,
      images, videos: card.querySelectorAll('video').length, skipped_blocks: skipped });
  }
  return { state: 'observed', product_id: expected.product_id, tabs: tabs.slice(0, limits.tabs).map(text => clip(text, limits.tabLine)), tabs_total: tabs.length,
    cards: read, cards_total: cards.length, names_skipped: namesSkipped, notes };
}

/**
 * @param {string} productId goods_id of the review page. @returns {string} One fixed read-only expression; no click, scroll or request.
 * @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function pddReviewsScript(productId) {
  if (!parsePddReviewsUrl(`https://mobile.pinduoduo.com/goods_comments.html?goods_id=${productId}`)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD goods_id.');
  }
  return `(${collectPddReviews})(${JSON.stringify({ product_id: productId })}, ${pddPageGate}, ${JSON.stringify(LIMITS)})`;
}

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The PDD reviews response does not match the supported page.');
const count = (value, max = 100000) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/**
 * One card's blocks as review fields. Blocks are read in page order: an optional spec line, the text, then blocks
 * recognised by their first line (date, 追评, 商家回复). From format 3 the page sends no other blocks; earlier formats
 * kept them in other_lines.
 */
function reviewFields(card, position, version) {
  if (!card || !Array.isArray(card.blocks) || card.blocks.length > LIMITS.blocks || !count(card.blocks_total, 1000) || card.blocks_total < card.blocks.length ||
      !count(card.images, 1000) || !count(card.videos, 1000) || (version === 3) !== Object.hasOwn(card, 'skipped_blocks') ||
      (version === 3 && !count(card.skipped_blocks, 1000))) throw invalid();
  const blocks = card.blocks.map(lines => {
    if (!Array.isArray(lines) || !lines.length || lines.length > LIMITS.blockLines) throw invalid();
    return lines.map(line => responseText(line, LIMITS.line)).filter(Boolean);
  }).filter(lines => lines.length);
  const review = { position, spec: null, text: null, date: null, follow_up: null, merchant_reply: null, other_lines: [], expand_shown: false,
    images: card.images, videos: card.videos, blocks_cut: card.blocks_total > card.blocks.length,
    ...(version === 3 ? { other_blocks_skipped: card.skipped_blocks } : {}) };
  for (const lines of blocks) {
    const content = lines.filter(line => !CONTROLS.has(line));
    if (lines.includes('展开')) review.expand_shown = true;
    if (!content.length) continue;
    const joined = content.join(' ');
    if (review.spec === null && review.text === null && content.length === 1 && SPEC_LINE.test(joined)) review.spec = joined;
    else if (review.date === null && content.length === 1 && DATE_LINE.test(joined)) review.date = joined;
    else if (review.follow_up === null && FOLLOW_UP.test(content[0])) review.follow_up = joined;
    else if (review.merchant_reply === null && MERCHANT_REPLY.test(content[0])) review.merchant_reply = joined;
    else if (review.text === null) review.text = joined;
    else review.other_lines.push(joined);
  }
  return review;
}

/**
 * Validate one observation of a PDD review page. A format 1 observation has no notes and yields no page_notes; only a
 * format 3 observation counts skipped blocks.
 * @param {unknown} value Raw page observation. @param {string} productId @param {{observedAt?: string, version?: 1|2|3}} [options]
 * @returns {object} Review page fields. @throws {ShoppingError} Page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validatePddReviews(value, productId, { observedAt = new Date().toISOString(), version = PDD_REVIEWS_SCHEMA_VERSION } = {}) {
  const target = parsePddReviewsUrl(`https://mobile.pinduoduo.com/goods_comments.html?goods_id=${productId}`);
  if (!target) throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD goods_id.');
  throwPageError(value?.state);
  if (value?.state !== 'observed' || value.product_id !== productId || !Array.isArray(value.tabs) || value.tabs.length > LIMITS.tabs ||
      !count(value.tabs_total, 1000) || value.tabs_total < value.tabs.length || !Array.isArray(value.cards) || value.cards.length > LIMITS.cards ||
      !count(value.cards_total, 100000) || value.cards_total < value.cards.length || !count(value.names_skipped) ||
      ![1, 2, 3].includes(version) || (version >= 2) !== Object.hasOwn(value, 'notes') ||
      (version >= 2 && (!Array.isArray(value.notes) || value.notes.length > LIMITS.notes))) throw invalid();
  const tabs = value.tabs.map(tab => responseText(tab, LIMITS.tabLine)).filter(Boolean);
  return { product_id: target.product_id, url: target.url, observed_at: observedAt, tabs, tabs_cut: value.tabs_total > value.tabs.length,
    loaded_count: value.cards_total, reviews: value.cards.map((card, index) => reviewFields(card, index + 1, version)),
    reviews_cut: value.cards_total > value.cards.length, reviewer_names_skipped: value.names_skipped,
    ...(version >= 2 ? { page_notes: value.notes.map(note => responseText(note, LIMITS.line)).filter(Boolean) } : {}) };
}

export { PDD_REVIEWS_SCHEMA_VERSION };
