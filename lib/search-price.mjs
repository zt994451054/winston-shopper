import { ShoppingError, publicError } from './errors.mjs';
import { pageDom, throwPageError } from './page-dom.mjs';
import { searchTarget, searchPageTarget, parseSearchPageUrl, parseSearchUrl, collectSearch, isSearchHome,
  validateSearch, validateSavedSearch } from './search.mjs';
import { pagination, validatePagination } from './search-pages.mjs';
import { SEARCH_RANGE_CARD_LIMIT, searchRangeTarget, parseSearchRangeUrl } from './search-page-range.mjs';
import { createSearchPriceRequest, parseCnyAmount } from './search-price-request.mjs';
import { assessDisplayedPrices, localPriceOrder } from './search-price-check.mjs';

const PRICE_CARD_LIMIT = SEARCH_RANGE_CARD_LIMIT;
function requireCardLimit(value) {
  if (![25, PRICE_CARD_LIMIT].includes(value)) throw new ShoppingError('INVALID_SEARCH', 'Use a supported cards-per-observation limit.');
}

/** Visible option text for each requested platform direction (2026-10-12 live layout). */
export const PRICE_DIRECTION_LABELS = Object.freeze({ 'price-asc': '从低到高', 'price-desc': '从高到低' });
/** Range input placeholders that identify the two visible bounds. */
export const PRICE_BOUND_PLACEHOLDERS = Object.freeze({ minimum: '¥ 最低价', maximum: '¥ 最高价' });
const POINTER_TABS = Object.freeze({ 综合: 'sortBarWrapInner', 价格: 'otherSelector', 区间: 'otherSelector' });
const OPTION_LABELS = Object.values(PRICE_DIRECTION_LABELS);
const CONTROL_KEYS = ['comprehensive_selected', 'sales_selected', 'price_selected', 'range_selected', 'direction_menu', 'range_panel',
  'source_tab', 'selected_filters'];

// Page 1 keeps its original first-page identity; pages 2-5 use the canonical five-page range identity (live 2026-10-13:
// after a price sort, 下一页 changes only the page parameter and keeps the sort).
// The 天猫 source tab only changes tab=all to tab=mall (live 2026-10-13), so it is part of the page identity: a 天猫
// view must never be taken for the 所有宝贝 view of the same query.
const SOURCES = Object.freeze({ all: 'all', tmall: 'mall' });
function priceViewTarget(query, page, source = 'all') {
  if (!Number.isInteger(page) || page < 1 || page > 5) throw new ShoppingError('INVALID_SEARCH', 'Choose a price result page from one through five.');
  if (!Object.hasOwn(SOURCES, source)) throw new ShoppingError('INVALID_SEARCH', 'Choose the 所有宝贝 or 天猫 source.');
  const base = page === 1 ? searchPageTarget(query, 1) : searchRangeTarget(query, page);
  return source === 'all' ? base : { ...base, source, url: base.url.replace('&tab=all', `&tab=${SOURCES[source]}`) };
}

/** @param {unknown} value Search address. @returns {object|null} Query, page 1-5, source and canonical address, or null. */
function parsePriceViewUrl(value) {
  try {
    const url = new URL(value), tabs = url.searchParams.getAll('tab');
    if (tabs.length > 1 || (tabs.length === 1 && !['all', 'mall'].includes(tabs[0]))) return null;
    const mall = tabs[0] === 'mall';
    url.searchParams.set('tab', 'all');
    const parsed = parseSearchRangeUrl(url.href);
    if (!parsed) return null;
    return mall ? { ...parsed, source: 'tmall', url: parsed.url.replace('&tab=all', '&tab=mall') } : parsed;
  } catch { return null; }
}

/**
 * Whether an address shows one of the allowed views of the query; used by the bridge before every price read or action.
 * @param {string} url @param {object} target Canonical query root. @param {{page: number, source?: string}[]} views
 * @returns {boolean}
 */
export function matchesPriceView(url, target, views) {
  requireRoot(target);
  const actual = parsePriceViewUrl(url);
  return Boolean(actual) && views.some(view => priceViewTarget(target.query, view.page, view.source ?? 'all').url === actual.url);
}

