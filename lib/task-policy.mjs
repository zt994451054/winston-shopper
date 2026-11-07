import { ShoppingError } from './errors.mjs';

export const TASK_POLICY = Object.freeze({
  operation_retries: 2, platform_retries: 5, wait_budget_ms: 120000,
  retry_delays_ms: Object.freeze([5000, 15000]), operation_interval_ms: 1500,
});

const TRANSIENT = new Set(['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE', 'PAGE_LOADING', 'READ_INTERRUPTED']);
// PAGE_NOT_VISIBLE waits for the user to show the JD tab. A hidden document has no review cards to read.
const HUMAN = new Set(['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'PAGE_NOT_VISIBLE']);
const CONNECTION = new Set(['EXTENSION_DISCONNECTED', 'TARGET_MISSING', 'TARGET_CHANGED', 'BROWSER_DISCONNECTED', 'BROWSER_SESSION_CHANGED']);
const ITEM_FAILURE = new Set(['PRODUCT_UNAVAILABLE', 'PERMISSION_DENIED', 'UNSUPPORTED_CAPABILITY', 'SELECTION_DISABLED', 'SELECTION_AMBIGUOUS', 'INCOMPLETE_SELECTION']);

/**
 * Classify safe error codes; unknown failures never acquire a retry allowance.
 * @param {string} code @returns {string} A recovery category.
 * @example failureCategory('VERIFICATION_REQUIRED') // 'user'
 */
export function failureCategory(code) {
  if (TRANSIENT.has(code)) return 'transient';
  if (HUMAN.has(code)) return 'user';
  if (CONNECTION.has(code)) return 'connection';
  if (ITEM_FAILURE.has(code)) return 'item';
  // An unexplained empty results area after many searches is handled like a rate limit: pause, never retry automatically.
  if (code === 'RATE_LIMITED' || code === 'SEARCH_RESULTS_UNAVAILABLE') return 'rate';
  return 'diagnostic';
}

/**
 * Decide whether a read-only operation can retry using the persisted counters.
 * @param {object} task @param {object} operation
 * @returns {{allowed: boolean, delay_ms?: number, code?: string}}
 * @example retryDecision(task, task.operations[0])
 */
export function retryDecision(task, operation) {
  if (operation.retries >= TASK_POLICY.operation_retries) return { allowed: false, code: 'OPERATION_RETRY_LIMIT' };
  if (task.retries >= TASK_POLICY.platform_retries) return { allowed: false, code: 'PLATFORM_RETRY_LIMIT' };
  const delay = TASK_POLICY.retry_delays_ms[operation.retries];
  if (task.wait_reserved_ms + delay > TASK_POLICY.wait_budget_ms) return { allowed: false, code: 'WAIT_BUDGET_EXHAUSTED' };
  return { allowed: true, delay_ms: delay };
}

/**
 * Validate an explicit recovery action. Human elapsed time never resets budgets.
 * @param {object} task @param {'user'|'cooldown'|'connection'|undefined} recovery
 * @throws {ShoppingError} RECOVERY_REQUIRED or INVALID_RECOVERY.
 */
export function validateRecovery(task, recovery) {
  if (['complete', 'partial', 'stopped', 'ended'].includes(task.status)) {
    if (recovery) throw new ShoppingError('INVALID_RECOVERY', 'A finished task cannot be resumed or receive a fresh retry budget.');
    return;
  }
  const expected = { waiting_user: 'user', waiting_cooldown: 'cooldown', waiting_connection: 'connection' }[task.status];
  if (expected && recovery !== expected) {
    throw new ShoppingError('RECOVERY_REQUIRED', 'The task is paused and needs its documented recovery action.', `After resolving the condition, use task-resume --after-${expected} with the same task.`);
  }
  if (!expected && recovery) throw new ShoppingError('INVALID_RECOVERY', 'This task is not waiting for that recovery action.');
}
