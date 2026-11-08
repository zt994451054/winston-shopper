import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { searchTarget } from '../lib/search.mjs';
import { createSearchPriceRequest } from '../lib/search-price-request.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { searchPriceScript, validateSearchPriceObservation, pickPriceDirectionScript, confirmPriceRangeScript,
  searchPricePlan, newSearchPriceState, runSearchPrice, validateSearchPriceState, searchPriceResult,
  validateSearchPriceResult, priceBoundText, priceExpectationGaps, priceControlsScript, validatePriceControlsReply,
  nextPricePageScript, validateNextPriceAcknowledgement, pickSourceScript, pickFilterScript } from '../lib/search-price.mjs';
import { priceSearchPage } from '../test-support/search-price-fixture.mjs';

const root = searchTarget('Synthetic mouse');
const request = (sort, minPrice = null, maxPrice = null) => createSearchPriceRequest({ query: root.query, sort, minPrice, maxPrice });

/** In-process stand-in for BrowserBridge that drives the synthetic page through the real page expressions. */
function fakeBridge(page, { loseReplyOn = null, failBeforeDispatch = null, hoverOpens = true, beforeCall = null } = {}) {
  const calls = [];
  const run = script => JSON.parse(JSON.stringify(vm.runInNewContext(script, page.context)));
  const act = async (kind, perform) => {
    beforeCall?.(kind, calls);
    calls.push(kind);
    if (failBeforeDispatch === kind) { const error = new ShoppingError('TARGET_CHANGED', 'synthetic'); error.actionNotDispatched = true; throw error; }
    const value = perform();
    if (loseReplyOn === kind) throw new ShoppingError('BRIDGE_TIMEOUT', 'synthetic lost reply');
    return value;
  };
  const clicked = value => {
    if (value.state !== 'action_dispatched') { const error = new ShoppingError('PRICE_CONTROL_UNAVAILABLE', 'synthetic'); error.actionNotDispatched = true; throw error; }
    return { clicked: true };
  };
  const cardLimits = [];
  return {
    calls, cardLimits,
    async readSearchPrice(tabId, target, pageNumber = 1, options = {}) {
      beforeCall?.('read', calls); calls.push('read'); cardLimits.push(options.cardLimit);
      return validateSearchPriceObservation(run(searchPriceScript(target, pageNumber, options)), target, pageNumber, options);
    },
    nextPricePage: (tabId, target, from, options) => act('next', () => validateNextPriceAcknowledgement(run(nextPricePageScript(target, from, options)))),
    hoverPriceTab: (tabId, target, label) => act(`hover:${label}`, () => { if (hoverOpens) page.hover(label); return { hovered: true }; }),
    pickPriceDirection: (tabId, target, label, source) => act('pick', () => clicked(run(pickPriceDirectionScript(target, label, source)))),
    pickSearchSource: (tabId, target, source) => act(`source:${source}`, () => clicked(run(pickSourceScript(target, source)))),
    pickSearchFilter: (tabId, target, label, source) => act(`filter:${label}`, () => clicked(run(pickFilterScript(target, label, source)))),
    // Mirrors BrowserBridge.fillPriceRange: the real controls script must show the panel open and the inputs empty first.
    fillPriceRange: (tabId, target, fields, source) => act('fill_range', () => {
      const controls = validatePriceControlsReply(run(priceControlsScript(target, source)));
      if (!controls.range_panel) { const error = new ShoppingError('PRICE_CONTROL_UNAVAILABLE', 'synthetic closed panel'); error.actionNotDispatched = true; throw error; }
      for (const { field, text } of fields) page.fill(field, text);
      return { filled: true };
    }),
    confirmPriceRange: (tabId, target, source) => act('confirm', () => clicked(run(confirmPriceRangeScript(target, source)))),
  };
}

function harness(priceRequest, bridgeOptions, pageOptions, { pages = 1, conditions } = {}) {
  const page = priceSearchPage(pageOptions);
  const bridge = fakeBridge(page, bridgeOptions);
  const op = { tab_id: 41, target: root, recovery_kind: null, search_price: newSearchPriceState(priceRequest, undefined, { pages, conditions }) };
  let now = 1_000_000, waited = 0;
  const commits = [];
  const context = { bridge, op, now: () => now, wait: async ms => { now += ms; waited += ms; },
    commit: async () => { validateSearchPriceState(op.search_price, root); commits.push(structuredClone(op.search_price)); } };
  return { page, bridge, op, context, commits, waited: () => waited };
}

