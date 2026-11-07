import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTask,runTask,taskStatus,rebindTask,endTask} from '../lib/tasks.mjs';
import {loadTask,withTaskStore,validateTask} from '../lib/task-store.mjs';
import {diagnoseTask} from '../lib/task-diagnostics.mjs';
import {ShoppingError} from '../lib/errors.mjs';
import {main} from '../lib/cli.mjs';
import {validateOrderRows} from '../lib/order-rows.mjs';
import {validateOrderDetailPage} from '../lib/order-detail-page.mjs';
import {validateOrderDetailBody} from '../lib/order-detail-body.mjs';
import {orderBodySource,runOrderBodyRead} from '../lib/order-body-read.mjs';
import {orderDetailSource,orderDetailCheckResult} from '../lib/order-detail-check.mjs';
import {orderGroup,observeOrders,orderTarget} from '../test-support/order-fixture.mjs';
import {observeDetail} from '../test-support/order-detail-fixture.mjs';
import { playwrightStatus,mockBridge} from '../test-support/mock-bridge.mjs';

const fail=code=>{throw new ShoppingError(code,'PRIVATE external text');};
async function fixture(t){
  const stateDirectory=await mkdtemp(path.join(os.tmpdir(),'shopping order body '));t.after(()=>rm(stateDirectory,{recursive:true,force:true}));
  const tabs=[{id:41,url:orderTarget.url}],calls=[],waits=[];let time=Date.parse('2026-10-08T00:00:00Z');
  const clock={now:()=>time,wait:async ms=>{waits.push(ms);time+=ms;}};
  const snapshot=validateOrderRows(observeOrders([orderGroup(1).group,orderGroup(2).group]),orderTarget);
  const bridge={endpoint:'http://127.0.0.1:19824',protocol:'playwright-extension',async requireConnected(){},async listTabs(){return tabs;},async readOrderRows(){return snapshot;}};
  await createTask({stateDirectory,task:'list',orders:true,tabId:41,bridge});await runTask({stateDirectory,task:'list',bridge},clock);
  const target=orderDetailSource(await loadTask(stateDirectory,'list'),2).target;
  const prepared={state:'entry_prepared',list_url:orderTarget.url,...target,position:2,loaded_groups_seen:2,
    selector:'.trade-main-content .trade-content-container > .trade-bought-list-order-container:nth-child(2) > .trade-bought-list-shop-info :is([class^="shopInfoOrderDetail--"], [class*=" shopInfoOrderDetail--"])',entry_text:'订单详情',target_attribute:'_blank'};
  bridge.inspectOrderDetailEntry=async()=>prepared;
  bridge.openOrderDetailEntry=async()=>{tabs.push({id:81,url:target.url});return {clicked:true,navigation_verified:false};};
  bridge.readOrderDetailPageState=async()=>validateOrderDetailPage({state:'observed',address:{state:'observed',...target},page_state:'not_assessed',error_roots_seen:0,error_page:null},target);
  await createTask({stateDirectory,task:'entry',orderDetail:true,sourceTask:'list',orderPosition:2,tabId:41,bridge});await runTask({stateDirectory,task:'entry',bridge},clock);
  const entryFile=path.join(stateDirectory,'tasks/entry.json'),entryBytes=await readFile(entryFile),listFile=path.join(stateDirectory,'tasks/list.json'),listBytes=await readFile(listFile);
  const body=validateOrderDetailBody(observeDetail({target,orderId:target.order_id,url:target.url}).raw,target);
  const options={stateDirectory,task:'body',orderBody:true,sourceTask:'entry',bridge};
  bridge.requireConnected=async()=>{calls.push('status');const task=await loadTask(stateDirectory,'body');assert.ok(task.operations[0].order_body_read.inventories_reserved>=1);};
  bridge.listTabs=async()=>{calls.push('tabs');return tabs;};
  bridge.readOrderDetailBody=async id=>{calls.push('body');assert.equal(id,81);const task=await loadTask(stateDirectory,'body');assert.ok(task.operations[0].order_body_read.reads_reserved>=1);return body;};
  await createTask(options);waits.length=0;
  return {options,clock,bridge,tabs,calls,waits,target,body,entryFile,entryBytes,listFile,listBytes};
}
async function change(f,fn){await withTaskStore(f.options.stateDirectory,'body',async store=>{const task=await store.load();fn(task);await store.save(task);});}
test('body pauses are saved before displaying their confirmed tab, and display failures leave the original state intact',async t=>{
  const f=await fixture(t),seen=[];
  f.bridge.readOrderDetailBody=()=>fail('VERIFICATION_REQUIRED');
  f.bridge.showTab=async tabId=>{seen.push({tabId,saved:await loadTask(f.options.stateDirectory,'body'),bytes:await readFile(path.join(f.options.stateDirectory,'tasks/body.json'))});throw new Error('Synthetic display failure');};
  const paused=await runTask(f.options,f.clock);
  assert.equal(paused.status,'waiting_user');assert.equal(paused.operations[0].error.code,'VERIFICATION_REQUIRED');
  assert.equal(seen.length,1);assert.equal(seen[0].tabId,81);assert.equal(seen[0].saved.status,'waiting_user');
  assert.deepEqual(await readFile(path.join(f.options.stateDirectory,'tasks/body.json')),seen[0].bytes);
});
test('a failed pause commit never requests foreground assistance',async t=>{
  const f=await fixture(t);let shows=0;
  f.bridge.readOrderDetailBody=()=>fail('LOGIN_REQUIRED');f.bridge.showTab=async()=>{shows++;return true;};
  await assert.rejects(withTaskStore(f.options.stateDirectory,'body',async store=>{
    const task=await store.load();
    await runOrderBodyRead({task,bridge:f.bridge,...f.clock,commit:async()=>{
      if(task.status==='waiting_user')throw new ShoppingError('CHECKPOINT_WRITE_FAILED','Synthetic checkpoint failure');
      await store.save(task);
    }});
  }),{code:'CHECKPOINT_WRITE_FAILED'});
  assert.equal(shows,0);
});
test('body creation only binds a completed entry and its unique saved new tab without IO or copying list items',async t=>{
  const f=await fixture(t),task=await loadTask(f.options.stateDirectory,'body'),op=task.operations[0];
  assert.equal(task.kind,'order_body_snapshot');assert.equal(op.tab_id,81);assert.equal(op.source.task,'entry');assert.equal(op.source.list.position,2);
  assert.equal(op.source.list.task,'list');assert.equal(Object.hasOwn(op.source,'items'),false);assert.equal(op.order_body_read.read_limit,6);assert.equal(op.order_body_read.inventory_limit,8);assert.deepEqual(f.calls,[]);
});
test('a bounded body read saves guarded fields and subsequent run/status/next-batch return exactly the original cache',async t=>{
  const f=await fixture(t),result=await runTask(f.options,f.clock),op=result.operations[0];
  assert.equal(result.status,'complete');assert.deepEqual(f.calls,['status','tabs','body']);assert.equal(op.result.scope,'single_order_body');assert.deepEqual(op.result.body,f.body);
  assert.equal(op.order_body_budget.reads_reserved,1);assert.equal(op.order_body_budget.inventories_reserved,1);assert.equal(op.actions_reserved,0);assert.equal(op.normal_order_fields_read,true);
  const file=path.join(f.options.stateDirectory,'tasks/body.json'),bytes=await readFile(file);assert.equal((await stat(file)).mode&0o777,0o600);
  f.bridge.requireConnected=()=>fail('BRIDGE_UNAVAILABLE');
  assert.deepEqual(await runTask(f.options,f.clock),result);assert.deepEqual(await taskStatus(f.options),result);assert.deepEqual(await runTask({...f.options,nextBatch:true},f.clock),result);
  await assert.rejects(runTask({...f.options,recovery:'user'},f.clock),{code:'INVALID_RECOVERY'});assert.deepEqual(await readFile(file),bytes);
  assert.deepEqual(await readFile(f.entryFile),f.entryBytes);assert.deepEqual(await readFile(f.listFile),f.listBytes);
});
test('body mode rejects other modes, explicit replacement tabs, positions and unsupported sessions before IO',async t=>{
  const f=await fixture(t);
  for(const addition of [{orderDetail:true},{orders:true},{cart:true},{bindings:['x']},{search:'query'},{details:true},{sourceTask:undefined},{tabId:81},{orderPosition:2},{pages:2},{cartRows:10},{orderRows:10},{plan:'missing'},{specificationImages:true},{orderBody:false}])await assert.rejects(createTask({...f.options,task:'bad',...addition}));
  await assert.rejects(createTask({...f.options,task:'bad',bridge:{...f.bridge,protocol:'owned-chrome-cdp'}}),{code:'INVALID_TRANSPORT'});assert.deepEqual(f.calls,[]);
});
test('unfinished, error-page and list-only sources cannot become body tasks',async t=>{
  const f=await fixture(t),entry=await loadTask(f.options.stateDirectory,'entry');
  const unfinished=structuredClone(entry);unfinished.status='pending';assert.throws(()=>orderBodySource(unfinished));
  await assert.rejects(createTask({...f.options,task:'bad',sourceTask:'list'}),{code:'ORDER_BODY_SOURCE_UNVERIFIED'});
  const error=structuredClone(entry),op=error.operations[0];op.order_detail_check.page=validateOrderDetailPage({state:'observed',address:{state:'observed',...f.target},page_state:'error',error_roots_seen:1,
    error_page:{title:{text:'页面出错了',truncated:false},subtitle:{text:'合成错误说明',truncated:false}}},f.target);op.result=orderDetailCheckResult(op);validateTask(error);
  assert.throws(()=>orderBodySource(error),{code:'ORDER_BODY_SOURCE_UNVERIFIED'});assert.deepEqual(f.calls,[]);
});
test('endpoint mismatch and body task self-reference cannot replace the original entry source',async t=>{
  const f=await fixture(t);await assert.rejects(createTask({...f.options,task:'bad',bridge:{...f.bridge,endpoint:'http://127.0.0.1:19825'}}),{code:'BINDING_ENDPOINT_MISMATCH'});
  await assert.rejects(createTask({...f.options,task:'bad',sourceTask:'bad'}));assert.deepEqual(f.calls,[]);
});
test('a missing saved new tab pauses without evaluating or borrowing another same-order tab',async t=>{
  const f=await fixture(t);f.tabs.splice(0,f.tabs.length,{id:82,url:f.target.url});const result=await runTask(f.options,f.clock);
  assert.equal(result.status,'waiting_connection');assert.equal(result.operations[0].order_body_budget.reads_reserved,0);assert.deepEqual(f.calls,['status','tabs']);
  const before=await loadTask(f.options.stateDirectory,'body');await assert.rejects(rebindTask({...f.options,tabId:82}),{code:'INVALID_RECOVERY'});
  const diagnosis=await diagnoseTask(f.options);assert.equal(diagnosis.operations[0].reason,'saved_tab_unavailable');assert.deepEqual(diagnosis.operations[0].matching_tab_ids,[82]);
  assert.deepEqual(await loadTask(f.options.stateDirectory,'body'),before);
});
test('login route pauses for the user and mismatched printed order stops association through adapter guards',async t=>{
  const f=await fixture(t);f.tabs.find(tab=>tab.id===81).url='https://login.taobao.com/member/login.jhtml';assert.equal((await runTask(f.options,f.clock)).status,'waiting_user');
  assert.equal((await loadTask(f.options.stateDirectory,'body')).operations[0].order_body_read.reads_reserved,0);
  f.tabs.find(tab=>tab.id===81).url=f.target.url;f.bridge.readOrderDetailBody=()=>fail('TARGET_CHANGED');
  const result=await runTask({...f.options,recovery:'user'},f.clock);assert.equal(result.status,'waiting_connection');assert.equal(result.operations[0].result,null);assert.deepEqual(f.waits,[5000]);
});
test('user and connection recoveries share two five-second reservations and a further resume seals the round',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailBody=()=>fail('VERIFICATION_REQUIRED');await runTask(f.options,f.clock);
  await assert.rejects(runTask(f.options,f.clock),{code:'RECOVERY_REQUIRED'});
  await runTask({...f.options,recovery:'user'},f.clock);await runTask({...f.options,recovery:'user'},f.clock);
  const result=await runTask({...f.options,recovery:'user'},f.clock);assert.equal(result.status,'stopped');assert.equal(result.operations[0].error.code,'ORDER_BODY_RECOVERY_LIMIT');
  assert.equal(result.operations[0].order_body_budget.recoveries_reserved,2);assert.deepEqual(f.waits,[5000,5000]);assert.equal(result.operations[0].order_body_budget.failures.length,3);
  await assert.rejects(createTask({...f.options,task:'renamed'}),{code:'PLATFORM_TASK_UNFINISHED'});
});
test('an explicit recovery is durably reserved before its wait and successful read keeps the original first failure',async t=>{
  const f=await fixture(t),normal=f.bridge.readOrderDetailBody;let count=0;f.bridge.readOrderDetailBody=(...args)=>++count===1?fail('LOGIN_REQUIRED'):normal(...args);
  await runTask(f.options,f.clock);const result=await runTask({...f.options,recovery:'user'},{...f.clock,wait:async ms=>{const saved=await loadTask(f.options.stateDirectory,'body');assert.equal(saved.operations[0].order_body_read.recoveries_reserved,1);assert.equal(saved.wait_reserved_ms,5000);return f.clock.wait(ms);}});
  assert.equal(result.status,'complete');assert.equal(result.operations[0].order_body_budget.failures[0].code,'LOGIN_REQUIRED');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
test('automatic transient faults retry twice and stop with saved original failures and no body result',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailBody=()=>fail('BRIDGE_TIMEOUT');const result=await runTask(f.options,f.clock);
  assert.equal(result.status,'stopped');assert.equal(result.operations[0].automatic_retries,2);assert.equal(result.operations[0].order_body_budget.reads_reserved,3);
  assert.deepEqual(f.waits,[5000,15000]);assert.equal(result.operations[0].order_body_budget.failures.length,3);assert.equal(result.operations[0].result,null);
});
test('a transient fault during explicit user recovery pauses again without consuming automatic retries',async t=>{
  const f=await fixture(t);let count=0;f.bridge.readOrderDetailBody=()=>fail(++count===1?'VERIFICATION_REQUIRED':'BRIDGE_TIMEOUT');await runTask(f.options,f.clock);
  const result=await runTask({...f.options,recovery:'user'},f.clock);assert.equal(result.status,'waiting_user');assert.equal(result.operations[0].automatic_retries,0);assert.deepEqual(f.waits,[5000]);
});
test('cooldown has only one explicit probe and a transient fault after that probe stops',async t=>{
  const f=await fixture(t);let count=0;f.bridge.readOrderDetailBody=()=>fail(++count===1?'RATE_LIMITED':'BRIDGE_TIMEOUT');await runTask(f.options,f.clock);
  const result=await runTask({...f.options,recovery:'cooldown'},f.clock);assert.equal(result.status,'stopped');assert.equal(result.cooldown_probes,1);assert.equal(result.operations[0].automatic_retries,0);assert.deepEqual(f.waits,[5000]);
});
test('a recovery wait interrupted by the host resumes its original reservation without charging another recovery',async t=>{
  const f=await fixture(t),normal=f.bridge.readOrderDetailBody;let count=0;f.bridge.readOrderDetailBody=(...args)=>++count===1?fail('LOGIN_REQUIRED'):normal(...args);await runTask(f.options,f.clock);
  await assert.rejects(runTask({...f.options,recovery:'user'},{...f.clock,wait:async()=>{throw Error('Host interrupted');}}));
  const result=await runTask(f.options,f.clock);assert.equal(result.status,'complete');assert.equal(result.operations[0].order_body_budget.recoveries_reserved,1);assert.equal(result.operations[0].automatic_retries,0);
});
test('a durably reserved content read without a reply retains READ_INTERRUPTED and spends one original retry',async t=>{
  const f=await fixture(t);await change(f,task=>{task.status='running';const op=task.operations[0];op.status='running';op.attempts=1;op.order_body_read.inventories_reserved=1;op.order_body_read.reads_reserved=1;});
  const result=await runTask(f.options,f.clock);assert.equal(result.status,'complete');assert.equal(result.operations[0].order_body_budget.reads_reserved,2);
  assert.equal(result.operations[0].order_body_budget.failures[0].code,'READ_INTERRUPTED');assert.equal(result.automatic_retries,1);assert.deepEqual(f.waits,[5000]);
});
test('checkpoint failure before content reservation is persisted prevents eval and cannot create automatic retries',async t=>{
  const f=await fixture(t),task=await loadTask(f.options.stateDirectory,'body');let reads=0;
  await assert.rejects(runOrderBodyRead({task,bridge:{...f.bridge,requireConnected:async()=>{},listTabs:async()=>f.tabs,readOrderDetailBody:async()=>{reads++;return f.body;}},...f.clock,
    commit:async()=>{if(task.operations[0].order_body_read.reads_reserved)throw new ShoppingError('CHECKPOINT_WRITE_FAILED','Disk unavailable');}}),{code:'CHECKPOINT_WRITE_FAILED'});
  assert.equal(reads,0);assert.equal(task.retries,0);
});
test('malformed body responses stop without saving private extra fields or guessed totals',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailBody=async()=>({...f.body,contact:'PRIVATE'});const result=await runTask(f.options,f.clock);
  assert.equal(result.status,'stopped');assert.equal(result.operations[0].error.code,'INVALID_RESPONSE');assert.equal(result.operations[0].result,null);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
test('an unknown structure stops after one protected read without searching other orders or retrying',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailBody=()=>fail('STRUCTURE_CHANGED');const result=await runTask(f.options,f.clock);
  assert.equal(result.status,'stopped');assert.equal(result.operations[0].automatic_retries,0);assert.deepEqual(f.calls,['status','tabs']);assert.deepEqual(f.waits,[]);
});
test('ending a paused body task keeps provenance, counters and failure history with no further IO',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailBody=()=>fail('LOGIN_REQUIRED');await runTask(f.options,f.clock);const before=await loadTask(f.options.stateDirectory,'body');
  await endTask(f.options);assert.deepEqual((await loadTask(f.options.stateDirectory,'body')).operations,before.operations);f.calls.length=0;assert.equal((await runTask(f.options,f.clock)).status,'ended');assert.deepEqual(f.calls,[]);
});
test('read protection retains six attempts and refuses a seventh without eval or refunding prior reservations',async t=>{
  const f=await fixture(t);await change(f,task=>{const op=task.operations[0];op.attempts=6;op.order_body_read.reads_reserved=6;op.order_body_read.inventories_reserved=6;});
  const result=await runTask(f.options,f.clock);assert.equal(result.status,'stopped');assert.equal(result.operations[0].error.code,'ORDER_BODY_BUDGET_LIMIT');assert.equal(result.operations[0].order_body_budget.reads_reserved,6);assert.deepEqual(f.calls,[]);
});
test('an exhausted inventory guard stops before connection inspection and never refreshes the content budget',async t=>{
  const f=await fixture(t);await change(f,task=>{const op=task.operations[0];op.attempts=8;op.order_body_read.inventories_reserved=8;});const result=await runTask(f.options,f.clock);
  assert.equal(result.status,'stopped');assert.equal(result.operations[0].error.code,'ORDER_BODY_BUDGET_LIMIT');assert.deepEqual(f.calls,[]);
});
test('unfinished body task has no next batch and no implicit recovery path',async t=>{
  const f=await fixture(t);await assert.rejects(runTask({...f.options,nextBatch:true},f.clock),{code:'INVALID_RECOVERY'});assert.deepEqual(f.calls,[]);
});
for(const[label,mutate]of Object.entries({
  'increased read limit':t=>{t.operations[0].order_body_read.read_limit=7;},
  'increased inventory limit':t=>{t.operations[0].order_body_read.inventory_limit=9;},
  'increased recovery limit':t=>{t.operations[0].order_body_read.recovery_limit=3;},
  'invented zero-cost body':t=>{t.operations[0].order_body_read.reads_reserved=0;},
  'invented full coverage':t=>{t.operations[0].result.body.coverage.full_order_items_verified=true;},
  'invented payment proof':t=>{t.operations[0].result.body.amount_observations[0].settlement_verified=true;},
  'extra contact data':t=>{t.operations[0].result.body.phone='PRIVATE';},
  'changed source observation':t=>{t.operations[0].source.observed_at='2026-01-01T00:00:00Z';},
  'changed source tab':t=>{t.operations[0].tab_id=82;},
  'changed original list observation':t=>{t.operations[0].source.list.observed_at='2026-01-01T00:00:00Z';},
  'invalid failure category':t=>{t.operations[0].order_body_read.failures=[{attempt:1,code:'LOGIN_REQUIRED',category:'diagnostic'}];},
  'fake source type':t=>{t.operations[0].source.task='body';},
}))test(`saved body task rejects ${label} before cache or browser use`,async t=>{
  const f=await fixture(t);await runTask(f.options,f.clock);const task=await loadTask(f.options.stateDirectory,'body');mutate(task);
  await writeFile(path.join(f.options.stateDirectory,'tasks/body.json'),JSON.stringify(task));await assert.rejects(taskStatus(f.options),{code:'INVALID_CHECKPOINT'});
  assert.deepEqual(f.calls,['status','tabs','body']);
});
test('changing the saved navigation source or its original list provenance invalidates even a finished body cache',async t=>{
  const f=await fixture(t);await runTask(f.options,f.clock);const entry=await loadTask(f.options.stateDirectory,'entry');entry.operations[0].source.observed_at='2026-01-01T00:00:00Z';entry.operations[0].result.source=entry.operations[0].source;validateTask(entry);
  await writeFile(f.entryFile,JSON.stringify(entry));await assert.rejects(taskStatus(f.options),{code:'INVALID_CHECKPOINT'});
});
test('restoring the original tab after a metadata failure spends one shared recovery without restoring inventory reservations',async t=>{
  const f=await fixture(t),tab=f.tabs.find(tab=>tab.id===81);f.tabs.splice(f.tabs.indexOf(tab),1);await runTask(f.options,f.clock);
  f.tabs.push(tab);const result=await runTask({...f.options,recovery:'connection'},f.clock);assert.equal(result.status,'complete');assert.equal(result.operations[0].order_body_budget.inventories_reserved,2);
  assert.equal(result.operations[0].order_body_budget.reads_reserved,1);assert.equal(result.operations[0].order_body_budget.recoveries_reserved,1);assert.equal(result.operations[0].order_body_budget.failures[0].code,'TARGET_MISSING');
});
test('a changed original list source invalidates the body cache even when the navigation task file itself is unchanged',async t=>{
  const f=await fixture(t);await runTask(f.options,f.clock);const list=await loadTask(f.options.stateDirectory,'list');
  list.operations[0].result.observed_at='2026-01-01T00:00:00Z';validateTask(list);await writeFile(f.listFile,JSON.stringify(list));
  await assert.rejects(taskStatus(f.options),{code:'INVALID_CHECKPOINT'});assert.deepEqual(await readFile(f.entryFile),f.entryBytes);
});
test('a body response from a different printed order cannot be saved under the original source',async t=>{
  const f=await fixture(t),different={url:f.target.url.replace('902','903'),order_id:'903'};
  f.bridge.readOrderDetailBody=async()=>validateOrderDetailBody(observeDetail({target:different,orderId:'903',url:different.url}).raw,different);
  const result=await runTask(f.options,f.clock);assert.equal(result.status,'stopped');assert.equal(result.operations[0].error.code,'INVALID_RESPONSE');assert.equal(result.operations[0].result,null);
});
test('an exhausted shared wait budget blocks explicit recovery before wait, metadata or eval',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailBody=()=>fail('LOGIN_REQUIRED');await runTask(f.options,f.clock);
  await change(f,task=>{task.wait_reserved_ms=120000;});f.calls.length=0;
  const result=await runTask({...f.options,recovery:'user'},f.clock);assert.equal(result.status,'stopped');assert.equal(result.operations[0].error.code,'WAIT_BUDGET_EXHAUSTED');
  assert.equal(result.operations[0].order_body_budget.recoveries_reserved,0);assert.deepEqual(f.waits,[]);assert.deepEqual(f.calls,[]);
});
test('a transient failure stays recorded when retry wait would exceed the shared budget',async t=>{
  const f=await fixture(t);await change(f,task=>{task.wait_reserved_ms=119999;});f.bridge.readOrderDetailBody=()=>fail('BRIDGE_TIMEOUT');
  const result=await runTask(f.options,f.clock);assert.equal(result.status,'stopped');assert.equal(result.operations[0].order_body_budget.failures[0].code,'BRIDGE_TIMEOUT');
  assert.equal(result.automatic_retries,0);assert.deepEqual(f.waits,[]);
});
test('actual CLI creates from local entry, evaluates one bounded body and returns cache without further requests',async t=>{
  const f=await fixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'shopping order body cli '));t.after(()=>rm(directory,{recursive:true,force:true}));
  const server=await mockBridge(t,{handler:({req,res,body})=>{
    res.setHeader('Content-Type','application/json');if(req.url==='/status'){res.end(JSON.stringify(playwrightStatus()));return;}
    let data;if(body.action==='tab_list')data={tabs:[{id:81,url:f.target.url}]};else{assert.equal(body.action,'eval');assert.ok(body.script.includes('collectOrderBody'));data={result:observeDetail({target:f.target,orderId:f.target.order_id,url:f.target.url}).raw};}
    res.end(JSON.stringify({id:body.id,success:true,data}));
  }});
  for(const name of ['list','entry']){const task=await loadTask(f.options.stateDirectory,name);task.endpoint=server.endpoint;await withTaskStore(directory,name,store=>store.create(task));}
  const common=['--task','cli-body','--state-dir',directory,'--endpoint',server.endpoint];const cli=async args=>{let text='';const code=await main(args,{write:value=>{text+=value;}});return {code,...JSON.parse(text)};};
  assert.equal((await cli(['task-start',...common,'--order-body','--source-task','entry'])).status,'task_created');assert.equal(server.state.commands.length,0);
  const result=await cli(['task-run',...common]);assert.equal(result.status,'complete');assert.equal(result.operations[0].result.body.printed_order_id_verified,true);
  assert.equal(server.state.commands.filter(command=>command.action==='eval').length,1);assert.ok(server.state.commands.every(command=>['tab_list','eval'].includes(command.action)));
  const count=server.state.commands.length;await cli(['task-run',...common]);await cli(['task-status','--task','cli-body','--state-dir',directory]);assert.equal(server.state.commands.length,count);
});
