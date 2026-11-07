import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';
import { parseDisplayedPrice } from './product.mjs';
import { pageDom, throwPageError, responseText } from './page-dom.mjs';

/**
 * Create one first-page, all-category keyword search identity.
 * @param {unknown} query @returns {object} Canonical search target.
 * @throws {ShoppingError} INVALID_SEARCH. @example searchTarget('罗技 M330')
 */
export function searchTarget(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new ShoppingError('INVALID_SEARCH', 'Supply one keyword query containing 1–100 characters.');
  }
  query = query.trim();
  return { platform: 'taobao', origin: 'https://s.taobao.com', pathname: '/search', query, page: 1,
    url: `https://s.taobao.com/search?q=${encodeURIComponent(query)}&page=1&tab=all` };
}

/**
 * Match a supported first-page search URL. Unknown business parameters are rejected.
 * @param {string} value @returns {object|null} Query identity, with tracking removed.
 */
export function parseSearchUrl(value) {
  const target = parseSearchPageUrl(value);
  return target?.page === 1 ? target : null;
}

/** @param {string} query @param {number} page @returns {object} Canonical first or second page identity. @throws {ShoppingError} INVALID_SEARCH. */
export function searchPageTarget(query, page) {
  const target = searchTarget(query);
  if (![1, 2].includes(page)) throw new ShoppingError('INVALID_SEARCH', 'Only the first two search pages are supported.');
  return { ...target, page, url: target.url.replace('&page=1&', `&page=${page}&`) };
}

/** @param {string} value @returns {object|null} First or second page, with no sorting or filter parameters accepted. */
export function parseSearchPageUrl(value) {
  try {
    const url = new URL(value);
    if (value.length > 16384 || url.origin !== 'https://s.taobao.com' || url.pathname !== '/search' || url.username || url.password || url.hash) return null;
    const allowed = new Set(['q', 'page', 'tab', 'spm', 'initiative_id', 'sourceId', 'commend', 'ie', 'clientPreloadId', 'preLoadId', 'preloadId', 'from', 'suggest']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key)) || url.searchParams.getAll('q').length !== 1 ||
        ['page', 'tab'].some(key => url.searchParams.getAll(key).length > 1) ||
        (url.searchParams.has('page') && !['1', '2'].includes(url.searchParams.get('page'))) ||
        (url.searchParams.has('tab') && url.searchParams.get('tab') !== 'all')) return null;
    const target = searchPageTarget(url.searchParams.get('q'), Number(url.searchParams.get('page') ?? 1));
    return target.query === url.searchParams.get('q') ? target : null;
  } catch { return null; }
}

/**
 * Preserve an observed URL sort token as data, without assigning it a sorting meaning or navigating to it.
 * @param {string} query @param {number} page @param {string} sortParameter
 * @returns {object} Canonical observed search identity. @throws {ShoppingError} INVALID_SEARCH.
 */
export function searchSortTarget(query, page, sortParameter) {
  const target = searchPageTarget(query, page);
  if (typeof sortParameter !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(sortParameter)) {
    throw new ShoppingError('INVALID_SEARCH', 'The observed sort token is unsupported.');
  }
  return { ...target, sort_parameter: sortParameter, url: `${target.url}&sort=${encodeURIComponent(sortParameter)}` };
}

/** @param {string} value @returns {object|null} A first/second page with at most one bounded sort token; other business parameters remain rejected. */
export function parseSortableSearchUrl(value) {
  try {
    const url = new URL(value);
    if (value.length > 16384 || url.searchParams.getAll('sort').length > 1) return null;
    if (!url.searchParams.has('sort')) return parseSearchPageUrl(value);
    const token = url.searchParams.get('sort');
    url.searchParams.delete('sort');
    const target = parseSearchPageUrl(url.href);
    return target ? searchSortTarget(target.query, target.page, token) : null;
  } catch { return null; }
}