test('plans are fixed by the request: the pointer leaves via 综合 before every entry and each state is verified by reopening', () => {
  const both = searchPricePlan(request('price-desc', '40', '60')).map(step => step.kind === 'read' || step.kind === 'settle' ? `${step.kind}:${step.expect}`
    : step.kind === 'hover' ? `hover:${step.tab}` : step.kind === 'fill_range' ? `fill_range:${step.fields.map(f => `${f.field}=${f.text}`).join(',')}`
    : step.kind === 'pick_direction' ? `pick:${step.label}` : step.kind);
  assert.deepEqual(both, ['read:baseline', 'hover:综合', 'hover:价格', 'read:direction_menu', 'pick:从高到低', 'settle:direction_applied',
    'hover:综合', 'hover:区间', 'read:range_panel_empty', 'fill_range:minimum=40,maximum=60', 'read:range_filled', 'confirm_range',
    'settle:range_applied', 'hover:综合', 'hover:区间', 'read:range_marked', 'hover:综合', 'hover:价格', 'read:direction_marked',
    'settle:final']);
  assert.deepEqual(searchPricePlan(request(null, null, '9.5')).find(step => step.kind === 'fill_range').fields, [{ field: 'maximum', text: '9.5' }]);
  // Schema 3 journals typed each bound separately; they still validate and rebuild their original plan.
  assert.deepEqual(searchPricePlan(request(null, '1', '9.5'), 3).filter(step => step.kind === 'fill').map(step => step.field), ['minimum', 'maximum']);
  assert.equal(searchPricePlan(request('price-asc')).some(step => step.kind === 'confirm_range'), false);
  assert.equal(newSearchPriceState(request('price-desc', '40', '60')).observation_limit, 1 + 2 + 4 + 2 + 2 + 4 + 2 + 2 + 4 + 6);
  assert.deepEqual(['0.00', '9.10', '9.05', '40.00', '999999999.99'].map(amount => priceBoundText({ amount, cents: Math.round(Number(amount) * 100) })),
    ['0', '9.1', '9.05', '40', '999999999.99']);
});

test('descending sort plus a range applies both, verifies by reopening and delivers platform order plus a local order', async () => {
  const h = harness(request('price-desc', '40', '60'));
  const result = await runSearchPrice(h.context);
  assert.deepEqual(h.bridge.calls.filter(call => call !== 'read'), ['hover:综合', 'hover:价格', 'pick', 'hover:综合', 'hover:区间',
    'fill_range', 'confirm', 'hover:综合', 'hover:区间', 'hover:综合', 'hover:价格']);
  // No pointer move closes an overlay, so the final read is taken with the verification menu still open.
  assert.equal(h.page.state.menuOpen, true);
  assert.equal(result.before.pagination.total_pages_displayed, 100); assert.equal(result.after.pagination.total_pages_displayed, 2);
  assert.deepEqual(result.applied.price_sort, { direction: 'price-desc', option_label: '从高到低', comprehensive_deselected: true,
    marked_option: '从高到低', marker: 'computed_font_weight' });
  assert.deepEqual(result.applied.price_range.reopened_input_text, { minimum_text: '40', maximum_text: '60' });
  assert.equal(result.applied.price_range.range_tab_selected, true);
  assert.deepEqual(result.coverage, { status: 'partial', platform_ui_applied: true, url_reflects_state: false, sort_verified: false,
    filters_verified: false, total_results_known: false });
  // Synthetic cards after reversal and range: an ad at position 1, then 19, 82, 49.9, 45.1 — displayed prices contradict both checks.
  assert.equal(result.displayed_price_check.order_check.status, 'contradicted_sample');
  assert.equal(result.displayed_price_check.range_check.status, 'contradicted_sample');
  assert.deepEqual(result.displayed_price_order.records.map(row => row.comparable_price.amount), ['82.00', '49.90', '45.10', '19.00']);
  assert.deepEqual(result.displayed_price_order.records.map(row => row.platform_position), [3, 4, 5, 2]);
  assert.equal(result.displayed_price_order.platform_order, false);
  assert.ok(result.action_evidence.actions.every(action => action.status === 'acknowledged'));
  assert.ok(h.waited() >= 1500 * 18, 'every page interaction keeps the normal spacing');
  assert.deepEqual(result.action_evidence.overlay_reopens, []);
  assert.deepEqual(result, searchPriceResult(root, h.op.search_price));
  validateSearchPriceResult(result, root, h.op.search_price);
});

test('direction-only and range-only requests use only their own controls', async () => {
  const ascending = harness(request('price-asc'));
  const asc = await runSearchPrice(ascending.context);
  assert.equal(asc.applied.price_range, null); assert.equal(asc.after.pagination.total_pages_displayed, 8);
  assert.ok(!ascending.bridge.calls.some(call => call.startsWith('fill') || call === 'confirm'));
  assert.equal(asc.displayed_price_order.direction, 'price-asc');
  const ranged = harness(request(null, null, '50'));
  const range = await runSearchPrice(ranged.context);
  assert.equal(range.applied.price_sort, null);
  assert.deepEqual(range.applied.price_range.reopened_input_text, { minimum_text: '', maximum_text: '50' });
  assert.deepEqual(ranged.bridge.calls.filter(call => call.startsWith('fill')), ['fill_range']);
  assert.equal(range.displayed_price_order.direction, 'price-asc');
});

test('a lost acknowledgement is recorded as uncertain and verified by observation, never by a second click', async () => {
  const h = harness(request('price-asc'), { loseReplyOn: 'pick' });
  const result = await runSearchPrice(h.context);
  assert.equal(h.bridge.calls.filter(call => call === 'pick').length, 1);
  const pick = result.action_evidence.actions.find(action => action.kind === 'pick_direction');
  assert.deepEqual(pick, { kind: 'pick_direction', target: '从低到高', status: 'uncertain', acknowledgement_error: 'BRIDGE_TIMEOUT' });
});

