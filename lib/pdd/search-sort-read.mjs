import { ShoppingError, publicError } from '../errors.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { validateSavedPddSearch } from './search.mjs';
import { PDD_SORTS, pddPriceRangeCheck, pddSortOrderCheck, requirePddPriceRange } from './search-sort.mjs';

// Format 2 (2026-10-28) adds the price range as actions before the sort clicks; format 1 journals hold sort clicks only.
const SCHEMA_VERSION = 2;
// On 2026-10-27/28 each sort click and the range 确认 re-sorted the loaded cards and rewrote the address within 8 s;
// the 筛选 panel opened, and the fill showed in its inputs, within 3 s.
const SETTLE_MS = { open_filter: 4_000, fill: 3_000, confirm: 8_000, sort: 8_000 };
const RECHECK_MS = 4_000;
const MAX_CHECKS = 3;
const MAX_READS = 2;
const REREAD_MS = 10_000;
const CLOCK_LIMIT_MS = 15_000;
const UNFINISHED_PAGE = new Set(['PAGE_STRUCTURE_CHANGED', 'PAGE_LOADING']);
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const V1_STATE_KEYS = ['schema_version', 'sort', 'clicks', 'reads', 'page', 'not_before'];
const V1_CLICK_KEYS = ['label', 'from', 'to', 'reserved', 'outcome', 'error', 'checks', 'confirmed'];
const STATE_KEYS = ['schema_version', 'sort', 'range', 'actions', 'reads', 'page', 'not_before'];
const ACTION_KEYS = ['kind', 'label', 'from', 'to', 'reserved', 'outcome', 'error', 'checks', 'confirmed'];

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const v1SortState = value => sameKeys(value, ['sort_type', 'selected']) && (value.sort_type === null || typeof value.sort_type === 'string') &&
  Array.isArray(value.selected) && value.selected.length <= 5 && value.selected.every(text => typeof text === 'string');
const sortState = value => sameKeys(value, ['sort_type', 'selected', 'price_range', 'panel']) && v1SortState({ sort_type: value.sort_type, selected: value.selected }) &&
  (value.price_range === null || typeof value.price_range === 'string') && sameKeys(value.panel, ['open', 'minimum', 'maximum']) && typeof value.panel.open === 'boolean';
const rangeText = range => range ? `${range.minimum},${range.maximum}` : null;
const directionOf = sort => ({ 'price-asc': 'asc', 'price-desc': 'desc' })[sort] ?? null;

/** The planned actions: open 筛选, fill, 确认 when a range is asked, then the sort clicks. */
function plannedActions(sort, range) {
  const blank = { reserved: false, outcome: null, error: null, checks: 0, confirmed: false };
  const rangeSteps = range ? ['open_filter', 'fill', 'confirm'].map(kind => ({ kind, label: null, from: null, to: null, ...blank })) : [];
  return [...rangeSteps, ...(sort ? PDD_SORTS[sort] : []).map(step => ({ kind: 'sort', ...step, ...blank }))];
}

