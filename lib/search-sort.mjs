import { ShoppingError, publicError } from './errors.mjs';
import { pageDom, throwPageError } from './page-dom.mjs';
import { searchTarget, searchPageTarget, searchSortTarget, parseSearchPageUrl, parseSortableSearchUrl,
  collectSearch, isSearchHome, validateSearch, validateSavedSearch } from './search.mjs';
import { pagination, validatePagination, collectLayout } from './search-pages.mjs';

function inspectSortTarget(expected, dispatched, parse) {
  const current = new URL(location.href);
  if (['login.taobao.com', 'login.tmall.com'].includes(current.hostname)) return { state: 'login_required' };
  const actual = parse(location.href);
  if (!actual || actual.query !== expected.query || (!dispatched && actual.sort_parameter !== undefined)) return { state: 'target_changed' };
  return { state: 'observed', url: actual.url };
}

/**
 * Verify only an explicitly saved tab's address when the extension inventory covers another window.
 * @param {object} target Canonical query root. @param {boolean} dispatched Whether a sort token is allowed.
 * @returns {string} Fixed location-only expression; no DOM, storage, navigation or unrelated URL output.
 * @throws {ShoppingError} INVALID_SEARCH for a noncanonical root.
 */
export function searchSortTargetScript(target, dispatched) {
  if (JSON.stringify(searchTarget(target?.query)) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use the canonical query root.');
  return `(() => { const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const searchSortTarget = ${searchSortTarget.toString()}; const parseSearchPageUrl = ${parseSearchPageUrl.toString()};
    const parseSortableSearchUrl = ${parseSortableSearchUrl.toString()};
    return (${inspectSortTarget.toString()})(${JSON.stringify(target)}, ${JSON.stringify(dispatched)}, parseSortableSearchUrl); })()`;
}

/**
 * Capture a normal sort read and, on structural failure, bounded layout evidence in the same evaluation.
 * @param {object} target Canonical root. @param {boolean} dispatched Original saved action intent.
 * @returns {string} Fixed read-only diagnostic expression, to be charged to the original DOM budget.
 * @throws {ShoppingError} INVALID_SEARCH for an invalid root.
 */
export function searchSortDiagnosticScript(target, dispatched) {
  const read = searchSortScript(target, { dispatched });
  return `(() => { const observation = ${read};
    const result = { observation, layout: null };
    if (!['search_pagination_missing', 'search_page_display_missing', 'search_page_controls_mismatch', 'search_sort_state_mismatch', 'structure_changed'].includes(observation.state)) return result;
    const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const searchSortTarget = ${searchSortTarget.toString()}; const parseSearchPageUrl = ${parseSearchPageUrl.toString()};
    const parseSortableSearchUrl = ${parseSortableSearchUrl.toString()}; const actual = parseSortableSearchUrl(location.href);
    if (!actual || actual.query !== ${JSON.stringify(target.query)} || (!${JSON.stringify(dispatched)} && actual.sort_parameter !== undefined)) return result;
    result.layout = (${collectLayout.toString()})(actual, (${pageDom.toString()})(), parseSortableSearchUrl, ${collectSearch.toString()}, ${isSearchHome.toString()});
    return result; })()`;
}

function collectSort(root, dispatched, baseline, dom, parse, collect, isHome, readPagination) {
  const actual = parse(location.href);
  if (!actual || actual.query !== root.query || (!dispatched && actual.sort_parameter !== undefined)) return { state: 'target_changed' };
  const raw = collect(actual, false, dom, parse, isHome, 25);
  if (raw.state !== 'observed') return raw;
  const roots = dom.all(document, dom.selector('sortBarWrapper'));
  if (roots.length !== 1) return { state: 'search_sort_state_mismatch' };
  const tabs = dom.all(roots[0], '[role="tab"]');
  const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true');
  if (selected.length !== 1) return { state: 'search_sort_state_mismatch' };
  const label = dom.text(selected[0], 40);
  if (!['综合', '销量'].includes(label)) return { state: 'search_sort_state_mismatch' };
  const sales = tabs.filter(tab => dom.text(tab, 40) === '销量');
  if (sales.length !== 1 || sales[0].disabled || sales[0].getAttribute('aria-disabled') === 'true' ||
      sales[0].getAttribute('data-disabled') === 'true') return { state: 'unsupported' };
  const controls = readPagination(dom, label);
  if (controls.state) return controls;
  if (controls.value.current_page !== actual.page) return { state: baseline ? 'structure_changed' : 'page_transition' };
  if (!dispatched && label !== '综合') return { state: 'unsupported' };
  if (!baseline) return { ...raw, pagination: controls.value };
  const urls = [...new Set(raw.items.filter(item => item.url).map(item => item.url))];
  if (actual.url !== baseline.url || label !== '综合' || JSON.stringify(urls) !== JSON.stringify(baseline.urls) ||
      JSON.stringify(controls.value) !== JSON.stringify(baseline.pagination)) return { state: 'target_changed' };
  sales[0].click();
  return { state: 'action_dispatched', clicked: true };
}

/**
 * Build a fixed sales-tab read or guarded click. No URL is constructed for navigation.
 * @param {object} target Canonical query root. @param {{dispatched?: boolean, before?: object}} options
 * @returns {string} Bounded page expression. @throws {ShoppingError} Invalid root or baseline.
 */
export function searchSortScript(target, { dispatched = false, before } = {}) {
  if (JSON.stringify(searchTarget(target?.query)) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use the canonical query root.');
  if (before) validateSnapshot(before, target, true);
  const baseline = before ? { url: before.search.url, urls: before.search.items.map(item => item.url), pagination: before.pagination } : null;
  return `(() => { const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const searchSortTarget = ${searchSortTarget.toString()}; const parseSearchPageUrl = ${parseSearchPageUrl.toString()};
    const parseSortableSearchUrl = ${parseSortableSearchUrl.toString()};
    return (${collectSort.toString()})(${JSON.stringify(target)}, ${JSON.stringify(dispatched)}, ${JSON.stringify(baseline)},
      (${pageDom.toString()})(), parseSortableSearchUrl, ${collectSearch.toString()}, ${isSearchHome.toString()}, ${pagination.toString()}); })()`;
}

/** @param {object} value @param {object} target @param {boolean} dispatched @returns {object} Transition or validated snapshot. @throws {ShoppingError} Gates, identity or layout mismatch. */
export function validateSearchSort(value, target, dispatched) {
  throwPageError(value?.state);
  if (value?.state === 'page_transition') return { state: 'page_transition' };
  const actual = parseSortableSearchUrl(value?.url);
  if (!actual || actual.query !== target.query || (!dispatched && actual.sort_parameter !== undefined)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The sort observation does not match the query and saved intent.');
  }
  const label = value.pagination?.selected_sort_label;
  if (!['综合', '销量'].includes(label) || (!dispatched && label !== '综合')) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The selected sort is inconsistent.');
  const search = validateSearch(value, actual, { cardLimit: 25, allowSort: true }).result;
  return { state: 'observed', snapshot: { search, pagination: validatePagination(value.pagination, actual.page, label) } };
}

function validateSnapshot(value, target, before = false) {
  if (!value || Object.keys(value).join(',') !== 'search,pagination') throw new ShoppingError('INVALID_CHECKPOINT', 'Invalid sort snapshot.');
  const actual = parseSortableSearchUrl(value.search?.url);
  const label = value.pagination?.selected_sort_label;
  if (!actual || actual.query !== target.query || !['综合', '销量'].includes(label) ||
      (before && (actual.sort_parameter !== undefined || label !== '综合'))) throw new ShoppingError('INVALID_CHECKPOINT', 'The sort snapshot target is inconsistent.');
  validateSavedSearch(value.search, actual, { cardLimit: 25, allowSort: true });
  if (JSON.stringify(validatePagination(value.pagination, actual.page, label)) !== JSON.stringify(value.pagination)) throw new ShoppingError('INVALID_CHECKPOINT', 'Invalid pagination snapshot.');
}

const identities = snapshot => snapshot.search.items.map(item => item.product_id);
function changed(before, after) { return JSON.stringify(identities(before)) !== JSON.stringify(identities(after)); }
function qualifies(before, after) { return after.search.page === 1 && after.pagination.selected_sort_label === '销量' && changed(before, after); }
function sameCandidate(a, b) {
  return a.search.url === b.search.url && JSON.stringify(identities(a)) === JSON.stringify(identities(b)) &&
    JSON.stringify(a.pagination) === JSON.stringify(b.pagination);
}

/** @returns {object} Durable one-click sort journal; eight observations and three outcome checks maximum. */
export function newSearchSortState() {
  return { observations: 0, checks: 0, not_before: 0, action_reserved: false, acknowledgement_error: null,
    before: null, candidate: null, after: null };
}

/** @param {object} state @param {object} target @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for invalid budgets or evidence. */
export function validateSearchSortState(state, target) {
  try {
    if (Object.keys(state).join(',') !== Object.keys(newSearchSortState()).join(',') ||
        !Number.isInteger(state.observations) || state.observations < 0 || state.observations > 8 ||
        !Number.isInteger(state.checks) || state.checks < 0 || state.checks > 3 || state.checks > state.observations ||
        !Number.isSafeInteger(state.not_before) || state.not_before < 0 || typeof state.action_reserved !== 'boolean' ||
        !(state.acknowledgement_error === null || (typeof state.acknowledgement_error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(state.acknowledgement_error)))) throw new Error();
    if (state.before) validateSnapshot(state.before, target, true);
    if (state.before && state.observations < 1) throw new Error();
    if (state.action_reserved && !state.before) throw new Error();
    if (!state.action_reserved && (state.checks || state.acknowledgement_error || state.candidate || state.after)) throw new Error();
    if (state.candidate) {
      validateSnapshot(state.candidate, target);
      if (!state.action_reserved || state.checks < 1 || state.observations < 2 || !qualifies(state.before, state.candidate)) throw new Error();
    }
    if (state.after) {
      validateSnapshot(state.after, target);
      if (!state.candidate || state.checks < 2 || state.observations < 3 || !qualifies(state.before, state.after) || !sameCandidate(state.candidate, state.after)) throw new Error();
    }
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The bounded sort journal is invalid.'); }
}

function resultFor(target, state) {
  return { schema_version: 1, query: target.query, source: 'bounded_search_sort', requested_sort: 'sales',
    before: state.before, after: state.after,
    coverage: { status: 'partial', sort_ui_verified: true, sort_verified: false, filters_verified: false, total_results_known: false },
    limits: { cards_per_observation: 25, sort_clicks: 1 },
    action_evidence: { actions_reserved: 1, observations_reserved: state.observations, acknowledgement_error: state.acknowledgement_error,
      verification: 'sales_tab_selected_first_page_changed_ids_and_two_matching_observations' },
    missing: ['verified_sort_algorithm', 'unscanned_cards', 'subsequent_pages', 'verified_payable_prices'], login_verified: false };
}

/** @param {object} value @param {object} target @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT if the result differs from the journal. */
export function validateSearchSortResult(value, target, state) {
  validateSearchSortState(state, target);
  if (!state.after || JSON.stringify(value) !== JSON.stringify(resultFor(target, state))) throw new ShoppingError('INVALID_CHECKPOINT', 'The sort result does not match its journal.');
}

/** @param {string} url @param {object} target @param {object} state @returns {boolean} Whether the original query and saved intent permit this observed URL. */
export function matchesSearchSort(url, target, state) {
  const actual = parseSortableSearchUrl(url);
  return Boolean(actual && actual.query === target.query && (state.action_reserved || actual.sort_parameter === undefined));
}

/**
 * Switch one visible 综合 tab to 销量 and confirm bounded first-page observations without redispatching.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} UI evidence and partial snapshots; the sorting algorithm remains unverified.
 * @throws {ShoppingError} Page gates, structure failures, exhausted budget or uncertain outcome.
 */
export async function runSearchSort({ bridge, op, commit, now, wait }) {
  const state = op.search_sort;
  if (state.after) return resultFor(op.target, state);
  while (state.observations < 8) {
    if (state.checks >= 3) throw new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'The sales-sort result could not be confirmed; its click will not be repeated.');
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved sort wait is inconsistent.');
      await wait(delay); continue;
    }
    state.observations += 1; state.not_before = now() + 1500;
    await commit();
    const observation = await bridge.readSearchSort(op.tab_id, op.target, state.action_reserved);
    state.not_before = now() + 1500; op.recovery_kind = null;
    if (!state.action_reserved) {
      if (observation.state !== 'observed') throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The starting sort and page are inconsistent.');
      state.before = observation.snapshot;
      state.action_reserved = true;
      await commit();
      try { await bridge.selectSalesSort(op.tab_id, op.target, state.before); }
      catch (error) {
        if (error.actionNotDispatched) { state.action_reserved = false; await commit(); throw error; }
        state.acknowledgement_error = publicError(error).code;
      }
      state.not_before = now() + 1500;
    } else {
      state.checks += 1;
      const snapshot = observation.state === 'observed' ? observation.snapshot : null;
      if (snapshot && qualifies(state.before, snapshot)) {
        if (state.candidate && sameCandidate(state.candidate, snapshot)) state.after = snapshot;
        else state.candidate = snapshot;
      } else state.candidate = null;
    }
    await commit();
    if (state.after) return resultFor(op.target, state);
  }
  throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The sort observation allowance was exhausted.');
}
