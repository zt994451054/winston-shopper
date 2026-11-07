import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { pddPageGate } from './page-gate.mjs';
import { parsePddOrderListUrl } from './targets.mjs';

// Format 2 (2026-10-27 live): the list shows the quantity before the spec, as in ×2，标准【断桥锁点】; format 1 only knew SPEC ×2.
const PDD_ORDERS_SCHEMA_VERSION = 2;
const LIMITS = Object.freeze({ line: 300, orders: 50, items: 10, lines: 12 });
const AMOUNT = /(实付|应付)[:：]?\s*[￥¥]\s*([0-9]+(?:\.[0-9]+)?)/;
const QUANTITY = /^(.*?)\s*[×xX]\s*([0-9]{1,5})[，,]?$/;
const LEADING_QUANTITY = /^[×xX]\s*([0-9]{1,5})[，,]?\s*(.*)$/;

/**
 * Internal serialized collector for the PDD order list (orders.html) as loaded, seen on 2026-10-27. Each card is the
 * largest block around one data-test="订单状态" and its children are, in order: the header (店铺名称, 订单状态), one row
 * per item (商品名称, then the spec with ×N and tags such as 7天价保), the amount row (avatars of the group, a unit price,
 * 实付 or 应付 with the amount, 免运费) and the buttons. Text is read as rendered, so the hidden copy of the amount row
 * and the hidden 更多 menu are left out. Buttons and unknown rows are not read; only their number is kept. Nothing is
 * clicked or scrolled.
 * @param {Function} gate pddPageGate @param {object} limits @returns {object} Raw guarded observation.
 */
export function collectPddOrders(gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/orders.html') return { state: 'target_changed' };
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limits.line);
  const linesOf = element => String(element.innerText ?? '').split('\n').map(clip).filter(Boolean);
  const statuses = [...document.querySelectorAll('[data-test="订单状态"]')];
  const statusesIn = root => statuses.filter(status => root.contains(status)).length;
  const cards = statuses.map(status => {
    let card = status;
    while (card.parentElement && statusesIn(card.parentElement) === 1) card = card.parentElement;
    return card;
  });
  const endShown = [...document.querySelectorAll('body *')].some(node => node.children.length === 0 && /^没有更多了/.test(clip(node.textContent)));
  if (!cards.length) return endShown ? { state: 'observed', orders: [], orders_total: 0, end_shown: true } : { state: 'structure_changed' };

  const orders = [];
  for (const card of cards.slice(0, limits.orders)) {
    const rows = [...card.children];
    const header = rows.find(row => statusesIn(row) === 1);
    const shop = card.querySelector('[data-test="店铺名称"]');
    const itemRows = rows.filter(row => row.querySelector('[data-test="商品名称"]'));
    const amountRow = rows.find(row => !itemRows.includes(row) && /实付|应付/.test(String(row.innerText ?? '')));
    if (!header || !shop || !itemRows.length || !amountRow || itemRows.some(row => row.querySelectorAll('[data-test="商品名称"]').length !== 1)) {
      return { state: 'structure_changed' };
    }
    const items = itemRows.slice(0, limits.items).map(row => {
      const title = clip(row.querySelector('[data-test="商品名称"]').textContent);
      return { title, lines: linesOf(row).filter(line => line !== title).slice(0, limits.lines) };
    });
    const rest = rows.filter(row => row !== header && !itemRows.includes(row) && row !== amountRow);
    orders.push({ shop: clip(shop.textContent), status: clip(card.querySelector('[data-test="订单状态"]').textContent), items, items_total: itemRows.length,
      amount_lines: linesOf(amountRow).slice(0, limits.lines), group_avatars: amountRow.querySelectorAll('img').length, other_rows_skipped: rest.length });
  }
  return { state: 'observed', orders, orders_total: cards.length, end_shown: endShown };
}

