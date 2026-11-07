import { ShoppingError } from './errors.mjs';
import { inspectSpecificationImageLoading, validateSpecificationLoading, validateSpecificationLoadingPlan } from './specification-image-loading.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, throwPageError, responseText } from './page-dom.mjs';
import { detailUrl } from './details.mjs';

function inspectSpecificationImages(target, dom, batch = null) {
  const address = new URL(location.href);
  if (address.origin !== target.origin || address.pathname !== target.pathname ||
      address.searchParams.getAll('id').length !== 1 || address.searchParams.get('id') !== target.product_id) return { state: 'target_changed' };
  const gate = dom.gate(null, { readOnly: true });
  if (gate) return { state: gate };
  const included = node => {
    let depth = 0;
    for (let parent = node; parent; parent = parent.parentElement) {
      if (++depth > 64) throw new Error('Specification ancestor limit reached');
      if (!dom.visible(parent) || parent.hidden || parent.getAttribute('aria-hidden') === 'true') return false;
      if (parent.tagName === 'VIDEO' || ['mainPicVideo', 'videoPicWrap', 'videoPic'].some(prefix => parent.matches(dom.selector(prefix)))) return false;
    }
    return true;
  };
  const nodes = (root, prefix) => dom.all(root, dom.selector(prefix)).filter(included);
  const label = (root, prefix, limit) => {
    const matches = nodes(root, prefix);
    if (matches.length !== 1) throw new Error('Ambiguous option label');
    const value = dom.text(matches[0], limit + 1);
    if (!value || value.length > limit) throw new Error('Unsupported option label');
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  };
  try {
    const roots = nodes(document, 'skuWrapper');
    if (!roots.length) return { state: 'unsupported' };
    if (roots.length !== 1) return { state: 'structure_changed' };
    const root = roots[0], groupNodes = nodes(root, 'skuItem');
    const layout = groupNodes.slice(0, 8).map(group => {
      if (group.parentElement?.closest(dom.selector('skuItem')) || group.closest(dom.selector('skuWrapper')) !== root) throw new Error('Nested specification group');
      const name = label(group, 'ItemLabel', 120), optionNodes = nodes(group, 'valueItem');
      const records = [];
      optionNodes.slice(0, 100).forEach((option, index) => {
        if (option.closest(dom.selector('skuItem')) !== group || option.parentElement?.closest(dom.selector('valueItem'))) throw new Error('Nested specification option');
        const regions = nodes(option, 'valueItemImgWrap');
        if (regions.length) records.push({ position: index + 1, option, regions });
      });
      return { group, name, options_seen: optionNodes.length, options_scanned: Math.min(optionNodes.length, 100), records };
    });
    if (batch?.kind === 'collection') {
      return collectSpecificationOptions(target, dom, batch, layout, groupNodes.length, included, label);
    }
    const offset = batch?.offset ?? 0;
    const inventory = { groups_seen: groupNodes.length, groups: layout.map(group => ({ name: group.name,
      options_seen: group.options_seen, options_scanned: group.options_scanned, image_options_seen: group.records.length })) };
    if (batch?.inventory) {
      if (JSON.stringify(inventory) !== JSON.stringify(batch.inventory)) return { state: 'specification_image_inventory_changed' };
      const prefix = layout.flatMap((group, index) => group.records.map(record => ({ group_position: index + 1, record })))
        .slice(0, offset).map(({ group_position, record }) => ({ group_position, position: record.position, label: label(record.option, 'valueItemText', 200) }));
      if (JSON.stringify(prefix) !== JSON.stringify(batch.prefix)) return { state: 'specification_image_inventory_changed' };
    }
    let visited = 0, remaining = 5;
    const groups = layout.map(({ group, name, options_seen, options_scanned, records }) => {
      const options = [];
      for (const { option, position, regions } of records) {
        if (visited++ < offset || !remaining) continue;
        remaining--;
        const images = regions.length === 1 ? dom.all(regions[0], 'img').filter(included) : null;
        const image = images?.length === 1 ? images[0] : null;
        if (image && (image.closest(dom.selector('valueItem')) !== option || image.closest(dom.selector('skuItem')) !== group ||
            image.closest(dom.selector('valueItemImgWrap')) !== regions[0])) throw new Error('Image owner mismatch');
        options.push({ position, label: label(option, 'valueItemText', 200),
          selected: option.getAttribute('aria-selected') === 'true' || option.matches(dom.selector('isSelected')) ? true : null,
          disabled: option.getAttribute('aria-disabled') === 'true' || option.getAttribute('data-disabled') === 'true' || option.matches(dom.selector('isDisabled')) ? true : null,
          image_regions_seen: regions.length, image_elements_seen: images?.length ?? null,
          image: image ? { url: image.currentSrc || image.getAttribute('src') || '',
            loaded: image.complete === true && image.naturalWidth > 0 && image.naturalHeight > 0,
            width: image.naturalWidth, height: image.naturalHeight } : null });
      }
      return { name, options_seen, options_scanned, image_options_seen: records.length, options };
    });
    return { state: 'observed', product_id: target.product_id, url: target.url,
      observed_at: new Date().toISOString(), groups_seen: groupNodes.length, groups,
      ...(batch ? { batch_offset: offset } : {}) };
  } catch { return { state: 'structure_changed' }; }
}

