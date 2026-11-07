import { ShoppingError } from './errors.mjs';
import { productScript, validateProduct, validateSavedProduct } from './product.mjs';
import { pageDom, responseText } from './page-dom.mjs';
import { collectDescriptionText, normalizeDescriptionObservation } from './description-dom.mjs';
import { collectServiceTerms, normalizeServiceTerms } from './service-terms.mjs';
import { collectOfferNotices, normalizeOfferNotices } from './offer-notices.mjs';
import { collectGalleryImages } from './gallery-dom.mjs';
import { describeImageReadiness, normalizeImageReadiness, validateImageReadinessMapping } from './image-readiness.mjs';

function collectDetails(dom, descriptionText, serviceTerms, offerNotices, galleryImages) {
  const field = (root, prefix) => {
    const nodes = dom.all(root, dom.selector(prefix));
    if (nodes.length > 1) throw new Error('Ambiguous detail field');
    return nodes[0] ?? null;
  };
  const unique = prefix => {
    const nodes = dom.all(document, dom.selector(prefix));
    if (nodes.length > 1) throw new Error('Ambiguous detail region');
    return nodes[0] ?? null;
  };
  const shop = unique('shopHeader'), params = unique('paramsWrap'), gallery = unique('picGallery');
  const description = unique('imageTextInfo'), guarantees = unique('GuaranteeInfo'), delivery = unique('DomesticDelivery');
  // Description images sit in three module types; rich-text and jumper images were not read before 2026-10-14.
  // description-image-loading.mjs must select the same images in the same order, since its positions index these rows.
  const descriptionModules = [['single_image', '.descV8-singleImage-image'], ['rich_text', '.descV8-richtext img'], ['pic_jumper', '.descV8-picJumper-image']];
  const descriptionImages = root => {
    const nodes = root ? dom.all(root, descriptionModules.map(([, selector]) => selector).join(', ')).filter(node => node.tagName === 'IMG') : [];
    return { observed: root !== null, elements_seen: nodes.length,
      items: nodes.slice(0, 60).map(node => ({ url: node.currentSrc || node.getAttribute('src') || '',
        loaded: node.complete === true && node.naturalWidth > 0, width: node.naturalWidth, height: node.naturalHeight,
        module: descriptionModules.find(([, selector]) => node.matches(selector))[0] })),
      image_modules: descriptionModules.map(([name]) => name) };
  };
  const parameterRows = params ? dom.all(params, `${dom.selector('emphasisParamsInfoItem')}, ${dom.selector('generalParamsInfoItem')}`) : [];
  const attributes = parameterRows.slice(0, 100).map(row => {
    const emphasis = row.matches(dom.selector('emphasisParamsInfoItem'));
    // The emphasis layout places the value above its label; ordinary rows do the reverse.
    return { name: dom.text(field(row, emphasis ? 'emphasisParamsInfoItemSubTitle' : 'generalParamsInfoItemTitle'), 120),
      value: dom.text(field(row, emphasis ? 'emphasisParamsInfoItemTitle' : 'generalParamsInfoItemSubTitle'), 1500),
      source: emphasis ? 'emphasis_parameters' : 'general_parameters' };
  });
  const shopName = shop ? field(shop, 'shopName') : null;
  const text = descriptionText(description, dom);
  const notices = offerNotices(dom);
  return {
    shop: shop ? { name: dom.text(shopName, 200), url: shopName?.closest('a')?.href ?? '' } : null,
    attributes: { observed: params !== null, rows_seen: parameterRows.length, items: attributes },
    gallery: galleryImages(gallery, dom),
    description: { ...descriptionImages(description), ...text, image_readiness_observed: true,
      videos_seen: description ? dom.all(description, '.descV8-video').length : 0 },
    services: { observed: guarantees !== null,
      labels: guarantees ? dom.all(guarantees, dom.selector('guaranteeText')).slice(0, 20).map(node => dom.text(node, 200)) : [],
      terms: serviceTerms(guarantees, dom) },
    shipping: { observed: delivery !== null,
      freight_labels: delivery ? dom.all(delivery, dom.selector('freight')).slice(0, 5).map(node => dom.text(node, 200)) : [],
      dispatch: notices.dispatch },
    purchase: notices.purchase,
  };
}

