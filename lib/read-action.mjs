import { ShoppingError, publicError } from './errors.mjs';
import { throwPageError } from './page-dom.mjs';
import { validateSavedSearch } from './search.mjs';
import { validateSavedReviews } from './reviews.mjs';

/** @returns {object} Durable budget for one navigation or review expansion and its observations. */
export function newReadActionState() {
  return { action_reserved: false, observations: 0, checks: 0, not_before: 0, acknowledgement_error: null };
}

/** @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent action budgets. */
export function validateReadActionState(state) {
  const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  if (!state || Object.keys(state).length !== 5 || typeof state.action_reserved !== 'boolean' ||
      !integer(state.observations, 8) || !integer(state.checks, 3) || state.checks > state.observations ||
      !integer(state.not_before, Number.MAX_SAFE_INTEGER) ||
      (state.action_reserved && !state.observations) ||
      (!state.action_reserved && state.acknowledgement_error !== null) ||
      (state.acknowledgement_error !== null && (typeof state.acknowledgement_error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(state.acknowledgement_error)))) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The saved navigation or review action journal is invalid.');
  }
}

/** @param {unknown} value @returns {{clicked: boolean}} Dispatch acknowledgement only. @throws {ShoppingError} Guard failures are definitely not dispatched; malformed acknowledgements are uncertain. */
export function validateReadActionAcknowledgement(value) {
  try { throwPageError(value?.state); }
  catch (error) { error.actionNotDispatched = true; throw error; }
  if (value?.state !== 'action_dispatched' || typeof value.clicked !== 'boolean') {
    throw new ShoppingError('INVALID_RESPONSE', 'The navigation or review acknowledgement is invalid.');
  }
  return { clicked: value.clicked };
}

function evidence(state) {
  return { status: 'observed', actions_reserved: Number(state.action_reserved), observations_reserved: state.observations,
    acknowledgement_error: state.acknowledgement_error };
}

/**
 * Revalidate cached results and evidence against the immutable journal.
 * @param {object} result @param {object} target @param {string} kind @param {object} state
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateReadActionResult(result, target, kind, state) {
  const { action_evidence: savedEvidence, ...data } = result;
  if (kind === 'search') validateSavedSearch(data, target);
  else validateSavedReviews(data, target);
  if (state.observations < 1 || JSON.stringify(savedEvidence) !== JSON.stringify(evidence(state))) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The saved result does not match its action journal.');
  }
}

/**
 * Execute one guarded navigation or expansion, preserving ambiguous dispatches across restarts.
 * @param {{kind: string, bridge: object, op: object, commit: () => Promise<void>, now: () => number, wait: (ms: number) => Promise<void>}} context
 * @returns {Promise<object>} Loaded results with durable observation evidence.
 * @throws {ShoppingError} Gates, connection failures, unknown outcome, or observation budget exhaustion.
 */
export async function runReadAction({ kind, bridge, op, commit, now, wait }) {
  const state = op.read_action;
  const observe = () => kind === 'search' ? bridge.readSearch(op.tab_id, op.target) : bridge.readReviews(op.tab_id, op.target);
  const act = () => kind === 'search' ? bridge.navigateSearch(op.tab_id, op.target) : bridge.expandReviews(op.tab_id, op.target);
  while (state.observations < 8) {
    if (state.checks >= 3) throw new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'The requested page or review panel was not observed. The action will not be repeated.');
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved observation wait is inconsistent with the current clock.');
      await wait(delay); continue;
    }
    state.observations += 1; state.not_before = now() + 1500;
    await commit();
    const observation = await observe();
    op.recovery_kind = null;
    if (observation.state === 'ready') return { ...observation.result, action_evidence: evidence(state) };
    if (observation.state === 'action_required' && !state.action_reserved) {
      state.action_reserved = true;
      await commit();
      try { await act(); }
      catch (error) {
        if (error.actionNotDispatched) { state.action_reserved = false; await commit(); throw error; }
        state.acknowledgement_error = publicError(error).code;
      }
    } else {
      state.checks += 1;
    }
    await commit();
    if (state.checks >= 3) throw new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'The requested page or review panel was not observed. The action will not be repeated.');
  }
  throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The bounded observation allowance was exhausted.');
}
