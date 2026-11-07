import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { parseJdProductUrl } from './targets.mjs';

/** Product rows kept from one order detail. Rows past this are counted and not parsed (2026-10-19 detail read). */
export const JD_ORDER_DETAIL_ITEM_LIMIT = 20;
/** Progress nodes kept from one order detail. Nodes past this are counted and not parsed. */
export const JD_ORDER_DETAIL_PROGRESS_LIMIT = 10;

const RAW_KEYS = ['state', 'layout', 'order_id', 'status_text', 'progress', 'progress_seen', 'shipping_text', 'item_columns', 'items', 'items_seen', 'items_returned', 'amounts'];
const PROGRESS_KEYS = ['position', 'name', 'time_text', 'reached'];
const ITEM_KEYS = ['position', 'product_id', 'title', 'cells', 'quantity'];
const AMOUNT_KEYS = ['label', 'value_text'];

/**
 * Read one JD order detail already open on details.jd.com. Two layouts share this address.
 * 2026-10-19 pages have `#orderstate` (layout `classic`). 2026-10-21 pages have `div.order-state` and
 * `div.order-goods table.tb-order` instead (layout `state_panel`); their consignee block is `.order-info-mod`, which this
 * read never enters. The address also carries a per-order PassKey; only host, path and orderid are compared, and neither
 * the PassKey nor the address is returned. Nothing on the page is changed.
 * Consignee, tracking rows, the payment overlay, hidden tab panels, images and the page header are not read: those regions
 * carry names, phone numbers or account text.
 * @param {{order_id: string}} expected Order id the tab was opened for.
 * @param {Function} gate jdPageGate.
 * @param {{progress: number, items: number}} limits Progress and item caps.
 * @returns {object} Raw guarded observation, without canonical product links. `layout` is `classic` or `state_panel`.
 */
