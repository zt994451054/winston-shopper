import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { orderRowsScript, validateOrderRows, validateSavedOrderRows } from '../lib/order-rows.mjs';
import { parseOrderDetailUrl } from '../lib/order-target.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';
import { cartNode as node } from '../test-support/cart-fixture.mjs';
import { orderTarget as target, orderGroup, orderItem, observeOrders } from '../test-support/order-fixture.mjs';

const snapshot = groups => validateOrderRows(observeOrders(groups.map(group => group.group)), target);
function append(parent, child) { parent.children.push(child); child.parentElement = parent; }
test('five order positions preserve multi-item groups, labels and raw dates without amount allocation', () => {
  const groups = Array.from({ length: 7 }, (_, index) => orderGroup(index + 1, { itemCount: index === 1 ? 3 : 1, tmall: index === 0 }));
  const value = snapshot(groups);
  assert.equal(value.orders.length, 5); assert.equal(value.coverage.loaded_orders_seen, 7); assert.equal(value.coverage.orders_omitted, 2);
  assert.equal(value.orders[1].items.length, 3);
  assert.equal(value.orders[0].status_region.text, '交易关闭');
  assert.equal(value.orders[0].payment_observations.items[0].label.text, '实付款');
  assert.equal(value.orders[0].payment_observations.items[0].level, 'order');
  assert.equal(value.orders[0].items[0].price_observations.items[0].level, 'item');
  assert.equal(value.orders[0].payment_observations.settlement_verified, false);
  assert.equal(value.orders[0].payment_observations.item_allocation_verified, false);
  assert.equal(value.orders[0].items[0].price_observations.unit_price_verified, false);
  assert.equal(value.orders[0].items[0].quantity.value, 2);
  assert.equal(value.orders[0].items[0].title, 'Synthetic item 1');
  assert.equal(value.orders[0].detail_entry.order_binding_verified, true);
  assert.equal(value.orders[0].placed_at_region.text, '2026-01-01');
  assert.equal(value.coverage.full_order_history, false); assert.equal(value.coverage.page_total_orders, null);
  assert.equal(value.coverage.filters_verified, false); assert.equal(value.privacy.contact_fields_read, false);
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
});
test('order ID is taken only from the explicit header label and stays a string', () => {
  const group = orderGroup(1, { orderId: '0009007199254740993001' }), value = snapshot([group]);
  assert.equal(value.orders[0].order_id, '0009007199254740993001');
  const raw = observeOrders([group.group]); raw.orders[0].order_id_region.text = '商品编号：123';
  assert.equal(validateOrderRows(raw, target).orders[0].order_id, null);
});
test('both observed detail routes strip tracking and bind only to the printed order ID', () => {
  assert.deepEqual(parseOrderDetailUrl('https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=001&tracking=PRIVATE#PRIVATE'),
    { order_id: '001', url: 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=001' });
  const raw = observeOrders([orderGroup().group]);
  raw.orders[0].detail_link = parseOrderDetailUrl('https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=999');
  const order = validateOrderRows(raw, target).orders[0];
  assert.equal(order.detail_entry.url, null); assert.equal(order.detail_entry.order_binding_verified, false);
});
test('lookalike, HTTP, credentials, unsupported paths, duplicate IDs and product IDs are not order-detail identities', () => {
  for (const url of ['http://trade.tmall.com/detail/orderDetail.htm?bizOrderId=1',
    'https://trade.tmall.com.example.test/detail/orderDetail.htm?bizOrderId=1',
    'https://user:secret@trade.tmall.com/detail/orderDetail.htm?bizOrderId=1',
    'https://trade.tmall.com:8443/detail/orderDetail.htm?bizOrderId=1',
    'https://trade.tmall.com/detail/other.htm?bizOrderId=1',
    'https://trade.tmall.com/detail/orderDetail.htm?id=1',
    'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=1&bizOrderId=2',
    'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=not-an-id']) assert.equal(parseOrderDetailUrl(url), null);
});
test('item limit, text truncation and price/information component limits are reported', () => {
  const group = orderGroup(1, { itemCount: 12 });
  const first = group.items[0];
  append(first.titleText, node('', 'a'.repeat(510)));
  for (let index = 0; index < 11; index++) append(first.content, node('infoContent--extra', 'Additional item information'));
  for (let index = 0; index < 11; index++) append(first.column, node('trade-price-container', '￥1.00'));
  const value = snapshot([group]), order = value.orders[0], item = order.items[0];
  assert.equal(order.items.length, 10); assert.equal(order.coverage.items_omitted, 2);
  assert.equal(order.coverage.full_order_items_verified, false);
  assert.equal(item.title, null); assert.equal(item.title_region.truncated, true);
  assert.equal(item.item_information.items.length, 10); assert.equal(item.item_information.truncated, true);
  assert.equal(item.price_observations.items.length, 10); assert.equal(item.price_observations.truncated, true);
});
test('unclassified item text is preserved without declaring all snippets to be specifications', () => {
  const group = orderGroup(); append(group.items[0].content, node('infoContent--service', '合成服务说明'));
  const item = snapshot([group]).orders[0].items[0];
  assert.equal(item.item_information.items.length, 2); assert.equal(item.item_information.interpretation, 'unclassified_item_text');
  assert.equal(item.association.sku_id, null); assert.equal(item.association.sku_binding_verified, false);
});
test('unknown or truncated quantity formats do not silently produce a number', () => {
  const raw = observeOrders([orderGroup().group]);
  for (const text of ['2', '×2', 'x0', 'x-1', 'x2 extra', 'x1000000000']) {
    raw.orders[0].items[0].quantity = { text, truncated: false };
    assert.equal(validateOrderRows(raw, target).orders[0].items[0].quantity.value, null);
  }
  raw.orders[0].items[0].quantity = { text: 'x2', truncated: true };
  assert.equal(validateOrderRows(raw, target).orders[0].items[0].quantity.verified, false);
});
test('duplicate item title or quantity sources remain unknown instead of choosing the first', () => {
  const group = orderGroup(), item = group.items[0];
  append(item.content, orderItem(2).anchor); append(item.column, node('quantity--duplicate', 'x5'));
  const value = snapshot([group]).orders[0].items[0];
  assert.equal(value.title, null); assert.equal(value.product_id, null); assert.equal(value.quantity.value, null);
});
test('missing optional header fields return explicit missing values', () => {
  const group = orderGroup(); group.header.children.splice(group.header.children.indexOf(group.shop), 1);
  assert.equal(snapshot([group]).orders[0].shop_name_region, null);
});
test('unknown item link is omitted while a uniquely sourced title remains usable', () => {
  const raw = observeOrders([orderGroup().group]); raw.orders[0].items[0].product_link = null;
  const item = validateOrderRows(raw, target).orders[0].items[0];
  assert.equal(item.title, 'Synthetic item 1'); assert.equal(item.url, null); assert.ok(item.missing.includes('product_link'));
});
test('empty, duplicate, nested or misplaced order roots stop rather than claiming no orders', () => {
  const group = orderGroup();
  for (const raw of [observeOrders([]), observeOrders([group.group], { extras: [node('trade-main-content')] }),
    observeOrders([node('wrapper', '', [orderGroup().group])]),
    observeOrders([orderGroup().group], { decorate: ({ root }) => root.children.push(node('trade-content-container')) })]) {
    assert.throws(() => validateOrderRows(raw, target), { code: 'PAGE_STRUCTURE_CHANGED' });
  }
});
test('misplaced header or payment and nested item groups do not mix values across levels', () => {
  const headerGroup = orderGroup(); headerGroup.header.parentElement = headerGroup.columns;
  const paymentGroup = orderGroup(); paymentGroup.payment.parentElement = paymentGroup.group;
  const itemGroup = orderGroup(); itemGroup.items[0].item.parentElement = itemGroup.group;
  for (const group of [headerGroup, paymentGroup, itemGroup]) {
    assert.throws(() => validateOrderRows(observeOrders([group.group]), target), { code: 'PAGE_STRUCTURE_CHANGED' });
  }
});
test('page loading, login, verification and rate states stop before reading order values', () => {
  for (const [raw, code] of [
    [observeOrders([orderGroup().group], { loading: true }), 'PAGE_LOADING'],
    [observeOrders([orderGroup().group], { extras: [node('loginDialog--fixture', '请登录', [], { attributes: { role: 'dialog' } })] }), 'LOGIN_REQUIRED'],
    [observeOrders([orderGroup().group], { extras: [node('', '', [], { attributes: { id: 'nc_1_wrapper' } })] }), 'VERIFICATION_REQUIRED'],
    [observeOrders([orderGroup().group], { decorate: ({ document }) => { document.title = '请求频繁'; } }), 'RATE_LIMITED'],
  ]) assert.throws(() => validateOrderRows(raw, target), { code });
});
test('identity guard runs before unrelated DOM access and does not leak query values', () => {
  const raw = vm.runInNewContext(orderRowsScript(target), { URL, location: { href: 'https://mail.example.test/?secret=PRIVATE' } });
  assert.throws(() => validateOrderRows(raw, target), { code: 'TARGET_CHANGED' });
  assert.equal(JSON.stringify(raw).includes('PRIVATE'), false);
});
test('extra keys, impossible counts, swapped positions and unsupported derived link fields are rejected', () => {
  const base = observeOrders([orderGroup().group]);
  const mutations = [value => { value.account = 'PRIVATE'; }, value => { value.loaded_orders_seen = 0; },
    value => { value.orders[0].position = 2; }, value => { value.orders[0].items[0].position = 2; },
    value => { value.orders[0].loaded_items_seen = 2; }, value => { value.orders[0].items[0].product_link.sku_id = '123'; },
    value => { value.orders[0].payment.truncated = 'false'; }, value => { value.orders[0].items[0].information.items[0] = null; }];
  for (const mutate of mutations) { const raw = structuredClone(base); mutate(raw); assert.throws(() => validateOrderRows(raw, target), { code: 'INVALID_RESPONSE' }); }
});
test('saved snapshots revalidate without upgrading coverage, payment or order associations', () => {
  const value = snapshot([orderGroup()]); assert.equal(validateSavedOrderRows(value, target), value);
  const mutations = [v => { v.coverage.full_order_history = true; }, v => { v.orders[0].order_id = '999'; },
    v => { v.orders[0].items[0].quantity.value = 99; }, v => { v.orders[0].payment_observations.settlement_verified = true; },
    v => { v.orders[0].detail_entry.url = 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=999'; },
    v => { v.privacy.contact_fields_read = true; }];
  for (const mutate of mutations) { const saved = structuredClone(value); mutate(saved); assert.throws(() => validateSavedOrderRows(saved, target), { code: 'INVALID_CHECKPOINT' }); }
});
test('production bridge performs one fixed read and validates its response without retries', async t => {
  const server = await mockBridge(t); server.state.metadata = observeOrders([orderGroup().group]);
  const value = await new BrowserBridge(server.endpoint).readOrderRows(41, target);
  assert.equal(value.orders.length, 1); assert.equal(server.state.commands.length, 1); assert.equal(server.state.commands[0].action, 'eval');
  server.state.metadata = { state: 'structure_changed' };
  await assert.rejects(new BrowserBridge(server.endpoint).readOrderRows(41, target), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.equal(server.state.commands.length, 2);
});
test('invalid target and tab fail before any browser IO', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  await assert.rejects(bridge.readOrderRows(41, { url: 'https://mail.example.test/' }), { code: 'INVALID_TARGET' });
  await assert.rejects(bridge.readOrderRows(0, target), { code: 'INVALID_TAB' }); assert.equal(server.state.requests.length, 0);
});
