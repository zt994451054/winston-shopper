import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBridge, PACED_METHODS } from '../lib/bridge.mjs';
import { JD_ORDER_ITEM_LIMIT, JD_ORDER_LIMIT, jdOrdersScript, validateJdOrders, validateSavedJdOrders } from '../lib/jd/orders.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { element, jdOrdersPage, orderCard, orderGroup, orderItem, splitBanner } from '../test-support/jd-orders-fixture.mjs';

const AT = '2026-10-16T00:00:00.000Z';
const LIST = 'https://order.jd.com/center/list.action';

function read(options, observedAt = AT) {
  const page = jdOrdersPage(options);
  const raw = page.evaluate(jdOrdersScript(page.target));
  return { page, raw, result: validateJdOrders(raw, page.target, { observedAt }) };
}

function absent(value, secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
}

function item(id, title, quantity) {
  return { position: 0, product_id: id, url: `https://item.jd.com/${id}.html`, title, quantity };
}

test('the loaded order cards and split notices are read, and private page text stays out', () => {
  const page = jdOrdersPage();
  const script = jdOrdersScript(page.target);
  assert.equal(page.readyState, 'loading');
  assert.equal(JD_ORDER_LIMIT, 50);
  assert.equal(JD_ORDER_ITEM_LIMIT, 10);
  assert.doesNotMatch(script, /\.click\(|scrollIntoView|scrollTo|scrollBy|fetch\(|XMLHttpRequest|cookie|Storage|location\.assign/);
  assert.equal(script.includes('JD_ORDER_LIMIT'), false);
  assert.equal(script.includes('JD_ORDER_ITEM_LIMIT'), false);
  assert.match(script, /\{"orders":50,"items":10\}/);
  const raw = page.evaluate(script);
  const result = validateJdOrders(raw, page.target, { observedAt: AT });
  assert.equal(raw.orders[0].items[0].url, undefined);
  assert.equal(raw.items_returned, undefined);
  const row = (position, group, split, id, time, shop, status, amount, notes, detail, items, seen) => ({
    position, group_position: group, split_order: split, order_id: id, order_time_text: time, shop_name: shop, status_text: status,
    amount_text: amount, amount_note_texts: notes, detail_entry: detail,
    items: items.map((entry, index) => ({ ...entry, position: index + 1 })), items_seen: seen, items_returned: items.length,
  });
  assert.equal(JSON.stringify(result), JSON.stringify({
    schema_version: 1, platform: 'jd', url: LIST, source: 'jd_order_list_dom', observed_at: AT, login_verified: false,
    time_range_text: '近3个月订单', status_filter_text: '全部',
    orders: [
      row(1, 1, false, '123456789012', '2026-09-01 10:20:30', '合成数码旗舰店', '已完成', '¥127.21', ['获得了7京豆'], true, [
        item('10086001', '合成蓝牙鼠标 静音款', 1), item('10086002', '合成鼠标垫 大号', 2),
      ], 2),
      row(2, 2, false, '210000000002', '2026-09-02 11:00:00', '合成百货小店', '已取消', '¥0.00', [], false, [
        item('10086003', '合成赠品袋', 1),
      ], 1),
      row(3, 3, true, '1234567890123456', '2026-08-15 08:05:00', '合成数码旗舰店', '待收货', '¥89.00', [], true, [
        item('10086004', '合成键盘 青轴', 1),
      ], 1),
      row(4, 4, true, '1234567890123457', '2026-08-15 08:06:00', '合成配件专营店', '待收货', '¥12.00', [], true, [
        item('10086005', '合成键帽 一套', 3),
      ], 1),
    ],
    split_notices: [{ position: 1, group_position: 3, info_texts: ['2026-08-15 08:00:00', null, '合成原单说明丙'],
      notice_text: '合成拆单提示这单被拆开了', detail_entry: true }],
    groups_seen: 4, orders_seen: 4, orders_returned: 4, orders_omitted: 0, items_seen: 5, items_returned: 5,
    coverage: { status: 'partial', scope: 'loaded_orders_only', scrolled: false, full_order_history: false,
      time_range_verified: false, amount_meaning_verified: false },
    missing: ['orders_not_loaded', 'orders_outside_time_range', 'order_details'],
    excluded: ['consignee', 'address', 'payment', 'account', 'images', 'action_buttons', 'internal_ids'],
  }));
  assert.equal(result.split_notices.some(notice => notice.group_position === 4), false);
  const text = JSON.stringify(result);
  for (const secret of ['合成收货人', '在线支付', '立即购买', '评价', '更多', '查看发票', '申请售后', '合成昵称甲', '订单详情', '拆单详情',
    'img.synthetic.invalid', 'synthetic.invalid/after-', 'synthetic-spm', 'http://item.jd.com']) {
    assert.equal(text.includes(secret), false, secret);
  }
  absent(raw, page.secrets);
  absent(result, page.secrets);
  validateSavedJdOrders(result, page.target);
});

test('orders past 50 and items past 10 are counted and not parsed, and notes, segments and long fields are cut', () => {
  const bulkId = index => String(820000000000 + index);
  const limited = read({ groups: Array.from({ length: JD_ORDER_LIMIT + 1 }, (_, index) => orderGroup({ cards: [orderCard({
    orderId: bulkId(index + 1), shop: '合成批量店', time: '2026-09-03 12:00:00', status: '已完成', amount: ['¥', '1', '.00'],
    items: index === JD_ORDER_LIMIT
      ? [1, 2, 3].map(itemIndex => orderItem({ id: String(910000000000 + itemIndex), title: `合成超限商品${itemIndex}`, quantity: 1 }))
      : [orderItem({ id: String(830000000000 + index + 1), title: `合成批量商品${index + 1}`, quantity: 1 })],
  })] })) });
  const limitedText = JSON.stringify(limited.result);
  assert.deepEqual([limited.result.orders_seen, limited.result.orders_returned, limited.result.orders_omitted, limited.result.groups_seen,
    limited.result.items_seen, limited.result.items_returned], [51, 50, 1, 51, 53, 50]);
  assert.equal(limited.result.orders[49].order_id, bulkId(50));
  assert.equal(limited.result.orders[49].group_position, 50);
  assert.equal(limited.result.orders[49].items[0].product_id, '830000000050');
  assert.equal(limited.result.orders.every(order => order.items_returned === 1), true);
  for (const secret of [bulkId(51), '合成超限商品1', '910000000001', '合成超限商品3']) assert.equal(limitedText.includes(secret), false, secret);
  absent(limited.result, limited.page.secrets);
  validateSavedJdOrders(limited.result, limited.page.target);

  const wide = read({ groups: [orderGroup({ cards: [orderCard({ items: Array.from({ length: JD_ORDER_ITEM_LIMIT + 2 }, (_, index) => orderItem({
    id: String(710000000000 + index + 1), title: `合成超量商品${index + 1}`, quantity: 1,
  })) })] })] });
  assert.deepEqual([wide.result.orders[0].items_seen, wide.result.orders[0].items_returned, wide.result.items_seen, wide.result.items_returned], [12, 10, 12, 10]);
  assert.equal(wide.result.orders[0].items[9].product_id, '710000000010');
  assert.equal(wide.result.orders[0].items[9].title, '合成超量商品10');
  const wideText = JSON.stringify(wide.result);
  assert.equal(wideText.includes('710000000011'), false);
  assert.equal(wideText.includes('合成超量商品12'), false);
  absent(wide.result, wide.page.secrets);

  const shop = `合成店${'名'.repeat(87)}`;
  const title = `合成题${'题'.repeat(347)}`;
  const status = `合成态${'态'.repeat(47)}`;
  const time = `合成时${'间'.repeat(47)}`;
  const notice = `合成示${'示'.repeat(247)}`;
  const info = `合成段${'息'.repeat(87)}`;
  const note = `合成注${'释'.repeat(67)}`;
  const range = `合成围${'围'.repeat(47)}`;
  const filter = `合成筛${'选'.repeat(27)}`;
  const amount = `¥${'9'.repeat(50)}`;
  assert.deepEqual([shop.length, title.length, status.length, time.length, notice.length, info.length, note.length, range.length, filter.length, amount.length],
    [90, 350, 50, 50, 250, 90, 70, 50, 30, 51]);
  const cut = read({
    timeRange: range, statuses: [{ label: filter, selected: true }],
    groups: [orderGroup({
      banner: splitBanner({
        notice, segments: [
          { text: info }, { text: '合成收货人横幅', sensitive: true }, { text: '合成信息丙' }, { text: '合成信息丁' }, { text: '合成信息戊' },
          { text: '合成信息己不采用' },
        ],
      }),
      cards: [orderCard({
        shop, time, status, amount: ['¥', '9'.repeat(50)],
        notes: [note, '合成说明二', '合成说明三', '合成说明四不采用'],
        items: [orderItem({ id: '300001', title, quantity: 1 })],
      })],
    })],
  });
  assert.equal(cut.result.time_range_text, range.slice(0, 40));
  assert.equal(cut.result.status_filter_text, filter.slice(0, 20));
  assert.equal(cut.result.orders[0].shop_name, shop.slice(0, 80));
  assert.equal(cut.result.orders[0].order_time_text, time.slice(0, 40));
  assert.equal(cut.result.orders[0].status_text, status.slice(0, 40));
  assert.equal(cut.result.orders[0].amount_text, amount.slice(0, 40));
  assert.deepEqual(cut.result.orders[0].amount_note_texts, [note.slice(0, 60), '合成说明二', '合成说明三']);
  assert.equal(cut.result.orders[0].items[0].title, title.slice(0, 300));
  assert.deepEqual(cut.result.split_notices[0].info_texts, [info.slice(0, 80), null, '合成信息丙', '合成信息丁', '合成信息戊']);
  assert.equal(cut.result.split_notices[0].notice_text, notice.slice(0, 200));
  const cutText = JSON.stringify(cut.result);
  for (const full of [shop, title, status, time, notice, info, note, range, filter, amount, '合成说明四不采用', '合成信息己不采用', '合成收货人横幅']) {
    assert.equal(cutText.includes(full), false, full);
  }
  absent(cut.result, cut.page.secrets);
  validateSavedJdOrders(cut.result, cut.page.target);
});

test('a non-numeric order id, a bad quantity or link, and a sensitive banner segment stay null', () => {
  const ids = read({ groups: [
    orderGroup({ cards: [orderCard({ orderId: '合成单号ABC', items: [orderItem({ id: '10086101', title: '合成单号商品甲' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '99999', items: [orderItem({ id: '10086102', title: '合成单号商品乙' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '1'.repeat(31), items: [orderItem({ id: '10086103', title: '合成单号商品丙' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '1'.repeat(30), items: [orderItem({ id: '10086104', title: '合成单号商品丁' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '111111', items: [orderItem({ id: '10086105', title: '合成单号商品戊' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '012345678901', items: [orderItem({ id: '10086106', title: '合成单号商品己' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '210000000099', orderIdText: null, orderIdTitle: '210000000099',
      items: [orderItem({ id: '10086107', title: '合成单号商品庚' })] })] }),
  ] });
  assert.deepEqual(ids.result.orders.map(order => order.order_id), [null, null, null, '1'.repeat(30), '111111', '012345678901', '210000000099']);
  const idsText = JSON.stringify(ids.result);
  assert.equal(idsText.includes('合成单号ABC'), false);
  assert.equal(idsText.includes('99999'), false);
  assert.equal(idsText.includes('1'.repeat(31)), false);
  absent(ids.result, ids.page.secrets);

  const fields = read({ groups: [
    orderGroup({ cards: [orderCard({ orderId: '320000000001', items: [orderItem({ id: '10086031', title: '合成数量前导零', quantity: '02' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '320000000002', items: [orderItem({ id: '10086032', title: '合成数量不是数字', quantity: '很多' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '320000000003', items: [orderItem({ id: '10086033', title: '合成数量超长', quantity: '1000000' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '320000000004', items: [orderItem({ id: '10086034', title: '合成链接斜杠', href: '//item.jd.com/10086034.html/' })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '320000000005', amount: null, items: [orderItem({ id: '10086035', title: '合成无价格行', quantity: 1 })] })] }),
    orderGroup({ cards: [orderCard({ orderId: '320000000006', items: [orderItem({
      title: '合成\u0001双  空格', titleText: '合成短名不采用', id: '10086036', quantity: 1,
    })] })] }),
  ] });
  assert.deepEqual(fields.result.orders.map(order => order.items[0].quantity), [2, null, null, 1, 1, 1]);
  assert.deepEqual(fields.result.orders.map(order => order.items[0].product_id), ['10086031', '10086032', '10086033', null, '10086035', '10086036']);
  assert.equal(fields.result.orders[3].items[0].url, null);
  assert.equal(fields.result.orders[4].amount_text, null);
  assert.equal(fields.result.orders[5].items[0].title, '合成 双 空格');
  const fieldsText = JSON.stringify(fields.result);
  for (const secret of ['很多', '1000000', '10086034', '合成短名不采用', '\u0001']) assert.equal(fieldsText.includes(secret), false, secret);
  absent(fields.result, fields.page.secrets);

  const banner = read({ groups: [orderGroup({
    banner: splitBanner({
      notice: '合成拆单提示自身类名', noticeText: undefined, segments: [
        { text: '收货人字样但类名干净' },
        { text: '合成自身敏感段', sensitive: 'self' },
      ],
    }),
    cards: [orderCard({ orderId: '320000000007', split: true, items: [orderItem({ id: '10086037', title: '合成敏感段商品' })] })],
  })] });
  assert.deepEqual(banner.result.split_notices[0].info_texts, ['收货人字样但类名干净', null]);
  assert.equal(banner.result.orders[0].split_order, true);
  assert.equal(JSON.stringify(banner.result).includes('合成自身敏感段'), false);
  absent(banner.result, banner.page.secrets);
  validateSavedJdOrders(banner.result, banner.page.target);

  assert.equal(read({ statuses: [{ label: '全部' }, { label: '待付款', secret: true }] }).result.status_filter_text, null);
  const both = read({ statuses: [{ label: '全部', selected: true }, { label: '待付款', selected: true, secret: true }] });
  assert.equal(both.result.status_filter_text, null);
  assert.equal(JSON.stringify(both.result).includes('全部'), false);
  assert.equal(JSON.stringify(both.result).includes('待付款'), false);
  const noRange = read({ timeRange: null });
  assert.equal(noRange.result.time_range_text, null);
  absent(noRange.result, noRange.page.secrets);
});

test('login, limit, verification, a wrong address and a list without cards stop the read', () => {
  const target = jdOrdersPage().target;
  const attempt = options => () => {
    const page = jdOrdersPage(options);
    return validateJdOrders(page.evaluate(jdOrdersScript(target)), target);
  };
  assert.throws(attempt({ href: 'https://passport.jd.com/new/login.aspx' }), { code: 'LOGIN_REQUIRED' });
  assert.throws(attempt({ href: 'https://pc-frequent-pro.pf.jd.com/' }), { code: 'RATE_LIMITED' });
  assert.throws(attempt({ extra: [element('div', { text: '访问频繁' })] }), { code: 'RATE_LIMITED' });
  assert.throws(attempt({ extra: [element('div', { cls: 'JDJRV-wrap' })] }), { code: 'VERIFICATION_REQUIRED' });
  assert.throws(attempt({ href: 'https://item.jd.com/10086001.html' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://example.invalid/orders' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://order.jd.com/center/detail.action?orderid=synthetic' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://order.jd.com/center/list.action/' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ list: false }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(attempt({ lists: 2 }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(attempt({ groups: [] }), { code: 'PAGE_STRUCTURE_CHANGED' });
  const bannerOnly = jdOrdersPage({ groups: [orderGroup({ banner: splitBanner(), cards: [] })] });
  const bannerRaw = bannerOnly.evaluate(jdOrdersScript(target));
  assert.deepEqual(bannerRaw, { state: 'structure_changed' });
  absent(bannerRaw, bannerOnly.secrets);
  assert.throws(() => validateJdOrders(bannerRaw, target), { code: 'PAGE_STRUCTURE_CHANGED' });
  for (const href of [`${LIST}?d=2&s=4096&page=2`, `${LIST}#section`]) {
    const page = jdOrdersPage({ href });
    const result = validateJdOrders(page.evaluate(jdOrdersScript(page.target)), page.target, { observedAt: AT });
    assert.equal(result.url, LIST);
    assert.equal(result.orders_seen, 4);
  }
  assert.throws(() => jdOrdersScript({ platform: 'jd', url: `${LIST}?d=1` }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => jdOrdersScript({ url: LIST, platform: 'jd' }), { code: 'INVALID_ARGUMENTS' });
});

test('a raw extra field is rejected, and a saved copy that no longer matches its own fields is rejected', () => {
  const page = jdOrdersPage();
  const script = jdOrdersScript(page.target);
  const fresh = () => page.evaluate(script);
  for (const edit of [
    value => { value.extra = true; },
    value => { value.orders[0].extra = true; },
    value => { value.orders[0].items[0].extra = true; },
    value => { value.split_notices[0].extra = true; },
    value => { value.orders[0].order_id = '1'.repeat(31); },
    value => { value.orders[0].order_id = 123456789012; },
    value => { value.orders[0].amount_text = '¥ 1'; },
    value => { value.orders[0].detail_entry = 'true'; },
    value => { value.orders[0].split_order = 1; },
    value => { value.orders[0].items[0].quantity = '1'; },
    value => { value.orders[0].items[0].product_id = '1'.repeat(21); },
    value => { value.orders[0].items_seen = -1; },
    value => { value.orders_seen = 8; },
    value => { value.items_seen = 0; },
    value => { value.time_range_text = ''; },
    value => { value.status_filter_text = '名'.repeat(21); },
    value => { value.orders[0].shop_name = '名'.repeat(81); },
    value => { value.split_notices[0].info_texts = [null, null, null, null, null, '合成多出来的一段']; },
    value => { value.orders[0].amount_note_texts.push('合成', '说明', '超限'); },
    value => { value.orders[0].position = 2; },
    value => { value.orders[0].group_position = 0; },
    value => { delete value.time_range_text; },
    value => { value.orders[2].group_position = 1; },
  ]) {
    const raw = fresh();
    edit(raw);
    assert.throws(() => validateJdOrders(raw, page.target), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => validateJdOrders(fresh(), { url: LIST, platform: 'jd' }), { code: 'INVALID_ARGUMENTS' });
  const result = validateJdOrders(fresh(), page.target, { observedAt: AT });
  validateSavedJdOrders(result, page.target);
  for (const edit of [
    value => { value.orders[0].items[0].url = 'https://item.jd.com/1.html'; },
    value => { value.orders[0].items[0].product_id = '100099'; },
    value => { value.orders_omitted = 1; },
    value => { value.items_returned = 0; },
    value => { value.orders[0].items_returned = 9; },
    value => { value.coverage.scrolled = true; },
    value => { value.extra = true; },
    value => { value.orders_seen = 8; },
    value => { value.platform = 'taobao'; },
    value => { value.login_verified = true; },
    value => { value.missing = []; },
    value => { value.excluded = []; },
    value => { value.source = 'other'; },
    value => { value.schema_version = 2; },
    value => { delete value.schema_version; },
    value => { value.observed_at = 'not-a-time'; },
    value => {
      const order = value.orders[0];
      const reversed = {};
      for (const key of Object.keys(order).reverse()) reversed[key] = order[key];
      value.orders[0] = reversed;
    },
    value => {
      const reversed = {};
      for (const key of Object.keys(value).reverse()) reversed[key] = value[key];
      return reversed;
    },
  ]) {
    const copy = structuredClone(result);
    const edited = edit(copy) ?? copy;
    assert.throws(() => validateSavedJdOrders(edited, page.target), { code: 'INVALID_CHECKPOINT' });
  }
  assert.throws(() => validateSavedJdOrders(result, { platform: 'jd', url: 'https://order.jd.com/center/list.action?d=1' }), { code: 'INVALID_CHECKPOINT' });
  assert.throws(() => validateSavedJdOrders(null, page.target), { code: 'INVALID_CHECKPOINT' });
});

test('readJdOrders is a paced read and is marked not dispatched only before the page script is sent', async t => {
  assert.deepEqual(PACED_METHODS.readJdOrders, ['read']);
  const page = jdOrdersPage();
  const { endpoint, state } = await mockBridge(t, { handler: ({ req, res, body }) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url: `${LIST}?d=2&page=2` }] } }));
    if (body?.action === 'eval') return res.end(JSON.stringify({ id: body.id, success: true, data: { result: page.evaluate(body.script) } }));
    res.end(JSON.stringify({ id: body?.id, success: false, error: 'unsupported' }));
  } });
  const result = await new BrowserBridge(endpoint).readJdOrders(88, page.target);
  assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval']);
  assert.equal(state.commands[1].script.includes('collectJdOrders'), true);
  assert.equal(Number.isNaN(Date.parse(result.observed_at)), false);
  assert.deepEqual(result, validateJdOrders(page.evaluate(jdOrdersScript(page.target)), page.target, { observedAt: result.observed_at }));
  absent(result, page.secrets);

  const disconnected = await mockBridge(t);
  disconnected.state.connected = false;
  await assert.rejects(new BrowserBridge(disconnected.endpoint).readJdOrders(88, page.target), { code: 'EXTENSION_DISCONNECTED', actionNotDispatched: true });
  assert.equal(disconnected.state.commands.length, 0);

  const missing = await mockBridge(t);
  await assert.rejects(new BrowserBridge(missing.endpoint).readJdOrders(88, page.target), { code: 'TARGET_MISSING', actionNotDispatched: true });
  assert.deepEqual(missing.state.commands.map(command => command.action), ['tab_list', 'eval']);
  assert.equal(missing.state.commands[1].script.includes('tab_address'), true);
  assert.equal(missing.state.commands[1].script.includes('collectJdOrders'), false);

  for (const [url, code] of [
    ['https://passport.jd.com/new/login.aspx', 'LOGIN_REQUIRED'],
    ['https://pc-frequent-pro.pf.jd.com/', 'RATE_LIMITED'],
    ['https://item.jd.com/1.html', 'TARGET_CHANGED'],
  ]) {
    const wrong = await mockBridge(t, { handler: ({ req, res, body }) => {
      if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
      if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url }] } }));
      res.end(JSON.stringify({ id: body?.id, success: false, error: 'PRIVATE_ERROR' }));
    } });
    await assert.rejects(new BrowserBridge(wrong.endpoint).readJdOrders(88, page.target), { code, actionNotDispatched: true });
    assert.deepEqual(wrong.state.commands.map(command => command.action), ['tab_list']);
  }

  const idle = await mockBridge(t);
  await assert.rejects(new BrowserBridge(idle.endpoint).readJdOrders(88, { platform: 'jd', url: `${LIST}?d=1` }),
    { code: 'INVALID_ARGUMENTS', actionNotDispatched: true });
  assert.equal(idle.state.requests.length, 0);

  const dropped = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url: page.target.url }] } }));
    res.end(JSON.stringify({ id: body.id, success: false, error: 'PRIVATE_ERROR' }));
  } });
  await assert.rejects(new BrowserBridge(dropped.endpoint).readJdOrders(88, page.target), error => {
    assert.equal(error.code, 'BROWSER_COMMAND_FAILED');
    assert.equal(error.actionNotDispatched, undefined);
    assert.equal(String(error.message).includes('PRIVATE_ERROR'), false);
    return true;
  });
  assert.equal(dropped.state.commands.some(command => command.action === 'eval' && command.script.includes('collectJdOrders')), true);

  const empty = jdOrdersPage({ list: false });
  const changed = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url: empty.target.url }] } }));
    if (body?.action === 'eval') return res.end(JSON.stringify({ id: body.id, success: true, data: { result: empty.evaluate(body.script) } }));
    res.end(JSON.stringify({ id: body?.id, success: false, error: 'unsupported' }));
  } });
  await assert.rejects(new BrowserBridge(changed.endpoint).readJdOrders(88, empty.target), error => {
    assert.equal(error.code, 'PAGE_STRUCTURE_CHANGED');
    assert.equal(error.actionNotDispatched, undefined);
    return true;
  });
  assert.equal(changed.state.commands.some(command => command.script?.includes('collectJdOrders')), true);
});