function requireRoot(target) {
  if (JSON.stringify(searchTarget(target?.query)) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use the canonical query root.');
}

/**
 * Internal serialized reader for the four sort-bar tabs and any open price overlay.
 * Overlays are portals at the end of the page, so they are found by class rather than a bounded scan.
 */
export function readPriceControls(dom) {
  const roots = dom.all(document, dom.selector('sortBarWrapper'));
  if (roots.length !== 1) return { state: 'structure_changed' };
  const tabs = dom.all(roots[0], '[role="tab"]');
  const named = ['综合', '销量', '价格', '区间'].map(label => tabs.filter(tab => dom.text(tab, 40) === label));
  if (named.some(list => list.length !== 1)) return { state: 'structure_changed' };
  const [comprehensive, sales, price, range] = named.map(list => list[0].getAttribute('aria-selected') === 'true');
  const menus = dom.all(document, dom.selector('priceTabOverLayWrapper'));
  const panels = dom.all(document, dom.selector('sectionPriceSelecterWrapper'));
  if (menus.length > 1 || panels.length > 1) return { state: 'structure_changed' };
  let directionMenu = null, rangePanel = null;
  if (menus.length) {
    // The selected direction differs only in computed weight; class names are identical.
    const options = dom.all(menus[0], dom.selector('priceTag')).map(node => ({ label: dom.text(node, 20),
      emphasized: Number(getComputedStyle(node).fontWeight) >= 600 }));
    if (options.length !== 2 || options[0].label !== '从低到高' || options[1].label !== '从高到低') return { state: 'structure_changed' };
    directionMenu = { options };
  }
  if (panels.length) {
    const field = placeholder => dom.all(document, 'input').filter(input => input.getAttribute('placeholder') === placeholder);
    const minimum = field('¥ 最低价'), maximum = field('¥ 最高价');
    const confirm = dom.all(panels[0], dom.selector('confirmButton')).filter(node => dom.text(node, 10) === '确定');
    if (minimum.length !== 1 || maximum.length !== 1 || confirm.length !== 1) return { state: 'structure_changed' };
    rangePanel = { minimum_text: String(minimum[0].value ?? '').slice(0, 41), maximum_text: String(maximum[0].value ?? '').slice(0, 41) };
  }
  // Live 2026-10-13: the source tab row marks its selected tab with an actStyle-- class, and the filter strip marks each
  // selected filter with a selected-- class. Neither has aria state. Unknown layouts read as null, never as "none selected".
  const marked = (node, prefix) => (node.getAttribute('class') ?? '').split(/\s+/).some(name => name.startsWith(`${prefix}--`));
  const rows = dom.all(document, dom.selector('tabWrap'));
  const active = rows.length === 1 ? [...rows[0].children].filter(node => marked(node, 'actStyle')) : [];
  const strips = dom.all(document, dom.selector('filterItemsWithFixBox'));
  const selectedFilters = strips.length === 1 ? dom.all(strips[0], dom.selector('filterItem')).filter(node => marked(node, 'selected')).map(node => dom.text(node, 12)) : null;
  return { value: { comprehensive_selected: comprehensive, sales_selected: sales, price_selected: price, range_selected: range,
    direction_menu: directionMenu, range_panel: rangePanel, source_tab: active.length === 1 ? dom.text(active[0], 10) : null,
    selected_filters: selectedFilters && selectedFilters.length <= 20 ? selectedFilters : null } };
}

function collectPriceView(target, previous, dom, parse, collect, isHome, readPagination, readControls, cardLimit) {
  // Whether the user had the page in front: a moving real pointer or another window can close hover overlays.
  const page = { visible: document.visibilityState === 'visible', focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null };
  const actual = parse(location.href);
  // While a page turn is settling, the tab may still show the page it came from.
  if (previous && actual?.url === previous.url) return { state: 'page_transition', page_state: page };
  if (!actual || actual.url !== target.url) return { state: 'target_changed' };
  const raw = collect(actual, false, dom, parse, isHome, cardLimit);
  if (raw.state !== 'observed') return raw;
  const controls = readControls(dom);
  if (controls.state) return controls;
  const pages = readPagination(dom, null);
  if (pages.state) return pages;
  if (pages.value.current_page !== target.page) return previous ? { state: 'page_transition', page_state: page } : { state: 'structure_changed' };
  return { ...raw, pagination: pages.value, controls: controls.value, page_state: page };
}

function readControlsOnly(target, dom, parse, readControls) {
  const actual = parse(location.href);
  if (!actual || actual.url !== target.url) return { state: 'target_changed' };
  const blocked = dom.gate();
  if (blocked) return { state: blocked };
  const controls = readControls(dom);
  return controls.state ? controls : { state: 'observed', controls: controls.value };
}

function guardedClick(target, label, dom, parse, findControl) {
  const actual = parse(location.href);
  if (!actual || actual.url !== target.url) return { state: 'target_changed' };
  const blocked = dom.gate();
  if (blocked) return { state: blocked };
  const control = findControl(dom, label);
  if (!control) return { state: 'price_control_unavailable' };
  control.click();
  return { state: 'action_dispatched', clicked: true };
}

function directionOption(dom, label) {
  const menus = dom.all(document, dom.selector('priceTabOverLayWrapper'));
  const options = menus.length === 1 ? dom.all(menus[0], dom.selector('priceTag')).filter(node => dom.text(node, 20) === label) : [];
  return options.length === 1 ? options[0] : null;
}

function sourceTabControl(dom, label) {
  const rows = dom.all(document, dom.selector('tabWrap'));
  const tabs = rows.length === 1 ? [...rows[0].children].filter(node => dom.visible(node) && dom.text(node, 10) === label) : [];
  return tabs.length === 1 ? tabs[0] : null;
}

function filterControl(dom, label) {
  const strips = dom.all(document, dom.selector('filterItemsWithFixBox'));
  const items = strips.length === 1 ? dom.all(strips[0], dom.selector('filterItem')).filter(node => dom.text(node, 12) === label) : [];
  return items.length === 1 ? items[0] : null;
}

function rangeConfirm(dom) {
  const panels = dom.all(document, dom.selector('sectionPriceSelecterWrapper'));
  const controls = panels.length === 1 ? dom.all(panels[0], dom.selector('confirmButton')).filter(node => dom.text(node, 10) === '确定') : [];
  return controls.length === 1 ? controls[0] : null;
}

function tabPointerSelector(label, container, dom) {
  const roots = dom.all(document, dom.selector('sortBarWrapper'));
  const tabs = roots.length === 1 ? dom.all(roots[0], '[role="tab"]').filter(tab => dom.text(tab, 40) === label) : [];
  if (tabs.length !== 1) return { state: 'structure_changed' };
  const index = [...tabs[0].parentElement.children].indexOf(tabs[0]) + 1;
  const selector = `:is(${dom.selector('sortBarWrapper')}) :is(${dom.selector(container)}) [role="tab"]:nth-child(${index})`;
  // A locator resolves the first match; require that the whole document has exactly this tab.
  const matches = [...document.querySelectorAll(selector)];
  return matches.length === 1 && matches[0] === tabs[0] ? { state: 'selector_ready', selector } : { state: 'structure_changed' };
}

const scriptPrelude = () => `const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const parseSearchPageUrl = ${parseSearchPageUrl.toString()}; const parseSearchUrl = ${parseSearchUrl.toString()};
    const searchRangeTarget = ${searchRangeTarget.toString()}; const parseSearchRangeUrl = ${parseSearchRangeUrl.toString()};
    const parsePriceViewUrl = ${parsePriceViewUrl.toString()};`;

/**
 * Build a read-only price view of one result page: cards, pagination without a sort-label assumption, and price control state.
 * @param {object} target Canonical query root. @param {number} [page=1] Result page 1-5.
 * @param {{allowPrevious?: boolean, cardLimit?: number}} [options] While a page turn settles, report the previous page as a transition
 * instead of a change. `cardLimit` is the task's cards per observation (25 before 2026-10-14, 50 since).
 * @returns {string} Fixed page expression. @throws {ShoppingError} INVALID_SEARCH.
 * @example searchPriceScript(searchTarget('罗技 M330'), 2, { allowPrevious: true });
 */
export function searchPriceScript(target, page = 1, { allowPrevious = false, source = 'all', previousSource = null, cardLimit = PRICE_CARD_LIMIT } = {}) {
  requireRoot(target); requireCardLimit(cardLimit);
  const view = priceViewTarget(target.query, page, source);
  const previous = allowPrevious && page > 1 ? priceViewTarget(target.query, page - 1, source) : previousSource ? priceViewTarget(target.query, page, previousSource) : null;
  return `(() => { ${scriptPrelude()}
    return (${collectPriceView.toString()})(${JSON.stringify(view)}, ${JSON.stringify(previous)}, (${pageDom.toString()})(), parsePriceViewUrl,
      ${collectSearch.toString()}, ${isSearchHome.toString()}, ${pagination.toString()}, ${readPriceControls.toString()}, ${cardLimit}); })()`;
}

function clickNextPricePage(view, productIds, dom, parse, collect, isHome, readPagination, cardLimit) {
  const actual = parse(location.href);
  if (!actual || actual.url !== view.url) return { state: 'target_changed' };
  const raw = collect(actual, false, dom, parse, isHome, cardLimit);
  if (raw.state !== 'observed') return { state: raw.state };
  const pages = readPagination(dom, null);
  if (pages.state) return { state: pages.state };
  // The click is guarded by the exact page and card order that was confirmed and saved.
  const ids = [];
  for (const item of raw.items) {
    if (!item.url) continue;
    const id = new URL(item.url).searchParams.get('id');
    if (!ids.includes(id)) ids.push(id);
  }
  if (pages.value.current_page !== view.page || JSON.stringify(ids) !== JSON.stringify(productIds)) return { state: 'target_changed' };
  if (pages.value.next_disabled) return { state: 'last_page' };
  pages.next.click();
  return { state: 'action_dispatched', clicked: true };
}

/**
 * Build one guarded 下一页 click from a confirmed price result page.
 * @param {object} target Canonical query root. @param {{page: number, product_ids: string[]}} from The confirmed current page.
 * @param {{cardLimit?: number}} [options] The cards per observation the confirmed page was read with.
 * @returns {string} Page expression. @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS before any IO.
 */
export function nextPricePageScript(target, from, { cardLimit = PRICE_CARD_LIMIT } = {}) {
  requireRoot(target); requireCardLimit(cardLimit);
  if (!Number.isInteger(from?.page) || from.page < 1 || from.page > 4 || !Array.isArray(from.product_ids) || from.product_ids.length > cardLimit ||
      from.product_ids.some(id => typeof id !== 'string' || !/^[0-9]{1,64}$/.test(id))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A next-page click needs a confirmed page from one through four and its saved card order.');
  }
  return `(() => { ${scriptPrelude()}
    return (${clickNextPricePage.toString()})(${JSON.stringify(priceViewTarget(target.query, from.page, from.source ?? 'all'))}, ${JSON.stringify(from.product_ids)},
      (${pageDom.toString()})(), parsePriceViewUrl, ${collectSearch.toString()}, ${isSearchHome.toString()}, ${pagination.toString()}, ${cardLimit}); })()`;
}

/**
 * @param {unknown} value @returns {{clicked: true}}
 * @throws {ShoppingError} LAST_PAGE_REACHED or page gates (marked undispatched, certain nothing was clicked); INVALID_RESPONSE when uncertain.
 */
export function validateNextPriceAcknowledgement(value) {
  if (value?.state === 'last_page') {
    const error = new ShoppingError('LAST_PAGE_REACHED', 'The confirmed page is the last result page; nothing was clicked.');
    error.actionNotDispatched = true;
    throw error;
  }
  return validatePriceClickAcknowledgement(value);
}

/**
 * Build a read-only expression for the price controls alone, used to check an overlay is open before typing.
 * @param {object} target Canonical query root. @returns {string} Page expression. @throws {ShoppingError} INVALID_SEARCH.
 */
export function priceControlsScript(target, source = 'all') {
  requireRoot(target);
  return `(() => { ${scriptPrelude()}
    return (${readControlsOnly.toString()})(${JSON.stringify(priceViewTarget(target.query, 1, source))}, (${pageDom.toString()})(), parsePriceViewUrl,
      ${readPriceControls.toString()}); })()`;
}

/** @param {unknown} value @returns {object} Validated controls. @throws {ShoppingError} Page gates, TARGET_CHANGED or INVALID_RESPONSE. */
export function validatePriceControlsReply(value) {
  throwPageError(value?.state);
  if (value?.state !== 'observed' || !sameKeys(value, ['state', 'controls'])) throw new ShoppingError('INVALID_RESPONSE', 'The price control reply is invalid.');
  return validatePriceControls(value.controls);
}

/** Visible text of each supported source tab, and the filter-strip labels this skill may select (user scope 2026-10-13: 包邮 only). */
export const SEARCH_SOURCE_LABELS = Object.freeze({ tmall: '天猫' });
export const SEARCH_FILTER_LABELS = Object.freeze(['包邮']);

/**
 * Build one guarded click on the 天猫 source tab of the 所有宝贝 first page.
 * @param {object} target Canonical query root. @param {'tmall'} source @returns {string} Page expression.
 * @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS before any IO.
 */
export function pickSourceScript(target, source) {
  requireRoot(target);
  if (!Object.hasOwn(SEARCH_SOURCE_LABELS, source)) throw new ShoppingError('INVALID_ARGUMENTS', 'Only the 天猫 source tab can be selected.');
  return `(() => { ${scriptPrelude()} const sourceTabControl = ${sourceTabControl.toString()};
    return (${guardedClick.toString()})(${JSON.stringify(priceViewTarget(target.query, 1))}, ${JSON.stringify(SEARCH_SOURCE_LABELS[source])}, (${pageDom.toString()})(),
      parsePriceViewUrl, sourceTabControl); })()`;
}

/**
 * Build one guarded click on a supported filter-strip item of the first page in the given source.
 * @param {object} target @param {string} label One of SEARCH_FILTER_LABELS. @param {'all'|'tmall'} [source='all']
 * @returns {string} Page expression. @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS before any IO.
 */
export function pickFilterScript(target, label, source = 'all') {
  requireRoot(target);
  if (!SEARCH_FILTER_LABELS.includes(label)) throw new ShoppingError('INVALID_ARGUMENTS', 'Only the supported filter labels can be selected.');
  return `(() => { ${scriptPrelude()} const filterControl = ${filterControl.toString()};
    return (${guardedClick.toString()})(${JSON.stringify(priceViewTarget(target.query, 1, source))}, ${JSON.stringify(label)}, (${pageDom.toString()})(),
      parsePriceViewUrl, filterControl); })()`;
}

/**
 * Build one guarded click on a visible direction option inside the open price menu. Fixed labels only.
 * @param {object} target @param {string} label 从低到高 or 从高到低. @returns {string} Page expression.
 * @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS before any IO.
 */
export function pickPriceDirectionScript(target, label, source = 'all') {
  requireRoot(target);
  if (!OPTION_LABELS.includes(label)) throw new ShoppingError('INVALID_ARGUMENTS', 'Only the observed price direction labels can be selected.');
  return `(() => { ${scriptPrelude()} const directionOption = ${directionOption.toString()};
    return (${guardedClick.toString()})(${JSON.stringify(priceViewTarget(target.query, 1, source))}, ${JSON.stringify(label)}, (${pageDom.toString()})(),
      parsePriceViewUrl, directionOption); })()`;
}

/** @param {object} target @returns {string} One guarded click on the open range panel's 确定 control. @throws {ShoppingError} INVALID_SEARCH. */
export function confirmPriceRangeScript(target, source = 'all') {
  requireRoot(target);
  return `(() => { ${scriptPrelude()} const rangeConfirm = ${rangeConfirm.toString()};
    return (${guardedClick.toString()})(${JSON.stringify(priceViewTarget(target.query, 1, source))}, null, (${pageDom.toString()})(),
      parsePriceViewUrl, rangeConfirm); })()`;
}

/**
 * Build a read-only expression that returns a selector matching exactly one named sort-bar tab, for a pointer reference.
 * @param {object} target @param {'综合'|'价格'|'区间'} label @returns {string} Page expression. @throws {ShoppingError} Invalid inputs.
 */
export function priceTabSelectorScript(target, label, page = 1, source = 'all') {
  requireRoot(target);
  if (!Object.hasOwn(POINTER_TABS, label)) throw new ShoppingError('INVALID_ARGUMENTS', 'Pointer moves are limited to the 综合, 价格 and 区间 tabs.');
  return `(() => { ${scriptPrelude()} const actual = parsePriceViewUrl(location.href);
    if (!actual || actual.url !== ${JSON.stringify(priceViewTarget(target.query, page, source).url)}) return { state: 'target_changed' };
    return (${tabPointerSelector.toString()})(${JSON.stringify(label)}, ${JSON.stringify(POINTER_TABS[label])}, (${pageDom.toString()})()); })()`;
}

/** @param {unknown} value @returns {string} One of the fixed tab selectors. @throws {ShoppingError} Page gates or INVALID_RESPONSE. */
export function validatePriceTabSelector(value) {
  throwPageError(value?.state);
  const allowed = new Set();
  for (const container of new Set(Object.values(POINTER_TABS))) {
    for (let index = 1; index <= 8; index++) {
      allowed.add(`:is([class^="sortBarWrapper--"], [class*=" sortBarWrapper--"]) :is([class^="${container}--"], [class*=" ${container}--"]) [role="tab"]:nth-child(${index})`);
    }
  }
  if (value?.state !== 'selector_ready' || Object.keys(value).length !== 2 || !allowed.has(value.selector)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The tab pointer selector is not one of the fixed sort-bar forms.');
  }
  return value.selector;
}

/**
 * Pick the single pointer/fill reference for one fixed role and accessible name from a scoped snapshot.
 * @param {unknown} data Snapshot reply. @param {object} target Canonical root. @param {'tab'|'textbox'} role @param {string} name
 * @returns {string} Reference key. @throws {ShoppingError} TARGET_CHANGED or INVALID_RESPONSE.
 */
export function validatePriceReference(data, target, role, name, page = 1, source = 'all') {
  requireRoot(target);
  if (parsePriceViewUrl(data?.url)?.url !== priceViewTarget(target.query, page, source).url) {
    throw new ShoppingError('TARGET_CHANGED', 'The scoped reference no longer belongs to the saved search page.');
  }
  const refs = data?.snapshotData?.refs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs) || Object.keys(refs).length > 32) throw new ShoppingError('INVALID_RESPONSE', 'The scoped reference inventory is invalid.');
  const matches = Object.entries(refs).filter(([, ref]) => ref?.role === role && ref.name === name);
  if (matches.length !== 1 || !/^[a-zA-Z0-9_-]{1,32}$/.test(matches[0][0]) || !Number.isSafeInteger(matches[0][1].backendDOMNodeId) || matches[0][1].backendDOMNodeId < 1) {
    throw new ShoppingError('INVALID_RESPONSE', 'The scoped reference does not identify exactly one expected control.');
  }
  return matches[0][0];
}

