import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { searchTarget, searchPageTarget, parseSearchPageUrl, validateSearch, validateSavedSearch } from '../lib/search.mjs';
import { searchRangeTarget, parseSearchRangeUrl, searchCollectionScript, validateSearchCollectionPage, validateSearchCollectionSnapshot } from '../lib/search-page-range.mjs';
import { BrowserBridge } from '../lib/bridge.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';
import { playwrightStatus, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

const root = searchTarget('Synthetic books');
function rawPage(page = 1, total = 5) {
  return {...rawSearch(searchRangeTarget(root.query,page)), pagination:{current_page:page,total_pages_displayed:total,
    next_disabled:page === total,previous_disabled:page === 1,selected_sort_label:'综合'}};
}
const snapshot = (page = 1, total = 5) => validateSearchCollectionPage(rawPage(page,total),root,[page]).page;
function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key,item]) => [key,reordered(item)])) : value;
}
function matches(node, selector) {
  const prefix = selector.match(/\[class(?:\^|\*)=" ?([^" ]+)--"\]/)?.[1];
  if (prefix) return node.className.split(/\s+/).some(name => name.startsWith(prefix + '--'));
  const typedClass = selector.match(/^(?:([a-z]+))?\.([a-zA-Z0-9-]+)$/);
  if (typedClass) return (!typedClass[1] || node.tagName === typedClass[1].toUpperCase()) && node.className.split(/\s+/).includes(typedClass[2]);
  const attributes = [...selector.matchAll(/\[([a-z-]+)="([^"]*)"\]/g)];
  if (attributes.length) {
    const tag = selector.match(/^([a-z]+)/)?.[1];
    return (!tag || node.tagName === tag.toUpperCase()) && attributes.every(match => node.getAttribute(match[1]) === match[2]);
  }
  return selector.toUpperCase() === node.tagName;
}
function node(className = '', text = '', children = [], fields = {}) {
  return {tagName:'DIV',className,innerText:text,disabled:false,...fields,
    getAttribute(name) {return name === 'class' ? className : fields.attributes?.[name] ?? null;},
    getClientRects() {return [{}];},
    querySelectorAll(query) {
      return children.flatMap(child => [child,...child.querySelectorAll('*')]).filter(child => query === '*' || query.split(',').some(part => matches(child,part.trim())));
    }};
}
function context(page = 1, {total = 5, cards = 3, displayPage = page, nextDisabled = displayPage === total, query = root.query, gate = false,
  loginLink = null, title = `${query} 搜索`} = {}) {
  let clicks = 0;
  const items = Array.from({length:cards},(_, index) => node('doubleCardWrapperAdapt--fixture','',[
    node('title--fixture',`Item ${index}`),node('shopNameText--fixture','Shop'),node('realSales--fixture','销量'),
    node('priceWrapper--fixture','¥10',[node('priceInt--fixture','10'),node('priceFloat--fixture',''),node('priceDesc--fixture','展示价')]),
  ],{tagName:'A',href:`https://item.taobao.com/item.htm?id=${100 + index}`}));
  const next = node('next-next','下一页',[],{tagName:'BUTTON',disabled:nextDisabled,click() {clicks++;}});
  const pagination = node('next-pagination','',[
    node('next-pagination-display',`${displayPage}/${total}`),next,
    node('next-prev','上一页',[],{tagName:'BUTTON',disabled:displayPage === 1}),node('next-current',String(displayPage),[],{tagName:'BUTTON'}),
  ]);
  const sort = node('sortBarWrapper--fixture','',[node('','综合',[],{tagName:'BUTTON',attributes:{role:'tab','aria-selected':'true'}})]);
  const input = node('','',[],{tagName:'INPUT',attributes:{name:'q'},value:query});
  const dialog = gate ? [node('login-dialog','请登录',[],{attributes:{role:'dialog'}})] : [];
  const nav = loginLink ? [node('site-nav-login',loginLink.text,[],{tagName:'A',attributes:{href:loginLink.href}})] : [];
  const document = node('','',[...nav,...items,pagination,sort,input,...dialog]);
  Object.assign(document,{readyState:'complete',title});
  return {value:{URL,location:{href:searchRangeTarget(query,page).url},document,getComputedStyle:() => ({display:'block',visibility:'visible'})},
    items,pagination,next,clicks:() => clicks};
}

test('new bounded range parser supports pages one through five while legacy APIs stop at two', () => {
  for (let page = 1; page <= 5; page++) {
    const target = searchRangeTarget(' 图书 ',page);
    assert.equal(target.query,'图书'); assert.equal(target.page,page);
    assert.deepEqual(parseSearchRangeUrl(target.url + '&spm=PRIVATE'),target);
    assert.equal(parseSearchPageUrl(target.url)?.page ?? null,page <= 2 ? page : null);
  }
  for (const page of [0,6,1.5,'3',NaN,Infinity]) assert.throws(() => searchRangeTarget(root.query,page),{code:'INVALID_SEARCH'});
  assert.throws(() => searchPageTarget(root.query,3),{code:'INVALID_SEARCH'});
});

test('range URLs reject sorting, filters, ambiguous or noncanonical query/page identities', () => {
  const url = searchRangeTarget(root.query,3).url;
  for (const value of [url + '&sort=sales',url + '&filter=price',url + '&page=2',url + '&q=other',url + '#fragment',
    url.replace('page=3','page=03'),url.replace('page=3','page=6'),url.replace('tab=all','tab=mall'),
    url.replace('https://','http://'),url.replace('s.taobao.com','user@s.taobao.com'),url.replace('s.taobao.com','s.taobao.com.evil'),
    url.replace('Synthetic%20books','%20Synthetic%20books%20'),null,{},'x'.repeat(16385)]) assert.equal(parseSearchRangeUrl(value),null);
});

test('range normalization accepts only explicit range mode, caps each page at its card limit and rejects sort mode', () => {
  const target = searchRangeTarget(root.query,3), raw = rawPage(3);
  assert.throws(() => validateSearch(raw,target),{code:'INVALID_SEARCH'});
  const result = validateSearch(raw,target,{allowPageRange:true}).result;
  assert.equal(result.page,3); assert.equal(result.limits.cards,25);
  validateSavedSearch(result,target,{allowPageRange:true});
  assert.equal(validateSearch(raw,target,{allowPageRange:true,cardLimit:50}).result.limits.cards,50);
  for (const options of [{allowPageRange:true,cardLimit:26},{allowPageRange:true,allowSort:true}]) {
    assert.throws(() => validateSearch(raw,target,options),{code:'INVALID_SEARCH'});
  }
  const excessive = rawPage(3); excessive.cards_seen = 26; excessive.items = Array.from({length:26},() => raw.items[0]);
  assert.throws(() => validateSearchCollectionPage(excessive,root,[3],{cardLimit:25}),{code:'INVALID_RESPONSE'});
  assert.equal(validateSearchCollectionPage(excessive,root,[3]).page.search.cards_scanned,26);
  excessive.cards_seen = 51; excessive.items = Array.from({length:51},() => raw.items[0]);
  assert.throws(() => validateSearchCollectionPage(excessive,root,[3]),{code:'INVALID_RESPONSE'});
  assert.throws(() => validateSearchCollectionPage(raw,root,[3],{cardLimit:40}),{code:'INVALID_SEARCH'});
});

test('collection pagination requires disabled-next exactly at the displayed final page', () => {
  for (const [page,total,nextDisabled] of [[2,5,true],[5,5,false]]) {
    const raw = rawPage(page,total); raw.pagination.next_disabled = nextDisabled;
    assert.throws(() => validateSearchCollectionPage(raw,root,[page]),{code:'PAGE_STRUCTURE_CHANGED'});
  }
  const raw = rawPage(3), result = validateSearchCollectionPage(reordered(raw),root,[3]);
  assert.equal(result.state,'observed'); assert.equal(result.page.search.page,3);
  assert.equal(result.page.search.coverage.sort_verified,false);
  assert.equal(validateSearchCollectionSnapshot(result.page,root,3,50),result.page);
  assert.throws(() => validateSearchCollectionSnapshot(result.page,root,3,25),{code:'INVALID_CHECKPOINT'});
  assert.deepEqual(validateSearchCollectionPage({state:'page_transition'},root,[2,3]),{state:'page_transition'});
  assert.throws(() => validateSearchCollectionPage({...raw,pagination:{...raw.pagination,account:'PRIVATE'}},root,[3]),{code:'PAGE_STRUCTURE_CHANGED'});
});

test('allowed-page sets and canonical query identities fail closed before content can be accepted', () => {
  for (const allowedPages of [[],[0],[6],[1,1],['1'],null,[1,2,3,4,5,1]]) {
    assert.throws(() => searchCollectionScript(root,{allowedPages}),{code:'INVALID_SEARCH'});
    assert.throws(() => validateSearchCollectionPage(rawPage(),root,allowedPages),{code:'INVALID_SEARCH'});
  }
  assert.throws(() => validateSearchCollectionPage(rawPage(3),root,[1,2]),{code:'INVALID_RESPONSE'});
  assert.throws(() => validateSearchCollectionPage(rawPage(3),searchTarget('other'),[3]),{code:'INVALID_RESPONSE'});
  for (const [state,code] of [['login_required','LOGIN_REQUIRED'],['verification_required','VERIFICATION_REQUIRED'],['rate_limited','RATE_LIMITED']]) {
    assert.throws(() => validateSearchCollectionPage({state},root,[1]),{code});
  }
});

test('cached range pages preserve original time and reject invented completeness, counters or page changes', () => {
  const page = snapshot(3), before = JSON.stringify(page);
  assert.equal(validateSearchCollectionSnapshot(page,root,3,50),page);
  assert.equal(JSON.stringify(page),before);
  for (const change of [value => value.search.page = 4,value => value.search.observed_at = 'invalid',value => value.search.coverage.total_results_known = true,
    value => value.search.cards_scanned++,value => value.pagination.next_disabled = true,value => value.private = 'PRIVATE',
    value => value.search.items[0].product_id = '999',value => value.search.limits.cards = 25]) {
    const altered = structuredClone(page); change(altered);
    assert.throws(() => validateSearchCollectionSnapshot(altered,root,3,50),{code:'INVALID_CHECKPOINT'});
  }
});

test('serialized range read is bounded, read-only and rejects unrelated locations before DOM access', () => {
  const script = searchCollectionScript(root,{allowedPages:[3]});
  const f = context(3,{cards:29}), raw = vm.runInNewContext(script,f.value);
  assert.equal(raw.state,'observed'); assert.equal(raw.items.length,29); assert.equal(raw.cards_seen,29);
  const legacy = vm.runInNewContext(searchCollectionScript(root,{allowedPages:[3],cardLimit:25}),context(3,{cards:29}).value);
  assert.equal(legacy.items.length,25); assert.equal(legacy.cards_seen,29);
  assert.throws(() => searchCollectionScript(root,{allowedPages:[3],cardLimit:30}),{code:'INVALID_SEARCH'});
  assert.equal(raw.pagination.current_page,3); assert.equal(f.clicks(),0);
  const forbidden = new Proxy({}, {get() {throw Error('Unrelated DOM must not be read');}});
  for (const url of [searchRangeTarget(root.query,2).url,'https://example.test/','https://www.taobao.com/',root.url + '&sort=sales']) {
    const value = vm.runInNewContext(script,{URL,location:{href:url},document:forbidden});
    assert.equal(value.state,'target_changed');
  }
  const gated = context(3,{gate:true});
  assert.equal(vm.runInNewContext(script,gated.value).state,'login_required');
});

test('serialized guard clicks only the checkpointed page with identical card positions and pagination', () => {
  const f = context(3), before = validateSearchCollectionPage(vm.runInNewContext(searchCollectionScript(root,{allowedPages:[3]}),f.value),root,[3]).page;
  const script = searchCollectionScript(root,{allowedPages:[3],before});
  assert.equal(vm.runInNewContext(script,f.value).state,'action_dispatched'); assert.equal(f.clicks(),1);
  const changed = context(3); changed.items[0].href = changed.items[1].href;
  assert.equal(vm.runInNewContext(script,changed.value).state,'target_changed'); assert.equal(changed.clicks(),0);
  const paginationChanged = context(3,{total:6});
  assert.equal(vm.runInNewContext(script,paginationChanged.value).state,'target_changed'); assert.equal(paginationChanged.clicks(),0);
  assert.throws(() => searchCollectionScript(root,{allowedPages:[3,4],before}),{code:'INVALID_SEARCH'});
  assert.throws(() => searchCollectionScript(root,{allowedPages:[5],before:snapshot(5,8)}),{code:'UNSUPPORTED_CAPABILITY'});
  assert.throws(() => searchCollectionScript(root,{allowedPages:[3],before:snapshot(3,3)}),{code:'UNSUPPORTED_CAPABILITY'});
});

test('serialized read reports an in-progress page display without clicking or treating it as final data', () => {
  const f = context(3,{displayPage:2});
  const raw = vm.runInNewContext(searchCollectionScript(root,{allowedPages:[2,3]}),f.value);
  assert.equal(raw.state,'page_transition');
  assert.deepEqual(validateSearchCollectionPage(raw,root,[2,3]),{state:'page_transition'});
  const action = vm.runInNewContext(searchCollectionScript(root,{allowedPages:[3],before:snapshot(3)}),f.value);
  assert.equal(action.state,'structure_changed');
  assert.equal(f.clicks(),0);
});

test('serialized collection rejects prematurely disabled next controls and does not click gated content', () => {
  const f = context(2,{nextDisabled:true});
  const raw = vm.runInNewContext(searchCollectionScript(root,{allowedPages:[2]}),f.value);
  assert.equal(raw.state,'structure_changed'); assert.equal(f.clicks(),0);
  const gate = context(2,{gate:true});
  const action = vm.runInNewContext(searchCollectionScript(root,{allowedPages:[2],before:snapshot(2)}),gate.value);
  assert.equal(action.state,'login_required'); assert.equal(gate.clicks(),0);
});

test('a logged-out search page with no result cards pauses for login instead of reporting a layout change', () => {
  const script = searchCollectionScript(root,{allowedPages:[1]});
  const siteLogin = {href:'//login.taobao.com/member/login.jhtml?f=top',text:'亲，请登录'};
  // The live logged-out page (2026-10-12) had an empty title and no cards, so the gate must run before the title check.
  for (const title of ['',`${root.query} 搜索`]) {
    const loggedOut = context(1,{cards:0,loginLink:siteLogin,title});
    const raw = vm.runInNewContext(script,loggedOut.value);
    assert.equal(raw.state,'login_required'); assert.equal(loggedOut.clicks(),0);
    assert.throws(() => validateSearchCollectionPage(raw,root,[1]),{code:'LOGIN_REQUIRED'});
  }
  assert.equal(vm.runInNewContext(script,context(1,{cards:0}).value).state,'structure_changed');
  assert.equal(vm.runInNewContext(script,context(1,{cards:3,loginLink:siteLogin}).value).state,'observed');
  for (const loginLink of [{href:'https://example.test/member/login.jhtml',text:'亲，请登录'},{href:siteLogin.href,text:'登录页'}]) {
    assert.equal(vm.runInNewContext(script,context(1,{cards:0,loginLink}).value).state,'structure_changed');
  }
});

test('range script query input remains serialized data rather than executable source', () => {
  const query = `books');globalThis.COMPROMISED=true;//`, target = searchTarget(query), f = context(3,{query});
  assert.equal(vm.runInNewContext(searchCollectionScript(target,{allowedPages:[3]}),f.value).state,'observed');
  assert.equal(f.value.COMPROMISED,undefined);
});

test('bridge range reads and actions use the fixed saved tab and never broaden the allowed page', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  server.state.tabs = [{id:41,url:searchRangeTarget(root.query,3).url}]; server.state.metadata = rawPage(3);
  assert.equal((await bridge.readSearchCollectionPage(41,root,[3])).page.search.page,3);
  const reads = server.state.commands.filter(command => command.action === 'eval');
  assert.equal(reads.length,1); assert.equal(reads[0].tabId,41);
  const before = snapshot(3); server.state.metadata = {state:'action_dispatched',clicked:true};
  assert.deepEqual(await bridge.nextSearchCollectionPage(41,root,before),{clicked:true});
  const count = server.state.commands.filter(command => command.action === 'eval').length;
  server.state.tabs[0].url = searchRangeTarget(root.query,4).url;
  await assert.rejects(bridge.nextSearchCollectionPage(41,root,before),error => error.code === 'TARGET_CHANGED' && error.actionNotDispatched === true);
  assert.equal(server.state.commands.filter(command => command.action === 'eval').length,count);
});

