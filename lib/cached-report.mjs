import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { normalizeListEmptyEvidence } from './list-empty-state.mjs';

const PRODUCT_KINDS = new Set(['product_snapshot', 'product_details', 'product_services', 'product_description_expansion']);
const REPORT_KINDS = new Set(['cart_snapshot', 'cart_collection', 'order_snapshot', 'order_collection', 'order_pages', 'order_body_snapshot', 'search', 'search_collection',
  'search_price', 'search_sort', 'order_detail_check', 'product_gallery', 'product_main_images', 'product_specification_images',
  'product_review_categories', 'jd_search', 'jd_search_pages', 'jd_search_sort', 'jd_product', 'jd_review_categories', 'jd_cart', 'jd_orders', 'jd_order_detail', 'pdd_search', 'pdd_search_sort', 'pdd_product', 'pdd_reviews', 'pdd_spec_prices', 'pdd_orders', 'pdd_order_detail', ...PRODUCT_KINDS]);
const COVERAGE_KEYS = ['status', 'loaded_rows_seen', 'returned_rows', 'rows_omitted', 'page_total_rows', 'full_cart',
  'empty_cart_verified', 'account_identity_verified', 'row_id_verified', 'shop_name_verified', 'display_price_kind_verified',
  'payment_verified', 'requested_limit_reached', 'requested_loaded_range_read', 'physical_row_identity_verified',
  'loaded_orders_seen', 'returned_orders', 'orders_omitted', 'page_total_orders', 'full_order_history', 'empty_orders_verified',
  'filters_verified', 'physical_order_identity_verified', 'settlement_verified', 'loaded_items_seen', 'returned_items',
  'items_omitted', 'full_order_items_verified', 'normal_detail_layout', 'normal_detail_layout_verified',
  'specifications', 'prices', 'reviews', 'attribute_scope', 'image_scope', 'service_scope', 'full_description',
  'platform_ui_applied', 'url_reflects_state', 'sort_verified', 'total_results_known', 'page_transition_verified', 'requested_bound_reached',
  'visible_last_page_verified', 'pages_read', 'total_pages_displayed', 'total_pages_first_displayed', 'total_pages_changed', 'all_listed_pages_read', 'listed_view', 'order_search_empty',
  'recycle_bin_included'];
const IMAGE_COVERAGE_KEYS = ['full_gallery', 'current_main_image_read', 'selected_image_relation_verified', 'original_resolution_verified',
  'file_downloaded', 'image_semantics_read', 'video_read'];
// Kinds added on 2026-10-14 also project these keys; earlier kinds keep the shared list, so their reports do not change.
const KIND_COVERAGE_KEYS = {
  search_sort: ['sort_ui_verified'],
  product_gallery: IMAGE_COVERAGE_KEYS,
  product_main_images: ['requested_images', 'returned_images', ...IMAGE_COVERAGE_KEYS],
  product_specification_images: ['scanned_inventory_complete', 'groups_omitted', 'options_omitted_in_scanned_groups', 'options_returned',
    'image_options_seen', 'loaded_image_links', 'unresolved_image_options', 'unread_image_options', 'scanned_supported_image_links_complete',
    'full_option_images', 'full_sku_matrix', 'cross_read_image_state_verified', 'file_downloaded', 'image_semantics_read', 'sku_price_binding_verified'],
  product_review_categories: ['scope', 'full_list', 'order', 'all_categories_read', 'unique_review_count', 'latest_order_verified', 'media_read'],
  order_detail_check: ['normal_detail_fields_read', 'printed_order_id_verified', 'contact_fields_read', 'local_only'],
  jd_search: ['scope', 'in_stock_only'],
  jd_search_pages: ['scope', 'in_stock_only', 'url_reflects_page'],
  jd_search_sort: ['scope', 'in_stock_only', 'url_reflects_page', 'url_reflects_sort', 'sort_direction_verified', 'price_range_verified'],
  jd_product: ['scope', 'same_group_specs_are_separate_products', 'same_group_spec_prices_read', 'detail_section_loaded', 'full_description_verified', 'reviews_read', 'review_summary_read'],
  jd_review_categories: ['scope', 'scrolled', 'date_has_year', 'media_read', 'unique_review_count'],
  jd_cart: ['scope', 'scrolled', 'header_count_meaning_verified'],
  jd_orders: ['scope', 'scrolled', 'time_range_verified', 'amount_meaning_verified'],
  pdd_search: ['scope', 'product_ids_known', 'titles_complete'],
  pdd_search_sort: ['scope', 'sort_ui_verified', 'url_reflects_sort', 'sort_direction_verified', 'price_range_verified', 'scrolled'],
  pdd_product: ['scope', 'price_hidden_by_page', 'reviews_scope', 'spec_prices_read', 'spec_panel_opened', 'detail_images_scrolled'],
  pdd_reviews: ['scope', 'review_page_opened', 'scrolled', 'category_clicked', 'expand_clicked', 'media_read'],
  pdd_spec_prices: ['scope', 'every_button_opened', 'drawers_closed', 'options_not_clicked', 'options_skipped_greyed', 'options_cut', 'unconfirmed_selections', 'order_controls_clicked', 'quantity_changed'],
  pdd_orders: ['scope', 'scrolled', 'order_ids_known', 'amount_meaning_verified'],
  pdd_order_detail: ['scope', 'info_expanded', 'consignee_read', 'payment_read', 'logistics_read', 'amount_meaning_verified'],
  jd_order_detail: ['scope', 'consignee_read', 'tracking_records_read', 'payment_tab_read', 'invoice_read', 'amount_meaning_verified'],
};
const SEARCH_COUNTS = ['cards_seen', 'cards_scanned', 'cards_not_rendered', 'duplicates_omitted', 'unsupported_cards_omitted'];
const IMAGE_COUNTS = ['elements_seen', 'elements_scanned', 'duplicates_omitted', 'unsupported_urls_omitted'];
const REVIEW_COUNTS = ['loaded_count', 'returned_count', 'omitted_count'];
const COLUMNS = ['record_type', 'source_task', 'task_kind', 'task_status', 'task_created_at', 'task_updated_at',
  'observation_position', 'operation_position', 'operation_status', 'batch_position', 'observed_at', 'source',
  'available', 'requested_rows', 'requested_orders', 'order_position', 'order_id', 'item_position', 'product_id', 'title', 'url', 'label', 'text', 'qualifier',
  'quantity', 'quantity_text', 'quantity_source', 'quantity_verified', 'group_position', 'group_name', 'selected', 'disabled',
  'current_marker', 'done_marker', 'loaded', 'truncated', 'clipped', 'verified', 'missing',
  'provenance_kind', 'provenance_task', 'provenance_observed_at', 'provenance_order_position', 'provenance_order_id', 'provenance_url'];
const IDENTIFIER_COLUMNS = new Set(['order_id', 'product_id', 'provenance_order_id']);
const CAUTION = '这是已有缓存的局部观察，采集时间保留原值。金额和状态为页面原文，支付、结算、账户、SKU 归属未验证；任务完成仅表示原请求范围完成。';

