import { createHash } from 'node:crypto';
import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';

const KINDS = ['title', 'specification', 'price'];
const REASONS = ['title_missing', 'title_ambiguous', 'specification_region_ambiguous', 'price_region_ambiguous'];
const EXCLUSIONS = [null, 'fixed_summary', 'other_product', 'unsupported_content'];

// Serialized with the existing guarded read; no extra request or page action is introduced.
function collectEvidence(product, expected) {
  if (product.state !== 'structure_changed') return product;
  const selector = prefix => `[class^="${prefix}--"], [class*=" ${prefix}--"]`;
  const prefixes = node => String(node.getAttribute('class') ?? '').split(/\s+/)
    .map(token => token.match(/^([A-Za-z][A-Za-z0-9_]{0,63})--/)?.[1]).filter(Boolean).slice(0, 8);
  const visible = node => {
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return node.getClientRects().length > 0;
  };
  const exclusion = node => {
    const names = prefixes(node);
    const tag = node.tagName.toUpperCase();
    if (names.includes('ItemHeadFixed')) return 'fixed_summary';
    if (['SCRIPT', 'STYLE', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG'].includes(tag) ||
        names.some(name => /delivery|address|review|recommend/i.test(name))) return 'unsupported_content';
    if (tag === 'A') {
      try {
        const url = new URL(node.getAttribute('href'), location.href);
        if (/^(item\.taobao\.com|detail\.tmall\.com)$/.test(url.hostname) &&
            url.pathname === '/item.htm' && url.searchParams.get('id') !== expected.product_id) return 'other_product';
      } catch { /* A malformed link is not a product identity source. */ }
    }
    return null;
  };
  const panelRefs = new Map();
  const context = node => {
    const ancestors = []; let panel = null, excluded = null, depth = 0;
    for (let parent = node; parent; parent = parent.parentElement) {
      const names = prefixes(parent);
      excluded ??= exclusion(parent);
      if (names.includes('GeneralSkuPanel') && panel === null) {
        if (!panelRefs.has(parent)) panelRefs.set(parent, panelRefs.size + 1);
        panel = panelRefs.get(parent);
      }
      if (parent !== node && ancestors.length < 8) ancestors.push(names);
      depth++;
    }
    return { panel_ref: panel, ancestors, ancestors_truncated: depth > 9, excluded_reason: excluded };
  };
  const regions = [], counts = {};
  let nextNode = 1;
  for (const [kind, query] of [['title', selector('ItemTitle')], ['specification', selector('skuWrapper')],
    ['price', `${selector('normalPrice')}, ${selector('beltPrice')}`]]) {
    const roots = [...document.querySelectorAll(query)].filter(visible);
    counts[kind] = roots.length;
    for (const root of roots.slice(0, 3)) {
      const region = { ref: regions.length + 1, kind, ...context(root), nodes: [], traversal_truncated: false };
      let visited = 0;
      const visit = (node, parentRef, depth) => {
        if (++visited > 160 || region.nodes.length >= 40 || depth > 6) { region.traversal_truncated = true; return; }
        if (!visible(node)) return;
        const excluded = region.excluded_reason ?? exclusion(node), ref = nextNode++;
        let raw = '', textTruncated = false;
        if (!excluded) {
          let seen = 0;
          for (const child of node.childNodes) {
            if (++seen > 80) { textTruncated = true; break; }
            if (child.nodeType === 3) raw += (child.nodeValue ?? '').slice(0, 401);
            if (raw.length > 400) { textTruncated = true; break; }
          }
        }
        const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
        let image = null;
        if (!excluded && kind === 'specification' && node.tagName === 'IMG') {
          const source = node.currentSrc || node.getAttribute('src') || '';
          try {
            const url = new URL(source, location.href);
            if (source && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
                /(^|\.)alicdn\.com$/.test(url.hostname) && !url.search && !url.hash && url.href.length <= 2048) {
              image = { url: url.href, width: node.naturalWidth, height: node.naturalHeight, loaded: node.complete === true };
            }
          } catch { /* Unresolved image sources stay null. */ }
        }
        region.nodes.push({ ref, parent_ref: parentRef, tag: node.tagName.toUpperCase(), component_prefixes: prefixes(node),
          text: text.slice(0, 400), text_truncated: textTruncated || text.length > 400, excluded_reason: excluded, image });
        if (excluded) return;
        for (const child of node.children) {
          if (visited >= 160 || region.nodes.length >= 40) { region.traversal_truncated = true; break; }
          visit(child, ref, depth + 1);
        }
      };
      visit(root, null, 0);
      regions.push(region);
    }
  }
  return { ...product, layout_evidence: { schema_version: 1, product_id: expected.product_id, url: expected.url,
    observed_at: new Date().toISOString(), reason: product.reason, source: 'same_read_supported_regions',
    counts, regions, contains_untrusted_page_text: true } };
}

function invalid() { return new ShoppingError('INVALID_LAYOUT_EVIDENCE', 'The bounded layout evidence is invalid or does not match this product.'); }
function keys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function integer(value, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function validPrefixes(value) {
  return Array.isArray(value) && value.length <= 8 && value.every(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name));
}
function validImage(value, kind, tag) {
  if (value === null) return true;
  if (kind !== 'specification' || tag !== 'IMG' || !keys(value, ['url', 'width', 'height', 'loaded']) ||
      typeof value.url !== 'string' || value.url.length > 2048 || !integer(value.width, 100000) || !integer(value.height, 100000) ||
      typeof value.loaded !== 'boolean') return false;
  try {
    const url = new URL(value.url);
    return url.href === value.url && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /(^|\.)alicdn\.com$/.test(url.hostname) && !url.search && !url.hash;
  } catch { return false; }
}

/**
 * Append a fixed, bounded diagnostic collector to an already guarded product expression.
 * @param {string} script Internal product expression. @param {object} target Canonical bound product.
 * @returns {string} One read-only expression; successful or gated reads remain unchanged.
 * @example withLayoutEvidence(productExpression, target)
 */
export function withLayoutEvidence(script, target) {
  return `(() => { const product = ${script};
    try { return (${collectEvidence.toString()})(product, ${JSON.stringify(target)}); }
    catch { return { ...product, layout_evidence_error: 'COLLECTION_FAILED' }; }
  })()`;
}

/**
 * Validate evidence topology, limits and target; never infer missing nodes or field meanings.
 * @param {unknown} value @param {object} target Canonical target. @returns {object} The validated evidence.
 * @throws {ShoppingError} INVALID_LAYOUT_EVIDENCE. @example validateLayoutEvidence(packet, target)
 */
export function validateLayoutEvidence(value, target) {
  const expected = parseProductUrl(target?.url);
  if (!keys(value, ['schema_version', 'product_id', 'url', 'observed_at', 'reason', 'source', 'counts', 'regions', 'contains_untrusted_page_text']) ||
      !expected || value.schema_version !== 1 || value.product_id !== expected.product_id || value.url !== expected.url ||
      typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) || !REASONS.includes(value.reason) ||
      value.source !== 'same_read_supported_regions' || value.contains_untrusted_page_text !== true || !keys(value.counts, KINDS) ||
      KINDS.some(kind => !integer(value.counts[kind])) || !Array.isArray(value.regions) || value.regions.length > 9) throw invalid();
  const ids = new Set(); let nextNode = 1;
  for (const [index, region] of value.regions.entries()) {
    if (!keys(region, ['ref', 'kind', 'panel_ref', 'ancestors', 'ancestors_truncated', 'excluded_reason', 'nodes', 'traversal_truncated']) ||
        region.ref !== index + 1 || !KINDS.includes(region.kind) ||
        (region.panel_ref !== null && (!integer(region.panel_ref, 9) || region.panel_ref === 0)) ||
        !Array.isArray(region.ancestors) || region.ancestors.length > 8 || !region.ancestors.every(validPrefixes) ||
        typeof region.ancestors_truncated !== 'boolean' || !EXCLUSIONS.includes(region.excluded_reason) ||
        typeof region.traversal_truncated !== 'boolean' || !Array.isArray(region.nodes) || region.nodes.length < 1 || region.nodes.length > 40) throw invalid();
    const parents = new Map();
    for (const [nodeIndex, node] of region.nodes.entries()) {
      if (!keys(node, ['ref', 'parent_ref', 'tag', 'component_prefixes', 'text', 'text_truncated', 'excluded_reason', 'image']) ||
          node.ref !== nextNode++ || ids.has(node.ref) ||
          (nodeIndex === 0 ? node.parent_ref !== null : !parents.has(node.parent_ref)) ||
          typeof node.tag !== 'string' || !/^[A-Z][A-Z0-9-]{0,31}$/.test(node.tag) || !validPrefixes(node.component_prefixes) ||
          typeof node.text !== 'string' || node.text.length > 400 || /[\u0000-\u001f\u007f]/.test(node.text) ||
          typeof node.text_truncated !== 'boolean' || !EXCLUSIONS.includes(node.excluded_reason) ||
          (region.excluded_reason !== null && node.excluded_reason !== region.excluded_reason) ||
          (node.excluded_reason !== null && (node.text !== '' || node.image !== null)) || !validImage(node.image, region.kind, node.tag)) throw invalid();
      const parent = parents.get(node.parent_ref);
      if (parent?.excluded || (parent?.depth ?? -1) >= 6) throw invalid();
      parents.set(node.ref, { excluded: node.excluded_reason !== null, depth: (parent?.depth ?? -1) + 1 });
      ids.add(node.ref);
    }
  }
  for (const kind of KINDS) if (value.regions.filter(region => region.kind === kind).length !== Math.min(3, value.counts[kind])) throw invalid();
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/**
 * Identify the exact validated evidence, independent of JSON object key order.
 * @param {object} evidence @returns {string} SHA-256; not a platform SKU or proof of external authenticity.
 * @example layoutEvidenceId(evidence)
 */
export function layoutEvidenceId(evidence) {
  validateLayoutEvidence(evidence, { url: evidence?.url });
  return createHash('sha256').update(JSON.stringify(canonical(evidence))).digest('hex');
}