/**
 * @param {{url:string}} target Bound public product identity.
 * @returns {string} Fixed DOM-only read of at most five options' image regions; no selection or requests.
 * @throws {ShoppingError} INVALID_TARGET for unsupported URLs.
 * @example specificationImagesScript({url:'https://detail.tmall.com/item.htm?id=123'});
 */
export function specificationImagesScript(target) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required.');
  return `(${inspectSpecificationImages.toString()})(${JSON.stringify(expected)}, (${pageDom.toString()})())`;
}

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The specification image observation has invalid fields or coverage.');
function keys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names.split(',').sort().join(',')) throw invalid();
}
function count(value, max = 10000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw invalid();
  return value;
}
function flag(value) {
  if (value !== true && value !== null) throw invalid();
  return value;
}
function label(value, max) {
  const normalized = responseText(value, max);
  if (!normalized) throw invalid();
  return normalized;
}

function normalizeImage(option) {
  const regions = count(option.image_regions_seen);
  if (!regions) throw invalid();
  const elements = regions === 1 ? count(option.image_elements_seen) : null;
  if (regions !== 1 && option.image_elements_seen !== null) throw invalid();
  let status = regions !== 1 ? 'ambiguous_image_regions' : elements === 0 ? 'image_element_not_observed' : 'ambiguous_image_elements';
  let url = null, loaded = null, width = null, height = null;
  if (regions === 1 && elements === 1) {
    keys(option.image, 'url,loaded,width,height');
    if (typeof option.image.url !== 'string' || option.image.url.length > 16384 || typeof option.image.loaded !== 'boolean') throw invalid();
    ({ loaded } = option.image);
    width = count(option.image.width, 1000000); height = count(option.image.height, 1000000);
    if (loaded && (!width || !height)) throw invalid();
    url = detailUrl(option.image.url, 'image');
    status = url ? 'observed' : 'unsupported_image_url';
  } else if (option.image !== null) throw invalid();
  return { regions_seen: regions, elements_seen: elements, status, url, loaded, width, height };
}

function normalizeGroups(value, offset = 0) {
  count(value.groups_seen);
  if (!Array.isArray(value.groups) || value.groups.length !== Math.min(value.groups_seen, 8)) throw invalid();
  let remaining = 5, skipped = offset;
  return value.groups.map((group, index) => {
    keys(group, 'name,options_seen,options_scanned,image_options_seen,options');
    const seen = count(group.options_seen), scanned = count(group.options_scanned, 100);
    const withImages = count(group.image_options_seen, scanned);
    const groupSkipped = Math.min(skipped, withImages); skipped -= groupSkipped;
    if (scanned !== Math.min(seen, 100) || !Array.isArray(group.options) || group.options.length !== Math.min(withImages - groupSkipped, remaining)) throw invalid();
    remaining -= group.options.length;
    let previous = 0;
    const options = group.options.map(option => {
      keys(option, 'position,label,selected,disabled,image_regions_seen,image_elements_seen,image');
      const position = count(option.position, scanned);
      if (position <= previous) throw invalid();
      previous = position;
      const image = normalizeImage(option);
      return { position, label: label(option.label, 200), selected: flag(option.selected), disabled: flag(option.disabled), image,
        association: { source: 'option_image_wrapper_dom', option_binding_verified: image.status === 'observed',
          sku_id: null, sku_binding_verified: false, sku_price_binding_verified: false } };
    });
    return { position: index + 1, name: label(group.name, 120), options_seen: seen, options_scanned: scanned,
      image_options_seen: withImages, image_options_sampled: options.length, image_options_omitted: withImages - options.length, options };
  });
}

