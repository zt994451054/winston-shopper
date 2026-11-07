import { ShoppingError, publicError } from '../errors.mjs';
import { integer, timestamp } from '../task-checks.mjs';
import { pddSpecHeader, validatePddSpecState } from './spec-prices.mjs';
import { parsePddProductUrl, pddSearchTarget } from './targets.mjs';

const SCHEMA_VERSION = 1;
// The user allowed at most 12 option clicks per drawer (2026-10-28).
const MAX_OPTION_CLICKS = 12;
// On 2026-10-28 a drawer opened, an option showed its price and the drawer closed, each within 4 s.
const SETTLE_MS = { open: 4_000, option: 3_500, close: 3_500 };
const RECHECK_MS = 3_000;
const MAX_CHECKS = 3;
const CLOCK_LIMIT_MS = 15_000;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STATE_KEYS = ['schema_version', 'product_task', 'product_id', 'product_title', 'groups', 'source_observed_at', 'steps', 'not_before'];
const STEP_KEYS = ['kind', 'button', 'group', 'option', 'reserved', 'outcome', 'error', 'checks', 'confirmed', 'done', 'observed'];
const MAX_STEPS = 1 + 4 * (MAX_OPTION_CLICKS + 2);

const sameKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/**
 * @param {string} productTask The completed pdd_product task whose tab shows the product page.
 * @param {object} product Its saved result: product_id, title, observed_at, price and spec.
 * @returns {object} A fresh journal: nothing clicked or read.
 * @throws {ShoppingError} INVALID_ARGUMENTS, SPEC_GROUPS_MISSING or PRICE_HIDDEN_BY_PAGE.
 */
export function newPddSpecReadState(productTask, product) {
  if (!parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${product?.product_id}`) || typeof product.title !== 'string' || !product.title ||
      !timestamp(product.observed_at)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'The source product result is not a supported PDD product read.');
  }
  const groups = product.spec?.groups?.map(group => group.name) ?? [];
  if (!groups.length) throw new ShoppingError('SPEC_GROUPS_MISSING', 'The product task read no spec groups, so there is no drawer to open.');
  // A masked price (7?.??) comes with a reduced page; its drawer is not opened (plan, 2026-10-28).
  if (product.price?.hidden_by_page) throw new ShoppingError('PRICE_HIDDEN_BY_PAGE', 'The product page hides its price; the spec drawers are not opened.');
  return { schema_version: SCHEMA_VERSION, product_task: productTask, product_id: product.product_id, product_title: product.title, groups,
    source_observed_at: product.observed_at, steps: [], not_before: 0 };
}

const shownOf = (state, step) => validatePddSpecState(step.observed.raw, state.groups);

/** Options to click in one open drawer, in page order: those neither selected nor greyed, at most 12. */
function optionPlan(open) {
  const candidates = open.groups.flatMap(group => group.options.filter(option => !option.selected && !option.unavailable)
    .map(option => ({ group: group.name, option: option.text })));
  return { picks: candidates.slice(0, MAX_OPTION_CLICKS), not_clicked: candidates.slice(MAX_OPTION_CLICKS) };
}
const isSelected = (open, pick) => open.groups.some(group => group.name === pick.group && group.options.some(option => option.text === pick.option && option.selected));

/**
 * The next step the plan asks for, given the finished steps so far: a look, then for each bar buy button one open, the
 * option clicks and one close. A pick already selected on the page is skipped, since clicking it would clear it.
 * @returns {{kind: string, button: string|null, group: string|null, option: string|null}|null} null when the plan is done.
 */
function nextPlanned(state, steps) {
  const step = (kind, button = null, group = null, option = null) => ({ kind, button, group, option });
  if (!steps.length) return step('look');
  const look = shownOf(state, steps[0]);
  if (!look.drawers_in_page) return null;
  let at = 1;
  for (const button of look.buttons) {
    if (at >= steps.length) return step('open', button);
    let latest = shownOf(state, steps[at++]);
    if (!latest.open) return null;
    for (const pick of optionPlan(latest.open).picks) {
      if (isSelected(latest.open, pick)) continue;
      if (at >= steps.length) return step('option', button, pick.group, pick.option);
      latest = shownOf(state, steps[at++]);
      if (!latest.open) return null;
    }
    if (at >= steps.length) return step('close', button);
    at += 1;
  }
  return null;
}

/**
 * Accept a partial journal, including a click reserved but not yet acknowledged. Every finished step must be the one
 * the plan asks for after the steps before it.
 * @param {object} state @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validatePddSpecReadState(state) {
  try {
    if (!sameKeys(state, STATE_KEYS) || state.schema_version !== SCHEMA_VERSION || typeof state.product_task !== 'string' || !state.product_task ||
        !parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${state.product_id}`) || typeof state.product_title !== 'string' ||
        !state.product_title || state.product_title.length > 600 || !Array.isArray(state.groups) || !state.groups.length || state.groups.length > 6 ||
        state.groups.some(name => typeof name !== 'string' || !name) || !timestamp(state.source_observed_at) || !Array.isArray(state.steps) ||
        state.steps.length > MAX_STEPS || !integer(state.not_before, Number.MAX_SAFE_INTEGER)) throw new Error();
    state.steps.forEach((step, index) => {
      if (!sameKeys(step, STEP_KEYS) || typeof step.reserved !== 'boolean' || ![null, 'clicked', 'uncertain'].includes(step.outcome) ||
          (step.outcome === 'uncertain') !== (step.error !== null) || (step.error !== null && !CODE.test(step.error)) || !integer(step.checks, MAX_CHECKS) ||
          typeof step.confirmed !== 'boolean' || typeof step.done !== 'boolean') throw new Error();
      const planned = nextPlanned(state, state.steps.slice(0, index));
      if (!planned || ['kind', 'button', 'group', 'option'].some(key => step[key] !== planned[key])) throw new Error();
      if (step.kind === 'look' ? step.reserved || step.outcome !== null : !step.reserved && (step.outcome !== null || step.checks > 0)) throw new Error();
      if (step.observed !== null) {
        if (!sameKeys(step.observed, ['observed_at', 'raw']) || !timestamp(step.observed.observed_at) || step.checks < 1) throw new Error();
        shownOf(state, step);
      }
      if ((step.done || step.confirmed) && step.observed === null) throw new Error();
      // Only the last step can still be running.
      if (index < state.steps.length - 1 && !step.done) throw new Error();
    });
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD spec price read journal is invalid.'); }
}

