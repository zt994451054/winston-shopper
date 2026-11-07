import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cartNode as node } from '../test-support/cart-fixture.mjs';
import { orderGroup, orderTarget } from '../test-support/order-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { orderDetailEntryScript, validateOrderDetailEntry, orderDetailEntryReference } from '../lib/order-detail-entry.mjs';

const detail = { order_id:'902', url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=902' };
function observe(change = () => {}, url = orderTarget.url) {
  const first = orderGroup(1), second = orderGroup(2);
  second.detailLink.getAttribute = name => name === 'href' ? detail.url : name === 'target' ? '_blank' : name === 'class' ? 'shopInfoOrderDetail--fixture' : null;
  second.detailLink.getBoundingClientRect = () => ({left:10,right:50,top:10,bottom:30,width:40,height:20});
  second.detailLink.click = () => { throw Error('Preparation must never click'); };
  const root = node('trade-content-container', '', [first.group,second.group]), main = node('trade-main-content', '', [root]);
  const privateRegion = node('account-profile', '');
  Object.defineProperty(privateRegion, 'innerText', {get() {throw Error('No account text');}});
  for (const group of [first,second]) for (const item of group.items) {
    Object.defineProperty(item.titleText, 'innerText', {get() {throw Error('No item text');}});
  }
  const document = node('', '', [main,privateRegion]);
  document.readyState = 'complete'; document.title = 'Synthetic list'; document.elementFromPoint = () => second.detailLink;
  change({first,second,root,main,document});
  const raw = vm.runInNewContext(orderDetailEntryScript(orderTarget,detail,2), { URL,document,location:{href:url},innerWidth:800,innerHeight:600,
    getComputedStyle:value => ({display:value.hidden?'none':'block',visibility:'visible'}) });
  return JSON.parse(JSON.stringify(raw));
}
const prepared = () => validateOrderDetailEntry(observe(),orderTarget,detail,2);
const reference = before => ({url:before.list_url,snapshotData:{refs:{e7:{role:'link',name:'订单详情',backendDOMNodeId:77}}}});

test('production preparation reads only the exact matching header and never clicks or reads account/items', () => {
  const before = prepared(); assert.equal(before.order_id,'902'); assert.equal(before.position,2);
  assert.equal(before.loaded_groups_seen,2); assert.equal(before.entry_text,'订单详情'); assert.equal(before.target_attribute,'_blank');
  assert.match(before.selector,/:nth-child\(2\)/);
});

test('generated selector uses the actual DOM child ordinal rather than assuming the order ordinal equals nth-child', () => {
  const before = validateOrderDetailEntry(observe(({root}) => root.children.unshift(node('non-order-divider'))),orderTarget,detail,2);
  assert.match(before.selector,/:nth-child\(3\)/); assert.equal(before.position,2);
});

test('changed list identity stops before any DOM access', () => {
  const raw = vm.runInNewContext(orderDetailEntryScript(orderTarget,detail,2), {URL,location:{href:'https://mail.example.test/'},
    get document() {throw Error('No unrelated DOM');}});
  assert.throws(() => validateOrderDetailEntry(raw,orderTarget,detail,2), {code:'TARGET_CHANGED'});
});

for (const change of ['id','href','extra_parameter','label','target','duplicate_entry','offscreen','obstruction','disabled']) {
  test('unsafe or changed header cannot produce a click preparation: '+change, () => {
    const raw = observe(({second,document}) => {
      if (change === 'id') Object.defineProperty(second.id,'innerText',{value:'订单号：999'});
      if (['href','extra_parameter','target','disabled'].includes(change)) {
        const get = second.detailLink.getAttribute;
        second.detailLink.getAttribute = name => name === 'href' && change === 'href' ? detail.url.replace('902','999')
          : name === 'href' && change === 'extra_parameter' ? detail.url+'&extra=PRIVATE'
          : name === 'target' && change === 'target' ? '_self'
          : name === 'aria-disabled' && change === 'disabled' ? 'true' : get(name);
      }
      if (change === 'label') Object.defineProperty(second.detailLink,'innerText',{value:'确认收货'});
      if (change === 'duplicate_entry') {
        const duplicate = node('shopInfoOrderDetail--fixture','订单详情',[],{tagName:'A'});
        duplicate.parentElement = second.header; second.header.children.push(duplicate);
      }
      if (change === 'offscreen') second.detailLink.getBoundingClientRect = () => ({left:10,right:50,top:1000,bottom:1020,width:40,height:20});
      if (change === 'obstruction') document.elementFromPoint = () => node('dialog');
    });
    assert.notEqual(raw.state,'entry_prepared'); assert.throws(() => validateOrderDetailEntry(raw,orderTarget,detail,2));
  });
}

test('caller-provided selectors and identity claims cannot enter the preparation contract', () => {
  const before = prepared();
  for (const bad of [{...before,selector:'body'}, {...before,selector:before.selector.replace('(2)','(2001)')},
    {...before,order_id:'999'}, {...before,account:'PRIVATE'}, {...before,loaded_groups_seen:1}]) {
    assert.throws(() => validateOrderDetailEntry(bad,orderTarget,detail,2), {code:'INVALID_RESPONSE'});
  }
  for (const position of [0,51,1.5,'2']) assert.throws(() => orderDetailEntryScript(orderTarget,detail,position), {code:'INVALID_ARGUMENTS'});
});

test('only one current link reference with the exact name and backend DOM identity is accepted', () => {
  const before = prepared(), data = reference(before); assert.equal(orderDetailEntryReference(data,before),'e7');
  for (const bad of [{...data,url:'https://mail.example.test/'}, {...data,snapshotData:{refs:{}}},
    {...data,snapshotData:{refs:{e7:{role:'link',name:'确认收货',backendDOMNodeId:77}}}},
    {...data,snapshotData:{refs:{e7:{role:'link',name:'订单详情',backendDOMNodeId:0}}}},
    {...data,snapshotData:{refs:{e7:data.snapshotData.refs.e7,e8:data.snapshotData.refs.e7}}}]) assert.throws(() => orderDetailEntryReference(bad,before));
});

async function entryServer(t, {changed=false,badReference=false,badClick=false} = {}) {
  const before = prepared(); let evaluations = 0;
  const server = await mockBridge(t, { handler:({req,res,body}) => {
    res.setHeader('Content-Type','application/json');
    if (req.url === '/status') { res.end(JSON.stringify(playwrightStatus())); return; }
    let data;
    if (body.action === 'eval') { evaluations++; data = {result:changed && evaluations === 2 ? {...before,loaded_groups_seen:3} : before}; }
    else if (body.action === 'snapshot') data = badReference ? {...reference(before),snapshotData:{refs:{}}} : reference(before);
    else if (body.action === 'click') data = {role:'link',name:badClick?'unconfirmed':'订单详情'};
    res.end(JSON.stringify({id:body.id,success:true,data}));
  } });
  return {server,before,bridge:new BrowserBridge(server.endpoint)};
}

test('native click uses fresh scoped reference with two guards and never evaluates DOM click or asserts navigation', async t => {
  const {server,before,bridge} = await entryServer(t);
  const result = await bridge.openOrderDetailEntry(41,orderTarget,detail,before);
  assert.deepEqual(result,{clicked:true,navigation_verified:false});
  assert.deepEqual(server.state.commands.map(command => command.action),['eval','snapshot','eval','click']);
  assert.equal(server.state.commands[1].selector,before.selector); assert.equal(server.state.commands[3].ref,'e7');
  assert.ok(server.state.commands.filter(command => command.action === 'eval').every(command => !command.script.includes('.click(')));
});

test('JSON key ordering cannot cause a false entry change', async t => {
  const {before,bridge} = await entryServer(t);
  const reordered = Object.fromEntries(Object.entries(before).reverse());
  assert.equal((await bridge.openOrderDetailEntry(41,orderTarget,detail,reordered)).clicked,true);
});

for (const failure of ['changed','badReference']) {
  test('preparation failure is explicitly undispatched and never sends click: '+failure, async t => {
    const {server,before,bridge} = await entryServer(t,{[failure]:true});
    await assert.rejects(bridge.openOrderDetailEntry(41,orderTarget,detail,before), error => error.actionNotDispatched === true);
    assert.equal(server.state.commands.some(command => command.action === 'click'),false);
  });
}

test('uncertain click reply is not marked undispatched and must not retry', async t => {
  const {server,before,bridge} = await entryServer(t,{badClick:true});
  await assert.rejects(bridge.openOrderDetailEntry(41,orderTarget,detail,before), error => error.code === 'INVALID_RESPONSE' && error.actionNotDispatched !== true);
  assert.equal(server.state.commands.filter(command => command.action === 'click').length,1);
});

test('invalid tab and target fail before any native backend request', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  await assert.rejects(bridge.inspectOrderDetailEntry(0,orderTarget,detail,2), {code:'INVALID_TAB'});
  await assert.rejects(bridge.inspectOrderDetailEntry(41,orderTarget,{...detail,order_id:'999'},2), {code:'INVALID_TARGET'});
  assert.equal(server.state.requests.length,0);
});

