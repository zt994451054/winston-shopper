// Synthetic JD product page shaped like the 2026-10-15 read-only probes. No browser or platform is accessed.
import vm from 'node:vm';
import { element as baseElement } from './search-price-fixture.mjs';
import { parseJdProductUrl } from '../lib/jd/targets.mjs';

/** The shared fake element plus the DOM methods, image fields, geometry and styles the JD product reader uses. */
export function element(tag, options = {}, children = []) {
  const node = baseElement(tag, options, children);
  node.childNodes = [...(options.text ? [{ nodeType: 3, nodeValue: options.text }] : []), ...children];
  node.lineThrough = options.lineThrough ?? false;
  node.backgroundImage = options.background ?? 'none';
  node.box = { top: options.top ?? 0, width: options.width ?? 750, height: options.height ?? 400 };
  Object.assign(node, options.image ?? {});
  node.querySelector = selector => node.querySelectorAll(selector)[0] ?? null;
  node.getBoundingClientRect = () => ({ ...node.box });
  node.closest = selector => {
    let top = node;
    while (top.parentElement) top = top.parentElement;
    const matches = top.querySelectorAll(selector);
    for (let current = node; current; current = current.parentElement) if (matches.includes(current)) return current;
    return null;
  };
  return node;
}

const loadedImage = { complete: true, naturalWidth: 750, naturalHeight: 1000 };
const img = (src, attrs = {}, cls = '') => element('img', { cls, attrs: { src, ...attrs }, image: loadedImage });

function rightPanel({ title, self }) {
  return element('div', { cls: 'page-right-content' }, [
    element('div', { cls: 'sku-title' }, [element('span', { cls: 'sku-title-text' }, [
      // Live title icons carry only numbers as alt text.
      element('span', { cls: 'sku-title-icon-box' }, [element('img', { cls: 'sku-type-icon', attrs: { alt: '6', src: 'x' } })]),
      element('span', { cls: 'sku-title-name', text: title })])]),
    element('div', { cls: 'product-price-panel' }, [
      element('span', { cls: 'product-price--main' }, [element('span', { cls: 'product-price--unit', text: '¥' }), element('span', { cls: 'product-price--value', text: '80.10' })]),
      element('span', { cls: 'product-price--activity-item product-price--activity-item--tag', text: '补贴价' }),
      element('div', { cls: 'product-price--gray' }, [element('span', { cls: 'product-price--gray-line-through', text: '¥89', lineThrough: true })]),
      element('span', { cls: 'product-price-panel--option product-price-panel--options-comment' },
        [element('span', { cls: 'product-price-panel--option product-price-panel--options-comment-count', text: '50万+' })]),
    ]),
    element('div', { cls: 'horizontal-layout specification-series-layout' }, [element('div', { cls: 'layout-label', text: '系列' }),
      element('div', { cls: 'layout-content' }, [element('div', { cls: 'specification-series-item' }, [element('span', { text: 'M330' })]),
        element('div', { cls: 'specification-series-item specification-series-item--selected' }, [element('span', { text: 'M331' })])])]),
    element('div', { cls: 'specification-group specification-group-0' }, [element('div', { cls: 'specification-group-label', text: '颜色' }),
      element('div', { cls: 'specification-group-content' }, [
        element('div', { cls: 'specification-item-sku has-image specification-item-sku--selected', attrs: { title: '黑色 静音' } }, [
          img('//img14.360buyimg.com/n9/black.jpg', { alt: '黑色' }, 'specification-item-sku-image'), element('span', { cls: 'specification-item-sku-text', text: '黑色' })]),
        element('div', { cls: 'specification-item-sku has-image', attrs: { title: '红色' } }, [
          img('https://img14.360buyimg.com/n9/red.jpg', { alt: '红色' }, 'specification-item-sku-image'), element('span', { cls: 'specification-item-sku-text', text: '红色' })]),
      ])]),
    element('div', { cls: 'specification-group specification-group-1' }, [element('div', { cls: 'specification-group-label', text: '尺码' }),
      element('div', { cls: 'specification-group-content' }, [
        element('div', { cls: 'specification-item-sku specification-item-sku--selected', attrs: { title: 'M' } }, [element('span', { cls: 'specification-item-sku-text', text: 'M' })]),
        element('div', { cls: 'specification-item-sku specification-item-sku--lack', attrs: { title: 'L' } }, [
          element('span', { cls: 'specification-item-sku-text', text: 'L' }), element('span', { cls: 'specification-item-sku--lack-tag', text: '无货' })]),
      ])]),
    element('div', { cls: 'service-support-tags' }, [
      element('div', { cls: 'service-support-tag-item' }, [element('a', { cls: 'service-support-tag-item--link', attrs: { title: '下单后7天内降价可申请价保' }, text: '7天价保' }),
        element('div', { cls: 'service-support-tag-item--split' }, [element('span', { text: '·' })])]),
      element('div', { cls: 'service-support-tag-item' }, [element('div', { cls: 'service-support-tag-item--text', attrs: { title: '所选地址包邮' }, text: '包邮' })]),
    ]),
  ]);
}

