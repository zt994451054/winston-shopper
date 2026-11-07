import { lstat, readFile } from 'node:fs/promises';
import { ShoppingError } from './errors.mjs';
import { normalizeSelection } from './selections.mjs';

/**
 * Load a small explicit combination plan; never accept executable content or navigation URLs.
 * @param {string} filename @returns {Promise<Array<{binding: string, selection: Array}>>}
 * @throws {ShoppingError} INVALID_SELECTION_PLAN or INVALID_SELECTION.
 * @example await loadSelectionPlan('./mouse-options.json');
 */
export async function loadSelectionPlan(filename) {
  let value;
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw new Error();
    value = JSON.parse(await readFile(filename, 'utf8'));
    if (value?.schema_version !== 1 || Object.keys(value).some(key => !['schema_version', 'items'].includes(key)) ||
        !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 20) throw new Error();
  } catch { throw new ShoppingError('INVALID_SELECTION_PLAN', 'Use a regular JSON plan file with schema_version 1 and 1–20 items.'); }
  return value.items.map(item => {
    if (!item || Object.keys(item).some(key => !['binding', 'selection'].includes(key)) ||
        typeof item.binding !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.binding)) {
      throw new ShoppingError('INVALID_SELECTION_PLAN', 'Each plan item needs a saved binding name and a selection array.');
    }
    return { binding: item.binding, selection: normalizeSelection(item.selection) };
  });
}
