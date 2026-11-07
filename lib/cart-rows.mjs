import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { parseCartUrl, cartTargetScript, validateCartTarget } from './cart-target.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, throwPageError, responseText } from './page-dom.mjs';
import { normalizeListEmptyEvidence } from './list-empty-state.mjs';
import { CART_AVAILABILITY_RULES, normalizeCartAvailability, cartAvailabilitySummary } from './cart-availability.mjs';

function collectCartRows(identity, dom, productUrl, plan = null, rowIdentity = null, withAvailability = false) {
  if (identity.state !== 'observed') return identity;
  const gate = dom.gate(null, { readOnly: true });
  if (gate) return { state: gate };
  if (!document.body || document.readyState === 'loading') return { state: 'loading' };
  const roots = dom.all(document, '.trade-main-cart-content');
  if (roots.length !== 1) return { state: 'structure_changed' };
  const root = roots[0];
  const rows = dom.all(root, '.trade-cart-item-info');
  if (!rows.length || rows.length > 2000) return { state: 'structure_changed' };
  if (plan && plan.loaded_rows_seen !== null && rows.length !== plan.loaded_rows_seen) return { state: 'cart_rows_changed' };
  const local = (row, query) => dom.all(row, query).filter(node => node.closest('.trade-cart-item-info') === row);
  const region = (row, query) => {
    const candidates = local(row, query);
    return candidates.length === 1 ? candidates[0] : null;
  };
  const text = (node, limit) => node ? { text: dom.text(node, limit), truncated: (node.innerText ?? '').trim().length > limit } : null;
  const classes = node => (node.getAttribute('class') ?? '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 300);
  // Style markers are class-name prefixes on the region or inside it; hashed suffixes change between builds.
  const marked = (node, prefix) => node ? [node, ...node.querySelectorAll('*')].some(child =>
    (child.getAttribute('class') ?? '').split(/\s+/).some(name => name.startsWith(`${prefix}--`))) : null;
  const notices = (row, container, prefix, limit) => {
    if (!container) return null;
    const found = local(row, dom.selector(prefix)).filter(node => container.contains(node));
    return { items: found.slice(0, 5).map(node => text(node, limit)), truncated: found.length > 5 };
  };
  const items = [];
  const start = plan?.start ?? 1, limit = plan?.limit ?? 5;
  const prefix = [];
  for (const [index, row] of rows.slice(0, start - 1 + limit).entries()) {
    const shop = row.closest('.trade-cart-shop-container');
    if (!shop || !root.contains(shop) || row.parentElement !== shop) return { state: 'structure_changed' };
    const shopHeaders = dom.all(shop, '.trade-cart-shop-info').filter(node => node.parentElement === shop);
    const detail = region(row, '.trade-cart-item-detail');
    const links = detail ? local(row, 'a[href]').filter(anchor => detail.contains(anchor)).flatMap(anchor => {
      let target;
      try { target = productUrl(new URL(anchor.getAttribute('href'), location.href).href); } catch { return []; }
      return target ? [{ product_id: target.product_id, url: target.url, title: text(anchor, 500) }] : [];
    }) : [];
    const priceQuantity = region(row, '.trade-cart-item-p-q-container');
    const quantityRegion = priceQuantity ? region(row, '.trade-cart-item-quantity') : null;
    const quantityInputs = quantityRegion && priceQuantity.contains(quantityRegion) ? local(row, 'input').filter(node => quantityRegion.contains(node) &&
      ['text', 'number'].includes(node.type)).slice(0, 10).map(node => ({ type: node.type,
        value: String(node.value ?? '').slice(0, 64), disabled: node.disabled === true })) : [];
    const quantityDisplays = quantityRegion && priceQuantity.contains(quantityRegion)
      ? local(row, dom.selector('quantityNumWrapper')).filter(node => quantityRegion.contains(node)) : [];
    const quantityDisplay = quantityDisplays.length === 1 ? text(quantityDisplays[0], 64) : null;
    const specificationRegion = region(row, '.trade-cart-item-sku-old');
    const identityFields = { position: index + 1, links,
      shop_region: shopHeaders.length === 1 ? text(shopHeaders[0], 500) : null,
      specification: text(specificationRegion, 1000), quantity_inputs: quantityInputs,
      quantity_display: quantityDisplay, quantity_ambiguous: quantityDisplays.length > 1 || quantityInputs.length > 1 ||
        (quantityDisplays.length > 0 && quantityInputs.length > 0) };
    if (index < start - 1) {
      const observed = rowIdentity(identityFields);
      if (observed === null || Object.keys(observed).some(key => observed[key] !== plan.guards[index][key])) return { state: 'cart_rows_changed' };
      prefix.push(observed);
      continue;
    }
    const priceRegion = priceQuantity ? region(row, '.trade-cart-item-price') : null;
    const priceContainers = priceRegion && priceQuantity.contains(priceRegion) ? dom.all(priceRegion, '.trade-price-container') : [];
    const priceObservations = priceContainers.slice(0, 10).map(container => {
      const labels = dom.all(container, '.trade-price-label');
      return { ...text(container, 500), label: labels.length === 1 ? text(labels[0], 100) : null };
    });
    const priceNodes = priceQuantity ? [priceQuantity, ...dom.all(priceQuantity, '*')] : [];
    const nodes = priceNodes.slice(0, 80).map((node, position) => ({ position: position + 1, tag: node.tagName.toUpperCase(),
      classes: classes(node), direct_text: [...node.childNodes].filter(child => child.nodeType === 3)
        .map(child => child.nodeValue ?? '').join('').trim().slice(0, 300) }));
    // Checkbox values can carry cart IDs, so only the disabled state is read.
    const checkboxes = withAvailability ? local(row, 'input').filter(node => node.type === 'checkbox') : [];
    const availability = withAvailability ? { image_texts: notices(row, region(row, '.trade-cart-item-image'), 'imageTxt', 100),
      messages: notices(row, detail, 'msgWrapper', 200),
      checkboxes: { items: checkboxes.slice(0, 5).map(node => ({ disabled: node.disabled === true })), truncated: checkboxes.length > 5 },
      specification_invalid: marked(specificationRegion, 'invalid'),
      price_invalid: priceRegion && priceQuantity.contains(priceRegion) ? marked(priceRegion, 'priceInvalid') : null,
      quantity_disabled: quantityRegion && priceQuantity.contains(quantityRegion) ? marked(quantityRegion, 'quantityNumDisabled') : null } : null;
    items.push({ ...identityFields,
      price_observations: priceObservations, price_observations_truncated: priceContainers.length > 10,
      price_quantity: priceQuantity ? { ...text(priceQuantity, 2000), nodes, nodes_truncated: priceNodes.length > 80 } : null,
      status_region: text(region(row, '.trade-cart-item-status'), 500), ...(availability ? { availability } : {}) });
  }
  return { state: 'observed', url: identity.url, observed_at: new Date().toISOString(),
    source: 'trade_cart_item_info_dom', loaded_rows_seen: rows.length, rows: items,
    ...(plan ? { start, limit, prefix } : {}) };
}

/**
 * Build a fixed read of at most five loaded rows in the observed Taobao cart layout.
 * @param {{url:string}} target Canonical cart identity.
 * @param {{availability?:boolean}} [options] false reproduces the pre-availability row shape (schema 1).
 * @returns {string} Address-guarded DOM expression; never clicks, scrolls or reads account fields.
 * @throws {ShoppingError} INVALID_TARGET before browser access.
 * @example cartRowsScript({url:'https://cart.taobao.com/cart.htm'});
 */
export function cartRowsScript(target, { availability = true } = {}) {
  const productParser = `(() => {const PRODUCT_HOSTS = new Set(['item.taobao.com','detail.tmall.com']); return ${parseProductUrl.toString()};})()`;
  return `(${collectCartRows.toString()})(${cartTargetScript(target)}, (${pageDom.toString()})(), ${productParser}, null, null, ${availability === true})`;
}

/**
 * @param {{url:string}} target Canonical cart identity. @param {object} plan Range and observed-value guards.
 * @param {{availability?:boolean}} [options] false continues a collection started before availability signals (schema 2 batches).
 * @returns {string} Fixed batch expression without actions or account reads.
 * @throws {ShoppingError} INVALID_TARGET or INVALID_ARGUMENTS before browser access.
 * @example cartBatchScript(target, {start:1,limit:5,loaded_rows_seen:null,guards:[]});
 */
export function cartBatchScript(target, plan, { availability = true } = {}) {
  validateCartBatchPlan(plan);
  const productParser = `(() => {const PRODUCT_HOSTS = new Set(['item.taobao.com','detail.tmall.com']); return ${parseProductUrl.toString()};})()`;
  return `(${collectCartRows.toString()})(${cartTargetScript(target)}, (${pageDom.toString()})(), ${productParser}, ${JSON.stringify(plan)}, ${cartRowIdentity.toString()}, ${availability === true})`;
}

// Compare bounded observed values, never claim that a DOM position is a persistent platform row ID.
function cartRowIdentity(row) {
  const clean = value => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  const title = row.links.length === 1 ? row.links[0] : null;
  const shop = row.shop_region, specification = row.specification;
  const input = row.quantity_inputs.length === 1 && row.quantity_display === null ? row.quantity_inputs[0].value : null;
  const display = row.quantity_inputs.length === 0 && row.quantity_display && !row.quantity_display.truncated ? row.quantity_display.text : null;
  const quantity = row.quantity_ambiguous ? null : input ?? display;
  if (!title?.title || title.title.truncated || !clean(title.title.text) || !shop || shop.truncated || !clean(shop.text) ||
      !specification || specification.truncated || quantity === null || !/^[1-9][0-9]{0,8}$/.test(clean(quantity))) return null;
  return { position: row.position, product_id: title.product_id, url: title.url, title: clean(title.title.text),
    shop_region: clean(shop.text), specification: clean(specification.text), quantity: Number(clean(quantity)) };
}

/** @param {object} row Validated row. @returns {object|null} Observed-value guard, or null for insufficient fields. @example cartRowGuard(snapshot.rows[0]); */
export function cartRowGuard(row) { return cartRowIdentity(savedRowSource(row)); }

/** @param {unknown} plan Range and guards. @returns {object} Validated bounded plan. @throws {ShoppingError} INVALID_ARGUMENTS before IO. @example validateCartBatchPlan(plan); */
export function validateCartBatchPlan(plan) {
  const bad = () => { throw new ShoppingError('INVALID_ARGUMENTS', 'Use a bounded cart range and unchanged preceding row guards.'); };
  if (!plan || Object.keys(plan).sort().join(',') !== 'guards,limit,loaded_rows_seen,start' ||
      !Number.isSafeInteger(plan.start) || plan.start < 1 || plan.start > 50 ||
      !Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 5 || plan.start + plan.limit - 1 > 50 ||
      !Array.isArray(plan.guards) || plan.guards.length !== plan.start - 1 ||
      (plan.start === 1 ? plan.loaded_rows_seen !== null : !Number.isSafeInteger(plan.loaded_rows_seen) ||
        plan.loaded_rows_seen < plan.start || plan.loaded_rows_seen > 2000)) bad();
  for (const [index, guard] of plan.guards.entries()) {
    if (!guard || Object.keys(guard).sort().join(',') !== 'position,product_id,quantity,shop_region,specification,title,url' ||
        guard.position !== index + 1 || typeof guard.product_id !== 'string' || parseProductUrl(guard.url)?.product_id !== guard.product_id ||
        parseProductUrl(guard.url)?.url !== guard.url || !Number.isSafeInteger(guard.quantity) || guard.quantity < 1 || guard.quantity > 999999999 ||
        !['title', 'shop_region', 'specification'].every(key => typeof guard[key] === 'string' &&
          guard[key].length <= (key === 'specification' ? 1000 : 500) && guard[key] === guard[key].trim() &&
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(guard[key])) || !guard.title || !guard.shop_region) bad();
  }
  return plan;
}

const invalid = () => { throw new ShoppingError('INVALID_RESPONSE', 'The cart returned invalid bounded row evidence.'); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
}
function textRegion(value, limit) {
  if (value === null) return null;
  exact(value, ['text', 'truncated']);
  if (typeof value.truncated !== 'boolean') invalid();
  if (typeof value.text !== 'string' || value.text.length > limit) invalid();
  return { text: value.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim(), truncated: value.truncated };
}
function priceQuantityRegion(value) {
  if (value === null) return null;
  exact(value, ['text', 'truncated', 'nodes', 'nodes_truncated']);
  if (typeof value.nodes_truncated !== 'boolean' || !Array.isArray(value.nodes) || value.nodes.length > 80) invalid();
  return { ...textRegion({text:value.text,truncated:value.truncated}, 2000),
    nodes_truncated: value.nodes_truncated, nodes: value.nodes.map((node, index) => {
      exact(node, ['position', 'tag', 'classes', 'direct_text']);
      if (node.position !== index + 1 || typeof node.tag !== 'string' || !/^[A-Z][A-Z0-9-]{0,30}$/.test(node.tag)) invalid();
      return { position: node.position, tag: node.tag, classes: responseText(node.classes, 300),
        direct_text: responseText(node.direct_text, 300) };
    }) };
}
function normalizeRow(row, index, availabilityRules) {
  exact(row, ['position', 'links', 'shop_region', 'specification', 'quantity_inputs', 'quantity_display', 'quantity_ambiguous',
    'price_observations', 'price_observations_truncated', 'price_quantity', 'status_region', ...(availabilityRules ? ['availability'] : [])]);
  if (row.position !== index + 1 || !Array.isArray(row.links) || row.links.length > 20 ||
      !Array.isArray(row.quantity_inputs) || row.quantity_inputs.length > 10 || !Array.isArray(row.price_observations) ||
      row.price_observations.length > 10 || typeof row.price_observations_truncated !== 'boolean' ||
      typeof row.quantity_ambiguous !== 'boolean') invalid();
  const links = row.links.map(link => {
    exact(link, ['product_id', 'url', 'title']);
    const target = parseProductUrl(link.url);
    if (!target || target.url !== link.url || target.product_id !== link.product_id) invalid();
    return { ...target, title: textRegion(link.title, 500) };
  });
  const inputs = row.quantity_inputs.map(input => {
    exact(input, ['type', 'value', 'disabled']);
    if (!['text', 'number'].includes(input.type) || typeof input.disabled !== 'boolean') invalid();
    return { type: input.type, value: responseText(input.value, 64), disabled: input.disabled };
  });
  const titleLink = links.length === 1 && links[0].title && !links[0].title.truncated && links[0].title.text ? links[0] : null;
  const display = textRegion(row.quantity_display, 64);
  const quantityRaw = row.quantity_ambiguous ? null : inputs.length === 1 && display === null ? inputs[0].value
    : inputs.length === 0 && display && !display.truncated ? display.text : null;
  const quantity = quantityRaw && /^[1-9][0-9]{0,8}$/.test(quantityRaw) ? Number(quantityRaw) : null;
  const priceObservations = row.price_observations.map(item => {
    exact(item, ['text', 'truncated', 'label']);
    return { ...textRegion({text:item.text,truncated:item.truncated}, 500), label: textRegion(item.label, 100),
      kind: 'unverified', source: 'same_row_price_container' };
  });
  return { position: row.position, row_id: null, product_id: titleLink?.product_id ?? null,
    url: titleLink?.url ?? null, title: titleLink?.title.text ?? null,
    shop_region: textRegion(row.shop_region, 500), specification: textRegion(row.specification, 1000),
    quantity: { value: quantity, inputs, display, ambiguous: row.quantity_ambiguous,
      source: inputs.length === 1 && display === null ? 'same_row_quantity_input'
        : inputs.length === 0 && display !== null ? 'same_row_quantity_display' : 'same_row_quantity_unverified', verified: quantity !== null },
    price_region_observations: { items: priceObservations, truncated: row.price_observations_truncated,
      unit_price_verified: false, row_amount_verified: false, payment_verified: false },
    price_quantity_region: priceQuantityRegion(row.price_quantity), status_region: textRegion(row.status_region, 500),
    ...(availabilityRules ? { availability: normalizeCartAvailability(row.availability, { rules: availabilityRules }) } : {}),
    association: { sku_id: null, sku_binding_verified: false, display_price_kind_verified: false, payment_verified: false },
    missing: [...(!titleLink ? ['unique_product_title_link'] : []), ...(quantity === null ? ['quantity'] : []),
      ...(row.shop_region === null ? ['shop_region'] : []), ...(row.specification === null ? ['specification_region'] : []),
      ...(row.price_quantity === null ? ['price_quantity_region'] : [])] };
}

/**
 * Validate loaded row evidence without deduplicating products or inferring SKU, totals or payment.
 * @param {unknown} value Fixed collector response. @param {{url:string}} target Expected cart identity.
 * @param {{availability?:boolean, availabilityRules?:1|2}} [options] `availability` must match the collector option; rows then carry
 * an availability status (schema 4) classified by `availabilityRules`, which defaults to the current rule.
 * @returns {object} Local-only partial snapshot; explicit empty evidence covers only the current list view.
 * @throws {ShoppingError} Known page gates, INVALID_TARGET or INVALID_RESPONSE.
 * @example validateCartRows(raw, {url:'https://cart.taobao.com/cart.htm'});
 */
export function validateCartRows(value, target, options = {}) { return normalizeCartSnapshot(value, target, null, rulesFromOptions(options)); }

/**
 * @param {unknown} value Collector response. @param {{url:string}} target Saved identity. @param {object} plan Reserved range.
 * @param {{availability?:boolean, availabilityRules?:1|2}} [options] As for validateCartRows (schema 5 with availability, 2 without).
 * @returns {object} Partial batch snapshot with global positions and bounded prefix confirmation.
 * @throws {ShoppingError} Page gates, CART_ROWS_CHANGED, invalid plan, target or response.
 * @example validateCartBatch(raw, target, plan);
 */
export function validateCartBatch(value, target, plan, options = {}) {
  validateCartBatchPlan(plan);
  if (value?.state === 'cart_rows_changed') throw new ShoppingError('CART_ROWS_CHANGED', 'The loaded count or preceding cart row values changed. Saved batches were retained.');
  return normalizeCartSnapshot(value, target, plan, rulesFromOptions(options));
}

function rulesFromOptions({ availability = true, availabilityRules: rules = CART_AVAILABILITY_RULES } = {}) {
  return availability === true ? rules : null;
}

// Snapshot versions: 1 rows, 2 batch, 3 empty view, 4 rows with availability, 5 batch with availability.
function snapshotVersion(empty, plan, availability) { return empty ? 3 : (plan ? 2 : 1) + (availability ? 3 : 0); }

function normalizeCartSnapshot(value, target, plan, availabilityRules) {
  const expected = parseCartUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'The observed Taobao HTTPS cart route is required.');
  throwPageError(value?.state);
  const empty = value?.state === 'observed_empty';
  exact(value, ['state', 'url', 'observed_at', 'source', 'loaded_rows_seen', 'rows',
    ...(empty ? ['empty_evidence'] : []), ...(plan ? ['start', 'limit', 'prefix'] : [])]);
  validateCartTarget({state:empty ? 'observed' : value.state,url:value.url}, expected);
  if (value.source !== 'trade_cart_item_info_dom' || typeof value.observed_at !== 'string' ||
      !Number.isFinite(Date.parse(value.observed_at)) || !Number.isSafeInteger(value.loaded_rows_seen) ||
      value.loaded_rows_seen < 0 || value.loaded_rows_seen > 2000 || !Array.isArray(value.rows)) invalid();
  const emptyEvidence = empty ? normalizeListEmptyEvidence(value.empty_evidence) : null;
  if (empty ? value.loaded_rows_seen !== 0 || value.rows.length !== 0
    : value.rows.length !== Math.min(plan?.limit ?? 5, value.loaded_rows_seen - (plan?.start ?? 1) + 1) || !value.rows.length) invalid();
  if (plan) {
    if (value.start !== plan.start || value.limit !== plan.limit || !isDeepStrictEqual(value.prefix, plan.guards)) invalid();
    if (empty && (plan.start !== 1 || plan.loaded_rows_seen !== null || plan.guards.length)) {
      throw new ShoppingError('CART_ROWS_CHANGED', 'The cart became empty after preceding rows were observed. Saved batches were retained.');
    }
    if (plan.loaded_rows_seen !== null && value.loaded_rows_seen !== plan.loaded_rows_seen) invalid();
  }
  const rows = value.rows.map((row, index) => normalizeRow(row, index + (plan?.start ?? 1) - 1, availabilityRules));
  return { schema_version: snapshotVersion(empty, plan, availabilityRules !== null), url: expected.url, observed_at: value.observed_at, source: value.source,
    ...(empty ? {empty_evidence:emptyEvidence} : {}),
    ...(plan ? { range: { start: plan.start, limit: plan.limit }, prefix_guard: { positions_checked: plan.guards.length,
      observed_values_match: true, physical_row_identity_verified: false } } : {}),
    rows, ...(availabilityRules && !empty ? { availability_summary: cartAvailabilitySummary(rows) } : {}),
    coverage: { status: 'partial', loaded_rows_seen: value.loaded_rows_seen,
      returned_rows: value.rows.length, rows_omitted: value.loaded_rows_seen - value.rows.length,
      page_total_rows: null, full_cart: false, empty_cart_verified: empty, account_identity_verified: false,
      row_id_verified: false, shop_name_verified: false, display_price_kind_verified: false, payment_verified: false },
    privacy: { local_only: true, account_fields_read: false }, limits: { row_positions: 5, price_quantity_nodes_per_row: 80 } };
}