function scalar(value) {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function regionText(region) { return typeof region?.text === 'string' ? region.text : null; }
function missingFields(value, prefix = '') { return Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => prefix + item) : []; }
function projectCoverage(value, prefix = '', keys = COVERAGE_KEYS) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [prefix + key, scalar(value[key])]));
}
function coverageKeys(kind) { return [...COVERAGE_KEYS, ...(KIND_COVERAGE_KEYS[kind] ?? [])]; }
function recordAdder(report, observation) {
  return (type, fields) => report.records.push({record_type:type, observation_position:observation.position,
    operation_position:observation.operation_position, batch_position:observation.batch_position,
    observed_at:observation.observed_at, source:observation.source,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, scalar(value)]))});
}
function addRegion(add, type, fields, region, label = null) {
  if (region !== null && region !== undefined) add(type, {...fields, label, text:regionText(region), truncated:region.truncated === true});
}
function addPrices(add, type, identity, prices, label = null) {
  for (const [index, price] of (prices?.items ?? []).entries()) {
    add(type, {...identity, label:label ?? regionText(price.label), text:regionText(price),
      qualifier:label === null ? null : regionText(price.label), item_position:identity.item_position ?? index + 1,
      truncated:price.truncated === true, verified:false});
  }
}
function addArrayCoverage(add, identity, label, collection) {
  if (typeof collection?.truncated === 'boolean') add('field_coverage', {...identity, label:label + '.truncated', text:String(collection.truncated)});
}
function quantityFields(quantity) {
  const input = quantity?.inputs?.length === 1 ? quantity.inputs[0].value : null;
  return {quantity:scalar(quantity?.value), quantity_text:regionText(quantity?.region) ?? regionText(quantity?.display) ?? scalar(input),
    quantity_source:scalar(quantity?.source), quantity_verified:quantity?.verified === true};
}
function cartRecords(snapshot, add) {
  for (const row of snapshot.rows ?? []) {
    const identity = {item_position:row.position, product_id:row.product_id, observed_at:row.observed_at ?? snapshot.observed_at};
    add('cart_item', {...identity, title:row.title, url:row.url, ...quantityFields(row.quantity), missing:missingFields(row.missing).join('; ')});
    addRegion(add, 'cart_shop', identity, row.shop_region);
    addRegion(add, 'cart_specification', identity, row.specification);
    addRegion(add, 'cart_status', identity, row.status_region);
    if (row.availability) cartAvailabilityRecord(add, identity, row.availability);
    addRegion(add, 'cart_price_quantity_text', identity, row.price_quantity_region);
    addPrices(add, 'cart_price', identity, row.price_region_observations);
    addArrayCoverage(add, identity, 'price_region_observations', row.price_region_observations);
  }
}
// The status rests on page markers; the reason and overlay texts stay verbatim, and purchase is never verified.
function cartAvailabilityRecord(add, identity, availability) {
  const checkboxes = availability.signals?.checkboxes?.items ?? [];
  const overlays = (availability.signals?.image_texts?.items ?? []).map(item => item.text).filter(text => typeof text === 'string');
  add('cart_availability', {...identity, label:availability.status, text:regionText(availability.reason),
    qualifier:overlays.length ? `image_text=${overlays.join(' / ')}` : null,
    disabled:checkboxes.length === 1 ? checkboxes[0].disabled : null, truncated:availability.reason?.truncated === true, verified:false});
}
function availabilityCounts(summary) {
  return summary && typeof summary === 'object' ? Object.fromEntries(Object.entries(summary).map(([status, count]) => ['availability.' + status, scalar(count)])) : {};
}
function emptyListRecord(snapshot, add, cart) {
  if (snapshot.schema_version !== 3 || snapshot.coverage?.[cart ? 'empty_cart_verified' : 'empty_orders_verified'] !== true) return;
  const evidence = normalizeListEmptyEvidence(snapshot.empty_evidence);
  add('empty_notice', { label: evidence.scope, text: evidence.message.text, qualifier: evidence.basis,
    truncated: false, verified: true, url: snapshot.url });
}
function orderItemRecords(items, add, order, body = false) {
  for (const item of items ?? []) {
    const identity = {...order, item_position:item.position, product_id:body ? item.product?.product_id ?? null : item.product_id};
    add('order_item', {...identity, title:item.title ?? regionText(item.title_region), url:body ? item.product?.url ?? null : item.url,
      ...quantityFields(item.quantity), truncated:item.title_region?.truncated === true, missing:missingFields(item.missing).join('; ')});
    for (const info of item.item_information?.items ?? []) addRegion(add, 'order_item_information', identity, info);
    addArrayCoverage(add, identity, 'item_information', item.item_information);
    addPrices(add, 'order_item_price', identity, item.price_observations);
    addArrayCoverage(add, identity, 'price_observations', item.price_observations);
  }
}
function orderRecords(snapshot, add) {
  for (const order of snapshot.orders ?? []) {
    const identity = {order_position:order.position, order_id:order.order_id, observed_at:order.observed_at ?? snapshot.observed_at};
    add('order', {...identity, url:order.detail_entry?.url ?? null, missing:missingFields(order.missing).join('; ')});
    addRegion(add, 'order_date', identity, order.placed_at_region);
    addRegion(add, 'order_shop', identity, order.shop_name_region);
    addRegion(add, 'order_status', identity, order.status_region);
    for (const [label, text] of Object.entries(projectCoverage(order.coverage))) add('order_item_coverage', {...identity, label, text:displayValue(text)});
    addPrices(add, 'order_price', identity, order.payment_observations);
    addArrayCoverage(add, identity, 'payment_observations', order.payment_observations);
    orderItemRecords(order.items, add, identity);
  }
}
/** One list page of a paged order task: its displayed pager and view, then its orders. */
function orderPageRecords(snapshot, add, pager, view) {
  add('order_pagination', {label:'pager', text:[...Object.entries(pager ?? {}), ...Object.entries(view ?? {})]
    .map(([key, value]) => `${key}=${displayValue(scalar(value))}`).join('; ')});
  orderRecords(snapshot, add);
}
function bodyRecords(body, add) {
  const identity = {order_id:body.order_id};
  add('order', {...identity, url:body.url});
  addRegion(add, 'order_shop', identity, body.shop_name_region);
  const banner = body.status_observations?.banner;
  if (banner) {
    addRegion(add, 'order_status', identity, banner.status_region, 'status_banner');
    addRegion(add, 'order_status_detail', identity, banner.detail_region, 'status_banner');
  }
  for (const step of body.status_observations?.steps ?? []) {
    add('order_progress', {...identity, item_position:step.position, text:regionText(step.title_region),
      current_marker:step.current_marker, done_marker:step.done_marker, verified:false});
  }
  orderItemRecords(body.items, add, identity, true);
  for (const amount of body.amount_observations ?? []) {
    addPrices(add, 'order_amount', {...identity, item_position:amount.position}, amount.price_observations, regionText(amount.label_region));
    addArrayCoverage(add, {...identity, item_position:amount.position}, 'amount_price_observations', amount.price_observations);
  }
}
function detailRecords(details, add, identity) {
  if (!details) return;
  if (details.shop) add('product_shop', {...identity, title:details.shop.name, url:details.shop.url});
  for (const row of details.attributes?.items ?? []) {
    add('parameter', {...identity, label:row.name, text:row.value, truncated:row.text_may_be_truncated === true});
  }
  if (typeof details.description?.text === 'string') {
    add('description', {...identity, text:details.description.text, truncated:details.description.text_may_be_truncated === true});
  }
  for (const region of ['gallery', 'description']) imageLinkRecords(add, identity, region, details[region]);
  for (const label of details.services?.labels ?? []) add('service_label', {...identity, text:label, verified:false});
  for (const term of details.services?.terms?.items ?? []) {
    add('service_term', {...identity, label:term.label, title:term.header_text, text:term.body_text,
      truncated:term.body_truncated, clipped:term.body_clipped, verified:false});
  }
  for (const label of details.shipping?.freight_labels ?? []) add('shipping_label', {...identity, text:label, verified:false});
  for (const [type, notices] of [['purchase_notice', details.purchase], ['dispatch_notice', details.shipping?.dispatch]]) {
    for (const label of notices?.labels ?? []) add(type, {...identity, text:label.text, truncated:label.text_truncated, verified:false});
  }
}
function imageLinkRecords(add, identity, region, collection) {
  for (const [index, image] of (collection?.items ?? []).entries()) {
    add('image_link', {...identity, item_position:image.position ?? index + 1, label:region, url:image.url, loaded:image.loaded,
      ...(image.module ? {qualifier:`module=${image.module}`} : {}), verified:false});
  }
}
function productRecords(snapshot, add) {
  const identity = {product_id:snapshot.product_id};
  add('product', {...identity, title:snapshot.title, url:snapshot.url});
  for (const [index, price] of (snapshot.prices ?? []).entries()) {
    add('product_price', {...identity, item_position:index + 1, label:price.label, text:price.raw, qualifier:price.qualifier, verified:false});
  }
  for (const [groupIndex, group] of (snapshot.specification_groups ?? []).entries()) {
    for (const [index, option] of (group.options ?? []).entries()) {
      add('specification', {...identity, group_position:groupIndex + 1, group_name:group.name, item_position:index + 1,
        label:option.label, selected:option.selected, disabled:option.disabled, verified:false});
    }
  }
  for (const [index, review] of (snapshot.review_previews ?? []).entries()) {
    add('review_preview', {...identity, item_position:review.observation_index ?? index + 1, label:review.date_text,
      text:review.body, truncated:review.text_may_be_truncated, verified:false});
  }
  detailRecords(snapshot.details, add, identity);
}
/** Scan counts and platform-order cards of one search page; each card's shop and sales text are separate records. */
function searchRecords(snapshot, add, pagination) {
  for (const key of SEARCH_COUNTS) if (Object.hasOwn(snapshot, key)) add('search_scan', {label:key, text:displayValue(snapshot[key])});
  if (pagination) {
    add('search_pagination', {label:'pagination', text:Object.entries(pagination).map(([key, value]) => `${key}=${displayValue(scalar(value))}`).join('; ')});
  }
  for (const item of snapshot.items ?? []) {
    const identity = {item_position:item.position, product_id:item.product_id};
    add('search_item', {...identity, title:item.title, url:item.url, label:item.price?.label, text:item.price?.raw, verified:false});
    if (item.shop) add('search_shop', {...identity, text:item.shop, verified:false});
    if (item.sales_text) add('search_sales', {...identity, text:item.sales_text, verified:false});
  }
}
/** JD first-screen cards as ordinary search records, plus each card's JD marks and, from format 2, the other amounts beside its price. */
function jdSearchRecords(snapshot, add) {
  searchRecords(snapshot, add);
  for (const item of snapshot.items ?? []) {
    const identity = {item_position:item.position, product_id:item.product_id};
    add('search_marks', {...identity, label:'jd', verified:false,
      text:`self_operated=${item.jd.self_operated}; sponsored=${item.jd.sponsored}; tags=${item.jd.tags.join('、')}`});
    for (const amount of item.jd.other_amounts ?? []) {
      add('search_other_amount', {...identity, label:amount.line_through ? 'line_through' : 'no_line_through', text:amount.text, verified:false});
    }
  }
}
/**
 * PDD cards as ordinary search records (no product number, a shortened title), plus each card's labels and image address.
 */
