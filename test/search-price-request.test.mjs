import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCnyAmount, createSearchPriceRequest, planSearchPriceRequest } from '../lib/search-price-request.mjs';

const sortingEvidence = ['visible_price_direction_option', 'price_direction_option_relation_to_entry', 'applied_price_direction_state'];
const rangeEvidence = ['price_range_input_identities', 'price_range_input_constraints', 'price_range_submit_control', 'applied_price_range_values'];

for (const [input, amount, cents] of [
  ['0', '0.00', 0], ['0.0', '0.00', 0], ['0.00', '0.00', 0], ['0.01', '0.01', 1],
  ['1', '1.00', 100], ['1.2', '1.20', 120], ['1.23', '1.23', 123],
  ['999999999.99', '999999999.99', 99999999999],
]) {
  test(`CNY amount ${input} keeps exact cents and canonical two-decimal output`, () => {
    const result = parseCnyAmount(input);
    assert.deepEqual(result, { amount, cents });
    assert.equal(Number.isSafeInteger(result.cents), true);
  });
}

test('CNY amounts reject nonstrings without implicit coercion', () => {
  for (const input of [undefined, null, 0, 1.23, NaN, Infinity, true, {}, [], new String('1'), 1n]) {
    assert.throws(() => parseCnyAmount(input), { code: 'INVALID_ARGUMENTS' });
  }
});

test('CNY amounts reject whitespace, currency, signs, exponents and nondecimal forms', () => {
  for (const input of ['', ' ', ' 1', '1 ', '1\n', '1\r\n', '\t1', '1e2', '1E2', '+1', '-1', '-0',
    '￥1', '¥1', '1元', '1,000', '0x10', '.5', '1.', '１', '1/2']) {
    assert.throws(() => parseCnyAmount(input), { code: 'INVALID_ARGUMENTS' });
  }
});

test('CNY amounts reject leading zeroes, excess decimals and ten-digit integers', () => {
  for (const input of ['00', '01', '00.00', '01.2', '1.234', '0.000', '1000000000', '9999999999.99']) {
    assert.throws(() => parseCnyAmount(input), { code: 'INVALID_ARGUMENTS' });
  }
});

test('request accepts either price direction and canonicalizes the search query', () => {
  for (const sort of ['price-asc', 'price-desc']) {
    assert.deepEqual(createSearchPriceRequest({ query: '  合同 图书  ', sort }), {
      schema_version: 1, platform: 'taobao', query: '合同 图书', price_sort: sort,
      price_range: { currency: 'CNY', minimum: null, maximum: null, inclusive: true },
    });
  }
});

test('request preserves zero as a valid sole minimum or maximum boundary', () => {
  const minimum = createSearchPriceRequest({ query: '图书', minPrice: '0' });
  const maximum = createSearchPriceRequest({ query: '图书', maxPrice: '0.0' });
  assert.deepEqual(minimum.price_range, { currency: 'CNY', minimum: { amount: '0.00', cents: 0 }, maximum: null, inclusive: true });
  assert.deepEqual(maximum.price_range, { currency: 'CNY', minimum: null, maximum: { amount: '0.00', cents: 0 }, inclusive: true });
  assert.equal(minimum.price_sort, null);
});

test('request accepts equal inclusive boundaries and a combined direction/range', () => {
  const result = createSearchPriceRequest({ query: '图书', sort: 'price-desc', minPrice: '9.1', maxPrice: '9.10' });
  assert.equal(result.price_sort, 'price-desc');
  assert.deepEqual(result.price_range, { currency: 'CNY', minimum: { amount: '9.10', cents: 910 },
    maximum: { amount: '9.10', cents: 910 }, inclusive: true });
});

