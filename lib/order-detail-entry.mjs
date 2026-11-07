import { ShoppingError } from './errors.mjs';
import { parseOrderListUrl, parseOrderDetailUrl, orderListTargetScript } from './order-target.mjs';
import { pageDom, throwPageError } from './page-dom.mjs';

/** Fixed reasons a header entry is refused before any click; saved with the failure for later diagnosis. */
export const ENTRY_REFUSAL_REASONS = Object.freeze(['link_attributes', 'outside_viewport', 'obstructed']);

const selectorPrefix = '.trade-main-content .trade-content-container > .trade-bought-list-order-container:nth-child(';
const selectorSuffix = ') > .trade-bought-list-shop-info :is([class^="shopInfoOrderDetail--"], [class*=" shopInfoOrderDetail--"])';

function entryArguments(list, detail, position) {
  const listTarget = parseOrderListUrl(list?.url), detailTarget = parseOrderDetailUrl(detail?.url);
  if (!listTarget || !detailTarget || detailTarget.order_id !== detail?.order_id) {
    throw new ShoppingError('INVALID_TARGET', 'Observed buyer-list and matching detail-link identities are required.');
  }
  if (!Number.isSafeInteger(position) || position < 1 || position > 50) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Choose one saved order-list position from 1 to 50.');
  }
  return { list:listTarget, detail:detailTarget, position };
}

function prepareEntry(identity, expected, position, dom, parseDetail, prefix, suffix) {
  if (identity.state !== 'observed') return identity;
  const gate = dom.gate();
  if (gate) return { state:gate };
  if (document.readyState === 'loading') return { state:'loading' };
  const mains = dom.all(document, '.trade-main-content');
  if (mains.length !== 1) return { state:'structure_changed' };
  const roots = dom.all(mains[0], '.trade-content-container');
  if (roots.length !== 1) return { state:'structure_changed' };
  const root = roots[0], groups = dom.all(root, '.trade-bought-list-order-container');
  if (!groups.length || groups.length > 2000 || groups.some(group => group.parentElement !== root)) return { state:'structure_changed' };
  const group = groups[position - 1];
  if (!group) return { state:'structure_changed' };
  const headers = dom.all(group, '.trade-bought-list-shop-info').filter(node => node.parentElement === group);
  if (headers.length !== 1) return { state:'structure_changed' };
  const header = headers[0];
  const local = query => dom.all(header, query).filter(node => node.closest('.trade-bought-list-order-container') === group);
  const ids = local(dom.selector('shopInfoOrderId')), entries = local(dom.selector('shopInfoOrderDetail'));
  if (ids.length !== 1 || entries.length !== 1 || entries[0].tagName !== 'A') return { state:'structure_changed' };
  const printed = ids[0].innerText.trim();
  if (printed.length > 100 || printed.match(/^订单号\s*[:：]\s*([0-9]{1,40})$/)?.[1] !== expected.order_id) return { state:'target_changed' };
  const anchor = entries[0];
  let raw;
  try { raw = new URL(anchor.getAttribute('href'), location.href); } catch { return { state:'target_changed' }; }
  const parsed = parseDetail(raw.href);
  if (!parsed || parsed.url !== expected.url) return { state:'target_changed' };
  // Taobao's analytics script appends one spm value to a header link once it has been clicked (live 2026-10-12). That single
  // tracking value is tolerated; any other extra parameter, a repeated spm or a fragment still blocks the click.
  const extras = [...raw.searchParams.keys()].filter(key => !['biz_order_id', 'bizOrderId'].includes(key));
  const spm = raw.searchParams.getAll('spm');
  const trackedOnly = extras.every(key => key === 'spm') && spm.length <= 1 && (spm[0] ?? '').length <= 200;
  if (!trackedOnly || raw.hash || anchor.innerText.trim() !== '订单详情' || anchor.getAttribute('target') !== '_blank' ||
      anchor.getAttribute('aria-disabled') === 'true' || anchor.getAttribute('data-disabled') === 'true') return { state:'unsupported', reason:'link_attributes' };
  const rect = anchor.getBoundingClientRect(), x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
  if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { state:'unsupported', reason:'outside_viewport' };
  const hit = document.elementFromPoint(x, y);
  if (!hit || !anchor.contains(hit)) return { state:'unsupported', reason:'obstructed' };
  const childIndex = [...root.children].indexOf(group) + 1;
  return { state:'entry_prepared', list_url:identity.url, ...expected, position, loaded_groups_seen:groups.length,
    selector:prefix + childIndex + suffix, entry_text:'订单详情', target_attribute:'_blank' };
}

