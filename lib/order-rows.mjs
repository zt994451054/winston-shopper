import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { parseOrderListUrl, parseOrderDetailUrl, orderListTargetScript, validateOrderListTarget } from './order-target.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, throwPageError, responseText } from './page-dom.mjs';
import { normalizeListEmptyEvidence } from './list-empty-state.mjs';

/** Orders read from one whole list page; the live list showed 30 per page (2026-10-13). */
export const WHOLE_PAGE_ORDERS = 50;

/**
 * Page-local order collector, serialized into fixed expressions; exported only for composition with other collectors.
 * @param {number} [pageLimit] Loaded groups to return without a batch plan: five by default, up to fifty for a whole list page.
 */
export function collectOrderRows(identity, dom, productUrl, detailUrl, plan = null, observedGuard = null, pageLimit = 5) {
  if (identity.state !== 'observed') return identity;
  const gate = dom.gate(null, { readOnly: true });
  if (gate) return { state: gate };
  if (!document.body || document.readyState === 'loading') return { state: 'loading' };
  const mains = dom.all(document, '.trade-main-content');
  if (mains.length !== 1) return { state: 'structure_changed' };
  const roots = dom.all(mains[0], '.trade-content-container');
  if (roots.length !== 1) return { state: 'structure_changed' };
  const root = roots[0], groups = dom.all(root, '.trade-bought-list-order-container');
  if (!groups.length || groups.length > 2000 || groups.some(group => group.parentElement !== root)) return { state: 'structure_changed' };
  if (plan && plan.loaded_orders_seen !== null && groups.length !== plan.loaded_orders_seen) return { state: 'order_rows_changed' };
  const local = (group, query) => dom.all(group, query).filter(node => node.closest('.trade-bought-list-order-container') === group);
  const region = (group, parent, query) => {
    const found = local(group, query).filter(node => parent.contains(node));
    return found.length === 1 ? found[0] : null;
  };
  const text = (node, max) => node ? { text: dom.text(node, max), truncated: (node.innerText ?? '').trim().length > max } : null;
  const link = (node, parser) => {
    if (!node || node.tagName.toUpperCase() !== 'A') return null;
    try { return parser(new URL(node.getAttribute('href'), location.href).href); } catch { return null; }
  };
  const prices = (group, parent) => {
    const nodes = local(group, '.trade-price-container').filter(node => parent.contains(node));
    return { items: nodes.slice(0, 10).map(node => ({ ...text(node, 500),
      label: text(region(group, node, '.trade-price-label'), 100) })), truncated: nodes.length > 10 };
  };
  const orders = [], prefix = [], start = plan?.start ?? 1, limit = plan?.limit ?? pageLimit;
  for (const [index, group] of groups.slice(0, start - 1 + limit).entries()) {
    const preceding = index < start - 1;
    const header = region(group, group, '.trade-bought-list-shop-info');
    const detail = region(group, group, '.trade-bought-col-order-detail');
    const payment = region(group, group, '.trade-bought-col-order-payment');
    if (!header || header.parentElement !== group || !detail || !payment || detail.parentElement !== payment.parentElement ||
        detail.parentElement?.parentElement !== group || !(detail.parentElement.getAttribute('class') ?? '').split(/\s+/).includes('trade-container-orderColContainer')) return { state: 'structure_changed' };
    const itemNodes = local(group, '.trade-bought-list-order-info').filter(node => detail.contains(node));
    if (!itemNodes.length || itemNodes.length > 2000 || itemNodes.some(node => node.parentElement !== detail)) return { state: 'structure_changed' };
    const items = itemNodes.slice(0, 10).map((item, itemIndex) => {
      const itemRegion = query => {
        const found = local(group, query).filter(node => node.closest('.trade-bought-list-order-info') === item);
        return found.length === 1 ? found[0] : null;
      };
      const content = itemRegion(dom.selector('itemInfoColItem'));
      const column = itemRegion(dom.selector('itemInfoColPrice'));
      const anchor = itemRegion(dom.selector('title'));
      const title = anchor && content?.contains(anchor) ? itemRegion(dom.selector('titleText')) : null;
      const quantity = itemRegion(dom.selector('quantity'));
      const information = content ? dom.all(content, dom.selector('infoContent')).filter(node => node.closest('.trade-bought-list-order-info') === item) : [];
      const components = !preceding && column ? dom.all(column, '.trade-price-container').filter(node => node.closest('.trade-bought-list-order-info') === item) : [];
      return { position: itemIndex + 1, title: title && anchor.contains(title) ? text(title, 500) : null,
        product_link: anchor && content?.contains(anchor) ? link(anchor, productUrl) : null,
        information: { items: information.slice(0, 10).map(node => text(node, 1000)), truncated: information.length > 10 },
        quantity: column?.contains(quantity) ? text(quantity, 100) : null,
        ...(preceding ? {} : { prices: { items: components.slice(0, 10).map(node => ({ ...text(node, 500),
          label: text(region(group, node, '.trade-price-label'), 100) })), truncated: components.length > 10 } }) };
    });
    const order = { position: index + 1,
      order_id_region: text(region(group, header, dom.selector('shopInfoOrderId')), 100),
      time: text(region(group, header, dom.selector('shopInfoOrderTime')), 100),
      shop: text(region(group, header, dom.selector('shopInfoName')), 500),
      status: text(region(group, header, dom.selector('shopInfoStatus')), 100),
      loaded_items_seen: itemNodes.length, items };
    if (preceding) {
      const guard = observedGuard(order);
      if (guard === null || JSON.stringify(guard) !== JSON.stringify(plan.guards[index])) return { state: 'order_rows_changed' };
      prefix.push(guard); continue;
    }
    orders.push({ ...order, detail_link: link(region(group, header, dom.selector('shopInfoOrderDetail')), detailUrl), payment: prices(group, payment) });
  }
  return { state: 'observed', url: identity.url, source: 'trade_bought_list_order_dom',
    observed_at: new Date().toISOString(), loaded_orders_seen: groups.length, orders,
    ...(plan ? { start, limit, prefix } : {}) };
}

