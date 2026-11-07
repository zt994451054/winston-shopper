import { ShoppingError } from './errors.mjs';
import { throwPageError } from './page-dom.mjs';

/**
 * Parse the observed Taobao HTTPS cart route, removing query and fragment values.
 * @param {unknown} value An existing cart URL.
 * @returns {object|null} Canonical cart identity; never a product or SKU ID.
 * @example parseCartUrl('https://cart.taobao.com/cart.htm?tracking=ignored');
 */
export function parseCartUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'cart.taobao.com' || url.pathname !== '/cart.htm' ||
      url.username || url.password || url.port) return null;
  return { platform: 'taobao', origin: url.origin, pathname: url.pathname, url: url.origin + url.pathname };
}

function requiredTarget(target) {
  const expected = parseCartUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'The observed Taobao HTTPS cart route is required.');
  return expected;
}

/**
 * Build a fixed location-only cart check, without document, storage or network access.
 * @param {{url:string}} target Canonical cart identity.
 * @returns {string} A read-only expression returning identity or a fixed failure state.
 * @throws {ShoppingError} INVALID_TARGET before any browser call.
 * @example cartTargetScript(parseCartUrl('https://cart.taobao.com/cart.htm'));
 */
export function cartTargetScript(target) {
  const expected = requiredTarget(target);
  return `(() => {
    const expected = ${JSON.stringify(expected)};
    const current = new URL(location.href);
    if (current.protocol !== 'https:' || current.username || current.password || current.port) {
      return { state: 'target_changed' };
    }
    if (['login.taobao.com', 'login.tmall.com'].includes(current.hostname)) return { state: 'login_required' };
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) return { state: 'target_changed' };
    return { state: 'observed', url: expected.url };
  })()`;
}

/**
 * Validate cart address evidence without treating it as login, empty-cart or row evidence.
 * @param {unknown} value The fixed expression's result.
 * @param {{url:string}} target Requested cart identity.
 * @returns {{url:string,page_state:string}} Identity only; page_state is not_assessed.
 * @throws {ShoppingError} INVALID_TARGET, INVALID_RESPONSE, LOGIN_REQUIRED or TARGET_CHANGED.
 * @example validateCartTarget({state:'observed',url:'https://cart.taobao.com/cart.htm'}, {url:'https://cart.taobao.com/cart.htm'});
 */
export function validateCartTarget(value, target) {
  const expected = requiredTarget(target);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && ['login_required', 'target_changed'].includes(value.state)) throwPageError(value.state);
    if (keys.length === 2 && keys.includes('state') && keys.includes('url') &&
        value.state === 'observed' && value.url === expected.url) {
      return { url: expected.url, page_state: 'not_assessed' };
    }
  }
  throw new ShoppingError('INVALID_RESPONSE', 'The browser returned invalid cart address evidence.');
}
