import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,symlink,unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createOrderWorkflow,runOrderWorkflow,orderWorkflowStatus,endOrderWorkflow} from '../lib/order-workflow.mjs';
import {readOrderWorkflow,writeOrderWorkflow} from '../lib/order-workflow-store.mjs';
import {validateOrderWorkflow} from '../lib/order-workflow-state.mjs';
import {createTask,runTask,taskStatus,endTask} from '../lib/tasks.mjs';
import {loadTask,withWorkflowPlatform,withTaskStore} from '../lib/task-store.mjs';
import {ShoppingError} from '../lib/errors.mjs';
import {validateOrderRows} from '../lib/order-rows.mjs';
import {validateOrderDetailPage} from '../lib/order-detail-page.mjs';
import {validateOrderDetailBody} from '../lib/order-detail-body.mjs';
import {orderDetailSource} from '../lib/order-detail-check.mjs';
import {orderGroup,observeOrders,orderTarget} from '../test-support/order-fixture.mjs';
import {observeDetail} from '../test-support/order-detail-fixture.mjs';
import {main} from '../lib/cli.mjs';
import { playwrightStatus,mockBridge} from '../test-support/mock-bridge.mjs';

const fail=code=>{throw new ShoppingError(code,'PRIVATE external text');};
async function fixture(t){
  const stateDirectory=await mkdtemp(path.join(os.tmpdir(),'shopping order workflow '));
  t.after(()=>rm(stateDirectory,{recursive:true,force:true}));
  const calls=[],waits=[],tabs=[{id:41,url:orderTarget.url}];let time=Date.parse('2026-10-08T00:00:00Z');
  const clock={now:()=>time,wait:async ms=>{waits.push(ms);time+=ms;}};
  const snapshot=validateOrderRows(observeOrders(Array.from({length:5},(_,index)=>orderGroup(index+1).group)),orderTarget);
  const target=snapshot.orders[1].detail_entry.observation;
  const bridge={endpoint:'http://127.0.0.1:19824',protocol:'playwright-extension',
    async requireConnected(){calls.push('status');},async listTabs(){calls.push('tabs');return tabs;},
    async readOrderRows(){calls.push('list');return snapshot;},
    async inspectOrderDetailEntry(){
      calls.push('prepare');const list=await loadTask(stateDirectory,'round-list'),record=orderDetailSource(list,2);
      return {state:'entry_prepared',list_url:orderTarget.url,...record.target,position:2,loaded_groups_seen:5,
        selector:'.trade-main-content .trade-content-container > .trade-bought-list-order-container:nth-child(2) > .trade-bought-list-shop-info :is([class^="shopInfoOrderDetail--"], [class*=" shopInfoOrderDetail--"])',entry_text:'订单详情',target_attribute:'_blank'};
    },
    async openOrderDetailEntry(){calls.push('click');tabs.push({id:81,url:target.url});return {clicked:true,navigation_verified:false};},
    async readOrderDetailPageState(){calls.push('page');return validateOrderDetailPage({state:'observed',address:{state:'observed',...target},page_state:'not_assessed',error_roots_seen:0,error_page:null},target);},
    async readOrderDetailBody(){calls.push('body');return validateOrderDetailBody(observeDetail({target,orderId:target.order_id,url:target.url}).raw,target);}};
  const options={stateDirectory,workflow:'round',tabId:41,orderPosition:2,bridge};
  await createOrderWorkflow(options);return {options,clock,bridge,calls,waits,tabs,target,snapshot};
}
const filename=(f,phase)=>path.join(f.options.stateDirectory,'tasks',`round-${phase}.json`);
const workflowFile=f=>path.join(f.options.stateDirectory,'order-workflows/round.json');
async function cli(args){let output='';const code=await main(args,{write:value=>{output+=value;}});return {code,...JSON.parse(output)};}

