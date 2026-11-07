import { ShoppingError } from '../errors.mjs';
import { parseDisplayedPrice } from '../product.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { jdPageGate } from './page-gate.mjs';
import { parseJdProductUrl } from './targets.mjs';

/** Bounds on one product read; the 2026-10-15 probes saw at most 25 options, 13 service tags, 11 parameters, 14 detail modules, 12 impression tags and 3 review previews. */
export const JD_PRODUCT_LIMITS = Object.freeze({ groups: 6, options: 60, series: 20, services: 30, gallery: 20, parameters: 60,
  highlights: 20, detail_elements: 120, detail_images: 80, tags: 10, icons: 6, review_tags: 20, review_previews: 10 });

/**
 * Result format, all 2026-10-15. 2 (after the first live run): self-operated from the shop header badge, highlight names
 * and values the right way round, empty parameter rows dropped, and the page's visibility and positions recorded with the
 * section. 3 (after the second): each service tag keeps its short name and its explanation, instead of one or the other.
 * 4: the default review block already visible on the page (title, praise line, impression tags, preview text and image counts).
 */
export const JD_PRODUCT_SCHEMA_VERSION = 4;

// Regions of the loaded 商品详情 section, in page order. Head and footer carry shop activity and reminder floors.
const DETAIL_REGIONS = Object.freeze([['related_head', '#related-layout-head'], ['detail_top', '#detail-top'],
  ['detail_main', '#detail-main'], ['related_footer', '#related-layout-footer']]);

/**
 * Internal serialized collector for one JD product page. Structure from the 2026-10-15 probes: the right panel uses
 * stable BEM classes; the 商品详情 section is a skeleton until it is scrolled into view, after which its images are
 * either IMG elements or CSS backgrounds of `.ssd-module` blocks. Reads only; never clicks or scrolls.
 * @param {{product_id: string, regions: string[][]}} expected @param {Function} gate jdPageGate @param {object} limits
 * @returns {object} Raw guarded observation.
 */
