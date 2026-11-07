import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { pageDom, responseText } from './page-dom.mjs';
import { parseOrderListUrl, parseOrderDetailUrl, orderListTargetScript } from './order-target.mjs';
import { parseProductUrl } from './targets.mjs';
import { collectOrderRows, validateOrderPageRows, validateSavedOrderPageRows, WHOLE_PAGE_ORDERS } from './order-rows.mjs';

/** The unfiltered list view that multi-page reading starts from and must keep. */
export const DEFAULT_ORDER_VIEW = Object.freeze({ tab: '所有订单', order_search_empty: true });
const MAX_PAGE = 9999;

// The list address never changes between pages (live, 2026-10-13), so the page is identified only by the antd pager.
function collectOrderPage(collectRows, identity, dom, productUrl, detailUrl, pageLimit, allowedPages, baseline) {
  if (identity.state !== 'observed') return identity;
  const blocked = dom.gate(null, { readOnly: true });
  if (blocked) return { state: blocked };
  if (!document.body || document.readyState === 'loading') return { state: 'loading' };
  // The pager can show one trailing page with no orders at all (live, 2026-10-13); report it instead of parsing rows.
  const mains = dom.all(document, '.trade-main-content');
  const roots = mains.length === 1 ? dom.all(mains[0], '.trade-content-container') : [];
  const noOrders = roots.length === 1 && !dom.all(roots[0], '.trade-bought-list-order-container').length;
  const rows = noOrders ? null : collectRows(identity, dom, productUrl, detailUrl, null, null, pageLimit);
  if (rows && rows.state !== 'observed') return rows;
  const classes = node => (node.getAttribute('class') ?? '').trim().split(/\s+/);
  const has = (node, name) => classes(node).includes(name);
  const pagers = dom.all(document, '.ant-pagination').filter(node => !node.closest('.trade-bought-list-order-container'));
  if (pagers.length !== 1) return { state: 'structure_changed' };
  const children = [...pagers[0].children];
  const previous = children.filter(node => has(node, 'ant-pagination-prev'));
  const next = children.filter(node => has(node, 'ant-pagination-next'));
  const items = children.filter(node => has(node, 'ant-pagination-item'));
  const numbers = items.map(node => {
    const text = dom.text(node, 8);
    return /^[1-9][0-9]{0,3}$/.test(text) && has(node, `ant-pagination-item-${text}`) ? Number(text) : null;
  });
  const active = items.filter(node => has(node, 'ant-pagination-item-active'));
  if (previous.length !== 1 || next.length !== 1 || !items.length || numbers.includes(null) || active.length !== 1) return { state: 'structure_changed' };
  const disabled = node => has(node, 'ant-pagination-disabled') || node.getAttribute('aria-disabled') === 'true';
  const pager = { current_page: numbers[items.indexOf(active[0])], total_pages_displayed: Math.max(...numbers),
    previous_disabled: disabled(previous[0]), next_disabled: disabled(next[0]) };
  if (pager.previous_disabled !== (pager.current_page === 1) ||
      pager.next_disabled !== (pager.current_page === pager.total_pages_displayed)) return { state: 'structure_changed' };
  if (!allowedPages.includes(pager.current_page)) return { state: 'target_changed' };
  const tabRows = dom.all(document, '.trade-bought-list-header-tabs');
  const highlighted = (tabRows.length === 1 ? dom.all(tabRows[0], dom.selector('tabItem')) : [])
    .filter(node => classes(node).some(name => name.startsWith('tabItemHighlight--')));
  const boxes = dom.all(document, dom.selector('headerSearchInput'));
  const inputs = boxes.length === 1 ? dom.all(boxes[0], 'input') : [];
  // Only whether the order search box is empty leaves the page, never what was typed into it.
  const view = { tab: highlighted.length === 1 ? dom.text(highlighted[0], 20) : null,
    order_search_empty: inputs.length === 1 ? String(inputs[0].value ?? '').trim() === '' : null };
  if (noOrders) return baseline ? { state: 'target_changed' } : { state: 'observed_no_orders', url: identity.url, observed_at: new Date().toISOString(), pager, view };
  if (!baseline) return { ...rows, pager, view };
  const ids = rows.orders.map(order => order.order_id_region && !order.order_id_region.truncated
    ? order.order_id_region.text.match(/^订单号\s*[:：]\s*([0-9]{1,40})$/)?.[1] ?? null : null);
  // The displayed total is not compared: the platform revises it while paging (live, 2026-10-13).
  if (pager.current_page !== baseline.page || pager.next_disabled ||
      rows.loaded_orders_seen !== baseline.loaded_orders_seen || JSON.stringify(ids) !== JSON.stringify(baseline.order_ids) ||
      JSON.stringify(view) !== JSON.stringify(baseline.view)) return { state: 'target_changed' };
  const gate = dom.gate();
  if (gate) return { state: gate };
  next[0].click();
  return { state: 'action_dispatched', clicked: true };
}

function requireTarget(target) {
  if (!target || parseOrderListUrl(target.url)?.url !== target.url) {
    throw new ShoppingError('INVALID_TARGET', 'The observed HTTPS buyer order-list route is required.');
  }
}
function requirePages(pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 2 || new Set(pages).size !== pages.length ||
      pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Provide one or two allowed order-list pages.');
  }
}
function invalid() { throw new ShoppingError('INVALID_RESPONSE', 'The buyer order list returned an invalid page view.'); }
function sameKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function normalizePager(value, allowedPages) {
  if (!sameKeys(value, ['current_page', 'total_pages_displayed', 'previous_disabled', 'next_disabled'])) invalid();
  const { current_page: current, total_pages_displayed: total, previous_disabled: previous, next_disabled: next } = value;
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current < 1 || current > total || total > MAX_PAGE ||
      typeof previous !== 'boolean' || typeof next !== 'boolean' || previous !== (current === 1) || next !== (current === total) ||
      !allowedPages.includes(current)) invalid();
  return { current_page: current, total_pages_displayed: total, previous_disabled: previous, next_disabled: next };
}
function normalizeView(value) {
  if (!sameKeys(value, ['tab', 'order_search_empty']) || !(value.order_search_empty === null || typeof value.order_search_empty === 'boolean')) invalid();
  return { tab: value.tab === null ? null : responseText(value.tab, 20), order_search_empty: value.order_search_empty };
}

