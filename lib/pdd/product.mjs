import { ShoppingError } from '../errors.mjs';
import { parseDisplayedPrice } from '../product.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { pddPageGate } from './page-gate.mjs';
import { parsePddProductUrl } from './targets.mjs';

const PDD_PRODUCT_SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({ line: 300, head: 40, highlights: 60, reviews: 10, shop: 60, params: 80, notices: 10, bottom: 12,
  gallery: 20, detailImages: 150, specGroups: 6, specOptions: 40, marks: 4, url: 2000 });
// Short words PDD puts right before ¥; seen live: 券后, 补贴价 (2026-10-27).
const PRICE_LABEL = /^(券后|补贴价|拼单价|到手价?|折后|新人价|秒杀价|限时价)$/;
const PRICE_HIDDEN = '前往APP查看价格';
const REVIEW_TAG = /^(.{1,20})\(([0-9]{1,9})\)$/;
// 商品评价(142), or 商品评价(2,669) with a thousands separator (2026-10-27).
const REVIEW_COUNT = /^商品评价\(([0-9]{1,3}(?:,[0-9]{3}){1,2}|[0-9]{1,9})\)$/;

/**
 * Internal serialized collector for one PDD product page, as rendered after a search card click (2026-10-27 probes of a
 * mouse and a dress). Class names are hashed, so regions are found by their visible headings, in page order:
 * price block, title, highlights and services, 商品评价(N) previews, 该商品所属店铺评价 tags and the shop, 商品详情
 * parameters and images, then the 消费提醒 notice before 点击查看商品价格说明. The bottom bar and the hidden spec panel
 * (已选 … 确定) come after it. Three things never leave the page: rows of other buyers' 拼单 (they hold nicknames
 * and timers), reviewer names next to their avatar, and the 相似商品 list of other products.
 * @param {{product_id: string, title_prefix: string}} expected @param {Function} gate pddPageGate @param {object} limits
 * @returns {object} Raw guarded observation.
 */