test('a header link carrying one analytics spm value after an earlier click is still the same entry; other extras are not', () => {
  // Live 2026-10-12: after the first click, Taobao's analytics script appended spm=... to that one header link only.
  const withHref = href => observe(({second}) => {
    const get = second.detailLink.getAttribute;
    second.detailLink.getAttribute = name => name === 'href' ? href : get(name);
  });
  const tracked = withHref(`${detail.url}&spm=a1z09.2.0.0.67002e8dSynthetic`);
  assert.equal(tracked.state, 'entry_prepared');
  assert.equal(validateOrderDetailEntry(tracked, orderTarget, detail, 2).order_id, '902');
  for (const href of [`${detail.url}&spm=a&spm=b`, `${detail.url}&spm=a&extra=1`, `${detail.url}&spm=a#section`, `${detail.url}&spm=${'x'.repeat(201)}`]) {
    assert.notEqual(withHref(href).state, 'entry_prepared', href);
  }
});

test('an unsafe header reports a fixed reason so a stopped entry can be diagnosed without another probe', () => {
  const cases = {
    outside_viewport: ({second}) => { second.detailLink.getBoundingClientRect = () => ({left:10,right:50,top:1000,bottom:1020,width:40,height:20}); },
    obstructed: ({document}) => { document.elementFromPoint = () => node('dialog'); },
    link_attributes: ({second}) => { const get = second.detailLink.getAttribute; second.detailLink.getAttribute = name => name === 'target' ? '_self' : get(name); },
  };
  for (const [reason, change] of Object.entries(cases)) {
    const raw = observe(change);
    assert.deepEqual(raw, {state:'unsupported', reason});
    assert.throws(() => validateOrderDetailEntry(raw, orderTarget, detail, 2), error => error.code === 'UNSUPPORTED_CAPABILITY' && error.entryReason === reason);
  }
  assert.throws(() => validateOrderDetailEntry({state:'unsupported', reason:'free text'}, orderTarget, detail, 2), {code:'INVALID_RESPONSE'});
});
