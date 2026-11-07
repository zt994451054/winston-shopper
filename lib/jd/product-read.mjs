import { ShoppingError, publicError } from '../errors.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { parseJdProductUrl } from './targets.mjs';
import { JD_PRODUCT_SCHEMA_VERSION, validateJdProductObservation } from './product.mjs';

// Reads of one product: the first read plus up to three checks after the single scroll; failed reads also count.
const MAX_OBSERVATIONS = 6;
const MAX_CHECKS = 3;
// The 2026-10-15 probes found the 商品详情 section loaded 6 s after the scroll; checks follow 5 s, then 3 s apart.
const SETTLE_MS = 5_000;
const RECHECK_MS = 3_000;
const STATE_KEYS = ['checks', 'initial', 'last', 'not_before', 'observations', 'schema_version', 'scroll', 'scroll_error', 'scroll_reserved'];

/** @returns {object} A fresh journal: no read, no scroll. */
export function newJdProductReadState() {
  return { schema_version: JD_PRODUCT_SCHEMA_VERSION, observations: 0, checks: 0, initial: null, scroll_reserved: false, scroll: null, scroll_error: null,
    last: null, not_before: 0 };
}

const settled = status => ['loaded', 'section_missing'].includes(status);
const position = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

/**
 * @param {object} state Saved journal. @param {object} target Bound JD product.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent reads, scroll records or budgets.
 */
