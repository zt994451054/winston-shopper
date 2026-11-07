import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cartRowsScript, validateCartRows } from '../lib/cart-rows.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';
import { cartNode, cartRow, observeCart } from '../test-support/cart-fixture.mjs';

const target = {url:'https://cart.taobao.com/cart.htm'};
const raw = () => observeCart([cartRow().row]);
const inspect = rows => validateCartRows(observeCart(rows), target);

test('only five loaded row positions are read, while later rows are counted without their values', () => {
  const rows = Array.from({length:7}, (_, i) => cartRow(i + 1));
  Object.defineProperty(rows[5].anchor, 'innerText', {get(){throw new Error('Sixth row values must not be read');}});
  const result = inspect(rows.map(item => item.row));
  assert.equal(result.rows.length, 5);
  assert.equal(result.coverage.loaded_rows_seen, 7);
  assert.equal(result.coverage.rows_omitted, 2);
  assert.equal(result.coverage.page_total_rows, null);
  assert.equal(result.coverage.full_cart, false);
});

test('same product in separate rows retains its own quantity and is not deduplicated', () => {
  const a = cartRow(1, {productId:'123',quantity:'1'}), b = cartRow(2, {productId:'123',quantity:'2'});
  const result = inspect([a.row,b.row]);
  assert.deepEqual(result.rows.map(row => row.product_id), ['123','123']);
  assert.deepEqual(result.rows.map(row => row.quantity.value), [1,2]);
  assert.ok(result.rows.every(row => row.row_id === null && row.association.sku_id === null));
});

test('recommendations and account text outside the verified cart root are not returned', () => {
  const recommendation = cartRow(9);
  Object.defineProperty(recommendation.anchor, 'innerText', {get(){throw new Error('Recommendation values are outside scope');}});
  const account = cartNode('account', 'PRIVATE_ACCOUNT');
  Object.defineProperty(account, 'innerText', {get(){throw new Error('Account text is outside scope');}});
  const result = validateCartRows(observeCart([cartRow().row], {additionalRoots:[recommendation.row,account]}), target);
  assert.equal(result.rows.length, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.privacy.account_fields_read, false);
});

test('no loaded rows do not become an empty cart', () => {
  const value = observeCart([]);
  assert.equal(value.state, 'structure_changed');
  assert.throws(() => validateCartRows(value, target), {code:'PAGE_STRUCTURE_CHANGED'});
});

test('ambiguous cart roots and rows outside a direct shop relationship stop', () => {
  assert.equal(observeCart([cartRow().row], {additionalRoots:[cartNode('trade-main-cart-content')]}).state, 'structure_changed');
  const wrapper = cartNode('', '', [cartRow().row]);
  const shop = cartNode('trade-cart-shop-container', '', [wrapper]);
  assert.equal(observeCart([], {shops:[shop]}).state, 'structure_changed');
});

test('changed and known login addresses stop before accessing any document', () => {
  const forbidden = new Proxy({}, {get(){throw new Error('Unexpected page access');}});
  for (const [url,state] of [['https://private.test/PRIVATE','target_changed'],['https://login.taobao.com/?account=PRIVATE','login_required']]) {
    const value = vm.runInNewContext(cartRowsScript(target), {URL,location:{href:url},document:forbidden});
    assert.equal(value.state, state);
    assert.deepEqual(Object.keys(value), ['state']);
  }
});

test('explicit verification gate returns no cart values', () => {
  const verification = cartNode('', '', [], {attributes:{id:'nc_1_wrapper'}});
  const value = observeCart([cartRow().row], {additionalRoots:[verification]});
  assert.equal(value.state, 'verification_required');
  assert.throws(() => validateCartRows(value, target), {code:'VERIFICATION_REQUIRED'});
});

test('ambiguous quantity inputs remain unknown without borrowing a neighboring row', () => {
  const a = cartRow(), b = cartRow(2, {quantity:'7'});
  const extra = cartNode('', '', [], {tagName:'INPUT',type:'number',value:'2',disabled:false});
  extra.parentElement = a.quantityRegion; a.quantityRegion.children.push(extra);
  const result = inspect([a.row,b.row]);
  assert.equal(result.rows[0].quantity.value, null);
  assert.equal(result.rows[0].quantity.verified, false);
  assert.equal(result.rows[1].quantity.value, 7);
});

