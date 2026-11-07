import { isExtensionProtocol } from './bridge-protocol.mjs';
import { createBlockedPageDisplay } from './foreground.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ShoppingError} from './errors.mjs';
import {parseTabId} from './targets.mjs';
import {createTask,runTask,endTask} from './tasks.mjs';
import {loadTask,withTaskStore,withWorkflowPlatform} from './task-store.mjs';
import {orderDetailSource} from './order-detail-check.mjs';
import {orderBodySource} from './order-body-read.mjs';
import {validateRecovery} from './task-policy.mjs';
import {workflowName,validateOrderWorkflow,WORKFLOW_LIMITS,WORKFLOW_PHASES,WORKFLOW_FINISHED,workflowBudget} from './order-workflow-state.mjs';
import {readOrderWorkflow,writeOrderWorkflow,assertWorkflowPlatformIdle} from './order-workflow-store.mjs';

const kinds={list:'order_snapshot',entry:'order_detail_check',body:'order_body_snapshot'};
const invalid=()=>new ShoppingError('INVALID_WORKFLOW_CHECKPOINT','The saved workflow stage or source chain has changed. No browser operation was sent.');
const taskHash=async(directory,name)=>createHash('sha256').update(await readFile(path.join(directory,'tasks',`${name}.json`))).digest('hex');
const defaultWait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function checkStage(workflow,stage,task,tasks){
  const op=task.operations[0];
  if(task.id!==stage.task||task.kind!==kinds[stage.phase]||task.endpoint!==workflow.endpoint||task.browser_session!==undefined)throw invalid();
  if(stage.phase==='list'){
    if(op.tab_id!==workflow.tab_id||op.order_read.schema_version!==1||op.order_read.order_limit!==5)throw invalid();
  }else if(stage.phase==='entry'){
    const record=orderDetailSource(tasks.list,workflow.order_position);
    if(op.tab_id!==workflow.tab_id||!isDeepStrictEqual(op.source,record.source)||!isDeepStrictEqual(op.target,record.target))throw invalid();
  }else{
    const record=orderBodySource(tasks.entry);
    if(op.tab_id!==record.tab_id||!isDeepStrictEqual(op.source,record.source)||!isDeepStrictEqual(op.target,record.target))throw invalid();
  }
}

async function loadStages(directory,workflow){
  const tasks={};
  for(const stage of workflow.stages){
    let task;
    try{task=await loadTask(directory,stage.task);}
    catch(error){if(error.code==='TASK_MISSING'&&stage.status!=='complete')continue;throw invalid();}
    if(stage.status==='planned')throw invalid();
    checkStage(workflow,stage,task,tasks);
    if(stage.status==='complete'&&(task.status!=='complete'||await taskHash(directory,stage.task)!==stage.sha256))throw invalid();
    tasks[stage.phase]=task;
  }
  return tasks;
}

function guardBudget(tasks){
  const budget=workflowBudget(Object.values(tasks));
  const exceeded=budget.explicit_recoveries>WORKFLOW_LIMITS.explicit_recoveries?'RECOVERY_LIMIT':
    budget.platform_retries>WORKFLOW_LIMITS.platform_retries?'RETRY_LIMIT':
    budget.cooldown_probes>WORKFLOW_LIMITS.cooldown_probes?'COOLDOWN_LIMIT':
    budget.wait_reserved_ms>WORKFLOW_LIMITS.wait_budget_ms?'WAIT_LIMIT':null;
  if(exceeded)throw new ShoppingError(`CHECKPOINT_WORKFLOW_${exceeded}`,'The proposed stage reservation exceeds the original workflow budget. No further request was dispatched.');
}

