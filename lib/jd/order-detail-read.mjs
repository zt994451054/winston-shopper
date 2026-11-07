import { ShoppingError, publicError } from '../errors.mjs';
import { parseTabId } from '../targets.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { JD_ORDER_DETAIL_POSITION_LIMIT } from './order-entry.mjs';
import { validateJdOrderDetail } from './order-detail.mjs';
import { jdLandingKind, parseJdOrderDetailUrl, parseJdOrderListUrl } from './targets.mjs';

const SCHEMA_VERSION = 1;
// The list read plus detail reads, failed ones included.
const MAX_READS = 4;
// Tab checks after the click that found nothing yet. A login or limit page found in a new tab pauses instead.
const MAX_CHECKS = 3;
// On 2026-10-19 the detail tab was listed a few seconds after a real click; checks follow 5 s, then 3 s apart.
const SETTLE_MS = 5_000;
const RECHECK_MS = 3_000;
const CLOCK_LIMIT_MS = 15_000;
const STATE_KEYS = ['checks', 'click', 'click_error', 'click_reserved', 'close', 'detail', 'detail_tab_id', 'entry', 'not_before', 'position',
  'reads', 'schema_version', 'tabs_before'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const codeOk = value => typeof value === 'string' && CODE.test(value);
const tabIdOk = value => { try { return parseTabId(value) === value; } catch { return false; } };

/**
 * @param {number} position 1-10, the loaded order card whose 订单详情 is opened.
 * @returns {object} A fresh journal: nothing read, clicked or closed. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function newJdOrderDetailReadState(position) {
  if (!Number.isSafeInteger(position) || position < 1 || position > JD_ORDER_DETAIL_POSITION_LIMIT) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use --order-position 1-${JD_ORDER_DETAIL_POSITION_LIMIT}.`);
  }
  return { schema_version: SCHEMA_VERSION, position, entry: null, reads: 0, tabs_before: null, click_reserved: false, click: null, click_error: null,
    checks: 0, detail_tab_id: null, detail: null, close: null, not_before: 0 };
}

/**
 * Accept a partial journal, including a click reserved but not yet acknowledged.
 * @param {object} state @param {number} listTabId The task's order list tab.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateJdOrderDetailReadState(state, listTabId) {
  try {
    if (!sameKeys(state, STATE_KEYS) || state.schema_version !== SCHEMA_VERSION || !Number.isSafeInteger(state.position) || state.position < 1 ||
        state.position > JD_ORDER_DETAIL_POSITION_LIMIT || !integer(state.reads, MAX_READS) || !integer(state.checks, MAX_CHECKS) ||
        !integer(state.not_before, Number.MAX_SAFE_INTEGER) || typeof state.click_reserved !== 'boolean' ||
        ![null, 'clicked', 'uncertain'].includes(state.click) || (state.click_error !== null && !codeOk(state.click_error)) ||
        (state.close !== null && state.close !== 'closed' && !codeOk(state.close))) throw new Error();
    // Each step needs the one before it: entry, click, a found tab, a read, then the close.
    if (state.entry === null) {
      if (state.click_reserved) throw new Error();
    } else {
      if (!sameKeys(state.entry, ['observed_at', 'order_id', 'split_order']) || !timestamp(state.entry.observed_at) ||
          typeof state.entry.order_id !== 'string' || !/^[0-9]{6,30}$/.test(state.entry.order_id) || typeof state.entry.split_order !== 'boolean' ||
          state.reads < 1) throw new Error();
    }
    if ((state.tabs_before !== null) !== state.click_reserved) throw new Error();
    if (state.tabs_before !== null && (!Array.isArray(state.tabs_before) || state.tabs_before.length > 1000 || !state.tabs_before.every(tabIdOk) ||
        new Set(state.tabs_before).size !== state.tabs_before.length)) throw new Error();
    if (!state.click_reserved && (state.click !== null || state.click_error !== null || state.checks > 0 || state.detail_tab_id !== null)) throw new Error();
    if ((state.click === 'clicked') === (state.click_error !== null) && state.click !== null) throw new Error();
    if (state.click === null && state.click_error !== null) throw new Error();
    if (state.detail_tab_id !== null && (state.click === null || !tabIdOk(state.detail_tab_id) || state.detail_tab_id === listTabId ||
        state.tabs_before.includes(state.detail_tab_id))) throw new Error();
    if (state.detail !== null) {
      if (state.detail_tab_id === null || !sameKeys(state.detail, ['observed_at', 'raw']) || !timestamp(state.detail.observed_at) || state.reads < 2) throw new Error();
      validateJdOrderDetail(state.detail.raw, state.entry.order_id, { observedAt: state.detail.observed_at });
    }
    if (state.close !== null && state.detail === null) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The JD order detail read journal is invalid.'); }
}

/**
 * Build the order detail result from a finished journal.
 * @param {object} state Finished journal. @param {{platform: 'jd', url: string}} target Order list target. @returns {object}
 */
export function jdOrderDetailResult(state, target) {
  const { observed_at: observedAt, order_id: orderId, ...detail } = validateJdOrderDetail(state.detail.raw, state.entry.order_id,
    { observedAt: state.detail.observed_at });
  return {
    schema_version: SCHEMA_VERSION, platform: 'jd', source: 'jd_order_detail_page', observed_at: observedAt, login_verified: false,
    order_list_url: target.url, order_position: state.position, order_id: orderId, split_order: state.entry.split_order, ...detail,
    opening: { list_observed_at: state.entry.observed_at, click: state.click, click_error: state.click_error, tab_checks: state.checks,
      reads_reserved: state.reads, detail_tab_closed: state.close === 'closed', close_error: state.close === 'closed' ? null : state.close },
    coverage: { status: 'partial', scope: 'single_order_detail_page', consignee_read: false, tracking_records_read: false,
      payment_tab_read: false, invoice_read: false, amount_meaning_verified: false },
    missing: ['tracking_records', 'payment_details', 'invoice'],
    // The product table's 操作 column is kept as text under its column name, so action buttons are not listed here.
    excluded: ['consignee', 'address', 'phone', 'tracking_records', 'payment_tab', 'invoice', 'pass_key', 'account', 'images'],
  };
}

/**
 * @param {object} result Saved result. @param {object} target Order list target. @param {object} state Saved journal.
 * @param {number} listTabId @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validateJdOrderDetailResult(result, target, state, listTabId) {
  try {
    validateJdOrderDetailReadState(state, listTabId);
    if (state.close === null || JSON.stringify(jdOrderDetailResult(state, target)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The JD order detail result does not match its journal.'); }
}

function notOpenedError() {
  return new ShoppingError('ORDER_DETAIL_NOT_OPENED', 'No new JD order detail tab for this order appeared after the click.',
    'Allow pop-ups for order.jd.com in this Chrome profile, then start a new task. This task does not click again.');
}

/**
 * Read the order id at one loaded position, click its 订单详情 once, find the one new detail tab for that order,
 * read it and close it. The click is recorded before it is sent and is never repeated, including after an interruption.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Order detail result.
 * @throws {ShoppingError} Page gates, refusals, ORDER_DETAIL_NOT_OPENED, ORDER_DETAIL_TAB_AMBIGUOUS or an exhausted read budget.
 */
export async function runJdOrderDetailRead({ bridge, op, commit, now, wait }) {
  const state = op.order_detail_read;
  if (!parseJdOrderListUrl(op.target?.url)) throw new ShoppingError('INVALID_CHECKPOINT', 'The JD order list target is invalid.');
  validateJdOrderDetailReadState(state, op.tab_id);
  // A killed process can leave the reservation without an acknowledgement. The click may have happened, so it is spent.
  if (state.click_reserved && state.click === null) {
    state.click = 'uncertain'; state.click_error = 'READ_INTERRUPTED'; state.not_before = now() + SETTLE_MS;
    await commit();
  }
  const reserveRead = async () => {
    if (state.reads >= MAX_READS) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The JD order detail read budget is exhausted.');
    state.reads += 1;
    await commit();
  };

  while (state.close === null) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The JD order detail wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (!state.entry) {
      await reserveRead();
      const list = await bridge.readJdOrders(op.tab_id, op.target);
      const order = list.orders[state.position - 1];
      if (!order) throw new ShoppingError('ORDER_POSITION_NOT_LOADED', 'The order list has no loaded order at this position.', 'Check the order list; choose a loaded position in a new task.');
      if (!order.order_id || !order.detail_entry) throw new ShoppingError('ORDER_DETAIL_ENTRY_MISSING', 'This order card has no readable order id or 订单详情 entry.');
      state.entry = { observed_at: list.observed_at, order_id: order.order_id, split_order: order.split_order };
      op.recovery_kind = null;
      await commit(); continue;
    }
    if (!state.click_reserved) {
      // The tab inventory is local; only tabs that are new after the click can be the detail page.
      state.tabs_before = (await bridge.listTabs()).map(tab => tab.id);
      state.click_reserved = true;
      await commit();
      try {
        await bridge.clickJdOrderDetail(op.tab_id, op.target, state.position, state.entry.order_id);
        state.click = 'clicked';
      } catch (error) {
        if (error.actionNotDispatched) { state.click_reserved = false; state.tabs_before = null; await commit(); throw error; }
        state.click = 'uncertain'; state.click_error = publicError(error).code;
      }
      op.recovery_kind = null;
      state.not_before = now() + SETTLE_MS;
      await commit(); continue;
    }
    if (state.detail_tab_id === null) {
      if (state.checks >= MAX_CHECKS) throw notOpenedError();
      const fresh = (await bridge.listTabs()).filter(tab => !state.tabs_before.includes(tab.id) && tab.id !== op.tab_id);
      const matches = fresh.filter(tab => parseJdOrderDetailUrl(tab.url)?.order_id === state.entry.order_id);
      if (matches.length > 1) throw new ShoppingError('ORDER_DETAIL_TAB_AMBIGUOUS', 'More than one new tab shows this order\'s detail page.', 'Close the extra tabs yourself; this task does not choose between them.');
      if (matches.length === 1) {
        state.detail_tab_id = matches[0].id; op.recovery_kind = null;
        await commit(); continue;
      }
      for (const [landing, code, message] of [['login_page', 'LOGIN_REQUIRED', 'The new tab shows the JD login page.'],
        ['risk_page', 'RATE_LIMITED', 'The new tab shows a JD access restriction.']]) {
        const blocked = fresh.filter(tab => jdLandingKind(tab.url) === landing);
        if (!blocked.length) continue;
        const error = new ShoppingError(code, message);
        error.blockedTabId = blocked.length === 1 ? blocked[0].id : null;
        throw error;
      }
      state.checks += 1;
      if (state.checks >= MAX_CHECKS) { await commit(); throw notOpenedError(); }
      state.not_before = now() + RECHECK_MS;
      await commit(); continue;
    }
    if (!state.detail) {
      await reserveRead();
      state.detail = await bridge.readJdOrderDetail(state.detail_tab_id, state.entry.order_id);
      op.recovery_kind = null;
      await commit(); continue;
    }
    // Closing is recorded, never retried; the read is complete either way.
    try { await bridge.closeJdOrderDetailTab(state.detail_tab_id, state.entry.order_id); state.close = 'closed'; }
    catch (error) { state.close = publicError(error).code; }
    await commit();
  }
  return jdOrderDetailResult(state, op.target);
}
