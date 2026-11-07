import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBridge } from '../lib/bridge.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawProduct } from '../test-support/product-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { rawReviewCategories, reviewCategoryObservation } from '../test-support/review-category-fixture.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const choice = { group: '颜色分类', option: '黑色' };
const address = { state: 'observed', url: target.url };

async function scenario(t, replies, tabs = []) {
  let index = 0;
  const mock = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs } }));
    const reply = replies[index++];
    res.end(JSON.stringify(reply ? { id: body.id, success: true, data: { result: reply } }
      : { id: body.id, success: false, error: 'PRIVATE_ERROR' }));
  } });
  return { bridge: new BrowserBridge(mock.endpoint), state: mock.state };
}

test('a snapshot missing from currentWindow checks the saved address before one fixed DOM read', async t => {
  const { bridge, state } = await scenario(t, [address, rawProduct()]);
  assert.equal((await bridge.readProduct(41, target)).product_id, '123');
  assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval', 'eval']);
  assert.ok(state.commands.slice(1).every(command => command.tabId === 41));
  assert.ok(!state.commands[1].script.includes('document'));
});

test('a selection missing from currentWindow verifies its exact saved address before dispatch', async t => {
  const { bridge, state } = await scenario(t, [address, { state: 'selection_dispatched', clicked: true, ...choice }]);
  await bridge.selectOption(41, target, choice);
  assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval', 'eval']);
  assert.ok(state.commands.slice(1).every(command => command.tabId === 41));
  assert.ok(!state.commands[1].script.includes('document'));
  assert.ok(state.commands[2].script.includes('.click()'));
});

test('failed or mismatched saved address checks stop before product reading or selection dispatch', async t => {
  for (const method of ['readProduct', 'selectOption', 'readSpecificationImages', 'readSpecificationCollection']) {
    for (const [reply, code] of [[{ state: 'target_changed' }, 'TARGET_CHANGED'],
      [{ state: 'login_required' }, 'LOGIN_REQUIRED'],
      [{ state: 'observed', url: 'https://detail.tmall.com/item.htm?id=999' }, 'INVALID_RESPONSE'],
      [null, 'BROWSER_COMMAND_FAILED']]) {
      const { bridge, state } = await scenario(t, [reply]);
      await assert.rejects(bridge[method](41, target, method === 'selectOption' ? choice : method === 'readSpecificationCollection' ? { inventory: null, positions: null } : undefined), error => {
        assert.equal(error.code, code);
        if (method === 'selectOption') assert.equal(error.actionNotDispatched, true);
        return true;
      });
      assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval']);
    }
  }
});

test('a listed different product is rejected without any fallback address or action command', async t => {
  for (const method of ['readProduct', 'selectOption', 'readSpecificationImages', 'readSpecificationCollection']) {
    const { bridge, state } = await scenario(t, [], [{ id: 41, url: 'https://detail.tmall.com/item.htm?id=999' }]);
    await assert.rejects(bridge[method](41, target, method === 'selectOption' ? choice : method === 'readSpecificationCollection' ? { inventory: null, positions: null } : undefined), { code: 'TARGET_CHANGED' });
    assert.deepEqual(state.commands.map(command => command.action), ['tab_list']);
  }
});

test('navigation after the address probe still fails the in-page product or selection guard', async t => {
  for (const method of ['readProduct', 'selectOption', 'readSpecificationImages', 'readSpecificationCollection']) {
    const { bridge, state } = await scenario(t, [address, { state: 'target_changed' }]);
    await assert.rejects(bridge[method](41, target, method === 'selectOption' ? choice : method === 'readSpecificationCollection' ? { inventory: null, positions: null } : undefined), { code: 'TARGET_CHANGED' });
    assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval', 'eval']);
  }
});

test('an uncertain selection response after a valid saved address is never retried or declared undispatched', async t => {
  const { bridge, state } = await scenario(t, [address, null]);
  await assert.rejects(bridge.selectOption(41, target, choice), error => {
    assert.equal(error.code, 'BROWSER_COMMAND_FAILED');
    assert.notEqual(error.actionNotDispatched, true);
    return true;
  });
  assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval', 'eval']);
});