function pddSearchRecords(snapshot, add) {
  searchRecords(snapshot, add);
  for (const item of snapshot.items ?? []) {
    const identity = {item_position:item.position, product_id:null};
    add('search_marks', {...identity, label:'pdd', verified:false,
      text:`labels=${item.pdd.labels.join('、')}; after_price=${item.pdd.after_price.join('、')}`});
    if (item.image_url) add('search_image', {...identity, url:item.image_url, verified:false});
  }
}
/**
 * A sorted or ranged PDD search: each action and what the page showed after it, the range and order checks, then the
 * cards. Format 1 results hold sort clicks only and keep their records.
 */
function pddSortRecords(result, add) {
  if (result.schema_version === 1) {
    for (const click of result.clicks) {
      add('search_sort_click', {label:click.label, text:`sort_type=${displayValue(click.from)}->${click.to}`,
        qualifier:`click=${click.outcome}; checks=${click.checks}; error=${displayValue(click.error)}`});
    }
  } else {
    for (const action of result.actions) {
      add(action.kind === 'sort' ? 'search_sort_click' : 'search_price_range_action', {label:action.label ?? action.kind,
        text:action.kind === 'sort' ? `sort_type->${action.to}` : null, qualifier:`click=${action.outcome}; checks=${action.checks}; error=${displayValue(action.error)}`});
    }
    const check = result.range_check;
    if (check) {
      add('search_price_range_check', {label:`${check.minimum}-${check.maximum}`, text:`address_price=${displayValue(result.address_price_range)}`,
        qualifier:`checked=${check.cards_checked}; outside=${check.outside}; unparsed_skipped=${check.unparsed_skipped}`, verified:false});
    }
  }
  add('search_sort_state', {label:displayValue(result.sort), text:`sort_type=${displayValue(result.sort_type)}; selected=${result.selected.join('、')}`,
    qualifier:orderCheckText(result.order_check), verified:false});
  pddSearchRecords(result.search, add);
}
/**
 * One PDD product page opened from a search card: how it was reached, its price as displayed (or hidden by the page),
 * page lines, shop, parameters, spec names without prices, review previews without names, and image addresses.
 */
function pddProductRecords(result, add) {
  const identity = {product_id:result.product_id};
  const entry = result.entry;
  add('product', {...identity, title:result.title, url:result.url});
  add('product_entry', {...identity, label:'search_card', text:entry.card_title,
    qualifier:`query=${entry.query}; card=${entry.card_position}; card_price=${entry.card_price}; click=${entry.click}`});
  add('product_price', {...identity, item_position:1, label:result.price.label, text:result.price.raw,
    qualifier:result.price.hidden_by_page ? 'hidden_by_page' : null, verified:false});
  for (const [index, note] of result.price_notes.entries()) add('price_note', {...identity, item_position:index + 1, text:note, verified:false});
  for (const [index, line] of result.highlights.entries()) add('page_line', {...identity, item_position:index + 1, text:line, verified:false});
  if (result.shop) {
    add('product_shop', {...identity, title:result.shop.name});
    for (const [index, line] of result.shop.lines.entries()) add('shop_line', {...identity, item_position:index + 1, text:line, verified:false});
    for (const [index, tag] of result.shop.review_tags.entries()) add('review_tag', {...identity, item_position:index + 1, label:tag.label, text:String(tag.count)});
  }
  for (const row of result.params) add('parameter', {...identity, label:row.name, text:row.value});
  for (const [index, line] of result.notices.entries()) add('page_notice', {...identity, item_position:index + 1, text:line});
  if (result.spec) {
    add('spec_chosen', {...identity, text:result.spec.chosen, verified:false});
    for (const [groupIndex, group] of result.spec.groups.entries()) {
      for (const [index, option] of group.options.entries()) {
        add('spec_option', {...identity, group_position:groupIndex + 1, group_name:group.name, item_position:index + 1, label:option.label,
          qualifier:option.marks.join('、') || null, verified:false});
      }
    }
  }
  if (result.reviews) {
    add('review_summary', {...identity, label:'page_previews', qualifier:`count=${result.reviews.count}; names_skipped=${result.reviews.reviewer_names_skipped}`});
    for (const [index, text] of result.reviews.previews.entries()) add('review_preview', {...identity, item_position:index + 1, text});
  }
  for (const [index, url] of result.gallery.images.entries()) add('image_link', {...identity, item_position:index + 1, label:'gallery', url, verified:false});
  for (const [index, url] of result.detail_images.entries()) add('image_link', {...identity, item_position:index + 1, label:'detail', url, verified:false});
}
/**
 * The 查看全部 review page of one PDD product: how it was reached, the category labels shown, then each loaded review
 * without its reviewer (spec, text, date, follow-up, merchant reply, other lines and media counts).
 */
function pddReviewRecords(result, add) {
  const identity = {product_id:result.product_id};
  const entry = result.entry;
  add('product', {...identity, title:entry.product_title, url:result.url});
  add('review_summary', {...identity, label:result.outcome, text:result.tabs.join('、') || null,
    qualifier:`product_page_count=${displayValue(entry.review_count_on_product_page)}; loaded=${result.loaded_count}; returned=${result.reviews.length}; ` +
      `names_skipped=${result.reviewer_names_skipped}; click=${displayValue(entry.click)}`});
  for (const review of result.reviews) {
    const at = {...identity, item_position:review.position};
    add('review', {...at, label:review.spec, text:review.text, verified:false,
      qualifier:`images=${review.images}; videos=${review.videos}; expand_shown=${review.expand_shown}` +
        (review.other_blocks_skipped === undefined ? '' : `; other_blocks_skipped=${review.other_blocks_skipped}`)});
    if (review.date) add('review_date', {...at, text:review.date, verified:false});
    if (review.follow_up) add('review_follow_up', {...at, text:review.follow_up});
    if (review.merchant_reply) add('review_reply', {...at, text:review.merchant_reply});
    for (const line of review.other_lines) add('review_line', {...at, text:line});
  }
  for (const [index, note] of (result.page_notes ?? []).entries()) add('page_notice', {...identity, item_position:index + 1, text:note});
}
/**
 * The spec drawers of one PDD product: per bar buy button, the drawer header after it opened and after each option click
 * (selection line and price, which depends on the button and the selection), the options shown as not selectable, and
 * those left unclicked over the 12-click limit or skipped because an earlier choice greyed them out (format 2).
 */
function pddSpecPriceRecords(result, add) {
  const identity = {product_id:result.product_id};
  add('product', {...identity, title:result.product_title});
  add('spec_drawer_scan', {...identity, label:result.outcome, text:result.buttons.join('、') || null, qualifier:`clicks=${result.entry.clicks}`});
  for (const [drawerIndex, drawer] of result.drawers.entries()) {
    const at = {...identity, group_position:drawerIndex + 1};
    add('spec_drawer', {...at, label:drawer.button, text:drawer.kind, qualifier:`closed=${drawer.closed}; not_clicked=${drawer.not_clicked.length}`});
    for (const [index, reading] of drawer.readings.entries()) {
      const after = reading.after.kind === 'open' ? 'open' : `${reading.after.group}=${reading.after.option}`;
      add('spec_price', {...at, item_position:index + 1, label:reading.chosen, text:reading.price?.raw ?? null,
        qualifier:`after=${after}; confirmed=${reading.confirmed}` + (reading.notes.length ? `; notes=${reading.notes.join('、')}` : ''), verified:false});
    }
    for (const group of drawer.groups) for (const option of group.unavailable) add('spec_option_unavailable', {...at, group_name:group.name, label:option});
    for (const pick of drawer.not_clicked) add('spec_option_not_clicked', {...at, group_name:pick.group, label:pick.option});
    for (const pick of drawer.skipped_greyed ?? []) add('spec_option_greyed_after_choice', {...at, group_name:pick.group, label:pick.option});
  }
}
/**
 * The loaded cards of a PDD order list. Group member avatars and buttons are never in the result; the list shows no order
 * numbers, so order_id stays empty.
 */
