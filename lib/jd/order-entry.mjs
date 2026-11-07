import { ShoppingError } from '../errors.mjs';
import { throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { parseJdOrderListUrl } from './targets.mjs';

/** Loaded order cards whose 订单详情 entry a task may click (user, 2026-10-19). */
export const JD_ORDER_DETAIL_POSITION_LIMIT = 10;

/**
 * In-page: click 订单详情 once on the loaded order card at one position, after checking that the card still shows the
 * order the task read. Cards are taken in page order, as collectJdOrders numbers them. The entry is a plain element that
 * calls window.open; a script click is not a user gesture, so the page opens only where the user allows pop-ups
 * for order.jd.com (2026-10-19 probe). Nothing else is clicked, scrolled or read.
 * @param {{position: number, order_id: string}} expected @param {Function} gate jdPageGate
 * @returns {{state: string}} 'clicked', a gate state, or why nothing was clicked.
 */
export function clickJdOrderDetailEntry(expected, gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  if (current.hostname !== 'order.jd.com' || current.pathname !== '/center/list.action') return { state: 'target_changed' };
  const textOf = node => String(node?.innerText ?? '').replace(/\s+/g, '');
  const hasClass = (node, token) => String(node?.className ?? '').includes(token);
  const lists = [...document.querySelectorAll('[class*="listContent-"]')];
  if (lists.length !== 1) return { state: 'structure_changed' };
  const card = [...lists[0].children].flatMap(group => [...group.querySelectorAll('[class*="orderCard-"]')])[expected.position - 1];
  if (!card) return { state: 'order_not_loaded' };
  // Same reading as collectJdOrders: the 订单号 label is followed by its value.
  const orderId = (() => {
    for (const block of card.querySelectorAll('[class*="orderMetas-"]')) {
      const kids = [...block.children];
      const index = kids.findIndex(kid => hasClass(kid, 'metaLabel-') && textOf(kid) === '订单号');
      if (index < 0) continue;
      const value = kids[index + 1];
      return value && hasClass(value, 'metaValue-') ? (textOf(value) || String(value.getAttribute('title') ?? '').trim()) : null;
    }
    return null;
  })();
  if (orderId !== expected.order_id) return { state: 'order_changed' };
  const entries = [...card.querySelectorAll('[class*="detailSection-"] [class*="detailLink-"]')].filter(node => textOf(node) === '订单详情');
  if (entries.length !== 1) return { state: entries.length ? 'entry_ambiguous' : 'entry_missing' };
  entries[0].click();
  return { state: 'clicked' };
}

/**
 * @param {{platform: 'jd', url: string}} target Canonical order list target. @param {number} position 1-10.
 * @param {string} orderId The order the task read at that position.
 * @returns {string} One fixed single-click expression.
 * @throws {ShoppingError} INVALID_ARGUMENTS for another target, position or order id.
 */
export function jdOrderDetailClickScript(target, position, orderId) {
  const expected = parseJdOrderListUrl(target?.url);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(target) || !Number.isSafeInteger(position) || position < 1 ||
      position > JD_ORDER_DETAIL_POSITION_LIMIT || typeof orderId !== 'string' || !/^[0-9]{6,30}$/.test(orderId)) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use the canonical JD order list, an order position from 1 to ${JD_ORDER_DETAIL_POSITION_LIMIT} and its order id.`);
  }
  return `(${clickJdOrderDetailEntry})(${JSON.stringify({ position, order_id: orderId })}, ${jdPageGate})`;
}

const REFUSALS = {
  order_not_loaded: ['ORDER_POSITION_NOT_LOADED', 'The order list no longer has a loaded order at this position.'],
  order_changed: ['ORDER_DETAIL_ENTRY_CHANGED', 'The order at this position is no longer the one the task read.'],
  entry_missing: ['ORDER_DETAIL_ENTRY_MISSING', 'This order card has no 订单详情 entry.'],
  entry_ambiguous: ['ORDER_DETAIL_ENTRY_MISSING', 'This order card has more than one 订单详情 entry.'],
};

/**
 * @param {unknown} value Page script result. @returns {{clicked: true}}
 * @throws {ShoppingError} Page gate errors, a refusal (nothing clicked, marked actionNotDispatched) or INVALID_RESPONSE.
 */
export function validateJdOrderDetailClick(value) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  const refusal = REFUSALS[value?.state];
  try {
    if (refusal) throw new ShoppingError(...refusal, 'Check the order list; the click is not repeated by this task.');
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The JD order detail click returned an unexpected acknowledgement.');
  } catch (error) {
    // Every non-click state comes from the page script before it clicked anything.
    if (typeof value?.state === 'string' && value.state !== 'clicked') error.actionNotDispatched = true;
    throw error;
  }
}