test('an ineffective click stops after the bounded settle reads without repeating the action', async () => {
  const h = harness(request('price-asc'));
  h.page.state.ignoreClicks = true;
  await assert.rejects(runSearchPrice(h.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(h.bridge.calls.filter(call => call === 'pick').length, 1);
  assert.equal(h.op.search_price.step_observations, 4);
  await assert.rejects(runSearchPrice(h.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(h.bridge.calls.filter(call => call === 'pick').length, 1);
});

test('a page that is not the default unfiltered first page stops before any pointer action', async () => {
  const h = harness(request('price-desc'));
  h.page.state.comprehensive = false; h.page.refresh();
  await assert.rejects(runSearchPrice(h.context), { code: 'PRICE_START_STATE_UNSUPPORTED' });
  assert.deepEqual(h.bridge.calls, ['read']); assert.equal(h.op.search_price.actions.length, 0);
});

test('a direction menu that does not open stops before any option click', async () => {
  const h = harness(request('price-desc'), { hoverOpens: false });
  await assert.rejects(runSearchPrice(h.context), { code: 'PRICE_CONTROL_NOT_CONFIRMED' });
  assert.equal(h.bridge.calls.includes('pick'), false);
  assert.equal(h.bridge.calls.filter(call => call === 'read').length, 3);
});

test('an undispatched action releases its reservation; an interrupted reservation is never dispatched again', async () => {
  const h = harness(request('price-asc'), { failBeforeDispatch: 'pick' });
  await assert.rejects(runSearchPrice(h.context), { code: 'TARGET_CHANGED' });
  assert.equal(h.op.search_price.actions.some(action => action.kind === 'pick_direction'), false);
  // A process killed after saving the intent, while the page did apply the click.
  h.op.search_price.actions.push({ step: h.op.search_price.step, kind: 'pick_direction', status: 'reserved', acknowledgement_error: null });
  validateSearchPriceState(h.op.search_price, root);
  Object.assign(h.page.state, { direction: '从低到高', comprehensive: false, menuOpen: false, totalPages: 8 });
  h.page.state.cards.reverse(); h.page.refresh();
  const bridge = fakeBridge(h.page);
  const result = await runSearchPrice({ ...h.context, bridge });
  assert.equal(bridge.calls.includes('pick'), false);
  assert.deepEqual(result.action_evidence.actions.find(action => action.kind === 'pick_direction'),
    { kind: 'pick_direction', target: '从低到高', status: 'uncertain', acknowledgement_error: 'READ_INTERRUPTED' });
});

test('checkpoints reject fabricated evidence, foreign plans and upgraded guarantees', async () => {
  const h = harness(request('price-desc', '40', '60'));
  const result = await runSearchPrice(h.context);
  for (const saved of h.commits) validateSearchPriceState(saved, root);
  const final = h.op.search_price;
  for (const mutate of [
    state => { state.extra = 1; },
    state => { state.plan.pop(); },
    state => { state.request.price_sort = 'price-asc'; },
    state => { state.evidence.direction.emphasized_label = '从低到高'; },
    state => { state.evidence.range.maximum_text = '70'; },
    state => { state.actions[0].status = 'reserved'; },
    state => { state.observations = state.observation_limit + 1; },
    state => { state.after = null; state.step = state.plan.length; },
  ]) {
    const copy = structuredClone(final); mutate(copy);
    assert.throws(() => validateSearchPriceState(copy, root), { code: 'INVALID_CHECKPOINT' });
  }
  const early = structuredClone(h.commits[1]);
  early.after = structuredClone(final.after);
  assert.throws(() => validateSearchPriceState(early, root), { code: 'INVALID_CHECKPOINT' });
  const upgraded = structuredClone(result); upgraded.coverage.sort_verified = true;
  assert.throws(() => validateSearchPriceResult(upgraded, root, final), { code: 'INVALID_CHECKPOINT' });
});

test('a read that fails before returning an observation uses the shared total but not the step allowance', async () => {
  const h = harness(request('price-asc'));
  const read = h.bridge.readSearchPrice;
  let failures = 1;
  h.bridge.readSearchPrice = async (...args) => {
    if (failures-- > 0) throw new ShoppingError('TARGET_MISSING', 'synthetic missing tab');
    return read(...args);
  };
  await assert.rejects(runSearchPrice(h.context), { code: 'TARGET_MISSING' });
  assert.equal(h.op.search_price.observations, 1); assert.equal(h.op.search_price.step_observations, 0);
  const result = await runSearchPrice(h.context);
  assert.equal(result.before.search.page, 1);
  assert.equal(result.action_evidence.observations_reserved, h.op.search_price.observations);
});

test('schema 1 journals from the first live runs stay loadable but are never executed', async () => {
  const fresh = newSearchPriceState(request('price-asc'), 2);
  // Schema 1 ended with a pointer move to 综合 before the final read (live runs on 2026-10-12, before c247dc5).
  const legacy = { ...structuredClone(fresh), schema_version: 1,
    plan: [...fresh.plan.slice(0, -1), { kind: 'hover', tab: '综合' }, fresh.plan.at(-1)] };
  validateSearchPriceState(legacy, root);
  assert.throws(() => validateSearchPriceState({ ...legacy, plan: fresh.plan }, root), { code: 'INVALID_CHECKPOINT' });
  assert.throws(() => validateSearchPriceState({ ...fresh, plan: legacy.plan }, root), { code: 'INVALID_CHECKPOINT' });
  const h = harness(request('price-asc'));
  h.op.search_price = legacy;
  await assert.rejects(runSearchPrice(h.context), { code: 'LEGACY_PRICE_PLAN' });
  assert.deepEqual(h.bridge.calls, []);
});

test('each unmet expectation is reported with fixed reason codes', () => {
  const state = newSearchPriceState(request('price-desc', '40', null));
  const page = priceSearchPage();
  const read = () => validateSearchPriceObservation(JSON.parse(JSON.stringify(vm.runInNewContext(searchPriceScript(root), page.context))), root);
  const baseline = read();
  state.before = baseline.snapshot;
  assert.deepEqual(priceExpectationGaps('baseline', baseline, state), []);
  assert.deepEqual(priceExpectationGaps('direction_menu', baseline, state), ['direction_menu_closed']);
  page.hover('价格');
  assert.deepEqual(priceExpectationGaps('direction_applied', read(), state), ['comprehensive_selected', 'list_unchanged']);
  page.hover('区间');
  assert.deepEqual(priceExpectationGaps('range_filled', read(), state), ['range_bounds_not_shown']);
  assert.deepEqual(priceExpectationGaps('range_marked', read(), state), ['range_not_selected', 'range_bounds_not_shown']);
  page.state.comprehensive = false; page.refresh();
  assert.deepEqual(priceExpectationGaps('baseline', read(), state), ['comprehensive_not_selected', 'range_panel_open']);
});

test('settle reads record why they did not count, including a view that changed between reads', async () => {
  const ineffective = harness(request('price-asc'));
  ineffective.page.state.ignoreClicks = true;
  await assert.rejects(runSearchPrice(ineffective.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  const settleStep = ineffective.op.search_price.step;
  const entries = ineffective.op.search_price.mismatches.filter(entry => entry.step === settleStep);
  assert.equal(entries.length, 4);
  assert.ok(entries.every(entry => entry.reasons.includes('comprehensive_selected') && entry.reasons.includes('list_unchanged')));

  const loading = harness(request('price-asc'));
  const read = loading.bridge.readSearchPrice;
  let flips = 0;
  loading.bridge.readSearchPrice = async (...args) => {
    // After the click, the first two settle reads still see the list re-rendering.
    if (loading.page.state.direction && flips < 2) { flips += 1; loading.page.state.totalPages = 8 + flips; loading.page.refresh(); }
    return read(...args);
  };
  const result = await runSearchPrice(loading.context);
  const changed = result.action_evidence.mismatches.filter(entry => entry.reasons.includes('view_changed'));
  assert.ok(changed.length >= 1);
  assert.deepEqual(result.action_evidence.mismatches, loading.op.search_price.mismatches);
});

test('schema 6 journals finish with twenty-five cards per read, and later journals read fifty', async () => {
  const six = harness(request('price-asc'));
  six.op.search_price = newSearchPriceState(request('price-asc'), 6);
  const old = await runSearchPrice(six.context);
  assert.equal(old.limits.cards_per_observation, 25); assert.ok(six.bridge.cardLimits.every(limit => limit === 25));
  const current = harness(request('price-asc')), result = await runSearchPrice(current.context);
  assert.equal(current.op.search_price.schema_version, 8);
  assert.equal(result.limits.cards_per_observation, 50); assert.ok(current.bridge.cardLimits.every(limit => limit === 50));
  const forged = structuredClone(six.op.search_price); forged.schema_version = 7;
  assert.throws(() => validateSearchPriceState(forged, root), { code: 'INVALID_CHECKPOINT' });
});

test('schema 7 journals still finish and keep listing unscanned cards and later pages as missing', async () => {
  const seven = harness(request('price-desc', '40', '60'), {}, undefined, { pages: 3 });
  seven.op.search_price = newSearchPriceState(request('price-desc', '40', '60'), 7, { pages: 3 });
  const result = await runSearchPrice(seven.context);
  assert.equal(result.paging.end_reason, 'last_page');
  assert.ok(result.pages.every(page => page.search.cards_seen === page.search.cards_scanned));
  assert.deepEqual(result.missing, ['platform_price_basis', 'unscanned_cards', 'subsequent_pages', 'verified_payable_prices']);
  validateSearchPriceResult(result, root, seven.op.search_price);
  const relabeled = structuredClone(result); relabeled.missing = ['platform_price_basis', 'verified_payable_prices'];
  assert.throws(() => validateSearchPriceResult(relabeled, root, seven.op.search_price), { code: 'INVALID_CHECKPOINT' });
});

test('schema 8 lists unscanned cards only when a read page had more than fifty, and later pages unless paging hit the last page', async () => {
  const lastPage = harness(request('price-desc', '40', '60'), {}, undefined, { pages: 3 });
  const ended = await runSearchPrice(lastPage.context);
  assert.equal(ended.paging.end_reason, 'last_page');
  assert.deepEqual(ended.missing, ['platform_price_basis', 'verified_payable_prices']);
  validateSearchPriceResult(ended, root, lastPage.op.search_price);
  const requested = harness(request('price-asc'), {}, undefined, { pages: 2 });
  assert.deepEqual((await runSearchPrice(requested.context)).missing, ['platform_price_basis', 'subsequent_pages', 'verified_payable_prices']);
  const sixty = Array.from({ length: 60 }, (_, index) => ({ id: String(2000 + index), price: String(10 + index) }));
  const crowded = harness(request('price-asc'), {}, { cards: sixty }), first = await runSearchPrice(crowded.context);
  assert.deepEqual([first.after.search.cards_seen, first.after.search.cards_scanned], [60, 50]);
  assert.deepEqual(first.missing, ['platform_price_basis', 'unscanned_cards', 'subsequent_pages', 'verified_payable_prices']);
  validateSearchPriceResult(first, root, crowded.op.search_price);
});

test('schema 2-5 journals stay loadable but are not executed; new journals use schema 8', async () => {
  const fresh = newSearchPriceState(request('price-asc'));
  assert.equal(fresh.schema_version, 8); assert.deepEqual([fresh.conditions, fresh.conditions_view], [{ source: 'all', filters: [] }, null]); assert.deepEqual(fresh.mismatches, []); assert.deepEqual(fresh.reopens, []);
  assert.deepEqual([fresh.requested_pages, fresh.current_page, fresh.pages, fresh.last_page_at], [1, 1, [], null]);
  const two = newSearchPriceState(request('price-asc'), 2);
  validateSearchPriceState(two, root);
  assert.throws(() => validateSearchPriceState({ ...two, mismatches: [] }, root), { code: 'INVALID_CHECKPOINT' });
  const three = newSearchPriceState(request('price-desc', '1', '9'), 3);
  validateSearchPriceState(three, root);
  assert.throws(() => validateSearchPriceState({ ...three, reopens: [] }, root), { code: 'INVALID_CHECKPOINT' });
  const four = newSearchPriceState(request('price-desc', '1', '9'), 4);
  validateSearchPriceState(four, root);
  assert.throws(() => newSearchPriceState(request('price-asc'), 4, { pages: 2 }), { code: 'INVALID_ARGUMENTS' });
  const five = newSearchPriceState(request('price-asc'), 5, { pages: 2 });
  validateSearchPriceState(five, root);
  assert.throws(() => newSearchPriceState(request('price-asc'), 5, { conditions: { filters: ['包邮'] } }), { code: 'INVALID_ARGUMENTS' });
  for (const legacy of [two, three, four, five]) {
    const h = harness(request(legacy.request.price_sort, legacy.request.price_range.minimum?.amount ?? null, legacy.request.price_range.maximum?.amount ?? null));
    h.op.search_price = legacy;
    await assert.rejects(runSearchPrice(h.context), { code: 'LEGACY_PRICE_PLAN' });
    assert.deepEqual(h.bridge.calls, []);
  }
});

const stepIndexOf = (state, predicate) => state.plan.findIndex(predicate);
const acknowledgedReopen = (step, trigger, tab) => ({ step, trigger, hovers: [{ tab: '综合', status: 'acknowledged', acknowledgement_error: null },
  { tab, status: 'acknowledged', acknowledgement_error: null }] });

test('a menu closed by the user before the option click is reopened once and the click then goes through', async () => {
  let page;
  const h = harness(request('price-asc'), { beforeCall: (kind, calls) => { if (kind === 'pick' && !calls.includes('pick')) page.leave(); } });
  page = h.page;
  const result = await runSearchPrice(h.context);
  assert.deepEqual(h.bridge.calls.filter(call => call !== 'read'), ['hover:综合', 'hover:价格', 'pick', 'hover:综合', 'hover:价格', 'pick', 'hover:综合', 'hover:价格']);
  const pick = stepIndexOf(h.op.search_price, step => step.kind === 'pick_direction');
  assert.deepEqual(result.action_evidence.overlay_reopens, [acknowledgedReopen(pick, 'action_unavailable', '价格')]);
  assert.equal(result.action_evidence.actions.filter(action => action.kind === 'pick_direction').length, 1, 'the refused attempt left no action record');
  assert.equal(result.applied.price_sort.marked_option, '从低到高');
});

test('a range panel closed before typing (the live 2026-10-13 stop) is reopened and both bounds are typed in one step', async () => {
  let page;
  const h = harness(request('price-desc', '40', '60'), { beforeCall: (kind, calls) => { if (kind === 'fill_range' && !calls.includes('fill_range')) page.leave(); } });
  page = h.page;
  const result = await runSearchPrice(h.context);
  const fill = stepIndexOf(h.op.search_price, step => step.kind === 'fill_range');
  assert.deepEqual(result.action_evidence.overlay_reopens, [acknowledgedReopen(fill, 'action_unavailable', '区间')]);
  assert.deepEqual(result.applied.price_range.reopened_input_text, { minimum_text: '40', maximum_text: '60' });
  assert.deepEqual(result.action_evidence.actions.find(action => action.kind === 'fill_range'),
    { kind: 'fill_range', target: 'minimum:40,maximum:60', status: 'acknowledged', acknowledgement_error: null });
});

test('an overlay found closed on a verification read is reopened once; the mismatch records that the page was not focused', async () => {
  let page;
  const h = harness(request('price-desc', '40', '60'), { beforeCall: (kind, calls) => {
    if (kind === 'read' && calls.at(-1) === 'hover:区间' && calls.includes('confirm') && !page.closedOnce) { page.closedOnce = true; page.leave(); }
  } });
  page = h.page;
  const result = await runSearchPrice(h.context);
  const marked = stepIndexOf(h.op.search_price, step => step.expect === 'range_marked');
  assert.deepEqual(result.action_evidence.overlay_reopens, [acknowledgedReopen(marked, 'read_closed', '区间')]);
  const mismatch = result.action_evidence.mismatches.find(entry => entry.step === marked);
  assert.deepEqual(mismatch.reasons, ['range_panel_closed']);
  assert.deepEqual(mismatch.page, { visible: true, focused: false });
  assert.deepEqual(result.applied.price_range.reopened_input_text, { minimum_text: '40', maximum_text: '60' });
});

test('an overlay closed again after its one reopen stops the task without any click', async () => {
  let page;
  const h = harness(request('price-asc'), { beforeCall: kind => { if (kind === 'pick') page.leave(); } });
  page = h.page;
  await assert.rejects(runSearchPrice(h.context), { code: 'PRICE_CONTROL_UNAVAILABLE' });
  assert.equal(h.op.search_price.reopens.length, 1);
  assert.equal(h.op.search_price.actions.some(action => action.kind === 'pick_direction'), false);
  assert.equal(h.page.state.direction, null);
});

test('typed bounds lost when the panel closes are never retyped: the task stops after the bounded reads', async () => {
  let page;
  const h = harness(request('price-desc', '40', '60'), { beforeCall: (kind, calls) => {
    if (kind === 'read' && calls.at(-1) === 'fill_range' && !page.closedOnce) { page.closedOnce = true; page.leave({ clearInputs: true }); }
  } });
  page = h.page;
  await assert.rejects(runSearchPrice(h.context), { code: 'PRICE_CONTROL_NOT_CONFIRMED' });
  assert.equal(h.bridge.calls.filter(call => call === 'fill_range').length, 1);
  assert.equal(h.bridge.calls.includes('confirm'), false);
  assert.deepEqual(h.op.search_price.mismatches.map(entry => entry.reasons), [['range_panel_closed'], ['range_bounds_not_shown']]);
});

test('no task reopens overlays more than three times', async () => {
  let page;
  const h = harness(request('price-desc', '40', '60'), { beforeCall: (kind, calls) => {
    if (['pick', 'fill_range', 'confirm'].includes(kind) && !calls.includes(kind)) page.leave();
    if (kind === 'read' && calls.at(-1) === 'hover:价格' && calls.includes('confirm')) page.leave();
  } });
  page = h.page;
  await assert.rejects(runSearchPrice(h.context), { code: 'PRICE_CONTROL_NOT_CONFIRMED' });
  assert.deepEqual(h.op.search_price.reopens.map(reopen => reopen.trigger), ['action_unavailable', 'action_unavailable', 'action_unavailable']);
  assert.equal(h.op.search_price.plan[h.op.search_price.step].expect, 'direction_marked');
});

test('a pointer move saved before an interruption is resolved as uncertain and never resent', async () => {
  let page, crash = true;
  const h = harness(request('price-asc'), { beforeCall: (kind, calls) => { if (kind === 'pick' && !calls.includes('pick')) page.leave(); } });
  page = h.page;
  const commit = h.context.commit;
  h.context.commit = async () => {
    await commit();
    const hover = h.op.search_price.reopens.at(-1)?.hovers.at(-1);
    if (crash && hover?.tab === '综合' && hover.status === 'reserved') { crash = false; throw new Error('synthetic process stop'); }
  };
  await assert.rejects(runSearchPrice(h.context), /synthetic process stop/);
  const saved = structuredClone(h.commits.at(-1));
  assert.equal(saved.reopens[0].hovers[0].status, 'reserved');
  const before = h.bridge.calls.length;
  h.op.search_price = saved; h.context.commit = commit;
  const result = await runSearchPrice(h.context);
  assert.deepEqual(result.action_evidence.overlay_reopens[0].hovers, [
    { tab: '综合', status: 'uncertain', acknowledgement_error: 'READ_INTERRUPTED' }, { tab: '价格', status: 'acknowledged', acknowledgement_error: null }]);
  assert.equal(h.bridge.calls.slice(before)[0], 'hover:价格', 'the saved move to 综合 was not sent again');
});

test('reopen records are checked: overlay steps only, once per step, at most three, and an open move only on the current step', async () => {
  let page;
  const h = harness(request('price-desc', '40', '60'), { beforeCall: (kind, calls) => { if (kind === 'fill_range' && !calls.includes('fill_range')) page.leave(); } });
  page = h.page;
  await runSearchPrice(h.context);
  const final = h.op.search_price;
  validateSearchPriceState(final, root);
  const settle = stepIndexOf(final, step => step.expect === 'direction_applied');
  for (const mutate of [
    state => { state.reopens[0].step = settle; },
    state => { state.reopens.push(structuredClone(state.reopens[0])); },
    state => { state.reopens[0].trigger = 'read_closed'; },
    state => { state.reopens[0].hovers[1].tab = '价格'; },
    state => { state.reopens[0].hovers[1].status = 'reserved'; },
    state => { state.reopens[0].hovers.pop(); },
    state => { state.mismatches.push({ step: 0, expect: 'baseline', observation: 1, reasons: ['sales_selected'] }); },
  ]) {
    const copy = structuredClone(final); mutate(copy);
    assert.throws(() => validateSearchPriceState(copy, root), { code: 'INVALID_CHECKPOINT' });
  }
});

test('an ascending sort is read over three pages: each turn is confirmed and the last page reopens the price menu', async () => {
  const h = harness(request('price-asc'), {}, undefined, { pages: 3 });
  assert.deepEqual(h.op.search_price.plan.slice(-8).map(step => step.kind === 'hover' ? `hover:${step.tab}` : step.expect ?? `${step.kind}:${step.page}`),
    ['final', 'next_page:2', 'page_turned', 'next_page:3', 'page_turned', 'hover:综合', 'hover:价格', 'direction_kept']);
  const result = await runSearchPrice(h.context);
  assert.equal(h.bridge.calls.filter(call => call === 'next').length, 2);
  assert.deepEqual(result.pages.map(page => [page.search.page, page.pagination.current_page, page.pagination.total_pages_displayed]), [[2, 2, 8], [3, 3, 8]]);
  assert.deepEqual(result.paging, { requested_pages: 3, pages_read: 3, end_reason: 'requested_pages', total_pages_displayed: 8,
    last_page_checks: { page: 3, marked_option: '从低到高', reopened_input_text: null } });
  assert.deepEqual([...new Set(result.displayed_price_order.records.map(row => row.platform_page))].sort(), [1, 2, 3]);
  assert.equal(result.displayed_price_check.scope, 'read_pages_displayed_prices');
  assert.equal(result.limits.pages, 3);
  assert.deepEqual(result.action_evidence.actions.filter(action => action.kind === 'next_page').map(action => action.target), ['page:2', 'page:3']);
  validateSearchPriceResult(result, root, h.op.search_price);
});

test('with fewer result pages than requested, paging stops at the last page and its overlays are still checked', async () => {
  const h = harness(request('price-desc', '40', '60'), {}, undefined, { pages: 3 });
  const result = await runSearchPrice(h.context);
  // The synthetic range leaves two result pages: 下一页 is disabled on page 2, so nothing is clicked there.
  assert.equal(h.bridge.calls.filter(call => call === 'next').length, 2);
  assert.equal(result.action_evidence.actions.filter(action => action.kind === 'next_page').length, 1);
  assert.deepEqual(result.paging, { requested_pages: 3, pages_read: 2, end_reason: 'last_page', total_pages_displayed: 2,
    last_page_checks: { page: 2, marked_option: '从高到低', reopened_input_text: { minimum_text: '40', maximum_text: '60' } } });
  assert.equal(h.page.state.page, 2);
  validateSearchPriceResult(result, root, h.op.search_price);
});

test('a range with few matches (no pager, 相关商品较少 notice) is one page: only the cards above the notice count', async () => {
  // Live 2026-11-08: 戴森吹风机 400-600 stopped with SEARCH_PAGINATION_MISSING; the page had 10 results, the notice, then 20 recommendations.
  const one = harness(request('price-asc', '400', '600'), {}, { fewResultsAfterRange: 3 });
  const result = await runSearchPrice(one.context);
  assert.deepEqual(result.after.pagination, { current_page: 1, total_pages_displayed: null, next_disabled: true, previous_disabled: true,
    selected_sort_label: null, few_results_notice: '相关商品较少，为您推荐以下商品' });
  assert.deepEqual([result.after.search.cards_seen, result.after.search.cards_scanned], [3, 3]);
  assert.ok(!result.missing.includes('subsequent_pages'));
  validateSearchPriceResult(result, root, one.op.search_price);
  const paged = harness(request('price-asc', '400', '600'), {}, { fewResultsAfterRange: 3 }, { pages: 3 });
  const pages = await runSearchPrice(paged.context);
  assert.deepEqual([pages.paging.pages_read, pages.paging.end_reason, pages.paging.total_pages_displayed], [1, 'last_page', null]);
  assert.equal(pages.action_evidence.actions.filter(action => action.kind === 'next_page').length, 0, '下一页 is never clicked');
  validateSearchPriceResult(pages, root, paged.op.search_price);
  const forged = structuredClone(paged.op.search_price);
  forged.after.pagination.few_results_notice = '为您推荐';
  assert.throws(() => validateSearchPriceState(forged, root), { code: 'INVALID_CHECKPOINT' });
});

test('a page that does not turn is never confirmed or clicked again, and a lost sort on a later page is reported', async () => {
  const stuck = harness(request('price-asc'), {}, undefined, { pages: 2 });
  stuck.page.state.ignoreNext = true;
  await assert.rejects(runSearchPrice(stuck.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(stuck.bridge.calls.filter(call => call === 'next').length, 1);
  assert.deepEqual(stuck.op.search_price.mismatches.slice(-4).map(entry => entry.reasons), Array(4).fill(['page_not_reached']));
  let page;
  const reset = harness(request('price-asc'), { beforeCall: (kind, calls) => {
    if (kind === 'read' && calls.at(-1) === 'next') { page.state.comprehensive = true; page.state.totalPages = 100; page.refresh(); }
  } }, undefined, { pages: 2 });
  page = reset.page;
  await assert.rejects(runSearchPrice(reset.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.deepEqual(reset.op.search_price.mismatches.at(-1).reasons, ['total_pages_changed', 'comprehensive_selected']);
  assert.equal(reset.op.search_price.current_page, 1);
});

test('a next-page intent saved before an interruption is never sent again, and paging journals reject tampering', async () => {
  const h = harness(request('price-asc'), {}, undefined, { pages: 2 });
  const commit = h.context.commit;
  let stop = true;
  h.context.commit = async () => {
    await commit();
    const last = h.op.search_price.actions.at(-1);
    if (stop && last?.kind === 'next_page' && last.status === 'reserved') { stop = false; throw new Error('synthetic process stop'); }
  };
  await assert.rejects(runSearchPrice(h.context), /synthetic process stop/);
  h.op.search_price = structuredClone(h.commits.at(-1)); h.context.commit = commit;
  await assert.rejects(runSearchPrice(h.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(h.bridge.calls.includes('next'), false);
  assert.deepEqual(h.op.search_price.actions.find(action => action.kind === 'next_page'),
    { step: h.op.search_price.plan.findIndex(step => step.kind === 'next_page'), kind: 'next_page', status: 'uncertain', acknowledgement_error: 'READ_INTERRUPTED' });
  const done = harness(request('price-asc'), {}, undefined, { pages: 3 });
  await runSearchPrice(done.context);
  const final = done.op.search_price;
  for (const mutate of [
    state => { state.current_page = 2; },
    state => { state.pages.pop(); },
    state => { state.pages.reverse(); },
    state => { state.last_page_at = 3; },
    state => { state.requested_pages = 2; },
    state => { state.kept.direction = null; },
  ]) {
    const copy = structuredClone(final); mutate(copy);
    assert.throws(() => validateSearchPriceState(copy, root), { code: 'INVALID_CHECKPOINT' });
  }
});

const conditionRequest = () => createSearchPriceRequest({ query: root.query }, { allowNoPrice: true });

test('天猫, then 包邮, then an ascending sort over three pages: each condition is confirmed once and held on every page', async () => {
  const h = harness(request('price-asc'), {}, undefined, { pages: 3, conditions: { source: 'tmall', filters: ['包邮'] } });
  assert.deepEqual(h.op.search_price.plan.slice(0, 6).map(step => step.expect ?? step.source ?? step.label ?? step.tab),
    ['baseline', 'tmall', 'source_applied', '包邮', 'filter_applied', '综合']);
  const result = await runSearchPrice(h.context);
  assert.deepEqual(h.bridge.calls.filter(call => call !== 'read').slice(0, 2), ['source:tmall', 'filter:包邮']);
  assert.deepEqual(result.applied.source, { source: 'tmall', tab_label: '天猫', marker: 'active_tab_class', address_tab: 'mall' });
  assert.deepEqual(result.applied.filters, [{ label: '包邮', marker: 'selected_class' }]);
  assert.ok([result.after, ...result.pages].every(page => page.search.url.endsWith('&tab=mall')));
  assert.deepEqual([h.page.state.source, h.page.state.filters, h.page.state.page], ['tmall', ['包邮'], 3]);
  assert.equal(result.paging.end_reason, 'requested_pages');
  assert.deepEqual(result.action_evidence.mismatches, []);
  validateSearchPriceResult(result, root, h.op.search_price);
});

test('conditions alone, without a price sort or range, need no pointer moves and report no price check', async () => {
  const h = harness(conditionRequest(), {}, undefined, { pages: 2, conditions: { filters: ['包邮'] } });
  const result = await runSearchPrice(h.context);
  assert.ok(!h.bridge.calls.some(call => call.startsWith('hover')));
  assert.deepEqual([result.applied.price_sort, result.applied.price_range, result.applied.source], [null, null, null]);
  assert.equal(result.displayed_price_check.overall_status, 'not_requested');
  assert.equal(result.pages.length, 1);
  assert.throws(() => newSearchPriceState(conditionRequest()), { code: 'INVALID_ARGUMENTS' }, 'a task must request something');
});

test('a preselected filter is not a default start, a filter lost to the price sort stops the task, and an ignored 天猫 click is never repeated', async () => {
  const preset = harness(request('price-asc'), {}, undefined, { conditions: { filters: ['包邮'] } });
  preset.page.state.filters = ['包邮']; preset.page.refresh();
  await assert.rejects(runSearchPrice(preset.context), { code: 'PRICE_START_STATE_UNSUPPORTED' });
  assert.deepEqual(preset.op.search_price.mismatches[0].reasons, ['filters_preselected']);
  let page;
  const lost = harness(request('price-asc'), { beforeCall: (kind, calls) => {
    if (kind === 'read' && calls.at(-1) === 'pick') { page.state.filters = []; page.refresh(); }
  } }, undefined, { conditions: { filters: ['包邮'] } });
  page = lost.page;
  await assert.rejects(runSearchPrice(lost.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.ok(lost.op.search_price.mismatches.at(-1).reasons.includes('filter_lost'));
  const ignored = harness(request('price-asc'), {}, undefined, { conditions: { source: 'tmall' } });
  ignored.page.state.ignoreSource = true;
  await assert.rejects(runSearchPrice(ignored.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(ignored.bridge.calls.filter(call => call === 'source:tmall').length, 1);
  assert.deepEqual(ignored.op.search_price.mismatches.map(entry => entry.reasons), Array(4).fill(['source_not_reached']));
});

test('condition journals reject a changed request, a forged view and a filter outside the supported set', async () => {
  const h = harness(request('price-asc'), {}, undefined, { conditions: { source: 'tmall', filters: ['包邮'] } });
  await runSearchPrice(h.context);
  const final = h.op.search_price;
  for (const mutate of [
    state => { state.conditions.source = 'all'; },
    state => { state.conditions.filters = ['明日达']; },
    state => { state.conditions_view = null; },
    state => { state.after.search.url = state.after.search.url.replace('&tab=mall', '&tab=all'); },
  ]) {
    const copy = structuredClone(final); mutate(copy);
    assert.throws(() => validateSearchPriceState(copy, root), { code: 'INVALID_CHECKPOINT' });
  }
  assert.throws(() => newSearchPriceState(request('price-asc'), undefined, { conditions: { filters: ['包邮', '包邮'] } }), { code: 'INVALID_ARGUMENTS' });
});