export function collectJdProduct(expected, gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  if (current.hostname !== 'item.jd.com' || current.pathname !== `/${expected.product_id}.html`) return { state: 'target_changed' };
  if (document.readyState !== 'complete') return { state: 'loading' };
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const text = (node, max) => String(node?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const attribute = (node, name, max) => String(node?.getAttribute(name) ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const hasClass = (node, name) => String(node.getAttribute('class') ?? '').split(/\s+/).includes(name);
  const lineThrough = node => [node, ...node.querySelectorAll('*')].some(part => String(getComputedStyle(part).textDecorationLine ?? '').includes('line-through'));
  const imageOf = image => image ? { src: attribute(image, 'src', 1000), loaded: Boolean(image.complete && image.naturalWidth > 0),
    width: Number(image.naturalWidth) || 0, height: Number(image.naturalHeight) || 0 } : null;

  const panels = [...document.querySelectorAll('.page-right-content')].filter(panel => visible(panel) && panel.querySelector('.sku-title-name'));
  if (panels.length !== 1) return { state: 'structure_changed' };
  const [panel] = panels;
  const priceBlock = panel.querySelector('.product-price-panel');
  const main = priceBlock?.querySelector('.product-price--main') ?? null;
  const priceTags = [...(priceBlock?.querySelectorAll('.product-price--activity-item') ?? [])].slice(0, limits.tags);
  const grayAmounts = [...(priceBlock?.querySelectorAll('.product-price--gray') ?? [])].slice(0, 3);
  const seriesLayout = panel.querySelector('.specification-series-layout');
  const shop = [...document.querySelectorAll('.shop-plugin .top-name')].find(node => visible(node) && (attribute(node, 'title', 200) || text(node, 200)));

  const panelRead = {
    title: text(panel.querySelector('.sku-title-name'), 300),
    // Live 2026-10-15: the title icons' alt texts are only numbers; the self-operated mark is a badge in the shop header.
    shop_self_badge: [...document.querySelectorAll('.shop-plugin .top-self-support-new')].some(visible),
    title_icons: [...panel.querySelectorAll('.sku-title-icon-box img')].slice(0, limits.icons).map(image => attribute(image, 'alt', 40)),
    // The panel also holds the review count and a price-alert link, so the raw price is the price parts only.
    price: { raw: [main, ...priceTags, ...grayAmounts].map(node => text(node, 60)).filter(Boolean).join(' ').slice(0, 300),
      amount_text: text(main, 60).replace(/\s+/g, ''), tags: priceTags.map(node => text(node, 40)),
      other_amounts: grayAmounts.map(node => ({ text: text(node, 40), line_through: lineThrough(node) })) },
    comment_count_text: text(priceBlock?.querySelector('.product-price-panel--options-comment-count') ?? null, 40),
    shop: shop ? attribute(shop, 'title', 200) || text(shop, 200) : '',
    series: seriesLayout ? { label: text(seriesLayout.querySelector('.layout-label'), 20),
      items: [...seriesLayout.querySelectorAll('.specification-series-item')].slice(0, limits.series)
        .map(item => ({ text: text(item, 60), selected: hasClass(item, 'specification-series-item--selected') })) } : null,
    groups: [...panel.querySelectorAll('.specification-group')].slice(0, limits.groups).map(group => ({
      name: text(group.querySelector('.specification-group-label'), 40),
      options: [...group.querySelectorAll('.specification-item-sku')].slice(0, limits.options).map(option => ({
        text: text(option.querySelector('.specification-item-sku-text'), 120), title: attribute(option, 'title', 200),
        selected: hasClass(option, 'specification-item-sku--selected'), out_of_stock: hasClass(option, 'specification-item-sku--lack'),
        out_of_stock_text: text(option.querySelector('.specification-item-sku--lack-tag'), 20),
        image: imageOf(option.querySelector('img.specification-item-sku-image')) })),
      options_seen: group.querySelectorAll('.specification-item-sku').length })),
    // Live 2026-10-15: the visible text is the tag's short name; its title attribute holds the longer explanation.
    services: [...panel.querySelectorAll('.service-support-tag-item')].slice(0, limits.services).map(item => {
      const label = item.querySelector('.service-support-tag-item--link, .service-support-tag-item--text') ?? item;
      return { label: text(label, 40), description: attribute(label, 'title', 300) };
    }),
    services_seen: panel.querySelectorAll('.service-support-tag-item').length,
    gallery: [...document.querySelectorAll('.image-carousel-track .item')].slice(0, limits.gallery).map(item => imageOf(item.querySelector('img'))),
    gallery_seen: document.querySelectorAll('.image-carousel-track .item').length,
  };

  const title = document.querySelector('#SPXQ-title');
  const section = title ? title.closest('.left-tabs-item') : null;
  let detail = { status: 'section_missing' };
  if (section) {
    const regions = expected.regions.map(([name, selector]) => [name, section.querySelector(selector)]).filter(([, root]) => root);
    const skeleton = [...section.querySelectorAll('.skeleton')].some(visible);
    const elements = regions.flatMap(([name, root]) => [...root.querySelectorAll('img, .ssd-module')].map(node => [name, node]));
    const images = elements.slice(0, limits.detail_elements).map(([region, node]) => {
      if (node.tagName === 'IMG') return { region, kind: 'img', ...imageOf(node) };
      const background = String(getComputedStyle(node).backgroundImage ?? '');
      const box = node.getBoundingClientRect();
      return { region, kind: 'css_background', src: (/url\(["']?([^"')]+)["']?\)/.exec(background)?.[1] ?? '').slice(0, 1000), loaded: null,
        width: Math.round(box.width) || 0, height: Math.round(box.height) || 0 };
    });
    const pairs = (selector, name, value) => [...section.querySelectorAll(selector)].map(item => ({
      name: attribute(item.querySelector(name), 'title', 80) || text(item.querySelector(name), 80),
      value: attribute(item.querySelector(value), 'title', 300) || text(item.querySelector(value), 300) }));
    const top = title.getBoundingClientRect().top;
    detail = {
      status: regions.some(([name]) => name === 'detail_main') ? 'loaded' : skeleton ? 'not_loaded' : 'empty',
      title_in_view: top >= 0 && top < (globalThis.innerHeight ?? 0),
      // Lazy sections load only while the page renders; a hidden or covered window may keep them as skeletons.
      view: { visible: document.visibilityState === 'visible', focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        scroll_y: Math.round(globalThis.scrollY ?? 0), title_top: Math.round(top) },
      // Live 2026-10-15: a highlight shows its value in `.title` and its name below it in `.desc .text`.
      highlights: pairs('.highlight-attrs .item', '.desc .text', '.title').slice(0, limits.highlights),
      parameters: pairs('.attrs .item', '.label .text', '.value .text').slice(0, limits.parameters),
      parameters_seen: section.querySelectorAll('.attrs .item').length,
      images, elements_seen: elements.length,
    };
  }

  // The default review block is on the page when it opens. Read it in place; do not open 全部评价.
  const reviewRoot = document.querySelector('#comment-root');
  let reviews = { status: 'missing' };
  if (reviewRoot) {
    const tagNodes = [...reviewRoot.querySelectorAll('.tags .item')];
    // Direct children only: a descendant li.item inside one preview is not another preview.
    const previewNodes = [...reviewRoot.querySelectorAll('ul.list')].flatMap(list => [...(list.children ?? [])]
      .filter(child => child.tagName === 'LI' && hasClass(child, 'item')));
    const outsideCount = item => {
      const countNode = item.querySelector('.count');
      const parts = [];
      const walk = node => {
        if (node === countNode) return;
        if (node.nodeType === 3) { parts.push(node.nodeValue ?? ''); return; }
        for (const child of node.childNodes ?? []) walk(child);
      };
      walk(item);
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    };
    const allBtn = reviewRoot.querySelector('.all-btn');
    reviews = {
      title: text(reviewRoot.querySelector('#comment-title'), 40),
      praise: text(reviewRoot.querySelector('.applause-rate'), 40),
      tags: tagNodes.slice(0, limits.review_tags).map(item => ({ text: outsideCount(item).slice(0, 30),
        count_text: text(item.querySelector('.count'), 20) })),
      tags_seen: tagNodes.length,
      // textContent, not innerText: the page clamps each preview to two lines, so innerText can follow that layout.
      previews: previewNodes.slice(0, limits.review_previews).map(item => {
        const full = String(item.querySelector('.info')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        return { body: full.slice(0, 1000), body_length: full.length, image_count: item.querySelectorAll('.imgs img').length };
      }),
      previews_seen: previewNodes.length,
      all_reviews_entry: Boolean(allBtn && visible(allBtn) && text(allBtn, 40) === '全部评价'),
    };
  }
  return { state: 'observed', product_id: expected.product_id, panel: panelRead, detail, reviews };
}

function expectedTarget(target) {
  const expected = parseJdProductUrl(target?.url);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(target)) throw new ShoppingError('INVALID_TARGET', 'Use a canonical JD product target.');
  return expected;
}

/**
 * @param {object} target Canonical JD product target. @returns {string} One fixed read-only expression; no click, scroll or request.
 * @throws {ShoppingError} INVALID_TARGET.
 */
export function jdProductScript(target) {
  const expected = expectedTarget(target);
  return `(${collectJdProduct})(${JSON.stringify({ product_id: expected.product_id, regions: DETAIL_REGIONS })}, ${jdPageGate}, ${JSON.stringify(JD_PRODUCT_LIMITS)})`;
}

/**
 * Internal serialized single scroll: bring the 商品详情 title to the top once so its lazy section loads.
 * @param {{product_id: string}} expected @param {Function} gate jdPageGate @returns {object} Gate state or scroll positions.
 */
export function scrollJdDetailSection(expected, gate) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  if (current.hostname !== 'item.jd.com' || current.pathname !== `/${expected.product_id}.html`) return { state: 'target_changed' };
  const title = document.querySelector('#SPXQ-title');
  if (!title || !title.closest('.left-tabs-item')) return { state: 'structure_changed' };
  const before = Math.round(globalThis.scrollY ?? 0);
  title.scrollIntoView({ behavior: 'instant', block: 'start' });
  return { state: 'scrolled', scroll_y_before: before, scroll_y_after: Math.round(globalThis.scrollY ?? 0) };
}

/** @param {object} target @returns {string} The fixed single-scroll expression. @throws {ShoppingError} INVALID_TARGET. */
export function jdDetailScrollScript(target) {
  const expected = expectedTarget(target);
  return `(${scrollJdDetailSection})(${JSON.stringify({ product_id: expected.product_id })}, ${jdPageGate})`;
}

/**
 * @param {unknown} value Raw scroll acknowledgement. @returns {{scroll_y_before: number, scroll_y_after: number}}
 * @throws {ShoppingError} Page gates (not dispatched) or INVALID_RESPONSE.
 */
export function validateJdDetailScroll(value) {
  throwPageError(value?.state);
  const position = number => Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000;
  if (value?.state !== 'scrolled' || !position(value.scroll_y_before) || !position(value.scroll_y_after)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The JD detail scroll acknowledgement is invalid.');
  }
  return { scroll_y_before: value.scroll_y_before, scroll_y_after: value.scroll_y_after };
}

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The JD product response does not match the supported page shape.');
function flag(value) { if (typeof value !== 'boolean') throw invalid(); return value; }
function list(value, max) { if (!Array.isArray(value) || value.length > max) throw invalid(); return value; }
function count(value, minimum) { if (!Number.isSafeInteger(value) || value < minimum || value > 10000) throw invalid(); return value; }
function size(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw invalid(); return value; }

/** Only https JD image hosts are kept; protocol-relative links are completed. @returns {string|null} */
export function jdImageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 1000) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return url.protocol === 'https:' && !url.username && !url.password && /(^|\.)360buyimg\.com$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function image(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw invalid();
  return { url: jdImageUrl(value.src), loaded: value.loaded === null ? null : flag(value.loaded), width: size(value.width), height: size(value.height) };
}

