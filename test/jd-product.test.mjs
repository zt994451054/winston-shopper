import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { jdDetailScrollScript, jdProductScript, validateJdDetailScroll, validateJdProductObservation } from '../lib/jd/product.mjs';
import { jdProductResult, newJdProductReadState, runJdProductRead, validateJdProductResult } from '../lib/jd/product-read.mjs';
import { buildCachedReport, renderCachedReport } from '../lib/cached-report.mjs';
import { saveBinding } from '../lib/state.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { element, jdProductPage } from '../test-support/jd-product-fixture.mjs';

/** Bridge stand-in that evaluates the real page scripts against the synthetic page, as the extension would. */
function fakeBridge(page, { scrollError = null } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    async readJdProduct(tabId, target) {
      calls.push('read'); reads += 1;
      const raw = page.evaluate(jdProductScript(target));
      validateJdProductObservation(raw, target);
      return { observed_at: new Date(Date.UTC(2026, 9, 15, 3, 0, reads)).toISOString(), raw };
    },
    async scrollJdDetails(tabId, target) {
      calls.push('scroll');
      if (scrollError) throw scrollError;
      return validateJdDetailScroll(page.evaluate(jdDetailScrollScript(target)));
    },
  };
}

function clock() {
  let time = 1_000_000;
  return { now: () => time, wait: async ms => { time += ms; } };
}

function operation(page) {
  return { tab_id: 88, target: page.target, recovery_kind: null, product_read: newJdProductReadState() };
}

async function read(page, op = operation(page), bridge = fakeBridge(page)) {
  const { now, wait } = clock();
  const result = await runJdProductRead({ bridge, op, commit: async () => {}, now, wait });
  return { result, op, bridge };
}

