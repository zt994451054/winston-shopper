// Synthetic JD cart shaped like the 2026-10-15 read-only structure probe. No browser or platform is accessed.
import vm from 'node:vm';
import { element as searchElement } from './jd-search-fixture.mjs';
import { parseJdCartUrl } from '../lib/jd/targets.mjs';

/** The search-page element plus the checked state cart rows read from the checkbox input. */
export function element(tag, options = {}, children = []) {
  const node = searchElement(tag, options, children);
  node.checked = options.checked ?? false;
  return node;
}

/**
 * One synthetic cart row. Prices, titles and specs are obviously synthetic.
 * Pass `href` to override the item link, including null when the row has no product number.
 * @param {object} [options]
 * @returns {object}
 */
export function cartRow(options = {}) {
  const row = {
    id: '100001', title: '合成商品标题', titleText: undefined, unavailable: false,
    specLabel: '合成项目', specText: '合成规格黑色标准版', priceText: '￥合成价88.00', priceKind: 'normal',
    otherAmount: null, decoyStatus: null, containerOnly: null, quantity: 1, checkbox: true, disabled: false,
    disabledClass: false, checked: false, mask: null, similar: false, tags: [], remind: null, bait: false, favorite: true,
    ...options,
  };
  if (!Object.hasOwn(options, 'href')) row.href = row.id ? `//item.jd.com/${row.id}.html` : null;
  return row;
}

/** @param {object} [options] @returns {{name: string, zy: boolean, rows: object[]}} */
export function cartShop(options = {}) {
  return { name: '合成店铺', zy: false, rows: [], ...options };
}

function defaultShops() {
  return [
    cartShop({ name: '合成数码旗舰店', zy: true, rows: [
      cartRow({ id: '100001', title: '合成耳机标准款全称', titleText: '合成耳机短名', priceText: '￥合成价1299.00',
        otherAmount: '￥合成对照价', decoyStatus: '合成状态价诱饵', quantity: 2, checked: true, bait: true,
        tags: ['合成七天价保', '合成包邮'] }),
      cartRow({ id: '100002', title: '合成耳机无货款', unavailable: true, priceKind: 'status_text', priceText: '商品补货中',
        otherAmount: '￥合成备用金额', quantity: null, disabled: true, disabledClass: true, mask: '无货', similar: true, favorite: false }),
    ] }),
    cartShop({ name: '合成第三方店', rows: [
      cartRow({ id: '100003', title: '合成键鼠套装', disabledClass: true, quantity: 1, priceText: '￥合成价88.00' }),
      cartRow({ id: '100004', href: '//item.jd.com/100004.html/', title: '合成缺号商品', quantity: 1 }),
      cartRow({ id: '100005', title: '合成无价商品', priceKind: null, priceText: null, quantity: 1 }),
    ] }),
    cartShop({ name: '合成配件店', rows: [
      cartRow({ id: '100006', href: 'http://item.jd.com/100006.html?synthetic-spm=1', title: '合成配件正常款',
        quantity: 3, similar: true, remind: '合成到货提醒', priceText: '￥合成价88.00' }),
      cartRow({ id: null, title: '合成缺号无货款', unavailable: true, priceKind: 'status_text', priceText: '商品补货中',
        quantity: null, disabled: true, disabledClass: true, mask: '无货', favorite: false }),
    ] }),
  ];
}

/**
 * Build a JD cart page and evaluate a script against it. readyState stays loading: the cart read does not use it.
 * @param {{href?: string, title?: string, header?: string|null, extra?: object[], list?: boolean, lists?: number,
 *   shops?: object[], address?: string, nickname?: string, readyState?: string, stray?: boolean}} [options]
 *   stray (default true) puts one product row in the list outside every shop group.
 * @returns {{target: object, evaluate: Function, secrets: string[], readyState: string}}
 */
