import { ShoppingError, publicError } from './errors.mjs';
import { pageDom, responseText } from './page-dom.mjs';
import { searchControlsScript, validateSearchControls, validateSavedSearchControls } from './search-controls.mjs';
import { newReadActionState, validateReadActionState } from './read-action.mjs';
import { collectPriceDirections, normalizePriceDirections } from './price-hover.mjs';

function inspectEntry(raw, dom, baseline, hover, directions) {
  if (raw.state !== 'observed') return raw;
  const roots = dom.all(document, dom.selector('sortBarWrapper'));
  if (roots.length !== 1) return { state: 'search_sort_state_mismatch' };
  const price = dom.all(roots[0], '[role="tab"]').filter(node => dom.text(dom.all(node, '.next-tabs-tab-inner')[0] ?? node, 80) === '价格');
  if (price.length !== 1) return { state: 'unsupported' };
  const text = node => dom.text(node, 600).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const entry = {
    sort_bar_text: text(roots[0]),
    menu_candidates: dom.all(document, '[role="menu"], [role="listbox"]')
      .map(text).filter(value => /价格|从低到高|从高到低/.test(value)).slice(0, 6),
  };
  if (!baseline) return { ...raw, price_entry: entry, ...(hover ? { price_directions: directions(dom, price[0], roots[0]) } : {}) };
  const urls = [...new Set(raw.items.filter(item => item.url).map(item => item.url))];
  if (raw.url !== baseline.url || JSON.stringify(raw.pagination) !== JSON.stringify(baseline.pagination) ||
      JSON.stringify(urls) !== JSON.stringify(baseline.urls) || JSON.stringify(entry) !== JSON.stringify(baseline.entry)) return { state: 'target_changed' };
  const tab = price[0];
  if (tab.getAttribute('aria-selected') === 'true' || tab.disabled || tab.getAttribute('aria-disabled') === 'true' ||
      tab.getAttribute('data-disabled') === 'true') return { state: 'unsupported' };
  if (hover) {
    const siblings = [...tab.parentElement.children];
    const selector = `:is(${dom.selector('sortBarWrapper')}) [role="tab"]:is(${dom.selector('customTabItemWithArr')}):nth-child(${siblings.indexOf(tab) + 1})`;
    const matches = dom.all(document, selector);
    const layout = { parent_child_count: siblings.length, price_sibling_index: siblings.indexOf(tab) + 1,
      matching_count: matches.length, matching_price: matches.length === 1 && matches[0] === tab,
      parent_tag: tab.parentElement.tagName.toUpperCase(), parent_class: (tab.parentElement.getAttribute('class') ?? '').slice(0, 300),
      siblings: siblings.slice(0, 16).map(node => ({ tag: node.tagName.toUpperCase(), role: (node.getAttribute('role') ?? '').slice(0, 40), class_name: (node.getAttribute('class') ?? '').slice(0, 300) })) };
    if (siblings.length > 8 || matches.length !== 1 || matches[0] !== tab) return { state: 'structure_changed', layout };
    return { state: 'hover_prepared', selector, layout };
  }
  tab.click();
  return { state: 'action_dispatched', clicked: true };
}

/**
 * Inspect the price entry, or click its unique enabled tab once against a saved baseline.
 * @param {object} target Canonical search root. @param {object} [before] Validated pre-action observation. @param {{hover?: boolean}} options Hover preparation is read-only.
 * @returns {string} Fixed guarded expression; never selects a direction or a menu item.
 * @throws {ShoppingError} Invalid target or baseline.
 */
export function priceEntryScript(target, before, { hover = false } = {}) {
  if (before) validateSnapshot(before, target, hover);
  const baseline = before ? { url: before.inspection.search.url, pagination: before.inspection.pagination,
    urls: before.inspection.search.items.map(item => item.url), entry: before.entry } : null;
  return `(() => { const raw = ${searchControlsScript(target)};
    return (${inspectEntry.toString()})(raw, (${pageDom.toString()})(), ${JSON.stringify(baseline)}, ${JSON.stringify(hover)}, ${collectPriceDirections.toString()}); })()`;
}

function normalizeEntry(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'menu_candidates,sort_bar_text' ||
      !Array.isArray(value.menu_candidates) || value.menu_candidates.length > 6) throw new ShoppingError('INVALID_RESPONSE', 'Invalid bounded price entry metadata.');
  const menuCandidates = value.menu_candidates.map(text => responseText(text, 600));
  if (menuCandidates.some(text => !/价格|从低到高|从高到低/.test(text))) throw new ShoppingError('INVALID_RESPONSE', 'Unrelated menu metadata.');
  return { sort_bar_text: responseText(value.sort_bar_text, 600), menu_candidates: menuCandidates };
}

