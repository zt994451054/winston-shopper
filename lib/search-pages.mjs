import { ShoppingError, publicError } from './errors.mjs';
import { pageDom, throwPageError } from './page-dom.mjs';
import { searchTarget, searchPageTarget, parseSearchPageUrl, isSearchHome, collectSearch, validateSearch, validateSavedSearch } from './search.mjs';

const CARD_LIMIT = 25;
const OBSERVATION_LIMIT = 8;

/** Internal serialized pagination reader. @param {object} dom @param {string} selectedSort @returns {object} Agreed controls or a fixed diagnostic state. */
export function pagination(dom, selectedSort = '综合') {
  const roots = dom.all(document, '.next-pagination');
  if (roots.length < 1 || roots.length > 2) return { state: 'search_pagination_missing' };
  // A null label means the caller checks sort and filter state itself: price views select no tab, or 区间.
  if (selectedSort !== null) {
    const sorts = dom.all(document, dom.selector('sortBarWrapper'));
    const selected = sorts.length === 1 ? dom.all(sorts[0], '[role="tab"][aria-selected="true"]') : [];
    if (selected.length !== 1 || dom.text(selected[0], 40) !== selectedSort) return { state: 'search_sort_state_mismatch' };
  }
  const disabled = button => Boolean(button.disabled || button.getAttribute('aria-disabled') === 'true');
  const controls = roots.map(root => {
    const displays = dom.all(root, '.next-pagination-display');
    const next = dom.all(root, 'button.next-next'), previous = dom.all(root, 'button.next-prev');
    const current = dom.all(root, 'button.next-current');
    const match = displays.length === 1 && dom.text(displays[0], 40).match(/^([1-9][0-9]*)\s*\/\s*([1-9][0-9]*)$/);
    if (displays.length > 1 || (displays.length === 1 && !match)) return { state: 'search_page_display_missing' };
    if (next.length !== 1 || previous.length !== 1 || current.length > 1 || (current.length === 1 && disabled(current[0]))) {
      return { state: 'search_page_controls_mismatch' };
    }
    const labelled = dom.text(next[0], 40) === '下一页' && dom.text(previous[0], 40) === '上一页';
    const currentText = current.length === 1 ? dom.text(current[0], 40) : null;
    if (match && currentText !== null && currentText !== match[1]) return { state: 'search_page_controls_mismatch' };
    if (!match && (!labelled || !/^[1-9][0-9]{0,5}$/.test(currentText ?? ''))) return { state: 'search_page_display_missing' };
    let numericPages = null;
    if (!match) {
      const buttons = dom.all(root, 'button.next-pagination-item');
      if (buttons.length > 42) return { state: 'search_page_display_missing' };
      numericPages = buttons.map(button => dom.text(button, 40)).filter(text => /^[1-9][0-9]{0,5}$/.test(text)).map(Number);
    }
    return { value: { current_page: Number(match ? match[1] : currentText), total_pages_displayed: match ? Number(match[2]) : null,
      next_disabled: disabled(next[0]), previous_disabled: disabled(previous[0]), selected_sort_label: selectedSort }, next: next[0],
      labelled, numericPages };
  });
  const failure = controls.find(control => control.state);
  if (failure) return failure;
  const displayed = controls.find(control => control.value.total_pages_displayed !== null);
  for (const control of controls.filter(control => control.numericPages !== null)) {
    const total = displayed?.value.total_pages_displayed;
    // A short full number strip can corroborate the compact display, but its last number alone cannot establish a total.
    if (!total || total > 40 || control.numericPages.length !== total || control.numericPages.some((page, index) => page !== index + 1)) {
      return { state: 'search_page_display_missing' };
    }
    control.value.total_pages_displayed = total;
  }
  const labelled = controls.filter(control => control.labelled);
  // The live layout has both compact and labelled pagination. They must agree; only the unique labelled control can be clicked.
  if (labelled.length !== 1 || controls.some(control => JSON.stringify(control.value) !== JSON.stringify(labelled[0].value))) {
    return { state: 'search_page_controls_mismatch' };
  }
  return labelled[0];
}