export function collectPddProduct(expected, gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const ids = current.searchParams.getAll('goods_id');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/goods.html' || ids.length !== 1 || ids[0] !== expected.product_id) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = (text, max = limits.line) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const before = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & 4));
  // Icon-font glyphs (private-use characters) and "|" separators carry no text; a VIDEO's text is only its fallback message.
  const leaves = [...document.querySelectorAll('body *')].filter(node => node.children.length === 0 && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'VIDEO', 'AUDIO'].includes(node.tagName) &&
    !/^[\uE000-\uF8FF|\s]*$/.test(String(node.textContent ?? '')));
  const first = test => leaves.find(node => test(clip(node.textContent))) ?? null;
  const detail = first(text => text === '商品详情');
  // The panel's selection line reads "已选：…", or "请选择 容量" while a group has no default (2026-10-27).
  const chosen = leaves.filter(node => /^(已选[:：]|请选择)/.test(clip(node.textContent)));
  const confirm = leaves.filter(node => clip(node.textContent) === '确定');
  const service = first(text => text === '客服');
  if (!detail) return { state: 'structure_changed' };

  // The spec panel is in the page even while closed: its root is the element holding both 已选 and 确定.
  let panel = null;
  if (chosen.length === 1 && confirm.length === 1) {
    panel = chosen[0];
    while (panel && !panel.contains(confirm[0])) panel = panel.parentElement;
  }
  // The bottom bar is the element around 客服 that also holds the bar's ¥; a page without that bar has none.
  let bar = service;
  while (bar && ![...bar.querySelectorAll('*')].some(node => node.children.length === 0 && /^[¥￥]/.test(clip(node.textContent)))) bar = bar.parentElement;
  if (bar && bar.contains(detail)) bar = null;
  const inside = (root, node) => Boolean(root && root.contains(node));
  const endMarks = [first(text => text === '点击查看商品价格说明'), first(text => text === '相似商品'), bar ? leaves.find(node => inside(bar, node)) : null]
    .filter(node => node && before(detail, node));
  const end = endMarks.sort((a, b) => (before(a, b) ? -1 : 1))[0] ?? null;
  const main = leaves.filter(node => !inside(panel, node) && !inside(bar, node) && (!end || before(node, end)));

  // Another buyer's 拼单 row is a short block with 去拼单; every line in it is dropped.
  const inBuyerRow = node => {
    for (let up = node, level = 0; up && level < 6; up = up.parentElement, level += 1) {
      const text = String(up.textContent ?? '');
      if (text.length < 160 && text.includes('去拼单')) return true;
    }
    return false;
  };
  const buyerLines = main.filter(inBuyerRow);
  const kept = main.filter(node => !inBuyerRow(node));
  const indexOf = node => kept.indexOf(node);
  // A card draws the 【】 of the full title with icon-font glyphs (private-use characters): card "\ue641罗技\ue642M330…",
  // page "【罗技】M330…" (2026-10-27). Both are compared without brackets, glyphs and spaces.
  const titleKey = text => clip(text).replace(/[\s\uE000-\uF8FF【】\[\]（）()「」『』]/g, '');
  const prefix = titleKey(expected.title_prefix);
  const detailAt = indexOf(detail);
  const titleNode = kept.slice(0, detailAt).filter(node => titleKey(node.textContent).startsWith(prefix))
    .sort((a, b) => clip(b.textContent).length - clip(a.textContent).length)[0];
  if (!titleNode) return { state: 'title_mismatch' };
  const titleAt = indexOf(titleNode);
  // Any 商品评价(…) heading marks the region, so a count written another way is refused later instead of losing the reviews.
  const reviewHead = kept.slice(titleAt, detailAt).find(node => /^商品评价\(.{1,12}\)$/.test(clip(node.textContent))) ?? null;
  const shopHead = kept.slice(titleAt, detailAt).find(node => clip(node.textContent) === '该商品所属店铺评价') ?? null;
  // A shop without store review tags has no such heading (2026-10-27); its card is then the block around 进店逛逛.
  let shopCard = null;
  if (!shopHead) {
    const enter = kept.slice(titleAt, detailAt).find(node => clip(node.textContent) === '进店逛逛') ?? null;
    shopCard = enter;
    while (shopCard && kept.filter(node => shopCard.contains(node)).length < 3) shopCard = shopCard.parentElement;
    if (shopCard && (shopCard.contains(titleNode) || shopCard.contains(detail))) shopCard = null;
  }
  const lines = (from, to) => kept.slice(from, to).map(node => clip(node.textContent));
  const reviewAt = reviewHead ? indexOf(reviewHead) : -1;
  // Where the shop part starts, and its first line: after the heading, or the card's first line when there is none.
  const shopAt = shopHead ? indexOf(shopHead) : shopCard ? kept.findIndex(node => shopCard.contains(node)) : -1;
  const shopLinesFrom = shopHead ? shopAt + 1 : shopAt;
  const highlightsEnd = [reviewAt, shopAt, detailAt].find(at => at > titleAt);

  // A reviewer name sits in a small block with the avatar and nothing else.
  const isReviewerName = node => {
    for (let up = node.parentElement, level = 0; up && level < 2; up = up.parentElement, level += 1) {
      const avatar = [...up.querySelectorAll('img')].some(image => image.getBoundingClientRect().width <= 60);
      if (avatar) return clip(up.innerText) === clip(node.textContent);
    }
    return false;
  };
  let reviews = null;
  if (reviewHead) {
    const nodes = kept.slice(reviewAt + 1, shopAt > reviewAt ? shopAt : detailAt).filter(node => clip(node.textContent) !== '查看全部');
    const texts = nodes.filter(node => !isReviewerName(node)).map(node => clip(node.textContent));
    reviews = { heading: clip(reviewHead.textContent), texts: texts.slice(0, limits.reviews), texts_total: texts.length, names_skipped: nodes.length - texts.length };
  }

  // Parameter rows hold exactly a name and a value; other lines in the section are notices.
  const sectionNodes = kept.slice(detailAt + 1);
  const rows = new Map();
  for (const node of sectionNodes) {
    const row = node.parentElement;
    rows.set(row, [...(rows.get(row) ?? []), node]);
  }
  const params = [], notices = [];
  for (const [row, nodes] of rows) {
    const rowLeaves = [...row.querySelectorAll('*')].filter(node => node.children.length === 0 && clip(node.textContent));
    if (nodes.length === 2 && rowLeaves.length === 2) params.push(nodes.map(node => clip(node.textContent)));
    else notices.push(...nodes.map(node => clip(node.textContent)));
  }

  const imageUrl = image => {
    const src = String(image.getAttribute('src') ?? '');
    return (/^https:\/\/[a-z0-9.-]+\.pddpic\.com\//.test(src) ? src : String(image.getAttribute('data-src') ?? '')).slice(0, limits.url);
  };
  const unique = values => [...new Set(values.filter(Boolean))];
  // The gallery is the block around the "1/5" counter; its carousel repeats images, so addresses are de-duplicated.
  const counter = kept.slice(0, titleAt).find(node => /^[0-9]{1,3}\/[0-9]{1,3}$/.test(clip(node.textContent))) ?? null;
  let gallery = counter;
  while (gallery && ![...gallery.querySelectorAll('img')].some(image => image.getBoundingClientRect().width >= 300)) gallery = gallery.parentElement;
  const galleryImages = gallery ? unique([...gallery.querySelectorAll('img')].filter(image => image.getBoundingClientRect().width >= 300).map(imageUrl)) : [];
  // Detail images: after 商品详情 and before the section's end, without avatars.
  const detailImages = unique([...document.querySelectorAll('img')].filter(image => before(detail, image) && (!end || before(image, end)) &&
    !inside(panel, image) && !inside(bar, image)).map(imageUrl).filter(url => { try { return !new URL(url).hostname.startsWith('avatar'); } catch { return false; } }));

  let spec = null;
  if (panel) {
    // Panel layout (2026-10-27): a header (price, offers, 已选), a block whose children are the groups, then 确定.
    // Each group is a name and a list of options.
    const groups = [];
    const blocks = [...panel.children].filter(block => !block.contains(chosen[0]) && !block.contains(confirm[0]));
    for (const block of blocks) {
      for (const group of block.children) {
        const [nameNode, list] = group.children;
        if (group.children.length !== 2 || !list.children.length) continue;
        // A name can carry a link inside it, as 尺码 does with 尺码详情; only the name's own text is kept.
        const whole = String(nameNode.textContent ?? '');
        const own = [...nameNode.children].reduce((text, child) => text.replace(String(child.textContent ?? ''), ''), whole);
        const name = clip(own) || clip(whole);
        const options = [...list.children].map(option => {
          const texts = [option, ...option.querySelectorAll('*')].filter(node => node.children.length === 0).map(node => clip(node.textContent)).filter(Boolean);
          const label = [...texts].sort((a, b) => b.length - a.length)[0] ?? '';
          return { label, marks: texts.filter(text => text !== label).slice(0, limits.marks) };
        });
        if (!name || options.some(option => !option.label)) continue;
        groups.push({ name, options: options.slice(0, limits.specOptions), options_total: options.length });
      }
    }
    spec = { chosen: clip(chosen[0].textContent), groups: groups.slice(0, limits.specGroups), groups_total: groups.length };
  }

  const bounded = (values, max) => ({ values: values.slice(0, max), total: values.length });
  return {
    state: 'observed', product_id: expected.product_id, title: clip(titleNode.textContent),
    head: bounded(lines(0, titleAt), limits.head),
    highlights: bounded(lines(titleAt + 1, highlightsEnd), limits.highlights), buyer_lines_skipped: buyerLines.length,
    reviews, shop: shopAt >= 0 ? bounded(lines(shopLinesFrom, detailAt), limits.shop) : null,
    params: bounded(params, limits.params), notices: bounded(notices, limits.notices),
    bottom: bar ? bounded([...bar.querySelectorAll('*')].filter(node => node.children.length === 0).map(node => clip(node.textContent)).filter(Boolean), limits.bottom) : null,
    gallery: { counter: counter ? clip(counter.textContent) : null, ...bounded(galleryImages, limits.gallery) },
    detail_images: bounded(detailImages, limits.detailImages), spec,
  };
}