const finished = state => state.steps.length > 0 && state.steps.at(-1).done && nextPlanned(state, state.steps) === null;

function readingOf(state, step) {
  const shown = shownOf(state, step);
  const header = pddSpecHeader(shown.open.header);
  return { after: step.kind === 'open' ? { kind: 'open' } : { kind: 'option', group: step.group, option: step.option }, outcome: step.outcome,
    error: step.error, confirmed: step.confirmed, observed_at: step.observed.observed_at, chosen: header.chosen, price: header.price, notes: header.notes,
    selected: shown.open.groups.map(group => ({ group: group.name, options: group.options.filter(option => option.selected).map(option => option.text) })) };
}

/**
 * Build the spec price result from a finished journal.
 * @param {object} state Finished journal. @param {{query: string}} target The search page the product came from. @returns {object}
 */
export function pddSpecPricesResult(state, target) {
  const look = shownOf(state, state.steps[0]);
  const drawers = [];
  let current = null;
  for (const step of state.steps.slice(1)) {
    if (step.kind === 'open') {
      const shown = shownOf(state, step);
      const plan = optionPlan(shown.open);
      current = { button: step.button, kind: /单独购买$/.test(step.button) ? 'alone' : 'group', readings: [], closed: false,
        groups: shown.open.groups.map(group => ({ name: group.name, options: group.options.map(option => option.text), options_cut: group.options_cut,
          unavailable: group.options.filter(option => option.unavailable).map(option => option.text) })),
        other_lines: shown.open.other_lines, not_clicked: plan.not_clicked };
      drawers.push(current);
    }
    if (step.kind === 'open' || step.kind === 'option') current.readings.push(readingOf(state, step));
    if (step.kind === 'close') current.closed = !shownOf(state, step).open;
  }
  const notClicked = drawers.reduce((sum, drawer) => sum + drawer.not_clicked.length, 0);
  const cut = drawers.some(drawer => drawer.groups.some(group => group.options_cut)) || look.buttons_cut;
  const unconfirmed = drawers.some(drawer => drawer.readings.some(reading => !reading.confirmed));
  const complete = look.drawers_in_page > 0 && drawers.length === look.buttons.length && drawers.every(drawer => drawer.closed) && !notClicked && !cut && !unconfirmed;
  return {
    schema_version: SCHEMA_VERSION, platform: 'pdd', source: 'pdd_spec_drawers', login_verified: false, observed_at: state.steps.at(-1).observed.observed_at,
    product_id: state.product_id, product_title: state.product_title,
    entry: { product_task: state.product_task, query: target.query, clicks: state.steps.filter(step => step.reserved).length },
    outcome: look.drawers_in_page ? 'read' : 'drawer_not_in_page', buttons: look.buttons, drawers,
    coverage: { status: complete ? 'complete' : 'partial', scope: 'spec_drawers_of_bar_buy_buttons', every_button_opened: drawers.length === look.buttons.length,
      drawers_closed: drawers.every(drawer => drawer.closed), options_not_clicked: notClicked, options_cut: cut, unconfirmed_selections: unconfirmed,
      order_controls_clicked: false, quantity_changed: false },
    missing: [...(look.drawers_in_page ? [] : ['spec_drawer']), ...(notClicked ? ['options_over_click_limit'] : []), ...(cut ? ['options_not_listed'] : []),
      ...(unconfirmed ? ['unconfirmed_selection'] : []), 'option_combinations_not_tried', 'verified_payable_price'],
    excluded: ['quantity', 'drawer_buttons', 'other_buyers'],
  };
}

