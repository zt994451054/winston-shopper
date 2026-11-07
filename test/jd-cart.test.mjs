import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge, PACED_METHODS } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { readThrottleObservations } from '../lib/throttle-log.mjs';
import { classifyJdCartAvailability, jdCartScript, validateJdCart, validateSavedJdCart } from '../lib/jd/cart.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { cartRow, cartShop, element, jdCartPage } from '../test-support/jd-cart-fixture.mjs';

const AT = '2026-10-15T00:00:00.000Z';

function read(options, observedAt = AT) {
  const page = jdCartPage(options);
  const raw = page.evaluate(jdCartScript(page.target));
  return { page, raw, result: validateJdCart(raw, page.target, { observedAt }) };
}

function absent(value, secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
}

test('the loaded cart rows are read with purchase signals, and private page text stays out', () => {
  const page = jdCartPage();
  const script = jdCartScript(page.target);
  assert.equal(page.readyState, 'loading');
  assert.doesNotMatch(script, /\.click\(|scrollIntoView|scrollTo|scrollBy|fetch\(|XMLHttpRequest|cookie|Storage|location\.assign/);
  assert.equal(script.includes('JD_CART_ROW_LIMIT'), false);
  assert.equal(script.includes('JD_CART_TAG_LIMIT'), false);
  const result = validateJdCart(page.evaluate(script), page.target, { observedAt: AT });
  assert.equal(JSON.stringify(result), JSON.stringify({
    schema_version: 1, platform: 'jd', url: 'https://cart.jd.com/cart_index', source: 'jd_cart_dom', observed_at: AT, login_verified: false,
    header_count_text: '12',
    shops: [
      { position: 1, name: '合成数码旗舰店', zy_icon: true, rows_seen: 2 },
      { position: 2, name: '合成第三方店', zy_icon: false, rows_seen: 3 },
      { position: 3, name: '合成配件店', zy_icon: false, rows_seen: 2 },
    ],
    rows: [
      { position: 1, shop_position: 1, product_id: '100001', url: 'https://item.jd.com/100001.html', title: '合成耳机标准款全称',
        spec_label: '合成项目', spec_text: '合成规格黑色标准版', price_text: '￥合成价1299.00', price_kind: 'normal', other_amount_text: '￥合成对照价',
        quantity: 2, checkbox_disabled: false, checkbox_checked: true, mask_text: null, title_unavailable: false, similar_entry: false,
        tags: ['合成七天价保', '合成包邮'], remind_text: null, availability: { status: 'no_marker_seen', reasons: [] } },
      { position: 2, shop_position: 1, product_id: '100002', url: 'https://item.jd.com/100002.html', title: '合成耳机无货款',
        spec_label: '合成项目', spec_text: '合成规格黑色标准版', price_text: '商品补货中', price_kind: 'status_text', other_amount_text: '￥合成备用金额',
        quantity: null, checkbox_disabled: true, checkbox_checked: false, mask_text: '无货', title_unavailable: true, similar_entry: true,
        tags: [], remind_text: null, availability: { status: 'cannot_buy', reasons: ['无货', '商品补货中'] } },
      { position: 3, shop_position: 2, product_id: '100003', url: 'https://item.jd.com/100003.html', title: '合成键鼠套装',
        spec_label: '合成项目', spec_text: '合成规格黑色标准版', price_text: '￥合成价88.00', price_kind: 'normal', other_amount_text: null,
        quantity: 1, checkbox_disabled: true, checkbox_checked: false, mask_text: null, title_unavailable: false, similar_entry: false,
        tags: [], remind_text: null, availability: { status: 'unrecognized', reasons: ['checkbox_disabled_without_other_signal'] } },
      { position: 4, shop_position: 2, product_id: null, url: null, title: '合成缺号商品',
        spec_label: '合成项目', spec_text: '合成规格黑色标准版', price_text: '￥合成价88.00', price_kind: 'normal', other_amount_text: null,
        quantity: 1, checkbox_disabled: false, checkbox_checked: false, mask_text: null, title_unavailable: false, similar_entry: false,
        tags: [], remind_text: null, availability: { status: 'unrecognized', reasons: ['missing_product_id'] } },
      { position: 5, shop_position: 2, product_id: '100005', url: 'https://item.jd.com/100005.html', title: '合成无价商品',
        spec_label: '合成项目', spec_text: '合成规格黑色标准版', price_text: null, price_kind: null, other_amount_text: null,
        quantity: 1, checkbox_disabled: false, checkbox_checked: false, mask_text: null, title_unavailable: false, similar_entry: false,
        tags: [], remind_text: null, availability: { status: 'unrecognized', reasons: ['no_price'] } },
      { position: 6, shop_position: 3, product_id: '100006', url: 'https://item.jd.com/100006.html', title: '合成配件正常款',
        spec_label: '合成项目', spec_text: '合成规格黑色标准版', price_text: '￥合成价88.00', price_kind: 'normal', other_amount_text: null,
        quantity: 3, checkbox_disabled: false, checkbox_checked: false, mask_text: null, title_unavailable: false, similar_entry: true,
        tags: [], remind_text: '合成到货提醒', availability: { status: 'no_marker_seen', reasons: [] } },
      { position: 7, shop_position: 3, product_id: null, url: null, title: '合成缺号无货款',
        spec_label: '合成项目', spec_text: '合成规格黑色标准版', price_text: '商品补货中', price_kind: 'status_text', other_amount_text: null,
        quantity: null, checkbox_disabled: true, checkbox_checked: false, mask_text: '无货', title_unavailable: true, similar_entry: false,
        tags: [], remind_text: null, availability: { status: 'cannot_buy', reasons: ['无货', '商品补货中'] } },
    ],
    rows_seen: 7, rows_returned: 7, rows_omitted: 0, shops_seen: 3, rows_outside_shops: 1, quantity_sum: 8,
    availability_summary: { cannot_buy: 2, no_marker_seen: 2, unrecognized: 3 },
    coverage: { status: 'partial', scope: 'loaded_rows_only', scrolled: false, full_cart: false, header_count_meaning_verified: false,
      payable_price_verified: false, checkout_selection_read: false },
    missing: ['rows_not_loaded', 'checkout_totals', 'payable_prices', 'rows_outside_shops'],
    excluded: ['address', 'account', 'internal_ids', 'images', 'recommendations', 'checkout_bar'],
  }));
  // The row outside every shop group is counted, and none of its text is read.
  assert.ok(page.secrets.includes('合成无店铺行'));
  const grouped = jdCartPage({ stray: false });
  const groupedResult = validateJdCart(grouped.evaluate(jdCartScript(grouped.target)), grouped.target, { observedAt: AT });
  assert.equal(groupedResult.rows_outside_shops, 0);
  assert.deepEqual(groupedResult.missing, ['rows_not_loaded', 'checkout_totals', 'payable_prices']);
  absent(result, page.secrets);
  assert.equal(JSON.stringify(result).includes('合成耳机短名'), false);
  assert.equal(JSON.stringify(result).includes('variant_out_of_stock'), false);
  assert.equal(result.header_count_text === String(result.rows_seen), false);
  assert.equal(result.header_count_text === String(result.quantity_sum), false);
  validateSavedJdCart(result, page.target);
});

test('rows past 100 are counted and not parsed, and over-long fields are cut before they are returned', () => {
  const bulk = (id, quantity) => cartRow({ id: String(id), title: `合成批量商品${id}`, quantity, priceText: '￥合成价1.00', favorite: false });
  const limited = read({ header: '55', shops: [
    cartShop({ name: '合成数码旗舰店', zy: true, rows: Array.from({ length: 90 }, (_, index) => bulk(200001 + index, 1)) }),
    cartShop({ name: '合成第三方店', rows: [
      ...Array.from({ length: 10 }, (_, index) => bulk(200091 + index, 1)),
      ...Array.from({ length: 10 }, (_, index) => bulk(200101 + index, 5)),
    ] }),
  ] });
  const text = JSON.stringify(limited.result);
  assert.deepEqual([limited.result.header_count_text, limited.result.rows_seen, limited.result.rows_returned, limited.result.rows_omitted, limited.result.quantity_sum],
    ['55', 110, 100, 10, 100]);
  assert.deepEqual(limited.result.shops.map(shop => [shop.name, shop.zy_icon, shop.rows_seen]), [
    ['合成数码旗舰店', true, 90], ['合成第三方店', false, 20]]);
  assert.equal(limited.result.rows.every(row => row.quantity === 1), true);
  assert.equal(limited.result.rows[99].product_id, '200100');
  assert.equal(limited.result.rows[90].shop_position, 2);
  assert.equal(text.includes('200101'), false);
  assert.equal(text.includes('合成批量商品200110'), false);
  absent(limited.result, limited.page.secrets);
  validateSavedJdCart(limited.result, limited.page.target);

  const name = `合成店${'名'.repeat(87)}`;
  const title = `合成题${'题'.repeat(347)}`;
  const specLabel = `合成标${'签'.repeat(87)}`;
  const specText = `合成规${'格'.repeat(87)}`;
  const remind = `合成醒${'醒'.repeat(247)}`;
  const price = `￥${'价'.repeat(89)}`;
  const longTag = `签${'名'.repeat(24)}`;
  const tags = [longTag, ...Array.from({ length: 10 }, (_, index) => `合成标签${index + 2}`)];
  const cut = read({ shops: [cartShop({ name, rows: [cartRow({ id: '300001', title, specLabel, specText, remind, priceText: price, tags })] })] });
  assert.deepEqual([name.length, title.length, specLabel.length, specText.length, remind.length, price.length, longTag.length, tags.length],
    [90, 350, 90, 90, 250, 90, 25, 11]);
  assert.equal(cut.result.shops[0].name, name.slice(0, 80));
  assert.equal(cut.result.rows[0].title, title.slice(0, 300));
  assert.equal(cut.result.rows[0].spec_label, specLabel.slice(0, 80));
  assert.equal(cut.result.rows[0].spec_text, specText.slice(0, 80));
  assert.equal(cut.result.rows[0].remind_text, remind.slice(0, 200));
  assert.equal(cut.result.rows[0].price_text, price.slice(0, 80));
  assert.deepEqual(cut.result.rows[0].tags, [longTag.slice(0, 20), ...tags.slice(1, 10)]);
  const cutText = JSON.stringify(cut.result);
  for (const full of [name, title, specLabel, specText, remind, price, longTag, '合成标签11']) assert.equal(cutText.includes(full), false, full);
});

test('purchase rules use only the explicit signals, including a missing number that is still cannot_buy', () => {
  const row = (overrides = {}) => ({
    checkbox_disabled: false, mask_text: null, title_unavailable: false, price_kind: 'normal', price_text: '￥合成价',
    quantity: 1, product_id: '100001', similar_entry: false, tags: [], remind_text: null, checkbox_checked: true,
    other_amount_text: '￥合成对照价', ...overrides,
  });
  assert.deepEqual(classifyJdCartAvailability(row()), { status: 'no_marker_seen', reasons: [] });
  assert.deepEqual(classifyJdCartAvailability(row({ quantity: 0 })), { status: 'no_marker_seen', reasons: [] });
  assert.deepEqual(classifyJdCartAvailability(row({
    checkbox_disabled: true, mask_text: '无货', title_unavailable: true, price_kind: 'status_text', price_text: '商品补货中', quantity: null, product_id: null,
  })), { status: 'cannot_buy', reasons: ['无货', '商品补货中'] });
  assert.deepEqual(classifyJdCartAvailability(row({ checkbox_disabled: true, title_unavailable: true, quantity: null })),
    { status: 'cannot_buy', reasons: [] });
  assert.deepEqual(classifyJdCartAvailability(row({ checkbox_disabled: true, mask_text: '无货' })),
    { status: 'cannot_buy', reasons: ['无货'] });
  assert.deepEqual(classifyJdCartAvailability(row({ checkbox_disabled: true, price_kind: 'status_text', price_text: '商品补货中' })),
    { status: 'cannot_buy', reasons: ['商品补货中'] });
  assert.deepEqual(classifyJdCartAvailability(row({ checkbox_disabled: true, quantity: null })),
    { status: 'unrecognized', reasons: ['checkbox_disabled_without_other_signal'] });
  assert.deepEqual(classifyJdCartAvailability(row({ checkbox_disabled: true, product_id: null })),
    { status: 'unrecognized', reasons: ['checkbox_disabled_without_other_signal', 'missing_product_id'] });
  assert.deepEqual(classifyJdCartAvailability(row({ checkbox_disabled: null })),
    { status: 'unrecognized', reasons: ['missing_checkbox'] });
  assert.deepEqual(classifyJdCartAvailability(row({
    mask_text: '无货', title_unavailable: true, price_kind: 'status_text', price_text: '商品补货中', quantity: null, product_id: null,
  })), { status: 'unrecognized', reasons: ['unexpected_mask', 'title_unavailable_without_disabled_checkbox', 'price_status_text', 'missing_quantity', 'missing_product_id'] });
  assert.deepEqual(classifyJdCartAvailability(row({
    checkbox_disabled: null, mask_text: '无货', title_unavailable: true, price_kind: null, price_text: null, quantity: null, product_id: '',
  })), { status: 'unrecognized', reasons: ['missing_checkbox', 'no_price', 'missing_quantity', 'missing_product_id'] });
  assert.deepEqual(classifyJdCartAvailability(row({ price_kind: 'status_text', price_text: '商品补货中' })),
    { status: 'unrecognized', reasons: ['price_status_text'] });
  assert.equal(JSON.stringify(classifyJdCartAvailability(row({ checkbox_disabled: true, mask_text: '无货' }))).includes('variant_out_of_stock'), false);

  const one = (rowOptions) => read({ header: null, shops: [cartShop({ name: '合成数码旗舰店', zy: true, rows: [cartRow(rowOptions)] })] }).result.rows[0];
  const missingBox = one({ checkbox: false, id: '100030', title: '合成无勾选商品' });
  assert.deepEqual([missingBox.checkbox_disabled, missingBox.checkbox_checked, missingBox.availability],
    [null, null, { status: 'unrecognized', reasons: ['missing_checkbox'] }]);
  const titleOnly = one({ disabled: true, unavailable: true, id: '100031', title: '合成仅标题不可买' });
  assert.deepEqual([titleOnly.checkbox_disabled, titleOnly.availability], [true, { status: 'cannot_buy', reasons: [] }]);
  assert.deepEqual(one({ quantity: 0, id: '100033', title: '合成数量为零' }).availability, { status: 'no_marker_seen', reasons: [] });
  const leading = one({ quantity: '02', id: '100034', title: '合成数量前导零' });
  assert.deepEqual([leading.quantity, leading.availability], [null, { status: 'unrecognized', reasons: ['missing_quantity'] }]);
  const container = one({ containerOnly: '合成容器价', priceKind: null, priceText: null, id: '100035', title: '合成仅容器价' });
  assert.deepEqual([container.price_text, container.price_kind, container.availability.reasons], [null, null, ['no_price']]);
  assert.equal(JSON.stringify(container).includes('合成容器价'), false);
  const mixed = one({ mask: '无货', priceKind: null, priceText: null, quantity: null, id: null, title: '合成多原因' });
  assert.deepEqual(mixed.availability, { status: 'unrecognized', reasons: ['unexpected_mask', 'no_price', 'missing_quantity', 'missing_product_id'] });
  const cleaned = one({ title: '合成\u0001双  空格', titleText: '合成短名不采用', id: '100020' });
  assert.equal(cleaned.title, '合成 双 空格');
  assert.equal(JSON.stringify(cleaned).includes('合成短名不采用'), false);
  assert.equal(read({ header: null, shops: [cartShop({ name: '合成数码旗舰店', rows: [cartRow({ title: '合成无页头商品' })] })] }).result.header_count_text, null);
});

test('login, limit, verification, a wrong address and a cart shell without rows stop the read', () => {
  const target = jdCartPage().target;
  const attempt = options => () => {
    const page = jdCartPage(options);
    return validateJdCart(page.evaluate(jdCartScript(target)), target);
  };
  assert.throws(attempt({ href: 'https://passport.jd.com/new/login.aspx' }), { code: 'LOGIN_REQUIRED' });
  assert.throws(attempt({ href: 'https://pc-frequent-pro.pf.jd.com/' }), { code: 'RATE_LIMITED' });
  assert.throws(attempt({ extra: [element('div', { text: '访问频繁' })] }), { code: 'RATE_LIMITED' });
  assert.throws(attempt({ extra: [element('div', { cls: 'JDJRV-wrap' })] }), { code: 'VERIFICATION_REQUIRED' });
  assert.throws(attempt({ href: 'https://item.jd.com/100001.html' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://example.invalid/cart' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://cart.jd.com/addToCart.html' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ list: false }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(attempt({ lists: 2 }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(attempt({ shops: [cartShop({ name: '合成空店', rows: [] })] }), { code: 'PAGE_STRUCTURE_CHANGED' });
  for (const href of ['https://cart.jd.com/cart.action', 'https://cart.jd.com/cart_index/', 'https://cart.jd.com/cart_index?r=1#section']) {
    const page = jdCartPage({ href });
    const result = validateJdCart(page.evaluate(jdCartScript(page.target)), page.target, { observedAt: AT });
    assert.equal(result.url, 'https://cart.jd.com/cart_index');
    assert.equal(result.rows_seen, 7);
  }
  assert.throws(() => jdCartScript({ platform: 'jd', url: 'https://cart.jd.com/cart.action' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => jdCartScript({ url: 'https://cart.jd.com/cart_index', platform: 'jd' }), { code: 'INVALID_ARGUMENTS' });
});

test('a raw extra field is rejected, and a saved copy that no longer matches its own fields is rejected', () => {
  const page = jdCartPage();
  const script = jdCartScript(page.target);
  const fresh = () => page.evaluate(script);
  for (const edit of [value => { value.extra = true; }, value => { value.rows[0].extra = true; },
    value => { value.rows[0].availability = { status: 'cannot_buy', reasons: [] }; }, value => { value.rows_seen = 8; },
    value => { value.rows[0].product_id = '1'.repeat(21); }, value => { value.header_count_text = 12; },
    value => { value.rows_outside_shops = -1; }, value => { delete value.rows_outside_shops; }]) {
    const raw = fresh();
    edit(raw);
    assert.throws(() => validateJdCart(raw, page.target), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => validateJdCart(fresh(), { url: 'https://cart.jd.com/cart_index', platform: 'jd' }), { code: 'INVALID_ARGUMENTS' });
  const result = validateJdCart(fresh(), page.target, { observedAt: AT });
  validateSavedJdCart(result, page.target);
  for (const edit of [value => { value.rows[0].url = 'https://item.jd.com/1.html'; }, value => { value.rows[1].availability.reasons = []; },
    value => { value.rows[0].availability.status = 'cannot_buy'; }, value => { value.availability_summary.cannot_buy = 9; },
    value => { value.quantity_sum = 0; }, value => { value.rows_omitted = 1; }, value => { value.coverage.scrolled = true; },
    value => { value.extra = true; }, value => { value.rows[0].product_id = '100099'; }, value => { value.rows_seen = 8; },
    value => { value.platform = 'taobao'; }, value => { value.login_verified = true; }, value => { value.missing = []; },
    value => { value.rows_outside_shops = 0; },
    value => { value.schema_version = 2; }, value => { delete value.schema_version; }, value => { value.observed_at = 'not-a-time'; },
    value => {
      const row = value.rows[0];
      const reversed = {};
      for (const key of Object.keys(row).reverse()) reversed[key] = row[key];
      value.rows[0] = reversed;
    },
    value => {
      const reversed = {};
      for (const key of Object.keys(value).reverse()) reversed[key] = value[key];
      return reversed;
    }]) {
    const copy = structuredClone(result);
    const edited = edit(copy) ?? copy;
    assert.throws(() => validateSavedJdCart(edited, page.target), { code: 'INVALID_CHECKPOINT' });
  }
  assert.throws(() => validateSavedJdCart(result, { platform: 'jd', url: 'https://cart.jd.com/cart.action' }), { code: 'INVALID_CHECKPOINT' });
});

test('readJdCart is a paced read and is marked not dispatched only before the page script is sent', async t => {
  assert.deepEqual(PACED_METHODS.readJdCart, ['read']);
  const page = jdCartPage();
  const { endpoint, state } = await mockBridge(t, { handler: ({ req, res, body }) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url: 'https://cart.jd.com/cart.action?r=9' }] } }));
    if (body?.action === 'eval') return res.end(JSON.stringify({ id: body.id, success: true, data: { result: page.evaluate(body.script) } }));
    res.end(JSON.stringify({ id: body?.id, success: false, error: 'unsupported' }));
  } });
  const result = await new BrowserBridge(endpoint).readJdCart(88, page.target);
  assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval']);
  assert.equal(state.commands[1].script.includes('collectJdCart'), true);
  assert.equal(Number.isNaN(Date.parse(result.observed_at)), false);
  assert.deepEqual(result, validateJdCart(page.evaluate(jdCartScript(page.target)), page.target, { observedAt: result.observed_at }));
  absent(result, page.secrets);

  const disconnected = await mockBridge(t);
  disconnected.state.connected = false;
  await assert.rejects(new BrowserBridge(disconnected.endpoint).readJdCart(88, page.target), { code: 'EXTENSION_DISCONNECTED', actionNotDispatched: true });
  assert.equal(disconnected.state.commands.length, 0);

  const missing = await mockBridge(t);
  await assert.rejects(new BrowserBridge(missing.endpoint).readJdCart(88, page.target), { code: 'TARGET_MISSING', actionNotDispatched: true });
  assert.deepEqual(missing.state.commands.map(command => command.action), ['tab_list', 'eval']);
  assert.equal(missing.state.commands[1].script.includes('tab_address'), true);
  assert.equal(missing.state.commands[1].script.includes('collectJdCart'), false);

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
    await assert.rejects(new BrowserBridge(wrong.endpoint).readJdCart(88, page.target), { code, actionNotDispatched: true });
    assert.deepEqual(wrong.state.commands.map(command => command.action), ['tab_list']);
  }

  const idle = await mockBridge(t);
  await assert.rejects(new BrowserBridge(idle.endpoint).readJdCart(88, { platform: 'jd', url: 'https://cart.jd.com/cart_index?r=1' }),
    { code: 'INVALID_ARGUMENTS', actionNotDispatched: true });
  assert.equal(idle.state.requests.length, 0);

  const dropped = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url: page.target.url }] } }));
    res.end(JSON.stringify({ id: body.id, success: false, error: 'PRIVATE_ERROR' }));
  } });
  await assert.rejects(new BrowserBridge(dropped.endpoint).readJdCart(88, page.target), error => {
    assert.equal(error.code, 'BROWSER_COMMAND_FAILED');
    assert.equal(error.actionNotDispatched, undefined);
    assert.equal(String(error.message).includes('PRIVATE_ERROR'), false);
    return true;
  });
  assert.equal(dropped.state.commands.some(command => command.action === 'eval' && command.script.includes('collectJdCart')), true);

  const empty = jdCartPage({ list: false });
  const changed = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url: empty.target.url }] } }));
    if (body?.action === 'eval') return res.end(JSON.stringify({ id: body.id, success: true, data: { result: empty.evaluate(body.script) } }));
    res.end(JSON.stringify({ id: body?.id, success: false, error: 'unsupported' }));
  } });
  await assert.rejects(new BrowserBridge(changed.endpoint).readJdCart(88, empty.target), error => {
    assert.equal(error.code, 'PAGE_STRUCTURE_CHANGED');
    assert.equal(error.actionNotDispatched, undefined);
    return true;
  });
  assert.equal(changed.state.commands.some(command => command.script?.includes('collectJdCart')), true);
});

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd cart '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a JD cart task runs on the JD ledger, saves its rows, reports the cart address and exports Markdown and CSV', async t => {
  const page = jdCartPage();
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 88, url: 'https://cart.jd.com/cart_index' }, { id: 41, url: 'https://s.taobao.com/search?q=mouse&page=1&tab=all' }];
  state.metadata = page.evaluate(jdCartScript(page.target));
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const [extra, code] of [
    [['--cart'], 'INVALID_ARGUMENTS'],
    [['--cart', '--tab', '88', '--search', 'mouse'], 'INVALID_ARGUMENTS'],
    [['--cart', '--tab', '88', '--bindings', 'jd-mouse'], 'INVALID_ARGUMENTS'],
    [['--cart', '--tab', '88', '--details'], 'INVALID_ARGUMENTS'],
    [['--cart', '--tab', '88', '--orders'], 'INVALID_ARGUMENTS'],
    [['--cart', '--tab', '88', '--order-rows', '5'], 'UNSUPPORTED_PLATFORM'],
  ]) {
    assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, code, extra.join(' '));
  }
  const created = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-cart', '--cart', '--tab', '88']);
  assert.deepEqual([created.code, created.value.task_kind, created.value.platform, created.value.products], [0, 'jd_cart', 'jd', 0]);
  const ran = await run(['task-run', ...common, '--task', 'jd-cart']);
  assert.deepEqual([ran.code, ran.value.status, ran.value.operations[0].cart_url], [0, 'complete', 'https://cart.jd.com/cart_index']);
  const result = ran.value.operations[0].result;
  assert.deepEqual([result.rows_seen, result.rows_outside_shops, result.availability_summary], [7, 1, { cannot_buy: 2, no_marker_seen: 2, unrecognized: 3 }]);
  assert.deepEqual(state.commands.filter(command => command.action === 'eval').map(command => command.script.includes('collectJdCart')).filter(Boolean), [true]);
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false, 'the JD read uses the JD ledger');
  assert.ok(existsSync(path.join(directory, 'pacing-jd.json')));
  const status = await run(['task-status', '--state-dir', directory, '--task', 'jd-cart']);
  assert.deepEqual(status.value.operations[0].result, result);

  const markdown = path.join(directory, '..', `jd-cart-${path.basename(directory)}.md`);
  const csv = path.join(directory, '..', `jd-cart-${path.basename(directory)}.csv`);
  t.after(() => Promise.all([rm(markdown, { force: true }), rm(csv, { force: true })]));
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-cart', '--format', 'markdown', '--output', markdown])).code, 0);
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-cart', '--format', 'csv', '--output', csv])).code, 0);
  const rows = await readFile(csv, 'utf8');
  for (const pattern of [/"cart_header_count",[^\n]*"header_count","12"/, /"cart_scan",[^\n]*"rows_outside_shops","1"/,
    /"cart_item",[^\n]*"'100001","合成耳机标准款全称","https:\/\/item.jd.com\/100001.html"/,
    /"cart_shop",[^\n]*"合成数码旗舰店"[^\n]*zy_icon=true/, /"cart_specification",[^\n]*"合成项目","合成规格黑色标准版"/,
    /"cart_price",[^\n]*"￥合成价1299.00"[^\n]*kind=normal; other_amount=￥合成对照价/,
    /"cart_availability",[^\n]*"cannot_buy","无货 \/ 商品补货中"/, /"cart_availability",[^\n]*"unrecognized","no_price"/,
    /"coverage",[^\n]*"scope","loaded_rows_only"/, /"coverage",[^\n]*"availability.cannot_buy","2"/, /"missing_field",[^\n]*"rows_outside_shops"/]) {
    assert.match(rows, pattern);
  }
  const text = await readFile(markdown, 'utf8');
  assert.match(text, /jd\\_cart/);
  absent(rows, page.secrets);
  absent(text, page.secrets);

  const file = path.join(directory, 'tasks', 'jd-cart.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.operations[0].result.rows[1].availability.status = 'no_marker_seen';
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'jd-cart'])).value.error.code, 'INVALID_CHECKPOINT');
});

test('a JD cart limit pauses the task, records the cart page kind and holds only JD tasks', async t => {
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 88, url: 'https://cart.jd.com/cart_index' }, { id: 41, url: 'https://s.taobao.com/search?q=mouse&page=1&tab=all' }];
  state.metadata = { state: 'rate_limited' };
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-cart', '--cart', '--tab', '88']);
  const paused = await run(['task-run', ...common, '--task', 'jd-cart']);
  assert.deepEqual([paused.value.status, paused.value.operations[0].error.code], ['waiting_cooldown', 'RATE_LIMITED']);
  const log = await readThrottleObservations(directory);
  assert.deepEqual(log.observations.map(entry => [entry.platform, entry.signal, entry.page_kind]), [['jd', 'rate_limited', 'cart']]);
  assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-second', '--cart', '--tab', '88'])).value.error.code, 'PLATFORM_TASK_UNFINISHED');
  const taobao = await run(['task-start', ...common, '--task', 'taobao-search', '--search', 'mouse', '--tab', '41']);
  assert.deepEqual([taobao.code, taobao.value.task_kind], [0, 'search'], 'the paused JD cart task does not hold Taobao');
});
