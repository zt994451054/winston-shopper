import { ShoppingError, publicError } from './errors.mjs';
import { validateSavedDetails } from './details.mjs';
import { serviceEntryScript } from './service-entry.mjs';

/** @returns {object} Persistent single-action service budget. @example newServiceReadState(); */
export function newServiceReadState() {
  return { action_reserved: false, labels: null, observations: 0, checks: 0, not_before: 0, acknowledgement_error: null };
}

/**
 * Validate the service journal without resetting failed or uncertain reservations.
 * @param {object} state @param {object} target
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateServiceReadState(state, target);
 */
export function validateServiceReadState(state, target) {
  const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  try {
    if (!state || Object.keys(state).sort().join(',') !== 'acknowledgement_error,action_reserved,checks,labels,not_before,observations' ||
        typeof state.action_reserved !== 'boolean' || !integer(state.observations, 8) || !integer(state.checks, 3) ||
        state.checks > state.observations || !integer(state.not_before, Number.MAX_SAFE_INTEGER) ||
        (state.action_reserved ? !state.observations || state.labels === null : state.labels !== null || state.acknowledgement_error !== null) ||
        (state.acknowledgement_error !== null && (typeof state.acknowledgement_error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(state.acknowledgement_error)))) throw new Error();
    if (state.labels !== null) serviceEntryScript(target, state.labels);
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'Invalid service expansion journal.'); }
}

function evidence(state) {
  return { status: 'panel_observed', actions_reserved: Number(state.action_reserved), observations_reserved: state.observations,
    acknowledgement_error: state.acknowledgement_error };
}

/**
 * Revalidate saved detail data and its service action evidence.
 * @param {object} result @param {object} target @param {object} state
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 * @example validateServiceReadResult(result, target, state);
 */
export function validateServiceReadResult(result, target, state) {
  const { service_evidence: saved, ...details } = result;
  validateSavedDetails(details, target);
  if (!state.observations || result.details.services.terms?.panel_observed !== true ||
      (state.labels && JSON.stringify(state.labels) !== JSON.stringify(result.details.services.labels)) ||
      JSON.stringify(saved) !== JSON.stringify(evidence(state))) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'Service results do not match the saved action evidence.');
  }
}

/**
 * Read service summaries, opening the inline entry only if needed; never replay a saved action.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Details with service evidence; incomplete linked rules remain unverified.
 * @throws {ShoppingError} Page/connection guards, changed labels, or bounded observation exhaustion.
 * @example runServiceRead({ bridge, op, commit, now: Date.now, wait });
 */
export async function runServiceRead({ bridge, op, commit, now, wait }) {
  const state = op.service_read;
  while (state.observations < 8 && state.checks < 3) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'Service observation wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    state.observations += 1; state.not_before = now() + 1500;
    await commit();
    const result = await bridge.readDetails(op.tab_id, op.target);
    op.recovery_kind = null;
    const { labels, terms } = result.details.services;
    if (state.labels && JSON.stringify(labels) !== JSON.stringify(state.labels)) {
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'Service labels changed after the saved expansion intent.');
    }
    if (terms?.panel_observed) return { ...result, service_evidence: evidence(state) };
    if (!terms || !labels.length) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'No supported service summary entry was observed.');
    if (!state.action_reserved && !terms.entry_expanded) {
      state.action_reserved = true; state.labels = [...labels];
      await commit();
      try { await bridge.expandServices(op.tab_id, op.target, state.labels); }
      catch (error) {
        state.acknowledgement_error = publicError(error).code;
        await commit();
        // Only ambiguous transport outcomes get a follow-up; guards and protocol errors retain their pause.
        if (error.actionNotDispatched || !['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE'].includes(error.code)) throw error;
      }
      state.not_before = now() + 1500;
    } else state.checks += 1;
    await commit();
  }
  throw new ShoppingError(state.checks >= 3 ? 'ACTION_OUTCOME_UNKNOWN' : 'ACTION_OBSERVATION_LIMIT',
    'The service panel was not confirmed within its observation budget. The action will not repeat.');
}
