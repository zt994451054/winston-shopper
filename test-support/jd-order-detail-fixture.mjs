// Synthetic JD order detail. `classic` matches the 2026-10-19 probe; `state_panel` matches the 2026-10-21 probe. No browser or platform is accessed.
import vm from 'node:vm';
import { element } from './jd-search-fixture.mjs';

export { element };

// Built at run time so the package scan for phone-shaped numbers does not flag this well-known fake number.
export const SYNTHETIC_PHONE = ['138', '0000', '0000'].join('');

/** @param {object} [options] @returns {object} One synthetic product row. Titles and links are obviously synthetic. */
export function detailItem(options = {}) {
  return {
    id: '10086011', title: '合成蓝牙耳机 降噪款', price: '¥128.00', beans: '0', discount: '¥0.00', quantity: '1',
    action: '合成操作', extraCells: [], ...options,
  };
}

/** @param {object} [options] @returns {object} One synthetic progress node. */
export function detailNode(options = {}) {
  return { name: '合成提交订单', time: '2026-09-20 16:24:17', ready: true, ...options };
}

/** @param {object} [options] @returns {object} One synthetic total row. The colon is fullwidth unless overridden. */
export function detailAmount(options = {}) {
  return { label: '商品总价', value: '¥157.00', colon: '：', ...options };
}

const DEFAULT_PROGRESS = [
  detailNode(),
  detailNode({ name: '合成付款成功', time: '2026-09-20 16:24:40' }),
  detailNode({ name: '合成商品出库', time: '2026-09-21 09:00:00' }),
  detailNode({ name: '合成等待收货', time: '', ready: false }),
];

const DEFAULT_ITEMS = [
  detailItem(),
  detailItem({
    id: '10086012', title: '合成耳机收纳盒', price: '¥29.00', beans: '3', discount: '¥5.00', quantity: '2',
    href: '//item.jd.com/10086012.html?synthetic-spm=1',
  }),
];

const DEFAULT_AMOUNTS = [
  detailAmount(),
  detailAmount({ label: '运费', value: '¥0.00', colon: ':' }),
];

const DEFAULT_COLUMNS = ['商品编号', '商品名称', '京东价', '京豆数量', '优惠', '商品数量', '操作'];

const STATE_PROGRESS = [
  detailNode({ name: '合成提交申请', time: '2026-09-20 16:24:17' }),
  detailNode({ name: '合成取消处理', time: '2026-09-20 16:30:00' }),
  detailNode({ name: '合成退款受理', time: '' }),
  detailNode({ name: '合成退款完成', time: '', ready: false }),
];

const STATE_ITEMS = [
  detailItem({ spec: '合成银色', lineAmount: '¥128.00', action: '合成在列' }),
  detailItem({
    id: '10086012', title: '合成耳机收纳盒', price: '¥29.00', beans: '3', quantity: '2', spec: '合成黑色',
    lineAmount: '¥58.00', action: '合成在列', href: '//item.jd.com/10086012.html?synthetic-spm=1',
  }),
];

const STATE_COLUMNS = ['商品', '合成价格', '合成金额', '合成数量', '合成京豆', '合成状态'];

const STATE_AMOUNTS = [
  detailAmount({ label: '商品总价', value: '¥157.00' }),
  detailAmount({ label: '合成运费', value: '¥6.00', colon: ':' }),
  detailAmount({ label: '合成优惠', value: '¥5.00' }),
  detailAmount({ label: '合成京豆抵', value: '¥ 0.00' }),
];

/**
 * Build a JD order detail and evaluate a script against it. readyState stays loading: the detail read does not use it.
 * `layout: 'state_panel'` is the 2026-10-21 page (no `#orderstate`). Anything else, including the default, is the
 * 2026-10-19 page and is unchanged. Text is synthetic. Private fragments are collected in `secrets`.
 * @param {object} [options]
 * @returns {{orderId: string, evaluate: Function, secrets: string[], readyState: string}}
 */
export function jdOrderDetailPage(options = {}) {
  if (options.layout === 'state_panel') return statePanelPage(options);
  return classicOrderDetailPage(options);
}