test('invalid action preparations fail without IO while dispatched transport errors stay uncertain', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  await assert.rejects(bridge.nextSearchCollectionPage(41,root,snapshot(5,8)),error => error.code === 'UNSUPPORTED_CAPABILITY' && error.actionNotDispatched === true);
  await assert.rejects(bridge.readSearchCollectionPage(0,root,[1]),{code:'INVALID_TAB'});
  assert.equal(server.state.requests.length,0);
  const lost = await mockBridge(t,{handler({req,res,body}) {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return res.end(JSON.stringify({id:body.id,success:true,data:{tabs:[{id:41,url:root.url}]}}));
    req.socket.destroy();
  }});
  await assert.rejects(new BrowserBridge(lost.endpoint).nextSearchCollectionPage(41,root,snapshot()),error => error.code === 'BRIDGE_UNAVAILABLE' && !error.actionNotDispatched);
});

test('bridge collection fails at missing or unrelated saved tabs before eval and preserves no-dispatch certainty', async t => {
  const server = await mockBridge(t), bridge = new BrowserBridge(server.endpoint);
  server.state.tabs = [{id:42,url:root.url}];
  await assert.rejects(bridge.readSearchCollectionPage(41,root,[1]),{code:'TARGET_MISSING'});
  await assert.rejects(bridge.nextSearchCollectionPage(41,root,snapshot()),error => error.code === 'TARGET_MISSING' && error.actionNotDispatched === true);
  server.state.tabs = [{id:41,url:searchRangeTarget('different query',1).url}];
  await assert.rejects(bridge.readSearchCollectionPage(41,root,[1]),{code:'TARGET_CHANGED'});
  await assert.rejects(bridge.nextSearchCollectionPage(41,root,snapshot()),error => error.code === 'TARGET_CHANGED' && error.actionNotDispatched === true);
  // Only the address probe for the unlisted saved tab may run; no page content is read.
  assert.equal(server.state.commands.filter(command => command.action === 'eval' && !isAddressProbe(command)).length,0);
  const requests = server.state.requests.length;
  await assert.rejects(bridge.readSearchCollectionPage(41,{...root,private:'PRIVATE'},[1]),{code:'INVALID_SEARCH'});
  await assert.rejects(bridge.nextSearchCollectionPage(0,root,snapshot()),error => error.code === 'INVALID_TAB' && error.actionNotDispatched === true);
  assert.equal(server.state.requests.length,requests);
});
