import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cartNode } from '../test-support/cart-fixture.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { orderDetailPageScript, validateOrderDetailPage } from '../lib/order-detail-page.mjs';

const target = { url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=123', order_id:'123' };
const forbidden = node => Object.defineProperty(node, 'innerText', { get() { throw Error('Unrelated/private text must not be read'); } });
function panel({ hidden=false, title='页面出错了', subtitle='请稍后再试' } = {}) {
  const titleNode = cartNode('trade-error-title', title), subtitleNode = cartNode('trade-error-subtitle', subtitle);
  const left = cartNode('trade-error-content-left', '', [titleNode, subtitleNode]);
  const content = cartNode('trade-error-content', '', [left]);
  return { root:cartNode('trade-error-container','',[content],{hidden}), content, left, title:titleNode, subtitle:subtitleNode };
}
function observe(roots=[], { url=target.url, decorate=()=>{}, loading=false } = {}) {
  const profile = forbidden(cartNode('site-nav-user','PRIVATE'));
  const contact = forbidden(cartNode('contact-information','PRIVATE'));
  const document = forbidden(cartNode('','',[...roots,profile,contact]));
  document.body = document; document.title = 'Synthetic order'; document.readyState = loading ? 'loading' : 'complete';
  decorate(document);
  const raw = vm.runInNewContext(orderDetailPageScript(target), { URL, document, location:{href:url},
    getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'}) });
  return JSON.parse(JSON.stringify(raw));
}

test('visible error panel is read through its unique local relationship while hidden/contact/account text is untouched', () => {
  const hidden = panel({hidden:true}); forbidden(hidden.title); forbidden(hidden.subtitle);
  const result = validateOrderDetailPage(observe([hidden.root,panel().root]),target);
  assert.equal(result.page_state,'error'); assert.equal(result.error_roots_seen,2);
  assert.equal(result.error_page.title_region.text,'页面出错了'); assert.equal(result.error_page.source_relationship_verified,true);
  assert.equal(result.error_page.cause_verified,false); assert.equal(result.route_order_binding_verified,true);
  for (const key of ['printed_order_id_verified','account_identity_verified','order_fields_read','normal_detail_layout_verified','settlement_verified']) assert.equal(result[key],false);
  assert.deepEqual(result.privacy,{local_only:true,contact_fields_read:false,account_profile_read:false});
});

test('absence of a visible supported error panel stays unassessed without reading order fields', () => {
  const hidden = panel({hidden:true}); forbidden(hidden.title); forbidden(hidden.subtitle);
  for (const roots of [[],[hidden.root]]) {
    const result = validateOrderDetailPage(observe(roots),target);
    assert.equal(result.page_state,'not_assessed'); assert.equal(result.error_page,null); assert.equal(result.order_fields_read,false);
  }
});

test('changed detail ID fails before any document access', () => {
  const raw = vm.runInNewContext(orderDetailPageScript(target), {URL,location:{href:target.url.replace('=123','=124')},
    get document() { throw Error('Changed pages must never be inspected'); } });
  assert.throws(()=>validateOrderDetailPage(raw,target),{code:'TARGET_CHANGED'});
});

test('loading and explicit user verification remain stop gates without reading the error heading', () => {
  const shown = panel(); forbidden(shown.title);
  assert.throws(()=>validateOrderDetailPage(observe([shown.root],{loading:true}),target),{code:'PAGE_LOADING'});
  assert.throws(()=>validateOrderDetailPage(observe([shown.root],{decorate:document=>{
    const query=document.querySelectorAll.bind(document);
    document.querySelectorAll=selector=>selector.includes('#nc_1_wrapper')?[cartNode()]:query(selector);
  }}),target),{code:'VERIFICATION_REQUIRED'});
});

test('two visible error roots are ambiguous rather than selected by document order', () => {
  const first=panel(), second=panel(); forbidden(first.title); forbidden(second.title);
  assert.throws(()=>validateOrderDetailPage(observe([first.root,second.root]),target),{code:'PAGE_STRUCTURE_CHANGED'});
});

for (const change of ['missing_subtitle','duplicate_title','nested_title','different_parent']) {
  test('unsupported heading relationship stops without a broad text fallback: '+change,()=>{
    const value=panel(); forbidden(value.title);
    if(change==='missing_subtitle')value.left.children.splice(1,1);
    if(change==='duplicate_title')value.left.children.push(cartNode('trade-error-title','Synthetic duplicate'));
    if(change==='nested_title')value.title.parentElement=cartNode('unexpected-wrapper');
    if(change==='different_parent')value.subtitle.parentElement=value.content;
    assert.throws(()=>validateOrderDetailPage(observe([value.root]),target),{code:'PAGE_STRUCTURE_CHANGED'});
  });
}

test('an empty error title is a structure failure and never a successful normal detail',()=>{
  assert.throws(()=>validateOrderDetailPage(observe([panel({title:' '}).root]),target),{code:'PAGE_STRUCTURE_CHANGED'});
});

test('error text is bounded with explicit truncation and never classifies a network or risk-control cause',()=>{
  const result=validateOrderDetailPage(observe([panel({title:'A'.repeat(301),subtitle:'B'.repeat(1001)}).root]),target);
  assert.deepEqual(result.error_page.title_region,{text:'A'.repeat(300),truncated:true});
  assert.deepEqual(result.error_page.subtitle_region,{text:'B'.repeat(1000),truncated:true});
  assert.equal(result.error_page.cause_verified,false);
});

for (const change of ['private_extra','forged_assessment','missing_error','empty_error','malformed_truncation','wrong_id','unclassified_gate']) {
  test('untrusted page-state response rejects unsupported evidence: '+change,()=>{
    let raw=observe([panel().root]);
    if(change==='private_extra')raw.contact='PRIVATE';
    if(change==='forged_assessment')raw.normal_detail_layout_verified=true;
    if(change==='missing_error')raw.error_page=null;
    if(change==='empty_error')raw.error_roots_seen=0;
    if(change==='malformed_truncation')raw.error_page.title.truncated=true;
    if(change==='wrong_id')raw.address.order_id='124';
    if(change==='unclassified_gate')raw={state:'unknown'};
    assert.throws(()=>validateOrderDetailPage(raw,target),{code:'INVALID_RESPONSE'});
  });
}

test('unassessed responses cannot carry error headings',()=>{
  const raw=observe([panel().root]); raw.page_state='not_assessed';
  assert.throws(()=>validateOrderDetailPage(raw,target),{code:'INVALID_RESPONSE'});
});

test('page-state bridge makes one fixed read, preserves error evidence and does not retry or navigate',async t=>{
  const server=await mockBridge(t), bridge=new BrowserBridge(server.endpoint);server.state.metadata=observe([panel().root]);
  assert.equal((await bridge.readOrderDetailPageState(41,target)).page_state,'error');
  assert.deepEqual(server.state.commands.map(command=>command.action),['eval']);
  server.state.metadata={state:'structure_changed'};
  await assert.rejects(bridge.readOrderDetailPageState(41,target),{code:'PAGE_STRUCTURE_CHANGED'});
  assert.equal(server.state.commands.length,2);
});

test('invalid page-state target/tab fails before connection and IO',async t=>{
  const server=await mockBridge(t), bridge=new BrowserBridge(server.endpoint);
  await assert.rejects(bridge.readOrderDetailPageState(41,{...target,order_id:'124'}),{code:'INVALID_TARGET'});
  await assert.rejects(bridge.readOrderDetailPageState(0,target),{code:'INVALID_TAB'});
  assert.equal(server.state.requests.length,0);
});
