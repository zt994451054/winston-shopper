import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cartNode as node } from '../test-support/cart-fixture.mjs';
import { detailTarget, observeDetail, statusBanner } from '../test-support/order-detail-fixture.mjs';
import { orderDetailBodyScript, validateOrderDetailBody, validateSavedOrderDetailBody, parseOrderDetailProductUrl } from '../lib/order-detail-body.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

test('printed order-ID guard permits bounded item/status/amount sources without reading contact, payment IDs or account text',()=>{
  const {raw}=observeDetail(),result=validateOrderDetailBody(raw,detailTarget);
  assert.equal(result.printed_order_id_verified,true);assert.equal(result.order_id,'902');assert.equal(result.items.length,3);
  assert.equal(result.items[0].product.url,'https://item.taobao.com/item.htm?id=101');assert.equal(result.items[0].quantity.value,2);
  assert.equal(result.status_observations.current_title,'交易成功');assert.equal(result.amount_observations[0].label_region.text,'实付款');
  assert.equal(result.items[0].price_observations.items[0].text,'￥19.90');assert.equal(result.amount_observations[0].price_observations.items[0].text,'￥59.70');
  assert.equal(result.amount_observations[0].settlement_verified,false);assert.equal(result.coverage.full_order_items_verified,false);
  assert.equal(result.privacy.payment_identifiers_read,false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
test('an address change is detected before any document getter is touched',()=>{
  const document=new Proxy({}, {get(){throw Error('No DOM read on a wrong route');}});
  const raw=vm.runInNewContext(orderDetailBodyScript(detailTarget),{URL,location:{href:detailTarget.url.replace('902','903')},document});
  assert.equal(raw.state,'target_changed');assert.throws(()=>validateOrderDetailBody(JSON.parse(JSON.stringify(raw)),detailTarget),{code:'TARGET_CHANGED'});
});
test('a wrong printed ID blocks every item and price text getter even when its URL matches',()=>{
  const {raw}=observeDetail({orderId:'903',change:f=>{Object.defineProperty(f.items[0].title,'innerText',{get(){throw Error('No items before identity');}});}});
  assert.equal(raw.state,'target_changed');
});
test('leading-zero order IDs remain strings and are never converted to numbers',()=>{
  const target={order_id:'000902',url:detailTarget.url.replace('902','000902')};
  const {raw}=observeDetail({target,url:target.url,orderId:'000902'});assert.equal(validateOrderDetailBody(raw,target).order_id,'000902');
});
test('ten-item cap preserves the loaded count and omitted positions instead of claiming a full order',()=>{
  const result=validateOrderDetailBody(observeDetail({itemCount:13}).raw,detailTarget);assert.equal(result.items.length,10);
  assert.equal(result.coverage.loaded_items_seen,13);assert.equal(result.coverage.items_omitted,3);assert.equal(result.coverage.full_order_items_verified,false);
});
test('a hidden duplicate metadata container is ignored without reading its values',()=>{
  const result=observeDetail({change:f=>{const hidden=node('trade-order-detail-detail-info','PRIVATE',[],{hidden:true});f.right.children.push(hidden);hidden.parentElement=f.right;}}).raw;
  assert.equal(result.state,'observed');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
const unsafe={
  'duplicate normal root':f=>{const duplicate=node('tbpc-order-detail-content-container');f.content.children.push(duplicate);duplicate.parentElement=f.content;},
  'a moved item row':f=>{f.items[0].row.parentElement=f.layout;},
  'duplicate order-ID label':f=>{const duplicate=node('detailInfoContent--fixture','',[node('detailInfoItemLeft--fixture','',[node('detailInfoTitle--fixture','订单编号')]),node('detailInfoItemRightPrint--fixture','902')]);f.meta.children.push(duplicate);duplicate.parentElement=f.meta;},
  'an unknown identity label':f=>{Object.defineProperty(f.idLabel,'innerText',{value:'支付宝交易号'});},
  'a missing current status marker':f=>{f.steps[3].getAttribute=()=>'';},
  'a duplicate current marker':f=>{f.steps[0].getAttribute=()=> 'statusStepItemCurrent--fixture';},
  'a hidden printed ID':f=>{f.printedId.getClientRects=()=>[];},
  'a nested price container':f=>{const nested=node('trade-price-container','￥1');f.items[0].price.children.push(nested);nested.parentElement=f.items[0].price;},
  'a duplicate quantity':f=>{const duplicate=node('quantity--fixture','x3');f.items[0].itemRight.children.push(duplicate);duplicate.parentElement=f.items[0].itemRight;},
  'a moved amount label':f=>{f.amountLabel.parentElement=f.amounts;},
};
for(const[name,change]of Object.entries(unsafe))test(`ambiguous/unsupported ${name} stops without choosing a fallback`,()=>{
  const {raw}=observeDetail({change});assert.notEqual(raw.state,'observed');assert.throws(()=>validateOrderDetailBody(raw,detailTarget));
});
test('missing product/quantity sources stay unknown without inferring values from price or other text',()=>{
  const {raw}=observeDetail({change:f=>{f.items[0].title.getAttribute=name=>name==='href'?'https://mail.example.test/?secret=PRIVATE':name==='class'?'title--fixture':null;
    Object.defineProperty(f.items[0].count,'innerText',{value:'2'});}});
  const item=validateOrderDetailBody(raw,detailTarget).items[0];assert.equal(item.product,null);assert.equal(item.quantity.value,null);assert.equal(item.quantity.verified,false);
  assert.deepEqual(item.missing,['product_link','quantity']);assert.equal(JSON.stringify(item).includes('PRIVATE'),false);
});
test('explicit multiply/count markers are supported; ambiguous, zero or oversized counts remain unknown',()=>{
  for(const [text,value]of [['x3',3],['× 4',4],['数量：5',5],['3件',null],['x0',null],['x9999999999',null]]){
    const {raw}=observeDetail({change:f=>{Object.defineProperty(f.items[0].count,'innerText',{value:text});}});
    assert.equal(validateOrderDetailBody(raw,detailTarget).items[0].quantity.value,value);
  }
});
test('bounded title and information truncation are delivered and do not become a completeness claim',()=>{
  const {raw}=observeDetail({change:f=>{Object.defineProperty(f.items[0].title,'innerText',{value:'a'.repeat(501)});Object.defineProperty(f.items[0].information,'innerText',{value:'b'.repeat(1001)});}});
  const result=validateOrderDetailBody(raw,detailTarget);assert.equal(result.items[0].title_region.truncated,true);assert.equal(result.items[0].item_information.items[0].truncated,true);
  assert.equal(result.coverage.full_order_items_verified,false);assert.equal(validateSavedOrderDetailBody(result,detailTarget),result);
});
test('saved body validation retains the original timestamp without another observation',()=>{
  const saved=validateOrderDetailBody(observeDetail().raw,detailTarget),time=saved.observed_at;
  assert.equal(validateSavedOrderDetailBody(saved,detailTarget),saved);assert.equal(saved.observed_at,time);
});
const forgeries={
  'invented order ID':v=>{v.order_id='903';},
  'false full-order claim':v=>{v.coverage.full_order_items_verified=true;},
  'false actual-payment claim':v=>{v.amount_observations[0].settlement_verified=true;},
  'reassigned item price':v=>{v.items[0].price_observations.items[0].level='order';},
  'guessed quantity':v=>{v.items[0].quantity.value=99;},
  'false current status':v=>{v.status_observations.current_title='退款成功';},
  'added contact data':v=>{v.address='PRIVATE';},
  'a forged product link':v=>{v.items[0].product.product_id='999';},
  'a guessed metadata source':v=>{v.source='account_storage';},
  'removed privacy limitation':v=>{v.privacy.payment_identifiers_read=true;},
};
for(const[name,mutate]of Object.entries(forgeries))test(`saved body refuses ${name}`,()=>{const saved=validateOrderDetailBody(observeDetail().raw,detailTarget);mutate(saved);assert.throws(()=>validateSavedOrderDetailBody(saved,detailTarget),{code:'INVALID_CHECKPOINT'});});
test('the production bridge returns bounded body evidence with one fixed eval and no internal retries',async t=>{
  const server=await mockBridge(t);server.state.metadata=observeDetail().raw;
  const result=await new BrowserBridge(server.endpoint).readOrderDetailBody(41,detailTarget);assert.equal(result.items.length,3);
  assert.equal(server.state.commands.length,1);assert.equal(server.state.commands[0].action,'eval');
  assert.equal(server.state.commands[0].script.includes('collectOrderBody'),true);assert.equal(server.state.commands[0].script.includes('.click('),false);
});
test('invalid body target or tab is rejected before any bridge request',async t=>{
  const server=await mockBridge(t),bridge=new BrowserBridge(server.endpoint);
  await assert.rejects(bridge.readOrderDetailBody(0,detailTarget));await assert.rejects(bridge.readOrderDetailBody(41,{...detailTarget,order_id:'903'}));assert.equal(server.state.requests.length,0);
});
test('observed mobile product title links retain their source path/ID and remove tracking without guessing a desktop equivalent',()=>{
  const {raw}=observeDetail({change:f=>{f.items[0].title.getAttribute=name=>name==='href'?'https://a.m.taobao.com/i00101.htm?from=detail&spm=PRIVATE&mi_id=PRIVATE':name==='class'?'title--fixture':null;}});
  const result=validateOrderDetailBody(raw,detailTarget),item=result.items[0];assert.equal(item.product.product_id,'00101');
  assert.equal(item.product.url,'https://a.m.taobao.com/i00101.htm');assert.equal(item.product_link_navigation_verified,false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(validateSavedOrderDetailBody(result,detailTarget),result);
});
test('mobile product parsing rejects unsafe authorities, ambiguous IDs and unobserved routes without enlarging the general product parser',()=>{
  for(const url of ['http://a.m.taobao.com/i101.htm','https://a.m.taobao.com.example.test/i101.htm','https://user:secret@a.m.taobao.com/i101.htm',
    'https://a.m.taobao.com:444/i101.htm','https://a.m.taobao.com/i101.htm?id=999','https://a.m.taobao.com/i101.htm?itemId=101',
    'https://a.m.taobao.com/item.htm?id=101','https://a.m.taobao.com/i101.html','https://a.m.taobao.com/i%31.htm','https://a.m.taobao.com/i101.htm/extra'])assert.equal(parseOrderDetailProductUrl(url),null);
});
test('same-product positions remain separate instead of deduplicating possible different purchased specifications',()=>{
  const {raw}=observeDetail({change:f=>{for(const item of f.items)item.title.getAttribute=name=>name==='href'?'https://a.m.taobao.com/i101.htm':name==='class'?'title--fixture':null;}});
  const result=validateOrderDetailBody(raw,detailTarget);assert.equal(result.items.length,3);assert.equal(new Set(result.items.map(item=>item.product.product_id)).size,1);
  assert.deepEqual(result.items.map(item=>item.position),[1,2,3]);
});
test('saved mobile-link snapshots reject a fabricated navigation-equivalence proof',()=>{
  const result=validateOrderDetailBody(observeDetail().raw,detailTarget);result.items[0].product_link_navigation_verified=true;
  assert.throws(()=>validateSavedOrderDetailBody(result,detailTarget),{code:'INVALID_CHECKPOINT'});
});
test('the first local body format keeps absent optional navigation fields absent on cache validation',()=>{
  const result=validateOrderDetailBody(observeDetail().raw,detailTarget);for(const item of result.items)delete item.product_link_navigation_verified;
  const original=JSON.stringify(result);assert.equal(validateSavedOrderDetailBody(result,detailTarget),result);assert.equal(JSON.stringify(result),original);
});

test('a closed order shows a status banner instead of progress steps; only its two status texts are read', () => {
  const banner = statusBanner();
  const {raw} = observeDetail({banner});
  assert.equal(raw.state, 'observed'); assert.deepEqual(raw.statuses, []);
  assert.deepEqual(raw.status_banner, {status:{text:'交易关闭',truncated:false}, detail:{text:'合成关闭原因',truncated:false}});
  const result = validateOrderDetailBody(raw, detailTarget);
  assert.deepEqual(result.status_observations, {layout:'status_banner', steps:[],
    banner:{status_region:{text:'交易关闭',truncated:false}, detail_region:{text:'合成关闭原因',truncated:false}},
    current_title:'交易关闭', source:'same_order_status_banner', settlement_verified:false});
  assert.equal(result.privacy.contact_fields_read, false);
  assert.deepEqual(validateSavedOrderDetailBody(structuredClone(result), detailTarget), result);
  const forged = structuredClone(result); forged.status_observations.current_title = '交易成功';
  assert.throws(() => validateSavedOrderDetailBody(forged, detailTarget), {code:'INVALID_CHECKPOINT'});
  // Without a detail line the status alone is still delivered.
  assert.equal(validateOrderDetailBody(observeDetail({banner:statusBanner({detail:null})}).raw, detailTarget).status_observations.banner.detail_region, null);
});

test('an ambiguous or missing status banner remains a structure change', () => {
  const twoTitles = statusBanner();
  twoTitles.title.parentElement.children.push(node('content--fixture', '交易成功', [], {tagName:'SPAN'}));
  twoTitles.title.parentElement.children.at(-1).parentElement = twoTitles.title.parentElement;
  assert.deepEqual(observeDetail({banner:twoTitles}).raw, {state:'structure_changed'});
  const empty = statusBanner(); empty.title.parentElement.children.splice(0);
  assert.deepEqual(observeDetail({banner:empty}).raw, {state:'structure_changed'});
  const raw = observeDetail({banner:statusBanner()}).raw;
  raw.statuses = [{title:{text:'交易成功',truncated:false},current:true,done:false}];
  assert.throws(() => validateOrderDetailBody(raw, detailTarget), {code:'INVALID_RESPONSE'});
});
