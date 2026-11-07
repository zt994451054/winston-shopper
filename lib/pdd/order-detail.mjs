import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { pddPageGate } from './page-gate.mjs';
import { parsePddOrderDetailUrl } from './targets.mjs';

// Format 2 (2026-11-07) also treats 查看更多订单信息 as the fold entry; format 1 results are rebuilt with the long label only.
const PDD_ORDER_DETAIL_SCHEMA_VERSION = 2;
const ORDER_LIMIT = 50;
// Status words that may stand in the top block; anything else there (the consignee, phone and address share it) is dropped.
const STATUS_WORDS = ['已签收', '待收货', '待发货', '已发货', '运输中', '派送中', '待付款', '待分享', '交易成功', '交易已取消', '已取消', '退款成功',
  '极速退款成功', '退款中', '待评价', '已评价', '拼单成功', '未发货，退款成功'];
// Rows of the order block whose label starts a section that is never read: payment, logistics and contact details.
const SKIPPED_LABEL = '^(支付方式|支付渠道|交易流水|支付流水|物流公司|快递公司|快递单号|运单号|物流单号|收货人|收件人|收货地址|地址|手机|电话|联系电话)[:：]?';
const LABEL = '^[^：:\\s]{1,10}[：:]';
// The fold entry reads 查看更多订单和优惠信息, or 查看更多订单信息 on an order without discounts (2026-11-07).
const EXPAND_LABELS = Object.freeze(['查看更多订单和优惠信息', '查看更多订单信息']);
const BUTTONS = ['复制', '联系商家', '申请退款', '再次拼单', '追加评价', '查看物流', '删除订单', '更多', '收起', '申请售后', '确认收货', '去支付',
  '取消订单', '售后详情', '钱款去向', '设为匿名', '评价', '去评价', '再次购买', '催发货', '修改地址', '分享'];
const expandLabelsOf = version => version >= 2 ? EXPAND_LABELS : EXPAND_LABELS.slice(0, 1);
const LIMITS = Object.freeze({ line: 300, lines: 80, statusWords: STATUS_WORDS, skippedLabel: SKIPPED_LABEL, label: LABEL });
const AMOUNT = /(实付|应付)[:：]?\s*[￥¥]\s*([0-9]+(?:\.[0-9]+)?)/;
const ORDER_SN = /^[0-9A-Za-z-]{6,40}$/;

/**
 * In-page: click the 商品名称 of order card N once on the order list, after checking the card still shows the shop,
 * status and first title a pdd_orders task read. PDD opens order.html?order_sn= in the same tab (2026-10-27). No
 * button of the card is touched.
 * @param {{position: number, shop: string, status: string, title: string}} expected @param {Function} gate pddPageGate
 * @returns {{state: string}} 'clicked', a gate state, or why nothing was clicked.
 */
export function clickPddOrderCard(expected, gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/orders.html') return { state: 'target_changed' };
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const statuses = [...document.querySelectorAll('[data-test="订单状态"]')];
  const card = statuses.map(status => {
    let up = status;
    while (up.parentElement && statuses.filter(other => up.parentElement.contains(other)).length === 1) up = up.parentElement;
    return up;
  })[expected.position - 1];
  if (!card) return { state: 'order_not_loaded' };
  const name = card.querySelector('[data-test="商品名称"]');
  if (!name || clip(card.querySelector('[data-test="店铺名称"]')?.textContent) !== expected.shop ||
      clip(card.querySelector('[data-test="订单状态"]')?.textContent) !== expected.status || clip(name.textContent).slice(0, 300) !== expected.title) {
    return { state: 'order_changed' };
  }
  name.scrollIntoView({ block: 'center' });
  name.click();
  return { state: 'clicked' };
}

/**
 * @param {number} position 1-50. @param {{shop: string, status: string, title: string}} card The saved order card.
 * @returns {string} One fixed single-click expression. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function pddOrderCardClickScript(position, card) {
  const valid = text => typeof text === 'string' && text.length > 0 && text.length <= 300;
  if (!Number.isSafeInteger(position) || position < 1 || position > ORDER_LIMIT || !valid(card?.shop) || !valid(card.status) || !valid(card.title)) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use an order position from 1 to ${ORDER_LIMIT} and that card's saved shop, status and title.`);
  }
  return `(${clickPddOrderCard})(${JSON.stringify({ position, shop: card.shop, status: card.status, title: card.title })}, ${pddPageGate})`;
}

/**
 * In-page: click 查看更多订单和优惠信息 once on an order detail page; it unfolds the order times in place (2026-10-27).
 * An order without discounts labels the same entry 查看更多订单信息 (2026-11-07), so both labels are accepted.
 * @param {{order_id: string, labels: string[]}} expected @param {Function} gate pddPageGate
 * @returns {{state: string}} 'clicked', 'not_shown' when the page has no such entry, a gate state or a refusal.
 */
