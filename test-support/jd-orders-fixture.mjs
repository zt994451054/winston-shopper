// Synthetic JD order list shaped like the 2026-10-16 read-only structure probe. No browser or platform is accessed.
import vm from 'node:vm';
import { element } from './jd-search-fixture.mjs';
import { parseJdOrderListUrl } from '../lib/jd/targets.mjs';

export { element };

const cls = name => `${name}-h1`;

/** @param {object} [options] @returns {object} One synthetic product row. Titles and links are obviously synthetic. */
export function orderItem(options = {}) {
  return { id: '10086001', title: '合成商品标题', quantity: 1, ...options };
}

/** @param {object} [options] @returns {object} One synthetic order card. */
export function orderCard(options = {}) {
  return {
    time: '2026-09-01 10:20:30', orderId: '123456789012', shop: '合成店铺', status: '已完成', split: false,
    amount: ['¥', '1', '.00'], notes: [], detail: true, consignee: '合成收货人', items: [orderItem()], ...options,
  };
}

/** @param {object} [options] @returns {object} One synthetic split banner. The middle segment carries a consignee class. */
export function splitBanner(options = {}) {
  return {
    segments: [
      { text: '2026-08-15 08:00:00', cls: 'orderTimeValue' },
      { text: '合成收货人横幅', sensitive: true },
      { text: '合成原单说明丙' },
    ],
    notice: '合成拆单提示这单被拆开了', detail: true, ...options,
  };
}

/** @param {object} [options] @returns {{banner: object|null, cards: object[]}} */
export function orderGroup(options = {}) {
  return { banner: null, cards: [], ...options };
}

const DEFAULT_STATUSES = [
  { label: '全部', selected: true },
  { label: '待付款', secret: true },
  { label: '待发货', secret: true },
  { label: '待收货' },
  { label: '已完成' },
  { label: '已取消' },
  { label: '待评价', secret: true },
];

function defaultGroups() {
  return [
    orderGroup({ cards: [orderCard({
      time: '2026-09-01 10:20:30', orderId: '123456789012', orderIdTitle: '合成订单号诱饵',
      shop: '合成数码旗舰店', shopText: '合成店短名不采用', status: '已完成',
      amount: ['¥', '127', '.21'], notes: ['', '获得了7京豆'],
      items: [
        orderItem({ id: '10086001', title: '合成蓝牙鼠标 静音款', titleText: '合成鼠标短名不采用', quantity: 1 }),
        orderItem({ id: '10086002', title: '合成鼠标垫 大号', titleText: '合成垫短名不采用', quantity: 2,
          href: 'http://item.jd.com/10086002.html?synthetic-spm=1' }),
      ],
    })] }),
    orderGroup({ cards: [orderCard({
      time: '2026-09-02 11:00:00', orderId: '210000000002', shop: '合成百货小店', status: '已取消',
      amount: ['¥', '0', '.00'], detail: false,
      items: [orderItem({ id: '10086003', title: '合成赠品袋', quantity: 1 })],
    })] }),
    orderGroup({
      banner: splitBanner({ noticeText: '合成短提示不采用' }),
      cards: [orderCard({
        time: '2026-08-15 08:05:00', orderId: '1234567890123456', shop: '合成数码旗舰店', status: '待收货', split: true,
        amount: ['¥', '89', '.00'],
        items: [orderItem({ id: '10086004', title: '合成键盘 青轴', quantity: 1 })],
      })],
    }),
    orderGroup({ cards: [orderCard({
      time: '2026-08-15 08:06:00', orderId: '1234567890123457', shop: '合成配件专营店', status: '待收货', split: true,
      amount: ['¥', '12', '.00'],
      items: [orderItem({ id: '10086005', title: '合成键帽 一套', quantity: 3 })],
    })] }),
  ];
}

/**
 * Build a JD order list and evaluate a script against it. readyState stays loading: the order read does not use it.
 * Text on the page is synthetic. Private fragments are collected in `secrets` so a test can prove they were not copied.
 * @param {object} [options]
 * @returns {{target: object, evaluate: Function, secrets: string[], readyState: string}}
 */
