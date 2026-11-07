import { ShoppingError, publicError } from './errors.mjs';

const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const errorCode = value => value === null || typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const ownsPanel = state => state.initial_state === 'closed' && state.open_acknowledgement === 'clicked' && state.open_confirmed;
const finished = ['preserved_initial', 'preserved_uncertain', 'preserved_changed_tab', 'already_closed', 'closed_confirmed'];

/** @returns {object} New-task journal: at most one close intent and three extra metadata reads. @example newReviewPanelLifecycle(); */
export function newReviewPanelLifecycle() {
  return { schema_version: 1, initial_state: null, open_acknowledgement: null, opened_tab_id: null,
    open_confirmed: false, status: 'pending', observations: 0, action_reserved: false,
    close_acknowledgement: null, acknowledgement_error: null, last_observation: null,
    last_read_error: null, closed_checks: 0, not_before: 0 };
}

/** @param {object} state Category journal. @param {object} observation Validated category observation. @returns {void} Record only witnessed initial/open states; inherited reads never establish ownership. @example recordReviewPanelObservation(state, observation); */
export function recordReviewPanelObservation(state, observation) {
  const panel = state.panel_lifecycle;
  if (!panel) return;
  if (panel.initial_state === null) {
    panel.initial_state = state.observations !== 1 || state.panel.action_reserved ? 'unknown' :
      observation.state === 'panel_action_required' ? 'closed' : observation.state === 'observed' ? 'open' : 'unknown';
  }
  if (observation.state === 'observed' && panel.open_acknowledgement === 'clicked') panel.open_confirmed = true;
}

/** @param {object} state Category journal. @param {{clicked: boolean}} acknowledgement @param {number} tabId @returns {void} Record a known reply, not ownership inferred from intent. @throws {ShoppingError} INVALID_RESPONSE for a malformed reply. @example recordReviewPanelOpening(state, { clicked: true }, 41); */
export function recordReviewPanelOpening(state, acknowledgement, tabId) {
  if (!state.panel_lifecycle) return;
  if (typeof acknowledgement?.clicked !== 'boolean') throw new ShoppingError('INVALID_RESPONSE', 'The review opening reply is invalid.');
  state.panel_lifecycle.open_acknowledgement = acknowledgement.clicked ? 'clicked' : 'not_clicked';
  if (acknowledgement.clicked) state.panel_lifecycle.opened_tab_id = tabId;
}

/** @param {object} state Category journal. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent ownership, results or cleanup budgets. @example validateReviewPanelLifecycle(state); */
export function validateReviewPanelLifecycle(state) {
  const panel = state.panel_lifecycle;
  if (!panel || Object.keys(panel).join(',') !== Object.keys(newReviewPanelLifecycle()).join(',') || panel.schema_version !== 1 ||
      ![null, 'unknown', 'open', 'closed'].includes(panel.initial_state) ||
      ![null, 'clicked', 'not_clicked'].includes(panel.open_acknowledgement) ||
      ![null, 'clicked', 'not_clicked'].includes(panel.close_acknowledgement) ||
      typeof panel.open_confirmed !== 'boolean' || typeof panel.action_reserved !== 'boolean' ||
      !['pending', ...finished].includes(panel.status) || !integer(panel.observations, 3) || !integer(panel.closed_checks, 2) ||
      !integer(panel.not_before, Number.MAX_SAFE_INTEGER) || !errorCode(panel.acknowledgement_error) || !errorCode(panel.last_read_error) ||
      ![null, 'open', 'closed'].includes(panel.last_observation)) throw invalid();
  if (panel.open_acknowledgement !== null && (!state.panel.action_reserved || panel.initial_state === null) ||
      (panel.open_acknowledgement === 'clicked' ? !integer(panel.opened_tab_id, Number.MAX_SAFE_INTEGER) || panel.opened_tab_id < 1 : panel.opened_tab_id !== null) ||
      panel.open_confirmed && (panel.open_acknowledgement !== 'clicked' || state.observations < 2) ||
      panel.initial_state !== null && !state.observations) throw invalid();
  if (panel.observations && (!ownsPanel(panel) || state.steps.some(step => !step.after)) ||
      panel.action_reserved && (!ownsPanel(panel) || !panel.observations) ||
      !panel.action_reserved && (panel.close_acknowledgement !== null || panel.acknowledgement_error !== null || panel.closed_checks) ||
      !panel.observations && (panel.last_observation !== null || panel.last_read_error !== null) ||
      panel.closed_checks && (panel.last_observation !== 'closed' || panel.last_read_error !== null || panel.closed_checks >= panel.observations)) throw invalid();
  if (finished.includes(panel.status) && state.steps.some(step => !step.after) ||
      panel.status === 'preserved_initial' && (panel.initial_state !== 'open' || panel.observations) ||
      panel.status === 'preserved_uncertain' && (ownsPanel(panel) || panel.initial_state === 'open' || panel.observations) ||
      panel.status === 'preserved_changed_tab' && !ownsPanel(panel) ||
      panel.status === 'already_closed' && (panel.action_reserved || !panel.observations || panel.last_observation !== 'closed') ||
      panel.status === 'closed_confirmed' && (!panel.action_reserved || panel.closed_checks !== 2 || panel.last_read_error !== null)) throw invalid();
}

