// Synthetic JD search page shaped like the 2026-10-15 read-only structure probes. No browser or platform is accessed.
import vm from 'node:vm';
import { element as baseElement } from './search-price-fixture.mjs';
import { jdSearchTarget } from '../lib/jd/targets.mjs';

/** The shared fake element plus the direct text nodes and the computed line-through the JD collectors read. */
export function element(tag, options = {}, children = []) {
  const node = baseElement(tag, options, children);
  node.childNodes = [...(options.text ? [{ nodeType: 3, nodeValue: options.text }] : []), ...children];
  node.lineThrough = options.lineThrough ?? false;
  node.dispatchEvent = event => { options.onEvent?.(event.type); return true; };
  return node;
}

/**
 * Live shape (2026-10-15): big price, then a badge such as 补贴到手价, then a gray second amount.
 * @param {{sku: string, title?: string, price?: string, badge?: string, other?: string|null, struck?: boolean, self?: boolean, ad?: boolean, tags?: string[]}} card
 */
export function jdCard({ sku, title = `Synthetic item ${sku}`, price = '129.00', badge = '到手价', other = '¥139', struck = false, self = false, ad = false, tags = ['包邮'] }) {
  return element('div', { cls: '_wrapper_1y1ag_3 plugin_goodsCardWrapper', attrs: { 'data-sku': sku, 'data-point-id': 'x' } }, [
    element('div', { cls: '_card_1y1ag_92' }, [
      element('div', { cls: '_bannerPicBox_1y1ag_76' }, ad ? [element('div', { cls: '_ad_17z5n_90', text: '广告' })] : []),
      element('div', { cls: '_info_1y1ag_17' }, [
        element('div', { cls: '_goods_title_container_1k2fi_1 _clip2_1k2fi_18' }, [
          element('div', { cls: '_imgTag_1qvb0_1' }, self ? [element('img', { attrs: { alt: '京东自营', src: 'x' } })] : []),
          element('span', { cls: '_newStyle_1k2fi_39', attrs: { title }, text: title }),
        ]),
        element('div', { cls: '_newStyle_9y3st_27 _container_9y3st_2' }, [
          element('span', { cls: '_price_9y3st_31', text: `¥${price}` }),
          element('span', {}, badge ? [element('div', { cls: '_subsidy_9y3st_67', text: badge })] : []),
          ...(other ? [element('span', { cls: '_gray_9y3st_78' }, [element('span', { text: other, lineThrough: struck })])] : []),
        ]),
        element('div', { cls: '_tags_hzhkm_2' }, tags.map(tag => element('div', { cls: '_newStyle_1qvb0_24 _textTag_1qvb0_10' }, [element('span', { text: tag })]))),
        element('div', { cls: '_goods_volume_container_1d8up_1' }, [element('span', { cls: '_goods_volume_1d8up_1', text: '已售1万+' })]),
        element('div', { cls: '_newStyle_3z0zc_1' }, [element('span', { cls: '_name_3z0zc_15', text: `Shop ${sku}` })]),
      ]),
    ]),
  ]);
}

export const DEFAULT_CARDS = [{ sku: '3290995', self: true, struck: true }, { sku: '10221084529885', price: '89.90', badge: '补贴到手价', other: '¥99' },
  { sku: '10068477063146', ad: true, tags: [], badge: '', other: null }];

function pageLabels(pages, active) {
  const count = Math.min(Math.max(pages, 1), 7);
  let start = Math.max(1, active - 3);
  const lastStart = Math.max(1, pages - count + 1);
  if (start > lastStart) start = lastStart;
  const labels = [];
  for (let page = start; page < start + count && page <= pages; page += 1) labels.push(page);
  if (!labels.includes(active)) labels.push(active);
  return labels;
}

