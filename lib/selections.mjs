import { createHash } from 'node:crypto';
import { ShoppingError, publicError } from './errors.mjs';
import { validateSavedProduct } from './product.mjs';

export const SELECTION_LIMITS = Object.freeze({ reads: 40, settling_reads: 8, confirmation_reads: 3, interval_ms: 1000, stable_ms: 2000, stable_samples: 3 });

/**
 * Validate exact group/option pairs; selections must name every visible specification group.
 * @param {unknown} value @returns {Array<{group: string, option: string}>}
 * @throws {ShoppingError} INVALID_SELECTION. @example normalizeSelection([{group:'颜色',option:'黑色'}])
 */
export function normalizeSelection(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new ShoppingError('INVALID_SELECTION', 'Specify 1–8 exact group/option pairs.');
  const seen = new Set();
  return value.map(choice => {
    if (!choice || Object.keys(choice).some(key => !['group', 'option'].includes(key)) ||
        typeof choice.group !== 'string' || typeof choice.option !== 'string' ||
        !choice.group.trim() || choice.group.length > 120 || !choice.option.trim() || choice.option.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(choice.group + choice.option) || seen.has(choice.group.trim())) {
      throw new ShoppingError('INVALID_SELECTION', 'Each group must have one nonempty exact option label; duplicate groups are not allowed.');
    }
    seen.add(choice.group.trim());
    return { group: choice.group.trim(), option: choice.option.trim() };
  });
}

/** @param {string} productId @param {Array} selection @returns {string} Stable logical operation key independent of input order. */
export function selectionKey(productId, selection) {
  return `${productId}:${JSON.stringify([...normalizeSelection(selection)].sort((a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : 0))}`;
}

/** @returns {object} Initial durable journal for one specified combination. */
export function newSelectionState() {
  return { phase: 'selecting', reads: 0, settling_reads: 0, dispatches: [], not_before: 0,
    baseline: null, last_signature: null, stable_since: 0, stable_samples: 0 };
}

/**
 * Reject corrupted selection journals before dispatch; every option gets at most one uncertain click.
 * @param {object} state @param {Array} selection @returns {void}
 * @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateSelectionState(state, selection) {
  const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  const hash = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  const invalid = () => { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved option-selection journal is invalid.'); };
  if (!state || !['selecting', 'settling'].includes(state.phase) || !integer(state.reads, 40) || !integer(state.settling_reads, 8) ||
      state.settling_reads > state.reads || !integer(state.not_before, Number.MAX_SAFE_INTEGER) ||
      !integer(state.stable_since, Number.MAX_SAFE_INTEGER) || !integer(state.stable_samples, 8) ||
      !hash(state.baseline) || !hash(state.last_signature) || !Array.isArray(state.dispatches) || state.dispatches.length > selection.length) invalid();
  const indexes = new Set();
  for (const entry of state.dispatches) {
    if (!integer(entry.choice_index, selection.length - 1) || indexes.has(entry.choice_index) ||
        !['reserved', 'confirmed'].includes(entry.status) || !integer(entry.checks, 3) ||
        (entry.error_code !== null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(entry.error_code))) invalid();
    indexes.add(entry.choice_index);
  }
}

function fingerprint(prices) { return createHash('sha256').update(JSON.stringify(prices)).digest('hex'); }

function locateChoices(snapshot, selection) {
  const scope = snapshot.specification_scope;
  if (scope && (scope.groups_omitted > 0 || scope.groups.some(group => group.options_omitted > 0))) {
    throw new ShoppingError('SELECTION_AMBIGUOUS', 'The specification list was truncated; a complete selection cannot be confirmed.');
  }
  const groups = snapshot.specification_groups;
  if (groups.length !== selection.length || groups.some(group => !selection.some(choice => choice.group === group.name))) {
    throw new ShoppingError('INCOMPLETE_SELECTION', 'Specify exactly one option for every visible specification group.');
  }
  if (groups.some(group => group.options.filter(option => option.selected === true).length > 1)) {
    throw new ShoppingError('SELECTION_STATE_CONFLICT', 'A specification group reports multiple selected options.');
  }
  return selection.map(choice => {
    const matching = groups.filter(group => group.name === choice.group);
    const options = matching.length === 1 ? matching[0].options.filter(option => option.label === choice.option) : [];
    if (options.length !== 1) throw new ShoppingError('SELECTION_AMBIGUOUS', 'A requested group or option is missing or ambiguous.');
    return options[0];
  });
}

function selectedResult(snapshot, op, stable) {
  const state = op.selection_state;
  let priceState = 'unstable';
  if (!snapshot.prices.length) priceState = 'not_observed';
  else if (stable) {
    if (snapshot.prices.some(price => price.kind !== 'single_displayed')) priceState = 'range_or_unparsed';
    else if (!state.dispatches.length) priceState = 'existing_selection_stable';
    else priceState = fingerprint(snapshot.prices) === state.baseline ? 'unchanged_after_selection' : 'changed_and_stable';
  }
  return { ...snapshot, selection_evidence: {
    requested: op.selection, status: 'confirmed', price_state: priceState,
    stable_samples: state.stable_samples, observation_count: state.reads, action_count: state.dispatches.length,
    method: 'bounded_dom_observations', sku_price_binding_verified: false,
  } };
}

/**
 * Validate cached selection evidence and its underlying public snapshot.
 * @param {object} result @param {object} target @param {Array} selection @param {object} [state] Persisted journal when available.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateSelectedResult(result, target, selection, state) {
  try {
    const { selection_evidence: evidence, ...snapshot } = result;
    validateSavedProduct(snapshot, target);
    if (!evidence || JSON.stringify(evidence.requested) !== JSON.stringify(selection) ||
        evidence.status !== 'confirmed' || evidence.method !== 'bounded_dom_observations' || evidence.sku_price_binding_verified !== false ||
        !['unstable', 'not_observed', 'range_or_unparsed', 'existing_selection_stable', 'unchanged_after_selection', 'changed_and_stable'].includes(evidence.price_state) ||
        !Number.isInteger(evidence.stable_samples) || evidence.stable_samples < 0 || evidence.stable_samples > 8 ||
        !Number.isInteger(evidence.observation_count) || evidence.observation_count < 1 || evidence.observation_count > 40 ||
        !Number.isInteger(evidence.action_count) || evidence.action_count < 0 || evidence.action_count > selection.length ||
        Object.keys(evidence).length !== 8 || locateChoices(snapshot, selection).some(option => option.selected !== true || option.disabled === true)) throw new Error();
    if (state && (state.dispatches.some(entry => entry.status !== 'confirmed') ||
        JSON.stringify(selectedResult(snapshot, { selection, selection_state: state }, state.stable_samples >= SELECTION_LIMITS.stable_samples)) !== JSON.stringify(result))) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved selection evidence does not match the requested combination.'); }
}

/**
 * Set a complete requested combination using a durable single-dispatch journal, then observe prices.
 * @param {{bridge: object, op: object, commit: () => Promise<void>, now: () => number, wait: (ms: number) => Promise<void>}} context
 * @returns {Promise<object>} Selection-confirmed snapshot with explicitly limited price evidence.
 * @throws {ShoppingError} Page gates, invalid options, uncertain outcome, or exhausted observation budget.
 */
