import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCachedReport, renderCachedReport } from '../lib/cached-report.mjs';

const times = ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'];
const region = text => ({text, truncated:false});
function task(kind, operations, status = 'complete') {
  return {id:'synthetic-report', kind, status, created_at:'2026-09-30T00:00:00Z', updated_at:'2026-10-09T00:00:00Z',
    endpoint:'http://private-endpoint.test', credentials:'DO_NOT_EXPORT', operations};
}
function cartRow(position, observedAt) {
  return {position, product_id:'123456789012345678901234567890', title:'Synthetic item', url:'https://item.taobao.com/item.htm?id=123',
    observed_at:observedAt, shop_region:region('Synthetic shop'), specification:region(position === 2 ? '' : 'Blue'),
    quantity:{value:2, source:'same_row_quantity_input', verified:true}, status_region:region('有效'),
    price_region_observations:{items:[{text:'¥ 12,34', label:region('促销'), kind:'unverified', truncated:false}], truncated:false},
    price_quantity_region:{text:'¥ 12,34 数量 2', truncated:false, nodes:[{direct_text:'DO_NOT_EXPORT'}]},
    missing:position === 2 ? ['specification_region'] : [], contact:'DO_NOT_EXPORT'};
}
function cartSnapshot(position, observedAt = times[0]) {
  return {observed_at:observedAt, source:'trade_cart_item_info_dom', url:'https://cart.taobao.com/cart.htm',
    rows:[cartRow(position, observedAt)], coverage:{status:'partial', loaded_rows_seen:30, returned_rows:1, rows_omitted:29,
      page_total_rows:null, full_cart:false, account_identity_verified:false, payment_verified:false, private:'DO_NOT_EXPORT'}};
}
function orderItem(position = 1) {
  return {position, product_id:'123456789012345678901', title:'Order item', url:'https://item.taobao.com/item.htm?id=123',
    title_region:region('Order item'), item_information:{items:[region('尺寸：L'),region('颜色：红')], truncated:false},
    quantity:{value:3, region:region('x3'), source:'same_item_quantity_display', verified:true},
    price_observations:{items:[{text:'¥99.00', label:region('原价'), kind:'unverified', truncated:false}], truncated:false}, missing:[]};
}
function orderSnapshot(position = 1, observedAt = times[0]) {
  return {observed_at:observedAt, source:'trade_bought_list_order_dom', url:'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
    coverage:{status:'partial', loaded_orders_seen:30, returned_orders:1, orders_omitted:29, full_order_history:false, settlement_verified:false},
    orders:[{position, order_id:'900123456789012345678901234567890', placed_at_region:region('2026-10-01'),
      shop_name_region:region('Order shop'), status_region:region('交易关闭'), detail_entry:{url:'https://buyertrade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=900'},
      payment_observations:{items:[{text:'¥299.00', label:region('实付款'), truncated:false}], truncated:false},
      items:[orderItem()], coverage:{loaded_items_seen:8, returned_items:1, items_omitted:7, full_order_items_verified:false}, missing:[]} ]};
}
function productSnapshot() {
  return {observed_at:times[0], source:'loaded_product_dom', product_id:'100000000000000000001', title:'Test product', url:'https://item.taobao.com/item.htm?id=123',
    specification_groups:[{name:'颜色', options:[{label:'蓝', selected:true, disabled:null}]}],
    prices:[{raw:'秒杀价 ¥69', label:'秒杀价', qualifier:'限会员', amount_text:'69', sku_price_binding_verified:false}],
    coverage:{status:'partial', specifications:'loaded_options_only', prices:'displayed_conditions_unverified', reviews:'preview_only'},
    missing:['verified_sku_price_mapping'], review_previews:[{body:'Preview text', date_text:'昨天', text_may_be_truncated:true}],
    details:{shop:{name:'Product shop', url:'https://shop123.taobao.com/category.htm'},
      attributes:{items:[{name:'材质', value:'棉', text_may_be_truncated:true}]},
      description:{text:'Description text', text_may_be_truncated:true, items:[{position:4, url:'https://img.alicdn.com/example.jpg', loaded:true}]},
      gallery:{items:[{position:7, url:'https://img.alicdn.com/gallery.jpg', loaded:false}]},
      services:{labels:['退换'], terms:{items:[{label:'退换', header_text:'退换 查看', body_text:'限符合条件', body_truncated:false, body_clipped:false}]}},
      shipping:{freight_labels:['运费待定']}, coverage:{status:'partial', full_description:false, image_scope:'links_only'}, missing:['full_service_terms']},
    cookies:'DO_NOT_EXPORT'};
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
function parseCsv(text) {
  const rows = [], row = []; let value = '', quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') {value += '"'; i++;} else quoted = !quoted; }
    else if (char === ',' && !quoted) {row.push(value); value = '';}
    else if (char === '\r' && text[i + 1] === '\n' && !quoted) {row.push(value); rows.push([...row]); row.length = 0; value = ''; i++;}
    else value += char;
  }
  assert.equal(quoted, false);
  return rows;
}