/** @returns {string} One fixed read-only expression for the loaded order cards; no click, scroll or request. */
export function pddOrdersScript() {
  return `(${collectPddOrders})(${pddPageGate}, ${JSON.stringify(LIMITS)})`;
}

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The PDD order list response does not match the supported page.');
const count = (value, max = 100000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const textLines = (value, max) => {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value.map(line => responseText(line, LIMITS.line)).filter(Boolean);
};

/** The spec and quantity of one line: ×N，SPEC as the list shows it, or SPEC ×N; format 1 knew only the latter. */
function quantityOf(line, version) {
  const leading = version >= 2 ? line.match(LEADING_QUANTITY) : null;
  if (leading) return { spec: leading[2] || null, quantity: Number(leading[1]) };
  const trailing = line.match(QUANTITY);
  return trailing ? { spec: trailing[1] || null, quantity: Number(trailing[2]) } : null;
}

/** An item row: the line with ×N holds the spec; other lines are tags such as 7天价保 or 退货包运费已失效. */
function itemFields(item, position, version) {
  if (!item || typeof item !== 'object') throw invalid();
  const title = responseText(item.title, LIMITS.line);
  if (!title) throw invalid();
  const lines = textLines(item.lines, LIMITS.lines);
  const at = lines.findIndex(line => quantityOf(line, version));
  const found = at >= 0 ? quantityOf(lines[at], version) : null;
  return { position, title, spec: found?.spec ?? null, quantity: found?.quantity ?? null, quantity_text: at >= 0 ? lines[at] : null,
    tags: lines.filter((_, index) => index !== at), lines };
}

/** The amount row as displayed: 实付 or 应付 with its amount, a unit price when shown, 先用后付 and the shipping note. */
function amountFields(lines) {
  const joined = lines.join(' ');
  const paid = joined.match(AMOUNT);
  return { label: paid ? paid[1] : null, amount_text: paid ? paid[2] : null, pay_later_shown: joined.includes('先用后付'),
    shipping_note: joined.match(/\((免运费|含运费[^)]*)\)/)?.[1] ?? null, lines, verified: false };
}

/**
 * Validate one observation of the PDD order list.
 * @param {unknown} value Raw page observation. @param {{observedAt?: string, version?: 1|2}} [options] version rebuilds a saved result.
 * @returns {object} Order list fields. @throws {ShoppingError} Page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validatePddOrders(value, { observedAt = new Date().toISOString(), version = PDD_ORDERS_SCHEMA_VERSION } = {}) {
  throwPageError(value?.state);
  if (value?.state !== 'observed' || !Array.isArray(value.orders) || value.orders.length > LIMITS.orders || !count(value.orders_total, 10000) ||
      value.orders_total < value.orders.length || typeof value.end_shown !== 'boolean') throw invalid();
  const orders = value.orders.map((order, index) => {
    if (!order || !Array.isArray(order.items) || !order.items.length || order.items.length > LIMITS.items || !count(order.items_total, 1000) ||
        order.items_total < order.items.length || !count(order.group_avatars, 1000) || !count(order.other_rows_skipped, 1000)) throw invalid();
    const shop = responseText(order.shop, LIMITS.line), status = responseText(order.status, LIMITS.line);
    if (!shop || !status) throw invalid();
    return { position: index + 1, order_id: null, shop, status, items: order.items.map((item, at) => itemFields(item, at + 1, version)),
      items_total: order.items_total, amount: amountFields(textLines(order.amount_lines, LIMITS.lines)),
      group_avatars_skipped: order.group_avatars, other_rows_skipped: order.other_rows_skipped };
  });
  const listShownWhole = value.end_shown && value.orders_total === value.orders.length;
  return {
    schema_version: version, platform: 'pdd', source: 'loaded_order_cards', url: parsePddOrderListUrl('https://mobile.pinduoduo.com/orders.html').url,
    observed_at: observedAt, login_verified: false, orders, loaded_count: value.orders_total, orders_cut: value.orders_total > value.orders.length,
    end_shown: value.end_shown,
    coverage: { status: listShownWhole ? 'complete' : 'partial', scope: 'loaded_order_cards', scrolled: false, tab_verified: false,
      order_ids_known: false, amount_meaning_verified: false },
    missing: ['order_ids', 'order_times', ...(listShownWhole ? [] : ['orders_not_loaded'])],
    excluded: ['buttons', 'group_member_avatars', 'recommended_products'],
  };
}

/**
 * Rebuild a saved list result from the lines it keeps and require an identical copy, so an edited cache is rejected.
 * @param {unknown} value Saved result. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateSavedPddOrders(value) {
  try {
    if (![1, 2].includes(value?.schema_version) || typeof value.observed_at !== 'string' || !Array.isArray(value.orders)) throw new Error();
    const raw = { state: 'observed', orders_total: value.loaded_count, end_shown: value.end_shown,
      orders: value.orders.map(order => ({ shop: order.shop, status: order.status, items: order.items.map(item => ({ title: item.title, lines: item.lines })),
        items_total: order.items_total, amount_lines: order.amount.lines, group_avatars: order.group_avatars_skipped, other_rows_skipped: order.other_rows_skipped })) };
    if (JSON.stringify(validatePddOrders(raw, { observedAt: value.observed_at, version: value.schema_version })) !== JSON.stringify(value)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved PDD order list result is invalid.'); }
}

export { PDD_ORDERS_SCHEMA_VERSION };
