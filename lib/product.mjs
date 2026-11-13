import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';
import { withLayoutEvidence, validateLayoutEvidence } from './layout-evidence.mjs';

// This function is serialized into the page; it must not close over Node state.
function collectProduct(expected, choice = null) {
  const current = new URL(location.href);
  if (current.origin !== expected.origin || current.pathname !== expected.pathname ||
      current.searchParams.getAll('id').length !== 1 || current.searchParams.get('id') !== expected.product_id) {
    return { state: 'target_changed' };
  }
  const selector = prefix => `[class^="${prefix}--"], [class*=" ${prefix}--"]`;
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const all = (root, query) => [...root.querySelectorAll(query)].filter(visible);
  const text = (node, max) => (node?.innerText ?? '').trim().slice(0, max);
  const one = (root, prefix) => all(root, selector(prefix))[0];
  const frames = all(document, 'iframe').map(frame => {
    try { const url = new URL(frame.getAttribute('src'), location.href); return `${url.hostname}${url.pathname}`; }
    catch { return ''; }
  });
  const verification = all(document, '#nc_1_wrapper, #baxia-dialog-content, #baxia-dialog, [id^="aliyunCaptcha"], [id^="nc_1_n1z"]');
  const dialogs = all(document, '[role="dialog"], [aria-modal="true"], [class*="loginDialog"], [class*="login-dialog"]');
  const dialogText = dialogs.map(node => text(node, 1500)).join('\n');
  const pageTitle = document.title.slice(0, 300);
  if (verification.length || frames.some(url => /captcha|punish|baxia/.test(url)) || /滑块|验证码|安全验证|drag the slider/i.test(dialogText)) {
    return { state: 'verification_required' };
  }
  // 2026-11-14 live: after three detail pages opened within seconds, Taobao rendered an inline 访问异常提示 in the shop
  // block (not a dialog) and dropped the price, parameter and review regions; it must stop the task like a rate limit.
  if (/访问.{0,4}频繁|请求.{0,4}频繁|稍后再试|too many requests/i.test(dialogText + pageTitle) ||
      /系统检测到当前访问存在异常/.test(document.body?.innerText ?? '')) return { state: 'rate_limited' };
  if (frames.some(url => /^(login\.taobao\.com|login\.tmall\.com)\//.test(url)) || /扫码登录|密码登录|请.{0,4}登录/.test(dialogText)) {
    return { state: 'login_required' };
  }
  if (dialogs.length) return { state: 'blocked_unknown' };
  const titleNodes = all(document, selector('ItemTitle'));
  const skuRoots = all(document, selector('skuWrapper'));
  const priceRoots = all(document, `${selector('normalPrice')}, ${selector('beltPrice')}`);
  const resolveSummaryLayout = () => {
    const panels = all(document, selector('GeneralSkuPanel'));
    const heads = all(document, selector('ItemHeadFixed'));
    if (panels.length !== 1 || heads.length !== 1 || skuRoots.length !== 1 || !panels[0].contains(heads[0])) return null;
    const bodies = all(panels[0], selector('scrollWrap')).filter(node => node.contains(skuRoots[0]));
    if (bodies.length !== 1 || heads[0].contains(bodies[0]) || bodies[0].contains(heads[0])) return null;
    const body = bodies[0], head = heads[0];
    const bodyTitles = titleNodes.filter(node => body.contains(node));
    const headTitles = titleNodes.filter(node => head.contains(node));
    const bodyPrices = priceRoots.filter(node => body.contains(node));
    const headPrices = priceRoots.filter(node => head.contains(node));
    // Only this observed sibling layout identifies an original region and its fixed summary.
    if (bodyTitles.length !== 1 || headTitles.length !== 1 || titleNodes.length !== 2 ||
        bodyPrices.length !== 1 || headPrices.length > 1 || priceRoots.length !== 1 + headPrices.length) return null;
    return { titles: bodyTitles, prices: bodyPrices,
      scope: { schema_version: 1, source: 'scrolling_purchase_panel', excluded_region: 'ItemHeadFixed',
        title_regions_seen: titleNodes.length, price_regions_seen: priceRoots.length,
        excluded_title_regions: headTitles.length, excluded_price_regions: headPrices.length } };
  };
  const layout = titleNodes.length > 1 || priceRoots.length > 1 ? resolveSummaryLayout() : null;
  const titles = layout?.titles ?? titleNodes, priceRegions = layout?.prices ?? priceRoots;
  const regionScope = layout?.scope;
  if (titles.length > 1) return { state: 'structure_changed', reason: 'title_ambiguous' };
  const titleNode = titles[0];
  if (!titleNode) {
    if (document.readyState !== 'complete') return { state: 'loading' };
    if (/下架|不存在|失效/.test(pageTitle)) return { state: 'product_unavailable' };
    return { state: 'structure_changed', reason: 'title_missing' };
  }
  if (skuRoots.length > 1) return { state: 'structure_changed', reason: 'specification_region_ambiguous' };
  const skuRoot = skuRoots[0];
  const groupNodes = skuRoot ? all(skuRoot, selector('skuItem')) : [];
  const optionNodes = groupNodes.slice(0, 8).map(group => all(group, selector('valueItem')));
  const groups = groupNodes.slice(0, 8).map((group, index) => ({
    name: text(one(group, 'ItemLabel'), 120),
    options: optionNodes[index].slice(0, 100).map(option => ({
      label: text(one(option, 'valueItemText'), 200),
      selected: option.getAttribute('aria-selected') === 'true' || /(?:^|\s)isSelected--/.test(option.className) ? true : null,
      disabled: option.getAttribute('aria-disabled') === 'true' || option.getAttribute('data-disabled') === 'true' || /(?:^|\s)isDisabled--/.test(option.className) ? true : null,
    })),
  }));
  const specificationCounts = { region_observed: Boolean(skuRoot), groups_seen: groupNodes.length,
    options_seen: optionNodes.map(nodes => nodes.length) };
  if (choice) {
    // A partial option list cannot rule out conflicting states elsewhere in the same selection region.
    if (groupNodes.length > 8 || optionNodes.some(nodes => nodes.length > 100)) return { state: 'selection_ambiguous' };
    if (groups.some(group => group.options.filter(option => option.selected === true).length > 1)) {
      return { state: 'selection_state_conflict' };
    }
    const matchingGroups = groupNodes.filter(group => text(one(group, 'ItemLabel'), 120) === choice.group);
    if (matchingGroups.length !== 1) return { state: 'selection_ambiguous' };
    const options = all(matchingGroups[0], selector('valueItem')).filter(option => text(one(option, 'valueItemText'), 200) === choice.option);
    if (options.length !== 1 || !['DIV', 'BUTTON'].includes(options[0].tagName)) return { state: 'selection_ambiguous' };
    const option = options[0];
    if (option.getAttribute('aria-disabled') === 'true' || option.getAttribute('data-disabled') === 'true' || /(?:^|\s)isDisabled--/.test(option.className)) {
      return { state: 'selection_disabled' };
    }
    const selected = option.getAttribute('aria-selected') === 'true' || /(?:^|\s)isSelected--/.test(option.className);
    if (!selected) option.click();
    return { state: 'selection_dispatched', group: choice.group, option: choice.option, clicked: !selected };
  }
  if (priceRegions.length > 1) return { state: 'structure_changed', reason: 'price_region_ambiguous' };
  const priceRoot = priceRegions[0];
  const prices = priceRoot ? all(priceRoot, `${selector('highlightPrice')}, ${selector('subPrice')}`).slice(0, 6).map(price => ({
    raw: text(price, 400), label: text(one(price, 'title'), 120),
    amount_text: all(price, selector('text')).map(node => text(node, 80)).join(''),
    qualifier: text(one(price, 'desc'), 120),
  })) : [];
  const commentRoot = one(document, 'Comments');
  const reviews = commentRoot ? all(commentRoot, selector('Comment')).slice(0, 5).map(comment => ({
    body: text(one(comment, 'content'), 2000), date_text: text(one(comment, 'meta'), 120),
  })) : [];
  const skuIds = current.searchParams.getAll('skuId');
  const validSkuId = skuIds.length === 1 && /^[1-9][0-9]{0,63}$/.test(skuIds[0]) && skuIds[0] !== expected.product_id;
  const skuUrl = {
    status: !skuIds.length ? 'parameter_absent' : skuIds.length > 1 ? 'ambiguous_parameter'
      : validSkuId ? 'candidate_only' : 'invalid_parameter',
    candidate_sku_id: validSkuId ? skuIds[0] : null,
    sku_properties_present: current.searchParams.has('sku_properties'),
  };
  return { state: 'observed', product_id: expected.product_id, url: expected.url,
    title: text(titleNode, 300).split('\n')[0], groups, prices, reviews, sku_url: skuUrl,
    specification_counts: specificationCounts,
    ...(regionScope ? { product_region_scope: regionScope } : {}) };
}

/**
 * Build a fixed DOM-only read for a previously bound public product page.
 * @param {{url: string}} target @param {{layoutDiagnostics?:boolean}} options New task diagnostics opt-in.
 * @returns {string} Guarded expression.
 * @throws {ShoppingError} INVALID_TARGET.
 * @example productScript(target, { layoutDiagnostics: true })
 */
export function productScript(target, { layoutDiagnostics = false } = {}) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A supported public product target is required.');
  const script = `(${collectProduct.toString()})(${JSON.stringify(expected)})`;
  return layoutDiagnostics ? withLayoutEvidence(script, expected) : script;
}

