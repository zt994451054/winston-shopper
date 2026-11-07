import { ShoppingError } from './errors.mjs';
import { parseOrderListUrl } from './order-target.mjs';
import { savedTabUrl } from './saved-tab.mjs';
import { validateSavedOrderRows } from './order-rows.mjs';
import { failureCategory } from './task-policy.mjs';

/**
 * @param {number|undefined} orderLimit Requested collection limit (1–50), or undefined for the original first-five scope.
 * @returns {object} Fixed scope/read limits and two shared explicit recoveries.
 * @throws {ShoppingError} INVALID_ARGUMENTS for an invalid requested range.
 * @example newOrderReadState();
 */
export function newOrderReadState(orderLimit) {
  if (orderLimit !== undefined && (!Number.isSafeInteger(orderLimit) || orderLimit < 1 || orderLimit > 50)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Order collection requires a group limit from 1 to 50.');
  }
  return { schema_version: orderLimit === undefined ? 1 : 2, order_limit: orderLimit ?? 5, item_limit: 10,
    read_limit: orderLimit === undefined ? 6 : Math.ceil(orderLimit / 5) + 2, recovery_limit: 2,
    recovery_wait_ms: 5000, recoveries_reserved: 0, failures: [] };
}

/**
 * @param {unknown} state Saved order budget. @param {object} op Saved operation counters.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT before any execution.
 * @example validateOrderReadState(op.order_read, op);
 */
export function validateOrderReadState(state, op) {
  const invalid = () => { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved buyer order-list budget is invalid.'); };
  let expected;
  try { expected = newOrderReadState(state?.schema_version === 2 ? state.order_limit : undefined); }
  catch { invalid(); }
  if (!state || Object.keys(state).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.entries(expected).some(([key, value]) => !['recoveries_reserved', 'failures'].includes(key) && state[key] !== value) ||
      !Number.isSafeInteger(state.recoveries_reserved) || state.recoveries_reserved < 0 || state.recoveries_reserved > state.recovery_limit ||
      !Number.isSafeInteger(op.attempts) || op.attempts < 0 || op.attempts > state.read_limit || state.recoveries_reserved > op.attempts ||
      (['running', 'succeeded', 'failed'].includes(op.status) && op.attempts === 0) ||
      !Array.isArray(state.failures) || state.failures.length > op.attempts) invalid();
  let previous = 0;
  for (const failure of state.failures) {
    if (!failure || Object.keys(failure).sort().join(',') !== 'attempt,category,code' ||
        !Number.isSafeInteger(failure.attempt) || failure.attempt <= previous || failure.attempt > op.attempts ||
        (['running', 'succeeded'].includes(op.status) && failure.attempt === op.attempts) ||
        typeof failure.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ||
        failure.category !== failureCategory(failure.code)) invalid();
    previous = failure.attempt;
  }
  if (op.recovery_kind !== null && state.recoveries_reserved === 0) invalid();
}

/**
 * @param {object} bridge Browser adapter. @param {object} op Saved explicit tab and target.
 * @returns {Promise<void>} Address/inventory confirmation without page content reads or selecting substitutes.
 * @throws {ShoppingError} Connection, LOGIN_REQUIRED, TARGET_MISSING or TARGET_CHANGED.
 * @example await requireOrderTab(bridge, op);
 */
export async function requireOrderTab(bridge, op) {
  await bridge.requireConnected();
  const url = await savedTabUrl(bridge, op.tab_id, 'The selected buyer order-list tab is neither listed nor reachable by its ID.');
  if (parseOrderListUrl(url)?.url === op.target.url) return;
  let actual;
  try { actual = new URL(url); } catch { /* Invalid addresses remain target failures. */ }
  if (actual?.protocol === 'https:' && !actual.username && !actual.password && !actual.port &&
      ['login.taobao.com', 'login.tmall.com'].includes(actual.hostname)) {
    throw new ShoppingError('LOGIN_REQUIRED', 'The selected buyer order-list tab requires user login.');
  }
  throw new ShoppingError('TARGET_CHANGED', 'The selected tab no longer identifies the saved buyer order-list route.');
}

/**
 * @param {{bridge:object,op:object}} options Browser adapter, saved route and already reserved operation.
 * @returns {Promise<object>} Validated local-only snapshot of at most five orders; no internal retries.
 * @throws {ShoppingError} Target/page gates, structure failures or INVALID_RESPONSE.
 * @example await runOrderRead({bridge, op});
 */
export async function runOrderRead({ bridge, op }) {
  await requireOrderTab(bridge, op);
  const result = await bridge.readOrderRows(op.tab_id, op.target);
  try { return validateSavedOrderRows(result, op.target); }
  catch { throw new ShoppingError('INVALID_RESPONSE', 'The order adapter returned an invalid bounded snapshot.'); }
}
