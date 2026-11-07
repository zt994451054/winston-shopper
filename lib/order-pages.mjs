import { isDeepStrictEqual } from 'node:util';
import { ShoppingError, publicError } from './errors.mjs';
import { failureCategory } from './task-policy.mjs';
import { parseOrderListUrl } from './order-target.mjs';
import { DEFAULT_ORDER_VIEW, orderPageIds, validateOrderPageSnapshot, validateEmptyOrderPage } from './order-page-view.mjs';
import { WHOLE_PAGE_ORDERS } from './order-rows.mjs';

/** Largest page count one task may request; the live account showed 9 pages of 30 orders (2026-10-13). */
export const MAX_ORDER_PAGES = 10;
const CHECK_LIMIT = 3;
const INTERVAL_MS = 1500;
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function signature(page) {
  return { current_page: page.pager.current_page, total_pages_displayed: page.pager.total_pages_displayed,
    loaded_orders_seen: page.rows.coverage.loaded_orders_seen, order_ids: orderPageIds(page) };
}
function emptySignature(page) {
  return { current_page: page.pager.current_page, total_pages_displayed: page.pager.total_pages_displayed, loaded_orders_seen: 0, order_ids: [] };
}
function pendingTransition(state) { return state.transitions.find(transition => !transition.confirmed) ?? null; }
function endReason(state) {
  const last = state.pages.at(-1);
  if (!last) return null;
  if (state.empty_last_page) return 'empty_last_page';
  if (state.pages.length === state.requested_pages) return 'requested_pages';
  return last.pager.next_disabled ? 'last_page' : null;
}
function seenIds(pages) { return new Set(pages.flatMap(orderPageIds)); }

/**
 * Check what every accepted page must show: the default view, unique explicit order IDs and no order from earlier pages.
 * The displayed page count is deliberately not compared: live, it fell from 9 to 8 on reaching page 3 (2026-10-13).
 * @returns {string|null} Stop code, or null when the page is acceptable.
 */
function pageProblem(page, earlier) {
  if (!isDeepStrictEqual(page.view, DEFAULT_ORDER_VIEW)) return earlier.length ? 'ORDER_VIEW_CHANGED' : 'ORDER_VIEW_NOT_DEFAULT';
  const ids = orderPageIds(page);
  if (ids.includes(null) || new Set(ids).size !== ids.length) return 'ORDER_CONTINUITY_UNVERIFIED';
  const seen = seenIds(earlier);
  if (ids.some(id => seen.has(id))) return 'ORDER_PAGES_OVERLAP';
  return null;
}
const STOP_MESSAGES = {
  ORDER_VIEW_NOT_DEFAULT: 'Start from page 1 of the 所有订单 tab with an empty order search box. Nothing was clicked.',
  ORDER_VIEW_CHANGED: 'The order list left the 所有订单 tab or its search box is no longer empty. Saved pages were retained.',
  ORDER_CONTINUITY_UNVERIFIED: 'An order on this page lacks a unique printed order number, so page continuity cannot be checked. Saved pages were retained.',
  ORDER_PAGES_OVERLAP: 'This page repeats an order from an earlier page; the list probably changed while reading. Saved pages were retained.',
};

/**
 * Fix the requested page scope and cumulative budgets for a new multi-page order task.
 * Schema 2 adds `empty_last_page`: the displayed last page may hold no orders (live, 2026-10-13). Schema 1 journals stay
 * readable and runnable, and stop on such a page as before.
 * @param {number} pages Integer from 1 to MAX_ORDER_PAGES. @param {1|2} [schemaVersion] Only for revalidating saved journals.
 * @returns {object} Empty durable journal. @throws {ShoppingError} INVALID_ARGUMENTS. @example newOrderPagesState(3);
 */