/**
 * Build one guarded option selection. Never clicks an already selected or disabled option.
 * @param {{url: string}} target @param {{group: string, option: string}} choice
 * @returns {string} Fixed page operation; no arbitrary selector or JavaScript input.
 * @throws {ShoppingError} INVALID_TARGET or INVALID_SELECTION.
 */
export function selectionScript(target, choice) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A supported public product target is required.');
  if (!choice || Object.keys(choice).some(key => !['group', 'option'].includes(key)) ||
      typeof choice.group !== 'string' || !choice.group.trim() || choice.group.length > 120 ||
      typeof choice.option !== 'string' || !choice.option.trim() || choice.option.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(choice.group + choice.option)) {
    throw new ShoppingError('INVALID_SELECTION', 'Select one group and option using their exact visible labels.');
  }
  return `(${collectProduct.toString()})(${JSON.stringify(expected)}, ${JSON.stringify(choice)})`;
}

/**
 * Validate the acknowledgement separately from the later selected-state observation.
 * @param {unknown} value @param {{group: string, option: string}} choice
 * @returns {{clicked: boolean}} Whether the page reports dispatching the click.
 * @throws {ShoppingError} Guard errors are marked actionNotDispatched; other errors are uncertain.
 */
export function validateSelectionAcknowledgement(value, choice) {
  const selectionErrors = { selection_ambiguous: ['SELECTION_AMBIGUOUS', 'The option cannot be uniquely identified.'],
    selection_state_conflict: ['SELECTION_STATE_CONFLICT', 'A specification group reports multiple selected options.'],
    selection_disabled: ['SELECTION_DISABLED', 'The requested option is disabled on the page.'] };
  const guard = Object.hasOwn(PAGE_ERRORS, value?.state) ? PAGE_ERRORS[value.state]
    : Object.hasOwn(selectionErrors, value?.state) ? selectionErrors[value.state] : null;
  if (guard) {
    const error = value.state === 'structure_changed' ? productStructureError(value.reason) : new ShoppingError(...guard);
    error.actionNotDispatched = true;
    throw error;
  }
  if (value?.state !== 'selection_dispatched' || value.group !== choice.group || value.option !== choice.option || typeof value.clicked !== 'boolean') {
    throw new ShoppingError('INVALID_RESPONSE', 'The selection acknowledgement does not match the requested option.');
  }
  return { clicked: value.clicked };
}

