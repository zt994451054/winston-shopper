// Synthetic Taobao search page modelled on the 2026-10-12 live price controls. No browser or platform is accessed.
import { searchPageTarget } from '../lib/search.mjs';

function splitTopLevel(text, separator) {
  const parts = []; let depth = 0, quote = null, current = '';
  for (const character of text) {
    if (quote) { if (character === quote) quote = null; current += character; continue; }
    if (character === '"' || character === "'") quote = character;
    else if ('(['.includes(character)) depth += 1;
    else if (')]'.includes(character)) depth -= 1;
    if (depth === 0 && character === separator) { parts.push(current); current = ''; continue; }
    current += character;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

function closingParenthesis(text, open) {
  for (let index = open, depth = 0; index < text.length; index++) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && --depth === 0) return index;
  }
  throw new Error(`Unbalanced synthetic selector: ${text}`);
}

function matchesCompound(node, compound) {
  let rest = compound, match;
  while (rest) {
    if (rest.startsWith(':is(')) {
      const end = closingParenthesis(rest, 3);
      if (!splitTopLevel(rest.slice(4, end), ',').some(part => matchesSelector(node, part))) return false;
      rest = rest.slice(end + 1);
    } else if ((match = rest.match(/^:nth-child\((\d+)\)/))) {
      if (!node.parentElement || node.parentElement.children.indexOf(node) + 1 !== Number(match[1])) return false;
      rest = rest.slice(match[0].length);
    } else if ((match = rest.match(/^\[([a-z-]+)(?:([\^*]?=)"([^"]*)")?\]/))) {
      const value = node.getAttribute(match[1]);
      if (value === null) return false;
      if ((match[2] === '=' && value !== match[3]) || (match[2] === '^=' && !value.startsWith(match[3])) ||
          (match[2] === '*=' && !value.includes(match[3]))) return false;
      rest = rest.slice(match[0].length);
    } else if ((match = rest.match(/^#([A-Za-z0-9_-]+)/))) {
      if (node.getAttribute('id') !== match[1]) return false;
      rest = rest.slice(match[0].length);
    } else if ((match = rest.match(/^\.([A-Za-z0-9_-]+)/))) {
      if (!node.className.split(/\s+/).includes(match[1])) return false;
      rest = rest.slice(match[0].length);
    } else if ((match = rest.match(/^[a-z]+/))) {
      if (node.tagName !== match[0].toUpperCase()) return false;
      rest = rest.slice(match[0].length);
    } else if (rest.startsWith('*')) {
      rest = rest.slice(1);
    } else throw new Error(`Unsupported synthetic selector: ${compound}`);
  }
  return true;
}

function matchesSelector(node, selector) {
  const compounds = splitTopLevel(selector, ' ');
  if (!matchesCompound(node, compounds.at(-1))) return false;
  let ancestor = node.parentElement;
  for (let index = compounds.length - 2; index >= 0; index--) {
    while (ancestor && !matchesCompound(ancestor, compounds[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

/** A synthetic element with parent links, inherited visibility, computed font weight and a click callback. */
export function element(tag, { cls = '', attrs = {}, text = null, hidden = false, fontWeight = '400', value = '', href = null, disabled = false, onClick = null } = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(), className: cls, children, parentElement: null, hidden, fontWeight, value, href, disabled, clicks: 0,
    get innerText() { return text ?? children.map(child => child.innerText).join(' '); },
    get textContent() { return this.innerText; },
    getAttribute(name) {
      if (name === 'class') return cls;
      if (Object.hasOwn(attrs, name)) return attrs[name];
      return name === 'href' ? href : null;
    },
    getClientRects() {
      for (let current = node; current; current = current.parentElement) if (current.hidden) return [];
      return [{}];
    },
    click() { node.clicks += 1; onClick?.(); },
    querySelectorAll(selector) {
      const all = [], parts = splitTopLevel(selector, ',');
      const walk = parent => { for (const child of parent.children) { all.push(child); walk(child); } };
      walk(node);
      return all.filter(candidate => parts.some(part => matchesSelector(candidate, part)));
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function tab(label, selected, extraClass = '') {
  return element('li', { cls: `next-tabs-tab customTabItem--a ${extraClass}`.trim(), attrs: { role: 'tab', 'aria-selected': String(selected) } },
    [element('div', { cls: 'next-tabs-tab-inner', text: label })]);
}

export function defaultCards() {
  return [
    { id: '1001', price: '89' }, { id: '1002', price: '45.1', label: '补贴后' }, { id: '1003', price: '49.9' },
    { id: '1004', price: '82', label: '优惠后' }, { id: '1005', price: '19' }, { id: '1006', price: '0', ad: true },
  ];
}

/**
 * Build a live-shaped search page whose synthetic clicks, hovers and fills change its state and re-render it.
 * Option clicks reverse the cards (direction) and confirm drops the last card (range), so applied states differ.
 * @param {{query?: string, cards?: object[]}} options
 * @returns {object} vm context, mutable state, canonical target and pointer/fill simulators.
 */
export function priceSearchPage({ query = 'Synthetic mouse', cards = defaultCards() } = {}) {
  const state = { comprehensive: true, range: false, direction: null, menuOpen: false, panelOpen: false,
    minimum: '', maximum: '', totalPages: 100, cards, loggedOut: false, resultsFailed: false, gate: null, ignoreClicks: false, pointer: null,
    visibility: 'visible', focused: true, page: 1, ignoreNext: false, source: 'all', filters: [], ignoreSource: false };
  const target = searchPageTarget(query, 1);
  let current;
  const refresh = () => { current = build(); };
  function build() {
    const cardNodes = state.cards.map(card => element('a', { cls: 'doubleCardWrapperAdapt--x',
      href: card.ad ? 'https://click.simba.taobao.com/cc_im?p=1' : `https://item.taobao.com/item.htm?id=${card.id}` }, [
      element('div', { cls: 'title--x', text: `Item ${card.id}` }),
      element('div', { cls: 'shopNameText--x', text: 'Shop' }),
      element('div', { cls: 'realSales--x', text: '10人付款' }),
      element('div', { cls: 'priceWrapper--x', text: `¥ ${card.price}${card.label ? ` ${card.label}` : ''}` }, [
        element('div', { cls: 'priceInt--x', text: card.price.split('.')[0] }),
        element('div', { cls: 'priceFloat--x', text: card.price.includes('.') ? `.${card.price.split('.')[1]}` : '' }),
        element('div', { cls: 'priceDesc--x', text: card.label ?? '' }),
      ]),
    ]));
    const option = label => element('div', { cls: 'priceTag--x', text: label, fontWeight: state.direction === label ? '700' : '400',
      onClick: () => {
        if (state.ignoreClicks) return;
        // Live: the sort bar re-renders and the menu reopens while the pointer still rests on 价格.
        state.direction = label; state.comprehensive = false; state.menuOpen = state.pointer === '价格';
        state.totalPages = label === '从低到高' ? 8 : 14; state.cards = [...state.cards].reverse(); refresh();
      } });
    const menu = element('div', { cls: 'next-overlay-inner priceTabOverLayWrapper--x', hidden: !state.menuOpen },
      [element('div', { cls: 'priceTagWrap--x' }, [option('从低到高'), option('从高到低')])]);
    const confirm = element('div', { cls: 'confirmButton--x', text: '确定', onClick: () => {
      if (state.ignoreClicks) return;
      state.range = true; state.panelOpen = state.pointer === '区间'; state.totalPages = 2; state.cards = state.cards.slice(0, -1); refresh();
    } });
    const panel = element('div', { cls: 'next-overlay-inner sectionPriceSelecterWrapper--x', hidden: !state.panelOpen },
      [element('div', { cls: 'preset--x', text: '0-57 30%的选择' }), element('div', { cls: 'resetButton--x', text: '重置' }), confirm]);
    const inputs = ['minimum', 'maximum'].map(field => element('input', { cls: 'textInput--x', hidden: !state.panelOpen, value: state[field],
      attrs: { placeholder: field === 'minimum' ? '¥ 最低价' : '¥ 最高价', type: 'text' } }));
    const sortBar = element('div', { cls: 'sortBarWrapper--x' }, [element('div', { cls: 'sortBarWrapTop--x' }, [
      element('div', { cls: 'sortBarWrapInner--x' }, [element('ul', { attrs: { role: 'tablist' } }, [tab('综合', state.comprehensive), tab('销量', false)])]),
      element('div', { cls: 'otherSelector--x' }, [
        element('i', { cls: 'priceTabIcon--x' }), element('i', { cls: 'priceSortTabIcon--x' }),
        element('div', { cls: 'priceWrapper--y' }, inputs),
        element('ul', { attrs: { role: 'tablist' } }, [tab('价格', false, 'customTabItemWithArr--a'), tab('区间', state.range, 'customTabItemWithArr--a')]),
      ]),
    ])]);
    // The live page also has an otherSelector region inside pagination; selectors must not rely on it being unique.
    // Live (2026-10-13): after a price sort, 下一页 changes only the page parameter; the sort, total pages and markers stay.
    const next = element('button', { cls: 'next-next', text: '下一页', disabled: state.page >= state.totalPages, onClick: () => {
      if (state.ignoreNext || state.page >= state.totalPages) return;
      state.page += 1; state.menuOpen = false; state.panelOpen = false;
      state.cards = state.cards.map(card => ({ ...card, id: String(Number(card.id) + 100) }));
      refresh();
    } });
    const pagination = element('div', { cls: 'next-pagination' }, [
      element('div', { cls: 'otherSelector--z' }, [element('div', { cls: 'next-pagination-display', text: `${state.page}/${state.totalPages}` })]),
      element('button', { cls: 'next-prev', text: '上一页', disabled: state.page === 1 }),
      element('button', { cls: 'next-current', text: String(state.page) }),
      next,
    ]);
    // Live 2026-10-13: the source tab row marks the selected tab with actStyle--; 天猫 sets tab=mall and clears the filter
    // strip. Each filter-strip item toggles a selected-- class; 包邮 leaves the address and total pages unchanged.
    const sourceTab = (label, source) => element('div', { cls: `baseStyle--x${state.source === source ? ' actStyle--a' : ''}`, text: label, onClick: () => {
      if (state.ignoreSource || state.source === source) return;
      state.source = source; state.filters = []; state.page = 1; state.cards = state.cards.map(card => ({ ...card, id: String(Number(card.id) + 5000) }));
      refresh();
    } });
    const tabRow = element('div', { cls: 'tabWrapAll--x' }, [element('div', { cls: 'tabWrapOuter--x' }, [element('div', { cls: 'tabWrap--x' }, [
      sourceTab('所有宝贝', 'all'), sourceTab('天猫', 'tmall'), sourceTab('淘宝', 'taobao')])])]);
    const filterItem = label => element('div', { cls: `filterItem--x${state.filters.includes(label) ? ' selected--b' : ''}`, onClick: () => {
      state.filters = state.filters.includes(label) ? state.filters.filter(item => item !== label) : [...state.filters, label];
      refresh();
    } }, [element('div', { cls: 'textWrap--x' }, [element('div', { cls: 'text--x', text: label })])]);
    const strip = element('div', { cls: 'filterItemsWithFixBox--x' }, [element('div', { cls: 'leftPart--x' }, [
      filterItem('旗舰店'), filterItem('包邮'), filterItem('明日达')])]);
    const nav = state.loggedOut ? [element('a', { text: '亲，请登录', attrs: { href: '//login.taobao.com/member/login.jhtml?f=top' } })] : [];
    const gate = state.gate ? [element('div', { attrs: { id: 'nc_1_wrapper' }, text: '滑块' })] : [];
    // Live (2026-10-12): logged out, or after many rapid searches while logged in, the results area shows only this placeholder.
    const failed = state.loggedOut || state.resultsFailed;
    const placeholder = failed ? [element('div', { cls: 'leftContent--x', text: '综合 销量 价格 区间 “哎呀，网络信号走丢啦~”' })] : [];
    const body = element('body', {}, [...nav, element('input', { attrs: { name: 'q' }, value: query }), tabRow, sortBar, strip,
      ...placeholder, ...(failed ? [] : cardNodes), pagination, menu, panel, ...gate]);
    const document = element('html', {}, [body]);
    Object.assign(document, { readyState: 'complete', title: `${query}_淘宝搜索`, body, visibilityState: state.visibility, hasFocus: () => state.focused });
    return { document, menu, panel, confirm };
  }
  refresh();
  const context = {
    URL, location: {
      get href() {
        return state.href ?? target.url.replace('&page=1&', `&page=${state.page}&`).replace('&tab=all', state.source === 'tmall' ? '&tab=mall' : '&tab=all');
      },
      set href(value) { state.href = value; },
      assign() { throw new Error('Navigation is not expected'); } },
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', fontWeight: node.fontWeight }),
    get document() { return current.document; },
  };
  return {
    context, state, target, refresh,
    /**
     * Simulate the live pointer behaviour: entering 价格 or 区间 opens its overlay and closes the other one;
     * 综合 closes neither; staying on the same tab sends no new enter event, so nothing reopens.
     */
    hover(label) {
      if (state.pointer === label) return;
      state.pointer = label;
      if (label === '价格') { state.menuOpen = true; state.panelOpen = false; }
      if (label === '区间') { state.panelOpen = true; state.menuOpen = false; }
      refresh();
    },
    /** Simulate typing into one visible range input. */
    fill(field, text) { state[field] = text; refresh(); },
    /**
     * Simulate the user's real pointer leaving the sort bar (live 2026-10-13): both overlays close and the next automated
     * move onto a tab is a fresh enter. Whether typed but unconfirmed bounds survive is unknown live, so tests choose.
     */
    leave({ clearInputs = false, focused = false } = {}) {
      state.pointer = 'elsewhere'; state.menuOpen = false; state.panelOpen = false; state.focused = focused;
      if (clearInputs && !state.range) { state.minimum = ''; state.maximum = ''; }
      refresh();
    },
  };
}