/**
 * @param {unknown} value Raw bounded page observation. @param {{url:string}} target Expected identity.
 * @returns {object} Option/image associations with original positions and explicit missing/ambiguous states.
 * @throws {ShoppingError} Page gates or INVALID_RESPONSE; no fabricated platform SKU or price binding.
 * @example validateSpecificationImages(raw, target);
 */
export function validateSpecificationImages(value, target) {
  throwPageError(value?.state);
  if (value?.state === 'specification_image_inventory_changed') throw new ShoppingError('SPECIFICATION_IMAGE_INVENTORY_CHANGED', 'The option list changed between batches; preserve previous observations and stop.');
  const paged = Object.hasOwn(value ?? {}, 'batch_offset');
  keys(value, 'state,product_id,url,observed_at,groups_seen,groups' + (paged ? ',batch_offset' : ''));
  const offset = paged ? count(value.batch_offset, 35) : 0;
  const expected = parseProductUrl(target?.url);
  if (!expected || value.state !== 'observed' || value.product_id !== expected.product_id || value.url !== expected.url ||
      typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at))) throw invalid();
  const groups = normalizeGroups(value, offset), options = groups.flatMap(group => group.options);
  const images = options.filter(option => option.image.status === 'observed');
  const sum = field => groups.reduce((total, group) => total + group[field], 0);
  if (offset && offset >= sum('image_options_seen')) throw invalid();
  return { schema_version: paged ? 2 : 1, product_id: expected.product_id, url: expected.url, observed_at: value.observed_at,
    source: 'loaded_specification_option_image_dom', groups,
    scope: { groups_seen: value.groups_seen, groups_scanned: groups.length, groups_omitted: value.groups_seen - groups.length,
      options_seen_in_scanned_groups: sum('options_seen'), options_scanned: sum('options_scanned'),
      options_unscanned_in_scanned_groups: sum('options_seen') - sum('options_scanned'),
      image_options_seen: sum('image_options_seen'), image_options_sampled: options.length,
      image_options_omitted: sum('image_options_seen') - options.length },
    availability: { returned_images: images.length, loaded_returned_images: images.filter(option => option.image.loaded).length,
      not_loaded_returned_images: images.filter(option => !option.image.loaded).length,
      sampled_options_without_supported_image: options.length - images.length },
    coverage: { status: 'partial', full_option_images: false, full_sku_matrix: false, selected_combination_verified: false,
      current_main_image_read: false, original_resolution_verified: false, file_downloaded: false, image_semantics_read: false, video_read: false },
    missing: images.length ? [] : ['specification_option_image_links'],
    limits: { groups: 8, options_per_group: 100, image_options: 5 },
    ...(paged ? { batch: { offset, sampled: options.length,
      remaining: sum('image_options_seen') - offset - options.length } } : {}) };
}

/**
 * @param {object} saved Canonical specification image result. @param {{url:string}} target Expected identity.
 * @returns {void} Validates the original result without refreshing its time or fields.
 * @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent fields, coverage or unsupported claims.
 * @example validateSavedSpecificationImages(saved, target);
 */