/** Pager shaped like the 2026-10-21 probe. `hash` is the CSS-module suffix, so a read must not hard-code one build. */
function buildJdPager({ pages, active, hash = '1gv36', hideNext = false, extraActive = false, showTotal = true }, onNext) {
  const item = `_pagination_item_${hash}_29`;
  const labels = pageLabels(pages, active);
  const items = labels.map(page => element('div', {
    cls: page === active ? `${item} _active_${hash}_39` : item, text: String(page),
  }));
  if (extraActive) items.push(element('div', { cls: `${item} _active_${hash}_39`, text: String(active) }));
  items.push(element('div', { cls: `${item} _fast_next_${hash}_48` }, [element('span')]));
  const parts = [
    element('div', { cls: `_pagination_previous_${hash}_7${active <= 1 ? ` _disabled_${hash}_18` : ''}`, text: '上一页' }),
    ...items,
    element('div', {
      cls: `_pagination_next_${hash}_8${active >= pages ? ` _disabled_${hash}_18` : ''}`, text: '下一页', hidden: hideNext, onClick: onNext,
    }),
  ];
  if (showTotal) parts.push(element('div', { cls: `_pagination_total_${hash}_61`, text: `共${pages}页` }));
  // Present on the live page. Readers and the next click leave it alone.
  parts.push(element('div', { cls: `_pagination_toPageNum_${hash}_71` }, [
    element('span', { text: '到第' }), element('input'), element('span', { text: '页' }),
  ]));
  return element('div', { cls: '_pagiContainer_bryc4_22' }, [
    element('div', { cls: `_pagination_center_${hash}_2` }, parts),
  ]);
}

/** Icon file names seen on 2026-10-21. Page code only records them; the fixture uses them so reads look live. */
export const JD_SORT_ICONS = Object.freeze({ comprehensiveOn: '8eb8645cb942affc.png', comprehensiveOff: 'd9815dcfaaa3da77.png',
  salesOff: '7f009b5b5d60b2a5.png', salesOn: '768e7ede703e335a.png', priceOff: '81f7897adff0fc6e.png', priceDesc: 'db0b7f451cb43530.png',
  priceAsc: 'ddf53912cae6970e.png', range: 'd9815dcfaaa3da77.png' });

/**
 * Sort bar shaped like the 2026-10-21 probe. `hash` is the tag module suffix and `barHash` the bar's, so reads must
 * not hard-code one build. Variants: `hidePrice`, `bothActive` (销量 and 价格 both selected), `dropTrigger` (no 价格区间 button).
 */
function buildJdSortBar({ state, hash = '3m6t1', barHash = 'y7vi5', hidePrice = false, bothActive = false, dropTrigger = false, appliedRange = null, onRangeHover = null }, onTag) {
  const icon = name => element('img', { attrs: { src: `//img.example/jfs/${name}?x=1` } });
  const trigger = (label, active, iconName, onEvent = null) => element('div', { cls: `_price-range_${hash}_47` }, [
    element('div', { cls: '_trigger-item_vd39m_21', onEvent }, [element('div', {}, [
      element('div', { cls: `_trigger-wrap_${hash}_84 _trigger-wrap-button_${hash}_97${active
        ? ` _bg-pink_${hash}_114 _trigger-wrap-button__active_${hash}_105 _price-range-trigger_${hash}_110` : ''}` },
      [element('span', { text: label }), icon(iconName)]),
    ])]),
  ]);
  const tag = (label, active, iconName, hidden = false) => element('div', {
    cls: `_sort-tag_${hash}_2 _sort-tag-button_${hash}_11${active ? ` _sort-tag-button__active_${hash}_19` : ''} _sort-bar-item_${barHash}_9`,
    hidden, onClick: () => onTag(label),
  }, [element('div', { cls: `_sort-tag-inner_${hash}_24` }, [element('span', { text: label }), icon(iconName)])]);
  const sales = state === 'sales' || bothActive;
  const price = state.startsWith('price');
  const priceIcon = { 'price-desc': JD_SORT_ICONS.priceDesc, 'price-asc': JD_SORT_ICONS.priceAsc }[state] ?? JD_SORT_ICONS.priceOff;
  return element('div', { cls: `_sort-bar_${barHash}_1` }, [
    element('div', { cls: `_sort-bar-area_${barHash}_12` }, [
      trigger('综合', state === 'comprehensive', state === 'comprehensive' ? JD_SORT_ICONS.comprehensiveOn : JD_SORT_ICONS.comprehensiveOff),
      tag('销量', sales, sales ? JD_SORT_ICONS.salesOn : JD_SORT_ICONS.salesOff),
      tag('价格', price || bothActive, bothActive && !price ? JD_SORT_ICONS.priceDesc : priceIcon, hidePrice),
    ]),
    element('div', { cls: `_sort-bar-area_${barHash}_12` }, dropTrigger ? [] : [appliedRange
      // After 确定 the live button is selected and names the range (2026-10-22: text starts 价格区间(¥).
      ? trigger(`价格区间(¥${appliedRange.minimum}-${appliedRange.maximum})`, true, JD_SORT_ICONS.comprehensiveOn)
      : trigger('价格区间', false, JD_SORT_ICONS.range, type => { if (type === 'mouseenter') onRangeHover?.(); })]),
  ]);
}