/**
 * @param {string} productId goods_id of the page. @param {string} titlePrefix The search card title, which the full title starts with.
 * @returns {string} One fixed read-only expression; no click, scroll or request. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function pddProductScript(productId, titlePrefix) {
  if (!parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${productId}`) || typeof titlePrefix !== 'string' ||
      !titlePrefix.trim() || titlePrefix.length > LIMITS.line) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD goods_id and the search card title.');
  }
  return `(${collectPddProduct})(${JSON.stringify({ product_id: productId, title_prefix: titlePrefix })}, ${pddPageGate}, ${JSON.stringify(LIMITS)})`;
}

/** The title without brackets, icon-font glyphs and spaces, as the collector compares it with the card title. */
const titleKey = text => text.replace(/[\s\uE000-\uF8FF【】\[\]（）()「」『』]/g, '');

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The PDD product response does not match the supported page.');

function textList(value, max, lineMax = LIMITS.line) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.values) || value.values.length > max || !Number.isSafeInteger(value.total) ||
      value.total < value.values.length || value.total > 100000) throw invalid();
  return { values: value.values.map(line => responseText(line, lineMax)).filter(Boolean), cut: value.total > value.values.length };
}

function imageUrl(value) {
  try {
    const url = new URL(responseText(value, LIMITS.url));
    return url.protocol === 'https:' && url.hostname.endsWith('.pddpic.com') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function imageList(value, max) {
  const list = textList(value, max, LIMITS.url);
  return { urls: list.values.map(imageUrl).filter(Boolean), cut: list.cut };
}

/** Split the lines above the title: gallery counter, label, ¥, amount pieces, then offers and sales. */
function priceFields(head) {
  const lines = head.filter(line => line !== '|' && !/^[0-9]{1,3}\/[0-9]{1,3}$/.test(line));
  const sign = lines.findIndex(line => /^[¥￥]/.test(line));
  if (sign < 0) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The PDD product page shows no price before its title.');
  const label = sign > 0 && PRICE_LABEL.test(lines[sign - 1]) ? lines[sign - 1] : '';
  const pieces = [lines[sign].replace(/^[¥￥]\s*/, '')].filter(Boolean);
  let end = sign + 1;
  // The amount is split as "89", ".", "9"; a hidden one reads like "7?.??".
  while (end < lines.length && /^[0-9.?]{1,12}$/.test(lines[end]) && pieces.join('').length < 20) pieces.push(lines[end++]);
  const amountText = pieces.join('');
  const hidden = amountText.includes('?') || lines.includes(PRICE_HIDDEN);
  const notes = [...lines.slice(0, label ? sign - 1 : sign), ...lines.slice(end)].filter(line => line !== PRICE_HIDDEN);
  const shown = hidden ? { kind: 'hidden_by_page', amount: null, minimum: null, maximum: null } : parseDisplayedPrice(amountText, label);
  return { price: { raw: [label, '¥', amountText].filter(Boolean).join(' '), amount_text: amountText, label, ...shown, currency: 'CNY',
    hidden_by_page: hidden, eligibility_verified: false, sku_price_binding_verified: false }, notes };
}

function specFields(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.groups) || value.groups.length > LIMITS.specGroups ||
      !Number.isSafeInteger(value.groups_total) || value.groups_total < value.groups.length) throw invalid();
  return {
    chosen: responseText(value.chosen, LIMITS.line).replace(/^已选[:：]\s*/, ''),
    groups: value.groups.map(group => {
      if (!Array.isArray(group?.options) || group.options.length > LIMITS.specOptions || !Number.isSafeInteger(group.options_total) ||
          group.options_total < group.options.length) throw invalid();
      return { name: responseText(group.name, LIMITS.line), options_cut: group.options_total > group.options.length,
        options: group.options.map(option => {
          if (!Array.isArray(option?.marks) || option.marks.length > LIMITS.marks) throw invalid();
          return { label: responseText(option.label, LIMITS.line), marks: option.marks.map(mark => responseText(mark, LIMITS.line)) };
        }) };
    }),
    groups_cut: value.groups_total > value.groups.length,
  };
}