async function commitGuard(directory,name,proposed){
  const workflow=await readOrderWorkflow(directory,name),tasks=await loadStages(directory,workflow);
  const stage=workflow.stages.find(value=>value.task===proposed.id);
  if(!stage||stage.status!=='reserved')throw invalid();
  checkStage(workflow,stage,proposed,tasks);tasks[stage.phase]=proposed;
  try{guardBudget(tasks);}catch(error){
    // A rejected retry reservation can follow a real fault; retain its safe code without dispatching the reservation.
    const cause=proposed.operations[0].error?.code;
    if(cause)error.cause=cause;
    throw error;
  }
}

function report(workflow,tasks){
  const list=tasks.list?.operations[0].result,entry=tasks.entry?.operations[0].result,body=tasks.body?.operations[0].result;
  const row=list?.orders.find(value=>value.position===workflow.order_position)??null;
  const emptyList=list?.schema_version===3&&list.coverage.empty_orders_verified===true&&list.orders.length===0;
  const listObservation=row?{task:tasks.list.id,observed_at:list.observed_at,order:row,coverage:list.coverage}:
    emptyList?{task:tasks.list.id,observed_at:list.observed_at,order:null,empty_evidence:list.empty_evidence,coverage:list.coverage}:null;
  return {ok:WORKFLOW_FINISHED.includes(workflow.status),workflow:workflow.id,workflow_kind:workflow.kind,status:workflow.status,
    selected_position:workflow.order_position,current_stage:workflow.stages.find(stage=>stage.status!=='complete')?.phase??'done',
    created_at:workflow.created_at,updated_at:workflow.updated_at,error:workflow.error,
    budget:{...workflowBudget(Object.values(tasks)),limits:workflow.limits,transition_wait_reserved_ms:workflow.transition_wait_reserved_ms},
    stages:workflow.stages.map(stage=>{const task=tasks[stage.phase],op=task?.operations[0];return {phase:stage.phase,task:stage.task,status:task?.status??stage.status,
      budget:op?.order_read??op?.order_detail_check??op?.order_body_read??null,attempts:op?.attempts??0,automatic_retries:task?.retries??0,
      wait_reserved_ms:task?.wait_reserved_ms??0,error:op?.error??null};}),
    result:{schema_version:1,scope:'single_order_read_workflow',observations:{list:listObservation,entry:entry??null,body:body??null},
      coverage:{workflow_complete:workflow.status==='complete',full_order_items_verified:false,account_identity_verified:false,settlement_verified:false,local_only:true}},
    next_action:WORKFLOW_FINISHED.includes(workflow.status)?'Return the saved observations only; unused stage budgets are not additional work.':
      workflow.status==='stopped'?'Inspect the saved failure and partial observations. Only explicitly ending this round releases its reservation.':
      workflow.status.startsWith('waiting_')?'Resolve the saved stage condition, then use order-workflow-resume with its matching after-* flag.':
      'Run order-workflow-run with this same workflow name and state directory.'};
}

/** Create a local plan for one of the first five loaded orders, without browser access.
 * @param {{stateDirectory:string,workflow:string,tabId:number,orderPosition:number,bridge:object}} options
 * @returns {Promise<object>} Fixed plan identity. @throws {ShoppingError} Invalid options, existing names or unfinished platform work.
 * @example createOrderWorkflow({stateDirectory,workflow:'one-order',tabId:41,orderPosition:2,bridge}); */
