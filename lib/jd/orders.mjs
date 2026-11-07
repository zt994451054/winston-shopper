import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { parseJdOrderListUrl, parseJdProductUrl } from './targets.mjs';

/** Loaded order cards kept in the result. Cards past this are counted and not parsed (2026-10-16 order list read). */
export const JD_ORDER_LIMIT = 50;
/** Product rows kept on one order card. */
export const JD_ORDER_ITEM_LIMIT = 10;
const JD_ORDER_SCHEMA_VERSION = 1;
const RAW_KEYS = ['state', 'time_range_text', 'status_filter_text', 'orders', 'split_notices', 'groups_seen', 'orders_seen', 'items_seen'];
const ORDER_KEYS = ['position', 'group_position', 'split_order', 'order_id', 'order_time_text', 'shop_name', 'status_text',
  'amount_text', 'amount_note_texts', 'detail_entry', 'items', 'items_seen', 'items_returned'];
const ITEM_KEYS = ['position', 'product_id', 'title', 'quantity'];
const NOTICE_KEYS = ['position', 'group_position', 'info_texts', 'notice_text', 'detail_entry'];

/**
 * Read the order cards already painted on the order list. Hashed class prefixes come from the 2026-10-16
 * read-only probe: match the stable module name and its trailing hyphen. Unlike the cart, these names are not wrapped in underscores.
 * An empty list was not part of that read, so a missing list or a list with no cards is structure_changed.
 * Nothing on the page is changed. Consignee, payment, actions and images are not read.
 * @param {{url: string}} expected Canonical order list address.
 * @param {Function} gate jdPageGate.
 * @param {{orders: number, items: number}} limits Order and per-order item caps.
 * @returns {object} Raw guarded observation, without canonical product links.
 */