export function newOrderPagesState(pages, schemaVersion = 2) {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_ORDER_PAGES || ![1, 2].includes(schemaVersion)) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Order paging requires a page count from 1 to ${MAX_ORDER_PAGES}.`);
  }
  return { schema_version: schemaVersion, requested_pages: pages, orders_per_page: WHOLE_PAGE_ORDERS,
    read_limit: 6, recovery_limit: 2, recovery_wait_ms: 5000, recoveries_reserved: 0, failures: [],
    observation_limit: 1 + 4 * (pages - 1) + 4, observations: 0, not_before: 0, pages: [], transitions: [],
    ...(schemaVersion === 2 ? { empty_last_page: null } : {}) };
}

// A candidate is one unconfirmed read; its view, IDs and total are judged only once a second read matches it.
function validateCandidate(value, transition) {
  if (!sameKeys(value, ['current_page', 'total_pages_displayed', 'loaded_orders_seen', 'order_ids']) ||
      value.current_page !== transition.to_page || !integer(value.total_pages_displayed, 9999) || value.total_pages_displayed < value.current_page ||
      !integer(value.loaded_orders_seen, 2000) || !Array.isArray(value.order_ids) ||
      value.order_ids.length !== Math.min(WHOLE_PAGE_ORDERS, value.loaded_orders_seen) ||
      value.order_ids.some(id => id !== null && (typeof id !== 'string' || !/^[0-9]{1,40}$/.test(id)))) throw Error();
}

/**
 * Validate the immutable scope, contiguous pages, next-page intents and cumulative budgets.
 * @param {unknown} state Journal. @param {{url:string}} target Canonical list route. @param {object} [op] Execution counters.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT before browser IO.
 * @example validateOrderPagesState(op.order_pages, op.target, op);
 */
export function validateOrderPagesState(state, target, op) {
  try {
    const expected = newOrderPagesState(state?.requested_pages, state?.schema_version);
    if (!isDeepStrictEqual(parseOrderListUrl(target?.url), target) || !sameKeys(state, Object.keys(expected))) throw Error();
    for (const key of ['schema_version', 'orders_per_page', 'read_limit', 'recovery_limit', 'recovery_wait_ms', 'observation_limit']) {
      if (state[key] !== expected[key]) throw Error();
    }
    if (!integer(state.recoveries_reserved, state.recovery_limit) || !integer(state.observations, state.observation_limit) ||
        !integer(state.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(state.pages) || state.pages.length > state.requested_pages ||
        !Array.isArray(state.transitions) || state.transitions.length > state.requested_pages - 1 ||
        !Array.isArray(state.failures) || state.failures.length > state.read_limit) throw Error();
    state.pages.forEach((page, index) => {
      validateOrderPageSnapshot(page, target, index + 1);
      if (pageProblem(page, state.pages.slice(0, index))) throw Error();
    });
    if (!state.pages.length && state.transitions.length) throw Error();
    const empty = state.empty_last_page ?? null;
    if (empty) {
      validateEmptyOrderPage(empty, target, state.pages.length + 1);
      if (!isDeepStrictEqual(empty.view, DEFAULT_ORDER_VIEW) || state.transitions.length !== state.pages.length) throw Error();
    }
    let confirmed = 0, minimumObservations = state.pages.length ? 1 : 0;
    for (const [index, transition] of state.transitions.entries()) {
      if (!sameKeys(transition, ['from_page', 'to_page', 'action_reserved_at', 'acknowledgement_error', 'checks', 'candidate', 'confirmed']) ||
          transition.from_page !== index + 1 || transition.to_page !== index + 2 || !timestamp(transition.action_reserved_at) ||
          !(transition.acknowledgement_error === null || code(transition.acknowledgement_error)) || !integer(transition.checks, CHECK_LIMIT) ||
          typeof transition.confirmed !== 'boolean' || !state.pages[index] || state.pages[index].pager.next_disabled) throw Error();
      minimumObservations += 1 + transition.checks;
      if (transition.candidate !== null) {
        validateCandidate(transition.candidate, transition);
        if (transition.checks < 1) throw Error();
      }
      if (transition.confirmed) {
        confirmed++;
        const next = state.pages[index + 1] ? signature(state.pages[index + 1]) : empty && index + 1 === state.pages.length ? emptySignature(empty) : null;
        if (transition.checks < 2 || !next || !isDeepStrictEqual(transition.candidate, next)) throw Error();
      } else if (index !== state.transitions.length - 1 || state.pages.length !== index + 1) throw Error();
    }
    if (state.pages.length + (empty ? 1 : 0) !== (state.pages.length ? confirmed + 1 : 0) || state.observations < minimumObservations ||
        (endReason(state) && pendingTransition(state))) throw Error();
    let previousAttempt = 0;
    for (const failure of state.failures) {
      if (!sameKeys(failure, ['attempt', 'category', 'code']) || !integer(failure.attempt, state.read_limit) ||
          failure.attempt <= previousAttempt || !code(failure.code) || failure.category !== failureCategory(failure.code)) throw Error();
      previousAttempt = failure.attempt;
    }
    if (op && (!integer(op.attempts, state.read_limit) || state.recoveries_reserved > op.attempts || previousAttempt > op.attempts ||
        (['running', 'succeeded', 'failed'].includes(op.status) && op.attempts === 0) ||
        (['running', 'succeeded'].includes(op.status) && previousAttempt === op.attempts && previousAttempt !== 0) ||
        (op.recovery_kind !== null && state.recoveries_reserved === 0))) throw Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved order paging journal is invalid.'); }
}

function resultFor(target, state) {
  const first = state.pages[0], empty = state.empty_last_page ?? null, returned = state.pages.reduce((sum, page) => sum + page.rows.orders.length, 0);
  // A confirmed empty trailing page is the displayed last page; the orders ended on the page before it.
  const last = empty ?? state.pages.at(-1), shown = [...state.pages, ...(empty ? [empty] : [])];
  const allListed = last.pager.next_disabled && shown.length === last.pager.total_pages_displayed;
  return { schema_version: 1, url: target.url, source: 'bounded_order_pages', requested_pages: state.requested_pages, pages: state.pages,
    returned_orders: returned, distinct_orders: seenIds(state.pages).size, end_reason: endReason(state),
    ...(state.schema_version === 2 ? { empty_last_page: empty } : {}),
    coverage: { status: 'partial', pages_read: state.pages.length, total_pages_displayed: last.pager.total_pages_displayed,
      total_pages_first_displayed: first.pager.total_pages_displayed,
      total_pages_changed: shown.some(page => page.pager.total_pages_displayed !== first.pager.total_pages_displayed),
      page_transition_verified: state.transitions.length > 0 && state.transitions.every(transition => transition.confirmed),
      requested_bound_reached: state.pages.length === state.requested_pages, visible_last_page_verified: last.pager.next_disabled,
      all_listed_pages_read: allListed, listed_view: DEFAULT_ORDER_VIEW.tab, order_search_empty: true, recycle_bin_included: false,
      full_order_history: false, account_identity_verified: false, physical_order_identity_verified: false, settlement_verified: false },
    limits: { requested_pages: state.requested_pages, orders_per_page: WHOLE_PAGE_ORDERS, item_positions_per_order: 10 },
    action_evidence: { actions_reserved: state.transitions.length, observations_reserved: state.observations,
      transitions: state.transitions.map(transition => ({ from_page: transition.from_page, to_page: transition.to_page,
        action_reserved_at: transition.action_reserved_at, acknowledgement_error: transition.acknowledgement_error,
        checks: transition.checks, verified: transition.confirmed })),
      verification: 'pager_current_page_and_disjoint_order_ids_with_two_consecutive_matching_observations' },
    missing: ['recycle_bin_orders', 'unlisted_older_orders', 'items_beyond_ten_per_order'],
    privacy: { local_only: true, contact_fields_read: false, account_profile_read: false, order_search_text_read: false } };
}

/**
 * Require a completed cached result to agree with every saved page and count.
 * @param {unknown} value Result. @param {{url:string}} target @param {object} state
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateOrderPagesResult(op.result, op.target, op.order_pages);
 */
export function validateOrderPagesResult(value, target, state) {
  validateOrderPagesState(state, target);
  if (!endReason(state) || !isDeepStrictEqual(value, resultFor(target, state))) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The order paging result does not match its completed journal.');
  }
}

/**
 * Finish a journal whose last page was saved before the result was published.
 * @param {{url:string}} target @param {object} state @returns {object|null} Completed local result, or null if more pages are needed.
 * @throws {ShoppingError} INVALID_CHECKPOINT. @example orderPagesCachedResult(op.target, op.order_pages);
 */
export function orderPagesCachedResult(target, state) {
  validateOrderPagesState(state, target);
  return endReason(state) ? resultFor(target, state) : null;
}

/**
 * Pages a read may show: the confirmed current page, plus its successor only while a saved next-page intent is pending.
 * @param {object} state @returns {number[]} Allowed page numbers. @example orderPagesAllowed(op.order_pages);
 */
export function orderPagesAllowed(state) {
  const pending = pendingTransition(state);
  return pending ? [pending.from_page, pending.to_page] : [state.pages.length || 1];
}

/**
 * Drop only an unfinished two-read confirmation after a gate or connection failure; pages, intents and budgets stay.
 * @param {object} state @returns {void} @example invalidateOrderPagesCandidate(op.order_pages);
 */
export function invalidateOrderPagesCandidate(state) {
  const pending = pendingTransition(state);
  if (pending) pending.candidate = null;
}

async function waitForObservation(state, now, wait) {
  const delay = state.not_before - now();
  if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved order observation interval is inconsistent.');
  if (delay > 0) await wait(delay);
}

async function reserveObservation(state, commit, now, wait) {
  if (state.observations >= state.observation_limit) {
    throw new ShoppingError('ORDER_OBSERVATION_LIMIT', 'The cumulative order page observation budget is exhausted.');
  }
  await waitForObservation(state, now, wait);
  state.observations++;
  state.not_before = now() + INTERVAL_MS;
  await commit();
}

async function reserveNextPage({ bridge, op, commit, now, wait }) {
  const state = op.order_pages, before = state.pages.at(-1);
  // The click script re-reads the whole page as its guard, so it also consumes a content observation.
  if (state.observations >= state.observation_limit) throw new ShoppingError('ORDER_OBSERVATION_LIMIT', 'No observation remains for a guarded next-page click.');
  await waitForObservation(state, now, wait);
  const transition = { from_page: before.pager.current_page, to_page: before.pager.current_page + 1,
    action_reserved_at: new Date(now()).toISOString(), acknowledgement_error: null, checks: 0, candidate: null, confirmed: false };
  state.transitions.push(transition);
  state.observations++;
  state.not_before = now() + INTERVAL_MS;
  await commit();
  try { await bridge.nextOrderPage(op.tab_id, op.target, before); }
  catch (error) {
    if (error.actionNotDispatched) {
      // Certainly nothing was clicked (a page gate, a changed page or a used-up pacing quota): release the intent so a
      // later run may reserve it again. The observation stays spent.
      state.transitions.pop(); await commit(); throw error;
    }
    transition.acknowledgement_error = publicError(error).code;
    await commit();
    if (['user', 'rate', 'connection'].includes(failureCategory(transition.acknowledgement_error))) throw error;
  }
  state.not_before = now() + INTERVAL_MS;
  await commit();
}

function acceptCheck(state, pending, page) {
  pending.checks++;
  if (page.pager.current_page !== pending.to_page) { pending.candidate = null; return; }
  const previous = state.pages.at(-1);
  // A page whose order list has not been replaced yet is still loading, not a repeat of the previous page.
  if (isDeepStrictEqual(orderPageIds(page), orderPageIds(previous))) { pending.candidate = null; return; }
  const current = signature(page);
  if (!pending.candidate || !isDeepStrictEqual(pending.candidate, current)) { pending.candidate = current; return; }
  const problem = pageProblem(page, state.pages);
  if (problem) { pending.candidate = null; throw new ShoppingError(problem, STOP_MESSAGES[problem]); }
  state.pages.push(page); pending.confirmed = true;
}

function acceptEmptyPage(state, pending, empty) {
  if (!pending || state.schema_version < 2) {
    throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The order list shows no orders on this page. Saved pages were retained.');
  }
  pending.checks++;
  // Only the displayed last page may stay empty; an empty page with an enabled next control is treated as still loading.
  if (empty.pager.current_page !== pending.to_page || !empty.pager.next_disabled) { pending.candidate = null; return; }
  const current = emptySignature(empty);
  if (!pending.candidate || !isDeepStrictEqual(pending.candidate, current)) { pending.candidate = current; return; }
  if (!isDeepStrictEqual(empty.view, DEFAULT_ORDER_VIEW)) {
    pending.candidate = null; throw new ShoppingError('ORDER_VIEW_CHANGED', STOP_MESSAGES.ORDER_VIEW_CHANGED);
  }
  state.empty_last_page = empty; pending.confirmed = true;
}

/**
 * Read 1–MAX_ORDER_PAGES whole order-list pages, using at most one durable next-page click per adjacent page.
 * @param {{bridge:object, op:object, commit:Function, now:Function, wait:Function}} context
 * @returns {Promise<object>} Partial order coverage with each page's own time, pager and view.
 * @throws {ShoppingError} Page gates, invalid responses, view or list changes, or exhausted budgets; uncertain clicks never repeat.
 * @example await runOrderPages({ bridge, op, commit, now, wait });
 */
export async function runOrderPages(context) {
  const { bridge, op, commit, now, wait } = context, state = op.order_pages;
  validateOrderPagesState(state, op.target, op);
  while (!endReason(state)) {
    if (state.pages.length && !pendingTransition(state)) await reserveNextPage(context);
    const pending = pendingTransition(state);
    if (pending?.checks >= CHECK_LIMIT) {
      throw new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'The next order page could not be confirmed. The saved next-page click will not be repeated.');
    }
    await reserveObservation(state, commit, now, wait);
    let observation;
    try { observation = await bridge.readOrderPage(op.tab_id, op.target, orderPagesAllowed(state)); }
    catch (error) { invalidateOrderPagesCandidate(state); throw error; }
    state.not_before = now() + INTERVAL_MS;
    const page = observation.page;
    if (observation.state === 'no_orders') acceptEmptyPage(state, pending, observation.empty_page);
    else if (!pending) {
      const problem = pageProblem(page, []);
      if (problem) throw new ShoppingError(problem, STOP_MESSAGES[problem]);
      state.pages.push(page);
    } else acceptCheck(state, pending, page);
    await commit();
  }
  return resultFor(op.target, state);
}