export async function createOrderWorkflow({stateDirectory,workflow:name,tabId,orderPosition,bridge}){
  workflowName(name);parseTabId(tabId);
  if(!isExtensionProtocol(bridge.protocol)||!Number.isSafeInteger(orderPosition)||orderPosition<1||orderPosition>5)throw new ShoppingError('INVALID_ARGUMENTS','Choose an explicit order position from 1 to 5 and its original extension list tab.');
  return withWorkflowPlatform(stateDirectory,name,()=>{throw invalid();},async()=>{
    try{await readOrderWorkflow(stateDirectory,name);throw new ShoppingError('WORKFLOW_EXISTS','This workflow already exists. Its stage names and budgets cannot be reset.');}
    catch(error){if(error.code!=='WORKFLOW_MISSING')throw error;}
    await assertWorkflowPlatformIdle(stateDirectory,name);
    await withTaskStore(stateDirectory,`${name}-list`,store=>store.assertPlatformIdle());
    for(const phase of WORKFLOW_PHASES){try{await loadTask(stateDirectory,`${name}-${phase}`);throw new ShoppingError('WORKFLOW_TASK_EXISTS','A fixed stage name already exists; it cannot be adopted or replaced.');}catch(error){if(error.code!=='TASK_MISSING')throw error;}}
    const at=new Date().toISOString(),workflow={schema_version:1,id:name,kind:'single_order_workflow',platform:'taobao',endpoint:bridge.endpoint,
      tab_id:tabId,order_position:orderPosition,status:'pending',created_at:at,updated_at:at,limits:{...WORKFLOW_LIMITS},
      stages:WORKFLOW_PHASES.map(phase=>({phase,task:`${name}-${phase}`,status:'planned',sha256:null})),not_before:0,transition_wait_reserved_ms:0,error:null};
    await writeOrderWorkflow(stateDirectory,workflow);
    return {ok:true,status:'workflow_created',workflow:name,scope:'one_of_first_five_loaded_orders',selected_position:orderPosition,next_action:'Run order-workflow-run with this saved workflow name.'};
  });
}

/** Read saved progress, original observations and budgets without any browser or state mutation.
 * @param {{stateDirectory:string,workflow:string}} options @returns {Promise<object>} Validated report.
 * @throws {ShoppingError} Missing or changed workflow/stage files. @example orderWorkflowStatus({stateDirectory,workflow:'one-order'}); */
export async function orderWorkflowStatus({stateDirectory,workflow:name}){
  const workflow=await readOrderWorkflow(stateDirectory,name),tasks=await loadStages(stateDirectory,workflow);guardBudget(tasks);return report(workflow,tasks);
}

async function createStage(directory,workflow,stage,bridge){
  const options={stateDirectory:directory,task:stage.task,bridge};
  if(stage.phase==='list')Object.assign(options,{orders:true,tabId:workflow.tab_id});
  else if(stage.phase==='entry')Object.assign(options,{orderDetail:true,sourceTask:workflow.stages[0].task,orderPosition:workflow.order_position,tabId:workflow.tab_id});
  else Object.assign(options,{orderBody:true,sourceTask:workflow.stages[1].task});
  await createTask(options);
}

/** Execute the fixed three-stage chain; recover the original paused child only and retain every reservation.
 * @param {{stateDirectory:string,workflow:string,bridge:object,recovery?:string}} options
 * @param {{now?:()=>number,wait?:(ms:number)=>Promise<void>}} clock Injectable offline clock.
 * @returns {Promise<object>} Original per-stage observations, failure and aggregate budget.
 * @throws {ShoppingError} Invalid source/recovery, concurrent work or checkpoint failure. Host wait interruption preserves state.
 * @example runOrderWorkflow({stateDirectory,workflow:'one-order',bridge}); */