test('cart report preserves repeated products, empty text, raw prices and original collection times', () => {
  const snapshots = [cartSnapshot(1), cartSnapshot(2, times[1])];
  const input = freeze(task('cart_collection', [{status:'succeeded', tab_id:55, result:{batches:snapshots.map(snapshot => ({snapshot}))},
    cart_collection:{batches:snapshots.map(snapshot => ({attempt:1, snapshot}))}}]));
  const report = buildCachedReport(input), items = report.records.filter(row => row.record_type === 'cart_item');
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => [item.item_position,item.product_id,item.observed_at]),
    [[1,snapshots[0].rows[0].product_id,times[0]],[2,snapshots[0].rows[0].product_id,times[1]]]);
  assert.equal(report.records.find(row => row.record_type === 'cart_specification' && row.item_position === 2).text, '');
  assert.equal(report.records.find(row => row.record_type === 'cart_price').text, '¥ 12,34');
  assert.equal(report.records.find(row => row.record_type === 'cart_price').verified, false);
  assert.equal(report.observations[0].coverage.full_cart, false);
  assert.equal(report.observations[0].coverage.page_total_rows, null);
  assert.equal(JSON.stringify(report).includes('DO_NOT_EXPORT'), false);
  assert.equal(JSON.stringify(report).includes('private-endpoint'), false);
});

test('snapshot and partial collection reports read saved evidence without requiring a final result', () => {
  for (const kind of ['cart_snapshot','cart_collection']) {
    const snapshot = cartSnapshot(1);
    const op = kind === 'cart_snapshot' ? {status:'succeeded', result:snapshot} : {status:'failed', result:null, cart_collection:{batches:[{snapshot}]}};
    const report = buildCachedReport(task(kind,[op],'stopped'));
    assert.equal(report.task.status,'stopped');
    assert.equal(report.observations[0].observed_at,times[0]);
    assert.equal(report.records.filter(row => row.record_type === 'cart_item').length,1);
    assert.equal(report.observations[0].coverage.status,'partial');
  }
});

test('order reports keep item and order prices separate and never interpret closed-order payment labels', () => {
  for (const kind of ['order_snapshot','order_collection']) {
    const snapshot = orderSnapshot();
    const op = kind === 'order_snapshot' ? {status:'succeeded', result:snapshot} : {status:'failed', result:null, order_collection:{batches:[{snapshot}]}};
    const report = buildCachedReport(task(kind,[op],'partial'));
    const order = report.records.find(row => row.record_type === 'order');
    assert.equal(order.order_id, snapshot.orders[0].order_id);
    assert.equal(report.records.find(row => row.record_type === 'order_price').label,'实付款');
    assert.equal(report.records.find(row => row.record_type === 'order_price').verified,false);
    assert.equal(report.records.find(row => row.record_type === 'order_item_price').text,'¥99.00');
    assert.equal(report.records.filter(row => row.record_type === 'order_item_information').length,2);
    assert.equal(report.records.find(row => row.record_type === 'order_status').text,'交易关闭');
    assert.equal(report.observations[0].coverage.full_order_history,false);
  }
});

