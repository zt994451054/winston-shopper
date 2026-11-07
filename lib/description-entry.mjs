import { ShoppingError } from './errors.mjs';
import { detailsScript, validateDetails, validateSavedDetails } from './details.mjs';
import { pageDom, responseText } from './page-dom.mjs';

/**
 * Inspect bounded controls and their explicit relationship to the unique description container.
 * Hidden text is not read. Returned nodes are local to the serialized action guard only.
 * @param {object} dom Page DOM helpers. @returns {{observation: object, nodes: Element[]}}
 * @example collectDescriptionEntry(pageDom());
 */
export function collectDescriptionEntry(dom) {
  const roots = dom.all(document, dom.selector('imageTextInfo'));
  if (roots.length > 1) throw new Error('Ambiguous description region');
  const root = roots[0] ?? null;
  const containers = root ? [...root.querySelectorAll('.descV8-container')] : [];
  const controls = root ? dom.all(root, 'button, summary, [role="button"], [aria-expanded]') : [];
  const observation = { schema_version: 1, region_observed: root !== null, container_count: containers.length,
    controls_seen: controls.length, controls_scanned: Math.min(controls.length, 8), controls_truncated: controls.length > 8,
    potential_entries_seen: 0, entries: [] };
  const nodes = [];
  for (const [index, node] of controls.slice(0, 8).entries()) {
    if (node.closest('.descV8-video, .descV8-charity, a, form, [hidden], [inert], [aria-hidden="true"]')) continue;
    const label = dom.text(node, 81).replace(/\s+/g, '').trim();
    if (label.length > 80 || !/^(展开(详情|正文|全文|全部|更多)?|查看(全部|完整)?(详情|正文)|查看更多|加载更多|收起(详情|正文|全文|全部)?)$/.test(label)) continue;
    observation.potential_entries_seen++;
    if (containers.length !== 1) continue;
    const container = containers[0], tag = node.tagName.toUpperCase();
    let kind = null, expanded = null, targetId = null;
    if (tag === 'SUMMARY' && node.parentElement?.tagName === 'DETAILS' &&
        container.closest('details') === node.parentElement &&
        [...node.parentElement.children].filter(child => child.tagName === 'SUMMARY').length === 1) {
      kind = 'native_details'; expanded = node.parentElement.open === true;
    } else if ((tag === 'BUTTON' || tag === 'DIV' && node.getAttribute('role') === 'button') &&
        ['true', 'false'].includes(node.getAttribute('aria-expanded'))) {
      const id = node.getAttribute('aria-controls');
      if (/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(id ?? '') && container.getAttribute('id') === id &&
          document.querySelectorAll(`[id="${id}"]`).length === 1) {
        kind = 'aria_controls'; expanded = node.getAttribute('aria-expanded') === 'true'; targetId = id;
      }
    }
    if (!kind || !expanded && label.startsWith('收起')) continue;
    observation.entries.push({ position: index + 1, kind, tag, label, target_id: targetId, expanded,
      disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('data-disabled') === 'true' });
    nodes.push(node);
  }
  return { observation, nodes };
}

function invalid() { return new ShoppingError('INVALID_RESPONSE', 'The description entry evidence is invalid.'); }

/** @param {object} value Bounded entry evidence. @returns {object} Canonical source metadata. @throws {ShoppingError} INVALID_RESPONSE. @example normalizeDescriptionEntry(raw.entry); */
export function normalizeDescriptionEntry(value) {
  const keys = 'container_count,controls_scanned,controls_seen,controls_truncated,entries,potential_entries_seen,region_observed,schema_version';
  const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  if (!value || Object.keys(value).sort().join(',') !== keys || value.schema_version !== 1 ||
      typeof value.region_observed !== 'boolean' || !integer(value.container_count, 10000) || !integer(value.controls_seen, 10000) ||
      value.controls_scanned !== Math.min(value.controls_seen, 8) || value.controls_truncated !== (value.controls_seen > 8) ||
      !integer(value.potential_entries_seen, value.controls_scanned) || !Array.isArray(value.entries) || value.entries.length > value.potential_entries_seen ||
      !value.region_observed && (value.container_count || value.controls_seen)) throw invalid();
  let previous = 0;
  const entries = value.entries.map(entry => {
    if (!entry || Object.keys(entry).sort().join(',') !== 'disabled,expanded,kind,label,position,tag,target_id' ||
        !integer(entry.position, value.controls_scanned) || entry.position <= previous || typeof entry.expanded !== 'boolean' || typeof entry.disabled !== 'boolean') throw invalid();
    previous = entry.position;
    const label = responseText(entry.label, 80);
    if (label !== entry.label || !/^(展开(详情|正文|全文|全部|更多)?|查看(全部|完整)?(详情|正文)|查看更多|加载更多|收起(详情|正文|全文|全部)?)$/.test(label) ||
        (entry.kind === 'native_details' ? entry.tag !== 'SUMMARY' || entry.target_id !== null
          : entry.kind !== 'aria_controls' || !['BUTTON', 'DIV'].includes(entry.tag) || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(entry.target_id ?? '')) ||
        value.container_count !== 1 || !entry.expanded && label.startsWith('收起')) throw invalid();
    return { position: entry.position, kind: entry.kind, tag: entry.tag, label, target_id: entry.target_id, expanded: entry.expanded, disabled: entry.disabled };
  });
  return { schema_version: 1, region_observed: value.region_observed, container_count: value.container_count,
    controls_seen: value.controls_seen, controls_scanned: value.controls_scanned, controls_truncated: value.controls_truncated,
    potential_entries_seen: value.potential_entries_seen, entries };
}