export function validateJdProductReadState(state, target) {
  try {
    // The journal's version is also its result format. Versions 1 and 2 are the first two live runs, 3 the third.
    if (!state || Object.keys(state).sort().join(',') !== STATE_KEYS.join(',') || ![1, 2, 3, 4].includes(state.schema_version) ||
        !integer(state.observations, MAX_OBSERVATIONS) || !integer(state.checks, MAX_CHECKS) || typeof state.scroll_reserved !== 'boolean' ||
        !integer(state.not_before, Number.MAX_SAFE_INTEGER) ||
        (state.scroll_error !== null && (typeof state.scroll_error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(state.scroll_error)))) throw new Error();
    if (state.scroll !== null && (Object.keys(state.scroll).sort().join(',') !== 'scroll_y_after,scroll_y_before' ||
        !position(state.scroll.scroll_y_before) || !position(state.scroll.scroll_y_after))) throw new Error();
    if ((state.initial === null) !== (state.last === null) || (state.last && state.observations < 1 + state.checks)) throw new Error();
    if (state.initial !== null) {
      if (Object.keys(state.initial).sort().join(',') !== 'detail_status,observed_at,title_in_view' || !timestamp(state.initial.observed_at) ||
          !['loaded', 'not_loaded', 'empty', 'section_missing'].includes(state.initial.detail_status) ||
          ![true, false, null].includes(state.initial.title_in_view)) throw new Error();
      if (Object.keys(state.last).sort().join(',') !== 'observed_at,raw' || !timestamp(state.last.observed_at)) throw new Error();
      validateJdProductObservation(state.last.raw, target, { schemaVersion: state.schema_version });
    }
    // A scroll happens only after a first read showed an unloaded section, and checks only after a scroll.
    if (state.scroll_reserved && (!state.initial || settled(state.initial.detail_status))) throw new Error();
    if (!state.scroll_reserved && (state.scroll !== null || state.scroll_error !== null || state.checks > 0)) throw new Error();
    if (state.scroll !== null && state.scroll_error !== null) throw new Error();
    if (!state.scroll_reserved && state.initial && Date.parse(state.last.observed_at) !== Date.parse(state.initial.observed_at)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The JD product read journal is invalid.'); }
}

function finished(state) {
  if (!state.last) return false;
  return settled(state.last.raw.detail.status) || (state.scroll_reserved && state.checks >= MAX_CHECKS);
}

// A missing block records only that status. A loaded one names what this read never collects.
function reviewSummary(reviews) {
  if (reviews.status !== 'loaded') return { status: 'missing' };
  return { ...reviews, excluded: ['nicknames', 'avatars', 'review_images'] };
}

/**
 * Build the product result from a finished journal. The page's other spec options are listed as 同组规格 only:
 * on JD each spec is its own product (user, 2026-10-15), so no price or stock is carried over to them.
 * Format 4 adds review_summary after detail. Formats 1-3 leave the result unchanged.
 * @param {object} state Finished journal. @param {object} target @returns {object} Product result.
 */
export function jdProductResult(state, target) {
  const normalized = validateJdProductObservation(state.last.raw, target, { schemaVersion: state.schema_version });
  const { panel, detail } = normalized;
  const loaded = detail.status === 'loaded';
  const withReviews = state.schema_version === 4;
  return {
    schema_version: state.schema_version, platform: 'jd', product_id: target.product_id, url: target.url, source: 'jd_product_page', observed_at: state.last.observed_at,
    login_verified: false, ...panel, detail,
    ...(withReviews ? { review_summary: reviewSummary(normalized.reviews) } : {}),
    detail_action: { initial_observed_at: state.initial.observed_at, initial_status: state.initial.detail_status,
      scroll_reserved: state.scroll_reserved, scroll: state.scroll, scroll_error: state.scroll_error,
      observations_reserved: state.observations, checks_after_scroll: state.checks },
    coverage: { status: 'partial', scope: 'single_product_page', same_group_specs_are_separate_products: true,
      same_group_spec_prices_read: false, detail_section_loaded: loaded, full_description_verified: false, reviews_read: false,
      ...(withReviews ? { review_summary_read: normalized.reviews.status === 'loaded' } : {}) },
    missing: ['same_group_spec_prices', 'reviews', 'verified_payable_price', ...(loaded ? [] : ['detail_section']),
      ...(withReviews && normalized.reviews.status !== 'loaded' ? ['review_summary'] : [])],
  };
}

/**
 * @param {object} result Saved result. @param {object} target @param {object} state Saved journal.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validateJdProductResult(result, target, state) {
  try {
    validateJdProductReadState(state, target);
    if (!finished(state) || JSON.stringify(jdProductResult(state, target)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The JD product result does not match its journal.'); }
}

/**
 * Read one bound JD product page; if its 商品详情 section is still a skeleton, scroll to it once and check again.
 * The scroll is recorded before it is sent and is never repeated, including after an interruption.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Product result; a section still unloaded after the checks is reported as missing.
 * @throws {ShoppingError} Page gates, target changes, an unsent scroll's error or an exhausted read budget.
 */
export async function runJdProductRead({ bridge, op, commit, now, wait }) {
  const state = op.product_read;
  if (!parseJdProductUrl(op.target?.url)) throw new ShoppingError('INVALID_CHECKPOINT', 'The JD product target is invalid.');
  while (!finished(state)) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15_000) throw new ShoppingError('CLOCK_CHANGED', 'The JD product wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (state.last && !state.scroll_reserved) {
      state.scroll_reserved = true; await commit();
      try { state.scroll = await bridge.scrollJdDetails(op.tab_id, op.target); }
      catch (error) {
        // Refused before anything reached the page: the scroll is released. Otherwise it may have happened and stays spent.
        if (error.actionNotDispatched) { state.scroll_reserved = false; await commit(); throw error; }
        state.scroll_error = publicError(error).code;
      }
      state.not_before = now() + SETTLE_MS; await commit(); continue;
    }
    if (state.observations >= MAX_OBSERVATIONS) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The JD product read budget is exhausted.');
    state.observations += 1;
    if (state.scroll_reserved) state.checks += 1;
    await commit();
    const { observed_at: observedAt, raw } = await bridge.readJdProduct(op.tab_id, op.target);
    const detail = raw.detail;
    state.last = { observed_at: observedAt, raw };
    state.initial ??= { observed_at: observedAt, detail_status: detail.status, title_in_view: detail.status === 'section_missing' ? null : detail.title_in_view };
    op.recovery_kind = null;
    state.not_before = state.scroll_reserved ? now() + RECHECK_MS : 0;
    await commit();
  }
  return jdProductResult(state, op.target);
}
