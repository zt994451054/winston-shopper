import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, runTask, taskStatus, rebindTask, endTask } from '../lib/tasks.mjs';
import { loadTask, withTaskStore, validateTask } from '../lib/task-store.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { main } from '../lib/cli.mjs';
import { validateOrderRows } from '../lib/order-rows.mjs';
import { parseOrderListUrl } from '../lib/order-target.mjs';
import { validateOrderDetailPage, validateSavedOrderDetailPage } from '../lib/order-detail-page.mjs';
import { orderDetailSource, runOrderDetailCheck } from '../lib/order-detail-check.mjs';
import { orderGroup, observeOrders, orderTarget } from '../test-support/order-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const list = parseOrderListUrl(orderTarget.url);
const fail = code => { throw new ShoppingError(code, 'PRIVATE external response'); };
function entry(target) {
  return {state:'entry_prepared',list_url:list.url,...target,position:2,loaded_groups_seen:7,
    selector:'.trade-main-content .trade-content-container > .trade-bought-list-order-container:nth-child(2) > .trade-bought-list-shop-info :is([class^="shopInfoOrderDetail--"], [class*=" shopInfoOrderDetail--"])',
    entry_text:'订单详情',target_attribute:'_blank'};
}
function page(target, error = false) {
  return validateOrderDetailPage({state:'observed',address:{state:'observed',...target},page_state:error?'error':'not_assessed',
    error_roots_seen:error?2:0,error_page:error?{title:{text:'页面出错了',truncated:false},subtitle:{text:'请检查网络',truncated:false}}:null},target);
}
async function fixture(t, changes = {}) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(),'shopping single order '));
  t.after(() => rm(stateDirectory,{recursive:true,force:true}));
  const calls = [], waits = [], tabs = [{id:41,url:list.url}];
  let time = Date.parse('2026-10-07T00:00:00Z');
  const snapshot = validateOrderRows(observeOrders(Array.from({length:7},(_,index)=>orderGroup(index+1).group)),list);
  const bridge = {endpoint:'http://127.0.0.1:19824',protocol:'playwright-extension',
    async requireConnected() {}, async listTabs() { return tabs; }, async readOrderRows() { return snapshot; }};
  await createTask({stateDirectory,task:'source',orders:true,tabId:41,bridge});
  await runTask({stateDirectory,task:'source',bridge});
  const sourceFile = path.join(stateDirectory,'tasks/source.json'), sourceBytes = await readFile(sourceFile);
  const target = orderDetailSource(await loadTask(stateDirectory,'source'),2).target;
  const options = {stateDirectory,task:'detail',orderDetail:true,sourceTask:'source',orderPosition:2,tabId:41,bridge};
  bridge.inspectOrderDetailEntry = async () => { calls.push('prepare'); const saved = await loadTask(stateDirectory,'detail');
    assert.ok(saved.operations[0].order_detail_check.reads_reserved>=1); return entry(target); };
  bridge.openOrderDetailEntry = async id => { calls.push('click'); const saved = await loadTask(stateDirectory,'detail'), state=saved.operations[0].order_detail_check;
    assert.ok(state.action_reserved); assert.ok(state.reads_reserved>=4); assert.equal(state.normal_wait_reserved_ms,5000);
    assert.equal(state.phase,'reconcile'); assert.ok(state.prior_tab_ids.includes(id));
    tabs.push({id:81,url:target.url}); return {clicked:true,navigation_verified:false}; };
  bridge.readOrderDetailPageState = async id => { calls.push('page'); assert.equal(id,81);
    const saved=await loadTask(stateDirectory,'detail'); assert.ok(saved.operations[0].order_detail_check.reads_reserved>=5); return page(target); };
  Object.assign(bridge,changes);
  await createTask(options);
  const clock = {now:()=>time,wait:async ms=>{waits.push(ms);time+=ms;}};
  return {options,bridge,tabs,calls,waits,clock,target,sourceFile,sourceBytes};
}
async function change(f, fn) { return withTaskStore(f.options.stateDirectory,'detail',async store=>{const task=await store.load();fn(task);await store.save(task);}); }

