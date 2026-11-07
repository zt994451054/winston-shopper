import { ShoppingError } from '../errors.mjs';
import { throwPageError } from '../page-dom.mjs';
import { pddPageGate } from './page-gate.mjs';
import { pddSearchTarget } from './targets.mjs';

/**
 * The clicks of each sort, as seen on 2026-10-27: every click re-sorts the page in place and writes sort_type into the
 * address. 销量 gives _sales; the first 价格 click sorts low to high (price), a second one high to low (_price).
 * `from` is the sort_type the page must show before that click; a fresh search page has none.
 */
export const PDD_SORTS = Object.freeze({
  sales: Object.freeze([{ label: '销量', from: null, to: '_sales' }]),
  'price-asc': Object.freeze([{ label: '价格', from: null, to: 'price' }]),
  'price-desc': Object.freeze([{ label: '价格', from: null, to: 'price' }, { label: '价格', from: 'price', to: '_price' }]),
});
const BAR_LABELS = ['综合', '销量', '价格', '品牌', '筛选'];
// The 筛选 panel's two inputs and its button (2026-10-28 probe); the range lands in the address as price=A,B.
const RANGE_INPUTS = ['最低价', '最高价'];
const PRICE_PARAM = /^[0-9]{1,7},[0-9]{1,7}$/;
const SORT_TYPE = /^_?[a-z]{1,20}$/;
const PRICE = /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/;

/**
 * In-page: the search page's sort_type and price range in the address, the sort bar items with their text colour, and
 * the shown 筛选 panel inputs. Read-only.
 * @param {{query: string}} expected @param {Function} gate pddPageGate @param {string[]} labels Sort bar texts.
 * @param {string[]} inputLabels The range input placeholders.
 * @returns {object} Raw guarded observation.
 */
export function collectPddSortState(expected, gate, labels, inputLabels) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keys = current.searchParams.getAll('search_key');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/search_result.html' || keys.length !== 1 || keys[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  // The bar sits at the top; its items are the innermost elements with exactly these texts.
  const items = [...document.querySelectorAll('body *')].filter(element => labels.includes(clip(element.textContent)) &&
    element.getBoundingClientRect().height > 0 && element.getBoundingClientRect().top < 250 &&
    ![...element.children].some(child => labels.includes(clip(child.textContent))));
  const sortTypes = current.searchParams.getAll('sort_type');
  // After 确认 the panel stays in the page with visibility: hidden and a height, so visibility decides what is shown.
  const shown = element => element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility === 'visible';
  const inputs = inputLabels.map(placeholder => [...document.querySelectorAll('input')].filter(input => input.placeholder === placeholder && shown(input))
    .map(input => String(input.value)));
  const confirms = [...document.querySelectorAll('body *')].filter(element => !element.children.length && /^确认/.test(clip(element.textContent)) && shown(element));
  return { state: 'observed', sort_types: sortTypes, items: items.map(item => ({ text: clip(item.textContent), color: String(getComputedStyle(item).color) })),
    prices: current.searchParams.getAll('price'), inputs, confirm_texts: confirms.map(element => clip(element.textContent).slice(0, 40)) };
}

/**
 * Which sort bar items are marked: on 2026-10-27 the selected item turned red while the others kept one grey, so the
 * marked items are those whose colour differs from the colour most items share.
 * sort_type default, which a range confirm writes (2026-10-28), means 综合 like no sort_type.
 * @param {unknown} value collectPddSortState result.
 * @returns {{sort_type: string|null, selected: string[], price_range: string|null, panel: {open: boolean, minimum: string|null, maximum: string|null}}}
 * @throws {ShoppingError} Page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validatePddSortState(value) {
  throwPageError(value?.state);
  const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The PDD sort bar response does not match the supported page.');
  if (value?.state !== 'observed' || !Array.isArray(value.sort_types) || value.sort_types.length > 1 || !Array.isArray(value.items) || value.items.length > 20 ||
      !Array.isArray(value.prices) || value.prices.length > 1 || (value.prices.length && !PRICE_PARAM.test(value.prices[0])) || !Array.isArray(value.inputs) ||
      value.inputs.length !== 2 || value.inputs.some(values => !Array.isArray(values) || values.length > 1 || values.some(text => typeof text !== 'string' || text.length > 20)) ||
      !Array.isArray(value.confirm_texts) || value.confirm_texts.length > 3 || value.confirm_texts.some(text => typeof text !== 'string')) throw invalid();
  const sortType = value.sort_types[0] ?? null;
  if (sortType !== null && sortType !== '' && !SORT_TYPE.test(sortType)) throw invalid();
  if (value.items.some(item => !BAR_LABELS.includes(item?.text) || typeof item.color !== 'string' || item.color.length > 60)) throw invalid();
  const texts = value.items.map(item => item.text);
  if (['销量', '价格'].some(label => texts.filter(text => text === label).length !== 1) || value.items.length < 3) {
    throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The PDD sort bar does not show 销量 and 价格 once each.');
  }
  const counts = new Map();
  for (const item of value.items) counts.set(item.color, (counts.get(item.color) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const open = value.inputs.every(values => values.length === 1) && value.confirm_texts.length === 1;
  return { sort_type: sortType === 'default' ? null : sortType || null, selected: value.items.filter(item => item.color !== common).map(item => item.text),
    price_range: value.prices[0] ?? null, panel: { open, minimum: open ? value.inputs[0][0] : null, maximum: open ? value.inputs[1][0] : null } };
}

/**
 * In-page: click one sort bar item once, only while the address shows the sort_type and price range the plan expects
 * before it. 筛选 opens the range panel and is clicked only on a page without a range.
 * @param {{query: string, label: string, from: string|null, range: string|null}} expected @param {Function} gate pddPageGate @param {string[]} labels
 * @returns {{state: string}} 'clicked', a gate state, 'sort_state_changed' or 'item_not_found'.
 */
