import { ShoppingError, publicError } from './errors.mjs';
import { descriptionImagePosition, descriptionImageEntry, canLoadDescriptionImage, sameDescriptionImageScope,
  validateSavedDescriptionImageObservation } from './description-image-loading.mjs';

/** @param {number} position Original description IMG position. @returns {object} One-scroll journal, six content reservations and three post-checks. @throws {ShoppingError} INVALID_ARGUMENTS. @example newDescriptionImageState(1); */
export function newDescriptionImageState(position) {
  return { schema_version: 1, position: descriptionImagePosition(position), observations: 0, checks: 0, confirmations: 0,
    action_reserved: false, scrolled: null, guard_reason: null, acknowledgement_error: null, initial: null, guard: null, last: null,
    not_before: 0, pace_wait_ms: 0 };
}

function ready(observation) {
  return Boolean(observation?.scope.owned && observation.scope.geometry && descriptionImageEntry(observation)?.status === 'normal_size_loaded');
}

/** @param {object} state Persistent source/action journal. @param {object} target Bound product. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for incompatible counts, sources or confirmations. @example validateDescriptionImageState(state, target); */
export function validateDescriptionImageState(state, target) {
  const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  try {
    if (!state || Object.keys(state).sort().join(',') !== 'acknowledgement_error,action_reserved,checks,confirmations,guard,guard_reason,initial,last,not_before,observations,pace_wait_ms,position,schema_version,scrolled' ||
        state.schema_version !== 1 || !integer(state.observations, 6) || !integer(state.checks, 3) || !integer(state.confirmations, 2) ||
        state.checks > state.observations || typeof state.action_reserved !== 'boolean' || ![null, true, false].includes(state.scrolled) ||
        ![null, 'already_ready', 'already_in_view', 'offscreen_resource'].includes(state.guard_reason) ||
        !integer(state.not_before, Number.MAX_SAFE_INTEGER) || !integer(state.pace_wait_ms, 9000) || state.pace_wait_ms % 1500 ||
        state.acknowledgement_error !== null && (typeof state.acknowledgement_error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(state.acknowledgement_error))) throw new Error();
    descriptionImagePosition(state.position);
    for (const value of [state.initial, state.guard, state.last]) if (value !== null) validateSavedDescriptionImageObservation(value, target, state.position);
    if (Boolean(state.initial) !== Boolean(state.last) || state.initial && !state.observations ||
        state.action_reserved && (!state.initial || !canLoadDescriptionImage(state.initial) || state.observations < 2) ||
        !state.action_reserved && (state.scrolled !== null || state.guard_reason !== null || state.guard !== null || state.acknowledgement_error !== null || state.checks) ||
        state.scrolled === true && state.guard_reason !== 'offscreen_resource' || state.guard_reason === 'offscreen_resource' && state.scrolled !== true ||
        Boolean(state.guard) !== (state.scrolled !== null) || Boolean(state.guard) !== (state.guard_reason !== null) ||
        state.guard && (!sameDescriptionImageScope(state.initial, state.guard) || descriptionImageEntry(state.initial)?.url !== descriptionImageEntry(state.guard)?.url) ||
        state.scrolled === true && !canLoadDescriptionImage(state.guard) || state.guard_reason === 'already_ready' && !ready(state.guard) ||
        state.guard_reason === 'already_in_view' && !state.guard.scope.geometry?.fully_in_view ||
        state.guard && state.guard_reason !== 'already_ready' && ['loaded', 'width', 'height'].some(key => descriptionImageEntry(state.guard)[key] !== descriptionImageEntry(state.initial)[key]) ||
        state.last && !state.checks && JSON.stringify(state.last) !== JSON.stringify(state.initial) ||
        state.confirmations && (!state.action_reserved || !ready(state.last) || !sameDescriptionImageScope(state.initial, state.last) || state.confirmations > state.checks)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The description image loading journal is invalid.'); }
}

function imageResult(state) {
  if (!state.initial) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'No valid image observation was obtained within the original budget.');
  const passive = !canLoadDescriptionImage(state.initial);
  if (!passive && !state.action_reserved || !passive && state.confirmations !== 2 && state.checks < 3 && state.observations < 6) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The description image result precedes its bounded observation outcome.');
  }
  const status = passive ? ready(state.initial) ? 'already_ready' : 'target_unverified'
    : state.confirmations === 2 ? 'normal_image_confirmed' : 'image_unresolved';
  return { ...state.last.snapshot, description_image_loading: { schema_version: 1, position: state.position, status,
    initial_image: descriptionImageEntry(state.initial), final_image: descriptionImageEntry(state.last),
    initial_observed_at: state.initial.snapshot.observed_at, final_observed_at: state.last.snapshot.observed_at,
    source_scope: state.last.scope, guard_scope: state.guard?.scope ?? null, guard_observed_at: state.guard?.snapshot.observed_at ?? null,
    actions_reserved: Number(state.action_reserved), scrolled: state.scrolled,
    guard_reason: state.guard_reason, acknowledgement_error: state.acknowledgement_error,
    observations_reserved: state.observations, post_checks_reserved: state.checks,
    normal_image_stability_confirmed: state.confirmations === 2, physical_element_identity_verified: false,
    scrolling_caused_loading_verified: false, full_description_verified: false, sku_id: null, sku_price_binding_verified: false } };
}