/**
 * Validate a guarded click reply. Every non-dispatch reply is certain that nothing was clicked.
 * @param {unknown} value @returns {{clicked: true}} @throws {ShoppingError} Marked undispatched, or INVALID_RESPONSE when uncertain.
 */
export function validatePriceClickAcknowledgement(value) {
  if (value?.state === 'price_control_unavailable') {
    const error = new ShoppingError('PRICE_CONTROL_UNAVAILABLE', 'The expected price control was not visible; nothing was clicked.');
    error.actionNotDispatched = true;
    throw error;
  }
  try { throwPageError(value?.state); } catch (error) { error.actionNotDispatched = true; throw error; }
  if (value?.state !== 'action_dispatched' || value.clicked !== true || Object.keys(value).length !== 2) {
    throw new ShoppingError('INVALID_RESPONSE', 'The price control acknowledgement is invalid.');
  }
  return { clicked: true };
}

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/**
 * Validate price control evidence independently of key order (the daemon returns alphabetically ordered keys).
 * @param {unknown} value @returns {object} A new object in canonical key order. @throws {ShoppingError} INVALID_RESPONSE.
 */
export function validatePriceControls(value) {
  const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The price control evidence is invalid.');
  if (!sameKeys(value, CONTROL_KEYS) || CONTROL_KEYS.slice(0, 4).some(key => typeof value[key] !== 'boolean')) throw invalid();
  const menu = value.direction_menu, panel = value.range_panel;
  if (menu !== null && (!sameKeys(menu, ['options']) || !Array.isArray(menu.options) || menu.options.length !== 2 ||
      menu.options.some((option, index) => !sameKeys(option, ['label', 'emphasized']) ||
        option.label !== OPTION_LABELS[index] || typeof option.emphasized !== 'boolean'))) throw invalid();
  if (panel !== null && (!sameKeys(panel, ['minimum_text', 'maximum_text']) ||
      ['minimum_text', 'maximum_text'].some(key => typeof panel[key] !== 'string' || panel[key].length > 40))) throw invalid();
  const label = text => typeof text === 'string' && text.length > 0 && text.length <= 12;
  if (!(value.source_tab === null || label(value.source_tab)) ||
      !(value.selected_filters === null || (Array.isArray(value.selected_filters) && value.selected_filters.length <= 20 && value.selected_filters.every(label)))) throw invalid();
  return { comprehensive_selected: value.comprehensive_selected, sales_selected: value.sales_selected,
    price_selected: value.price_selected, range_selected: value.range_selected,
    direction_menu: menu && { options: menu.options.map(option => ({ label: option.label, emphasized: option.emphasized })) },
    range_panel: panel && { minimum_text: panel.minimum_text, maximum_text: panel.maximum_text },
    source_tab: value.source_tab, selected_filters: value.selected_filters && [...value.selected_filters] };
}

/**
 * Validate one raw first-page price view.
 * @param {unknown} value @param {object} target Canonical root.
 * @returns {{snapshot: {search: object, pagination: object}, controls: object}} Partial cards and price control state.
 * @throws {ShoppingError} Page gates, identity mismatch or invalid structure.
 */
