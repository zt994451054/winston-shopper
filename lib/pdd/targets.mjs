import { ShoppingError } from '../errors.mjs';
import { searchTarget } from '../search.mjs';

// PDD has no full desktop shop; its mobile web site works in desktop Chrome (probe, 2026-10-27). Only this host was seen.
const HOST = 'mobile.pinduoduo.com';
const ORIGIN = `https://${HOST}`;
// Login and limit pages have not been seen yet; these paths are PDD's known ones and still need confirming live.
const LOGIN_PATHS = new Set(['/login.html']);
const RISK_PATHS = new Set(['/psnl_verification.html', '/verification.html']);

function webUrl(value, { httpsOnly = true } = {}) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!(httpsOnly ? ['https:'] : ['https:', 'http:']).includes(url.protocol) || url.username || url.password || url.port) return null;
  return url;
}

const isPddHost = hostname => hostname === 'pinduoduo.com' || hostname.endsWith('.pinduoduo.com') || hostname.endsWith('.yangkeduo.com');

/** The single value of one query parameter on a mobile.pinduoduo.com page, or null. */
function onlyParam(url, pathname, name, pattern) {
  if (url?.hostname !== HOST || url.pathname !== pathname) return null;
  const values = url.searchParams.getAll(name);
  return values.length === 1 && pattern.test(values[0]) ? values[0] : null;
}

const GOODS_ID = /^[0-9]{1,20}$/;

/**
 * Parse a PDD product page. A search card opens it with a dozen tracking parameters; goods_id alone opens it too (2026-10-27).
 * @param {unknown} value @returns {{platform: 'pdd', origin: string, pathname: string, product_id: string, url: string}|null}
 * @example parsePddProductUrl('https://mobile.pinduoduo.com/goods.html?goods_id=123&refer_page_name=search_result') // url with goods_id only
 */
export function parsePddProductUrl(value) {
  const id = onlyParam(webUrl(value), '/goods.html', 'goods_id', GOODS_ID);
  if (!id) return null;
  return { platform: 'pdd', origin: ORIGIN, pathname: '/goods.html', product_id: id, url: `${ORIGIN}/goods.html?goods_id=${id}` };
}

/**
 * The 查看全部 review page of one product, reached from its product page in the same tab.
 * @param {unknown} value @returns {{platform: 'pdd', product_id: string, url: string}|null}
 */
export function parsePddReviewsUrl(value) {
  const id = onlyParam(webUrl(value), '/goods_comments.html', 'goods_id', GOODS_ID);
  return id ? { platform: 'pdd', product_id: id, url: `${ORIGIN}/goods_comments.html?goods_id=${id}` } : null;
}

/**
 * Canonical search page for one query, with the same query rules as Taobao. PDD lists results in one scrolling page.
 * @param {string} query @returns {{platform: 'pdd', origin: string, pathname: string, query: string, page: 1, url: string}}
 * @throws {ShoppingError} INVALID_SEARCH.
 */
export function pddSearchTarget(query) {
  const { query: clean } = searchTarget(query);
  return { platform: 'pdd', origin: ORIGIN, pathname: '/search_result.html', query: clean, page: 1,
    url: `${ORIGIN}/search_result.html?search_key=${encodeURIComponent(clean)}` };
}

/** @param {unknown} value @returns {object|null} The query's canonical search identity; other parameters are ignored. */
export function parsePddSearchUrl(value) {
  const key = onlyParam(webUrl(value), '/search_result.html', 'search_key', /^[\s\S]+$/);
  if (key === null) return null;
  try { return pddSearchTarget(key); } catch { return null; }
}

/** @param {unknown} value @returns {{platform: 'pdd', url: string}|null} The buyer order list; tab parameters are dropped. */
export function parsePddOrderListUrl(value) {
  const url = webUrl(value);
  return url?.hostname === HOST && url.pathname === '/orders.html' ? { platform: 'pdd', url: `${ORIGIN}/orders.html` } : null;
}

/**
 * The page an order card opens in the same tab (2026-10-27). Only the order number is kept; other parameters are dropped.
 * @param {unknown} value @returns {{platform: 'pdd', order_id: string}|null}
 */
export function parsePddOrderDetailUrl(value) {
  const id = onlyParam(webUrl(value), '/order.html', 'order_sn', /^[0-9A-Za-z-]{6,40}$/);
  return id ? { platform: 'pdd', order_id: id } : null;
}

/**
 * Classify where a PDD tab landed when it is not the requested page. Only the category is returned, never the address.
 * @param {unknown} value @returns {'login_page'|'risk_page'|'other_page'}
 */
export function pddLandingKind(value) {
  const url = webUrl(value, { httpsOnly: false });
  if (!url || url.hostname !== HOST) return 'other_page';
  if (LOGIN_PATHS.has(url.pathname)) return 'login_page';
  if (RISK_PATHS.has(url.pathname)) return 'risk_page';
  return 'other_page';
}