/**
 * Read the base product and its loaded detail regions in a single guarded page evaluation.
 * @param {{url: string}} target @returns {string} Fixed DOM read; no navigation, image downloads, or UI actions.
 * @throws {ShoppingError} INVALID_TARGET.
 * @example detailsScript({ url: 'https://detail.tmall.com/item.htm?id=123' });
 */
export function detailsScript(target) {
  return `(() => { const product = ${productScript(target)};
    if (product.state !== 'observed') return product;
    try { return { ...product, details: (${collectDetails.toString()})((${pageDom.toString()})(), ${collectDescriptionText.toString()}, ${collectServiceTerms.toString()}, ${collectOfferNotices.toString()}, ${collectGalleryImages.toString()}) }; }
    catch { return { state: 'structure_changed' }; }
  })()`;
}

function invalid() { return new ShoppingError('INVALID_RESPONSE', 'The product detail response contains an invalid field.'); }
function collection(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw invalid();
  return value;
}
function observed(value) { if (typeof value !== 'boolean') throw invalid(); return value; }
function count(value, maximum = 10000) { if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalid(); return value; }

/**
 * Validate a public image asset or supported shop link; omit unsupported and query-bearing URLs.
 * @param {unknown} value @param {'image'|'shop'} type @returns {string|null} Canonical safe link; null for invalid input.
 * @example detailUrl('https://img.alicdn.com/example.jpg', 'image');
 */
export function detailUrl(value, type) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (type === 'shop') {
      if (!/^shop[0-9]+\.taobao\.com$/.test(url.hostname) && !/^[a-z0-9-]+\.tmall\.com$/.test(url.hostname)) return null;
      if (!['/', '/category.htm', '/search.htm'].includes(url.pathname)) return null;
      return `${url.origin}${url.pathname}`;
    }
    if (type !== 'image' || url.search || url.hash ||
        !['alicdn.com', 'tbcdn.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.href;
  } catch { return null; }
}

const DESCRIPTION_IMAGE_MODULES = ['single_image', 'rich_text', 'pic_jumper'];
// Scans before 2026-10-14 read only single-image modules and carry no image_modules; they stay valid as saved.
function scannedModules(value, source) {
  if (value === undefined) return null;
  if (source !== 'description_image' || !Array.isArray(value) || value.join(',') !== DESCRIPTION_IMAGE_MODULES.join(',')) throw invalid();
  return [...DESCRIPTION_IMAGE_MODULES];
}

/**
 * @param {object} value Raw image rows. @param {number} limit Maximum rows. @param {string} source Fixed region source.
 * @returns {object} Validated, deduplicated links retaining scanned positions; description scans since 2026-10-14 list
 * `image_modules` and give each link its `module`.
 * @throws {ShoppingError} INVALID_RESPONSE for malformed rows, modules or counts.
 * @example normalizeImageCollection(raw, 20, 'gallery_thumbnail');
 */
export function normalizeImageCollection(value, limit, source) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60 || !['gallery_thumbnail', 'description_image'].includes(source)) throw invalid();
  const modules = scannedModules(value?.image_modules, source);
  const regionObserved = observed(value?.observed), seen = count(value?.elements_seen);
  const rows = collection(value?.items, limit);
  if (seen < rows.length || (!regionObserved && (seen || rows.length))) throw invalid();
  let rejected = 0, duplicates = 0;
  const found = new Set(), items = [];
  rows.forEach((row, index) => {
    const url = detailUrl(row?.url, 'image');
    const loaded = observed(row?.loaded), width = count(row?.width, 1000000), height = count(row?.height, 1000000);
    if (loaded && (width === 0 || height === 0)) throw invalid();
    if (modules ? !modules.includes(row.module) : row?.module !== undefined) throw invalid();
    if (!url) { rejected += 1; return; }
    if (found.has(url)) { duplicates += 1; return; }
    found.add(url); items.push({ position: index + 1, url, loaded, width, height, source, ...(modules ? { module: row.module } : {}) });
  });
  return { observed: regionObserved, elements_seen: seen, elements_scanned: rows.length, duplicates_omitted: duplicates,
    unsupported_urls_omitted: rejected, items, ...(modules ? { image_modules: modules } : {}), image_text_extracted: false };
}

function labels(value, field, limit) {
  const regionObserved = observed(value?.observed);
  const items = collection(value?.[field], limit).map(text => responseText(text, 200));
  if ((!regionObserved && items.length) || items.some(text => !text)) throw invalid();
  return { observed: regionObserved, [field]: [...new Set(items)], conditions_verified: false };
}