/**
 * Parse a displayed decimal price conservatively; preserve ranges and starting prices.
 * @param {string} amountText @param {string} qualifier
 * @returns {{kind: string, amount: string|null, minimum: string|null, maximum: string|null}}
 * @example parseDisplayedPrice('89', '起')
 */
export function parseDisplayedPrice(amountText, qualifier) {
  const clean = amountText.replace(/[￥¥\s]/g, '');
  const decimal = '(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,2})?';
  const range = clean.match(new RegExp(`^(${decimal})[-~～—](${decimal})$`));
  if (range && Number(range[1]) <= Number(range[2]) && !qualifier.includes('起')) {
    return { kind: 'range', amount: null, minimum: range[1], maximum: range[2] };
  }
  if (new RegExp(`^${decimal}$`).test(clean)) {
    return qualifier.includes('起') ? { kind: 'starting_from', amount: null, minimum: clean, maximum: null }
      : { kind: 'single_displayed', amount: clean, minimum: null, maximum: null };
  }
  return { kind: 'unparsed', amount: null, minimum: null, maximum: null };
}

function string(value, max) {
  if (typeof value !== 'string' || value.length > max) throw new ShoppingError('INVALID_RESPONSE', 'The product response contains an invalid text field.');
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}
function array(value, max) {
  if (!Array.isArray(value) || value.length > max) throw new ShoppingError('INVALID_RESPONSE', 'The product response contains an invalid collection.');
  return value;
}
function flag(value) {
  if (value !== true && value !== null) throw new ShoppingError('INVALID_RESPONSE', 'The product response contains an invalid observation flag.');
  return value;
}