/**
 * @param {'sales'|'price-asc'|'price-desc'|null} sort @param {{minimum: number, maximum: number}|null} range Whole yuan.
 * @returns {object} A fresh journal: nothing clicked, typed or read. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function newPddSortReadState(sort, range = null) {
  if (sort !== null && !Object.hasOwn(PDD_SORTS, sort)) throw new ShoppingError('INVALID_ARGUMENTS', 'Use --sort sales, price-asc or price-desc.');
  if (range) requirePddPriceRange(range.minimum, range.maximum);
  if (sort === null && !range) throw new ShoppingError('INVALID_ARGUMENTS', 'A PDD sort task needs --sort, a price range, or both.');
  const kept = range ? { minimum: range.minimum, maximum: range.maximum } : null;
  return { schema_version: SCHEMA_VERSION, sort, range: kept, actions: plannedActions(sort, kept), reads: 0, page: null, not_before: 0 };
}

function validateActions(actions, planned) {
  if (!Array.isArray(actions) || actions.length !== planned.length) throw new Error();
  actions.forEach((action, index) => {
    const step = planned[index];
    if (!sameKeys(action, ACTION_KEYS) || ['kind', 'label', 'from', 'to'].some(key => action[key] !== step[key]) || typeof action.reserved !== 'boolean' ||
        ![null, 'clicked', 'uncertain'].includes(action.outcome) || typeof action.confirmed !== 'boolean' || (action.outcome === 'uncertain') !== (action.error !== null) ||
        (action.error !== null && !CODE.test(action.error)) || !integer(action.checks, MAX_CHECKS)) throw new Error();
    // Each action waits for the one before it to be confirmed on the page.
    if (!action.reserved && (action.outcome !== null || action.checks > 0 || action.confirmed)) throw new Error();
    if (action.confirmed && action.outcome === null) throw new Error();
    if (action.reserved && index > 0 && !actions[index - 1].confirmed) throw new Error();
  });
}

/**
 * Accept a partial journal, including an action reserved but not yet acknowledged. Format 1 journals, saved on 2026-10-28
 * before the range, are accepted as saved.
 * @param {object} state @param {object} target Canonical search target. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validatePddSortReadState(state, target) {
  try {
    const v1 = state?.schema_version === 1;
    if (v1) {
      if (!sameKeys(state, V1_STATE_KEYS) || !Object.hasOwn(PDD_SORTS, state.sort) || !Array.isArray(state.clicks) ||
          state.clicks.some(click => !sameKeys(click, V1_CLICK_KEYS))) throw new Error();
      validateActions(state.clicks.map(click => ({ kind: 'sort', ...click })), plannedActions(state.sort, null));
    } else {
      if (!sameKeys(state, STATE_KEYS) || state.schema_version !== SCHEMA_VERSION || (state.sort !== null && !Object.hasOwn(PDD_SORTS, state.sort)) ||
          (state.range !== null && !sameKeys(state.range, ['minimum', 'maximum'])) || (state.sort === null && state.range === null)) throw new Error();
      if (state.range) requirePddPriceRange(state.range.minimum, state.range.maximum);
      validateActions(state.actions, plannedActions(state.sort, state.range));
    }
    const steps = v1 ? state.clicks : state.actions;
    if (!integer(state.reads, MAX_READS) || !integer(state.not_before, Number.MAX_SAFE_INTEGER)) throw new Error();
    if (state.reads > 0 && !steps.every(step => step.confirmed)) throw new Error();
    if (state.page !== null) {
      if (!sameKeys(state.page, ['observed_at', 'sort_state', 'search']) || !timestamp(state.page.observed_at) || state.reads < 1 ||
          !(v1 ? v1SortState : sortState)(state.page.sort_state) || state.page.search.observed_at !== state.page.observed_at) throw new Error();
      validateSavedPddSearch(state.page.search, target);
    }
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD sort read journal is invalid.'); }
}

/** The bar items that mark a sort: with a range, 筛选 is also red (2026-10-28) and belongs to the range. */
const sortItems = (shown, range) => range ? shown.selected.filter(text => text !== '筛选') : shown.selected;
const showsSort = (shown, step, range) => shown.sort_type === step.to && sortItems(shown, range).length === 1 && sortItems(shown, range)[0] === step.label &&
  (shown.price_range ?? null) === rangeText(range);

/** Whether the page shows what one action should have done. */
function actionShown(action, shown, range) {
  if (action.kind === 'open_filter') return shown.panel.open;
  if (action.kind === 'fill') return shown.panel.open && shown.panel.minimum === String(range.minimum) && shown.panel.maximum === String(range.maximum);
  if (action.kind === 'confirm') return shown.price_range === rangeText(range) && !shown.panel.open && shown.selected.includes('筛选');
  return showsSort(shown, action, range);
}

