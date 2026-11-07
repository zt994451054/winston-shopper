import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { PACING_POLICY, PDD_PACING_POLICY } from '../lib/pacing.mjs';
import { pacingFile, pacingPolicy, parsePlatform } from '../lib/platforms.mjs';
import { pageStillMatches } from '../lib/opened-pages.mjs';
import { readThrottleObservations } from '../lib/throttle-log.mjs';
import { loadBinding, saveBinding } from '../lib/state.mjs';
import { pddPageGate } from '../lib/pdd/page-gate.mjs';
import {
  parsePddOrderDetailUrl, parsePddOrderListUrl, parsePddProductUrl, parsePddReviewsUrl, parsePddSearchUrl, pddLandingKind, pddMetadataScript,
  pddSearchTarget, summarizePddTab, validatePddMetadata,
} from '../lib/pdd/targets.mjs';
import { playwrightStatus, answerAddressProbe, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';
import { element } from '../test-support/search-price-fixture.mjs';

const GOODS = '600123456789';
const ITEM = `https://mobile.pinduoduo.com/goods.html?goods_id=${GOODS}`;
// The shape a search card click produced live on 2026-10-27, with synthetic values.
const TRACKED = `${ITEM}&_oak_rcto=PRIVATE&_oak_gallery=x&_x_query=mouse&refer_page_name=search_result&refer_page_id=1&refer_page_sn=2&uin=PRIVATE`;

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pdd '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A bridge whose new tabs land on `landing(url)`, listed until closed. */
async function tabBridge(t, { landing = url => url } = {}) {
  let next = 90;
  return mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    state.tabs = state.open ??= [];
    if (req.url === '/status') return send(playwrightStatus());
    if (isAddressProbe(body)) return answerAddressProbe(body, state, send);
    if (body.action === 'tab_new') {
      const tab = { id: next++, url: landing(body.url) };
      state.open.push(tab);
      return send({ id: body.id, success: true, data: { tabId: tab.id, url: tab.url } });
    }
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: state.open } });
    if (body.action === 'tab_close') {
      state.open.splice(state.open.findIndex(tab => tab.id === body.tabId), 1);
      return send({ id: body.id, success: true, data: {} });
    }
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

test('PDD addresses parse to canonical identities without tracking, and other hosts or shapes are rejected', () => {
  assert.deepEqual(parsePddProductUrl(TRACKED),
    { platform: 'pdd', origin: 'https://mobile.pinduoduo.com', pathname: '/goods.html', product_id: GOODS, url: ITEM });
  for (const value of [`http://mobile.pinduoduo.com/goods.html?goods_id=${GOODS}`, `https://mobile.yangkeduo.com/goods.html?goods_id=${GOODS}`,
    'https://mobile.pinduoduo.com/goods.html?goods_id=abc', `https://mobile.pinduoduo.com/goods.html?goods_id=${GOODS}&goods_id=1`,
    'https://mobile.pinduoduo.com/goods.html', `https://mobile.pinduoduo.com/goods2.html?goods_id=${GOODS}`,
    `https://user:x@mobile.pinduoduo.com/goods.html?goods_id=${GOODS}`, `https://mobile.pinduoduo.com:8443/goods.html?goods_id=${GOODS}`, null]) {
    assert.equal(parsePddProductUrl(value), null, String(value));
  }
  assert.deepEqual(parsePddReviewsUrl(`https://mobile.pinduoduo.com/goods_comments.html?goods_id=${GOODS}&uin=PRIVATE`),
    { platform: 'pdd', product_id: GOODS, url: `https://mobile.pinduoduo.com/goods_comments.html?goods_id=${GOODS}` });
  const target = pddSearchTarget('  罗技 M330 ');
  assert.equal(target.url, `https://mobile.pinduoduo.com/search_result.html?search_key=${encodeURIComponent('罗技 M330')}`);
  assert.equal(parsePddSearchUrl(`${target.url}&sort_type=_sales&refer_page_name=index`).query, '罗技 M330');
  assert.equal(parsePddSearchUrl('https://mobile.pinduoduo.com/search_result.html?search_key=a&search_key=b'), null);
  assert.equal(parsePddSearchUrl('https://mobile.pinduoduo.com/search_result.html'), null);
  assert.throws(() => pddSearchTarget(' '), { code: 'INVALID_SEARCH' });
  assert.equal(parsePddOrderListUrl('https://mobile.pinduoduo.com/orders.html?type=1&refer_page_name=personal').url, 'https://mobile.pinduoduo.com/orders.html');
  assert.equal(parsePddOrderListUrl('https://mobile.pinduoduo.com/order.html?order_sn=PRIVATE'), null);
  assert.deepEqual(parsePddOrderDetailUrl('https://mobile.pinduoduo.com/order.html?order_sn=261027-123456789&page_from=1&main_orders=1'),
    { platform: 'pdd', order_id: '261027-123456789' });
  for (const url of ['https://mobile.pinduoduo.com/order.html', 'https://mobile.pinduoduo.com/order.html?order_sn=a&order_sn=b',
    'https://mobile.pinduoduo.com/order.html?order_sn=<script>', 'https://mobile.pinduoduo.com/orders.html?order_sn=261027-123456789']) {
    assert.equal(parsePddOrderDetailUrl(url), null, url);
  }
  assert.equal(pddLandingKind('https://mobile.pinduoduo.com/login.html?from=PRIVATE'), 'login_page');
  assert.equal(pddLandingKind('https://mobile.pinduoduo.com/psnl_verification.html?x=PRIVATE'), 'risk_page');
  assert.equal(pddLandingKind('https://mobile.pinduoduo.com/index.html'), 'other_page');
  assert.equal(pddLandingKind('https://passport.jd.com/new/login.aspx'), 'other_page');
  assert.equal(parsePlatform('pdd'), 'pdd');
  assert.equal(path.basename(pacingFile('/state', 'pdd')), 'pacing-pdd.json');
});

