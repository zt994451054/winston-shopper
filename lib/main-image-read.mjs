import { ShoppingError, publicError } from './errors.mjs';
import { normalizeMainImages, validateMainImageObservation } from './main-images.mjs';

const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const keys = (value, names) => value && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ready = (observation, version) => observation.selected && observation.image?.loaded && (version === 2 || observation.image.uncovered);
const eligible = (step, observation, version) => ready(observation, version) && (step.before.selected ||
  step.action_reserved && observation.image.url !== step.before.image?.url);
const comparableImage = (image, version) => {
  if (!image || version === 1) return image;
  const { uncovered, ...data } = image;
  return data;
};
const stable = (a, b, version) => same(comparableImage(a.image, version), comparableImage(b.image, version)) && a.selected === b.selected;
const exhausted = () => new ShoppingError('MAIN_IMAGE_UNCONFIRMED', 'The selected main image was not confirmed within its read budget. Selection will not repeat.');
const invalid = () => new ShoppingError('INVALID_CHECKPOINT', 'The main image journal or saved result is invalid.');

/** @param {string[]} thumbnails @returns {object} At most four reads and one selection intent per thumbnail, twelve reads per batch. @throws {ShoppingError} INVALID_MAIN_IMAGES. @example newMainImageState(thumbnails); */
export function newMainImageState(thumbnails) {
  return { schema_version: 2, bound_tab_id: null, observations: 0, not_before: 0,
    steps: normalizeMainImages(thumbnails).map(thumbnail_url => ({ thumbnail_url, reads: 0, action_reserved: false,
      acknowledgement: null, acknowledgement_error: null, before: null, candidate: null, after: null, last_observation: null })) };
}

function validateObservationRead(read, step, target) {
  if (!keys(read, 'read_index,observation') || !integer(read.read_index, step.reads) || !read.read_index ||
      !step.before) throw invalid();
  validateMainImageObservation(read.observation, target, step.thumbnail_url);
}

function validateRead(read, step, target, version) {
  validateObservationRead(read, step, target);
  if (step.action_reserved && read.read_index < 2 || !eligible(step, read.observation, version)) throw invalid();
}

/** @param {object} state @param {object} target @param {string[]} thumbnails @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for forged bindings, counts or confirmation evidence. @example validateMainImageState(state, target, thumbnails); */
export function validateMainImageState(state, target, thumbnails) {
  try {
    normalizeMainImages(thumbnails);
    if (!keys(state, 'schema_version,bound_tab_id,observations,not_before,steps') || ![1, 2].includes(state.schema_version) ||
        !integer(state.observations, 12) || !integer(state.not_before, Number.MAX_SAFE_INTEGER) ||
        (state.observations ? !integer(state.bound_tab_id, Number.MAX_SAFE_INTEGER) || !state.bound_tab_id : state.bound_tab_id !== null) ||
        !Array.isArray(state.steps) || state.steps.length !== thumbnails.length) throw invalid();
    let reads = 0, unfinished = false;
    for (const [index, step] of state.steps.entries()) {
      if (!keys(step, 'thumbnail_url,reads,action_reserved,acknowledgement,acknowledgement_error,before,candidate,after' +
          (state.schema_version === 2 ? ',last_observation' : '')) ||
          step.thumbnail_url !== thumbnails[index] || !integer(step.reads, 4) || typeof step.action_reserved !== 'boolean' ||
          ![null, 'clicked', 'not_clicked'].includes(step.acknowledgement) ||
          step.acknowledgement_error !== null && (typeof step.acknowledgement_error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(step.acknowledgement_error)) ||
          step.acknowledgement !== null && step.acknowledgement_error !== null ||
          !step.action_reserved && (step.acknowledgement !== null || step.acknowledgement_error !== null) ||
          !step.reads && (step.before !== null || step.action_reserved || step.candidate !== null || step.after !== null) ||
          unfinished && step.reads) throw invalid();
      if (step.before !== null) validateMainImageObservation(step.before, target, step.thumbnail_url);
      if (step.action_reserved && (!step.before || step.before.selected)) throw invalid();
      if (state.schema_version === 2) {
        if ((step.last_observation === null) !== (step.before === null)) throw invalid();
        if (step.last_observation !== null) {
          validateObservationRead(step.last_observation, step, target);
          if (step.last_observation.read_index === 1 && !same(step.last_observation.observation, step.before) ||
              step.candidate !== null && !same(step.candidate, step.last_observation) ||
              step.after !== null && !same(step.after.second, step.last_observation)) throw invalid();
        }
      }
      if (step.candidate !== null || step.after !== null) {
        if (!step.before || !step.before.selected && !step.action_reserved) throw invalid();
        if (step.candidate !== null) {
          validateRead(step.candidate, step, target, state.schema_version);
          if (step.candidate.read_index !== step.reads || step.after !== null) throw invalid();
        }
        if (step.after !== null) {
          if (!keys(step.after, 'first,second')) throw invalid();
          validateRead(step.after.first, step, target, state.schema_version); validateRead(step.after.second, step, target, state.schema_version);
          if (step.after.second.read_index !== step.reads || step.after.first.read_index + 1 !== step.reads ||
              !stable(step.after.first.observation, step.after.second.observation, state.schema_version) ||
              Date.parse(step.after.second.observation.observed_at) < Date.parse(step.after.first.observation.observed_at)) throw invalid();
        }
      }
      reads += step.reads;
      if (!step.after) unfinished = true;
    }
    if (reads !== state.observations) throw invalid();
  } catch { throw invalid(); }
}