export function validateSearchPriceObservation(value, target, page = 1, { allowPrevious = false, source = 'all', previousSource = null, cardLimit = PRICE_CARD_LIMIT } = {}) {
  requireRoot(target); requireCardLimit(cardLimit);
  if (((allowPrevious && page > 1) || previousSource) && value?.state === 'page_transition') return { transition: true, page_state: validPageState(value) };
  throwPageError(value?.state);
  const search = validateViewSearch(value, target, page, source, cardLimit);
  return { snapshot: { search, pagination: validatePagination(value?.pagination, page, null) }, controls: validatePriceControls(value?.controls),
    page_state: validPageState(value) };
}

function validPageState(value) {
  const shown = value?.page_state;
  if (!sameKeys(shown, ['visible', 'focused']) || typeof shown.visible !== 'boolean' || ![true, false, null].includes(shown.focused) ||
      (value.state === 'page_transition' && Object.keys(value).length !== 2)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The page visibility evidence is invalid.');
  }
  return { visible: shown.visible, focused: shown.focused };
}

// The shared search validators know only tab=all; a 天猫 view is checked against its tab=all twin and keeps its own address.
function validateViewSearch(value, target, page, source, cardLimit) {
  const view = priceViewTarget(target.query, page, source), base = priceViewTarget(target.query, page);
  const options = { cardLimit, ...(page > 1 ? { allowPageRange: true } : {}) };
  if (source === 'all') return validateSearch(value, view, options).result;
  if (value?.url !== view.url) throw new ShoppingError('INVALID_RESPONSE', 'The search response does not match the requested 天猫 view.');
  return { ...validateSearch({ ...value, url: base.url }, base, options).result, url: view.url };
}

/**
 * @param {unknown} value @param {object} target @param {number} [page=1] @param {string} [source='all']
 * @param {number} [cardLimit] The owning journal's cards per observation (25 or 50).
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for an invalid saved page snapshot.
 */
export function validatePriceSnapshot(value, target, page = 1, source = 'all', cardLimit = PRICE_CARD_LIMIT) {
  try {
    requireCardLimit(cardLimit);
    if (!value || Object.keys(value).join(',') !== 'search,pagination') throw new Error();
    const view = priceViewTarget(target.query, page, source), base = priceViewTarget(target.query, page);
    if (value.search?.url !== view.url) throw new Error();
    validateSavedSearch({ ...value.search, url: base.url }, base, { cardLimit, ...(page > 1 ? { allowPageRange: true } : {}) });
    if (JSON.stringify(validatePagination(value.pagination, page, null)) !== JSON.stringify(value.pagination)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved price view snapshot is invalid.'); }
}

const PACE_MS = 1500;
const ACTION_KINDS = new Set(['hover', 'pick_direction', 'fill', 'fill_range', 'confirm_range', 'next_page', 'pick_source', 'pick_filter']);
const READ_ALLOWANCE = Object.freeze({ baseline: 1, read: 2, settle: 4 });
// Reads that fail before returning an observation (connection, retries, interruption) still use the shared total.
const FAILED_READ_MARGIN = 6;
const STATE_KEYS = ['schema_version', 'request', 'plan', 'step', 'step_observations', 'observations', 'observation_limit', 'not_before',
  'actions', 'candidate', 'direction_applied', 'range_applied', 'evidence', 'before', 'after'];
// Schema 3 adds the reasons each returned observation did not count. Schema 4 types both range bounds in one step, records
// page visibility with each mismatch and allows one overlay reopen per step. Schemas 1-3 are kept only for their records.
// Schema 5 continues the applied sort and range onto result pages 2-5, then reopens the overlays on the last page read.
// Schema 6 first applies the 天猫 source and the 包邮 filter, in that order, and checks them in every later read.
// Schema 7 reads up to fifty cards per observation, as the first-screen search does; earlier schemas read twenty-five.
// Schema 8 lists unscanned cards and later pages as missing only when they exist; earlier schemas always list both.
const CURRENT_SCHEMA = 8;
const cardLimitOf = state => state.schema_version >= 7 ? PRICE_CARD_LIMIT : 25;
const PAGING_KEYS = ['requested_pages', 'current_page', 'pages', 'last_page_at', 'kept'];
const CONDITION_KEYS = ['conditions', 'conditions_view'];
const stateKeys = version => version >= 3 ? [...STATE_KEYS, 'mismatches', ...(version >= 4 ? ['reopens'] : []), ...(version >= 5 ? PAGING_KEYS : []),
  ...(version >= 6 ? CONDITION_KEYS : [])] : STATE_KEYS;
const NO_CONDITIONS = Object.freeze({ source: 'all', filters: Object.freeze([]) });
// A real pointer passing over the page can close a hover overlay; each overlay step may reopen it once, at most three times per task.
const MAX_REOPENS = 3;
const REOPEN_TRIGGERS = new Set(['action_unavailable', 'read_closed']);
const CLOSED_GAPS = new Set(['direction_menu_closed', 'range_panel_closed']);
const READ_OVERLAYS = Object.freeze({ direction_menu: '价格', direction_marked: '价格', range_panel_empty: '区间', range_filled: '区间', range_marked: '区间',
  direction_kept: '价格', range_kept: '区间' });
const MISMATCH_REASONS = new Set(['comprehensive_selected', 'comprehensive_not_selected', 'sales_selected', 'price_selected',
  'range_selected', 'range_not_selected', 'direction_menu_open', 'direction_menu_closed', 'range_panel_open', 'range_panel_closed',
  'list_unchanged', 'range_inputs_not_empty', 'range_bounds_not_shown', 'direction_not_marked', 'view_changed', 'page_not_reached', 'total_pages_changed',
  'source_not_default', 'filters_preselected', 'conditions_unreadable', 'source_not_applied', 'source_not_reached', 'filter_not_applied',
  'source_lost', 'filter_lost']);

const hasRange = request => request.price_range.minimum !== null || request.price_range.maximum !== null;
const hasPrice = request => request.price_sort !== null || hasRange(request);

/**
 * Canonical search conditions: the source tab and the supported filters in a fixed order.
 * @param {{source?: string, filters?: string[]}} [value] @returns {{source: 'all'|'tmall', filters: string[]}}
 * @throws {ShoppingError} INVALID_ARGUMENTS for an unsupported source, filter or duplicate.
 */
export function normalizeSearchConditions(value = {}) {
  const source = value.source ?? 'all', filters = value.filters ?? [];
  if (!['all', 'tmall'].includes(source) || !Array.isArray(filters) || new Set(filters).size !== filters.length ||
      filters.some(label => !SEARCH_FILTER_LABELS.includes(label))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Choose the 天猫 source and the 包邮 filter only.');
  }
  return { source, filters: SEARCH_FILTER_LABELS.filter(label => filters.includes(label)) };
}
const conditionsOf = state => state.schema_version >= 6 ? state.conditions : NO_CONDITIONS;
const hasConditions = conditions => conditions.source !== 'all' || conditions.filters.length > 0;
const allowance = step => step.kind === 'read' && step.expect === 'baseline' ? READ_ALLOWANCE.baseline : READ_ALLOWANCE[step.kind];

/** @param {object} step Plan step. @returns {string|null} The sort-bar tab whose hover opens the overlay this step needs. */
function overlayTab(step) {
  if (step.kind === 'pick_direction') return '价格';
  if (step.kind === 'fill_range' || step.kind === 'confirm_range') return '区间';
  return step.kind === 'read' ? READ_OVERLAYS[step.expect] ?? null : null;
}

/** @param {{amount: string, cents: number}} bound Canonical request bound. @returns {string} Shortest exact decimal text to type. */
export function priceBoundText(bound) {
  return String(bound.cents / 100);
}

/**
 * Derive the fixed step list for one price request.
 * Live behaviour (2026-10-12): hovering 价格 or 区间 opens its overlay and closes the other; hovering 综合 closes neither,
 * and an overlay reopens only when the pointer enters its tab again. So the pointer moves to 综合 before every entry.
 * Each applied state is verified by reopening its overlay. No pointer move or key closes an overlay, so the final
 * read accepts an open verification overlay; it does not change the cards or pagination.
 * @param {object} request createSearchPriceRequest output. @returns {object[]} Ordered read, settle and action steps.
 * @example searchPricePlan(createSearchPriceRequest({query:'鼠标',sort:'price-asc'}));
 */
export function searchPricePlan(request, schemaVersion = CURRENT_SCHEMA, pages = 1, conditions = NO_CONDITIONS) {
  const direction = request.price_sort, range = request.price_range;
  const steps = [{ kind: 'read', expect: 'baseline' }];
  // 天猫 clears selected filters (live 2026-10-13), so the source comes first, then the filters, then the price controls.
  if (schemaVersion >= 6 && conditions.source !== 'all') steps.push({ kind: 'pick_source', source: conditions.source }, { kind: 'settle', expect: 'source_applied' });
  if (schemaVersion >= 6) for (const label of conditions.filters) steps.push({ kind: 'pick_filter', label }, { kind: 'settle', expect: 'filter_applied', label });
  if (schemaVersion < 6 || hasPrice(request)) steps.push({ kind: 'hover', tab: '综合' });
  if (direction) {
    steps.push({ kind: 'hover', tab: '价格' }, { kind: 'read', expect: 'direction_menu' },
      { kind: 'pick_direction', label: PRICE_DIRECTION_LABELS[direction] }, { kind: 'settle', expect: 'direction_applied' });
  }
  if (hasRange(request)) {
    steps.push({ kind: 'hover', tab: '综合' }, { kind: 'hover', tab: '区间' }, { kind: 'read', expect: 'range_panel_empty' });
    const fields = ['minimum', 'maximum'].filter(field => range[field]).map(field => ({ field, text: priceBoundText(range[field]) }));
    // Typing both bounds back to back leaves the open panel as short a window as possible (live 2026-10-13: it closed between two paced fills).
    if (schemaVersion >= 4) steps.push({ kind: 'fill_range', fields });
    else for (const { field, text } of fields) steps.push({ kind: 'fill', field, text });
    steps.push({ kind: 'read', expect: 'range_filled' }, { kind: 'confirm_range' }, { kind: 'settle', expect: 'range_applied' },
      { kind: 'hover', tab: '综合' }, { kind: 'hover', tab: '区间' }, { kind: 'read', expect: 'range_marked' });
  }
  if (direction) steps.push({ kind: 'hover', tab: '综合' }, { kind: 'hover', tab: '价格' }, { kind: 'read', expect: 'direction_marked' });
  // Schema 1 (first live runs) wrongly assumed 综合 closes overlays and moved there once more before the final read.
  if (schemaVersion === 1) steps.push({ kind: 'hover', tab: '综合' });
  steps.push({ kind: 'settle', expect: 'final' });
  if (schemaVersion >= 5 && pages > 1) {
    for (let page = 2; page <= pages; page++) steps.push({ kind: 'next_page', page }, { kind: 'settle', expect: 'page_turned', page });
    // The last page read is checked again by reopening each applied overlay, in the same order as on page 1.
    if (hasRange(request)) steps.push({ kind: 'hover', tab: '综合' }, { kind: 'hover', tab: '区间' }, { kind: 'read', expect: 'range_kept' });
    if (direction) steps.push({ kind: 'hover', tab: '综合' }, { kind: 'hover', tab: '价格' }, { kind: 'read', expect: 'direction_kept' });
  }
  return steps;
}

/**
 * @param {object} request createSearchPriceRequest output. @param {number} [schemaVersion] Only validation rebuilds older schemas.
 * @returns {object} New durable step journal; no IO.
 */
export function newSearchPriceState(request, schemaVersion = CURRENT_SCHEMA, { pages = 1, conditions } = {}) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 5 || (pages > 1 && schemaVersion < 5)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A price task reads one to five result pages.');
  }
  const canonical = normalizeSearchConditions(conditions);
  if ((hasConditions(canonical) && schemaVersion < 6) || (!hasPrice(request) && !hasConditions(canonical))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Request a price direction, a price boundary, the 天猫 source or the 包邮 filter.');
  }
  const plan = searchPricePlan(request, schemaVersion, pages, canonical);
  return { schema_version: schemaVersion, request: structuredClone(request), plan, step: 0, step_observations: 0, observations: 0,
    observation_limit: plan.filter(step => !ACTION_KINDS.has(step.kind)).reduce((total, step) => total + allowance(step), FAILED_READ_MARGIN),
    not_before: 0, actions: [], candidate: null, direction_applied: null, range_applied: null,
    evidence: { direction: null, range: null }, before: null, after: null,
    ...(schemaVersion >= 3 ? { mismatches: [] } : {}), ...(schemaVersion >= 4 ? { reopens: [] } : {}),
    ...(schemaVersion >= 5 ? { requested_pages: pages, current_page: 1, pages: [], last_page_at: null, kept: { direction: null, range: null } } : {}),
    ...(schemaVersion >= 6 ? { conditions: canonical, conditions_view: null } : {}) };
}

