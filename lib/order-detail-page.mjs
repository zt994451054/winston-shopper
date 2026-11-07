import { ShoppingError } from './errors.mjs';
import { isDeepStrictEqual } from 'node:util';
import { pageDom, responseText, throwPageError } from './page-dom.mjs';
import { orderDetailTargetScript, validateOrderDetailTarget } from './order-target.mjs';

function collectDetailPage(address, dom) {
  if (address.state !== 'observed') return address;
  if (document.readyState === 'loading') return { state:'loading' };
  const gate = dom.gate(null, { readOnly:true });
  if (gate) return { state:gate };
  const roots = [...document.querySelectorAll('.trade-error-container')], shown = roots.filter(dom.visible);
  if (!shown.length) return { state:'observed', address, page_state:'not_assessed', error_roots_seen:roots.length, error_page:null };
  if (shown.length !== 1 || roots.length > 20) return { state:'structure_changed' };
  const root = shown[0];
  const child = (parent, selector) => {
    const nodes = dom.all(parent, selector);
    return nodes.length === 1 && nodes[0].parentElement === parent ? nodes[0] : null;
  };
  const content = child(root, '.trade-error-content');
  const left = content && child(content, '.trade-error-content-left');
  const title = left && child(left, '.trade-error-title'), subtitle = left && child(left, '.trade-error-subtitle');
  if (!title || !subtitle) return { state:'structure_changed' };
  const text = (node, max) => {
    const value = node.innerText.trim();
    return { text:value.slice(0, max), truncated:value.length > max };
  };
  const titleText = text(title, 300);
  if (!titleText.text) return { state:'structure_changed' };
  return { state:'observed', address, page_state:'error', error_roots_seen:roots.length,
    error_page:{ title:titleText, subtitle:text(subtitle, 1000) } };
}

/**
 * Inspect only the observed error-panel structure after the exact route/ID guard. No normal order fields are read.
 * @param {{url:string,order_id:string}} target Canonical saved detail-link identity.
 * @returns {string} Fixed, bounded DOM expression; no actions, storage reads or requests.
 * @throws {ShoppingError} INVALID_TARGET before browser access.
 * @example orderDetailPageScript({url:'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=123',order_id:'123'});
 */
export function orderDetailPageScript(target) {
  const address = orderDetailTargetScript(target);
  return `(${collectDetailPage.toString()})(${address}, (${pageDom.toString()})())`;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function textRegion(value, limit) {
  if (!exactKeys(value, ['text','truncated']) || typeof value.truncated !== 'boolean' ||
      value.truncated && value.text?.length !== limit) {
    throw new ShoppingError('INVALID_RESPONSE', 'The detail page returned invalid error-heading evidence.');
  }
  return { text:responseText(value.text, limit), truncated:value.truncated };
}

/**
 * @param {unknown} value Fixed page-state response. @param {{url:string,order_id:string}} target Saved detail link.
 * @returns {object} Local error-heading observation or unassessed state, never a successful detail snapshot.
 * @throws {ShoppingError} Invalid target/response, page gate or ambiguous error-panel structure.
 * @example validateOrderDetailPage(rawResponse, target);
 */
export function validateOrderDetailPage(value, target) {
  orderDetailTargetScript(target);
  if (exactKeys(value, ['state'])) throwPageError(value.state);
  if (!exactKeys(value, ['state','address','page_state','error_roots_seen','error_page']) || value.state !== 'observed' ||
      !Number.isSafeInteger(value.error_roots_seen) || value.error_roots_seen < 0 || value.error_roots_seen > 20 ||
      !['error','not_assessed'].includes(value.page_state)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The browser returned invalid order-detail page-state evidence.');
  }
  const address = validateOrderDetailTarget(value.address, target);
  let errorPage = null;
  if (value.page_state === 'error') {
    if (!value.error_roots_seen || !exactKeys(value.error_page, ['title','subtitle'])) {
      throw new ShoppingError('INVALID_RESPONSE', 'The visible error panel is missing its heading fields.');
    }
    const title = textRegion(value.error_page.title, 300), subtitle = textRegion(value.error_page.subtitle, 1000);
    if (!title.text) throw new ShoppingError('INVALID_RESPONSE', 'The error heading is empty.');
    errorPage = { source:'visible_trade_error_panel', title_region:title, subtitle_region:subtitle,
      source_relationship_verified:true, cause_verified:false };
  } else if (value.error_page !== null) {
    throw new ShoppingError('INVALID_RESPONSE', 'An unassessed detail page cannot carry error-heading observations.');
  }
  return { schema_version:1, ...address, observed_at:new Date().toISOString(), page_state:value.page_state,
    error_roots_seen:value.error_roots_seen, error_page:errorPage, order_fields_read:false,
    normal_detail_layout_verified:false, settlement_verified:false,
    privacy:{ local_only:true, contact_fields_read:false, account_profile_read:false } };
}

/**
 * Revalidate a local page observation without changing its original time or upgrading its coverage.
 * @param {unknown} value Saved page state. @param {object} target Canonical detail identity.
 * @returns {object} Unchanged validated observation.
 * @throws {ShoppingError} INVALID_CHECKPOINT for invented fields, identity or coverage.
 * @example validateSavedOrderDetailPage(saved, target);
 */
export function validateSavedOrderDetailPage(value, target) {
  try {
    if (typeof value?.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at))) throw Error();
    const normalized = validateOrderDetailPage({ state:'observed',
      address:{ state:'observed', url:value.url, order_id:value.order_id },
      page_state:value.page_state, error_roots_seen:value.error_roots_seen,
      error_page:value.error_page && { title:value.error_page.title_region, subtitle:value.error_page.subtitle_region } }, target);
    normalized.observed_at = value.observed_at;
    if (!isDeepStrictEqual(value, normalized)) throw Error();
    return value;
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved order-detail page observation is invalid.'); }
}
