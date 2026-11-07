import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { pageDom, throwPageError } from './page-dom.mjs';
import { searchTarget, searchPageTarget, parseSearchPageUrl, collectSearch, isSearchHome, validateSearch, validateSavedSearch } from './search.mjs';
import { pagination, validatePagination } from './search-pages.mjs';

// New tasks read up to fifty cards per page, as the first-screen search does; tasks started before 2026-10-14 keep twenty-five.
export const SEARCH_RANGE_CARD_LIMIT = 50;
const CARD_LIMITS = [25, SEARCH_RANGE_CARD_LIMIT];
function requireCardLimit(value) {
  if (!CARD_LIMITS.includes(value)) throw new ShoppingError('INVALID_SEARCH', 'Use a supported cards-per-page limit.');
  return value;
}

/**
 * Create a canonical unsorted keyword page identity within the new five-page scope.
 * @param {unknown} query Bounded keyword text. @param {number} page Integer from one through five.
 * @returns {object} Canonical query/page identity; no sort or filter parameters.
 * @throws {ShoppingError} INVALID_SEARCH for unsupported query or page values.
 * @example searchRangeTarget('图书', 3);
 */
export function searchRangeTarget(query, page) {
  const first = searchTarget(query);
  if (!Number.isInteger(page) || page < 1 || page > 5) throw new ShoppingError('INVALID_SEARCH', 'Choose a search page from one through five.');
  return {...first, page, url:first.url.replace('&page=1&', `&page=${page}&`)};
}

/**
 * Parse one supported range URL using the legacy business/tracking parameter allowlist.
 * @param {unknown} value Search URL. @returns {object|null} Canonical unsorted page or null.
 * @example parseSearchRangeUrl('https://s.taobao.com/search?q=books&page=3&tab=all');
 */
export function parseSearchRangeUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 16384) return null;
    const url = new URL(value), pages = url.searchParams.getAll('page');
    if (pages.length > 1 || pages.length === 1 && !/^[1-5]$/.test(pages[0])) return null;
    const page = Number(pages[0] ?? 1);
    url.searchParams.set('page', '1');
    const first = parseSearchPageUrl(url.href);
    return first ? searchRangeTarget(first.query, page) : null;
  } catch { return null; }
}

function requireTarget(target) {
  if (!isDeepStrictEqual(searchRangeTarget(target?.query, target?.page), target)) {
    throw new ShoppingError('INVALID_SEARCH', 'Use a canonical unsorted search range target.');
  }
}
function requirePages(pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 5 || new Set(pages).size !== pages.length ||
      pages.some(page => !Number.isInteger(page) || page < 1 || page > 5)) {
    throw new ShoppingError('INVALID_SEARCH', 'Provide a nonempty unique set of allowed pages from one through five.');
  }
}

function collectRange(root, allowedPages, baseline, dom, parse, collect, home, controlsFor, cardLimit) {
  const target = parse(location.href);
  if (!target || target.query !== root.query || !allowedPages.includes(target.page)) return {state:'target_changed'};
  const raw = collect(target, false, dom, parse, home, cardLimit);
  if (raw.state !== 'observed') return raw;
  const controls = controlsFor(dom);
  if (controls.state) return controls;
  if (controls.value.current_page !== target.page) return {state:baseline ? 'structure_changed' : 'page_transition'};
  if (controls.value.next_disabled !== (controls.value.current_page === controls.value.total_pages_displayed)) return {state:'structure_changed'};
  if (!baseline) return {...raw, pagination:controls.value};
  const seen = new Set(), items = [];
  for (const [index, item] of raw.items.entries()) {
    if (!item.url) continue;
    const id = new URL(item.url).searchParams.get('id');
    if (seen.has(id)) continue;
    seen.add(id); items.push({position:index + 1,url:item.url});
  }
  if (target.page !== baseline.page || raw.cards_seen !== baseline.cards_seen || raw.items.length !== baseline.cards_scanned ||
      JSON.stringify(items) !== JSON.stringify(baseline.items) || JSON.stringify(controls.value) !== JSON.stringify(baseline.pagination)) {
    return {state:'target_changed'};
  }
  if (controls.value.next_disabled || target.page >= 5) return {state:'unsupported'};
  controls.next.click();
  return {state:'action_dispatched',clicked:true};
}