export async function readSelectedProduct({ bridge, op, commit, now, wait }) {
  const state = op.selection_state;
  while (state.reads < SELECTION_LIMITS.reads) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved option wait is inconsistent with the current clock.');
      await wait(delay);
      continue;
    }
    if (state.phase === 'settling' && state.settling_reads >= SELECTION_LIMITS.settling_reads) {
      throw new ShoppingError('SELECTION_OBSERVATION_LIMIT', 'The price observation allowance was exhausted before a result was committed.');
    }
    state.reads += 1;
    if (state.phase === 'settling') state.settling_reads += 1;
    state.not_before = now() + SELECTION_LIMITS.interval_ms;
    await commit();
    const snapshot = await bridge.readProduct(op.tab_id, op.target);
    op.recovery_kind = null;
    const options = locateChoices(snapshot, op.selection);
    if (state.baseline === null) state.baseline = fingerprint(snapshot.prices);
    const pending = state.dispatches.find(entry => entry.status === 'reserved');
    if (pending) {
      if (options[pending.choice_index].selected === true) pending.status = 'confirmed';
      else {
        pending.checks += 1;
        await commit();
        if (pending.checks >= SELECTION_LIMITS.confirmation_reads) {
          throw new ShoppingError('SELECTION_OUTCOME_UNKNOWN', 'The previous selection was not observed. It will not be clicked again automatically.');
        }
        continue;
      }
    }
    if (options.some(option => option.disabled === true)) throw new ShoppingError('SELECTION_DISABLED', 'The requested combination contains a disabled option.');
    const next = options.findIndex(option => option.selected !== true);
    if (next !== -1) {
      if (state.phase === 'settling' || state.dispatches.some(entry => entry.choice_index === next)) {
        throw new ShoppingError('SELECTION_CHANGED', 'The page changed a previously confirmed selection.');
      }
      const entry = { choice_index: next, status: 'reserved', checks: 0, error_code: null };
      state.dispatches.push(entry);
      state.not_before = now() + 1500;
      await commit();
      try { await bridge.selectOption(op.tab_id, op.target, op.selection[next]); }
      catch (error) {
        if (error.actionNotDispatched) { state.dispatches.pop(); await commit(); throw error; }
        entry.error_code = publicError(error).code;
        await commit();
      }
      continue;
    }
    state.phase = 'settling';
    const signature = fingerprint(snapshot.prices);
    if (signature === state.last_signature) state.stable_samples = Math.min(state.stable_samples + 1, SELECTION_LIMITS.stable_samples);
    else { state.last_signature = signature; state.stable_samples = 1; state.stable_since = now(); }
    const stable = state.stable_samples >= SELECTION_LIMITS.stable_samples && now() - state.stable_since >= SELECTION_LIMITS.stable_ms;
    await commit();
    if (stable || state.settling_reads >= SELECTION_LIMITS.settling_reads) return selectedResult(snapshot, op, stable);
  }
  throw new ShoppingError('SELECTION_OBSERVATION_LIMIT', 'The bounded observation allowance for this combination was exhausted.');
}
