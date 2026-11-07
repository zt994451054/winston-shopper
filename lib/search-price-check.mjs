import { loadTask, validateTask } from './task-store.mjs';
import { createSearchPriceRequest, parseCnyAmount } from './search-price-request.mjs';
import { ShoppingError } from './errors.mjs';

const SUPPORTED_KINDS = new Set(['search', 'search_pages', 'search_collection']);
const CHECK_OPTIONS = ['sort', 'minPrice', 'maxPrice', 'reviewedAt'];

function argumentsError() {
  return new ShoppingError('INVALID_ARGUMENTS', 'Supply a price direction or an exact CNY price boundary using the supported options.');
}

function requireOptions(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => !allowed.includes(key))) throw argumentsError();
}

function reviewTime(value = new Date().toISOString()) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw argumentsError();
  return value;
}

function requestFor(query, options) {
  return createSearchPriceRequest({ query, sort: options.sort ?? null,
    minPrice: options.minPrice ?? null, maxPrice: options.maxPrice ?? null });
}

function reference(row) {
  return { page: row.page, position: row.position, product_id: row.product_id, observed_at: row.observed_at };
}

function rangeStatus(price, range) {
  if (range.minimum === null && range.maximum === null) return 'not_requested';
  if (price === null) return 'unknown';
  return (range.minimum !== null && price.cents < range.minimum.cents) ||
    (range.maximum !== null && price.cents > range.maximum.cents) ? 'outside' : 'within';
}

function recordsFor(snapshots, request) {
  return snapshots.flatMap(snapshot => snapshot.items.map(item => {
    // Starting and ranged prices cannot establish the displayed price of a specific SKU.
    const comparable = item.price.kind === 'single_displayed' ? parseCnyAmount(item.price.amount) : null;
    return { page: snapshot.page, position: item.position, product_id: item.product_id, url: item.url, title: item.title,
      observed_at: snapshot.observed_at, price: structuredClone(item.price), comparable_price: comparable,
      uncertainty: comparable === null ? item.price.kind : null,
      range_status: rangeStatus(comparable, request.price_range) };
  }));
}

function orderCheck(records, direction) {
  const known = records.filter(row => row.comparable_price !== null), violations = [];
  if (direction === null) return { status: 'not_requested', direction: null, comparable_records: known.length,
    unknown_records: records.length - known.length, comparisons: 0, violations };
  for (let index = 1; index < known.length; index++) {
    const previous = known[index - 1], current = known[index];
    const difference = current.comparable_price.cents - previous.comparable_price.cents;
    if (direction === 'price-asc' ? difference < 0 : difference > 0) {
      violations.push({ previous: reference(previous), current: reference(current),
        previous_price: previous.comparable_price.amount, current_price: current.comparable_price.amount });
    }
  }
  const unknown = records.length - known.length;
  return { status: violations.length ? 'contradicted_sample' : unknown || known.length < 2 ? 'inconclusive_sample' : 'matched_sample',
    direction, comparable_records: known.length, unknown_records: unknown,
    comparisons: Math.max(0, known.length - 1), violations };
}

function rangeCheck(records, range) {
  const outside = records.filter(row => row.range_status === 'outside').map(reference);
  const unknown = records.filter(row => row.range_status === 'unknown').length;
  const requested = range.minimum !== null || range.maximum !== null;
  return { status: !requested ? 'not_requested' : outside.length ? 'contradicted_sample' : unknown ? 'inconclusive_sample' : 'matched_sample',
    minimum: range.minimum, maximum: range.maximum, inclusive: true,
    comparable_records: records.filter(row => row.comparable_price !== null).length, unknown_records: unknown, outside };
}

/**
 * Assess saved page snapshots against a validated price request, keeping the original order.
 * @param {object[]} snapshots Saved search snapshots in platform order. @param {object} request createSearchPriceRequest output.
 * @returns {{records: object[], order_check: object, range_check: object, overall_status: string}} Displayed-price sample checks only.
 * @example assessDisplayedPrices([snapshot], request);
 */
export function assessDisplayedPrices(snapshots, request) {
  const records = recordsFor(snapshots, request), order = orderCheck(records, request.price_sort);
  const range = rangeCheck(records, request.price_range), statuses = [order.status, range.status];
  return { records, order_check: order, range_check: range,
    overall_status: statuses.includes('contradicted_sample') ? 'contradicted_sample' :
      statuses.includes('inconclusive_sample') ? 'inconclusive_sample' : 'matched_sample' };
}

/**
 * Reorder records locally by comparable displayed price. Unknown prices follow in their original order.
 * This is a convenience view for callers and never claims to be the platform order.
 * @param {object[]} records assessDisplayedPrices records. @param {'price-asc'|'price-desc'} direction
 * @returns {object[]} Ranked copies keeping the platform page and position.
 * @example localPriceOrder(records, 'price-asc');
 */