/** @param {string} value @returns {boolean} Whether navigation may start from this exact public homepage. */
export function isSearchHome(value) {
  try { const url = new URL(value); return url.origin === 'https://www.taobao.com' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}

/** Internal serialized collector. @param {object} expected @param {boolean} navigate @param {object} dom @param {Function} parseSearch @param {Function} isHome @param {number} cardLimit @returns {object} Raw guarded page observation. */
export function collectSearch(expected, navigate, dom, parseSearch, isHome, cardLimit = 50) {
  const current = location.href;
  const home = isHome(current);
  if (!home && parseSearch(current)?.url !== expected.url) return { state: 'target_changed' };
  const blocked = dom.gate();
  if (blocked) return { state: blocked };
  if (document.readyState !== 'complete') return { state: 'loading' };
  if (home) {
    if (!navigate) return { state: 'action_required' };
    location.assign(expected.url);
    return { state: 'action_dispatched', clicked: true };
  }
  if (navigate) return { state: 'action_dispatched', clicked: false };
  const cards = dom.all(document, dom.selector('doubleCardWrapperAdapt')).filter(node => node.tagName === 'A');
  // Logged out, the results shell renders no cards (and may have an empty title); the only signal is the site-nav login link.
  const loginPrompt = !cards.length && dom.all(document, 'a').some(link => {
    try {
      const url = new URL(link.getAttribute('href') ?? '', location.href);
      return url.hostname === 'login.taobao.com' && url.pathname === '/member/login.jhtml' && /请登录/.test(dom.text(link, 20));
    } catch { return false; }
  });
  if (loginPrompt) return { state: 'login_required' };
  // Logged in, the same empty shell with only this load-failure text appeared after many rapid searches (2026-10-12).
  if (!cards.length && dom.all(document, dom.selector('leftContent')).some(region => /网络信号走丢/.test(dom.text(region, 2000)))) {
    return { state: 'search_results_unavailable' };
  }
  const queryInputs = [...document.querySelectorAll('input[name="q"]')];
  if (queryInputs.length !== 1 || queryInputs[0].value !== expected.query || !document.title.includes(expected.query)) return { state: 'structure_changed' };
  if (!cards.length) return { state: 'structure_changed' };
  const items = cards.slice(0, cardLimit).map(card => {
    let productUrl;
    try {
      const url = new URL(card.href);
      const ids = url.searchParams.getAll('id');
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
          !['item.taobao.com', 'detail.tmall.com'].includes(url.hostname) || url.pathname !== '/item.htm' ||
          ids.length !== 1 || !/^[0-9]{1,64}$/.test(ids[0])) return { url: null };
      productUrl = `${url.origin}${url.pathname}?id=${ids[0]}`;
    } catch { return { url: null }; }
    const price = dom.one(card, 'priceWrapper');
    return { url: productUrl, title: dom.text(dom.one(card, 'title'), 300),
      shop: dom.text(dom.one(card, 'shopNameText'), 200),
      price: { raw: dom.text(price, 500), amount_text: dom.text(dom.one(card, 'priceInt'), 40) + dom.text(dom.one(card, 'priceFloat'), 40),
        label: dom.text(dom.one(card, 'priceDesc'), 120) },
      sales_text: dom.text(dom.one(card, 'realSales'), 120) };
  });
  return { state: 'observed', url: expected.url, query: expected.query, items, cards_seen: cards.length };
}

/** @param {object} target @param {boolean} [navigate] @returns {string} Fixed guarded search read or homepage navigation. @throws {ShoppingError} INVALID_SEARCH. */
export function searchScript(target, navigate = false) {
  const expected = searchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_SEARCH', 'Use a canonical search target.');
  // These pure URL parsers close only over searchTarget, supplied inside the expression.
  return `(() => { const searchTarget = ${searchTarget.toString()}; const searchPageTarget = ${searchPageTarget.toString()};
    const parseSearchPageUrl = ${parseSearchPageUrl.toString()}; const parseSearch = ${parseSearchUrl.toString()};
    return (${collectSearch.toString()})(${JSON.stringify(expected)}, ${JSON.stringify(navigate)}, (${pageDom.toString()})(), parseSearch, ${isSearchHome.toString()}); })()`;
}

