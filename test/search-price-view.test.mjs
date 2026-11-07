import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { searchTarget } from '../lib/search.mjs';
import { searchPriceScript, validateSearchPriceObservation, pickPriceDirectionScript, confirmPriceRangeScript,
  priceTabSelectorScript, validatePriceTabSelector, validatePriceControls, validatePriceReference,
  validatePriceClickAcknowledgement, nextPricePageScript, validateNextPriceAcknowledgement, validatePriceSnapshot,
  pickSourceScript, pickFilterScript } from '../lib/search-price.mjs';
import { priceSearchPage } from '../test-support/search-price-fixture.mjs';
import { searchCollectionScript } from '../lib/search-page-range.mjs';
import { failureCategory } from '../lib/task-policy.mjs';

const root = searchTarget('Synthetic mouse');
// The real bridge returns JSON; a round trip also removes the vm realm's prototypes.
const run = (script, page) => JSON.parse(JSON.stringify(vm.runInNewContext(script, page.context)));

test('a baseline price view reads comprehensive selection, closed overlays and pagination without a sort-label check', () => {
  const page = priceSearchPage();
  const raw = run(searchPriceScript(root), page);
  assert.equal(raw.state, 'observed');
  assert.deepEqual(raw.controls, { comprehensive_selected: true, sales_selected: false, price_selected: false, range_selected: false,
    direction_menu: null, range_panel: null, source_tab: '所有宝贝', selected_filters: [] });
  assert.equal(raw.pagination.selected_sort_label, null); assert.equal(raw.pagination.total_pages_displayed, 100);
  const observation = validateSearchPriceObservation(raw, root);
  assert.equal(observation.snapshot.search.page, 1);
  assert.equal(observation.snapshot.search.unsupported_cards_omitted, 1);
  assert.deepEqual(observation.snapshot.search.items.map(item => item.product_id), ['1001', '1002', '1003', '1004', '1005']);
  assert.equal(observation.snapshot.pagination.selected_sort_label, null);
  assert.equal(observation.controls.comprehensive_selected, true);
});

test('hovered price and range overlays expose only bounded labels, emphasis and input text', () => {
  const page = priceSearchPage();
  page.hover('价格');
  let controls = run(searchPriceScript(root), page).controls;
  assert.deepEqual(controls.direction_menu, { options: [{ label: '从低到高', emphasized: false }, { label: '从高到低', emphasized: false }] });
  assert.equal(controls.range_panel, null);
  page.hover('区间'); page.fill('minimum', '40');
  controls = run(searchPriceScript(root), page).controls;
  assert.equal(controls.direction_menu, null);
  assert.deepEqual(controls.range_panel, { minimum_text: '40', maximum_text: '' });
});

test('a guarded direction pick clicks exactly the requested visible option once', () => {
  const page = priceSearchPage();
  assert.deepEqual(run(pickPriceDirectionScript(root, '从低到高'), page), { state: 'price_control_unavailable' });
  assert.equal(page.state.direction, null);
  page.hover('价格');
  assert.deepEqual(run(pickPriceDirectionScript(root, '从低到高'), page), { state: 'action_dispatched', clicked: true });
  // The pointer still rests on 价格, so the re-rendered menu is open again (live 2026-10-12).
  assert.equal(page.state.direction, '从低到高'); assert.equal(page.state.menuOpen, true);
  const after = run(searchPriceScript(root), page);
  assert.equal(after.controls.comprehensive_selected, false); assert.equal(after.pagination.total_pages_displayed, 8);
  page.hover('综合'); page.hover('价格');
  assert.deepEqual(run(searchPriceScript(root), page).controls.direction_menu.options,
    [{ label: '从低到高', emphasized: true }, { label: '从高到低', emphasized: false }]);
  assert.throws(() => pickPriceDirectionScript(root, '价格最低'), { code: 'INVALID_ARGUMENTS' });
});

test('a guarded range confirmation clicks only the visible panel confirm control and reopening shows applied values', () => {
  const page = priceSearchPage();
  assert.deepEqual(run(confirmPriceRangeScript(root), page), { state: 'price_control_unavailable' });
  page.hover('区间'); page.fill('minimum', '40'); page.fill('maximum', '60');
  assert.deepEqual(run(confirmPriceRangeScript(root), page), { state: 'action_dispatched', clicked: true });
  const after = run(searchPriceScript(root), page);
  assert.equal(after.controls.range_selected, true);
  assert.deepEqual(after.controls.range_panel, { minimum_text: '40', maximum_text: '60' }, 'the pointer on 区间 keeps the panel open');
  assert.equal(after.pagination.total_pages_displayed, 2);
  page.hover('综合'); page.hover('区间');
  assert.deepEqual(run(searchPriceScript(root), page).controls.range_panel, { minimum_text: '40', maximum_text: '60' });
});