test('blank, zero, negative and noninteger quantities are never converted or invented', () => {
  for (const value of ['', '0', '-1', '1.5', '1 unit', '1000000000']) assert.equal(inspect([cartRow(1,{quantity:value}).row]).rows[0].quantity.value, null);
});

test('disabled quantity is an observed value, not zero stock or a saleability assertion', () => {
  const item = cartRow(); item.input.disabled = true;
  const row = inspect([item.row]).rows[0];
  assert.equal(row.quantity.value, 1);
  assert.equal(row.quantity.inputs[0].disabled, true);
  assert.equal(row.stock, undefined);
  assert.equal(row.available, undefined);
});

test('static quantity text uses only the supported same-row quantity display', () => {
  const item = cartRow(1, {quantity:'3',displayQuantity:true});
  const row = inspect([item.row]).rows[0];
  assert.equal(row.quantity.value,3);
  assert.equal(row.quantity.source,'same_row_quantity_display');
  assert.equal(row.quantity.inputs.length,0);
  assert.equal(row.quantity.display.text,'3');
});

test('simultaneous input and static quantity sources remain unknown', () => {
  const item=cartRow();item.quantityDisplay.parentElement=item.quantityRegion;item.quantityRegion.children.push(item.quantityDisplay);
  const row=inspect([item.row]).rows[0];
  assert.equal(row.quantity.value,null);assert.equal(row.quantity.verified,false);
});

test('inputs in the price region cannot be mistaken for quantity controls', () => {
  const item=cartRow(1,{quantity:'4',displayQuantity:true});
  item.input.parentElement=item.priceRegion;item.priceRegion.children.push(item.input);
  const row=inspect([item.row]).rows[0];
  assert.equal(row.quantity.value,4);assert.equal(row.quantity.inputs.length,0);
});

test('multiple static quantity displays cannot make a concurrent input look unique', () => {
  const item=cartRow();
  for(const text of ['2','3']){const display=cartNode('quantityNumWrapper--fixture',text);display.parentElement=item.quantityRegion;item.quantityRegion.children.push(display);}
  const row=inspect([item.row]).rows[0];
  assert.equal(row.quantity.value,null);assert.equal(row.quantity.ambiguous,true);
});

test('canonical product identity strips tracking and cannot supply a SKU ID', () => {
  const row = inspect([cartRow().row]).rows[0];
  assert.equal(row.url, 'https://detail.tmall.com/item.htm?id=101');
  assert.equal(row.association.sku_id, null);
  assert.equal(row.association.sku_binding_verified, false);
  assert.equal(row.row_id, null);
});

test('multiple title links return an unknown title instead of taking the first', () => {
  const item = cartRow(), extra = cartNode('', 'Other title', [], {tagName:'A',attributes:{href:'https://detail.tmall.com/item.htm?id=999'}});
  extra.parentElement = item.detail; item.detail.children.push(extra);
  const row = inspect([item.row]).rows[0];
  assert.equal(row.title, null); assert.equal(row.product_id, null);
  assert.ok(row.missing.includes('unique_product_title_link'));
});

test('specification line breaks and truncation remain explicit', () => {
  const value = raw();
  const normal = validateCartRows(value, target).rows[0];
  assert.equal(normal.specification.text, '颜色：蓝\n尺寸：M');
  value.rows[0].specification = {text:'X'.repeat(1000),truncated:true};
  assert.equal(validateCartRows(value,target).rows[0].specification.truncated, true);
  value.rows[0].links[0].title.truncated = true;
  assert.equal(validateCartRows(value,target).rows[0].title, null);
});

test('ambiguous price regions stay unknown rather than using totals or another region', () => {
  const item = cartRow(), extra = cartNode('trade-cart-item-p-q-container','OTHER_TOTAL');
  extra.parentElement = item.row; item.row.children.push(extra);
  const row = inspect([item.row]).rows[0];
  assert.equal(row.price_quantity_region, null);
  assert.equal(row.quantity.value, null);
});

test('mixed row price text is not a verified unit price, total or payment', () => {
  const row = inspect([cartRow().row]).rows[0];
  assert.equal(row.price_quantity_region.text, '￥19.90');
  assert.equal(row.association.display_price_kind_verified, false);
  assert.equal(row.association.payment_verified, false);
  assert.equal(row.unit_price, undefined); assert.equal(row.amount, undefined);
});