/**
 * Produce a redacted inventory entry for a PDD tab, or null for other sites. Order detail and other addresses stay hidden.
 * @param {{id: number, url: string}} tab @returns {object|null}
 */
export function summarizePddTab(tab) {
  const url = webUrl(tab.url, { httpsOnly: false });
  if (!url || !isPddHost(url.hostname)) return null;
  const product = parsePddProductUrl(tab.url), reviews = parsePddReviewsUrl(tab.url), orders = parsePddOrderListUrl(tab.url);
  const landing = pddLandingKind(tab.url);
  const kind = product ? 'product' : reviews ? 'reviews' : parsePddSearchUrl(tab.url) ? 'search' : orders ? 'orders_list'
    : parsePddOrderDetailUrl(tab.url) ? 'order_detail' : landing !== 'other_page' ? landing
    : url.hostname === HOST && ['/', '/index.html'].includes(url.pathname) ? 'home' : 'other';
  return {
    tab_id: tab.id, origin: url.origin, kind,
    ...(product ? { product_id: product.product_id, url: product.url } : {}),
    ...(reviews ? { product_id: reviews.product_id, url: reviews.url } : {}),
    ...(orders ? { url: orders.url } : {}),
  };
}

/**
 * Whether a tab opened for a PDD page still shows it. A product tab that moved to the same product's review page still
 * matches, because the review page is reached from the product page in the same tab.
 * @param {{kind: 'search'|'product'|'orders', key: string|null}} page @param {string} url @returns {boolean}
 */
export function pddPageStillMatches(page, url) {
  if (page.kind === 'product') return [parsePddProductUrl(url), parsePddReviewsUrl(url)].some(found => found?.product_id === page.key);
  if (page.kind === 'orders') return parsePddOrderListUrl(url) !== null;
  return page.kind === 'search' && parsePddSearchUrl(url)?.query === page.key;
}

/**
 * Location and title check for bind and probe; reads nothing else from the page.
 * @param {{url: string}} target A PDD product identity. @returns {string} Fixed read-only expression.
 * @throws {ShoppingError} INVALID_TARGET.
 */
export function pddMetadataScript(target) {
  const expected = parsePddProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A PDD mobile.pinduoduo.com goods page is required.');
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const current = new URL(location.href);
    if (current.hostname === ${JSON.stringify(HOST)} && ${JSON.stringify([...LOGIN_PATHS])}.includes(current.pathname)) return { state: 'login_required' };
    if (current.hostname === ${JSON.stringify(HOST)} && ${JSON.stringify([...RISK_PATHS])}.includes(current.pathname)) return { state: 'rate_limited' };
    const ids = current.searchParams.getAll('goods_id');
    if (current.origin !== expected.origin || current.pathname !== expected.pathname || ids.length !== 1) return { state: 'target_changed' };
    return { state: 'observed', origin: current.origin, pathname: current.pathname, product_id: ids[0], title: document.title.slice(0, 300) };
  })()`;
}

/** @returns {ShoppingError} RATE_LIMITED for a tab that shows a PDD verification or access-limit page. */
export function pddRiskPageError() {
  return new ShoppingError('RATE_LIMITED', 'PDD shows a verification or access-limit page on this tab.',
    'Stop all PDD work now and tell the user which page; open no further PDD pages until the user says to continue.');
}

/**
 * @param {unknown} value @param {{url: string}} target
 * @returns {{product_id: string, url: string, title: string, page_state: string}}
 * @throws {ShoppingError} LOGIN_REQUIRED, RATE_LIMITED, TARGET_CHANGED or INVALID_RESPONSE.
 */
export function validatePddMetadata(value, target) {
  if (value?.state === 'login_required') throw new ShoppingError('LOGIN_REQUIRED', 'PDD asks for login on this tab.', 'Ask the user to log in to PDD mobile web in this browser profile.');
  if (value?.state === 'rate_limited') throw pddRiskPageError();
  if (value?.state === 'target_changed') {
    throw new ShoppingError('TARGET_CHANGED', 'The bound tab now shows a different page.', 'Select the intended product tab and explicitly bind it again.');
  }
  const expected = parsePddProductUrl(target?.url);
  if (!expected || value?.state !== 'observed' || value.origin !== expected.origin || value.pathname !== expected.pathname ||
      value.product_id !== expected.product_id || typeof value.title !== 'string' || value.title.length > 300) {
    throw new ShoppingError('INVALID_RESPONSE', 'The browser returned invalid product metadata.');
  }
  return { product_id: expected.product_id, url: expected.url, title: value.title.replace(/[\u0000-\u001f\u007f]/g, ''), page_state: 'not_assessed' };
}
