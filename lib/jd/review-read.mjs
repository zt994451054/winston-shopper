import { ShoppingError, publicError } from '../errors.mjs';
import { createBlockedPageDisplay } from '../foreground.mjs';
import { responseText } from '../page-dom.mjs';
import { normalizeReviewCategoryPlan } from '../review-categories.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { pageNotVisibleError, validateJdReviewObservation } from './review-categories.mjs';
import { parseJdProductUrl } from './targets.mjs';

// One product, one visit: open at most once, confirm each category, close only if this visit opened the panel.
const MAX_OBSERVATIONS = 20;
const MAX_OPEN_CHECKS = 3;
const MAX_CATEGORY_CHECKS = 4;
const MAX_CLOSE_READS = 3;
const MAX_CLOSED_STREAK = 2;
const OPEN_SETTLE_MS = 4_000;
const CATEGORY_SETTLE_MS = 4_000;
const RECHECK_MS = 2_000;
const CLOSE_SETTLE_MS = 2_000;
const SHOW_SETTLE_MS = 2_000;
const CLOCK_LIMIT_MS = 15_000;
const STATE_KEYS = ['categories_seen', 'close', 'not_before', 'observations', 'open', 'schema_version', 'sku_select_text', 'sort_text', 'steps'];
const OPEN_KEYS = ['acknowledgement', 'checks', 'confirmed', 'error', 'initial_state', 'reserved'];
const CLOSE_KEYS = ['acknowledgement', 'closed_streak', 'error', 'reads', 'reserved', 'status'];
const STEP_KEYS = ['acknowledgement', 'acknowledgement_error', 'action_reserved', 'after', 'before_cards', 'before_sort', 'candidate',
  'cards_seen', 'category', 'checks', 'count_text', 'list_changed', 'observed_at', 'requested'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const codeOk = value => value === null || (typeof value === 'string' && CODE.test(value));
const sent = acknowledgement => acknowledgement === 'clicked' || acknowledgement === 'uncertain';
const textOk = (value, max) => { try { return responseText(value, max) === value; } catch { return false; } };

function journalError() { return new ShoppingError('INVALID_CHECKPOINT', 'The JD review read journal is invalid.'); }
function resultError() { return new ShoppingError('INVALID_CHECKPOINT', 'The JD review result does not match its journal.'); }
function drawerError() {
  return new ShoppingError('REVIEW_DRAWER_NOT_VISIBLE', 'The mounted review content is outside the viewport or hidden.',
    'Preserve the task and its budget. Inspect the current panel without replaying prior actions or creating a replacement task.');
}
function outcomeError() {
  return new ShoppingError('REVIEW_CATEGORY_OUTCOME_UNKNOWN', 'Category content could not be confirmed; its action will not be repeated.');
}
function limitError() { return new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The JD review read budget is exhausted.'); }

/** A category click may have changed the list. A category that was already selected records null. */
function changedList(step) {
  if (!step.after || !step.action_reserved) return null;
  return JSON.stringify(step.before_cards) !== JSON.stringify(step.after);
}

function taskOpened(state) {
  return state.open.acknowledgement === 'clicked' && state.open.confirmed === true && state.open.initial_state === 'closed';
}

function validCards(cards) {
  if (!Array.isArray(cards) || cards.length > 10) return false;
  try {
    validateJdReviewObservation({
      state: 'observed', visible: true, entry: 'present', panel: 'open', tags: [], tags_seen: 0,
      sort_text: '', sku_select_text: '', cards, cards_seen: cards.length,
    });
    return true;
  } catch { return false; }
}

function validTags(tags) {
  if (!Array.isArray(tags) || tags.length > 30) return false;
  try {
    validateJdReviewObservation({
      state: 'observed', visible: true, entry: 'present', panel: 'open', tags, tags_seen: tags.length,
      sort_text: '', sku_select_text: '', cards: [], cards_seen: 0,
    });
    return true;
  } catch { return false; }
}

function blankStep(requested) {
  return {
    requested, category: null, count_text: null, acknowledgement: null, acknowledgement_error: null, action_reserved: false,
    before_cards: null, before_sort: null, candidate: null, after: null, observed_at: null, cards_seen: null, list_changed: null, checks: 0,
  };
}

/**
 * @param {Array<string|null>} plan One to three labels, or [null] for whichever tag is selected.
 * @returns {object} An empty journal. @throws {ShoppingError} INVALID_REVIEW_CATEGORIES.
 */
export function newJdReviewReadState(plan) {
  return {
    schema_version: 1, observations: 0, categories_seen: null, sort_text: null, sku_select_text: null,
    open: { acknowledgement: null, checks: 0, confirmed: false, error: null, initial_state: null, reserved: false },
    close: { acknowledgement: null, closed_streak: 0, error: null, reads: 0, reserved: false, status: null },
    steps: normalizeReviewCategoryPlan(plan).map(blankStep), not_before: 0,
  };
}

function validStep(step, requested, observations) {
  if (!sameKeys(step, STEP_KEYS) || step.requested !== requested || !integer(step.checks, MAX_CATEGORY_CHECKS) || step.checks > observations ||
      typeof step.action_reserved !== 'boolean' || ![null, 'clicked', 'uncertain'].includes(step.acknowledgement) || !codeOk(step.acknowledgement_error)) return false;
  if (step.acknowledgement !== null && !step.action_reserved) return false;
  if (step.category === null) {
    return step.count_text === null && step.before_sort === null && step.before_cards === null && step.candidate === null &&
      step.after === null && step.acknowledgement === null && !step.action_reserved && step.observed_at === null &&
      step.cards_seen === null && step.list_changed === null;
  }
  if (!textOk(step.category, 80) || !step.category || !textOk(step.count_text, 40) || !textOk(step.before_sort, 40)) return false;
  if (requested !== null && step.category !== requested) return false;
  if (step.action_reserved && !validCards(step.before_cards)) return false;
  if (!step.action_reserved && step.before_cards !== null) return false;
  if (step.candidate !== null && (!validCards(step.candidate) || step.candidate.length < 1)) return false;
  if ((step.after === null) !== (step.observed_at === null) || (step.after === null) !== (step.cards_seen === null)) return false;
  if (step.after === null) return step.list_changed === null;
  return step.checks >= 1 && validCards(step.after) && step.after.length >= 1 && JSON.stringify(step.candidate) === JSON.stringify(step.after) &&
    timestamp(step.observed_at) && integer(step.cards_seen, 10000) && step.cards_seen >= step.after.length && step.list_changed === changedList(step);
}

/**
 * Accept a partial journal, including a click reserved but not yet acknowledged.
 * Observations may exceed the sum of the phase counters: a resumed run can carry reads from an earlier visit.
 * @param {object} state @param {object} target Canonical JD product. @param {Array<string|null>} plan
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateJdReviewReadState(state, target, plan) {
  try {
    const canonical = parseJdProductUrl(target?.url);
    const labels = normalizeReviewCategoryPlan(plan);
    if (!canonical || JSON.stringify(canonical) !== JSON.stringify(target) || !sameKeys(state, STATE_KEYS) || state.schema_version !== 1 ||
        !integer(state.observations, MAX_OBSERVATIONS) || !integer(state.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(state.steps) ||
        state.steps.length !== labels.length) throw new Error();
    if ((state.categories_seen === null) !== (state.sort_text === null) || (state.sort_text === null) !== (state.sku_select_text === null)) throw new Error();
    if (state.categories_seen !== null && !validTags(state.categories_seen)) throw new Error();
    if (state.sort_text !== null && (!textOk(state.sort_text, 40) || !textOk(state.sku_select_text, 40))) throw new Error();
    if (!sameKeys(state.open, OPEN_KEYS) || !integer(state.open.checks, MAX_OPEN_CHECKS) || state.open.checks > state.observations ||
        typeof state.open.confirmed !== 'boolean' || typeof state.open.reserved !== 'boolean' || !codeOk(state.open.error) ||
        ![null, 'clicked', 'uncertain'].includes(state.open.acknowledgement) || ![null, 'open', 'closed'].includes(state.open.initial_state)) throw new Error();
    if ((state.open.acknowledgement !== null && !state.open.reserved) || (state.open.confirmed && state.open.initial_state === null)) throw new Error();
    if (!state.steps.every((step, index) => validStep(step, labels[index], state.observations))) throw new Error();
    if (state.steps.some(step => step.category !== null || step.candidate !== null || step.after !== null) && state.categories_seen === null) throw new Error();
    const spent = state.open.checks + state.steps.reduce((sum, step) => sum + step.checks, 0) + state.close.reads;
    const stepsDone = state.steps.every(step => step.after);
    if (spent > state.observations || !sameKeys(state.close, CLOSE_KEYS) || !integer(state.close.reads, MAX_CLOSE_READS) ||
        state.close.reads > state.observations || !integer(state.close.closed_streak, MAX_CLOSED_STREAK) || typeof state.close.reserved !== 'boolean' ||
        !codeOk(state.close.error) || ![null, 'clicked', 'uncertain'].includes(state.close.acknowledgement) ||
        ![null, 'closed_confirmed', 'not_opened_by_task', 'unconfirmed'].includes(state.close.status)) throw new Error();
    if (state.close.acknowledgement !== null && !state.close.reserved) throw new Error();
    if (state.close.status === 'closed_confirmed' && (state.close.closed_streak !== MAX_CLOSED_STREAK || state.close.reads < 2)) throw new Error();
    if (state.close.closed_streak === MAX_CLOSED_STREAK && state.close.status !== 'closed_confirmed') throw new Error();
    if ((state.close.status !== null || state.close.reserved || state.close.acknowledgement !== null || state.close.reads > 0 || state.close.error !== null) && !stepsDone) throw new Error();
  } catch { throw journalError(); }
}

function sampleOf(step) {
  return {
    requested: step.requested, category: step.category, count_text: step.count_text, observed_at: step.observed_at,
    list_changed: changedList(step), cards_rendered: step.after.length, cards_seen: step.cards_seen, cards: step.after,
  };
}

/**
 * Samples already confirmed. The task report uses this so it does not reshape cards itself.
 * @param {object} state Journal, finished or not. @returns {object[]}
 */
export function partialJdReviewSamples(state) {
  return state.steps.filter(step => step.after).map(sampleOf);
}

/**
 * Rebuild the visit result from a finished journal. Key order is part of the saved result.
 * list_changed, opened_by_task and the action counts are derived again, so a tampered copy no longer matches.
 * @param {object} state @param {object} target @returns {object}
 */
export function jdReviewResult(state, target) {
  const samples = state.steps.map(sampleOf);
  return {
    schema_version: 1, platform: 'jd', product_id: target.product_id, url: target.url, source: 'jd_review_overlay',
    observed_at: samples.at(-1).observed_at, login_verified: false,
    panel: {
      initial_state: state.open.initial_state, opened_by_task: taskOpened(state), open_acknowledgement: state.open.acknowledgement,
      close_status: state.close.status, sort_text: state.sort_text, sku_select_text: state.sku_select_text,
    },
    categories_seen: state.categories_seen, samples,
    association: { category_ui_verified: true, filter_algorithm_verified: false },
    coverage: { status: 'partial', scope: 'rendered_cards_only', scrolled: false, date_has_year: false, media_read: false, unique_review_count: null },
    excluded: ['nicknames', 'avatars', 'member_marks', 'review_media_urls', 'card_actions'],
    actions: {
      open_reserved: state.open.reserved, category_clicks_reserved: state.steps.filter(step => step.action_reserved).length,
      close_reserved: state.close.reserved, observations_reserved: state.observations,
    },
  };
}

/**
 * @param {object} result @param {object} target @param {Array<string|null>} plan @param {object} state
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validateJdReviewResult(result, target, plan, state) {
  try {
    validateJdReviewReadState(state, target, plan);
    if (!state.steps.every(step => step.after) || state.close.status === null || JSON.stringify(jdReviewResult(state, target)) !== JSON.stringify(result)) throw new Error();
  } catch (error) {
    if (error instanceof ShoppingError && error.message === 'The JD review read journal is invalid.') throw error;
    throw resultError();
  }
}

/**
 * Read the planned 全部评价 categories on one bound product, then close the panel only if this run opened it.
 * A hidden document pauses the open and category phases. Closing does not: #rateList can disappear while the window is hidden.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function, showPage?: Function}} context
 * @returns {Promise<object>} Review result. A panel that never disappears is still returned, with close_status unconfirmed.
 * @throws {ShoppingError} A hidden page, a missing category, an unconfirmed sample, or an exhausted read budget.
 */
export async function runJdReviewRead({ bridge, op, commit, now, wait, showPage = createBlockedPageDisplay(bridge) }) {
  const state = op.review_read;
  validateJdReviewReadState(state, op.target, op.review_categories);
  // A killed process can leave the reservation set and the acknowledgement empty. The click may already have happened.
  if (releaseInFlight(state)) await commit();

  let showAttempted = false;

  const observe = async requireVisible => {
    if (state.observations >= MAX_OBSERVATIONS) return null;
    state.observations += 1;
    await commit();
    const { observed_at: observedAt, raw } = await bridge.readJdReviewCategories(op.tab_id, op.target);
    if (requireVisible && raw.visible !== true) {
      // User 2026-11-04: when blocked, bring the page forward instead of asking for help; ask only if that fails. Once per run.
      if (showAttempted) throw pageNotVisibleError();
      showAttempted = true;
      if (!(await showPage(op.tab_id))) throw pageNotVisibleError();
      await wait(SHOW_SETTLE_MS);
      return observe(requireVisible);
    }
    if (raw.panel === 'open') {
      state.categories_seen = raw.tags;
      state.sort_text = raw.sort_text;
      state.sku_select_text = raw.sku_select_text;
    }
    op.recovery_kind = null;
    return { observed_at: observedAt, raw };
  };

  const finishClick = async (record, errorKey, settleMs, run) => {
    try { await run(); }
    catch (error) {
      if (error.actionNotDispatched) return error;
      record.acknowledgement = 'uncertain';
      record[errorKey] = publicError(error).code;
      state.not_before = now() + settleMs;
      await commit();
      return null;
    }
    record.acknowledgement = 'clicked';
    record[errorKey] = null;
    state.not_before = now() + settleMs;
    await commit();
    return null;
  };

  const sendOpen = async () => {
    state.open.reserved = true;
    state.open.error = null;
    await commit();
    const error = await finishClick(state.open, 'error', OPEN_SETTLE_MS, () => bridge.openJdReviewPanel(op.tab_id, op.target));
    if (!error) return;
    state.open.reserved = false;
    await commit();
    if (error.reviewClickReason === 'panel_open') return;
    throw error;
  };

  const sendSelect = async (step, label) => {
    step.action_reserved = true;
    await commit();
    const error = await finishClick(step, 'acknowledgement_error', CATEGORY_SETTLE_MS, () => bridge.selectJdReviewCategory(op.tab_id, op.target, label));
    if (!error) return;
    step.action_reserved = false;
    step.category = null;
    step.count_text = null;
    step.before_sort = null;
    step.before_cards = null;
    await commit();
    if (error.reviewClickReason === 'already_selected') return;
    throw error;
  };

  const waitOrStop = async checks => {
    state.not_before = checks >= MAX_CATEGORY_CHECKS ? 0 : now() + RECHECK_MS;
    await commit();
    if (checks >= MAX_CATEGORY_CHECKS) throw outcomeError();
  };

  const confirm = async (step, raw, observedAt) => {
    step.checks += 1;
    const prior = step.candidate;
    step.candidate = null;
    const matches = raw.tags.filter(tag => tag.name === step.category);
    const selectedCount = raw.tags.filter(tag => tag.selected).length;
    const qualifies = matches.length === 1 && matches[0].selected && selectedCount === 1 && state.sort_text === step.before_sort && raw.cards.length >= 1;
    if (qualifies) {
      step.candidate = raw.cards;
      step.count_text = matches[0].count_text;
      if (prior && JSON.stringify(prior) === JSON.stringify(raw.cards)) {
        step.after = raw.cards;
        step.observed_at = observedAt;
        step.cards_seen = raw.cards_seen;
        step.list_changed = changedList(step);
      }
    }
    if (step.after) {
      state.not_before = 0;
      await commit();
      return;
    }
    await waitOrStop(step.checks);
  };

  const takeCategory = async seen => {
    const step = state.steps.find(item => !item.after);
    const { raw, observed_at: observedAt } = seen;
    if (raw.panel !== 'open') throw new ShoppingError('REVIEW_PANEL_REQUIRED', 'The review panel is not open.');
    if (!(step.category === null && step.acknowledgement === null && step.candidate === null)) return confirm(step, raw, observedAt);
    const selected = raw.tags.filter(tag => tag.selected);
    if (step.requested === null && selected.length !== 1) {
      step.checks += 1;
      return waitOrStop(step.checks);
    }
    const label = step.requested ?? selected[0].name;
    const matches = raw.tags.filter(tag => tag.name === label);
    if (matches.length === 0) throw new ShoppingError('REVIEW_CATEGORY_UNAVAILABLE', 'The requested category is not on the panel.');
    if (matches.length > 1) throw new ShoppingError('REVIEW_CATEGORIES_AMBIGUOUS', 'More than one tag has the requested category name.');
    const match = matches[0];
    if (match.selected && (selected.length !== 1 || raw.cards.length < 1)) {
      step.checks += 1;
      return waitOrStop(step.checks);
    }
    if (match.selected) {
      // The name is fixed here. The next read is the second look, so this one does not spend a category check.
      step.category = label;
      step.count_text = match.count_text;
      step.before_sort = state.sort_text;
      step.candidate = raw.cards;
      state.not_before = now() + RECHECK_MS;
      await commit();
      return;
    }
    step.category = label;
    step.count_text = match.count_text;
    step.before_sort = state.sort_text;
    step.before_cards = raw.cards;
    await sendSelect(step, label);
  };

  const settleOpen = async seen => {
    const { raw } = seen;
    if (state.open.initial_state === null) state.open.initial_state = raw.panel === 'open' ? 'open' : 'closed';
    if (sent(state.open.acknowledgement) && raw.panel !== 'open') {
      state.open.checks += 1;
      state.not_before = state.open.checks >= MAX_OPEN_CHECKS ? 0 : now() + RECHECK_MS;
      await commit();
      if (state.open.checks >= MAX_OPEN_CHECKS) throw drawerError();
      return false;
    }
    if (raw.panel === 'open') {
      if (sent(state.open.acknowledgement)) state.open.checks += 1;
      state.open.confirmed = true;
      await commit();
      return true;
    }
    if (raw.entry === 'missing') {
      await commit();
      throw new ShoppingError('REVIEW_PANEL_REQUIRED', 'The 全部评价 entry is not on the page.');
    }
    if (raw.entry === 'ambiguous') {
      await commit();
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The 全部评价 entry is not unique.');
    }
    await sendOpen();
    return false;
  };

  // Close ignores visibility. Two reads that find no #rateList confirm it, including while the document is hidden.
  const closePanel = async () => {
    if (state.close.status) return;
    if (!taskOpened(state)) {
      state.close.status = 'not_opened_by_task';
      await commit();
      return;
    }
    if (!state.close.reserved && state.close.acknowledgement === null) {
      state.close.reserved = true;
      await commit();
      const error = await finishClick(state.close, 'error', CLOSE_SETTLE_MS, () => bridge.closeJdReviewPanel(op.tab_id, op.target));
      if (!error) return;
      state.close.reserved = false;
      state.close.error = publicError(error).code;
      state.close.status = 'unconfirmed';
      await commit();
      return;
    }
    if (state.observations >= MAX_OBSERVATIONS || state.close.reads >= MAX_CLOSE_READS) {
      state.close.status = 'unconfirmed';
      await commit();
      return;
    }
    const seen = await observe(false);
    if (!seen) {
      state.close.status = 'unconfirmed';
      await commit();
      return;
    }
    state.close.reads += 1;
    if (seen.raw.panel === 'closed') {
      state.close.closed_streak += 1;
      if (state.close.closed_streak >= MAX_CLOSED_STREAK) state.close.status = 'closed_confirmed';
    } else state.close.closed_streak = 0;
    // A third read that is the second consecutive absence still counts as closed.
    if (!state.close.status && state.close.reads >= MAX_CLOSE_READS) state.close.status = 'unconfirmed';
    if (!state.close.status) state.not_before = now() + RECHECK_MS;
    await commit();
  };

  while (true) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The JD review wait is inconsistent with the clock.');
      await wait(delay);
      continue;
    }
    if (state.steps.every(step => step.after)) {
      await closePanel();
      if (state.close.status) return jdReviewResult(state, op.target);
      continue;
    }
    if (!state.open.confirmed && sent(state.open.acknowledgement) && state.open.checks >= MAX_OPEN_CHECKS) throw drawerError();
    const step = state.steps.find(item => !item.after);
    if (state.open.confirmed && step.checks >= MAX_CATEGORY_CHECKS) throw outcomeError();
    const seen = await observe(true);
    if (!seen) throw limitError();
    if (!state.open.confirmed) {
      const ready = await settleOpen(seen);
      if (!ready) continue;
    }
    await takeCategory(seen);
  }
}

function releaseInFlight(state) {
  let changed = false;
  if (state.open.reserved && state.open.acknowledgement === null) {
    state.open.acknowledgement = 'uncertain';
    state.open.error ??= 'READ_INTERRUPTED';
    changed = true;
  }
  for (const step of state.steps) {
    if (step.action_reserved && step.acknowledgement === null) {
      step.acknowledgement = 'uncertain';
      step.acknowledgement_error ??= 'READ_INTERRUPTED';
      changed = true;
    }
  }
  if (state.close.reserved && state.close.acknowledgement === null) {
    state.close.acknowledgement = 'uncertain';
    state.close.error ??= 'READ_INTERRUPTED';
    changed = true;
  }
  return changed;
}
