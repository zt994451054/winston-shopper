import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { parseJdCartUrl, parseJdProductUrl } from './targets.mjs';

/** Loaded rows kept in the result. Rows past this are counted and not parsed (2026-10-15 cart read). */
export const JD_CART_ROW_LIMIT = 100;
/** Service tags kept on one row. */
export const JD_CART_TAG_LIMIT = 10;
const JD_CART_SCHEMA_VERSION = 1;
const RAW_KEYS = ['state', 'header_count_text', 'shops', 'rows', 'rows_seen', 'shops_seen', 'rows_outside_shops'];
const SHOP_KEYS = ['position', 'name', 'zy_icon', 'rows_seen'];
const ROW_KEYS = ['position', 'shop_position', 'product_id', 'title', 'spec_label', 'spec_text', 'price_text', 'price_kind',
  'other_amount_text', 'quantity', 'checkbox_disabled', 'checkbox_checked', 'mask_text', 'title_unavailable', 'similar_entry',
  'tags', 'remind_text'];

/**
 * Read the cart rows already painted on the page. Hashed class prefixes come from the 2026-10-15 cart probe:
 * the hash changes between releases, so match the stable module name, not the search page's stricter token shape.
 * Empty carts were not in that read, so a missing list or a list with no product rows is structure_changed.
 * @param {{url: string}} expected Canonical cart address.
 * @param {Function} gate jdPageGate.
 * @param {{rows: number, tags: number}} limits Row and tag caps.
 * @returns {object} Raw guarded observation, without availability or canonical product links.
 */