test('a gate on the confirmed detail page displays that page once after saving the original pause',async t=>{
  for(const code of ['LOGIN_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED']){
    const f=await fixture(t),seen=[];
    f.bridge.readOrderDetailPageState=()=>fail(code);
    f.bridge.showTab=async tabId=>{seen.push({tabId,saved:await loadTask(f.options.stateDirectory,'detail'),bytes:await readFile(path.join(f.options.stateDirectory,'tasks/detail.json'))});throw new Error('Synthetic display failure');};
    const paused=await runTask(f.options,f.clock);
    assert.equal(paused.operations[0].error.code,code);assert.equal(seen.length,1);assert.equal(seen[0].tabId,81);
    assert.equal(seen[0].saved.status,code==='RATE_LIMITED'?'waiting_cooldown':'waiting_user');
    assert.equal(seen[0].saved.operations[0].order_detail_check.detail_tab_id,81);
    assert.deepEqual(await readFile(path.join(f.options.stateDirectory,'tasks/detail.json')),seen[0].bytes);
    assert.equal(f.calls.filter(call=>call==='click').length,1);
  }
});

test('single-order creation uses saved provenance locally and does not read the browser or list again',async t=>{
  const f=await fixture(t),task=await loadTask(f.options.stateDirectory,'detail');
  assert.equal(task.kind,'order_detail_check');assert.equal(task.operations[0].source.position,2);
  assert.equal(task.operations[0].source.task,'source');assert.equal(task.operations[0].source.order_id,f.target.order_id);
  assert.deepEqual(f.calls,[]);assert.equal(task.operations[0].order_detail_check.read_limit,8);
  assert.equal(task.operations[0].order_detail_check.inventory_limit,6);
  assert.equal(Object.hasOwn(task.operations[0].source,'items'),false);
});
test('one native click is durably reserved; new page state is saved and completed calls only return its original cache',async t=>{
  const f=await fixture(t),report=await runTask(f.options,f.clock),op=report.operations[0];
  assert.equal(report.status,'complete');assert.deepEqual(f.calls,['prepare','click','page']);assert.deepEqual(f.waits,[5000]);
  assert.equal(op.order_detail_budget.reads_reserved,5);assert.equal(op.order_detail_budget.inventories_reserved,4);
  assert.equal(op.result.outcome,'normal_content_unassessed');assert.equal(op.result.opening.navigation_verified,true);
  assert.equal(op.result.coverage.normal_detail_fields_read,false);assert.equal(op.actions_reserved,1);
  const file=path.join(f.options.stateDirectory,'tasks/detail.json'),bytes=await readFile(file);
  f.bridge.requireConnected=()=>fail('EXTENSION_DISCONNECTED');
  assert.deepEqual(await runTask(f.options,f.clock),report);assert.deepEqual(await taskStatus(f.options),report);
  assert.deepEqual(await runTask({...f.options,nextBatch:true},f.clock),report);
  assert.deepEqual(await readFile(file),bytes);assert.deepEqual(await readFile(f.sourceFile),f.sourceBytes);
});
test('a visible error page completes only the bounded page check, retains unknown cause and reads no order body',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailPageState=async()=>page(f.target,true);
  const value=await runTask(f.options,f.clock),result=value.operations[0].result;
  assert.equal(value.status,'complete');assert.equal(result.outcome,'page_unavailable');
  assert.equal(result.page.error_page.cause_verified,false);assert.equal(result.page.printed_order_id_verified,false);
  assert.equal(result.page.order_fields_read,false);assert.equal(result.coverage.contact_fields_read,false);
});
test('single-order mode rejects other modes, missing tab and orphan source options before browser IO',async t=>{
  const f=await fixture(t);
  for(const addition of [{orders:true},{cart:true},{search:'query'},{bindings:['x']},{details:true},{orderRows:10},{cartRows:10},{pages:2},
    {sort:'sales'},{reviews:true},{plan:'missing'},{sourceTask:undefined},{orderPosition:0},{orderPosition:51},{orderPosition:2.2},{tabId:undefined}]) {
    await assert.rejects(createTask({...f.options,task:'bad',...addition}));
  }
  await assert.rejects(createTask({...f.options,task:'bad',orderDetail:false}),{code:'INVALID_ARGUMENTS'});
  assert.deepEqual(f.calls,[]);
});
test('an unfinished or unbound list position cannot be used as a normal detail source',async t=>{
  const f=await fixture(t),source=await loadTask(f.options.stateDirectory,'source');
  source.status='pending';assert.throws(()=>orderDetailSource(source,2),{code:'ORDER_DETAIL_SOURCE_UNVERIFIED'});
  source.status='complete';source.operations[0].result.orders[1].detail_entry.order_binding_verified=false;
  assert.throws(()=>orderDetailSource(source,2),{code:'ORDER_DETAIL_SOURCE_UNVERIFIED'});
  assert.throws(()=>orderDetailSource(source,6),{code:'ORDER_DETAIL_SOURCE_UNVERIFIED'});
});
test('an old same-order error tab is excluded and an unconfirmed opening pauses without repeating a click',async t=>{
  const f=await fixture(t);f.tabs.push({id:75,url:f.target.url});
  f.bridge.openOrderDetailEntry=async()=>{f.calls.push('click');return {clicked:true,navigation_verified:false};};
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'waiting_connection');
  assert.deepEqual(f.calls,['prepare','click']);assert.equal(value.operations[0].order_detail_budget.detail_tab_id,null);
  await assert.rejects(runTask(f.options,f.clock),{code:'RECOVERY_REQUIRED'});
  await assert.rejects(rebindTask({...f.options,tabId:75}),{code:'INVALID_RECOVERY'});
  const diagnostic=await diagnoseTask(f.options);assert.deepEqual(diagnostic.operations[0].matching_tab_ids,[]);
  f.tabs.push({id:81,url:f.target.url});
  assert.equal((await runTask({...f.options,recovery:'connection'},f.clock)).status,'complete');
  assert.deepEqual(f.calls,['prepare','click','page']);assert.deepEqual(f.waits,[5000,5000]);
});
test('multiple new matching detail pages stop without choosing one or reading either body',async t=>{
  const f=await fixture(t);f.bridge.openOrderDetailEntry=async()=>{f.tabs.push({id:81,url:f.target.url},{id:82,url:f.target.url});return {clicked:true,navigation_verified:false};};
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'stopped');assert.equal(value.operations[0].error.code,'ORDER_DETAIL_NAVIGATION_AMBIGUOUS');
  assert.deepEqual(f.calls,['prepare']);
});
test('a source tab navigating to the exact saved detail route is allowed but causality is not inferred',async t=>{
  const f=await fixture(t);f.bridge.openOrderDetailEntry=async()=>{f.tabs[0].url=f.target.url;return {clicked:true,navigation_verified:false};};
  f.bridge.readOrderDetailPageState=async id=>{assert.equal(id,41);return page(f.target);};
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'complete');assert.equal(value.operations[0].result.opening.opening_causality_verified,false);
});
test('an uncertain click response remains separate from confirmed new-page identity and is never redispatched',async t=>{
  const f=await fixture(t);f.bridge.openOrderDetailEntry=async()=>{f.calls.push('click');f.tabs.push({id:81,url:f.target.url});fail('BRIDGE_TIMEOUT');};
  const value=await runTask(f.options,f.clock),opening=value.operations[0].result.opening;
  assert.equal(value.status,'complete');assert.equal(opening.action_outcome,'uncertain');assert.equal(opening.action_error.code,'BRIDGE_TIMEOUT');
  assert.equal(opening.navigation_verified,true);assert.equal(value.automatic_retries,0);assert.deepEqual(f.calls,['prepare','click','page']);
  assert.equal(JSON.stringify(value).includes('PRIVATE'),false);
});
test('known preparation failure seals the reserved intent even if transient and never clicks on a rerun',async t=>{
  const f=await fixture(t);f.bridge.openOrderDetailEntry=async()=>{const error=new ShoppingError('BRIDGE_TIMEOUT','PRIVATE');error.actionNotDispatched=true;throw error;};
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'stopped');assert.equal(value.automatic_retries,0);
  assert.equal(value.operations[0].order_detail_budget.action_outcome,'not_dispatched');
  assert.deepEqual(await runTask(f.options,f.clock),value);assert.deepEqual(f.calls,['prepare']);
});
test('verification pauses and reserves one shared recovery plus five-second wait before any resumed page IO',async t=>{
  const f=await fixture(t);let count=0;const normal=f.bridge.inspectOrderDetailEntry;
  f.bridge.inspectOrderDetailEntry=()=>++count===1?fail('VERIFICATION_REQUIRED'):normal();
  assert.equal((await runTask(f.options,f.clock)).status,'waiting_user');
  await assert.rejects(runTask(f.options,f.clock),{code:'RECOVERY_REQUIRED'});
  const value=await runTask({...f.options,recovery:'user'},{...f.clock,wait:async ms=>{
    const saved=await loadTask(f.options.stateDirectory,'detail');assert.equal(saved.operations[0].order_detail_check.recoveries_reserved,1);return f.clock.wait(ms);
  }});
  assert.equal(value.status,'complete');assert.equal(value.wait_reserved_ms,10000);assert.deepEqual(f.waits,[5000,5000]);
  assert.equal(value.operations[0].order_detail_budget.failures[0].code,'VERIFICATION_REQUIRED');
});
test('two user/connection recoveries share a fixed limit; stopped tasks cannot acquire a fresh name',async t=>{
  const f=await fixture(t,{inspectOrderDetailEntry:()=>fail('LOGIN_REQUIRED')});
  await runTask(f.options,f.clock);await runTask({...f.options,recovery:'user'},f.clock);await runTask({...f.options,recovery:'user'},f.clock);
  const value=await runTask({...f.options,recovery:'user'},f.clock);assert.equal(value.status,'stopped');assert.equal(value.operations[0].error.code,'ORDER_DETAIL_RECOVERY_LIMIT');
  assert.equal(value.operations[0].order_detail_budget.recoveries_reserved,2);assert.deepEqual(f.waits,[5000,5000]);
  await assert.rejects(createTask({...f.options,task:'replacement'}),{code:'PLATFORM_TASK_UNFINISHED'});
});
test('only the original selected list tab is used; explicit rebind is permitted before intent and retains counters',async t=>{
  const f=await fixture(t);f.tabs[0].id=42;
  assert.equal((await runTask(f.options,f.clock)).status,'waiting_connection');assert.deepEqual(f.calls,[]);
  const before=await loadTask(f.options.stateDirectory,'detail');await rebindTask({...f.options,tabId:42});
  assert.deepEqual((await loadTask(f.options.stateDirectory,'detail')).operations[0].order_detail_check,before.operations[0].order_detail_check);
  assert.equal((await runTask({...f.options,recovery:'connection'},f.clock)).status,'complete');
});
test('an explicit user recovery timeout pauses again with no automatic retry',async t=>{
  const f=await fixture(t);let count=0;f.bridge.inspectOrderDetailEntry=()=>fail(++count===1?'LOGIN_REQUIRED':'BRIDGE_TIMEOUT');
  await runTask(f.options,f.clock);assert.equal((await runTask({...f.options,recovery:'user'},f.clock)).status,'waiting_user');assert.equal(count,2);
});
test('ordinary transient faults have two automatic retries with durable five/fifteen-second reservations',async t=>{
  const f=await fixture(t,{inspectOrderDetailEntry:()=>fail('BRIDGE_TIMEOUT')});
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'stopped');assert.equal(value.automatic_retries,2);
  assert.deepEqual(f.waits,[5000,15000]);assert.equal(value.wait_reserved_ms,20000);assert.equal(value.operations[0].order_detail_budget.failures.length,3);
});
test('read budget exhaustion stops before a guarded click group can exceed its saved eight reservations',async t=>{
  const f=await fixture(t);await change(f,task=>{task.operations[0].attempts=1;task.operations[0].order_detail_check.reads_reserved=7;});
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'stopped');assert.equal(value.operations[0].order_detail_budget.reads_reserved,8);
  assert.deepEqual(f.calls,['prepare']);assert.equal(value.operations[0].actions_reserved,0);
});
test('metadata budget exhaustion stops before requesting another inventory',async t=>{
  const f=await fixture(t);await change(f,task=>{task.operations[0].attempts=1;task.operations[0].order_detail_check.inventories_reserved=6;});
  let inventories=0;f.bridge.listTabs=()=>{inventories++;return f.tabs;};
  assert.equal((await runTask(f.options,f.clock)).status,'stopped');assert.equal(inventories,0);
});
test('saved login URL pauses without reading the login document or keeping its private query',async t=>{
  const f=await fixture(t);f.tabs[0].url='https://login.taobao.com/?account=PRIVATE';
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'waiting_user');assert.deepEqual(f.calls,[]);assert.equal(JSON.stringify(value).includes('PRIVATE'),false);
});
test('a known new-page ID is retained across page faults and no other matching tab can substitute for it',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailPageState=()=>fail('VERIFICATION_REQUIRED');
  assert.equal((await runTask(f.options,f.clock)).status,'waiting_user');
  f.tabs.splice(f.tabs.findIndex(tab=>tab.id===81),1,{id:82,url:f.target.url});
  assert.equal((await runTask({...f.options,recovery:'user'},f.clock)).status,'waiting_connection');
  assert.deepEqual((await diagnoseTask(f.options)).operations[0].matching_tab_ids,[]);assert.deepEqual(f.calls,['prepare','click']);
});
test('a killed process after persisted action intent resumes through metadata only and never repeats the click',async t=>{
  const f=await fixture(t);await assert.rejects(runTask(f.options,{...f.clock,wait:async()=>{throw Error('Host interrupted');}}));
  const saved=await loadTask(f.options.stateDirectory,'detail');assert.equal(saved.operations[0].order_detail_check.action_reserved,true);
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'complete');assert.equal(value.automatic_retries,1);
  assert.deepEqual(f.calls,['prepare','click','page']);assert.equal(value.operations[0].order_detail_budget.failures[0].code,'READ_INTERRUPTED');
});
test('a reserved recovery wait survives a host interruption without charging a second recovery',async t=>{
  const f=await fixture(t);let count=0;const normal=f.bridge.inspectOrderDetailEntry;
  f.bridge.inspectOrderDetailEntry=()=>++count===1?fail('LOGIN_REQUIRED'):normal();await runTask(f.options,f.clock);
  await assert.rejects(runTask({...f.options,recovery:'user'},{...f.clock,wait:async()=>{throw Error('Host interrupted');}}));
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'complete');assert.equal(value.operations[0].order_detail_budget.recoveries_reserved,1);
});
test('a malformed page adapter response stops without keeping private fields or inventing normal-content coverage',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailPageState=async()=>({...page(f.target),account:'PRIVATE'});
  const value=await runTask(f.options,f.clock);assert.equal(value.status,'stopped');assert.equal(value.operations[0].error.code,'INVALID_RESPONSE');
  assert.equal(value.operations[0].result,null);assert.equal(JSON.stringify(value).includes('PRIVATE'),false);
});
test('ending a paused task keeps its journal and cached provenance without browser access',async t=>{
  const f=await fixture(t,{inspectOrderDetailEntry:()=>fail('LOGIN_REQUIRED')});await runTask(f.options,f.clock);
  const before=await loadTask(f.options.stateDirectory,'detail');await endTask(f.options);
  assert.deepEqual((await loadTask(f.options.stateDirectory,'detail')).operations,before.operations);
  assert.equal((await runTask(f.options,f.clock)).status,'ended');await assert.rejects(runTask({...f.options,recovery:'user'},f.clock),{code:'INVALID_RECOVERY'});
});