test('body report retains original list, entry and body timestamps and mobile links independently', () => {
  const body = {observed_at:times[1], source:'tbpc_order_detail_dom', order_id:'90012345678901234567890',
    url:'https://buyertrade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=900', shop_name_region:region('Detail shop'),
    status_observations:{steps:[{position:1,title_region:region('提交订单'),current_marker:false,done_marker:true},
      {position:2,title_region:region('交易关闭'),current_marker:true,done_marker:false}]},
    items:[{...orderItem(), product:{product_id:'123456789012345678901',url:'https://a.m.taobao.com/i123456789012345678901.htm'}}],
    amount_observations:[{position:1,label_region:region('运费'),price_observations:{items:[{text:'¥0.00',label:null,truncated:false}]}}],
    coverage:{status:'partial',full_order_items_verified:false,account_identity_verified:false,settlement_verified:false}};
  const source = {task:'entry-source',observed_at:'2026-10-01T05:00:00Z',list:{task:'list-source',position:2,observed_at:times[0],order_id:body.order_id,list_url:'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'}};
  const report = buildCachedReport(task('order_body_snapshot',[{status:'succeeded',source,result:{source,body}}]));
  assert.equal(report.observations[0].observed_at,times[1]);
  assert.deepEqual(report.observations[0].provenance.map(row => [row.source_task,row.observed_at]),
    [['entry-source','2026-10-01T05:00:00Z'],['list-source',times[0]]]);
  assert.match(report.records.find(row => row.record_type === 'order_item').url,/a\.m\.taobao\.com/);
  assert.equal(report.records.find(row => row.record_type === 'order_progress' && row.current_marker).text,'交易关闭');
  assert.equal(report.records.find(row => row.record_type === 'order_amount').label,'运费');
  assert.equal(report.records.find(row => row.record_type === 'order_amount').verified,false);
  // A closed order's status banner replaces the progress steps in the report.
  const banner = {...body, status_observations:{layout:'status_banner', steps:[], banner:{status_region:region('交易关闭'), detail_region:region('合成关闭原因')},
    current_title:'交易关闭', source:'same_order_status_banner', settlement_verified:false}};
  const bannerReport = buildCachedReport(task('order_body_snapshot',[{status:'succeeded',source,result:{source,body:banner}}]));
  assert.equal(bannerReport.records.filter(row => row.record_type === 'order_progress').length, 0);
  assert.deepEqual(['order_status','order_status_detail'].map(type => bannerReport.records.find(row => row.record_type === type)?.text), ['交易关闭','合成关闭原因']);
  assert.equal(bannerReport.records.find(row => row.record_type === 'order_status').label, 'status_banner');
  const markdown = renderCachedReport(report,'markdown');
  assert.match(markdown,/来源订单编号：90012345678901234567890/);
  assert.match(markdown,/来源地址：https:\/\/buyertrade\.taobao\.com\/trade\/itemlist\/list\\_bought\\_items\.htm/);
  assert.ok(markdown.includes(source.list.observed_at));
  assert.ok(markdown.includes(source.observed_at));
  assert.ok(markdown.includes(body.observed_at));
  const csv = parseCsv(renderCachedReport(report,'csv')), headers = csv.shift();
  const sources = csv.filter(row => row[headers.indexOf('record_type')] === 'provenance');
  assert.equal(sources.length,2);
  for (const row of sources) {
    assert.equal(row[headers.indexOf('source_task')],'synthetic-report');
    assert.equal(row[headers.indexOf('observed_at')],body.observed_at);
    assert.equal(row[headers.indexOf('task_kind')],'order_body_snapshot');
    assert.equal(row[headers.indexOf('source')],body.source);
  }
  assert.deepEqual(sources.map(row => [row[headers.indexOf('provenance_kind')],row[headers.indexOf('provenance_task')],row[headers.indexOf('provenance_observed_at')]]),
    [['order_entry','entry-source',source.observed_at],['order_list','list-source',source.list.observed_at]]);
  assert.equal(sources[1][headers.indexOf('provenance_order_id')],`'${body.order_id}`);
  assert.equal(sources[1][headers.indexOf('provenance_url')],source.list.list_url);
});

test('all supported product report kinds include cached text, specifications and distinct image positions', () => {
  for (const kind of ['product_snapshot','product_details','product_services','product_description_expansion']) {
    const report = buildCachedReport(freeze(task(kind,[{status:'succeeded',result:productSnapshot()}])));
    assert.equal(report.records.find(row => row.record_type === 'product').title,'Test product');
    assert.equal(report.records.find(row => row.record_type === 'product_price').text,'秒杀价 ¥69');
    assert.equal(report.records.find(row => row.record_type === 'product_price').qualifier,'限会员');
    assert.equal(report.records.find(row => row.record_type === 'specification').selected,true);
    assert.equal(report.records.find(row => row.record_type === 'parameter').text,'棉');
    assert.equal(report.records.find(row => row.record_type === 'description').text,'Description text');
    assert.equal(report.records.find(row => row.record_type === 'service_term').text,'限符合条件');
    assert.deepEqual(report.records.filter(row => row.record_type === 'image_link').map(row => [row.item_position,row.label]),[[7,'gallery'],[4,'description']]);
    assert.equal(report.observations[0].coverage['details.full_description'],false);
    assert.equal(report.observations[0].missing.includes('details.full_service_terms'),true);
  }
});

