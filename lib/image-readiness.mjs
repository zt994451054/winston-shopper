import { ShoppingError } from './errors.mjs';

const statuses = ['normal_size_loaded', 'tiny_image_unresolved', 'not_loaded', 'url_not_observed', 'unsupported_url'];
const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The description image readiness evidence is invalid.');

function count(value, maximum = 10000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalid();
  return value;
}

function loadingFields(value) {
  if (typeof value?.loaded !== 'boolean') throw invalid();
  const width = count(value.width, 1000000), height = count(value.height, 1000000);
  if (value.loaded && (!width || !height)) throw invalid();
  return { loaded: value.loaded, width, height };
}

function statusOf(entry) {
  if (entry.url_state === 'absent') return 'url_not_observed';
  if (entry.url_state === 'unsupported') return 'unsupported_url';
  if (!entry.loaded) return 'not_loaded';
  return entry.width <= 2 || entry.height <= 2 ? 'tiny_image_unresolved' : 'normal_size_loaded';
}

function summarize(observed, seen, entries) {
  if (typeof observed !== 'boolean' || entries.length > 60 || seen < entries.length || (!observed && seen)) throw invalid();
  const counts = Object.fromEntries(statuses.map(status => [status, 0]));
  for (const entry of entries) counts[entry.status] += 1;
  return { schema_version: 1, source: 'description_image_dom', region_observed: observed,
    elements_seen: seen, elements_scanned: entries.length, unscanned_elements: seen - entries.length,
    entries, counts, full_description_verified: false };
}

/**
 * Preserve per-element loading evidence separately from deduplicated links.
 * @param {object} region Raw description image scan (at most 60 rows).
 * @param {function(string): (string|null)} normalizeUrl Supported public asset URL policy.
 * @returns {object} Scoped readiness evidence; tiny resources remain unresolved.
 * @throws {ShoppingError} INVALID_RESPONSE for inconsistent scan or loading fields.
 * @example describeImageReadiness(raw.description, value => detailUrl(value, 'image'));
 */
export function describeImageReadiness(region, normalizeUrl) {
  if (typeof normalizeUrl !== 'function' || !Array.isArray(region?.items) || region.items.length > 60) throw invalid();
  const seen = count(region.elements_seen);
  const entries = region.items.map((row, index) => {
    if (typeof row?.url !== 'string') throw invalid();
    const url = normalizeUrl(row.url), urlState = url ? 'supported' : row.url === '' ? 'absent' : 'unsupported';
    const entry = { position: index + 1, url, url_state: urlState, ...loadingFields(row) };
    return { ...entry, status: statusOf(entry) };
  });
  return summarize(region.observed, seen, entries);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw invalid();
}

/**
 * Validate saved readiness without deriving new evidence for legacy snapshots.
 * @param {object} value Saved readiness metadata. @param {function} normalizeUrl Public asset URL policy.
 * @returns {object} Canonical evidence with independently derived statuses and counts.
 * @throws {ShoppingError} INVALID_RESPONSE for extra fields, inconsistent counts or changed URLs.
 * @example normalizeImageReadiness(saved.image_readiness, publicImageUrl);
 */
export function normalizeImageReadiness(value, normalizeUrl) {
  exactKeys(value, ['schema_version', 'source', 'region_observed', 'elements_seen', 'elements_scanned', 'unscanned_elements', 'entries', 'counts', 'full_description_verified']);
  if (typeof normalizeUrl !== 'function' || value.schema_version !== 1 || value.source !== 'description_image_dom' ||
      value.full_description_verified !== false || !Array.isArray(value.entries) || value.entries.length > 60) throw invalid();
  const entries = value.entries.map((entry, index) => {
    exactKeys(entry, ['position', 'url', 'url_state', 'loaded', 'width', 'height', 'status']);
    if (entry.position !== index + 1 || !['supported', 'absent', 'unsupported'].includes(entry.url_state)) throw invalid();
    if (entry.url_state === 'supported' ? typeof entry.url !== 'string' || normalizeUrl(entry.url) !== entry.url : entry.url !== null) throw invalid();
    const normalized = { position: entry.position, url: entry.url, url_state: entry.url_state, ...loadingFields(entry) };
    const status = statusOf(normalized);
    if (entry.status !== status) throw invalid();
    return { ...normalized, status };
  });
  const result = summarize(value.region_observed, count(value.elements_seen), entries);
  exactKeys(value.counts, statuses);
  if (value.elements_scanned !== result.elements_scanned || value.unscanned_elements !== result.unscanned_elements ||
      statuses.some(status => value.counts[status] !== result.counts[status])) throw invalid();
  return result;
}

/**
 * Check that readiness and delivered links describe the same element scan.
 * @param {object} readiness Validated readiness. @param {object} description Normalized image collection.
 * @returns {void} @throws {ShoppingError} INVALID_RESPONSE for mismatched scope, URLs or dimensions.
 * @example validateImageReadinessMapping(readiness, details.description);
 */
export function validateImageReadinessMapping(readiness, description) {
  if (readiness.region_observed !== description.observed || readiness.elements_seen !== description.elements_seen ||
      readiness.elements_scanned !== description.elements_scanned || readiness.unscanned_elements !== description.elements_seen - description.elements_scanned) throw invalid();
  const found = new Set(), items = [];
  let duplicates = 0, unsupported = 0;
  for (const entry of readiness.entries) {
    if (entry.url_state !== 'supported') { unsupported += 1; continue; }
    if (found.has(entry.url)) { duplicates += 1; continue; }
    found.add(entry.url);
    items.push({ position: entry.position, url: entry.url, loaded: entry.loaded, width: entry.width, height: entry.height, source: 'description_image' });
  }
  // Readiness entries do not record the description module, so links are compared without it.
  const delivered = description.items.map(({ module, ...item }) => item);
  if (duplicates !== description.duplicates_omitted || unsupported !== description.unsupported_urls_omitted ||
      JSON.stringify(items) !== JSON.stringify(delivered)) throw invalid();
}