function pddOrderRecords(result, add) {
  add('order_scan', {label:'loaded_count', text:displayValue(result.loaded_count), qualifier:`end_shown=${result.end_shown}; orders_cut=${result.orders_cut}`});
  for (const order of result.orders) {
    const identity = {order_position:order.position, order_id:null};
    add('order', {...identity, qualifier:`items_total=${order.items_total}; group_avatars_skipped=${order.group_avatars_skipped}; ` +
      `other_rows_skipped=${order.other_rows_skipped}`});
    add('order_shop', {...identity, text:order.shop, verified:false});
    add('order_status', {...identity, text:order.status, verified:false});
    add('order_price', {...identity, label:order.amount.label, text:order.amount.amount_text, verified:false,
      qualifier:`pay_later_shown=${order.amount.pay_later_shown}; shipping=${displayValue(order.amount.shipping_note)}; lines=${order.amount.lines.join(' / ')}`});
    for (const item of order.items) {
      add('order_item', {...identity, item_position:item.position, title:item.title, label:item.spec, quantity:item.quantity, quantity_text:item.quantity_text,
        qualifier:item.tags.length ? `tags=${item.tags.join(' / ')}` : null});
    }
  }
}
/**
 * One PDD order page reached from its list card. The consignee block, payment and logistics rows are never in the
 * result; only status words, the order block's lines and the times shown after unfolding are kept.
 */
function pddOrderDetailRecords(result, add) {
  const {entry} = result, identity = {order_position:entry.order_position, order_id:result.order_id};
  add('order', {...identity, url:result.url, qualifier:`order_number_shown=${displayValue(result.order_number_shown)}; ` +
    `top_parts_skipped=${result.top_parts_skipped}; rows_skipped=${result.rows_skipped}`});
  add('order_detail_opening', {...identity, label:entry.click, verified:false,
    qualifier:`click_error=${displayValue(entry.click_error)}; address_checks=${entry.address_checks}; expand=${displayValue(entry.expand)}; ` +
      `expand_error=${displayValue(entry.expand_error)}; reads_reserved=${entry.reads_reserved}; list_task=${entry.list_task}`});
  add('order_status', {...identity, text:result.status_words.join(' / ') || null, verified:false});
  add('order_price', {...identity, label:result.amount?.label ?? null, text:result.amount?.amount_text ?? null, verified:false});
  for (const line of result.discount_lines) add('order_amount', {...identity, text:line, verified:false});
  for (const [index, time] of result.times.entries()) add('order_time', {...identity, item_position:index + 1, label:time.label, text:time.value, verified:false});
  for (const [index, line] of result.lines.entries()) add('order_line', {...identity, item_position:index + 1, text:line});
}
/**
 * One page of a paged JD search: what its pager showed and how this task reached it, then its cards as on a first-screen
 * read, without the products already returned on earlier pages.
 */
function jdSearchPageRecords(snapshot, add) {
  const {pager, transition} = snapshot;
  add('search_pagination', {label:'pager', text:`active_page=${displayValue(pager.active_page)}; total=${displayValue(pager.total_text)}; ` +
    `previous=${pager.previous}; next=${pager.next}`, qualifier:transition ? `from_page=${transition.from_page}; click=${transition.acknowledgement}; ` +
    `checks=${transition.checks}; error=${displayValue(transition.error)}` : 'start_page'});
  add('search_scan', {label:'cross_page_duplicates_omitted', text:displayValue(snapshot.cross_page_duplicates_omitted)});
  jdSearchRecords(snapshot, add);
}
const rangeCheckText = check => `checked=${check.cards_checked}; outside=${check.outside}; sponsored_skipped=${check.sponsored_skipped}; unparsed_skipped=${check.unparsed_skipped}`;
const orderCheckText = check => check
  ? `direction=${check.direction}; status=${check.status}; compared=${check.cards_compared}; in_order=${check.pairs.in_order}; against=${check.pairs.against}; equal=${check.pairs.equal}`
  : 'no_order_check';
/**
 * One page of a sorted JD search: on page 1 each sort click and what it showed, then on every page the sort bar and the
 * order of the cards' sort prices, then the same records as a page of the paged search.
 */
function jdSortedPageRecords(snapshot, add) {
  const range = snapshot.price_range;
  if (range) {
    add('search_price_range', {label:`${range.minimum}-${range.maximum}`, text:range.label_text, qualifier:`click=${range.acknowledgement}; checks=${range.checks}; ` +
      `error=${displayValue(range.error)}; ${rangeCheckText(range.check)}`});
  }
  for (const step of snapshot.sort_steps ?? []) {
    add('search_sort_click', {label:step.label, text:`active_after=${displayValue(step.active_after)}`, qualifier:`click=${step.acknowledgement}; checks=${step.checks}; ` +
      `error=${displayValue(step.error)}; price_icon=${displayValue(step.price_icon_before)}->${displayValue(step.price_icon_after)}; ${orderCheckText(step.direction_check)}`});
  }
  const bar = snapshot.sort_bar;
  add('search_sort_state', {label:displayValue(snapshot.active_sort), text:`comprehensive=${bar.comprehensive.active}; sales=${bar.sales.active}; price=${bar.price.active}; ` +
    `price_icon=${displayValue(bar.price.icon)}`, qualifier:orderCheckText(snapshot.direction_check), verified:false});
  const check = snapshot.price_range_check;
  if (check) add('search_price_range_check', {label:`${check.minimum}-${check.maximum}`, text:`range_button=${displayValue(bar.range.text)}`, qualifier:rangeCheckText(check), verified:false});
  jdSearchPageRecords(snapshot, add);
}
/**
 * One JD product page. Spec options are `same_group_spec` records, not `specification`: on JD each option is its own
 * product, so nothing read on this page (price, stock) belongs to them.
 */
