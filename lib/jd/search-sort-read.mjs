import { ShoppingError, publicError } from '../errors.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { JD_SEARCH_PAGE_LIMIT } from './search-pages.mjs';
import { jdPriceRangeCheck, jdSortOrderCheck, requirePriceRange, shownPriceRange, validateJdSortedSearch } from './search-sort.mjs';
import { newJdSearchPagesState, pagedParts, runPaging, validateJdSearchPagesState } from './search-pages-read.mjs';
import { jdSearchTarget } from './targets.mjs';

// Version 2 (2026-10-22) adds a price range set before any sort; tasks without one keep version 1 and its result shape.
const SCHEMA_VERSION = 1;
const RANGE_SCHEMA_VERSION = 2;
/**
 * Clicks per requested sort from the default 综合 view (2026-10-21 probe): 销量 once; 价格 once sorts down and a second
 * click sorts up. The direction each 价格 click should give is checked on the cards, never assumed.
 */
const PLANS = Object.freeze({
  sales: [{ label: '销量', active: 'sales', direction: null }],
  'price-desc': [{ label: '价格', active: 'price', direction: 'desc' }],
  'price-asc': [{ label: '价格', active: 'price', direction: 'desc' }, { label: '价格', active: 'price', direction: 'asc' }],
});
export const JD_SORTS = Object.freeze(Object.keys(PLANS));
const MAX_CHECKS = 3;
const MAX_READS = 1 + 2 * MAX_CHECKS;
// The range adds its own checks and two dropdown reads per attempt to open and fill it; one resumed attempt is allowed.
const MAX_RANGE_READS = MAX_READS + MAX_CHECKS + 4;
// The 2026-10-22 probe read the dropdown 4 s after the hover; 确定 had refiltered the cards within 6 s.
const DROPDOWN_SETTLE_MS = 4_000;
// On 2026-10-21 each sort click had replaced the cards within the probe's 6 s wait; checks follow 5 s, then 3 s apart.
const SETTLE_MS = 5_000;
const RECHECK_MS = 3_000;
const CLOCK_LIMIT_MS = 15_000;
const STATE_KEYS = ['not_before', 'paging', 'reads', 'schema_version', 'sort', 'start', 'steps'];
const STEP_KEYS = ['acknowledgement', 'before', 'checks', 'confirmed', 'error', 'label', 'observed'];
const RANGE_KEYS = ['acknowledgement', 'checks', 'confirmed', 'error', 'maximum', 'minimum', 'observed', 'reserved'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const productIds = observation => observation.search.items.map(item => item.product_id).join(',');
const sortStateOf = observation => ({ active_sort: observation.active_sort, price_icon: observation.sort_bar.price.icon });

function journalError() { return new ShoppingError('INVALID_CHECKPOINT', 'The JD search sort journal is invalid.'); }

/**
 * A 价格 direction counts as shown when no neighbouring cards disagree, or when agreeing pairs outnumber disagreeing
 * ones four to one; a few cards out of order are kept in the result rather than stopping the task.
 * @param {object} check jdSortOrderCheck result. @returns {boolean}
 */
export function directionShown(check) {
  return check.status === 'ordered' || (check.status === 'mixed' && check.pairs.in_order >= 4 * check.pairs.against);
}

/** The planned clicks: none when only a price range was asked for. */
const planOf = state => (state.sort === null ? [] : PLANS[state.sort]);

/** The direction this sort's pages must show, or null for 销量 and for no sort. */
function finalDirection(state) { return planOf(state).at(-1)?.direction ?? null; }

/** Whether the page still shows exactly the requested range on its 价格区间 button. */
function rangeShown(range, observation) {
  const shown = shownPriceRange(observation.sort_bar.range);
  return shown !== null && shown[0] === range.minimum && shown[1] === range.maximum;
}

/** Every card's sort price must lie inside the range; one outside means the filter is not what the page applied. */
function requireCardsInRange(range, observation) {
  if (jdPriceRangeCheck(observation.search.items, range.minimum, range.maximum).outside > 0) {
    throw new ShoppingError('SEARCH_PRICE_RANGE_NOT_APPLIED', 'A card on the search page is priced outside the requested range.',
      'Look at the search page; this task does not click again. Start a new task from a freshly opened first page.');
  }
}

function rangeLostError() {
  return new ShoppingError('SEARCH_PRICE_RANGE_LOST', 'The search page no longer shows the requested price range.', 'Look at the search page; start a new task from a freshly opened first page.');
}

/** Paging after the range and the sort: every page must still show both, and with a range every card must lie inside it. */
function sortedPagingSpec(state) {
  const active = planOf(state).at(-1)?.active ?? 'comprehensive';
  const direction = finalDirection(state);
  const range = state.price_range ?? null;
  return {
    minPages: 1,
    validate: (raw, target, observedAt) => validateJdSortedSearch(raw, target, { observedAt }),
    read: (bridge, tabId, target) => bridge.readJdSortedSearch(tabId, target),
    check: observation => {
      if (observation.active_sort !== active) {
        throw new ShoppingError('SEARCH_SORT_LOST', 'The search page no longer shows the requested sort.', 'Look at the search page; start a new task from a freshly opened first page.');
      }
      if (range && !rangeShown(range, observation)) throw rangeLostError();
      if (range) requireCardsInRange(range, observation);
    },
    pageExtras: observation => ({ sort_bar: observation.sort_bar, active_sort: observation.active_sort,
      direction_check: direction ? jdSortOrderCheck(observation.search.items, direction) : null,
      ...(range ? { price_range_check: jdPriceRangeCheck(observation.search.items, range.minimum, range.maximum) } : {}) }),
  };
}

/**
 * @param {string|null} sort sales, price-desc or price-asc; null only with a price range. @param {number} [requestedPages] 1-5.
 * @param {{minimum: number, maximum: number}|null} [priceRange] Whole yuan, set before the sort.
 * @returns {object} A fresh journal: nothing read or clicked. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function newJdSearchSortState(sort, requestedPages = 1, priceRange = null) {
  if (priceRange !== null) requirePriceRange(priceRange?.minimum, priceRange?.maximum);
  if (!(Object.hasOwn(PLANS, sort) || (sort === null && priceRange !== null))) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use --sort ${JD_SORTS.join('|')} or --min-price with --max-price for a JD search.`);
  }
  if (!Number.isSafeInteger(requestedPages) || requestedPages < 1 || requestedPages > JD_SEARCH_PAGE_LIMIT) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use --pages 2-${JD_SEARCH_PAGE_LIMIT} for a JD search.`);
  }
  // The paging journal is the plain paged search's; after the sort it starts by reading page 1 again.
  const paging = requestedPages === 1 ? { ...newJdSearchPagesState(2), requested_pages: 1 } : newJdSearchPagesState(requestedPages);
  if (priceRange === null) return { schema_version: SCHEMA_VERSION, sort, reads: 0, not_before: 0, start: null, steps: [], paging };
  return { schema_version: RANGE_SCHEMA_VERSION, sort, reads: 0, not_before: 0, start: null,
    price_range: { minimum: priceRange.minimum, maximum: priceRange.maximum, reserved: false, acknowledgement: null, error: null, checks: 0, confirmed: false, observed: null },
    steps: [], paging };
}

function savedObservation(saved, target) {
  if (!sameKeys(saved, ['observed_at', 'raw']) || !timestamp(saved.observed_at)) throw journalError();
  return validateJdSortedSearch(saved.raw, target, { observedAt: saved.observed_at });
}

/**
 * Whether one read shows what a sort click should have made: the clicked tag selected, page 1 and other cards than before
 * (a second 价格 click also changes the 价格 icon). A 价格 read must also not show the opposite direction.
 * @returns {'confirmed'|'pending'} @throws {ShoppingError} SEARCH_SORT_MISMATCH or SEARCH_SORT_DIRECTION_MISMATCH.
 */
function judgeStep(step, plan, observation, previous, range) {
  const shown = observation.active_sort;
  if (![null, step.before.active_sort, plan.active].includes(shown)) {
    throw new ShoppingError('SEARCH_SORT_MISMATCH', 'The search page shows a sort this task did not click.', 'Look at the search page; this task does not click again.');
  }
  const changed = productIds(observation) !== productIds(previous) &&
    (step.before.active_sort !== plan.active || observation.sort_bar.price.icon !== step.before.price_icon);
  if (shown !== plan.active || !changed || observation.pager.active_page !== 1) return 'pending';
  if (range && !rangeShown(range, observation)) throw rangeLostError();
  if (plan.direction && jdSortOrderCheck(observation.search.items, plan.direction).status === 'opposite') {
    throw new ShoppingError('SEARCH_SORT_DIRECTION_MISMATCH', `The cards are in the opposite order to ${plan.direction === 'desc' ? '价格 high to low' : '价格 low to high'}.`,
      'Look at the search page; this task does not click again. JD may have changed which way 价格 sorts first.');
  }
  return 'confirmed';
}

/**
 * Whether one read shows what 确定 should have made: the 价格区间 button selected and naming the requested bounds, page 1
 * still in 综合, other cards than before, and every card's sort price inside the range.
 * @returns {'confirmed'|'pending'} @throws {ShoppingError} SEARCH_PRICE_RANGE_MISMATCH, SEARCH_SORT_MISMATCH or SEARCH_PRICE_RANGE_NOT_APPLIED.
 */
function judgeRange(range, observation, previous) {
  if (observation.sort_bar.range.active && !rangeShown(range, observation)) {
    throw new ShoppingError('SEARCH_PRICE_RANGE_MISMATCH', 'The 价格区间 button names another range than this task typed.', 'Look at the search page; this task does not click again.');
  }
  if (observation.active_sort !== 'comprehensive') {
    throw new ShoppingError('SEARCH_SORT_MISMATCH', 'The search page shows a sort this task did not click.', 'Look at the search page; this task does not click again.');
  }
  if (!rangeShown(range, observation) || productIds(observation) === productIds(previous) || observation.pager.active_page !== 1) return 'pending';
  requireCardsInRange(range, observation);
  return 'confirmed';
}

/** Before the second 价格 click the first one must clearly show high to low; otherwise the second click could be wrong. */
function requireShownDirection(plan, observation) {
  if (!directionShown(jdSortOrderCheck(observation.search.items, plan.direction))) {
    throw new ShoppingError('SEARCH_SORT_DIRECTION_UNVERIFIED', 'The cards do not clearly show 价格 high to low after the first click.',
      'Look at the search page; this task does not click 价格 again. Start a new task from a freshly opened first page.');
  }
}

/**
 * Accept a partial journal, including a click reserved but not yet acknowledged.
 * @param {object} state @param {object} target Canonical JD search target.
 * @returns {object[]} The start observation and each confirmed step's observation. @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateJdSearchSortState(state, target) {
  try {
    const ranged = state?.schema_version === RANGE_SCHEMA_VERSION;
    if (!sameKeys(state, ranged ? [...STATE_KEYS, 'price_range'] : STATE_KEYS) || ![SCHEMA_VERSION, RANGE_SCHEMA_VERSION].includes(state.schema_version) ||
        !(Object.hasOwn(PLANS, state.sort) || (ranged && state.sort === null)) ||
        !integer(state.reads, ranged ? MAX_RANGE_READS : MAX_READS) || !integer(state.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(state.steps)) throw new Error();
    const plan = planOf(state);
    const range = ranged ? state.price_range : null;
    if (state.steps.length > plan.length || (state.steps.length && state.start === null)) throw new Error();
    const observations = [];
    if (state.start !== null) {
      const start = savedObservation(state.start, target);
      if (start.pager.active_page !== 1 || start.active_sort !== 'comprehensive' || (ranged && start.sort_bar.range.active)) throw new Error();
      observations.push(start);
    }
    if (ranged) {
      if (!sameKeys(range, RANGE_KEYS) || typeof range.reserved !== 'boolean' || !integer(range.checks, MAX_CHECKS) ||
          ![null, 'clicked', 'uncertain'].includes(range.acknowledgement) || typeof range.confirmed !== 'boolean' ||
          (range.error !== null && !(typeof range.error === 'string' && CODE.test(range.error))) ||
          (range.acknowledgement === 'uncertain') !== (range.error !== null) || (range.acknowledgement === null && range.checks > 0) ||
          (!range.reserved && range.acknowledgement !== null) || (range.reserved && state.start === null) ||
          range.confirmed !== (range.observed !== null) || (range.confirmed && (range.acknowledgement === null || range.checks < 1)) ||
          (!range.confirmed && state.steps.length)) throw new Error();
      requirePriceRange(range.minimum, range.maximum);
      if (range.confirmed) {
        const observation = savedObservation(range.observed, target);
        if (judgeRange(range, observation, observations[0]) !== 'confirmed') throw new Error();
        observations.push(observation);
      }
    }
    state.steps.forEach((step, index) => {
      const previous = observations.at(-1);
      if (!sameKeys(step, STEP_KEYS) || step.label !== plan[index].label || !sameKeys(step.before, ['active_sort', 'price_icon']) ||
          JSON.stringify(step.before) !== JSON.stringify(sortStateOf(previous)) || !integer(step.checks, MAX_CHECKS) ||
          ![null, 'clicked', 'uncertain'].includes(step.acknowledgement) || typeof step.confirmed !== 'boolean' ||
          (step.error !== null && !(typeof step.error === 'string' && CODE.test(step.error))) ||
          (step.acknowledgement === 'uncertain') !== (step.error !== null) || (step.acknowledgement === null && step.checks > 0)) throw new Error();
      if (step.confirmed !== (step.observed !== null) || (step.confirmed && (step.acknowledgement === null || step.checks < 1))) throw new Error();
      if (!step.confirmed) {
        if (index !== state.steps.length - 1) throw new Error();
        return;
      }
      const observation = savedObservation(step.observed, target);
      if (judgeStep(step, plan[index], observation, previous, range) !== 'confirmed') throw new Error();
      if (index < plan.length - 1) requireShownDirection(plan[index], observation);
      observations.push(observation);
    });
    if (state.reads < (state.start ? 1 : 0) + (range?.checks ?? 0) + state.steps.reduce((total, step) => total + step.checks, 0)) throw new Error();
    if (!prepared(state) && (state.paging.reads > 0 || state.paging.pages.length)) throw new Error();
    validateJdSearchPagesState(state.paging, target, sortedPagingSpec(state));
    return observations;
  } catch (error) {
    if (error?.code === 'INVALID_CHECKPOINT') throw error;
    throw journalError();
  }
}

/** The range (if any) and every planned sort click are confirmed, so paging may start. */
function prepared(state) {
  const plan = planOf(state);
  return (state.price_range?.confirmed ?? true) && state.steps.length === plan.length && (plan.length === 0 || state.steps.at(-1).confirmed);
}

/**
 * Build the sorted search result from a finished journal.
 * @param {object} state Finished journal. @param {object} target @returns {object}
 */
export function jdSearchSortResult(state, target) {
  const observations = validateJdSearchSortState(state, target);
  const plan = planOf(state);
  const spec = sortedPagingSpec(state);
  const { pages, first, distinctProducts, crossPageDuplicates } = pagedParts(state.paging, target, spec);
  const direction = finalDirection(state);
  const lastPageReached = state.paging.end === 'last_page';
  const range = state.price_range ?? null;
  // Observations are the start, then the range's (with one), then one per sort click.
  const offset = range ? 2 : 1;
  const rangeResult = range ? { price_range: { minimum: range.minimum, maximum: range.maximum, acknowledgement: range.acknowledgement, error: range.error,
    checks: range.checks, label_text: observations[1].sort_bar.range.text, check: jdPriceRangeCheck(observations[1].search.items, range.minimum, range.maximum) } } : {};
  return {
    schema_version: state.schema_version, platform: 'jd', query: target.query, url: target.url, source: 'jd_search_sort',
    observed_at: pages.at(-1).search.observed_at, login_verified: false, requested_sort: state.sort, ...rangeResult,
    sort: { basis: direction ? 'gray_amount_or_displayed_price' : null, start_observed_at: observations[0].observed_at,
      steps: state.steps.map((step, index) => ({ label: step.label, acknowledgement: step.acknowledgement, error: step.error, checks: step.checks,
        active_after: observations[index + offset].active_sort, price_icon_before: step.before.price_icon, price_icon_after: observations[index + offset].sort_bar.price.icon,
        direction_check: plan[index].direction ? jdSortOrderCheck(observations[index + offset].search.items, plan[index].direction) : null })) },
    requested_pages: state.paging.requested_pages, pages_read: pages.length, end_reason: state.paging.end,
    total_pages_text: first.pager.total_text, total_pages: first.pager.total_pages,
    distinct_products: distinctProducts, cross_page_duplicates_omitted: crossPageDuplicates,
    pages,
    coverage: { status: 'partial', scope: 'first_screen_loaded_cards_per_page', url_reflects_sort: false, url_reflects_page: false,
      sort_verified: plan.length ? true : null, sort_direction_verified: direction ? pages.every(page => directionShown(page.direction_check)) : null,
      ...(range ? { price_range_verified: true } : {}),
      page_transition_verified: true, filters_verified: false, all_listed_pages_read: lastPageReached, in_stock_only: first.search.coverage.in_stock_only },
    missing: ['cards_below_first_screen', ...(lastPageReached ? [] : ['subsequent_pages']), 'verified_filters', 'verified_payable_prices',
      ...(state.sort === 'sales' ? ['sales_ranking_basis'] : [])],
  };
}

/**
 * @param {object} result Saved result. @param {object} target @param {object} state Saved journal.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validateJdSearchSortResult(result, target, state) {
  try {
    validateJdSearchSortState(state, target);
    if (state.paging.end === null || JSON.stringify(jdSearchSortResult(state, target)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The JD search sort result does not match its journal.'); }
}

function rangeNotChangedError() {
  return new ShoppingError('SEARCH_PRICE_RANGE_NOT_CHANGED', 'The search page did not show the price range after one 确定 click.',
    'Look at the search page; this task does not click again. Start a new task from a freshly opened first page.');
}

function rangeUnavailableError(message) {
  return new ShoppingError('SEARCH_PRICE_RANGE_UNAVAILABLE', message, 'Look at the search page; start a new task from a freshly opened first page.');
}

function notChangedError() {
  return new ShoppingError('SEARCH_SORT_NOT_CHANGED', 'The search page did not show the clicked sort after one click.',
    'Look at the search page; this task does not click again. Start a new task from a freshly opened first page.');
}

/**
 * From page 1 in the default 综合 view, optionally set a price range first (open 价格区间, type both bounds, click 确定
 * once and confirm it on the button and the cards), then click 销量 or 价格 once per planned step and confirm each click on
 * the sort bar, the cards and, for 价格, their order; then read the requested pages as the paged search does. A click is
 * recorded before it is sent and is never repeated.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Sorted search result.
 * @throws {ShoppingError} Page gates, SEARCH_NOT_FIRST_PAGE, SEARCH_SORT_NOT_DEFAULT, SEARCH_SORT_STATE_CHANGED, SEARCH_SORT_MISMATCH,
 *   SEARCH_SORT_NOT_CHANGED, SEARCH_SORT_DIRECTION_MISMATCH, SEARCH_SORT_DIRECTION_UNVERIFIED, SEARCH_SORT_LOST, the SEARCH_PRICE_RANGE_*
 *   errors, the paging errors or an exhausted read budget.
 */
export async function runJdSearchSortRead({ bridge, op, commit, now, wait }) {
  const state = op.search_sort_read;
  const target = jdSearchTarget(op.target?.query);
  if (JSON.stringify(target) !== JSON.stringify(op.target)) throw new ShoppingError('INVALID_CHECKPOINT', 'The JD search target is invalid.');
  const observations = validateJdSearchSortState(state, target);
  const plan = planOf(state);
  const range = state.price_range ?? null;
  const maxReads = range ? MAX_RANGE_READS : MAX_READS;
  const pending = () => state.steps.at(-1)?.confirmed === false ? state.steps.at(-1) : null;
  if (range?.reserved && range.acknowledgement === null) {
    Object.assign(range, { acknowledgement: 'uncertain', error: 'READ_INTERRUPTED' });
    state.not_before = now() + SETTLE_MS;
    await commit();
  }
  // A killed process can leave a click reserved without its acknowledgement. It may have happened, so it is spent.
  if (pending()?.acknowledgement === null) {
    Object.assign(pending(), { acknowledgement: 'uncertain', error: 'READ_INTERRUPTED' });
    state.not_before = now() + SETTLE_MS;
    await commit();
  }
  const read = async () => {
    if (state.reads >= maxReads) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The JD search sort read budget is exhausted.');
    state.reads += 1;
    await commit();
    const saved = await bridge.readJdSortedSearch(op.tab_id, target);
    return { saved: { observed_at: saved.observed_at, raw: saved.raw }, observation: validateJdSortedSearch(saved.raw, target, { observedAt: saved.observed_at }) };
  };
  const readPanel = async () => {
    if (state.reads >= maxReads) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The JD search sort read budget is exhausted.');
    state.reads += 1;
    await commit();
    return bridge.readJdPriceRangePanel(op.tab_id, target);
  };
  // Typing is local to the page, so it is not journaled: a rerun finds the inputs empty, already holding the bounds, or
  // holding something else, which stops the task.
  const fillRange = async () => {
    const wanted = [String(range.minimum), String(range.maximum)];
    const holds = panel => panel.open === 1 && panel.inputs.length === 2 && panel.inputs[0].value === wanted[0] && panel.inputs[1].value === wanted[1];
    await bridge.hoverJdPriceRange(op.tab_id, target);
    await wait(DROPDOWN_SETTLE_MS);
    const opened = await readPanel();
    if (opened.open !== 1) throw rangeUnavailableError('The 价格区间 dropdown did not open.');
    if (holds(opened)) return;
    await bridge.fillJdPriceRange(op.tab_id, target, range.minimum, range.maximum);
    if (!holds(await readPanel())) {
      throw new ShoppingError('SEARCH_PRICE_RANGE_NOT_FILLED', 'The price range inputs do not hold the requested bounds after typing; 确定 was not clicked.',
        'Look at the search page; start a new task from a freshly opened first page.');
    }
  };

  while (!prepared(state)) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The JD search sort wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (!state.start) {
      const { saved, observation } = await read();
      if (observation.pager.active_page !== 1) {
        throw new ShoppingError('SEARCH_NOT_FIRST_PAGE', 'The search tab is not on page 1.', 'Open the search again with page-open and start a new task on that tab.');
      }
      if (observation.active_sort !== 'comprehensive') {
        throw new ShoppingError('SEARCH_SORT_NOT_DEFAULT', 'The search tab does not show the default 综合 sort.', 'Open the search again with page-open and start a new task on that tab.');
      }
      if (range && observation.sort_bar.range.active) {
        throw new ShoppingError('SEARCH_SORT_NOT_DEFAULT', 'The search tab already shows a price range.', 'Open the search again with page-open and start a new task on that tab.');
      }
      state.start = saved;
      observations.push(observation);
      op.recovery_kind = null;
      await commit(); continue;
    }
    if (range && !range.confirmed) {
      if (!range.reserved) {
        await fillRange();
        range.reserved = true;
        await commit();
        try {
          await bridge.confirmJdPriceRange(op.tab_id, target, range.minimum, range.maximum);
          range.acknowledgement = 'clicked';
        } catch (error) {
          if (error.actionNotDispatched) {
            range.reserved = false;
            await commit();
            throw error;
          }
          Object.assign(range, { acknowledgement: 'uncertain', error: publicError(error).code });
        }
        op.recovery_kind = null;
        state.not_before = now() + SETTLE_MS;
        await commit(); continue;
      }
      if (range.checks >= MAX_CHECKS) throw rangeNotChangedError();
      const next = await read();
      range.checks += 1;
      let verdict;
      try { verdict = judgeRange(range, next.observation, observations[0]); }
      catch (error) { await commit(); throw error; }
      if (verdict === 'confirmed') {
        Object.assign(range, { confirmed: true, observed: next.saved });
        observations.push(next.observation);
        op.recovery_kind = null;
        await commit(); continue;
      }
      if (range.checks >= MAX_CHECKS) { await commit(); throw rangeNotChangedError(); }
      state.not_before = now() + RECHECK_MS;
      await commit(); continue;
    }
    const step = pending();
    if (!step) {
      const index = state.steps.length;
      const before = sortStateOf(observations.at(-1));
      state.steps.push({ label: plan[index].label, before, acknowledgement: null, error: null, checks: 0, confirmed: false, observed: null });
      await commit();
      try {
        await bridge.clickJdSortTag(op.tab_id, target, plan[index].label, before);
        state.steps.at(-1).acknowledgement = 'clicked';
      } catch (error) {
        if (error.actionNotDispatched) {
          // Nothing was clicked: the reservation is released and the refusal stops the task.
          state.steps.pop();
          await commit();
          throw error;
        }
        Object.assign(state.steps.at(-1), { acknowledgement: 'uncertain', error: publicError(error).code });
      }
      op.recovery_kind = null;
      state.not_before = now() + SETTLE_MS;
      await commit(); continue;
    }
    if (step.checks >= MAX_CHECKS) throw notChangedError();
    const index = state.steps.length - 1;
    // Only a completed read counts as a check: a login or limit page met here pauses the task without using one up.
    const next = await read();
    step.checks += 1;
    let verdict;
    try { verdict = judgeStep(step, plan[index], next.observation, observations.at(-1), range); }
    catch (error) { await commit(); throw error; }
    if (verdict === 'confirmed') {
      if (index < plan.length - 1) {
        try { requireShownDirection(plan[index], next.observation); }
        catch (error) { await commit(); throw error; }
      }
      Object.assign(step, { confirmed: true, observed: next.saved });
      observations.push(next.observation);
      op.recovery_kind = null;
      await commit(); continue;
    }
    if (step.checks >= MAX_CHECKS) { await commit(); throw notChangedError(); }
    state.not_before = now() + RECHECK_MS;
    await commit();
  }
  await runPaging({ bridge, op, state: state.paging, target, commit, now, wait, spec: sortedPagingSpec(state) });
  return jdSearchSortResult(state, target);
}