export function validateSavedSpecificationImages(saved, target) {
  try {
    const normalized = validateSpecificationImages({ state: 'observed', product_id: saved.product_id, url: saved.url,
      observed_at: saved.observed_at, groups_seen: saved.scope.groups_seen,
      ...(saved.schema_version === 2 ? { batch_offset: saved.batch.offset } : {}),
      groups: saved.groups.map(group => ({ name: group.name, options_seen: group.options_seen, options_scanned: group.options_scanned,
        image_options_seen: group.image_options_seen, options: group.options.map(option => ({
          position: option.position, label: option.label, selected: option.selected, disabled: option.disabled,
          image_regions_seen: option.image.regions_seen, image_elements_seen: option.image.elements_seen,
          image: option.image.regions_seen === 1 && option.image.elements_seen === 1
            ? { url: option.image.url ?? '', loaded: option.image.loaded, width: option.image.width, height: option.image.height } : null
        })) })) }, target);
    if (JSON.stringify(normalized) !== JSON.stringify(saved)) throw invalid();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved specification images do not match their supported schema.'); }
}

function inventoryOf(snapshot) {
  return { groups_seen: snapshot.scope.groups_seen, groups: snapshot.groups.map(group => ({ name: group.name,
    options_seen: group.options_seen, options_scanned: group.options_scanned, image_options_seen: group.image_options_seen })) };
}

/**
 * @param {object[]} batches Previous validated batches in order, at most eight. @param {{url:string}} target Identity.
 * @returns {object|null} Fixed continuation guard, or null when all image options in the scanned structure were sampled.
 * @throws {ShoppingError} INVALID_CHECKPOINT for mismatched layouts, offsets or repeated positions.
 * @example specificationImageContinuation([firstBatch], target);
 */
export function specificationImageContinuation(batches, target) {
  try {
    if (!Array.isArray(batches) || batches.length > 8) throw invalid();
    if (!batches.length) return { offset: 0, inventory: null, prefix: [] };
    let inventory = null;
    const prefix = [];
    for (const [index, batch] of batches.entries()) {
      validateSavedSpecificationImages(batch, target);
      if ((batch.schema_version === 1 && index !== 0) || (batch.batch?.offset ?? 0) !== prefix.length) throw invalid();
      const current = inventoryOf(batch);
      if (inventory && JSON.stringify(inventory) !== JSON.stringify(current)) throw invalid();
      inventory = current;
      const total = batch.scope.image_options_seen;
      if (index > 0 && prefix.length >= total) throw invalid();
      for (const group of batch.groups) for (const option of group.options) {
        const previous = prefix.at(-1);
        if (previous && (group.position < previous.group_position || group.position === previous.group_position && option.position <= previous.position)) throw invalid();
        prefix.push({ group_position: group.position, position: option.position, label: option.label });
      }
    }
    return prefix.length === batches[0].scope.image_options_seen ? null : { offset: prefix.length, inventory, prefix };
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The specification image batches cannot form a consistent continuation.'); }
}

/**
 * @param {{url:string}} target Bound product. @param {object[]} batches Previously committed batches; [] starts at zero.
 * @returns {string} Read-only next batch expression; previous option URLs are not read again.
 * @throws {ShoppingError} INVALID_TARGET, INVALID_CHECKPOINT, or SPECIFICATION_IMAGE_BATCH_LIMIT.
 * @example specificationImageBatchScript(target, [firstBatch]);
 */
export function specificationImageBatchScript(target, batches) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required.');
  const continuation = specificationImageContinuation(batches, expected);
  if (!continuation || batches.length >= 8 || continuation.offset > 35) {
    throw new ShoppingError('SPECIFICATION_IMAGE_BATCH_LIMIT', 'No further batch is available within this task budget.');
  }
  return `(${inspectSpecificationImages.toString()})(${JSON.stringify(expected)}, (${pageDom.toString()})(), ${JSON.stringify(continuation)})`;
}

function collectSpecificationOptions(target, dom, plan, layout, groupsSeen, included, textLabel) {
  const inventory = { groups_seen: groupsSeen, groups: layout.map((group, index) => ({
    position: index + 1, name: group.name, options_seen: group.options_seen,
    options: dom.all(group.group, dom.selector('valueItem')).filter(included).slice(0, 100).map((option, index) => ({
      position: index + 1, label: textLabel(option, 'valueItemText', 200),
      image_regions_seen: dom.all(option, dom.selector('valueItemImgWrap')).filter(included).length
    }))
  })) };
  if (plan.inventory && JSON.stringify(inventory) !== JSON.stringify(plan.inventory)) return { state: 'specification_image_inventory_changed' };
  const requested = plan.positions ?? inventory.groups.flatMap(group => group.options
    .filter(option => option.image_regions_seen > 0).map(option => ({ group_position: group.position, position: option.position }))).slice(0, 5);
  let scrollImage = null;
  const samples = requested.map(({ group_position, position }) => {
    const group = layout[group_position - 1], record = group?.records.find(value => value.position === position);
    if (!record) throw new Error('Missing option owner');
    const { option, regions } = record;
    const images = regions.length === 1 ? dom.all(regions[0], 'img').filter(included) : null;
    const image = images?.length === 1 ? images[0] : null;
    if (image && (image.closest(dom.selector('valueItem')) !== option || image.closest(dom.selector('skuItem')) !== group.group ||
        image.closest(dom.selector('valueItemImgWrap')) !== regions[0])) throw new Error('Image owner mismatch');
    if (plan.scroll) {
      const selected = dom.all(group.group, dom.selector('valueItem')).filter(included)
        .filter(node => node.getAttribute('aria-selected') === 'true' || node.matches(dom.selector('isSelected')));
      if (selected.length > 1) throw new Error('Conflicting selected options');
      scrollImage = image;
    }
    return { group_position, position, label: textLabel(option, 'valueItemText', 200),
      selected: option.getAttribute('aria-selected') === 'true' || option.matches(dom.selector('isSelected')) ? true : null,
      disabled: option.getAttribute('aria-disabled') === 'true' || option.getAttribute('data-disabled') === 'true' || option.matches(dom.selector('isDisabled')) ? true : null,
      image_regions_seen: regions.length, image_elements_seen: images?.length ?? null,
      image: image ? { url: image.currentSrc || image.getAttribute('src') || '',
        loaded: image.complete === true && image.naturalWidth > 0 && image.naturalHeight > 0,
        width: image.naturalWidth, height: image.naturalHeight } : null };
  });
  const observedAt = new Date().toISOString();
  const loading = plan.scroll ? inspectSpecificationImageLoading(dom, scrollImage, samples[0], plan.scroll.expected_image) : null;
  if (loading?.state) return { state: loading.state };
  return { state: 'observed', product_id: target.product_id, url: target.url,
    observed_at: observedAt, inventory, samples, ...(loading ? { loading } : {}) };
}

/**
 * @param {{url:string}} target Bound identity. @param {object} plan Fixed inventory guard and up to five positions, or inventory_only with [] and null inventory.
 * @returns {string} Fixed DOM read; a reserved scroll plan may move one offscreen tiny IMG, never select or request images.
 * @throws {ShoppingError} INVALID_TARGET or INVALID_ARGUMENTS.
 * @example specificationCollectionScript(target, {inventory:null, positions:null});
 */
export function specificationCollectionScript(target, plan) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required.');
  const inventoryOnly = plan?.inventory_only === true;
  if (!plan || (Object.hasOwn(plan, 'inventory_only') && !inventoryOnly) ||
      (inventoryOnly && (plan.inventory !== null || !Array.isArray(plan.positions) || plan.positions.length !== 0 || plan.scroll || plan.after_scroll)) ||
      (plan.positions !== null && (!Array.isArray(plan.positions) || plan.positions.length < (inventoryOnly ? 0 : 1) || plan.positions.length > 5 ||
      plan.positions.some(p => !p || !Number.isSafeInteger(p.group_position) || p.group_position < 1 || p.group_position > 8 ||
        !Number.isSafeInteger(p.position) || p.position < 1 || p.position > 100)))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'A bounded specification collection plan is required.');
  }
  if (plan.scroll) validateSpecificationLoadingPlan(plan);
  const loadingHelper = plan.scroll ? `const inspectSpecificationImageLoading = ${inspectSpecificationImageLoading.toString()};` : '';
  return `(() => { ${loadingHelper} const collectSpecificationOptions = ${collectSpecificationOptions.toString()}; return (${inspectSpecificationImages.toString()})(${JSON.stringify(expected)}, (${pageDom.toString()})(), ${JSON.stringify({ ...plan, kind: 'collection' })}); })()`;
}