export function collectJdOrderDetail(expected, gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const first = (root, selector) => root ? [...root.querySelectorAll(selector)][0] ?? null : null;
  const all = (root, selector) => root ? [...root.querySelectorAll(selector)] : [];
  const pageUrl = new URL(location.href);
  // One orderid parameter, same rule as parseJdOrderDetailUrl. A second copy, or a different id, is not this order.
  const ids = pageUrl.searchParams.getAll('orderid');
  if (pageUrl.hostname !== 'details.jd.com' || pageUrl.pathname !== '/normal/item.action' || ids.length !== 1 || ids[0] !== expected?.order_id) {
    return { state: 'target_changed' };
  }
  const textOf = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const nodeText = (node, max) => textOf(node?.innerText, max);
  const blank = value => value || null;
  const classText = node => String(node?.className ?? '');
  const hasClass = (node, token) => classText(node).split(/\s+/).includes(token);
  // Protocol-relative, http and https item links, with an optional query. A trailing slash is not a product link.
  const itemId = href => /^(?:https?:)?\/\/item\.jd\.com\/([0-9]{1,20})\.html(?:[?#].*)?$/.exec(String(href ?? ''))?.[1] ?? null;
  const titled = (node, max) => blank(textOf(node?.getAttribute('title'), max) || nodeText(node, max));
  // The live amount label ends with a fullwidth or halfwidth colon, sometimes with a space before it.
  const cleanLabel = raw => blank(textOf(raw, 40).replace(/[:：]$/, '').trim());
  const insideHide = node => {
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      if (hasClass(ancestor, 'hide')) return true;
    }
    return false;
  };
  // Both layouts can put an image-only product link before the titled one (2026-10-21: a 商品图片 column on a classic page,
  // the p-img link on state_panel), so the first recognized link that has a title or text is used.
  const productLinkOf = row => {
    const recognized = all(row, 'a[href]').filter(anchor => itemId(anchor.getAttribute('href')));
    const chosen = recognized.find(anchor => titled(anchor, 300)) ?? recognized[0] ?? null;
    return { productId: chosen ? itemId(chosen.getAttribute('href')) : null, title: chosen ? titled(chosen, 300) : null };
  };
  // #orderstate is the 2026-10-19 page. A partial classic page stays structure_changed and is not read as the other layout.
  if (!first(document, '#orderstate')) {
    if (!first(document, 'div.order-state') || !first(document, 'div.order-goods table.tb-order')) return { state: 'structure_changed' };
    const orderMatched = /订单号\s*[:：]\s*([0-9]{6,30})\s*$/.exec(textOf(first(document, '.order-state .state-top')?.innerText, 80));
    const panelNodes = all(first(document, '.order-state .order-process'), 'div.node');
    const panelProgress = panelNodes.slice(0, limits.progress).map((node, index) => ({
      position: index + 1,
      name: blank(nodeText(first(node, 'li.txt2'), 40)),
      time_text: blank(nodeText(first(node, 'li.txt3'), 40)),
      reached: hasClass(node, 'ready'),
    }));
    const panelTable = first(document, 'div.order-goods table.tb-order');
    const panelColumns = all(panelTable, 'thead th').filter(cell => !hasClass(cell, 'grap')).slice(0, 10).map(cell => textOf(cell.innerText, 20));
    const panelRows = all(panelTable, 'tbody tr').filter(row => [...(row.children ?? [])].some(cell => cell.tagName === 'TD'));
    const panelItems = panelRows.slice(0, limits.items).map((row, index) => {
      const link = productLinkOf(row);
      const quantityText = nodeText(first(row, 'td.p-num'), 20);
      return {
        position: index + 1, product_id: link.productId, title: link.title,
        cells: [...row.children].filter(cell => cell.tagName === 'TD' && !hasClass(cell, 'grap')).slice(0, 10).map(cell => textOf(cell.innerText, 100)),
        quantity: /^[0-9]{1,6}$/.test(quantityText) ? Number(quantityText) : null,
      };
    });
    const panelAmounts = [];
    for (const li of all(first(document, '.order-goods .goods-total'), 'ul li')) {
      if (panelAmounts.length >= 10) break;
      const value = String(first(li, 'span.txt')?.innerText ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, '').slice(0, 40);
      const label = cleanLabel(first(li, 'span.label')?.innerText);
      // An empty row was seen between the coupon and subsidy rows on 2026-10-21; it carries nothing to keep.
      if (label || value) panelAmounts.push({ label, value_text: value || null });
    }
    return {
      state: 'observed', layout: 'state_panel', order_id: orderMatched ? orderMatched[1] : null,
      status_text: blank(nodeText(first(document, '.order-state .state-txt'), 40)),
      progress: panelProgress, progress_seen: panelNodes.length, shipping_text: null, item_columns: panelColumns,
      items: panelItems, items_seen: panelRows.length, items_returned: panelItems.length, amounts: panelAmounts,
    };
  }
  if (!first(document, '#orderinfo dd.p-list table')) return { state: 'structure_changed' };

  // The printed order number is a direct strong. Nested strongs repeat the label inside regions this read must not use.
  let orderId = null;
  let orderLabeled = false;
  for (const block of all(document, 'div.ml10.mb10')) {
    for (const child of block.children ?? []) {
      if (child.tagName !== 'STRONG') continue;
      const raw = textOf(child.innerText, 80);
      if (!raw.includes('订单号')) continue;
      orderLabeled = true;
      const matched = /订单号\s*[:：]\s*([0-9]{6,30})\s*$/.exec(raw);
      orderId = matched ? matched[1] : null;
      break;
    }
    if (orderLabeled) break;
  }

  const nodes = all(first(document, '#process'), 'div.node');
  const progress = nodes.slice(0, limits.progress).map((node, index) => ({
    position: index + 1,
    name: blank(nodeText(first(node, 'li.tx2'), 40)),
    time_text: blank(nodeText(first(node, 'li.tx3'), 40)),
    reached: hasClass(node, 'ready'),
  }));

  // Inactive 付款信息 panels use class hide and can name a payer. Their .extra is not the delivery line.
  const shippingNode = all(first(document, '#ordertrack'), '.extra').find(node => !insideHide(node)) ?? null;
  const table = first(document, '#orderinfo dd.p-list table');
  const tableRows = all(table, 'tr');
  const header = tableRows.find(row => [...(row.children ?? [])].some(cell => cell.tagName === 'TH')) ?? null;
  const columns = header ? [...header.children].filter(cell => cell.tagName === 'TH').slice(0, 10).map(cell => textOf(cell.innerText, 20)) : [];
  const itemRows = tableRows.filter(row => [...(row.children ?? [])].some(cell => cell.tagName === 'TD'));
  const items = itemRows.slice(0, limits.items).map((row, index) => {
    const link = productLinkOf(row);
    const quantityText = nodeText(first(row, 'td.p-num'), 20);
    return {
      position: index + 1, product_id: link.productId, title: link.title,
      cells: [...row.children].filter(cell => cell.tagName === 'TD').slice(0, 10).map(cell => textOf(cell.innerText, 100)),
      quantity: /^[0-9]{1,6}$/.test(quantityText) ? Number(quantityText) : null,
    };
  });

  // A total row is "label span + the remaining amount text". The payable line's label is the text before span.ftx04.
  const total = first(document, '#orderinfo .total');
  const amounts = [];
  for (const li of all(total, 'ul li')) {
    if (amounts.length >= 10) break;
    const span = first(li, 'span');
    const spanText = String(span?.innerText ?? '');
    const rest = span ? String(li.innerText ?? '').replace(spanText, '') : String(li.innerText ?? '');
    const value = rest.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, '').slice(0, 40);
    const label = cleanLabel(spanText);
    if (label || value) amounts.push({ label, value_text: value || null });
  }
  if (amounts.length < 10) {
    const extra = all(total, '.extra').find(node => !insideHide(node)) ?? null;
    if (extra) {
      const valueNode = first(extra, 'span.ftx04');
      const valueRaw = String(valueNode?.innerText ?? '');
      const before = valueRaw ? String(extra.innerText ?? '').replace(valueRaw, '') : String(extra.innerText ?? '');
      amounts.push({ label: cleanLabel(before), value_text: blank(textOf(valueNode?.innerText, 40)) });
    }
  }

  return {
    state: 'observed', layout: 'classic', order_id: orderId, status_text: blank(nodeText(first(document, '#orderstate .mt .ftx14'), 40)),
    progress, progress_seen: nodes.length, shipping_text: blank(nodeText(shippingNode, 100)), item_columns: columns,
    items, items_seen: itemRows.length, items_returned: items.length, amounts,
  };
}