function detailContent(detail) {
  const images = detail === 'css'
    ? [element('div', { cls: 'ssd-module M1', background: 'url("https://img30.360buyimg.com/sku/m1.jpg")', height: 900 }),
      element('div', { cls: 'ssd-module M2', background: 'url("https://cdn.example.test/m2.jpg")' })]
    : [img('//img30.360buyimg.com/sku/d1.jpg'), img('//img30.360buyimg.com/sku/d2.jpg')];
  return [
    element('div', { attrs: { id: 'related-layout-head' } }, [element('div', { cls: 'ssd-module-wrap' }, [img('//img30.360buyimg.com/shop/activity.jpg')])]),
    element('div', { attrs: { id: 'detail-main' } }, [element('div', {}, images)]),
  ];
}

/**
 * Default review block, shaped like the 2026-10-15 probe. Nicknames and image addresses are present so tests can
 * assert they are not collected. A nested li.item is not a preview.
 * @param {{tags?: number, previews?: number, bodyLength?: number}|null} counts
 */
function reviewBlock(counts) {
  const generated = counts !== null;
  const tag = (label, count) => element('div', { cls: 'item' }, [
    element('div', { text: label }),
    ...(count === null ? [] : [element('div', { cls: 'count', text: count })]),
  ]);
  const tags = generated
    ? Array.from({ length: counts.tags ?? 2 }, (_, index) => tag(`合成印象${index + 1}`, String(index + 1)))
    : [tag('手感清楚', '3'), tag('做工清楚', '1万+'), tag('没有人数', null)];
  const preview = (body, images, nested) => element('li', { cls: 'item' }, [
    element('div', { cls: 'comment-user' }, [
      element('img', { cls: 'headimg', attrs: { src: 'https://img14.360buyimg.com/n0/synthetic-avatar.jpg' } }),
      element('div', { cls: 'nickname', text: 'Synthetic buyer' }),
    ]),
    element('div', { cls: 'info text-ellipsis-2', text: body }),
    element('div', { cls: 'imgs' }, images.map(src => element('div', { cls: 'term' }, [element('img', { attrs: { src } })]))),
    ...(nested ? [element('ul', {}, [element('li', { cls: 'item' }, [element('div', { cls: 'info', text: '嵌套评价不应被读到' })])])] : []),
  ]);
  const previewCount = counts?.previews ?? 2;
  const previews = Array.from({ length: previewCount }, (_, index) => {
    const body = generated
      ? index === 0 && counts.bodyLength > 0 ? '长'.repeat(counts.bodyLength) : `合成评价正文${index + 1}`
      : `合成评价正文${index === 0 ? '一' : '二'}`;
    return preview(body, index === 0 ? ['https://img14.360buyimg.com/n0/synthetic-review.jpg'] : [], index === 0);
  });
  return element('div', { cls: 'left-tabs-item everyone-reviews' }, [
    element('div', { cls: 'evaluation-qq' }, [
      element('div', { cls: 'comment-root', attrs: { id: 'comment-root' } }, [
        element('div', { cls: 'top-block' }, [
          element('div', { cls: 'comment-title', attrs: { id: 'comment-title' }, text: '买家评价(20+)' }),
          element('div', { cls: 'right-extra' }, [element('div', { cls: 'applause-rate golden', text: '超过半数' })]),
        ]),
        element('div', { cls: 'mt24' }, [
          element('div', { cls: 'tags' }, tags),
          element('ul', { cls: 'list' }, previews),
          element('div', { cls: 'all-btn' }, [element('span', { text: '全部评价' }), element('i', { cls: 'arrow' })]),
        ]),
      ]),
    ]),
  ]);
}