function skuEvidence(value, productId) {
  const statuses = ['parameter_absent', 'ambiguous_parameter', 'invalid_parameter', 'candidate_only'];
  if (!value || Object.keys(value).length !== 3 || !statuses.includes(value.status) ||
      typeof value.sku_properties_present !== 'boolean' ||
      (value.status === 'candidate_only'
        ? typeof value.candidate_sku_id !== 'string' || !/^[1-9][0-9]{0,63}$/.test(value.candidate_sku_id) || value.candidate_sku_id === productId
        : value.candidate_sku_id !== null)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The product URL SKU observation is invalid.');
  }
  // A page URL may be stale or user-supplied; co-observation is not a verified binding.
  return { schema_version: 1, source: 'current_product_url', parameter: 'skuId',
    status: value.status, candidate_sku_id: value.candidate_sku_id,
    sku_properties_present: value.sku_properties_present,
    selection_binding_verified: false, sku_price_binding_verified: false };
}

function specificationScope(value, groups) {
  const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The specification counts do not match the observed option lists.');
  const count = number => Number.isSafeInteger(number) && number >= 0;
  if (!value || Object.keys(value).sort().join(',') !== 'groups_seen,options_seen,region_observed' ||
      typeof value.region_observed !== 'boolean' || !count(value.groups_seen) ||
      (!value.region_observed && value.groups_seen !== 0) ||
      !Array.isArray(value.options_seen) || value.options_seen.length !== groups.length ||
      Math.min(value.groups_seen, 8) !== groups.length) throw invalid();
  const scopeGroups = groups.map((group, index) => {
    const seen = value.options_seen[index];
    if (!count(seen) || Math.min(seen, 100) !== group.options.length) throw invalid();
    return { group_index: index + 1, options_seen: seen, options_returned: group.options.length,
      options_omitted: seen - group.options.length };
  });
  return { schema_version: 1, region_observed: value.region_observed, groups_seen: value.groups_seen,
    groups_returned: groups.length, groups_omitted: value.groups_seen - groups.length,
    groups: scopeGroups, full_sku_matrix_verified: false };
}

function productRegionScope(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'excluded_price_regions,excluded_region,excluded_title_regions,price_regions_seen,schema_version,source,title_regions_seen' ||
      value.schema_version !== 1 || value.source !== 'scrolling_purchase_panel' || value.excluded_region !== 'ItemHeadFixed' ||
      value.title_regions_seen !== 2 || value.excluded_title_regions !== 1 || ![0, 1].includes(value.excluded_price_regions) ||
      value.price_regions_seen !== 1 + value.excluded_price_regions) {
    throw new ShoppingError('INVALID_RESPONSE', 'The product region scope does not match the supported purchase panel layout.');
  }
  return { schema_version: 1, source: value.source, excluded_region: value.excluded_region,
    title_regions_seen: value.title_regions_seen, price_regions_seen: value.price_regions_seen,
    excluded_title_regions: value.excluded_title_regions, excluded_price_regions: value.excluded_price_regions };
}

