import vm from 'node:vm';
import { pddSearchTarget } from '../lib/pdd/targets.mjs';

/**
 * Minimal DOM node for the PDD collectors: tag, `[attr="value"]` and `*` selectors, block-level innerText joined by newlines like a
 * browser renders the card lines, a box for images and cards, document order, and a click callback.
 */
export function node(tag, { text = null, ownText = '', attrs = {}, width = 0, top = 0, left = 0, onClick = null, hidden = false } = {}, children = []) {
  // A hidden node (and everything in it) has no height and no innerText, like a display:none copy on the page.
  const isHidden = () => { for (let current = self; current; current = current.parentElement) if (current.hidden) return true; return false; };
  const self = {
    tagName: tag.toUpperCase(), children, parentElement: null, hidden,
    get innerText() { return isHidden() ? '' : text ?? [ownText, ...children.map(child => child.innerText)].filter(Boolean).join('\n'); },
    get childNodes() { return [...(text !== null ? [{ nodeType: 3, textContent: text }] : ownText ? [{ nodeType: 3, textContent: ownText }] : []), ...children]; },
    get textContent() { return text ?? ownText + children.map(child => child.textContent).join(''); },
    compareDocumentPosition(other) {
      let root = self;
      while (root.parentElement) root = root.parentElement;
      const order = [];
      const walk = item => { order.push(item); item.children.forEach(walk); };
      walk(root);
      return order.indexOf(other) > order.indexOf(self) ? 4 : 2;
    },
    scrollIntoView() {},
    click() { onClick?.(); },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    getBoundingClientRect() { return { width, height: isHidden() ? 0 : width, top, left }; },
    getClientRects() { return [{}]; },
    contains(other) { for (let current = other; current; current = current.parentElement) if (current === self) return true; return false; },
    querySelectorAll(selector) {
      const all = [];
      const walk = parent => { for (const child of parent.children) { all.push(child); walk(child); } };
      walk(self);
      const attribute = selector.match(/^\[([\w-]+)="(.*)"\]$/);
      if (attribute) return all.filter(candidate => candidate.getAttribute(attribute[1]) === attribute[2]);
      return selector === '*' ? all : all.filter(candidate => candidate.tagName === selector.toUpperCase());
    },
    querySelector(selector) { return self.querySelectorAll(selector)[0] ?? null; },
  };
  for (const child of children) child.parentElement = self;
  return self;
}

const IMAGE = id => `https://img-2.pddpic.com/mms-material-img/2026-10-27/${id}.jpeg`;

/**
 * One live-shaped card (2026-10-27): title, labels, an optional 券后, ¥, amount and decimals as separate lines, sales text.
 * @param {{title: string, labels?: string[], label?: string, amount: string, decimals?: string, sales?: string, image?: string, lazy?: boolean}} card
 */
export function pddCard({ title, labels = [], label = null, amount, decimals = null, sales = '已抢100件', image = IMAGE(title.length), lazy = false, top = 0, left = 0, onClick = null }) {
  const main = node('img', { width: 381, onClick, attrs: lazy ? { src: 'https://mobile.pinduoduo.com/placeholder.png', 'data-src': image } : { src: image } });
  return node('div', { top, left }, [
    main, node('img', { width: 116, attrs: { src: 'https://img-2.pddpic.com/brand-label.png' } }),
    node('div', { text: title }), ...labels.map(text => node('span', { text })),
    ...(label ? [node('span', { text: label })] : []), node('span', { text: '¥' }), node('span', { text: amount }),
    ...(decimals ? [node('span', { text: decimals })] : []), ...(sales ? [node('span', { text: sales })] : []),
  ]);
}

export function defaultPddCards() {
  return [
    { title: '罗技(Logitech)M', labels: ['立减23元', '假一赔十', '新客'], amount: '76', sales: '本店已拼1356件' },
    { title: '罗技M330静音无线光电', labels: ['近54天100%好评', '假一赔十'], label: '券后', amount: '71', sales: '已抢286件' },
    { title: 'Logitech 罗技M330 B330', labels: ['假一赔十'], amount: '79', decimals: '.92', sales: '本店已拼1件', lazy: true },
  ];
}

/**
 * Build a PDD search page context for the serialized collector. With `columns`, cards alternate between two column
 * elements, left then right, a row of two per 500 px, as the page shows them after 返回 (2026-10-27).
 * @param {{query?: string, cards?: object[], columns?: boolean, href?: string, readyState?: string, bodyText?: string, extra?: object[], bar?: object}} options `bar` replaces the default sort bar.
 * @returns {{context: object, target: object}}
 */
export function pddSearchPage({ query = 'Synthetic mouse', cards = defaultPddCards(), columns = false, href = null, readyState = 'complete', bodyText = null, extra = [], bar = null } = {}) {
  const target = pddSearchTarget(query);
  const placed = cards.map((card, index) => pddCard(columns ? { ...card, top: 500 * Math.floor(index / 2), left: 400 * (index % 2) } : card));
  const grid = columns ? node('div', {}, [0, 1].map(column => node('div', {}, placed.filter((_, index) => index % 2 === column)))) : node('div', {}, placed);
  const body = node('body', bodyText === null ? {} : { text: bodyText }, [
    bar ?? node('div', {}, [node('span', { text: '综合' }), node('span', { text: '销量' }), node('span', { text: '价格' })]),
    grid, node('div', { text: '用手机浏览器扫码在拼多多App打开' }), ...extra]);
  const document = { title: '拼多多', body, readyState, querySelectorAll: selector => selector === 'body *' ? body.querySelectorAll('*') : body.querySelectorAll(selector) };
  const context = { URL, location: { href: href ?? `${target.url}&refer_page_name=index` }, document,
    // A node's `color` property stands in for its rendered text colour; the sort bar marks the selected item in red.
    getComputedStyle: element => ({ display: 'block', visibility: 'visible', color: element?.color ?? 'rgb(88, 89, 91)' }) };
  return { context, target, // Results cross the bridge as JSON, so they are returned as plain Node values.
    evaluate: script => JSON.parse(JSON.stringify(vm.runInNewContext(script, context) ?? null)) };
}