export function collectJdCart(expected, gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  // cart.action and cart_index/ are the same cart; the canonical address is only checked again in Node.
  const cartPaths = ['/cart_index', '/cart_index/', '/cart.action'];
  if (expected?.url !== 'https://cart.jd.com/cart_index' || current.hostname !== 'cart.jd.com' || !cartPaths.includes(current.pathname)) {
    return { state: 'target_changed' };
  }
  const textOf = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const nodeText = (node, max) => textOf(node?.innerText, max);
  const blank = value => value || null;
  const first = (root, selector) => root ? [...root.querySelectorAll(selector)][0] ?? null : null;
  const all = (root, selector) => root ? [...root.querySelectorAll(selector)] : [];
  // Protocol-relative, http and https item links, with an optional query. A trailing slash is not a product link.
  const itemId = href => /^(?:https?:)?\/\/item\.jd\.com\/([0-9]{1,20})\.html(?:[?#].*)?$/.exec(String(href ?? ''))?.[1] ?? null;

  const lists = all(document, '[class*="_infiniteScroll_center_"]');
  if (lists.length !== 1) return { state: 'structure_changed' };
  const list = lists[0];
  const headerNode = first(document, '[class*="_cartNum_"] .number');
  const header = textOf(headerNode?.innerText, 200).replace(/[()（）\s]/g, '').slice(0, 20);
  const shops = all(list, '[class*="_card_"][data-vendorid]').map((shop, index) => {
    const items = all(shop, '[class*="_product-item_"]');
    return {
      position: index + 1,
      name: nodeText(first(shop, '[class*="_shopName_"]'), 80),
      // `_zy_` on the vendor icon was present for self-operated shops; what it guarantees is still unverified.
      zy_icon: Boolean(first(shop, '[class*="_vendorIcon_"][class*="_zy_"]')),
      rows_seen: items.length,
      items,
    };
  });
  const rowsSeen = shops.reduce((total, shop) => total + shop.rows_seen, 0);
  if (rowsSeen < 1) return { state: 'structure_changed' };
  // Rows outside every shop group are counted only, so a short read is never silent.
  const rowsOutsideShops = all(list, '[class*="_product-item_"]').length - rowsSeen;
  const rows = [];
  // Past the cap, rows are counted on the shop and not parsed.
  shopLoop: for (const shop of shops) {
    for (const item of shop.items) {
      if (rows.length >= limits.rows) break shopLoop;
      const link = first(item, 'a[class*="_goodTitle_"]');
      const title = textOf(link?.getAttribute('title'), 300) || nodeText(link, 300);
      // Spec text lives under the extra column. `_title-txt_` is a different module and must not win.
      const extra = first(item, '[class*="_flexGoodExtra_"]');
      // `_p-price-cont_` does not contain `_p-price_` (the character after "price" is "-"), so the status line stays separate.
      const normal = nodeText(first(item, '[class*="_price-normal_"]'), 80);
      const status = nodeText(first(item, '[class*="_p-price_"]'), 80);
      const checkRoot = first(item, '[class*="_good-check_"]');
      const check = checkRoot ? first(checkRoot, 'input') : null;
      const checkClass = checkRoot ? first(checkRoot, '[class*="_checkbox_"]')?.getAttribute('class') ?? '' : '';
      const quantityInput = first(item, '[class*="_cart-number_"] input');
      const quantityText = quantityInput ? String(quantityInput.value ?? '') : '';
      rows.push({
        position: rows.length + 1,
        shop_position: shop.position,
        product_id: itemId(link?.getAttribute('href')),
        title,
        spec_label: blank(nodeText(first(extra, '[class*="_label_"]'), 80)),
        spec_text: blank(nodeText(first(extra, '[class*="_txt_"]'), 80)),
        price_text: normal || status || null,
        price_kind: normal ? 'normal' : status ? 'status_text' : null,
        other_amount_text: blank(nodeText(first(item, '[class*="_product-price-sku_"]'), 80)),
        quantity: /^(?:0|[1-9][0-9]{0,5})$/.test(quantityText) ? Number(quantityText) : null,
        checkbox_disabled: check ? check.disabled === true || String(checkClass).includes('_disabled_') : null,
        checkbox_checked: check ? check.checked === true : null,
        mask_text: blank(nodeText(first(item, '[class*="_viewer_mask_"]'), 80)),
        title_unavailable: String(link?.getAttribute('class') ?? '').includes('_title__unavailable_'),
        similar_entry: Boolean(first(item, '[class*="_similarSearchBox_"]')),
        tags: all(first(item, '[class*="_detail-tags_"]'), 'span').map(node => nodeText(node, 20)).filter(Boolean).slice(0, limits.tags),
        remind_text: blank(nodeText(first(item, '[class*="_remindWrapper_"]'), 200)),
      });
    }
  }
  return {
    state: 'observed',
    header_count_text: header || null,
    shops: shops.map(shop => ({ position: shop.position, name: shop.name, zy_icon: shop.zy_icon, rows_seen: shop.rows_seen })),
    rows, rows_seen: rowsSeen, shops_seen: shops.length, rows_outside_shops: rowsOutsideShops,
  };
}

/**
 * Classify one loaded row from explicit page signals. A disabled checkbox plus any other cannot-buy signal wins
 * even when the product number is missing; missing_product_id is recorded only when the row does not reach cannot_buy.
 * Tags, remind text, the similar entry, the checked state and the second amount are not signals.
 * @param {object} row Row fields after normalization.
 * @returns {{status: 'cannot_buy'|'no_marker_seen'|'unrecognized', reasons: string[]}}
 */
export function classifyJdCartAvailability(row) {
  const mask = typeof row.mask_text === 'string' && row.mask_text ? row.mask_text : null;
  const unavailable = row.title_unavailable === true;
  const statusPrice = row.price_kind === 'status_text';
  const otherSignal = Boolean(mask) || unavailable || statusPrice;
  if (row.checkbox_disabled === true && otherSignal) {
    return { status: 'cannot_buy', reasons: [mask, statusPrice ? row.price_text : null].filter(Boolean) };
  }
  const productId = typeof row.product_id === 'string' && row.product_id ? row.product_id : '';
  if (row.checkbox_disabled === false && !mask && !unavailable && row.price_kind === 'normal' && row.quantity !== null && productId) {
    return { status: 'no_marker_seen', reasons: [] };
  }
  const reasons = [];
  if (row.checkbox_disabled === null) reasons.push('missing_checkbox');
  if (row.checkbox_disabled === true && !otherSignal) reasons.push('checkbox_disabled_without_other_signal');
  if (row.checkbox_disabled === false && mask) reasons.push('unexpected_mask');
  if (row.checkbox_disabled === false && unavailable) reasons.push('title_unavailable_without_disabled_checkbox');
  if (row.price_kind === null) reasons.push('no_price');
  if (statusPrice && row.checkbox_disabled !== true) reasons.push('price_status_text');
  // A disabled checkbox without another cannot-buy signal is unrecognized for that reason alone; a missing quantity is expected there.
  if (row.quantity === null && row.checkbox_disabled !== true) reasons.push('missing_quantity');
  if (!productId) reasons.push('missing_product_id');
  return { status: 'unrecognized', reasons };
}

/**
 * @param {{platform: 'jd', url: string}} target Canonical cart identity from parseJdCartUrl.
 * @returns {string} One read-only expression.
 * @throws {ShoppingError} INVALID_ARGUMENTS when the target is not the canonical cart.
 */
export function jdCartScript(target) {
  const expected = canonicalTarget(target);
  return `(${collectJdCart})(${JSON.stringify({ url: expected.url })}, ${jdPageGate}, ${JSON.stringify({ rows: JD_CART_ROW_LIMIT, tags: JD_CART_TAG_LIMIT })})`;
}

const invalid = () => { throw new ShoppingError('INVALID_RESPONSE', 'The JD cart response does not match the cart page.'); };

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function canonicalTarget(target) {
  const expected = parseJdCartUrl(target?.url);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(target)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a canonical JD cart target.');
  }
  return expected;
}

function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}

