import { ShoppingError } from './errors.mjs';
import { specificationImageContinuation } from './specification-images.mjs';

/** @returns {object} New bounded batch journal; eight batches plus two failed reads. @example newSpecificationImageBatches(); */
export function newSpecificationImageBatches() {
  return { schema_version: 1, batch_limit: 8, read_limit: 10, batches: [] };
}

/**
 * @param {object} state Saved journal. @param {object} target Product identity. @param {number} attempts Counted reads.
 * @returns {void} Validates saved batch order and limits without changing data.
 * @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateSpecificationImageBatches(state, target, 2);
 */
export function validateSpecificationImageBatches(state, target, attempts) {
  try {
    const expected = newSpecificationImageBatches();
    if (!state || !Array.isArray(state.batches) || state.batches.length > expected.batch_limit ||
        !Number.isSafeInteger(attempts) || attempts < state.batches.length || attempts > expected.read_limit ||
        JSON.stringify({ ...state, batches: [] }) !== JSON.stringify(expected)) throw new Error();
    specificationImageContinuation(state.batches, target);
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The specification image batch journal is inconsistent.'); }
}

/**
 * @param {object} state Validated journal. @param {object} target Identity.
 * @returns {object} Time-preserving batches and cumulative coverage, without merging observations into one timestamp.
 * @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent batches.
 * @example specificationImageBatchResult(state, target);
 */
export function specificationImageBatchResult(state, target) {
  const continuation = specificationImageContinuation(state.batches, target);
  const sampled = state.batches.reduce((sum, batch) => sum + batch.scope.image_options_sampled, 0);
  const returned = state.batches.reduce((sum, batch) => sum + batch.availability.returned_images, 0);
  const total = state.batches[0]?.scope.image_options_seen ?? null;
  return { schema_version: 1, product_id: target.product_id, url: target.url,
    source: 'specification_option_image_batches', batches: state.batches,
    coverage: { status: 'partial', batches: state.batches.length, image_options_sampled: sampled,
      image_options_seen_in_scanned_structure: total, image_options_remaining: total === null ? null : total - sampled,
      returned_images: returned, scanned_image_options_sampled: continuation === null,
      full_option_images: false, full_sku_matrix: false, cross_batch_image_state_verified: false },
    limits: { image_options_per_batch: 5, batches: state.batch_limit, content_reads: state.read_limit } };
}
