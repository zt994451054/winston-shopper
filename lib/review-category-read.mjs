import { ShoppingError, publicError } from './errors.mjs';
import { normalizeReviewCategoryPlan, reviewListKey, validateReviewCategorySnapshot } from './review-categories.mjs';
import { newReviewObservationDelivery, reserveReviewObservation, recordReviewObservation,
  failReviewObservation, validateReviewObservationDelivery } from './review-observations.mjs';
import { newReviewPanelLifecycle, recordReviewPanelObservation, recordReviewPanelOpening,
  validateReviewPanelLifecycle, reviewPanelLifecycleEvidence, restoreReviewPanel } from './review-panel-lifecycle.mjs';

const newStep = requested => ({ requested, before: null, action_reserved: false,
  acknowledgement_error: null, checks: 0, candidate: null, after: null });
const desiredLabel = step => step.requested ?? step.before?.selected_category;
const sameList = (left, right) => reviewListKey(left.reviews) === reviewListKey(right.reviews);
const sameObservation = (left, right) => sameList(left, right) && left.reviews.loaded_count === right.reviews.loaded_count &&
  left.reviews.fold_notice_text === right.reviews.fold_notice_text && left.sort_text === right.sort_text &&
  JSON.stringify(left.categories) === JSON.stringify(right.categories);
const qualifies = (step, snapshot) => snapshot.selected_category === desiredLabel(step) &&
  snapshot.sort_text === step.before.sort_text && (!step.action_reserved || !sameList(step.before, snapshot));
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** @param {Array<string|null>} plan @returns {object} Three categories, twelve sampling reads, one open and one intent per category; new tasks also allow one owned-panel close and three cleanup reads. @throws {ShoppingError} INVALID_REVIEW_CATEGORIES. @example newReviewCategoryState([null]); */
export function newReviewCategoryState(plan) {
  return { observations: 0, not_before: 0,
    panel: { action_reserved: false, checks: 0, acknowledgement_error: null },
    steps: normalizeReviewCategoryPlan(plan).map(newStep), observation_delivery: newReviewObservationDelivery(),
    panel_lifecycle: newReviewPanelLifecycle() };
}

/** @param {object} state @param {object} target @param {Array<string|null>} plan @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent budgets or category evidence. @example validateReviewCategoryState(state, target, ['全部']); */
export function validateReviewCategoryState(state, target, plan) {
  try {
    const normalized = normalizeReviewCategoryPlan(plan);
    const deliveryEnabled = Object.hasOwn(state, 'observation_delivery');
    const lifecycleEnabled = Object.hasOwn(state, 'panel_lifecycle');
    const keys = `observations,not_before,panel,steps${deliveryEnabled ? ',observation_delivery' : ''}${lifecycleEnabled ? ',panel_lifecycle' : ''}`;
    if (Object.keys(state).join(',') !== keys || !integer(state.observations, 12) ||
        !integer(state.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(state.steps) || state.steps.length !== normalized.length) throw new Error();
    const panel = state.panel;
    if (Object.keys(panel).join(',') !== 'action_reserved,checks,acknowledgement_error' || typeof panel.action_reserved !== 'boolean' ||
        !integer(panel.checks, 3) || panel.checks > state.observations || panel.action_reserved && !state.observations ||
        !(panel.acknowledgement_error === null || panel.action_reserved && typeof panel.acknowledgement_error === 'string' &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(panel.acknowledgement_error))) throw new Error();
    let priorUnfinished = false, minimumReads = 0;
    for (const [index, step] of state.steps.entries()) {
      if (Object.keys(step).join(',') !== Object.keys(newStep(null)).join(',') || step.requested !== normalized[index] ||
          typeof step.action_reserved !== 'boolean' || !integer(step.checks, 3) ||
          !(step.acknowledgement_error === null || typeof step.acknowledgement_error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(step.acknowledgement_error))) throw new Error();
      if (!step.before) {
        if (step.action_reserved || step.checks || step.candidate || step.after || step.acknowledgement_error) throw new Error();
      } else {
        if (priorUnfinished) throw new Error();
        validateReviewCategorySnapshot(step.before, target);
        minimumReads += 1 + step.checks;
        const desired = step.before.categories.find(category => category.label === desiredLabel(step));
        if (!desired || desired.disabled || !desired.in_viewport) throw new Error();
        if (step.action_reserved === (step.before.selected_category === desiredLabel(step))) throw new Error();
        if (!step.action_reserved && step.acknowledgement_error) throw new Error();
      }
      if (step.candidate) {
        validateReviewCategorySnapshot(step.candidate, target);
        if (!step.before || !qualifies(step, step.candidate) || step.action_reserved && step.checks < 1) throw new Error();
      }
      if (step.after) {
        validateReviewCategorySnapshot(step.after, target);
        if (!step.candidate || step.checks < (step.action_reserved ? 2 : 1) ||
            !qualifies(step, step.after) || !sameObservation(step.candidate, step.after)) throw new Error();
      } else priorUnfinished = true;
    }
    if (minimumReads + Number(panel.action_reserved) > state.observations) throw new Error();
    if (deliveryEnabled) validateReviewObservationDelivery(state, target);
    if (lifecycleEnabled) validateReviewPanelLifecycle(state);
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The text review category journal is invalid.'); }
}

function resultFor(target, plan, state) {
  return { schema_version: 1, product_id: target.product_id, url: target.url, source: 'bounded_review_category_text',
    requested_categories: plan, samples: state.steps.map(step => ({ category: desiredLabel(step),
      reviews: step.after.reviews, category_catalogue: step.after.categories, sort_text: step.after.sort_text,
      association: { basis: 'selected_marker_and_two_matching_text_observations',
        category_ui_verified: true, content_changed_after_switch: step.action_reserved, filter_algorithm_verified: false } })),
    coverage: { status: 'partial', order: 'page_display_order', all_categories_read: false,
      unique_review_count: null, latest_order_verified: false, media_read: false },
    limits: { categories: 3, main_review_positions_per_category: 10, observations: 12, checks_per_category: 3 },
    action_evidence: { observations_reserved: state.observations,
      panel: { action_reserved: state.panel.action_reserved, acknowledgement_error: state.panel.acknowledgement_error },
      actions_reserved: state.steps.filter(step => step.action_reserved).length,
      categories: state.steps.map(step => ({ category: desiredLabel(step), action_reserved: step.action_reserved,
        acknowledgement_error: step.acknowledgement_error })) },
    ...(state.panel_lifecycle ? { panel_lifecycle: reviewPanelLifecycleEvidence(state) } : {}),
    excluded: ['review_images', 'review_videos'], login_verified: false };
}

/** @param {object} value @param {object} target @param {Array<string|null>} plan @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when completed samples disagree with their journal. @example validateReviewCategoryResult(result, target, [null], state); */
export function validateReviewCategoryResult(value, target, plan, state) {
  validateReviewCategoryState(state, target, plan);
  if (state.steps.some(step => !step.after) || state.panel_lifecycle?.status === 'pending' || JSON.stringify(value) !== JSON.stringify(resultFor(target, plan, state))) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'The text review samples do not match their journal.');
  }
}

