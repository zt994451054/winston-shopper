import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serviceEntryScript } from '../lib/service-entry.mjs';

const target = { url: 'https://detail.tmall.com/item.htm?id=123' };
const labels = ['退货宝', '7天无理由退换'];

function fixture() {
  let clicks = 0;
  const text = labels.map(label => ({ innerText: label, getClientRects: () => [{}] }));
  const attributes = {};
  const trigger = { tagName: 'DIV', matches: () => true, getClientRects: () => [{}], closest: () => null,
    getAttribute: key => attributes[key] ?? null, querySelectorAll: () => text, click: () => { clicks++; } };
  const root = { getClientRects: () => [{}], querySelectorAll: query => query.includes('isExpend') ? [] : [trigger] };
  const roots = [root], dialogs = [];
  const document = { title: 'Synthetic product', querySelectorAll: query => query.includes('GuaranteeInfo') ? roots
    : query.includes('role="dialog"') ? dialogs : [] };
  const run = (activate = false, url = target.url) => vm.runInNewContext(serviceEntryScript(target, labels, activate),
    { URL, location: { href: url }, document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  return { trigger, attributes, roots, text, dialogs, run, clicks: () => clicks };
}

test('a service entry with exact labels is observed without action and activates only once per explicit call', () => {
  const f = fixture();
  assert.equal(f.run().state, 'entry_observed'); assert.equal(f.clicks(), 0);
  assert.equal(f.run(true).state, 'action_dispatched'); assert.equal(f.clicks(), 1);
});

test('service entry labels and target identity must still match before activation', () => {
  const f = fixture();
  assert.equal(f.run(true, 'https://detail.tmall.com/item.htm?id=999').state, 'target_changed');
  f.text[0].innerText = 'A different service';
  assert.equal(f.run(true).state, 'structure_changed'); assert.equal(f.clicks(), 0);
});

test('ambiguous, absent or disabled service entries never receive a click', () => {
  for (const mutate of [f => f.roots.push(f.roots[0]), f => f.roots.splice(0),
    f => { f.attributes['aria-disabled'] = 'true'; }, f => { f.attributes['data-disabled'] = 'true'; },
    f => { f.trigger.disabled = true; }, f => { f.trigger.matches = () => false; },
    f => { f.roots[0].querySelectorAll = () => [f.trigger, f.trigger]; }]) {
    const f = fixture(); mutate(f); assert.notEqual(f.run(true).state, 'action_dispatched'); assert.equal(f.clicks(), 0);
  }
});

test('service links, navigable ancestors and unrelated dialogs block activation', () => {
  for (const mutate of [f => { f.trigger.tagName = 'A'; }, f => { f.trigger.closest = () => ({}); },
    f => { f.attributes.role = 'link'; }, f => f.dialogs.push({ innerText: 'Other content', getClientRects: () => [{}] })]) {
    const f = fixture(); mutate(f); assert.notEqual(f.run(true).state, 'action_dispatched'); assert.equal(f.clicks(), 0);
  }
});

test('service entry scripts stop on login or verification and reject invalid plans before browser use', () => {
  for (const [text, state] of [['请扫码登录', 'login_required'], ['安全验证', 'verification_required']]) {
    const f = fixture(); f.dialogs.push({ innerText: text, getClientRects: () => [{}] });
    assert.equal(f.run(true).state, state); assert.equal(f.clicks(), 0);
  }
  for (const input of [[], [''], ['a', 'a'], [' x'], ['x\n'], Array(21).fill('x'), [1]]) {
    assert.throws(() => serviceEntryScript(target, input), { code: 'INVALID_SERVICE_ENTRY' });
  }
});

test('a service entry opened between observation and dispatch is not toggled closed', () => {
  const f = fixture();
  f.roots[0].querySelectorAll = query => query.includes('isExpend') ? [{ getClientRects: () => [{}] }] : [f.trigger];
  assert.equal(f.run(true).clicked, false); assert.equal(f.clicks(), 0);
});
