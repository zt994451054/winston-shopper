import vm from 'node:vm';
import { cartRowsScript, cartBatchScript } from '../lib/cart-rows.mjs';

function matches(node, query) {
  return query.split(',').some(part => {
    const selector = part.trim();
    if (selector === '*') return true;
    if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return node.getAttribute('id') === selector.slice(1);
    const prefix = selector.match(/\[class(?:\^|\*)=" ?([^" ]+)--"\]/)?.[1];
    if (prefix) return node.className.split(/\s+/).some(name => name.startsWith(`${prefix}--`));
    const attr = selector.match(/^\[(role|aria-modal)="([^"]+)"\]$/);
    if (attr) return node.getAttribute(attr[1]) === attr[2];
    if (selector === 'a[href]') return node.tagName === 'A' && node.getAttribute('href') !== null;
    return selector.toUpperCase() === node.tagName.toUpperCase();
  });
}

/** Synthetic DOM element; fixture values contain no real account or cart data. */
export function cartNode(classes = '', text = '', children = [], fields = {}) {
  const attributes = fields.attributes ?? {};
  const node = { tagName: 'DIV', nodeType: 1, className: classes, children, ...fields,
    get innerText() { return [text, ...children.map(child => child.innerText)].filter(Boolean).join('\n'); },
    get childNodes() { return [{nodeType:3,nodeValue:text}, ...children]; },
    getAttribute(name) { return name === 'class' ? classes : attributes[name] ?? null; },
    getClientRects() { return fields.hidden ? [] : [{}]; },
    contains(other) { return node === other || children.some(child => child.contains(other)); },
    querySelectorAll(query) {
      return children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => matches(child, query));
    },
    closest(query) { for (let current = node; current; current = current.parentElement) if (matches(current, query)) return current; return null; },
  };
  children.forEach(child => { child.parentElement = node; });
  return node;
}

// Marker layouts observed on the live cart (2026-10-13); 'normal' rows carry none of them.
const AVAILABILITY_LAYOUTS = {
  normal: { imageText: null, message: null, disabled: false, specification: false, price: false, quantity: false },
  variant_out_of_stock: { imageText: '款式缺货', message: null, disabled: true, specification: false, price: true, quantity: false },
  cannot_buy: { imageText: '商品下架', message: '宝贝已不能购买', disabled: true, specification: true, price: true, quantity: true },
};

/**
 * One synthetic cart row with separate image, detail, specification and price/quantity regions.
 * `availability` picks a marker layout; `imageText` and `message` override its texts (null removes them).
 */
export function cartRow(position = 1, { productId = String(100 + position), quantity = '1', displayQuantity = false, availability = 'normal',
  imageText, message } = {}) {
  const layout = AVAILABILITY_LAYOUTS[availability];
  const overlay = imageText === undefined ? layout.imageText : imageText, notice = message === undefined ? layout.message : message;
  const marker = (on, name) => on ? ` ${name}--fixture` : '';
  const anchor = cartNode('', `Synthetic item ${position}`, [], {tagName:'A',attributes:{href:`https://detail.tmall.com/item.htm?id=${productId}&tracking=PRIVATE`}});
  const image = cartNode('trade-cart-item-image', '', [cartNode('imageContainer--fixture', '', overlay ? [cartNode('imageTxt--fixture', overlay)] : [])]);
  const detail = cartNode('trade-cart-item-detail', '', [anchor, ...(notice ? [cartNode('rightWrapper--fixture', '', [cartNode('msgWrapper--fixture', notice)])] : [])]);
  const specification = cartNode('trade-cart-item-sku-old' + marker(layout.specification, 'invalid'), '颜色：蓝\n尺寸：M');
  const input = cartNode('', '', [], {tagName:'INPUT',type:'text',value:quantity,disabled:false});
  const price = cartNode('trade-price-container' + marker(layout.price, 'priceInvalid'), '￥19.90');
  const priceRegion = cartNode('trade-cart-item-price', '', [price]);
  const quantityDisplay = cartNode('quantityNumWrapper--fixture', quantity);
  const quantityRegion = cartNode('trade-cart-item-quantity' + marker(layout.quantity, 'quantityNumDisabled'), '', [displayQuantity ? quantityDisplay : input]);
  const priceQuantity = cartNode('trade-cart-item-p-q-container', '', [priceRegion, quantityRegion]);
  const checkbox = cartNode('', '', [], {tagName:'INPUT',type:'checkbox',value:'PRIVATE',disabled:layout.disabled});
  const status = cartNode('trade-cart-item-status', '', [checkbox]);
  const row = cartNode('trade-cart-item-info', '', [image, detail, specification, priceQuantity, status]);
  return { row, anchor, image, detail, specification, input, quantityRegion, quantityDisplay, price, priceRegion, priceQuantity, status, checkbox };
}

/** Bounded collector execution in a synthetic context, never a browser connection. */
export function observeCart(rows, { additionalRoots = [], url = 'https://cart.taobao.com/cart.htm', shops = null, plan = null, availability = true } = {}) {
  const shopContainers = shops ?? [cartNode('trade-cart-shop-container', '', [cartNode('trade-cart-shop-info', 'Synthetic shop'), ...rows])];
  const root = cartNode('trade-main-cart-content', '', shopContainers);
  const document = cartNode('', '', [root, ...additionalRoots]);
  document.body = document;
  document.readyState = 'complete';
  document.title = 'Synthetic cart';
  const target = {url:'https://cart.taobao.com/cart.htm'};
  const value = vm.runInNewContext(plan ? cartBatchScript(target, plan, {availability}) : cartRowsScript(target, {availability}), {URL, location:{href:url}, document,
    getComputedStyle: node => ({display:node.hidden?'none':'block',visibility:'visible'})});
  return JSON.parse(JSON.stringify(value));
}
