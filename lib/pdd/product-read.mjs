import { ShoppingError, publicError } from '../errors.mjs';
import { savedTabUrl } from '../saved-tab.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { PDD_SEARCH_CARD_LIMIT } from './search.mjs';
import { PDD_PRODUCT_SCHEMA_VERSION, pddProductFields } from './product.mjs';
import { parsePddProductUrl, parsePddSearchUrl, pddLandingKind, pddRiskPageError, pddSearchTarget } from './targets.mjs';

const SCHEMA_VERSION = 1;
// Product reads: the page can still be rendering after the address changes (2026-10-27: reads 8, 12 and 16 s after the
// click found no title, a read a few minutes later found the whole page), so an unfinished page is read again, 10 s apart.
const MAX_READS = 4;
const REREAD_MS = 10_000;
const UNFINISHED_PAGE = new Set(['TITLE_MISMATCH', 'PAGE_STRUCTURE_CHANGED', 'PAGE_LOADING']);
// Address checks after the click that still show the search page.
const MAX_CHECKS = 3;
// On 2026-10-27 the product page replaced the search page within a few seconds of a click.
const SETTLE_MS = 8_000;
const RECHECK_MS = 4_000;
const CLOCK_LIMIT_MS = 15_000;
const STATE_KEYS = ['schema_version', 'search_task', 'position', 'card', 'click_reserved', 'click', 'click_error', 'checks', 'product_id', 'reads',
  'product', 'not_before'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/**
 * @param {string} searchTask The completed pdd_search task the card comes from. @param {number} position 1-40.
 * @param {{title: string, price: {amount_text: string}}} item The saved card at that position.
 * @returns {object} A fresh journal: nothing clicked or read. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function newPddProductReadState(searchTask, position, item) {
  if (!Number.isSafeInteger(position) || position < 1 || position > PDD_SEARCH_CARD_LIMIT || typeof item?.title !== 'string' || !item.title ||
      typeof item.price?.amount_text !== 'string' || !/^[0-9.]{1,20}$/.test(item.price.amount_text)) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use --card 1-${PDD_SEARCH_CARD_LIMIT} for a card with a title and a price.`);
  }
  return { schema_version: SCHEMA_VERSION, search_task: searchTask, position, card: { title: item.title, amount_text: item.price.amount_text },
    click_reserved: false, click: null, click_error: null, checks: 0, product_id: null, reads: 0, product: null, not_before: 0 };
}

/**
 * Accept a partial journal, including a click reserved but not yet acknowledged.
 * @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validatePddProductReadState(state) {
  try {
    if (!sameKeys(state, STATE_KEYS) || state.schema_version !== SCHEMA_VERSION || typeof state.search_task !== 'string' || !state.search_task ||
        !Number.isSafeInteger(state.position) || state.position < 1 || state.position > PDD_SEARCH_CARD_LIMIT ||
        !sameKeys(state.card, ['title', 'amount_text']) || typeof state.card.title !== 'string' || !state.card.title || state.card.title.length > 300 ||
        typeof state.card.amount_text !== 'string' || !/^[0-9.]{1,20}$/.test(state.card.amount_text) || typeof state.click_reserved !== 'boolean' ||
        ![null, 'clicked', 'uncertain'].includes(state.click) || (state.click_error !== null && !(typeof state.click_error === 'string' && CODE.test(state.click_error))) ||
        !integer(state.checks, MAX_CHECKS) || !integer(state.reads, MAX_READS) || !integer(state.not_before, Number.MAX_SAFE_INTEGER)) throw new Error();
    // Each step needs the one before it: the click, the product address, then the read.
    if (!state.click_reserved && (state.click !== null || state.checks > 0)) throw new Error();
    if ((state.click === 'uncertain') !== (state.click_error !== null)) throw new Error();
    if (state.product_id !== null && (state.click === null || !parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${state.product_id}`))) throw new Error();
    if (state.reads > 0 && state.product_id === null) throw new Error();
    if (state.product !== null) {
      if (state.product_id === null || !sameKeys(state.product, ['observed_at', 'raw']) || !timestamp(state.product.observed_at) || state.reads < 1) throw new Error();
      pddProductFields(state.product.raw, state.product_id, state.card.title, state.product.observed_at);
    }
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD product read journal is invalid.'); }
}

/**
 * Build the product result from a finished journal.
 * @param {object} state Finished journal. @param {{query: string}} target The search page the card was on. @returns {object}
 */
export function pddProductResult(state, target) {
  const { observed_at: observedAt, ...product } = pddProductFields(state.product.raw, state.product_id, state.card.title, state.product.observed_at);
  return {
    schema_version: PDD_PRODUCT_SCHEMA_VERSION, platform: 'pdd', source: 'pdd_product_page', observed_at: observedAt, login_verified: false,
    entry: { search_task: state.search_task, query: target.query, card_position: state.position, card_title: state.card.title,
      card_price: state.card.amount_text, click: state.click, click_error: state.click_error, address_checks: state.checks, reads_reserved: state.reads },
    ...product,
  };
}

/**
 * @param {object} result Saved result. @param {object} target Search target. @param {object} state Saved journal.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validatePddProductResult(result, target, state) {
  try {
    validatePddProductReadState(state);
    if (state.product === null || JSON.stringify(pddProductResult(state, target)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD product result does not match its journal.'); }
}

function notOpenedError() {
  return new ShoppingError('PRODUCT_NOT_OPENED', 'The tab still shows the search page after clicking the card.',
    'Look at the tab; this task does not click again. Start a new search task to try once more.');
}

/**
 * Click search card N once, wait for its product page to replace the search page in the same tab, then read it. The
 * click is recorded before it is sent and never repeated, including after an interruption.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Product result.
 * @throws {ShoppingError} Page gates, refusals, PRODUCT_NOT_OPENED or an exhausted read budget.
 */
export async function runPddProductRead({ bridge, op, commit, now, wait }) {
  const state = op.product_read;
  const target = pddSearchTarget(op.target?.query);
  if (JSON.stringify(target) !== JSON.stringify(op.target)) throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD search target is invalid.');
  validatePddProductReadState(state);
  // A killed process can leave the reservation without an acknowledgement. The click may have happened, so it is spent.
  if (state.click_reserved && state.click === null) {
    state.click = 'uncertain'; state.click_error = 'READ_INTERRUPTED'; state.not_before = now() + SETTLE_MS;
    await commit();
  }
  while (state.product === null) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The PDD product wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (!state.click_reserved) {
      state.click_reserved = true;
      await commit();
      try {
        await bridge.clickPddSearchCard(op.tab_id, target, state.position, state.card);
        state.click = 'clicked';
      } catch (error) {
        if (error.actionNotDispatched) { state.click_reserved = false; await commit(); throw error; }
        state.click = 'uncertain'; state.click_error = publicError(error).code;
      }
      op.recovery_kind = null;
      state.not_before = now() + SETTLE_MS;
      await commit(); continue;
    }
    if (state.product_id === null) {
      if (state.checks >= MAX_CHECKS) throw notOpenedError();
      const url = await savedTabUrl(bridge, op.tab_id, 'The PDD search tab is neither listed nor reachable by its ID.');
      const product = parsePddProductUrl(url);
      if (product) { state.product_id = product.product_id; op.recovery_kind = null; await commit(); continue; }
      const landing = pddLandingKind(url);
      if (landing === 'login_page') throw new ShoppingError('LOGIN_REQUIRED', 'PDD shows its login page on this tab.', 'Ask the user to log in to PDD in this browser profile.');
      if (landing === 'risk_page') throw pddRiskPageError();
      if (parsePddSearchUrl(url)?.query !== target.query) {
        throw new ShoppingError('TARGET_CHANGED', 'The tab shows neither the search page nor a product page.', 'Look at the tab; this task does not click again.');
      }
      state.checks += 1;
      if (state.checks >= MAX_CHECKS) { await commit(); throw notOpenedError(); }
      state.not_before = now() + RECHECK_MS;
      await commit(); continue;
    }
    if (state.reads >= MAX_READS) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The PDD product read budget is exhausted.');
    state.reads += 1;
    await commit();
    try {
      state.product = await bridge.readPddProduct(op.tab_id, state.product_id, state.card.title);
    } catch (error) {
      if (!UNFINISHED_PAGE.has(error.code) || state.reads >= MAX_READS) throw error;
      state.not_before = now() + REREAD_MS;
      await commit(); continue;
    }
    op.recovery_kind = null;
    await commit();
  }
  return pddProductResult(state, target);
}