/**
 * @param {string} orderId Printed order id, 6 to 30 digits. Not a URL and not a PassKey.
 * @returns {string} One read-only expression.
 * @throws {ShoppingError} INVALID_ARGUMENTS when the id is not 6 to 30 digits.
 */
export function jdOrderDetailScript(orderId) {
  const expectedOrderId = canonicalOrderId(orderId);
  return `(${collectJdOrderDetail})(${JSON.stringify({ order_id: expectedOrderId })}, ${jdPageGate}, ${JSON.stringify({ progress: JD_ORDER_DETAIL_PROGRESS_LIMIT, items: JD_ORDER_DETAIL_ITEM_LIMIT })})`;
}

const invalid = () => { throw new ShoppingError('INVALID_RESPONSE', 'The JD order detail response does not match the order detail page.'); };

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function canonicalOrderId(orderId) {
  if (typeof orderId !== 'string' || !/^[0-9]{6,30}$/.test(orderId)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a JD order id of 6 to 30 digits.');
  }
  return orderId;
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

function pageOrderIdOf(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9]{6,30}$/.test(value)) invalid();
  return value;
}

function quantity(value) {
  if (value === null) return null;
  return integer(value, 0, 999999);
}

function texts(value, count, max) {
  if (!Array.isArray(value) || value.length > count) invalid();
  return value.map(entry => {
    if (typeof entry !== 'string') invalid();
    return responseText(entry, max);
  });
}

