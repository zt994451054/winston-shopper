import { ShoppingError } from './errors.mjs';
import { validateSavedSpecificationCollectionObservation } from './specification-images.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = option => `${option.group_position}:${option.position}`;
const positionsOf = samples => samples.map(({ group_position, position }) => ({ group_position, position }));
const invalid = () => new ShoppingError('INVALID_CHECKPOINT', 'The bounded specification collection journal is inconsistent.');

/** @param {1|2|3} [schemaVersion=3] Older versions are replay-only compatibility. @returns {object} New journal; no old task is upgraded. @throws {ShoppingError} INVALID_CHECKPOINT. @example newSpecificationCollection(); */
export function newSpecificationCollection(schemaVersion = 3) {
  if (schemaVersion === 3) return { schema_version: 3, inventory_read_limit: 3, read_limit: 3,
    per_option_read_limit: 3, scroll_limit: 0, inventory: null, reads: [] };
  if (![1, 2].includes(schemaVersion)) throw invalid();
  return { schema_version: schemaVersion, read_limit: 10, per_option_read_limit: 3,
    ...(schemaVersion === 2 ? { scroll_limit: 2 } : {}), inventory: null, reads: [] };
}

function imageState(image) {
  if (image.status !== 'observed') return image.status;
  if (!image.loaded) return 'image_not_loaded';
  if (image.width <= 2 || image.height <= 2) return 'tiny_image_unresolved';
  return 'loaded_image_link';
}

function entries(state) {
  const options = (state.inventory?.groups ?? []).flatMap(group => group.options.map(option => {
    const position = { group_position: group.position, position: option.position };
    return { ...position, group: group.name, label: option.label, image_regions_seen: option.image_regions_seen, attempts: 0, observations: [] };
  }));
  const byPosition = new Map(options.map(option => [keyOf(option), option]));
  state.reads.forEach((read, index) => {
    const positions = read.positions ?? positionsOf(read.observation?.samples ?? []);
    for (const position of positions) {
      const option = byPosition.get(keyOf(position));
      if (option) option.attempts++;
    }
    for (const sample of read.observation?.samples ?? []) {
      byPosition.get(keyOf(sample))?.observations.push({ read: index + 1, observed_at: read.observation.observed_at, ...sample,
        ...(read.scroll ? { source_timing: read.observation.loading.action === 'scrolled' ? 'before_scroll' : 'read_only' } : {}) });
    }
  });
  return options.map(({ observations, ...option }) => {
    const best = observations.find(observation => imageState(observation.image) === 'loaded_image_link') ?? observations.at(-1);
    return { ...option, image_status: best ? imageState(best.image) : option.image_regions_seen ? 'not_read' : 'no_supported_image_container',
      image: best?.image ?? null, association: best?.association ?? { source: null, option_binding_verified: false,
        sku_id: null, sku_binding_verified: false, sku_price_binding_verified: false }, observations };
  });
}

/**
 * @param {object} state Validated journal.
 * @returns {object|null} Initial scan, one reserved loading guard, or up to five read positions; null at completion or limits.
 * @example specificationCollectionPlan(state);
 */
export function specificationCollectionPlan(state) {
  if (state.reads.length >= state.read_limit) return null;
  if (!state.inventory) return state.schema_version === 3
    ? { inventory: null, positions: [], inventory_only: true } : { inventory: null, positions: null };
  const pending = entries(state).filter(option => option.image_regions_seen > 0 && option.image_status !== 'loaded_image_link' &&
    option.attempts < state.per_option_read_limit).sort((a, b) => a.attempts - b.attempts);
  if (!pending.length) return null;
  if (state.schema_version >= 2) {
    const last = state.reads.at(-1);
    if (last?.scroll) {
      const target = pending.find(option => keyOf(option) === keyOf(last.positions[0]));
      if (target) return { inventory: state.inventory,
        positions: positionsOf(state.schema_version === 3 ? [target] : [target, ...pending.filter(option => option !== target)].slice(0, 5)), after_scroll: state.reads.length };
    }
    const previousScrolls = state.reads.filter(read => read.scroll);
    const fullInventory = state.inventory.groups_seen === state.inventory.groups.length &&
      state.inventory.groups.every(group => group.options.length === group.options_seen);
    const scrollTarget = pending.find(option => option.image_status === 'tiny_image_unresolved' && option.attempts < state.per_option_read_limit - 1 &&
      !previousScrolls.some(read => keyOf(read.positions[0]) === keyOf(option)));
    if (pending[0].attempts > 0 && fullInventory && scrollTarget && previousScrolls.length < state.scroll_limit &&
        state.reads.length + 2 <= state.read_limit) {
      const { url, width, height } = scrollTarget.image;
      return { inventory: state.inventory, positions: positionsOf([scrollTarget]), scroll: { expected_image: { url, width, height } } };
    }
  }
  const leastRead = pending.filter(option => option.attempts === pending[0].attempts);
  return { inventory: state.inventory, positions: positionsOf(leastRead.slice(0, 5)) };
}

