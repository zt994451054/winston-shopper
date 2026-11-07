import { ShoppingError } from '../errors.mjs';
import { normalizeEndpoint } from '../bridge.mjs';
import { parseTabId } from '../targets.mjs';
import { TASK_POLICY } from '../task-policy.mjs';
import { TASK_STATUSES, OPERATION_STATUSES, integer, timestamp, validError } from '../task-checks.mjs';
import { parsePddOrderListUrl, pddSearchTarget } from './targets.mjs';
import { validateSavedPddSearch } from './search.mjs';
import { validateSavedPddOrders } from './orders.mjs';
import { validatePddSortReadState, validatePddSortResult } from './search-sort-read.mjs';
import { validatePddOrderDetailReadState, validatePddOrderDetailResult } from './order-detail-read.mjs';
import { validatePddProductReadState, validatePddProductResult } from './product-read.mjs';
import { validatePddReviewsReadState, validatePddReviewsResult } from './reviews-read.mjs';
import { validatePddSpecPricesResult, validatePddSpecReadState } from './spec-prices-read.mjs';

/** PDD task kinds and the page kind each reads, for limit records. Other platforms' kinds never start with `pdd_`. */
export const PDD_TASK_KINDS = Object.freeze({ pdd_search: 'search', pdd_search_sort: 'search', pdd_product: 'product', pdd_reviews: 'product', pdd_spec_prices: 'product', pdd_orders: 'orders',
  pdd_order_detail: 'orders' });

const TASK_KEYS = ['schema_version', 'id', 'kind', 'platform', 'endpoint', 'status', 'created_at', 'updated_at', 'policy',
  'retries', 'cooldown_probes', 'wait_reserved_ms', 'not_before', 'operations'];
const OPERATION_KEYS = ['tab_id', 'target', 'status', 'attempts', 'retries', 'not_before', 'recovery_kind', 'error', 'result'];
const sameKeys = (value, keys) => value && typeof value === 'object' && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/**
 * Validate a saved PDD task before it can affect a browser, budgets or reports. Same task shape as a JD search task; a
 * product task also keeps its click-and-read journal, and its target is the search page the card was on.
 * @param {unknown} task @returns {object} The same task. @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validatePddTask(task) {
  const invalid = () => new ShoppingError('INVALID_CHECKPOINT', 'The PDD task checkpoint is invalid or incompatible. No browser operation was sent.');
  try {
    if (!sameKeys(task, TASK_KEYS) || task.schema_version !== 1 || task.platform !== 'pdd' || !Object.hasOwn(PDD_TASK_KINDS, task.kind) ||
        normalizeEndpoint(task.endpoint) !== task.endpoint || !TASK_STATUSES.includes(task.status) || task.status === 'awaiting_batch' ||
        !timestamp(task.created_at) || !timestamp(task.updated_at) || JSON.stringify(task.policy) !== JSON.stringify(TASK_POLICY) ||
        !integer(task.retries, 5) || !integer(task.wait_reserved_ms, 120000) || !integer(task.cooldown_probes, 1) ||
        !integer(task.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(task.operations) || task.operations.length !== 1) throw invalid();
    const [op] = task.operations;
    const journal = { pdd_product: 'product_read', pdd_reviews: 'reviews_read', pdd_order_detail: 'order_detail_read', pdd_search_sort: 'sort_read', pdd_spec_prices: 'spec_read' }[task.kind];
    if (!sameKeys(op, journal ? [...OPERATION_KEYS, journal] : OPERATION_KEYS)) throw invalid();
    parseTabId(op.tab_id);
    // Order tasks run on the order list; the others on a search page, or on the page a search card opened.
    const orderKind = ['pdd_orders', 'pdd_order_detail'].includes(task.kind);
    const target = orderKind ? parsePddOrderListUrl(op.target?.url) : pddSearchTarget(op.target?.query);
    if (JSON.stringify(target) !== JSON.stringify(op.target) || !OPERATION_STATUSES.includes(op.status) ||
        ![null, 'user', 'cooldown', 'connection'].includes(op.recovery_kind) || !integer(op.attempts, 1000) || !integer(op.retries, 2) ||
        op.attempts < op.retries || !integer(op.not_before, Number.MAX_SAFE_INTEGER) || !validError(op.error) ||
        (op.status === 'succeeded') !== (op.result !== null)) throw invalid();
    if (task.kind === 'pdd_product') {
      if (op.result !== null) validatePddProductResult(op.result, target, op.product_read);
      else validatePddProductReadState(op.product_read);
    } else if (task.kind === 'pdd_order_detail') {
      if (op.result !== null) validatePddOrderDetailResult(op.result, op.order_detail_read);
      else validatePddOrderDetailReadState(op.order_detail_read);
    } else if (task.kind === 'pdd_search_sort') {
      if (op.result !== null) validatePddSortResult(op.result, op.sort_read, target);
      else validatePddSortReadState(op.sort_read, target);
    } else if (task.kind === 'pdd_orders') {
      if (op.result !== null) validateSavedPddOrders(op.result);
    } else if (task.kind === 'pdd_reviews') {
      if (op.result !== null) validatePddReviewsResult(op.result, target, op.reviews_read);
      else validatePddReviewsReadState(op.reviews_read);
    } else if (task.kind === 'pdd_spec_prices') {
      if (op.result !== null) validatePddSpecPricesResult(op.result, target, op.spec_read);
      else validatePddSpecReadState(op.spec_read);
    } else if (op.result !== null) validateSavedPddSearch(op.result, target);
    const finished = ['succeeded', 'failed'].includes(op.status);
    if (task.retries !== task.cooldown_probes + op.retries ||
        (['complete', 'partial'].includes(task.status) !== finished && !['stopped', 'ended'].includes(task.status)) ||
        (task.status === 'complete' && op.status !== 'succeeded')) throw invalid();
    return task;
  } catch { throw invalid(); }
}