export function expandPddOrderInfo(expected, gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const ids = current.searchParams.getAll('order_sn');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/order.html' || ids.length !== 1 || ids[0] !== expected.order_id) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const own = element => [...element.childNodes].filter(node => node.nodeType === 3).map(node => String(node.textContent).trim()).join('');
  const entry = [...document.querySelectorAll('body *')].find(element => expected.labels.includes(element.children.length ? own(element) : String(element.textContent).trim()) &&
    element.getBoundingClientRect().height > 0);
  if (!entry) return { state: 'not_shown' };
  entry.scrollIntoView({ block: 'center' });
  entry.click();
  return { state: 'clicked' };
}

/** @param {string} orderId @returns {string} @throws {ShoppingError} INVALID_ARGUMENTS. */
export function pddOrderExpandScript(orderId) {
  if (typeof orderId !== 'string' || !ORDER_SN.test(orderId)) throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD order_sn.');
  return `(${expandPddOrderInfo})(${JSON.stringify({ order_id: orderId, labels: EXPAND_LABELS })}, ${pddPageGate})`;
}

const CLICK_REFUSALS = {
  order_not_loaded: ['ORDER_NOT_LOADED', 'The order list has no loaded order at this position.'],
  order_changed: ['ORDER_CHANGED', 'The order at this position no longer shows the shop, status and title the list task read.'],
};

/**
 * @param {unknown} value Page script result of a click script. @param {boolean} [expand] The expand script, which may answer not_shown.
 * @returns {{clicked: boolean}} @throws {ShoppingError} Page gate errors, refusals (marked actionNotDispatched) or INVALID_RESPONSE.
 */
export function validatePddOrderClick(value, expand = false) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  if (expand && value?.state === 'not_shown' && Object.keys(value).length === 1) return { clicked: false };
  const refusal = expand ? null : CLICK_REFUSALS[value?.state];
  try {
    if (refusal) throw new ShoppingError(...refusal, 'Read the order list again in a new pdd_orders task, then start a new detail task from it.');
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The PDD order click returned an unexpected acknowledgement.');
  } catch (error) {
    // Every non-click state comes from the page script before it clicked anything.
    if (typeof value?.state === 'string' && value.state !== 'clicked') error.actionNotDispatched = true;
    throw error;
  }
}

/**
 * Internal serialized collector for an order detail page (order.html?order_sn=), seen on 2026-10-27. The top block holds
 * the status words together with the consignee, phone and address; only known status words are kept from it and the
 * rest is counted. The order block is the smallest element holding both the shop name and 订单编号; its lines are read
 * as rendered, except sections that start with a payment, logistics or contact label, which are counted and dropped.
 * The recommended products below are not read.
 * @param {{order_id: string, shop: string}} expected @param {Function} gate pddPageGate @param {object} limits
 * @returns {object} Raw guarded observation.
 */
export function collectPddOrderDetail(expected, gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const ids = current.searchParams.getAll('order_sn');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/order.html' || ids.length !== 1 || ids[0] !== expected.order_id) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limits.line);
  const own = element => clip([...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(''));
  const visible = element => element.getBoundingClientRect().height > 0;
  // Text pieces: leaves, and elements that carry text of their own beside their children (amounts, the address).
  const pieces = [...document.querySelectorAll('body *')].filter(element => !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName) && visible(element) &&
    (element.children.length ? own(element) : clip(element.textContent)));
  const textOf = element => element.children.length ? own(element) : clip(element.textContent);
  const shop = pieces.find(element => textOf(element) === expected.shop);
  const number = pieces.find(element => /^订单编号/.test(textOf(element)));
  if (!shop || !number) return { state: 'structure_changed' };
  let block = shop;
  while (block && !block.contains(number)) block = block.parentElement;
  const top = pieces.filter(element => (element.compareDocumentPosition(shop) & 4) && !element.contains(shop));
  if (!block || top.some(element => block.contains(element))) return { state: 'structure_changed' };
  const status = top.map(textOf).filter(text => limits.statusWords.includes(text));

  const skipped = new RegExp(limits.skippedLabel);
  const label = new RegExp(limits.label);
  const lines = [];
  let skipping = false, rowsSkipped = 0;
  for (const line of String(block.innerText ?? '').split('\n').map(clip).filter(Boolean)) {
    if (skipped.test(line)) { skipping = true; rowsSkipped += 1; continue; }
    if (skipping && !label.test(line)) { rowsSkipped += 1; continue; }
    skipping = false;
    lines.push(line);
  }
  return { state: 'observed', order_id: expected.order_id, status, top_parts_skipped: top.length - status.length, lines: lines.slice(0, limits.lines),
    lines_total: lines.length, rows_skipped: rowsSkipped };
}