test('PDD starts with lower load quotas than Taobao and JD, with the same spacing', () => {
  assert.deepEqual(pacingPolicy('pdd').limits, { search: { per_10_minutes: 3, per_hour: 10 }, page: { per_10_minutes: 6, per_hour: 24 } });
  assert.equal(pacingPolicy('pdd'), PDD_PACING_POLICY);
  assert.equal(pacingPolicy('jd'), PACING_POLICY);
  assert.equal(pacingPolicy('taobao'), PACING_POLICY);
  assert.deepEqual(PDD_PACING_POLICY.gap_ms, PACING_POLICY.gap_ms);
});

test('PDD tab summaries name the page kind and never return order-detail, login or tracking values', () => {
  const summaries = [
    { id: 1, url: TRACKED }, { id: 2, url: 'https://mobile.pinduoduo.com/search_result.html?search_key=mouse' },
    { id: 3, url: `https://mobile.pinduoduo.com/goods_comments.html?goods_id=${GOODS}&uin=PRIVATE` },
    { id: 4, url: 'https://mobile.pinduoduo.com/orders.html?refer_page_name=PRIVATE' },
    { id: 5, url: 'https://mobile.pinduoduo.com/order.html?order_sn=PRIVATE-ORDER-1&page_from=1' },
    { id: 6, url: 'https://mobile.pinduoduo.com/login.html?from=PRIVATE' }, { id: 7, url: 'https://mobile.pinduoduo.com/psnl_verification.html?x=PRIVATE' },
    { id: 8, url: 'https://mobile.pinduoduo.com/index.html?refer_page_sn=PRIVATE' }, { id: 9, url: 'https://mobile.pinduoduo.com/personal.html' },
    { id: 10, url: 'https://item.jd.com/1.html' }, { id: 11, url: 'https://notpinduoduo.com/' },
  ].map(summarizePddTab);
  assert.deepEqual(summaries.map(item => item?.kind ?? null),
    ['product', 'search', 'reviews', 'orders_list', 'order_detail', 'login_page', 'risk_page', 'home', 'other', null, null]);
  assert.deepEqual([summaries[0].url, summaries[0].product_id], [ITEM, GOODS]);
  assert.equal(summaries[2].product_id, GOODS);
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE/);
});