/**
 * @param {object} result Saved result. @param {object} target Search target. @param {object} state Saved journal.
 * @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT when the result is not exactly what its journal yields.
 */
export function validatePddSpecPricesResult(result, target, state) {
  try {
    validatePddSpecReadState(state);
    if (!finished(state) || JSON.stringify(pddSpecPricesResult(state, target)) !== JSON.stringify(result)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD spec price result does not match its journal.'); }
}

function notShownError(step) {
  const errors = {
    open: ['SPEC_DRAWER_NOT_OPENED', `No spec drawer opened after clicking ${step.button}.`],
    option: ['SPEC_DRAWER_STATE_CHANGED', 'The spec drawer closed after clicking an option.'],
    close: ['SPEC_DRAWER_NOT_CLOSED', 'The spec drawer stayed open after clicking its close icon.'],
  }[step.kind];
  return new ShoppingError(...errors, 'Look at the tab; this task does not click again.');
}

/** Whether the read after a step shows what the step should have done; null when it can never show it. */
function stepShown(step, shown) {
  if (step.kind === 'look') return true;
  if (step.kind === 'open') return Boolean(shown.open);
  if (step.kind === 'close') return !shown.open;
  if (!shown.open) return null;
  return isSelected(shown.open, step);
}

/**
 * On the product page a pdd_product task read, open the spec drawer of each bar buy button once (单独购买, 免拼购买 …),
 * click the options that are not selected one at a time, at most 12 per drawer, reading the drawer header after each,
 * then close the drawer with its close icon. Only buy buttons, options and the close icon are ever clicked; every read
 * checks the tab still shows this product page (user rule, 2026-10-28: never order and never reach an order page).
 * Each click is recorded before it is sent and never repeated, including after an interruption.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function}} context
 * @returns {Promise<object>} Spec price result.
 * @throws {ShoppingError} Page gates, TARGET_CHANGED when the tab left the product page, refusals, SPEC_DRAWER_NOT_OPENED,
 *   SPEC_DRAWER_STATE_CHANGED or SPEC_DRAWER_NOT_CLOSED.
 */
export async function runPddSpecPricesRead({ bridge, op, commit, now, wait }) {
  const state = op.spec_read;
  const target = pddSearchTarget(op.target?.query);
  if (JSON.stringify(target) !== JSON.stringify(op.target)) throw new ShoppingError('INVALID_CHECKPOINT', 'The PDD search target is invalid.');
  validatePddSpecReadState(state);
  // A killed process can leave a reservation without an acknowledgement. The click may have happened, so it is spent.
  const last = state.steps.at(-1);
  if (last?.reserved && last.outcome === null) {
    last.outcome = 'uncertain'; last.error = 'READ_INTERRUPTED'; state.not_before = now() + SETTLE_MS[last.kind];
    await commit();
  }
  while (!finished(state)) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > CLOCK_LIMIT_MS) throw new ShoppingError('CLOCK_CHANGED', 'The PDD spec price wait is inconsistent with the clock.');
      await wait(delay); continue;
    }
    const step = state.steps.at(-1);
    if (!step || step.done) {
      const planned = nextPlanned(state, state.steps);
      state.steps.push({ ...planned, reserved: false, outcome: null, error: null, checks: 0, confirmed: false, done: false, observed: null });
      await commit(); continue;
    }
    if (step.kind !== 'look' && !step.reserved) {
      step.reserved = true;
      await commit();
      const action = step.kind === 'open' ? { kind: 'open', label: step.button } : step.kind === 'option' ? { kind: 'option', group: step.group, text: step.option } : { kind: 'close' };
      try {
        await bridge.clickPddSpec(op.tab_id, state.product_id, state.groups, action);
        step.outcome = 'clicked';
      } catch (error) {
        if (error.actionNotDispatched) { step.reserved = false; await commit(); throw error; }
        step.outcome = 'uncertain'; step.error = publicError(error).code;
      }
      op.recovery_kind = null; state.not_before = now() + SETTLE_MS[step.kind];
      await commit(); continue;
    }
    if (step.checks >= MAX_CHECKS) throw notShownError(step);
    step.checks += 1;
    await commit();
    try {
      step.observed = await bridge.readPddSpecState(op.tab_id, state.product_id, state.groups);
    } catch (error) {
      if (error.code !== 'PAGE_LOADING' || step.checks >= MAX_CHECKS) throw error;
      state.not_before = now() + RECHECK_MS;
      await commit(); continue;
    }
    const shown = stepShown(step, shownOf(state, step));
    if (shown === null) { await commit(); throw notShownError(step); }
    if (shown) { step.confirmed = true; step.done = true; }
    // An option the page did not mark as selected is kept unconfirmed; the drawer is still open, so the plan goes on.
    else if (step.checks >= MAX_CHECKS && step.kind === 'option') step.done = true;
    else if (step.checks >= MAX_CHECKS) { await commit(); throw notShownError(step); }
    else state.not_before = now() + RECHECK_MS;
    op.recovery_kind = null;
    await commit();
  }
  return pddSpecPricesResult(state, target);
}
