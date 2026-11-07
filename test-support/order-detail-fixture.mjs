import vm from 'node:vm';
import { cartNode as node } from './cart-fixture.mjs';
import { orderDetailBodyScript } from '../lib/order-detail-body.mjs';

/** Synthetic order detail identity, never a real account or order. */
export const detailTarget = {url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=902',order_id:'902'};
/** Synthetic detail item with independent title, information, quantity and price sources. */
export function detailItem(position = 1, {quantity = 'x2'} = {}) {
  const title = node('title--fixture', `Synthetic detail item ${position}`, [], {tagName:'A',attributes:{href:`https://item.taobao.com/item.htm?id=${100+position}&tracking=PRIVATE`}});
  const information = node('infoContent--fixture', '颜色：合成蓝色 / 尺码：合成M');
  const itemLeft = node('baseInfoLeft--fixture', '', [node('', '', [title], {tagName:'SPAN'}),node('info--fixture','',[information])]);
  const price = node('trade-price-container', '￥19.90');
  const count = node('quantity--fixture', quantity);
  const itemRight = node('baseInfoRight--fixture', '', [price,count]);
  const base = node('baseInfo--fixture', '', [itemLeft,itemRight]),content = node('content--fixture','',[base]);
  const row = node('trade-order-detail-order-info', '', [content]);
  return {row,title,information,itemLeft,itemRight,price,count,base,content};
}
/** Synthetic supported normal layout plus contact/payment-value getters that must never be read. */
/**
 * Synthetic closed-order banner (live 2026-10-12 shape): status and detail texts, plus an address/contact block and action
 * buttons whose text getters throw, proving the collector never reads or clicks them.
 */
export function statusBanner({status = '交易关闭', detail = '合成关闭原因'} = {}) {
  const guarded = (classes, label) => {
    const value = node(classes, '');
    Object.defineProperty(value, 'innerText', {get(){throw Error(`No ${label} text`);}});
    value.click = () => { throw Error(`No ${label} click`); };
    return value;
  };
  const title = node('content--fixture', status, [], {tagName:'SPAN'});
  const subtitle = detail === null ? null : node('subContent--fixture', detail, [], {tagName:'SPAN'});
  const address = node('logisticsAddress--fixture', '', [node('addressItem--fixture', '', [guarded('', 'address'), guarded('userInfo--fixture', 'contact')])]);
  const operations = node('operations--fixture', '', [guarded('trade-button btn--fixture', 'button')]);
  const inner = node('trade-container type-of-normal py-24', '', [node('', '', [title, ...(subtitle ? [subtitle] : [])]), address, operations]);
  return {root:node('trade-container type-of-normal', '', [inner]), title, subtitle, address, operations};
}
export function detailLayout({itemCount = 3, orderId = '902', banner = null} = {}) {
  const printedId = node('detailInfoItemRightPrint--fixture', orderId, [], {tagName:'A'});
  const idLabel = node('detailInfoTitle--fixture','订单编号');
  const idRow = node('detailInfoContent--fixture','',[node('detailInfoItemLeft--fixture','',[idLabel]),printedId]);
  const privateRows = ['收货信息','支付宝交易号','支付方式'].map(label => {
    const value = node('detailInfoItemRightPrint--fixture','');
    Object.defineProperty(value,'innerText',{get(){throw Error('No contact/payment values');}});
    return node('detailInfoContent--fixture','',[node('detailInfoItemLeft--fixture','',[node('detailInfoTitle--fixture',label)]),value]);
  });
  const meta = node('trade-order-detail-detail-info','',[idRow,...privateRows]);
  const amountLabel = node('detailInfoItemLeftPrint--fixture','实付款');
  const amountPrice = node('trade-price-container','￥59.70');
  const amountRow = node('detailInfoContent--fixture','',[amountLabel,amountPrice]);
  const amounts = node('trade-order-detail-settlement-info','',[node('', '', [amountRow])]);
  const right = node('tbpc-order-detail-main-right-content-container','',[amounts,meta]);
  const steps = ['提交订单','付款','发货','交易成功'].map((label,index) => {
    const title = node('statusStepItemTitle--fixture',label);
    return node(`statusStepItem--fixture ${index===3?'statusStepItemCurrent--fixture':'statusStepItemDone--fixture'}`,'',[title]);
  });
  const status = node('statusStep--fixture','',steps);
  const shopName = node('shopInfoName--fixture','Synthetic detail shop',[],{tagName:'A'}),shop=node('trade-order-detail-shop-info','',[shopName]);
  const items = Array.from({length:itemCount},(_,index)=>detailItem(index+1));
  const left = node('tbpc-order-detail-main-left-content-container','',[banner ? banner.root : node('progress-wrapper','',[status]),shop,...items.map(item=>item.row)]);
  const layout = node('tbpc-order-detail-main-content-container','',[left,right]);
  const overall = node('tbpc-order-detail-content-container','',[layout]);
  const content = node('trade-content-container','',[overall]),main=node('trade-main-content','',[content]);
  const account = node('account-profile','');Object.defineProperty(account,'innerText',{get(){throw Error('No account text');}});
  const document = node('', '', [main,account]);document.readyState='complete';document.title='Synthetic detail';
  return {document,main,content,overall,layout,left,right,meta,idRow,idLabel,printedId,privateRows,amounts,amountRow,amountLabel,amountPrice,status,steps,shopName,items};
}
/** Run the fixed collector in a synthetic DOM. @returns {object} Raw result and mutable fixture; no browser access. */
export function observeDetail({change = () => {}, url = detailTarget.url, target = detailTarget, ...options} = {}) {
  const fixture = detailLayout(options);change(fixture);
  const raw = vm.runInNewContext(orderDetailBodyScript(target),{URL,location:{href:url},document:fixture.document,
    getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'})});
  return {raw:JSON.parse(JSON.stringify(raw)),fixture};
}
