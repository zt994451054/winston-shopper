import { ShoppingError } from './errors.mjs';
import { pageDom, throwPageError, responseText } from './page-dom.mjs';
import { searchTarget, searchPageTarget, searchSortTarget, parseSearchPageUrl, parseSortableSearchUrl,
  collectSearch, isSearchHome, validateSearch, validateSavedSearch } from './search.mjs';
import { pagination, validatePagination } from './search-pages.mjs';

function collectControls(root, dom, parse, collect, isHome, readPagination) {
  const actual = parse(location.href);
  if (!actual || actual.query !== root.query) return { state: 'target_changed' };
  const raw = collect(actual, false, dom, parse, isHome, 25);
  if (raw.state !== 'observed') return raw;
  const roots = dom.all(document, dom.selector('sortBarWrapper'));
  if (roots.length !== 1) return { state: 'search_sort_state_mismatch' };
  const tabs = dom.all(roots[0], '[role="tab"]');
  const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true');
  if (tabs.length > 8 || selected.length !== 1) return { state: 'search_sort_state_mismatch' };
  const label = dom.text(selected[0], 80);
  if (!['综合', '销量', '价格', '区间'].includes(label)) return { state: 'search_sort_state_mismatch' };
  const controls = readPagination(dom, label);
  if (controls.state) return controls;
  if (controls.value.current_page !== actual.page) return { state: 'structure_changed' };
  const describe = node => ({ tag: node.tagName.toUpperCase(), class_name: (node.getAttribute('class') ?? '').slice(0, 300),
    text: dom.text(node, 80), role: (node.getAttribute('role') ?? '').slice(0, 40),
    aria_label: (node.getAttribute('aria-label') ?? '').slice(0, 80),
    aria_sort: (node.getAttribute('aria-sort') ?? '').slice(0, 40),
    aria_haspopup: (node.getAttribute('aria-haspopup') ?? '').slice(0, 40),
    aria_expanded: (node.getAttribute('aria-expanded') ?? '').slice(0, 40),
    selected: node.getAttribute('aria-selected') === 'true',
    disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('data-disabled') === 'true') });
  return { ...raw, pagination: controls.value, controls: tabs.map(tab => ({ ...describe(tab),
    text: dom.text(dom.all(tab, '.next-tabs-tab-inner')[0] ?? tab, 80),
    children: [...tab.children].filter(dom.visible).slice(0, 12).map(child => ({ ...describe(child),
      children: [...child.children].filter(dom.visible).slice(0, 12).map(describe) })) })) };
}

/** @param {object} target Canonical query root. @returns {string} Fixed read of up to 25 cards and eight scoped controls; no actions or hidden state. @throws {ShoppingError} INVALID_SEARCH. */
export function searchControlsScript(target) {
  if (JSON.stringify(searchTarget(target?.query)) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use the canonical query root.');
  return `(() => { const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const searchSortTarget = ${searchSortTarget.toString()}; const parseSearchPageUrl = ${parseSearchPageUrl.toString()};
    const parseSortableSearchUrl = ${parseSortableSearchUrl.toString()};
    return (${collectControls.toString()})(${JSON.stringify(target)}, (${pageDom.toString()})(), parseSortableSearchUrl,
      ${collectSearch.toString()}, ${isSearchHome.toString()}, ${pagination.toString()}); })()`;
}

function normalizeNode(value, depth) {
  const limits = { tag: 20, class_name: 300, text: 80, role: 40, aria_label: 80, aria_sort: 40, aria_haspopup: 40, aria_expanded: 40 };
  if (!value || Object.keys(value).length !== Object.keys(limits).length + 2 + Number(depth > 0) ||
      typeof value.selected !== 'boolean' || typeof value.disabled !== 'boolean') throw new ShoppingError('INVALID_RESPONSE', 'Invalid scoped control metadata.');
  const result = Object.fromEntries(Object.entries(limits).map(([key, limit]) => [key, responseText(value[key], limit)]));
  if (!/^[A-Z][A-Z0-9-]{0,19}$/.test(result.tag)) throw new ShoppingError('INVALID_RESPONSE', 'Invalid control element name.');
  Object.assign(result, { selected: value.selected, disabled: value.disabled });
  if (depth > 0) {
    if (!Array.isArray(value.children) || value.children.length > 12) throw new ShoppingError('INVALID_RESPONSE', 'Control metadata exceeded its child limit.');
    result.children = value.children.map(child => normalizeNode(child, depth - 1));
  }
  return result;
}

function normalizeControls(value, selectedLabel) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new ShoppingError('INVALID_RESPONSE', 'Invalid scoped sort controls.');
  const controls = value.map(node => normalizeNode(node, 2));
  const selected = controls.filter(node => node.selected);
  if (controls.some(node => node.role !== 'tab') || selected.length !== 1 || selected[0].text !== selectedLabel) {
    throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The selected sort control disagrees with pagination.');
  }
  return controls;
}

/** @param {object} value @param {object} target @returns {object} Partial search snapshot and bounded visible control metadata. @throws {ShoppingError} Gates or invalid layout/response. */
export function validateSearchControls(value, target) {
  throwPageError(value?.state);
  const actual = parseSortableSearchUrl(value?.url), label = value?.pagination?.selected_sort_label;
  if (!actual || actual.query !== target.query || !['综合', '销量', '价格', '区间'].includes(label)) throw new ShoppingError('INVALID_RESPONSE', 'Unexpected control inspection target.');
  const search = validateSearch(value, actual, { cardLimit: 25, allowSort: true }).result;
  return { schema_version: 1, query: target.query, source: 'visible_search_controls', search,
    pagination: validatePagination(value.pagination, actual.page, label), controls: normalizeControls(value.controls, label),
    coverage: { status: 'partial', controls_visible_only: true, control_behavior_verified: false, sort_verified: false, filters_verified: false },
    limits: { cards: 25, tabs: 8, children_per_level: 12, descendant_levels: 2 }, login_verified: false };
}

/** @param {object} value @param {object} target @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for altered inspection results. */
export function validateSavedSearchControls(value, target) {
  try {
    const actual = parseSortableSearchUrl(value.search?.url), label = value.pagination?.selected_sort_label;
    if (!actual || actual.query !== target.query || !['综合', '销量', '价格', '区间'].includes(label)) throw new Error();
    validateSavedSearch(value.search, actual, { cardLimit: 25, allowSort: true });
    const expected = { schema_version: 1, query: target.query, source: 'visible_search_controls', search: value.search,
      pagination: validatePagination(value.pagination, actual.page, label), controls: normalizeControls(value.controls, label),
      coverage: { status: 'partial', controls_visible_only: true, control_behavior_verified: false, sort_verified: false, filters_verified: false },
      limits: { cards: 25, tabs: 8, children_per_level: 12, descendant_levels: 2 }, login_verified: false };
    if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'Invalid saved search control inspection.'); }
}

/** @param {{bridge: object, op: object, commit: Function}} context @returns {Promise<object>} One read-only inspection. @throws {ShoppingError} Gates or exhausted shared observation budget. */
export async function runSearchControls({ bridge, op, commit }) {
  if (op.read_action.observations >= 8) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The inspection observation allowance was exhausted.');
  op.read_action.observations += 1;
  await commit();
  return bridge.readSearchControls(op.tab_id, op.target);
}
