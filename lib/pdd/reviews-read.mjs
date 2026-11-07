import { ShoppingError, publicError } from '../errors.mjs';
import { savedTabUrl } from '../saved-tab.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { validatePddReviews } from './reviews.mjs';
import { parsePddProductUrl, parsePddReviewsUrl, pddLandingKind, pddRiskPageError, pddSearchTarget } from './targets.mjs';

// A journal's format is its result's format: 2 adds page_notes, 3 counts skipped review blocks. Older journals are rebuilt as saved.
const SCHEMA_VERSION = 3;
// The review page replaced the product page within 8 s of the click on 2026-10-27.
const SETTLE_MS = 8_000;
const RECHECK_MS = 4_000;
const MAX_CHECKS = 3;
// A review page still rendering is read once more, 10 s later; nothing is clicked again.
const MAX_READS = 2;
const REREAD_MS = 10_000;
const UNFINISHED_PAGE = new Set(['PAGE_STRUCTURE_CHANGED', 'PAGE_LOADING']);
const CLOCK_LIMIT_MS = 15_000;
const STATE_KEYS = ['schema_version', 'product_task', 'product_id', 'product_title', 'review_count', 'source_observed_at', 'click_reserved', 'click',
  'click_error', 'checks', 'reads', 'page', 'not_before'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/**
 * @param {string} productTask The completed pdd_product task whose tab shows the product page.
 * @param {object} product Its saved result: product_id, title, observed_at and reviews (null when the page had no review area).
 * @returns {object} A fresh journal: nothing clicked or read. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function newPddReviewsReadState(productTask, product) {
  const count = product?.reviews === null ? null : product?.reviews?.count;
  if (!parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${product?.product_id}`) || typeof product.title !== 'string' || !product.title ||
      !timestamp(product.observed_at) || !(count === null || (Number.isSafeInteger(count) && count >= 0))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'The source product result is not a supported PDD product read.');
  }
  return { schema_version: SCHEMA_VERSION, product_task: productTask, product_id: product.product_id, product_title: product.title,
    review_count: count, source_observed_at: product.observed_at, click_reserved: false, click: null, click_error: null, checks: 0, reads: 0,
    page: null, not_before: 0 };
}

/** A product with no review area, or 商品评价(0), is answered from the product read without touching the tab. */
const hasNoReviews = state => state.review_count === null || state.review_count === 0;

/**
 * Accept a partial journal, including a click reserved but not yet acknowledged.
 * @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validatePddReviewsReadState(state) {
  try {
    if (!sameKeys(state, STATE_KEYS) || ![1, 2, SCHEMA_VERSION].includes(state.schema_version) || typeof state.product_task !== 'string' || !state.product_task ||
        !parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${state.product_id}`) || typeof state.product_title !== 'string' ||
        !state.product_title || state.product_title.length > 600 || !(state.review_count === null || integer(state.review_count, 100_000_000)) ||
        !timestamp(state.source_observed_at) || typeof state.click_reserved !== 'boolean' || ![null, 'clicked', 'uncertain'].includes(state.click) ||
        (state.click_error !== null && !(typeof state.click_error === 'string' && CODE.test(state.click_error))) ||
        !integer(state.checks, MAX_CHECKS) || !integer(state.reads, MAX_READS) || !integer(state.not_before, Number.MAX_SAFE_INTEGER)) throw new Error();
    if (hasNoReviews(state) && (state.click_reserved || state.reads > 0 || state.page !== null)) throw new Error();
    // Each step needs the one before it: the click, the review page address, then the read.
    if (!state.click_reserved && (state.click !== null || state.checks > 0 || state.reads > 0)) throw new Error();
    if ((state.click === 'uncertain') !== (state.click_error !== null)) throw new Error();
    if (state.reads > 0 && state.click === null) throw new Error();
    if (state.page !== null) {
      if (!sameKeys(state.page, ['observed_at', 'raw']) || !timestamp(state.page.observed_at) || state.reads < 1) throw new Error();
      validatePddReviews(state.page.raw, state.product_id, { observedAt: state.page.observed_at, version: state.schema_version });
    }
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD reviews read journal is invalid.'); }
}

/**
 * Build the reviews result from a finished journal.
 * @param {object} state Finished journal. @param {{query: string}} target The search page the product came from. @returns {object}
 */
export function pddReviewsResult(state, target) {
  const entry = { product_task: state.product_task, query: target.query, product_title: state.product_title, review_count_on_product_page: state.review_count,
    click: state.click, click_error: state.click_error, address_checks: state.checks, reads_reserved: state.reads };
  const version = state.schema_version;
  const base = { schema_version: version, platform: 'pdd', source: 'pdd_reviews_page', login_verified: false, entry };
  const excluded = ['reviewer_names', 'reviewer_avatars', 'review_buttons'];
  if (hasNoReviews(state)) {
    return { ...base, observed_at: state.source_observed_at, outcome: 'no_reviews', product_id: state.product_id, url: null, tabs: [], tabs_cut: false,
      loaded_count: 0, reviews: [], reviews_cut: false, reviewer_names_skipped: 0, ...(version >= 2 ? { page_notes: [] } : {}),
      coverage: { status: 'complete', scope: 'product_page_shows_no_reviews', review_page_opened: false, scrolled: false, category_clicked: false,
        expand_clicked: false, media_read: false },
      missing: [], excluded };
  }
  const { observed_at: observedAt, ...page } = validatePddReviews(state.page.raw, state.product_id, { observedAt: state.page.observed_at, version });
  return { ...base, observed_at: observedAt, outcome: 'read', ...page,
    coverage: { status: 'partial', scope: 'loaded_reviews_of_default_list', review_page_opened: true, scrolled: false, category_clicked: false,
      expand_clicked: false, media_read: false },
    missing: ['unloaded_reviews', 'other_categories', 'review_media'], excluded };
}

/**
 * @param {object} result Saved result. @param {object} target Search target. @param {object} state Saved journal.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validatePddReviewsResult(result, target, state) {
  try {
    validatePddReviewsReadState(state);
    if ((!hasNoReviews(state) && state.page === null) || JSON.stringify(pddReviewsResult(state, target)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD reviews result does not match its journal.'); }
}

function notOpenedError() {
  return new ShoppingError('REVIEWS_NOT_OPENED', 'The tab still shows the product page after clicking 查看全部.',
    'Look at the tab; this task does not click again. Start from a new search task to try once more.');
}

/**
 * Click 查看全部 once on the product page a pdd_product task read, wait for the review page to replace it in the same
 * tab, then read the loaded reviews of its default list. A product without reviews is answered from the product read.
 * The click is recorded before it is sent and never repeated, including after an interruption.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Reviews result.
 * @throws {ShoppingError} Page gates, refusals, REVIEWS_NOT_OPENED or an exhausted read budget.
 */
export async function runPddReviewsRead({ bridge, op, commit, now, wait }) {
  const state = op.reviews_read;
  const target = pddSearchTarget(op.target?.query);
  if (JSON.stringify(target) !== JSON.stringify(op.target)) throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD search target is invalid.');
  validatePddReviewsReadState(state);
  if (hasNoReviews(state)) return pddReviewsResult(state, target);
  // A killed process can leave the reservation without an acknowledgement. The click may have happened, so it is spent.
  if (state.click_reserved && state.click === null) {
    state.click = 'uncertain'; state.click_error = 'READ_INTERRUPTED'; state.not_before = now() + SETTLE_MS;
    await commit();
  }
  let opened = false;
  while (state.page === null) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The PDD reviews wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (!state.click_reserved) {
      state.click_reserved = true;
      await commit();
      try {
        await bridge.clickPddReviewsLink(op.tab_id, state.product_id, state.review_count);
        state.click = 'clicked';
      } catch (error) {
        if (error.actionNotDispatched) { state.click_reserved = false; await commit(); throw error; }
        state.click = 'uncertain'; state.click_error = publicError(error).code;
      }
      op.recovery_kind = null;
      state.not_before = now() + SETTLE_MS;
      await commit(); continue;
    }
    if (!opened) {
      const url = await savedTabUrl(bridge, op.tab_id, 'The PDD product tab is neither listed nor reachable by its ID.');
      if (parsePddReviewsUrl(url)?.product_id === state.product_id) { opened = true; continue; }
      const landing = pddLandingKind(url);
      if (landing === 'login_page') throw new ShoppingError('LOGIN_REQUIRED', 'PDD shows its login page on this tab.', 'Ask the user to log in to PDD in this browser profile.');
      if (landing === 'risk_page') throw pddRiskPageError();
      if (parsePddProductUrl(url)?.product_id !== state.product_id) {
        throw new ShoppingError('TARGET_CHANGED', 'The tab shows neither the product page nor its review page.', 'Look at the tab; this task does not click again.');
      }
      if (state.checks >= MAX_CHECKS) throw notOpenedError();
      state.checks += 1;
      if (state.checks >= MAX_CHECKS) { await commit(); throw notOpenedError(); }
      state.not_before = now() + RECHECK_MS;
      await commit(); continue;
    }
    if (state.reads >= MAX_READS) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The PDD reviews read budget is exhausted.');
    state.reads += 1;
    await commit();
    try {
      state.page = await bridge.readPddReviews(op.tab_id, state.product_id);
    } catch (error) {
      if (!UNFINISHED_PAGE.has(error.code) || state.reads >= MAX_READS) throw error;
      state.not_before = now() + REREAD_MS;
      await commit(); continue;
    }
    op.recovery_kind = null;
    await commit();
  }
  return pddReviewsResult(state, target);
}