export function localPriceOrder(records, direction) {
  if (!['price-asc', 'price-desc'].includes(direction)) throw argumentsError();
  const known = records.filter(row => row.comparable_price !== null);
  const unknown = records.filter(row => row.comparable_price === null);
  // Array sort is stable, so equal prices keep their platform order.
  known.sort((a, b) => direction === 'price-asc' ? a.comparable_price.cents - b.comparable_price.cents : b.comparable_price.cents - a.comparable_price.cents);
  return [...known, ...unknown].map((row, index) => ({ local_rank: index + 1, platform_page: row.page, platform_position: row.position,
    product_id: row.product_id, url: row.url, title: row.title, comparable_price: row.comparable_price,
    uncertainty: row.uncertainty, range_status: row.range_status }));
}

/**
 * Check the original saved search order and displayed prices against a local request.
 * @param {object} saved A complete, validated search, search_pages or search_collection checkpoint.
 * @param {{sort?: string|null, minPrice?: string|null, maxPrice?: string|null, reviewedAt?: string}} options Price intent and optional ISO review time.
 * @returns {object} Partial sample assessment with original positions and collection times; no platform application evidence.
 * @throws {ShoppingError} INVALID_ARGUMENTS, INVALID_CHECKPOINT, UNSUPPORTED_CAPABILITY or CACHE_NOT_COMPLETE.
 * @example buildSearchPriceCheck(saved, {sort: 'price-asc', maxPrice: '100'});
 */
export function buildSearchPriceCheck(saved, options = {}) {
  requireOptions(options, CHECK_OPTIONS);
  const reviewedAt = reviewTime(options.reviewedAt);
  // Legacy validation fills optional recovery fields; isolate that normalization from the caller's evidence.
  saved = structuredClone(saved);
  validateTask(saved);
  if (!SUPPORTED_KINDS.has(saved.kind)) {
    throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Cached price checks support ordinary searches and confirmed search page collections only.');
  }
  if (saved.status !== 'complete') {
    throw new ShoppingError('CACHE_NOT_COMPLETE', 'The search cache is incomplete; this command will not execute or resume it.');
  }
  const operation = saved.operations[0], request = requestFor(operation.target.query, options);
  const pages = saved.kind === 'search' ? null : operation.result.pages;
  const snapshots = pages ? pages.map(page => page.search) : [operation.result];
  const { records, order_check: order, range_check: range, overall_status: overall } = assessDisplayedPrices(snapshots, request);
  return { ok: true, status: 'cached_prices_checked', schema_version: 1, scope: 'cached_displayed_prices', request,
    reviewed_at: reviewedAt, source: { task: saved.id, kind: saved.kind, status: saved.status,
      observations: snapshots.map((snapshot, index) => ({ page: snapshot.page, url: snapshot.url, observed_at: snapshot.observed_at,
        coverage: structuredClone(snapshot.coverage), cards_seen: snapshot.cards_seen, cards_scanned: snapshot.cards_scanned,
        duplicates_omitted: snapshot.duplicates_omitted, unsupported_cards_omitted: snapshot.unsupported_cards_omitted,
        ...(pages ? { pagination: structuredClone(pages[index].pagination) } : {}) })) },
    records, order_check: order, range_check: range, overall_status: overall,
    platform_applied: false, platform_sort_verified: false, platform_filter_verified: false,
    browser_accessed: false, state_changed: false, actions_reserved: 0,
    coverage: { status: 'partial', scope: 'saved_search_records', total_results_known: false },
    missing: ['platform_price_controls_and_applied_state', 'unsaved_search_cards_and_pages',
      'verified_sku_bound_and_payable_prices'] };
}

/**
 * Load and check an existing cache without browser IO, locks, task execution or state writes.
 * @param {{stateDirectory: string, task: string, sort?: string|null, minPrice?: string|null, maxPrice?: string|null, reviewedAt?: string}} options Local cache identity and price intent.
 * @returns {Promise<object>} Original-position sample assessment.
 * @throws {ShoppingError} Invalid arguments, missing/modified checkpoints, unsupported kinds or incomplete caches.
 * @example await checkCachedSearchPrices({stateDirectory: './state', task: 'search', sort: 'price-desc'});
 */
export async function checkCachedSearchPrices(options) {
  requireOptions(options, ['stateDirectory', 'task', ...CHECK_OPTIONS]);
  if (typeof options.stateDirectory !== 'string' || !options.stateDirectory.trim() || options.stateDirectory.includes('\0')) throw argumentsError();
  requestFor('Price request validation', options);
  const reviewedAt = reviewTime(options.reviewedAt);
  const saved = await loadTask(options.stateDirectory, options.task);
  return buildSearchPriceCheck(saved, { sort: options.sort, minPrice: options.minPrice, maxPrice: options.maxPrice, reviewedAt });
}
