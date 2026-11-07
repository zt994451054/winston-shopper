import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { orderGuard, validateSavedOrderBatch } from './order-rows.mjs';
import { requireOrderTab } from './order-read.mjs';

/** @returns {object} Empty collection; range validation belongs to newOrderReadState. @example newOrderCollection(); */
export function newOrderCollection() { return { schema_version: 1, batches: [] }; }

/**
 * @param {object} state Validated saved collection. @param {number} orderLimit Validated requested limit.
 * @returns {object|null} Up to five new positions and preceding identity guards, or null when the loaded scope is complete.
 * @throws {ShoppingError} ORDER_CONTINUITY_UNVERIFIED if preceding observations are insufficient or IDs duplicate.
 * @example orderCollectionPlan(newOrderCollection(), 10);
 */
export function orderCollectionPlan(state, orderLimit) {
  const orders = state.batches.flatMap(batch => batch.snapshot.orders);
  const loaded = state.batches[0]?.snapshot.coverage.loaded_orders_seen ?? null;
  const end = Math.min(orderLimit, loaded ?? orderLimit);
  if (orders.length >= end) return null;
  const guards = orders.map(orderGuard);
  if (guards.some(guard => guard === null) || new Set(guards.map(guard => guard.order_id)).size !== guards.length) {
    throw new ShoppingError('ORDER_CONTINUITY_UNVERIFIED', 'Preceding order positions lack sufficient distinct observed identity fields. Saved orders were retained.');
  }
  return { start: orders.length + 1, limit: Math.min(5, end - orders.length), loaded_orders_seen: loaded, guards };
}

/**
 * @param {{bridge:object,op:object}} options Adapter and saved operation whose read is already reserved.
 * @returns {Promise<object>} One validated partial batch; no actions or internal retries.
 * @throws {ShoppingError} Target/page gates, changed observations, insufficient guards or invalid response.
 * @example await runOrderCollection({bridge, op});
 */
export async function runOrderCollection({ bridge, op }) {
  const plan = orderCollectionPlan(op.order_collection, op.order_read.order_limit);
  await requireOrderTab(bridge, op);
  const result = await bridge.readOrderBatch(op.tab_id, op.target, plan);
  try { return validateSavedOrderBatch(result, op.target, plan); }
  catch { throw new ShoppingError('INVALID_RESPONSE', 'The order adapter returned an invalid batch snapshot.'); }
}

/**
 * @param {object} state Validated collection. @param {{url:string}} target Saved route. @param {number} orderLimit Requested scope.
 * @returns {object} Local-only delivery with per-batch times and global positions; no deduplication or full-history claim.
 * @example orderCollectionResult(state, target, 10);
 */
export function orderCollectionResult(state, target, orderLimit) {
  const loaded = state.batches[0]?.snapshot.coverage.loaded_orders_seen ?? null;
  const orders = state.batches.flatMap(batch => batch.snapshot.orders.map(order => ({ ...order, observed_at: batch.snapshot.observed_at })));
  const empty = state.batches.length === 1 && state.batches[0].snapshot.schema_version === 3 &&
    state.batches[0].snapshot.coverage.empty_orders_verified === true;
  return { schema_version: empty ? 3 : 1, url: target.url, requested_orders: orderLimit, batches: state.batches, orders,
    ...(empty ? { empty_evidence: structuredClone(state.batches[0].snapshot.empty_evidence) } : {}),
    coverage: { status: 'partial', loaded_orders_seen: loaded, returned_orders: orders.length,
      orders_omitted: loaded === null ? null : loaded - orders.length,
      requested_limit_reached: orders.length === orderLimit,
      requested_loaded_range_read: loaded !== null && orders.length === Math.min(orderLimit, loaded),
      page_total_orders: null, full_order_history: false, empty_orders_verified: empty, account_identity_verified: false,
      filters_verified: false, physical_order_identity_verified: false, settlement_verified: false },
    privacy: { local_only: true, contact_fields_read: false, account_profile_read: false } };
}

/**
 * @param {unknown} state Saved collection. @param {{url:string}} target Saved route. @param {object} op Operation with validated budget.
 * @param {string} taskStatus Enclosing saved status. @returns {void} Validates finite progress and associations before IO.
 * @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent batches, attempts, status or final result.
 * @example validateOrderCollection(op.order_collection, op.target, op, task.status);
 */
export function validateOrderCollection(state, target, op, taskStatus) {
  const invalid = () => { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved order collection is invalid or incompatible.'); };
  if (!state || Object.keys(state).sort().join(',') !== 'batches,schema_version' || state.schema_version !== 1 ||
      op.order_read.schema_version !== 2 || !Array.isArray(state.batches) || state.batches.length > Math.ceil(op.order_read.order_limit / 5)) invalid();
  const previous = newOrderCollection();
  let attempt = 0;
  for (const batch of state.batches) {
    if (!batch || Object.keys(batch).sort().join(',') !== 'attempt,snapshot' || !Number.isSafeInteger(batch.attempt) ||
        batch.attempt <= attempt || batch.attempt > op.attempts || op.order_read.failures.some(failure => failure.attempt === batch.attempt)) invalid();
    let plan;
    try { plan = orderCollectionPlan(previous, op.order_read.order_limit); } catch { invalid(); }
    if (!plan) invalid();
    validateSavedOrderBatch(batch.snapshot, target, plan);
    previous.batches.push(batch); attempt = batch.attempt;
  }
  const result = orderCollectionResult(state, target, op.order_read.order_limit);
  if ((op.status === 'succeeded') !== result.coverage.requested_loaded_range_read ||
      (op.result !== null && !isDeepStrictEqual(op.result, result)) ||
      (op.status === 'running' && attempt === op.attempts) ||
      (taskStatus === 'awaiting_batch' && (op.status !== 'pending' || op.error !== null || !state.batches.length || attempt !== op.attempts))) invalid();
  if (taskStatus === 'awaiting_batch') {
    try { if (!orderCollectionPlan(state, op.order_read.order_limit)) invalid(); } catch { invalid(); }
  }
}
