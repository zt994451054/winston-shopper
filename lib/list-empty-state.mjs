import { ShoppingError } from './errors.mjs';

const KEYS = ['scope', 'basis', 'message', 'list_root_count', 'notice_count', 'notice_visible',
  'notice_within_list', 'document_ready', 'gates_clear'];
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

/**
 * Validate explicit empty-notice evidence supplied by a reviewed list adapter, never infer it from zero rows.
 * @param {unknown} value Unique, visible, complete notice inside a ready, ungated current list root.
 * @returns {object} Independent evidence value scoped to this view; it makes no whole-account claim.
 * @throws {ShoppingError} INVALID_RESPONSE for missing, ambiguous, gated or unbounded evidence.
 * @example normalizeListEmptyEvidence(observation.empty_evidence);
 */
export function normalizeListEmptyEvidence(value) {
  if (!exact(value, KEYS) || value.scope !== 'current_list_view' || value.basis !== 'explicit_empty_notice' ||
      value.list_root_count !== 1 || value.notice_count !== 1 || value.notice_visible !== true ||
      value.notice_within_list !== true || value.document_ready !== true || value.gates_clear !== true ||
      !exact(value.message, ['text', 'truncated']) || value.message.truncated !== false ||
      typeof value.message.text !== 'string' || !value.message.text || value.message.text.length > 500 ||
      value.message.text !== value.message.text.trim() || /\p{Cc}/u.test(value.message.text)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The list returned invalid explicit empty-notice evidence.');
  }
  return structuredClone(value);
}