const summary = snapshot => ({ product_ids: snapshot.search.items.map(item => item.product_id),
  total_pages_displayed: snapshot.pagination.total_pages_displayed });
const sameView = (a, b) => JSON.stringify(summary(a)) === JSON.stringify(summary(b));
const changedFrom = (previous, snapshot) => JSON.stringify(previous) !== JSON.stringify(summary(snapshot));

function textCents(text) {
  try { return parseCnyAmount(text).cents; } catch { return null; }
}

function boundsShown(panel, range) {
  return ['minimum', 'maximum'].every(field => range[field] === null ? panel[`${field}_text`] === ''
    : textCents(panel[`${field}_text`]) === range[field].cents);
}

/**
 * List the fixed reason codes for every condition a step expects but the observation does not show. Pure; no IO.
 * @param {string} expect Step expectation. @param {{snapshot: object, controls: object}} observation @param {object} state Journal.
 * @returns {string[]} Reason codes in a fixed evaluation order; empty when the expectation is met.
 */
export function priceExpectationGaps(expect, observation, state) {
  return [...new Set([...priceGaps(expect, observation, state), ...conditionGaps(expect, observation, state)])];
}

// Schema 6: a default start, the requested source and filters once applied, and none of them lost afterwards.
function conditionGaps(expect, observation, state) {
  if (state.schema_version < 6) return [];
  const { source, filters } = state.conditions, controls = observation.controls, gaps = [];
  if (expect === 'baseline') {
    if (controls.source_tab !== null && controls.source_tab !== '所有宝贝') gaps.push('source_not_default');
    if (controls.selected_filters?.length) gaps.push('filters_preselected');
    if (hasConditions(state.conditions) && (controls.source_tab === null || controls.selected_filters === null)) gaps.push('conditions_unreadable');
    return gaps;
  }
  if (source !== 'all') {
    const shown = controls.source_tab === SEARCH_SOURCE_LABELS[source];
    if (expect === 'source_applied') return shown ? [] : ['source_not_applied'];
    if (!shown && stepDone(state, step => step.expect === 'source_applied')) gaps.push('source_lost');
  }
  const current = state.plan[state.step];
  for (const label of filters) {
    const shown = Boolean(controls.selected_filters?.includes(label));
    if (expect === 'filter_applied' && current.label === label) { if (!shown) gaps.push('filter_not_applied'); }
    else if (!shown && stepDone(state, step => step.expect === 'filter_applied' && step.label === label)) gaps.push('filter_lost');
  }
  return gaps;
}

function priceGaps(expect, observation, state) {
  const controls = observation.controls, gaps = [];
  const direction = state.request.price_sort, range = state.request.price_range, ranged = hasRange(state.request);
  const require = (condition, code) => { if (!condition) gaps.push(code); };
  const menuClosed = () => require(!controls.direction_menu, 'direction_menu_open');
  const panelClosed = () => require(!controls.range_panel, 'range_panel_open');
  switch (expect) {
    case 'baseline':
      require(controls.comprehensive_selected, 'comprehensive_not_selected'); require(!controls.sales_selected, 'sales_selected');
      require(!controls.price_selected, 'price_selected'); require(!controls.range_selected, 'range_selected'); menuClosed(); panelClosed();
      break;
    case 'direction_menu': require(Boolean(controls.direction_menu), 'direction_menu_closed'); break;
    // The comprehensive tab losing its selection is the persistent marker; the list must also have reloaded. The menu may
    // reopen after the click while the pointer still rests on 价格 (live 2026-10-12), so an open hover overlay is allowed.
    case 'direction_applied':
      require(!controls.comprehensive_selected, 'comprehensive_selected'); require(!controls.sales_selected, 'sales_selected');
      require(!controls.range_selected, 'range_selected');
      require(changedFrom(state.schema_version >= 6 && state.conditions_view ? state.conditions_view : summary(state.before), observation.snapshot), 'list_unchanged');
      break;
    // The source and filter markers themselves are checked with the other conditions.
    case 'source_applied':
    case 'filter_applied':
      break;
    case 'range_panel_empty':
      if (!controls.range_panel) gaps.push('range_panel_closed');
      else require(controls.range_panel.minimum_text === '' && controls.range_panel.maximum_text === '', 'range_inputs_not_empty');
      break;
    case 'range_filled':
      if (!controls.range_panel) gaps.push('range_panel_closed');
      else require(boundsShown(controls.range_panel, range), 'range_bounds_not_shown');
      break;
    case 'range_applied':
      require(controls.range_selected, 'range_not_selected'); require(!controls.sales_selected, 'sales_selected');
      if (direction) require(!controls.comprehensive_selected, 'comprehensive_selected');
      break;
    // A later page keeps the applied view: same total, 综合 still unselected, the range still selected and new cards.
    case 'page_turned': {
      const step = state.plan[state.step], previous = state.pages.at(-1) ?? state.after;
      if (observation.snapshot.pagination.current_page !== step.page) gaps.push('page_not_reached');
      require(observation.snapshot.pagination.total_pages_displayed === state.after.pagination.total_pages_displayed, 'total_pages_changed');
      require(!controls.sales_selected, 'sales_selected');
      if (direction) require(!controls.comprehensive_selected, 'comprehensive_selected');
      if (ranged) require(controls.range_selected, 'range_not_selected');
      require(changedFrom(summary(previous), observation.snapshot), 'list_unchanged');
      break;
    }
    case 'range_marked':
    case 'range_kept':
      require(controls.range_selected, 'range_not_selected');
      if (!controls.range_panel) gaps.push('range_panel_closed');
      else require(boundsShown(controls.range_panel, range), 'range_bounds_not_shown');
      break;
    case 'direction_marked':
    case 'direction_kept': {
      if (!controls.direction_menu) { gaps.push('direction_menu_closed'); break; }
      require(!controls.comprehensive_selected, 'comprehensive_selected');
      if (ranged) require(controls.range_selected, 'range_not_selected');
      const emphasized = controls.direction_menu.options.filter(option => option.emphasized);
      require(emphasized.length === 1 && emphasized[0].label === PRICE_DIRECTION_LABELS[direction], 'direction_not_marked');
      break;
    }
    case 'final':
      require(!controls.sales_selected, 'sales_selected');
      if (direction) require(!controls.comprehensive_selected, 'comprehensive_selected');
      if (ranged) require(controls.range_selected, 'range_not_selected');
      break;
    default: throw new ShoppingError('INVALID_CHECKPOINT', 'Unknown price step expectation.');
  }
  return gaps;
}

