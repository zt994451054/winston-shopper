import test from 'node:test';
import assert from 'node:assert/strict';
import { JD_ORDER_DETAIL_ITEM_LIMIT, JD_ORDER_DETAIL_PROGRESS_LIMIT, jdOrderDetailScript, validateJdOrderDetail } from '../lib/jd/order-detail.mjs';
import { SYNTHETIC_PHONE, detailAmount, detailItem, detailNode, element, jdOrderDetailPage } from '../test-support/jd-order-detail-fixture.mjs';

const AT = '2026-10-19T00:00:00.000Z';
const ORDER_ID = '880000000001';
const DETAIL = `https://details.jd.com/normal/item.action?orderid=${ORDER_ID}&PassKey=SYNTHETICKEY`;

function read(options, observedAt = AT) {
  const page = jdOrderDetailPage(options);
  const raw = page.evaluate(jdOrderDetailScript(page.orderId));
  return { page, raw, result: validateJdOrderDetail(raw, page.orderId, { observedAt }) };
}

function absent(value, secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
}

const PRIVATE = ['合成收货人', '合成路1号', '138****0000', '合成配送员', `${SYNTHETIC_PHONE}`, '合成代付人', '合成签收人',
  '合成昵称甲', '在线支付', '支付方式', 'PassKey', 'SYNTHETICKEY', 'img.synthetic.invalid', '合成付款浮层',
  '770000000077', '合成旁路说明'];