/**
 * Serialize a bounded read, or one next-page click guarded by the exact saved page/card order/pagination.
 * @param {object} target Canonical query identity.
 * @param {{allowedPages:number[],before?:object,cardLimit?:number}} options Saved permitted pages, optional baseline and the task's
 * cards-per-page limit (25 or 50), which a baseline page must share.
 * @returns {string} Fixed expression; all caller values are serialized as data.
 * @throws {ShoppingError} INVALID_SEARCH, INVALID_CHECKPOINT, or UNSUPPORTED_CAPABILITY before IO.
 * @example searchCollectionScript(searchRangeTarget('books',1), {allowedPages:[2,3]});
 */
export function searchCollectionScript(target, {allowedPages, before, cardLimit = SEARCH_RANGE_CARD_LIMIT} = {}) {
  requireTarget(target); requirePages(allowedPages); requireCardLimit(cardLimit);
  let baseline = null;
  if (before !== undefined) {
    validateSearchCollectionSnapshot(before, target, before?.search?.page, cardLimit);
    if (allowedPages.length !== 1 || allowedPages[0] !== before.search.page) {
      throw new ShoppingError('INVALID_SEARCH', 'A next-page action can only guard its checkpointed current page.');
    }
    if (before.search.page >= 5 || before.pagination.next_disabled) {
      throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'The current page cannot continue within the bounded search range.');
    }
    baseline = {page:before.search.page, cards_seen:before.search.cards_seen, cards_scanned:before.search.cards_scanned,
      items:before.search.items.map(item => ({position:item.position,url:item.url})), pagination:validatePagination(before.pagination,before.search.page)};
  }
  return `(() => { const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const parseSearchPageUrl = ${parseSearchPageUrl.toString()}; const searchRangeTarget = ${searchRangeTarget.toString()};
    const parseSearchRangeUrl = ${parseSearchRangeUrl.toString()};
    return (${collectRange.toString()})(${JSON.stringify(target)}, ${JSON.stringify(allowedPages)}, ${JSON.stringify(baseline)},
      (${pageDom.toString()})(), parseSearchRangeUrl, ${collectSearch.toString()}, ${isSearchHome.toString()}, ${pagination.toString()}, ${cardLimit}); })()`;
}

function rangePagination(value, page) {
  const normalized = validatePagination(value,page);
  if (normalized.next_disabled !== (normalized.current_page === normalized.total_pages_displayed)) {
    throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The displayed final page and next-button disabled state disagree.');
  }
  return normalized;
}

/**
 * Validate one raw page or transient display state under the exact saved page allowance.
 * @param {unknown} value Raw collector response. @param {object} target Canonical query. @param {number[]} allowedPages Saved permitted pages.
 * @param {{cardLimit?:number}} [options] The collector's cards-per-page limit (25 or 50).
 * @returns {object} An observed page or a page_transition marker; each page has at most `cardLimit` cards.
 * @throws {ShoppingError} Invalid bounds, known gates, invalid response, or PAGE_STRUCTURE_CHANGED.
 * @example validateSearchCollectionPage(raw, target, [2,3]);
 */
export function validateSearchCollectionPage(value, target, allowedPages, {cardLimit = SEARCH_RANGE_CARD_LIMIT} = {}) {
  requireTarget(target); requirePages(allowedPages); requireCardLimit(cardLimit); throwPageError(value?.state);
  if (value?.state === 'page_transition') {
    if (Object.keys(value).length !== 1) throw new ShoppingError('INVALID_RESPONSE', 'The page transition marker is invalid.');
    return {state:'page_transition'};
  }
  const actual = parseSearchRangeUrl(value?.url);
  if (!actual || actual.query !== target.query || !allowedPages.includes(actual.page)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The observed query or page is outside the saved search range.');
  }
  const search = validateSearch(value, actual, {cardLimit,allowPageRange:true}).result;
  return {state:'observed',page:{search,pagination:rangePagination(value.pagination,actual.page)}};
}

/**
 * Revalidate a cached page without upgrading its original time, coverage or displayed controls.
 * @param {unknown} value Saved {search,pagination}. @param {object} target Canonical query. @param {number} page Expected page.
 * @param {number} cardLimit The owning task's cards-per-page limit (25 or 50); the page must have been read with it.
 * @returns {object} The unchanged page value. @throws {ShoppingError} INVALID_CHECKPOINT before IO.
 * @example validateSearchCollectionSnapshot(savedPage, target, 3, 50);
 */
export function validateSearchCollectionSnapshot(value, target, page, cardLimit) {
  try {
    requireTarget(target); requireCardLimit(cardLimit);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'pagination,search') throw Error();
    validateSavedSearch(value.search, searchRangeTarget(target.query,page), {cardLimit,allowPageRange:true});
    rangePagination(value.pagination,page);
    return value;
  } catch {throw new ShoppingError('INVALID_CHECKPOINT', 'The saved bounded search page is invalid.');}
}