test('service expansion uses the saved-address guard before dispatch outside currentWindow', async t => {
  const {bridge, state} = await scenario(t, [address, {state: 'action_dispatched', clicked: true}]);
  assert.equal((await bridge.expandServices(41, target, ['7天无理由退货'])).clicked, true);
  assert.deepEqual(state.commands.map(c => c.action), ['tab_list', 'eval', 'eval']);
  assert.ok(state.commands.slice(1).every(c => c.tabId === 41));
});

test('service expansion refuses changed addresses or page gates without confusing them with lost replies', async t => {
  for (const replies of [[{state: 'target_changed'}], [address, {state: 'verification_required'}]]) {
    const {bridge} = await scenario(t, replies);
    await assert.rejects(bridge.expandServices(41, target, ['7天无理由退货']), error => {
      assert.equal(error.actionNotDispatched, true);return true;
    });
  }
});

test('service expansion keeps uncertain command failures ambiguous and does not retry', async t => {
  const {bridge, state} = await scenario(t, [address, null]);
  await assert.rejects(bridge.expandServices(41, target, ['7天无理由退货']), error => {
    assert.equal(error.code, 'BROWSER_COMMAND_FAILED');assert.notEqual(error.actionNotDispatched, true);return true;
  });
  assert.equal(state.commands.length, 3);
});

test('reviews check the exact saved address before reads or expansion outside currentWindow', async t => {
  for (const [method, response] of [['readReviews', {state:'action_required'}], ['expandReviews', {state:'action_dispatched',clicked:true}]]) {
    const {bridge,state} = await scenario(t,[address,response]);
    await bridge[method](41,target);
    assert.deepEqual(state.commands.map(c=>c.action),['tab_list','eval','eval']);
    assert.ok(state.commands.slice(1).every(c=>c.tabId===41));
    assert.ok(!state.commands[1].script.includes('document'));
  }
});

test('review target guards distinguish a failed address, a page gate and an uncertain action response', async t => {
  for (const method of ['readReviews','expandReviews']) {
    for (const [replies,code] of [[[{state:'target_changed'}],'TARGET_CHANGED'],
      [[address,{state:'verification_required'}],'VERIFICATION_REQUIRED'],[[address,null],'BROWSER_COMMAND_FAILED']]) {
      const {bridge,state}=await scenario(t,replies);
      await assert.rejects(bridge[method](41,target),error=>{
        assert.equal(error.code,code);
        if(method==='expandReviews') assert.equal(error.actionNotDispatched,code==='BROWSER_COMMAND_FAILED'?undefined:true);
        return true;
      });
      assert.equal(state.commands.length,replies.length+1);
    }
    const {bridge,state}=await scenario(t,[],[{id:41,url:'https://detail.tmall.com/item.htm?id=999'}]);
    await assert.rejects(bridge[method](41,target),{code:'TARGET_CHANGED'});
    assert.equal(state.commands.length,1);
  }
});

test('text review reads and category or panel actions verify saved addresses outside the current window', async t => {
  const before = reviewCategoryObservation(target).snapshot;
  for (const [method, reply] of [['readReviewCategories', rawReviewCategories(target)],
    ['selectReviewCategory', { state: 'action_dispatched', clicked: true }], ['openReviewPanel', { state: 'action_dispatched', clicked: true }]]) {
    const { bridge, state } = await scenario(t, [address, reply]);
    await bridge[method](41, target, before, '追评');
    assert.deepEqual(state.commands.map(command => command.action), ['tab_list', 'eval', 'eval']);
    assert.ok(!state.commands[1].script.includes('document'));
    assert.ok(state.commands.slice(1).every(command => command.tabId === 41));
  }
});

test('text review actions reject target changes and gates, while unknown replies stay ambiguous', async t => {
  const before = reviewCategoryObservation(target).snapshot;
  for (const method of ['selectReviewCategory', 'openReviewPanel']) {
    for (const [replies, code] of [[[{ state: 'target_changed' }], 'TARGET_CHANGED'],
      [[address, { state: 'verification_required' }], 'VERIFICATION_REQUIRED'], [[address, null], 'BROWSER_COMMAND_FAILED']]) {
      const { bridge, state } = await scenario(t, replies);
      await assert.rejects(bridge[method](41, target, before, '追评'), error => {
        assert.equal(error.code, code);
        assert.equal(error.actionNotDispatched, code === 'BROWSER_COMMAND_FAILED' ? undefined : true);
        return true;
      });
      assert.equal(state.commands.length, replies.length + 1);
    }
  }
});