test('description image links keep their module as a qualifier, and older links have none', () => {
  const snapshot = productSnapshot();
  snapshot.details.description.items.push({position:5, url:'https://img.alicdn.com/rich.jpg', loaded:true, module:'rich_text'});
  const report = buildCachedReport(task('product_details',[{status:'succeeded',result:snapshot}]));
  assert.deepEqual(report.records.filter(row => row.record_type === 'image_link').map(row => [row.item_position,row.label,row.qualifier ?? null]),
    [[7,'gallery',null],[4,'description',null],[5,'description','module=rich_text']]);
  assert.ok(renderCachedReport(report,'csv').includes('"module=rich_text"'));
});

test('empty pending operations produce explicit unavailable observations with no invented observation time', () => {
  const report = buildCachedReport(task('product_snapshot',[{status:'pending',result:null}],'pending'));
  assert.equal(report.observations[0].available,false);
  assert.equal(report.observations[0].observed_at,null);
  assert.deepEqual(report.observations[0].missing,['cached_result']);
  assert.deepEqual(report.records,[]);
  assert.match(renderCachedReport(report,'markdown'),/cached\\_result/);
  const rows = parseCsv(renderCachedReport(report,'csv'));
  assert.ok(rows.some(row => row.includes('cached_result')));
  assert.ok(rows.some(row => row.includes('pending')));
});

test('reports reject unsupported task kinds and render formats without producing partial output', () => {
  assert.throws(() => buildCachedReport(task('search_controls',[])),{code:'UNSUPPORTED_REPORT_KIND'});
  assert.throws(() => buildCachedReport(null),{code:'INVALID_CHECKPOINT'});
  assert.throws(() => renderCachedReport(buildCachedReport(task('cart_snapshot',[])),'html'),{code:'INVALID_ARGUMENTS'});
});

test('CSV round-trips quoted multiline text and protects long identifiers as text', () => {
  const snapshot = cartSnapshot(1), row = snapshot.rows[0];
  row.title = '标题, "quoted"\n下一行';
  const report = buildCachedReport(task('cart_snapshot',[{status:'succeeded',result:snapshot}]));
  const rows = parseCsv(renderCachedReport(report,'csv')), headers = rows.shift();
  const record = rows.find(values => values[headers.indexOf('record_type')] === 'cart_item');
  assert.equal(record[headers.indexOf('title')],row.title);
  assert.equal(record[headers.indexOf('product_id')],`'${row.product_id}`);
  assert.ok(rows.every(values => values.length === headers.length));
  assert.equal(report.records.find(item => item.record_type === 'cart_item').product_id,row.product_id);
});

test('CSV mitigates formulas after whitespace and controls while preserving original cached text', () => {
  for (const title of ['=1+1','+SUM(A1)','-1+2','@SUM(A1)','  =HYPERLINK("https://example.test")','\t\r\n=1','\u0001=1','\u0085=1','\u200b=1']) {
    const snapshot = cartSnapshot(1); snapshot.rows[0].title = title;
    const report = buildCachedReport(task('cart_snapshot',[{status:'succeeded',result:snapshot}]));
    const rows = parseCsv(renderCachedReport(report,'csv')), headers = rows.shift();
    const record = rows.find(values => values[headers.indexOf('record_type')] === 'cart_item');
    assert.equal(record[headers.indexOf('title')],`'${title}`);
    assert.equal(report.records.find(item => item.record_type === 'cart_item').title,title);
  }
});

test('unknown quantity retains its raw observation and absent regions never become verified content', () => {
  const snapshot = cartSnapshot(1), row = snapshot.rows[0];
  row.quantity = {value:null, source:'same_row_quantity_display', verified:false, display:region('未知')};
  row.shop_region = null; row.specification = null; row.status_region = null; row.price_quantity_region = null;
  row.price_region_observations = {items:[], truncated:false}; row.missing = ['quantity','specification_region'];
  const report = buildCachedReport(task('cart_snapshot',[{status:'succeeded',result:snapshot}]));
  const item = report.records.find(record => record.record_type === 'cart_item');
  assert.equal(item.quantity,null);
  assert.equal(item.quantity_text,'未知');
  assert.equal(item.quantity_verified,false);
  assert.equal(report.records.filter(record => record.record_type !== 'field_coverage').length,1);
  const markdown = renderCachedReport(report,'markdown');
  assert.match(markdown,/未知/);
  assert.match(markdown,/quantity=null/);
});