test('tab pointer selectors are unique to the requested sort-bar tab despite another otherSelector region', () => {
  const page = priceSearchPage();
  for (const [label, container, index] of [['综合', 'sortBarWrapInner', 1], ['价格', 'otherSelector', 1], ['区间', 'otherSelector', 2]]) {
    const raw = run(priceTabSelectorScript(root, label), page);
    const selector = validatePriceTabSelector(raw);
    assert.equal(selector, `:is([class^="sortBarWrapper--"], [class*=" sortBarWrapper--"]) :is([class^="${container}--"], [class*=" ${container}--"]) [role="tab"]:nth-child(${index})`);
    const matches = page.context.document.querySelectorAll(selector);
    assert.equal(matches.length, 1); assert.equal(matches[0].innerText, label);
  }
  assert.throws(() => priceTabSelectorScript(root, '销量'), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validatePriceTabSelector({ state: 'selector_ready', selector: 'body *' }), { code: 'INVALID_RESPONSE' });
});

test('price scripts honour gates, login prompts and unrelated locations without clicking', () => {
  const page = priceSearchPage();
  page.state.gate = 'slider'; page.refresh(); page.hover('价格');
  assert.equal(run(searchPriceScript(root), page).state, 'verification_required');
  assert.equal(run(pickPriceDirectionScript(root, '从低到高'), page).state, 'verification_required');
  assert.equal(page.state.direction, null);
  const loggedOut = priceSearchPage(); loggedOut.state.loggedOut = true; loggedOut.refresh();
  assert.equal(run(searchPriceScript(root), loggedOut).state, 'login_required');
  const moved = priceSearchPage(); moved.context.location.href = 'https://www.taobao.com/';
  assert.equal(run(searchPriceScript(root), moved).state, 'target_changed');
  assert.equal(run(confirmPriceRangeScript(root), moved).state, 'target_changed');
});

test('price control evidence rejects extra fields, unknown labels and unbounded text', () => {
  const valid = { comprehensive_selected: false, sales_selected: false, price_selected: false, range_selected: true,
    direction_menu: { options: [{ label: '从低到高', emphasized: false }, { label: '从高到低', emphasized: true }] },
    range_panel: { minimum_text: '40', maximum_text: '' }, source_tab: '天猫', selected_filters: ['包邮'] };
  assert.deepEqual(validatePriceControls(structuredClone(valid)), valid);
  // Unknown layouts read as null rather than as "nothing selected".
  assert.deepEqual(validatePriceControls({ ...structuredClone(valid), source_tab: null, selected_filters: null }).selected_filters, null);
  // The daemon reorders keys alphabetically; validation must accept that and return canonical order.
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  assert.equal(JSON.stringify(validatePriceControls(sorted(valid))), JSON.stringify(valid));
  for (const mutate of [
    value => { value.extra = true; },
    value => { value.range_selected = 'yes'; },
    value => { value.direction_menu.options[0].label = '价格最低'; },
    value => { value.direction_menu.options.pop(); },
    value => { value.range_panel.minimum_text = 'x'.repeat(41); },
    value => { value.range_panel.extra = ''; },
    value => { value.source_tab = ''; },
    value => { value.selected_filters = ['x'.repeat(13)]; },
    value => { delete value.selected_filters; },
  ]) {
    const value = structuredClone(valid); mutate(value);
    assert.throws(() => validatePriceControls(value), { code: 'INVALID_RESPONSE' });
  }
});