test('the panel and a loaded 商品详情 section are read without a scroll; other specs are listed as same-group specs only', async () => {
  const page = jdProductPage({ loaded: true });
  const { result, op, bridge } = await read(page);
  assert.deepEqual(bridge.calls, ['read']);
  assert.equal(page.scrolls, 0);
  assert.deepEqual([result.platform, result.product_id, result.url, result.title, result.self_operated, result.shop],
    ['jd', '3290995', 'https://item.jd.com/3290995.html', 'Synthetic JD mouse', true, 'Synthetic shop']);
  assert.deepEqual(result.price, { raw: '¥ 80.10 补贴价 ¥89', amount_text: '¥80.10', kind: 'single_displayed', amount: '80.10', minimum: null, maximum: null,
    currency: 'CNY', tags: ['补贴价'], other_amounts: [{ text: '¥89', line_through: true }], eligibility_verified: false });
  assert.equal(result.comment_count_text, '50万+');
  assert.deepEqual(result.series, { label: '系列', items: [{ text: 'M330', selected: false }, { text: 'M331', selected: true }] });
  assert.deepEqual(result.same_group_specs.map(group => [group.name, group.options.map(option => [option.text, option.selected, option.out_of_stock, option.out_of_stock_text, option.image?.url ?? null])]), [
    ['颜色', [['黑色', true, false, '', 'https://img14.360buyimg.com/n9/black.jpg'], ['红色', false, false, '', 'https://img14.360buyimg.com/n9/red.jpg']]],
    ['尺码', [['M', true, false, '', null], ['L', false, true, '无货', null]]]]);
  assert.ok(!JSON.stringify(result.same_group_specs).includes('80.10'), 'no price is attached to a same-group spec');
  assert.deepEqual(result.services, [{ label: '7天价保', description: '下单后7天内降价可申请价保' }, { label: '包邮', description: '所选地址包邮' }]);
  assert.deepEqual(result.gallery.map(image => image.url), ['https://img10.360buyimg.com/n5/a.jpg', 'https://img10.360buyimg.com/n5/b.jpg']);
  assert.deepEqual(result.detail.highlights, [{ name: '续航时间', value: '24个月' }]);
  assert.deepEqual(result.detail.parameters, [{ name: '品牌', value: '罗技（Logitech）' }]);
  assert.deepEqual([result.schema_version, result.detail.parameters_seen, result.detail.empty_parameter_rows_omitted], [4, 2, 1]);
  assert.deepEqual(result.detail.view, { visible: true, focused: true, scroll_y: 40, title_top: 2800 });
  assert.deepEqual(result.detail.images.map(image => [image.region, image.kind, image.url]), [
    ['related_head', 'img', 'https://img30.360buyimg.com/shop/activity.jpg'], ['detail_main', 'img', 'https://img30.360buyimg.com/sku/d1.jpg'],
    ['detail_main', 'img', 'https://img30.360buyimg.com/sku/d2.jpg']]);
  assert.deepEqual(result.detail_action, { initial_observed_at: result.observed_at, initial_status: 'loaded', scroll_reserved: false, scroll: null,
    scroll_error: null, observations_reserved: 1, checks_after_scroll: 0 });
  assert.deepEqual(result.coverage, { status: 'partial', scope: 'single_product_page', same_group_specs_are_separate_products: true,
    same_group_spec_prices_read: false, detail_section_loaded: true, full_description_verified: false, reviews_read: false,
    review_summary_read: true });
  assert.deepEqual(result.missing, ['same_group_spec_prices', 'reviews', 'verified_payable_price']);
  assert.deepEqual(result.review_summary, {
    status: 'loaded', title: '买家评价(20+)', count_text: '20+', praise: '超过半数',
    tags: [{ text: '手感清楚', count_text: '3' }, { text: '做工清楚', count_text: '1万+' }, { text: '没有人数', count_text: '' }],
    tags_seen: 3,
    previews: [{ body: '合成评价正文一', body_length: '合成评价正文一'.length, image_count: 1 },
      { body: '合成评价正文二', body_length: '合成评价正文二'.length, image_count: 0 }],
    previews_seen: 2, all_reviews_entry: true, excluded: ['nicknames', 'avatars', 'review_images'],
  });
  assert.equal(JSON.stringify(result).includes('Synthetic buyer'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-avatar'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-review'), false);
  assert.equal(JSON.stringify(result).includes('嵌套评价不应被读到'), false);
  validateJdProductResult(result, page.target, op.product_read);
  assert.doesNotMatch(jdProductScript(page.target), /\.click\(|scrollIntoView|scrollTo|scrollBy|fetch\(|XMLHttpRequest|cookie|Storage|location\.assign/);
  assert.doesNotMatch(jdProductScript(page.target), /comment-user|nickname|headimg/);
  assert.doesNotMatch(jdDetailScrollScript(page.target), /\.click\(|fetch\(|XMLHttpRequest|cookie|Storage/);
});

test('self-operated comes from the shop header badge, and the page visibility is kept with the section', async () => {
  const { result } = await read(jdProductPage({ self: false, loaded: true, visibility: 'hidden' }));
  assert.deepEqual([result.self_operated, result.title_icons], [false, ['6']]);
  assert.deepEqual(result.detail.view, { visible: false, focused: false, scroll_y: 40, title_top: 2800 });
});

test('format 1 and 2 journals from the first two live runs are rebuilt with their own rules', async () => {
  const page = jdProductPage({ loaded: true });
  const { op } = await read(page);
  // Before format 3 the page script saved one string per service tag: its explanation, or else its name.
  const older = version => {
    const state = { ...structuredClone(op.product_read), schema_version: version };
    state.last.raw.panel.services = state.last.raw.panel.services.map(service => service.description || service.label);
    return state;
  };
  const second = older(2), formatTwo = jdProductResult(second, page.target);
  assert.deepEqual([formatTwo.schema_version, formatTwo.services, formatTwo.self_operated], [2, ['下单后7天内降价可申请价保', '所选地址包邮'], true]);
  validateJdProductResult(formatTwo, page.target, second);
  const state = older(1);
  const old = jdProductResult(state, page.target);
  // Format 1 looked for 自营 in the icon alt texts, kept empty parameter rows and had no view.
  assert.deepEqual([old.schema_version, old.self_operated, old.detail.parameters.length, old.detail.view, old.detail.empty_parameter_rows_omitted],
    [1, false, 2, undefined, undefined]);
  validateJdProductResult(old, page.target, state);
  assert.equal(Object.hasOwn(formatTwo, 'review_summary'), false);
  assert.equal(Object.hasOwn(formatTwo.coverage, 'review_summary_read'), false);
  assert.equal(Object.hasOwn(old, 'review_summary'), false);
  assert.equal(Object.hasOwn(old.coverage, 'review_summary_read'), false);
  assert.throws(() => validateJdProductResult({ ...old, schema_version: 2 }, page.target, state), { code: 'INVALID_CHECKPOINT' });
});

test('a format 3 result ignores a review block on the raw read, and its export does not gain the new coverage key', async () => {
  const page = jdProductPage({ loaded: true });
  const { op } = await read(page);
  const state = structuredClone(op.product_read);
  state.schema_version = 3;
  const result = jdProductResult(state, page.target);
  const stripped = structuredClone(state);
  delete stripped.last.raw.reviews;
  const without = jdProductResult(stripped, page.target);
  assert.equal(JSON.stringify(result), JSON.stringify(without));
  assert.equal(result.schema_version, 3);
  assert.equal(Object.hasOwn(result, 'review_summary'), false);
  assert.deepEqual(result.coverage, { status: 'partial', scope: 'single_product_page', same_group_specs_are_separate_products: true,
    same_group_spec_prices_read: false, detail_section_loaded: true, full_description_verified: false, reviews_read: false });
  assert.deepEqual(result.missing, ['same_group_spec_prices', 'reviews', 'verified_payable_price']);
  const taskOf = value => ({ id: 'jd-format-3', kind: 'jd_product', status: 'complete', created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z', operations: [{ status: 'succeeded', result: value }] });
  for (const format of ['csv', 'markdown']) {
    const rendered = renderCachedReport(buildCachedReport(taskOf(result)), format);
    assert.equal(rendered, renderCachedReport(buildCachedReport(taskOf(without)), format));
    assert.doesNotMatch(rendered, /review_summary|review_tag|review_preview/);
  }
  assert.deepEqual(buildCachedReport(taskOf(result)).observations[0].coverage, {
    status: 'partial', scope: 'single_product_page', same_group_specs_are_separate_products: true,
    same_group_spec_prices_read: false, detail_section_loaded: true, full_description_verified: false, reviews_read: false,
  });
});

test('a page without the default review block still finishes, and the count stays the last parenthetical', async () => {
  const page = jdProductPage({ loaded: true, reviews: false });
  const { result, bridge } = await read(page);
  assert.deepEqual(bridge.calls, ['read']);
  assert.equal(result.detail.status, 'loaded');
  assert.deepEqual(result.review_summary, { status: 'missing' });
  assert.equal(result.coverage.reviews_read, false);
  assert.equal(result.coverage.review_summary_read, false);
  assert.deepEqual(result.missing, ['same_group_spec_prices', 'reviews', 'verified_payable_price', 'review_summary']);
  const task = { id: 'jd-missing', kind: 'jd_product', status: 'complete', created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z', operations: [{ status: 'succeeded', result }] };
  const records = buildCachedReport(task).records.filter(row => String(row.record_type).startsWith('review_'));
  assert.deepEqual(records.map(row => [row.record_type, row.label, row.text, row.qualifier]),
    [['review_summary', 'missing', null, 'count=; praise=; entry=']]);

  const present = jdProductPage({ loaded: true });
  const readState = (await read(present)).op.product_read;
  readState.last.raw.reviews.title = '买家评价';
  assert.equal(jdProductResult(readState, present.target).review_summary.count_text, null);
  readState.last.raw.reviews.title = '买家评价（8）还有(9)';
  const lastPair = jdProductResult(readState, present.target).review_summary;
  assert.equal(lastPair.title, '买家评价（8）还有(9)');
  assert.equal(lastPair.count_text, '9');
});

test('impression tags and previews past the limit are cut, and the full counts are kept', async () => {
  const page = jdProductPage({ loaded: true, reviewCounts: { tags: 21, previews: 11, bodyLength: 1500 } });
  const { result } = await read(page);
  const summary = result.review_summary;
  assert.equal(summary.tags.length, 20);
  assert.equal(summary.tags_seen, 21);
  assert.equal(summary.tags[0].text, '合成印象1');
  assert.equal(summary.tags[0].count_text, '1');
  assert.equal(JSON.stringify(result).includes('合成印象21'), false);
  assert.equal(summary.previews.length, 10);
  assert.equal(summary.previews_seen, 11);
  assert.equal(summary.previews[0].body, '长'.repeat(1000));
  assert.equal(summary.previews[0].body_length, 1500);
  assert.equal(summary.previews[0].image_count, 1);
  assert.equal(JSON.stringify(result).includes('合成评价正文11'), false);
  assert.equal(JSON.stringify(result).includes('Synthetic buyer'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-review'), false);
  assert.equal(JSON.stringify(result).includes('嵌套评价不应被读到'), false);
});

test('an unloaded section is scrolled to once, then checked until it loads', async () => {
  const page = jdProductPage();
  const { result, op, bridge } = await read(page);
  assert.deepEqual(bridge.calls, ['read', 'scroll', 'read']);
  assert.equal(page.scrolls, 1);
  assert.equal(JSON.stringify(page.options), JSON.stringify({ behavior: 'instant', block: 'start' }));
  assert.deepEqual([result.detail.status, result.detail.title_in_view, result.detail.images.length], ['loaded', true, 3]);
  assert.deepEqual(result.detail_action, { initial_observed_at: '2026-10-15T03:00:01.000Z', initial_status: 'not_loaded', scroll_reserved: true,
    scroll: { scroll_y_before: 40, scroll_y_after: 2900 }, scroll_error: null, observations_reserved: 2, checks_after_scroll: 1 });
  validateJdProductResult(result, page.target, op.product_read);
});

test('a section that never loads ends after three checks with the section reported missing, and the scroll is not repeated', async () => {
  const page = jdProductPage({ loadsOnScroll: false });
  const { result, bridge } = await read(page);
  assert.deepEqual(bridge.calls, ['read', 'scroll', 'read', 'read', 'read']);
  assert.equal(page.scrolls, 1);
  assert.equal(result.detail.status, 'not_loaded');
  assert.equal(result.coverage.detail_section_loaded, false);
  assert.ok(result.missing.includes('detail_section'));
});

test('detail modules drawn as CSS backgrounds are kept with their kind; other hosts are counted, not returned', async () => {
  const { result } = await read(jdProductPage({ detail: 'css', loaded: true }));
  assert.deepEqual(result.detail.images.slice(1).map(image => [image.region, image.kind, image.url, image.loaded, image.height]),
    [['detail_main', 'css_background', 'https://img30.360buyimg.com/sku/m1.jpg', null, 900]]);
  assert.deepEqual([result.detail.elements_scanned, result.detail.unsupported_elements_omitted], [3, 1]);
});

test('an interrupted run never scrolls again, and an uncertain scroll error is recorded while the checks continue', async () => {
  const page = jdProductPage();
  const op = operation(page);
  // Saved just before the scroll was sent: the reservation is on disk, the acknowledgement is not.
  const first = fakeBridge(page);
  const { now } = clock();
  op.product_read.observations = 1;
  const initial = await first.readJdProduct(88, page.target);
  Object.assign(op.product_read, { initial: { observed_at: initial.observed_at, detail_status: 'not_loaded', title_in_view: false },
    last: initial, scroll_reserved: true, not_before: now() });
  const resumed = await read(page, op);
  assert.deepEqual(resumed.bridge.calls, ['read', 'read', 'read']);
  assert.equal(page.scrolls, 0);
  assert.equal(resumed.result.detail.status, 'not_loaded');

  const timeout = new ShoppingError('BRIDGE_TIMEOUT', 'No acknowledgement.');
  const uncertain = await read(jdProductPage(), undefined, fakeBridge(jdProductPage(), { scrollError: timeout }));
  assert.deepEqual(uncertain.bridge.calls, ['read', 'scroll', 'read', 'read', 'read']);
  assert.deepEqual([uncertain.result.detail_action.scroll, uncertain.result.detail_action.scroll_error], [null, 'BRIDGE_TIMEOUT']);
});

test('a scroll refused before it reached the page is released, so a later run may scroll once', async () => {
  const page = jdProductPage();
  const op = operation(page);
  const refused = new ShoppingError('RATE_LIMITED', 'Limit page.');
  refused.actionNotDispatched = true;
  await assert.rejects(read(page, op, fakeBridge(page, { scrollError: refused })), { code: 'RATE_LIMITED' });
  assert.deepEqual([op.product_read.scroll_reserved, op.product_read.scroll_error, page.scrolls], [false, null, 0]);
  const { result, bridge } = await read(page, op);
  assert.deepEqual(bridge.calls, ['scroll', 'read']);
  assert.deepEqual([page.scrolls, result.detail.status], [1, 'loaded']);
});

test('another product, a login or limit page, two product panels and a missing title stop the read; a page without the section is not scrolled', async () => {
  const attempt = options => () => {
    const page = jdProductPage(options);
    return validateJdProductObservation(page.evaluate(jdProductScript(jdProductPage().target)), jdProductPage().target);
  };
  assert.throws(attempt({ href: 'https://item.jd.com/100.html' }), { code: 'TARGET_CHANGED' });
  assert.throws(attempt({ href: 'https://passport.jd.com/new/login.aspx' }), { code: 'LOGIN_REQUIRED' });
  assert.throws(attempt({ extra: [element('div', { text: '访问频繁，请稍后再试' })] }), { code: 'RATE_LIMITED' });
  assert.throws(attempt({ panels: 2 }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(attempt({ title: '' }), { code: 'PAGE_STRUCTURE_CHANGED' });
  const page = jdProductPage({ detail: 'none' });
  const { result, bridge } = await read(page);
  assert.deepEqual([bridge.calls, result.detail, result.missing.includes('detail_section')], [['read'], { status: 'section_missing' }, true]);
  const limited = jdProductPage({ extra: [element('div', { text: '访问频繁' })] });
  assert.deepEqual(limited.evaluate(jdDetailScrollScript(limited.target)), { state: 'rate_limited' });
  assert.equal(limited.scrolls, 0);
});

test('a saved result or journal that does not match is rejected', async () => {
  const page = jdProductPage();
  const { result, op } = await read(page);
  for (const edit of [(value, state) => { value.title = 'Other'; }, (value, state) => { value.same_group_specs[0].options[0].selected = false; },
    (value, state) => { state.last.raw.panel.title = 'Edited'; }, (value, state) => { state.checks = 0; },
    (value, state) => { state.scroll = null; state.scroll_error = 'BRIDGE_TIMEOUT'; state.scroll_reserved = false; },
    (value, state) => { state.initial.detail_status = 'loaded'; }, (value, state) => { state.extra = 1; },
    (value, state) => { value.coverage.same_group_spec_prices_read = true; }]) {
    const copy = structuredClone(result), state = structuredClone(op.product_read);
    edit(copy, state);
    assert.throws(() => validateJdProductResult(copy, page.target, state), { code: 'INVALID_CHECKPOINT' });
  }
});

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

/** A loopback bridge whose eval commands run the real scripts against the synthetic page. */
function pageBridge(t, page, tabId = 88) {
  return mockBridge(t, { handler: ({ req, res, body }) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: tabId, url: page.target.url }] } }));
    if (body?.action === 'eval') return res.end(JSON.stringify({ id: body.id, success: true, data: { result: page.evaluate(body.script) } }));
    res.end(JSON.stringify({ id: body?.id, success: false, error: 'unsupported' }));
  } });
}

test('a JD product task reads, scrolls once, saves its result on the JD ledger and exports same-group specs and detail images', async t => {
  const page = jdProductPage();
  const { endpoint } = await pageBridge(t, page);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd product '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveBinding(directory, 'jd-mouse', { schema_version: 1, platform: 'jd', endpoint, tab_id: 88, target: page.target, created_at: new Date().toISOString() });
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const [extra, code] of [[['--bindings', 'jd-mouse,jd-other', '--details'], 'INVALID_ARGUMENTS'], [['--bindings', 'jd-mouse'], 'INVALID_ARGUMENTS'],
    [['--details'], 'INVALID_ARGUMENTS'], [['--bindings', 'jd-mouse', '--services'], 'UNSUPPORTED_PLATFORM']]) {
    assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, code);
  }
  const created = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-detail', '--bindings', 'jd-mouse', '--details']);
  assert.deepEqual([created.code, created.value.task_kind, created.value.products], [0, 'jd_product', 1]);
  const ran = await run(['task-run', ...common, '--task', 'jd-detail']);
  assert.deepEqual([ran.code, ran.value.status, ran.value.operations[0].product_id, ran.value.operations[0].actions_reserved], [0, 'complete', '3290995', 1]);
  assert.equal(ran.value.operations[0].result.detail.status, 'loaded');
  assert.equal(page.scrolls, 1);
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false);
  assert.ok(existsSync(path.join(directory, 'pacing-jd.json')));
  const status = await run(['task-status', '--state-dir', directory, '--task', 'jd-detail']);
  assert.deepEqual(status.value.operations[0].result, ran.value.operations[0].result);
  const csv = path.join(directory, '..', `jd-product-${path.basename(directory)}.csv`);
  t.after(() => rm(csv, { force: true }));
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-detail', '--format', 'csv', '--output', csv])).code, 0);
  const rows = await readFile(csv, 'utf8');
  for (const pattern of [/"same_group_spec",[^\n]*"黑色"[^\n]*"颜色"/, /"detail_section",[^\n]*"loaded"/, /"image_link",[^\n]*"detail_main"[^\n]*kind=img/,
    /"price_other_amount",[^\n]*"line_through","¥89"/, /"service_label",[^\n]*"7天价保","下单后7天内降价可申请价保"/, /"parameter",[^\n]*"品牌"/, /"product_marks",[^\n]*self_operated=true/,
    /"review_summary",[^\n]*"loaded","买家评价\(20\+\)"[^\n]*count=20\+; praise=超过半数; entry=true/,
    /"review_tag",[^\n]*"手感清楚","3"/, /"review_preview",[^\n]*"合成评价正文一"[^\n]*length=7; images=1/]) assert.match(rows, pattern);
  assert.equal(rows.includes('Synthetic buyer'), false);
  assert.equal(rows.includes('synthetic-avatar'), false);
  assert.equal(rows.includes('synthetic-review'), false);
  // A tampered saved task is refused before any browser command.
  const file = path.join(directory, 'tasks', 'jd-detail.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.operations[0].result.title = 'Edited';
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'jd-detail'])).value.error.code, 'INVALID_CHECKPOINT');
});
