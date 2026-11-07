import { isProductStructureReason } from './product.mjs';

/** Checkpoint field rules shared by the Taobao and JD task validators. */
export const TASK_STATUSES = Object.freeze(['pending', 'running', 'retry_wait', 'waiting_user', 'waiting_cooldown', 'waiting_connection', 'awaiting_batch', 'complete', 'partial', 'stopped', 'ended']);
export const OPERATION_STATUSES = Object.freeze(['pending', 'running', 'retry_wait', 'succeeded', 'failed']);

/** @param {unknown} value @param {number} max @returns {boolean} A safe integer from 0 to max. */
export function integer(value, max) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }

/** @param {unknown} value @returns {boolean} A parseable timestamp string. */
export function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

/** @param {unknown} value @returns {boolean} A saved operation error: null, or a public code with a known category. */
export function validError(value) {
  const code = item => typeof item === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(item);
  return value === null || (value && Object.keys(value).every(key => ['code', 'category', 'cause', 'reason'].includes(key)) &&
    code(value.code) && ['transient', 'user', 'connection', 'item', 'rate', 'diagnostic', 'budget', 'pacing'].includes(value.category) &&
    (value.cause === undefined || code(value.cause)) &&
    (!Object.hasOwn(value, 'reason') || (value.code === 'PAGE_STRUCTURE_CHANGED' && value.category === 'diagnostic' &&
      isProductStructureReason(value.reason))));
}