const PAGE_ERRORS = {
  target_changed: ['TARGET_CHANGED', 'The bound page changed during the read.'],
  verification_required: ['VERIFICATION_REQUIRED', 'The page shows a verification gate.'],
  login_required: ['LOGIN_REQUIRED', 'The product read needs user login.'],
  rate_limited: ['RATE_LIMITED', 'The page reports frequent access or a retry-later restriction.'],
  blocked_unknown: ['ACCESS_BLOCKED', 'An unrecognized dialog blocks the product read.'],
  loading: ['PAGE_LOADING', 'The document is still loading.'],
  structure_changed: ['PAGE_STRUCTURE_CHANGED', 'A supported product region is missing or ambiguous.'],
  product_unavailable: ['PRODUCT_UNAVAILABLE', 'The page reports that the product is unavailable.'],
};

const STRUCTURE_REASONS = {
  title_missing: 'The supported product title region is missing.',
  title_ambiguous: 'Multiple visible product title regions were found.',
  title_empty: 'The product title region is empty.',
  specification_region_ambiguous: 'Multiple visible specification regions were found.',
  specification_group_name_empty: 'A specification group name is empty.',
  specification_option_label_empty: 'A specification option label is empty.',
  price_region_ambiguous: 'Multiple visible price regions were found.',
  review_preview_body_empty: 'A review preview body is empty.',
};

/**
 * Accept only fixed product-structure reasons; never persist page text as a reason.
 * @param {unknown} value @returns {boolean} Whether the reason is supported.
 * @example isProductStructureReason('price_region_ambiguous')
 */
export function isProductStructureReason(value) {
  return typeof value === 'string' && Object.hasOwn(STRUCTURE_REASONS, value);
}

function productStructureError(reason) {
  const known = isProductStructureReason(reason);
  const error = new ShoppingError('PAGE_STRUCTURE_CHANGED',
    known ? STRUCTURE_REASONS[reason] : PAGE_ERRORS.structure_changed[1],
    'Inspect task status and follow the recorded recovery condition.');
  if (known) error.productStructureReason = reason;
  return error;
}

/**
 * Validate and normalize bounded public DOM observations; no guessed SKU IDs or prices.
 * @param {unknown} value @param {{url: string}} target
 * @returns {object} A partial snapshot with source, limits, and missing-field reasons.
 * @throws {ShoppingError} Page state, identity, or schema errors.
 */