/**
 * @param {unknown} raw Page response. @param {{url:string}} target Expected identity.
 * @returns {object} Complete scanned text inventory and this read's bounded image observations.
 * @throws {ShoppingError} Page gate, changed inventory, or INVALID_RESPONSE.
 * @example validateSpecificationCollectionObservation(raw, target);
 */
export function validateSpecificationCollectionObservation(raw, target) {
  throwPageError(raw?.state);
  if (raw?.state === 'specification_image_inventory_changed') throw new ShoppingError('SPECIFICATION_IMAGE_INVENTORY_CHANGED', 'The specification inventory changed; previous observations were retained.');
  const loading = Object.hasOwn(raw ?? {}, 'loading');
  keys(raw, 'state,product_id,url,observed_at,inventory,samples' + (loading ? ',loading' : ''));
  const expected = parseProductUrl(target?.url);
  if (!expected || raw.state !== 'observed' || raw.product_id !== expected.product_id || raw.url !== expected.url ||
      typeof raw.observed_at !== 'string' || !Number.isFinite(Date.parse(raw.observed_at))) throw invalid();
  keys(raw.inventory, 'groups_seen,groups');
  const groupsSeen = count(raw.inventory.groups_seen);
  if (!Array.isArray(raw.inventory.groups) || raw.inventory.groups.length !== Math.min(groupsSeen, 8)) throw invalid();
  const inventory = { groups_seen: groupsSeen, groups: raw.inventory.groups.map((group, index) => {
    keys(group, 'position,name,options_seen,options');
    const seen = count(group.options_seen);
    if (group.position !== index + 1 || !Array.isArray(group.options) || group.options.length !== Math.min(seen, 100)) throw invalid();
    return { position: index + 1, name: label(group.name, 120), options_seen: seen, options: group.options.map((option, index) => {
      keys(option, 'position,label,image_regions_seen');
      if (option.position !== index + 1) throw invalid();
      return { position: index + 1, label: label(option.label, 200), image_regions_seen: count(option.image_regions_seen) };
    }) };
  }) };
  if (!Array.isArray(raw.samples) || raw.samples.length > 5) throw invalid();
  const seen = new Set();
  const samples = raw.samples.map(option => {
    keys(option, 'group_position,position,label,selected,disabled,image_regions_seen,image_elements_seen,image');
    const groupPosition = count(option.group_position, 8), position = count(option.position, 100);
    const owner = inventory.groups[groupPosition - 1]?.options[position - 1], key = `${groupPosition}:${position}`;
    if (!owner || seen.has(key) || label(option.label, 200) !== owner.label || option.image_regions_seen !== owner.image_regions_seen) throw invalid();
    seen.add(key);
    const image = normalizeImage(option);
    return { group_position: groupPosition, position, label: owner.label,
      selected: flag(option.selected), disabled: flag(option.disabled), image,
      association: { source: 'option_image_wrapper_dom', option_binding_verified: image.status === 'observed',
        sku_id: null, sku_binding_verified: false, sku_price_binding_verified: false } };
  });
  const loadingObservation = loading ? validateSpecificationLoading(raw.loading, samples) : null;
  if (loadingObservation?.action === 'scrolled' && Date.parse(loadingObservation.action_observed_at) < Date.parse(raw.observed_at)) throw invalid();
  return { schema_version: loading ? 2 : 1, product_id: expected.product_id, url: expected.url, observed_at: raw.observed_at, inventory, samples,
    ...(loading ? { loading: loadingObservation } : {}) };
}

/**
 * @param {object} saved Canonical observation. @param {object} target Identity.
 * @returns {void} Validates stored fields without refreshing them. @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateSavedSpecificationCollectionObservation(saved, target);
 */
export function validateSavedSpecificationCollectionObservation(saved, target) {
  try {
    const raw = { state: 'observed', product_id: saved.product_id, url: saved.url, observed_at: saved.observed_at,
      inventory: saved.inventory, samples: saved.samples.map(option => ({
        group_position: option.group_position, position: option.position, label: option.label, selected: option.selected, disabled: option.disabled,
        image_regions_seen: option.image.regions_seen, image_elements_seen: option.image.elements_seen,
        image: option.image.regions_seen === 1 && option.image.elements_seen === 1
          ? { url: option.image.url ?? '', loaded: option.image.loaded, width: option.image.width, height: option.image.height } : null
      })), ...(Object.hasOwn(saved, 'loading') ? { loading: saved.loading } : {}) };
    if (JSON.stringify(validateSpecificationCollectionObservation(raw, target)) !== JSON.stringify(saved)) throw invalid();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved specification collection observation is invalid.'); }
}
