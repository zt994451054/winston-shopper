import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { orderDetailTargetScript, validateOrderDetailTarget } from './order-target.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, responseText, throwPageError } from './page-dom.mjs';

/**
 * Preserve directly observed desktop or mobile title-link identities, without claiming redirect equivalence.
 * @param {string} value Observed absolute title href.
 * @returns {object|null} Canonical source route and its explicit product ID; tracking values removed.
 * @example parseOrderDetailProductUrl('https://a.m.taobao.com/i123.htm?from=detail');
 */
export function parseOrderDetailProductUrl(value) {
  const desktop = parseProductUrl(value);
  if (desktop) return desktop;
  if (typeof value !== 'string' || value.length > 16384) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'a.m.taobao.com' || url.username || url.password || url.port ||
      url.searchParams.has('id') || url.searchParams.has('itemId')) return null;
  const id = url.pathname.match(/^\/i([0-9]{1,64})\.htm$/)?.[1];
  if (!id) return null;
  return {platform:'taobao',origin:url.origin,pathname:url.pathname,product_id:id,url:`${url.origin}${url.pathname}`};
}

function collectOrderBody(address, dom, productUrl) {
  if (address.state !== 'observed') return address;
  const gate = dom.gate(null, {readOnly:true});
  if (gate) return {state:gate};
  if (document.readyState === 'loading') return {state:'loading'};
  const one = (root, selector) => { const nodes = dom.all(root, selector); return nodes.length === 1 ? nodes[0] : null; };
  const child = (root, selector) => { const node = one(root, selector); return node?.parentElement === root ? node : null; };
  const text = (node, max) => node ? {text:dom.text(node, max), truncated:(node.innerText ?? '').trim().length > max} : null;
  const main = one(document, '.trade-main-content'), content = main && one(main, '.trade-content-container');
  const overall = content && child(content, '.tbpc-order-detail-content-container');
  const layout = overall && child(overall, '.tbpc-order-detail-main-content-container');
  const left = layout && child(layout, '.tbpc-order-detail-main-left-content-container');
  const right = layout && child(layout, '.tbpc-order-detail-main-right-content-container');
  const meta = right && child(right, '.trade-order-detail-detail-info');
  if (!left || !right || !meta) return {state:'structure_changed'};
  const metaRows = dom.all(meta, dom.selector('detailInfoContent')).filter(row => row.parentElement === meta);
  if (!metaRows.length || metaRows.length > 20) return {state:'structure_changed'};
  const labels = metaRows.map(row => ({row, label:one(row, dom.selector('detailInfoTitle'))}));
  if (labels.some(value => !value.label || value.label.parentElement?.parentElement !== value.row)) return {state:'structure_changed'};
  const ids = labels.filter(value => /^(订单编号|订单号)\s*[:：]?$/.test(dom.text(value.label, 100)));
  if (ids.length !== 1) return {state:'structure_changed'};
  const idValue = child(ids[0].row, dom.selector('detailInfoItemRightPrint'));
  const idRegion = text(idValue, 100), idLabel = text(ids[0].label, 100);
  const printedId = idRegion && !idRegion.truncated ? idRegion.text.match(/^([0-9]{1,40})(?:\s*复制)?$/)?.[1] : null;
  // A URL match alone cannot associate item, status or amount text with this order.
  if (!idLabel || idLabel.truncated || printedId !== address.order_id) return {state:'target_changed'};

  const stepRoot = one(left, dom.selector('statusStep'));
  let statuses = [], banner = null;
  if (stepRoot) {
    const steps = dom.all(stepRoot, dom.selector('statusStepItem'));
    if (!steps.length || steps.length > 10 || steps.some(step => step.parentElement !== stepRoot)) return {state:'structure_changed'};
    statuses = steps.map(step => {
      const classes = (step.getAttribute('class') ?? '').split(/\s+/);
      return {title:text(child(step, dom.selector('statusStepItemTitle')), 100),
        current:classes.some(value => value.startsWith('statusStepItemCurrent--')),
        done:classes.some(value => value.startsWith('statusStepItemDone--'))};
    });
    if (statuses.some(step => !step.title) || statuses.filter(step => step.current).length !== 1) return {state:'structure_changed'};
  } else {
    // A closed order (live Tmall page, 2026-10-12) shows a status banner instead of progress steps. Only its status and detail
    // texts are read; the address/contact block and the action buttons in the same banner are never read or clicked.
    const roots = dom.all(left, '.trade-container').filter(node => node.parentElement === left);
    const root = roots.length === 1 ? roots[0] : null;
    const excluded = root ? [...dom.all(root, dom.selector('logisticsAddress')), ...dom.all(root, dom.selector('operations'))] : [];
    const pick = prefix => root ? dom.all(root, dom.selector(prefix)).filter(node => !excluded.some(region => region.contains(node))) : [];
    const titles = pick('content'), details = pick('subContent');
    if (titles.length !== 1 || details.length > 1) return {state:'structure_changed'};
    banner = {status:text(titles[0], 100), detail:details.length ? text(details[0], 200) : null};
    if (!banner.status.text || banner.status.truncated) return {state:'structure_changed'};
  }
  const shop = child(left, '.trade-order-detail-shop-info');
  const shopName = shop && one(shop, dom.selector('shopInfoName'));
  const rows = dom.all(left, '.trade-order-detail-order-info');
  if (!rows.length || rows.length > 2000 || rows.some(row => row.parentElement !== left)) return {state:'structure_changed'};
  const prices = root => {
    const containers = dom.all(root, '.trade-price-container');
    if (containers.some(node => node.parentElement.closest('.trade-price-container'))) return null;
    return {items:containers.slice(0, 10).map(node => ({...text(node, 500), label:text(one(node, '.trade-price-label'), 100)})), truncated:containers.length > 10};
  };
  const items = [];
  for (const [index, row] of rows.slice(0, 10).entries()) {
    const local = query => dom.all(row, query).filter(node => node.closest('.trade-order-detail-order-info') === row);
    const region = query => { const nodes = local(query); return nodes.length === 1 ? nodes[0] : null; };
    const itemContent = region(dom.selector('content')), base = itemContent && child(itemContent, dom.selector('baseInfo'));
    const itemLeft = base && child(base, dom.selector('baseInfoLeft')), itemRight = base && child(base, dom.selector('baseInfoRight'));
    if (!itemContent || itemContent.parentElement !== row || !itemLeft || !itemRight) return {state:'structure_changed'};
    const titles = local(dom.selector('title')).filter(node => itemLeft.contains(node));
    if (titles.length > 1 || titles[0] && titles[0].tagName !== 'A') return {state:'structure_changed'};
    const anchor = titles[0];
    let product = null;
    if (anchor) {
      let href;
      try { href = new URL(anchor.getAttribute('href'), location.href).href; } catch { /* Unsupported addresses remain missing. */ }
      if (href) product = productUrl(href);
    }
    const info = local(dom.selector('infoContent')).filter(node => itemLeft.contains(node));
    const price = prices(itemRight);
    if (!price) return {state:'structure_changed'};
    const quantities = local(dom.selector('quantity')).filter(node => itemRight.contains(node));
    if (quantities.length > 1) return {state:'structure_changed'};
    items.push({position:index + 1, title:text(anchor, 500), product,
      information:{items:info.slice(0, 10).map(node => text(node, 1000)), truncated:info.length > 10},
      quantity:text(quantities[0], 64), prices:price});
  }
  const amountRoot = child(right, '.trade-order-detail-settlement-info');
  if (!amountRoot) return {state:'structure_changed'};
  const amountRows = dom.all(amountRoot, dom.selector('detailInfoContent'));
  if (!amountRows.length || amountRows.length > 20) return {state:'structure_changed'};
  const amounts = [];
  for (const row of amountRows) {
    if (row.closest('.trade-order-detail-settlement-info') !== amountRoot) return {state:'structure_changed'};
    const label = one(row, dom.selector('detailInfoItemLeftPrint')), value = prices(row);
    if (!label || label.parentElement !== row || !value || !value.items.length) return {state:'structure_changed'};
    amounts.push({label:text(label, 100), prices:value});
  }
  return {state:'observed', address, source:'tbpc_order_detail_dom', observed_at:new Date().toISOString(),
    order_id_region:{label:idLabel, value:idRegion}, shop:text(shopName, 500), statuses, ...(banner ? {status_banner:banner} : {}),
    loaded_items_seen:rows.length, items, amounts};
}