function jdProductRecords(result, add) {
  const identity = {product_id:result.product_id};
  add('product', {...identity, title:result.title, url:result.url});
  add('product_marks', {...identity, label:'jd', verified:false,
    text:`self_operated=${result.self_operated}; title_icons=${result.title_icons.join('、')}; comment_count=${result.comment_count_text}`});
  add('product_price', {...identity, item_position:1, label:result.price.tags.join('、'), text:result.price.raw, verified:false});
  for (const amount of result.price.other_amounts) {
    add('price_other_amount', {...identity, label:amount.line_through ? 'line_through' : 'no_line_through', text:amount.text, verified:false});
  }
  if (result.shop) add('product_shop', {...identity, title:result.shop});
  for (const [index, item] of (result.series?.items ?? []).entries()) {
    add('product_series', {...identity, item_position:index + 1, group_name:result.series.label, label:item.text, selected:item.selected, verified:false});
  }
  for (const group of result.same_group_specs) {
    for (const option of group.options) {
      add('same_group_spec', {...identity, group_position:group.position, group_name:group.name, item_position:option.position, label:option.text,
        title:option.title, url:option.image?.url ?? null, selected:option.selected, disabled:option.out_of_stock,
        qualifier:option.out_of_stock_text || null, verified:false});
    }
  }
  // Format 3 keeps each tag's short name and explanation; earlier formats saved one string per tag.
  for (const service of result.services) {
    if (typeof service === 'string') add('service_label', {...identity, text:service, verified:false});
    else add('service_label', {...identity, label:service.label, text:service.description, verified:false});
  }
  for (const image of result.gallery) add('image_link', {...identity, item_position:image.position, label:'gallery', url:image.url, loaded:image.loaded, verified:false});
  const detail = result.detail;
  add('detail_section', {...identity, label:detail.status, verified:false,
    text:`initial=${result.detail_action.initial_status}; scroll_reserved=${result.detail_action.scroll_reserved}; checks=${result.detail_action.checks_after_scroll}`});
  for (const row of detail.highlights ?? []) add('parameter', {...identity, label:row.name, text:row.value, qualifier:'highlight'});
  for (const row of detail.parameters ?? []) add('parameter', {...identity, label:row.name, text:row.value});
  for (const image of detail.images ?? []) {
    add('image_link', {...identity, item_position:image.position, label:image.region, url:image.url, loaded:image.loaded,
      qualifier:`kind=${image.kind}`, verified:false});
  }
  // Older results have no review_summary, so their records stay as they were.
  const summary = result.review_summary;
  if (summary) {
    add('review_summary', {...identity, label:summary.status, text:summary.title ?? null,
      qualifier:`count=${summary.count_text ?? ''}; praise=${summary.praise ?? ''}; entry=${summary.all_reviews_entry ?? ''}`});
    for (const [index, tag] of (summary.tags ?? []).entries()) {
      add('review_tag', {...identity, item_position:index + 1, label:tag.text, text:tag.count_text});
    }
    for (const [index, preview] of (summary.previews ?? []).entries()) {
      add('review_preview', {...identity, item_position:index + 1, text:preview.body,
        qualifier:`length=${preview.body_length}; images=${preview.image_count}`});
    }
  }
}
/** The requested sort with the tab marked before and after the click, then the sorted first-page cards. */
function sortRecords(result, add) {
  add('sort_condition', {label:'sort', text:result.requested_sort, verified:false,
    qualifier:`marked_before=${result.before?.pagination?.selected_sort_label ?? 'none'}; marked_after=${result.after?.pagination?.selected_sort_label ?? 'none'}`});
  searchRecords(result.after?.search ?? {}, add, result.after?.pagination);
}
function galleryRecords(result, add) {
  const identity = {product_id:result.product_id};
  for (const key of IMAGE_COUNTS) if (Object.hasOwn(result.gallery ?? {}, key)) add('image_scan', {...identity, label:key, text:displayValue(result.gallery[key])});
  imageLinkRecords(add, identity, 'gallery', result.gallery);
}
/** One selected thumbnail's main image; the thumbnail link and the selection checks stay in the qualifier. */
function mainImageRecords(snapshot, add) {
  const {sample} = snapshot, image = sample.image ?? {};
  add('main_image', {product_id:snapshot.product_id, item_position:snapshot.position, label:'main_image', url:image.url, loaded:image.loaded,
    qualifier:`thumbnail=${sample.thumbnail_url}; size=${image.width}x${image.height}; selected_marker_verified=${sample.association?.selected_marker_verified}; ` +
      `two_matching_observations=${sample.association?.two_matching_observations}`, verified:false});
}
/** Every scanned option with its image link or the reason none was obtained; each link keeps the time it was read. */
function specificationImageRecords(result, add) {
  const identity = {product_id:result.product_id};
  for (const option of result.options ?? []) {
    const shown = option.image ? option.observations?.find(observation => isDeepStrictEqual(observation.image, option.image)) : null;
    add('specification_image', {...identity, group_position:option.group_position, group_name:option.group, item_position:option.position,
      label:option.label, url:option.image?.url ?? null, loaded:option.image?.loaded ?? null,
      qualifier:`image_status=${option.image_status}; attempts=${option.attempts}`, verified:false, ...(shown ? {observed_at:shown.observed_at} : {})});
  }
  if (result.collection) add('specification_collection', {...identity, label:'stop_reason', text:result.collection.stop_reason});
}
/** One category sample: its tab list and label check, then each review with its follow-ups and seller replies. */
function reviewCategoryRecords(snapshot, add) {
  const {sample} = snapshot, identity = {product_id:snapshot.product_id, group_position:snapshot.position, group_name:sample.category};
  add('review_category', {...identity, label:sample.category, text:snapshot.total_text, verified:false,
    qualifier:`sort=${sample.sort_text}; category_ui_verified=${sample.association?.category_ui_verified}; ` +
      `content_changed_after_switch=${sample.association?.content_changed_after_switch}`});
  for (const option of sample.category_catalogue ?? []) {
    add('review_category_option', {...identity, item_position:option.position, label:option.label, text:option.count_text,
      selected:option.selected, disabled:option.disabled});
  }
  for (const key of REVIEW_COUNTS) if (Object.hasOwn(snapshot, key)) add('review_scan', {...identity, label:key, text:displayValue(snapshot[key])});
  for (const review of snapshot.reviews ?? []) {
    const position = {...identity, item_position:review.observation_index};
    add('review', {...position, label:review.purchase_text, text:review.body, truncated:review.text_may_be_truncated, verified:false});
    for (const [index, followup] of (review.followups ?? []).entries()) {
      add('review_followup', {...position, label:followup.interval_text, text:followup.body ?? followup.raw,
        qualifier:`followup=${index + 1}`, truncated:followup.text_may_be_truncated, verified:false});
      for (const reply of followup.seller_replies ?? []) {
        add('review_seller_reply', {...position, label:`followup_${index + 1}`, text:reply.body, truncated:reply.text_may_be_truncated, verified:false});
      }
    }
    for (const reply of review.seller_replies ?? []) {
      add('review_seller_reply', {...position, label:'review', text:reply.body, truncated:reply.text_may_be_truncated, verified:false});
    }
  }
}
const JD_CART_COUNTS = ['rows_seen', 'rows_returned', 'rows_omitted', 'shops_seen', 'rows_outside_shops', 'quantity_sum'];
/**
 * The loaded JD cart rows. Purchase status rests on page markers only; nothing here verifies that a row can be ordered.
 * Address, account, internal ids and image links are not in the result, so they cannot reach the report.
 */
function jdCartRecords(result, add) {
  add('cart_header_count', {label:'header_count', text:result.header_count_text, verified:false});
  for (const key of JD_CART_COUNTS) add('cart_scan', {label:key, text:displayValue(result[key])});
  for (const row of result.rows) {
    const shop = result.shops[row.shop_position - 1];
    const identity = {item_position:row.position, product_id:row.product_id};
    add('cart_item', {...identity, title:row.title, url:row.url, quantity:row.quantity});
    add('cart_shop', {...identity, label:shop.name, group_position:shop.position, qualifier:`zy_icon=${shop.zy_icon}`, verified:false});
    add('cart_specification', {...identity, label:row.spec_label, text:row.spec_text});
    add('cart_price', {...identity, text:row.price_text, verified:false,
      qualifier:`kind=${row.price_kind}${row.other_amount_text === null ? '' : `; other_amount=${row.other_amount_text}`}`});
    add('cart_availability', {...identity, label:row.availability.status, text:row.availability.reasons.length ? row.availability.reasons.join(' / ') : null,
      disabled:row.checkbox_disabled, verified:false});
  }
}
const JD_ORDER_COUNTS = ['groups_seen', 'orders_seen', 'orders_returned', 'orders_omitted', 'items_seen', 'items_returned'];
/**
 * The loaded JD order list cards. The time range is the page's own label, so the orders are never the full history.
 * Consignee, payment method, buttons and image links are not in the result, so they cannot reach the report.
 */
function jdOrderRecords(result, add) {
  add('order_list_view', {label:'time_range', text:result.time_range_text, verified:false});
  add('order_list_view', {label:'status_filter', text:result.status_filter_text, verified:false});
  for (const key of JD_ORDER_COUNTS) add('order_scan', {label:key, text:displayValue(result[key])});
  for (const notice of result.split_notices) {
    add('order_split_notice', {item_position:notice.position, group_position:notice.group_position, text:notice.notice_text, verified:false,
      qualifier:`info=${notice.info_texts.map(displayValue).join(' / ')}; detail_entry=${notice.detail_entry}`});
  }
  for (const order of result.orders) {
    const identity = {order_position:order.position, order_id:order.order_id};
    add('order', {...identity, group_position:order.group_position, qualifier:`split_order=${order.split_order}; detail_entry=${order.detail_entry}; ` +
      `items_seen=${order.items_seen}; items_returned=${order.items_returned}`});
    add('order_date', {...identity, text:order.order_time_text});
    add('order_shop', {...identity, text:order.shop_name, verified:false});
    add('order_status', {...identity, text:order.status_text, verified:false});
    add('order_price', {...identity, text:order.amount_text, verified:false,
      qualifier:order.amount_note_texts.length ? `notes=${order.amount_note_texts.join(' / ')}` : null});
    for (const item of order.items) {
      add('order_item', {...identity, item_position:item.position, product_id:item.product_id, title:item.title, url:item.url, quantity:item.quantity});
    }
  }
}
const JD_ORDER_DETAIL_COUNTS = ['progress_seen', 'items_seen', 'items_returned'];
/**
 * One JD order's detail page. Product cells are listed under the page's own column names; the consignee block, tracking
 * records, payment tab and the detail page's address with its PassKey are never in the result.
 */