test('recorded PDD pages still match after tracking or moving to the same product reviews, but not another product, query or platform', () => {
  assert.equal(pageStillMatches({ platform: 'pdd', kind: 'product', key: GOODS }, TRACKED), true);
  assert.equal(pageStillMatches({ platform: 'pdd', kind: 'product', key: GOODS }, `https://mobile.pinduoduo.com/goods_comments.html?goods_id=${GOODS}`), true);
  assert.equal(pageStillMatches({ platform: 'pdd', kind: 'product', key: GOODS }, 'https://mobile.pinduoduo.com/goods.html?goods_id=1'), false);
  assert.equal(pageStillMatches({ platform: 'pdd', kind: 'search', key: 'mouse' }, 'https://mobile.pinduoduo.com/search_result.html?search_key=mouse&sort_type=_sales'), true);
  assert.equal(pageStillMatches({ platform: 'pdd', kind: 'search', key: 'mouse' }, 'https://search.jd.com/Search?keyword=mouse'), false);
  assert.equal(pageStillMatches({ platform: 'pdd', kind: 'orders', key: null }, 'https://mobile.pinduoduo.com/order.html?order_sn=1234567'), false);
  assert.equal(pageStillMatches({ platform: 'pdd', kind: 'orders', key: null }, 'https://mobile.pinduoduo.com/login.html'), false);
  assert.equal(pageStillMatches({ kind: 'product', key: GOODS }, ITEM), false, 'no platform means Taobao');
});

