import { readFile, lstat } from 'node:fs/promises';
import { ShoppingError } from './errors.mjs';
import { normalizeReviewCategoryPlan } from './review-categories.mjs';

/** @param {string} filename @returns {Promise<Array<string|null>>} A bounded JSON category plan. @throws {ShoppingError} INVALID_REVIEW_CATEGORIES for invalid files or labels. @example await loadReviewCategoryPlan('categories.json'); */
export async function loadReviewCategoryPlan(filename) {
  try {
    if (typeof filename !== 'string' || !filename) throw new Error();
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error();
    const bytes = await readFile(filename);
    if (bytes.length > 8192) throw new Error();
    return normalizeReviewCategoryPlan(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new ShoppingError('INVALID_REVIEW_CATEGORIES', 'Use a JSON file containing one to three exact category labels, or [null] for the current category.');
  }
}