/** @param {object} result Saved delivery. @param {object} target Bound product. @param {object} state Journal. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT. @example validateDescriptionImageResult(result, target, state); */
export function validateDescriptionImageResult(result, target, state) {
  try {
    validateDescriptionImageState(state, target);
    if (!state.initial || JSON.stringify(imageResult(state)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The description image result does not match its journal.'); }
}

/**
 * Observe one requested description image, reserve at most one scroll, then finitely re-read.
 * The guard counts as a content read; failures and interruption never refund or replay it.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Current details plus bounded image evidence, including unresolved outcomes.
 * @throws {ShoppingError} Identity, gates, invalid source, interruption or exhausted fault budget.
 * @example runDescriptionImageRead({bridge, op, commit, now: Date.now, wait});
 */
export async function runDescriptionImageRead({ bridge, op, commit, now, wait }) {
  const state = op.description_image_read;
  const reserve = async () => {
    if (state.observations >= 6) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The original image observation budget is exhausted.');
    state.observations++; await commit();
  };
  const pace = async () => { state.not_before = now() + 1500; state.pace_wait_ms += 1500; await commit(); };
  while (state.observations < 6 && state.checks < 3) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The description image wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (!state.initial) {
      await reserve();
      const observation = await bridge.readDescriptionImageLoading(op.tab_id, op.target, state.position);
      state.initial = observation; state.last = observation; op.recovery_kind = null; await commit();
      if (!canLoadDescriptionImage(observation)) return imageResult(state);
    }
    if (!state.action_reserved) {
      if (state.observations >= 4) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'No budget remains for the scroll guard and two observations.');
      state.action_reserved = true; state.observations++; await commit();
      try {
        const acknowledgement = await bridge.scrollDescriptionImage(op.tab_id, op.target, state.position, state.initial);
        state.guard = acknowledgement.observation; state.scrolled = acknowledgement.scrolled; state.guard_reason = acknowledgement.reason;
      } catch (error) {
        state.acknowledgement_error = publicError(error).code; await commit();
        if (error.actionNotDispatched || !['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE'].includes(error.code)) throw error;
      }
      await pace(); continue;
    }
    state.checks++; await reserve();
    let current;
    try { current = await bridge.readDescriptionImageLoading(op.tab_id, op.target, state.position); }
    catch (error) { state.confirmations = 0; await commit(); throw error; }
    op.recovery_kind = null;
    if (!sameDescriptionImageScope(state.initial, current)) {
      state.last = current; state.confirmations = 0; await commit();
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The requested description image position or container scope changed.');
    }
    const entry = descriptionImageEntry(current), previous = descriptionImageEntry(state.last);
    const stable = ready(current) && state.confirmations > 0 && ['url', 'width', 'height'].every(key => entry[key] === previous?.[key]);
    state.confirmations = ready(current) ? stable ? 2 : 1 : 0;
    state.last = current; await commit();
    if (state.confirmations === 2) return imageResult(state);
    if (state.observations < 6 && state.checks < 3) await pace();
  }
  return imageResult(state);
}
