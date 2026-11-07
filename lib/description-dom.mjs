import { ShoppingError } from './errors.mjs';
import { responseText } from './page-dom.mjs';

/**
 * Collect text and expansion clues only inside the observed detail region; no actions or hidden state.
 * @param {Element|null} region Observed imageTextInfo region. @param {object} dom Visible DOM helpers.
 * @returns {object} Bounded text plus evidence of traversal limits, clipping and candidate controls.
 * @throws {Error} Multiple supported text containers are ambiguous.
 * @example collectDescriptionText(document.querySelector('.imageTextInfo--sample'), pageDom());
 */
export function collectDescriptionText(region, dom) {
  const limits = { nodes: 800, depth: 12, text_characters: 6000, controls: 8 };
  const evidence = { schema_version: 1, text_container_observed: false, nodes_scanned: 0,
    traversal_truncated: false, text_truncated: false, clipped_subtrees_omitted: 0,
    control_candidates: [], controls_truncated: false, expansion_behavior_verified: false, limits };
  if (!region) return { text: '', observation: evidence };
  const containers = dom.all(region, '.descV8-container');
  if (containers.length > 1) throw new Error('Ambiguous description container');
  const container = containers[0] ?? null;
  evidence.text_container_observed = container !== null;
  const excluded = node => ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'IMG', 'VIDEO', 'AUDIO'].includes(node.tagName.toUpperCase()) ||
    node.matches('.descV8-charity, .descV8-singleImage, .descV8-video');
  const clipped = node => {
    const style = getComputedStyle(node);
    return (['hidden', 'clip'].includes(style.overflowY ?? style.overflow) && node.scrollHeight > node.clientHeight + 1) ||
      (['hidden', 'clip'].includes(style.overflowX ?? style.overflow) && node.scrollWidth > node.clientWidth + 1);
  };
  const control = node => {
    if (!['BUTTON', 'A', 'SUMMARY'].includes(node.tagName.toUpperCase()) && node.getAttribute('role') !== 'button' && node.getAttribute('aria-expanded') === null) return false;
    const label = dom.text(node, 80).replace(/\s+/g, ' ').trim();
    if (!/展开|收起|加载更多|查看.{0,8}(全部|完整|更多|详情)/.test(label)) return false;
    if (evidence.control_candidates.length >= limits.controls) { evidence.controls_truncated = true; return true; }
    evidence.control_candidates.push({ label, tag: node.tagName.toUpperCase(),
      class_name: (node.getAttribute('class') ?? '').slice(0, 300),
      aria_expanded: (node.getAttribute('aria-expanded') ?? '').slice(0, 20),
      disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('data-disabled') === 'true') });
    return true;
  };
  let text = '';
  const append = value => {
    const normalized = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ');
    if (text.length + normalized.length > limits.text_characters) evidence.text_truncated = true;
    text += normalized.slice(0, limits.text_characters - text.length);
  };
  const visit = (node, depth, inText) => {
    if (evidence.nodes_scanned >= limits.nodes || depth > limits.depth) { evidence.traversal_truncated = true; return; }
    evidence.nodes_scanned += 1;
    if (node.nodeType === 3) { if (inText) append(node.nodeValue ?? ''); return; }
    if (node.nodeType !== 1 || !dom.visible(node) || excluded(node)) return;
    // Clipped DOM can contain text the user cannot currently see; omit it rather than expose the hidden remainder.
    if (clipped(node)) { evidence.clipped_subtrees_omitted += 1; return; }
    if (control(node)) return;
    const isText = inText || node === container;
    if (isText && ['DIV', 'P', 'LI', 'TR', 'H1', 'H2', 'H3', 'BR'].includes(node.tagName.toUpperCase())) append(' ');
    if (depth === limits.depth) {
      if (node.childNodes.length) evidence.traversal_truncated = true;
      return;
    }
    for (const child of node.childNodes) {
      if (evidence.nodes_scanned >= limits.nodes) { evidence.traversal_truncated = true; break; }
      visit(child, depth + 1, isText);
    }
    if (isText && ['DIV', 'P', 'LI', 'TR', 'H1', 'H2', 'H3'].includes(node.tagName.toUpperCase())) append(' ');
  };
  visit(region, 0, false);
  return { text: text.trim(), observation: evidence };
}

/**
 * @param {unknown} value Untrusted description observation from a fixed page read.
 * @returns {object} Canonical bounded text and layout observation.
 * @throws {ShoppingError} INVALID_RESPONSE for unsupported fields, limits or guarantees.
 * @example normalizeDescriptionObservation(collectDescriptionText(null, {}).observation);
 */
export function normalizeDescriptionObservation(value) {
  const invalid = () => new ShoppingError('INVALID_RESPONSE', 'Invalid bounded description observation.');
  const keys = 'clipped_subtrees_omitted,control_candidates,controls_truncated,expansion_behavior_verified,limits,nodes_scanned,schema_version,text_container_observed,text_truncated,traversal_truncated';
  if (!value || Object.keys(value).sort().join(',') !== keys || value.schema_version !== 1 ||
      !Number.isSafeInteger(value.nodes_scanned) || value.nodes_scanned < 0 || value.nodes_scanned > 800 ||
      !Number.isSafeInteger(value.clipped_subtrees_omitted) || value.clipped_subtrees_omitted < 0 || value.clipped_subtrees_omitted > value.nodes_scanned ||
      !['text_container_observed', 'traversal_truncated', 'text_truncated', 'controls_truncated'].every(key => typeof value[key] === 'boolean') ||
      value.expansion_behavior_verified !== false || !Array.isArray(value.control_candidates) || value.control_candidates.length > 8 ||
      value.control_candidates.length > value.nodes_scanned || (value.controls_truncated && value.control_candidates.length !== 8)) throw invalid();
  const limits = { nodes: 800, depth: 12, text_characters: 6000, controls: 8 };
  if (!value.limits || Object.keys(value.limits).length !== 4 || !Object.entries(limits).every(([key, limit]) => value.limits[key] === limit)) throw invalid();
  const candidates = value.control_candidates.map(candidate => {
    if (!candidate || Object.keys(candidate).sort().join(',') !== 'aria_expanded,class_name,disabled,label,tag' || typeof candidate.disabled !== 'boolean') throw invalid();
    const normalized = { label: responseText(candidate.label, 80), tag: responseText(candidate.tag, 20),
      class_name: responseText(candidate.class_name, 300), aria_expanded: responseText(candidate.aria_expanded, 20), disabled: candidate.disabled };
    if (!/展开|收起|加载更多|查看.{0,8}(全部|完整|更多|详情)/.test(normalized.label) || !/^[A-Z][A-Z0-9-]{0,19}$/.test(normalized.tag)) throw invalid();
    return normalized;
  });
  return { schema_version: 1, text_container_observed: value.text_container_observed, nodes_scanned: value.nodes_scanned,
    traversal_truncated: value.traversal_truncated, text_truncated: value.text_truncated, clipped_subtrees_omitted: value.clipped_subtrees_omitted,
    control_candidates: candidates, controls_truncated: value.controls_truncated, expansion_behavior_verified: false, limits };
}