function savedRowSource(row) {
  return { position: row.position,
    links: row.product_id === null ? [] : [{ product_id: row.product_id, url: row.url, title: { text: row.title, truncated: false } }],
    shop_region: row.shop_region, specification: row.specification,
    quantity_inputs: row.quantity.inputs, quantity_display: row.quantity.display, quantity_ambiguous: row.quantity.ambiguous,
    price_observations: row.price_region_observations.items.map(item => ({ text: item.text, truncated: item.truncated, label: item.label })),
    price_observations_truncated: row.price_region_observations.truncated,
    price_quantity: row.price_quantity_region, status_region: row.status_region,
    ...(row.availability === undefined ? {} : { availability: row.availability?.signals }) };
}

/**
 * Revalidate a saved cart snapshot, including its derived quantities and coverage.
 * @param {unknown} value Normalized snapshot. @param {{url:string}} target Saved cart identity.
 * @returns {object} The unchanged validated snapshot.
 * @throws {ShoppingError} INVALID_CHECKPOINT; does not upgrade older private research results.
 * @example validateSavedCartRows(snapshot, {url:'https://cart.taobao.com/cart.htm'});
 */
export function validateSavedCartRows(value, target) { return validateSavedSnapshot(value, target); }

/**
 * @param {unknown} value Saved snapshot. @param {{url:string}} target Saved identity. @param {object} plan Derived continuation.
 * @returns {object} The unchanged revalidated batch; never upgrades v1 snapshots.
 * @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateSavedCartBatch(snapshot, target, plan);
 */
export function validateSavedCartBatch(value, target, plan) { return validateSavedSnapshot(value, target, plan); }

function validateSavedSnapshot(value, target, plan = null) {
  try {
    const empty = value?.schema_version === 3, availability = [4, 5].includes(value?.schema_version);
    if (!Array.isArray(value?.rows) || !empty && value.rows.length < 1 || value.rows.length > 5) invalid();
    const raw = { state: empty ? 'observed_empty' : 'observed', url: value.url, observed_at: value.observed_at, source: value.source,
      ...(empty ? {empty_evidence:value.empty_evidence} : {}),
      loaded_rows_seen: value.coverage?.loaded_rows_seen, rows: value.rows.map(savedRowSource),
      ...(plan ? { start: plan.start, limit: plan.limit, prefix: plan.guards } : {}) };
    // Rows saved before rule 2 carry no classification_version; recomputing with another rule would fail the comparison.
    const options = { availability, availabilityRules: availability ? value.rows[0]?.availability?.classification_version ?? 1 : undefined };
    if (!isDeepStrictEqual(plan ? validateCartBatch(raw, target, plan, options) : validateCartRows(raw, target, options), value)) invalid();
    return value;
  } catch {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The saved cart snapshot is invalid or incompatible.');
  }
}