export function clickPddSortItem(expected, gate, labels) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keys = current.searchParams.getAll('search_key');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/search_result.html' || keys.length !== 1 || keys[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const sortTypes = current.searchParams.getAll('sort_type'), prices = current.searchParams.getAll('price');
  const sortType = sortTypes[0] === 'default' ? null : sortTypes[0] || null;
  if (sortTypes.length > 1 || sortType !== expected.from || prices.length > 1 || (prices[0] ?? null) !== expected.range) return { state: 'sort_state_changed' };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const hits = [...document.querySelectorAll('body *')].filter(element => clip(element.textContent) === expected.label &&
    element.getBoundingClientRect().height > 0 && element.getBoundingClientRect().top < 250 &&
    ![...element.children].some(child => labels.includes(clip(child.textContent))));
  if (hits.length !== 1) return { state: 'item_not_found' };
  hits[0].click();
  return { state: 'clicked' };
}

function checkedTarget(target) {
  const expected = pddSearchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use a canonical PDD search target.');
  return expected;
}

/** @param {object} target Canonical PDD search target. @returns {string} One fixed read-only expression. */
export function pddSortStateScript(target) {
  return `(${collectPddSortState})(${JSON.stringify({ query: checkedTarget(target).query })}, ${pddPageGate}, ${JSON.stringify(BAR_LABELS)}, ${JSON.stringify(RANGE_INPUTS)})`;
}

/**
 * @param {object} target Canonical PDD search target.
 * @param {{label: string, from: string|null, range?: string|null}} step One step of PDD_SORTS, or 筛选 from null, with the range the page must show.
 * @returns {string} One fixed single-click expression. @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS.
 */
export function pddSortClickScript(target, step) {
  const range = step?.range ?? null;
  const known = Object.values(PDD_SORTS).flat().some(item => item.label === step?.label && item.from === step.from) ||
    (step?.label === '筛选' && step.from === null && range === null);
  if (!known || (range !== null && !PRICE_PARAM.test(range))) throw new ShoppingError('INVALID_ARGUMENTS', 'Use one step of a supported PDD sort.');
  return `(${clickPddSortItem})(${JSON.stringify({ query: checkedTarget(target).query, label: step.label, from: step.from, range })}, ${pddPageGate}, ${JSON.stringify(BAR_LABELS)})`;
}

/**
 * In-page: click the 筛选 panel's 确认 once, only while both shown inputs hold the requested bounds.
 * @param {{query: string, minimum: string, maximum: string}} expected @param {Function} gate pddPageGate @param {string[]} inputLabels
 * @returns {{state: string}} 'clicked', a gate state or 'range_not_ready'.
 */
export function clickPddRangeConfirm(expected, gate, inputLabels) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keys = current.searchParams.getAll('search_key');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/search_result.html' || keys.length !== 1 || keys[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const shown = element => element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility === 'visible';
  const values = inputLabels.map(placeholder => [...document.querySelectorAll('input')].filter(input => input.placeholder === placeholder && shown(input)).map(input => String(input.value)));
  const confirms = [...document.querySelectorAll('body *')].filter(element => !element.children.length && /^确认/.test(clip(element.textContent)) && shown(element));
  if (current.searchParams.getAll('price').length || values.some(found => found.length !== 1) || values[0][0] !== expected.minimum ||
      values[1][0] !== expected.maximum || confirms.length !== 1) return { state: 'range_not_ready' };
  confirms[0].click();
  return { state: 'clicked' };
}