function v1Result(state) {
  const final = state.clicks.at(-1);
  const { search, sort_state: shown } = state.page;
  const direction = directionOf(state.sort);
  const orderCheck = direction ? pddSortOrderCheck(search.items, direction) : null;
  const uiVerified = shown.sort_type === final.to && shown.selected.length === 1 && shown.selected[0] === final.label;
  const directionVerified = direction === null ? null : orderCheck.status === 'ordered';
  return {
    schema_version: 1, platform: 'pdd', source: 'pdd_sorted_search_cards', query: search.query, observed_at: state.page.observed_at,
    sort: state.sort, sort_type: shown.sort_type, selected: shown.selected,
    clicks: state.clicks.map(click => ({ label: click.label, from: click.from, to: click.to, outcome: click.outcome, error: click.error, checks: click.checks })),
    order_check: orderCheck, search,
    coverage: { status: 'partial', scope: 'loaded_search_cards', sort_ui_verified: uiVerified, url_reflects_sort: shown.sort_type === final.to,
      sort_direction_verified: directionVerified, price_range_verified: false, scrolled: false },
    missing: ['product_ids', 'full_titles', 'cards_not_loaded', 'verified_payable_prices', ...(directionVerified === false ? ['sort_direction'] : [])],
  };
}

/** @param {object} state Finished journal. @returns {object} The sorted or ranged search result. */
export function pddSortResult(state) {
  if (state.schema_version === 1) return v1Result(state);
  const { search, sort_state: shown } = state.page;
  const direction = directionOf(state.sort);
  const orderCheck = direction ? pddSortOrderCheck(search.items, direction) : null;
  const finalSort = state.actions.filter(action => action.kind === 'sort').at(-1) ?? null;
  const rangeCheck = state.range ? pddPriceRangeCheck(search.items, state.range.minimum, state.range.maximum) : null;
  const directionVerified = direction === null ? null : orderCheck.status === 'ordered';
  const rangeVerified = state.range === null ? null : shown.price_range === rangeText(state.range) && shown.selected.includes('筛选') &&
    rangeCheck.cards_checked > 0 && rangeCheck.outside === 0;
  return {
    schema_version: 2, platform: 'pdd', source: 'pdd_sorted_search_cards', query: search.query, observed_at: state.page.observed_at,
    sort: state.sort, price_range: state.range, sort_type: shown.sort_type, address_price_range: shown.price_range, selected: shown.selected,
    actions: state.actions.map(action => ({ kind: action.kind, label: action.label, to: action.to, outcome: action.outcome, error: action.error, checks: action.checks })),
    order_check: orderCheck, range_check: rangeCheck, search,
    coverage: { status: 'partial', scope: 'loaded_search_cards', sort_ui_verified: finalSort ? showsSort(shown, finalSort, state.range) : null,
      url_reflects_sort: finalSort ? shown.sort_type === finalSort.to : null, sort_direction_verified: directionVerified, price_range_verified: rangeVerified, scrolled: false },
    missing: ['product_ids', 'full_titles', 'cards_not_loaded', 'verified_payable_prices', ...(directionVerified === false ? ['sort_direction'] : []),
      ...(rangeVerified === false ? ['price_range'] : [])],
  };
}

/**
 * @param {object} result Saved result. @param {object} state Saved journal. @param {object} target
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validatePddSortResult(result, state, target) {
  try {
    validatePddSortReadState(state, target);
    if (state.page === null || JSON.stringify(pddSortResult(state)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD sort result does not match its journal.'); }
}

function notShownError(action, range) {
  const what = { open_filter: 'the 筛选 panel open', fill: `${range?.minimum} and ${range?.maximum} in the range inputs`,
    confirm: `price=${rangeText(range)} in the address with the panel closed` }[action.kind] ?? `${action.label} as sort_type ${action.to}`;
  return new ShoppingError(action.kind === 'sort' ? 'SEARCH_SORT_NOT_APPLIED' : 'SEARCH_PRICE_RANGE_NOT_APPLIED', `The page did not show ${what} after the action.`,
    'Look at the tab; this task does not repeat the action. Open a new search page to try once more.');
}

/** Send one action through the bridge. */
function send(bridge, op, state, action) {
  const { range } = state;
  if (action.kind === 'open_filter') return bridge.openPddFilter(op.tab_id, op.target);
  if (action.kind === 'fill') return bridge.fillPddPriceRange(op.tab_id, op.target, range.minimum, range.maximum);
  if (action.kind === 'confirm') return bridge.confirmPddPriceRange(op.tab_id, op.target, range.minimum, range.maximum);
  return bridge.clickPddSort(op.tab_id, op.target, { label: action.label, from: action.from, range: rangeText(range) });
}

