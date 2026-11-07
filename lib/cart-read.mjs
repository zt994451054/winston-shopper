import { ShoppingError } from './errors.mjs';
import { parseCartUrl } from './cart-target.mjs';
import { savedTabUrl } from './saved-tab.mjs';
import { validateSavedCartRows } from './cart-rows.mjs';
import { failureCategory } from './task-policy.mjs';

/**
 * @param {number|undefined} rowLimit Explicit collection limit (1–50), or undefined for the legacy first-five scope.
 * @returns {object} Immutable scope limits and mutable bounded failure/recovery counters.
 * @throws {ShoppingError} INVALID_ARGUMENTS for an invalid collection limit.
 * @example newCartReadState(10) // four reads, two shared recoveries
 */
export function newCartReadState(rowLimit) {
  if (rowLimit !== undefined && (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > 50)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Cart collection requires a row limit from 1 to 50.');
  }
  return { schema_version: rowLimit === undefined ? 1 : 2, row_limit: rowLimit ?? 5,
    read_limit: rowLimit === undefined ? 6 : Math.ceil(rowLimit / 5) + 2, recovery_limit: 2,
    recovery_wait_ms: 5000, recoveries_reserved: 0, failures: [] };
}

/**
 * Validate cart budgets before a checkpoint can affect execution.
 * @param {unknown} state Saved cart state. @param {object} op Saved operation counters.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateCartReadState(state, op) {
  let expected;
  try { expected = newCartReadState(state?.schema_version === 2 ? state.row_limit : undefined); }
  catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved cart row limit is invalid.'); }
  if (!state || Object.keys(state).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.entries(expected).some(([key, value]) => !['recoveries_reserved', 'failures'].includes(key) && state[key] !== value) ||
      !Number.isSafeInteger(state.recoveries_reserved) || state.recoveries_reserved < 0 ||
      state.recoveries_reserved > state.recovery_limit || state.recoveries_reserved > op.attempts ||
      !Number.isSafeInteger(op.attempts) || op.attempts < 0 || op.attempts > state.read_limit ||
      (['running', 'succeeded', 'failed'].includes(op.status) && op.attempts === 0) ||
      !Array.isArray(state.failures) || state.failures.length > op.attempts) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The saved cart budget is invalid.');
  }
  let previous = 0;
  for (const failure of state.failures) {
    if (!failure || Object.keys(failure).sort().join(',') !== 'attempt,category,code' ||
        !Number.isSafeInteger(failure.attempt) || failure.attempt <= previous || failure.attempt > op.attempts ||
        (['running', 'succeeded'].includes(op.status) && failure.attempt === op.attempts) ||
        typeof failure.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ||
        failure.category !== failureCategory(failure.code)) {
      throw new ShoppingError('INVALID_CHECKPOINT', 'The saved cart failure history is invalid.');
    }
    previous = failure.attempt;
  }
  if (op.recovery_kind !== null && state.recoveries_reserved === 0) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The cart recovery was not reserved.');
  }
}

/**
 * Check only the explicitly selected current-window cart tab; never choose a substitute.
 * @param {object} bridge Browser adapter. @param {object} op Saved tab and target.
 * @returns {Promise<void>} Resolves after inventory/address checks, without a DOM read.
 * @throws {ShoppingError} Connection failures, LOGIN_REQUIRED, TARGET_MISSING or TARGET_CHANGED.
 * @example await requireCartTab(bridge, op);
 */
export async function requireCartTab(bridge, op) {
  await bridge.requireConnected();
  const url = await savedTabUrl(bridge, op.tab_id, 'The selected cart tab is neither listed nor reachable by its ID.');
  if (parseCartUrl(url)?.url !== op.target.url) {
    let actual;
    try { actual = new URL(url); } catch { /* An invalid address is a changed target. */ }
    if (actual?.protocol === 'https:' && !actual.username && !actual.password && !actual.port &&
        ['login.taobao.com', 'login.tmall.com'].includes(actual.hostname)) {
      throw new ShoppingError('LOGIN_REQUIRED', 'The selected cart tab requires user login.');
    }
    throw new ShoppingError('TARGET_CHANGED', 'The selected tab no longer identifies the saved cart route.');
  }
}

/**
 * @param {{bridge:object,op:object}} options Saved tab, target and browser adapter.
 * @returns {Promise<object>} Validated first-five-row snapshot.
 * @throws {ShoppingError} Known gates, target failures or invalid row evidence; never retries itself.
 */
export async function runCartRead({ bridge, op }) {
  await requireCartTab(bridge, op);
  const result = await bridge.readCartRows(op.tab_id, op.target);
  try { return validateSavedCartRows(result, op.target); }
  catch { throw new ShoppingError('INVALID_RESPONSE', 'The cart adapter returned an invalid row snapshot.'); }
}
