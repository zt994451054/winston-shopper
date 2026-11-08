import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { Pacer } from '../lib/pacing.mjs';
import { pacingFile, parsePlatform } from '../lib/platforms.mjs';
import { pageStillMatches } from '../lib/opened-pages.mjs';
import { readThrottleObservations, recordThrottleObservation } from '../lib/throttle-log.mjs';
import { saveBinding, loadBinding } from '../lib/state.mjs';
import { jdPageGate } from '../lib/jd/page-gate.mjs';
import {
  jdLandingKind, jdMetadataScript, jdSearchTarget, parseJdCartUrl, parseJdOrderDetailUrl, parseJdOrderListUrl, parseJdProductUrl, parseJdSearchUrl,
  summarizeJdTab, validateJdMetadata,
} from '../lib/jd/targets.mjs';
import { playwrightStatus, answerAddressProbe, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';
import { element } from '../test-support/search-price-fixture.mjs';

const SKU = '100012345678';
const ITEM = `https://item.jd.com/${SKU}.html`;

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A bridge whose new tabs land on `landing(url)`, listed until closed. */
async function tabBridge(t, { landing = url => url, tabs = [] } = {}) {
  let next = 90;
  return mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    state.tabs = state.open ??= [...tabs];
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
    if (body.action === 'eval') return send({ id: body.id, success: true, data: { result: state.metadata } });
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

test('JD addresses parse to canonical identities without tracking, and other hosts or shapes are rejected', () => {
  assert.deepEqual(parseJdProductUrl(`${ITEM}?spm=tracking#comment`),
    { platform: 'jd', origin: 'https://item.jd.com', pathname: `/${SKU}.html`, product_id: SKU, url: ITEM });
  for (const value of [`http://item.jd.com/${SKU}.html`, `https://item.jd.hk/${SKU}.html`, 'https://item.jd.com/abc.html',
    `https://item.jd.com/${SKU}.htm`, `https://user:x@item.jd.com/${SKU}.html`, `https://item.jd.com:8443/${SKU}.html`, null]) {
    assert.equal(parseJdProductUrl(value), null, String(value));
  }
  const target = jdSearchTarget('  罗技 M330 ');
  assert.equal(target.url, `https://search.jd.com/Search?keyword=${encodeURIComponent('罗技 M330')}&enc=utf-8`);
  assert.equal(parseJdSearchUrl(`${target.url}&pvid=abc&page=3&s=56`).query, '罗技 M330');
  assert.equal(parseJdSearchUrl('https://search.jd.com/Search?keyword=a&keyword=b'), null);
  assert.equal(parseJdSearchUrl('https://search.jd.com/Search?enc=utf-8'), null);
  assert.throws(() => jdSearchTarget(' '), { code: 'INVALID_SEARCH' });
  assert.equal(parseJdCartUrl('https://cart.jd.com/cart_index?r=1').url, 'https://cart.jd.com/cart_index');
  assert.equal(parseJdCartUrl('https://cart.jd.com/cart.action').url, 'https://cart.jd.com/cart_index');
  assert.equal(parseJdCartUrl('https://cart.jd.com/addToCart.html?rcd=1&pid=1'), null);
  assert.equal(parseJdOrderListUrl('https://order.jd.com/center/list.action?d=2&s=4096&page=2').url, 'https://order.jd.com/center/list.action');
  assert.equal(parseJdOrderListUrl('https://details.jd.com/normal/item.action?orderid=PRIVATE'), null);
  assert.deepEqual(parseJdOrderDetailUrl('https://details.jd.com/normal/item.action?orderid=351244735000&PassKey=SECRET'),
    { platform: 'jd', order_id: '351244735000' });
  assert.equal(JSON.stringify(parseJdOrderDetailUrl('https://details.jd.com/normal/item.action?orderid=351244735000&PassKey=SECRET')).includes('SECRET'), false);
  for (const url of ['https://details.jd.com/normal/item.action?orderid=PRIVATE', 'https://details.jd.com/normal/item.action',
    'https://details.jd.com/normal/item.action?orderid=351244735000&orderid=351244735001', 'https://details.jd.com/other.action?orderid=351244735000',
    'https://order.jd.com/center/list.action?orderid=351244735000']) {
    assert.equal(parseJdOrderDetailUrl(url), null, url);
  }
  assert.equal(jdLandingKind('https://passport.jd.com/new/login.aspx?ReturnUrl=x'), 'login_page');
  assert.equal(jdLandingKind('https://pc-frequent-pro.pf.jd.com/?from=x'), 'risk_page');
  assert.equal(jdLandingKind('https://cfe.m.jd.com/privatedomain/risk_handler/03101900/?returnurl=x'), 'risk_page');
  assert.equal(jdLandingKind('https://www.jd.com/'), 'other_page');
  assert.equal(parsePlatform(undefined), 'taobao');
  assert.throws(() => parsePlatform('tmall'), { code: 'UNSUPPORTED_PLATFORM' });
  assert.equal(path.basename(pacingFile('/state', 'taobao')), 'pacing.json');
  assert.equal(path.basename(pacingFile('/state', 'jd')), 'pacing-jd.json');
});

test('JD tab summaries name the page kind and never return order-detail, login or risk addresses', () => {
  const summaries = [
    { id: 1, url: `${ITEM}?spm=x` }, { id: 2, url: 'https://search.jd.com/Search?keyword=mouse&enc=utf-8' },
    { id: 3, url: 'https://cart.jd.com/cart_index' }, { id: 4, url: 'https://order.jd.com/center/list.action?s=1' },
    { id: 5, url: 'https://details.jd.com/normal/item.action?orderid=PRIVATE_ORDER&PassKey=PRIVATE_KEY' },
    { id: 6, url: 'https://passport.jd.com/new/login.aspx?ReturnUrl=PRIVATE' }, { id: 7, url: 'https://pc-frequent-pro.pf.jd.com/?x=PRIVATE' },
    { id: 8, url: 'https://www.jd.com/' }, { id: 9, url: 'https://item.taobao.com/item.htm?id=5' }, { id: 10, url: 'https://notjd.com/' },
  ].map(summarizeJdTab);
  assert.deepEqual(summaries.map(item => item?.kind ?? null),
    ['product', 'search', 'cart', 'orders_list', 'other', 'login_page', 'risk_page', 'home', null, null]);
  assert.equal(summaries[0].url, ITEM); assert.equal(summaries[0].product_id, SKU);
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE/);
});

test('recorded JD pages still match after paging or tracking, but not on another product, query or Taobao', () => {
  assert.equal(pageStillMatches({ platform: 'jd', kind: 'product', key: SKU }, `${ITEM}?spm=x`), true);
  assert.equal(pageStillMatches({ platform: 'jd', kind: 'product', key: SKU }, 'https://item.jd.com/100012345679.html'), false);
  assert.equal(pageStillMatches({ platform: 'jd', kind: 'search', key: 'mouse' }, 'https://search.jd.com/Search?keyword=mouse&page=3'), true);
  assert.equal(pageStillMatches({ platform: 'jd', kind: 'search', key: 'mouse' }, 'https://s.taobao.com/search?q=mouse&page=1&tab=all'), false);
  assert.equal(pageStillMatches({ platform: 'jd', kind: 'orders', key: null }, 'https://passport.jd.com/new/login.aspx'), false);
  assert.equal(pageStillMatches({ platform: 'jd', kind: 'cart', key: null }, 'https://cart.jd.com/cart_index'), true);
  assert.equal(pageStillMatches({ kind: 'search', key: 'mouse' }, 'https://search.jd.com/Search?keyword=mouse'), false, 'no platform means Taobao');
});

function gateOf(url, nodes = [], title = 'JD page') {
  const body = element('body', {}, nodes);
  return vm.runInNewContext(`(${jdPageGate})()`, { URL, location: { href: url },
    document: { title, body, querySelectorAll: selector => body.querySelectorAll(selector) },
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible' }) });
}

test('the JD page gate returns only a code for login, risk, slider and limit pages, and null for a normal page', () => {
  assert.equal(gateOf(ITEM, [element('div', { cls: 'sku-name', text: 'PRIVATE product title' })]), null);
  assert.equal(gateOf('https://passport.jd.com/new/login.aspx'), 'login_required');
  assert.equal(gateOf('https://pc-frequent-pro.pf.jd.com/'), 'rate_limited');
  assert.equal(gateOf(ITEM, [element('div', { cls: 'JDJRV-wrap' })]), 'verification_required');
  assert.equal(gateOf(ITEM, [element('div', { cls: 'JDJRV-wrap', hidden: true })]), null, 'a hidden slider does not stop');
  assert.equal(gateOf('https://www.jd.com/', [element('div', { text: '内容太火爆了' })]), 'rate_limited');
  assert.equal(gateOf('https://search.jd.com/Search?keyword=a', [element('div', { text: '访问频繁导致无法搜索' })]), 'rate_limited');
  assert.equal(gateOf(ITEM, [element('div', { text: '请完成安全验证' })]), 'verification_required');
  assert.equal(gateOf(ITEM, [element('iframe', { attrs: { src: 'https://passport.jd.com/uc/popupLogin2013' } })]), 'login_required');
  assert.doesNotMatch(jdPageGate.toString(), /\.click\(|scroll|fetch\(|XMLHttpRequest|cookie|Storage/);
});

test('the JD metadata check reads only location and title, and rejects another page or a login redirect', () => {
  const target = parseJdProductUrl(ITEM);
  const evaluate = href => vm.runInNewContext(jdMetadataScript(target), { URL, location: { href }, document: { title: 'Synthetic JD item' } });
  assert.deepEqual(validateJdMetadata(evaluate(`${ITEM}?spm=x`), target),
    { product_id: SKU, url: ITEM, title: 'Synthetic JD item', page_state: 'not_assessed' });
  assert.throws(() => validateJdMetadata(evaluate('https://item.jd.com/1.html'), target), { code: 'TARGET_CHANGED' });
  assert.throws(() => validateJdMetadata(evaluate('https://passport.jd.com/new/login.aspx'), target), { code: 'LOGIN_REQUIRED' });
  assert.throws(() => validateJdMetadata(evaluate('https://pc-frequent-pro.pf.jd.com/?returnurl=x'), target), { code: 'RATE_LIMITED' });
  assert.throws(() => validateJdMetadata(evaluate('https://cfe.m.jd.com/privatedomain/risk_handler/03101900/?returnurl=x'), target), { code: 'RATE_LIMITED' });
  assert.throws(() => jdMetadataScript({ url: 'https://item.taobao.com/item.htm?id=5' }), { code: 'INVALID_TARGET' });
});

test('page-open --platform jd uses its own pacing ledger, records the page with its platform, and page-close checks the JD address', async t => {
  const server = await tabBridge(t);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  // A used-up Taobao search quota must not hold JD.
  const now = Date.now();
  await writeFile(path.join(directory, 'pacing.json'), JSON.stringify({ schema_version: 1, last_interaction_at: 0, last_load_at: 0,
    gap: null, load_gap: null, loads: [5, 4, 3, 2, 1].map(minutes => ({ at: now - minutes * 60_000, category: 'search' })) }));
  const opened = await run(['page-open', '--platform', 'jd', '--search', 'Synthetic mouse', ...common]);
  assert.equal(opened.code, 0);
  assert.deepEqual([opened.value.platform, opened.value.kind, opened.value.url_matches, opened.value.landing], ['jd', 'search', true, 'requested']);
  assert.equal(server.state.commands.find(command => command.action === 'tab_new').url, jdSearchTarget('Synthetic mouse').url);
  const jdLedger = JSON.parse(await readFile(path.join(directory, 'pacing-jd.json'), 'utf8'));
  assert.deepEqual(jdLedger.loads.map(load => load.category), ['search']);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'pacing.json'), 'utf8')).loads.length, 5, 'the Taobao ledger is untouched');
  const pages = JSON.parse(await readFile(path.join(directory, 'opened-pages.json'), 'utf8')).pages;
  assert.deepEqual(pages.map(page => [page.platform, page.kind, page.key]), [['jd', 'search', 'Synthetic mouse']]);
  assert.equal(existsSync(path.join(directory, 'throttle-observations.json')), false);

  server.state.open.find(tab => tab.id === opened.value.tab_id).url = 'https://search.jd.com/Search?keyword=other';
  assert.equal((await run(['page-close', '--tab', String(opened.value.tab_id), ...common])).value.error.code, 'TAB_ADDRESS_CHANGED');
  server.state.open.find(tab => tab.id === opened.value.tab_id).url = 'https://search.jd.com/Search?keyword=Synthetic%20mouse&page=3';
  const closed = await run(['page-close', '--tab', String(opened.value.tab_id), ...common]);
  assert.deepEqual([closed.value.status, closed.value.platform, closed.value.kind], ['page_closed', 'jd', 'search']);
});

test('a JD risk page landing is reported with the load counts that preceded it; a login landing only asks for login', async t => {
  const server = await tabBridge(t, { landing: url => url.includes('item.jd.com') ? 'https://pc-frequent-pro.pf.jd.com/?returnUrl=PRIVATE'
    : 'https://passport.jd.com/new/login.aspx?ReturnUrl=PRIVATE' });
  const directory = await stateDirectory(t);
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  const risk = await run(['page-open', '--platform', 'jd', '--url', `${ITEM}?spm=x`, ...common]);
  assert.deepEqual([risk.code, risk.value.url_matches, risk.value.landing], [0, false, 'risk_page']);
  assert.match(risk.value.next_action, /Stop all JD work now/);
  assert.equal(server.state.commands.find(command => command.action === 'tab_new').url, ITEM);
  const log = await readThrottleObservations(directory);
  assert.equal(log.observations.length, 1);
  assert.deepEqual({ ...log.observations[0], observed_at: null }, { platform: 'jd', observed_at: null, signal: 'risk_page', page_kind: 'product',
    loads: { search: { last_10_minutes: 0, last_hour: 0 }, page: { last_10_minutes: 1, last_hour: 1 } } });
  assert.doesNotMatch(JSON.stringify(risk.value), /PRIVATE/);

  const loginDirectory = await stateDirectory(t);
  const login = await run(['page-open', '--platform', 'jd', '--orders', '--endpoint', server.endpoint, '--state-dir', loginDirectory]);
  assert.deepEqual([login.value.kind, login.value.landing], ['orders', 'login_page']);
  assert.match(login.value.next_action, /log in to JD/);
  assert.equal(existsSync(path.join(loginDirectory, 'throttle-observations.json')), false);
});

test('JD options are checked before any browser command, and a refused open keeps no quota', async t => {
  const server = await tabBridge(t);
  for (const [args, code] of [[['--platform', 'pdd', '--cart'], 'UNSUPPORTED_PLATFORM'],
    [['--platform', 'jd', '--url', 'https://item.taobao.com/item.htm?id=5'], 'INVALID_ARGUMENTS'], [['--platform', 'jd', '--search', ' '], 'INVALID_SEARCH']]) {
    const directory = await stateDirectory(t);
    assert.equal((await run(['page-open', ...args, '--endpoint', server.endpoint, '--state-dir', directory])).value.error.code, code);
    const ledger = await readFile(path.join(directory, 'pacing-jd.json'), 'utf8').catch(() => null);
    assert.ok(ledger === null || JSON.parse(ledger).loads.length === 0);
  }
  assert.equal(server.state.commands.some(command => command.action === 'tab_new'), false);
});

test('tabs --platform jd lists only JD tabs; bind and probe a JD product on the JD ledger; JD bindings cannot start Taobao tasks', async t => {
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 41, url: 'https://detail.tmall.com/item.htm?id=123' }, { id: 51, url: `${ITEM}?spm=PRIVATE` },
    { id: 52, url: 'https://details.jd.com/normal/item.action?orderid=PRIVATE' }];
  state.metadata = { state: 'observed', origin: 'https://item.jd.com', pathname: `/${SKU}.html`, product_id: SKU, title: 'Synthetic JD item' };
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  const listed = await run(['tabs', '--platform', 'jd', ...common]);
  assert.deepEqual(listed.value.tabs.map(tab => [tab.tab_id, tab.kind]), [[51, 'product'], [52, 'other']]);
  assert.equal(listed.value.platform, 'jd');
  assert.doesNotMatch(JSON.stringify(listed.value), /PRIVATE/);
  assert.equal((await run(['bind', ...common, '--tab', '51'])).value.error.code, 'UNSUPPORTED_TARGET', 'Taobao bind refuses a JD tab');
  const bound = await run(['bind', '--platform', 'jd', ...common, '--tab', '51', '--binding', 'jd-item']);
  assert.deepEqual([bound.code, bound.value.platform, bound.value.target], [0, 'jd', ITEM]);
  assert.equal((await loadBinding(directory, 'jd-item')).platform, 'jd');
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false, 'JD reads use the JD ledger');
  assert.ok(existsSync(path.join(directory, 'pacing-jd.json')));
  const refused = await run(['task-start', ...common, '--task', 'jd-details', '--bindings', 'jd-item', '--details']);
  assert.equal(refused.value.error.code, 'UNSUPPORTED_PLATFORM');

  const probeDirectory = await stateDirectory(t);
  await saveBinding(probeDirectory, 'jd-item', { schema_version: 1, platform: 'jd', endpoint, tab_id: 51, target: parseJdProductUrl(ITEM), created_at: new Date().toISOString() });
  const probed = await run(['probe', '--endpoint', endpoint, '--state-dir', probeDirectory, '--binding', 'jd-item']);
  assert.deepEqual([probed.code, probed.value.platform, probed.value.metadata.product_id], [0, 'jd', SKU]);
  assert.equal(existsSync(path.join(probeDirectory, 'pacing.json')), false);
  state.tabs[1].url = 'https://item.jd.com/1.html';
  assert.equal((await run(['probe', '--endpoint', endpoint, '--state-dir', probeDirectory, '--binding', 'jd-item'])).value.error.code, 'TARGET_CHANGED');
  assert.equal(existsSync(path.join(probeDirectory, 'throttle-observations.json')), false);
});