function paramFields(value) {
  if (!value || !Array.isArray(value.values) || value.values.length > LIMITS.params || !Number.isSafeInteger(value.total) ||
      value.total < value.values.length) throw invalid();
  const values = value.values.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2) throw invalid();
    return { name: responseText(pair[0], LIMITS.line), value: responseText(pair[1], LIMITS.line) };
  });
  return { values, cut: value.total > value.values.length };
}

/** Store review tags like 回头客(17) lead the shop block; the first other line is the shop name. */
function shopFields(lines) {
  const tags = [];
  let at = 0;
  for (; at < lines.length; at += 1) {
    const tag = lines[at].match(REVIEW_TAG);
    if (!tag) break;
    tags.push({ label: tag[1], count: Number(tag[2]) });
  }
  const rest = lines.slice(at);
  return { name: rest[0] ?? null, review_tags: tags, lines: rest.slice(1) };
}

/**
 * Validate one observation of a PDD product page. When the page hides the price ("前往APP查看价格", seen on some
 * products), the amount is not kept and price.hidden_by_page is true; the user chose to skip such products (2026-10-27).
 * @param {unknown} value Raw page observation. @param {string} productId @param {string} titlePrefix The search card title.
 * @param {{observedAt?: string}} [options]
 * @returns {object} Product fields. @throws {ShoppingError} Page gates, TITLE_MISMATCH, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
 */
