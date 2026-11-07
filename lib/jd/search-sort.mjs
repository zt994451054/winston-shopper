import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { JD_SEARCH_CARD_LIMIT, collectJdSearch } from './search.mjs';
import { collectJdSearchPager, validateJdSearchPage } from './search-pages.mjs';
import { jdSearchTarget } from './targets.mjs';

const SORT_BAR_KEYS = ['state', 'comprehensive', 'sales', 'price', 'range'];
const TRIGGER_KEYS = ['text', 'active', 'icon'];
const TAG_KEYS = ['active', 'icon'];
const SORTS = ['comprehensive', 'sales', 'price'];
const LABELS = ['销量', '价格'];
const ICON_PATTERN = /^[A-Za-z0-9._-]{1,60}$/;
// Checked before any shape. A login or address change wins over a missing control.
const PAGE_GATES = ['login_required', 'rate_limited', 'verification_required', 'target_changed', 'loading'];
const PRICE_PATTERN = /^[0-9]{1,7}(\.[0-9]{1,2})?$/;

/**
 * Read the JD search sort bar (2026-10-21 probe): the 综合 and 价格区间 drop-down buttons plus the 销量 and 价格 tags.
 * Class hashes change between releases, so controls are matched by CSS-module name. The icon file name is the only
 * direction marker on the page; it is recorded, never interpreted.
 * @param {Function} gate jdPageGate.
 * @returns {object} `observed` controls, or a gate / `search_sort_state_mismatch` state. Nothing is clicked.
 */
