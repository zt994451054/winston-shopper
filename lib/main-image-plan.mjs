import { readFile, lstat } from 'node:fs/promises';
import { ShoppingError } from './errors.mjs';
import { normalizeMainImages } from './main-images.mjs';

/** @param {string} filename @returns {Promise<string[]>} One to three exact observed thumbnail URLs. @throws {ShoppingError} INVALID_MAIN_IMAGES for invalid, oversized or symbolic-link files. @example await loadMainImagePlan('main-images.json'); */
export async function loadMainImagePlan(filename) {
  try {
    if (typeof filename !== 'string' || !filename) throw new Error();
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error();
    const bytes = await readFile(filename);
    if (bytes.length > 8192) throw new Error();
    return normalizeMainImages(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new ShoppingError('INVALID_MAIN_IMAGES', 'Use a JSON file containing one to three distinct exact product thumbnail URLs.');
  }
}
