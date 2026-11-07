import { ShoppingError, publicError } from './errors.mjs';
import { failureCategory } from './task-policy.mjs';
import { searchTarget } from './search.mjs';
import { SEARCH_RANGE_CARD_LIMIT, searchRangeTarget, validateSearchCollectionSnapshot } from './search-page-range.mjs';

const CHECK_LIMIT = 3;
const INTERVAL_MS = 1500;
const identities = page => page.search.items.map(item => item.product_id);
const signature = page => JSON.stringify([identities(page), page.pagination.total_pages_displayed]);
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sameKeys = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function hasNewItems(before, after) {
  const old = new Set(identities(before));
  return identities(after).some(id => !old.has(id));
}

function pendingTransition(state) { return state.transitions.find(transition => !transition.confirmed) ?? null; }

function endReason(state) {
  const last = state.pages.at(-1);
  if (!last) return null;
  if (state.pages.length === state.requested_pages) return 'requested_pages';
  return last.pagination.next_disabled ? 'visible_last_page' : null;
}

/**
 * Fix the requested page scope and cumulative budgets for a new search task.
 * @param {number} pages Integer from 1 to 5. @returns {object} Empty durable collection journal.
 * @throws {ShoppingError} INVALID_ARGUMENTS. @example newSearchCollectionState(3);
 */
export function newSearchCollectionState(pages) {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 5) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Search collection requires a page count from 1 to 5.');
  }
  return { schema_version: 1, requested_pages: pages, cards_per_page: SEARCH_RANGE_CARD_LIMIT,
    read_limit: 6, recovery_limit: 2, recovery_wait_ms: 5000, recoveries_reserved: 0, failures: [],
    observation_limit: 1 + 4 * (pages - 1) + 4, observations: 0, not_before: 0, pages: [], transitions: [] };
}

/**
 * Validate immutable scope, contiguous snapshots, navigation intent and cumulative budgets.
 * @param {unknown} state Journal. @param {object} target Canonical first-page target.
 * @param {object} [op] Execution counters when validating a checkpoint.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT before browser IO.
 * @example validateSearchCollectionState(op.search_collection, op.target, op);
 */
