import test from 'node:test';
import assert from 'node:assert/strict';
import { jdSearchScript, validateJdSearch } from '../lib/jd/search.mjs';
import {
  JD_SEARCH_PAGE_LIMIT, jdNextPageScript, jdSearchPageScript, validateJdNextPage, validateJdSearchPage,
} from '../lib/jd/search-pages.mjs';
import { element, jdSearchPage } from '../test-support/jd-search-fixture.mjs';

const AT = '2026-10-21T00:00:00.000Z';
const FIRST = [{ sku: '310000000001' }, { sku: '310000000002' }];
const SECOND = [{ sku: '320000000001' }, { sku: '320000000002' }];
const QUIET = /scrollIntoView|scrollTo|scrollBy|fetch\(|XMLHttpRequest|cookie|Storage|location\.assign/;

function view(active, pages, overrides = {}) {
  return {
    active_page: active, active_text: String(active), total_pages: pages, total_text: `共${pages}页`,
    previous: active <= 1 ? 'disabled' : 'enabled', next: active >= pages ? 'disabled' : 'enabled', ...overrides,
  };
}

function read(options) {
  const page = jdSearchPage(options);
  const raw = page.evaluate(jdSearchPageScript(page.target));
  return { page, raw, result: validateJdSearchPage(raw, page.target, { observedAt: AT }) };
}

test('the pager reports the current page, the total and whether each control can be used', () => {
  assert.equal(JD_SEARCH_PAGE_LIMIT, 5);
  const first = read({ pager: { pages: 17, active: 1 } });
  assert.deepEqual(Object.keys(first.result).sort(), ['observed_at', 'pager', 'search']);
  assert.deepEqual(Object.keys(first.result.pager).sort(), ['active_page', 'active_text', 'next', 'previous', 'total_pages', 'total_text']);
  assert.equal(first.result.observed_at, AT);
  assert.deepEqual(first.result.pager, view(1, 17));
  assert.equal(first.page.clicks(), 0);
  assert.deepEqual(read({ pager: { pages: 17, active: 2 } }).result.pager, view(2, 17));
  assert.deepEqual(read({ pager: { pages: 17, active: 17 } }).result.pager, view(17, 17));
  // A different module hash still resolves. The live suffix changes between releases.
  assert.deepEqual(read({ pager: { pages: 4, active: 2, hash: 'ab12c' } }).result.pager, view(2, 4));
  assert.deepEqual(read({ pager: { pages: 17, active: 1, showTotal: false } }).result.pager, view(1, 17, { total_pages: null, total_text: null }));
  assert.deepEqual(read({ pager: { pages: 17, active: 1, hideNext: true } }).result.pager, view(1, 17, { next: 'missing' }));
  assert.deepEqual(read({ pager: { pages: 17, active: 1, extraActive: true } }).result.pager,
    view(1, 17, { active_page: null, active_text: null }));
});

test('one read returns the pager and the same first screen as the card reader, without a click', () => {
  const page = jdSearchPage({ pager: { pages: 17, active: 1 } });
  const readScript = jdSearchPageScript(page.target);
  const clickScript = jdNextPageScript(page.target, 1);
  assert.match(readScript, /function collectJdSearchPager\(/);
  assert.match(readScript, /function collectJdSearch\(/);
  assert.doesNotMatch(readScript, /function clickJdNextPage/);
  assert.doesNotMatch(readScript, new RegExp(`\\.click\\(|${QUIET.source}`));
  assert.match(clickScript, /function clickJdNextPage\(/);
  assert.doesNotMatch(clickScript, QUIET);
  assert.equal((clickScript.match(/\.click\(\)/g) ?? []).length, 1);
  const combined = validateJdSearchPage(page.evaluate(readScript), page.target, { observedAt: AT });
  const alone = validateJdSearch(page.evaluate(jdSearchScript(page.target)), page.target, { observedAt: AT });
  assert.deepEqual(combined.search, alone);
  assert.deepEqual(combined.pager, view(1, 17));
  assert.equal(page.clicks(), 0);
  assert.deepEqual(combined.search.items.map(item => item.product_id), ['3290995', '10221084529885', '10068477063146']);
});

test('one next click moves to the next page and replaces the first-screen cards', () => {
  const page = jdSearchPage({ pager: { pages: 17, active: 1 }, pageCards: [FIRST, SECOND] });
  const before = validateJdSearchPage(page.evaluate(jdSearchPageScript(page.target)), page.target, { observedAt: AT });
  assert.deepEqual(before.pager, view(1, 17));
  assert.deepEqual(before.search.items.map(item => item.product_id), ['310000000001', '310000000002']);
  assert.deepEqual(validateJdNextPage(page.evaluate(jdNextPageScript(page.target, 1))), { clicked: true });
  assert.equal(page.clicks(), 1);
  const after = validateJdSearchPage(page.evaluate(jdSearchPageScript(page.target)), page.target, { observedAt: AT });
  assert.deepEqual(after.pager, view(2, 17));
  assert.deepEqual(after.search.items.map(item => item.product_id), ['320000000001', '320000000002']);
  assert.equal(page.clicks(), 1);
  const frozen = jdSearchPage({ pager: { pages: 17, active: 1, advance: false }, pageCards: [FIRST, SECOND] });
  assert.deepEqual(validateJdNextPage(frozen.evaluate(jdNextPageScript(frozen.target, 1))), { clicked: true });
  assert.equal(frozen.clicks(), 1);
  const stayed = validateJdSearchPage(frozen.evaluate(jdSearchPageScript(frozen.target)), frozen.target, { observedAt: AT });
  assert.deepEqual(stayed.pager, view(1, 17));
  assert.deepEqual(stayed.search.items.map(item => item.product_id), ['310000000001', '310000000002']);
});

test('a next click is refused, and not sent, when the pager is not the expected enabled control', () => {
  const refuse = (options, fromPage, state, code, lastPage = false) => {
    const page = jdSearchPage({ pager: { pages: 17, active: 1 }, ...options });
    const value = page.evaluate(jdNextPageScript(page.target, fromPage));
    assert.equal(value.state, state, state);
    assert.equal(page.clicks(), 0, state);
    assert.throws(() => validateJdNextPage(value), error => {
      assert.equal(error.code, code, state);
      assert.equal(error.actionNotDispatched, true, state);
      assert.equal(error.lastPage, lastPage ? true : undefined, state);
      return true;
    }, state);
  };
  refuse({}, 2, 'page_mismatch', 'SEARCH_PAGE_MISMATCH');
  refuse({ pager: { pages: 17, active: 1, extraActive: true } }, 1, 'page_mismatch', 'SEARCH_PAGE_MISMATCH');
  refuse({ pager: { pages: 3, active: 3 } }, 3, 'last_page', 'SEARCH_LAST_PAGE', true);
  refuse({ pager: null }, 1, 'search_pagination_missing', 'SEARCH_PAGINATION_MISSING');
  refuse({ pager: { pages: 17, active: 1, copies: 2 } }, 1, 'search_page_controls_mismatch', 'SEARCH_PAGE_CONTROLS_MISMATCH');
  refuse({ pager: { pages: 17, active: 1, hideNext: true } }, 1, 'search_page_controls_mismatch', 'SEARCH_PAGE_CONTROLS_MISMATCH');
  refuse({ href: 'https://passport.jd.com/new/login.aspx' }, 1, 'login_required', 'LOGIN_REQUIRED');
  refuse({ extra: [element('div', { text: '访问频繁导致无法搜索' })] }, 1, 'rate_limited', 'RATE_LIMITED');
  refuse({ extra: [element('div', { cls: 'JDJRV-wrap' })] }, 1, 'verification_required', 'VERIFICATION_REQUIRED');
  refuse({ href: 'https://search.jd.com/Search?keyword=other&enc=utf-8' }, 1, 'target_changed', 'TARGET_CHANGED');
});

test('gates stop a read before a pager-shape error, and a bad acknowledgement or page is rejected', () => {
  const gone = jdSearchPage({ href: 'https://item.jd.com/1.html' });
  const goneRaw = gone.evaluate(jdSearchPageScript(gone.target));
  assert.equal(goneRaw.search.state, 'target_changed');
  assert.equal(goneRaw.pager.state, 'search_pagination_missing');
  assert.throws(() => validateJdSearchPage(goneRaw, gone.target), { code: 'TARGET_CHANGED' });
  const bare = jdSearchPage({ cards: [] });
  const bareRaw = bare.evaluate(jdSearchPageScript(bare.target));
  assert.equal(bareRaw.search.state, 'structure_changed');
  assert.equal(bareRaw.pager.state, 'search_pagination_missing');
  assert.throws(() => validateJdSearchPage(bareRaw, bare.target), { code: 'SEARCH_PAGINATION_MISSING' });
  const doubled = jdSearchPage({ pager: { pages: 17, active: 1, copies: 2 } });
  assert.throws(() => validateJdSearchPage(doubled.evaluate(jdSearchPageScript(doubled.target)), doubled.target),
    { code: 'SEARCH_PAGE_CONTROLS_MISMATCH' });
  const empty = jdSearchPage({ cards: [], pager: { pages: 17, active: 1 } });
  assert.throws(() => validateJdSearchPage(empty.evaluate(jdSearchPageScript(empty.target)), empty.target), { code: 'PAGE_STRUCTURE_CHANGED' });
  for (const [options, code] of [
    [{ href: 'https://passport.jd.com/new/login.aspx', pager: { pages: 17, active: 1 } }, 'LOGIN_REQUIRED'],
    [{ extra: [element('div', { text: '访问频繁导致无法搜索' })], pager: { pages: 17, active: 1 } }, 'RATE_LIMITED'],
    [{ extra: [element('div', { cls: 'JDJRV-wrap' })], pager: { pages: 17, active: 1 } }, 'VERIFICATION_REQUIRED'],
  ]) {
    const page = jdSearchPage(options);
    assert.throws(() => validateJdSearchPage(page.evaluate(jdSearchPageScript(page.target)), page.target), { code });
  }

  const { page, raw } = read({ pager: { pages: 17, active: 1 } });
  const reject = (name, edit) => {
    const copy = structuredClone(raw);
    edit(copy);
    assert.throws(() => validateJdSearchPage(copy, page.target), { code: 'INVALID_RESPONSE' }, name);
  };
  reject('extra root', value => { value.extra = true; });
  reject('missing search', value => { delete value.search; });
  reject('extra pager', value => { value.pager.extra = 1; });
  reject('missing next', value => { delete value.pager.next; });
  reject('page off the label', value => { value.pager.active_page = 9; });
  reject('page string', value => { value.pager.active_page = '1'; });
  reject('page fraction', value => { value.pager.active_page = 1.5; });
  reject('page null', value => { value.pager.active_page = null; });
  reject('label too long', value => { value.pager.active_text = '1234567'; });
  reject('label number', value => { value.pager.active_text = 1; });
  reject('label null', value => { value.pager.active_text = null; });
  reject('total off the label', value => { value.pager.total_pages = 16; });
  reject('total string', value => { value.pager.total_pages = '17'; });
  reject('total null', value => { value.pager.total_pages = null; });
  reject('total too long', value => { value.pager.total_text = `共17页${'x'.repeat(20)}`; });
  reject('total text null', value => { value.pager.total_text = null; });
  reject('previous', value => { value.pager.previous = 'yes'; });
  reject('next', value => { value.pager.next = null; });
  reject('state', value => { value.pager.state = 'other'; });
  reject('pager null', value => { value.pager = null; });
  reject('search null', value => { value.search = null; });
  assert.throws(() => validateJdSearchPage(null, page.target), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validateJdSearchPage([], page.target), { code: 'INVALID_RESPONSE' });
  const loading = structuredClone(raw);
  loading.search = { state: 'loading' };
  assert.throws(() => validateJdSearchPage(loading, page.target), { code: 'PAGE_LOADING' });
  const loginPager = structuredClone(raw);
  loginPager.pager = { state: 'login_required' };
  assert.throws(() => validateJdSearchPage(loginPager, page.target), { code: 'LOGIN_REQUIRED' });

  assert.throws(() => validateJdNextPage({ state: 'clicked', extra: 1 }), error => error.code === 'INVALID_RESPONSE' && error.actionNotDispatched !== true);
  assert.throws(() => validateJdNextPage(null), error => error.code === 'INVALID_RESPONSE' && error.actionNotDispatched !== true);
  assert.throws(() => validateJdNextPage({ state: 'surprise' }), error => error.code === 'INVALID_RESPONSE' && error.actionNotDispatched === true);
  assert.deepEqual(validateJdNextPage({ state: 'clicked' }), { clicked: true });

  for (const fromPage of [0, 5, -1, 1.5, null, undefined, '1', Number.NaN, Number.POSITIVE_INFINITY, true]) {
    assert.throws(() => jdNextPageScript(page.target, fromPage), { code: 'INVALID_ARGUMENTS' }, String(fromPage));
  }
  assert.equal(typeof jdNextPageScript(page.target, 4), 'string');
  assert.throws(() => jdSearchPageScript({ ...page.target, page: 2 }), { code: 'INVALID_SEARCH' });
  assert.throws(() => jdNextPageScript({ ...page.target, page: 2 }, 1), { code: 'INVALID_SEARCH' });
  assert.throws(() => jdNextPageScript({ ...page.target, page: 2 }, 9), { code: 'INVALID_SEARCH' });
  assert.throws(() => jdSearchPageScript(null), { code: 'INVALID_SEARCH' });
  assert.throws(() => jdNextPageScript(null, 1), { code: 'INVALID_SEARCH' });
});