/**
 * Read one observed normal detail layout after exact route and printed-order-ID guards.
 * @param {{url:string,order_id:string}} target Canonical saved detail identity.
 * @returns {string} Fixed bounded DOM collector; no actions, account/contact values, images, storage or requests.
 * @throws {ShoppingError} INVALID_TARGET before browser access.
 * @example orderDetailBodyScript({url:'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=902',order_id:'902'});
 */
export function orderDetailBodyScript(target) {
  const parser = `(() => {const PRODUCT_HOSTS = new Set(['item.taobao.com','detail.tmall.com']); const parseProductUrl=${parseProductUrl.toString()}; return ${parseOrderDetailProductUrl.toString()};})()`;
  return `(${collectOrderBody.toString()})(${orderDetailTargetScript(target)},(${pageDom.toString()})(),${parser})`;
}

const invalid = () => { throw new ShoppingError('INVALID_RESPONSE', 'The order-detail page returned invalid bounded body evidence.'); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function region(value, max, nullable = false) {
  if (value === null && nullable) return null;
  exact(value, ['text','truncated']);
  if (typeof value.truncated !== 'boolean' || value.truncated && value.text?.length !== max) invalid();
  return {text:responseText(value.text, max), truncated:value.truncated};
}
function priceObservations(value, level) {
  exact(value, ['items','truncated']);
  if (!Array.isArray(value.items) || value.items.length > 10 || typeof value.truncated !== 'boolean' || value.truncated && value.items.length !== 10) invalid();
  return {items:value.items.map(item => {
    exact(item, ['text','truncated','label']);
    return {...region({text:item.text,truncated:item.truncated}, 500), label:region(item.label, 100, true),
      source:'same_detail_price_container',level,kind:'unverified',settlement_verified:false};
  }),truncated:value.truncated};
}
function normalizeItem(item, index) {
  exact(item, ['position','title','product','information','quantity','prices']);
  if (item.position !== index + 1) invalid();
  const title = region(item.title, 500, true), product = item.product === null ? null : parseOrderDetailProductUrl(item.product?.url);
  if (!isDeepStrictEqual(product, item.product)) invalid();
  exact(item.information, ['items','truncated']);
  if (!Array.isArray(item.information.items) || item.information.items.length > 10 || typeof item.information.truncated !== 'boolean' ||
      item.information.truncated && item.information.items.length !== 10) invalid();
  const quantity = region(item.quantity, 64, true);
  const digits = quantity && !quantity.truncated ? quantity.text.match(/^(?:[xX×]\s*|数量\s*[:：]\s*)([1-9][0-9]{0,8})$/)?.[1] : null;
  return {position:item.position, title_region:title, product,product_link_navigation_verified:false,
    item_information:{...item.information, items:item.information.items.map(value => region(value, 1000)), interpretation:'unclassified_item_text'},
    quantity:{region:quantity,value:digits ? Number(digits) : null,verified:Boolean(digits),source:'same_detail_item_quantity_display'},
    price_observations:priceObservations(item.prices, 'item'),
    association:{sku_id:null,sku_binding_verified:false,settlement_verified:false},
    missing:[...(!title?.text || title.truncated ? ['title'] : []), ...(!product ? ['product_link'] : []), ...(!digits ? ['quantity'] : [])]};
}

/**
 * Validate raw DOM evidence and derive only source-supported associations and values.
 * @param {unknown} value Fixed collector response. @param {object} target Canonical detail identity.
 * @returns {object} Local partial snapshot; status/price labels are observations, never settlement proof.
 * @throws {ShoppingError} Page gates, INVALID_RESPONSE, TARGET_CHANGED or unsupported structure.
 * @example validateOrderDetailBody(raw, target);
 */
export function validateOrderDetailBody(value, target) {
  orderDetailTargetScript(target);
  if (value && Object.keys(value).length === 1) throwPageError(value.state);
  // Only the status-banner layout carries status_banner; the progress-step layout keeps its original raw shape.
  const bannerLayout = Boolean(value) && Object.hasOwn(value, 'status_banner');
  exact(value, ['state','address','source','observed_at','order_id_region','shop','statuses','loaded_items_seen','items','amounts',
    ...(bannerLayout ? ['status_banner'] : [])]);
  if (value.state !== 'observed' || value.source !== 'tbpc_order_detail_dom' || typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)) ||
      !Number.isSafeInteger(value.loaded_items_seen) || value.loaded_items_seen < 1 || value.loaded_items_seen > 2000 ||
      !Array.isArray(value.items) || value.items.length !== Math.min(10,value.loaded_items_seen) ||
      !Array.isArray(value.statuses) || (bannerLayout ? value.statuses.length !== 0 : !value.statuses.length) || value.statuses.length > 10 ||
      !Array.isArray(value.amounts) || !value.amounts.length || value.amounts.length > 20) invalid();
  const address = validateOrderDetailTarget(value.address, target);
  exact(value.order_id_region, ['label','value']);
  const idLabel = region(value.order_id_region.label, 100), idValue = region(value.order_id_region.value, 100);
  if (idLabel.truncated || !/^(订单编号|订单号)\s*[:：]?$/.test(idLabel.text) || idValue.truncated ||
      idValue.text.match(/^([0-9]{1,40})(?:\s*复制)?$/)?.[1] !== target.order_id) invalid();
  const statuses = value.statuses.map((step,index) => {
    exact(step, ['title','current','done']);
    if (typeof step.current !== 'boolean' || typeof step.done !== 'boolean') invalid();
    const title = region(step.title, 100);
    if (!title.text || title.truncated) invalid();
    return {position:index + 1,title_region:title,current_marker:step.current,done_marker:step.done};
  });
  let statusObservations;
  if (bannerLayout) {
    exact(value.status_banner, ['status','detail']);
    const status = region(value.status_banner.status, 100), detail = region(value.status_banner.detail, 200, true);
    if (!status.text || status.truncated) invalid();
    statusObservations = {layout:'status_banner', steps:[], banner:{status_region:status, detail_region:detail},
      current_title:status.text, source:'same_order_status_banner', settlement_verified:false};
  } else {
    const current = statuses.filter(step => step.current_marker);
    if (current.length !== 1) invalid();
    statusObservations = {steps:statuses,current_title:current[0].title_region.text,source:'same_order_progress_current_marker',settlement_verified:false};
  }
  return {schema_version:1, source:value.source, ...address, observed_at:value.observed_at,
    printed_order_id_verified:true,order_id_region:{label:idLabel,value:idValue},shop_name_region:region(value.shop, 500, true),
    status_observations:statusObservations,
    items:value.items.map(normalizeItem),amount_observations:value.amounts.map((amount,index) => {
      exact(amount, ['label','prices']);
      const label = region(amount.label, 100), prices = priceObservations(amount.prices, 'order');
      if (!label.text || label.truncated || !prices.items.length) invalid();
      return {position:index + 1,label_region:label,price_observations:prices,source:'same_order_settlement_region',settlement_verified:false};
    }), coverage:{status:'partial',normal_detail_layout:'tbpc_order_detail',normal_detail_layout_verified:true,
      loaded_items_seen:value.loaded_items_seen,returned_items:value.items.length,items_omitted:value.loaded_items_seen-value.items.length,
      full_order_items_verified:false,account_identity_verified:false,settlement_verified:false},
    privacy:{local_only:true,contact_fields_read:false,account_profile_read:false,payment_identifiers_read:false},
    actions:{clicks:0,scrolls:0,refreshes:0,downloads:0,order_mutations:0}};
}