test('request compares exact cents at maximum values and rejects inverted boundaries', () => {
  assert.equal(createSearchPriceRequest({ query: '图书', minPrice: '999999999.98', maxPrice: '999999999.99' }).price_range.maximum.cents, 99999999999);
  for (const [minPrice, maxPrice] of [['0.01', '0'], ['9.11', '9.1'], ['999999999.99', '999999999.98']]) {
    assert.throws(() => createSearchPriceRequest({ query: '图书', minPrice, maxPrice }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('request treats omitted, undefined and null optional fields as absent', () => {
  const expected = createSearchPriceRequest({ query: '图书', minPrice: '1' });
  assert.deepEqual(createSearchPriceRequest({ query: '图书', sort: undefined, minPrice: '1', maxPrice: undefined }), expected);
  assert.deepEqual(createSearchPriceRequest({ query: '图书', sort: null, minPrice: '1', maxPrice: null }), expected);
});

test('request rejects unsupported sort values and malformed amount boundaries', () => {
  for (const sort of ['sales', 'asc', 'price', ' price-asc', '', 1, true, {}]) {
    assert.throws(() => createSearchPriceRequest({ query: '图书', sort }), { code: 'INVALID_ARGUMENTS' });
  }
  for (const boundary of ['', '1.001', '01', 1, false, []]) {
    for (const key of ['minPrice', 'maxPrice']) {
      assert.throws(() => createSearchPriceRequest({ query: '图书', [key]: boundary }), { code: 'INVALID_ARGUMENTS' });
    }
  }
});

test('request requires sorting or at least one price boundary', () => {
  for (const options of [{ query: '图书' }, { query: '图书', sort: null, minPrice: null, maxPrice: null },
    { query: '图书', sort: undefined, minPrice: undefined, maxPrice: undefined }]) {
    assert.throws(() => createSearchPriceRequest(options), { code: 'INVALID_ARGUMENTS' });
  }
});

test('request uses the established bounded search query validation', () => {
  for (const query of [undefined, null, '', '  ', 1, 'q'.repeat(101), '图\n书', '图\u0000书']) {
    assert.throws(() => createSearchPriceRequest({ query, sort: 'price-asc' }), { code: 'INVALID_SEARCH' });
  }
  assert.equal(createSearchPriceRequest({ query: 'q'.repeat(100), sort: 'price-asc' }).query.length, 100);
});

test('request rejects missing or nonobject options and every unknown own key', () => {
  for (const options of [undefined, null, [], 'query', 1, true]) {
    assert.throws(() => createSearchPriceRequest(options), { code: 'INVALID_ARGUMENTS' });
  }
  for (const extra of [{ tabId: 41 }, { filters: ['包邮'] }, { browser: {} }, { minimum: '1' }, { [Symbol('unknown')]: true }]) {
    assert.throws(() => createSearchPriceRequest({ query: '图书', sort: 'price-asc', ...extra }), { code: 'INVALID_ARGUMENTS' });
  }
  const hidden = { query: '图书', sort: 'price-asc' };
  Object.defineProperty(hidden, 'hidden', { value: true });
  assert.throws(() => createSearchPriceRequest(hidden), { code: 'INVALID_ARGUMENTS' });
});

test('planning a direction lists only direction evidence and never claims platform execution', () => {
  const options = { query: '图书', sort: 'price-asc' };
  assert.deepEqual(planSearchPriceRequest(options), {
    ok: true, status: 'waiting_layout_evidence', request: createSearchPriceRequest(options),
    platform_sort_implemented: false, platform_filter_implemented: false, platform_applied: false,
    browser_accessed: false, state_changed: false, actions_reserved: 0, required_evidence: sortingEvidence,
  });
});

test('planning either price boundary lists only range input and applied-value evidence', () => {
  for (const options of [{ query: '图书', minPrice: '1' }, { query: '图书', maxPrice: '10' }]) {
    const plan = planSearchPriceRequest(options);
    assert.deepEqual(plan.required_evidence, rangeEvidence);
    assert.equal(plan.request.price_sort, null);
  }
});

test('planning a combined request lists both independent evidence groups', () => {
  const plan = planSearchPriceRequest({ query: '图书', sort: 'price-desc', minPrice: '0', maxPrice: '100' });
  assert.deepEqual(plan.required_evidence, [...sortingEvidence, ...rangeEvidence]);
});

test('planning does not mutate input and returns independent request/evidence objects', () => {
  const options = Object.freeze({ query: ' 图书 ', minPrice: '1' });
  const first = planSearchPriceRequest(options);
  first.request.price_range.minimum.amount = '99.00';
  first.required_evidence.pop();
  const second = planSearchPriceRequest(options);
  assert.equal(second.request.price_range.minimum.amount, '1.00');
  assert.deepEqual(second.required_evidence, rangeEvidence);
  assert.equal(options.query, ' 图书 ');
});

test('planning rejects invalid requests rather than returning a ready or applied result', () => {
  assert.throws(() => planSearchPriceRequest({ query: '图书', sort: 'sales' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => planSearchPriceRequest({ query: '图书', minPrice: '2', maxPrice: '1' }), { code: 'INVALID_ARGUMENTS' });
});