export function jdCartPage({
  href = 'https://cart.jd.com/cart_index', title = '合成购物车', header = '12', extra = [], list = true, lists = 1,
  shops, address = '合成收货地址示例路1号', nickname = '合成昵称甲', readyState = 'loading', stray: withStray = true,
} = {}) {
  const target = parseJdCartUrl('https://cart.jd.com/cart_index');
  const secrets = [];
  const hide = value => {
    if (typeof value === 'string' && value && !secrets.includes(value)) secrets.push(value);
    return value;
  };
  const priceNodes = row => {
    if (row.containerOnly) {
      return [element('span', { cls: '_p-price-cont_1in3n_8', text: row.containerOnly })];
    }
    if (row.priceKind === 'status_text') {
      return [
        element('div', { cls: '_p-price_1in3n_12', text: row.priceText }),
        ...(row.otherAmount ? [element('p', { cls: '_product-price-sku_1in3n_42', text: row.otherAmount })] : []),
      ];
    }
    if (row.priceKind !== 'normal') return [];
    return [element('div', { cls: '_price-container_1in3n_5' }, [
      element('span', { cls: '_p-price-cont_1in3n_8' }, [
        element('span', { cls: '_price-normal_1in3n_18', attrs: { title: row.priceText }, text: row.priceText }),
      ]),
      ...(row.decoyStatus ? [element('div', { cls: '_p-price_1in3n_12', text: hide(row.decoyStatus) })] : []),
      ...(row.otherAmount ? [element('p', { cls: '_product-price-sku_1in3n_42', text: row.otherAmount })] : []),
    ])];
  };
  const renderRow = (row, key) => {
    const titleClass = `_goodTitle_1kgc5_1 ${row.unavailable ? '_title__unavailable_1kgc5_20' : '_title__hover_1kgc5_8'}`;
    const checkToken = hide(`synthetic-row-check-${key}`);
    const checkbox = row.checkbox ? element('div', { cls: '_good-check_r7tg3_1' }, [
      element('label', {}, [
        element('span', { cls: `_checkbox_lfahn_4${row.disabledClass ? ' _disabled_lfahn_61' : ''}` }, [
          element('input', { disabled: row.disabled === true, checked: row.checked === true, value: checkToken }),
        ]),
      ]),
    ]) : null;
    if (row.similar) hide('找相似');
    if (row.favorite) hide('移入收藏');
    if (String(row.href ?? '').includes('synthetic-spm')) hide('synthetic-spm=1');
    return element('div', { cls: '_product-item_88ueb_1', attrs: { 'data-skuuuid': hide(`synthetic-sku-uuid-${key}`) } }, [
      element('div', { cls: '_row_88ueb_40 _good_88ueb_6', attrs: { 'data-rowgid': hide(`synthetic-row-gid-${key}`) } }, [
        element('div', { cls: '_good-left_1op3a_6' }, [
          ...(checkbox ? [checkbox] : []),
          element('div', { cls: '_good-img_txkun_1' }, [
            element('img', { cls: 'pc-image-main', attrs: { src: hide(`https://img.synthetic.invalid/${key}.png`), alt: hide(`synthetic-image-alt-${key}`) } }),
            ...(row.mask ? [element('div', { cls: '_viewer_mask_txkun_23', text: row.mask })] : []),
          ]),
        ]),
        element('div', { cls: '_good-info-detail_1op3a_11' }, [
          element('a', { cls: titleClass, href: row.href, attrs: row.title ? { title: row.title } : {}, text: row.titleText ?? row.title ?? '' }),
          element('div', { cls: '_remindWrapper_1fqnm_1' }, row.remind ? [element('span', { text: row.remind })] : []),
          element('div', { cls: '_detail-tags_1p4o3_1' }, [
            element('p', {}, row.tags.map(tag => element('span', { text: tag }))),
          ]),
          ...(row.similar ? [element('div', { cls: '_similarSearchBox_1pb2h_1' }, [element('span', { text: '找相似' })])] : []),
          ...(row.bait ? [
            element('span', { cls: '_label_bait_1', text: hide('合成标签诱饵') }),
            element('span', { cls: '_txt_bait_1', text: hide('合成规格诱饵') }),
          ] : []),
        ]),
        element('div', { cls: '_rowItem_88ueb_46 _flexGoodExtra_88ueb_56' }, [
          element('div', { cls: '_extra-select_8vvh7_1', attrs: { title: row.specText ?? '' } }, [
            ...(row.specLabel ? [element('span', { cls: '_label_8vvh7_13', text: row.specLabel })] : []),
            ...(row.specText ? [element('span', { cls: '_txt_8vvh7_20', text: row.specText })] : []),
          ]),
        ]),
        element('div', { cls: '_rowItem_88ueb_46 _flexPriceAndPromotion_88ueb_61' }, priceNodes(row)),
        element('div', { cls: '_rowItem_88ueb_46 _flexGoodCount_88ueb_69' }, [
          element('div', { cls: '_cart-number_1ep1a_1' }, row.quantity === null ? [] : [
            element('button', { text: '-' }),
            element('div', {}, [element('input', { value: String(row.quantity) })]),
            element('button', { text: '+' }),
          ]),
        ]),
        element('div', { cls: '_rowItem_88ueb_46 _flexGoodActions_88ueb_74' }, [
          ...(row.favorite ? [element('a', { href: hide(`https://synthetic.invalid/fav-token-${key}`), text: '移入收藏' })] : []),
          element('a', { href: hide(`https://synthetic.invalid/delete-token-${key}`), text: '删除' }),
        ]),
      ]),
    ]);
  };
  const renderShop = (shop, shopIndex) => element('div', { cls: '_card_1v6li_1', attrs: { 'data-vendorid': hide(shop.vendor ?? `synthetic-vendor-id-${shopIndex}`) } }, [
    element('div', { cls: '_cardHeader_1v6li_7' }, [
      element('div', { cls: '_vendorTitle_19mks_1' }, [
        element('label', {}, [
          element('span', { cls: '_checkbox_lfahn_4 _disabled_lfahn_61' }, [
            element('input', { disabled: true, checked: true, value: hide(`synthetic-shop-check-${shopIndex}`) }),
          ]),
        ]),
        element('div', { cls: `_vendorIcon_1rvc7_1${shop.zy ? ' _zy_1rvc7_17' : ''}` }),
        element('span', { cls: '_title-txt_19mks_6' }, [
          element('div', { cls: '_shopName_19mks_10', text: shop.name }),
        ]),
      ]),
    ]),
    element('div', { cls: '_cardBody_1v6li_15' }, shop.rows.map((row, rowIndex) => renderRow(row, `${shopIndex}-${rowIndex}`))),
  ]);
  const shopNodes = (shops ?? defaultShops()).map(renderShop);
  const stray = element('div', { cls: '_product-item_88ueb_1', attrs: { 'data-skuuuid': hide('synthetic-sku-uuid-stray') } }, [
    element('a', { cls: '_goodTitle_1kgc5_1', href: '//item.jd.com/199999.html', attrs: { title: hide('合成无店铺行') }, text: '合成无店铺行' }),
  ]);
  const headerNode = element('div', { cls: '_cartNum_11omx_29' }, [
    element('span', { text: '购物车' }),
    ...(header === null ? [] : [
      element('span', { cls: 'number' }, [
        element('span', { text: '（' }),
        element('span', { text: String(header) }),
        element('span', { text: '）' }),
      ]),
      element('span', { cls: 'number', text: hide('合成伪页头88') }),
    ]),
  ]);
  const outside = element('div', { cls: '_card_1v6li_1', attrs: { 'data-vendorid': hide('synthetic-vendor-id-outside') } }, [
    element('div', { cls: '_cardHeader_1v6li_7' }),
    element('div', { cls: '_shopName_19mks_10', text: hide('合成列表外店铺') }),
    element('div', { cls: '_product-item_88ueb_1' }, [
      element('a', { cls: '_goodTitle_1kgc5_1', attrs: { title: hide('合成列表外商品') }, text: '合成列表外商品' }),
    ]),
  ]);
  const listCount = list ? lists : 0;
  const listNodes = Array.from({ length: listCount }, (_, index) => element('div', { cls: '_infiniteScroll_center_1twc0_1' },
    index === 0 ? [...(withStray ? [stray] : []), ...shopNodes] : []));
  const body = element('body', {}, [
    headerNode,
    element('div', { cls: '_delivery_11omx_40', text: hide(address) }),
    element('div', { cls: '_nickname_1_1', text: hide(nickname) }),
    outside,
    ...listNodes,
    element('div', { cls: '_cart-recommend_18y9y_2', text: hide('合成推荐不该读取') }),
    element('div', { attrs: { id: 'submitBar' }, text: hide('合成结算合计999') }),
    ...extra,
  ]);
  const evaluate = script => JSON.parse(JSON.stringify(vm.runInNewContext(script, {
    URL, location: { href },
    document: { title, readyState, body, querySelectorAll: selector => body.querySelectorAll(selector) },
    getComputedStyle: node => ({ display: node?.hidden ? 'none' : 'block', visibility: 'visible' }),
  })));
  return { target, evaluate, secrets, readyState };
}