/**
 * Validate one order-detail observation. Product links are canonicalized here. This is the page observation, not the
 * saved task result. A printed order id that disagrees with the requested id means the tab is no longer that order;
 * a missing printed id stays null because the address already matched. `state_panel` has no separate shipping line
 * outside the consignee block, so `shipping_text` must be null.
 * @param {unknown} value Raw page observation.
 * @param {string} orderId Order id the tab was opened for, 6 to 30 digits.
 * @param {{observedAt?: string}} [options]
 * @returns {object} Normalized order detail observation.
 * @throws {ShoppingError} INVALID_ARGUMENTS, page gates, TARGET_CHANGED, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validateJdOrderDetail(value, orderId, { observedAt = new Date().toISOString() } = {}) {
  const expectedOrderId = canonicalOrderId(orderId);
  throwPageError(value?.state);
  if (value?.state !== 'observed' || !sameKeys(value, RAW_KEYS) || !Array.isArray(value.progress) || !Array.isArray(value.item_columns) ||
      !Array.isArray(value.items) || !Array.isArray(value.amounts)) invalid();
  if (value.layout !== 'classic' && value.layout !== 'state_panel') invalid();
  // The state-panel shipping line lives in .order-info-mod with the consignee, so a non-null value was read from the wrong place.
  if (value.layout === 'state_panel' && value.shipping_text !== null) invalid();
  const pageOrderId = pageOrderIdOf(value.order_id);
  const progressSeen = integer(value.progress_seen, 0, 10000);
  if (value.progress.length !== Math.min(progressSeen, JD_ORDER_DETAIL_PROGRESS_LIMIT)) invalid();
  const progress = value.progress.map((step, index) => {
    if (!sameKeys(step, PROGRESS_KEYS) || step.position !== index + 1) invalid();
    return { position: step.position, name: optionalText(step.name, 40), time_text: optionalText(step.time_text, 40), reached: flag(step.reached) };
  });
  const itemsSeen = integer(value.items_seen, 0, 100000000);
  const itemsReturned = integer(value.items_returned, 0, JD_ORDER_DETAIL_ITEM_LIMIT);
  if (itemsReturned !== value.items.length || value.items.length !== Math.min(itemsSeen, JD_ORDER_DETAIL_ITEM_LIMIT)) invalid();
  const items = value.items.map((item, index) => {
    if (!sameKeys(item, ITEM_KEYS) || item.position !== index + 1 || !Array.isArray(item.cells)) invalid();
    const link = productLink(item.product_id);
    return {
      position: item.position, product_id: link.product_id, url: link.url, title: optionalText(item.title, 300),
      cells: texts(item.cells, 10, 100), quantity: quantity(item.quantity),
    };
  });
  if (value.amounts.length > 10) invalid();
  const amounts = value.amounts.map(entry => {
    if (!sameKeys(entry, AMOUNT_KEYS)) invalid();
    return { label: optionalText(entry.label, 40), value_text: optionalText(entry.value_text, 40) };
  });
  // The address matched, but the number printed on the page is a second source. A disagreement is a different order.
  if (pageOrderId !== null && pageOrderId !== expectedOrderId) throwPageError('target_changed');
  return {
    observed_at: observedAt, order_id: expectedOrderId, order_id_on_page: pageOrderId, layout: value.layout,
    status_text: optionalText(value.status_text, 40), progress, progress_seen: progressSeen,
    shipping_text: optionalText(value.shipping_text, 100), item_columns: texts(value.item_columns, 10, 20),
    items, items_seen: itemsSeen, items_returned: items.length, amounts,
  };
}