function gateOf(url, nodes = [], title = '拼多多') {
  const body = element('body', {}, nodes);
  return vm.runInNewContext(`(${pddPageGate})()`, { URL, location: { href: url },
    document: { title, body, querySelectorAll: selector => body.querySelectorAll(selector) },
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible' }) });
}

test('the PDD page gate returns only a code for login, verification and limit pages, and null for a normal page with the app panel', () => {
  assert.equal(gateOf(ITEM, [element('div', { text: 'PRIVATE goods title' }), element('div', { cls: 'pdd-go-to-app-pc', text: '用手机浏览器扫码在拼多多App打开' })]), null);
  assert.equal(gateOf('https://mobile.pinduoduo.com/login.html?from=x'), 'login_required');
  assert.equal(gateOf('https://mobile.pinduoduo.com/psnl_verification.html'), 'verification_required');
  assert.equal(gateOf(ITEM, [element('div', { text: '请完成安全验证' })]), 'verification_required');
  assert.equal(gateOf('https://mobile.pinduoduo.com/search_result.html?search_key=a', [element('div', { text: '操作过于频繁，请稍后再试' })]), 'rate_limited');
  assert.equal(gateOf(ITEM, [element('iframe', { attrs: { src: 'https://mobile.pinduoduo.com/login.html?x=1' } })]), 'login_required');
  assert.doesNotMatch(pddPageGate.toString(), /\.click\(|scroll|fetch\(|XMLHttpRequest|cookie|Storage/);
});

test('the PDD metadata check reads only location and title, and rejects another goods page or a login redirect', () => {
  const target = parsePddProductUrl(ITEM);
  const evaluate = href => vm.runInNewContext(pddMetadataScript(target), { URL, location: { href }, document: { title: '拼多多' } });
  assert.deepEqual(validatePddMetadata(evaluate(TRACKED), target), { product_id: GOODS, url: ITEM, title: '拼多多', page_state: 'not_assessed' });
  assert.throws(() => validatePddMetadata(evaluate('https://mobile.pinduoduo.com/goods.html?goods_id=1'), target), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validatePddMetadata(evaluate(`https://mobile.pinduoduo.com/goods_comments.html?goods_id=${GOODS}`), target), { code: 'TARGET_CHANGED' });
  assert.throws(() => validatePddMetadata(evaluate('https://mobile.pinduoduo.com/login.html'), target), { code: 'LOGIN_REQUIRED' });
  assert.throws(() => validatePddMetadata(evaluate('https://mobile.pinduoduo.com/psnl_verification.html'), target), { code: 'RATE_LIMITED' });
  assert.throws(() => pddMetadataScript({ url: 'https://item.jd.com/1.html' }), { code: 'INVALID_TARGET' });
});

test('page-open --platform pdd uses its own ledger and lower quota, records the page, and page-close checks the PDD address', async t => {
  const server = await tabBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  // A used-up JD search quota must not hold PDD.
  const now = Date.now();
  await writeFile(path.join(directory, 'pacing-jd.json'), JSON.stringify({ schema_version: 1, last_interaction_at: 0, last_load_at: 0,
    gap: null, load_gap: null, loads: [5, 4, 3, 2, 1].map(minutes => ({ at: now - minutes * 60_000, category: 'search' })) }));
  const opened = await run(['page-open', '--platform', 'pdd', '--search', 'Synthetic mouse', ...common]);
  assert.equal(opened.code, 0);
  assert.deepEqual([opened.value.platform, opened.value.kind, opened.value.url_matches, opened.value.landing], ['pdd', 'search', true, 'requested']);
  assert.equal(server.state.commands.find(command => command.action === 'tab_new').url, pddSearchTarget('Synthetic mouse').url);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8')).loads.map(load => load.category), ['search']);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'pacing-jd.json'), 'utf8')).loads.length, 5, 'the JD ledger is untouched');
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false, 'the Taobao ledger is untouched');
  const pages = JSON.parse(await readFile(path.join(directory, 'opened-pages.json'), 'utf8')).pages;
  assert.deepEqual(pages.map(page => [page.platform, page.kind, page.key]), [['pdd', 'search', 'Synthetic mouse']]);

  server.state.open.find(tab => tab.id === opened.value.tab_id).url = 'https://mobile.pinduoduo.com/search_result.html?search_key=other';
  assert.equal((await run(['page-close', '--tab', String(opened.value.tab_id), ...common])).value.error.code, 'TAB_ADDRESS_CHANGED');
  server.state.open.find(tab => tab.id === opened.value.tab_id).url = 'https://mobile.pinduoduo.com/search_result.html?search_key=Synthetic%20mouse&sort_type=_sales';
  const closed = await run(['page-close', '--tab', String(opened.value.tab_id), ...common]);
  assert.deepEqual([closed.value.status, closed.value.platform, closed.value.kind], ['page_closed', 'pdd', 'search']);

  // PDD's third search within ten minutes is the last one its lower quota allows; the fourth is refused before any command.
  await writeFile(path.join(directory, 'pacing-pdd.json'), JSON.stringify({ schema_version: 1, last_interaction_at: 0, last_load_at: 0,
    gap: null, load_gap: null, loads: [3, 2, 1].map(minutes => ({ at: Date.now() - minutes * 60_000, category: 'search' })) }));
  const before = server.state.commands.filter(command => command.action === 'tab_new').length;
  const held = await run(['page-open', '--platform', 'pdd', '--search', 'Synthetic mouse', ...common]);
  assert.equal(held.value.error.code, 'PACING_LIMIT');
  assert.equal(server.state.commands.filter(command => command.action === 'tab_new').length, before);
});

test('a PDD verification landing is recorded with the preceding load counts; a login landing asks the user to log in to PDD', async t => {
  const server = await tabBridge(t, { landing: url => url.includes('search_result.html') ? 'https://mobile.pinduoduo.com/psnl_verification.html?from=PRIVATE'
    : 'https://mobile.pinduoduo.com/login.html?from=PRIVATE' });
  const directory = await stateDirectory(t);
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  const risk = await run(['page-open', '--platform', 'pdd', '--search', 'Synthetic mouse', ...common]);
  assert.deepEqual([risk.code, risk.value.url_matches, risk.value.landing], [0, false, 'risk_page']);
  assert.match(risk.value.next_action, /Stop all PDD work now/);
  const log = await readThrottleObservations(directory);
  assert.deepEqual(log.observations.map(item => [item.platform, item.signal, item.page_kind, item.loads.search.last_10_minutes]), [['pdd', 'risk_page', 'search', 1]]);
  assert.doesNotMatch(JSON.stringify(risk.value), /PRIVATE/);

  const login = await run(['page-open', '--platform', 'pdd', '--orders', ...common]);
  assert.deepEqual([login.value.kind, login.value.landing], ['orders', 'login_page']);
  assert.match(login.value.next_action, /log in to PDD/);
  assert.equal(server.state.commands.filter(command => command.action === 'tab_new').at(-1).url, 'https://mobile.pinduoduo.com/orders.html');
});

test('PDD options are checked before any browser command: no cart, no product links (products open from a search card), and a refused open keeps no quota', async t => {
  const server = await tabBridge(t);
  for (const [args, code] of [[['--platform', 'pdd', '--cart'], 'UNSUPPORTED_PLATFORM'], [['--platform', 'pdd', '--url', TRACKED], 'UNSUPPORTED_PLATFORM'],
    [['--platform', 'pdd', '--search', ' '], 'INVALID_SEARCH']]) {
    const directory = await stateDirectory(t);
    assert.equal((await run(['page-open', ...args, '--endpoint', server.endpoint, '--state-dir', directory])).value.error.code, code);
    const ledger = await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8').catch(() => null);
    assert.ok(ledger === null || JSON.parse(ledger).loads.length === 0);
  }
  assert.equal(server.state.commands.some(command => command.action === 'tab_new'), false);
});

test('tabs --platform pdd lists only PDD tabs; bind and probe a PDD product on the PDD ledger; PDD tasks are refused for now', async t => {
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 41, url: 'https://item.jd.com/123.html' }, { id: 51, url: TRACKED },
    { id: 52, url: 'https://mobile.pinduoduo.com/order.html?order_sn=PRIVATE-1' }];
  state.metadata = { state: 'observed', origin: 'https://mobile.pinduoduo.com', pathname: '/goods.html', product_id: GOODS, title: '拼多多' };
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  const listed = await run(['tabs', '--platform', 'pdd', ...common]);
  assert.deepEqual(listed.value.tabs.map(tab => [tab.tab_id, tab.kind]), [[51, 'product'], [52, 'order_detail']]);
  assert.doesNotMatch(JSON.stringify(listed.value), /PRIVATE/);
  assert.equal((await run(['bind', '--platform', 'jd', ...common, '--tab', '51'])).value.error.code, 'UNSUPPORTED_TARGET', 'JD bind refuses a PDD tab');
  const bound = await run(['bind', '--platform', 'pdd', ...common, '--tab', '51', '--binding', 'pdd-item']);
  assert.deepEqual([bound.code, bound.value.platform, bound.value.target], [0, 'pdd', ITEM]);
  assert.equal((await loadBinding(directory, 'pdd-item')).platform, 'pdd');
  assert.ok(existsSync(path.join(directory, 'pacing-pdd.json')));
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false);
  assert.equal((await run(['task-start', '--platform', 'pdd', ...common, '--task', 'pdd-details', '--bindings', 'pdd-item', '--details'])).value.error.code, 'UNSUPPORTED_PLATFORM');
  assert.equal((await run(['task-start', ...common, '--task', 'tb-details', '--bindings', 'pdd-item', '--details'])).value.error.code, 'UNSUPPORTED_PLATFORM');

  const probed = await run(['probe', ...common, '--binding', 'pdd-item']);
  assert.deepEqual([probed.code, probed.value.platform, probed.value.metadata.product_id], [0, 'pdd', GOODS]);
  state.tabs[1].url = 'https://mobile.pinduoduo.com/goods.html?goods_id=1';
  assert.equal((await run(['probe', ...common, '--binding', 'pdd-item'])).value.error.code, 'TARGET_CHANGED');
});