/**
 * Prepare a single observed header link without clicking, reading other orders or collecting contact fields.
 * @param {{url:string}} list Saved buyer-list route. @param {{url:string,order_id:string}} detail Matching saved detail identity.
 * @param {number} position One saved list position (1–50).
 * @returns {string} Fixed identity, local structure and interaction checks; no requests or storage reads.
 * @throws {ShoppingError} INVALID_TARGET or INVALID_ARGUMENTS before browser access.
 * @example orderDetailEntryScript(list, detail, 2);
 */
export function orderDetailEntryScript(list, detail, position) {
  const expected = entryArguments(list, detail, position);
  return `(${prepareEntry.toString()})(${orderListTargetScript(expected.list)},${JSON.stringify(expected.detail)},${position},` +
    `(${pageDom.toString()})(),${parseOrderDetailUrl.toString()},${JSON.stringify(selectorPrefix)},${JSON.stringify(selectorSuffix)})`;
}

function validSelector(value) {
  if (typeof value !== 'string' || !value.startsWith(selectorPrefix) || !value.endsWith(selectorSuffix)) return false;
  const index = value.slice(selectorPrefix.length, -selectorSuffix.length);
  return /^[1-9][0-9]{0,3}$/.test(index) && Number(index) <= 2000;
}

/**
 * @param {unknown} value Fixed entry response. @param {object} list Saved list route. @param {object} detail Saved detail identity.
 * @param {number} position Requested saved position.
 * @returns {object} Local header-entry preparation, not navigation or detail-body evidence.
 * @throws {ShoppingError} Invalid arguments, response, page gate or unsupported interaction scope.
 * @example validateOrderDetailEntry(raw, list, detail, 2);
 */
export function validateOrderDetailEntry(value, list, detail, position) {
  const expected = entryArguments(list, detail, position);
  if (value && Object.keys(value).length === 1) throwPageError(value.state);
  if (value?.state === 'unsupported' && Object.keys(value).length === 2) {
    if (!ENTRY_REFUSAL_REASONS.includes(value.reason)) throw new ShoppingError('INVALID_RESPONSE', 'The header entry returned an unknown refusal reason.');
    const error = new ShoppingError('UNSUPPORTED_CAPABILITY', 'The header entry is not safely clickable; nothing was clicked.');
    error.entryReason = value.reason;
    throw error;
  }
  const keys = ['state','list_url','url','order_id','position','loaded_groups_seen','selector','entry_text','target_attribute'];
  if (!value || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
      value.state !== 'entry_prepared' || value.list_url !== expected.list.url || value.url !== expected.detail.url ||
      value.order_id !== expected.detail.order_id || value.position !== position ||
      !Number.isSafeInteger(value.loaded_groups_seen) || value.loaded_groups_seen < position || value.loaded_groups_seen > 2000 ||
      !validSelector(value.selector) || value.entry_text !== '订单详情' || value.target_attribute !== '_blank') {
    throw new ShoppingError('INVALID_RESPONSE', 'The header entry returned invalid bounded navigation preparation.');
  }
  return { ...value };
}

/**
 * @param {unknown} data Fresh anchor-only accessibility snapshot. @param {object} before Validated entry preparation.
 * @returns {string} One current backend reference for the exact order-detail link.
 * @throws {ShoppingError} TARGET_CHANGED or INVALID_RESPONSE; no actions or IO.
 * @example orderDetailEntryReference(snapshot, before);
 */
export function orderDetailEntryReference(data, before) {
  const list = parseOrderListUrl(before?.list_url), detail = parseOrderDetailUrl(before?.url);
  validateOrderDetailEntry(before, list, detail, before?.position);
  if (parseOrderListUrl(data?.url)?.url !== list.url) throw new ShoppingError('TARGET_CHANGED', 'The entry reference belongs to another page.');
  const refs = data?.snapshotData?.refs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs) || Object.keys(refs).length > 16) {
    throw new ShoppingError('INVALID_RESPONSE', 'The scoped entry reference inventory is invalid.');
  }
  const links = Object.entries(refs).filter(([, ref]) => ref?.role === 'link');
  if (links.length !== 1 || links[0][1].name !== '订单详情' || !/^[a-zA-Z0-9_-]{1,32}$/.test(links[0][0]) ||
      !Number.isSafeInteger(links[0][1].backendDOMNodeId) || links[0][1].backendDOMNodeId < 1) {
    throw new ShoppingError('INVALID_RESPONSE', 'The scoped reference does not uniquely identify the order-detail link.');
  }
  return links[0][0];
}
