import test from 'node:test';
import assert from 'node:assert/strict';
import { orderPageScript, validateOrderPage, validateOrderPageSnapshot, validateEmptyOrderPage, orderPageIds } from '../lib/order-page-view.mjs';
import { validateSavedOrderRows } from '../lib/order-rows.mjs';
import { cartNode as node } from '../test-support/cart-fixture.mjs';
import { observeOrderPage, orderPageGroups, orderTarget } from '../test-support/order-fixture.mjs';

// Fixture nodes answer getAttribute('class') from their construction, so a changed class needs both views updated.
function setClass(target, classes, attributes = {}) {
  const original = target.getAttribute.bind(target);
  target.className = classes;
  target.getAttribute = name => name === 'class' ? classes : Object.hasOwn(attributes, name) ? attributes[name] : original(name);
}
const pagerOf = main => main.children.at(-1).children[0];
const read = (groups, options = {}) => validateOrderPage(observeOrderPage(groups, options).value, orderTarget, options.allowedPages ?? [options.page ?? 1]);

test('a page read returns every loaded order with the displayed pager and the default view', () => {
  const { page } = read(orderPageGroups(1), { page: 1, total: 9 });
  assert.equal(page.rows.schema_version, 4);
  assert.equal(page.rows.orders.length, 30);
  assert.equal(page.rows.coverage.loaded_orders_seen, 30);
  assert.equal(page.rows.coverage.orders_omitted, 0);
  assert.equal(page.rows.limits.order_positions, 50);
  assert.deepEqual(page.pager, { current_page: 1, total_pages_displayed: 9, previous_disabled: true, next_disabled: false });
  assert.deepEqual(page.view, { tab: '所有订单', order_search_empty: true });
  assert.deepEqual(orderPageIds(page).slice(0, 2), ['1001', '1002']);
  assert.equal(JSON.stringify(page).includes('PRIVATE'), false);
});

test('a page with more than fifty loaded groups returns fifty and reports the rest as omitted', () => {
  const { page } = read(orderPageGroups(2, 55), { page: 2, total: 3 });
  assert.equal(page.rows.orders.length, 50);
  assert.equal(page.rows.coverage.orders_omitted, 5);
});

test('the last page reports both controls consistently', () => {
  const { page } = read(orderPageGroups(3, 4), { page: 3, total: 3 });
  assert.deepEqual(page.pager, { current_page: 3, total_pages_displayed: 3, previous_disabled: false, next_disabled: true });
});

test('a list frame without orders is reported with its pager and view only, and never guards a click', () => {
  const raw = observeOrderPage([], { page: 9, total: 9 }).value;
  assert.deepEqual(Object.keys(raw).sort(), ['observed_at', 'pager', 'state', 'url', 'view']);
  const result = validateOrderPage(raw, orderTarget, [8, 9]);
  assert.equal(result.state, 'no_orders');
  assert.deepEqual(result.empty_page.pager, { current_page: 9, total_pages_displayed: 9, previous_disabled: false, next_disabled: true });
  assert.deepEqual(result.empty_page.view, { tab: '所有订单', order_search_empty: true });
  assert.equal(validateEmptyOrderPage(result.empty_page, orderTarget, 9), result.empty_page);
  assert.throws(() => validateEmptyOrderPage(result.empty_page, orderTarget, 8), { code: 'INVALID_CHECKPOINT' });
  const middle = validateOrderPage(observeOrderPage([], { page: 2, total: 9 }).value, orderTarget, [2]).empty_page;
  assert.throws(() => validateEmptyOrderPage(middle, orderTarget, 2), { code: 'INVALID_CHECKPOINT' });
  assert.throws(() => validateOrderPage({ ...raw, extra: 1 }, orderTarget, [9]), { code: 'INVALID_RESPONSE' });
  const { page } = read(orderPageGroups(1), { page: 1, total: 9 });
  const guarded = observeOrderPage([], { page: 1, total: 9, before: page });
  assert.deepEqual(guarded.value, { state: 'target_changed' });
  assert.deepEqual(guarded.clicks, []);
});

test('a non-default tab or search is reported without returning the typed search text', () => {
  const raw = observeOrderPage(orderPageGroups(1), { view: { tab: '待收货', search: 'PRIVATE_QUERY' } }).value;
  assert.equal(JSON.stringify(raw).includes('PRIVATE_QUERY'), false);
  assert.deepEqual(validateOrderPage(raw, orderTarget, [1]).page.view, { tab: '待收货', order_search_empty: false });
  const missing = read(orderPageGroups(1), { decorate: ({ main }) => { main.children.splice(1, 1); } });
  assert.equal(missing.page.view.order_search_empty, null);
});