test('a JD tab that turned into the risk page is refused by bind and probe, and the limit is recorded', async t => {
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 51, url: 'https://pc-frequent-pro.pf.jd.com/?returnurl=PRIVATE' }, { id: 52, url: ITEM }];
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  // Seen live on 2026-10-15: page-open reported the product page, and the tab moved to the risk page before bind.
  const listed = await run(['bind', '--platform', 'jd', ...common, '--tab', '51', '--binding', 'jd-risk']);
  assert.equal(listed.value.error.code, 'RATE_LIMITED');
  assert.doesNotMatch(JSON.stringify(listed.value), /PRIVATE/);
  // The limit locks JD: nothing more is sent until the user says it is handled (user, 2026-11-08).
  const requests = state.requests.length;
  const locked = await run(['bind', '--platform', 'jd', ...common, '--tab', '52', '--binding', 'jd-risk']);
  assert.deepEqual([locked.value.error.code, state.requests.length], ['PLATFORM_LOCKED', requests]);
  assert.match(locked.value.error.next_action, /tell the user/);
  assert.equal((await run(['platform-unlock', '--platform', 'jd', '--state-dir', directory])).value.unlocked, true);
  state.metadata = { state: 'rate_limited' };
  assert.equal((await run(['bind', '--platform', 'jd', ...common, '--tab', '52', '--binding', 'jd-risk'])).value.error.code, 'RATE_LIMITED');
  await run(['platform-unlock', '--platform', 'jd', '--state-dir', directory]);
  await saveBinding(directory, 'jd-item', { schema_version: 1, platform: 'jd', endpoint, tab_id: 52, target: parseJdProductUrl(ITEM), created_at: new Date().toISOString() });
  assert.equal((await run(['probe', ...common, '--binding', 'jd-item'])).value.error.code, 'RATE_LIMITED');
  assert.equal(existsSync(path.join(directory, 'jd-risk.json')), false);
  const log = await readThrottleObservations(directory);
  assert.deepEqual(log.observations.map(item => [item.platform, item.signal, item.page_kind]),
    [['jd', 'rate_limited', 'product'], ['jd', 'rate_limited', 'product'], ['jd', 'rate_limited', 'product']]);
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false);
});

test('recent load counts and the limit record are bounded and validated', async t => {
  const directory = await stateDirectory(t);
  let clock = 10 * 3_600_000;
  const pacer = new Pacer({ file: pacingFile(directory, 'jd'), now: () => clock, wait: async ms => { clock += ms; }, random: () => 0 });
  await writeFile(pacingFile(directory, 'jd'), JSON.stringify({ schema_version: 1, last_interaction_at: 0, last_load_at: 0, gap: null, load_gap: null,
    loads: [{ at: clock - 30 * 60_000, category: 'search' }, { at: clock - 5 * 60_000, category: 'search' }, { at: clock - 61 * 60_000, category: 'page' }] }));
  assert.deepEqual(await pacer.recentLoads(), { search: { last_10_minutes: 1, last_hour: 2 }, page: { last_10_minutes: 0, last_hour: 0 } });
  await assert.rejects(recordThrottleObservation(directory, { platform: 'jd', signal: 'slow', page_kind: 'search', loads: {} }), { code: 'INVALID_ARGUMENTS' });
  await writeFile(path.join(directory, 'throttle-observations.json'), '{"schema_version":1,"observations":[{}]}');
  await assert.rejects(readThrottleObservations(directory), { code: 'INVALID_THROTTLE_LOG' });
});
