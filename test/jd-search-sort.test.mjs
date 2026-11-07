import test from 'node:test';
import assert from 'node:assert/strict';
import { jdSearchPageScript, validateJdSearchPage } from '../lib/jd/search-pages.mjs';
import {
  collectJdSortBar, jdPriceRangeCheck, jdPriceRangeConfirmScript, jdPriceRangeHoverScript, jdPriceRangePanelScript, jdSortClickScript, jdSortOrderCheck,
  jdSortedSearchScript, requirePriceRange, shownPriceRange, validateJdPriceRangeConfirm, validateJdPriceRangeHover, validateJdPriceRangePanel,
  validateJdSortClick, validateJdSortedSearch,
} from '../lib/jd/search-sort.mjs';
import { jdSearchTarget } from '../lib/jd/targets.mjs';
import { JD_SORT_ICONS as ICONS, jdSearchPage } from '../test-support/jd-search-fixture.mjs';

const AT = '2026-10-22T00:00:00.000Z';
const QUIET = /scrollIntoView|scrollTo|scrollBy|fetch\(|XMLHttpRequest|cookie|Storage|location\.assign/;
const cards = (prefix, grays) => grays.map((gray, index) => ({ sku: `${prefix}${index + 1}`, price: '1.00', other: gray === null ? null : `¥${gray}` }));
// The gray amounts read on 2026-10-21 after the first and the second 价格 click.
const DOWN = ['979', '959', '959', '880', '870', '851', '850', '830', '799', '492'];
const UP = ['39', '39', '40', '43', '43', '46', '48.4', '48.7', '49'];
const SORT_CARDS = { comprehensive: cards('100', ['129', '89', '99', '45']), sales: cards('200', ['49', '129', '89', '59']),
  'price-desc': cards('300', DOWN), 'price-asc': cards('400', UP) };

function sortedRead(page) {
  return validateJdSortedSearch(page.evaluate(jdSortedSearchScript(page.target)), page.target, { observedAt: AT });
}

function sortPage(active = 'comprehensive', sort = {}, options = {}) {
  return jdSearchPage({ pager: { pages: 17, active: 1 }, sort: { active, cards: SORT_CARDS, ...sort }, ...options });
}

function click(page, label, before) {
  return page.evaluate(jdSortClickScript(page.target, label, before));
}

const failure = callback => { try { callback(); } catch (error) { return error; } assert.fail('expected an error'); };

test('the sort bar reports each control, its selection and only the icon file name', () => {
  const expected = {
    comprehensive: ['comprehensive', [true, ICONS.comprehensiveOn], [false, ICONS.salesOff], [false, ICONS.priceOff]],
    sales: ['sales', [false, ICONS.comprehensiveOff], [true, ICONS.salesOn], [false, ICONS.priceOff]],
    'price-desc': ['price', [false, ICONS.comprehensiveOff], [false, ICONS.salesOff], [true, ICONS.priceDesc]],
    'price-asc': ['price', [false, ICONS.comprehensiveOff], [false, ICONS.salesOff], [true, ICONS.priceAsc]],
  };
  for (const [state, [activeSort, comprehensive, sales, price]] of Object.entries(expected)) {
    const result = sortedRead(sortPage(state));
    assert.deepEqual(Object.keys(result).sort(), ['active_sort', 'observed_at', 'pager', 'search', 'sort_bar']);
    assert.equal(result.active_sort, activeSort, state);
    assert.deepEqual(result.sort_bar, {
      comprehensive: { text: '综合', active: comprehensive[0], icon: comprehensive[1] },
      sales: { active: sales[0], icon: sales[1] }, price: { active: price[0], icon: price[1] },
      range: { text: '价格区间', active: false, icon: ICONS.range },
    }, state);
  }
  // A different module hash still resolves. The live suffix changes between releases.
  assert.equal(sortedRead(sortPage('sales', { hash: 'ab12c', barHash: 'zz9x8' })).active_sort, 'sales');
});

test('one read returns the sort bar, the pager and the same cards as the pager read', () => {
  const page = sortPage('price-desc');
  const result = sortedRead(page);
  const plain = validateJdSearchPage(page.evaluate(jdSearchPageScript(page.target)), page.target, { observedAt: AT });
  assert.deepEqual(result.pager, plain.pager);
  assert.deepEqual(result.search, plain.search);
  assert.equal(result.search.items.length, DOWN.length);
  assert.deepEqual([page.clicks(), page.sortClicks()], [0, 0]);
});

test('价格 clicked from 综合 sorts high to low, again low to high; 销量 sorts by sales', () => {
  const page = sortPage();
  assert.deepEqual(validateJdSortClick(click(page, '价格', { active_sort: 'comprehensive', price_icon: ICONS.priceOff })), { clicked: true });
  const down = sortedRead(page);
  assert.deepEqual([down.active_sort, down.sort_bar.price.icon, jdSortOrderCheck(down.search.items, 'desc').status], ['price', ICONS.priceDesc, 'ordered']);
  validateJdSortClick(click(page, '价格', { active_sort: 'price', price_icon: ICONS.priceDesc }));
  const up = sortedRead(page);
  assert.deepEqual([up.active_sort, up.sort_bar.price.icon, jdSortOrderCheck(up.search.items, 'asc').status], ['price', ICONS.priceAsc, 'ordered']);
  assert.equal(page.sortClicks(), 2);

  const sales = sortPage();
  validateJdSortClick(click(sales, '销量', { active_sort: 'comprehensive', price_icon: ICONS.priceOff }));
  assert.deepEqual([sortedRead(sales).active_sort, sales.sortClicks(), sales.clicks()], ['sales', 1, 0]);
});

test('a sort click that does not match the last read, or cannot find one tag, clicks nothing', () => {
  const stale = [
    ['price-desc', { active_sort: 'comprehensive', price_icon: ICONS.priceOff }],
    ['price-asc', { active_sort: 'price', price_icon: ICONS.priceDesc }],
    ['comprehensive', { active_sort: 'comprehensive', price_icon: null }],
  ];
  for (const [state, before] of stale) {
    const page = sortPage(state);
    const error = failure(() => validateJdSortClick(click(page, '价格', before)));
    assert.deepEqual([error.code, error.actionNotDispatched, page.sortClicks()], ['SEARCH_SORT_STATE_CHANGED', true, 0], state);
  }
  const blocked = [
    [{}, { pager: { pages: 17, active: 1 } }, 'SEARCH_SORT_STATE_MISMATCH', 'no sort bar'],
    [{ copies: 2 }, {}, 'SEARCH_SORT_STATE_MISMATCH', 'two sort bars'],
    [{ hidePrice: true }, {}, 'SEARCH_SORT_STATE_MISMATCH', 'hidden 价格'],
    [{ bothActive: true }, {}, 'SEARCH_SORT_STATE_MISMATCH', 'two selected'],
    [{ dropTrigger: true }, {}, 'SEARCH_SORT_STATE_MISMATCH', 'no 价格区间'],
    [{}, { title: '京东-欢迎登录', href: 'https://passport.jd.com/new/login.aspx' }, 'LOGIN_REQUIRED', 'login'],
    [{}, { href: 'https://search.jd.com/Search?keyword=other&enc=utf-8' }, 'TARGET_CHANGED', 'other keyword'],
  ];
  for (const [sort, options, code, name] of blocked) {
    const page = name === 'no sort bar' ? jdSearchPage(options) : sortPage('comprehensive', sort, options);
    const error = failure(() => validateJdSortClick(click(page, '价格', { active_sort: 'comprehensive', price_icon: ICONS.priceOff })));
    assert.deepEqual([error.code, error.actionNotDispatched, page.sortClicks()], [code, true, 0], name);
  }
});

test('a page whose sort bar is missing, doubled or ambiguous is refused on read', () => {
  for (const [page, code] of [
    [jdSearchPage({ pager: { pages: 17, active: 1 } }), 'SEARCH_SORT_STATE_MISMATCH'],
    [sortPage('comprehensive', { copies: 2 }), 'SEARCH_SORT_STATE_MISMATCH'],
    [sortPage('comprehensive', { bothActive: true }), 'SEARCH_SORT_STATE_MISMATCH'],
    [sortPage('comprehensive', {}, { href: 'https://search.jd.com/Search?keyword=other&enc=utf-8' }), 'TARGET_CHANGED'],
  ]) {
    assert.throws(() => sortedRead(page), { code });
  }
  // The sort bar is present but the pager is not: the pager's own error.
  assert.throws(() => sortedRead(jdSearchPage({ sort: { active: 'comprehensive' } })), { code: 'SEARCH_PAGINATION_MISSING' });
});

test('an ignored sort click is still one click and leaves the page as it was', () => {
  const page = sortPage('comprehensive', { ignoreClicks: true });
  validateJdSortClick(click(page, '销量', { active_sort: 'comprehensive', price_icon: ICONS.priceOff }));
  assert.deepEqual([page.sortClicks(), sortedRead(page).active_sort], [1, 'comprehensive']);
});

test('the order check uses the plain gray amount, else the big price, and skips ads and unreadable cards', () => {
  const check = (cardList, direction) => {
    const page = jdSearchPage({ pager: { pages: 3, active: 1 }, cards: cardList });
    return jdSortOrderCheck(validateJdSearchPage(page.evaluate(jdSearchPageScript(page.target)), page.target, { observedAt: AT }).search.items, direction);
  };
  assert.deepEqual(check(cards('600', DOWN), 'desc'), { basis: 'gray_amount_or_displayed_price', direction: 'desc', cards_compared: 10,
    pairs: { in_order: 8, against: 0, equal: 1 }, sponsored_skipped: 0, unparsed_skipped: 0, status: 'ordered' });
  assert.deepEqual([check(cards('600', UP), 'asc').status, check(cards('600', UP), 'asc').pairs], ['ordered', { in_order: 6, against: 0, equal: 2 }]);
  assert.equal(check(cards('600', UP), 'desc').status, 'opposite');
  assert.deepEqual([check(cards('600', ['979', '120', '880', '40', '870']), 'desc').status], ['mixed']);
  assert.equal(check(cards('600', ['3', '2', '1']), 'desc').status, 'too_few');
  // No gray amount: the big price counts. A struck amount is a list price and is not the key.
  const mixedSources = [{ sku: '7001', price: '90', other: null }, { sku: '7002', price: '80', other: null },
    { sku: '7003', price: '1', other: '¥999', struck: true }, { sku: '7004', price: '60', other: '¥70' }, { sku: '7005', price: '5', other: '¥50' }];
  assert.deepEqual(check(mixedSources, 'desc').pairs, { in_order: 3, against: 1, equal: 0 });
  // An ad and an unparsable price are counted and left out.
  const skipped = [...cards('800', ['50', '40']), { sku: '8003', ad: true, other: '¥999' }, { sku: '8004', price: '面议', other: null },
    ...cards('810', ['30', '20'])];
  assert.deepEqual(check(skipped, 'desc'), { basis: 'gray_amount_or_displayed_price', direction: 'desc', cards_compared: 4,
    pairs: { in_order: 3, against: 0, equal: 0 }, sponsored_skipped: 1, unparsed_skipped: 1, status: 'ordered' });
  assert.throws(() => jdSortOrderCheck([], 'up'), { code: 'INVALID_ARGUMENTS' });
});

test('responses and click arguments are checked strictly', () => {
  const page = sortPage('price-desc');
  const raw = page.evaluate(jdSortedSearchScript(page.target));
  for (const change of [
    value => { value.extra = 1; },
    value => { value.sort_bar.extra = 1; },
    value => { value.sort_bar.sales.text = '销量'; },
    value => { value.sort_bar.price.active = 'yes'; },
    value => { value.sort_bar.price.icon = 'https://img.example/x.png'; },
    value => { value.sort_bar.comprehensive.text = 'x'.repeat(41); },
    value => { delete value.sort_bar.range; },
    value => { value.sort_bar.state = 'other'; },
  ]) {
    const copy = structuredClone(raw);
    change(copy);
    assert.throws(() => validateJdSortedSearch(copy, page.target, { observedAt: AT }), { code: 'INVALID_RESPONSE' }, change.toString());
  }
  const target = jdSearchTarget('Synthetic mouse');
  const before = { active_sort: 'comprehensive', price_icon: ICONS.priceOff };
  for (const [label, state] of [['综合', before], ['价格区间', before], ['价格', { ...before, extra: 1 }], ['价格', { ...before, active_sort: null }],
    ['价格', { ...before, active_sort: 'price-asc' }], ['价格', { ...before, price_icon: '../x.png' }], ['价格', { active_sort: 'sales' }]]) {
    assert.throws(() => jdSortClickScript(target, label, state), { code: 'INVALID_ARGUMENTS' }, `${label} ${JSON.stringify(state)}`);
  }
  assert.throws(() => jdSortClickScript({ query: 'Synthetic mouse' }, '价格', before), { code: 'INVALID_SEARCH' });
  assert.deepEqual(jdSortClickScript(target, '价格', { ...before, price_icon: null }).length > 0, true);
  const odd = failure(() => validateJdSortClick({ state: 'clicked', extra: 1 }));
  assert.deepEqual([odd.code, odd.actionNotDispatched], ['INVALID_RESPONSE', undefined]);
  assert.equal(failure(() => validateJdSortClick(null)).actionNotDispatched, undefined);
  assert.equal(failure(() => validateJdSortClick({ state: 'unknown' })).actionNotDispatched, true);
});

test('the read scripts never click; no script scrolls, fetches or reads storage; the click script clicks once', () => {
  const target = jdSearchTarget('Synthetic mouse');
  const read = jdSortedSearchScript(target);
  const clickScript = jdSortClickScript(target, '价格', { active_sort: 'comprehensive', price_icon: null });
  assert.doesNotMatch(String(collectJdSortBar), /\.click\(/);
  assert.doesNotMatch(read, /\.click\(/);
  assert.doesNotMatch(read, QUIET);
  assert.doesNotMatch(clickScript, QUIET);
  // The clicker reuses collectJdSortBar for its check; only its own body clicks.
  assert.equal(clickScript.match(/\.click\(/g).length, 1);
});

const IN_RANGE = cards('900', ['89', '64.8', '65', '79.9', '89.1', '69']);

test('价格区间 opens on hover, takes two typed bounds and one 确定, then names the range and shows only cards inside it', () => {
  const page = sortPage('comprehensive', { rangeCards: { comprehensive: IN_RANGE } });
  const panel = () => validateJdPriceRangePanel(page.evaluate(jdPriceRangePanelScript(page.target)));
  assert.deepEqual(panel(), { open: 0, inputs: [] });
  assert.deepEqual(validateJdPriceRangeHover(page.evaluate(jdPriceRangeHoverScript(page.target))), { hovered: true });
  assert.deepEqual(panel(), { open: 1, inputs: [{ placeholder: '最低价', value: '', unique: true }, { placeholder: '最高价', value: '', unique: true }] });
  const before = sortedRead(page);
  assert.deepEqual([before.sort_bar.range, shownPriceRange(before.sort_bar.range)], [{ text: '价格区间', active: false, icon: ICONS.range }, null]);
  page.fill('minimum', '60'); page.fill('maximum', '90');
  assert.deepEqual(panel().inputs.map(input => input.value), ['60', '90']);
  assert.deepEqual(validateJdPriceRangeConfirm(page.evaluate(jdPriceRangeConfirmScript(page.target, 60, 90))), { clicked: true });
  const after = sortedRead(page);
  assert.deepEqual([page.confirmClicks(), page.panelOpen(), after.active_sort, after.sort_bar.range.active, after.sort_bar.range.text, shownPriceRange(after.sort_bar.range)],
    [1, false, 'comprehensive', true, '价格区间(¥60-90)', [60, 90]]);
  assert.deepEqual(jdPriceRangeCheck(after.search.items, 60, 90), { basis: 'gray_amount_or_displayed_price', minimum: 60, maximum: 90, cards_checked: 6, outside: 0,
    sponsored_skipped: 0, unparsed_skipped: 0 });
  assert.equal(jdPriceRangeCheck(before.search.items, 60, 90).outside, 3);
  assert.deepEqual([page.clicks(), page.sortClicks()], [0, 0]);
});

test('the range controls refuse, without clicking, a range already set, other typed bounds or a closed dropdown', () => {
  const set = sortPage('comprehensive', { range: { minimum: 60, maximum: 90 } });
  const hover = failure(() => validateJdPriceRangeHover(set.evaluate(jdPriceRangeHoverScript(set.target))));
  assert.deepEqual([hover.code, hover.actionNotDispatched, set.panelOpen()], ['SEARCH_PRICE_RANGE_STATE_CHANGED', true, false]);
  const page = sortPage();
  const closed = failure(() => validateJdPriceRangeConfirm(page.evaluate(jdPriceRangeConfirmScript(page.target, 60, 90))));
  assert.deepEqual([closed.code, closed.actionNotDispatched], ['SEARCH_PRICE_RANGE_UNAVAILABLE', true]);
  page.evaluate(jdPriceRangeHoverScript(page.target));
  page.fill('minimum', '60'); page.fill('maximum', '99');
  const other = failure(() => validateJdPriceRangeConfirm(page.evaluate(jdPriceRangeConfirmScript(page.target, 60, 90))));
  assert.deepEqual([other.code, other.actionNotDispatched, page.confirmClicks()], ['SEARCH_PRICE_RANGE_NOT_FILLED', true, 0]);
  const login = sortPage('comprehensive', {}, { title: '京东-欢迎登录', href: 'https://passport.jd.com/new/login.aspx' });
  assert.equal(failure(() => validateJdPriceRangeHover(login.evaluate(jdPriceRangeHoverScript(login.target)))).code, 'LOGIN_REQUIRED');
  assert.throws(() => validateJdPriceRangePanel(login.evaluate(jdPriceRangePanelScript(login.target))), { code: 'LOGIN_REQUIRED' });
  // The shown range must name exactly two amounts.
  assert.deepEqual([shownPriceRange({ text: '价格区间(¥60-90)', active: false }), shownPriceRange({ text: '价格区间(¥60以上)', active: true })], [null, null]);
});

test('range arguments, panel replies and the range scripts are checked strictly', () => {
  for (const [minimum, maximum] of [[0, 90], [60, 60], [90, 60], [60.5, 90], [60, 1_000_000], ['60', 90]]) {
    assert.throws(() => requirePriceRange(minimum, maximum), { code: 'INVALID_ARGUMENTS' }, `${minimum} ${maximum}`);
    assert.throws(() => jdPriceRangeConfirmScript(jdSearchTarget('Synthetic mouse'), minimum, maximum), { code: 'INVALID_ARGUMENTS' });
  }
  for (const value of [{ state: 'observed', open: 1 }, { state: 'observed', open: 0, inputs: [{ placeholder: 'a', value: '', unique: true }] },
    { state: 'observed', open: 6, inputs: [] }, { state: 'observed', open: 1, inputs: [{ placeholder: 'a', value: '', unique: 'yes' }] },
    { state: 'observed', open: 1, inputs: [{ placeholder: 'x'.repeat(13), value: '', unique: true }] }, null]) {
    assert.throws(() => validateJdPriceRangePanel(value), { code: 'INVALID_RESPONSE' }, JSON.stringify(value));
  }
  const odd = failure(() => validateJdPriceRangeConfirm({ state: 'clicked', extra: 1 }));
  assert.deepEqual([odd.code, odd.actionNotDispatched], ['INVALID_RESPONSE', undefined]);
  const target = jdSearchTarget('Synthetic mouse');
  const [panel, hover, confirm] = [jdPriceRangePanelScript(target), jdPriceRangeHoverScript(target), jdPriceRangeConfirmScript(target, 60, 90)];
  for (const script of [panel, hover, confirm]) assert.doesNotMatch(script, QUIET);
  for (const script of [panel, hover]) assert.doesNotMatch(script, /\.click\(|\.value\s*=/);
  assert.equal(confirm.match(/\.click\(/g).length, 1);
  assert.doesNotMatch(confirm, /\.value\s*=/);
});