/** @param {string} expect @param {object} observation @param {object} state @returns {boolean} Whether no expected condition is missing. */
export function meetsPriceExpectation(expect, observation, state) {
  return priceExpectationGaps(expect, observation, state).length === 0;
}

function describeTarget(step) {
  if (step.kind === 'fill_range') return step.fields.map(({ field, text }) => `${field}:${text}`).join(',');
  if (step.kind === 'next_page') return `page:${step.page}`;
  if (step.kind === 'pick_source') return SEARCH_SOURCE_LABELS[step.source];
  if (step.kind === 'pick_filter') return step.label;
  return step.kind === 'hover' ? step.tab : step.kind === 'pick_direction' ? step.label : step.kind === 'fill' ? `${step.field}:${step.text}` : '确定';
}

function stepIndex(state, expect) { return state.plan.findIndex(step => step.expect === expect); }

/**
 * Validate a saved journal against its request, plan, counters and the evidence each completed step must have produced.
 * @param {object} state @param {object} target Canonical query root. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateSearchPriceState(state, target) {
  try {
    requireRoot(target);
    if (!state || ![1, 2, 3, 4, 5, 6, 7, CURRENT_SCHEMA].includes(state.schema_version) || Object.keys(state).join(',') !== stateKeys(state.schema_version).join(',')) throw new Error();
    const request = state.request, range = request?.price_range;
    const conditions = state.schema_version >= 6 ? normalizeSearchConditions(state.conditions) : NO_CONDITIONS;
    const canonical = createSearchPriceRequest({ query: target.query, sort: request?.price_sort ?? null,
      minPrice: range?.minimum?.amount ?? null, maxPrice: range?.maximum?.amount ?? null }, { allowNoPrice: hasConditions(conditions) });
    const fresh = newSearchPriceState(canonical, state.schema_version, { pages: state.schema_version >= 5 ? state.requested_pages : 1,
      ...(state.schema_version >= 6 ? { conditions } : {}) });
    if (JSON.stringify(request) !== JSON.stringify(canonical) || JSON.stringify(state.plan) !== JSON.stringify(fresh.plan) ||
        state.observation_limit !== fresh.observation_limit || (state.schema_version >= 6 && JSON.stringify(state.conditions) !== JSON.stringify(conditions))) throw new Error();
    const steps = state.plan.length;
    if (!Number.isInteger(state.step) || state.step < 0 || state.step > steps ||
        !Number.isInteger(state.observations) || state.observations < 0 || state.observations > state.observation_limit ||
        !Number.isSafeInteger(state.not_before) || state.not_before < 0 || !Array.isArray(state.actions)) throw new Error();
    const current = state.plan[state.step];
    const maximum = current && !ACTION_KINDS.has(current.kind) ? allowance(current) : 0;
    if (!Number.isInteger(state.step_observations) || state.step_observations < 0 || state.step_observations > maximum) throw new Error();
    // Completed action steps each have one final record; only the current step may hold an unresolved reservation.
    // Page steps beyond an early last page were skipped and have none.
    const completed = state.plan.map((step, index) => ({ step, index }))
      .filter(({ step, index }) => ACTION_KINDS.has(step.kind) && index < state.step && !skippedPageStep(state, step));
    const reserved = current && ACTION_KINDS.has(current.kind) ? state.actions.slice(completed.length) : [];
    if (state.actions.length !== completed.length + reserved.length || reserved.length > 1) throw new Error();
    state.actions.forEach((action, position) => {
      const index = position < completed.length ? completed[position].index : state.step;
      const finalStatus = position < completed.length;
      if (!action || Object.keys(action).join(',') !== 'step,kind,status,acknowledgement_error' || action.step !== index ||
          action.kind !== state.plan[index].kind ||
          (finalStatus ? !['acknowledged', 'uncertain'].includes(action.status) : action.status !== 'reserved') ||
          !(action.acknowledgement_error === null ? action.status !== 'uncertain'
            : action.status === 'uncertain' && /^[A-Z][A-Z0-9_]{0,63}$/.test(action.acknowledgement_error))) throw new Error();
    });
    const done = expect => { const index = stepIndex(state, expect); return index >= 0 && index < state.step; };
    if ((state.before !== null) !== (state.step > 0)) throw new Error();
    if (state.before) validatePriceSnapshot(state.before, target, 1, 'all', cardLimitOf(state));
    if (state.candidate !== null) {
      if (current?.kind !== 'settle' || state.step_observations < 1) throw new Error();
      validatePriceSnapshot(state.candidate, target, current.page ?? 1, readSource(state, current), cardLimitOf(state));
    }
    for (const expect of ['direction_applied', 'range_applied']) {
      const value = state[expect];
      if ((value !== null) !== done(expect)) throw new Error();
      if (value && (Object.keys(value).join(',') !== 'product_ids,total_pages_displayed' || !Array.isArray(value.product_ids) ||
          value.product_ids.some(id => typeof id !== 'string' || !/^[0-9]{1,64}$/.test(id)) || !Number.isSafeInteger(value.total_pages_displayed))) throw new Error();
    }
    if (state.direction_applied && JSON.stringify(state.direction_applied) === JSON.stringify(state.conditions_view ?? summary(state.before))) throw new Error();
    if (!state.evidence || Object.keys(state.evidence).join(',') !== 'direction,range') throw new Error();
    const direction = state.evidence.direction, shown = state.evidence.range;
    if ((direction !== null) !== done('direction_marked') || (shown !== null) !== done('range_marked')) throw new Error();
    if (direction && (Object.keys(direction).join(',') !== 'emphasized_label' || direction.emphasized_label !== PRICE_DIRECTION_LABELS[request.price_sort])) throw new Error();
    if (shown && (Object.keys(shown).join(',') !== 'minimum_text,maximum_text' || !boundsShown(shown, range))) throw new Error();
    if ((state.after !== null) !== done('final')) throw new Error();
    if (state.after) validatePriceSnapshot(state.after, target, 1, currentSource(state), cardLimitOf(state));
    if (state.schema_version >= 5) validatePaging(state, target, done);
    if (state.schema_version >= 6) {
      const settled = state.plan.some((step, index) => index < state.step && ['source_applied', 'filter_applied'].includes(step.expect));
      const view = state.conditions_view;
      if ((view !== null) !== settled || (view && (Object.keys(view).join(',') !== 'product_ids,total_pages_displayed' || !Array.isArray(view.product_ids) ||
          view.product_ids.some(id => typeof id !== 'string' || !/^[0-9]{1,64}$/.test(id)) || !Number.isSafeInteger(view.total_pages_displayed)))) throw new Error();
    }
    if (state.schema_version >= 3) validateMismatches(state);
    if (state.schema_version >= 4) validateReopens(state);
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The bounded price journal is invalid.'); }
}

function stepDone(state, predicate) {
  const index = state.plan.findIndex(predicate);
  return index >= 0 && index < state.step;
}

// The source a read or action expects: 天猫 once its settle step has confirmed it (and while confirming it), otherwise 所有宝贝.
function currentSource(state) {
  const source = conditionsOf(state).source;
  return source !== 'all' && stepDone(state, step => step.expect === 'source_applied') ? source : 'all';
}
function readSource(state, step) {
  return step?.expect === 'source_applied' ? conditionsOf(state).source : currentSource(state);
}

function skippedPageStep(state, step) {
  return state.schema_version >= 5 && state.last_page_at !== null && step.page > state.last_page_at;
}

// The first step after every page step: the last-page overlay checks.
function afterPageSteps(state) {
  const last = state.plan.findLastIndex(step => step.page !== undefined);
  return last < 0 ? state.plan.length : last + 1;
}

function validatePaging(state, target, done) {
  const { requested_pages: requested, current_page: current, pages, last_page_at: last, kept } = state;
  if (!Number.isInteger(current) || current < 1 || current > requested || !Array.isArray(pages) || pages.length !== current - 1) throw new Error();
  pages.forEach((snapshot, index) => validatePriceSnapshot(snapshot, target, index + 2, currentSource(state), cardLimitOf(state)));
  const turned = state.plan.filter((step, index) => step.expect === 'page_turned' && index < state.step && !skippedPageStep(state, step)).length;
  if (turned !== current - 1) throw new Error();
  if (last !== null && (last !== current || current >= requested || state.step < afterPageSteps(state))) throw new Error();
  if (!kept || Object.keys(kept).join(',') !== 'direction,range') throw new Error();
  if ((kept.direction !== null) !== done('direction_kept') || (kept.range !== null) !== done('range_kept')) throw new Error();
  if (kept.direction && (Object.keys(kept.direction).join(',') !== 'emphasized_label' ||
      kept.direction.emphasized_label !== PRICE_DIRECTION_LABELS[state.request.price_sort])) throw new Error();
  if (kept.range && (Object.keys(kept.range).join(',') !== 'minimum_text,maximum_text' || !boundsShown(kept.range, state.request.price_range))) throw new Error();
}

function validateMismatches(state) {
  if (!Array.isArray(state.mismatches) || state.mismatches.length > state.observation_limit) throw new Error();
  let previous = 0;
  for (const entry of state.mismatches) {
    const step = state.plan[entry?.step];
    const keys = state.schema_version >= 4 ? 'step,expect,observation,reasons,page' : 'step,expect,observation,reasons';
    if (!entry || Object.keys(entry).join(',') !== keys || !Number.isInteger(entry.step) ||
        (state.schema_version >= 4 && (Object.keys(entry.page ?? {}).join(',') !== 'visible,focused' || typeof entry.page.visible !== 'boolean' ||
          ![true, false, null].includes(entry.page.focused))) ||
        entry.step > state.step || !step || ACTION_KINDS.has(step.kind) || step.expect !== entry.expect ||
        !Number.isInteger(entry.observation) || entry.observation <= previous || entry.observation > state.observations ||
        !Array.isArray(entry.reasons) || entry.reasons.length < 1 || entry.reasons.length > 8 ||
        new Set(entry.reasons).size !== entry.reasons.length || entry.reasons.some(reason => !MISMATCH_REASONS.has(reason)) ||
        (entry.reasons.includes('view_changed') && (step.kind !== 'settle' || entry.reasons.length !== 1))) throw new Error();
    previous = entry.observation;
  }
}

// Each reopen is two pointer moves (综合, then the overlay's tab) recorded like actions: reserved before dispatch, final after.
function validateReopens(state) {
  if (!Array.isArray(state.reopens) || state.reopens.length > MAX_REOPENS) throw new Error();
  const steps = new Set();
  state.reopens.forEach((reopen, position) => {
    const step = state.plan[reopen?.step], last = position === state.reopens.length - 1;
    if (!reopen || Object.keys(reopen).join(',') !== 'step,trigger,hovers' || !Number.isInteger(reopen.step) || reopen.step > state.step ||
        !step || !overlayTab(step) || steps.has(reopen.step) || !REOPEN_TRIGGERS.has(reopen.trigger) ||
        (reopen.trigger === 'read_closed') !== (step.kind === 'read') || !Array.isArray(reopen.hovers) || reopen.hovers.length < 1 ||
        reopen.hovers.length > 2 || (reopen.hovers.length < 2 && !(last && reopen.step === state.step))) throw new Error();
    steps.add(reopen.step);
    reopen.hovers.forEach((hover, index) => {
      const open = last && reopen.step === state.step && index === reopen.hovers.length - 1;
      if (!hover || Object.keys(hover).join(',') !== 'tab,status,acknowledgement_error' || hover.tab !== ['综合', overlayTab(step)][index] ||
          !(hover.status === 'reserved' ? open && hover.acknowledgement_error === null
            : hover.status === 'acknowledged' ? hover.acknowledgement_error === null
              : hover.status === 'uncertain' && /^[A-Z][A-Z0-9_]{0,63}$/.test(hover.acknowledgement_error ?? ''))) throw new Error();
    });
  });
}

/**
 * Build the delivered result: UI-applied evidence, the platform-order snapshot, displayed-price checks and a local reorder.
 * @param {object} target @param {object} state Completed journal. @returns {object} Partial first-page result.
 */