/**
 * Build a fixed read of five loaded buyer order groups, each with at most ten loaded item positions.
 * @param {{url:string}} target Canonical buyer-list identity. @returns {string} Guarded DOM expression without actions or contact fields.
 * @throws {ShoppingError} INVALID_TARGET before browser access.
 * @example orderRowsScript({url:'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'});
 */
export function orderRowsScript(target) {
  const productParser = `(() => {const PRODUCT_HOSTS = new Set(['item.taobao.com','detail.tmall.com']); return ${parseProductUrl.toString()};})()`;
  return `(${collectOrderRows.toString()})(${orderListTargetScript(target)},(${pageDom.toString()})(),${productParser},${parseOrderDetailUrl.toString()})`;
}

/**
 * @param {{url:string}} target Canonical buyer-list route. @param {object} plan Five-or-fewer positions and preceding guards.
 * @returns {string} One fixed read-only expression with identity guards and no out-of-range prices.
 * @throws {ShoppingError} INVALID_ARGUMENTS or INVALID_TARGET before IO.
 * @example orderBatchScript(target, {start:1,limit:5,loaded_orders_seen:null,guards:[]});
 */
export function orderBatchScript(target, plan) {
  validateOrderBatchPlan(plan);
  const productParser = `(() => {const PRODUCT_HOSTS = new Set(['item.taobao.com','detail.tmall.com']); return ${parseProductUrl.toString()};})()`;
  return `(${collectOrderRows.toString()})(${orderListTargetScript(target)},(${pageDom.toString()})(),${productParser},${parseOrderDetailUrl.toString()},${JSON.stringify(plan)},${orderObservedGuard.toString()})`;
}