test('a page outside the saved allowance is a changed target', () => {
  assert.throws(() => read(orderPageGroups(3), { page: 3, total: 9, allowedPages: [1, 2] }), { code: 'TARGET_CHANGED' });
});

test('unsupported pager layouts stop as structure changes', () => {
  const layouts = [
    ({ main }) => { main.children.pop(); },
    ({ main }) => { main.children.push(node('extra', '', [node('ant-pagination', '', [])])); },
    ({ main }) => { setClass(pagerOf(main).children[1], 'ant-pagination-item ant-pagination-item-1'); },
    ({ main }) => { setClass(pagerOf(main).children[0], 'ant-pagination-prev', { 'aria-disabled': 'false' }); },
    ({ main }) => { setClass(pagerOf(main).children[1], 'ant-pagination-item ant-pagination-item-7 ant-pagination-item-active'); },
    ({ main }) => { pagerOf(main).children.splice(-2, 1); },
  ];
  for (const decorate of layouts) {
    assert.throws(() => read(orderPageGroups(1), { page: 1, total: 9, decorate }), { code: 'PAGE_STRUCTURE_CHANGED' });
  }
});

test('the next click is guarded by the saved page number, order IDs and view', () => {
  const { page } = read(orderPageGroups(1), { page: 1, total: 9 });
  const clicked = observeOrderPage(orderPageGroups(1), { page: 1, total: 9, before: page });
  assert.deepEqual(clicked.value, { state: 'action_dispatched', clicked: true });
  assert.deepEqual(clicked.clicks, ['next']);
  // The platform revises its displayed total while paging, so a different total alone does not block the click.
  assert.deepEqual(observeOrderPage(orderPageGroups(1), { page: 1, total: 8, before: page }).clicks, ['next']);
  for (const options of [
    { groups: orderPageGroups(1, 30, ['999']) },
    { groups: orderPageGroups(1, 29) },
    { view: { tab: '待付款' } },
    { view: { search: 'x' } },
  ]) {
    const result = observeOrderPage(options.groups ?? orderPageGroups(1), { page: 1, total: 9, view: options.view, before: page });
    assert.deepEqual(result.value, { state: 'target_changed' });
    assert.deepEqual(result.clicks, []);
  }
  const dialog = node('', '', [], { attributes: { role: 'dialog' } });
  const blocked = observeOrderPage(orderPageGroups(1), { page: 1, total: 9, before: page, extras: [dialog] });
  assert.deepEqual(blocked.value, { state: 'blocked_unknown' });
  assert.deepEqual(blocked.clicks, []);
});

test('a click cannot be built for the last page or for an unsaved page', () => {
  const last = read(orderPageGroups(3, 4), { page: 3, total: 3 }).page;
  assert.throws(() => orderPageScript(orderTarget, { allowedPages: [3], before: last }), { code: 'INVALID_ARGUMENTS' });
  const first = read(orderPageGroups(1), { page: 1, total: 3 }).page;
  assert.throws(() => orderPageScript(orderTarget, { allowedPages: [1, 2], before: first }), { code: 'INVALID_ARGUMENTS' });
  for (const allowedPages of [[], [0], [1, 2, 3], [1, 1], ['1']]) {
    assert.throws(() => orderPageScript(orderTarget, { allowedPages }), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => orderPageScript({ url: 'https://buyertrade.taobao.com/other' }, { allowedPages: [1] }), { code: 'INVALID_TARGET' });
});

test('saved pages revalidate offline and reject tampering or older snapshot formats', () => {
  const { page } = read(orderPageGroups(2), { page: 2, total: 3 });
  assert.equal(validateOrderPageSnapshot(page, orderTarget, 2), page);
  for (const mutate of [
    value => { value.pager.current_page = 3; },
    value => { value.pager.next_disabled = true; },
    value => { value.view.extra = true; },
    value => { value.rows.orders[0].order_id = '1'; },
    value => { value.rows.schema_version = 1; },
    value => { value.extra = true; },
  ]) {
    const copy = structuredClone(page); mutate(copy);
    assert.throws(() => validateOrderPageSnapshot(copy, orderTarget, 2), { code: 'INVALID_CHECKPOINT' });
  }
  assert.throws(() => validateOrderPageSnapshot(page, orderTarget, 3), { code: 'INVALID_CHECKPOINT' });
  assert.throws(() => validateSavedOrderRows(page.rows, orderTarget), { code: 'INVALID_CHECKPOINT' });
});