export function collectJdOrders(expected, gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  if (expected?.url !== 'https://order.jd.com/center/list.action' || current.hostname !== 'order.jd.com' || current.pathname !== '/center/list.action') {
    return { state: 'target_changed' };
  }
  const textOf = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const nodeText = (node, max) => textOf(node?.innerText, max);
  const blank = value => value || null;
  const first = (root, selector) => root ? [...root.querySelectorAll(selector)][0] ?? null : null;
  const all = (root, selector) => root ? [...root.querySelectorAll(selector)] : [];
  const classText = node => String(node?.className ?? '');
  const hasClass = (node, token) => classText(node).includes(token);
  const titled = (node, max) => blank(textOf(node?.getAttribute('title'), max) || nodeText(node, max));
  // Protocol-relative, http and https item links, with an optional query. A trailing slash is not a product link.
  const itemId = href => /^(?:https?:)?\/\/item\.jd\.com\/([0-9]{1,20})\.html(?:[?#].*)?$/.exec(String(href ?? ''))?.[1] ?? null;
  // These tokens name consignee, phone and account fragments. A parent innerText would copy the child, so the whole segment is blanked.
  const sensitiveToken = /user|nick|avatar|consignee|address|receiver|phone|mobile/i;
  const tainted = node => {
    const pile = [node];
    for (let index = 0; index < pile.length; index += 1) {
      const current = pile[index];
      if (classText(current).split(/\s+/).some(token => token && sensitiveToken.test(token))) return true;
      for (const child of current.children ?? []) pile.push(child);
    }
    return false;
  };

  const lists = all(document, '[class*="listContent-"]');
  if (lists.length !== 1) return { state: 'structure_changed' };
  const list = lists[0];
  const groups = [...list.children];
  const cardsByGroup = groups.map(group => all(group, '[class*="orderCard-"]'));
  const ordersSeen = cardsByGroup.reduce((total, cards) => total + cards.length, 0);
  if (ordersSeen < 1) return { state: 'structure_changed' };

  const timeRange = blank(nodeText(first(document, '[class*="filterOptionsTitleLeft-"] [class*="selectContainer-"]'), 40));
  const selected = all(document, '[class*="orderStatusList-"] [class*="statusCard-"]').filter(node => hasClass(node, 'selected-'));
  const statusFilter = selected.length === 1 ? blank(nodeText(selected[0], 20)) : null;

  const orderIdOf = card => {
    for (const block of all(card, '[class*="orderMetas-"]')) {
      const kids = [...block.children];
      for (let index = 0; index < kids.length; index += 1) {
        if (!hasClass(kids[index], 'metaLabel-') || nodeText(kids[index], 20) !== '订单号') continue;
        const value = kids[index + 1];
        if (!value || !hasClass(value, 'metaValue-')) return null;
        const visible = textOf(value.innerText, 40);
        const raw = visible || textOf(value.getAttribute('title'), 40);
        return /^[0-9]{6,30}$/.test(raw) ? raw : null;
      }
    }
    return null;
  };
  // The price is split across separate currency, integer and decimal nodes, so the joined text contains spaces.
  const amountOf = card => {
    const row = first(card, '[class*="priceRow-"]');
    if (!row) return null;
    const compact = String(row.innerText ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, '').slice(0, 40);
    return compact || null;
  };
  const notesOf = card => {
    const column = first(card, '[class*="priceColumn-"]');
    return [...(column?.children ?? [])].filter(child => !hasClass(child, 'priceRow-')).map(child => nodeText(child, 60)).filter(Boolean).slice(0, 3);
  };
  const orderOf = (card, position, groupPosition, itemNodes) => {
    const items = itemNodes.slice(0, limits.items).map((item, index) => {
      const quantityText = nodeText(first(item, '[class*="countNum-"]'), 20);
      return {
        position: index + 1,
        product_id: itemId(first(item, 'a[class*="goodImg-"]')?.getAttribute('href')),
        title: titled(first(item, '[class*="productTitle-"]'), 300),
        quantity: /^[0-9]{1,6}$/.test(quantityText) ? Number(quantityText) : null,
      };
    });
    // The same words label a column outside the card; only the detail-section control counts.
    const detailNode = first(card, '[class*="detailSection-"] [class*="detailLink-"]');
    return {
      position, group_position: groupPosition, split_order: hasClass(first(card, '[class*="header-"]'), 'splitOrderHeader-'),
      order_id: orderIdOf(card), order_time_text: blank(nodeText(first(card, '[class*="orderTime-"]'), 40)),
      shop_name: titled(first(card, '[class*="shopNames-"]'), 80), status_text: blank(nodeText(first(card, '[class*="statusText-"]'), 40)),
      amount_text: amountOf(card), amount_note_texts: notesOf(card), detail_entry: nodeText(detailNode, 40) === '订单详情',
      items, items_seen: itemNodes.length, items_returned: items.length,
    };
  };

  // Cards past the cap are counted, including their items, and not parsed.
  let itemsSeen = 0;
  const orders = [];
  for (let groupIndex = 0; groupIndex < cardsByGroup.length; groupIndex += 1) {
    for (const card of cardsByGroup[groupIndex]) {
      const itemNodes = all(card, '[class*="productItem-"]');
      itemsSeen += itemNodes.length;
      if (orders.length >= limits.orders) continue;
      orders.push(orderOf(card, orders.length + 1, groupIndex + 1, itemNodes));
    }
  }
  // A child order is not tied to a split banner. The page only shows that they share a group.
  const splitNotices = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    for (const banner of all(groups[groupIndex], '[class*="splitBanner-"]')) {
      const section = first(banner, '[class*="metaSection-"]');
      const noticeNode = first(banner, '[class*="noticeText-"]');
      splitNotices.push({
        position: splitNotices.length + 1, group_position: groupIndex + 1,
        info_texts: [...(section?.children ?? [])].slice(0, 5).map(node => (tainted(node) ? null : blank(nodeText(node, 80)))),
        notice_text: titled(noticeNode, 200),
        detail_entry: Boolean(first(banner, '[class*="notificationSection-"] [class*="detailLink-"]')),
      });
    }
  }
  return {
    state: 'observed', time_range_text: timeRange, status_filter_text: statusFilter, orders, split_notices: splitNotices,
    groups_seen: groups.length, orders_seen: ordersSeen, items_seen: itemsSeen,
  };
}

/**
 * @param {{platform: 'jd', url: string}} target Canonical order list identity from parseJdOrderListUrl.
 * @returns {string} One read-only expression.
 * @throws {ShoppingError} INVALID_ARGUMENTS when the target is not the canonical order list.
 */
export function jdOrdersScript(target) {
  const expected = canonicalTarget(target);
  return `(${collectJdOrders})(${JSON.stringify({ url: expected.url })}, ${jdPageGate}, ${JSON.stringify({ orders: JD_ORDER_LIMIT, items: JD_ORDER_ITEM_LIMIT })})`;
}

const invalid = () => { throw new ShoppingError('INVALID_RESPONSE', 'The JD order list response does not match the order list page.'); };

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function canonicalTarget(target) {
  const expected = parseJdOrderListUrl(target?.url);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(target)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a canonical JD order list target.');
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

function orderId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9]{6,30}$/.test(value)) invalid();
  return value;
}