export function validatePddProduct(value, productId, titlePrefix, { observedAt = new Date().toISOString() } = {}) {
  const target = parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${productId}`);
  if (!target || typeof titlePrefix !== 'string' || !titlePrefix.trim()) throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD goods_id and the search card title.');
  if (value?.state === 'title_mismatch') {
    throw new ShoppingError('TITLE_MISMATCH', 'The opened product page has no title starting with the search card title.', 'Check the tab; this task does not click again.');
  }
  throwPageError(value?.state);
  if (value?.state !== 'observed' || value.product_id !== productId || !Number.isSafeInteger(value.buyer_lines_skipped) || value.buyer_lines_skipped < 0 ||
      !value.gallery || typeof value.gallery !== 'object') throw invalid();
  const title = responseText(value.title, LIMITS.line);
  if (!titleKey(title).startsWith(titleKey(titlePrefix)) || !titleKey(titlePrefix)) throw invalid();
  const head = textList(value.head, LIMITS.head);
  const { price, notes } = priceFields(head.values);
  let reviews = null;
  if (value.reviews !== null) {
    const headingText = responseText(value.reviews?.heading, LIMITS.line);
    if (/^商品评价\(.{1,12}\)$/.test(headingText) && !REVIEW_COUNT.test(headingText)) {
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The PDD 商品评价 heading shows its count in an unsupported form.', 'Report the heading; the reader supports digits with thousands separators.');
    }
    const heading = headingText.match(REVIEW_COUNT);
    if (!heading || !Array.isArray(value.reviews.texts) || value.reviews.texts.length > LIMITS.reviews || !Number.isSafeInteger(value.reviews.texts_total) ||
        value.reviews.texts_total < value.reviews.texts.length || !Number.isSafeInteger(value.reviews.names_skipped) || value.reviews.names_skipped < 0) throw invalid();
    reviews = { count: Number(heading[1].replaceAll(',', '')), previews: value.reviews.texts.map(text => responseText(text, LIMITS.line)).filter(Boolean),
      previews_cut: value.reviews.texts_total > value.reviews.texts.length, reviewer_names_skipped: value.reviews.names_skipped };
  }
  const shop = value.shop === null ? null : textList(value.shop, LIMITS.shop);
  const params = paramFields(value.params);
  const counter = value.gallery.counter === null ? null : responseText(value.gallery.counter, 10);
  if (counter !== null && !/^[0-9]{1,3}\/[0-9]{1,3}$/.test(counter)) throw invalid();
  const gallery = imageList(value.gallery, LIMITS.gallery);
  const details = imageList(value.detail_images, LIMITS.detailImages);
  const highlights = textList(value.highlights, LIMITS.highlights);
  const notices = textList(value.notices, LIMITS.notices);
  const bottom = value.bottom === null ? null : textList(value.bottom, LIMITS.bottom);
  const spec = specFields(value.spec);
  const shopParts = shop ? shopFields(shop.values) : null;
  return {
    product_id: target.product_id, url: target.url, observed_at: observedAt, title, price, price_notes: notes,
    gallery: { counter, total_shown: counter ? Number(counter.split('/')[1]) : null, images: gallery.urls, images_cut: gallery.cut },
    highlights: highlights.values, highlights_cut: highlights.cut, other_buyer_lines_skipped: value.buyer_lines_skipped,
    reviews, shop: shopParts && { ...shopParts, lines_cut: shop.cut },
    params: params.values, params_cut: params.cut, notices: notices.values,
    bottom_bar: bottom ? bottom.values : null, spec, detail_images: details.urls, detail_images_cut: details.cut,
  };
}

/**
 * The saved product block of a pdd_product result, with its coverage. Rebuilt from the raw observation kept in the
 * task journal, so an edited result is rejected.
 * @param {object} raw @param {string} productId @param {string} titlePrefix @param {string} observedAt @returns {object}
 */
export function pddProductFields(raw, productId, titlePrefix, observedAt) {
  const product = validatePddProduct(raw, productId, titlePrefix, { observedAt });
  return {
    ...product,
    coverage: { status: 'partial', scope: 'product_page_as_rendered', price_hidden_by_page: product.price.hidden_by_page, reviews_scope: 'page_previews',
      spec_prices_read: false, spec_panel_opened: false, detail_images_scrolled: false, similar_products_read: false },
    missing: ['per_spec_prices', 'all_reviews', 'verified_payable_price', ...(product.price.hidden_by_page ? ['displayed_price'] : [])],
    excluded: ['other_buyers', 'reviewer_names', 'similar_products'],
  };
}

export { PDD_PRODUCT_SCHEMA_VERSION };