test('a PDD tab that turned into a verification page is refused by bind and probe, and the limit is recorded on PDD', async t => {
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 51, url: 'https://mobile.pinduoduo.com/psnl_verification.html?from=PRIVATE' }, { id: 52, url: ITEM }];
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  assert.equal((await run(['bind', '--platform', 'pdd', ...common, '--tab', '51', '--binding', 'pdd-risk'])).value.error.code, 'RATE_LIMITED');
  state.metadata = { state: 'rate_limited' };
  assert.equal((await run(['bind', '--platform', 'pdd', ...common, '--tab', '52', '--binding', 'pdd-risk'])).value.error.code, 'RATE_LIMITED');
  await saveBinding(directory, 'pdd-item', { schema_version: 1, platform: 'pdd', endpoint, tab_id: 52, target: parsePddProductUrl(ITEM), created_at: new Date().toISOString() });
  assert.equal((await run(['probe', ...common, '--binding', 'pdd-item'])).value.error.code, 'RATE_LIMITED');
  const log = await readThrottleObservations(directory);
  assert.deepEqual(log.observations.map(item => [item.platform, item.signal]), [['pdd', 'rate_limited'], ['pdd', 'rate_limited'], ['pdd', 'rate_limited']]);
  assert.equal(existsSync(path.join(directory, 'pacing-jd.json')), false);
});
