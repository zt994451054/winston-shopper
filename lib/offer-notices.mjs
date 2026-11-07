import { ShoppingError } from './errors.mjs';
import { responseText } from './page-dom.mjs';

/**
 * Read bounded quantity-area and dispatch labels from their observed product regions.
 * @param {object} dom Page-local visible DOM helpers.
 * @returns {object} Raw purchase and dispatch notices; no address, quantity input or interaction.
 * @throws {Error} Ambiguous regions or a notice containing address controls.
 * @example collectOfferNotices(pageDom());
 */
export function collectOfferNotices(dom) {
  const read = (regionPrefix, labelPrefix) => {
    const roots = dom.all(document, dom.selector(regionPrefix));
    if (roots.length > 1) throw new Error('Ambiguous offer notice region');
    const nodes = roots.length ? dom.all(roots[0], dom.selector(labelPrefix)) : [];
    const labels = nodes.slice(0, 5).map(node => {
      if (node.closest(dom.selector('deliveryAddrWrap')) ||
          dom.all(node, `${dom.selector('deliveryAddrWrap')}, input, textarea`).length) {
        throw new Error('Offer notice contains an address or input control');
      }
      const text = dom.text(node, 201);
      return { text: text.slice(0, 200), text_truncated: text.length > 200 };
    });
    return { schema_version: 1, observed: roots.length === 1, labels_seen: nodes.length, labels };
  };
  return { purchase: read('skuWrapper', 'quantityTip'), dispatch: read('DomesticDelivery', 'shipping') };
}

/**
 * Validate raw or saved notices without interpreting stock, limits or delivery promises.
 * @param {unknown} value Notice collection. @param {'purchase'|'dispatch'} kind Supported source region.
 * @returns {object} Canonical raw-text labels with coverage and explicitly unknown guarantees.
 * @throws {ShoppingError} INVALID_RESPONSE for unsupported sources, bounds or contradictory claims.
 * @example normalizeOfferNotices(raw, 'purchase');
 */
export function normalizeOfferNotices(value, kind) {
  const invalid = () => new ShoppingError('INVALID_RESPONSE', 'Invalid product purchase or dispatch notices.');
  if (!['purchase', 'dispatch'].includes(kind)) throw invalid();
  const metadata = kind === 'purchase'
    ? { source: 'sku_quantity_tip', stock_quantity: null, purchase_limit: null, sku_id: null, availability_verified: false }
    : { source: 'delivery_shipping_label', address_read: false, arrival_time: null, conditions_verified: false };
  const allowed = new Set(['schema_version', 'observed', 'labels_seen', 'labels', 'labels_returned', 'labels_omitted', 'limits', ...Object.keys(metadata)]);
  if (!value || Object.keys(value).some(key => !allowed.has(key)) || value.schema_version !== 1 ||
      typeof value.observed !== 'boolean' || !Number.isSafeInteger(value.labels_seen) || value.labels_seen < 0 || value.labels_seen > 10000 ||
      !Array.isArray(value.labels) || value.labels.length !== Math.min(value.labels_seen, 5) || (!value.observed && value.labels_seen)) throw invalid();
  const labels = value.labels.map(label => {
    if (!label || Object.keys(label).sort().join(',') !== 'text,text_truncated' || typeof label.text_truncated !== 'boolean') throw invalid();
    const text = responseText(label.text, 200);
    if (!text) throw invalid();
    return { text, text_truncated: label.text_truncated };
  });
  const counts = { labels_returned: labels.length, labels_omitted: value.labels_seen - labels.length };
  const limits = { labels: 5, label_characters: 200 };
  for (const [key, expected] of Object.entries({ ...metadata, ...counts })) {
    if (value[key] !== undefined && value[key] !== expected) throw invalid();
  }
  if (value.limits !== undefined && (!value.limits || Object.keys(value.limits).sort().join(',') !== 'label_characters,labels' ||
      value.limits.labels !== 5 || value.limits.label_characters !== 200)) throw invalid();
  return { schema_version: 1, observed: value.observed, labels_seen: value.labels_seen, ...counts, labels, ...metadata, limits };
}