/**
 * @param {string} orderId order_sn from the tab address. @param {string} shop The shop name the list task read.
 * @returns {string} One fixed read-only expression. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function pddOrderDetailScript(orderId, shop) {
  if (typeof orderId !== 'string' || !ORDER_SN.test(orderId) || typeof shop !== 'string' || !shop || shop.length > 300) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD order_sn and the saved shop name.');
  }
  return `(${collectPddOrderDetail})(${JSON.stringify({ order_id: orderId, shop })}, ${pddPageGate}, ${JSON.stringify(LIMITS)})`;
}

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The PDD order detail response does not match the supported page.');
const count = (value, max = 100000) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Label-value pairs such as 订单编号： 123 or 下单时间：2026-…, on one line or the label alone followed by its value. */
function pairs(lines) {
  const found = [];
  for (let at = 0; at < lines.length; at += 1) {
    const match = lines[at].match(/^([^：:\s]{1,10})[：:]\s*(.*)$/);
    if (!match) continue;
    const value = match[2] || (lines[at + 1] && !/^[^：:\s]{1,10}[：:]/.test(lines[at + 1]) ? lines[at + 1] : '');
    found.push({ label: match[1], value });
  }
  return found;
}

/**
 * Validate one observation of a PDD order detail page.
 * @param {unknown} value Raw page observation. @param {string} orderId
 * @param {{observedAt?: string, version?: 1|2}} [options] version rebuilds a saved result with that format's rules.
 * @returns {object} Order fields. @throws {ShoppingError} Page gates, PAGE_STRUCTURE_CHANGED, ORDER_NUMBER_MISMATCH or INVALID_RESPONSE.
 */
export function validatePddOrderDetail(value, orderId, { observedAt = new Date().toISOString(), version = PDD_ORDER_DETAIL_SCHEMA_VERSION } = {}) {
  const target = parsePddOrderDetailUrl(`https://mobile.pinduoduo.com/order.html?order_sn=${orderId}`);
  if (!target) throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD order_sn.');
  throwPageError(value?.state);
  if (value?.state !== 'observed' || value.order_id !== orderId || !Array.isArray(value.status) || value.status.length > 10 ||
      value.status.some(word => !STATUS_WORDS.includes(word)) || !count(value.top_parts_skipped, 1000) || !Array.isArray(value.lines) ||
      value.lines.length > LIMITS.lines || !count(value.lines_total, 10000) || value.lines_total < value.lines.length || !count(value.rows_skipped, 1000)) throw invalid();
  const all = value.lines.map(line => responseText(line, LIMITS.line)).filter(Boolean);
  if (all.some(line => new RegExp(SKIPPED_LABEL).test(line))) throw invalid();
  const expandLabels = expandLabelsOf(version);
  const lines = all.filter(line => !BUTTONS.includes(line) && !expandLabels.includes(line));
  const found = pairs(lines);
  const shown = found.find(pair => pair.label === '订单编号')?.value ?? null;
  if (shown !== null && shown !== orderId) {
    throw new ShoppingError('ORDER_NUMBER_MISMATCH', 'The page shows another order number than its address.', 'Look at the tab; this task does not click again.');
  }
  const paid = lines.join(' ').match(AMOUNT);
  return {
    order_id: target.order_id, url: `https://mobile.pinduoduo.com/order.html?order_sn=${target.order_id}`, observed_at: observedAt,
    status_words: value.status, top_parts_skipped: value.top_parts_skipped, order_number_shown: shown,
    amount: { label: paid ? paid[1] : null, amount_text: paid ? paid[2] : null, verified: false },
    discount_lines: lines.filter(line => /优惠|立减|补贴|券/.test(line) && !/^[^：:\s]{1,10}[：:]/.test(line)),
    times: found.filter(pair => /时间$/.test(pair.label) && pair.value),
    info_folded: all.some(line => expandLabels.includes(line)),
    lines, lines_cut: value.lines_total > value.lines.length, rows_skipped: value.rows_skipped,
  };
}

export { PDD_ORDER_DETAIL_SCHEMA_VERSION, ORDER_LIMIT };
