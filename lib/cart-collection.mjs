import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { cartRowGuard, validateSavedCartBatch } from './cart-rows.mjs';
import { requireCartTab } from './cart-read.mjs';
import { cartAvailabilitySummary } from './cart-availability.mjs';

// Collection version 1 predates row availability and version 2 classifies it with rule 1; batches keep their
// collection's shape and rule until it ends, so one result never mixes rules.
const BATCH_VERSIONS = { 1: [2, 3], 2: [5, 3], 3: [5, 3] };
const AVAILABILITY_RULES = { 2: 1, 3: 2 };
const withAvailability = state => state.schema_version !== 1;
const batchOptions = state => withAvailability(state)
  ? { availability: true, availabilityRules: AVAILABILITY_RULES[state.schema_version] } : { availability: false };
function batchMatches(state, snapshot) {
  return BATCH_VERSIONS[state.schema_version].includes(snapshot.schema_version) && (snapshot.schema_version !== 5 ||
    snapshot.rows.every(row => (row.availability.classification_version ?? 1) === AVAILABILITY_RULES[state.schema_version]));
}

/** @returns {object} Empty new collection whose rows carry availability; row-limit validation belongs to newCartReadState. @example newCartCollection(); */
export function newCartCollection() { return { schema_version: 3, batches: [] }; }

/**
 * @param {object} state Validated collection. @param {number} rowLimit Saved requested limit.
 * @returns {object|null} Next five-or-fewer positions and prefix guards; null means complete.
 * @throws {ShoppingError} CART_CONTINUITY_UNVERIFIED for missing guards.
 * @example cartCollectionPlan(newCartCollection(), 10);
 */
export function cartCollectionPlan(state, rowLimit) {
  const rows = state.batches.flatMap(batch => batch.snapshot.rows);
  const loaded = state.batches[0]?.snapshot.coverage.loaded_rows_seen ?? null;
  const end = Math.min(rowLimit, loaded ?? rowLimit);
  if (rows.length >= end) return null;
  const guards = rows.map(cartRowGuard);
  if (guards.some(guard => guard === null)) throw new ShoppingError('CART_CONTINUITY_UNVERIFIED', 'Preceding cart rows lack sufficient observed fields for a safe continuation. Saved rows were retained.');
  return { start: rows.length + 1, limit: Math.min(5, end - rows.length), loaded_rows_seen: loaded, guards };
}

/**
 * @param {{bridge:object,op:object}} options Validated operation with its read already reserved.
 * @returns {Promise<object>} One validated batch on the saved tab; no actions or adapter retries.
 * @throws {ShoppingError} Target, connection, page gate, continuity or invalid-response errors.
 * @example await runCartCollection({bridge, op});
 */
export async function runCartCollection({ bridge, op }) {
  const plan = cartCollectionPlan(op.cart_collection, op.cart_read.row_limit);
  await requireCartTab(bridge, op);
  const result = await bridge.readCartBatch(op.tab_id, op.target, plan, batchOptions(op.cart_collection));
  try {
    validateSavedCartBatch(result, op.target, plan);
    if (!batchMatches(op.cart_collection, result)) throw new Error('mixed batch versions');
    return result;
  } catch { throw new ShoppingError('INVALID_RESPONSE', 'The cart adapter returned an invalid batch snapshot.'); }
}

/**
 * @param {object} state Validated collection. @param {{url:string}} target Saved identity. @param {number} rowLimit Saved limit.
 * @returns {object} Local-only delivery with each batch time and global positions; no deduplication or full-cart assertion.
 * @example cartCollectionResult(state, target, 10);
 */
export function cartCollectionResult(state, target, rowLimit) {
  const loaded = state.batches[0]?.snapshot.coverage.loaded_rows_seen ?? null;
  const emptySnapshot = state.batches.length === 1 && state.batches[0].snapshot.schema_version === 3
    ? state.batches[0].snapshot : null;
  const rows = state.batches.flatMap(batch => batch.snapshot.rows.map(row => ({ ...row, observed_at: batch.snapshot.observed_at })));
  const availability = withAvailability(state) && !emptySnapshot;
  return { schema_version: emptySnapshot ? 3 : availability ? 2 : 1, url: target.url, requested_rows: rowLimit, batches: state.batches, rows,
    ...(emptySnapshot ? {empty_evidence:structuredClone(emptySnapshot.empty_evidence)} : {}),
    ...(availability ? { availability_summary: cartAvailabilitySummary(rows) } : {}),
    coverage: { status: 'partial', loaded_rows_seen: loaded, returned_rows: rows.length,
      rows_omitted: loaded === null ? null : loaded - rows.length,
      requested_limit_reached: rows.length === rowLimit,
      requested_loaded_range_read: loaded !== null && rows.length === Math.min(rowLimit, loaded),
      page_total_rows: null, full_cart: false, empty_cart_verified: emptySnapshot !== null, account_identity_verified: false,
      physical_row_identity_verified: false, display_price_kind_verified: false, payment_verified: false },
    privacy: { local_only: true, account_fields_read: false } };
}

/**
 * @param {unknown} state Saved collection. @param {{url:string}} target Saved identity.
 * @param {object} op Operation with validated budget. @param {string} taskStatus Saved enclosing status.
 * @returns {void} Validates finite progress and batch/attempt order before IO, without upgrades.
 * @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent progress or result.
 * @example validateCartCollection(op.cart_collection, op.target, op, task.status);
 */
export function validateCartCollection(state, target, op, taskStatus) {
  const invalid = () => { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved cart collection is invalid or incompatible.'); };
  if (!state || Object.keys(state).sort().join(',') !== 'batches,schema_version' || ![1, 2, 3].includes(state.schema_version) ||
      op.cart_read.schema_version !== 2 || !Array.isArray(state.batches) || state.batches.length > Math.ceil(op.cart_read.row_limit / 5)) invalid();
  const previous = { schema_version: state.schema_version, batches: [] };
  let attempt = 0;
  for (const batch of state.batches) {
    if (!batch || Object.keys(batch).sort().join(',') !== 'attempt,snapshot' || !Number.isSafeInteger(batch.attempt) ||
        batch.attempt <= attempt || batch.attempt > op.attempts || op.cart_read.failures.some(failure => failure.attempt === batch.attempt)) invalid();
    let plan;
    try { plan = cartCollectionPlan(previous, op.cart_read.row_limit); } catch { invalid(); }
    if (!plan) invalid();
    validateSavedCartBatch(batch.snapshot, target, plan);
    if (!batchMatches(state, batch.snapshot)) invalid();
    previous.batches.push(batch); attempt = batch.attempt;
  }
  const result = cartCollectionResult(state, target, op.cart_read.row_limit);
  if ((op.status === 'succeeded') !== result.coverage.requested_loaded_range_read ||
      (op.result !== null && !isDeepStrictEqual(op.result, result)) ||
      (op.status === 'running' && attempt === op.attempts) ||
      (taskStatus === 'awaiting_batch' && (op.status !== 'pending' || op.error !== null || !state.batches.length || attempt !== op.attempts))) invalid();
  if (taskStatus === 'awaiting_batch') {
    try { if (!cartCollectionPlan(state, op.cart_read.row_limit)) invalid(); } catch { invalid(); }
  }
}
