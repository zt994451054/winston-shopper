import { validateReviewCategorySnapshot, reviewListKey } from './review-categories.mjs';

const phases = ['initial', 'after_switch', 'confirmation'];
const outcomes = ['reserved', 'observed', 'waiting_result', 'panel_action_required', 'error'];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const exactKeys = (value, keys) => value && Object.keys(value).join(',') === keys;
const requestedLabel = (step, snapshot) => step.requested ?? step.before?.selected_category ?? snapshot.selected_category;

/** @returns {object} Bounded delivery journal; absence on older checkpoints means not recorded. @example newReviewObservationDelivery(); */
export function newReviewObservationDelivery() {
  return { schema_version: 1, latest_read: null, last_observation: null };
}

/** @param {object} state @param {number} stepIndex @returns {void} Reserve metadata before IO without discarding the last valid text. @example reserveReviewObservation(state, 0); */
export function reserveReviewObservation(state, stepIndex) {
  if (!state.observation_delivery) return;
  const step = state.steps[stepIndex];
  state.observation_delivery.latest_read = { read_index: state.observations, step_index: stepIndex,
    phase: !step.before ? 'initial' : step.action_reserved ? 'after_switch' : 'confirmation',
    outcome: 'reserved', error_code: null };
}

/** @param {object} state @param {object} observation Validated bridge observation. @returns {void} Keep at most one valid snapshot, never a confirmation. @example recordReviewObservation(state, observation); */
export function recordReviewObservation(state, observation) {
  const delivery = state.observation_delivery;
  if (!delivery) return;
  delivery.latest_read.outcome = observation.state;
  if (observation.state === 'observed') {
    const { read_index, step_index, phase } = delivery.latest_read;
    delivery.last_observation = { read_index, step_index, phase, snapshot: observation.snapshot };
  }
}

/** @param {object} state @param {string} code Safe public error code. @returns {void} Mark a failed read while preserving older text and its time. @example failReviewObservation(state, 'BRIDGE_TIMEOUT'); */
export function failReviewObservation(state, code) {
  if (!state.observation_delivery) return;
  state.observation_delivery.latest_read.outcome = 'error';
  state.observation_delivery.latest_read.error_code = code;
}

/**
 * Validate delivery metadata against the existing task journal; it cannot authorize reads or confirmations.
 * @param {object} state @param {object} target @returns {void}
 * @throws {Error} Inconsistent metadata; the caller converts this to INVALID_CHECKPOINT.
 * @example validateReviewObservationDelivery(state, target);
 */
export function validateReviewObservationDelivery(state, target) {
  const delivery = state.observation_delivery;
  if (!exactKeys(delivery, 'schema_version,latest_read,last_observation') || delivery.schema_version !== 1) throw new Error('Invalid delivery journal');
  const latest = delivery.latest_read, saved = delivery.last_observation;
  if (latest === null) {
    if (saved !== null) throw new Error('Observation without a read');
    return;
  }
  const validReference = value => Number.isSafeInteger(value.read_index) && value.read_index > 0 && value.read_index <= state.observations &&
    Number.isSafeInteger(value.step_index) && value.step_index >= 0 && value.step_index < state.steps.length && phases.includes(value.phase);
  if (!exactKeys(latest, 'read_index,step_index,phase,outcome,error_code') || !validReference(latest) ||
      latest.read_index !== state.observations || !outcomes.includes(latest.outcome) ||
      (latest.outcome === 'error' ? typeof latest.error_code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(latest.error_code) : latest.error_code !== null)) {
    throw new Error('Invalid latest read');
  }
  const step = state.steps[latest.step_index];
  if (state.steps.slice(0, latest.step_index).some(prior => !prior.after) ||
      latest.phase === 'after_switch' && (!step.before || !step.action_reserved) ||
      latest.phase === 'confirmation' && (!step.before || step.action_reserved)) throw new Error('Invalid read phase');
  if (saved === null) {
    if (latest.outcome === 'observed' && !step.after) throw new Error('Missing observed text');
    return;
  }
  if (!exactKeys(saved, 'read_index,step_index,phase,snapshot') || !validReference(saved) ||
      saved.step_index !== latest.step_index || step.after || saved.read_index > latest.read_index) throw new Error('Invalid saved observation');
  validateReviewCategorySnapshot(saved.snapshot, target);
  if (saved.phase === 'initial' && step.before && !same(saved.snapshot, step.before) ||
      saved.phase === 'after_switch' && (!step.action_reserved || !step.checks) ||
      saved.phase === 'confirmation' && (!step.before || step.action_reserved || !step.checks)) throw new Error('Invalid observed phase');
  if (latest.outcome === 'observed' ? saved.read_index !== latest.read_index || saved.phase !== latest.phase : saved.read_index >= latest.read_index) {
    throw new Error('Observation does not match its read');
  }
}

function reasonsFor(step, observation) {
  const requested = requestedLabel(step, observation.snapshot);
  const reasons = [], snapshot = observation.snapshot;
  if (snapshot.selected_category !== requested) reasons.push('requested_category_not_selected');
  if (step.before && snapshot.sort_text !== step.before.sort_text) reasons.push('sort_changed');
  if (observation.phase === 'after_switch' && reviewListKey(snapshot.reviews) === reviewListKey(step.before.reviews)) {
    reasons.push('text_unchanged_after_switch');
  }
  if (observation.phase === 'initial' && step.action_reserved) reasons.push('no_post_switch_observation');
  return reasons.length ? reasons : ['consecutive_confirmation_not_completed'];
}

/**
 * Report the last valid unconfirmed text independently from confirmed category samples.
 * @param {object} state Validated category journal. @returns {Array<object>|undefined} Zero or one observations; undefined for legacy journals.
 * @example unconfirmedReviewObservations(state);
 */
export function unconfirmedReviewObservations(state) {
  const delivery = state.observation_delivery;
  if (!delivery) return undefined;
  const observation = delivery.last_observation;
  if (!observation) return [];
  const step = state.steps[observation.step_index];
  return [{ requested_category: requestedLabel(step, observation.snapshot),
    selected_category_observed: observation.snapshot.selected_category,
    read_index: observation.read_index, phase: observation.phase, snapshot: observation.snapshot,
    association: { status: 'unverified', category_ui_verified: false, filter_algorithm_verified: false,
      reasons: reasonsFor(step, observation) },
    observation_is_latest_read: observation.read_index === delivery.latest_read.read_index,
    latest_read: delivery.latest_read }];
}