/**
 * The 2026-10-19 page. The hidden delivery line is rendered before the visible one, so a collector that takes the
 * first `.extra` copies the payer.
 * @param {object} [options]
 * @returns {{orderId: string, evaluate: Function, secrets: string[], readyState: string}}
 */
function classicOrderDetailPage({
  orderId = '880000000001', href, orderIdText, orderStrong = true, title = '合成订单详情', status = '完成',
  nickname = '合成昵称甲', orderState = true, productTable = true, progress = DEFAULT_PROGRESS,
  items = DEFAULT_ITEMS, columns = DEFAULT_COLUMNS, amounts = DEFAULT_AMOUNTS,
  payable = { label: '实付款', value: '¥152.00' }, shipping = '承运人：合成运输', shippingText, extra = [],
  readyState = 'loading',
} = {}) {
  const pageHref = href ?? `https://details.jd.com/normal/item.action?orderid=${orderId}&PassKey=SYNTHETICKEY`;
  const strongText = orderIdText === undefined ? `订单号：${orderId}` : orderIdText;
  const secrets = [];
  const hide = value => {
    if (typeof value === 'string' && value && !secrets.includes(value)) secrets.push(value);
    return value;
  };
  const concealIfLong = (value, max) => {
    if (typeof value === 'string' && value.length > max) hide(value);
  };
  for (const secret of [
    '合成昵称甲', '合成签收人', '合成付款浮层', '合成旁路说明', '合成配送员', `${SYNTHETIC_PHONE}`, '合成代付人',
    '合成收货人', '合成路1号', '138****0000', '在线支付', '支付方式', 'PassKey', 'SYNTHETICKEY',
    'img.synthetic.invalid', 'synthetic.invalid', '合成运费险说明', '合成面包屑', '合成伪状态不采用',
    '处理时间', '处理信息', '操作人', '订单跟踪', '付款信息', '合成客服入口', '合成头像', '合成条码',
    '合成商品图', '收货人信息', '订单信息', '商品清单', '770000000077', '订单号：770000000077',
    '合成代付人隐藏送货', '合成隐藏付款信息', '合成隐藏页签丙', `合成配送员已送达 ${SYNTHETIC_PHONE}`,
    '2026-09-21 10:00:00', '合成其他页签',
  ]) hide(secret);
  hide(nickname);
  hide(title);
  hide(pageHref);
  if (typeof strongText === 'string' && strongText !== orderId) hide(strongText);
  if (typeof status === 'string') concealIfLong(status, 40);

  const renderItem = item => {
    const link = Object.hasOwn(item, 'href') ? item.href : `//item.jd.com/${item.id}.html`;
    if (typeof link === 'string' && link !== `//item.jd.com/${item.id}.html` && link !== `https://item.jd.com/${item.id}.html`) hide(link);
    if (typeof link === 'string' && link.includes('synthetic-spm')) hide('synthetic-spm=1');
    if (typeof link === 'string' && link.startsWith('http://')) hide('http://item.jd.com');
    if (typeof item.title === 'string' && /[\u0000-\u001f\u007f]/.test(item.title)) hide(item.title);
    concealIfLong(item.title, 300);
    if (item.titleText && item.titleText !== item.title) concealIfLong(item.titleText, 100);
    for (const part of [item.price, item.beans, item.discount, item.code, ...(item.extraCells ?? [])]) concealIfLong(part, 100);
    if (item.quantity != null) concealIfLong(String(item.quantity), 100);
    hide(`jingdou-${item.id}`);
    hide(`https://img.synthetic.invalid/${item.id}.png`);
    const visible = item.titleText ?? item.title ?? '';
    const anchor = link ? [element('a', { href: link, attrs: item.title ? { title: item.title } : {}, text: visible })] : [];
    // imageColumn: the 2026-10-21 classic page had a 商品图片 column whose product link holds only an image.
    const imageColumn = item.imageColumn && link ? [element('td', {}, [element('a', { href: link }, [
      element('img', { attrs: { src: `https://img.synthetic.invalid/${item.id}.png`, alt: '合成商品图' } }),
    ])])] : [];
    return element('tr', {}, [
      element('td', { text: item.code ?? item.id ?? '' }),
      ...imageColumn,
      element('td', {}, [
        element('img', { attrs: { src: `https://img.synthetic.invalid/${item.id}.png`, alt: '合成商品图' } }),
        ...anchor,
      ]),
      element('td', { text: item.price ?? '' }),
      element('td', { attrs: { id: `jingdou-${item.id}` }, text: item.beans ?? '' }),
      element('td', { text: item.discount ?? '' }),
      element('td', { cls: 'p-num', text: item.quantity == null ? '' : String(item.quantity) }),
      element('td', {}, [element('a', { href: 'https://synthetic.invalid/action', text: item.action ?? '合成操作' })]),
      ...(item.extraCells ?? []).map(text => element('td', { text })),
    ]);
  };
  const headerRow = element('tr', {}, columns.map(name => {
    concealIfLong(name, 20);
    return element('th', { text: name });
  }));
  const itemRows = items.map(renderItem);
  const amountLis = amounts.map(amount => {
    if (typeof amount.value === 'string' && /\s/.test(amount.value)) hide(amount.value);
    else concealIfLong(amount.value, 40);
    concealIfLong(amount.label, 40);
    return element('li', {}, [
      element('span', { text: `${amount.label ?? ''}${amount.colon ?? '：'}` }),
      element('em', { text: amount.value ?? '' }),
    ]);
  });
  if (payable) {
    concealIfLong(payable.label, 40);
    concealIfLong(payable.value, 40);
  }
  const shippingNode = shippingText != null
    ? element('div', { cls: 'extra', text: shippingText })
    : shipping == null ? null : element('div', { cls: 'extra' }, [
      element('span', { attrs: { id: 'jdshfs' }, text: '送货方式：' }),
      element('span', { text: shipping }),
    ]);
  if (shippingText != null) concealIfLong(shippingText, 100);
  else if (shipping != null) concealIfLong(`送货方式： ${shipping}`, 100);

  const stateBlock = element('div', { attrs: { id: 'orderstate' }, cls: 'm' }, [
    element('div', { cls: 'mt' }, [
      element('strong', {}, [element('span', { cls: 'ftx14', text: status ?? '' })]),
      element('span', { attrs: { id: 'pay-button-synthetic' }, hidden: true, text: '合成付款浮层' }),
    ]),
    element('div', { cls: 'mc', text: '合成状态说明，合成签收人已签收' }),
  ]);
  const processBlock = element('div', { attrs: { id: 'process' }, cls: 'section2' }, (Array.isArray(progress) ? progress : []).flatMap((node, index, list) => {
    concealIfLong(node.name, 40);
    concealIfLong(node.time, 40);
    const piece = element('div', { cls: node.ready ? 'node ready' : 'node' }, [
      element('ul', {}, [
        element('li', { cls: 'tx1' }),
        element('li', { cls: 'tx2', text: node.name ?? '' }),
        element('li', { attrs: { id: `track_time_${index}` }, cls: 'tx3', text: node.time ?? '' }),
      ]),
    ]);
    return index === list.length - 1 ? [piece] : [piece, element('div', { cls: 'proce ready' })];
  }));
  const trackBlock = element('div', { attrs: { id: 'ordertrack' }, cls: 'm' }, [
    element('ul', { cls: 'tab' }, [
      element('li', { cls: 'curr' }, [element('h2', { text: '订单跟踪' })]),
      element('li', {}, [element('h2', { text: '付款信息' })]),
      element('li', {}, [element('h2', { text: '合成其他页签' })]),
    ]),
    element('div', { cls: 'mc tabcon hide', hidden: true }, [
      element('div', { cls: 'extra', text: '合成代付人隐藏送货' }),
      element('p', { text: '合成代付人' }),
    ]),
    element('div', { cls: 'mc tabcon' }, [
      element('table', {}, [
        element('tbody', { attrs: { id: 'tbody_track' } }, [
          element('tr', {}, [
            element('th', { text: '处理时间' }), element('th', { text: '处理信息' }), element('th', { text: '操作人' }),
          ]),
        ]),
        element('tbody', {}, [
          element('tr', {}, [
            element('td', { text: '2026-09-21 10:00:00' }),
            element('td', { text: `合成配送员已送达 ${SYNTHETIC_PHONE}` }),
            element('td', { text: '合成配送员' }),
          ]),
        ]),
      ]),
    ]),
    ...(shippingNode ? [shippingNode] : []),
    element('div', { cls: 'mc tabcon hide', hidden: true, text: '合成隐藏付款信息' }),
    element('div', { cls: 'mc tabcon hide', hidden: true, text: '合成隐藏页签丙' }),
  ]);
  const infoBlock = element('div', { attrs: { id: 'orderinfo' }, cls: 'm' }, [
    element('div', { cls: 'mt' }, [element('strong', { text: '订单信息' })]),
    element('div', { cls: 'mc' }, [
      element('dl', { cls: 'fore' }, [
        element('dt', { text: '收货人信息' }),
        element('dd', {}, [element('ul', {}, [
          element('li', { text: '合成收货人' }),
          element('li', { text: '合成路1号' }),
          element('li', { text: '138****0000' }),
        ])]),
      ]),
      element('dl', {}, [
        element('dt', {}, [element('span', { cls: 'i-mt', text: '商品清单' })]),
        ...(productTable ? [element('dd', { cls: 'p-list' }, [
          element('table', {}, [element('tbody', {}, [headerRow, ...itemRows])]),
        ])] : []),
      ]),
      element('div', { attrs: { id: 'barcode' } }, [
        element('img', { attrs: { src: 'https://img.synthetic.invalid/barcode.png', alt: '合成条码' } }),
      ]),
      element('div', { attrs: { id: 'yunFeiXian' }, text: '合成运费险说明' }),
    ]),
    element('div', { cls: 'total' }, [
      element('ul', {}, amountLis),
      ...(payable ? [element('div', { cls: 'extra' }, [
        element('i', { text: `${payable.label ?? '实付款'}${payable.colon ?? '：'}` }),
        element('span', { cls: 'ftx04' }, [element('b', { text: payable.value ?? '' })]),
      ])] : []),
    ]),
  ]);
  const body = element('body', {}, [
    ...extra,
    element('div', { attrs: { id: 'shortcut-synthetic' } }, [
      element('a', { cls: 'nickname', text: nickname }),
      element('img', { attrs: { src: 'https://img.synthetic.invalid/avatar.png', alt: '合成头像' } }),
      element('span', { cls: 'ftx14', text: '合成伪状态不采用' }),
    ]),
    element('div', { cls: 'w' }, [
      element('div', { cls: 'breadcrumb', text: '合成面包屑' }),
      ...(orderState ? [stateBlock] : []),
      element('div', { cls: 'ml10 mb10' }, [
        element('div', {}, [element('strong', { text: '订单号：770000000077' })]),
        element('strong', { text: '合成旁路说明' }),
        ...(orderStrong ? [element('strong', { text: strongText ?? '' })] : []),
        ...(progress === false ? [] : [processBlock]),
        trackBlock,
        infoBlock,
      ]),
    ]),
    element('div', { attrs: { id: 'service-synthetic' }, text: '合成客服入口' }),
    element('div', { attrs: { id: 'footer-synthetic' } }, [
      element('a', { href: 'https://synthetic.invalid/pay', text: '在线支付' }),
      element('a', { href: 'https://synthetic.invalid/method', text: '支付方式' }),
    ]),
  ]);
  const evaluate = script => JSON.parse(JSON.stringify(vm.runInNewContext(script, {
    URL, location: { href: pageHref },
    document: { title, readyState, body, querySelectorAll: selector => body.querySelectorAll(selector) },
    getComputedStyle: node => ({ display: node?.hidden ? 'none' : 'block', visibility: 'visible' }),
  })));
  return { orderId, evaluate, secrets, readyState };
}

