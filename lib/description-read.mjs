import { ShoppingError, publicError } from './errors.mjs';
import { validateSavedDescriptionObservation, descriptionEntryStatus, sameDescriptionEntry } from './description-entry.mjs';

/** @returns {object} One-expansion journal with six shared content/guard reads and three post-checks. @example newDescriptionReadState(); */
export function newDescriptionReadState() {
  return { schema_version: 1, observations: 0, checks: 0, confirmations: 0, action_reserved: false,
    clicked: null, acknowledgement_error: null, initial: null, last: null, not_before: 0, pace_wait_ms: 0 };
}

function readable(observation) {
  const { text, observation: scope } = observation.snapshot.details.description;
  return descriptionEntryStatus(observation.entry) === 'expanded' && Boolean(text) && scope?.text_container_observed === true &&
    !scope.text_truncated && !scope.traversal_truncated && !scope.controls_truncated && scope.clipped_subtrees_omitted === 0;
}

/** @param {object} state Persistent journal. @param {object} target Bound product. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent evidence or budgets. @example validateDescriptionReadState(state, target); */
export function validateDescriptionReadState(state, target) {
  const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  try {
    if (!state || Object.keys(state).sort().join(',') !== 'acknowledgement_error,action_reserved,checks,clicked,confirmations,initial,last,not_before,observations,pace_wait_ms,schema_version' ||
        state.schema_version !== 1 || !integer(state.observations, 6) || !integer(state.checks, 3) ||
        !integer(state.confirmations, 2) || state.checks > state.observations || typeof state.action_reserved !== 'boolean' ||
        ![null, true, false].includes(state.clicked) || !integer(state.not_before, Number.MAX_SAFE_INTEGER) ||
        !integer(state.pace_wait_ms, 9000) || state.pace_wait_ms % 1500 ||
        (state.acknowledgement_error !== null && (typeof state.acknowledgement_error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(state.acknowledgement_error)))) throw new Error();
    for (const value of [state.initial, state.last]) if (value !== null) validateSavedDescriptionObservation(value, target);
    if (Boolean(state.initial) !== Boolean(state.last) || state.initial && !state.observations ||
        state.action_reserved && (!state.initial || descriptionEntryStatus(state.initial.entry) !== 'collapsed' || state.observations < 2) ||
        !state.action_reserved && (state.clicked !== null || state.acknowledgement_error !== null) ||
        state.confirmations && (!state.last || !readable(state.last) || state.confirmations > state.observations) ||
        state.initial && state.confirmations && !sameDescriptionEntry(state.initial.entry, state.last.entry) ||
        !state.action_reserved && state.confirmations && descriptionEntryStatus(state.initial.entry) !== 'expanded' ||
        state.confirmations === 2 && state.checks < (state.action_reserved ? 2 : 1) ||
        state.last && !state.checks && JSON.stringify(state.last) !== JSON.stringify(state.initial)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The description expansion journal is invalid.'); }
}

function expansionResult(state) {
  const initialStatus = descriptionEntryStatus(state.initial.entry), current = state.last;
  const passive = ['entry_not_observed', 'entry_unverified'].includes(initialStatus);
  if (!passive && (!readable(current) || state.confirmations !== 2)) {
    throw new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'Expanded description text has not been confirmed within its budget.');
  }
  const status = passive ? initialStatus : state.action_reserved ? 'expansion_observed' : 'already_expanded';
  return { ...current.snapshot, description_expansion: { schema_version: 1, status, entry: current.entry,
    initial_observed_at: state.initial.snapshot.observed_at, initial_text_characters: state.initial.snapshot.details.description.text.length,
    final_text_characters: current.snapshot.details.description.text.length,
    text_changed: current.snapshot.details.description.text !== state.initial.snapshot.details.description.text,
    same_entry_expanded_verified: !passive, text_stability_confirmed: !passive,
    actions_reserved: Number(state.action_reserved), clicked: state.clicked, observations_reserved: state.observations,
    post_checks_reserved: state.checks, acknowledgement_error: state.acknowledgement_error,
    full_description_verified: false } };
}

/** @param {object} result Cached result. @param {object} target Bound product. @param {object} state Journal. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for forged confirmations or changed data. @example validateDescriptionReadResult(result, target, state); */
export function validateDescriptionReadResult(result, target, state) {
  try {
    validateDescriptionReadState(state, target);
    if (!state.initial || JSON.stringify(expansionResult(state)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The description result does not match its journal.'); }
}

/**
 * Expand only an explicitly bound description entry once and confirm two consecutive readable texts.
 * Reads, the action guard, failures and interruptions share six reservations; unknown dispatch never repeats.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Details and scoped expansion evidence; no entry yields partial coverage without clicks.
 * @throws {ShoppingError} Gates, source changes, incomplete text or exhausted observation budgets.
 * @example runDescriptionRead({bridge, op, commit, now: Date.now, wait});
 */
export async function runDescriptionRead({ bridge, op, commit, now, wait }) {
  const state = op.description_read;
  const reserve = async () => {
    if (state.observations >= 6) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The description read budget is exhausted.');
    state.observations++; await commit();
  };
  const pace = async () => {
    state.not_before = now() + 1500; state.pace_wait_ms += 1500; await commit();
  };
  while (state.observations < 6 && state.checks < 3) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The description wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    if (!state.initial) {
      await reserve();
      const initial = await bridge.readDescriptionExpansion(op.tab_id, op.target);
      state.initial = initial; state.last = initial; op.recovery_kind = null; await commit();
      const status = descriptionEntryStatus(initial.entry);
      if (['entry_not_observed', 'entry_unverified'].includes(status)) return expansionResult(state);
      if (status === 'expanded') {
        state.confirmations = Number(readable(initial)); await pace(); continue;
      }
    }
    if (!state.action_reserved && descriptionEntryStatus(state.initial.entry) === 'collapsed') {
      // Reserve the guard and intent together so interruption cannot refund or replay the click.
      if (state.observations >= 4) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'No budget remains for the expansion guard and two follow-up reads.');
      state.action_reserved = true; state.observations++; await commit();
      try {
        const acknowledgement = await bridge.expandDescription(op.tab_id, op.target, state.initial.entry);
        state.clicked = acknowledgement.clicked;
      } catch (error) {
        state.acknowledgement_error = publicError(error).code; await commit();
        if (error.actionNotDispatched || !['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE'].includes(error.code)) throw error;
      }
      await pace(); continue;
    }
    state.checks++; await reserve();
    let current;
    try { current = await bridge.readDescriptionExpansion(op.tab_id, op.target); }
    catch (error) { state.confirmations = 0; await commit(); throw error; }
    op.recovery_kind = null;
    if (!sameDescriptionEntry(state.initial.entry, current.entry)) {
      state.last = current; state.confirmations = 0; await commit();
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The description control or container changed after the initial observation.');
    }
    const stable = readable(current) && state.confirmations > 0 &&
      state.last.snapshot.details.description.text === current.snapshot.details.description.text;
    state.confirmations = readable(current) ? stable ? 2 : 1 : 0;
    state.last = current; await commit();
    if (state.confirmations === 2) return expansionResult(state);
    if (state.observations < 6 && state.checks < 3) await pace();
  }
  throw new ShoppingError(state.checks >= 3 ? 'ACTION_OUTCOME_UNKNOWN' : 'ACTION_OBSERVATION_LIMIT',
    'The expanded description was not confirmed within its original budget. The action will not repeat.');
}