function normalizePanel(panel, schemaVersion) {
  if (!panel || typeof panel !== 'object') throw invalid();
  const title = responseText(panel.title, 300);
  if (!title) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The JD product title was not found.');
  const icons = list(panel.title_icons, JD_PRODUCT_LIMITS.icons).map(alt => responseText(alt, 40));
  const raw = responseText(panel.price?.raw, 300), amountText = responseText(panel.price?.amount_text, 60);
  const series = panel.series === null ? null : { label: responseText(panel.series?.label, 20),
    items: list(panel.series?.items, JD_PRODUCT_LIMITS.series).map(item => ({ text: responseText(item?.text, 60), selected: flag(item?.selected) })) };
  const groups = list(panel.groups, JD_PRODUCT_LIMITS.groups).map((group, groupIndex) => {
    const options = list(group?.options, JD_PRODUCT_LIMITS.options).map((option, index) => ({ position: index + 1,
      text: responseText(option?.text, 120), title: responseText(option?.title, 200), selected: flag(option?.selected),
      out_of_stock: flag(option?.out_of_stock), out_of_stock_text: responseText(option?.out_of_stock_text, 20), image: image(option?.image) }));
    return { position: groupIndex + 1, name: responseText(group?.name, 40), options, options_seen: count(group?.options_seen, options.length) };
  });
  const gallery = list(panel.gallery, JD_PRODUCT_LIMITS.gallery).map((item, index) => ({ position: index + 1, ...(image(item) ?? { url: null, loaded: false, width: 0, height: 0 }) }));
  // Format 1 (the first live run) looked for 自营 in the icon alt texts, which turned out to be numbers.
  const selfOperated = schemaVersion === 1 ? icons.some(alt => alt.includes('自营')) : flag(panel.shop_self_badge);
  return {
    title, title_icons: icons, self_operated: selfOperated,
    price: { raw, amount_text: amountText, ...parseDisplayedPrice(amountText, raw), currency: 'CNY',
      tags: list(panel.price?.tags, JD_PRODUCT_LIMITS.tags).map(tag => responseText(tag, 40)),
      other_amounts: list(panel.price?.other_amounts, 3).map(amount => ({ text: responseText(amount?.text, 40), line_through: flag(amount?.line_through) })),
      eligibility_verified: false },
    comment_count_text: responseText(panel.comment_count_text, 40), shop: responseText(panel.shop, 200),
    series, same_group_specs: groups,
    services: list(panel.services, JD_PRODUCT_LIMITS.services).map(service => schemaVersion < 3 ? responseText(service, 80)
      : { label: responseText(service?.label, 40), description: responseText(service?.description, 300) }),
    services_seen: count(panel.services_seen, panel.services.length),
    gallery, gallery_seen: count(panel.gallery_seen, gallery.length),
  };
}