/**
 * On a fresh PDD search page, set the price range when asked (open 筛选, fill both bounds, click 确认), then click the sort
 * bar items of the sort in order, confirming each action on the page before the next; then read the loaded cards. No
 * action is ever repeated, including after an interruption; a price sort whose cards run the opposite way is not saved.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Sorted or ranged search result.
 * @throws {ShoppingError} Page gates, refusals, SEARCH_SORT_NOT_APPLIED, SEARCH_PRICE_RANGE_NOT_APPLIED, SEARCH_SORT_DIRECTION_MISMATCH
 *   or an exhausted read budget.
 */
export async function runPddSortRead({ bridge, op, commit, now, wait }) {
  const state = op.sort_read;
  validatePddSortReadState(state, op.target);
  if (state.schema_version !== SCHEMA_VERSION) throw new ShoppingError('INVALID_CHECKPOINT', 'A format 1 PDD sort journal is kept for reading only.');
  // A killed process can leave a reservation without an acknowledgement. The action may have happened, so it is spent.
  const pending = state.actions.find(action => action.reserved && action.outcome === null);
  if (pending) { pending.outcome = 'uncertain'; pending.error = 'READ_INTERRUPTED'; state.not_before = now() + SETTLE_MS[pending.kind]; await commit(); }
  while (state.page === null) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The PDD sort wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    const action = state.actions.find(item => !item.confirmed);
    if (action && !action.reserved) {
      action.reserved = true;
      await commit();
      try {
        await send(bridge, op, state, action);
        action.outcome = 'clicked';
      } catch (error) {
        if (error.actionNotDispatched) { action.reserved = false; await commit(); throw error; }
        action.outcome = 'uncertain'; action.error = publicError(error).code;
      }
      op.recovery_kind = null; state.not_before = now() + SETTLE_MS[action.kind];
      await commit(); continue;
    }
    if (action) {
      if (action.checks >= MAX_CHECKS) throw notShownError(action, state.range);
      const shown = await bridge.readPddSortState(op.tab_id, op.target);
      action.checks += 1;
      if (actionShown(action, shown, state.range)) action.confirmed = true;
      else if (action.checks >= MAX_CHECKS) { await commit(); throw notShownError(action, state.range); }
      else state.not_before = now() + RECHECK_MS;
      op.recovery_kind = null;
      await commit(); continue;
    }
    if (state.reads >= MAX_READS) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The PDD sort read budget is exhausted.');
    state.reads += 1;
    await commit();
    let page;
    try {
      const search = await bridge.readPddSearch(op.tab_id, op.target);
      const shown = await bridge.readPddSortState(op.tab_id, op.target);
      page = { observed_at: search.observed_at, sort_state: shown, search };
    } catch (error) {
      if (!UNFINISHED_PAGE.has(error.code) || state.reads >= MAX_READS) throw error;
      state.not_before = now() + REREAD_MS;
      await commit(); continue;
    }
    const direction = directionOf(state.sort);
    if (direction && pddSortOrderCheck(page.search.items, direction).status === 'opposite') {
      throw new ShoppingError('SEARCH_SORT_DIRECTION_MISMATCH', `The cards run opposite to ${direction === 'asc' ? '价格 low to high' : '价格 high to low'}.`,
        'Look at the tab; this task does not click again.');
    }
    state.page = page;
    op.recovery_kind = null;
    await commit();
  }
  return pddSortResult(state);
}
