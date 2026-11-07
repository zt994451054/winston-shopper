import { ShoppingError } from './errors.mjs';
import { responseText } from './page-dom.mjs';

/**
 * Collect the observed public service popover only when its expanded entry and ordered labels agree.
 * @param {Element|null} entry Product GuaranteeInfo region. @param {object} dom Visible DOM helpers.
 * @returns {object} Bounded loaded summaries; no clicks, linked rules or entitlement verification.
 * @throws {Error} Ambiguous or unrelated visible service content.
 * @example collectServiceTerms(entry, pageDom());
 */
export function collectServiceTerms(entry, dom) {
  const panels = dom.all(document, dom.selector('moreGuaranteeListWrap'));
  const expanded = entry ? dom.all(entry, dom.selector('isExpend')) : [];
  if (panels.length > 1 || expanded.length > 1) throw new Error('Ambiguous service expansion');
  const empty = { schema_version: 1, panel_observed: false, entry_expanded: expanded.length === 1, items_seen: 0, items: [] };
  if (!panels.length) return empty;
  if (!entry || expanded.length !== 1) throw new Error('Service panel has no expanded product entry');
  const labels = dom.all(entry, dom.selector('guaranteeText')).map(node => dom.text(node, 201));
  const rows = dom.all(panels[0], dom.selector('GuaranteeItem'));
  if (!rows.length || rows.length !== labels.length || rows.length > 20 || new Set(labels).size !== labels.length) {
    throw new Error('Service panel does not match product labels');
  }
  const items = rows.map((row, index) => {
    const headers = dom.all(row, dom.selector('header')), bodies = dom.all(row, dom.selector('subItem'));
    if (headers.length !== 1 || bodies.length !== 1) throw new Error('Ambiguous service summary');
    const header = (headers[0].innerText ?? '').trim();
    const parts = header.split(/\r?\n/).map(part => part.trim()).filter(Boolean);
    if (header.length > 400 || parts[0] !== labels[index] || parts.slice(1).some(part => !['更多', '查看'].includes(part))) {
      throw new Error('Service header does not match its label');
    }
    const body = bodies[0], style = getComputedStyle(body), text = (body.innerText ?? '').trim();
    const clipped = (['hidden', 'clip'].includes(style.overflowY ?? style.overflow) && body.scrollHeight > body.clientHeight + 1) ||
      (['hidden', 'clip'].includes(style.overflowX ?? style.overflow) && body.scrollWidth > body.clientWidth + 1);
    return { label: labels[index], header_text: header, body_text: clipped ? '' : text.slice(0, 2000),
      body_truncated: !clipped && text.length > 2000, body_clipped: clipped, additional_entry_labels: parts.slice(1) };
  });
  return { schema_version: 1, panel_observed: true, entry_expanded: true, items_seen: rows.length, items };
}

/**
 * Validate optional service summaries without claiming complete linked rules or user eligibility.
 * @param {unknown} value Raw or previously normalized service observation.
 * @param {string[]} labels Ordered service labels from the same product observation.
 * @returns {object} Canonical service summary observation.
 * @throws {ShoppingError} INVALID_RESPONSE for contradictory or unsupported data.
 * @example normalizeServiceTerms(raw, ['7天无理由退货']);
 */
export function normalizeServiceTerms(value, labels) {
  const invalid = () => new ShoppingError('INVALID_RESPONSE', 'Invalid loaded service summary observation.');
  if (!value || value.schema_version !== 1 || typeof value.panel_observed !== 'boolean' || typeof value.entry_expanded !== 'boolean' ||
      !Number.isSafeInteger(value.items_seen) || value.items_seen < 0 || value.items_seen > 20 ||
      !Array.isArray(value.items) || value.items.length !== value.items_seen ||
      (value.panel_observed ? !value.entry_expanded || value.items.length !== labels.length || !value.items.length : value.items.length !== 0)) throw invalid();
  const items = value.items.map((item, index) => {
    const label = responseText(item?.label, 200), header = responseText(item?.header_text, 400), text = responseText(item?.body_text, 2000);
    if (label !== labels[index] || typeof item.body_truncated !== 'boolean' || typeof item.body_clipped !== 'boolean' ||
        (item.body_clipped && (text || item.body_truncated)) || (!item.body_clipped && !text) ||
        !Array.isArray(item.additional_entry_labels) || item.additional_entry_labels.length > 2 ||
        item.additional_entry_labels.some(entry => !['更多', '查看'].includes(entry)) ||
        header !== [label, ...item.additional_entry_labels].join(' ')) throw invalid();
    return { label, header_text: header, body_text: text, body_truncated: item.body_truncated,
      body_clipped: item.body_clipped, additional_entry_labels: [...item.additional_entry_labels] };
  });
  return { schema_version: 1, panel_observed: value.panel_observed, entry_expanded: value.entry_expanded,
    items_seen: value.items_seen, items_returned: items.length, items,
    association_basis: value.panel_observed ? 'expanded_entry_and_matching_labels' : null,
    full_terms_verified: false, eligibility_verified: false };
}