export function validateSearchCollectionState(state, target, op) {
  try {
    const expected = newSearchCollectionState(state?.requested_pages);
    if (JSON.stringify(searchTarget(target?.query)) !== JSON.stringify(target) || !sameKeys(state, Object.keys(expected))) throw Error();
    for (const key of ['schema_version', 'requested_pages', 'read_limit', 'recovery_limit', 'recovery_wait_ms', 'observation_limit']) {
      if (state[key] !== expected[key]) throw Error();
    }
    // Collections started before 2026-10-14 keep twenty-five cards per page until they end.
    if (![25, SEARCH_RANGE_CARD_LIMIT].includes(state.cards_per_page)) throw Error();
    if (!integer(state.recoveries_reserved, 2) || !integer(state.observations, state.observation_limit) ||
        !integer(state.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(state.pages) || state.pages.length > state.requested_pages ||
        !Array.isArray(state.transitions) || state.transitions.length > state.requested_pages - 1 || !Array.isArray(state.failures) || state.failures.length > state.read_limit) throw Error();
    state.pages.forEach((page, index) => {
      validateSearchCollectionSnapshot(page, target, index + 1, state.cards_per_page);
      if (index && page.pagination.total_pages_displayed !== state.pages[0].pagination.total_pages_displayed) throw Error();
    });
    if (!state.pages.length && state.transitions.length) throw Error();
    let confirmed = 0, minimumObservations = state.pages.length ? 1 : 0;
    for (const [index, transition] of state.transitions.entries()) {
      if (!sameKeys(transition, ['from_page', 'to_page', 'action_reserved_at', 'acknowledgement_error', 'checks', 'candidate', 'confirmed']) ||
          transition.from_page !== index + 1 || transition.to_page !== index + 2 || !timestamp(transition.action_reserved_at) ||
          !(transition.acknowledgement_error === null || code(transition.acknowledgement_error)) || !integer(transition.checks, CHECK_LIMIT) ||
          typeof transition.confirmed !== 'boolean' || !state.pages[index] || state.pages[index].pagination.next_disabled) throw Error();
      minimumObservations += 1 + transition.checks;
      if (transition.candidate !== null) {
        validateSearchCollectionSnapshot(transition.candidate, target, index + 2, state.cards_per_page);
        if (transition.checks < 1 || !hasNewItems(state.pages[index], transition.candidate) ||
            transition.candidate.pagination.total_pages_displayed !== state.pages[index].pagination.total_pages_displayed) throw Error();
      }
      if (transition.confirmed) {
        confirmed++;
        if (!transition.candidate || transition.checks < 2 || !state.pages[index + 1] ||
            signature(transition.candidate) !== signature(state.pages[index + 1]) || !hasNewItems(state.pages[index], state.pages[index + 1])) throw Error();
      } else if (index !== state.transitions.length - 1 || state.pages.length !== index + 1) throw Error();
    }
    if (state.pages.length !== (state.pages.length ? confirmed + 1 : 0) || state.observations < minimumObservations ||
        (endReason(state) && pendingTransition(state))) throw Error();
    let previousAttempt = 0;
    for (const failure of state.failures) {
      if (!sameKeys(failure, ['attempt', 'category', 'code']) || !integer(failure.attempt, state.read_limit) ||
          failure.attempt <= previousAttempt || !code(failure.code) || failure.category !== failureCategory(failure.code)) throw Error();
      previousAttempt = failure.attempt;
    }
    if (op) {
      if (!integer(op.attempts, state.read_limit) || state.recoveries_reserved > op.attempts || previousAttempt > op.attempts ||
          (['running', 'succeeded', 'failed'].includes(op.status) && op.attempts === 0) ||
          (['running', 'succeeded'].includes(op.status) && previousAttempt === op.attempts && previousAttempt !== 0) ||
          (op.recovery_kind !== null && state.recoveries_reserved === 0)) throw Error();
    }
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved search collection journal is invalid.'); }
}

function resultFor(target, state) {
  const last = state.pages.at(-1), records = state.pages.reduce((sum, page) => sum + page.search.items.length, 0);
  return { schema_version: 1, query: target.query, source: 'bounded_search_collection', pages: state.pages,
    records, distinct_products: new Set(state.pages.flatMap(identities)).size, end_reason: endReason(state),
    coverage: { status: 'partial', page_transition_verified: state.transitions.length > 0 && state.transitions.every(transition => transition.confirmed),
      requested_bound_reached: state.pages.length === state.requested_pages, visible_last_page_verified: last.pagination.next_disabled,
      sort_verified: false, filters_verified: false, total_results_known: false },
    limits: { requested_pages: state.requested_pages, cards_per_page: state.cards_per_page },
    action_evidence: { actions_reserved: state.transitions.length, observations_reserved: state.observations,
      transitions: state.transitions.map(transition => ({ from_page: transition.from_page, to_page: transition.to_page,
        action_reserved_at: transition.action_reserved_at, acknowledgement_error: transition.acknowledgement_error,
        checks: transition.checks, verified: transition.confirmed })),
      verification: 'matching_url_and_page_display_with_new_items_and_two_consecutive_matching_observations' },
    missing: [...(state.cards_per_page === 25 || state.pages.some(page => page.search.cards_seen > page.search.cards_scanned) ? ['unscanned_cards'] : []),
      'verified_sort_and_filters', 'verified_payable_prices', 'total_search_results'], login_verified: false };
}

/**
 * Require a completed cached result to agree with every saved snapshot and count.
 * @param {unknown} value Result. @param {object} target @param {object} state
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateSearchCollectionResult(op.result, op.target, op.search_collection);
 */
export function validateSearchCollectionResult(value, target, state) {
  validateSearchCollectionState(state, target);
  if (!endReason(state) || JSON.stringify(value) !== JSON.stringify(resultFor(target, state))) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The search result does not match its completed collection journal.');
  }
}

/**
 * Finish a journal whose last page was saved before the host could publish the result.
 * @param {object} target @param {object} state @returns {object|null} Completed local result, or null if more observations are required.
 * @throws {ShoppingError} INVALID_CHECKPOINT. @example searchCollectionCachedResult(op.target, op.search_collection);
 */
export function searchCollectionCachedResult(target, state) {
  validateSearchCollectionState(state, target);
  return endReason(state) ? resultFor(target, state) : null;
}

/**
 * Derive the exact current and pending next-page identities from saved intent.
 * @param {object} target @param {object} state @returns {object[]} Allowed targets; no arbitrary page jump.
 * @throws {ShoppingError} INVALID_SEARCH for malformed identities.
 * @example searchCollectionTargets(op.target, op.search_collection);
 */
export function searchCollectionTargets(target, state) {
  const pending = pendingTransition(state), current = state.pages.length || 1;
  return (pending ? [pending.from_page, pending.to_page] : [current]).map(page => searchRangeTarget(target.query, page));
}

/**
 * Invalidate only an unfinished consecutive-observation proof after a gate or connection failure.
 * @param {object} state @returns {void} Saved pages, actions, checks and budgets are retained.
 * @example invalidateSearchCollectionCandidate(op.search_collection);
 */
export function invalidateSearchCollectionCandidate(state) {
  const pending = pendingTransition(state);
  if (pending) pending.candidate = null;
}

async function waitForObservation(state, now, wait) {
  const delay = state.not_before - now();
  if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved search observation interval is inconsistent.');
  if (delay > 0) await wait(delay);
}

async function reserveObservation(state, commit, now, wait) {
  if (state.observations >= state.observation_limit) {
    throw new ShoppingError('SEARCH_OBSERVATION_LIMIT', 'The cumulative search observation budget is exhausted.');
  }
  await waitForObservation(state, now, wait);
  state.observations++;
  state.not_before = now() + INTERVAL_MS;
  await commit();
}

function acceptObservation(state, observation, target, allowedPages) {
  if (observation?.state === 'page_transition') return null;
  try {
    if (observation?.state !== 'observed' || !allowedPages.includes(observation.page?.search?.page)) throw Error();
    validateSearchCollectionSnapshot(observation.page, target, observation.page.search.page, state.cards_per_page);
    return observation.page;
  } catch { throw new ShoppingError('INVALID_RESPONSE', 'The adapter returned an invalid search collection page.'); }
}

async function reserveNextPage({ bridge, op, commit, now, wait }) {
  const state = op.search_collection, before = state.pages.at(-1);
  // The action evaluates the cards again, so its guard consumes a content observation as well as one intent.
  if (state.observations >= state.observation_limit) throw new ShoppingError('SEARCH_OBSERVATION_LIMIT', 'No observation remains for a guarded next-page action.');
  await waitForObservation(state, now, wait);
  const transition = { from_page: before.search.page, to_page: before.search.page + 1,
    action_reserved_at: new Date(now()).toISOString(), acknowledgement_error: null, checks: 0, candidate: null, confirmed: false };
  state.transitions.push(transition);
  state.observations++;
  state.not_before = now() + INTERVAL_MS;
  await commit();
  try { await bridge.nextSearchCollectionPage(op.tab_id, op.target, before); }
  catch (error) {
    if (error.code === 'PACING_LIMIT' && error.actionNotDispatched) {
      // The local quota refused the call before any page IO, so this intent never reached the page. Keeping it would
      // leave the resumed task only observing a page that cannot turn; release it so the next run may click once.
      state.transitions.pop(); await commit(); throw error;
    }
    transition.acknowledgement_error = publicError(error).code;
    await commit();
    if (error.actionNotDispatched || ['user', 'rate', 'connection'].includes(failureCategory(transition.acknowledgement_error))) throw error;
  }
  state.not_before = now() + INTERVAL_MS;
  await commit();
}

/**
 * Preserve 1–5 loaded search pages, using one durable action per adjacent transition.
 * @param {{bridge:object,op:object,commit:Function,now:Function,wait:Function}} context
 * @returns {Promise<object>} Partial card coverage, individual source/times and verified adjacent transitions.
 * @throws {ShoppingError} Page gates, invalid responses or exhausted budgets; uncertain actions never repeat.
 * @example await runSearchCollection({ bridge, op, commit, now, wait });
 */
export async function runSearchCollection(context) {
  const { bridge, op, commit, now, wait } = context, state = op.search_collection;
  validateSearchCollectionState(state, op.target, op);
  while (!endReason(state)) {
    if (state.pages.length && !pendingTransition(state)) await reserveNextPage(context);
    const pending = pendingTransition(state);
    if (pending?.checks >= CHECK_LIMIT) {
      throw new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'The adjacent page could not be confirmed. The saved next-page action will not be repeated.');
    }
    await reserveObservation(state, commit, now, wait);
    const allowedPages = searchCollectionTargets(op.target, state).map(target => target.page);
    let observation;
    try { observation = await bridge.readSearchCollectionPage(op.tab_id, op.target, allowedPages, { cardLimit: state.cards_per_page }); }
    catch (error) { invalidateSearchCollectionCandidate(state); throw error; }
    state.not_before = now() + INTERVAL_MS;
    const page = acceptObservation(state, observation, op.target, allowedPages);
    if (!pending) {
      if (!page || page.search.page !== 1) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The initial search page is unconfirmed.');
      state.pages.push(page);
    } else {
      pending.checks++;
      if (page && page.pagination.total_pages_displayed !== state.pages.at(-1).pagination.total_pages_displayed) {
        invalidateSearchCollectionCandidate(state);
        throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The displayed search page count changed during collection. Saved pages were retained.');
      }
      if (!page || page.search.page !== pending.to_page || !hasNewItems(state.pages.at(-1), page)) pending.candidate = null;
      else if (pending.candidate && signature(pending.candidate) === signature(page)) {
        state.pages.push(page); pending.confirmed = true;
      } else pending.candidate = page;
    }
    await commit();
  }
  return resultFor(op.target, state);
}
