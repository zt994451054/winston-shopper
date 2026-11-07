import test from 'node:test';
import assert from 'node:assert/strict';
import { jdOrderDetailClickScript, validateJdOrderDetailClick } from '../lib/jd/order-entry.mjs';
import { jdOrdersPage, orderCard, orderGroup } from '../test-support/jd-orders-fixture.mjs';

const clicksOf = page => page.evaluate('[...document.querySelectorAll(\'[class*="detailLink-"]\')].map(node => node.clicks)');

test('the click script clicks 订单详情 once on the card at the position, after its order id matches', () => {
  const page = jdOrdersPage();
  const before = clicksOf(page);
  assert.deepEqual(before.every(count => count === 0), true);
  // Position 3 is the first child order, after a split banner whose own entry is 拆单详情.
  assert.deepEqual(validateJdOrderDetailClick(page.evaluate(jdOrderDetailClickScript(page.target, 3, '1234567890123456'))), { clicked: true });
  const after = clicksOf(page);
  assert.equal(after.reduce((total, count) => total + count, 0), 1);
  const labels = page.evaluate('[...document.querySelectorAll(\'[class*="detailLink-"]\')].map(node => node.innerText.trim())');
  assert.equal(labels[after.indexOf(1)], '订单详情');
});

test('the click script refuses, without clicking, a changed order, an unloaded position, a missing entry and a gate', () => {
  const cases = [
    [jdOrdersPage(), 1, '999999999999', 'order_changed', 'ORDER_DETAIL_ENTRY_CHANGED'],
    [jdOrdersPage(), 5, '123456789012', 'order_not_loaded', 'ORDER_POSITION_NOT_LOADED'],
    // The second default card has no 订单详情 entry.
    [jdOrdersPage(), 2, '210000000002', 'entry_missing', 'ORDER_DETAIL_ENTRY_MISSING'],
    [jdOrdersPage({ href: 'https://passport.jd.com/new/login.aspx' }), 1, '123456789012', 'login_required', 'LOGIN_REQUIRED'],
    [jdOrdersPage({ href: 'https://order.jd.com/center/other.action' }), 1, '123456789012', 'target_changed', 'TARGET_CHANGED'],
    [jdOrdersPage({ list: false }), 1, '123456789012', 'structure_changed', 'PAGE_STRUCTURE_CHANGED'],
  ];
  for (const [page, position, orderId, state, code] of cases) {
    const value = page.evaluate(jdOrderDetailClickScript(page.target, position, orderId));
    assert.equal(value.state, state, state);
    assert.ok(clicksOf(page).every(count => count === 0), `${state} clicked nothing`);
    assert.throws(() => validateJdOrderDetailClick(value), error => error.code === code && error.actionNotDispatched === true, state);
  }
  const twice = jdOrdersPage({ groups: [orderGroup({ cards: [orderCard()] })] });
  twice.evaluate(`document.querySelectorAll('[class*="detailSection-"]')[0].children.push(document.querySelectorAll('[class*="detailLink-"]')[0])`);
  const ambiguous = twice.evaluate(jdOrderDetailClickScript(twice.target, 1, '123456789012'));
  assert.equal(ambiguous.state, 'entry_ambiguous');
  assert.ok(clicksOf(twice).every(count => count === 0));
});

test('the click script takes only a canonical list, positions 1-10 and a digit order id; acknowledgements are strict', () => {
  const { target } = jdOrdersPage();
  for (const [value, position, orderId] of [[{ ...target, url: 'https://order.jd.com/x' }, 1, '123456789012'], [target, 0, '123456789012'],
    [target, 11, '123456789012'], [target, 1.5, '123456789012'], [target, 1, '12345'], [target, 1, '1234567a9012'], [target, 1, 123456789012]]) {
    assert.throws(() => jdOrderDetailClickScript(value, position, orderId), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => validateJdOrderDetailClick({ state: 'clicked', extra: 1 }), error => error.code === 'INVALID_RESPONSE' && error.actionNotDispatched !== true);
  assert.throws(() => validateJdOrderDetailClick(null), error => error.code === 'INVALID_RESPONSE' && error.actionNotDispatched !== true);
  assert.throws(() => validateJdOrderDetailClick({ state: 'surprise' }), error => error.code === 'INVALID_RESPONSE' && error.actionNotDispatched === true);
  const script = jdOrderDetailClickScript(target, 1, '123456789012');
  assert.equal((script.match(/\.click\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(script, /scroll|fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|window\.open/);
});
