import { ShoppingError } from '../errors.mjs';
import { normalizeEndpoint } from '../bridge.mjs';
import { parseTabId } from '../targets.mjs';
import { TASK_POLICY } from '../task-policy.mjs';
import { TASK_STATUSES, OPERATION_STATUSES, integer, timestamp, validError } from '../task-checks.mjs';
import { jdSearchTarget, parseJdCartUrl, parseJdOrderListUrl, parseJdProductUrl } from './targets.mjs';
import { validateSavedJdSearch } from './search.mjs';
import { validateSavedJdCart } from './cart.mjs';
import { validateSavedJdOrders } from './orders.mjs';
import { validateJdProductReadState, validateJdProductResult } from './product-read.mjs';
import { validateJdReviewReadState, validateJdReviewResult } from './review-read.mjs';
import { validateJdOrderDetailReadState, validateJdOrderDetailResult } from './order-detail-read.mjs';
import { validateJdSearchPagesResult, validateJdSearchPagesState } from './search-pages-read.mjs';
import { validateJdSearchSortResult, validateJdSearchSortState } from './search-sort-read.mjs';

/** JD task kinds and the page kind each reads, for limit records. Taobao kinds never start with `jd_`. */
export const JD_TASK_KINDS = Object.freeze({ jd_search: 'search', jd_search_pages: 'search', jd_search_sort: 'search', jd_product: 'product', jd_review_categories: 'product', jd_cart: 'cart', jd_orders: 'orders', jd_order_detail: 'orders' });

const TASK_KEYS = ['schema_version', 'id', 'kind', 'platform', 'endpoint', 'status', 'created_at', 'updated_at', 'policy',
  'retries', 'cooldown_probes', 'wait_reserved_ms', 'not_before', 'operations'];
const OPERATION_KEYS = ['tab_id', 'target', 'status', 'attempts', 'retries', 'not_before', 'recovery_kind', 'error', 'result'];
const sameKeys = (value, keys) => value && typeof value === 'object' && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/**
 * Validate a saved JD task before it can affect a browser, budgets or reports.
 * @param {unknown} task @returns {object} The same task. @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateJdTask(task) {
  const invalid = () => new ShoppingError('INVALID_CHECKPOINT', 'The JD task checkpoint is invalid or incompatible. No browser operation was sent.');
  try {
    if (!sameKeys(task, TASK_KEYS) || task.schema_version !== 1 || task.platform !== 'jd' || !Object.hasOwn(JD_TASK_KINDS, task.kind) ||
        normalizeEndpoint(task.endpoint) !== task.endpoint || !TASK_STATUSES.includes(task.status) || task.status === 'awaiting_batch' ||
        !timestamp(task.created_at) || !timestamp(task.updated_at) || JSON.stringify(task.policy) !== JSON.stringify(TASK_POLICY) ||
        !integer(task.retries, 5) || !integer(task.wait_reserved_ms, 120000) || !integer(task.cooldown_probes, 1) ||
        !integer(task.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(task.operations) || task.operations.length !== 1) throw invalid();
    const [op] = task.operations;
    const product = task.kind === 'jd_product';
    const review = task.kind === 'jd_review_categories';
    const detail = task.kind === 'jd_order_detail';
    const searchPages = task.kind === 'jd_search_pages', searchSort = task.kind === 'jd_search_sort';
    const extras = product ? ['product_read'] : review ? ['review_categories', 'review_read'] : detail ? ['order_detail_read']
      : searchPages ? ['search_pages_read'] : searchSort ? ['search_sort_read'] : [];
    if (!sameKeys(op, [...OPERATION_KEYS, ...extras])) throw invalid();
    parseTabId(op.tab_id);
    const cart = task.kind === 'jd_cart', orders = task.kind === 'jd_orders';
    const target = product || review ? parseJdProductUrl(op.target?.url) : cart ? parseJdCartUrl(op.target?.url)
      : orders || detail ? parseJdOrderListUrl(op.target?.url) : jdSearchTarget(op.target?.query);
    if (!target || JSON.stringify(target) !== JSON.stringify(op.target) || !OPERATION_STATUSES.includes(op.status) ||
        ![null, 'user', 'cooldown', 'connection'].includes(op.recovery_kind) || !integer(op.attempts, 1000) || !integer(op.retries, 2) ||
        op.attempts < op.retries || !integer(op.not_before, Number.MAX_SAFE_INTEGER) || !validError(op.error) ||
        (op.status === 'succeeded') !== (op.result !== null)) throw invalid();
    if (product) {
      if (op.result !== null) validateJdProductResult(op.result, target, op.product_read);
      else validateJdProductReadState(op.product_read, target);
    } else if (review) {
      if (op.result !== null) validateJdReviewResult(op.result, target, op.review_categories, op.review_read);
      else validateJdReviewReadState(op.review_read, target, op.review_categories);
    } else if (cart) {
      if (op.result !== null) validateSavedJdCart(op.result, target);
    } else if (orders) {
      if (op.result !== null) validateSavedJdOrders(op.result, target);
    } else if (detail) {
      if (op.result !== null) validateJdOrderDetailResult(op.result, target, op.order_detail_read, op.tab_id);
      else validateJdOrderDetailReadState(op.order_detail_read, op.tab_id);
    } else if (searchPages) {
      if (op.result !== null) validateJdSearchPagesResult(op.result, target, op.search_pages_read);
      else validateJdSearchPagesState(op.search_pages_read, target);
    } else if (searchSort) {
      if (op.result !== null) validateJdSearchSortResult(op.result, target, op.search_sort_read);
      else validateJdSearchSortState(op.search_sort_read, target);
    } else if (op.result !== null) validateSavedJdSearch(op.result, target);
    const finished = ['succeeded', 'failed'].includes(op.status);
    if (task.retries !== task.cooldown_probes + op.retries ||
        (['complete', 'partial'].includes(task.status) !== finished && !['stopped', 'ended'].includes(task.status)) ||
        (task.status === 'complete' && op.status !== 'succeeded')) throw invalid();
    return task;
  } catch { throw invalid(); }
}