test('pointer references must be one exact control on the saved first page; click replies separate certain non-dispatch', () => {
  const url = 'https://s.taobao.com/search?page=1&q=Synthetic%20mouse&tab=all';
  const snapshot = refs => ({ url, snapshotData: { refs } });
  assert.equal(validatePriceReference(snapshot({ 3: { backendDOMNodeId: 9, role: 'tab', name: '价格' } }), root, 'tab', '价格'), '3');
  for (const data of [
    snapshot({}), snapshot({ 0: { backendDOMNodeId: 9, role: 'tab', name: '价格' }, 1: { backendDOMNodeId: 10, role: 'tab', name: '价格' } }),
    snapshot({ 0: { backendDOMNodeId: 9, role: 'button', name: '价格' } }), snapshot({ 'a b': { backendDOMNodeId: 9, role: 'tab', name: '价格' } }),
  ]) assert.throws(() => validatePriceReference(data, root, 'tab', '价格'), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validatePriceReference({ ...snapshot({ 0: { backendDOMNodeId: 9, role: 'tab', name: '价格' } }), url: `${url}&page=2` }, root, 'tab', '价格'),
    { code: 'TARGET_CHANGED' });
  assert.deepEqual(validatePriceClickAcknowledgement({ state: 'action_dispatched', clicked: true }), { clicked: true });
  for (const [value, code] of [[{ state: 'price_control_unavailable' }, 'PRICE_CONTROL_UNAVAILABLE'], [{ state: 'verification_required' }, 'VERIFICATION_REQUIRED'],
    [{ state: 'target_changed' }, 'TARGET_CHANGED']]) {
    assert.throws(() => validatePriceClickAcknowledgement(value), error => error.code === code && error.actionNotDispatched === true);
  }
  assert.throws(() => validatePriceClickAcknowledgement({ state: 'action_dispatched', clicked: false }),
    error => error.code === 'INVALID_RESPONSE' && !error.actionNotDispatched);
});

test('a logged-in results area that shows only the load-failure placeholder is a platform pause, not a layout change', () => {
  const page = priceSearchPage(); page.state.resultsFailed = true; page.refresh();
  const raw = run(searchPriceScript(root), page);
  assert.deepEqual(raw, { state: 'search_results_unavailable' });
  assert.throws(() => validateSearchPriceObservation(raw, root), { code: 'SEARCH_RESULTS_UNAVAILABLE' });
  assert.equal(failureCategory('SEARCH_RESULTS_UNAVAILABLE'), 'rate');
  // The shared collector gives the same answer to the multi-page search mode.
  assert.equal(run(searchCollectionScript(root, { allowedPages: [1] }), page).state, 'search_results_unavailable');
  // Logged out, the login prompt still takes precedence.
  page.state.loggedOut = true; page.refresh();
  assert.equal(run(searchPriceScript(root), page).state, 'login_required');
});

test('a guarded 下一页 click moves a sorted view to page 2, which is then read with its own page identity', () => {
  const page = priceSearchPage();
  page.hover('价格'); run(pickPriceDirectionScript(root, '从低到高'), page);
  const first = validateSearchPriceObservation(run(searchPriceScript(root), page), root);
  const from = { page: 1, product_ids: first.snapshot.search.items.map(item => item.product_id) };
  assert.equal(run(nextPricePageScript(root, from), page).state, 'action_dispatched');
  assert.equal(page.state.page, 2);
  assert.throws(() => validateSearchPriceObservation(run(searchPriceScript(root), page), root), /./, 'the first-page reader refuses page 2');
  const second = validateSearchPriceObservation(run(searchPriceScript(root, 2), page), root, 2);
  assert.equal(second.snapshot.search.page, 2);
  assert.deepEqual([second.snapshot.pagination.current_page, second.snapshot.pagination.total_pages_displayed], [2, 8]);
  assert.equal(second.controls.comprehensive_selected, false);
  assert.ok(second.snapshot.search.items.every(item => !from.product_ids.includes(item.product_id)));
  validatePriceSnapshot(second.snapshot, root, 2);
  assert.throws(() => validatePriceSnapshot(second.snapshot, root, 1), { code: 'INVALID_CHECKPOINT' });
  assert.equal(validatePriceTabSelector(run(priceTabSelectorScript(root, '价格', 2), page)).length > 0, true);
  assert.equal(run(priceTabSelectorScript(root, '价格', 1), page).state, 'target_changed');
});

test('the 下一页 click is refused for a changed card order or page, and reports the last page without clicking', () => {
  const page = priceSearchPage();
  const first = validateSearchPriceObservation(run(searchPriceScript(root), page), root);
  const ids = first.snapshot.search.items.map(item => item.product_id);
  assert.equal(run(nextPricePageScript(root, { page: 1, product_ids: [...ids].reverse() }), page).state, 'target_changed');
  assert.equal(run(nextPricePageScript(root, { page: 2, product_ids: ids }), page).state, 'target_changed');
  assert.equal(page.state.page, 1, 'nothing was clicked');
  page.state.totalPages = 1; page.refresh();
  const last = run(nextPricePageScript(root, { page: 1, product_ids: ids }), page);
  assert.equal(last.state, 'last_page');
  assert.throws(() => validateNextPriceAcknowledgement(last), error => error.code === 'LAST_PAGE_REACHED' && error.actionNotDispatched === true);
  assert.deepEqual(validateNextPriceAcknowledgement({ state: 'action_dispatched', clicked: true }), { clicked: true });
  for (const from of [{ page: 5, product_ids: [] }, { page: 1, product_ids: ['x'] }, null]) {
    assert.throws(() => nextPricePageScript(root, from), { code: 'INVALID_ARGUMENTS' });
  }
});