function startStep(step, snapshot) {
  const label = step.requested ?? snapshot.selected_category;
  const category = snapshot.categories.find(category => category.label === label);
  if (!category || category.disabled || !category.in_viewport) {
    throw new ShoppingError('REVIEW_CATEGORY_UNAVAILABLE', 'The requested category is missing, disabled or outside the viewport.');
  }
  step.before = snapshot;
  step.action_reserved = label !== snapshot.selected_category;
  if (!step.action_reserved) step.candidate = snapshot;
}

/**
 * Sample the current or explicitly requested text categories without pagination or repeated clicks.
 * Opens a uniquely verified normal entry at most once and restores a verifiably owned panel after success.
 * Sampling and cleanup have separate fixed read limits; every intent is durable before IO.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} At most three category samples, ten loaded main-review positions each.
 * @throws {ShoppingError} Gates, unknown category outcome or exhausted observation budget.
 * @example await runReviewCategories({ bridge, op, commit, now: Date.now, wait });
 */
export async function runReviewCategories({ bridge, op, commit, now, wait }) {
  const state = op.category_read;
  while (state.steps.some(step => !step.after) && state.observations < 12) {
    const step = state.steps.find(step => !step.after);
    if (step.checks >= 3) throw new ShoppingError('REVIEW_CATEGORY_OUTCOME_UNKNOWN', 'Category content could not be confirmed; its action will not be repeated.');
    if (!state.steps[0].before && state.panel.checks >= 3) throw new ShoppingError('ACTION_OUTCOME_UNKNOWN', 'The review panel did not become readable; its opening will not repeat.');
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved review observation wait is inconsistent.');
      await wait(delay); continue;
    }
    const priorCandidate = step.candidate;
    // An interrupted or gated read breaks consecutive confirmation; its old candidate cannot survive recovery.
    step.candidate = null;
    state.observations++; state.not_before = now() + 1500;
    reserveReviewObservation(state, state.steps.indexOf(step));
    await commit();
    let observation;
    try { observation = await bridge.readReviewCategories(op.tab_id, op.target); }
    catch (error) {
      failReviewObservation(state, publicError(error).code);
      await commit();
      throw error;
    }
    recordReviewObservation(state, observation);
    recordReviewPanelObservation(state, observation);
    op.recovery_kind = null; state.not_before = now() + 1500;
    if (!step.before && ['panel_action_required', 'waiting_result'].includes(observation.state)) {
      if (state.steps[0].before) throw new ShoppingError('REVIEW_PANEL_REQUIRED', 'The review panel disappeared after category sampling began.');
      if (observation.state === 'panel_action_required' && !state.panel.action_reserved) {
        state.panel.action_reserved = true;
        await commit();
        try { recordReviewPanelOpening(state, await bridge.openReviewPanel(op.tab_id, op.target), op.tab_id); }
        catch (error) {
          state.panel.acknowledgement_error = publicError(error).code;
          await commit();
          if (error.actionNotDispatched || !['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE'].includes(error.code)) throw error;
        }
        state.not_before = now() + 1500;
      } else state.panel.checks++;
      await commit(); continue;
    }
    if (!step.before) {
      if (observation.state !== 'observed') throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The starting category has no supported text list.');
      startStep(step, observation.snapshot);
      await commit();
      if (step.action_reserved) {
        try { await bridge.selectReviewCategory(op.tab_id, op.target, step.before, desiredLabel(step)); }
        catch (error) {
          step.acknowledgement_error = publicError(error).code;
          await commit();
          if (error.actionNotDispatched || !['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE'].includes(error.code)) throw error;
        }
        state.not_before = now() + 1500;
      }
    } else {
      step.checks++;
      if (observation.state === 'observed' && qualifies(step, observation.snapshot)) {
        step.candidate = observation.snapshot;
        if (priorCandidate && sameObservation(priorCandidate, observation.snapshot)) step.after = observation.snapshot;
      } else step.candidate = null;
    }
    if (step.after && state.observation_delivery) state.observation_delivery.last_observation = null;
    await commit();
  }
  if (state.steps.some(step => !step.after)) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The text category observation budget is exhausted.');
  await restoreReviewPanel({ bridge, op, commit, now, wait });
  return resultFor(op.target, op.review_categories, state);
}