/** @param {object} raw @param {object} target @param {{hover?: boolean}} options @returns {object} Visible controls and bounded candidates, without inferred ownership or behavior. @throws {ShoppingError} Page gates or invalid response. */
export function validatePriceEntry(raw, target, { hover = false } = {}) {
  return { inspection: validateSearchControls(raw, target), entry: normalizeEntry(raw.price_entry),
    ...(hover ? { directions: normalizePriceDirections(raw.price_directions) } : {}) };
}

function validateSnapshot(value, target, hover = false) {
  if (!value || Object.keys(value).join(',') !== (hover ? 'inspection,entry,directions' : 'inspection,entry')) throw new Error('Invalid price entry snapshot');
  validateSavedSearchControls(value.inspection, target);
  if (JSON.stringify(value.entry) !== JSON.stringify(normalizeEntry(value.entry))) throw new Error('Invalid price entry metadata');
  if (hover && JSON.stringify(value.directions) !== JSON.stringify(normalizePriceDirections(value.directions))) throw new Error('Invalid visible direction labels');
}

/** @returns {object} Single-interaction inspection journal; observations and ambiguous dispatches survive restarts. */
export function newPriceEntryState() { return { ...newReadActionState(), before: null, after: null }; }

/** @param {object} state @param {object} target @param {boolean} hover Whether the immutable task requests a hover. @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for inconsistent evidence or counters. */
export function validatePriceEntryState(state, target, hover = false) {
  try {
    if (Object.keys(state).join(',') !== Object.keys(newPriceEntryState()).join(',')) throw new Error();
    const { before, after, ...action } = state;
    validateReadActionState(action);
    if (before) validateSnapshot(before, target, hover);
    if ((before && state.observations < 1) || (state.action_reserved && !before) || state.checks > 1) throw new Error();
    if (after) {
      validateSnapshot(after, target, hover);
      if (!state.action_reserved || state.observations < (hover ? 3 : 2) || state.checks !== 1) throw new Error();
    } else if (state.checks) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'Invalid price-entry inspection journal.'); }
}

function resultFor(target, state, hover = false) {
  return { schema_version: 1, query: target.query, source: hover ? 'bounded_price_hover_inspection' : 'bounded_price_entry_inspection', before: state.before, after: state.after,
    coverage: { status: 'partial', control_behavior_verified: false, menu_relation_verified: false, sort_verified: false, filters_verified: false },
    price_direction: null, limits: { cards_per_observation: 25, price_tab_clicks: hover ? 0 : 1, menu_candidates: 6,
      ...(hover ? { price_tab_hovers: 1, direction_candidates: 8, direction_nodes_scanned: 3000 } : {}) },
    action_evidence: { actions_reserved: Number(state.action_reserved), observations_reserved: state.observations,
      acknowledgement_error: state.acknowledgement_error }, login_verified: false };
}

/** @param {object} result @param {object} target @param {object} state @param {boolean} hover @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for an altered result. */
export function validatePriceEntryResult(result, target, state, hover = false) {
  validatePriceEntryState(state, target, hover);
  if (!state.after || JSON.stringify(result) !== JSON.stringify(resultFor(target, state, hover))) throw new ShoppingError('INVALID_CHECKPOINT', 'The price-entry result differs from its saved observations.');
}

/**
 * Observe before and after one price-tab interaction, without interpreting its sort direction.
 * @param {{bridge: object, op: object, commit: Function, now: Function, wait: Function, hover?: boolean}} context
 * @returns {Promise<object>} Descriptive observations only, including a possible unchanged state.
 * @throws {ShoppingError} Page gates, layout or budget failures. Never repeats an uncertain interaction.
 */
export async function runPriceEntry({ bridge, op, commit, now, wait, hover = false }) {
  const state = op.price_entry;
  if (state.after) return resultFor(op.target, state, hover);
  while (state.observations < 8) {
    const delay = state.not_before - now();
    if (delay > 0) {
      if (delay > 15000) throw new ShoppingError('CLOCK_CHANGED', 'The saved price-entry wait is inconsistent.');
      await wait(delay); continue;
    }
    state.observations += 1; state.not_before = now() + 1500;
    await commit();
    const observation = await bridge.readPriceEntry(op.tab_id, op.target, { hover });
    op.recovery_kind = null;
    if (state.action_reserved) {
      state.after = observation; state.checks = 1;
      await commit();
      return resultFor(op.target, state, hover);
    }
    if (hover) {
      if (state.observations >= 7) throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The hover needs a reference read and a later outcome observation.');
      state.observations += 1;
    }
    state.before = observation; state.action_reserved = true;
    await commit();
    try {
      if (hover) await bridge.hoverPriceEntry(op.tab_id, op.target, state.before);
      else await bridge.openPriceEntry(op.tab_id, op.target, state.before);
    }
    catch (error) {
      if (error.actionNotDispatched) { state.action_reserved = false; await commit(); throw error; }
      state.acknowledgement_error = publicError(error).code;
    }
    state.not_before = now() + 1500;
    await commit();
  }
  throw new ShoppingError('ACTION_OBSERVATION_LIMIT', 'The price-entry observation allowance was exhausted.');
}
