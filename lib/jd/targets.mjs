import { ShoppingError } from '../errors.mjs';
import { searchTarget } from '../search.mjs';

const CART_PATHS = new Set(['/cart_index', '/cart_index/', '/cart.action']);
// Hosts JD redirects to when it limits access; seen live on 2026-09-15 (pc-frequent-pro) or documented for its risk handler.
const RISK_HOSTS = new Set(['pc-frequent-pro.pf.jd.com']);

function webUrl(value, { httpsOnly = true } = {}) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!(httpsOnly ? ['https:'] : ['https:', 'http:']).includes(url.protocol) || url.username || url.password || url.port) return null;
  return url;
}

const isJdHost = hostname => hostname === 'jd.com' || hostname.endsWith('.jd.com');

/**
 * Parse a JD product page. JD gives every specification its own page and number, so product_id is a SKU number.
 * @param {unknown} value @returns {{platform: 'jd', origin: string, pathname: string, product_id: string, url: string}|null}
 * @example parseJdProductUrl('https://item.jd.com/100012345678.html?spm=ignored') // url without the query
 */
export function parseJdProductUrl(value) {
  const url = webUrl(value);
  const sku = url?.hostname === 'item.jd.com' ? /^\/([0-9]{1,20})\.html$/.exec(url.pathname)?.[1] : undefined;
  if (!sku) return null;
  return { platform: 'jd', origin: url.origin, pathname: url.pathname, product_id: sku, url: `${url.origin}${url.pathname}` };
}

/**
 * The product number of a page an item.jd.com product moved to on another JD site, such as JD International (2026-11-08: a
 * 海外自营 product left item.jd.com and page-close could not close it). Only the number in a /NUMBER.html path is read.
 * @param {string} value @returns {string|null}
 */
function movedProductId(value) {
  const url = webUrl(value);
  if (!url || !/(^|\.)jd\.(com|hk)$/.test(url.hostname) || url.hostname === 'item.jd.com') return null;
  return /^\/([0-9]{1,20})\.html$/.exec(url.pathname)?.[1] ?? null;
}

/**
 * Canonical first search page for one query, with the same query rules as Taobao.
 * @param {string} query @returns {{platform: 'jd', origin: string, pathname: string, query: string, page: 1, url: string}}
 * @throws {ShoppingError} INVALID_SEARCH.
 */
export function jdSearchTarget(query) {
  const { query: clean } = searchTarget(query);
  return { platform: 'jd', origin: 'https://search.jd.com', pathname: '/Search', query: clean, page: 1,
    url: `https://search.jd.com/Search?keyword=${encodeURIComponent(clean)}&enc=utf-8` };
}

/**
 * Match a JD search page by its single keyword. Paging and sorting parameters are not interpreted yet.
 * @param {unknown} value @returns {object|null} The query's canonical first-page identity.
 */
export function parseJdSearchUrl(value) {
  const url = webUrl(value);
  if (url?.hostname !== 'search.jd.com' || url.pathname !== '/Search') return null;
  const keywords = url.searchParams.getAll('keyword');
  if (keywords.length !== 1) return null;
  try { return jdSearchTarget(keywords[0]); } catch { return null; }
}

/** @param {unknown} value @returns {{platform: 'jd', url: string}|null} The cart route; query values are dropped. */
export function parseJdCartUrl(value) {
  const url = webUrl(value);
  return url?.hostname === 'cart.jd.com' && CART_PATHS.has(url.pathname) ? { platform: 'jd', url: 'https://cart.jd.com/cart_index' } : null;
}

/** @param {unknown} value @returns {{platform: 'jd', url: string}|null} The buyer order list; time-range and page parameters are dropped. */
export function parseJdOrderListUrl(value) {
  const url = webUrl(value);
  return url?.hostname === 'order.jd.com' && url.pathname === '/center/list.action'
    ? { platform: 'jd', url: 'https://order.jd.com/center/list.action' } : null;
}

/**
 * The page behind an order list's 订单详情 entry (2026-10-19). Its address also carries a per-order PassKey, which is
 * never returned, so the result identifies the order but cannot open the page.
 * @param {unknown} value @returns {{platform: 'jd', order_id: string}|null}
 */
export function parseJdOrderDetailUrl(value) {
  const url = webUrl(value);
  if (url?.hostname !== 'details.jd.com' || url.pathname !== '/normal/item.action') return null;
  const ids = url.searchParams.getAll('orderid');
  return ids.length === 1 && /^[0-9]{6,30}$/.test(ids[0]) ? { platform: 'jd', order_id: ids[0] } : null;
}

/**
 * Classify where a JD tab landed when it is not the requested page. Only the category is returned, never the address.
 * @param {unknown} value @returns {'login_page'|'risk_page'|'other_page'}
 */