test('empty product regions and multiple operations remain explicit across both output formats', () => {
  const snapshot = productSnapshot();
  delete snapshot.details; snapshot.prices = []; snapshot.specification_groups = []; snapshot.review_previews = [];
  const report = buildCachedReport(task('product_snapshot',[{status:'succeeded',result:snapshot},{status:'pending',result:null}],'partial'));
  assert.deepEqual(report.observations.map(row => [row.operation_position,row.available]),[[1,true],[2,false]]);
  assert.equal(report.records.length,1);
  assert.match(renderCachedReport(report,'markdown'),/无已缓存内容记录/);
  assert.equal(parseCsv(renderCachedReport(report,'csv')).filter(row => row.includes('observation')).length,2);
});

test('invalid task envelopes fail without converting arbitrary objects into report text', () => {
  for (const input of [task('cart_snapshot',null), {...task('cart_snapshot',[]),id:33}, task('cart_snapshot',[null]),task('cart_snapshot',[[]])]) {
    assert.throws(() => buildCachedReport(input),{code:'INVALID_CHECKPOINT'});
  }
});

test('collection report distinguishes requested scope, per-batch coverage and aggregate cached coverage', () => {
  const snapshot = cartSnapshot(1);
  const report = buildCachedReport(task('cart_collection',[{status:'failed',cart_read:{row_limit:10},
    cart_collection:{batches:[{snapshot}]},result:{requested_rows:10,batches:[{snapshot}],
      coverage:{status:'partial',returned_rows:1,requested_limit_reached:false,full_cart:false}}}], 'partial'));
  assert.equal(report.observations[0].requested_rows,10);
  assert.equal(report.observations[0].coverage.rows_omitted,29);
  assert.equal(report.observations[0].collection_coverage.requested_limit_reached,false);
  const markdown = renderCachedReport(report,'markdown');
  assert.match(markdown,/操作状态：failed/);
  assert.match(markdown,/购物车行数=10/);
  assert.match(markdown,/collection\.requested\\_limit\\_reached/);
  const csv = parseCsv(renderCachedReport(report,'csv')), headers = csv.shift();
  const observation = csv.find(row => row[headers.indexOf('record_type')] === 'observation');
  assert.equal(observation[headers.indexOf('requested_rows')],'10');
  assert.ok(csv.some(row => row[headers.indexOf('record_type')] === 'collection_coverage'));
});

test('array truncation observations survive export without upgrading partial scope', () => {
  const cart = cartSnapshot(1); cart.rows[0].price_region_observations.truncated = true;
  const cartReport = buildCachedReport(task('cart_snapshot',[{status:'succeeded',result:cart}]));
  assert.deepEqual(cartReport.records.filter(record => record.record_type === 'field_coverage').map(row => [row.label,row.text]),
    [['price_region_observations.truncated','true']]);
  const order = orderSnapshot(), item = order.orders[0].items[0];
  item.item_information.truncated = true; item.price_observations.truncated = true; order.orders[0].payment_observations.truncated = true;
  const report = buildCachedReport(task('order_snapshot',[{status:'succeeded',result:order}]));
  const coverage = report.records.filter(row => row.record_type === 'field_coverage');
  assert.deepEqual(coverage.map(row => [row.label,row.text]),
    [['payment_observations.truncated','true'],['item_information.truncated','true'],['price_observations.truncated','true']]);
  assert.equal(report.observations[0].coverage.full_order_history,false);
  assert.match(renderCachedReport(report,'markdown'),/item\\_information\.truncated/);
  assert.ok(parseCsv(renderCachedReport(report,'csv')).some(row => row.includes('item_information.truncated') && row.includes('true')));
});