export function collectJdSortBar(gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const text = (node, max) => String(node?.innerText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const inModule = name => node => String(node.getAttribute('class') ?? '').split(/\s+/).some(token => new RegExp(`^${name}_[a-z0-9]{5}_[0-9]+$`).test(token));
  const allOf = (root, name) => [...root.querySelectorAll(`[class*="${name}_"]`)].filter(inModule(name));
  const mismatch = { state: 'search_sort_state_mismatch' };
  const bars = allOf(document, '_sort-bar').filter(visible);
  if (bars.length !== 1) return mismatch;
  const icon = node => {
    const image = node.querySelectorAll('img')[0];
    const name = image ? String(image.getAttribute('src') ?? '').split(/[?#]/)[0].split('/').pop() : '';
    return /^[A-Za-z0-9._-]{1,60}$/.test(name) ? name : null;
  };
  const triggers = allOf(bars[0], '_trigger-wrap').filter(visible);
  const tags = allOf(bars[0], '_sort-tag').filter(visible);
  const sales = tags.filter(node => text(node, 20) === '销量');
  const price = tags.filter(node => text(node, 20) === '价格');
  if (triggers.length !== 2 || sales.length !== 1 || price.length !== 1) return mismatch;
  const trigger = node => ({ text: text(node, 40), active: inModule('_trigger-wrap-button__active')(node), icon: icon(node) });
  const tag = node => ({ active: inModule('_sort-tag-button__active')(node), icon: icon(node) });
  return { state: 'observed', comprehensive: trigger(triggers[0]), sales: tag(sales[0]), price: tag(price[0]), range: trigger(triggers[1]) };
}

/**
 * One read of the sort bar, the pager and the first screen already loaded. Card-read parameters match jdSearchScript.
 * @param {{query: string, url: string}} target Canonical JD search target.
 * @returns {string} One expression. It does not click or scroll.
 * @throws {ShoppingError} INVALID_SEARCH.
 */
export function jdSortedSearchScript(target) {
  const expected = canonicalTarget(target);
  const query = JSON.stringify({ query: expected.query });
  return `({ sort_bar: (${collectJdSortBar})(${jdPageGate}), pager: (${collectJdSearchPager})(${jdPageGate}), ` +
    `search: (${collectJdSearch})(${query}, ${jdPageGate}, ${JD_SEARCH_CARD_LIMIT}) })`;
}

/**
 * @param {unknown} value Raw `{sort_bar, pager, search}` observation.
 * @param {{query: string, url: string}} target Canonical JD search target.
 * @param {{observedAt?: string}} [options]
 * @returns {{observed_at: string, sort_bar: object, active_sort: 'comprehensive'|'sales'|'price'|null, pager: object, search: object}}
 * `pager` and `search` are the validateJdSearchPage result.
 * @throws {ShoppingError} INVALID_SEARCH, page gates, SEARCH_SORT_STATE_MISMATCH, pager errors, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validateJdSortedSearch(value, target, { observedAt = new Date().toISOString() } = {}) {
  if (!sameKeys(value, ['sort_bar', 'pager', 'search'])) invalid();
  for (const part of [value.search, value.pager, value.sort_bar]) {
    if (PAGE_GATES.includes(part?.state)) throwPageError(part.state);
  }
  if (value.sort_bar?.state === 'search_sort_state_mismatch') throwPageError('search_sort_state_mismatch');
  const sortBar = validateSortBar(value.sort_bar);
  const page = validateJdSearchPage({ pager: value.pager, search: value.search }, target, { observedAt });
  return { observed_at: observedAt, sort_bar: sortBar, active_sort: activeSort(sortBar), pager: page.pager, search: page.search };
}

/**
 * Click the 销量 or 价格 tag once, only when the sort bar still shows the state the task last read. The live page
 * reorders in place (2026-10-21), so this does not scroll or read the cards; the caller re-reads after the click.
 * @param {{query: string, label: string, before: {active_sort: string, price_icon: string|null}}} expected
 * @param {Function} gate jdPageGate.
 * @param {Function} readSortBar collectJdSortBar.
 * @returns {{state: string}} `clicked`, or why nothing was clicked.
 */
export function clickJdSortTag(expected, gate, readSortBar) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keywords = current.searchParams.getAll('keyword');
  if (current.hostname !== 'search.jd.com' || current.pathname !== '/Search' || keywords.length !== 1 || keywords[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  const bar = readSortBar(gate);
  if (bar.state !== 'observed') return { state: bar.state };
  const active = ['comprehensive', 'sales', 'price'].filter(name => bar[name].active);
  if (active.length > 1) return { state: 'search_sort_state_mismatch' };
  if ((active[0] ?? null) !== expected.before.active_sort || bar.price.icon !== expected.before.price_icon) return { state: 'sort_state_changed' };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const text = (node, max) => String(node?.innerText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const inModule = name => node => String(node.getAttribute('class') ?? '').split(/\s+/).some(token => new RegExp(`^${name}_[a-z0-9]{5}_[0-9]+$`).test(token));
  const allOf = (root, name) => [...root.querySelectorAll(`[class*="${name}_"]`)].filter(inModule(name));
  const bars = allOf(document, '_sort-bar').filter(visible);
  const tags = bars.length === 1 ? allOf(bars[0], '_sort-tag').filter(visible).filter(node => text(node, 20) === expected.label) : [];
  if (tags.length !== 1) return { state: 'search_sort_state_mismatch' };
  tags[0].click();
  return { state: 'clicked' };
}

/**
 * @param {{query: string, url: string}} target Canonical JD search target.
 * @param {'销量'|'价格'} label Sort tag to click.
 * @param {{active_sort: 'comprehensive'|'sales'|'price', price_icon: string|null}} before State the task last read.
 * @returns {string} One single-click expression.
 * @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS.
 */
export function jdSortClickScript(target, label, before) {
  const expected = canonicalTarget(target);
  if (!LABELS.includes(label)) throw new ShoppingError('INVALID_ARGUMENTS', 'A JD sort click supports only 销量 or 价格.');
  if (!sameKeys(before, ['active_sort', 'price_icon']) || !SORTS.includes(before.active_sort) ||
      !(before.price_icon === null || (typeof before.price_icon === 'string' && ICON_PATTERN.test(before.price_icon)))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A JD sort click needs the sort state the task last read.');
  }
  const payload = { query: expected.query, label, before: { active_sort: before.active_sort, price_icon: before.price_icon } };
  return `(${clickJdSortTag})(${JSON.stringify(payload)}, ${jdPageGate}, ${collectJdSortBar})`;
}

/**
 * @param {unknown} value Page-script acknowledgement.
 * @returns {{clicked: true}}
 * @throws {ShoppingError} SEARCH_SORT_STATE_CHANGED, SEARCH_SORT_STATE_MISMATCH, page gates, or INVALID_RESPONSE.
 * A state other than `clicked` means the script did not click and is marked actionNotDispatched.
 */
export function validateJdSortClick(value) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  try {
    if (value?.state === 'sort_state_changed') {
      throw new ShoppingError('SEARCH_SORT_STATE_CHANGED', 'The JD sort bar no longer shows the state this click expected.',
        'Open the search page again and start a new task.');
    }
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The JD sort click returned an unexpected acknowledgement.');
  } catch (error) {
    if (typeof value?.state === 'string' && value.state !== 'clicked') error.actionNotDispatched = true;
    throw error;
  }
}

/**
 * Check whether the first-screen cards follow a price direction. JD sorts by the gray amount beside the price
 * (2026-10-21: 979…492 down, 39…49 up); the big 到手价 is not in order. Struck-through amounts are list prices, not the key.
 * @param {object[]} items validateJdSearch items.
 * @param {'asc'|'desc'} direction
 * @returns {{basis: string, direction: string, cards_compared: number, pairs: {in_order: number, against: number, equal: number},
 *   sponsored_skipped: number, unparsed_skipped: number, status: 'too_few'|'ordered'|'opposite'|'mixed'}}
 * @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function jdSortOrderCheck(items, direction) {
  if (!['asc', 'desc'].includes(direction) || !Array.isArray(items)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A JD order check needs search items and asc or desc.');
  }
  const { values, sponsoredSkipped, unparsedSkipped } = sortKeys(items);
  const pairs = { in_order: 0, against: 0, equal: 0 };
  for (let index = 1; index < values.length; index += 1) {
    const step = values[index] - values[index - 1];
    if (step === 0) pairs.equal += 1;
    else if ((step > 0) === (direction === 'asc')) pairs.in_order += 1;
    else pairs.against += 1;
  }
  const status = values.length < 4 ? 'too_few' : pairs.against === 0 ? 'ordered' : pairs.in_order === 0 ? 'opposite' : 'mixed';
  return { basis: 'gray_amount_or_displayed_price', direction, cards_compared: values.length, pairs,
    sponsored_skipped: sponsoredSkipped, unparsed_skipped: unparsedSkipped, status };
}

/**
 * Check that every first-screen card's sort price lies inside the requested range (2026-10-22 probe: 60–90 left only
 * 64.45–89.1). Sort prices are read as in jdSortOrderCheck; ads and unreadable amounts are counted and left out.
 * @param {object[]} items validateJdSearch items. @param {number} minimum @param {number} maximum
 * @returns {{basis: string, minimum: number, maximum: number, cards_checked: number, outside: number, sponsored_skipped: number, unparsed_skipped: number}}
 * @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function jdPriceRangeCheck(items, minimum, maximum) {
  if (!Array.isArray(items) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A JD price range check needs search items and a minimum below the maximum.');
  }
  const { values, sponsoredSkipped, unparsedSkipped } = sortKeys(items);
  return { basis: 'gray_amount_or_displayed_price', minimum, maximum, cards_checked: values.length,
    outside: values.filter(value => value < minimum || value > maximum).length, sponsored_skipped: sponsoredSkipped, unparsed_skipped: unparsedSkipped };
}

/**
 * The two amounts the 价格区间 button shows once a range is set (2026-10-22: the text starts 价格区间(¥ after 确定).
 * @param {{text: string, active: boolean}} range Validated sort-bar range control.
 * @returns {number[]|null} Both amounts when the button is selected and names exactly two, else null.
 */
export function shownPriceRange(range) {
  if (!range.active) return null;
  const amounts = (range.text.match(/[0-9]+(?:\.[0-9]+)?/g) ?? []).map(Number);
  return amounts.length === 2 ? amounts : null;
}

/**
 * Read the open 价格区间 dropdown: a visible `_drop-down-body_` holding a `_range-input_` (2026-10-22 probe: placeholders
 * 最低价 and 最高价, presets, 重置 and 确定). Read only.
 * @param {Function} gate jdPageGate.
 * @returns {object} `observed` with the number of open dropdowns and, for exactly one, its inputs; or a gate state.
 */
export function collectJdPriceRangePanel(gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const panels = [...document.querySelectorAll('[class*="_drop-down-body_"]')].filter(visible)
    .filter(node => node.querySelectorAll('[class*="_range-input_"]').length > 0);
  if (panels.length !== 1) return { state: 'observed', open: Math.min(panels.length, 5), inputs: [] };
  const inputs = [...panels[0].querySelectorAll('input')].filter(visible).slice(0, 4).map(input => {
    const placeholder = String(input.getAttribute('placeholder') ?? '').slice(0, 12);
    return { placeholder, value: String(input.value ?? '').slice(0, 12),
      unique: [...document.querySelectorAll('input')].filter(other => other.getAttribute('placeholder') === placeholder).length === 1 };
  });
  return { state: 'observed', open: 1, inputs };
}

/**
 * Open the 价格区间 dropdown with the pointer events a mouse moving onto it fires; a script click does not open it
 * (2026-10-21). Only while no range is set yet. Nothing is clicked or typed.
 * @param {{query: string}} expected @param {Function} gate jdPageGate. @param {Function} readSortBar collectJdSortBar.
 * @returns {{state: string}} `hovered`, or why nothing was sent.
 */
export function hoverJdPriceRange(expected, gate, readSortBar) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keywords = current.searchParams.getAll('keyword');
  if (current.hostname !== 'search.jd.com' || current.pathname !== '/Search' || keywords.length !== 1 || keywords[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  const bar = readSortBar(gate);
  if (bar.state !== 'observed') return { state: bar.state };
  if (bar.range.active) return { state: 'range_already_set' };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const inModule = name => node => String(node.getAttribute('class') ?? '').split(/\s+/).some(token => new RegExp(`^${name}_[a-z0-9]{5}_[0-9]+$`).test(token));
  const bars = [...document.querySelectorAll('[class*="_sort-bar_"]')].filter(inModule('_sort-bar')).filter(visible);
  const buttons = bars.length === 1 ? [...bars[0].querySelectorAll('[class*="_trigger-wrap_"]')].filter(inModule('_trigger-wrap')).filter(visible)
    .filter(node => String(node.innerText ?? '').replace(/\s+/g, '') === '价格区间') : [];
  if (buttons.length !== 1) return { state: 'search_sort_state_mismatch' };
  const chain = [];
  for (let node = buttons[0]; node && chain.length < 5; node = node.parentElement) {
    chain.unshift(node);
    if (String(node.getAttribute('class') ?? '').includes('_trigger-item_')) break;
  }
  const send = (node, type, bubbles) => node.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true }));
  send(buttons[0], 'pointerover', true);
  send(buttons[0], 'mouseover', true);
  for (const node of chain) { send(node, 'pointerenter', false); send(node, 'mouseenter', false); }
  send(buttons[0], 'mousemove', true);
  return { state: 'hovered' };
}

/**
 * Click 确定 once in the open 价格区间 dropdown, only when its two inputs hold exactly the requested bounds.
 * @param {{query: string, minimum: string, maximum: string}} expected @param {Function} gate jdPageGate.
 * @param {Function} readPanel collectJdPriceRangePanel.
 * @returns {{state: string}} `clicked`, or why nothing was clicked.
 */
export function clickJdPriceRangeConfirm(expected, gate, readPanel) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keywords = current.searchParams.getAll('keyword');
  if (current.hostname !== 'search.jd.com' || current.pathname !== '/Search' || keywords.length !== 1 || keywords[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  const panel = readPanel(gate);
  if (panel.state !== 'observed') return { state: panel.state };
  if (panel.open !== 1) return { state: 'range_panel_closed' };
  if (panel.inputs.length !== 2 || panel.inputs[0].value !== expected.minimum || panel.inputs[1].value !== expected.maximum) return { state: 'range_values_changed' };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const panels = [...document.querySelectorAll('[class*="_drop-down-body_"]')].filter(visible)
    .filter(node => node.querySelectorAll('[class*="_range-input_"]').length > 0);
  const actions = panels.length === 1 ? [...panels[0].querySelectorAll('[class*="_range-actions_"]')].filter(visible) : [];
  const matches = actions.length === 1 ? [...actions[0].querySelectorAll('[class*="_common-button"]')].filter(visible)
    .filter(node => String(node.innerText ?? '').replace(/\s+/g, '') === '确定') : [];
  // A button and its text span can both carry a `_common-button…` class; the outermost one is the button.
  const buttons = matches.filter(node => { for (let up = node.parentElement; up; up = up.parentElement) if (matches.includes(up)) return false; return true; });
  if (buttons.length !== 1) return { state: 'range_panel_closed' };
  buttons[0].click();
  return { state: 'clicked' };
}

/** @param {{query: string, url: string}} target @returns {string} The read-only panel expression. @throws {ShoppingError} INVALID_SEARCH. */
export function jdPriceRangePanelScript(target) {
  canonicalTarget(target);
  return `(${collectJdPriceRangePanel})(${jdPageGate})`;
}

/** @param {{query: string, url: string}} target @returns {string} The single hover expression. @throws {ShoppingError} INVALID_SEARCH. */
export function jdPriceRangeHoverScript(target) {
  const expected = canonicalTarget(target);
  return `(${hoverJdPriceRange})(${JSON.stringify({ query: expected.query })}, ${jdPageGate}, ${collectJdSortBar})`;
}

/**
 * @param {{query: string, url: string}} target @param {number} minimum @param {number} maximum Whole yuan, minimum below maximum.
 * @returns {string} The single 确定 click expression. @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS.
 */
export function jdPriceRangeConfirmScript(target, minimum, maximum) {
  const expected = canonicalTarget(target);
  requirePriceRange(minimum, maximum);
  return `(${clickJdPriceRangeConfirm})(${JSON.stringify({ query: expected.query, minimum: String(minimum), maximum: String(maximum) })}, ${jdPageGate}, ${collectJdPriceRangePanel})`;
}

/**
 * @param {number} minimum @param {number} maximum
 * @throws {ShoppingError} INVALID_ARGUMENTS unless both are whole yuan from 1 to 999999 and minimum is below maximum.
 */
export function requirePriceRange(minimum, maximum) {
  const whole = value => Number.isSafeInteger(value) && value >= 1 && value <= 999_999;
  if (!whole(minimum) || !whole(maximum) || minimum >= maximum) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A JD price range needs --min-price and --max-price as whole yuan from 1 to 999999, the minimum below the maximum.');
  }
}

/**
 * @param {unknown} value Raw panel read.
 * @returns {{open: number, inputs: {placeholder: string, value: string, unique: boolean}[]}}
 * @throws {ShoppingError} Page gates or INVALID_RESPONSE.
 */
export function validateJdPriceRangePanel(value) {
  if (PAGE_GATES.includes(value?.state)) throwPageError(value.state);
  if (!sameKeys(value, ['state', 'open', 'inputs']) || value.state !== 'observed' || !Number.isSafeInteger(value.open) || value.open < 0 || value.open > 5 ||
      !Array.isArray(value.inputs) || value.inputs.length > 4 || (value.open !== 1 && value.inputs.length)) invalid();
  const inputs = value.inputs.map(input => {
    if (!sameKeys(input, ['placeholder', 'value', 'unique']) || typeof input.unique !== 'boolean') invalid();
    return { placeholder: responseText(input.placeholder, 12), value: responseText(input.value, 12), unique: input.unique };
  });
  return { open: value.open, inputs };
}

/**
 * @param {unknown} value Hover acknowledgement. @returns {{hovered: true}}
 * @throws {ShoppingError} SEARCH_PRICE_RANGE_STATE_CHANGED, SEARCH_SORT_STATE_MISMATCH, page gates or INVALID_RESPONSE; refusals are marked actionNotDispatched.
 */
export function validateJdPriceRangeHover(value) {
  if (value?.state === 'hovered' && Object.keys(value).length === 1) return { hovered: true };
  return refuse(value, state => {
    if (state === 'range_already_set') {
      throw new ShoppingError('SEARCH_PRICE_RANGE_STATE_CHANGED', 'The search page already shows a price range.', 'Open the search page again and start a new task.');
    }
  });
}

/**
 * @param {unknown} value 确定 click acknowledgement. @returns {{clicked: true}}
 * @throws {ShoppingError} SEARCH_PRICE_RANGE_NOT_FILLED, SEARCH_PRICE_RANGE_UNAVAILABLE, page gates or INVALID_RESPONSE; refusals are marked actionNotDispatched.
 */
export function validateJdPriceRangeConfirm(value) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  return refuse(value, state => {
    if (state === 'range_values_changed') {
      throw new ShoppingError('SEARCH_PRICE_RANGE_NOT_FILLED', 'The price range inputs do not hold the requested bounds; 确定 was not clicked.', 'Open the search page again and start a new task.');
    }
    if (state === 'range_panel_closed') {
      throw new ShoppingError('SEARCH_PRICE_RANGE_UNAVAILABLE', 'The price range dropdown or its 确定 button is not open; nothing was clicked.', 'Open the search page again and start a new task.');
    }
  });
}

function refuse(value, special) {
  try {
    if (typeof value?.state === 'string') special(value.state);
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The JD price range control returned an unexpected acknowledgement.');
  } catch (error) {
    if (typeof value?.state === 'string' && !['clicked', 'hovered'].includes(value.state)) error.actionNotDispatched = true;
    throw error;
  }
}

function sortKeys(items) {
  let sponsoredSkipped = 0, unparsedSkipped = 0;
  const values = [];
  for (const item of items) {
    if (item?.jd?.sponsored) { sponsoredSkipped += 1; continue; }
    const gray = (item?.jd?.other_amounts ?? []).find(amount => !amount.line_through);
    const amount = String(gray ? gray.text : item?.price?.amount_text ?? '').replace(/^[¥￥]/, '');
    if (!PRICE_PATTERN.test(amount)) { unparsedSkipped += 1; continue; }
    values.push(Number(amount));
  }
  return { values, sponsoredSkipped, unparsedSkipped };
}

function validateSortBar(bar) {
  if (!sameKeys(bar, SORT_BAR_KEYS) || bar.state !== 'observed') invalid();
  const trigger = control => {
    if (!sameKeys(control, TRIGGER_KEYS)) invalid();
    return { text: responseText(control.text, 40), active: flag(control.active), icon: iconName(control.icon) };
  };
  const tag = control => {
    if (!sameKeys(control, TAG_KEYS)) invalid();
    return { active: flag(control.active), icon: iconName(control.icon) };
  };
  return { comprehensive: trigger(bar.comprehensive), sales: tag(bar.sales), price: tag(bar.price), range: trigger(bar.range) };
}

function activeSort(sortBar) {
  const active = SORTS.filter(name => sortBar[name].active);
  if (active.length > 1) throwPageError('search_sort_state_mismatch');
  return active[0] ?? null;
}

function canonicalTarget(target) {
  const expected = jdSearchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use a canonical JD search target.');
  return expected;
}

const invalid = () => { throw new ShoppingError('INVALID_RESPONSE', 'The JD search page response does not match the sort bar, pager and first screen.'); };

const flag = value => { if (typeof value !== 'boolean') invalid(); return value; };

const iconName = value => {
  if (value !== null && (typeof value !== 'string' || !ICON_PATTERN.test(value))) invalid();
  return value;
};

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