/**
 * A JD product page whose 商品详情 section is a skeleton until its title is scrolled into view.
 * @param {{productId?: string, title?: string, self?: boolean, detail?: 'img'|'css'|'none', loaded?: boolean, loadsOnScroll?: boolean,
 *   panels?: number, href?: string, extra?: object[], visibility?: 'visible'|'hidden', reviews?: boolean,
 *   reviewCounts?: {tags?: number, previews?: number, bodyLength?: number}|null}} options
 *   detail 'none' omits the section. reviews false omits the default review block.
 */
export function jdProductPage({ productId = '3290995', title = 'Synthetic JD mouse', self = true, detail = 'img', loaded = false,
  loadsOnScroll = true, panels = 1, href, extra = [], visibility = 'visible', reviews = true, reviewCounts = null } = {}) {
  const target = parseJdProductUrl(`https://item.jd.com/${productId}.html`);
  const page = { target, scrolls: 0, scrollY: 40, loaded };
  const build = () => {
    const sectionTitle = element('div', { cls: 'title', attrs: { id: 'SPXQ-title' }, text: '商品详情', top: page.scrolls ? 0 : 2800 });
    sectionTitle.scrollIntoView = options => {
      page.scrolls += 1; page.options = options; page.scrollY = 2900;
      if (loadsOnScroll) page.loaded = true;
      page.body = build();
    };
    const parameters = element('div', { cls: '_scoped_1egwu_1' }, page.loaded ? [
      // As on the live page: the value is the big `.title`, its name the small `.desc .text` below.
      element('div', { cls: 'highlight-attrs' }, [element('div', { cls: 'item' }, [element('div', { cls: 'title text-ellipsis', attrs: { title: '24个月' }, text: '24个月' }),
        element('div', { cls: 'desc' }, [element('div', { cls: 'text text-ellipsis', attrs: { title: '续航时间' }, text: '续航时间' })])])]),
      element('div', { cls: 'attrs' }, [element('div', { cls: 'item' }, [element('div', { cls: 'label' }, [element('span', { cls: 'text', text: '品牌' })]),
        element('div', { cls: 'value' }, [element('div', { cls: 'text', attrs: { title: '罗技（Logitech）' } }, [element('a', { text: '罗技（Logitech）' })])])]),
      element('div', { cls: 'item' }, [element('div', { cls: 'label' }, [element('span', { cls: 'text' })]), element('div', { cls: 'value' }, [element('div', { cls: 'text' })])])]),
    ] : [element('div', { cls: 'attrs' })]);
    const section = element('div', { cls: 'left-tabs-item' }, [sectionTitle, parameters,
      ...(page.loaded ? detailContent(detail) : [element('div', { cls: 'imgtext-ske mt24 skeleton' })])]);
    return element('body', {}, [
      element('div', { cls: 'shop-plugin' }, [element('div', { cls: 'top-name-tag' }, [
        ...(self ? [element('div', { cls: 'top-self-support-new' }, [element('img', { attrs: { src: 'x' } })])] : []),
        element('div', { cls: 'top-name', attrs: { title: 'Synthetic shop' }, text: 'Synthetic shop' })])]),
      element('div', { cls: 'image-carousel-track vertical' }, [element('div', { cls: 'item current' }, [img('//img10.360buyimg.com/n5/a.jpg')]),
        element('div', { cls: 'item' }, [img('//img10.360buyimg.com/n5/b.jpg')])]),
      element('div', { cls: 'product-tab-panel' }, Array.from({ length: panels }, () => element('div', { cls: 'product-tab-item' }, [rightPanel({ title, self })]))),
      element('div', { cls: 'left-tabs-content' }, [...(detail === 'none' ? [] : [section]), ...(reviews ? [reviewBlock(reviewCounts)] : [])]),
      ...extra,
    ]);
  };
  page.body = build();
  page.evaluate = script => {
    const context = { URL, location: { href: href ?? target.url }, innerHeight: 987,
      get scrollY() { return page.scrollY; },
      document: { title: 'JD product', readyState: 'complete', visibilityState: visibility, hasFocus: () => visibility === 'visible', get body() { return page.body; },
        querySelector: selector => page.body.querySelectorAll(selector)[0] ?? null, querySelectorAll: selector => page.body.querySelectorAll(selector) },
      getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible',
        textDecorationLine: node.lineThrough ? 'line-through' : 'none', backgroundImage: node.backgroundImage }) };
    context.globalThis = context;
    return JSON.parse(JSON.stringify(vm.runInNewContext(script, context)));
  };
  return page;
}