function jdOrderDetailRecords(result, add) {
  const identity = {order_position:result.order_position, order_id:result.order_id};
  const {opening} = result;
  add('order', {...identity, qualifier:`split_order=${result.split_order}; order_id_on_page=${displayValue(result.order_id_on_page)}; ` +
    `layout=${displayValue(result.layout)}`});
  add('order_detail_opening', {...identity, label:opening.click, verified:false,
    qualifier:`click_error=${displayValue(opening.click_error)}; tab_checks=${opening.tab_checks}; reads_reserved=${opening.reads_reserved}; ` +
      `detail_tab_closed=${opening.detail_tab_closed}; close_error=${displayValue(opening.close_error)}; list_observed_at=${opening.list_observed_at}`});
  for (const key of JD_ORDER_DETAIL_COUNTS) add('order_scan', {...identity, label:key, text:displayValue(result[key])});
  add('order_status', {...identity, text:result.status_text, verified:false});
  for (const node of result.progress) {
    add('order_progress', {...identity, item_position:node.position, label:node.name, text:node.time_text, done_marker:node.reached, verified:false});
  }
  add('order_shipping', {...identity, text:result.shipping_text, verified:false});
  for (const item of result.items) {
    const cells = item.cells.map((cell, index) => `${result.item_columns[index] ?? `column_${index + 1}`}=${cell}`).join('; ');
    add('order_item', {...identity, item_position:item.position, product_id:item.product_id, title:item.title, url:item.url, quantity:item.quantity,
      qualifier:cells || null});
  }
  for (const amount of result.amounts) add('order_amount', {...identity, label:amount.label, text:amount.value_text, verified:false});
}
/**
 * One JD 全部评价 category sample and its rendered cards. Nicknames, avatars and media URLs are never in the result.
 * The tag list and panel state come from the last read with the panel open, so they are listed once, with the last sample.
 */
function jdReviewCategoryRecords(snapshot, add) {
  const {sample, panel} = snapshot, identity = {product_id:snapshot.product_id, group_position:snapshot.position, group_name:sample.category};
  add('review_category', {...identity, label:sample.category, text:sample.count_text, verified:false,
    qualifier:`requested=${sample.requested ?? 'current'}; sort=${panel.sort_text}; sku=${panel.sku_select_text}; ` +
      `list_changed=${sample.list_changed}; cards_rendered=${sample.cards_rendered}; cards_seen=${sample.cards_seen}`});
  for (const card of sample.cards) {
    const position = {...identity, item_position:card.position};
    add('review', {...position, label:card.date_text, text:card.body, truncated:card.body_length > card.body.length, verified:false,
      qualifier:`spec=${card.spec_text}; rating=${card.rating_mark}; media_items=${card.media.count}; videos=${card.media.videos}`});
    if (card.followup) {
      add('review_followup', {...position, label:card.followup.interval_text, text:card.followup.body, qualifier:'followup=1',
        truncated:card.followup.body_length > card.followup.body.length, verified:false});
    }
  }
  if (!snapshot.last) return;
  add('review_panel', {product_id:snapshot.product_id, label:panel.initial_state, verified:false,
    qualifier:`opened_by_task=${panel.opened_by_task}; open_acknowledgement=${panel.open_acknowledgement}; close_status=${panel.close_status}`});
  for (const [index, tag] of snapshot.categories_seen.entries()) {
    add('review_category_option', {product_id:snapshot.product_id, item_position:index + 1, label:tag.name, text:tag.count_text,
      selected:tag.selected, qualifier:'last_open_panel_read'});
  }
}
/** How the order page was opened, its route binding and page state; the order fields themselves were never read. */
function orderEntryRecords(result, add) {
  const identity = {order_id:result.target?.order_id};
  add('order_entry', {...identity, url:result.target?.url, label:result.outcome, verified:false,
    qualifier:`opening=${result.opening?.action_outcome}; navigation_verified=${result.opening?.navigation_verified}; ` +
      `route_order_binding_verified=${result.page?.route_order_binding_verified}; page_state=${result.page?.page_state}`});
  const error = result.page?.error_page;
  if (error) {
    addRegion(add, 'order_error_page', identity, error.title_region, 'title');
    addRegion(add, 'order_error_page', identity, error.subtitle_region, 'subtitle');
  }
}
const RECORD_BUILDERS = {search_sort:sortRecords, product_gallery:galleryRecords, product_main_images:mainImageRecords,
  product_specification_images:specificationImageRecords, product_review_categories:reviewCategoryRecords, order_detail_check:orderEntryRecords,
  jd_search:jdSearchRecords, jd_search_pages:jdSearchPageRecords, jd_search_sort:jdSortedPageRecords, jd_product:jdProductRecords, jd_review_categories:jdReviewCategoryRecords, jd_cart:jdCartRecords,
  jd_orders:jdOrderRecords, jd_order_detail:jdOrderDetailRecords, pdd_search:pddSearchRecords, pdd_search_sort:pddSortRecords, pdd_product:pddProductRecords, pdd_reviews:pddReviewRecords, pdd_spec_prices:pddSpecPriceRecords,
  pdd_orders:pddOrderRecords, pdd_order_detail:pddOrderDetailRecords};
function priceRangeStatuses(result) {
  return new Map((result.displayed_price_order?.records ?? []).map(row => [`${row.platform_page ?? 1}:${row.platform_position}:${row.product_id}`, row.range_status]));
}
function priceSearchItems(search, statuses, add) {
  for (const item of search?.items ?? []) {
    add('search_item', {item_position:item.position, product_id:item.product_id, title:item.title, url:item.url, label:item.price?.label,
      text:item.price?.raw, qualifier:`range=${statuses.get(`${search.page}:${item.position}:${item.product_id}`) ?? 'unknown'}`, verified:false});
  }
}
/**
 * Applied conditions, platform-order cards, paging, the local displayed-price order and the sample checks of one price task.
 * Later result pages are separate observations that carry only their own cards.
 */
