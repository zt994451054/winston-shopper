import { ShoppingError } from '../errors.mjs';
import { parseDisplayedPrice } from '../product.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { pddPageGate } from './page-gate.mjs';
import { pddSearchTarget } from './targets.mjs';

/** The first load held 20 cards (2026-10-27); scrolling adds more, which this read never triggers. */
export const PDD_SEARCH_CARD_LIMIT = 40;
const MAX_LINES = 20;
// Format 2 (2026-10-28) counts the cards the page had not drawn yet (cards_not_rendered); format 1 results are rebuilt as saved.
const PDD_SEARCH_SCHEMA_VERSION = 2;
// Short words PDD puts right before ¥ to qualify the amount; seen live: 券后 (2026-10-27).
const PRICE_LABEL = /^(券后|到手价?|拼单价|补贴价|折后|新人价)$/;
const SALES = /已抢|已拼|已售|总售|热销|人付款/;

/**
 * Internal serialized collector for the loaded cards of a PDD search page. Structure from the 2026-10-27 probes: class
 * names are hashed and cards carry no links or ids; each card holds exactly one ¥ sign (see pddSearchCards), and its
 * rendered lines run title, labels, an optional 券后, ¥, amount, optional decimals, sales text. Cards not yet scrolled to
 * keep their image address in data-src.
 * @param {{query: string}} expected @param {Function} gate pddPageGate @param {number} cardLimit @param {number} lineLimit
 * @param {Function} pddSearchCards Card finder, passed in because page scripts are serialized.
 * @returns {object} Raw guarded observation.
 */