/**
 * Serialize a read of one whole order-list page, or one next-page click guarded by the saved page's number,
 * order IDs and view.
 * @param {{url:string}} target Canonical buyer-list route. @param {{allowedPages:number[], before?:object}} options
 * Saved permitted pages (one or two) and, for the click, the checkpointed current page.
 * @returns {string} Fixed expression; caller values are serialized as data. No contact or account fields are read.
 * @throws {ShoppingError} INVALID_TARGET, INVALID_ARGUMENTS or INVALID_CHECKPOINT before browser access.
 * @example orderPageScript(target, { allowedPages: [1] });
 */
export function orderPageScript(target, { allowedPages, before } = {}) {
  requireTarget(target); requirePages(allowedPages);
  let baseline = null;
  if (before !== undefined) {
    validateOrderPageSnapshot(before, target, before?.pager?.current_page);
    if (allowedPages.length !== 1 || allowedPages[0] !== before.pager.current_page || before.pager.next_disabled) {
      throw new ShoppingError('INVALID_ARGUMENTS', 'A next-page click can only guard a checkpointed page that is not the last one.');
    }
    baseline = { page: before.pager.current_page, loaded_orders_seen: before.rows.coverage.loaded_orders_seen, order_ids: orderPageIds(before), view: before.view };
  }
  const productParser = `(() => {const PRODUCT_HOSTS = new Set(['item.taobao.com','detail.tmall.com']); return ${parseProductUrl.toString()};})()`;
  return `(${collectOrderPage.toString()})(${collectOrderRows.toString()},${orderListTargetScript(target)},(${pageDom.toString()})(),` +
    `${productParser},${parseOrderDetailUrl.toString()},${WHOLE_PAGE_ORDERS},${JSON.stringify(allowedPages)},${JSON.stringify(baseline)})`;
}

function normalizeEmptyPage(value, target, allowedPages) {
  if (!sameKeys(value, ['url', 'observed_at', 'pager', 'view']) || value.url !== parseOrderListUrl(target.url).url ||
      typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at))) invalid();
  return { url: value.url, observed_at: value.observed_at, pager: normalizePager(value.pager, allowedPages), view: normalizeView(value.view) };
}

/**
 * Validate one raw page read under the saved page allowance.
 * @param {unknown} value Collector response. @param {{url:string}} target Saved route. @param {number[]} allowedPages Saved permitted pages.
 * @returns {{state:'observed', page:{rows:object, pager:object, view:object}}|{state:'no_orders', empty_page:object}} At most fifty
 * loaded orders with the displayed pager and view, or a page whose list frame holds no orders at all (its pager and view only).
 * @throws {ShoppingError} Page gates, TARGET_CHANGED, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 * @example validateOrderPage(raw, target, [2, 3]);
 */
export function validateOrderPage(value, target, allowedPages) {
  requireTarget(target); requirePages(allowedPages);
  if (value?.state === 'observed_no_orders') {
    const { state, ...page } = value;
    return { state: 'no_orders', empty_page: normalizeEmptyPage(page, target, allowedPages) };
  }
  const { pager, view, ...raw } = value && typeof value === 'object' ? value : {};
  const rows = validateOrderPageRows(value?.state === 'observed' ? raw : value, target);
  return { state: 'observed', page: { rows, pager: normalizePager(pager, allowedPages), view: normalizeView(view) } };
}

/**
 * Revalidate a saved page without upgrading its time, coverage or displayed controls.
 * @param {unknown} value Saved {rows, pager, view}. @param {{url:string}} target Saved route. @param {number} page Expected page.
 * @returns {object} The unchanged page. @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateOrderPageSnapshot(state.pages[1], target, 2);
 */
export function validateOrderPageSnapshot(value, target, page) {
  try {
    requireTarget(target);
    if (!sameKeys(value, ['rows', 'pager', 'view'])) throw Error();
    validateSavedOrderPageRows(value.rows, target);
    if (!isDeepStrictEqual(normalizePager(value.pager, [page]), value.pager) || !isDeepStrictEqual(normalizeView(value.view), value.view)) throw Error();
    return value;
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved buyer order-list page is invalid.'); }
}

/**
 * Revalidate a saved trailing page that showed no orders: it must be the displayed last page.
 * @param {unknown} value Saved {url, observed_at, pager, view}. @param {{url:string}} target @param {number} page Expected page.
 * @returns {object} The unchanged value. @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateEmptyOrderPage(state.empty_last_page, target, 9);
 */
export function validateEmptyOrderPage(value, target, page) {
  try {
    requireTarget(target);
    if (!isDeepStrictEqual(normalizeEmptyPage(value, target, [page]), value) || !value.pager.next_disabled) throw Error();
    return value;
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved empty order-list page is invalid.'); }
}

/** @param {object} page Validated page. @returns {(string|null)[]} Explicit order IDs in page order; null where none was printed. @example orderPageIds(page); */
export function orderPageIds(page) { return page.rows.orders.map(order => order.order_id); }