export function validateProduct(value, target) {
  if (value?.state === 'structure_changed') {
    const error = productStructureError(value.reason);
    if (Object.hasOwn(value, 'layout_evidence_error')) {
      if (value.layout_evidence_error !== 'COLLECTION_FAILED' || Object.hasOwn(value, 'layout_evidence')) {
        throw new ShoppingError('INVALID_LAYOUT_EVIDENCE', 'The layout diagnostic status is invalid.');
      }
      error.layoutEvidenceError = 'COLLECTION_FAILED';
    }
    if (Object.hasOwn(value, 'layout_evidence')) {
      const evidence = validateLayoutEvidence(value.layout_evidence, target);
      if (evidence.reason !== value.reason) throw new ShoppingError('INVALID_LAYOUT_EVIDENCE', 'The layout evidence does not match the recorded failure.');
      error.layoutEvidence = evidence;
    }
    throw error;
  }
  const pageError = Object.hasOwn(PAGE_ERRORS, value?.state) ? PAGE_ERRORS[value.state] : null;
  if (pageError) throw new ShoppingError(...pageError, 'Inspect task status and follow the recorded recovery condition.');
  const expected = parseProductUrl(target?.url);
  if (!expected || value?.state !== 'observed' || value.product_id !== expected.product_id || value.url !== expected.url) {
    throw new ShoppingError('INVALID_RESPONSE', 'The product response does not match the bound page.');
  }
  const title = string(value.title, 300);
  if (!title) throw productStructureError('title_empty');
  const groups = array(value.groups, 8).map(group => ({
    name: string(group?.name, 120), options: array(group?.options, 100).map(option => ({
      label: string(option?.label, 200), selected: flag(option?.selected), disabled: flag(option?.disabled), sku_id: null,
    })),
  }));
  const prices = array(value.prices, 6).map(price => {
    const raw = string(price?.raw, 400), label = string(price?.label, 120);
    const amountText = string(price?.amount_text, 480), qualifier = string(price?.qualifier, 120);
    return { raw, label, qualifier, ...parseDisplayedPrice(amountText, qualifier), currency: 'CNY',
      eligibility_verified: false, sku_id: null, sku_price_binding_verified: false };
  });
  const reviews = array(value.reviews, 5).map((review, index) => ({
    observation_index: index + 1, body: string(review?.body, 2000), date_text: string(review?.date_text, 120),
    review_id: null, text_may_be_truncated: true,
  }));
  if (groups.some(group => !group.name)) throw productStructureError('specification_group_name_empty');
  if (groups.some(group => group.options.some(option => !option.label))) throw productStructureError('specification_option_label_empty');
  if (reviews.some(review => !review.body)) throw productStructureError('review_preview_body_empty');
  return {
    product_id: expected.product_id, url: expected.url, title, source: 'loaded_product_dom',
    observed_at: new Date().toISOString(), page_state: 'supported_regions_observed', login_verified: false,
    specification_groups: groups, prices, review_previews: reviews,
    coverage: { status: 'partial', specifications: groups.length ? 'loaded_options_only' : 'not_observed',
      prices: prices.length ? 'displayed_conditions_unverified' : 'not_observed',
      reviews: reviews.length ? 'preview_only' : 'not_observed' },
    missing: ['platform_sku_ids', 'verified_sku_price_mapping', 'full_review_list',
      ...(!groups.length ? ['specification_region'] : []), ...(!prices.length ? ['price_region'] : []),
      ...(!reviews.length ? ['review_preview_region'] : [])],
    limits: { groups: 8, options_per_group: 100, prices: 6, review_previews: 5, review_characters: 2000 },
    ...(Object.hasOwn(value, 'sku_url') ? { sku_evidence: skuEvidence(value.sku_url, expected.product_id) } : {}),
    ...(Object.hasOwn(value, 'specification_counts') ? { specification_scope: specificationScope(value.specification_counts, groups) } : {}),
    ...(Object.hasOwn(value, 'product_region_scope') ? { product_region_scope: productRegionScope(value.product_region_scope) } : {}),
  };
}

/**
 * Revalidate saved output against the same public schema before returning cached results.
 * @param {unknown} value @param {{url: string}} target @returns {object} Validated snapshot.
 * @throws {ShoppingError} INVALID_CHECKPOINT for changed fields, identities or unsupported schemas.
 */
export function validateSavedProduct(value, target) {
  try {
    if (typeof value?.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at))) throw new Error();
    const normalized = validateProduct({
      state: 'observed', product_id: value.product_id, url: value.url, title: value.title,
      groups: value.specification_groups,
      prices: value.prices.map(price => ({ raw: price.raw, label: price.label, qualifier: price.qualifier,
        amount_text: price.kind === 'range' ? `${price.minimum}-${price.maximum}`
          : price.kind === 'starting_from' ? price.minimum : price.kind === 'single_displayed' ? price.amount : '' })),
      reviews: value.review_previews.map(review => ({ body: review.body, date_text: review.date_text })),
      ...(Object.hasOwn(value, 'sku_evidence') ? { sku_url: {
        status: value.sku_evidence.status, candidate_sku_id: value.sku_evidence.candidate_sku_id,
        sku_properties_present: value.sku_evidence.sku_properties_present,
      } } : {}),
      ...(Object.hasOwn(value, 'specification_scope') ? { specification_counts: {
        region_observed: value.specification_scope.region_observed, groups_seen: value.specification_scope.groups_seen,
        options_seen: value.specification_scope.groups.map(group => group.options_seen),
      } } : {}),
      ...(Object.hasOwn(value, 'product_region_scope') ? { product_region_scope: value.product_region_scope } : {}),
    }, target);
    normalized.observed_at = value.observed_at;
    if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error();
    return normalized;
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved product snapshot does not match the supported output schema.'); }
}