test('while a page turn settles, the previous page is a transition only when the read allows it', () => {
  const page = priceSearchPage();
  const transition = run(searchPriceScript(root, 2, { allowPrevious: true }), page);
  assert.deepEqual(transition, { state: 'page_transition', page_state: { visible: true, focused: true } });
  assert.deepEqual(validateSearchPriceObservation(transition, root, 2, { allowPrevious: true }), { transition: true, page_state: { visible: true, focused: true } });
  assert.throws(() => validateSearchPriceObservation(transition, root, 2), /./);
  assert.equal(run(searchPriceScript(root, 2), page).state, 'target_changed');
});

test('the controls read the selected source tab and filters; 天猫 switches the address to tab=mall and clears filters', () => {
  const page = priceSearchPage();
  const strip = () => page.context.document.querySelectorAll('[class*="filterItem--"]');
  [...strip()].find(node => node.innerText.trim() === '包邮').click();
  let raw = run(searchPriceScript(root), page);
  assert.deepEqual([raw.controls.source_tab, raw.controls.selected_filters], ['所有宝贝', ['包邮']]);
  [...page.context.document.querySelectorAll('[class*="baseStyle--"]')].find(node => node.innerText.trim() === '天猫').click();
  assert.match(page.context.location.href, /&tab=mall$/);
  assert.equal(run(searchPriceScript(root), page).state, 'target_changed', 'the 所有宝贝 reader refuses the 天猫 view');
  raw = run(searchPriceScript(root, 1, { source: 'tmall' }), page);
  assert.deepEqual([raw.controls.source_tab, raw.controls.selected_filters], ['天猫', []]);
  const observation = validateSearchPriceObservation(raw, root, 1, { source: 'tmall' });
  assert.match(observation.snapshot.search.url, /&tab=mall$/);
  validatePriceSnapshot(observation.snapshot, root, 1, 'tmall');
  assert.throws(() => validatePriceSnapshot(observation.snapshot, root, 1), { code: 'INVALID_CHECKPOINT' });
  const transition = run(searchPriceScript(root, 1, { source: 'tmall', previousSource: 'all' }), priceSearchPage());
  assert.deepEqual(validateSearchPriceObservation(transition, root, 1, { source: 'tmall', previousSource: 'all' }).transition, true);
});

test('guarded clicks select 天猫 from 所有宝贝 and 包邮 in the current source, and refuse anything else without clicking', () => {
  const page = priceSearchPage();
  assert.deepEqual(run(pickFilterScript(root, '包邮'), page), { state: 'action_dispatched', clicked: true });
  assert.deepEqual(page.state.filters, ['包邮']);
  assert.equal(run(pickFilterScript(root, '包邮', 'tmall'), page).state, 'target_changed', 'a 天猫 click guard refuses the 所有宝贝 page');
  assert.deepEqual(run(pickSourceScript(root, 'tmall'), page), { state: 'action_dispatched', clicked: true });
  assert.deepEqual([page.state.source, page.state.filters], ['tmall', []]);
  assert.equal(run(pickSourceScript(root, 'tmall'), page).state, 'target_changed', 'the source click only starts from 所有宝贝');
  assert.deepEqual(run(pickFilterScript(root, '包邮', 'tmall'), page), { state: 'action_dispatched', clicked: true });
  assert.deepEqual(page.state.filters, ['包邮']);
  const gated = priceSearchPage(); gated.state.gate = 'slider'; gated.refresh();
  assert.equal(run(pickFilterScript(root, '包邮'), gated).state, 'verification_required');
  assert.deepEqual(gated.state.filters, []);
  assert.throws(() => pickFilterScript(root, '明日达'), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => pickSourceScript(root, 'taobao'), { code: 'INVALID_ARGUMENTS' });
  const missing = priceSearchPage(); missing.context.document.querySelectorAll('[class*="filterItem--"]').forEach(node => { node.hidden = true; });
  assert.equal(run(pickFilterScript(root, '包邮'), missing).state, 'price_control_unavailable');
});