/** @param {object} region Validated image collection. @returns {object} Counts of returned, loaded and unscanned elements without inferring complete coverage. @example imageAvailability(gallery); */
export function imageAvailability(region) {
  const loaded = region.items.filter(item => item.loaded).length;
  return { region_observed: region.observed, returned_images: region.items.length,
    loaded_returned_images: loaded, not_loaded_returned_images: region.items.length - loaded,
    unscanned_elements: region.elements_seen - region.elements_scanned };
}

function detailAvailability(details) {
  const { attributes, gallery, description } = details;
  const hasImages = description.items.length > 0, hasText = description.text.length > 0;
  const kind = !description.observed ? 'region_not_observed' : hasImages && hasText ? 'text_and_image_links'
    : hasImages ? 'image_links_only' : hasText ? 'text_only' : 'no_supported_content_observed';
  return { parameters: { region_observed: attributes.observed, returned_rows: attributes.items.length,
    unscanned_rows: attributes.rows_seen - attributes.items.length },
    gallery: imageAvailability(gallery), description: { ...imageAvailability(description), content_kind: kind,
      text_characters: description.text.length, image_text_extracted: false },
    unloaded_or_folded_content_verified: false };
}

function normalizeDetails(value, version = 2) {
  let shop = null;
  if (value?.shop !== null) {
    const name = responseText(value?.shop?.name, 200);
    if (!name) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The shop header has no supported name field.');
    shop = { name, url: detailUrl(value.shop.url, 'shop'), source: 'shop_header' };
  }
  const attributesObserved = observed(value?.attributes?.observed), rowsSeen = count(value?.attributes?.rows_seen);
  const attributes = collection(value?.attributes?.items, 100).map(row => {
    const name = responseText(row?.name, 120), text = responseText(row?.value, 1500);
    if (!name || !text || !['emphasis_parameters', 'general_parameters'].includes(row.source)) {
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'A parameter row is missing its label or value.');
    }
    return { name, value: text, source: row.source, text_may_be_truncated: true };
  });
  if (rowsSeen < attributes.length || (!attributesObserved && (rowsSeen || attributes.length))) throw invalid();
  const gallery = normalizeImageCollection(value?.gallery, 20, 'gallery_thumbnail');
  const description = { ...normalizeImageCollection(value?.description, 60, 'description_image'),
    text: responseText(value?.description?.text, 6000), text_may_be_truncated: true, videos_seen: count(value?.description?.videos_seen, 100),
    videos_extracted: false };
  if (version === 2 && value.description.observation !== undefined) {
    description.observation = normalizeDescriptionObservation(value.description.observation);
    const evidence = description.observation;
    if ((!evidence.text_container_observed && (description.text || evidence.text_truncated)) ||
        (description.observed && evidence.nodes_scanned === 0) ||
        (!description.observed && (evidence.text_container_observed || evidence.nodes_scanned || evidence.traversal_truncated || evidence.controls_truncated))) throw invalid();
  }
  if (value.description.image_readiness_observed !== undefined && typeof value.description.image_readiness_observed !== 'boolean') throw invalid();
  if (version === 2 && value.description.image_readiness !== undefined) {
    description.image_readiness = normalizeImageReadiness(value.description.image_readiness, url => detailUrl(url, 'image'));
  } else if (version === 2 && value.description.image_readiness_observed === true) {
    description.image_readiness = describeImageReadiness(value.description, url => detailUrl(url, 'image'));
  }
  if (!description.observed && (description.text || description.videos_seen)) throw invalid();
  const services = labels(value?.services, 'labels', 20), shipping = labels(value?.shipping, 'freight_labels', 5);
  if (version === 2 && value.shipping.dispatch !== undefined) {
    shipping.dispatch = normalizeOfferNotices(value.shipping.dispatch, 'dispatch');
    if (shipping.dispatch.observed !== shipping.observed) throw invalid();
  }
  if (version === 2 && value.services.terms !== undefined) {
    services.terms = normalizeServiceTerms(value.services.terms, services.labels);
    if (!services.observed && (services.terms.panel_observed || services.terms.entry_expanded)) throw invalid();
  }
  const details = { schema_version: version, source: 'loaded_product_detail_regions', shop,
    attributes: { observed: attributesObserved, rows_seen: rowsSeen, items: attributes }, gallery, description, services, shipping,
    coverage: { status: 'partial', attribute_scope: 'loaded_rows', image_scope: 'links_only', service_scope: 'displayed_labels', full_description: false },
    missing: ['image_text_not_extracted', 'unloaded_or_folded_regions', 'full_service_terms', 'address_specific_delivery', 'video_contents',
      ...(!shop ? ['shop_header'] : []), ...(!attributes.length ? ['parameter_rows'] : []),
      ...(!gallery.items.length ? ['gallery_image_links'] : []), ...(!description.items.length && !description.text ? ['description_content'] : [])],
    limits: { parameters: 100, parameter_value_characters: 1500, gallery_images: 20, description_images: 60, description_text_characters: 6000,
      service_labels: 20, freight_labels: 5 },
  };
  if (version === 2 && value.purchase !== undefined) details.purchase = normalizeOfferNotices(value.purchase, 'purchase');
  if (version === 2) details.availability = detailAvailability(details);
  return details;
}