function orderObservedGuard(order) {
  const clean = value => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  const text = value => value && !value.truncated ? clean(value.text) : null;
  const id = text(order.order_id_region)?.match(/^订单号\s*[:：]\s*([0-9]{1,40})$/)?.[1] ?? null;
  const time = text(order.time), shop = text(order.shop), status = text(order.status);
  if (!id || !time || !shop || !status) return null;
  const items = order.items.map(item => {
    const title = text(item.title), product = item.product_link, digits = text(item.quantity)?.match(/^x([1-9][0-9]{0,8})$/)?.[1];
    const information = item.information.items.map(text);
    if (!title || !product || !digits || item.information.truncated || information.some(value => value === null)) return null;
    return { position: item.position, product_id: product.product_id, url: product.url, title,
      quantity: Number(digits), information };
  });
  if (items.some(item => item === null)) return null;
  return { position: order.position, order_id: id, time, shop, status, loaded_items_seen: order.loaded_items_seen, items };
}

/** @param {object} order Validated saved order. @returns {object|null} Bounded text guard or null if insufficient; no account claim. @example orderGuard(snapshot.orders[0]); */
export function orderGuard(order) { return orderObservedGuard(rawOrder(order)); }

/**
 * @param {unknown} plan Reserved range with full preceding text guards. @returns {object} Unchanged validated plan.
 * @throws {ShoppingError} INVALID_ARGUMENTS before browser access.
 * @example validateOrderBatchPlan({start:1,limit:5,loaded_orders_seen:null,guards:[]});
 */
export function validateOrderBatchPlan(plan) {
  const bad = () => { throw new ShoppingError('INVALID_ARGUMENTS', 'Use a bounded order range with unchanged preceding order guards.'); };
  if (!plan || Object.keys(plan).sort().join(',') !== 'guards,limit,loaded_orders_seen,start' ||
      !Number.isSafeInteger(plan.start) || plan.start < 1 || plan.start > 50 ||
      !Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 5 || plan.start + plan.limit - 1 > 50 ||
      !Array.isArray(plan.guards) || plan.guards.length !== plan.start - 1 ||
      (plan.start === 1 ? plan.loaded_orders_seen !== null : !Number.isSafeInteger(plan.loaded_orders_seen) ||
        plan.loaded_orders_seen < plan.start || plan.loaded_orders_seen > 2000)) bad();
  const safeText = (value, max) => typeof value === 'string' && value.length <= max && value === value.trim() &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const ids = new Set();
  for (const [index, guard] of plan.guards.entries()) {
    if (!guard || Object.keys(guard).sort().join(',') !== 'items,loaded_items_seen,order_id,position,shop,status,time' ||
        guard.position !== index + 1 || typeof guard.order_id !== 'string' || !/^[0-9]{1,40}$/.test(guard.order_id) || ids.has(guard.order_id) ||
        !safeText(guard.time, 100) || !guard.time || !safeText(guard.shop, 500) || !guard.shop || !safeText(guard.status, 100) || !guard.status ||
        !Number.isSafeInteger(guard.loaded_items_seen) || guard.loaded_items_seen < 1 || guard.loaded_items_seen > 2000 ||
        !Array.isArray(guard.items) || guard.items.length !== Math.min(10, guard.loaded_items_seen)) bad();
    ids.add(guard.order_id);
    for (const [itemIndex, item] of guard.items.entries()) {
      if (!item || Object.keys(item).sort().join(',') !== 'information,position,product_id,quantity,title,url' || item.position !== itemIndex + 1 ||
          typeof item.product_id !== 'string' || parseProductUrl(item.url)?.product_id !== item.product_id || parseProductUrl(item.url)?.url !== item.url ||
          !safeText(item.title, 500) || !item.title || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 999999999 ||
          !Array.isArray(item.information) || item.information.length > 10 || item.information.some(value => !safeText(value, 1000))) bad();
    }
  }
  return plan;
}

