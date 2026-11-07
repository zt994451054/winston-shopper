import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { JD_SEARCH_CARD_LIMIT, collectJdSearch, validateJdSearch } from './search.mjs';
import { jdSearchTarget } from './targets.mjs';

/** Upper bound of --pages for one JD search task (user, 2026-10-21). */
export const JD_SEARCH_PAGE_LIMIT = 5;

const PAGER_KEYS = ['state', 'active_page', 'active_text', 'total_pages', 'total_text', 'previous', 'next'];
const CONTROLS = ['enabled', 'disabled', 'missing'];
// Checked before the pager shape. A login or address change wins over a missing pager.
const PAGE_GATES = ['login_required', 'rate_limited', 'verification_required', 'target_changed', 'loading'];
const PAGER_STOPS = ['search_pagination_missing', 'search_page_controls_mismatch'];

/**
 * Read the visible JD search pager. Class hashes change between releases; the module name does not
 * (2026-10-21 probe: `_pagination_next_1gv36_8`). The page-jump input and the fast-forward control are not read.
 * @param {Function} gate jdPageGate.
 * @returns {object} `observed` pager fields, or a gate / pager state. Nothing is clicked.
 */
export function collectJdSearchPager(gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const text = (node, max) => String(node?.innerText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  // A module token is `_name_hash_n`. Matching the whole token avoids `_active_` inside a longer name.
  const inModule = name => node => String(node.getAttribute('class') ?? '').split(/\s+/).some(token => new RegExp(`^${name}_[a-z0-9]{5}_[0-9]+$`).test(token));
  const allOf = (root, name) => [...root.querySelectorAll(`[class*="${name}_"]`)].filter(inModule(name));
  const centers = allOf(document, '_pagination_center').filter(visible);
  if (!centers.length) return { state: 'search_pagination_missing' };
  if (centers.length !== 1) return { state: 'search_page_controls_mismatch' };
  const center = centers[0];
  const control = (name, label) => {
    const nodes = allOf(center, name).filter(visible);
    if (nodes.length !== 1 || text(nodes[0], 40) !== label) return 'missing';
    return inModule('_disabled')(nodes[0]) ? 'disabled' : 'enabled';
  };
  const activeNodes = allOf(center, '_pagination_item').filter(visible).filter(inModule('_active'));
  const activeText = activeNodes.length === 1 ? text(activeNodes[0], 6) : null;
  const totalNode = allOf(center, '_pagination_total').filter(visible)[0] ?? null;
  const totalText = totalNode ? text(totalNode, 20) : null;
  const totalMatch = totalText === null ? null : /共(\d{1,4})页/.exec(totalText);
  return {
    state: 'observed',
    active_page: activeText !== null && /^[0-9]{1,3}$/.test(activeText) ? Number(activeText) : null,
    active_text: activeText,
    total_pages: totalMatch ? Number(totalMatch[1]) : null,
    total_text: totalText,
    previous: control('_pagination_previous', '上一页'),
    next: control('_pagination_next', '下一页'),
  };
}

/**
 * One read of the pager and the first screen already loaded. Parameters of the card read match jdSearchScript.
 * @param {{query: string, url: string}} target Canonical JD search target.
 * @returns {string} One expression. It does not click or scroll.
 * @throws {ShoppingError} INVALID_SEARCH.
 */
export function jdSearchPageScript(target) {
  const expected = canonicalTarget(target);
  const query = JSON.stringify({ query: expected.query });
  return `({ pager: (${collectJdSearchPager})(${jdPageGate}), search: (${collectJdSearch})(${query}, ${jdPageGate}, ${JD_SEARCH_CARD_LIMIT}) })`;
}

/**
 * @param {unknown} value Raw `{pager, search}` observation.
 * @param {{query: string, url: string}} target Canonical JD search target.
 * @param {{observedAt?: string}} [options]
 * @returns {{observed_at: string, pager: object, search: object}} Pager fields plus the validateJdSearch result.
 * @throws {ShoppingError} INVALID_SEARCH, page gates, SEARCH_PAGINATION_MISSING, SEARCH_PAGE_CONTROLS_MISMATCH, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validateJdSearchPage(value, target, { observedAt = new Date().toISOString() } = {}) {
  if (!sameKeys(value, ['pager', 'search'])) invalid();
  if (PAGE_GATES.includes(value.search?.state)) throwPageError(value.search.state);
  if (PAGE_GATES.includes(value.pager?.state)) throwPageError(value.pager.state);
  if (PAGER_STOPS.includes(value.pager?.state)) throwPageError(value.pager.state);
  if (!sameKeys(value.pager, PAGER_KEYS) || value.pager.state !== 'observed') invalid();
  const activeText = pageText(value.pager.active_text, 6);
  const activePage = activeText !== null && /^[0-9]{1,3}$/.test(activeText) ? Number(activeText) : null;
  if (value.pager.active_page !== activePage) invalid();
  const totalText = pageText(value.pager.total_text, 20);
  const totalMatch = totalText === null ? null : /共(\d{1,4})页/.exec(totalText);
  const totalPages = totalMatch ? Number(totalMatch[1]) : null;
  if (value.pager.total_pages !== totalPages) invalid();
  if (!CONTROLS.includes(value.pager.previous) || !CONTROLS.includes(value.pager.next)) invalid();
  const search = validateJdSearch(value.search, target, { observedAt });
  return {
    observed_at: observedAt,
    pager: {
      active_page: activePage, active_text: activeText, total_pages: totalPages, total_text: totalText,
      previous: value.pager.previous, next: value.pager.next,
    },
    search,
  };
}

/**
 * Click 下一页 once, only when the visible pager is still on `from_page`. The address does not change on the live
 * page (2026-10-21), so this does not scroll, type, or read the cards; the caller re-reads after the click.
 * @param {{query: string, from_page: number}} expected Keyword and the page the task last read.
 * @param {Function} gate jdPageGate.
 * @returns {{state: string}} `clicked`, or why nothing was clicked.
 */
export function clickJdNextPage(expected, gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keywords = current.searchParams.getAll('keyword');
  if (current.hostname !== 'search.jd.com' || current.pathname !== '/Search' || keywords.length !== 1 || keywords[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const text = (node, max) => String(node?.innerText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const inModule = name => node => String(node.getAttribute('class') ?? '').split(/\s+/).some(token => new RegExp(`^${name}_[a-z0-9]{5}_[0-9]+$`).test(token));
  const allOf = (root, name) => [...root.querySelectorAll(`[class*="${name}_"]`)].filter(inModule(name));
  const centers = allOf(document, '_pagination_center').filter(visible);
  if (!centers.length) return { state: 'search_pagination_missing' };
  if (centers.length !== 1) return { state: 'search_page_controls_mismatch' };
  const center = centers[0];
  const active = allOf(center, '_pagination_item').filter(visible).filter(inModule('_active'));
  const activeText = active.length === 1 ? text(active[0], 6) : '';
  if (active.length !== 1 || !/^[0-9]{1,3}$/.test(activeText) || Number(activeText) !== expected.from_page) return { state: 'page_mismatch' };
  const next = allOf(center, '_pagination_next').filter(visible).filter(node => text(node, 40) === '下一页');
  if (next.length !== 1) return { state: 'search_page_controls_mismatch' };
  if (inModule('_disabled')(next[0])) return { state: 'last_page' };
  next[0].click();
  return { state: 'clicked' };
}

/**
 * @param {{query: string, url: string}} target Canonical JD search target.
 * @param {number} fromPage Current page, 1 through 4. Page 5 is the last page a task may land on, so it is not a click origin.
 * @returns {string} One single-click expression.
 * @throws {ShoppingError} INVALID_SEARCH or INVALID_ARGUMENTS.
 */
export function jdNextPageScript(target, fromPage) {
  const expected = canonicalTarget(target);
  if (!Number.isSafeInteger(fromPage) || fromPage < 1 || fromPage > JD_SEARCH_PAGE_LIMIT - 1) {
    throw new ShoppingError('INVALID_ARGUMENTS', `A JD next-page click needs a current page from 1 to ${JD_SEARCH_PAGE_LIMIT - 1}.`);
  }
  return `(${clickJdNextPage})(${JSON.stringify({ query: expected.query, from_page: fromPage })}, ${jdPageGate})`;
}

/**
 * @param {unknown} value Page-script acknowledgement.
 * @returns {{clicked: true}}
 * @throws {ShoppingError} SEARCH_LAST_PAGE (lastPage set), SEARCH_PAGE_MISMATCH, page gates, or INVALID_RESPONSE.
 * A state other than `clicked` means the script did not click and is marked actionNotDispatched.
 */
export function validateJdNextPage(value) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  try {
    if (value?.state === 'last_page') {
      const error = new ShoppingError('SEARCH_LAST_PAGE', 'The JD search next-page control is disabled.',
        'Stop paging this search. Do not click next again.');
      error.lastPage = true;
      throw error;
    }
    if (value?.state === 'page_mismatch') {
      throw new ShoppingError('SEARCH_PAGE_MISMATCH', 'The JD search pager is not on the page this click expected.',
        'Read the pager again before another next-page click.');
    }
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The JD next-page click returned an unexpected acknowledgement.');
  } catch (error) {
    if (typeof value?.state === 'string' && value.state !== 'clicked') error.actionNotDispatched = true;
    throw error;
  }
}

function canonicalTarget(target) {
  const expected = jdSearchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use a canonical JD search target.');
  return expected;
}

const invalid = () => { throw new ShoppingError('INVALID_RESPONSE', 'The JD search page response does not match the pager and first screen.'); };

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function pageText(value, max) {
  if (value === null) return null;
  return responseText(value, max);
}