function view(value) {
  const position = number => Number.isSafeInteger(number) && Math.abs(number) <= 1_000_000;
  if (!value || Object.keys(value).sort().join(',') !== 'focused,scroll_y,title_top,visible' || ![true, false, null].includes(value.focused) ||
      !position(value.scroll_y) || !position(value.title_top)) throw invalid();
  return { visible: flag(value.visible), focused: value.focused, scroll_y: value.scroll_y, title_top: value.title_top };
}

function normalizeDetail(detail, schemaVersion) {
  if (detail?.status === 'section_missing') return { status: 'section_missing' };
  if (!['loaded', 'not_loaded', 'empty'].includes(detail?.status)) throw invalid();
  const pairs = (value, max) => list(value, max).map(pair => ({ name: responseText(pair?.name, 80), value: responseText(pair?.value, 300) }));
  const parameters = pairs(detail.parameters, JD_PRODUCT_LIMITS.parameters);
  // Format 2 drops rows with neither name nor value (one seen live on 2026-10-15) and counts them.
  const kept = schemaVersion === 1 ? parameters : parameters.filter(row => row.name || row.value);
  let unsupported = 0;
  const images = [];
  list(detail.images, JD_PRODUCT_LIMITS.detail_elements).forEach((item, index) => {
    if (!DETAIL_REGIONS.some(([name]) => name === item?.region) || !['img', 'css_background'].includes(item?.kind)) throw invalid();
    const url = jdImageUrl(item.src);
    if (item.kind === 'css_background' && item.loaded !== null) throw invalid();
    const loaded = item.kind === 'img' ? flag(item.loaded) : null;
    if (!url) { unsupported += 1; return; }
    if (images.length < JD_PRODUCT_LIMITS.detail_images) {
      images.push({ position: images.length + 1, element_position: index + 1, region: item.region, kind: item.kind, url, loaded,
        width: size(item.width), height: size(item.height) });
    }
  });
  const scanned = detail.images.length;
  return {
    status: detail.status, title_in_view: flag(detail.title_in_view), ...(schemaVersion === 1 ? {} : { view: view(detail.view) }),
    highlights: pairs(detail.highlights, JD_PRODUCT_LIMITS.highlights),
    parameters: kept, parameters_seen: count(detail.parameters_seen, detail.parameters.length),
    ...(schemaVersion === 1 ? {} : { empty_parameter_rows_omitted: parameters.length - kept.length }),
    images, elements_seen: count(detail.elements_seen, scanned), elements_scanned: scanned,
    unsupported_elements_omitted: unsupported, images_beyond_limit_omitted: scanned - unsupported - images.length,
  };
}