export function jdOrdersPage({
  href = 'https://order.jd.com/center/list.action', title = '合成订单列表', timeRange = '近3个月订单',
  statuses = DEFAULT_STATUSES, groups, list = true, lists = 1, extra = [], nickname = '合成昵称甲', readyState = 'loading',
} = {}) {
  const target = parseJdOrderListUrl('https://order.jd.com/center/list.action');
  const secrets = [];
  const hide = value => {
    if (typeof value === 'string' && value && !secrets.includes(value)) secrets.push(value);
    return value;
  };
  const concealIfLong = (value, max) => {
    if (typeof value === 'string' && value.length > max) hide(value);
  };
  if (typeof timeRange === 'string') concealIfLong(timeRange, 40);

  const detailLink = label => element('div', { cls: cls('detailLink'), attrs: { role: 'button', tabindex: '0' } }, [
    element('span', { text: hide(label) }),
  ]);
  const renderSegment = (segment, index) => {
    if (segment.sensitive || index >= 5) hide(segment.text);
    else concealIfLong(segment.text, 80);
    const sensitiveClass = segment.sensitive === 'self' ? ` ${cls('consigneeName')}` : '';
    if (segment.sensitive === 'self') return element('div', { cls: `${cls('infoGroup')}${sensitiveClass}`, text: segment.text });
    const childClass = segment.sensitive ? cls('consigneeName') : (segment.cls ? cls(segment.cls) : '');
    return element('div', { cls: `${cls('infoGroup')}${sensitiveClass}` }, [
      element('span', { cls: childClass, text: segment.text }),
    ]);
  };
  const renderBanner = banner => {
    const visibleNotice = Object.hasOwn(banner, 'noticeText') ? banner.noticeText : banner.notice;
    if (Object.hasOwn(banner, 'noticeText') && banner.noticeText && banner.noticeText !== banner.notice) hide(banner.noticeText);
    concealIfLong(banner.notice, 200);
    return element('div', { cls: cls('splitBanner') }, [
      element('div', { cls: cls('metaSection') }, (banner.segments ?? []).map(renderSegment)),
      element('div', { cls: cls('notificationSection') }, [
        element('span', { cls: cls('noticeText'), attrs: banner.notice ? { title: banner.notice } : {}, text: visibleNotice }),
        ...(banner.detail === false ? [] : [detailLink('拆单详情')]),
      ]),
    ]);
  };
  const renderItem = (item, key) => {
    const href = Object.hasOwn(item, 'href') ? item.href : (item.id ? `//item.jd.com/${item.id}.html` : null);
    if (typeof href === 'string' && href.includes('synthetic-spm')) hide('synthetic-spm=1');
    if (typeof href === 'string' && href.startsWith('http://')) hide('http://item.jd.com');
    if (typeof item.quantity === 'string' && !/^[0-9]{1,6}$/.test(item.quantity)) hide(item.quantity);
    if (item.titleText && item.titleText !== item.title) hide(item.titleText);
    if (typeof item.title === 'string' && /[\u0000-\u001f\u007f]/.test(item.title)) hide(item.title);
    concealIfLong(item.title, 300);
    const quantityText = item.quantity === null || item.quantity === undefined ? '' : String(item.quantity);
    return element('div', { cls: cls('productItemWrapper') }, [
      element('div', { cls: cls('productItem') }, [
        element('a', { cls: cls('goodImg'), href, attrs: { title: hide(`合成图片标题${key}`) } }, [
          element('img', { attrs: { src: hide(`https://img.synthetic.invalid/${key}.png`), alt: hide(`合成图片说明${key}`) } }),
        ]),
        element('div', { cls: cls('productInfo') }, [
          element('h3', { cls: cls('productTitle'), attrs: item.title ? { title: item.title } : {}, text: item.titleText ?? item.title ?? '' }),
          element('div', { cls: cls('productCount') }, [
            element('span', { text: '共' }),
            element('span', { cls: cls('countNum'), text: quantityText }),
            element('span', { text: '件' }),
          ]),
          element('div', { cls: cls('itemButtons') }, [
            element('div', {}, [
              element('a', { cls: cls('buttonLink'), href: hide(`https://synthetic.invalid/after-${key}`), text: hide('申请售后') }),
            ]),
          ]),
        ]),
      ]),
    ]);
  };
  const renderCard = (card, key) => {
    const idText = Object.hasOwn(card, 'orderIdText') ? card.orderIdText : card.orderId;
    const idTitle = Object.hasOwn(card, 'orderIdTitle') ? card.orderIdTitle : null;
    if (typeof idText === 'string' && !/^[0-9]{6,30}$/.test(idText)) hide(idText);
    if (typeof idTitle === 'string' && idTitle !== idText && !/^[0-9]{6,30}$/.test(idTitle)) hide(idTitle);
    if (card.shopText && card.shopText !== card.shop) hide(card.shopText);
    concealIfLong(card.shop, 80);
    concealIfLong(card.time, 40);
    concealIfLong(card.status, 40);
    if (Array.isArray(card.amount)) concealIfLong(card.amount.join('').replace(/\s+/g, ''), 40);
    (card.notes ?? []).forEach((note, index) => { if (index >= 3 || !String(note ?? '').trim()) { if (note) hide(note); } else concealIfLong(note, 60); });
    const headerClass = card.split ? `${cls('header')} ${cls('splitOrderHeader')}` : cls('header');
    return element('div', { cls: cls('orderCard') }, [
      element('div', { cls: headerClass }, [
        element('div', { cls: cls('headerLeft') }, [
          element('div', { cls: cls('orderTime') }, [element('div', { cls: cls('metaValue'), text: card.time })]),
          element('div', { cls: cls('orderMetas') }, [
            element('div', { cls: cls('metaLabel'), text: '订单号' }),
            element('div', { cls: cls('metaValue'), attrs: idTitle == null ? {} : { title: idTitle }, text: idText == null ? null : String(idText) }),
          ]),
          element('div', { cls: cls('shopInfo') }, [
            element('span', { cls: cls('shopNames'), attrs: { title: card.shop ?? '' }, text: card.shopText ?? card.shop ?? '' }),
            element('img', { cls: cls('contactIcon'), attrs: { src: hide('https://img.synthetic.invalid/contact.png'), alt: hide('合成联系卖家') } }),
          ]),
        ]),
        element('div', { cls: cls('headerRight') }, [
          element('div', { cls: cls('rightStateStyle') }, [element('span', { cls: cls('statusText'), text: card.status ?? '' })]),
        ]),
      ]),
      element('div', { cls: cls('orderBody') }, [
        element('div', {}, [
          element('div', { cls: cls('productListContainer') }, [
            element('div', { cls: cls('productList') }, (card.items ?? []).map((item, index) => renderItem(item, `${key}-${index + 1}`))),
          ]),
        ]),
        element('div', { cls: cls('priceActionSection') }, [
          element('div', { cls: cls('paymentTypestyle') }, [
            element('div', { cls: cls('priceColumn') }, [
              ...(card.amount == null ? [] : [element('div', { cls: cls('priceRow') }, [
                element('div', {}, (Array.isArray(card.amount) ? card.amount : [String(card.amount)]).map(part => element('span', { text: String(part) }))),
              ])]),
              ...(card.notes ?? []).map(note => element('span', { cls: cls('jingDouAuto'), text: note })),
            ]),
            element('div', { cls: cls('paymentTypeName'), text: hide('在线支付') }),
          ]),
          element('div', { cls: cls('deliveryAndExpress') }, [
            element('div', { cls: cls('delivery') }, [
              element('div', { cls: cls('deliveryInfo') }, [
                element('span', { cls: cls('userName'), text: hide(card.consignee ?? '合成收货人') }),
                element('span', { cls: cls('addressLine'), text: hide(card.address ?? '合成收货地址示例路1号') }),
                element('span', { cls: cls('mobileNumber'), text: hide(card.phone ?? '合成电话占位') }),
              ]),
              ...(card.detail === false ? [] : [element('div', { cls: cls('detailSection') }, [detailLink('订单详情')])]),
            ]),
          ]),
          element('div', { cls: cls('action') }, [
            element('button', { text: hide('立即购买') }),
            element('button', { text: hide('评价') }),
            element('button', { text: hide('更多') }),
            element('button', { text: hide('查看发票') }),
          ]),
        ]),
      ]),
    ]);
  };
  const renderGroup = (group, groupIndex) => element('div', {}, [
    ...(group.banner ? [renderBanner(group.banner)] : []),
    ...group.cards.map((card, cardIndex) => element('div', {}, [renderCard(card, `${groupIndex + 1}-${cardIndex + 1}`)])),
  ]);
  const statusNodes = statuses.map(status => {
    if (status.secret) hide(status.label);
    else concealIfLong(status.label, 20);
    return element('div', { cls: `${cls('statusCard')}${status.selected ? ` ${cls('selected')}` : ''}` }, [
      element('span', { text: status.label }),
    ]);
  });
  const filter = element('div', { cls: cls('filterOptions') }, [
    element('div', { cls: cls('orderStatusList') }, statusNodes),
    element('div', { cls: cls('searchSection') }, [
      element('input', { value: hide('合成已输入搜索词'), attrs: { placeholder: hide('合成搜索词不要读取') } }),
    ]),
    element('div', { cls: cls('exportOrder'), text: hide('合成导出订单入口') }),
    element('div', { cls: cls('recycleBin'), text: hide('合成订单回收站') }),
    element('div', { cls: cls('filterOptionsTitle') }, [
      element('div', { cls: cls('filterOptionsTitleLeft') }, [
        ...(timeRange == null ? [] : [element('div', { cls: cls('selectContainer') }, [
          element('div', { cls: cls('select') }, [element('div', {}, [element('span', { text: timeRange })])]),
        ])]),
        element('div', { cls: cls('consignee'), text: hide('订单详情') }),
      ]),
      element('div', { cls: cls('filterOptionsTitleRight') }, [
        element('span', { text: hide('金额') }),
        element('span', { text: hide('状态') }),
        element('span', { text: hide('操作') }),
      ]),
    ]),
  ]);
  const listCount = list ? lists : 0;
  const groupNodes = (groups ?? defaultGroups()).map(renderGroup);
  const listNodes = Array.from({ length: listCount }, (_, index) => element('div', { cls: cls('listContent') }, index === 0 ? groupNodes : []));
  const body = element('body', {}, [
    ...extra,
    element('div', { cls: cls('nickname'), text: hide(nickname) }),
    element('div', { cls: cls('selectContainer'), text: hide('合成伪时间范围') }),
    element('div', { cls: `${cls('statusCard')} ${cls('selected')}`, text: hide('合成伪状态全部') }),
    element('div', { cls: cls('orderCard') }, [
      element('h3', { cls: cls('productTitle'), attrs: { title: hide('合成列表外订单') }, text: hide('合成列表外订单短名') }),
      element('div', { cls: cls('orderMetas') }, [
        element('div', { cls: cls('metaLabel'), text: '订单号' }),
        element('div', { cls: cls('metaValue'), text: hide('合成列表外单号') }),
      ]),
    ]),
    filter,
    ...listNodes,
  ]);
  const evaluate = script => JSON.parse(JSON.stringify(vm.runInNewContext(script, {
    URL, location: { href },
    document: { title, readyState, body, querySelectorAll: selector => body.querySelectorAll(selector) },
    getComputedStyle: node => ({ display: node?.hidden ? 'none' : 'block', visibility: 'visible' }),
  })));
  return { target, evaluate, secrets, readyState };
}