function collectPages(root, allowSecond, baseline, dom, parse, collect, isHome, readPagination) {
  const target = parse(location.href);
  if (!target || target.query !== root.query || (!allowSecond && target.page !== 1)) return { state: 'target_changed' };
  const raw = collect(target, false, dom, parse, isHome, 25);
  if (raw.state !== 'observed') return raw;
  const controls = readPagination(dom);
  if (controls.state) return controls;
  if (controls.value.current_page !== target.page) return { state: baseline ? 'structure_changed' : 'page_transition' };
  if (!baseline) return { ...raw, pagination: controls.value };
  // The action's own guard must still see the exact page and sampled card order that was checkpointed.
  const urls = [...new Set(raw.items.filter(item => item.url).map(item => item.url))];
  if (target.page !== 1 || JSON.stringify(urls) !== JSON.stringify(baseline.urls) ||
      JSON.stringify(controls.value) !== JSON.stringify(baseline.pagination)) return { state: 'target_changed' };
  if (controls.value.next_disabled) return { state: 'unsupported' };
  controls.next.click();
  return { state: 'action_dispatched', clicked: true };
}

/** Internal serialized bounded layout collector. @param {object} expected @param {object} dom @param {Function} parse @param {Function} collect @param {Function} isHome @returns {object} Metadata and scoped public cards, never an action. */
export function collectLayout(expected, dom, parse, collect, isHome) {
  if (parse(location.href)?.url !== expected.url) return { state: 'target_changed' };
  const raw = collect(expected, false, dom, parse, isHome, 25);
  if (!['observed', 'structure_changed'].includes(raw.state)) return raw;
  const describe = node => {
    const visible = dom.visible(node);
    const text = visible ? dom.text(node, 40) : '';
    return { tag: node.tagName, class_name: (node.getAttribute('class') ?? '').slice(0, 250), visible,
      label: /^([1-9][0-9]{0,5})(\s*\/\s*[1-9][0-9]{0,5})?$/.test(text) || ['上一页', '下一页', '综合', '销量', '价格', '区间'].includes(text) ? text : null,
      aria_current: ['page', 'true', 'false'].includes(node.getAttribute('aria-current')) ? node.getAttribute('aria-current') : null,
      aria_selected: ['true', 'false'].includes(node.getAttribute('aria-selected')) ? node.getAttribute('aria-selected') : null,
      disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true') };
  };
  const roots = dom.all(document, '.next-pagination');
  const sorts = dom.all(document, dom.selector('sortBarWrapper'));
  const queryInputs = [...document.querySelectorAll('input[name="q"]')];
  return { state: 'layout_observed', url: expected.url, query: expected.query, read_state: raw.state,
    raw_search: raw.state === 'observed' ? raw : null,
    query_inputs: queryInputs.length, query_matches: queryInputs.length === 1 && queryInputs[0].value === expected.query,
    title_matches: document.title.includes(expected.query),
    card_elements: dom.all(document, dom.selector('doubleCardWrapperAdapt')).filter(node => node.tagName === 'A').length,
    pagination_roots: roots.length, pagination: roots.slice(0, 2).map(root => ({
      controls: [...root.querySelectorAll('button,[aria-current],.next-pagination-display')].slice(0, 40).map(describe),
    })), sort_roots: sorts.length, sorts: sorts.slice(0, 2).map(root => dom.all(root, '[role="tab"]').slice(0, 8).map(describe)) };
}

/**
 * Inspect bounded pagination metadata during an explicitly budgeted diagnostic read. Hidden labels are not read.
 * @param {object} target Canonical first-page search. @returns {string} Fixed read-only expression, never a navigation.
 * @throws {ShoppingError} INVALID_SEARCH before any browser request.
 */
export function searchPagesDiagnosticScript(target) {
  if (JSON.stringify(searchTarget(target?.query)) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use the canonical first-page query.');
  return `(() => { const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const parseSearchPageUrl = ${parseSearchPageUrl.toString()};
    return (${collectLayout.toString()})(${JSON.stringify(target)}, (${pageDom.toString()})(), parseSearchPageUrl,
      ${collectSearch.toString()}, ${isSearchHome.toString()}); })()`;
}

/**
 * Build a fixed, bounded two-page observation or a single guarded next-page click.
 * @param {object} target Canonical first-page query. @param {{allowSecond?: boolean, before?: object}} options
 * @returns {string} Page expression, with all inputs serialized as data.
 * @throws {ShoppingError} Invalid target or baseline; no arbitrary selectors or script input.
 */
export function searchPagesScript(target, { allowSecond = false, before } = {}) {
  if (JSON.stringify(searchTarget(target?.query)) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use the canonical first-page query.');
  if (before) validatePage(before, target, 1);
  const baseline = before ? { urls: before.search.items.map(item => item.url), pagination: before.pagination } : null;
  return `(() => { const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const parseSearchPageUrl = ${parseSearchPageUrl.toString()};
    return (${collectPages.toString()})(${JSON.stringify(target)}, ${JSON.stringify(allowSecond)}, ${JSON.stringify(baseline)},
      (${pageDom.toString()})(), parseSearchPageUrl, ${collectSearch.toString()}, ${isSearchHome.toString()}, ${pagination.toString()}); })()`;
}

/** @param {object} value @param {number} page @param {string} selectedSort @returns {object} Canonical pagination state. @throws {ShoppingError} PAGE_STRUCTURE_CHANGED. */
export function validatePagination(value, page, selectedSort = '综合') {
  const normalized = { current_page: page, total_pages_displayed: value?.total_pages_displayed,
    next_disabled: value?.next_disabled, previous_disabled: value?.previous_disabled, selected_sort_label: selectedSort };
  if (!value || Object.keys(value).length !== Object.keys(normalized).length ||
      Object.keys(value).some(key => !Object.hasOwn(normalized, key)) || value.current_page !== page || value.selected_sort_label !== selectedSort ||
      !Number.isSafeInteger(normalized.total_pages_displayed) || normalized.total_pages_displayed < page || normalized.total_pages_displayed > 100000 ||
      typeof normalized.next_disabled !== 'boolean' || typeof normalized.previous_disabled !== 'boolean' ||
      normalized.previous_disabled !== (page === 1) ||
      (normalized.total_pages_displayed === page && !normalized.next_disabled)) {
    throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The pagination display, controls and search page disagree.');
  }
  return normalized;
}

/** @param {object} value @param {object} target @param {boolean} allowSecond @returns {object} A transition or validated page observation. @throws {ShoppingError} Page gates, target or structure mismatch. */
export function validateSearchPage(value, target, allowSecond) {
  throwPageError(value?.state);
  if (value?.state === 'page_transition') return { state: 'page_transition' };
  const actual = parseSearchPageUrl(value?.url);
  if (!actual || actual.query !== target.query || (!allowSecond && actual.page !== 1)) throw new ShoppingError('INVALID_RESPONSE', 'Unexpected search page observation.');
  const search = validateSearch(value, actual, { cardLimit: CARD_LIMIT }).result;
  const controls = validatePagination(value.pagination, actual.page);
  return { state: 'observed', page: { search, pagination: controls } };
}

function validatePage(value, target, page) {
  if (!value || Object.keys(value).join(',') !== 'search,pagination') throw new Error('Invalid page snapshot.');
  validateSavedSearch(value.search, searchPageTarget(target.query, page), { cardLimit: CARD_LIMIT });
  validatePagination(value.pagination, page);
}

const identities = page => page.search.items.map(item => item.product_id);
function hasNewItems(before, after) {
  const old = new Set(identities(before));
  return identities(after).some(id => !old.has(id));
}

/** @returns {object} Empty two-page journal; at most one next-page action can be reserved. */
export function newSearchPagesState() {
  return { observations: 0, checks: 0, not_before: 0, action_reserved: false, acknowledgement_error: null,
    before: null, candidate: null, after: null };
}

/** @param {object} state @param {object} target @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT, before any browser use. */
export function validateSearchPagesState(state, target) {
  try {
    if (Object.keys(state).join(',') !== Object.keys(newSearchPagesState()).join(',') ||
        !Number.isInteger(state.observations) || state.observations < 0 || state.observations > OBSERVATION_LIMIT ||
        !Number.isInteger(state.checks) || state.checks < 0 || state.checks > 3 || state.checks > state.observations ||
        !Number.isSafeInteger(state.not_before) || state.not_before < 0 || typeof state.action_reserved !== 'boolean' ||
        !(state.acknowledgement_error === null || (typeof state.acknowledgement_error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(state.acknowledgement_error)))) throw new Error();
    if (state.before) validatePage(state.before, target, 1);
    if (state.action_reserved && (!state.before || state.before.pagination.next_disabled)) throw new Error();
    if (state.before && state.observations < 1) throw new Error();
    if (!state.action_reserved && (state.checks || state.acknowledgement_error || state.candidate || state.after)) throw new Error();
    if (state.candidate) {
      validatePage(state.candidate, target, 2);
      if (state.checks < 1 || state.observations < 2 || !hasNewItems(state.before, state.candidate)) throw new Error();
    }
    if (state.after) {
      validatePage(state.after, target, 2);
      if (!state.candidate || state.checks < 2 || state.observations < 3 ||
          JSON.stringify(identities(state.candidate)) !== JSON.stringify(identities(state.after)) ||
          state.candidate.pagination.total_pages_displayed !== state.after.pagination.total_pages_displayed) throw new Error();
    }
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The two-page search journal is invalid.'); }
}

function resultFor(target, state) {
  return { schema_version: 1, query: target.query, source: 'bounded_search_pages', pages: [state.before, state.after],
    coverage: { status: 'partial', page_transition_verified: true, sort_verified: false, filters_verified: false, total_results_known: false },
    limits: { pages: 2, cards_per_page: CARD_LIMIT },
    action_evidence: { actions_reserved: 1, observations_reserved: state.observations, acknowledgement_error: state.acknowledgement_error,
      verification: 'matching_url_and_page_display_with_new_items_and_two_matching_page2_observations' },
    missing: ['unscanned_cards', 'subsequent_pages', 'verified_sort_and_filters', 'verified_payable_prices'], login_verified: false };
}

/** @param {object} value @param {object} target @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent cached results. */
export function validateSearchPagesResult(value, target, state) {
  validateSearchPagesState(state, target);
  if (!state.after || JSON.stringify(value) !== JSON.stringify(resultFor(target, state))) throw new ShoppingError('INVALID_CHECKPOINT', 'The result does not match its two-page journal.');
}

/** @param {object} target @param {object} state @returns {object[]} Exact pages allowed by the saved navigation intent, for diagnosis and reconnection. */
export function searchPagesTargets(target, state) {
  return state.action_reserved ? [target, searchPageTarget(target.query, 2)] : [target];
}

/**
 * Read the first two pages with one durable click and bounded confirmation observations.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Two partial page snapshots and transition evidence.
 * @throws {ShoppingError} Gates, exhausted observations, unchanged content or unknown action outcome; never redispatches an uncertain click.
 */
export async function runSearchPages({ bridge, op, commit, now, wait }) {
  const state = op.search_pages;
  if (state.after) return resultFor(op.target, state);
  while (state.observations < OBSERVATION_LIMIT) {
    if (state.checks >= 3) throw new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'The second page could not be confirmed. The next-page click will not be repeated.');
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved page observation wait is inconsistent.');
      await wait(delay); continue;
    }
    state.observations += 1; state.not_before = now() + 1500;
    await commit();
    const observation = await bridge.readSearchPage(op.tab_id, op.target, state.action_reserved);
    state.not_before = now() + 1500;
    op.recovery_kind = null;
    if (!state.action_reserved) {
      if (observation.state !== 'observed' || observation.page.search.page !== 1) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The starting page has no consistent pagination state.');
      state.before = observation.page;
      if (state.before.pagination.next_disabled) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'The observed next-page button is disabled.');
      state.action_reserved = true;
      await commit();
      try { await bridge.nextSearchPage(op.tab_id, op.target, state.before); }
      catch (error) {
        if (error.actionNotDispatched) { state.action_reserved = false; await commit(); throw error; }
        state.acknowledgement_error = publicError(error).code;
      }
      state.not_before = now() + 1500;
    } else {
      state.checks += 1;
      const page = observation.state === 'observed' ? observation.page : null;
      if (page?.search.page === 2 && hasNewItems(state.before, page)) {
        if (state.candidate && JSON.stringify(identities(state.candidate)) === JSON.stringify(identities(page)) &&
            state.candidate.pagination.total_pages_displayed === page.pagination.total_pages_displayed) {
          state.after = page;
        } else state.candidate = page;
      } else state.candidate = null;
    }
    await commit();
    if (state.after) return resultFor(op.target, state);
  }
  throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The two-page observation allowance was exhausted.');
}