/** @param {object} entry Validated entry scan. @returns {string} Scoped state without claiming full-page absence. @example descriptionEntryStatus(entry); */
export function descriptionEntryStatus(entry) {
  if (entry.controls_truncated) return 'entry_unverified';
  if (!entry.potential_entries_seen) return 'entry_not_observed';
  if (entry.potential_entries_seen !== 1 || entry.entries.length !== 1 || entry.entries[0].disabled) return 'entry_unverified';
  return entry.entries[0].expanded ? 'expanded' : 'collapsed';
}

/** @param {object} before Validated scan. @param {object} after Validated scan. @returns {boolean} Same explicit control/container relationship; labels may change on expansion. @example sameDescriptionEntry(before, after); */
export function sameDescriptionEntry(before, after) {
  if (before.entries.length !== 1 || after.entries.length !== 1 || before.controls_seen !== after.controls_seen ||
      before.container_count !== after.container_count || before.controls_truncated || after.controls_truncated || after.potential_entries_seen !== 1) return false;
  return ['position', 'kind', 'tag', 'target_id'].every(key => before.entries[0][key] === after.entries[0][key]);
}

function activateDescription(dom, expected, inspection) {
  const gate = dom.gate();
  if (gate) return { state: gate };
  const current = inspection.observation;
  if (current.controls_truncated || current.potential_entries_seen !== 1 || current.entries.length !== 1 ||
      current.controls_seen !== expected.controls_seen ||
      ['position', 'kind', 'tag', 'target_id'].some(key => current.entries[0][key] !== expected.entries[0][key])) return { state: 'structure_changed' };
  const entry = current.entries[0], node = inspection.nodes[0];
  if (entry.expanded) return { state: 'action_dispatched', clicked: false };
  if (entry.disabled || entry.label !== expected.entries[0].label) return { state: 'description_entry_unavailable' };
  const rect = node.getBoundingClientRect();
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return { state: 'description_entry_unavailable' };
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { state: 'description_entry_unavailable' };
  let ancestor = node, reachedBody = false;
  for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none' ||
        ancestor.hasAttribute('hidden') || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') return { state: 'description_entry_unavailable' };
    if (ancestor === document.body) { reachedBody = true; break; }
  }
  const hit = document.elementFromPoint(x, y);
  if (!reachedBody || !hit || hit !== node && !node.contains(hit)) return { state: 'description_entry_unavailable' };
  node.click();
  return { state: 'action_dispatched', clicked: true };
}

/**
 * Read details and finite entry evidence, or guard one expansion against the saved source.
 * @param {object} target Public product. @param {object|null} expected Validated collapsed entry scan for a single reserved action.
 * @returns {string} Fixed script; no scroll, navigation, download or retry.
 * @throws {ShoppingError} INVALID_RESPONSE for a non-collapsed or unverified requested entry.
 * @example descriptionExpansionScript(target, saved.entry);
 */
export function descriptionExpansionScript(target, expected = null) {
  if (expected !== null) {
    expected = normalizeDescriptionEntry(expected);
    if (descriptionEntryStatus(expected) !== 'collapsed') throw invalid();
  }
  return `(() => { const snapshot = ${detailsScript(target)};
    if (snapshot.state !== 'observed') return snapshot;
    const dom = (${pageDom.toString()})();
    let inspection;
    try { inspection = (${collectDescriptionEntry.toString()})(dom); } catch { return {state:'structure_changed'}; }
    return ${expected === null ? '{ snapshot, entry: inspection.observation }' : `(${activateDescription.toString()})(dom, ${JSON.stringify(expected)}, inspection)`};
  })()`;
}

/** @param {object} value Page response. @param {object} target Bound product. @returns {{snapshot: object, entry: object}} Validated same-read observation. @throws {ShoppingError} Product or entry schema errors. @example validateDescriptionObservation(raw, target); */
export function validateDescriptionObservation(value, target) {
  const snapshot = validateDetails(value?.snapshot ?? value, target), entry = normalizeDescriptionEntry(value?.entry);
  if (entry.region_observed !== snapshot.details.description.observed) throw invalid();
  return { snapshot, entry };
}

/** @param {object} value Saved observation. @param {object} target Bound product. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT. @example validateSavedDescriptionObservation(value, target); */
export function validateSavedDescriptionObservation(value, target) {
  try {
    if (!value || Object.keys(value).sort().join(',') !== 'entry,snapshot') throw invalid();
    validateSavedDetails(value.snapshot, target);
    if (JSON.stringify(normalizeDescriptionEntry(value.entry)) !== JSON.stringify(value.entry) ||
        value.entry.region_observed !== value.snapshot.details.description.observed) throw invalid();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved description observation is invalid.'); }
}