export function searchPriceResult(target, state) {
  const request = state.request, direction = request.price_sort, range = request.price_range;
  // Results with more than one page keep the same shape as before plus the paging fields; one-page results are unchanged.
  const paged = state.schema_version >= 5 && state.requested_pages > 1;
  const snapshots = [state.after.search, ...(paged ? state.pages.map(page => page.search) : [])];
  const assessment = assessDisplayedPrices(snapshots, request), localDirection = direction ?? 'price-asc';
  return { schema_version: 1, query: target.query, source: 'bounded_search_price', request: structuredClone(request),
    before: state.before, after: state.after,
    applied: {
      price_sort: direction === null ? null : { direction, option_label: PRICE_DIRECTION_LABELS[direction], comprehensive_deselected: true,
        marked_option: state.evidence.direction.emphasized_label, marker: 'computed_font_weight' },
      price_range: hasRange(request) ? { minimum: range.minimum, maximum: range.maximum, range_tab_selected: true,
        reopened_input_text: state.evidence.range } : null,
      // Each condition was confirmed on page 1 and re-checked in every later read, including each page turned to.
      ...(hasConditions(conditionsOf(state)) ? {
        source: conditionsOf(state).source === 'all' ? null : { source: conditionsOf(state).source, tab_label: SEARCH_SOURCE_LABELS[conditionsOf(state).source],
          marker: 'active_tab_class', address_tab: SOURCES[conditionsOf(state).source] },
        filters: conditionsOf(state).filters.map(label => ({ label, marker: 'selected_class' })) } : {}),
    },
    coverage: { status: 'partial', platform_ui_applied: true, url_reflects_state: false, sort_verified: false,
      filters_verified: false, total_results_known: false },
    ...(paged ? { pages: state.pages, paging: { requested_pages: state.requested_pages, pages_read: state.current_page,
      end_reason: state.last_page_at === null ? 'requested_pages' : 'last_page', total_pages_displayed: state.after.pagination.total_pages_displayed,
      last_page_checks: { page: state.current_page, marked_option: state.kept.direction?.emphasized_label ?? null, reopened_input_text: state.kept.range } } } : {}),
    displayed_price_check: { scope: paged ? 'read_pages_displayed_prices' : 'final_first_page_displayed_prices', order_check: assessment.order_check,
      range_check: assessment.range_check, overall_status: hasPrice(request) ? assessment.overall_status : 'not_requested' },
    displayed_price_order: { basis: 'displayed_single_prices', direction: localDirection, platform_order: false,
      records: localPriceOrder(assessment.records, localDirection) },
    limits: { pages: paged ? state.requested_pages : 1, cards_per_observation: cardLimitOf(state) },
    action_evidence: { actions: state.actions.map(action => ({ kind: action.kind, target: describeTarget(state.plan[action.step]),
      status: action.status, acknowledgement_error: action.acknowledgement_error })),
      observations_reserved: state.observations, observation_limit: state.observation_limit, mismatches: state.mismatches,
      ...(state.schema_version >= 4 ? { overlay_reopens: state.reopens } : {}) },
    missing: missingFrom(state, snapshots, paged), login_verified: false };
}

function missingFrom(state, snapshots, paged) {
  const exact = state.schema_version >= 8;
  const unscanned = !exact || snapshots.some(snapshot => snapshot.cards_seen > snapshot.cards_scanned);
  // Only a multi-page read verifies the last page; a one-page result never checks whether more pages follow.
  const laterPages = !exact || !paged || state.last_page_at === null;
  return ['platform_price_basis', ...(unscanned ? ['unscanned_cards'] : []), ...(laterPages ? ['subsequent_pages'] : []), 'verified_payable_prices'];
}

/** @param {object} value @param {object} target @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT if the result differs from its journal. */
export function validateSearchPriceResult(value, target, state) {
  validateSearchPriceState(state, target);
  if (!state.after || JSON.stringify(value) !== JSON.stringify(searchPriceResult(target, state))) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The price result does not match its journal.');
  }
}