export function jdLandingKind(value) {
  const url = webUrl(value, { httpsOnly: false });
  if (!url) return 'other_page';
  if (url.hostname === 'passport.jd.com') return 'login_page';
  if (RISK_HOSTS.has(url.hostname) || url.hostname === 'cfe.m.jd.com' && url.pathname.includes('/risk_handler')) return 'risk_page';
  return 'other_page';
}

/**
 * Produce a redacted inventory entry for a JD tab, or null for other sites. Order detail and other addresses stay hidden.
 * @param {{id: number, url: string}} tab @returns {object|null}
 */
export function summarizeJdTab(tab) {
  const url = webUrl(tab.url, { httpsOnly: false });
  if (!url || !isJdHost(url.hostname)) return null;
  const product = parseJdProductUrl(tab.url), cart = parseJdCartUrl(tab.url), orders = parseJdOrderListUrl(tab.url);
  const landing = jdLandingKind(tab.url);
  const kind = product ? 'product' : parseJdSearchUrl(tab.url) ? 'search' : cart ? 'cart' : orders ? 'orders_list'
    : landing !== 'other_page' ? landing : ['www.jd.com', 'jd.com'].includes(url.hostname) && url.pathname === '/' ? 'home' : 'other';
  return {
    tab_id: tab.id, origin: url.origin, kind,
    ...(product ? { product_id: product.product_id, url: product.url } : {}),
    ...(cart ? { url: cart.url } : {}),
    ...(orders ? { url: orders.url } : {}),
  };
}

/**
 * Whether a tab opened for a JD page still shows it, allowing later pages, sorting or tracking parameters.
 * @param {{kind: 'search'|'product'|'orders'|'cart', key: string|null}} page @param {string} url @returns {boolean}
 */
export function jdPageStillMatches(page, url) {
  if (page.kind === 'product') return parseJdProductUrl(url)?.product_id === page.key || movedProductId(url) === page.key;
  if (page.kind === 'orders') return parseJdOrderListUrl(url) !== null;
  if (page.kind === 'cart') return parseJdCartUrl(url) !== null;
  return page.kind === 'search' && parseJdSearchUrl(url)?.query === page.key;
}

/**
 * Location and title check for bind and probe; reads nothing else from the page.
 * @param {{url: string}} target A JD product identity. @returns {string} Fixed read-only expression.
 * @throws {ShoppingError} INVALID_TARGET.
 */
export function jdMetadataScript(target) {
  const expected = parseJdProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A JD item.jd.com product page is required.');
  // Address only, like the login check. Seen live on 2026-10-15: a tab that page-open reported as the product page
  // had moved to the risk page by the time it was bound.
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const current = new URL(location.href);
    if (current.hostname === 'passport.jd.com') return { state: 'login_required' };
    if (current.hostname === 'pc-frequent-pro.pf.jd.com' || current.hostname === 'cfe.m.jd.com' && current.pathname.includes('/risk_handler')) {
      return { state: 'rate_limited' };
    }
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) return { state: 'target_changed' };
    return { state: 'observed', origin: current.origin, pathname: current.pathname,
      product_id: /^\\/([0-9]{1,20})\\.html$/.exec(current.pathname)?.[1] ?? null, title: document.title.slice(0, 300) };
  })()`;
}

/** @returns {ShoppingError} RATE_LIMITED for a tab that shows JD's access-limit page. */
export function jdRiskPageError() {
  return new ShoppingError('RATE_LIMITED', 'JD shows its access-limit page on this tab.',
    'Stop all JD work now and tell the user which page; open no further JD pages until the user says to continue.');
}

/**
 * @param {unknown} value @param {{url: string}} target
 * @returns {{product_id: string, url: string, title: string, page_state: string}}
 * @throws {ShoppingError} LOGIN_REQUIRED, RATE_LIMITED, TARGET_CHANGED or INVALID_RESPONSE.
 */
export function validateJdMetadata(value, target) {
  if (value?.state === 'login_required') throw new ShoppingError('LOGIN_REQUIRED', 'JD asks for login on this tab.', 'Ask the user to log in to JD in this browser profile.');
  if (value?.state === 'rate_limited') throw jdRiskPageError();
  if (value?.state === 'target_changed') {
    throw new ShoppingError('TARGET_CHANGED', 'The bound tab now shows a different page.', 'Select the intended product tab and explicitly bind it again.');
  }
  const expected = parseJdProductUrl(target?.url);
  if (!expected || value?.state !== 'observed' || value.origin !== expected.origin || value.pathname !== expected.pathname ||
      value.product_id !== expected.product_id || typeof value.title !== 'string' || value.title.length > 300) {
    throw new ShoppingError('INVALID_RESPONSE', 'The browser returned invalid product metadata.');
  }
  return { product_id: expected.product_id, url: expected.url, title: value.title.replace(/[\u0000-\u001f\u007f]/g, ''), page_state: 'not_assessed' };
}