function priceRecords(result, add) {
  if (result.later_page) { priceSearchItems(result.search, priceRangeStatuses(result.source_result), add); return; }
  const sort = result.applied?.price_sort, range = result.applied?.price_range;
  if (result.applied?.source) add('price_condition', {label:'source', text:result.applied.source.source,
    qualifier:`marked=${result.applied.source.tab_label}; tab=${result.applied.source.address_tab}`});
  for (const filter of result.applied?.filters ?? []) add('price_condition', {label:'filter', text:filter.label, qualifier:`marked=${filter.marker}`});
  if (sort) add('price_condition', {label:'price_sort', text:sort.direction, qualifier:`marked=${sort.marked_option}`});
  if (range) add('price_condition', {label:'price_range', text:`${range.minimum?.amount ?? ''}-${range.maximum?.amount ?? ''}`,
    qualifier:`reopened=${range.reopened_input_text?.minimum_text ?? ''}/${range.reopened_input_text?.maximum_text ?? ''}`});
  priceSearchItems(result.after?.search, priceRangeStatuses(result), add);
  const paging = result.paging;
  if (paging) {
    const kept = paging.last_page_checks;
    add('price_paging', {label:paging.end_reason, text:`${paging.pages_read}/${paging.requested_pages}`,
      qualifier:`total_pages=${paging.total_pages_displayed}; last_page=${kept.page}; marked=${kept.marked_option ?? 'none'}; ` +
        `reopened=${kept.reopened_input_text ? `${kept.reopened_input_text.minimum_text}/${kept.reopened_input_text.maximum_text}` : 'none'}`});
  }
  for (const row of result.displayed_price_order?.records ?? []) {
    add('local_price_order', {item_position:row.local_rank, product_id:row.product_id, title:row.title, url:row.url, text:row.comparable_price?.amount ?? null,
      qualifier:`${paging ? `platform_page=${row.platform_page}; ` : ''}platform_position=${row.platform_position}; not_platform_order`, verified:false});
  }
  for (const name of ['order_check', 'range_check']) {
    const check = result.displayed_price_check?.[name];
    if (check) add('price_check', {label:name, text:check.status, verified:false});
  }
}
// An entry check names the list order it opened directly.
function listProvenance(source) {
  if (!source || typeof source.task !== 'string') return [];
  return [{kind:'order_list', source_task:source.task, observed_at:scalar(source.observed_at), order_position:scalar(source.position),
    order_id:scalar(source.order_id), url:scalar(source.list_url)}];
}
function provenance(source) {
  if (!source || typeof source.task !== 'string') return [];
  const entry = {kind:'order_entry', source_task:source.task, observed_at:scalar(source.observed_at)};
  if (!source.list) return [entry];
  return [entry, {kind:'order_list', source_task:scalar(source.list.task), observed_at:scalar(source.list.observed_at),
    order_position:scalar(source.list.position), order_id:scalar(source.list.order_id), url:scalar(source.list.list_url)}];
}
function operationSnapshots(kind, op) {
  if (kind === 'search_collection') {
    // Unfinished collections still report the pages that were already confirmed and saved.
    return (op.result?.pages ?? op.search_collection?.pages ?? []).map((page, index) => ({snapshot:page.search, pagination:page.pagination, batch_position:index + 1}));
  }
  if (kind === 'jd_search_pages') {
    // Each page keeps its own time; the pages of a task that stopped early stay in its journal and are not exported.
    return (op.result?.pages ?? []).map(page => ({snapshot:{...page.search, pager:page.pager, transition:page.transition}, batch_position:page.page}));
  }
  if (kind === 'jd_search_sort') {
    return (op.result?.pages ?? []).map(page => ({snapshot:{...page.search, pager:page.pager, transition:page.transition, sort_bar:page.sort_bar,
      active_sort:page.active_sort, direction_check:page.direction_check, ...(page.price_range_check ? {price_range_check:page.price_range_check} : {}),
      ...(page.page === 1 ? {sort_steps:op.result.sort.steps, ...(op.result.price_range ? {price_range:op.result.price_range} : {})} : {})}, batch_position:page.page}));
  }
  if (kind === 'order_pages') {
    // Each list page is its own observation with its own time; unfinished tasks still report their confirmed pages.
    const empty = op.result?.empty_last_page ?? op.order_pages?.empty_last_page ?? null;
    return [...(op.result?.pages ?? op.order_pages?.pages ?? []).map(page => ({snapshot:page.rows, pager:page.pager, view:page.view,
      batch_position:page.pager.current_page})),
      // A confirmed trailing page without orders keeps its own time, pager and view, with zero returned orders.
      ...(empty ? [{snapshot:{observed_at:empty.observed_at, url:empty.url, source:'trade_bought_list_order_dom', orders:[],
        coverage:{loaded_orders_seen:0, returned_orders:0}}, pager:empty.pager, view:empty.view, batch_position:empty.pager.current_page}] : [])];
  }
  if (kind === 'cart_collection' || kind === 'order_collection') {
    const saved = kind === 'cart_collection' ? op.cart_collection : op.order_collection;
    return (saved?.batches ?? op.result?.batches ?? []).map((batch, index) => ({snapshot:batch.snapshot, batch_position:index + 1}));
  }
  // A price result's observation time and address belong to its final first-page snapshot; each later page keeps its own.
  if (kind === 'search_price') {
    if (!op.result) return [];
    const paged = Array.isArray(op.result.pages);
    return [{snapshot:{...op.result, observed_at:op.result.after?.search?.observed_at, url:op.result.after?.search?.url}, batch_position:paged ? 1 : null},
      ...(paged ? op.result.pages.map((page, index) => ({snapshot:{later_page:true, search:page.search, observed_at:page.search.observed_at,
        url:page.search.url, source:op.result.source, coverage:op.result.coverage, missing:op.result.missing, source_result:op.result}, batch_position:index + 2})) : [])];
  }
  if (!op.result) return [];
  // Each main-image or review-category sample keeps its own observation time.
  if (kind === 'product_main_images') {
    return op.result.samples.map((sample, index) => ({snapshot:{sample, position:index + 1, product_id:op.result.product_id,
      observed_at:sample.observed_at, url:op.result.url, source:sample.source}, batch_position:index + 1}));
  }
  if (kind === 'product_review_categories') {
    return op.result.samples.map((sample, index) => ({snapshot:{...sample.reviews, sample, position:index + 1}, batch_position:index + 1}));
  }
  if (kind === 'jd_review_categories') {
    const {samples} = op.result;
    return samples.map((sample, index) => ({snapshot:{sample, position:index + 1, last:index === samples.length - 1, product_id:op.result.product_id,
      panel:op.result.panel, categories_seen:op.result.categories_seen, observed_at:sample.observed_at, url:op.result.url,
      source:op.result.source}, batch_position:index + 1}));
  }
  if (kind === 'search_sort') {
    return [{snapshot:{...op.result, observed_at:op.result.after?.search?.observed_at, url:op.result.after?.search?.url}, batch_position:null}];
  }
  if (kind === 'product_specification_images') return [{snapshot:{...op.result, observed_at:op.result.inventory_observed_at}, batch_position:null}];
  if (kind === 'order_detail_check') {
    return [{snapshot:{...op.result, observed_at:op.result.page?.observed_at, url:op.result.page?.url, source:op.result.scope}, batch_position:null}];
  }
  return [{snapshot:kind === 'order_body_snapshot' ? op.result.body : op.result, batch_position:null}];
}
// Card records and distinct products are different counts and stay separate.
function searchCollectionSummary(kind, op) {
  if (!['search_collection', 'order_pages', 'jd_search_pages', 'jd_search_sort'].includes(kind) || !op.result) return {};
  const keys = kind === 'order_pages' ? ['returned_orders', 'distinct_orders', 'end_reason']
    : kind === 'jd_search_pages' ? ['pages_read', 'distinct_products', 'cross_page_duplicates_omitted', 'end_reason', 'total_pages_text']
    : kind === 'jd_search_sort' ? ['requested_sort', 'pages_read', 'distinct_products', 'cross_page_duplicates_omitted', 'end_reason', 'total_pages_text']
    : ['records', 'distinct_products', 'end_reason'];
  return Object.fromEntries(keys.map(key => [key, scalar(op.result[key])]));
}
function newObservation(task, op, operationPosition, snapshot, batchPosition, position) {
  const keys = coverageKeys(task.kind);
  return {position, operation_position:operationPosition, operation_status:scalar(op.status), batch_position:batchPosition,
    available:Boolean(snapshot), observed_at:scalar(snapshot?.observed_at), source:scalar(snapshot?.source), url:scalar(snapshot?.url),
    requested_rows:scalar(op.cart_read?.row_limit ?? op.result?.requested_rows), requested_orders:scalar(op.order_read?.order_limit ?? op.result?.requested_orders),
    scope:task.kind, coverage:{...projectCoverage(snapshot?.coverage, '', keys), ...projectCoverage(snapshot?.details?.coverage, 'details.'),
      ...availabilityCounts(snapshot?.availability_summary)},
    collection_coverage:batchPosition === null ? {} : {...projectCoverage(op.result?.coverage, '', keys), ...searchCollectionSummary(task.kind, op),
      ...availabilityCounts(op.result?.availability_summary)},
    missing:snapshot ? [...missingFields(snapshot.missing), ...missingFields(snapshot.details?.missing, 'details.'),
      ...(['search_collection', 'order_pages', 'jd_search_pages', 'jd_search_sort'].includes(task.kind) ? missingFields(op.result?.missing, 'collection.') : [])] : ['cached_result'],
    provenance:task.kind === 'order_body_snapshot' ? provenance(op.source ?? op.result?.source)
      : task.kind === 'order_detail_check' ? listProvenance(op.source ?? op.result?.source) : []};
}

/**
 * Project one already validated saved task into allowlisted local report data without IO or mutation.
 * @param {object} task Checkpoint returned by loadTask; source validation remains the caller's responsibility.
 * @returns {{task:object, observations:object[], records:object[]}} Original observation times, coverage and flat text records.
 * @throws {ShoppingError} INVALID_CHECKPOINT for an invalid envelope, INVALID_RESPONSE for invalid empty evidence,
 * or UNSUPPORTED_REPORT_KIND for unsupported kinds.
 * @example buildCachedReport(await loadTask(stateDirectory, 'saved-cart'));
 */