export async function runOrderWorkflow({stateDirectory,workflow:name,bridge,recovery},{now=Date.now,wait=defaultWait}={}){
  workflowName(name);
  return withWorkflowPlatform(stateDirectory,name,task=>commitGuard(stateDirectory,name,task),async()=>{
    const workflow=await readOrderWorkflow(stateDirectory,name);let tasks=await loadStages(stateDirectory,workflow);guardBudget(tasks);
    if(WORKFLOW_FINISHED.includes(workflow.status)||workflow.status==='stopped'){
      if(recovery)throw new ShoppingError('INVALID_RECOVERY','A finished or stopped workflow cannot receive new recovery allowances.');
      return report(workflow,tasks);
    }
    if(!isExtensionProtocol(bridge.protocol)||bridge.endpoint!==workflow.endpoint)throw new ShoppingError('BINDING_ENDPOINT_MISMATCH','Restore the saved workflow endpoint and original extension connection.');
    const commit=async()=>{workflow.updated_at=new Date(now()).toISOString();await writeOrderWorkflow(stateDirectory,workflow);};
    const showPage=createBlockedPageDisplay(bridge);
    const stop=async(code,cause)=>{workflow.status='stopped';workflow.error={code,...(cause?{cause}:{})};await commit();return report(workflow,tasks);};
    for(const stage of workflow.stages){
      if(stage.status==='complete')continue;
      let child=tasks[stage.phase];
      if(recovery&&!child)throw new ShoppingError('INVALID_RECOVERY','No saved workflow stage is waiting for recovery.');
      if(child)validateRecovery(child,recovery);
      if(['stopped','partial','ended'].includes(child?.status))return stop(child.operations[0].error?.code??'WORKFLOW_STAGE_UNAVAILABLE');
      if(child?.status!=='complete'){
        let blockedTabId;
        const remaining=workflow.not_before-now();if(remaining>0)await wait(remaining);
        workflow.not_before=0;workflow.status='running';workflow.error=null;
        if(stage.status==='planned')stage.status='reserved';await commit();
        try{
          if(!child)await createStage(stateDirectory,workflow,stage,bridge);
          // The parent pause must be durable too before a window is brought forward for user assistance.
          await runTask({stateDirectory,task:stage.task,bridge,recovery,showPage:async tabId=>{blockedTabId=tabId;return false;}},{now,wait});
        }catch(error){
          if(error.code?.startsWith('CHECKPOINT_WORKFLOW_')){tasks=await loadStages(stateDirectory,workflow);return stop(error.code.slice('CHECKPOINT_'.length),error.cause);}
          if(error.code==='ORDER_BODY_SOURCE_UNVERIFIED'||error.code==='ORDER_DETAIL_SOURCE_UNVERIFIED')return stop(error.code);
          throw error;
        }
        recovery=undefined;tasks=await loadStages(stateDirectory,workflow);child=tasks[stage.phase];
        if(child.status!=='complete'){
          workflow.status=child.status.startsWith('waiting_')?child.status:'stopped';workflow.error=child.operations[0].error?{code:child.operations[0].error.code}:null;
          await commit();await showPage(blockedTabId);return report(workflow,tasks);
        }
      }
      stage.status='complete';stage.sha256=await taskHash(stateDirectory,stage.task);
      if(stage.phase==='body'){workflow.status='complete';workflow.error=null;workflow.not_before=0;}
      else{workflow.status='running';workflow.transition_wait_reserved_ms+=1500;workflow.not_before=now()+1500;}
      await commit();
    }
    return report(workflow,tasks);
  });
}

/** Explicitly end this workflow and its unfinished child, preserving observations, budgets and source references.
 * @param {{stateDirectory:string,workflow:string}} options @returns {Promise<object>} Cached ended/complete report.
 * @throws {ShoppingError} Concurrent or changed state. @example endOrderWorkflow({stateDirectory,workflow:'one-order'}); */
export async function endOrderWorkflow({stateDirectory,workflow:name}){
  workflowName(name);
  return withWorkflowPlatform(stateDirectory,name,task=>commitGuard(stateDirectory,name,task),async()=>{
    const workflow=await readOrderWorkflow(stateDirectory,name);let tasks=await loadStages(stateDirectory,workflow);
    if(WORKFLOW_FINISHED.includes(workflow.status))return report(workflow,tasks);
    const active=workflow.stages.find(stage=>stage.status==='reserved'),child=active&&tasks[active.phase];
    if(child&&!['complete','ended'].includes(child.status))await endTask({stateDirectory,task:active.task});
    tasks=await loadStages(stateDirectory,workflow);workflow.status='ended';workflow.not_before=0;workflow.updated_at=new Date().toISOString();
    await writeOrderWorkflow(stateDirectory,workflow);return report(workflow,tasks);
  });
}
