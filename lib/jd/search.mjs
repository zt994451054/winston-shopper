import { ShoppingError } from '../errors.mjs';
import { parseDisplayedPrice } from '../product.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { jdSearchTarget, parseJdProductUrl } from './targets.mjs';

/** First load shows 30 cards (2026-10-15); a scroll may add more, which this first-screen read never triggers. */
export const JD_SEARCH_CARD_LIMIT = 60;
/**
 * Result format. 2 (2026-10-15) keeps amounts shown beside the price in `jd.other_amounts` instead of the label.
 * Format 1 results carry no schema_version and are read back unchanged.
 */
const JD_SEARCH_SCHEMA_VERSION = 2;

/**
 * Internal serialized collector for the first screen of a JD search page. Structure from the 2026-10-15 probes:
 * cards are `.plugin_goodsCardWrapper[data-sku]` without item links; other parts use CSS-module classes `_name_hash_n`.
 * @param {{query: string}} expected @param {Function} gate jdPageGate @param {number} cardLimit
 * @returns {object} Raw guarded observation.
 */
export function collectJdSearch(expected, gate, cardLimit) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keywords = current.searchParams.getAll('keyword');
  if (current.hostname !== 'search.jd.com' || current.pathname !== '/Search' || keywords.length !== 1 || keywords[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const text = (node, max) => String(node?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const ownText = node => [...(node.childNodes ?? [])].filter(child => child.nodeType === 3).map(child => child.nodeValue).join('').replace(/\s+/g, '');
  // CSS-module class tokens look like `_price_9y3st_31`; the hash changes between releases, the module name does not.
  const inModule = name => node => String(node.getAttribute('class') ?? '').split(/\s+/).some(token => new RegExp(`^${name}_[a-z0-9]{5}_[0-9]+$`).test(token));
  const firstOf = (root, name) => [...root.querySelectorAll(`[class*="${name}_"]`)].find(inModule(name)) ?? null;
  const allOf = (root, name) => [...root.querySelectorAll(`[class*="${name}_"]`)].filter(inModule(name));

  const cards = [...document.querySelectorAll('.plugin_goodsCardWrapper[data-sku]')].filter(visible);
  if (!cards.length) return { state: 'structure_changed' };
  const items = cards.slice(0, cardLimit).map(card => {
    const titleRegion = firstOf(card, '_goods_title_container');
    const titled = titleRegion ? [...titleRegion.querySelectorAll('[title]')][0] : null;
    const price = firstOf(card, '_price');
    const priceBlock = price?.parentElement ?? null;
    const besidePrice = priceBlock ? [...priceBlock.children].filter(child => child !== price).filter(child => text(child, 60)) : [];
    // A second amount (gray, e.g. ¥89 beside ¥80.1 补贴到手价) is kept apart from the label; the page does not say what it is.
    const isAmount = child => /^[¥￥]\s*[0-9]/.test(text(child, 60));
    const lineThrough = node => [node, ...node.querySelectorAll('*')].some(part => String(getComputedStyle(part).textDecorationLine ?? '').includes('line-through'));
    return {
      sku: String(card.getAttribute('data-sku') ?? '').slice(0, 40),
      title: String(titled?.getAttribute('title') || text(titleRegion, 300)).slice(0, 300),
      shop: text(firstOf(card, '_name'), 200), sales_text: text(firstOf(card, '_goods_volume'), 120),
      price: { raw: text(priceBlock, 300), amount_text: text(price, 60).replace(/\s+/g, ''),
        label: besidePrice.filter(child => !isAmount(child)).map(child => text(child, 60)).join(' ').slice(0, 120),
        other_amounts: besidePrice.filter(isAmount).slice(0, 3).map(child => ({ text: text(child, 40), line_through: lineThrough(child) })) },
      self_operated: [...card.querySelectorAll('img')].some(image => String(image.getAttribute('alt') ?? '').includes('自营')),
      sponsored: [...card.querySelectorAll('div, span')].some(node => ownText(node) === '广告'),
      tags: allOf(card, '_textTag').filter(visible).map(node => text(node, 20)).filter(Boolean).slice(0, 10),
    };
  });
  // 仅显示有货 was ticked by default on 2026-10-15; it narrows the results, so its state is part of the result.
  const stockLabel = [...document.querySelectorAll('span')].find(node => ownText(node) === '仅显示有货');
  const nearAncestors = [];
  for (let node = stockLabel; node && nearAncestors.length < 4; node = node.parentElement) nearAncestors.push(node);
  const stockActive = stockLabel
    ? nearAncestors.some(node => String(node.getAttribute('class') ?? '').split(/\s+/).some(token => token.includes('__active'))) : null;
  return { state: 'observed', query: expected.query, items, cards_seen: cards.length, in_stock_only: stockActive };
}

/**
 * @param {{query: string, url: string}} target A canonical JD first-page search identity.
 * @returns {string} One fixed read-only expression; no click, scroll or request.
 * @throws {ShoppingError} INVALID_SEARCH.
 */
export function jdSearchScript(target) {
  const expected = jdSearchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use a canonical JD search target.');
  return `(${collectJdSearch})(${JSON.stringify({ query: expected.query })}, ${jdPageGate}, ${JD_SEARCH_CARD_LIMIT})`;
}

function flag(value) {
  if (typeof value !== 'boolean') throw new ShoppingError('INVALID_RESPONSE', 'The JD search response contains an invalid flag.');
  return value;
}

function otherAmounts(value) {
  if (!Array.isArray(value) || value.length > 3) throw new ShoppingError('INVALID_RESPONSE', 'The JD search response contains invalid extra amounts.');
  return value.map(amount => ({ text: responseText(amount?.text, 40), line_through: flag(amount?.line_through) }));
}

/**
 * Validate one first-screen observation into the shared search result shape; JD-only marks stay under `jd`.
 * @param {unknown} value Raw page observation. @param {object} target Canonical JD search target.
 * @param {{observedAt?: string, schemaVersion?: 1|2}} [options] schemaVersion 1 only rebuilds saved format 1 results.
 * @returns {object} Search result. @throws {ShoppingError} Page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validateJdSearch(value, target, { observedAt = new Date().toISOString(), schemaVersion = JD_SEARCH_SCHEMA_VERSION } = {}) {
  const expected = jdSearchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use a canonical JD search target.');
  throwPageError(value?.state);
  if (value?.state !== 'observed' || value.query !== target.query || !Array.isArray(value.items) || value.items.length < 1 ||
      value.items.length > JD_SEARCH_CARD_LIMIT || !Number.isSafeInteger(value.cards_seen) || value.cards_seen < value.items.length ||
      value.cards_seen > 10000 || ![true, false, null].includes(value.in_stock_only)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The JD search response does not match the requested first page.');
  }
  const ids = new Set(), items = [];
  let unsupported = 0;
  value.items.forEach((item, index) => {
    const product = /^[0-9]{1,20}$/.test(item?.sku ?? '') ? parseJdProductUrl(`https://item.jd.com/${item.sku}.html`) : null;
    if (!product) { unsupported += 1; return; }
    const title = responseText(item.title, 300);
    if (!title) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'A JD search card is missing its title.');
    if (!Array.isArray(item.tags) || item.tags.length > 10) throw new ShoppingError('INVALID_RESPONSE', 'The JD search response contains invalid tags.');
    const raw = responseText(item.price?.raw, 300), amountText = responseText(item.price?.amount_text, 60), label = responseText(item.price?.label, 120);
    const normalized = { position: index + 1, product_id: product.product_id, url: product.url, title,
      shop: responseText(item.shop, 200), sales_text: responseText(item.sales_text, 120),
      price: { raw, amount_text: amountText, label, ...parseDisplayedPrice(amountText, raw), currency: 'CNY', eligibility_verified: false, sku_price_binding_verified: false },
      jd: { self_operated: flag(item.self_operated), sponsored: flag(item.sponsored), tags: item.tags.map(tag => responseText(tag, 20)),
        ...(schemaVersion === 2 ? { other_amounts: otherAmounts(item.price?.other_amounts) } : {}) } };
    if (!ids.has(product.product_id)) { ids.add(product.product_id); items.push(normalized); }
  });
  if (!items.length) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'No loaded JD search card has a product number.');
  return {
    ...(schemaVersion === 2 ? { schema_version: 2 } : {}), platform: 'jd', query: target.query, url: target.url, page: 1, source: 'loaded_search_cards', observed_at: observedAt, login_verified: false,
    items, cards_seen: value.cards_seen, cards_scanned: value.items.length,
    duplicates_omitted: value.items.length - items.length - unsupported, unsupported_cards_omitted: unsupported,
    coverage: { status: 'partial', scope: 'first_screen_loaded_cards', sort_verified: false, filters_verified: false, total_results_known: false,
      in_stock_only: value.in_stock_only },
    limits: { cards: JD_SEARCH_CARD_LIMIT },
    missing: ['cards_below_first_screen', 'subsequent_pages', 'verified_sort_and_filters', 'verified_payable_prices'],
  };
}

/**
 * Rebuild a saved result from its own fields and require an identical copy, so edited caches are rejected.
 * @param {object} value Saved result. @param {object} target @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateSavedJdSearch(value, target) {
  try {
    if (typeof value?.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) || !Array.isArray(value.items) ||
        !Number.isSafeInteger(value.cards_scanned) || value.cards_scanned > JD_SEARCH_CARD_LIMIT || value.cards_scanned < value.items.length) throw new Error();
    // Skipped cards are not saved, so they are rebuilt as unsupported placeholders after the kept ones.
    if (![undefined, 2].includes(value.schema_version)) throw new Error();
    const schemaVersion = value.schema_version ?? 1;
    const placeholders = Array.from({ length: value.cards_scanned - value.items.length }, () => ({ sku: '' }));
    const rebuilt = validateJdSearch({ state: 'observed', query: value.query, cards_seen: value.cards_seen, in_stock_only: value.coverage?.in_stock_only,
      items: [...value.items.map(item => ({ sku: item.product_id, title: item.title, shop: item.shop, sales_text: item.sales_text,
        price: { raw: item.price.raw, amount_text: item.price.amount_text, label: item.price.label, other_amounts: item.jd.other_amounts },
        self_operated: item.jd.self_operated, sponsored: item.jd.sponsored, tags: item.jd.tags })), ...placeholders] }, target,
    { observedAt: value.observed_at, schemaVersion });
    let previous = 0;
    rebuilt.items.forEach((item, index) => {
      const position = value.items[index].position;
      if (!Number.isInteger(position) || position <= previous || position > value.cards_scanned) throw new Error();
      item.position = position; previous = position;
    });
    rebuilt.duplicates_omitted = value.duplicates_omitted; rebuilt.unsupported_cards_omitted = value.unsupported_cards_omitted;
    if (!Number.isSafeInteger(value.duplicates_omitted) || !Number.isSafeInteger(value.unsupported_cards_omitted) || value.duplicates_omitted < 0 ||
        value.unsupported_cards_omitted < 0 || value.duplicates_omitted + value.unsupported_cards_omitted !== value.cards_scanned - value.items.length ||
        JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved JD search result is invalid.'); }
}
