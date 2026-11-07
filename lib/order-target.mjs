import { ShoppingError } from './errors.mjs';
import { throwPageError } from './page-dom.mjs';

/**
 * Parse only the buyer's order-list route, stripping query/fragment data without asserting filter or account continuity.
 * @param {unknown} value Existing page address.
 * @returns {object|null} Canonical list identity; never an order-detail URL or an order ID.
 * @example parseOrderListUrl('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?tracking=ignored');
 */
export function parseOrderListUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'buyertrade.taobao.com' ||
      url.pathname !== '/trade/itemlist/list_bought_items.htm' || url.username || url.password || url.port) return null;
  return { platform: 'taobao', origin: url.origin, pathname: url.pathname, url: url.origin + url.pathname };
}

/**
 * Parse the two order-detail routes observed in buyer-list headers; never opens them.
 * @param {unknown} value Existing header link. @returns {object|null} Canonical route and string order ID.
 * @example parseOrderDetailUrl('https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=123');
 */
export function parseOrderDetailUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const key = url.hostname === 'trade.tmall.com' && url.pathname === '/detail/orderDetail.htm' ? 'bizOrderId'
    : url.hostname === 'trade.taobao.com' && url.pathname === '/trade/detail/trade_order_detail.htm' ? 'biz_order_id' : null;
  if (!key || url.searchParams.getAll(key).length !== 1) return null;
  const id = url.searchParams.get(key);
  if (!id || !/^[0-9]{1,40}$/.test(id)) return null;
  return { order_id: id, url: `${url.origin}${url.pathname}?${key}=${id}` };
}

function requiredDetailTarget(target) {
  const expected = parseOrderDetailUrl(target?.url);
  if (!expected || target.order_id !== expected.order_id) {
    throw new ShoppingError('INVALID_TARGET', 'A matching observed order-detail route and string order ID are required.');
  }
  return expected;
}

/**
 * Check the observed detail route and its single order-ID parameter before any DOM access.
 * @param {{url:string,order_id:string}} target Saved, canonical detail-link identity.
 * @returns {string} Fixed address-only expression; unrelated query values are never returned.
 * @throws {ShoppingError} INVALID_TARGET before browser access.
 * @example orderDetailTargetScript(parseOrderDetailUrl('https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=123'));
 */
export function orderDetailTargetScript(target) {
  const expected = requiredDetailTarget(target);
  return `(() => {
    const expected = ${JSON.stringify(expected)}, saved = new URL(expected.url), current = new URL(location.href);
    if (current.protocol !== 'https:' || current.username || current.password || current.port) return {state:'target_changed'};
    if (['login.taobao.com','login.tmall.com'].includes(current.hostname)) return {state:'login_required'};
    const key = saved.hostname === 'trade.tmall.com' ? 'bizOrderId' : 'biz_order_id';
    if (current.origin !== saved.origin || current.pathname !== saved.pathname ||
        current.searchParams.getAll(key).length !== 1 || current.searchParams.get(key) !== expected.order_id) return {state:'target_changed'};
    return {state:'observed',url:expected.url,order_id:expected.order_id};
  })()`;
}

/**
 * @param {unknown} value Address response. @param {{url:string,order_id:string}} target Saved link identity.
 * @returns {object} Route evidence only; the page's printed order ID and account are not verified.
 * @throws {ShoppingError} INVALID_TARGET, INVALID_RESPONSE, LOGIN_REQUIRED or TARGET_CHANGED.
 * @example validateOrderDetailTarget({state:'observed',...target}, target);
 */
export function validateOrderDetailTarget(value, target) {
  const expected = requiredDetailTarget(target);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && ['login_required', 'target_changed'].includes(value.state)) throwPageError(value.state);
    if (keys.length === 3 && keys.every(key => ['state','url','order_id'].includes(key)) &&
        value.state === 'observed' && value.url === expected.url && value.order_id === expected.order_id) {
      return { ...expected, route_order_binding_verified: true, printed_order_id_verified: false, account_identity_verified: false };
    }
  }
  throw new ShoppingError('INVALID_RESPONSE', 'The browser returned invalid order-detail address evidence.');
}

function requiredTarget(target) {
  const expected = parseOrderListUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'The observed HTTPS buyer order-list route is required.');
  return expected;
}

/**
 * @param {{url:string}} target Canonical buyer list identity.
 * @returns {string} Fixed location-only check with no account fields, DOM, requests or storage reads.
 * @throws {ShoppingError} INVALID_TARGET before browser access.
 * @example orderListTargetScript(parseOrderListUrl('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'));
 */
export function orderListTargetScript(target) {
  const expected = requiredTarget(target);
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const current = new URL(location.href);
    if (current.protocol !== 'https:' || current.username || current.password || current.port) return {state:'target_changed'};
    if (['login.taobao.com','login.tmall.com'].includes(current.hostname)) return {state:'login_required'};
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) return {state:'target_changed'};
    return {state:'observed',url:expected.url};
  })()`;
}

/**
 * @param {unknown} value Fixed address response. @param {{url:string}} target Saved list identity.
 * @returns {object} Address only, with account/filter/page-state evidence explicitly unassessed.
 * @throws {ShoppingError} INVALID_TARGET, INVALID_RESPONSE, LOGIN_REQUIRED or TARGET_CHANGED.
 * @example validateOrderListTarget({state:'observed',url:target.url}, target);
 */
export function validateOrderListTarget(value, target) {
  const expected = requiredTarget(target);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && ['login_required', 'target_changed'].includes(value.state)) throwPageError(value.state);
    if (keys.length === 2 && keys.includes('state') && keys.includes('url') && value.state === 'observed' && value.url === expected.url) {
      return { url: expected.url, page_state: 'not_assessed', filters_verified: false, account_identity_verified: false };
    }
  }
  throw new ShoppingError('INVALID_RESPONSE', 'The browser returned invalid buyer order-list address evidence.');
}