const forgeries={
  'enlarged read budget':t=>{t.operations[0].order_detail_check.read_limit=9;},
  'enlarged inventory budget':t=>{t.operations[0].order_detail_check.inventory_limit=7;},
  'refunded normal wait':t=>{t.wait_reserved_ms=0;},
  'false printed-order proof':t=>{t.operations[0].result.page.printed_order_id_verified=true;},
  'false payment proof':t=>{t.operations[0].result.coverage.settlement_verified=true;},
  'extra contact data':t=>{t.operations[0].order_detail_check.page.address='PRIVATE';},
  'an old tab reused as the new result':t=>{t.operations[0].order_detail_check.prior_tab_ids.push(81);},
  'changed order identity':t=>{t.operations[0].source.order_id='999';},
  'missing action intent':t=>{t.operations[0].order_detail_check.action_reserved=false;},
  'guessed action acknowledgement':t=>{t.operations[0].order_detail_check.action_error={code:'BRIDGE_TIMEOUT',category:'transient'};},
  'a private top-level field':t=>{t.account='PRIVATE';},
};
for(const[name,mutate]of Object.entries(forgeries))test(`checkpoint rejects ${name} before cache or browser access`,async t=>{
  const f=await fixture(t);await runTask(f.options,f.clock);const task=await loadTask(f.options.stateDirectory,'detail');mutate(task);
  assert.throws(()=>validateTask(task),{code:'INVALID_CHECKPOINT'});
  await writeFile(path.join(f.options.stateDirectory,'tasks/detail.json'),JSON.stringify(task));
  await assert.rejects(taskStatus(f.options),{code:'INVALID_CHECKPOINT'});assert.deepEqual(f.calls,['prepare','click','page']);
});
test('saved error and unassessed page validation keeps the original timestamp and rejects added identity claims',async t=>{
  const f=await fixture(t);for(const error of [false,true]){const value=page(f.target,error);assert.equal(validateSavedOrderDetailPage(value,f.target),value);
    value.normal_detail_layout_verified=true;assert.throws(()=>validateSavedOrderDetailPage(value,f.target),{code:'INVALID_CHECKPOINT'});}
});
test('actual CLI uses local saved source and scoped eval/snapshot/native click; finished run/status return cache',async t=>{
  const f=await fixture(t), stateDirectory=await mkdtemp(path.join(os.tmpdir(),'shopping order cli '));
  t.after(()=>rm(stateDirectory,{recursive:true,force:true}));
  const server=await mockBridge(t,{handler:({req,res,body,state})=>{
    res.setHeader('Content-Type','application/json');if(req.url==='/status'){res.end(JSON.stringify(playwrightStatus()));return;}
    let data;
    if(body.action==='tab_list')data={tabs:state.tabs};
    else if(body.action==='snapshot')data={url:list.url,snapshotData:{refs:{e1:{role:'link',name:'订单详情',backendDOMNodeId:101}}}};
    else if(body.action==='click'){state.tabs.push({id:81,url:f.target.url});data={role:'link',name:'订单详情'};}
    else {assert.equal(body.action,'eval');data={result:body.script.includes('collectDetailPage')?{state:'observed',address:{state:'observed',...f.target},page_state:'not_assessed',error_roots_seen:0,error_page:null}:entry(f.target)};}
    res.end(JSON.stringify({id:body.id,success:true,data}));
  }});
  const source=await loadTask(f.options.stateDirectory,'source');source.endpoint=server.endpoint;
  await withTaskStore(stateDirectory,'source',store=>store.create(source));
  server.state.tabs=[{id:41,url:list.url}];const common=['--task','cli-detail','--state-dir',stateDirectory,'--endpoint',server.endpoint];
  const cli=async args=>{let text='';const code=await main(args,{write:v=>{text+=v;}});return {code,...JSON.parse(text)};};
  assert.equal((await cli(['task-start',...common,'--order-detail','--source-task','source','--order-position','2','--tab','41'])).status,'task_created');
  assert.equal(server.state.commands.length,0);const result=await cli(['task-run',...common]);assert.equal(result.status,'complete');
  assert.equal(server.state.commands.filter(c=>c.action==='click').length,1);assert.equal(server.state.commands.filter(c=>c.action==='eval').length,4);
  assert.equal(server.state.commands.filter(c=>c.action==='snapshot').length,1);
  assert.ok(server.state.commands.every(c=>['tab_list','eval','snapshot','click'].includes(c.action)));
  const before=server.state.commands.length;await cli(['task-run',...common]);await cli(['task-status','--task','cli-detail','--state-dir',stateDirectory]);
  assert.equal(server.state.commands.length,before);assert.equal(result.operations[0].result.coverage.normal_detail_fields_read,false);
});
test('a changed source observation cannot silently reassign the cached order identity',async t=>{
  const f=await fixture(t);const file=path.join(f.options.stateDirectory,'tasks/detail.json'),task=await loadTask(f.options.stateDirectory,'detail');
  task.operations[0].source.observed_at='2026-10-06T00:00:00Z';validateTask(task);
  await writeFile(file,JSON.stringify(task));await assert.rejects(taskStatus(f.options),{code:'INVALID_CHECKPOINT'});assert.deepEqual(f.calls,[]);
});
test('checkpoint failure before the click intent is committed prevents dispatch and cannot become a browser retry',async t=>{
  const f=await fixture(t),task=await loadTask(f.options.stateDirectory,'detail');let dispatched=0;
  const bridge={...f.bridge,inspectOrderDetailEntry:async()=>entry(f.target),openOrderDetailEntry:async()=>{dispatched++;}};
  await assert.rejects(runOrderDetailCheck({task,bridge,...f.clock,commit:async()=>{
    if(task.operations[0].order_detail_check.action_reserved)throw new ShoppingError('CHECKPOINT_WRITE_FAILED','Disk unavailable');
  }}),{code:'CHECKPOINT_WRITE_FAILED'});assert.equal(dispatched,0);assert.equal(task.retries,0);
});
test('cooldown allows one explicit probe and a subsequent transient fault stops without automatic retries',async t=>{
  const f=await fixture(t);let count=0;f.bridge.inspectOrderDetailEntry=()=>fail(++count===1?'RATE_LIMITED':'BRIDGE_TIMEOUT');
  assert.equal((await runTask(f.options,f.clock)).status,'waiting_cooldown');
  const value=await runTask({...f.options,recovery:'cooldown'},f.clock);assert.equal(value.status,'stopped');assert.equal(value.cooldown_probes,1);
  assert.equal(value.operations[0].automatic_retries,0);assert.deepEqual(f.waits,[5000]);
});
test('an unsupported entry keeps its fixed reason in the saved failure record',async t=>{
  const f=await fixture(t,{inspectOrderDetailEntry:async()=>{const error=new ShoppingError('UNSUPPORTED_CAPABILITY','synthetic');error.entryReason='outside_viewport';throw error;}});
  const value=await runTask(f.options,f.clock);
  assert.deepEqual(value.operations[0].order_detail_budget.failures,[{attempt:1,phase:'prepare',code:'UNSUPPORTED_CAPABILITY',category:'item',reason:'outside_viewport'}]);
  assert.equal((await loadTask(f.options.stateDirectory,'detail')).operations[0].order_detail_check.failures[0].reason,'outside_viewport');
  // The store refuses to write a failure record with an unknown reason.
  await assert.rejects(change(f,task=>{task.operations[0].order_detail_check.failures[0].reason='made up';}),{code:'INVALID_CHECKPOINT'});
});
