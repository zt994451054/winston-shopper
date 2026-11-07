import { ShoppingError, publicError } from '../errors.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { JD_SEARCH_PAGE_LIMIT, validateJdSearchPage } from './search-pages.mjs';
import { jdSearchTarget } from './targets.mjs';

const SCHEMA_VERSION = 1;
// Checks of the pager after one 下一页 click; a check that does not show the next page is repeated, the click never is.
const MAX_CHECKS = 3;
const MAX_READS = 1 + (JD_SEARCH_PAGE_LIMIT - 1) * MAX_CHECKS;
// On 2026-10-21 page 2 had replaced the cards within the probe's 6 s wait; checks follow 5 s, then 3 s apart.
const SETTLE_MS = 5_000;
const RECHECK_MS = 3_000;
const CLOCK_LIMIT_MS = 15_000;
const STATE_KEYS = ['end', 'not_before', 'pages', 'reads', 'requested_pages', 'schema_version', 'transitions'];
const TRANSITION_KEYS = ['acknowledgement', 'checks', 'confirmed', 'error', 'from_page'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const productIds = page => page.search.items.map(item => item.product_id).join(',');

function journalError() { return new ShoppingError('INVALID_CHECKPOINT', 'The JD search pages journal is invalid.'); }

/**
 * @param {number} requestedPages 2-5.
 * @returns {object} A fresh journal: nothing read or clicked. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function newJdSearchPagesState(requestedPages) {
  if (!Number.isSafeInteger(requestedPages) || requestedPages < 2 || requestedPages > JD_SEARCH_PAGE_LIMIT) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use --pages 2-${JD_SEARCH_PAGE_LIMIT} for a JD search.`);
  }
  return { schema_version: SCHEMA_VERSION, requested_pages: requestedPages, reads: 0, pages: [], transitions: [], end: null, not_before: 0 };
}

/**
 * What one kind of paged read reads and accepts. The plain paged search reads the pager and cards; a sorted one also reads
 * the sort bar and requires its sort on every page.
 * @typedef {{minPages: number, validate: Function, read: Function, check: Function, pageExtras: Function}} PagingSpec
 */
export const SEARCH_PAGES_SPEC = Object.freeze({
  minPages: 2,
  validate: (raw, target, observedAt) => validateJdSearchPage(raw, target, { observedAt }),
  read: (bridge, tabId, target) => bridge.readJdSearchPage(tabId, target),
  check: () => {},
  pageExtras: () => ({}),
});

/** Validate each saved page against the page before it: page k shows pager page k and other cards than page k-1. */
function confirmedPages(state, target, spec) {
  return state.pages.map((page, index) => {
    if (!sameKeys(page, ['observed_at', 'raw']) || !timestamp(page.observed_at)) throw journalError();
    const observation = spec.validate(page.raw, target, page.observed_at);
    if (observation.pager.active_page !== index + 1) throw journalError();
    spec.check(observation);
    return observation;
  });
}

/**
 * Accept a partial journal, including a click reserved but not yet acknowledged.
 * @param {object} state @param {object} target Canonical JD search target.
 * @returns {object[]} The confirmed page observations. @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateJdSearchPagesState(state, target, spec = SEARCH_PAGES_SPEC) {
  try {
    if (!sameKeys(state, STATE_KEYS) || state.schema_version !== SCHEMA_VERSION || !Number.isSafeInteger(state.requested_pages) ||
        state.requested_pages < spec.minPages || state.requested_pages > JD_SEARCH_PAGE_LIMIT || !integer(state.reads, MAX_READS) ||
        !integer(state.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(state.pages) || state.pages.length > state.requested_pages ||
        !Array.isArray(state.transitions) || ![null, 'requested_pages_read', 'last_page'].includes(state.end) || state.reads < state.pages.length) throw new Error();
    const observations = confirmedPages(state, target, spec);
    for (let index = 1; index < observations.length; index += 1) if (productIds(observations[index]) === productIds(observations[index - 1])) throw new Error();
    // One transition per page after the first, plus at most one still waiting for its page.
    const pending = state.transitions.length - Math.max(state.pages.length - 1, 0);
    if (![0, 1].includes(pending) || (pending === 1 && state.pages.length === 0)) throw new Error();
    state.transitions.forEach((transition, index) => {
      if (!sameKeys(transition, TRANSITION_KEYS) || transition.from_page !== index + 1 || !integer(transition.checks, MAX_CHECKS) ||
          ![null, 'clicked', 'uncertain'].includes(transition.acknowledgement) || typeof transition.confirmed !== 'boolean' ||
          (transition.error !== null && !(typeof transition.error === 'string' && CODE.test(transition.error))) ||
          (transition.acknowledgement === 'uncertain') !== (transition.error !== null)) throw new Error();
      const confirmed = index < state.pages.length - 1;
      if (transition.confirmed !== confirmed || (confirmed && (transition.acknowledgement === null || transition.checks < 1))) throw new Error();
      if (transition.acknowledgement === null && transition.checks > 0) throw new Error();
    });
    // Every check is a completed read, and so is page 1.
    if (state.reads < Math.min(state.pages.length, 1) + state.transitions.reduce((total, transition) => total + transition.checks, 0)) throw new Error();
    if (state.end === 'requested_pages_read' && (state.pages.length !== state.requested_pages || pending)) throw new Error();
    if (state.end === 'last_page' && (pending || !state.pages.length)) throw new Error();
    if (state.end === null && state.pages.length === state.requested_pages) throw new Error();
    return observations;
  } catch (error) {
    if (error?.code === 'INVALID_CHECKPOINT') throw error;
    throw journalError();
  }
}

/**
 * The pages of a finished journal, each with the products already listed on earlier pages left out and counted.
 * @param {object} state Finished paging journal. @param {object} target @param {PagingSpec} spec
 * @returns {{pages: object[], first: object, distinctProducts: number, crossPageDuplicates: number}}
 */
export function pagedParts(state, target, spec) {
  const observations = confirmedPages(state, target, spec);
  const seen = new Set();
  const pages = observations.map((observation, index) => {
    const items = observation.search.items.filter(item => !seen.has(item.product_id));
    for (const item of items) seen.add(item.product_id);
    const reached = index ? state.transitions[index - 1] : null;
    return { page: index + 1, ...spec.pageExtras(observation), pager: observation.pager,
      transition: reached && { from_page: reached.from_page, acknowledgement: reached.acknowledgement, error: reached.error, checks: reached.checks },
      // The page's own read: its cards with earlier pages' products left out; paging is described once, on the whole result.
      search: { ...observation.search, page: index + 1, items, cross_page_duplicates_omitted: observation.search.items.length - items.length,
        missing: observation.search.missing.filter(name => name !== 'subsequent_pages') } };
  });
  return { pages, first: observations[0], distinctProducts: seen.size,
    crossPageDuplicates: pages.reduce((total, page) => total + page.search.cross_page_duplicates_omitted, 0) };
}

/**
 * Build the paged search result from a finished journal. A product seen on an earlier page is omitted from later pages
 * and counted there.
 * @param {object} state Finished journal. @param {object} target @returns {object}
 */
export function jdSearchPagesResult(state, target) {
  const { pages, first, distinctProducts, crossPageDuplicates } = pagedParts(state, target, SEARCH_PAGES_SPEC);
  const lastPageReached = state.end === 'last_page';
  return {
    schema_version: SCHEMA_VERSION, platform: 'jd', query: target.query, url: target.url, source: 'jd_search_pages',
    observed_at: pages.at(-1).search.observed_at, login_verified: false, requested_pages: state.requested_pages, pages_read: pages.length,
    end_reason: state.end, total_pages_text: first.pager.total_text, total_pages: first.pager.total_pages,
    distinct_products: distinctProducts, cross_page_duplicates_omitted: crossPageDuplicates,
    pages,
    coverage: { status: 'partial', scope: 'first_screen_loaded_cards_per_page', url_reflects_page: false, page_transition_verified: true,
      sort_verified: false, filters_verified: false, all_listed_pages_read: lastPageReached, in_stock_only: first.search.coverage.in_stock_only },
    missing: ['cards_below_first_screen', ...(lastPageReached ? [] : ['subsequent_pages']), 'verified_sort_and_filters', 'verified_payable_prices'],
  };
}

/**
 * @param {object} result Saved result. @param {object} target @param {object} state Saved journal.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validateJdSearchPagesResult(result, target, state) {
  try {
    validateJdSearchPagesState(state, target);
    if (state.end === null || JSON.stringify(jdSearchPagesResult(state, target)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The JD search pages result does not match its journal.'); }
}

function notChangedError() {
  return new ShoppingError('SEARCH_PAGE_NOT_CHANGED', 'The search page did not move to the next page after one 下一页 click.',
    'Look at the search page; this task does not click again. Start a new task from a freshly opened first page.');
}

/**
 * Read the first screen of page 1, then for each further page click 下一页 once and read the page after its pager shows
 * the next number and its cards changed. A click is recorded before it is sent and is never repeated.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Paged search result.
 * @throws {ShoppingError} Page gates, SEARCH_NOT_FIRST_PAGE, SEARCH_PAGE_MISMATCH, SEARCH_PAGE_NOT_CHANGED or an exhausted read budget.
 */
export async function runJdSearchPagesRead({ bridge, op, commit, now, wait }) {
  const target = jdSearchTarget(op.target?.query);
  if (JSON.stringify(target) !== JSON.stringify(op.target)) throw new ShoppingError('INVALID_CHECKPOINT', 'The JD search target is invalid.');
  await runPaging({ bridge, op, state: op.search_pages_read, target, commit, now, wait, spec: SEARCH_PAGES_SPEC });
  return jdSearchPagesResult(op.search_pages_read, target);
}

/**
 * The paging steps shared by the plain and the sorted paged search: read page 1, then per further page click 下一页 once
 * and read it after its pager and cards changed. Ends with state.end set; the caller builds its own result.
 * @param {{bridge: object, op: object, state: object, target: object, commit: Function, now: Function, wait: Function, spec: PagingSpec}} context
 * @returns {Promise<void>}
 * @throws {ShoppingError} Page gates, the spec's own check, SEARCH_NOT_FIRST_PAGE, SEARCH_PAGE_MISMATCH, SEARCH_PAGE_NOT_CHANGED or an exhausted read budget.
 */
export async function runPaging({ bridge, op, state, target, commit, now, wait, spec }) {
  const observations = validateJdSearchPagesState(state, target, spec);
  const pending = () => state.transitions.at(-1)?.confirmed === false ? state.transitions.at(-1) : null;
  // A killed process can leave a click reserved without its acknowledgement. It may have happened, so it is spent.
  if (pending()?.acknowledgement === null) {
    Object.assign(pending(), { acknowledgement: 'uncertain', error: 'READ_INTERRUPTED' });
    state.not_before = now() + SETTLE_MS;
    await commit();
  }
  const read = async () => {
    if (state.reads >= MAX_READS) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The JD search pages read budget is exhausted.');
    state.reads += 1;
    await commit();
    const { observed_at: observedAt, raw } = await spec.read(bridge, op.tab_id, target);
    const observation = spec.validate(raw, target, observedAt);
    spec.check(observation);
    return { saved: { observed_at: observedAt, raw }, observation };
  };
  const accept = async ({ saved, observation }) => {
    state.pages.push(saved);
    observations.push(observation);
    if (state.pages.length === state.requested_pages) state.end = 'requested_pages_read';
    else if (observation.pager.next === 'disabled') state.end = 'last_page';
    op.recovery_kind = null;
    await commit();
  };

  while (state.end === null) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The JD search pages wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (!state.pages.length) {
      const first = await read();
      if (first.observation.pager.active_page !== 1) {
        throw new ShoppingError('SEARCH_NOT_FIRST_PAGE', 'The search tab is not on page 1.', 'Open the search again with page-open and start a new task on that tab.');
      }
      await accept(first); continue;
    }
    const transition = pending();
    if (!transition) {
      const fromPage = state.pages.length;
      state.transitions.push({ from_page: fromPage, acknowledgement: null, error: null, checks: 0, confirmed: false });
      await commit();
      try {
        await bridge.clickJdNextPage(op.tab_id, target, fromPage);
        Object.assign(state.transitions.at(-1), { acknowledgement: 'clicked' });
      } catch (error) {
        if (error.actionNotDispatched) {
          // Nothing was clicked: the reservation is released. A disabled 下一页 ends the read with the pages already read.
          state.transitions.pop();
          if (error.lastPage) state.end = 'last_page';
          await commit();
          if (error.lastPage) continue;
          throw error;
        }
        Object.assign(state.transitions.at(-1), { acknowledgement: 'uncertain', error: publicError(error).code });
      }
      op.recovery_kind = null;
      state.not_before = now() + SETTLE_MS;
      await commit(); continue;
    }
    if (transition.checks >= MAX_CHECKS) throw notChangedError();
    // Only a completed read counts as a check: a login or limit page met here pauses the task without using one up.
    const next = await read();
    transition.checks += 1;
    const shown = next.observation.pager.active_page;
    const changed = productIds(next.observation) !== productIds(observations.at(-1));
    if (shown === transition.from_page + 1 && changed) {
      transition.confirmed = true;
      await accept(next); continue;
    }
    // Still the old page, or a pager without one clear current number, may be mid-update; any other number is not this click's page.
    if (![null, transition.from_page, transition.from_page + 1].includes(shown)) {
      await commit();
      throw new ShoppingError('SEARCH_PAGE_MISMATCH', 'The search pager shows a page this task did not move to.', 'Look at the search page; this task does not click again.');
    }
    if (transition.checks >= MAX_CHECKS) { await commit(); throw notChangedError(); }
    state.not_before = now() + RECHECK_MS;
    await commit();
  }
}