test('Markdown escapes HTML, table separators, newlines and active link syntax', () => {
  const snapshot = cartSnapshot(1); snapshot.rows[0].title = '<script>alert(1)</script>|\n[click](javascript:bad)';
  const markdown = renderCachedReport(buildCachedReport(task('cart_snapshot',[{status:'succeeded',result:snapshot}])), 'markdown');
  assert.equal(markdown.includes('<script>'),false);
  assert.equal(markdown.includes('[click](javascript:bad)'),false);
  assert.match(markdown,/&lt;script&gt;/);
  assert.match(markdown,/\\\|/);
  assert.match(markdown,/未验证/);
  assert.match(markdown,/partial/);
  assert.equal(markdown.includes('DO_NOT_EXPORT'),false);
});

test('report projection owns its arrays and nested metadata without mutating source evidence', () => {
  const snapshot = productSnapshot(), input = task('product_details',[{status:'succeeded',result:snapshot}]);
  const before = JSON.stringify(input), report = buildCachedReport(input);
  report.observations[0].missing.push('caller_note');
  report.observations[0].coverage.status = 'caller_changed';
  report.records[0].title = 'caller_changed';
  assert.equal(JSON.stringify(input),before);
});

function searchPage(observedAt, label) {
  return {search:{observed_at:observedAt, url:'https://s.taobao.com/search?q=mouse', source:'loaded_search_cards', cards_seen:46, cards_scanned:25,
    duplicates_omitted:0, unsupported_cards_omitted:1, items:[{position:2, product_id:'537601894090', title:'Mouse', url:'https://detail.tmall.com/item.htm?id=537601894090',
      shop:'Mouse shop', sales_text:'1000+人收货', price:{raw:'¥ 89 优惠后', label:'优惠后'}}], missing:['subsequent_pages']},
    pagination:{current_page:1, total_pages_displayed:11, next_disabled:false, previous_disabled:true, selected_sort_label:label}};
}

test('a sales-sort report keeps the marked tab before and after the click and only the sorted cards', () => {
  const result = {schema_version:1, source:'bounded_search_sort', requested_sort:'sales', before:searchPage(times[0], '综合'), after:searchPage(times[1], '销量'),
    coverage:{status:'partial', sort_ui_verified:true, sort_verified:false, filters_verified:false, total_results_known:false},
    missing:['verified_sort_algorithm', 'unscanned_cards']};
  const report = buildCachedReport(task('search_sort',[{status:'succeeded',result}]));
  assert.equal(report.observations[0].observed_at,times[1]);
  assert.equal(report.observations[0].coverage.sort_ui_verified,true);
  assert.deepEqual(report.observations[0].missing,['verified_sort_algorithm', 'unscanned_cards']);
  const condition = report.records.find(row => row.record_type === 'sort_condition');
  assert.deepEqual([condition.text,condition.qualifier],['sales','marked_before=综合; marked_after=销量']);
  assert.equal(report.records.filter(row => row.record_type === 'search_item').length,1);
  assert.match(report.records.find(row => row.record_type === 'search_pagination').text,/selected_sort_label=销量/);
  // Earlier kinds keep the shared coverage list, so the same key is not projected for a plain search.
  const search = buildCachedReport(task('search',[{status:'succeeded',result:{...result.after.search, coverage:result.coverage}}]));
  assert.equal(Object.hasOwn(search.observations[0].coverage,'sort_ui_verified'),false);
});