/** The 价格区间 dropdown shaped like the 2026-10-22 probe: two inputs, presets, 重置 and 确定. */
function buildJdPriceRangePanel(values, onConfirm) {
  const button = (text, onClick = null) => element('div', { cls: '_common-button_q1w2e_1', onClick }, [element('span', { cls: '_common-button-text_q1w2e_9', text })]);
  return element('div', { cls: '_drop-down-body_q1w2e_5' }, [
    element('div', { cls: '_range-title_3m6t1_60', text: '请输入价格区间' }),
    element('div', { cls: '_range-input_3m6t1_70' }, [element('input', { attrs: { placeholder: '最低价' }, value: values.minimum }), element('span', { text: '-' }),
      element('input', { attrs: { placeholder: '最高价' }, value: values.maximum })]),
    ...['0 - 30', '30 - 50', '50 - 80'].map(text => element('div', { cls: '_price-range-item_3m6t1_80', text })),
    element('div', { cls: '_range-actions_3m6t1_90' }, [button('重置'), button('确定', onConfirm)]),
  ]);
}

/** JD's live transitions (2026-10-21): 价格 first sorts high to low, then toggles. */
function nextSort(state, label) {
  if (label === '销量') return 'sales';
  return state === 'price-desc' ? 'price-asc' : 'price-desc';
}

/**
 * Build a JD search page and evaluate a script against it.
 * `pager` omitted or null keeps the page without a pager, so existing reads stay the same.
 * `pageCards` is one card group per page. A 下一页 click advances the active page and swaps in that group's cards
 * when the live page would, unless `advance` is false (the control was clicked and the page did not change).
 * @param {{query?: string, cards?: object[], inStockActive?: boolean, href?: string, extra?: object[], title?: string,
 *   pager?: null | {pages: number, active: number, hash?: string, copies?: number, hideNext?: boolean, extraActive?: boolean, showTotal?: boolean, advance?: boolean},
 *   pageCards?: object[][], sort?: null | {active: 'comprehensive'|'sales'|'price-desc'|'price-asc', cards?: object, ignoreClicks?: boolean,
 *   copies?: number, hash?: string, barHash?: string, hidePrice?: boolean, bothActive?: boolean, dropTrigger?: boolean,
 *   rangeCards?: object, ignoreConfirm?: boolean, range?: {minimum: number, maximum: number}}}} [options]
 * `sort` omitted or null keeps the page without a sort bar. `sort.cards[state]` is one card group (page 1) or one group
 * per page; a state without cards keeps the current ones. A 销量 / 价格 click changes the state, swaps the cards and
 * returns the pager to page 1, unless `ignoreClicks` (counted, page unchanged).
 * Price range: a scripted mouseenter on 价格区间 opens the dropdown; `fill(field, text)` types as the extension's fill does;
 * 确定 applies the typed range (shown on the button), closes the dropdown, returns to page 1 and swaps in
 * `rangeCards[state]` (same shapes as `cards`), unless `ignoreConfirm`. `sort.range` starts with a range already applied.
 * @returns {{target: object, body: object, evaluate: Function, clicks: () => number, sortClicks: () => number, sortState: () => string|null,
 *   confirmClicks: () => number, fill: Function, range: () => object|null, panelOpen: () => boolean}}
 * `clicks` counts 下一页 clicks only; `sortClicks` counts sort-tag clicks; `confirmClicks` counts 确定 clicks.
 */