/**
 * @param {object} target Canonical PDD search target. @param {number} minimum @param {number} maximum Whole yuan.
 * @returns {string} One fixed single-click expression. @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS.
 */
export function pddRangeConfirmScript(target, minimum, maximum) {
  requirePddPriceRange(minimum, maximum);
  return `(${clickPddRangeConfirm})(${JSON.stringify({ query: checkedTarget(target).query, minimum: String(minimum), maximum: String(maximum) })}, ${pddPageGate}, ${JSON.stringify(RANGE_INPUTS)})`;
}

/**
 * @param {number} minimum @param {number} maximum @returns {void}
 * @throws {ShoppingError} INVALID_ARGUMENTS unless both are whole yuan from 1 to 999999, the minimum below the maximum.
 */
export function requirePddPriceRange(minimum, maximum) {
  const whole = value => Number.isSafeInteger(value) && value >= 1 && value <= 999_999;
  if (!whole(minimum) || !whole(maximum) || minimum >= maximum) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A PDD price range needs --min-price and --max-price as whole yuan from 1 to 999999, the minimum below the maximum.');
  }
}

export { RANGE_INPUTS };

const CLICK_REFUSALS = {
  sort_state_changed: ['SEARCH_SORT_STATE_CHANGED', 'The search page no longer shows the sort this click expected.'],
  item_not_found: ['PAGE_STRUCTURE_CHANGED', 'The PDD sort bar does not show this item exactly once.'],
  range_not_ready: ['SEARCH_PRICE_RANGE_STATE_CHANGED', 'The 筛选 panel does not show the requested bounds with one 确认 button.'],
};

/**
 * @param {unknown} value clickPddSortItem result. @returns {{clicked: true}}
 * @throws {ShoppingError} Refusals and page gates (marked actionNotDispatched) or INVALID_RESPONSE.
 */
export function validatePddSortClick(value) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  try {
    const refusal = CLICK_REFUSALS[value?.state];
    if (refusal) throw new ShoppingError(...refusal, 'Open a new search page with page-open and start a new task.');
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The PDD sort click returned an unexpected acknowledgement.');
  } catch (error) {
    // Every non-click state comes from the page script before it clicked anything.
    if (typeof value?.state === 'string' && value.state !== 'clicked') error.actionNotDispatched = true;
    throw error;
  }
}

/**
 * Check whether the loaded cards follow a price direction. PDD sorts by the displayed amount, 券后 amounts included
 * (2026-10-27: 8.45, 19.59 … 券后 39.79 up; 券后 699, 579 … 券后 75.8 down). Cards without a single amount are counted and left out.
 * @param {object[]} items validatePddSearch items. @param {'asc'|'desc'} direction
 * @returns {{basis: string, direction: string, cards_compared: number, pairs: {in_order: number, against: number, equal: number},
 *   unparsed_skipped: number, status: 'too_few'|'ordered'|'opposite'|'mixed'}}
 */
export function pddSortOrderCheck(items, direction) {
  const values = [];
  let unparsed = 0;
  for (const item of items) {
    const amount = item?.price?.amount;
    if (typeof amount === 'string' && PRICE.test(amount)) values.push(Number(amount)); else unparsed += 1;
  }
  const pairs = { in_order: 0, against: 0, equal: 0 };
  for (let index = 1; index < values.length; index += 1) {
    const step = values[index] - values[index - 1];
    if (step === 0) pairs.equal += 1;
    else if ((step > 0) === (direction === 'asc')) pairs.in_order += 1;
    else pairs.against += 1;
  }
  const status = values.length < 4 ? 'too_few' : pairs.against === 0 ? 'ordered' : pairs.in_order === 0 ? 'opposite' : 'mixed';
  return { basis: 'displayed_amount', direction, cards_compared: values.length, pairs, unparsed_skipped: unparsed, status };
}

/**
 * Check that the loaded cards' displayed amounts lie inside the requested range (2026-10-28 probe: 30–60 left 32.8–58.39,
 * 券后 amounts included). Cards without a single amount are counted and left out.
 * @param {object[]} items validatePddSearch items. @param {number} minimum @param {number} maximum
 * @returns {{basis: string, minimum: number, maximum: number, cards_checked: number, outside: number, unparsed_skipped: number}}
 */
export function pddPriceRangeCheck(items, minimum, maximum) {
  const values = items.map(item => item?.price?.amount).filter(amount => typeof amount === 'string' && PRICE.test(amount)).map(Number);
  return { basis: 'displayed_amount', minimum, maximum, cards_checked: values.length, outside: values.filter(value => value < minimum || value > maximum).length,
    unparsed_skipped: items.length - values.length };
}
