import { ShoppingError, publicError } from '../errors.mjs';
import { savedTabUrl } from '../saved-tab.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { ORDER_LIMIT, PDD_ORDER_DETAIL_SCHEMA_VERSION, validatePddOrderDetail } from './order-detail.mjs';
import { parsePddOrderDetailUrl, parsePddOrderListUrl, pddLandingKind, pddRiskPageError } from './targets.mjs';

const SCHEMA_VERSION = 1;
// On 2026-10-27 the detail page replaced the list within a few seconds, and the folded order info opened within 3 s.
const SETTLE_MS = 8_000;
const RECHECK_MS = 4_000;
const MAX_CHECKS = 3;
const EXPAND_SETTLE_MS = 3_000;
const MAX_READS = 2;
const REREAD_MS = 10_000;
const UNFINISHED_PAGE = new Set(['PAGE_STRUCTURE_CHANGED', 'PAGE_LOADING']);
const CLOCK_LIMIT_MS = 15_000;
const STATE_KEYS = ['schema_version', 'list_task', 'position', 'card', 'click_reserved', 'click', 'click_error', 'checks', 'order_id', 'expand_reserved',
  'expand', 'expand_error', 'reads', 'page', 'not_before'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validCard = card => sameKeys(card, ['shop', 'status', 'title']) && ['shop', 'status', 'title'].every(key => typeof card[key] === 'string' &&
  card[key].length > 0 && card[key].length <= 300);

/**
 * @param {string} listTask The completed pdd_orders task. @param {number} position 1-50.
 * @param {{shop: string, status: string, items: {title: string}[]}} order The saved order at that position.
 * @returns {object} A fresh journal: nothing clicked or read. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function newPddOrderDetailReadState(listTask, position, order) {
  const card = { shop: order?.shop, status: order?.status, title: order?.items?.[0]?.title };
  if (!Number.isSafeInteger(position) || position < 1 || position > ORDER_LIMIT || !validCard(card)) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use --order-position 1-${ORDER_LIMIT} for an order the list task read.`);
  }
  return { schema_version: SCHEMA_VERSION, list_task: listTask, position, card, click_reserved: false, click: null, click_error: null, checks: 0,
    order_id: null, expand_reserved: false, expand: null, expand_error: null, reads: 0, page: null, not_before: 0 };
}

/**
 * Accept a partial journal, including an action reserved but not yet acknowledged.
 * @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validatePddOrderDetailReadState(state) {
  try {
    if (!sameKeys(state, STATE_KEYS) || state.schema_version !== SCHEMA_VERSION || typeof state.list_task !== 'string' || !state.list_task ||
        !Number.isSafeInteger(state.position) || state.position < 1 || state.position > ORDER_LIMIT || !validCard(state.card) ||
        typeof state.click_reserved !== 'boolean' || ![null, 'clicked', 'uncertain'].includes(state.click) ||
        (state.click_error !== null && !(typeof state.click_error === 'string' && CODE.test(state.click_error))) || typeof state.expand_reserved !== 'boolean' ||
        ![null, 'clicked', 'not_shown', 'uncertain'].includes(state.expand) || (state.expand_error !== null && !(typeof state.expand_error === 'string' && CODE.test(state.expand_error))) ||
        !integer(state.checks, MAX_CHECKS) || !integer(state.reads, MAX_READS) || !integer(state.not_before, Number.MAX_SAFE_INTEGER)) throw new Error();
    // Each step needs the one before it: the card click, the detail address, the expand click, then the read.
    if (!state.click_reserved && (state.click !== null || state.checks > 0)) throw new Error();
    if ((state.click === 'uncertain') !== (state.click_error !== null) || (state.expand === 'uncertain') !== (state.expand_error !== null)) throw new Error();
    if (state.order_id !== null && (state.click === null || !parsePddOrderDetailUrl(`https://mobile.pinduoduo.com/order.html?order_sn=${state.order_id}`))) throw new Error();
    if (state.expand_reserved && state.order_id === null) throw new Error();
    if (!state.expand_reserved && state.expand !== null) throw new Error();
    if (state.reads > 0 && state.expand === null) throw new Error();
    if (state.page !== null) {
      if (!sameKeys(state.page, ['observed_at', 'raw']) || !timestamp(state.page.observed_at) || state.reads < 1) throw new Error();
      validatePddOrderDetail(state.page.raw, state.order_id, { observedAt: state.page.observed_at });
    }
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD order detail read journal is invalid.'); }
}

/**
 * @param {object} state Finished journal. @param {1|2} [version] Result format; a saved result is rebuilt in its own format.
 * @returns {object} The order detail result.
 */
export function pddOrderDetailResult(state, version = PDD_ORDER_DETAIL_SCHEMA_VERSION) {
  const { observed_at: observedAt, ...order } = validatePddOrderDetail(state.page.raw, state.order_id, { observedAt: state.page.observed_at, version });
  return {
    schema_version: version, platform: 'pdd', source: 'pdd_order_detail_page', observed_at: observedAt, login_verified: false,
    entry: { list_task: state.list_task, order_position: state.position, card_shop: state.card.shop, card_status: state.card.status,
      card_title: state.card.title, click: state.click, click_error: state.click_error, address_checks: state.checks, expand: state.expand,
      expand_error: state.expand_error, reads_reserved: state.reads },
    ...order,
    coverage: { status: 'partial', scope: 'order_detail_as_rendered', info_expanded: state.expand === 'clicked' && !order.info_folded,
      consignee_read: false, payment_read: false, logistics_read: false, amount_meaning_verified: false },
    missing: ['consignee', 'payment', 'logistics', ...(order.times.length ? [] : ['order_times'])],
    excluded: ['consignee', 'phone', 'address', 'payment_method', 'tracking_number', 'buttons', 'recommended_products'],
  };
}

/**
 * @param {object} result Saved result. @param {object} state Saved journal.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validatePddOrderDetailResult(result, state) {
  try {
    validatePddOrderDetailReadState(state);
    if (state.page === null || ![1, 2].includes(result?.schema_version) ||
      JSON.stringify(pddOrderDetailResult(state, result.schema_version)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD order detail result does not match its journal.'); }
}

function notOpenedError() {
  return new ShoppingError('ORDER_NOT_OPENED', 'The tab still shows the order list after clicking the order.',
    'Look at the tab; this task does not click again. Start a new order list task to try once more.');
}

/** Reserve, send and record one click; a refusal before dispatch frees the reservation, anything else spends it. */
async function clickOnce(state, keys, send, commit) {
  state[keys.reserved] = true;
  await commit();
  try {
    state[keys.outcome] = (await send()).clicked === false ? 'not_shown' : 'clicked';
  } catch (error) {
    if (error.actionNotDispatched) { state[keys.reserved] = false; await commit(); throw error; }
    state[keys.outcome] = 'uncertain'; state[keys.error] = publicError(error).code;
  }
}

/**
 * Click order N of a pdd_orders list once, wait for its detail page to replace the list in the same tab, click
 * 查看更多订单和优惠信息 once (user, 2026-10-27), then read the page. No click is ever repeated, including after an
 * interruption.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Order detail result. @throws {ShoppingError} Page gates, refusals, ORDER_NOT_OPENED or an exhausted read budget.
 */
export async function runPddOrderDetailRead({ bridge, op, commit, now, wait }) {
  const state = op.order_detail_read;
  if (JSON.stringify(parsePddOrderListUrl(op.target?.url)) !== JSON.stringify(op.target)) throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD order list target is invalid.');
  validatePddOrderDetailReadState(state);
  // A killed process can leave a reservation without an acknowledgement. The click may have happened, so it is spent.
  if (state.click_reserved && state.click === null) { state.click = 'uncertain'; state.click_error = 'READ_INTERRUPTED'; state.not_before = now() + SETTLE_MS; await commit(); }
  if (state.expand_reserved && state.expand === null) { state.expand = 'uncertain'; state.expand_error = 'READ_INTERRUPTED'; state.not_before = now() + EXPAND_SETTLE_MS; await commit(); }
  while (state.page === null) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The PDD order detail wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (!state.click_reserved) {
      await clickOnce(state, { reserved: 'click_reserved', outcome: 'click', error: 'click_error' },
        () => bridge.clickPddOrderCard(op.tab_id, state.position, state.card), commit);
      op.recovery_kind = null; state.not_before = now() + SETTLE_MS;
      await commit(); continue;
    }
    if (state.order_id === null) {
      if (state.checks >= MAX_CHECKS) throw notOpenedError();
      const url = await savedTabUrl(bridge, op.tab_id, 'The PDD order tab is neither listed nor reachable by its ID.');
      const detail = parsePddOrderDetailUrl(url);
      if (detail) { state.order_id = detail.order_id; op.recovery_kind = null; await commit(); continue; }
      const landing = pddLandingKind(url);
      if (landing === 'login_page') throw new ShoppingError('LOGIN_REQUIRED', 'PDD shows its login page on this tab.', 'Ask the user to log in to PDD in this browser profile.');
      if (landing === 'risk_page') throw pddRiskPageError();
      if (!parsePddOrderListUrl(url)) throw new ShoppingError('TARGET_CHANGED', 'The tab shows neither the order list nor an order.', 'Look at the tab; this task does not click again.');
      state.checks += 1;
      if (state.checks >= MAX_CHECKS) { await commit(); throw notOpenedError(); }
      state.not_before = now() + RECHECK_MS;
      await commit(); continue;
    }
    if (!state.expand_reserved) {
      await clickOnce(state, { reserved: 'expand_reserved', outcome: 'expand', error: 'expand_error' },
        () => bridge.expandPddOrderInfo(op.tab_id, state.order_id), commit);
      op.recovery_kind = null; state.not_before = now() + EXPAND_SETTLE_MS;
      await commit(); continue;
    }
    if (state.reads >= MAX_READS) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The PDD order detail read budget is exhausted.');
    state.reads += 1;
    await commit();
    try {
      state.page = await bridge.readPddOrderDetail(op.tab_id, state.order_id, state.card.shop);
    } catch (error) {
      if (!UNFINISHED_PAGE.has(error.code) || state.reads >= MAX_READS) throw error;
      state.not_before = now() + REREAD_MS;
      await commit(); continue;
    }
    op.recovery_kind = null;
    await commit();
  }
  return pddOrderDetailResult(state);
}