test('price labels and reduction components remain separate unclassified observations', () => {
  const item=cartRow();
  const label=cartNode('trade-price-label','平台加补后');label.parentElement=item.price;item.price.children.push(label);
  const reduction=cartNode('trade-price-container','￥2',[cartNode('trade-price-label','距加入降')]);
  reduction.parentElement=item.priceRegion;item.priceRegion.children.push(reduction);
  const row=inspect([item.row]).rows[0];
  assert.equal(row.price_region_observations.items.length,2);
  assert.deepEqual(row.price_region_observations.items.map(p=>p.label.text),['平台加补后','距加入降']);
  assert.ok(row.price_region_observations.items.every(p=>p.kind==='unverified'));
  assert.equal(row.price_region_observations.unit_price_verified,false);
  assert.equal(row.price_region_observations.row_amount_verified,false);
});

test('multiple price labels are not silently assigned by order', () => {
  const item=cartRow();
  for(const text of ['优惠后','其他条件']){const label=cartNode('trade-price-label',text);label.parentElement=item.price;item.price.children.push(label);}
  assert.equal(inspect([item.row]).rows[0].price_region_observations.items[0].label,null);
});

test('more than ten price components remain partial instead of silently complete', () => {
  const item=cartRow();
  for(let i=0;i<12;i++){const price=cartNode('trade-price-container','￥1');price.parentElement=item.priceRegion;item.priceRegion.children.push(price);}
  const row=inspect([item.row]).rows[0];
  assert.equal(row.price_region_observations.items.length,10);
  assert.equal(row.price_region_observations.truncated,true);
  assert.equal(row.price_region_observations.payment_verified,false);
});

test('SVG nodes in the local price subtree use a supported tag representation', () => {
  const item = cartRow(), svg = cartNode('', '', [], {tagName:'svg'});
  svg.parentElement = item.priceQuantity; item.priceQuantity.children.push(svg);
  assert.ok(inspect([item.row]).rows[0].price_quantity_region.nodes.some(node => node.tag === 'SVG'));
});

test('large local price subtrees are truncated to eighty nodes without claiming completeness', () => {
  const item = cartRow();
  for(let i=0;i<90;i++){const node=cartNode('synthetic-price-part','￥1');node.parentElement=item.priceQuantity;item.priceQuantity.children.push(node);}
  const row = inspect([item.row]).rows[0];
  assert.equal(row.price_quantity_region.nodes.length,80);
  assert.equal(row.price_quantity_region.nodes_truncated,true);
});

test('response identity, positions, limits and extra private fields are validated strictly', () => {
  for (const change of [v=>{v.url+='?account=PRIVATE';},v=>{v.account='PRIVATE';},v=>{v.rows[0].position=2;},
    v=>{v.loaded_rows_seen=0;},v=>{v.rows[0].sku_id='invented';},v=>{v.rows[0].quantity_inputs[0].type='password';},
    v=>{v.rows[0].price_quantity.nodes[0].private='PRIVATE';}]) {
    const value=raw();change(value);assert.throws(()=>validateCartRows(value,target),{code:'INVALID_RESPONSE'});
  }
});

test('bridge performs one fixed read on the requested cart tab', async t => {
  const {endpoint,state}=await mockBridge(t);state.metadata=raw();
  const result=await new BrowserBridge(endpoint).readCartRows(41,target);
  assert.equal(result.rows.length,1);assert.deepEqual(state.commands.map(c=>c.action),['eval']);
  assert.equal(state.commands[0].tabId,41);
});

test('invalid local targets and tabs never contact the bridge', async t => {
  const {endpoint,state}=await mockBridge(t);const bridge=new BrowserBridge(endpoint);
  await assert.rejects(bridge.readCartRows(41,{url:'https://private.test/'}),{code:'INVALID_TARGET'});
  await assert.rejects(bridge.readCartRows(0,target),{code:'INVALID_TAB'});
  assert.equal(state.requests.length,0);
});

test('failed native reads are not retried and external errors are not exposed', async t => {
  const {endpoint,state}=await mockBridge(t,{handler({req,res,body}){
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url==='/status'?playwrightStatus():{id:body.id,success:false,error:'PRIVATE_ACCOUNT'}));
  }});
  await assert.rejects(new BrowserBridge(endpoint).readCartRows(41,target),error=>error.code==='BROWSER_COMMAND_FAILED'&&!error.message.includes('PRIVATE'));
  assert.equal(state.commands.length,1);
});