function invalid() { throw new ShoppingError('INVALID_RESPONSE', 'The buyer order list returned invalid bounded evidence.'); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
}
function textRegion(value, max) {
  if (value === null) return null;
  exact(value, ['text', 'truncated']);
  if (typeof value.truncated !== 'boolean') invalid();
  return { text: responseText(value.text, max), truncated: value.truncated };
}
function canonicalLink(value, parser) {
  if (value === null) return null;
  const parsed = parser(value?.url);
  if (!parsed || !isDeepStrictEqual(value, parsed)) invalid();
  return parsed;
}
function normalizedPrices(value, level) {
  exact(value, ['items', 'truncated']);
  if (!Array.isArray(value.items) || value.items.length > 10 || typeof value.truncated !== 'boolean') invalid();
  return { items: value.items.map(item => {
    exact(item, ['text', 'truncated', 'label']);
    return { ...textRegion({ text: item.text, truncated: item.truncated }, 500), label: textRegion(item.label, 100),
      level, kind: 'unverified', source: level === 'order' ? 'same_order_payment_column' : 'same_item_price_column' };
  }), truncated: value.truncated, settlement_verified: false,
    ...(level === 'item' ? { unit_price_verified: false, line_amount_verified: false } : { item_allocation_verified: false }) };
}
function normalizeItem(item, index) {
  exact(item, ['position', 'title', 'product_link', 'information', 'quantity', 'prices']);
  if (item.position !== index + 1) invalid();
  const title = textRegion(item.title, 500), product = canonicalLink(item.product_link, parseProductUrl);
  exact(item.information, ['items', 'truncated']);
  if (!Array.isArray(item.information.items) || item.information.items.length > 10 || typeof item.information.truncated !== 'boolean') invalid();
  const quantity = textRegion(item.quantity, 100);
  const digits = quantity && !quantity.truncated ? quantity.text.match(/^x([1-9][0-9]{0,8})$/)?.[1] : null;
  return { position: item.position, title: title && !title.truncated && title.text ? title.text : null, title_region: title,
    product_id: product?.product_id ?? null, url: product?.url ?? null, product_link: product,
    item_information: { items: item.information.items.map(value => { if (value === null) invalid(); return textRegion(value, 1000); }),
      truncated: item.information.truncated, interpretation: 'unclassified_item_text' },
    quantity: { region: quantity, value: digits ? Number(digits) : null, verified: Boolean(digits), source: 'same_item_quantity_display' },
    price_observations: normalizedPrices(item.prices, 'item'),
    association: { sku_id: null, sku_binding_verified: false, settlement_verified: false },
    missing: [...(!title || title.truncated || !title.text ? ['title'] : []), ...(!product ? ['product_link'] : []), ...(!digits ? ['quantity'] : [])] };
}
function normalizeOrder(order, index) {
  exact(order, ['position', 'order_id_region', 'time', 'shop', 'status', 'detail_link', 'payment', 'loaded_items_seen', 'items']);
  if (order.position !== index + 1 || !Number.isSafeInteger(order.loaded_items_seen) || order.loaded_items_seen < 1 ||
      order.loaded_items_seen > 2000 || !Array.isArray(order.items) || order.items.length !== Math.min(10, order.loaded_items_seen)) invalid();
  const idRegion = textRegion(order.order_id_region, 100);
  const id = idRegion && !idRegion.truncated ? idRegion.text.match(/^订单号\s*[:：]\s*([0-9]{1,40})$/)?.[1] ?? null : null;
  const candidate = canonicalLink(order.detail_link, parseOrderDetailUrl), bound = id !== null && candidate?.order_id === id;
  return { position: order.position, order_id: id, order_id_region: idRegion,
    placed_at_region: textRegion(order.time, 100), shop_name_region: textRegion(order.shop, 500), status_region: textRegion(order.status, 100),
    detail_entry: { observation: candidate, url: bound ? candidate.url : null, order_binding_verified: bound,
      reason: bound ? null : candidate ? 'printed_order_id_mismatch_or_unknown' : 'supported_header_link_not_observed' },
    payment_observations: normalizedPrices(order.payment, 'order'), items: order.items.map(normalizeItem),
    coverage: { loaded_items_seen: order.loaded_items_seen, returned_items: order.items.length,
      items_omitted: order.loaded_items_seen - order.items.length, full_order_items_verified: false },
    missing: [...(id === null ? ['explicit_order_id'] : []), ...(order.time === null ? ['placed_at_region'] : []),
      ...(order.shop === null ? ['shop_name_region'] : []), ...(order.status === null ? ['status_region'] : []), ...(!bound ? ['bound_detail_entry'] : [])] };
}

