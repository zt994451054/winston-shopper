import { ShoppingError } from './errors.mjs';
import { searchTarget } from './search.mjs';

const REQUEST_KEYS = new Set(['query', 'sort', 'minPrice', 'maxPrice']);
const DIRECTION_EVIDENCE = ['visible_price_direction_option', 'price_direction_option_relation_to_entry', 'applied_price_direction_state'];
const RANGE_EVIDENCE = ['price_range_input_identities', 'price_range_input_constraints', 'price_range_submit_control', 'applied_price_range_values'];

/**
 * Parse a CNY decimal string without rounding or accepting currency/sign notation.
 * @param {unknown} value Plain nonnegative decimal text, at most nine integer digits and two decimal places.
 * @returns {{amount:string,cents:number}} Canonical two-decimal amount and exact safe-integer cents.
 * @throws {ShoppingError} INVALID_ARGUMENTS for nonstrings, whitespace, leading zeroes or unsupported precision.
 * @example parseCnyAmount('9.1'); // {amount:'9.10',cents:910}
 */
export function parseCnyAmount(value) {
  if (typeof value !== 'string') {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a CNY amount as plain decimal text.');
  }
  const match = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/.exec(value);
  // The end anchor can match before a final newline; the amount must consume every character.
  if (!match || match[0] !== value) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a nonnegative CNY decimal with at most nine integer digits and two decimal places, without whitespace or leading zeroes.');
  }
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return { amount: `${match[1]}.${fraction}`, cents: Number(match[1]) * 100 + Number(fraction) };
}

/**
 * Create a price sorting/range request contract without applying it to a platform.
 * @param {object} options Request fields; unknown own keys are rejected.
 * @param {string} options.query Keyword accepted and canonicalized by searchTarget.
 * @param {'price-asc'|'price-desc'|null} [options.sort=null] Desired platform price direction.
 * @param {string|null} [options.minPrice=null] Inclusive minimum CNY amount.
 * @param {string|null} [options.maxPrice=null] Inclusive maximum CNY amount.
 * @returns {object} Schema 1 Taobao request with canonical query, price_sort and parsed price_range.
 * @param {{allowNoPrice?: boolean}} [mode] A search-conditions task (天猫, 包邮) may request no price behavior at all.
 * @throws {ShoppingError} INVALID_ARGUMENTS for invalid options, unsupported direction, no requested behavior or an inverted range; INVALID_SEARCH for an invalid query.
 * @example createSearchPriceRequest({query:'图书',sort:'price-asc',maxPrice:'100'});
 */
export function createSearchPriceRequest(options, { allowNoPrice = false } = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => !REQUEST_KEYS.has(key))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Provide only query, sort, minPrice and maxPrice request fields.');
  }
  const { query, sort = null, minPrice = null, maxPrice = null } = options;
  if (![null, 'price-asc', 'price-desc'].includes(sort)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Choose price-asc, price-desc or no price direction.');
  }
  if (sort === null && minPrice === null && maxPrice === null && !allowNoPrice) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Request a price direction or at least one price boundary.');
  }
  const target = searchTarget(query);
  const minimum = minPrice === null ? null : parseCnyAmount(minPrice);
  const maximum = maxPrice === null ? null : parseCnyAmount(maxPrice);
  if (minimum && maximum && minimum.cents > maximum.cents) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'The minimum price cannot exceed the maximum price.');
  }
  return { schema_version: 1, platform: 'taobao', query: target.query, price_sort: sort,
    price_range: { currency: 'CNY', minimum, maximum, inclusive: true } };
}

/**
 * Prepare only the validated contract and its missing natural layout evidence.
 * This plan neither implements nor applies platform sorting/filtering and performs no browser or state IO.
 * @param {object} options Query/direction/range fields accepted by createSearchPriceRequest.
 * @returns {object} waiting_layout_evidence plan with the request, needed evidence IDs and explicit zero-side-effect flags.
 * @throws {ShoppingError} INVALID_ARGUMENTS or INVALID_SEARCH when the request is invalid.
 * @example planSearchPriceRequest({query:'图书',minPrice:'10',maxPrice:'100'});
 */
export function planSearchPriceRequest(options) {
  const request = createSearchPriceRequest(options);
  const requiredEvidence = [];
  if (request.price_sort !== null) requiredEvidence.push(...DIRECTION_EVIDENCE);
  if (request.price_range.minimum !== null || request.price_range.maximum !== null) requiredEvidence.push(...RANGE_EVIDENCE);
  return { ok: true, status: 'waiting_layout_evidence', request,
    platform_sort_implemented: false, platform_filter_implemented: false, platform_applied: false,
    browser_accessed: false, state_changed: false, actions_reserved: 0, required_evidence: requiredEvidence };
}
