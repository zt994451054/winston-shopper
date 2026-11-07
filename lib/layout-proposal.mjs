import { ShoppingError } from './errors.mjs';
import { layoutEvidenceId, validateLayoutEvidence } from './layout-evidence.mjs';

const FIELDS = Object.freeze({ title: 'title', specification_group: 'specification', specification_option: 'specification',
  specification_image: 'specification', display_price: 'price' });

function reject(reason) {
  throw new ShoppingError('INVALID_LAYOUT_PROPOSAL', `The layout proposal was rejected: ${reason}.`,
    'Use only references from the saved evidence. Missing or ambiguous evidence remains unknown; no browser read was sent.');
}

function descendant(nodes, child, parent) {
  for (let node = nodes.get(child); node; node = nodes.get(node.parent_ref)) if (node.ref === parent) return true;
  return false;
}

function fieldKeys(field) {
  const common = ['field', 'region_ref', 'node_ref'];
  if (field === 'specification_group') return [...common, 'container_ref'];
  if (field === 'specification_option') return [...common, 'container_ref', 'group_ref'];
  if (field === 'specification_image') return [...common, 'option_ref'];
  return common;
}

/**
 * Check model-chosen node references against one saved bounded observation, without IO.
 * Values come only from evidence; the model cannot provide executable code or replacement text.
 * @param {unknown} proposal Versioned evidence ID, product ID and up to 120 field references.
 * @param {object} evidence Validated saved diagnostic. @param {object} target Bound product.
 * @returns {object} Traceable candidate fields, separate from verified product snapshots.
 * @throws {ShoppingError} INVALID_LAYOUT_PROPOSAL or INVALID_LAYOUT_EVIDENCE.
 * @example checkLayoutProposal(proposal, evidence, target)
 */
export function checkLayoutProposal(proposal, evidence, target) {
  validateLayoutEvidence(evidence, target);
  if (!proposal || Object.keys(proposal).sort().join(',') !== 'evidence_id,fields,product_id,schema_version' ||
      proposal.schema_version !== 1 || proposal.evidence_id !== layoutEvidenceId(evidence) ||
      proposal.product_id !== evidence.product_id || !Array.isArray(proposal.fields) ||
      proposal.fields.length < 1 || proposal.fields.length > 120) reject('identity, evidence or field count mismatch');
  const regions = new Map(evidence.regions.map(region => [region.ref, region]));
  const groups = new Map(), options = new Map(), used = new Set(), panelRefs = new Set(), fields = [];
  for (const field of proposal.fields) {
    if (!field || !Object.hasOwn(FIELDS, field.field) ||
        Object.keys(field).sort().join(',') !== fieldKeys(field.field).sort().join(',')) reject('unsupported field shape');
    const region = regions.get(field.region_ref);
    if (!region || region.kind !== FIELDS[field.field] || region.panel_ref === null || region.excluded_reason !== null ||
        region.traversal_truncated || evidence.counts[region.kind] > 3) reject('unavailable, excluded or truncated region');
    const alternatives = evidence.regions.filter(item => item.kind === region.kind && item.excluded_reason === null);
    if (alternatives.length !== 1) reject('ambiguous field region');
    panelRefs.add(region.panel_ref);
    const nodes = new Map(region.nodes.map(node => [node.ref, node]));
    const node = nodes.get(field.node_ref);
    if (!node || node.excluded_reason !== null || node.text_truncated || used.has(node.ref)) reject('invalid or reused node');
    used.add(node.ref);
    if (field.field === 'specification_image') {
      if (!node.image?.loaded || node.image.width <= 2 || node.image.height <= 2) reject('image is missing, unloaded or tiny');
    } else if (!node.text.trim()) reject('missing field text');
    if (field.container_ref !== undefined) {
      const container = nodes.get(field.container_ref);
      if (!container || container.excluded_reason !== null || !descendant(nodes, node.ref, container.ref)) reject('invalid field container');
      const collection = field.field === 'specification_group' ? groups : options;
      if (collection.has(container.ref)) reject('duplicate field container');
      collection.set(container.ref, { field, region, nodes });
    }
    fields.push({ ...field, ...(field.field === 'specification_image' ? { image: structuredClone(node.image) } : { raw: node.text }),
      source_binding_verified: true, field_interpretation_verified: false });
  }
  if (panelRefs.size !== 1 || fields.filter(field => field.field === 'title').length > 1) reject('multiple purchase panels or titles');
  for (const { field, region, nodes } of options.values()) {
    const group = groups.get(field.group_ref);
    if (!group || group.region.ref !== region.ref || field.container_ref === field.group_ref ||
        !descendant(nodes, field.container_ref, field.group_ref)) reject('option does not belong to its proposed group');
  }
  const optionList = [...options.values()];
  for (const [index, { field, nodes }] of optionList.entries()) {
    if (optionList.slice(index + 1).some(other => descendant(nodes, field.container_ref, other.field.container_ref) ||
        descendant(nodes, other.field.container_ref, field.container_ref))) reject('overlapping option containers');
  }
  for (const field of fields.filter(item => item.field === 'specification_image')) {
    const option = options.get(field.option_ref);
    if (!option || option.region.ref !== field.region_ref || !descendant(option.nodes, field.node_ref, field.option_ref)) {
      reject('image does not belong to its proposed option');
    }
  }
  return { schema_version: 1, status: 'layout_proposal_checked', product_id: evidence.product_id, url: evidence.url,
    evidence_id: proposal.evidence_id, observed_at: evidence.observed_at, fields,
    missing_field_kinds: Object.keys(FIELDS).filter(kind => !fields.some(field => field.field === kind)),
    source_binding_verified: true, field_interpretation_verified: false, live_rechecked: false,
    full_coverage_verified: false, snapshot_updated: false, additional_reads_authorized: false,
    sku_id: null, sku_price_binding_verified: false, eligibility_verified: false };
}