/**
 * Validate and preserve order-level and item-level observations without payment allocation or transaction claims.
 * @param {unknown} value Fixed collector response. @param {{url:string}} target Expected buyer-list identity.
 * @returns {object} Local-only partial snapshot; explicit adapter empty evidence is scoped to the current list view.
 * @throws {ShoppingError} Page gates, INVALID_TARGET or INVALID_RESPONSE.
 * @example validateOrderRows(raw, target);
 */
export function validateOrderRows(value, target) {
  return normalizeOrderSnapshot(value, target);
}

/**
 * Validate every loaded order group of one list page (at most fifty), as snapshot schema 4. An explicitly empty list is
 * rejected here: paging has no evidence contract for it.
 * @param {unknown} value Collector response with pageLimit WHOLE_PAGE_ORDERS. @param {{url:string}} target Saved route.
 * @returns {object} Local-only partial snapshot of the loaded page. @throws {ShoppingError} Page gates, INVALID_TARGET or INVALID_RESPONSE.
 * @example validateOrderPageRows(raw, target);
 */
export function validateOrderPageRows(value, target) {
  if (value?.state === 'observed_empty') invalid();
  return normalizeOrderSnapshot(value, target, null, WHOLE_PAGE_ORDERS);
}

/** @param {unknown} value Saved schema-4 page snapshot. @param {{url:string}} target Saved route.
 * @returns {object} The unchanged snapshot. @throws {ShoppingError} INVALID_CHECKPOINT. @example validateSavedOrderPageRows(page.rows, target); */
export function validateSavedOrderPageRows(value, target) {
  if (value?.schema_version !== 4) throw new ShoppingError('INVALID_CHECKPOINT', 'The saved buyer order-list snapshot is invalid or incompatible.');
  return validateSavedSnapshot(value, target, null, WHOLE_PAGE_ORDERS);
}

/** @param {unknown} value Collector response. @param {{url:string}} target Saved route. @param {object} plan Reserved range/guards.
 * @returns {object} Validated batch with global positions; explicit empty evidence is accepted only for the first range.
 * @throws {ShoppingError} Page gates, ORDER_ROWS_CHANGED or invalid response/plan.
 * @example validateOrderBatch(raw, target, plan); */
export function validateOrderBatch(value, target, plan) {
  validateOrderBatchPlan(plan);
  if (value?.state === 'order_rows_changed') {
    exact(value, ['state']);
    throw new ShoppingError('ORDER_ROWS_CHANGED', 'The loaded count or preceding order fields changed. Saved batches were retained.');
  }
  return normalizeOrderSnapshot(value, target, plan);
}

function normalizeOrderSnapshot(value, target, plan = null, pageLimit = 5) {
  const expected = parseOrderListUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'The observed HTTPS buyer order-list route is required.');
  const empty = value?.state === 'observed_empty';
  if (value?.state !== 'observed' && !empty) { exact(value, ['state']); throwPageError(value.state); invalid(); }
  exact(value, ['state', 'url', 'source', 'observed_at', 'loaded_orders_seen', 'orders',
    ...(empty ? ['empty_evidence'] : []), ...(plan ? ['start', 'limit', 'prefix'] : [])]);
  validateOrderListTarget({ state: 'observed', url: value.url }, expected);
  if (value.source !== 'trade_bought_list_order_dom' || typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) ||
      !Number.isSafeInteger(value.loaded_orders_seen) || value.loaded_orders_seen < (empty ? 0 : 1) || value.loaded_orders_seen > 2000 ||
      !Array.isArray(value.orders) || (empty ? value.loaded_orders_seen !== 0 || value.orders.length !== 0 :
        !value.orders.length || value.orders.length !== Math.min(plan?.limit ?? pageLimit, value.loaded_orders_seen - (plan?.start ?? 1) + 1))) invalid();
  const emptyEvidence = empty ? normalizeListEmptyEvidence(value.empty_evidence) : null;
  if (plan && (value.start !== plan.start || value.limit !== plan.limit || !isDeepStrictEqual(value.prefix, plan.guards))) invalid();
  if (empty && plan?.start > 1) {
    throw new ShoppingError('ORDER_ROWS_CHANGED', 'The previously nonempty order list is now explicitly empty. Saved batches were retained.');
  }
  if (plan && plan.loaded_orders_seen !== null && value.loaded_orders_seen !== plan.loaded_orders_seen) invalid();
  return { schema_version: empty ? 3 : plan ? 2 : pageLimit === WHOLE_PAGE_ORDERS ? 4 : 1, url: expected.url, observed_at: value.observed_at, source: value.source,
    ...(empty ? { empty_evidence: emptyEvidence } : {}),
    ...(plan ? { range: { start: plan.start, limit: plan.limit }, prefix_guard: { positions_checked: plan.guards.length,
      observed_values_match: true, physical_order_identity_verified: false } } : {}),
    orders: value.orders.map((order, index) => normalizeOrder(order, index + (plan?.start ?? 1) - 1)), coverage: { status: 'partial', loaded_orders_seen: value.loaded_orders_seen,
      returned_orders: value.orders.length, orders_omitted: value.loaded_orders_seen - value.orders.length,
      page_total_orders: null, full_order_history: false, empty_orders_verified: empty, account_identity_verified: false,
      filters_verified: false, settlement_verified: false },
    privacy: { local_only: true, contact_fields_read: false, account_profile_read: false },
    limits: { order_positions: plan ? 5 : pageLimit, item_positions_per_order: 10, price_components_per_region: 10, information_regions_per_item: 10 } };
}