/** @param {object} state Validated main-image journal. @returns {object[]} Confirmed images only; incomplete requests stay outside this list. @example mainImageSamples(state); */
export function mainImageSamples(state) {
  return state.steps.filter(step => step.after).map(step => {
    const observation = step.after.second.observation;
    return { thumbnail_url: step.thumbnail_url, observed_at: observation.observed_at, image: observation.image,
      source: 'mainPic_within_unique_mainPicWrap',
      association: { selected_marker_verified: true, two_matching_observations: true,
        initially_selected: step.before.selected, image_url_changed_after_intent: step.action_reserved ? true : null,
        sku_id: null, sku_binding_verified: false },
      observations: { first_at: step.after.first.observation.observed_at, second_at: observation.observed_at },
      action: { reserved: step.action_reserved, acknowledgement: step.acknowledgement, error: step.acknowledgement_error } };
  });
}

function result(target, state) {
  return { schema_version: state.schema_version, product_id: target.product_id, url: target.url,
    source: state.schema_version === 1 ? 'visible_main_image_dom' : 'loaded_main_image_dom',
    samples: mainImageSamples(state), coverage: { status: 'partial', requested_images: state.steps.length,
      returned_images: state.steps.filter(step => step.after).length, full_gallery: false, file_downloaded: false,
      image_semantics_read: false, original_resolution_verified: false, video_read: false },
    limits: { requested_images: 3, observations: 12, observations_per_image: 4, selection_actions_per_image: 1 } };
}

/**
 * Deliver the last valid DOM read from the unfinished step without confirming the requested image.
 * @param {object} op Validated main-image operation; legacy journals return no additional data.
 * @returns {object[]} At most one observation, with freshness and an explicitly unverified association.
 * @example unconfirmedMainImageObservations(op);
 */
export function unconfirmedMainImageObservations(op) {
  const state = op.main_image_read;
  if (state.schema_version !== 2) return [];
  const step = state.steps.find(item => !item.after), last = step?.last_observation;
  if (!last) return [];
  return [{ requested_thumbnail_url: step.thumbnail_url, snapshot: structuredClone(last.observation),
    observation_is_latest_read: last.read_index === step.reads,
    original_tab_matches: state.bound_tab_id === op.tab_id,
    association: { requested_image_confirmed: false, sku_id: null, sku_binding_verified: false } }];
}

/** @param {object} saved @param {object} target @param {string[]} thumbnails @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for incomplete or altered results. @example validateMainImageResult(saved, target, thumbnails, state); */
export function validateMainImageResult(saved, target, thumbnails, state) {
  validateMainImageState(state, target, thumbnails);
  if (state.steps.some(step => !step.after) || !same(saved, result(target, state))) throw invalid();
}

/**
 * Read at most three static main images; save every read/selection intent before browser IO.
 * Selection acknowledgement is never sufficient. New attempts break consecutive confirmation, not budgets.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Images with selected-UI evidence and partial coverage; leaves the last image selected.
 * @throws {ShoppingError} Page/connection gates, MAIN_IMAGE_TAB_CHANGED or MAIN_IMAGE_UNCONFIRMED.
 * @example await runMainImages({ bridge, op, commit, now: Date.now, wait });
 */
export async function runMainImages({ bridge, op, commit, now, wait }) {
  const state = op.main_image_read;
  if (state.bound_tab_id !== null && state.bound_tab_id !== op.tab_id) {
    throw new ShoppingError('MAIN_IMAGE_TAB_CHANGED', 'Image selection evidence belongs to the original tab; it cannot be transferred to a replacement tab.');
  }
  const active = state.steps.find(step => !step.after);
  if (active?.candidate) { active.candidate = null; await commit(); }
  for (const step of state.steps) {
    while (!step.after) {
      if (step.reads >= 4 || state.observations >= 12) throw exhausted();
      const delay = state.not_before - now();
      if (delay > 0) {
        if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved main-image wait is inconsistent.');
        await wait(delay); continue;
      }
      const candidate = step.candidate;
      step.candidate = null; step.reads++; state.observations++; state.bound_tab_id = op.tab_id;
      state.not_before = now() + 1500;
      await commit();
      const observation = validateMainImageObservation(await bridge.readMainImage(op.tab_id, op.target, step.thumbnail_url), op.target, step.thumbnail_url);
      op.recovery_kind = null; state.not_before = now() + 1500;
      step.before ??= observation;
      if (state.schema_version === 2) step.last_observation = { read_index: step.reads, observation };
      if (!step.before.selected && !step.action_reserved) {
        if (4 - step.reads < 2) { await commit(); throw exhausted(); }
        step.action_reserved = true;
        await commit();
        try {
          const acknowledgement = await bridge.selectMainImage(op.tab_id, op.target, step.thumbnail_url);
          if (typeof acknowledgement?.clicked !== 'boolean') throw new ShoppingError('INVALID_RESPONSE', 'Invalid thumbnail selection acknowledgement.');
          step.acknowledgement = acknowledgement.clicked ? 'clicked' : 'not_clicked';
        } catch (error) {
          step.acknowledgement_error = publicError(error).code; await commit();
          if (error.actionNotDispatched || !['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE'].includes(error.code)) throw error;
        }
        state.not_before = now() + 1500;
      } else if (eligible(step, observation, state.schema_version)) {
        const read = { read_index: step.reads, observation };
        if (candidate && stable(candidate.observation, observation, state.schema_version) &&
            Date.parse(observation.observed_at) >= Date.parse(candidate.observation.observed_at)) step.after = { first: candidate, second: read };
        else step.candidate = read;
      }
      await commit();
    }
  }
  return result(op.target, state);
}