function dispatchPriceAction(bridge, op, step, state) {
  const source = currentSource(state);
  if (step.kind === 'pick_source') return bridge.pickSearchSource(op.tab_id, op.target, step.source);
  if (step.kind === 'pick_filter') return bridge.pickSearchFilter(op.tab_id, op.target, step.label, source);
  if (step.kind === 'hover') return bridge.hoverPriceTab(op.tab_id, op.target, step.tab, state.current_page, source);
  if (step.kind === 'next_page') {
    const confirmed = state.pages.at(-1) ?? state.after;
    return bridge.nextPricePage(op.tab_id, op.target, { page: state.current_page, product_ids: confirmed.search.items.map(item => item.product_id), source },
      { cardLimit: cardLimitOf(state) });
  }
  if (step.kind === 'pick_direction') return bridge.pickPriceDirection(op.tab_id, op.target, step.label, source);
  if (step.kind === 'fill_range') return bridge.fillPriceRange(op.tab_id, op.target, step.fields, source);
  return bridge.confirmPriceRange(op.tab_id, op.target, source);
}

function mayReopen(state, step) {
  return state.schema_version >= 4 && overlayTab(step) !== null && state.reopens.length < MAX_REOPENS &&
    !state.reopens.some(reopen => reopen.step === state.step);
}

function reopenInProgress(state) {
  const last = state.reopens?.at(-1);
  return Boolean(last) && last.step === state.step && (last.hovers.length < 2 || last.hovers.at(-1).status === 'reserved');
}

/**
 * Move the pointer to 综合 and back onto the overlay's tab, once for this step. Each move is saved before it is sent;
 * an interrupted move is resolved as uncertain and never resent.
 */
async function reopenOverlay(state, step, trigger, { bridge, op, commit, now, wait }) {
  const tabs = ['综合', overlayTab(step)];
  let record = reopenInProgress(state) ? state.reopens.at(-1) : null;
  while (!record || record.hovers.length < tabs.length || record.hovers.at(-1).status === 'reserved') {
    const pending = record?.hovers.at(-1);
    if (pending?.status === 'reserved') {
      // A previous process saved this move and stopped before its outcome: resolve it as uncertain, never resend it.
      pending.status = 'uncertain'; pending.acknowledgement_error = 'READ_INTERRUPTED'; await commit(); continue;
    }
    const delay = state.not_before - now();
    if (delay > 0) await wait(delay);
    const hover = { tab: tabs[record?.hovers.length ?? 0], status: 'reserved', acknowledgement_error: null };
    if (!record) { record = { step: state.step, trigger, hovers: [] }; state.reopens.push(record); }
    record.hovers.push(hover); await commit();
    try { await bridge.hoverPriceTab(op.tab_id, op.target, hover.tab, state.current_page, currentSource(state)); hover.status = 'acknowledged'; }
    catch (error) {
      if (!error.actionNotDispatched) { hover.status = 'uncertain'; hover.acknowledgement_error = publicError(error).code; }
      else {
        record.hovers.pop();
        if (!record.hovers.length) state.reopens.pop();
        await commit(); throw error;
      }
    }
    state.not_before = now() + PACE_MS; await commit();
  }
}

function advance(state, now) {
  state.step += 1; state.step_observations = 0; state.candidate = null; state.not_before = now() + PACE_MS;
}

async function performAction(state, step, context) {
  const { bridge, op, commit, now } = context;
  const last = state.actions.at(-1);
  if (last?.step === state.step) {
    // A previous process saved this intent and stopped before recording its outcome: observe, never redispatch.
    last.status = 'uncertain'; last.acknowledgement_error = 'READ_INTERRUPTED';
  } else {
    const action = { step: state.step, kind: step.kind, status: 'reserved', acknowledgement_error: null };
    state.actions.push(action);
    await commit();
    try { await dispatchPriceAction(bridge, op, step, state); action.status = 'acknowledged'; }
    catch (error) {
      if (!error.actionNotDispatched) { action.status = 'uncertain'; action.acknowledgement_error = publicError(error).code; }
      else {
        state.actions.pop(); await commit();
        // The overlay closed before anything was sent: reopen it once, then the loop retries this same step.
        if (error.code === 'PRICE_CONTROL_UNAVAILABLE' && mayReopen(state, step)) return reopenOverlay(state, step, 'action_unavailable', context);
        // Fewer result pages than requested: keep the pages read and go straight to the last-page checks.
        if (error.code === 'LAST_PAGE_REACHED' && step.kind === 'next_page') {
          state.last_page_at = state.current_page; state.step = afterPageSteps(state);
          state.step_observations = 0; state.candidate = null; state.not_before = now() + PACE_MS;
          return commit();
        }
        throw error;
      }
    }
  }
  advance(state, now);
  await commit();
}

function exhausted(step) {
  if (step.expect === 'baseline') return new ShoppingError('PRICE_START_STATE_UNSUPPORTED', 'Start from the default comprehensive, unfiltered first search page with no price overlay open.');
  if (step.kind === 'settle') return new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'The applied price state could not be confirmed; no action will be repeated.');
  return new ShoppingError('PRICE_CONTROL_NOT_CONFIRMED', 'The expected price control state was not observed; no further action was sent.');
}

async function observeStep(state, step, context) {
  const { bridge, op, commit, now } = context;
  if (state.step_observations >= allowance(step)) throw exhausted(step);
  if (state.observations >= state.observation_limit) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The price observation allowance was exhausted.');
  // The shared total is reserved before IO; the step allowance counts only observations that were actually returned.
  state.observations += 1; state.not_before = now() + PACE_MS;
  await commit();
  const turning = step.expect === 'page_turned', switching = step.expect === 'source_applied';
  const observation = await bridge.readSearchPrice(op.tab_id, op.target, turning ? step.page : state.current_page,
    { allowPrevious: turning, source: readSource(state, step), previousSource: switching ? 'all' : null, cardLimit: cardLimitOf(state) });
  state.step_observations += 1; state.not_before = now() + PACE_MS; op.recovery_kind = null;
  const mismatch = reasons => state.mismatches.push({ step: state.step, expect: step.expect, observation: state.observations, reasons,
    ...(state.schema_version >= 4 ? { page: observation.page_state } : {}) });
  if (observation.transition) {
    mismatch([switching ? 'source_not_reached' : 'page_not_reached']); state.candidate = null;
    return commit();
  }
  const gaps = priceExpectationGaps(step.expect, observation, state);
  if (step.kind === 'read') {
    if (gaps.some(gap => CLOSED_GAPS.has(gap)) && mayReopen(state, step) && state.step_observations < allowance(step)) {
      mismatch(gaps); await commit();
      return reopenOverlay(state, step, 'read_closed', context);
    }
    if (!gaps.length) {
      if (step.expect === 'baseline') state.before = observation.snapshot;
      if (step.expect === 'direction_marked') state.evidence.direction = { emphasized_label: PRICE_DIRECTION_LABELS[state.request.price_sort] };
      if (step.expect === 'range_marked') state.evidence.range = { minimum_text: observation.controls.range_panel.minimum_text,
        maximum_text: observation.controls.range_panel.maximum_text };
      if (step.expect === 'direction_kept') state.kept.direction = { emphasized_label: PRICE_DIRECTION_LABELS[state.request.price_sort] };
      if (step.expect === 'range_kept') state.kept.range = { minimum_text: observation.controls.range_panel.minimum_text,
        maximum_text: observation.controls.range_panel.maximum_text };
      advance(state, now);
    } else mismatch(gaps);
  } else if (gaps.length) {
    mismatch(gaps); state.candidate = null;
  } else if (state.candidate && sameView(state.candidate, observation.snapshot)) {
    if (step.expect === 'final') state.after = observation.snapshot;
    else if (turning) { state.pages.push(observation.snapshot); state.current_page = step.page; }
    else if (['source_applied', 'filter_applied'].includes(step.expect)) state.conditions_view = summary(observation.snapshot);
    else state[step.expect] = summary(observation.snapshot);
    advance(state, now);
  } else {
    if (state.candidate) mismatch(['view_changed']);
    state.candidate = observation.snapshot;
  }
  await commit();
}

/**
 * Apply one requested price direction and/or range on the saved first search page, confirming each state without redispatch.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} UI-applied evidence and partial first-page snapshots; platform price basis remains unverified.
 * @throws {ShoppingError} Page gates, start-state, control, outcome or allowance failures.
 */
export async function runSearchPrice(context) {
  const state = context.op.search_price;
  // Schemas 6 and 7 differ from 8 only in their card scope and missing labels, so a journal started under them may finish as it began.
  if (![6, 7, CURRENT_SCHEMA].includes(state.schema_version)) throw new ShoppingError('LEGACY_PRICE_PLAN', 'This journal uses a superseded schema; it is kept for its record and is not executed.');
  while (state.step < state.plan.length) {
    const delay = state.not_before - context.now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved price wait is inconsistent.');
      await context.wait(delay); continue;
    }
    const step = state.plan[state.step];
    if (reopenInProgress(state)) await reopenOverlay(state, step, null, context);
    else if (ACTION_KINDS.has(step.kind)) await performAction(state, step, context);
    else await observeStep(state, step, context);
  }
  return searchPriceResult(context.op.target, state);
}