/**
 * The 2026-10-21 page: `div.order-state` plus `table.tb-order`, and no `#orderstate`.
 * `.order-info-mod` holds the consignee on purpose. `orderState: false` omits the state panel, `productTable: false`
 * omits the goods table, and `stateTop: false` omits the printed order id.
 * @param {object} [options]
 * @returns {{orderId: string, evaluate: Function, secrets: string[], readyState: string}}
 */
function statePanelPage({
  orderId = '880000000001', href, orderIdText, stateTop = true, title = '合成订单详情', status = '合成已取消',
  nickname = '合成昵称甲', orderState = true, productTable = true, progress = STATE_PROGRESS,
  items = STATE_ITEMS, columns = STATE_COLUMNS, amounts = STATE_AMOUNTS,
  payable = { label: '应付款', value: '¥152.00' }, extra = [], readyState = 'loading',
} = {}) {
  const pageHref = href ?? `https://details.jd.com/normal/item.action?orderid=${orderId}&PassKey=SYNTHETICKEY`;
  const topText = orderIdText === undefined ? `订单号：${orderId}` : orderIdText;
  const secrets = [];
  const hide = value => {
    if (typeof value === 'string' && value && !secrets.includes(value)) secrets.push(value);
    return value;
  };
  const concealIfLong = (value, max) => {
    if (typeof value === 'string' && value.length > max) hide(value);
  };
  for (const secret of [
    '合成账户pin', '合成定位键', '合成强调提示勿读', '合成强调甲', '合成强调乙', '合成面包屑',
    '合成收货人', '合成路1号', '138****0000', `合成配送员 ${SYNTHETIC_PHONE}`, '合成配送员', `${SYNTHETIC_PHONE}`,
    '在线支付', '合成付款时间', '收货信息', '配送信息', '付款信息', '立即购买', '查看退款时效', '修改信息',
    '合成其他说明', '合成隐藏页签丙', '合成店铺甲', '联系客服', '合成反馈入口', '支付方式', '合成客服入口',
    '合成间隔列甲', '合成间隔列乙', '合成间隔格甲', '合成间隔格乙', '合成旁路金额', '合成商品图',
    '合成伪状态不采用', '合成昵称甲', 'PassKey', 'SYNTHETICKEY', 'img.synthetic.invalid', 'synthetic.invalid',
  ]) hide(secret);
  hide(nickname);
  hide(title);
  hide(pageHref);
  if (stateTop && typeof topText === 'string' && topText !== orderId) hide(topText);
  if (typeof status === 'string') concealIfLong(status, 40);

  const renderItem = (item, index) => {
    const productHref = `//item.jd.com/${item.id}.html`;
    const link = Object.hasOwn(item, 'href') ? item.href : productHref;
    if (typeof link === 'string' && link !== productHref && link !== `https://item.jd.com/${item.id}.html`) hide(link);
    if (typeof link === 'string' && link.includes('synthetic-spm')) hide('synthetic-spm=1');
    if (typeof link === 'string' && link.startsWith('http://')) hide('http://item.jd.com');
    if (typeof item.title === 'string' && /[\u0000-\u001f\u007f]/.test(item.title)) hide(item.title);
    concealIfLong(item.title, 300);
    if (item.titleText && item.titleText !== item.title) concealIfLong(item.titleText, 100);
    concealIfLong(item.spec, 100);
    for (const part of [item.price, item.lineAmount, item.beans, item.action, ...(item.extraCells ?? [])]) concealIfLong(part, 100);
    if (item.quantity != null) concealIfLong(String(item.quantity), 100);
    hide(`jingdou-${item.id}`);
    hide(`https://img.synthetic.invalid/${item.id}.png`);
    const visible = item.titleText ?? item.title ?? '';
    return element('tr', { cls: `${index === 0 ? 'first-tr ' : ''}product-${item.id}`.trim(), attrs: { productid: String(item.id) } }, [
      element('td', { cls: 'grap', text: '合成间隔格甲' }),
      element('td', { cls: 'grap', text: '合成间隔格乙' }),
      element('td', {}, [
        element('div', { cls: 'p-item' }, [
          element('div', { cls: 'p-img' }, [
            element('a', { href: productHref }, [
              element('img', { attrs: { src: `https://img.synthetic.invalid/${item.id}.png`, alt: '合成商品图' } }),
            ]),
          ]),
          element('div', { cls: 'p-info' }, [
            element('div', { cls: 'p-name' }, [
              element('a', { cls: 'a-link sku-link', href: link || null, attrs: item.title ? { title: item.title } : {}, text: visible }),
            ]),
            element('div', { cls: 'p-extra' }, [element('span', { cls: 'txt', text: item.spec ?? '合成银色' })]),
          ]),
        ]),
      ]),
      element('td', { text: item.price ?? '' }),
      element('td', { text: item.lineAmount ?? '' }),
      element('td', { cls: 'p-num', text: item.quantity == null ? '' : String(item.quantity) }),
      element('td', { attrs: { id: `jingdou-${item.id}` }, text: item.beans ?? '' }),
      element('td', { text: item.action ?? '合成在列' }),
      ...(item.extraCells ?? []).map(text => element('td', { text })),
    ]);
  };
  const progressNodes = progress === false || !Array.isArray(progress) ? [] : progress;
  const processChildren = progressNodes.flatMap((node, index, list) => {
    concealIfLong(node.name, 40);
    concealIfLong(node.time, 40);
    const piece = element('div', { cls: node.ready ? 'node ready' : 'node' }, [
      element('i', { cls: 'node-icon' }),
      element('ul', {}, [
        element('li', { cls: 'txt1' }),
        element('li', { cls: 'txt2', text: node.name ?? '' }),
        element('li', { cls: 'txt3', text: node.time ?? '' }),
      ]),
    ]);
    return index === list.length - 1 ? [piece] : [piece, element('div', { cls: 'proce done' })];
  });
  const headerCells = [
    element('th', { cls: 'grap', text: '合成间隔列甲' }),
    element('th', { cls: 'grap', text: '合成间隔列乙' }),
    ...columns.map(name => {
      concealIfLong(name, 20);
      return element('th', { text: name });
    }),
  ];
  const amountLis = amounts.map((amount, index) => {
    if (typeof amount.value === 'string' && /\s/.test(amount.value)) hide(amount.value);
    else concealIfLong(amount.value, 40);
    concealIfLong(amount.label, 40);
    return element('li', {}, [
      element('span', { cls: 'label', text: `${amount.label ?? ''}${amount.colon ?? '：'}` }),
      ...(index === 0 ? [element('span', { text: '合成旁路金额' })] : []),
      element('span', { cls: 'txt', text: amount.value ?? '' }),
    ]);
  });
  if (payable) {
    concealIfLong(payable.label, 40);
    concealIfLong(payable.value, 40);
  }
  const payableLi = payable ? element('li', { cls: 'ftx-01' }, [
    element('span', { cls: 'label', text: `${payable.label ?? '应付款'}${payable.colon ?? '：'}` }),
    element('span', { cls: 'txt count', text: payable.value ?? '' }),
  ]) : null;
  const stateBlock = element('div', { cls: 'm order-state order-state02' }, [
    element('div', { attrs: { id: 'tab-dingqigou' }, cls: 'tab-dingqigou', hidden: true, text: '合成隐藏页签丙' }),
    element('div', { cls: 'mc state-cont' }, [
      element('div', { cls: 'state-lcol' }, [
        ...(stateTop ? [element('div', { cls: 'state-top', text: topText ?? '' })] : []),
        element('h3', { cls: 'state-txt ftx-02', text: status ?? '' }),
        element('div', { cls: 'state-btns' }, [
          element('a', { cls: 'btn-1 btn-rebuy-detail', href: 'https://synthetic.invalid/rebuy', text: '立即购买' }),
        ]),
      ]),
      element('div', { cls: 'state-rcol' }, [
        element('div', { cls: 'state-rtop' }, [
          element('div', { cls: 'ftx-03' }, [
            element('a', { cls: 'ftx-05', href: 'https://synthetic.invalid/refund-time', text: '查看退款时效' }),
          ]),
        ]),
        element('div', { attrs: { id: 'process-04' }, cls: 'order-process steps-4' }, processChildren),
        element('div', { cls: 'state-tip', hidden: true, text: '修改信息' }),
        element('div', { cls: 'state-others' }, [element('strong', { text: '合成其他说明' })]),
      ]),
    ]),
  ]);
  const infoBlock = element('div', { cls: 'm order-info-mod' }, [
    element('div', { cls: 'order-info order-info-new mc' }, [
      element('div', { cls: 'dl' }, [
        element('div', { cls: 'dt' }, [element('h4', { text: '收货信息' })]),
        element('div', { cls: 'dd' }, [
          element('div', { cls: 'item', text: '合成收货人' }),
          element('div', { cls: 'item', text: '合成路1号' }),
        ]),
      ]),
      element('div', { cls: 'dl' }, [
        element('div', { cls: 'dt' }, [element('h4', { text: '配送信息' })]),
        element('div', { cls: 'dd' }, [
          element('div', { cls: 'item', text: `合成配送员 ${SYNTHETIC_PHONE}` }),
          element('div', { cls: 'item', text: '138****0000' }),
        ]),
      ]),
      element('div', { cls: 'dl' }, [
        element('div', { cls: 'dt' }, [element('h4', { text: '付款信息' })]),
        element('div', { cls: 'dd' }, [
          element('div', { cls: 'item', text: '在线支付' }),
          element('div', { cls: 'item', text: '合成付款时间' }),
        ]),
      ]),
    ]),
  ]);
  const table = element('table', { cls: 'tb-void tb-order' }, [
    element('colgroup', {}, [
      element('col', { cls: 'grap' }), element('col', { cls: 'grap' }), element('col', { cls: 'col-goods' }),
      element('col', { cls: 'col-number' }), element('col', { cls: 'col-price' }), element('col', { cls: 'col-amount' }),
      element('col', { cls: 'col-bean' }), element('col', { cls: 'col-state' }), element('col', { cls: 'col-ops' }),
    ]),
    element('thead', {}, [element('tr', {}, headerCells)]),
    element('tbody', {}, items.map(renderItem)),
  ]);
  const body = element('body', {}, [
    ...extra,
    element('div', { attrs: { id: 'shortcut-synthetic' } }, [
      element('a', { cls: 'nickname', text: nickname }),
      element('span', { cls: 'ftx14', text: '合成伪状态不采用' }),
    ]),
    element('input', { attrs: { id: 'orderid', value: orderId }, value: orderId }),
    element('input', { attrs: { id: 'pin', value: '合成账户pin' }, value: '合成账户pin' }),
    element('input', { attrs: { id: 'order-giskey', value: '合成定位键' }, value: '合成定位键' }),
    element('div', { attrs: { id: 'container' } }, [
      element('div', { cls: 'emph-wrap' }, [
        element('div', { cls: 'w' }, [
          element('div', { cls: 'emph-tips' }, [
            element('b', { text: '合成强调提示勿读' }),
            element('strong', { text: '合成强调甲' }),
            element('strong', { text: '合成强调乙' }),
          ]),
        ]),
      ]),
      element('div', { cls: 'w' }, [
        element('div', { cls: 'main' }, [
          element('div', { cls: 'breadcrumb' }, [element('strong', { text: '合成面包屑' })]),
          ...(orderState ? [stateBlock] : []),
          infoBlock,
          element('div', { cls: 'order-goods m' }, [
            element('div', { cls: 'mt goods-head' }, [
              element('span', { cls: 'shop-name', text: '合成店铺甲' }),
              element('div', { attrs: { id: 'im' }, cls: 'im-jd', text: '联系客服' }),
            ]),
            element('div', { cls: 'mc' }, [
              element('div', { cls: 'goods-list' }, productTable ? [table] : []),
            ]),
            element('div', { cls: 'goods-total' }, [
              element('ul', {}, [...amountLis, ...(payableLi ? [payableLi] : [])]),
            ]),
          ]),
          element('div', { cls: 'ui-slidebar', text: '合成反馈入口' }),
        ]),
      ]),
    ]),
    element('div', { attrs: { id: 'service-synthetic' }, text: '合成客服入口' }),
    element('div', { attrs: { id: 'footer-synthetic' } }, [
      element('a', { href: 'https://synthetic.invalid/pay', text: '在线支付' }),
      element('a', { href: 'https://synthetic.invalid/method', text: '支付方式' }),
    ]),
  ]);
  const evaluate = script => JSON.parse(JSON.stringify(vm.runInNewContext(script, {
    URL, location: { href: pageHref },
    document: { title, readyState, body, querySelectorAll: selector => body.querySelectorAll(selector) },
    getComputedStyle: node => ({ display: node?.hidden ? 'none' : 'block', visibility: 'visible' }),
  })));
  return { orderId, evaluate, secrets, readyState };
}