/**
 * @param {unknown} value @param {object} target @returns {object} Base snapshot with scoped detail observations.
 * @throws {ShoppingError} Page, identity, or detail schema errors.
 * @example validateDetails(rawPageResult, target);
 */
export function validateDetails(value, target) {
  const product = validateProduct(value, target);
  const details = normalizeDetails(value.details);
  if (details.description.image_readiness) validateImageReadinessMapping(details.description.image_readiness, details.description);
  if (!details.shop && !details.attributes.observed && !details.gallery.observed && !details.description.observed &&
      !details.services.observed && !details.shipping.observed && !details.purchase?.observed) {
    throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'No supported detail region was observed on this product page.');
  }
  return { ...product, details };
}

/** @param {object} value Saved image collection. @param {number} limit Maximum scanned elements. @returns {object} Rows for canonical validation; the caller must preserve and compare original positions and omission counts. @throws {ShoppingError} INVALID_RESPONSE for contradictory counts or positions. @example restoreImageCollection(savedGallery, 20); */
export function restoreImageCollection(value, limit) {
  if (!value || !Array.isArray(value.items) || !Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw invalid();
  const scanned = count(value.elements_scanned, limit), duplicates = count(value.duplicates_omitted, limit), unsupported = count(value.unsupported_urls_omitted, limit);
  if (scanned !== value.items.length + duplicates + unsupported || value.elements_seen < scanned) throw invalid();
  let previous = 0;
  for (const item of value.items) {
    if (!Number.isInteger(item.position) || item.position <= previous || item.position > scanned) throw invalid();
    previous = item.position;
  }
  return { observed: value.observed, elements_seen: value.elements_seen, items: value.items };
}

/**
 * @param {object} value @param {object} target @returns {void}
 * @throws {ShoppingError} INVALID_CHECKPOINT for changed or incompatible detail snapshots.
 * @example validateSavedDetails(savedResult, target);
 */
export function validateSavedDetails(value, target) {
  try {
    const { details, ...product } = value;
    if (![1, 2].includes(details?.schema_version)) throw invalid();
    validateSavedProduct(product, target);
    const normalized = normalizeDetails({ ...details, gallery: restoreImageCollection(details.gallery, 20),
      description: { ...restoreImageCollection(details.description, 60), text: details.description.text, videos_seen: details.description.videos_seen,
        ...(details.description.image_modules === undefined ? {} : { image_modules: details.description.image_modules }),
        ...(details.description.observation === undefined ? {} : { observation: details.description.observation }),
        ...(details.description.image_readiness === undefined ? {} : { image_readiness: details.description.image_readiness }) } }, details.schema_version);
    for (const key of ['gallery', 'description']) {
      normalized[key].elements_scanned = details[key].elements_scanned;
      normalized[key].duplicates_omitted = details[key].duplicates_omitted;
      normalized[key].unsupported_urls_omitted = details[key].unsupported_urls_omitted;
      normalized[key].items.forEach((item, index) => { item.position = details[key].items[index].position; });
    }
    if (details.schema_version === 2) normalized.availability = detailAvailability(normalized);
    if (normalized.description.image_readiness) validateImageReadinessMapping(normalized.description.image_readiness, normalized.description);
    if (JSON.stringify(normalized) !== JSON.stringify(details)) throw invalid();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved product details do not match the supported schema.'); }
}