/**
 * @param {object} state Mutable task journal, persisted by caller before IO.
 * @returns {object} Reserved fixed read plan. @throws {ShoppingError} SPECIFICATION_IMAGE_READ_LIMIT.
 * @example const plan = reserveSpecificationCollectionRead(state); await commit();
 */
export function reserveSpecificationCollectionRead(state) {
  const plan = specificationCollectionPlan(state);
  if (!plan) throw new ShoppingError('SPECIFICATION_IMAGE_READ_LIMIT', 'No further specification read is available.');
  state.reads.push({ positions: plan.positions, observation: null,
    ...(plan.inventory_only ? { inventory_only: true } : {}),
    ...(plan.scroll ? { scroll: plan.scroll } : {}), ...(plan.after_scroll ? { after_scroll: plan.after_scroll } : {}) });
  return plan;
}

/**
 * @param {object} state Reserved journal. @param {object} observation Validated DOM response. @param {object} target Identity.
 * @returns {void} Commits only the exact reserved positions, preserving earlier observations.
 * @throws {ShoppingError} INVALID_RESPONSE or SPECIFICATION_IMAGE_INVENTORY_CHANGED.
 * @example acceptSpecificationCollectionRead(state, observation, target);
 */
export function acceptSpecificationCollectionRead(state, observation, target) {
  validateSavedSpecificationCollectionObservation(observation, target);
  const read = state.reads.at(-1);
  if (!read || read.observation) throw new ShoppingError('INVALID_RESPONSE', 'No pending specification read exists.');
  if (Boolean(read.scroll) !== Object.hasOwn(observation, 'loading')) throw new ShoppingError('INVALID_RESPONSE', 'The loading acknowledgement does not match its reservation.');
  if (state.inventory && !same(state.inventory, observation.inventory)) {
    throw new ShoppingError('SPECIFICATION_IMAGE_INVENTORY_CHANGED', 'The specification list changed between reads.');
  }
  const expected = read.positions ?? observation.inventory.groups.flatMap(group => group.options.filter(option => option.image_regions_seen > 0)
    .map(option => ({ group_position: group.position, position: option.position }))).slice(0, 5);
  if (!same(expected, positionsOf(observation.samples))) throw new ShoppingError('INVALID_RESPONSE', 'The specification response does not match its reserved positions.');
  if (read.scroll) {
    const image = observation.samples[0].image, loading = observation.loading;
    const unchanged = image.status === 'observed' && image.loaded &&
      same({ url: image.url, width: image.width, height: image.height }, read.scroll.expected_image);
    if (['offscreen_tiny_image', 'already_in_view'].includes(loading.reason) ? !unchanged :
        loading.reason === 'source_changed' ? unchanged : image.regions_seen === 1 && image.elements_seen === 1) {
      throw new ShoppingError('INVALID_RESPONSE', 'The loading action is inconsistent with its guarded image source.');
    }
  }
  state.inventory ??= observation.inventory;
  if (state.schema_version === 3 && read.inventory_only) {
    const imageOptions = state.inventory.groups.reduce((sum, group) => sum + group.options.filter(option => option.image_regions_seen > 0).length, 0);
    // Even single-option guards and failed reads fit; grouping only lowers actual use.
    state.read_limit = state.inventory_read_limit + imageOptions * state.per_option_read_limit;
    state.scroll_limit = imageOptions;
  }
  read.observation = { observed_at: observation.observed_at, samples: observation.samples,
    ...(read.scroll ? { loading: observation.loading } : {}) };
}

/**
 * @param {object} state Saved journal. @param {object} target Identity. @param {number} attempts Task read reservations.
 * @returns {void} Replays accounting and schema checks without browser IO. @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateSpecificationCollection(state, target, op.attempts);
 */