export function jdSearchPage({ query = 'Synthetic mouse', cards = DEFAULT_CARDS, inStockActive = true, href, extra = [], title = 'JD search',
  pager = null, pageCards = null, sort = null } = {}) {
  const target = jdSearchTarget(query);
  let active = pager?.active ?? 1;
  let clicks = 0, sortClicks = 0;
  let sortState = sort?.active ?? null;
  let appliedRange = sort?.range ?? null, panelOpen = false, confirmClicks = 0;
  const typed = { minimum: '', maximum: '' };
  const body = element('body');
  const sortGroups = () => {
    const group = (appliedRange && sort?.rangeCards?.[sortState]) || sort?.cards?.[sortState];
    if (!group) return null;
    return Array.isArray(group[0]) ? group : [group];
  };
  const shownCards = () => {
    const groups = sortGroups();
    if (groups) return groups[active - 1] ?? cards;
    return pager && pageCards ? pageCards[active - 1] ?? cards : cards;
  };
  const onRangeHover = () => { panelOpen = true; render(); };
  const onConfirm = () => {
    confirmClicks += 1;
    if (sort.ignoreConfirm) return;
    appliedRange = { minimum: Number(typed.minimum), maximum: Number(typed.maximum) };
    panelOpen = false;
    active = 1;
    render();
  };
  const fill = (field, text) => { typed[field] = text; render(); };
  const onTag = label => {
    sortClicks += 1;
    if (sort.ignoreClicks) return;
    sortState = nextSort(sortState, label);
    active = 1;
    render();
  };
  const onNext = () => {
    clicks += 1;
    // The live click stays on this address and replaces the first screen (2026-10-21). `advance: false` leaves it unchanged.
    if (!pager || pager.advance === false || active >= pager.pages) return;
    active += 1;
    render();
  };
  const render = () => {
    const filter = element('div', { cls: `_filter-select_1kjnr_1${inStockActive ? ' _filter-select__active_1kjnr_43' : ''}` },
      [element('span', { cls: '_filter-select-section_1kjnr_23', text: '仅显示有货' })]);
    const goods = element('div', { cls: 'plugin_goodsContainer' }, shownCards().map(jdCard));
    const pagers = pager ? Array.from({ length: pager.copies ?? 1 }, () => buildJdPager({ ...pager, active }, onNext)) : [];
    // Keep this array: the synthetic innerText getter closes over it, and the rate-limit gate reads body text.
    const sortBars = sort ? Array.from({ length: sort.copies ?? 1 }, () => buildJdSortBar({ ...sort, state: sortState, appliedRange, onRangeHover }, onTag)) : [];
    const panels = panelOpen ? [buildJdPriceRangePanel(typed, onConfirm)] : [];
    body.children.splice(0, body.children.length, filter, ...sortBars, goods, ...pagers, ...panels, ...extra);
    for (const node of body.children) node.parentElement = body;
  };
  render();
  class MouseEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  const evaluate = script => JSON.parse(JSON.stringify(vm.runInNewContext(script, { URL, MouseEvent, location: { href: href ?? target.url },
    document: { title, readyState: 'complete', body, querySelectorAll: selector => body.querySelectorAll(selector) },
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', textDecorationLine: node.lineThrough ? 'line-through' : 'none' }) })));
  return { target, body, evaluate, clicks: () => clicks, sortClicks: () => sortClicks, sortState: () => sortState,
    confirmClicks: () => confirmClicks, fill, range: () => appliedRange, panelOpen: () => panelOpen };
}