test('gallery and main-image reports keep each link, its load state and each sample time', () => {
  const gallery = {schema_version:1, product_id:'537601894090', url:'https://detail.tmall.com/item.htm?id=537601894090', observed_at:times[0],
    source:'loaded_gallery_thumbnail_dom', gallery:{observed:true, elements_seen:3, elements_scanned:3, duplicates_omitted:1, unsupported_urls_omitted:0,
      items:[{position:1, url:'https://img.alicdn.com/a.jpg', loaded:true, width:800, height:800, source:'gallery_thumbnail'},
        {position:3, url:'https://img.alicdn.com/b.jpg', loaded:false, width:0, height:0, source:'gallery_thumbnail'}]},
    coverage:{status:'partial', full_gallery:false, video_read:false}, missing:[]};
  const galleryReport = buildCachedReport(task('product_gallery',[{status:'succeeded',result:gallery}]));
  assert.deepEqual(galleryReport.records.filter(row => row.record_type === 'image_scan').map(row => [row.label,row.text]),
    [['elements_seen','3'],['elements_scanned','3'],['duplicates_omitted','1'],['unsupported_urls_omitted','0']]);
  assert.deepEqual(galleryReport.records.filter(row => row.record_type === 'image_link').map(row => [row.item_position,row.loaded]),[[1,true],[3,false]]);
  assert.equal(galleryReport.observations[0].coverage.full_gallery,false);
  const sample = (observedAt, name) => ({thumbnail_url:`https://img.alicdn.com/${name}_q50.jpg`, observed_at:observedAt, source:'mainPic_within_unique_mainPicWrap',
    image:{url:`https://img.alicdn.com/${name}.jpg`, loaded:true, width:800, height:750}, association:{selected_marker_verified:true, two_matching_observations:true}});
  const main = {schema_version:2, product_id:'537601894090', url:gallery.url, source:'loaded_main_image_dom', samples:[sample(times[0],'one'), sample(times[1],'two')],
    coverage:{status:'partial', requested_images:2, returned_images:2, full_gallery:false}};
  const mainReport = buildCachedReport(task('product_main_images',[{status:'succeeded',result:main}]));
  assert.deepEqual(mainReport.observations.map(row => [row.batch_position,row.observed_at,row.collection_coverage.returned_images]),[[1,times[0],2],[2,times[1],2]]);
  const images = mainReport.records.filter(row => row.record_type === 'main_image');
  assert.deepEqual(images.map(row => [row.item_position,row.url]),[[1,'https://img.alicdn.com/one.jpg'],[2,'https://img.alicdn.com/two.jpg']]);
  assert.match(images[0].qualifier,/^thumbnail=https:\/\/img\.alicdn\.com\/one_q50\.jpg; size=800x750; selected_marker_verified=true/);
});

test('a specification-image report lists every option, the time its link was read and why others have none', () => {
  const option = (position, label, image, status, observations) => ({group_position:1, position, group:'颜色', label, image_regions_seen:image ? 1 : 0, attempts:observations.length,
    image_status:status, image, association:{option_binding_verified:Boolean(image)}, observations});
  const blue = {url:'https://img.alicdn.com/blue.jpg', loaded:true, width:400, height:400, status:'observed'};
  const tiny = {url:'https://img.alicdn.com/red.jpg', loaded:true, width:1, height:1, status:'observed'};
  const result = {schema_version:3, product_id:'1040479270864', url:'https://item.taobao.com/item.htm?id=1040479270864', source:'bounded_specification_collection',
    inventory_observed_at:times[0], options:[
      option(1, '蓝', blue, 'loaded_image_link', [{read:2, observed_at:times[0], image:{...tiny}}, {read:3, observed_at:times[1], image:{...blue}}]),
      option(2, '均码', null, 'no_supported_image_container', [])],
    collection:{stop_reason:'scanned_image_options_obtained'}, coverage:{status:'partial', options_returned:2, full_sku_matrix:false}};
  const report = buildCachedReport(task('product_specification_images',[{status:'succeeded',result}]));
  assert.equal(report.observations[0].observed_at,times[0]);
  assert.deepEqual([report.observations[0].coverage.options_returned,report.observations[0].coverage.full_sku_matrix],[2,false]);
  const rows = report.records.filter(row => row.record_type === 'specification_image');
  assert.deepEqual(rows.map(row => [row.group_name,row.item_position,row.label,row.url,row.observed_at]),
    [['颜色',1,'蓝','https://img.alicdn.com/blue.jpg',times[1]],['颜色',2,'均码',null,times[0]]]);
  assert.equal(rows[1].qualifier,'image_status=no_supported_image_container; attempts=0');
  assert.equal(report.records.find(row => row.record_type === 'specification_collection').text,'scanned_image_options_obtained');
});