function rawPrices(value) { return { items: value.items.map(item => ({ text: item.text, truncated: item.truncated, label: item.label })), truncated: value.truncated }; }
function rawOrder(order) {
  return { position: order.position, order_id_region: order.order_id_region, time: order.placed_at_region,
    shop: order.shop_name_region, status: order.status_region, detail_link: order.detail_entry.observation,
    payment: rawPrices(order.payment_observations), loaded_items_seen: order.coverage.loaded_items_seen,
    items: order.items.map(item => ({ position: item.position, title: item.title_region, product_link: item.product_link,
      information: { items: item.item_information.items, truncated: item.item_information.truncated }, quantity: item.quantity.region,
      prices: rawPrices(item.price_observations) })) };
}

/**
 * Revalidate a saved snapshot and every derived association/coverage field, without reading a browser.
 * @param {unknown} value Saved normalized snapshot. @param {{url:string}} target Saved list route.
 * @returns {object} The unchanged snapshot. @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateSavedOrderRows(snapshot, target);
 */
export function validateSavedOrderRows(value, target) {
  return validateSavedSnapshot(value, target);
}

/** @param {unknown} value Saved batch. @param {{url:string}} target Saved route. @param {object} plan Derived continuation.
 * @returns {object} Unchanged validated batch. @throws {ShoppingError} INVALID_CHECKPOINT; never upgrades old snapshots.
 * @example validateSavedOrderBatch(snapshot, target, plan); */
export function validateSavedOrderBatch(value, target, plan) { return validateSavedSnapshot(value, target, plan); }

function validateSavedSnapshot(value, target, plan = null, pageLimit = 5) {
  try {
    const empty = value?.schema_version === 3 && value?.orders?.length === 0;
    if (!Array.isArray(value?.orders) || value.orders.length < (empty ? 0 : 1) || value.orders.length > pageLimit) invalid();
    const raw = { state: empty ? 'observed_empty' : 'observed', url: value.url, source: value.source, observed_at: value.observed_at,
      loaded_orders_seen: value.coverage?.loaded_orders_seen, orders: value.orders.map(rawOrder),
      ...(empty ? { empty_evidence: value.empty_evidence } : {}),
      ...(plan ? { start: plan.start, limit: plan.limit, prefix: plan.guards } : {}) };
    const normalized = plan ? validateOrderBatch(raw, target, plan) : pageLimit === WHOLE_PAGE_ORDERS ? validateOrderPageRows(raw, target) : validateOrderRows(raw, target);
    if (!isDeepStrictEqual(normalized, value)) invalid();
    return value;
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved buyer order-list snapshot is invalid or incompatible.'); }
}
