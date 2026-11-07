import { ShoppingError } from './errors.mjs';
import { parseCartUrl } from './cart-target.mjs';
import { parseOrderListUrl } from './order-target.mjs';

const PRODUCT_HOSTS = new Set(['item.taobao.com', 'detail.tmall.com']);
const TAB_HOSTS = new Set([
  ...PRODUCT_HOSTS, 'www.taobao.com', 'taobao.com', 's.taobao.com',
  'www.tmall.com', 'tmall.com', 'cart.taobao.com',
  'buyertrade.taobao.com', 'login.taobao.com',
]);

/**
 * Parse a supported public product URL without retaining tracking parameters.
 * @param {string} value
 * @returns {{platform: string, origin: string, pathname: string, product_id: string, url: string}|null}
 * @example parseProductUrl('https://detail.tmall.com/item.htm?id=123&tracking=ignored')
 */
export function parseProductUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  if (!PRODUCT_HOSTS.has(url.hostname) || url.pathname !== '/item.htm') return null;
  const ids = url.searchParams.getAll('id');
  if (ids.length !== 1 || !/^[0-9]{1,64}$/.test(ids[0])) return null;
  return {
    platform: 'taobao', origin: url.origin, pathname: url.pathname,
    product_id: ids[0], url: `${url.origin}${url.pathname}?id=${ids[0]}`,
  };
}

/**
 * Produce a redacted inventory entry for a relevant tab, or null for other sites.
 * @param {{id: number, url: string}} tab
 * @returns {object|null}
 */
export function summarizeTab(tab) {
  let url;
  try { url = new URL(tab.url); } catch { return null; }
  if (!TAB_HOSTS.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return null;
  const product = parseProductUrl(tab.url);
  const cart = parseCartUrl(tab.url);
  const orders = parseOrderListUrl(tab.url);
  const kind = product ? 'product' : cart ? 'cart' : orders ? 'orders_list' : url.hostname === 's.taobao.com' && url.pathname === '/search' ? 'search'
    : url.origin === 'https://www.taobao.com' && url.pathname === '/' && !url.search && !url.hash ? 'search_home' : 'other';
  return {
    tab_id: tab.id, origin: url.origin, kind,
    ...(product ? { product_id: product.product_id, url: product.url } : {}),
    ...(cart ? { url: cart.url } : {}),
    ...(orders ? { url: orders.url } : {}),
  };
}

/**
 * Validate a Chrome tab ID. Throws INVALID_TAB before any browser request.
 * @param {unknown} value
 * @returns {number}
 */
export function parseTabId(value) {
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw new ShoppingError('INVALID_TAB', 'A positive numeric tab ID is required.', 'Run tabs and select a listed product tab.');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new ShoppingError('INVALID_TAB', 'The tab ID is outside the supported range.');
  return id;
}

/**
 * Build the sole DOM operation exposed by this prototype: guarded public metadata.
 * @param {{url: string}} target A canonical supported product identity.
 * @returns {string} A read-only browser expression with no network or storage access.
 * @throws {ShoppingError} INVALID_TARGET if the supplied target is unsupported.
 */
export function metadataScript(target) {
  const expected = parseProductUrl(target.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A supported Taobao or Tmall product page is required.');
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const current = new URL(location.href);
    const ids = current.searchParams.getAll('id');
    if (current.origin !== expected.origin || current.pathname !== expected.pathname ||
        ids.length !== 1 || ids[0] !== expected.product_id) {
      return { state: 'target_changed' };
    }
    return { state: 'observed', origin: current.origin, pathname: current.pathname,
      product_id: ids[0], title: document.title.slice(0, 300) };
  })()`;
}

/**
 * Check an explicitly saved product tab using only its address; never returns an unrelated URL.
 * @param {{url: string}} target Supported product identity.
 * @returns {string} Fixed location-only expression, suitable before a budgeted detail read.
 * @throws {ShoppingError} INVALID_TARGET for an unsupported product.
 * @example productTargetScript({ url: 'https://detail.tmall.com/item.htm?id=123' });
 */
export function productTargetScript(target) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A supported product identity is required.');
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const current = new URL(location.href);
    if (['https:', 'http:'].includes(current.protocol) && !current.username && !current.password && !current.port &&
        ['login.taobao.com', 'login.tmall.com'].includes(current.hostname)) return { state: 'login_required' };
    const ids = current.searchParams.getAll('id');
    if (current.username || current.password || current.port || current.origin !== expected.origin ||
        current.pathname !== expected.pathname || ids.length !== 1 || ids[0] !== expected.product_id) return { state: 'target_changed' };
    return { state: 'observed', url: expected.url };
  })()`;
}

/**
 * Validate the in-page identity check without trusting arbitrary page output.
 * @param {unknown} value @param {{url: string}} target
 * @returns {{product_id: string, url: string, title: string, page_state: string}}
 * @throws {ShoppingError} TARGET_CHANGED or INVALID_RESPONSE.
 */
export function validateMetadata(value, target) {
  if (value?.state === 'target_changed') {
    throw new ShoppingError('TARGET_CHANGED', 'The bound tab now shows a different page.', 'Select the intended product tab and explicitly bind it again.');
  }
  const expected = parseProductUrl(target.url);
  if (!expected || value?.state !== 'observed' || value.origin !== expected.origin ||
      value.pathname !== expected.pathname || value.product_id !== expected.product_id ||
      typeof value.title !== 'string' || value.title.length > 300) {
    throw new ShoppingError('INVALID_RESPONSE', 'The browser returned invalid product metadata.');
  }
  return {
    product_id: expected.product_id, url: expected.url,
    title: value.title.replace(/[\u0000-\u001f\u007f]/g, ''),
    page_state: 'not_assessed',
  };
}