function optionalText(value, max) {
  if (value === null) return null;
  const text = responseText(value, max);
  if (!text) invalid();
  return text;
}

function flag(value) {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function productLink(value) {
  if (value === null) return { product_id: null, url: null };
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) invalid();
  const parsed = parseJdProductUrl(`https://item.jd.com/${value}.html`);
  if (!parsed || parsed.product_id !== value) invalid();
  return { product_id: parsed.product_id, url: parsed.url };
}

/**
 * Validate one cart observation into the saved result shape. Availability is recomputed here.
 * @param {unknown} value Raw page observation.
 * @param {{platform: 'jd', url: string}} target Canonical cart identity.
 * @param {{observedAt?: string}} [options]
 * @returns {object} Cart result, schema version 1.
 * @throws {ShoppingError} INVALID_ARGUMENTS, page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validateJdCart(value, target, { observedAt = new Date().toISOString() } = {}) {
  const expected = canonicalTarget(target);
  throwPageError(value?.state);
  if (value?.state !== 'observed' || !sameKeys(value, RAW_KEYS) || !Array.isArray(value.shops) || !Array.isArray(value.rows)) invalid();
  const header = value.header_count_text === null ? null : responseText(value.header_count_text, 20);
  if (header === '') invalid();
  const rowsSeen = integer(value.rows_seen, 1, 10000);
  const shopsSeen = integer(value.shops_seen, 1, 10000);
  const rowsOutsideShops = integer(value.rows_outside_shops, 0, 10000);
  if (shopsSeen !== value.shops.length || value.rows.length !== Math.min(rowsSeen, JD_CART_ROW_LIMIT)) invalid();
  const shops = value.shops.map((shop, index) => {
    if (!sameKeys(shop, SHOP_KEYS) || shop.position !== index + 1 || typeof shop.zy_icon !== 'boolean') invalid();
    return { position: shop.position, name: responseText(shop.name, 80), zy_icon: shop.zy_icon, rows_seen: integer(shop.rows_seen, 0, 10000) };
  });
  if (shops.reduce((total, shop) => total + shop.rows_seen, 0) !== rowsSeen) invalid();
  const rows = [];
  let cursor = 0;
  for (const shop of shops) {
    const take = Math.min(shop.rows_seen, value.rows.length - cursor);
    for (let index = 0; index < take; index += 1) {
      const row = value.rows[cursor];
      if (!sameKeys(row, ROW_KEYS) || row.position !== cursor + 1 || row.shop_position !== shop.position) invalid();
      const link = productLink(row.product_id);
      const priceKind = row.price_kind;
      if (!['normal', 'status_text', null].includes(priceKind)) invalid();
      const priceText = priceKind === null ? (row.price_text === null ? null : invalid()) : optionalText(row.price_text, 80);
      if ((priceKind === null) !== (priceText === null)) invalid();
      const quantity = row.quantity === null ? null : integer(row.quantity, 0, 999999);
      const checkboxDisabled = row.checkbox_disabled;
      const checkboxChecked = row.checkbox_checked;
      if (!((checkboxDisabled === null && checkboxChecked === null) || (typeof checkboxDisabled === 'boolean' && typeof checkboxChecked === 'boolean'))) invalid();
      if (!Array.isArray(row.tags) || row.tags.length > JD_CART_TAG_LIMIT) invalid();
      const normalized = {
        position: row.position, shop_position: row.shop_position, product_id: link.product_id, url: link.url,
        title: responseText(row.title, 300), spec_label: optionalText(row.spec_label, 80), spec_text: optionalText(row.spec_text, 80),
        price_text: priceText, price_kind: priceKind, other_amount_text: optionalText(row.other_amount_text, 80), quantity,
        checkbox_disabled: checkboxDisabled, checkbox_checked: checkboxChecked, mask_text: optionalText(row.mask_text, 80),
        title_unavailable: flag(row.title_unavailable), similar_entry: flag(row.similar_entry),
        tags: row.tags.map(tag => optionalText(tag, 20)), remind_text: optionalText(row.remind_text, 200),
      };
      normalized.availability = classifyJdCartAvailability(normalized);
      rows.push(normalized);
      cursor += 1;
    }
  }
  if (cursor !== rows.length) invalid();
  const availabilitySummary = { cannot_buy: 0, no_marker_seen: 0, unrecognized: 0 };
  let quantitySum = 0;
  for (const row of rows) {
    availabilitySummary[row.availability.status] += 1;
    quantitySum += row.quantity ?? 0;
  }
  return {
    schema_version: JD_CART_SCHEMA_VERSION, platform: 'jd', url: expected.url, source: 'jd_cart_dom', observed_at: observedAt, login_verified: false,
    header_count_text: header, shops, rows, rows_seen: rowsSeen, rows_returned: rows.length, rows_omitted: rowsSeen - rows.length, shops_seen: shopsSeen,
    rows_outside_shops: rowsOutsideShops, quantity_sum: quantitySum, availability_summary: availabilitySummary,
    coverage: { status: 'partial', scope: 'loaded_rows_only', scrolled: false, full_cart: false, header_count_meaning_verified: false,
      payable_price_verified: false, checkout_selection_read: false },
    missing: ['rows_not_loaded', 'checkout_totals', 'payable_prices', ...(rowsOutsideShops > 0 ? ['rows_outside_shops'] : [])],
    excluded: ['address', 'account', 'internal_ids', 'images', 'recommendations', 'checkout_bar'],
  };
}

/**
 * Rebuild a saved cart result from its own fields and require an identical copy.
 * @param {object} value Saved result. @param {{platform: 'jd', url: string}} target Canonical cart identity.
 * @returns {void}
 * @throws {ShoppingError} INVALID_CHECKPOINT when the saved result is inconsistent, including a bad target.
 */
export function validateSavedJdCart(value, target) {
  try {
    if (value?.schema_version !== 1 || typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) ||
        !Array.isArray(value.shops) || !Array.isArray(value.rows)) throw new Error();
    const rebuilt = validateJdCart({
      state: 'observed', header_count_text: value.header_count_text, shops: value.shops, rows_seen: value.rows_seen, shops_seen: value.shops_seen,
      rows_outside_shops: value.rows_outside_shops,
      rows: value.rows.map(row => {
        if (!row || typeof row !== 'object') throw new Error();
        const copy = { ...row };
        delete copy.url;
        delete copy.availability;
        return copy;
      }),
    }, target, { observedAt: value.observed_at });
    if (JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error();
  } catch {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The saved JD cart result is invalid.');
  }
}