export function validateSpecificationCollection(state, target, attempts) {
  try {
    const replay = newSpecificationCollection(state?.schema_version);
    if (!state || !Array.isArray(state.reads) || state.reads.length !== attempts || state.reads.length > 2403 ||
        !same({ ...state, ...(state.schema_version === 3 ? { read_limit: 3, scroll_limit: 0 } : {}), inventory: null, reads: [] }, replay)) throw invalid();
    for (const read of state.reads) {
      reserveSpecificationCollectionRead(replay);
      if (!same({ ...read, observation: null }, replay.reads.at(-1))) throw invalid();
      if (read.observation) {
        if (!same(Object.keys(read.observation).sort(), read.scroll ? ['loading', 'observed_at', 'samples'] : ['observed_at', 'samples'])) throw invalid();
        acceptSpecificationCollectionRead(replay, { schema_version: read.scroll ? 2 : 1, product_id: target.product_id, url: target.url,
          observed_at: read.observation.observed_at, inventory: state.inventory, samples: read.observation.samples,
          ...(read.scroll ? { loading: read.observation.loading } : {}) }, target);
      }
    }
    if (!same(state, replay)) throw invalid();
  } catch { throw invalid(); }
}

/**
 * @param {object} state Validated journal. @param {object} target Identity.
 * @returns {object} Every scanned label, all acquired images, attempts, explicit gaps and per-observation times.
 * @example specificationCollectionResult(state, target);
 */
export function specificationCollectionResult(state, target) {
  const options = entries(state);
  const imageOptions = options.filter(option => option.image_regions_seen > 0);
  const unresolved = imageOptions.filter(option => option.image_status !== 'loaded_image_link');
  const groups = state.inventory?.groups ?? [];
  const groupsOmitted = state.inventory ? state.inventory.groups_seen - groups.length : null;
  const optionsOmitted = state.inventory ? groups.reduce((sum, group) => sum + group.options_seen - group.options.length, 0) : null;
  const inventoryCovered = !!state.inventory && groupsOmitted === 0 && optionsOmitted === 0;
  const next = specificationCollectionPlan(state);
  const reason = next ? 'in_progress' : !state.inventory && state.schema_version === 3 ? 'inventory_read_limit'
    : unresolved.length === 0 && inventoryCovered ? 'scanned_image_options_obtained'
    : unresolved.length === 0 && state.inventory ? 'structure_scan_limit'
    : state.reads.length >= state.read_limit ? 'content_read_limit' : 'per_option_read_limit';
  return { schema_version: state.schema_version, product_id: target.product_id, url: target.url,
    source: 'bounded_specification_collection', inventory: state.inventory,
    inventory_observed_at: state.reads.find(read => read.observation)?.observation.observed_at ?? null, options,
    missing_images: unresolved.map(option => ({ group_position: option.group_position, position: option.position,
      label: option.label, reason: option.image_status, attempts: option.attempts })),
    unsupported_image_options: options.filter(option => !option.image_regions_seen).map(option => ({
      group_position: option.group_position, position: option.position, label: option.label, reason: option.image_status })),
    collection: { goal: 'all_specification_options_and_images_within_budget', next_read_available: next !== null,
      stop_reason: reason, content_reads_reserved: state.reads.length,
      observations_returned: state.reads.filter(read => read.observation).length,
      ...(state.schema_version === 3 ? { inventory_reads_reserved: state.reads.filter(read => read.inventory_only).length,
        image_reads_reserved: state.reads.filter(read => !read.inventory_only).length,
        budget_basis: { image_options: state.inventory ? imageOptions.length : null,
          formula: 'inventory_read_limit + image_options * reads_per_image_option', finalized: state.inventory !== null } } : {}),
      limits: { content_reads: state.read_limit, reads_per_image_option: state.per_option_read_limit, image_options_per_read: 5,
        ...(state.schema_version === 3 ? { inventory_reads: state.inventory_read_limit } : {}),
        ...(state.schema_version >= 2 ? { scroll_intents: state.scroll_limit, scroll_intents_per_option: 1 } : {}) },
      ...(state.schema_version >= 2 ? { loading_actions: state.reads.flatMap((read, index) => read.scroll ? [{
        read: index + 1, position: read.positions[0], expected_image: read.scroll.expected_image,
        observation: read.observation?.loading ?? null,
        acknowledgement: read.observation ? 'received' : 'unconfirmed',
        after_read: state.reads.findIndex(next => next.after_scroll === index + 1) >= 0
          ? state.reads.findIndex(next => next.after_scroll === index + 1) + 1 : null
      }] : []) } : {}) },
    coverage: { status: 'partial', scanned_inventory_complete: inventoryCovered, groups_omitted: groupsOmitted,
      options_omitted_in_scanned_groups: optionsOmitted, options_returned: options.length, image_options_seen: imageOptions.length,
      loaded_image_links: imageOptions.length - unresolved.length, unresolved_image_options: unresolved.length,
      unread_image_options: imageOptions.filter(option => option.attempts === 0).length,
      scanned_supported_image_links_complete: inventoryCovered && unresolved.length === 0,
      full_option_images: false, full_sku_matrix: false, cross_read_image_state_verified: false,
      file_downloaded: false, image_semantics_read: false, sku_price_binding_verified: false } };
}
