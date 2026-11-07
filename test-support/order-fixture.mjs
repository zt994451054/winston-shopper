import vm from 'node:vm';
import { cartNode as node } from './cart-fixture.mjs';
import { orderRowsScript, orderBatchScript } from '../lib/order-rows.mjs';
import { orderPageScript } from '../lib/order-page-view.mjs';

/** Synthetic buyer-list route; no real account, IDs, titles or prices. */
export const orderTarget = { url: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm' };
/** Synthetic scoped item with deliberately different item and order amount text. */
export function orderItem(position = 1) {
  const titleText = node('titleText--fixture', `Synthetic item ${position}`);
  const anchor = node('title--fixture', '', [titleText, node('titleSnapshot--fixture', '交易快照')],
    { tagName: 'A', attributes: { href: `https://item.taobao.com/item.htm?id=${100 + position}&mi_id=PRIVATE` } });
  const information = node('infoContent--fixture', '合成蓝色 / 合成尺寸');
  const content = node('itemInfoColItem--fixture', '', [anchor, information, node('operate--fixture', '申请售后')]);
  const quantity = node('quantity--fixture', 'x2');
  const price = node('trade-price-container', '￥19.90');
  const column = node('itemInfoColPrice--fixture', '', [price, quantity]);
  return { item: node('trade-bought-list-order-info', '', [content, column]), anchor, titleText, information, quantity, content, column, price };
}
/** Synthetic order header, direct item/payment columns and an excluded recommendation. */
export function orderGroup(position = 1, { itemCount = 1, orderId = String(900 + position), tmall = false } = {}) {
  const time = node('shopInfoOrderTime--fixture', '2026-01-01');
  const id = node('shopInfoOrderId--fixture', `订单号：${orderId}`);
  const shop = node('shopInfoName--fixture', 'Synthetic shop');
  const status = node('shopInfoStatus--fixture', position === 1 ? '交易关闭' : '交易成功');
  const href = tmall ? `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${orderId}&secret=PRIVATE`
    : `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${orderId}&secret=PRIVATE`;
  const detailLink = node('shopInfoOrderDetail--fixture', '订单详情', [], { tagName: 'A', attributes: { href } });
  const header = node('trade-bought-list-shop-info', '', [time, id, shop, status, detailLink]);
  const items = Array.from({ length: itemCount }, (_, index) => orderItem(index + 1));
  const detail = node('trade-bought-col-order-detail', '', items.map(value => value.item));
  const paymentLabel = node('trade-price-label', '实付款');
  const paymentPrice = node('trade-price-container', '￥39.80', [paymentLabel]);
  const payment = node('trade-bought-col-order-payment', '', [paymentPrice]);
  const columns = node('trade-container-orderColContainer', '', [detail, payment, node('trade-bought-col-order-operations', '确认收货')]);
  const recommendation = node('extItems--fixture', 'PRIVATE_RECOMMENDATION', [node('titleText--fixture', '推荐商品')]);
  const group = node('trade-bought-list-order-container', '', [header, columns, recommendation]);
  return { group, header, id, time, shop, status, detailLink, items, detail, payment, paymentLabel, paymentPrice, columns, recommendation };
}
/** Run the fixed production collector in a synthetic DOM; never opens a browser. */
export function observeOrders(groups, { url = orderTarget.url, extras = [], decorate = () => {}, loading = false, plan = null } = {}) {
  const root = node('trade-content-container', '', groups), main = node('trade-main-content', '', [root]);
  const outside = node('account-profile', 'PRIVATE_PROFILE');
  Object.defineProperty(outside, 'innerText', { get() { throw new Error('Account text must not be read'); } });
  const document = node('', '', [main, outside, ...extras]);
  document.body = document; document.readyState = loading ? 'loading' : 'complete'; document.title = 'Synthetic buyer list';
  decorate({ document, root, main });
  const value = vm.runInNewContext(plan ? orderBatchScript(orderTarget, plan) : orderRowsScript(orderTarget), { URL, location: { href: url }, document,
    getComputedStyle: value => ({ display: value.hidden ? 'none' : 'block', visibility: 'visible' }) });
  return JSON.parse(JSON.stringify(value));
}

/**
 * Synthetic antd pager: previous, the first five page numbers, a jump marker, the last page, next, and a page jumper.
 * @param {{onNext?: Function}} [options] Called when the next control is clicked.
 */
export function orderPager(page, total, { onNext = () => {} } = {}) {
  const item = number => node(`ant-pagination-item ant-pagination-item-${number}${number === page ? ' ant-pagination-item-active' : ''}`,
    String(number), [], { tagName: 'LI', attributes: { title: String(number) } });
  const listed = [...new Set([...Array.from({ length: Math.min(5, total) }, (_, index) => index + 1), page, total])].sort((a, b) => a - b);
  const control = (name, disabled, fields = {}) => node(`ant-pagination-${name}${disabled ? ' ant-pagination-disabled' : ''}`, '',
    [node('ant-pagination-item-link', '', [], { tagName: 'BUTTON' })], { tagName: 'LI', attributes: { 'aria-disabled': String(disabled) }, ...fields });
  const next = control('next', page === total, { click: onNext });
  const pager = node('ant-pagination pagination--fixture', '', [control('prev', page === 1), ...listed.map(item),
    ...(total > 5 ? [node('ant-pagination-jump-next', '•••', [], { tagName: 'LI' })] : []), next,
    node('ant-pagination-options', '到页', [node('', '', [], { tagName: 'INPUT', value: '' })], { tagName: 'LI' })], { tagName: 'UL' });
  return { pager, next, container: node('paginationContainer--fixture', '', [pager]) };
}

/** Synthetic status tabs and order search box; `search` is the typed text, which collectors must never return. */
export function orderListView({ tab = '所有订单', search = '' } = {}) {
  const tabs = ['所有订单', '待付款', '待发货', '待收货', '待评价', '分阶段', '回收站'].map(label =>
    node(`tabItem--fixture${label === tab ? ' tabItemHighlight--fixture' : ''}`, '', [node('', label)]));
  const header = node('tabsContainer--fixture trade-bought-list-header-tabs', '', [node('tabs--fixture', '', tabs)]);
  const input = node('ant-input', '', [], { tagName: 'INPUT', value: search });
  const box = node('ant-input-affix-wrapper headerSearchInput--fixture', '', [
    node('ant-input-prefix', '', [node('headerSearchInputPrefix--fixture', '', [node('headerSearchInputPrefixText--fixture', '全部')])]), input]);
  return { header, box, input, tabs };
}

/** Synthetic page `page` of a list: order IDs are unique per page unless `ids` overrides them. */
export function orderPageGroups(page, count = 30, ids = null) {
  return Array.from({ length: count }, (_, index) => orderGroup(index + 1, { orderId: ids?.[index] ?? String(page * 1000 + index + 1) }).group);
}

/**
 * Evaluate any page expression against one synthetic list page; never opens a browser.
 * @returns {{value: object, clicks: string[]}} Raw expression result and the controls it clicked.
 */
export function runOnOrderPage(script, groups, { page = 1, total = 3, view = {}, url = orderTarget.url, extras = [], decorate = () => {} } = {}) {
  const clicks = [];
  const { container } = orderPager(page, total, { onNext: () => clicks.push('next') });
  const { header, box } = orderListView(view);
  const root = node('trade-content-container', '', groups), main = node('trade-main-content', '', [header, box, root, container]);
  const document = node('', '', [main, ...extras]);
  document.body = document; document.readyState = 'complete'; document.title = 'Synthetic buyer list';
  decorate({ document, main, root });
  const value = vm.runInNewContext(script, { URL, location: { href: url }, document,
    getComputedStyle: value => ({ display: value.hidden ? 'none' : 'block', visibility: 'visible' }) });
  return { value: JSON.parse(JSON.stringify(value)), clicks };
}

/** Run the fixed order-page expression (a read, or a guarded click when `before` is given) in a synthetic document. */
export function observeOrderPage(groups, { allowedPages, before, ...options } = {}) {
  return runOnOrderPage(orderPageScript(orderTarget, { allowedPages: allowedPages ?? [options.page ?? 1], before }), groups, options);
}