function invalid() { return new ShoppingError('INVALID_CHECKPOINT', 'The review panel ownership or cleanup journal is invalid.'); }

/** @param {object} state Validated category journal. @returns {object|undefined} Public lifecycle evidence; absent for old tasks, no local tab identifier. @example reviewPanelLifecycleEvidence(state); */
export function reviewPanelLifecycleEvidence(state) {
  const panel = state.panel_lifecycle;
  if (!panel) return undefined;
  const { opened_tab_id, not_before, ...evidence } = panel;
  return { ...evidence, limits: { observations: 3, close_actions: 1, closed_confirmations: 2 } };
}

/**
 * Restore only a panel this task verifiably opened, after all requested text samples succeed.
 * Failed sampling performs no cleanup; an interrupted/uncertain close is never repeated.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<void>} Completion or an explicit preserved-state outcome.
 * @throws {ShoppingError} Gates, identity/structure errors or REVIEW_PANEL_CLEANUP_UNCONFIRMED.
 * @example await restoreReviewPanel({ bridge, op, commit, now: Date.now, wait });
 */
export async function restoreReviewPanel({ bridge, op, commit, now, wait }) {
  const state = op.category_read, panel = state.panel_lifecycle;
  if (!panel || finished.includes(panel.status)) return;
  if (state.steps.some(step => !step.after)) throw invalid();
  if (!ownsPanel(panel) || panel.opened_tab_id !== op.tab_id) {
    panel.status = panel.initial_state === 'open' ? 'preserved_initial' : !ownsPanel(panel) ? 'preserved_uncertain' : 'preserved_changed_tab';
    await commit(); return;
  }
  while (panel.observations < 3) {
    const delay = Math.max(panel.not_before, state.not_before) - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved panel cleanup wait is inconsistent.');
      await wait(delay); continue;
    }
    const priorClosed = panel.closed_checks;
    panel.closed_checks = 0; panel.observations++; panel.last_observation = null; panel.last_read_error = null;
    panel.not_before = now() + 1500;
    await commit();
    let observation;
    try {
      observation = await bridge.readReviewPanelState(op.tab_id, op.target);
      if (!['open', 'closed'].includes(observation?.state)) throw new ShoppingError('INVALID_RESPONSE', 'The panel state reply is invalid.');
    } catch (error) { panel.last_read_error = publicError(error).code; await commit(); throw error; }
    panel.last_observation = observation.state; panel.not_before = now() + 1500; op.recovery_kind = null;
    if (observation.state === 'closed') {
      if (!panel.action_reserved) panel.status = 'already_closed';
      else {
        panel.closed_checks = priorClosed + 1;
        if (panel.closed_checks === 2) panel.status = 'closed_confirmed';
      }
      await commit();
      if (finished.includes(panel.status)) return;
      continue;
    }
    if (!panel.action_reserved) {
      // A first read after interruption may consume the room needed for two post-action confirmations.
      if (3 - panel.observations < 2) { await commit(); break; }
      panel.action_reserved = true;
      await commit();
      try {
        const acknowledgement = await bridge.closeReviewPanel(op.tab_id, op.target);
        if (typeof acknowledgement?.clicked !== 'boolean') throw new ShoppingError('INVALID_RESPONSE', 'The panel close reply is invalid.');
        panel.close_acknowledgement = acknowledgement.clicked ? 'clicked' : 'not_clicked';
      } catch (error) {
        panel.acknowledgement_error = publicError(error).code; await commit();
        if (error.actionNotDispatched || !['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE'].includes(error.code)) throw error;
      }
      panel.not_before = now() + 1500;
    }
    await commit();
  }
  throw new ShoppingError('REVIEW_PANEL_CLEANUP_UNCONFIRMED', 'Review text is saved, but panel restoration could not be confirmed within its budget. No close will repeat.');
}