function quantity(value) {
  if (value === null) return null;
  return integer(value, 0, 999999);
}

function amountText(value) {
  if (value === null) return null;
  const text = optionalText(value, 40);
  if (/\s/.test(text)) invalid();
  return text;
}

function noteTexts(value) {
  if (!Array.isArray(value) || value.length > 3) invalid();
  return value.map(entry => {
    const text = optionalText(entry, 60);
    if (text === null) invalid();
    return text;
  });
}

function infoTexts(value) {
  if (!Array.isArray(value) || value.length > 5) invalid();
  return value.map(entry => (entry === null ? null : optionalText(entry, 80)));
}

/**
 * Validate one order-list observation into the saved result shape.
 * Product links are canonicalized here. Coverage stays partial: the list is one loaded time range, not the whole history.
 * @param {unknown} value Raw page observation.
 * @param {{platform: 'jd', url: string}} target Canonical order list identity.
 * @param {{observedAt?: string}} [options]
 * @returns {object} Order list result, schema version 1.
 * @throws {ShoppingError} INVALID_ARGUMENTS, page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validateJdOrders(value, target, { observedAt = new Date().toISOString() } = {}) {
  const expected = canonicalTarget(target);
  throwPageError(value?.state);
  if (value?.state !== 'observed' || !sameKeys(value, RAW_KEYS) || !Array.isArray(value.orders) || !Array.isArray(value.split_notices)) invalid();
  const timeRange = optionalText(value.time_range_text, 40);
  const statusFilter = optionalText(value.status_filter_text, 20);
  const ordersSeen = integer(value.orders_seen, 1, 10000);
  const groupsSeen = integer(value.groups_seen, 1, 10000);
  const itemsSeen = integer(value.items_seen, 0, 100000000);
  if (value.orders.length !== Math.min(ordersSeen, JD_ORDER_LIMIT)) invalid();
  let previousGroup = 0;
  const orders = value.orders.map((order, index) => {
    if (!sameKeys(order, ORDER_KEYS) || order.position !== index + 1 || !Array.isArray(order.items)) invalid();
    const groupPosition = integer(order.group_position, 1, groupsSeen);
    if (groupPosition < previousGroup) invalid();
    previousGroup = groupPosition;
    const orderItemsSeen = integer(order.items_seen, 0, 10000);
    const itemsReturned = integer(order.items_returned, 0, JD_ORDER_ITEM_LIMIT);
    if (itemsReturned !== order.items.length || order.items.length !== Math.min(orderItemsSeen, JD_ORDER_ITEM_LIMIT)) invalid();
    const items = order.items.map((item, itemIndex) => {
      if (!sameKeys(item, ITEM_KEYS) || item.position !== itemIndex + 1) invalid();
      const link = productLink(item.product_id);
      return { position: item.position, product_id: link.product_id, url: link.url, title: optionalText(item.title, 300), quantity: quantity(item.quantity) };
    });
    return {
      position: order.position, group_position: groupPosition, split_order: flag(order.split_order), order_id: orderId(order.order_id),
      order_time_text: optionalText(order.order_time_text, 40), shop_name: optionalText(order.shop_name, 80), status_text: optionalText(order.status_text, 40),
      amount_text: amountText(order.amount_text), amount_note_texts: noteTexts(order.amount_note_texts), detail_entry: flag(order.detail_entry),
      items, items_seen: orderItemsSeen, items_returned: items.length,
    };
  });
  let previousNoticeGroup = 0;
  const splitNotices = value.split_notices.map((notice, index) => {
    if (!sameKeys(notice, NOTICE_KEYS) || notice.position !== index + 1) invalid();
    const groupPosition = integer(notice.group_position, 1, groupsSeen);
    if (groupPosition < previousNoticeGroup) invalid();
    previousNoticeGroup = groupPosition;
    return {
      position: notice.position, group_position: groupPosition, info_texts: infoTexts(notice.info_texts),
      notice_text: optionalText(notice.notice_text, 200), detail_entry: flag(notice.detail_entry),
    };
  });
  const returnedItemsSeen = orders.reduce((total, order) => total + order.items_seen, 0);
  if (itemsSeen < returnedItemsSeen || (orders.length === ordersSeen && itemsSeen !== returnedItemsSeen)) invalid();
  const itemsReturned = orders.reduce((total, order) => total + order.items_returned, 0);
  return {
    schema_version: JD_ORDER_SCHEMA_VERSION, platform: 'jd', url: expected.url, source: 'jd_order_list_dom', observed_at: observedAt, login_verified: false,
    time_range_text: timeRange, status_filter_text: statusFilter, orders, split_notices: splitNotices,
    groups_seen: groupsSeen, orders_seen: ordersSeen, orders_returned: orders.length, orders_omitted: ordersSeen - orders.length,
    items_seen: itemsSeen, items_returned: itemsReturned,
    coverage: { status: 'partial', scope: 'loaded_orders_only', scrolled: false, full_order_history: false,
      time_range_verified: false, amount_meaning_verified: false },
    missing: ['orders_not_loaded', 'orders_outside_time_range', 'order_details'],
    excluded: ['consignee', 'address', 'payment', 'account', 'images', 'action_buttons', 'internal_ids'],
  };
}

/**
 * Rebuild a saved order list result from its own fields and require an identical copy.
 * @param {object} value Saved result.
 * @param {{platform: 'jd', url: string}} target Canonical order list identity.
 * @returns {void}
 * @throws {ShoppingError} INVALID_CHECKPOINT when the saved result is inconsistent, including a bad target.
 */
export function validateSavedJdOrders(value, target) {
  try {
    if (value?.schema_version !== 1 || typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) ||
        !Array.isArray(value.orders) || !Array.isArray(value.split_notices)) throw new Error();
    const rebuilt = validateJdOrders({
      state: 'observed', time_range_text: value.time_range_text, status_filter_text: value.status_filter_text,
      groups_seen: value.groups_seen, orders_seen: value.orders_seen, items_seen: value.items_seen, split_notices: value.split_notices,
      orders: value.orders.map(order => {
        if (!order || typeof order !== 'object' || !Array.isArray(order.items)) throw new Error();
        return {
          ...order,
          items: order.items.map(item => {
            if (!item || typeof item !== 'object') throw new Error();
            const copy = { ...item };
            delete copy.url;
            return copy;
          }),
        };
      }),
    }, target, { observedAt: value.observed_at });
    if (JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error();
  } catch {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The saved JD order list result is invalid.');
  }
}