/** @param {unknown} value @param {object} target @param {{cardLimit?: number, allowSort?: boolean, allowPageRange?: boolean}} options Range mode allows only unsorted pages 1–5 with twenty-five (tasks before 2026-10-14) or fifty cards. @returns {object} An action request or bounded search result. @throws {ShoppingError} Page or response errors. */
export function validateSearch(value, target, { allowPageRange = false, cardLimit = allowPageRange ? 25 : 50, allowSort = false } = {}) {
  let expected;
  if (allowPageRange) {
    if (allowSort || target?.sort_parameter !== undefined || !Number.isInteger(target?.page) || target.page < 1 || target.page > 5 || ![25, 50].includes(cardLimit)) {
      throw new ShoppingError('INVALID_SEARCH', 'Range mode requires unsorted pages one through five and a twenty-five- or fifty-card limit.');
    }
    const first = searchTarget(target?.query);
    expected = { ...first, page: target.page, url: first.url.replace('&page=1&', `&page=${target.page}&`) };
  } else expected = allowSort && target?.sort_parameter !== undefined
    ? searchSortTarget(target.query, target.page, target.sort_parameter) : searchPageTarget(target?.query, target?.page);
  if (!Number.isInteger(cardLimit) || cardLimit < 1 || cardLimit > 50 ||
      JSON.stringify(expected) !== JSON.stringify(target)) {
    throw new ShoppingError('INVALID_SEARCH', 'Use a canonical page target and a card limit from 1 to 50.');
  }
  throwPageError(value?.state);
  if (value?.state === 'action_required') return { state: 'action_required' };
  if (value?.state !== 'observed' || value.url !== target.url || value.query !== target.query ||
      !Array.isArray(value.items) || value.items.length < 1 || value.items.length > cardLimit ||
      !Number.isSafeInteger(value.cards_seen) || value.cards_seen < value.items.length || value.cards_seen > 10000) {
    throw new ShoppingError('INVALID_RESPONSE', 'The search response does not match the requested first page.');
  }
  const ids = new Set();
  const items = [];
  let unsupported = 0;
  value.items.forEach((item, index) => {
    // Sponsored redirect cards have no verified direct item identity; never follow them.
    if (item?.url === null) { unsupported += 1; return; }
    const product = parseProductUrl(item?.url);
    const title = responseText(item?.title, 300);
    if (!product || !title) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'A search card is missing its product identity or title.');
    const raw = responseText(item.price?.raw, 500), amountText = responseText(item.price?.amount_text, 80), label = responseText(item.price?.label, 120);
    const normalized = { position: index + 1, product_id: product.product_id, url: product.url, title,
      shop: responseText(item.shop, 200), sales_text: responseText(item.sales_text, 120),
      price: { raw, amount_text: amountText, label, ...parseDisplayedPrice(amountText, raw), currency: 'CNY', eligibility_verified: false, sku_price_binding_verified: false } };
    if (!ids.has(product.product_id)) { ids.add(product.product_id); items.push(normalized); }
  });
  if (!items.length) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'No loaded search card has a supported direct product identity.');
  return { state: 'ready', result: {
    query: target.query, url: target.url, page: target.page, source: 'loaded_search_cards', observed_at: new Date().toISOString(), login_verified: false,
    items, cards_seen: value.cards_seen, cards_scanned: value.items.length,
    duplicates_omitted: value.items.length - items.length - unsupported, unsupported_cards_omitted: unsupported,
    coverage: { status: 'partial', scope: target.page === 1 ? 'first_page_loaded_cards' : 'loaded_page_cards', sort_verified: false, filters_verified: false, total_results_known: false },
    limits: { cards: cardLimit }, missing: ['subsequent_pages', 'verified_sort_and_filters', 'verified_payable_prices'],
  } };
}

/** @param {object} value @param {object} target @param {{cardLimit?: number, allowSort?: boolean, allowPageRange?: boolean}} options Range mode keeps unsorted pages 1–5 and twenty-five-card scope separate from legacy defaults. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for modified cached search data. */
export function validateSavedSearch(value, target, { allowPageRange = false, cardLimit = allowPageRange ? 25 : 50, allowSort = false } = {}) {
  try {
    if (typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) ||
        !Number.isSafeInteger(value.cards_scanned) || value.cards_scanned < value.items.length || value.cards_scanned > cardLimit ||
        !Number.isSafeInteger(value.duplicates_omitted) || value.duplicates_omitted < 0 ||
        !Number.isSafeInteger(value.unsupported_cards_omitted) || value.unsupported_cards_omitted < 0 ||
        value.duplicates_omitted + value.unsupported_cards_omitted !== value.cards_scanned - value.items.length) throw new Error();
    const normalized = validateSearch({ state: 'observed', url: value.url, query: value.query, cards_seen: value.cards_seen,
      items: value.items.map(item => ({ url: item.url, title: item.title, shop: item.shop, sales_text: item.sales_text, price: item.price })) }, target, { cardLimit, allowSort, allowPageRange }).result;
    let previous = 0;
    normalized.items.forEach((item, index) => {
      const position = value.items[index].position;
      if (!Number.isInteger(position) || position <= previous || position > value.cards_scanned) throw new Error();
      item.position = position; previous = position;
    });
    normalized.observed_at = value.observed_at;
    normalized.cards_scanned = value.cards_scanned; normalized.duplicates_omitted = value.duplicates_omitted;
    normalized.unsupported_cards_omitted = value.unsupported_cards_omitted;
    if (value.cards_seen < value.cards_scanned || JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved search result is invalid.'); }
}