test('a review-category report gives each category its own observation with its tabs, reviews, follow-ups and replies', () => {
  const reviews = (observedAt, bodies) => ({product_id:'1069125756045', url:'https://item.taobao.com/item.htm?id=1069125756045', source:'loaded_review_drawer',
    schema_version:4, observed_at:observedAt, total_text:'用户评价·25', loaded_count:bodies.length, returned_count:bodies.length, omitted_count:0,
    reviews:bodies.map((body, index) => ({observation_index:index + 1, body, purchase_text:'2026年9月6日已购：银色', text_may_be_truncated:true,
      seller_replies:index === 0 ? [{raw:'商家回复：谢谢', body:'谢谢', text_may_be_truncated:true}] : [],
      followups:index === 0 ? [{raw:'2天后追评：还行', interval_text:'2天后追评：', body:'还行', text_may_be_truncated:true, seller_replies:[]}] : []})),
    coverage:{status:'partial', scope:'currently_loaded_drawer', sort_verified:false, filters_verified:false, full_list:false}, missing:['stable_review_ids']});
  const sample = (category, observedAt, bodies) => ({category, reviews:reviews(observedAt, bodies), sort_text:'默认排序',
    category_catalogue:[{position:1, label:'全部', count_text:'', selected:category === '全部', disabled:false},
      {position:2, label:'追评', count_text:'2', selected:category === '追评', disabled:false}],
    association:{category_ui_verified:true, content_changed_after_switch:category !== '全部'}});
  const result = {schema_version:1, product_id:'1069125756045', source:'bounded_review_category_text', samples:[sample('全部', times[0], ['好', '一般']), sample('追评', times[1], ['好'])],
    coverage:{status:'partial', order:'page_display_order', all_categories_read:false, unique_review_count:null, media_read:false}};
  const report = buildCachedReport(task('product_review_categories',[{status:'succeeded',result}]));
  assert.deepEqual(report.observations.map(row => [row.batch_position,row.observed_at,row.coverage.full_list,row.collection_coverage.all_categories_read]),
    [[1,times[0],false,false],[2,times[1],false,false]]);
  assert.deepEqual(report.observations[0].missing,['stable_review_ids']);
  const first = report.records.filter(row => row.observation_position === 1);
  assert.deepEqual(first.filter(row => row.record_type === 'review').map(row => [row.item_position,row.label,row.text,row.group_name]),
    [[1,'2026年9月6日已购：银色','好','全部'],[2,'2026年9月6日已购：银色','一般','全部']]);
  assert.deepEqual(first.filter(row => row.record_type === 'review_followup').map(row => [row.item_position,row.label,row.text]),[[1,'2天后追评：','还行']]);
  assert.deepEqual(first.filter(row => row.record_type === 'review_seller_reply').map(row => [row.label,row.text]),[['review','谢谢']]);
  assert.deepEqual(first.filter(row => row.record_type === 'review_category_option').map(row => [row.label,row.text,row.selected]),[['全部','',true],['追评','2',false]]);
  assert.match(report.records.find(row => row.record_type === 'review_category' && row.group_name === '追评').qualifier,/content_changed_after_switch=true/);
});

test('an order entry report names its list source and keeps an error page heading without reading order fields', () => {
  const source = {task:'orders-list', position:2, list_url:'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm', order_id:'1000000000000000001', observed_at:times[0]};
  const page = {schema_version:1, order_id:source.order_id, url:'https://buyertrade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=1000000000000000001',
    route_order_binding_verified:true, observed_at:times[1], page_state:'error', error_roots_seen:1,
    error_page:{source:'visible_trade_error_panel', title_region:region('页面不存在'), subtitle_region:region('请稍后再试'), source_relationship_verified:true, cause_verified:false},
    order_fields_read:false};
  const result = {schema_version:1, scope:'single_order_navigation_and_page_state', source, target:{order_id:source.order_id, url:page.url}, outcome:'page_unavailable',
    opening:{method:'extension_mouse_click', action_outcome:'acknowledged', action_error:null, navigation_verified:true}, page,
    coverage:{normal_detail_fields_read:false, account_identity_verified:false, settlement_verified:false, contact_fields_read:false, local_only:true}};
  const report = buildCachedReport(task('order_detail_check',[{status:'succeeded',source,result}]));
  assert.deepEqual([report.observations[0].observed_at,report.observations[0].source,report.observations[0].coverage.contact_fields_read],
    [times[1],'single_order_navigation_and_page_state',false]);
  assert.deepEqual(report.observations[0].provenance,[{kind:'order_list', source_task:'orders-list', observed_at:times[0], order_position:2,
    order_id:source.order_id, url:source.list_url}]);
  const entry = report.records.find(row => row.record_type === 'order_entry');
  assert.deepEqual([entry.order_id,entry.label],[source.order_id,'page_unavailable']);
  assert.match(entry.qualifier,/route_order_binding_verified=true; page_state=error$/);
  assert.deepEqual(report.records.filter(row => row.record_type === 'order_error_page').map(row => [row.label,row.text]),[['title','页面不存在'],['subtitle','请稍后再试']]);
  const csv = parseCsv(renderCachedReport(report,'csv')), headers = csv.shift();
  assert.ok(csv.some(row => row[headers.indexOf('record_type')] === 'provenance' && row[headers.indexOf('provenance_order_id')] === `'${source.order_id}`));
});