export function collectPddSearch(expected, gate, cardLimit, lineLimit, pddSearchCards) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keys = current.searchParams.getAll('search_key');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/search_result.html' || keys.length !== 1 || keys[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const yen = [...document.querySelectorAll('body *')].filter(node => node.children.length === 0 && /^[¥￥]/.test(String(node.textContent).trim()));
  if (!yen.length) return { state: 'structure_changed' };
  const cards = pddSearchCards(yen);
  if (!cards) return { state: 'structure_changed' };
  const linesOf = card => String(card.innerText ?? '').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // The result list sits in a content-visibility: auto container, so cards far below the screen are not drawn and have no
  // rendered text (2026-10-28: one-column iPhone cards from the 9th on, visible page or not). Reading stops at the first
  // such card instead of guessing its lines from hidden markup, and the page is not moved to draw it.
  const scanned = cards.slice(0, cardLimit);
  const firstBlank = scanned.findIndex(card => !linesOf(card).length);
  if (firstBlank === 0) return { state: 'structure_changed' };
  const drawn = firstBlank < 0 ? scanned : scanned.slice(0, firstBlank);
  const items = drawn.map(card => {
    const lines = linesOf(card);
    const main = [...card.querySelectorAll('img')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    const src = main ? String(main.getAttribute('src') ?? '') : '', lazy = main ? String(main.getAttribute('data-src') ?? '') : '';
    return { lines: lines.slice(0, lineLimit).map(line => line.slice(0, 300)), lines_total: lines.length,
      image: (/^https:\/\/[a-z0-9.-]+\.pddpic\.com\//.test(src) ? src : lazy).slice(0, 2000) };
  });
  return { state: 'observed', query: expected.query, items, cards_seen: cards.length, cards_not_rendered: firstBlank < 0 ? 0 : cards.length - firstBlank };
}

/**
 * In-page: the search cards around the given ¥ signs, in reading order. A card is the highest ancestor of one ¥ that
 * holds no other ¥, so it works both for one grid and for the two separate columns a page shows after 返回 (2026-10-27).
 * Cards are ordered top to bottom, then left to right; with one grid that is the page order. Serialized into page scripts,
 * so it uses nothing outside its arguments.
 * @param {Element[]} yen Leaf elements whose text starts with ¥. @returns {Element[]|null} null when a card has no image.
 */
export function pddSearchCards(yen) {
  if (!yen.length) return null;
  let cards;
  if (yen.length === 1) {
    // A single ¥ has no neighbour to stop at, so its card is the nearest ancestor that holds an image.
    let single = yen[0];
    while (single && !single.querySelector('img')) single = single.parentElement;
    cards = single ? [single] : [];
  } else {
    const signsIn = node => yen.filter(sign => node.contains(sign)).length;
    cards = yen.map(sign => {
      let card = sign;
      while (card.parentElement && signsIn(card.parentElement) === 1) card = card.parentElement;
      return card;
    });
  }
  if (!cards.length || cards.some(card => !card.querySelector('img'))) return null;
  const placed = cards.map((card, index) => ({ card, index, box: card.getBoundingClientRect() }));
  placed.sort((a, b) => (Math.round(a.box.top ?? 0) - Math.round(b.box.top ?? 0)) || ((a.box.left ?? 0) - (b.box.left ?? 0)) || a.index - b.index);
  return placed.map(item => item.card);
}

/**
 * @param {{query: string, url: string}} target A canonical PDD search identity.
 * @returns {string} One fixed read-only expression; no click, scroll or request.
 * @throws {ShoppingError} INVALID_SEARCH.
 */
export function pddSearchScript(target) {
  const expected = pddSearchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use a canonical PDD search target.');
  return `(${collectPddSearch})(${JSON.stringify({ query: expected.query })}, ${pddPageGate}, ${PDD_SEARCH_CARD_LIMIT}, ${MAX_LINES}, ${pddSearchCards})`;
}

/** A pddpic.com https image address, or null; nothing else is kept. */
function imageUrl(value) {
  const text = responseText(value, 2000);
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname.endsWith('.pddpic.com') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/**
 * Split one card's rendered lines into the shared search fields. The page gives no ids or roles, so the parts are
 * found by position around the ¥ line; the lines themselves are kept under `pdd.lines`.
 * @param {string[]} lines @returns {object} @throws {ShoppingError} PAGE_STRUCTURE_CHANGED.
 */
function cardFields(lines) {
  const sign = lines.findIndex(line => /^[¥￥]/.test(line));
  if (sign < 1) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'A PDD search card has no title before its price.');
  let end = sign + 1;
  const inline = lines[sign].replace(/^[¥￥]\s*/, '');
  const amountParts = inline ? [inline] : [];
  while (end < lines.length && /^\.?[0-9][0-9.]*$/.test(lines[end]) && amountParts.join('').length < 20) amountParts.push(lines[end++]);
  const amountText = amountParts.join('');
  const label = PRICE_LABEL.test(lines[sign - 1]) && sign > 1 ? lines[sign - 1] : '';
  const after = lines.slice(end);
  return {
    title: lines[0],
    labels: lines.slice(1, label ? sign - 1 : sign),
    price: { raw: [label, '¥', amountText].filter(Boolean).join(' '), amount_text: amountText, label },
    sales_text: after.find(line => SALES.test(line)) ?? '',
    after_price: after.filter(line => !SALES.test(line)),
  };
}

/**
 * Validate one observation of the loaded search cards. PDD cards carry no product number and only a shortened title,
 * so product_id and url are null and the coverage says so (user decision A, 2026-10-27).
 * @param {unknown} value Raw page observation. @param {object} target Canonical PDD search target.
 * @param {{observedAt?: string, version?: number}} [options] version 1 rebuilds a result saved before cards_not_rendered.
 * @returns {object} Search result. @throws {ShoppingError} Page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validatePddSearch(value, target, { observedAt = new Date().toISOString(), version = PDD_SEARCH_SCHEMA_VERSION } = {}) {
  const expected = pddSearchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use a canonical PDD search target.');
  throwPageError(value?.state);
  if (value?.state !== 'observed' || value.query !== target.query || !Array.isArray(value.items) || value.items.length < 1 ||
      value.items.length > PDD_SEARCH_CARD_LIMIT || !Number.isSafeInteger(value.cards_seen) || value.cards_seen < value.items.length || value.cards_seen > 10000 ||
      (version >= 2 && (!Number.isSafeInteger(value.cards_not_rendered) || value.cards_not_rendered < 0 || value.items.length + value.cards_not_rendered > value.cards_seen))) {
    throw new ShoppingError('INVALID_RESPONSE', 'The PDD search response does not match the requested page.');
  }
  const items = value.items.map((item, index) => {
    if (!Array.isArray(item?.lines) || item.lines.length > MAX_LINES || !Number.isSafeInteger(item.lines_total) || item.lines_total < item.lines.length) {
      throw new ShoppingError('INVALID_RESPONSE', 'The PDD search response contains invalid card lines.');
    }
    const lines = item.lines.map(line => responseText(line, 300)).filter(Boolean);
    const fields = cardFields(lines);
    return { position: index + 1, product_id: null, url: null, title: fields.title, sales_text: fields.sales_text,
      price: { ...fields.price, ...parseDisplayedPrice(fields.price.amount_text, fields.price.raw), currency: 'CNY', eligibility_verified: false, sku_price_binding_verified: false },
      image_url: imageUrl(item.image),
      pdd: { labels: fields.labels, after_price: fields.after_price, lines, lines_cut: item.lines_total > item.lines.length } };
  });
  return {
    schema_version: version, platform: 'pdd', query: target.query, url: target.url, page: 1, source: 'loaded_search_cards',
    observed_at: observedAt, login_verified: false, items, cards_seen: value.cards_seen, cards_scanned: value.items.length,
    ...(version >= 2 ? { cards_not_rendered: value.cards_not_rendered } : {}),
    coverage: { status: 'partial', scope: 'loaded_search_cards', product_ids_known: false, titles_complete: false, sort_verified: false,
      filters_verified: false, total_results_known: false },
    limits: { cards: PDD_SEARCH_CARD_LIMIT },
    missing: ['product_ids', 'full_titles', 'cards_not_loaded', ...(version >= 2 && value.cards_not_rendered ? ['cards_not_rendered'] : []),
      'verified_sort_and_filters', 'verified_payable_prices'],
  };
}

/**
 * Rebuild a saved result from its kept card lines and require an identical copy, so edited caches are rejected.
 * @param {object} value Saved result. @param {object} target @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateSavedPddSearch(value, target) {
  try {
    if (![1, PDD_SEARCH_SCHEMA_VERSION].includes(value?.schema_version) || typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) ||
        !Array.isArray(value.items) || value.cards_scanned !== value.items.length) throw new Error();
    const rebuilt = validatePddSearch({ state: 'observed', query: value.query, cards_seen: value.cards_seen,
      ...(value.schema_version >= 2 ? { cards_not_rendered: value.cards_not_rendered } : {}),
      items: value.items.map(item => ({ lines: item.pdd.lines, lines_total: item.pdd.lines.length + (item.pdd.lines_cut === true ? 1 : 0),
        image: item.image_url ?? '' })) }, target, { observedAt: value.observed_at, version: value.schema_version });
    if (JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved PDD search result is invalid.'); }
}