/**
 * Revalidate all saved sources and derived fields without changing the original observation time.
 * @param {unknown} value Saved bounded body. @param {object} target Canonical detail identity.
 * @returns {object} Unchanged snapshot.
 * @throws {ShoppingError} INVALID_CHECKPOINT for invented fields, values, identities or completeness claims.
 * @example validateSavedOrderDetailBody(saved, target);
 */
export function validateSavedOrderDetailBody(value, target) {
  try {
    const rawPrices = prices => ({truncated:prices.truncated,items:prices.items.map(item => ({text:item.text,truncated:item.truncated,label:item.label}))});
    const raw = {state:'observed',address:{state:'observed',url:value.url,order_id:value.order_id},source:value.source,observed_at:value.observed_at,
      order_id_region:value.order_id_region,shop:value.shop_name_region,statuses:value.status_observations.steps.map(step => ({title:step.title_region,current:step.current_marker,done:step.done_marker})),
      ...(value.status_observations.layout === 'status_banner' ? {status_banner:{status:value.status_observations.banner.status_region,
        detail:value.status_observations.banner.detail_region}} : {}),
      loaded_items_seen:value.coverage.loaded_items_seen,items:value.items.map(item => ({position:item.position,title:item.title_region,product:item.product,
        information:{items:item.item_information.items,truncated:item.item_information.truncated},quantity:item.quantity.region,prices:rawPrices(item.price_observations)})),
      amounts:value.amount_observations.map(amount => ({label:amount.label_region,prices:rawPrices(amount.price_observations)}))};
    const normalized = validateOrderDetailBody(raw, target);
    // The first local body observation predates this optional explicit navigation boundary; do not backfill it.
    normalized.items.forEach((item,index) => { if (!Object.hasOwn(value.items[index], 'product_link_navigation_verified')) delete item.product_link_navigation_verified; });
    if (!isDeepStrictEqual(normalized, value)) throw Error();
    return value;
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved order-detail body is invalid.'); }
}