export function buildCachedReport(task) {
  if (!task || typeof task !== 'object' || typeof task.kind !== 'string') {
    throw new ShoppingError('INVALID_CHECKPOINT', 'Use a validated saved task for report export.');
  }
  if (!REPORT_KINDS.has(task.kind)) throw new ShoppingError('UNSUPPORTED_REPORT_KIND', 'This saved task kind does not support text report export.');
  if (!['id', 'status', 'created_at', 'updated_at'].every(key => typeof task[key] === 'string') || !Array.isArray(task.operations) ||
      task.operations.some(op => !op || typeof op !== 'object' || Array.isArray(op))) {
    throw new ShoppingError('INVALID_CHECKPOINT', 'Use a validated saved task for report export.');
  }
  const report = {task:Object.fromEntries(['id', 'kind', 'status', 'created_at', 'updated_at'].map(key => [key, task[key]])), observations:[], records:[]};
  for (const [index, op] of task.operations.entries()) {
    const snapshots = operationSnapshots(task.kind, op);
    for (const {snapshot, batch_position, pagination, pager, view} of snapshots.length ? snapshots : [{snapshot:null, batch_position:null}]) {
      const observation = newObservation(task, op, index + 1, snapshot, batch_position, report.observations.length + 1);
      report.observations.push(observation);
      if (!snapshot) continue;
      const add = recordAdder(report, observation);
      if (task.kind.startsWith('cart_') || ['order_snapshot', 'order_collection'].includes(task.kind)) {
        emptyListRecord(snapshot, add, task.kind.startsWith('cart_'));
      }
      if (RECORD_BUILDERS[task.kind]) RECORD_BUILDERS[task.kind](snapshot, add);
      else if (task.kind.startsWith('cart_')) cartRecords(snapshot, add);
      else if (task.kind === 'order_body_snapshot') bodyRecords(snapshot, add);
      else if (task.kind === 'order_pages') orderPageRecords(snapshot, add, pager, view);
      else if (task.kind.startsWith('order_')) orderRecords(snapshot, add);
      else if (task.kind === 'search_price') priceRecords(snapshot, add);
      else if (task.kind === 'search' || task.kind === 'search_collection') searchRecords(snapshot, add, pagination);
      else productRecords(snapshot, add);
    }
  }
  return report;
}

function displayValue(value) { return value === null || value === undefined ? 'null' : String(value); }
function markdownText(value) {
  return displayValue(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/([\\`*_{}[\]()|#!~])/g, '\\$1');
}
function markdownReport(report) {
  const lines = ['# 缓存采集报告', '', CAUTION, '',
    `任务：${markdownText(report.task.id)}；类型：${markdownText(report.task.kind)}；状态：${markdownText(report.task.status)}`, '',
    `任务创建时间：${markdownText(report.task.created_at)}；任务更新时间：${markdownText(report.task.updated_at)}`, ''];
  for (const observation of report.observations) {
    lines.push(`## 观察 ${observation.position}`, '',
      `操作：${observation.operation_position}；操作状态：${markdownText(observation.operation_status)}；批次：${markdownText(observation.batch_position)}；已有内容：${observation.available}`, '',
      `原采集时间：${markdownText(observation.observed_at)}；来源：${markdownText(observation.source)}`, '',
      `来源地址：${markdownText(observation.url)}`, '');
    if (observation.requested_rows !== null || observation.requested_orders !== null) {
      lines.push(`原请求范围：购物车行数=${markdownText(observation.requested_rows)}；订单数=${markdownText(observation.requested_orders)}`, '');
    }
    for (const source of observation.provenance) {
      lines.push(`关联来源：${markdownText(source.kind)}／${markdownText(source.source_task)}；原采集时间：${markdownText(source.observed_at)}；订单位置：${markdownText(source.order_position)}`, '');
      if (source.kind === 'order_list') lines.push(`来源订单编号：${markdownText(source.order_id)}；来源地址：${markdownText(source.url)}`, '');
    }
    const coverages = {...observation.coverage, ...Object.fromEntries(Object.entries(observation.collection_coverage).map(([key, value]) => ['collection.' + key, value]))};
    if (Object.keys(coverages).length) {
      lines.push('覆盖范围：', '', '| 字段 | 原值 |', '| --- | --- |');
      for (const [key, value] of Object.entries(coverages)) lines.push(`| ${markdownText(key)} | ${markdownText(value)} |`);
      lines.push('');
    }
    lines.push(`缺失字段：${observation.missing.length ? observation.missing.map(markdownText).join('；') : '未记录缺失字段（不表示完整）'}`, '');
    const records = report.records.filter(record => record.observation_position === observation.position);
    if (!records.length) {lines.push('无已缓存内容记录。', ''); continue;}
    if (records.some(record => record.record_type === 'empty_notice')) {
      lines.push('明确空状态仅适用于原采集时间的当前列表视图；全车、全历史和账户身份仍未验证。', '');
    }
    lines.push('| 类型 | 订单位置／编号 | 商品位置／编号 | 标题／标签 | 原文／数量 | 标记 | 链接 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of records) {
      const text = row.text ?? (row.quantity === undefined ? null : `quantity=${displayValue(row.quantity)}; raw=${displayValue(row.quantity_text)}; source=${displayValue(row.quantity_source)}`);
      const flags = ['selected', 'disabled', 'current_marker', 'done_marker', 'loaded', 'truncated', 'clipped', 'verified', 'quantity_verified']
        .filter(key => Object.hasOwn(row, key)).map(key => `${key}=${displayValue(row[key])}`);
      if (row.qualifier !== null && row.qualifier !== undefined) flags.push(`qualifier=${row.qualifier}`);
      if (row.group_name) flags.push(`group=${row.group_name}; position=${row.group_position}`);
      if (row.missing) flags.push(`missing=${row.missing}`);
      lines.push('| ' + [row.record_type, `${displayValue(row.order_position)} / ${displayValue(row.order_id)}`,
        `${displayValue(row.item_position)} / ${displayValue(row.product_id)}`, [row.title, row.label].filter(value => value !== null && value !== undefined).join(' / '),
        text, flags.join('; '), row.url].map(markdownText).join(' | ') + ' |');
    }
    lines.push('');
  }
  return lines.join('\n');
}
function csvCell(value, identifier = false) {
  let text = value === null || value === undefined ? '' : String(value);
  // CSV quoting does not stop spreadsheet formulas or long-identifier numeric conversion.
  if (text && (identifier || /^[\s\p{Cc}\p{Cf}]*[=+@-]/u.test(text))) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function csvReport(report) {
  const taskFields = {source_task:report.task.id, task_kind:report.task.kind, task_status:report.task.status,
    task_created_at:report.task.created_at, task_updated_at:report.task.updated_at};
  const rows = [{...taskFields, record_type:'report_notice', text:CAUTION}];
  for (const observation of report.observations) {
    const context = {...taskFields, observation_position:observation.position, operation_position:observation.operation_position,
      operation_status:observation.operation_status, batch_position:observation.batch_position, observed_at:observation.observed_at,
      source:observation.source, available:observation.available, requested_rows:observation.requested_rows, requested_orders:observation.requested_orders};
    rows.push({...context, record_type:'observation', url:observation.url, label:observation.scope});
    if (report.records.some(record => record.observation_position === observation.position && record.record_type === 'empty_notice')) {
      rows.push({...context, record_type:'empty_scope_notice', text:'明确空状态仅适用于原采集时间的当前列表视图；全车、全历史和账户身份仍未验证。'});
    }
    for (const source of observation.provenance) {
      rows.push({...context, record_type:'provenance', provenance_kind:source.kind, provenance_task:source.source_task,
        provenance_observed_at:source.observed_at, provenance_order_position:source.order_position,
        provenance_order_id:source.order_id, provenance_url:source.url});
    }
    for (const [label, value] of Object.entries(observation.coverage)) rows.push({...context, record_type:'coverage', label, text:displayValue(value)});
    for (const [label, value] of Object.entries(observation.collection_coverage)) rows.push({...context, record_type:'collection_coverage', label, text:displayValue(value)});
    for (const text of observation.missing) rows.push({...context, record_type:'missing_field', text});
    for (const record of report.records.filter(item => item.observation_position === observation.position)) rows.push({...context, ...record});
  }
  return '\ufeff' + [COLUMNS.map(name => csvCell(name)).join(','), ...rows.map(row => COLUMNS.map(name => csvCell(row[name], IDENTIFIER_COLUMNS.has(name))).join(','))].join('\r\n') + '\r\n';
}

/**
 * Render projected report data as safe Markdown or spreadsheet-compatible CSV, without IO.
 * @param {object} report Projection returned by buildCachedReport.
 * @param {'markdown'|'csv'} format Requested text format; CSV has a UTF-8 BOM and apostrophe-protected identifiers/formulas.
 * @returns {string} UTF-8 text; presentation escaping never changes source observations.
 * @throws {ShoppingError} INVALID_ARGUMENTS when the format is unsupported.
 * @example renderCachedReport(buildCachedReport(task), 'markdown');
 */
export function renderCachedReport(report, format) {
  if (format === 'markdown') return markdownReport(report);
  if (format === 'csv') return csvReport(report);
  throw new ShoppingError('INVALID_ARGUMENTS', 'Choose report format markdown or csv.');
}