test('creating a fixed first-five plan reserves its names before IO and status only reads local state',async t=>{
  const f=await fixture(t),saved=await readOrderWorkflow(f.options.stateDirectory,'round');
  assert.deepEqual(saved.stages.map(stage=>stage.task),['round-list','round-entry','round-body']);
  assert.deepEqual(f.calls,[]);assert.equal((await orderWorkflowStatus(f.options)).status,'pending');
  assert.equal((await stat(workflowFile(f))).mode&0o777,0o600);
  assert.equal((await stat(path.dirname(workflowFile(f)))).mode&0o777,0o700);
  await assert.rejects(loadTask(f.options.stateDirectory,'round-list'),{code:'TASK_MISSING'});
});
test('the original three stages save distinct observations, one guarded click and durable aggregate budgets',async t=>{
  const f=await fixture(t),result=await runOrderWorkflow(f.options,f.clock);
  assert.equal(result.status,'complete');assert.equal(result.result.scope,'single_order_read_workflow');
  assert.equal(result.result.observations.list.order.position,2);assert.equal(result.result.observations.body.body.printed_order_id_verified,true);
  assert.equal(f.calls.filter(value=>value==='list').length,1);assert.equal(f.calls.filter(value=>value==='click').length,1);assert.equal(f.calls.filter(value=>value==='body').length,1);
  assert.deepEqual(f.waits,[1500,5000,1500]);assert.equal(result.budget.transition_wait_reserved_ms,3000);
  assert.equal(result.budget.explicit_recoveries,0);assert.equal(result.budget.actions_reserved,1);assert.equal(result.budget.wait_reserved_ms,5000);
  assert.equal(result.result.coverage.settlement_verified,false);assert.equal(result.result.coverage.full_order_items_verified,false);
  for(const stage of (await readOrderWorkflow(f.options.stateDirectory,'round')).stages)assert.equal(stage.sha256,createHash('sha256').update(await readFile(filename(f,stage.phase))).digest('hex'));
});
test('completed run/status/end preserve every original byte and issue no browser calls',async t=>{
  const f=await fixture(t),result=await runOrderWorkflow(f.options,f.clock),bytes=await readFile(workflowFile(f));f.calls.length=0;
  f.bridge.requireConnected=()=>fail('BRIDGE_UNAVAILABLE');
  assert.deepEqual(await runOrderWorkflow(f.options,f.clock),result);assert.deepEqual(await orderWorkflowStatus(f.options),result);assert.deepEqual(await endOrderWorkflow(f.options),result);
  assert.deepEqual(await readFile(workflowFile(f)),bytes);assert.deepEqual(f.calls,[]);
  await assert.rejects(runOrderWorkflow({...f.options,recovery:'user'},f.clock),{code:'INVALID_RECOVERY'});
});
test('the pending wrapper blocks renamed workflows, unrelated tasks and direct reserved child execution',async t=>{
  const f=await fixture(t);
  await assert.rejects(createOrderWorkflow({...f.options,workflow:'renamed'}),{code:'PLATFORM_WORKFLOW_UNFINISHED'});
  await assert.rejects(createTask({stateDirectory:f.options.stateDirectory,task:'other',orders:true,tabId:41,bridge:f.bridge}),{code:'PLATFORM_WORKFLOW_UNFINISHED'});
  await assert.rejects(createTask({stateDirectory:f.options.stateDirectory,task:'round-list',orders:true,tabId:41,bridge:f.bridge}),{code:'WORKFLOW_TASK_RESERVED'});
  await assert.rejects(runTask({stateDirectory:f.options.stateDirectory,task:'round-list',bridge:f.bridge}),{code:'WORKFLOW_TASK_RESERVED'});assert.deepEqual(f.calls,[]);
});
test('a paused list requires exact recovery and resumes the original child without restarting completed stages',async t=>{
  const f=await fixture(t),normal=f.bridge.readOrderRows;let count=0;f.bridge.readOrderRows=(...args)=>++count===1?fail('LOGIN_REQUIRED'):normal(...args);
  const paused=await runOrderWorkflow(f.options,f.clock);assert.equal(paused.status,'waiting_user');assert.equal(paused.current_stage,'list');
  await assert.rejects(runOrderWorkflow(f.options,f.clock),{code:'RECOVERY_REQUIRED'});await assert.rejects(runOrderWorkflow({...f.options,recovery:'connection'},f.clock),{code:'RECOVERY_REQUIRED'});
  const result=await runOrderWorkflow({...f.options,recovery:'user'},f.clock);assert.equal(result.status,'complete');assert.equal(result.budget.explicit_recoveries,1);
  assert.equal(result.stages[0].budget.failures[0].code,'LOGIN_REQUIRED');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.deepEqual(f.waits,[5000,1500,5000,1500]);
});
test('user assistance displays once only after both child and parent pauses are saved, preserving display failures',async t=>{
  const f=await fixture(t),seen=[];
  f.bridge.readOrderRows=()=>fail('LOGIN_REQUIRED');
  f.bridge.showTab=async tabId=>{
    seen.push({tabId,parent:await readOrderWorkflow(f.options.stateDirectory,'round'),child:await loadTask(f.options.stateDirectory,'round-list')});
    throw new Error('Synthetic display failure');
  };
  const paused=await runOrderWorkflow(f.options,f.clock);
  assert.equal(paused.status,'waiting_user');assert.equal(seen.length,1);assert.equal(seen[0].tabId,41);
  assert.equal(seen[0].parent.status,'waiting_user');assert.equal(seen[0].child.status,'waiting_user');
  assert.equal(seen[0].child.operations[0].error.code,'LOGIN_REQUIRED');
  const parentBytes=await readFile(workflowFile(f)),childBytes=await readFile(filename(f,'list'));
  await assert.rejects(runOrderWorkflow(f.options,f.clock),{code:'RECOVERY_REQUIRED'});
  await orderWorkflowStatus(f.options);assert.equal(seen.length,1);
  assert.deepEqual(await readFile(workflowFile(f)),parentBytes);assert.deepEqual(await readFile(filename(f,'list')),childBytes);
});
test('a missing saved body tab pauses and will not borrow an existing same-order tab',async t=>{
  const f=await fixture(t),normal=f.bridge.readOrderDetailPageState;f.bridge.readOrderDetailPageState=async()=>{const page=await normal();f.tabs.splice(1,1,{id:82,url:f.target.url});return page;};
  const paused=await runOrderWorkflow(f.options,f.clock);assert.equal(paused.status,'waiting_connection');assert.equal(paused.current_stage,'body');assert.equal(f.calls.includes('body'),false);
  const list=await readFile(filename(f,'list')),entry=await readFile(filename(f,'entry'));f.tabs.push({id:81,url:f.target.url});
  const result=await runOrderWorkflow({...f.options,recovery:'connection'},f.clock);assert.equal(result.status,'complete');assert.equal(result.budget.explicit_recoveries,1);
  assert.equal(f.calls.filter(value=>value==='click').length,1);assert.deepEqual(await readFile(filename(f,'list')),list);assert.deepEqual(await readFile(filename(f,'entry')),entry);
});
test('two explicit recoveries belong to the entire chain and a third stage recovery stops before IO',async t=>{
  const f=await fixture(t),normal=f.bridge.readOrderRows;let listReads=0;f.bridge.readOrderRows=(...args)=>++listReads<=2?fail('LOGIN_REQUIRED'):normal(...args);
  f.bridge.inspectOrderDetailEntry=()=>fail('VERIFICATION_REQUIRED');
  await runOrderWorkflow(f.options,f.clock);await runOrderWorkflow({...f.options,recovery:'user'},f.clock);
  const paused=await runOrderWorkflow({...f.options,recovery:'user'},f.clock);assert.equal(paused.status,'waiting_user');assert.equal(paused.current_stage,'entry');assert.equal(paused.budget.explicit_recoveries,2);
  f.calls.length=0;f.waits.length=0;const stopped=await runOrderWorkflow({...f.options,recovery:'user'},f.clock);
  assert.equal(stopped.status,'stopped');assert.equal(stopped.error.code,'WORKFLOW_RECOVERY_LIMIT');assert.equal(stopped.budget.explicit_recoveries,2);assert.deepEqual(f.calls,[]);assert.deepEqual(f.waits,[]);
  const bytes=await readFile(filename(f,'entry'));await runOrderWorkflow(f.options,f.clock);assert.deepEqual(await readFile(filename(f,'entry')),bytes);
});
test('automatic retries are accumulated across all stages and a sixth retry cannot dispatch another read',async t=>{
  const f=await fixture(t),list=f.bridge.readOrderRows,prepare=f.bridge.inspectOrderDetailEntry;let a=0,b=0;
  f.bridge.readOrderRows=(...args)=>++a<=2?fail('BRIDGE_TIMEOUT'):list(...args);
  f.bridge.inspectOrderDetailEntry=(...args)=>++b<=2?fail('BRIDGE_TIMEOUT'):prepare(...args);
  f.bridge.readOrderDetailBody=()=>{f.calls.push('body-fault');return fail('BRIDGE_TIMEOUT');};
  const result=await runOrderWorkflow(f.options,f.clock);assert.equal(result.status,'stopped');assert.equal(result.error.code,'WORKFLOW_RETRY_LIMIT');
  assert.equal(result.budget.platform_retries,5);assert.equal(f.calls.filter(value=>value==='body-fault').length,2);assert.equal(result.stages[2].budget.failures[0].code,'BRIDGE_TIMEOUT');
  assert.equal(result.error.cause,'BRIDGE_TIMEOUT');
});
test('a cooldown probe in an earlier stage cannot be repeated in a later stage',async t=>{
  const f=await fixture(t),list=f.bridge.readOrderRows;let count=0;f.bridge.readOrderRows=(...args)=>++count===1?fail('RATE_LIMITED'):list(...args);
  f.bridge.inspectOrderDetailEntry=()=>fail('RATE_LIMITED');await runOrderWorkflow(f.options,f.clock);
  const paused=await runOrderWorkflow({...f.options,recovery:'cooldown'},f.clock);assert.equal(paused.status,'waiting_cooldown');assert.equal(paused.budget.cooldown_probes,1);
  f.calls.length=0;f.waits.length=0;const result=await runOrderWorkflow({...f.options,recovery:'cooldown'},f.clock);
  assert.equal(result.status,'stopped');assert.equal(result.error.code,'WORKFLOW_COOLDOWN_LIMIT');assert.deepEqual(f.calls,[]);assert.deepEqual(f.waits,[]);
});
test('a supported visible error page keeps entry observations and never creates or reads a body task',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailPageState=async()=>validateOrderDetailPage({state:'observed',address:{state:'observed',...f.target},page_state:'error',error_roots_seen:1,
    error_page:{title:{text:'页面出错了',truncated:false},subtitle:{text:'合成错误说明',truncated:false}}},f.target);
  const result=await runOrderWorkflow(f.options,f.clock);assert.equal(result.status,'stopped');assert.equal(result.error.code,'ORDER_BODY_SOURCE_UNVERIFIED');
  assert.ok(result.result.observations.entry);assert.equal(result.result.observations.body,null);await assert.rejects(loadTask(f.options.stateDirectory,'round-body'),{code:'TASK_MISSING'});assert.equal(f.calls.includes('body'),false);
});
test('a list without the explicitly selected position stops without substituting another order',async t=>{
  const f=await fixture(t);f.bridge.readOrderRows=async()=>validateOrderRows(observeOrders([orderGroup(1).group]),orderTarget);
  const result=await runOrderWorkflow(f.options,f.clock);assert.equal(result.status,'stopped');assert.equal(result.error.code,'ORDER_DETAIL_SOURCE_UNVERIFIED');assert.equal(result.result.observations.list,null);
  assert.equal(f.calls.includes('click'),false);
});
test('a structure failure keeps the partial original stages and ending only releases the wrapper locally',async t=>{
  const f=await fixture(t);f.bridge.readOrderDetailBody=()=>fail('STRUCTURE_CHANGED');const stopped=await runOrderWorkflow(f.options,f.clock);assert.equal(stopped.status,'stopped');
  await assert.rejects(createOrderWorkflow({...f.options,workflow:'new'}),{code:'PLATFORM_WORKFLOW_UNFINISHED'});
  const before=await loadTask(f.options.stateDirectory,'round-body');f.calls.length=0;const ended=await endOrderWorkflow(f.options);assert.equal(ended.status,'ended');
  assert.deepEqual((await loadTask(f.options.stateDirectory,'round-body')).operations,before.operations);assert.deepEqual(f.calls,[]);
  assert.equal((await createOrderWorkflow({...f.options,workflow:'new'})).status,'workflow_created');
});
test('an interrupted stage interval retains the completed list and remaining wait without another list read',async t=>{
  const f=await fixture(t);await assert.rejects(runOrderWorkflow(f.options,{...f.clock,wait:async()=>{throw Error('Host interrupted');}}));
  const saved=await readOrderWorkflow(f.options.stateDirectory,'round');assert.equal(saved.stages[0].status,'complete');assert.equal(saved.transition_wait_reserved_ms,1500);
  assert.equal((await runOrderWorkflow(f.options,f.clock)).status,'complete');assert.equal(f.calls.filter(value=>value==='list').length,1);assert.deepEqual(f.waits,[1500,5000,1500]);
});
test('interruption after the click intent never repeats the click or takes another same-order tab',async t=>{
  const f=await fixture(t);let interrupted=false;
  await assert.rejects(runOrderWorkflow(f.options,{...f.clock,wait:async ms=>{if(ms===5000&&!interrupted){interrupted=true;throw Error('Host interrupted');}return f.clock.wait(ms);}}));
  assert.equal(f.calls.filter(value=>value==='click').length,1);assert.equal((await runOrderWorkflow(f.options,f.clock)).status,'complete');assert.equal(f.calls.filter(value=>value==='click').length,1);
});
test('interrupted recovery wait resumes its original allowance without another recovery charge',async t=>{
  const f=await fixture(t),normal=f.bridge.readOrderDetailBody;let count=0;f.bridge.readOrderDetailBody=(...args)=>++count===1?fail('LOGIN_REQUIRED'):normal(...args);
  await runOrderWorkflow(f.options,f.clock);
  await assert.rejects(runOrderWorkflow({...f.options,recovery:'user'},{...f.clock,wait:async()=>{throw Error('Host interrupted');}}));
  const result=await runOrderWorkflow(f.options,f.clock);assert.equal(result.status,'complete');assert.equal(result.budget.explicit_recoveries,1);assert.equal(f.calls.filter(value=>value==='click').length,1);
});
test('a committed child result without parent completion is reconciled locally without repeating the read',async t=>{
  const f=await fixture(t);await runOrderWorkflow(f.options,f.clock);const saved=await readOrderWorkflow(f.options.stateDirectory,'round');
  saved.status='running';saved.stages[2].status='reserved';saved.stages[2].sha256=null;await writeOrderWorkflow(f.options.stateDirectory,saved);f.calls.length=0;
  const result=await runOrderWorkflow(f.options,f.clock);assert.equal(result.status,'complete');assert.deepEqual(f.calls,[]);
});
test('changed completed checkpoint bytes invalidate the chain before cache or browser use',async t=>{
  const f=await fixture(t);await runOrderWorkflow(f.options,f.clock);f.calls.length=0;const file=filename(f,'list');await writeFile(file,(await readFile(file,'utf8'))+'\n');
  await assert.rejects(orderWorkflowStatus(f.options),{code:'INVALID_WORKFLOW_CHECKPOINT'});await assert.rejects(runOrderWorkflow(f.options,f.clock),{code:'INVALID_WORKFLOW_CHECKPOINT'});assert.deepEqual(f.calls,[]);
});
test('the original endpoint remains fixed for every stage',async t=>{
  const f=await fixture(t);await assert.rejects(runOrderWorkflow({...f.options,bridge:{...f.bridge,endpoint:'http://127.0.0.1:19825'}},f.clock),{code:'BINDING_ENDPOINT_MISMATCH'});assert.deepEqual(f.calls,[]);
});
test('workflow operations share the original platform lock with standalone tasks and reject concurrent child stores',async t=>{
  const f=await fixture(t);await withWorkflowPlatform(f.options.stateDirectory,'round',async()=>{},async()=>{
    await assert.rejects(withWorkflowPlatform(f.options.stateDirectory,'round',async()=>{},async()=>{}),{code:'TASK_BUSY'});
    await withTaskStore(f.options.stateDirectory,'round-list',async()=>{await assert.rejects(withTaskStore(f.options.stateDirectory,'round-entry',async()=>{}),{code:'TASK_BUSY'});});
  });assert.deepEqual(f.calls,[]);
});
test('a finished preexisting stage name cannot be adopted into a new workflow',async t=>{
  const f=await fixture(t);await endOrderWorkflow(f.options);await createTask({stateDirectory:f.options.stateDirectory,task:'new-list',orders:true,tabId:41,bridge:f.bridge});
  await runTask({stateDirectory:f.options.stateDirectory,task:'new-list',bridge:f.bridge},f.clock);
  await assert.rejects(createOrderWorkflow({...f.options,workflow:'new'}),{code:'WORKFLOW_TASK_EXISTS'});
});
test('finished unrelated task caches remain readable during another pending workflow',async t=>{
  const f=await fixture(t);await runOrderWorkflow(f.options,f.clock);await createOrderWorkflow({...f.options,workflow:'new'});f.calls.length=0;
  assert.equal((await runTask({stateDirectory:f.options.stateDirectory,task:'round-list',bridge:f.bridge},f.clock)).status,'complete');
  assert.equal((await taskStatus({stateDirectory:f.options.stateDirectory,task:'round-list'})).status,'complete');assert.deepEqual(f.calls,[]);
});
test('completed workflow children remain immutable even when standalone task-end is requested',async t=>{
  const f=await fixture(t),result=await runOrderWorkflow(f.options,f.clock);f.calls.length=0;
  await assert.rejects(endTask({stateDirectory:f.options.stateDirectory,task:'round-body'}),{code:'WORKFLOW_TASK_RESERVED'});
  assert.deepEqual(await orderWorkflowStatus(f.options),result);assert.deepEqual(f.calls,[]);
});
for(const [label,mutate]of Object.entries({
  'changed selected position':value=>{value.order_position=6;},'changed stage name':value=>{value.stages[1].task='other';},
  'inflated recovery budget':value=>{value.limits.explicit_recoveries=3;},'out-of-order stage':value=>{value.stages[1].status='reserved';},
  'invented completed digest':value=>{value.stages[0].status='complete';value.stages[0].sha256='fake';},'extra private property':value=>{value.account='PRIVATE';},
  'invented status':value=>{value.status='partial';},'changed phase':value=>{value.stages[0].phase='body';},
  'lost phase interval':value=>{value.transition_wait_reserved_ms=1500;},'invalid endpoint':value=>{value.endpoint='https://example.test';}
  ,'invented unbounded wait':value=>{value.not_before=Number.MAX_SAFE_INTEGER;}
}))test(`invalid workflow ${label} fails before execution`,async t=>{
  const f=await fixture(t),saved=await readOrderWorkflow(f.options.stateDirectory,'round');mutate(saved);assert.throws(()=>validateOrderWorkflow(saved),{code:'INVALID_WORKFLOW_CHECKPOINT'});
  await writeFile(workflowFile(f),JSON.stringify(saved));await assert.rejects(runOrderWorkflow(f.options,f.clock),{code:'INVALID_WORKFLOW_CHECKPOINT'});assert.deepEqual(f.calls,[]);
});
test('workflow symlinks and oversized checkpoints are rejected without following their content',async t=>{
  const f=await fixture(t),file=workflowFile(f);await unlink(file);await symlink(filename(f,'list'),file);await assert.rejects(orderWorkflowStatus(f.options),{code:'INVALID_WORKFLOW_CHECKPOINT'});
  await unlink(file);await writeFile(file,' '.repeat(16385));await assert.rejects(orderWorkflowStatus(f.options),{code:'INVALID_WORKFLOW_CHECKPOINT'});assert.deepEqual(f.calls,[]);
});
test('CLI validates exact workflow arguments and locally creates, inspects and ends the plan',async t=>{
  const f=await fixture(t);await endOrderWorkflow(f.options);
  const common=['--workflow','cli','--state-dir',f.options.stateDirectory];
  assert.equal((await cli(['order-workflow-start',...common,'--tab','41','--order-position','2'])).status,'workflow_created');
  assert.equal((await cli(['order-workflow-status',...common])).status,'pending');assert.equal((await cli(['order-workflow-end',...common])).status,'ended');
  for(const args of [[],['--after-user','--after-connection']])assert.equal((await cli(['order-workflow-resume',...common,...args])).error.code,'INVALID_RECOVERY');
  for(const addition of [['--task','other'],['--source-task','list'],['--dedicated'],['--order-rows','10']])assert.equal((await cli(['order-workflow-start',...common,'--tab','41','--order-position','2',...addition])).error.code,'INVALID_ARGUMENTS');
  assert.equal((await cli(['order-workflow-start','--workflow','../bad','--tab','41','--order-position','2'])).error.code,'INVALID_WORKFLOW_NAME');assert.deepEqual(f.calls,[]);
});
test('the original platform wait allowance spans completed and future stages and prevents a new click reservation',async t=>{
  const f=await fixture(t);await assert.rejects(runOrderWorkflow(f.options,{...f.clock,wait:async()=>{throw Error('Host interrupted');}}));
  const list=await loadTask(f.options.stateDirectory,'round-list');list.wait_reserved_ms=119999;await writeFile(filename(f,'list'),JSON.stringify(list));
  const saved=await readOrderWorkflow(f.options.stateDirectory,'round');saved.stages[0].sha256=createHash('sha256').update(await readFile(filename(f,'list'))).digest('hex');
  await writeOrderWorkflow(f.options.stateDirectory,saved);const result=await runOrderWorkflow(f.options,f.clock);
  assert.equal(result.status,'stopped');assert.equal(result.error.code,'WORKFLOW_WAIT_LIMIT');assert.equal(result.budget.wait_reserved_ms,119999);assert.equal(result.budget.actions_reserved,0);assert.equal(f.calls.includes('click'),false);
});
test('actual child-process CLI traverses the local mocked bridge and finished caches need no HTTP',async t=>{
  const f=await fixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'shopping workflow cli '));t.after(()=>rm(directory,{recursive:true,force:true}));
  const before={state:'entry_prepared',list_url:orderTarget.url,...f.target,position:2,loaded_groups_seen:5,
    selector:'.trade-main-content .trade-content-container > .trade-bought-list-order-container:nth-child(2) > .trade-bought-list-shop-info :is([class^="shopInfoOrderDetail--"], [class*=" shopInfoOrderDetail--"])',entry_text:'订单详情',target_attribute:'_blank'};
  let opened=false,blocked=false;
  const server=await mockBridge(t,{handler:({req,res,body})=>{
    res.setHeader('Content-Type','application/json');if(blocked){res.statusCode=503;res.end('{}');return;}
    if(req.url==='/status'){res.end(JSON.stringify(playwrightStatus()));return;}
    let data;
    if(body.action==='tab_list')data={tabs:opened?[{id:41,url:orderTarget.url},{id:81,url:f.target.url}]:[{id:41,url:orderTarget.url}]};
    else if(body.action==='snapshot')data={url:orderTarget.url,snapshotData:{refs:{e7:{role:'link',name:'订单详情',backendDOMNodeId:77}}}};
    else if(body.action==='click'){opened=true;data={role:'link',name:'订单详情'};}
    else if(body.action==='eval'){
      if(body.script.includes('collectOrderRows'))data={result:observeOrders(Array.from({length:5},(_,index)=>orderGroup(index+1).group))};
      else if(body.script.includes('prepareEntry'))data={result:before};
      else if(body.script.includes('collectDetailPage'))data={result:{state:'observed',address:{state:'observed',...f.target},page_state:'not_assessed',error_roots_seen:0,error_page:null}};
      else {assert.ok(body.script.includes('collectOrderBody'));data={result:observeDetail({target:f.target,orderId:f.target.order_id,url:f.target.url}).raw};}
    }else assert.fail('Unexpected bridge action');
    res.end(JSON.stringify({id:body.id,success:true,data}));
  }});
  const script=fileURLToPath(new URL('../scripts/shopping.mjs',import.meta.url));
  const command=async args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});child.on('error',reject);
    child.on('close',code=>{try{assert.equal(stderr,'');resolve({code,...JSON.parse(stdout)});}catch(error){reject(error);}});
  });
  const local=['--workflow','cli-round','--state-dir',directory],remote=[...local,'--endpoint',server.endpoint];
  assert.equal((await command(['order-workflow-start',...remote,'--tab','41','--order-position','2'])).status,'workflow_created');assert.equal(server.state.requests.length,0);
  await withWorkflowPlatform(directory,'cli-round',async()=>{},async()=>{
    assert.equal((await command(['order-workflow-run',...remote])).error.code,'TASK_BUSY');assert.equal(server.state.requests.length,0);
  });
  const result=await command(['order-workflow-run',...remote]);assert.equal(result.code,0);assert.equal(result.status,'complete');assert.equal(result.result.observations.body.body.printed_order_id_verified,true);
  assert.equal(server.state.commands.filter(value=>value.action==='click').length,1);assert.equal(server.state.commands.filter(value=>value.action==='eval'&&value.script.includes('collectOrderBody')).length,1);
  const count=server.state.requests.length;blocked=true;
  assert.equal((await command(['order-workflow-run',...remote])).status,'complete');assert.equal((await command(['order-workflow-status',...local])).status,'complete');assert.equal((await command(['order-workflow-end',...local])).status,'complete');
  assert.equal(server.state.requests.length,count);
});