test('the order detail fields are read, private text stays out, and the script does not act', () => {
  const page = jdOrderDetailPage();
  const script = jdOrderDetailScript(page.orderId);
  assert.equal(page.readyState, 'loading');
  assert.equal(page.orderId, ORDER_ID);
  assert.equal(JD_ORDER_DETAIL_ITEM_LIMIT, 20);
  assert.equal(JD_ORDER_DETAIL_PROGRESS_LIMIT, 10);
  assert.doesNotMatch(script, /\.click\(|scrollIntoView|scrollTo|scrollBy|fetch\(|XMLHttpRequest|cookie|Storage|location\.assign/);
  assert.equal(script.includes('JD_ORDER_DETAIL_ITEM_LIMIT'), false);
  assert.equal(script.includes('JD_ORDER_DETAIL_PROGRESS_LIMIT'), false);
  assert.equal(script.includes('PassKey'), false);
  assert.match(script, /\{"progress":10,"items":20\}/);
  const raw = page.evaluate(script);
  const result = validateJdOrderDetail(raw, ORDER_ID, { observedAt: AT });
  assert.equal(raw.items[0].url, undefined);
  assert.equal(JSON.stringify(raw).includes('item.jd.com'), false);
  assert.equal(JSON.stringify(raw).includes('PassKey'), false);
  const row = (position, id, title, cells, quantity) => ({
    position, product_id: id, url: `https://item.jd.com/${id}.html`, title, cells, quantity,
  });
  assert.equal(JSON.stringify(result), JSON.stringify({
    observed_at: AT, order_id: ORDER_ID, order_id_on_page: ORDER_ID, layout: 'classic', status_text: '完成',
    progress: [
      { position: 1, name: '合成提交订单', time_text: '2026-09-20 16:24:17', reached: true },
      { position: 2, name: '合成付款成功', time_text: '2026-09-20 16:24:40', reached: true },
      { position: 3, name: '合成商品出库', time_text: '2026-09-21 09:00:00', reached: true },
      { position: 4, name: '合成等待收货', time_text: null, reached: false },
    ],
    progress_seen: 4, shipping_text: '送货方式： 承运人：合成运输',
    item_columns: ['商品编号', '商品名称', '京东价', '京豆数量', '优惠', '商品数量', '操作'],
    items: [
      row(1, '10086011', '合成蓝牙耳机 降噪款', ['10086011', '合成蓝牙耳机 降噪款', '¥128.00', '0', '¥0.00', '1', '合成操作'], 1),
      row(2, '10086012', '合成耳机收纳盒', ['10086012', '合成耳机收纳盒', '¥29.00', '3', '¥5.00', '2', '合成操作'], 2),
    ],
    items_seen: 2, items_returned: 2,
    amounts: [
      { label: '商品总价', value_text: '¥157.00' },
      { label: '运费', value_text: '¥0.00' },
      { label: '实付款', value_text: '¥152.00' },
    ],
  }));
  const text = JSON.stringify(result);
  for (const secret of PRIVATE) assert.equal(text.includes(secret), false, secret);
  absent(raw, page.secrets);
  absent(result, page.secrets);
});

test('progress past 10, items past 20, columns, cells, amounts and long fields are cut', () => {
  const nodes = Array.from({ length: JD_ORDER_DETAIL_PROGRESS_LIMIT + 1 }, (_, index) => detailNode({
    name: `合成节点${String(index + 1).padStart(2, '0')}`, time: '2026-09-03 12:00:00', ready: index !== JD_ORDER_DETAIL_PROGRESS_LIMIT,
  }));
  const limited = read({ progress: nodes });
  assert.deepEqual([limited.result.progress_seen, limited.result.progress.length], [11, 10]);
  assert.equal(limited.result.progress[9].name, '合成节点10');
  assert.equal(limited.result.progress[9].reached, true);
  assert.equal(JSON.stringify(limited.result).includes('合成节点11'), false);
  absent(limited.result, limited.page.secrets);

  const bulk = read({ items: Array.from({ length: JD_ORDER_DETAIL_ITEM_LIMIT + 1 }, (_, index) => detailItem({
    id: String(710000000001 + index), title: `合成超量商品${index + 1}`, quantity: '1',
  })) });
  assert.deepEqual([bulk.result.items_seen, bulk.result.items_returned, bulk.result.items.length], [21, 20, 20]);
  assert.equal(bulk.result.items[19].product_id, '710000000020');
  assert.equal(bulk.result.items[19].title, '合成超量商品20');
  const bulkText = JSON.stringify(bulk.result);
  assert.equal(bulkText.includes('710000000021'), false);
  assert.equal(bulkText.includes('合成超量商品21'), false);
  absent(bulk.result, bulk.page.secrets);

  const wide = read({
    columns: [...Array.from({ length: 10 }, (_, index) => `合成列${String(index + 1).padStart(2, '0')}`), '合成列11'],
    items: [detailItem({ id: '10086051', title: '合成列商品', extraCells: ['合成格外08', '合成格外09', '合成格外10', '合成格外11'] })],
  });
  assert.equal(wide.result.item_columns.length, 10);
  assert.equal(wide.result.item_columns[9], '合成列10');
  assert.equal(wide.result.items[0].cells.length, 10);
  assert.equal(wide.result.items[0].cells[9], '合成格外10');
  const wideText = JSON.stringify(wide.result);
  assert.equal(wideText.includes('合成列11'), false);
  assert.equal(wideText.includes('合成格外11'), false);
  absent(wide.result, wide.page.secrets);

  const fees = Array.from({ length: 11 }, (_, index) => detailAmount({ label: `合成费${String(index + 1).padStart(2, '0')}`, value: '¥1.00' }));
  const capped = read({ amounts: fees });
  assert.equal(capped.result.amounts.length, 10);
  assert.equal(capped.result.amounts[9].label, '合成费10');
  const cappedText = JSON.stringify(capped.result);
  assert.equal(cappedText.includes('合成费11'), false);
  assert.equal(cappedText.includes('实付款'), false);
  absent(capped.result, capped.page.secrets);

  const status = `合成态${'态'.repeat(47)}`;
  const name = `合成节${'点'.repeat(47)}`;
  const time = `合成时${'间'.repeat(47)}`;
  const shipping = `合成运${'输'.repeat(117)}`;
  const title = `合成题${'题'.repeat(347)}`;
  const cell = `合成格${'值'.repeat(117)}`;
  const label = `合成费${'用'.repeat(47)}`;
  const amount = `¥${'9'.repeat(50)}`;
  const header = `合成列${'名'.repeat(27)}`;
  assert.deepEqual([status.length, name.length, time.length, shipping.length, title.length, cell.length, label.length, amount.length, header.length],
    [50, 50, 50, 120, 350, 120, 50, 51, 30]);
  const cut = read({
    status, shippingText: shipping, columns: [header],
    progress: [detailNode({ name, time, ready: true })],
    items: [detailItem({ id: '10086061', title, price: cell, quantity: '1' })],
    amounts: [detailAmount({ label, value: amount })],
    payable: { label: '实付款', value: '¥1.00' },
  });
  assert.equal(cut.result.status_text, status.slice(0, 40));
  assert.equal(cut.result.progress[0].name, name.slice(0, 40));
  assert.equal(cut.result.progress[0].time_text, time.slice(0, 40));
  assert.equal(cut.result.shipping_text, shipping.slice(0, 100));
  assert.equal(cut.result.item_columns[0], header.slice(0, 20));
  assert.equal(cut.result.items[0].title, title.slice(0, 300));
  assert.equal(cut.result.items[0].cells[1], title.slice(0, 100));
  assert.equal(cut.result.items[0].cells[2], cell.slice(0, 100));
  assert.equal(cut.result.amounts[0].label, label.slice(0, 40));
  assert.equal(cut.result.amounts[0].value_text, amount.slice(0, 40));
  assert.equal(cut.result.amounts[1].label, '实付款');
  const cutText = JSON.stringify(cut.result);
  for (const full of [status, name, time, shipping, title, cell, label, amount, header]) assert.equal(cutText.includes(full), false, full);
  absent(cut.result, cut.page.secrets);
});

test('a printed order id, quantity, or product link that does not parse becomes null', () => {
  const half = read({ orderIdText: `订单号: ${ORDER_ID}` });
  assert.equal(half.result.order_id_on_page, ORDER_ID);
  const spaced = read({ orderIdText: `订单号：  ${ORDER_ID}` });
  assert.equal(spaced.result.order_id_on_page, ORDER_ID);
  const shortId = read({ orderId: '123456' });
  assert.equal(shortId.result.order_id, '123456');
  assert.equal(shortId.result.order_id_on_page, '123456');
  const longId = '1'.repeat(30);
  const long = read({ orderId: longId });
  assert.equal(long.result.order_id_on_page, longId);
  absent(long.result, long.page.secrets);

  const tooShort = read({ orderIdText: '订单号：12345' });
  assert.equal(tooShort.result.order_id, ORDER_ID);
  assert.equal(tooShort.result.order_id_on_page, null);
  assert.equal(JSON.stringify(tooShort.result).includes('12345'), false);
  const tooLong = '1'.repeat(31);
  const over = read({ orderIdText: `订单号：${tooLong}` });
  assert.equal(over.result.order_id_on_page, null);
  assert.equal(JSON.stringify(over.result).includes(tooLong), false);
  const junk = read({ orderIdText: `订单号：${ORDER_ID}合成尾注` });
  assert.equal(junk.result.order_id_on_page, null);
  assert.equal(JSON.stringify(junk.result).includes('合成尾注'), false);
  const unlabeled = read({ orderStrong: false });
  assert.equal(unlabeled.result.order_id_on_page, null);
  assert.equal(unlabeled.result.order_id, ORDER_ID);
  absent(unlabeled.result, unlabeled.page.secrets);

  const fields = read({ items: [
    detailItem({ id: '10086031', title: '合成数量前导零', quantity: '02' }),
    detailItem({ id: '10086032', title: '合成数量不是数字', quantity: '很多' }),
    detailItem({ id: '10086033', title: '合成数量超长', quantity: '1000000' }),
    detailItem({ id: '10086034', title: '合成链接斜杠', href: '//item.jd.com/10086034.html/' }),
    detailItem({ id: '10086035', title: '合成无链接', href: '' }),
    detailItem({ id: '10086036', title: '合成\u0001双  空格', quantity: '1' }),
    detailItem({ id: '10086037', title: '合成属性标题', titleText: '合成可见短名', quantity: '1' }),
    detailItem({ id: '10086038', title: '合成明文链接', href: 'http://item.jd.com/10086038.html', quantity: '1' }),
    detailItem({ id: '10086039', title: '合成锚点链接', href: '//item.jd.com/10086039.html#synthetic-hash', quantity: '0' }),
    detailItem({ id: '10086040', code: '合成编号不是链接', title: '合成编号来自链接', quantity: '1' }),
  ] });
  assert.deepEqual(fields.result.items.map(item => item.quantity), [2, null, null, 1, 1, 1, 1, 1, 0, 1]);
  assert.deepEqual(fields.result.items.map(item => item.product_id), [
    '10086031', '10086032', '10086033', null, null, '10086036', '10086037', '10086038', '10086039', '10086040',
  ]);
  assert.equal(fields.result.items[3].url, null);
  assert.equal(fields.result.items[3].cells[0], '10086034');
  assert.equal(fields.result.items[4].url, null);
  assert.equal(fields.result.items[5].title, '合成 双 空格');
  assert.equal(fields.result.items[6].title, '合成属性标题');
  assert.equal(fields.result.items[6].cells[1], '合成可见短名');
  assert.equal(fields.result.items[7].url, 'https://item.jd.com/10086038.html');
  assert.equal(fields.result.items[8].url, 'https://item.jd.com/10086039.html');
  assert.equal(fields.result.items[9].cells[0], '合成编号不是链接');
  const fieldsText = JSON.stringify(fields.result);
  for (const secret of ['synthetic-hash', 'http://item.jd.com', '10086034.html/', '\u0001']) assert.equal(fieldsText.includes(secret), false, secret);
  absent(fields.result, fields.page.secrets);

  const money = read({
    amounts: [detailAmount({ label: '商品总价', value: '¥ 157 . 00' })],
    payable: { label: '实付款', value: '¥ 152.00' },
  });
  assert.deepEqual(money.result.amounts, [
    { label: '商品总价', value_text: '¥157.00' },
    { label: '实付款', value_text: '¥ 152.00' },
  ]);
  assert.equal(JSON.stringify(money.result).includes('¥ 157 . 00'), false);
  absent(money.result, money.page.secrets);
  assert.equal(read({ shipping: null }).result.shipping_text, null);
  assert.equal(read({ status: '' }).result.status_text, null);
  assert.deepEqual(read({ progress: false }).result.progress, []);
  assert.equal(read({ progress: false }).result.progress_seen, 0);
});

test('login, limit, verification, a wrong address, a mismatched order id, and a broken structure stop the read', () => {
  const attempt = options => () => {
    const page = jdOrderDetailPage(options);
    return validateJdOrderDetail(page.evaluate(jdOrderDetailScript(ORDER_ID)), ORDER_ID);
  };
  assert.throws(attempt({ href: 'https://passport.jd.com/new/login.aspx' }), { code: 'LOGIN_REQUIRED' });
  assert.throws(attempt({ href: 'https://pc-frequent-pro.pf.jd.com/' }), { code: 'RATE_LIMITED' });
  assert.throws(attempt({ extra: [element('div', { text: '访问频繁' })] }), { code: 'RATE_LIMITED' });
  assert.throws(attempt({ extra: [element('div', { cls: 'JDJRV-wrap' })] }), { code: 'VERIFICATION_REQUIRED' });
  assert.throws(attempt({ href: 'https://item.jd.com/10086011.html' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://example.invalid/order' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://order.jd.com/center/list.action' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://details.jd.com/normal/item.action/' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: `https://details.jd.com/normal/item.action?orderid=880000000099&PassKey=SYNTHETICKEY` }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://details.jd.com/normal/item.action?PassKey=SYNTHETICKEY' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: `${DETAIL}&orderid=${ORDER_ID}` }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ orderState: false }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(attempt({ productTable: false }), { code: 'PAGE_STRUCTURE_CHANGED' });

  const loggedOut = jdOrderDetailPage({ href: 'https://passport.jd.com/new/login.aspx' });
  const loggedRaw = loggedOut.evaluate(jdOrderDetailScript(ORDER_ID));
  assert.deepEqual(loggedRaw, { state: 'login_required' });
  absent(loggedRaw, loggedOut.secrets);
  const wrong = jdOrderDetailPage({ href: `https://details.jd.com/normal/item.action?orderid=880000000099&PassKey=SYNTHETICKEY` });
  const wrongRaw = wrong.evaluate(jdOrderDetailScript(ORDER_ID));
  assert.deepEqual(wrongRaw, { state: 'target_changed' });
  absent(wrongRaw, wrong.secrets);
  const broken = jdOrderDetailPage({ productTable: false });
  const brokenRaw = broken.evaluate(jdOrderDetailScript(ORDER_ID));
  assert.deepEqual(brokenRaw, { state: 'structure_changed' });
  absent(brokenRaw, broken.secrets);

  const printed = jdOrderDetailPage({ orderIdText: '订单号：880000000099' });
  const printedRaw = printed.evaluate(jdOrderDetailScript(ORDER_ID));
  assert.equal(printedRaw.state, 'observed');
  assert.equal(printedRaw.order_id, '880000000099');
  assert.throws(() => validateJdOrderDetail(printedRaw, ORDER_ID), { code: 'TARGET_CHANGED' });
  absent(printedRaw, printed.secrets);

  const hashed = jdOrderDetailPage({ href: `https://details.jd.com/normal/item.action?PassKey=SYNTHETICKEY&orderid=${ORDER_ID}#item` });
  const hashedResult = validateJdOrderDetail(hashed.evaluate(jdOrderDetailScript(ORDER_ID)), ORDER_ID, { observedAt: AT });
  assert.equal(hashedResult.order_id, ORDER_ID);
  assert.equal(hashedResult.items_seen, 2);
  assert.equal(JSON.stringify(hashedResult).includes('PassKey'), false);
  assert.equal(JSON.stringify(hashedResult).includes('SYNTHETICKEY'), false);

  assert.throws(() => jdOrderDetailScript('12345'), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => jdOrderDetailScript('1'.repeat(31)), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => jdOrderDetailScript(880000000001), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => jdOrderDetailScript(`${ORDER_ID} `), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => validateJdOrderDetail({ state: 'observed' }, '12345'), { code: 'INVALID_ARGUMENTS' });
});

test('a raw extra field, a bad type, or an out-of-range value is rejected', () => {
  const page = jdOrderDetailPage();
  const script = jdOrderDetailScript(page.orderId);
  const fresh = () => page.evaluate(script);
  for (const edit of [
    value => { value.extra = true; },
    value => { value.progress[0].extra = true; },
    value => { value.items[0].extra = true; },
    value => { value.items[0].url = 'https://item.jd.com/10086011.html'; },
    value => { value.amounts[0].extra = true; },
    value => { value.order_id = '1'.repeat(31); },
    value => { value.order_id = 880000000001; },
    value => { value.status_text = ''; },
    value => { value.status_text = '态'.repeat(41); },
    value => { value.shipping_text = '运'.repeat(101); },
    value => { value.progress[0].reached = 'true'; },
    value => { value.progress[0].reached = 1; },
    value => { value.progress[0].name = '名'.repeat(41); },
    value => { value.progress[0].time_text = ''; },
    value => { value.progress[0].position = 2; },
    value => { value.progress_seen = -1; },
    value => { value.progress_seen = 0; },
    value => { value.progress_seen = 1.5; },
    value => { value.items[0].quantity = '1'; },
    value => { value.items[0].quantity = -1; },
    value => { value.items[0].quantity = 1000000; },
    value => { value.items[0].quantity = 1.5; },
    value => { value.items[0].product_id = '1'.repeat(21); },
    value => { value.items[0].product_id = 10086011; },
    value => { value.items[0].title = ''; },
    value => { value.items[0].title = '题'.repeat(301); },
    value => { value.items[0].cells = [...value.items[0].cells, '八', '九', '十', '十一']; },
    value => { value.items[0].cells[0] = '格'.repeat(101); },
    value => { value.items[0].cells[0] = 1; },
    value => { value.items[0].position = 2; },
    value => { value.items_seen = -1; },
    value => { value.items_seen = 2.5; },
    value => { value.items_seen = 3; },
    value => { value.items_returned = 0; },
    value => { value.items_returned = 21; },
    value => { value.item_columns = [...value.item_columns, '八', '九', '十', '十一']; },
    value => { value.item_columns[0] = '列'.repeat(21); },
    value => { value.item_columns[0] = null; },
    value => { value.amounts.push(...Array.from({ length: 8 }, () => ({ label: '合成费', value_text: '¥1' }))); },
    value => { value.amounts[0].label = ''; },
    value => { value.amounts[0].label = '标'.repeat(41); },
    value => { value.amounts[0].value_text = '值'.repeat(41); },
    value => { delete value.shipping_text; },
    value => { delete value.order_id; },
    value => { value.state = 'nope'; },
  ]) {
    const raw = fresh();
    edit(raw);
    assert.throws(() => validateJdOrderDetail(raw, page.orderId), { code: 'INVALID_RESPONSE' }, edit.toString());
  }
  const mismatched = fresh();
  mismatched.order_id = '880000000099';
  assert.throws(() => validateJdOrderDetail(mismatched, ORDER_ID), { code: 'TARGET_CHANGED' });
  assert.throws(() => validateJdOrderDetail(fresh(), `${ORDER_ID}x`), { code: 'INVALID_ARGUMENTS' });
});

function readPanel(options, observedAt = AT) {
  return read({ layout: 'state_panel', ...options }, observedAt);
}

const PANEL_PRIVATE = ['合成账户pin', '合成强调提示勿读', '合成面包屑', '合成收货人', '合成路1号', '138****0000',
  `合成配送员 ${SYNTHETIC_PHONE}`, '在线支付', '合成付款时间', '立即购买', '查看退款时效', '修改信息', '合成店铺甲',
  '联系客服', '支付方式', 'PassKey', 'SYNTHETICKEY', '合成间隔列甲', '合成间隔格甲', '合成旁路金额'];

test('the state panel layout is read, grap columns are skipped, and private text stays out', () => {
  const page = jdOrderDetailPage({ layout: 'state_panel' });
  const script = jdOrderDetailScript(page.orderId);
  assert.equal(page.readyState, 'loading');
  assert.doesNotMatch(script, /\.click\(|scrollIntoView|scrollTo|scrollBy|fetch\(|XMLHttpRequest|cookie|Storage|location\.assign/);
  for (const secret of PANEL_PRIVATE) assert.equal(page.secrets.includes(secret), true, secret);
  const raw = page.evaluate(script);
  const result = validateJdOrderDetail(raw, ORDER_ID, { observedAt: AT });
  assert.equal(raw.layout, 'state_panel');
  assert.equal(raw.shipping_text, null);
  assert.equal(raw.items[0].url, undefined);
  assert.equal(JSON.stringify(raw).includes('item.jd.com'), false);
  assert.equal(JSON.stringify(raw).includes('PassKey'), false);
  const row = (position, id, title, cells, quantity) => ({
    position, product_id: id, url: `https://item.jd.com/${id}.html`, title, cells, quantity,
  });
  assert.equal(JSON.stringify(result), JSON.stringify({
    observed_at: AT, order_id: ORDER_ID, order_id_on_page: ORDER_ID, layout: 'state_panel', status_text: '合成已取消',
    progress: [
      { position: 1, name: '合成提交申请', time_text: '2026-09-20 16:24:17', reached: true },
      { position: 2, name: '合成取消处理', time_text: '2026-09-20 16:30:00', reached: true },
      { position: 3, name: '合成退款受理', time_text: null, reached: true },
      { position: 4, name: '合成退款完成', time_text: null, reached: false },
    ],
    progress_seen: 4, shipping_text: null,
    item_columns: ['商品', '合成价格', '合成金额', '合成数量', '合成京豆', '合成状态'],
    items: [
      row(1, '10086011', '合成蓝牙耳机 降噪款', ['合成蓝牙耳机 降噪款 合成银色', '¥128.00', '¥128.00', '1', '0', '合成在列'], 1),
      row(2, '10086012', '合成耳机收纳盒', ['合成耳机收纳盒 合成黑色', '¥29.00', '¥58.00', '2', '3', '合成在列'], 2),
    ],
    items_seen: 2, items_returned: 2,
    amounts: [
      { label: '商品总价', value_text: '¥157.00' },
      { label: '合成运费', value_text: '¥6.00' },
      { label: '合成优惠', value_text: '¥5.00' },
      { label: '合成京豆抵', value_text: '¥0.00' },
      { label: '应付款', value_text: '¥152.00' },
    ],
  }));
  assert.equal(JSON.stringify(result).includes('¥ 0.00'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-spm'), false);
  absent(raw, page.secrets);
  absent(result, page.secrets);
});

test('a state panel product title comes from the first titled link, or is null when every product link is blank', () => {
  const titled = readPanel({ items: [detailItem({
    id: '10086021', title: '合成属性标题', titleText: '合成可见短名', spec: '合成银色',
    price: '¥1.00', lineAmount: '¥1.00', quantity: '1', beans: '0', action: '合成在列',
  })] });
  assert.equal(titled.result.layout, 'state_panel');
  assert.equal(titled.result.items[0].title, '合成属性标题');
  assert.equal(titled.result.items[0].cells[0], '合成可见短名 合成银色');
  assert.equal(titled.result.items[0].cells.includes('合成间隔格甲'), false);
  absent(titled.result, titled.page.secrets);

  const bare = readPanel({ items: [detailItem({
    id: '10086041', title: null, titleText: '', spec: '合成无标题',
    price: '¥1.00', lineAmount: '¥1.00', quantity: '1', beans: '0', action: '合成在列',
  })] });
  assert.equal(bare.result.items[0].product_id, '10086041');
  assert.equal(bare.result.items[0].title, null);
  assert.equal(bare.result.items[0].url, 'https://item.jd.com/10086041.html');
  assert.equal(bare.result.items[0].cells[0], '合成无标题');
  absent(bare.result, bare.page.secrets);
});

test('state panel caps, a missing or foreign order id, and a broken page stop or null out', () => {
  const nodes = Array.from({ length: JD_ORDER_DETAIL_PROGRESS_LIMIT + 1 }, (_, index) => detailNode({
    name: `合成节点${String(index + 1).padStart(2, '0')}`, time: '2026-09-03 12:00:00', ready: index !== JD_ORDER_DETAIL_PROGRESS_LIMIT,
  }));
  const limited = readPanel({ progress: nodes });
  assert.deepEqual([limited.result.progress_seen, limited.result.progress.length], [11, 10]);
  assert.equal(limited.result.progress[9].name, '合成节点10');
  assert.equal(JSON.stringify(limited.result).includes('合成节点11'), false);

  const wide = readPanel({
    columns: [...Array.from({ length: 11 }, (_, index) => `合成列${String(index + 1).padStart(2, '0')}`)],
    items: [detailItem({
      id: '10086051', title: '合成列商品', price: '¥1.00', lineAmount: '¥1.00', quantity: '1', beans: '0', action: '合成在列',
      extraCells: ['合成格外07', '合成格外08', '合成格外09', '合成格外10', '合成格外11'],
    })],
  });
  assert.equal(wide.result.item_columns[0], '合成列01');
  assert.equal(wide.result.item_columns.length, 10);
  assert.equal(wide.result.item_columns[9], '合成列10');
  assert.equal(wide.result.items[0].cells.length, 10);
  assert.equal(wide.result.items[0].cells[9], '合成格外10');
  const wideText = JSON.stringify(wide.result);
  assert.equal(wideText.includes('合成列11'), false);
  assert.equal(wideText.includes('合成格外11'), false);
  assert.equal(wideText.includes('合成间隔'), false);

  const bulk = readPanel({ items: Array.from({ length: JD_ORDER_DETAIL_ITEM_LIMIT + 1 }, (_, index) => detailItem({
    id: String(710000000001 + index), title: `合成超量商品${index + 1}`, quantity: '1', price: '¥1.00', lineAmount: '¥1.00', beans: '0',
  })) });
  assert.deepEqual([bulk.result.items_seen, bulk.result.items_returned], [21, 20]);
  assert.equal(JSON.stringify(bulk.result).includes('710000000021'), false);

  const fees = Array.from({ length: 11 }, (_, index) => detailAmount({ label: `合成费${String(index + 1).padStart(2, '0')}`, value: '¥1.00' }));
  const capped = readPanel({ amounts: fees });
  assert.equal(capped.result.amounts.length, 10);
  assert.equal(capped.result.amounts[9].label, '合成费10');
  const cappedText = JSON.stringify(capped.result);
  assert.equal(cappedText.includes('合成费11'), false);
  assert.equal(cappedText.includes('应付款'), false);
  absent(capped.result, capped.page.secrets);

  assert.equal(readPanel({ orderIdText: `订单号: ${ORDER_ID}` }).result.order_id_on_page, ORDER_ID);
  assert.equal(readPanel({ stateTop: false }).result.order_id_on_page, null);
  assert.equal(readPanel({ stateTop: false }).result.order_id, ORDER_ID);
  const junk = readPanel({ orderIdText: `订单号：${ORDER_ID}合成尾注` });
  assert.equal(junk.result.order_id_on_page, null);
  assert.equal(JSON.stringify(junk.result).includes('合成尾注'), false);
  absent(junk.result, junk.page.secrets);

  const printed = jdOrderDetailPage({ layout: 'state_panel', orderIdText: '订单号：880000000099' });
  const printedRaw = printed.evaluate(jdOrderDetailScript(ORDER_ID));
  assert.equal(printedRaw.state, 'observed');
  assert.equal(printedRaw.order_id, '880000000099');
  assert.throws(() => validateJdOrderDetail(printedRaw, ORDER_ID), { code: 'TARGET_CHANGED' });
  absent(printedRaw, printed.secrets);

  const attempt = options => () => {
    const page = jdOrderDetailPage({ layout: 'state_panel', ...options });
    return validateJdOrderDetail(page.evaluate(jdOrderDetailScript(ORDER_ID)), ORDER_ID);
  };
  assert.throws(attempt({ productTable: false }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(attempt({ orderState: false }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(attempt({ orderState: false, productTable: false }), { code: 'PAGE_STRUCTURE_CHANGED' });
  const broken = jdOrderDetailPage({ layout: 'state_panel', orderState: false, productTable: false });
  const brokenRaw = broken.evaluate(jdOrderDetailScript(ORDER_ID));
  assert.deepEqual(brokenRaw, { state: 'structure_changed' });
  absent(brokenRaw, broken.secrets);
});

test('a state panel observation rejects another layout name and a shipping line', () => {
  const page = jdOrderDetailPage({ layout: 'state_panel' });
  const script = jdOrderDetailScript(page.orderId);
  const badLayout = page.evaluate(script);
  badLayout.layout = 'grid';
  assert.throws(() => validateJdOrderDetail(badLayout, ORDER_ID), { code: 'INVALID_RESPONSE' });
  const missing = page.evaluate(script);
  delete missing.layout;
  assert.throws(() => validateJdOrderDetail(missing, ORDER_ID), { code: 'INVALID_RESPONSE' });
  const shipped = page.evaluate(script);
  shipped.shipping_text = '合成送货';
  assert.throws(() => validateJdOrderDetail(shipped, ORDER_ID), { code: 'INVALID_RESPONSE' });
  const classic = jdOrderDetailPage().evaluate(jdOrderDetailScript(ORDER_ID));
  classic.layout = 'state_panel';
  assert.throws(() => validateJdOrderDetail(classic, ORDER_ID), { code: 'INVALID_RESPONSE' });
});

test('a classic 商品图片 column does not blank the title, and empty amount rows are skipped on both layouts', () => {
  const classic = read({
    columns: ['商品编号', '商品图片', '商品名称', '京东价', '京豆数量', '优惠', '商品数量', '操作'],
    items: [detailItem({ imageColumn: true })],
    amounts: [detailAmount(), detailAmount({ label: '', value: '', colon: '' }), detailAmount({ label: '运费', value: '¥0.00' })],
  }).result;
  assert.deepEqual([classic.items[0].product_id, classic.items[0].title, classic.items[0].cells.length], ['10086011', '合成蓝牙耳机 降噪款', 8]);
  assert.deepEqual(classic.amounts.map(amount => amount.label), ['商品总价', '运费', '实付款']);
  const panel = read({ layout: 'state_panel', amounts: [detailAmount(), detailAmount({ label: '', value: '', colon: '' }), detailAmount({ label: '运费', value: '¥0.00' })] }).result;
  assert.deepEqual(panel.amounts.map(amount => amount.label), ['商品总价', '运费', '应付款']);
});
