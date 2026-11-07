import { node } from './pdd-search-fixture.mjs';

export const PDD_ORDER_SN = '261020-000000000000001';
export const pddOrderListUrl = () => 'https://mobile.pinduoduo.com/orders.html?refer_page_name=personal';
export const pddOrderDetailUrl = (sn = PDD_ORDER_SN) => `https://mobile.pinduoduo.com/order.html?order_sn=${sn}&main_orders=1&is_tester=0`;

const div = (text, options = {}) => node('div', { text, width: 100, ...options });
const tagged = (name, text, options = {}) => div(text, { attrs: { 'data-test': name }, ...options });

/**
 * One order card of orders.html as seen on 2026-10-27: header (店铺名称, 订单状态), one row per item, the amount row with
 * the group's avatars, its hidden copy, and the buttons.
 */
export function pddOrderCard({ shop, status, items, amount = ['先用后付 实付:￥3.34', '(免运费)'], avatars = 2, onTitle = null }) {
  const amountRow = () => node('div', { width: 100 }, [...Array.from({ length: avatars }, () => node('img', { width: 20, attrs: { src: 'https://avatar2.pddpic.com/a/PRIVATE.jpeg' } })),
    ...amount.map(text => div(text))]);
  const copy = amountRow();
  copy.hidden = true;
  return node('div', { width: 100 }, [
    node('div', { width: 100 }, [tagged('店铺名称', shop), tagged('订单状态', status)]),
    ...items.map(({ title, lines = [] }) => node('div', { width: 100 }, [node('img', { width: 80, attrs: { 'data-test': '商品图片' } }),
      tagged('商品名称', title, { onClick: onTitle }), ...lines.map(line => div(line))])),
    amountRow(), copy,
    node('div', { width: 100 }, ['售后详情', '删除订单', '再次拼单', '更多'].map(text => div(text))),
  ]);
}

export function defaultPddOrders(onTitle = null) {
  return [
    { shop: '优尚一家', status: '极速退款成功', items: [{ title: '断桥锁点密封条', lines: ['×2，白色', '7天价保'] }], amount: ['实付:￥0', '(免运费)'], onTitle },
    { shop: 'PDD Synthetic Shop', status: '交易成功', items: [{ title: '静音无线鼠标', lines: ['×1，黑色【全新】'] }, { title: '鼠标垫', lines: ['蓝色 ×1，'] }],
      amount: ['¥3.36', '先用后付 实付:￥6.77', '(免运费)'], avatars: 4, onTitle },
  ];
}

/** orders.html with the given cards, 没有更多了 under them, then recommended products. */
export function pddOrdersBody({ orders = defaultPddOrders(), end = true } = {}) {
  return node('body', {}, [
    node('div', { width: 100 }, ['全部', '待付款', '待分享', '待发货', '待收货', '评价'].map(text => div(text))),
    node('div', { width: 100 }, orders.map(pddOrderCard)),
    ...(end ? [div('没有更多了...')] : []),
    node('div', { width: 100 }, [div('精选推荐'), div('PRIVATE_RECOMMENDED')]),
  ]);
}

/**
 * order.html: the top block (status and the consignee, phone and address as own text), the order block whose
 * 查看更多订单和优惠信息 unfolds payment, logistics and times in place, then recommended products.
 * @param {{status?: string, shop?: string, shownNumber?: string, expandable?: boolean, expandLabel?: string, onExpand?: Function}} options
 */
export function pddOrderDetailBody({ status = '已签收', shop = '优尚一家', shownNumber = PDD_ORDER_SN, expandable = true, expandLabel = '查看更多订单和优惠信息', onExpand = null } = {}) {
  const unfolded = [div('支付方式：先用后付'), div('已从微信支付PRIVATE_PAYMENT'), div('物流公司：PRIVATE_EXPRESS'), div('快递单号：YTPRIVATE0001'), div('复制'),
    div('下单时间：2026-10-20 10:00:00'), div('拼单时间：2026-10-20 10:00:05'), div('发货时间：2026-10-21 09:00:00'), div('成交时间：2026-10-24 18:00:00')];
  const entry = div(expandLabel);
  const block = node('div', { width: 100 }, [
    div(shop), div('断桥锁点密封条'), div('白色'), div('￥1.68'), div('×2'), div('联系商家'), div('申请退款'),
    div('大促后共优惠 ¥0.02'), div('先用后付'), div('实付: ￥3.34'), div('(免运费)'), div(`订单编号：${shownNumber}`), div('复制'),
    div('商品快照：发生交易争议时，可作为判断依据'), ...(expandable ? [entry] : []), div('再次拼单'), div('查看物流'), div('删除订单'),
  ]);
  entry.click = () => {
    const at = block.children.indexOf(entry);
    block.children.splice(at, 1, ...unfolded);
    for (const child of unfolded) child.parentElement = block;
    onExpand?.();
  };
  return node('body', {}, [
    node('div', { width: 100 }, [div(status), node('div', { ownText: 'PRIVATE_NAME 138PRIVATE 浙江省杭州市西湖区PRIVATE_ADDRESS', width: 100 }, [div('>')])]),
    block,
    node('div', { width: 100 }, [div('PRIVATE_RECOMMENDED')]),
  ]);
}