/** Last parenthetical in a review title, halfwidth or fullwidth. Empty and missing pairs stay null; the text is not parsed as a number. */
function reviewCountText(title) {
  let value = null;
  for (const match of title.matchAll(/[（(]([^（）()]*)[）)]/g)) value = match[1].trim();
  return value ? value : null;
}

/**
 * @param {object} reviews Raw default-review block, or `{status: 'missing'}`.
 * @returns {object} Normalized block. Counts stay page text.
 * @throws {ShoppingError} INVALID_RESPONSE.
 */
function normalizeReviews(reviews) {
  if (!reviews || typeof reviews !== 'object') throw invalid();
  if (reviews.status === 'missing') {
    if (Object.keys(reviews).length !== 1) throw invalid();
    return { status: 'missing' };
  }
  const title = responseText(reviews.title, 40);
  const tags = list(reviews.tags, JD_PRODUCT_LIMITS.review_tags).map(tag => ({ text: responseText(tag?.text, 30),
    count_text: responseText(tag?.count_text, 20) }));
  const previews = list(reviews.previews, JD_PRODUCT_LIMITS.review_previews).map(preview => {
    const body = responseText(preview?.body, 1000);
    const bodyLength = size(preview?.body_length);
    if (bodyLength < body.length) throw invalid();
    return { body, body_length: bodyLength, image_count: count(preview?.image_count, 0) };
  });
  return {
    status: 'loaded', title, count_text: reviewCountText(title), praise: responseText(reviews.praise, 40), tags,
    tags_seen: count(reviews.tags_seen, tags.length), previews, previews_seen: count(reviews.previews_seen, previews.length),
    all_reviews_entry: flag(reviews.all_reviews_entry),
  };
}

/**
 * Validate one raw product observation into normalized panel and detail fields.
 * @param {unknown} value Raw page observation. @param {object} target Canonical JD product target.
 * @param {{schemaVersion?: 1|2|3|4}} [options] 1 and 2 rebuild the first two live runs, 3 the third (2026-10-15). 4 also returns reviews.
 * @returns {{panel: object, detail: object, reviews?: object}} Versions 1-3 omit reviews.
 * @throws {ShoppingError} Page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validateJdProductObservation(value, target, { schemaVersion = JD_PRODUCT_SCHEMA_VERSION } = {}) {
  const expected = expectedTarget(target);
  throwPageError(value?.state);
  if (value?.state !== 'observed' || value.product_id !== expected.product_id || ![1, 2, 3, 4].includes(schemaVersion)) throw invalid();
  const panel = normalizePanel(value.panel, schemaVersion);
  const detail = normalizeDetail(value.detail, schemaVersion);
  if (schemaVersion !== 4) return { panel, detail };
  return { panel, detail, reviews: normalizeReviews(value.reviews) };
}
