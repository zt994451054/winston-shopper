import {ShoppingError} from './errors.mjs';
import {normalizeEndpoint} from './bridge.mjs';
import {parseTabId} from './targets.mjs';

export const WORKFLOW_LIMITS=Object.freeze({explicit_recoveries:2,platform_retries:5,cooldown_probes:1,wait_budget_ms:120000});
export const WORKFLOW_PHASES=Object.freeze(['list','entry','body']);
export const WORKFLOW_FINISHED=Object.freeze(['complete','ended']);
const statuses=['pending','running','waiting_user','waiting_connection','waiting_cooldown','stopped',...WORKFLOW_FINISHED];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const invalid=()=>new ShoppingError('INVALID_WORKFLOW_CHECKPOINT','The saved order workflow is invalid. No browser operation was sent.');

/** Validate a workflow filename component, leaving room for its fixed child task suffixes.
 * @param {unknown} name @returns {string} Safe name of 1–48 characters.
 * @throws {ShoppingError} INVALID_WORKFLOW_NAME. @example workflowName('order-read'); */
export function workflowName(name){
  if(typeof name!=='string'||!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name))throw new ShoppingError('INVALID_WORKFLOW_NAME','Use a workflow name with 1–48 lowercase letters, digits, underscores or hyphens.');
  return name;
}

/** Validate metadata without changing saved stage references or interpreting page data.
 * @param {unknown} value @returns {object} Original checkpoint.
 * @throws {ShoppingError} INVALID_WORKFLOW_CHECKPOINT. @example validateOrderWorkflow(saved); */
export function validateOrderWorkflow(value){
  try{
    if(!exact(value,['schema_version','id','kind','platform','endpoint','tab_id','order_position','status','created_at','updated_at','limits','stages','not_before','transition_wait_reserved_ms','error'])||
      value.schema_version!==1||value.kind!=='single_order_workflow'||value.platform!=='taobao'||!statuses.includes(value.status)||
      !timestamp(value.created_at)||!timestamp(value.updated_at)||normalizeEndpoint(value.endpoint)!==value.endpoint||
      !Number.isSafeInteger(value.order_position)||value.order_position<1||value.order_position>5||
      !exact(value.limits,Object.keys(WORKFLOW_LIMITS))||Object.entries(WORKFLOW_LIMITS).some(([key,limit])=>value.limits[key]!==limit)||
      !Number.isSafeInteger(value.not_before)||value.not_before<0||!Array.isArray(value.stages)||value.stages.length!==3)throw invalid();
    workflowName(value.id);parseTabId(value.tab_id);
    let prefix=true,completed=0,reserved=0;
    for(const [index,stage]of value.stages.entries()){
      if(!exact(stage,['phase','task','status','sha256'])||stage.phase!==WORKFLOW_PHASES[index]||stage.task!==`${value.id}-${stage.phase}`||
        !['planned','reserved','complete'].includes(stage.status)||
        (stage.status==='complete'?typeof stage.sha256!=='string'||!/^[0-9a-f]{64}$/.test(stage.sha256):stage.sha256!==null))throw invalid();
      if(stage.status==='complete'){if(!prefix)throw invalid();completed++;}
      else {prefix=false;if(stage.status==='reserved'){if(reserved||value.stages.slice(0,index).some(item=>item.status!=='complete'))throw invalid();reserved++;}}
    }
    if(value.transition_wait_reserved_ms!==Math.min(completed,2)*1500||
      (value.status==='complete')!==(completed===3)||value.status==='complete'&&value.not_before!==0||
      value.status==='ended'&&value.not_before!==0||
      value.not_before>0&&(value.status!=='running'||completed===0||value.not_before>Date.parse(value.updated_at)+1500)||
      value.status==='pending'&&(completed||reserved)||value.status.startsWith('waiting_')&&!reserved||
      value.error!==null&&(!exact(value.error,Object.hasOwn(value.error,'cause')?['code','cause']:['code'])||
        Object.values(value.error).some(code=>typeof code!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)))||
      ['pending','complete'].includes(value.status)&&value.error!==null)throw invalid();
    return value;
  }catch{throw invalid();}
}

/** Derive counters from the original stage tasks; no new allowance is granted by the wrapper.
 * @param {object[]} tasks Present stage checkpoints. @returns {object} Aggregate reservations.
 * @example workflowBudget([listTask,entryTask]); */
export function workflowBudget(tasks){
  return tasks.reduce((budget,task)=>{
    const op=task.operations[0],state=op.order_read??op.order_detail_check??op.order_body_read;
    budget.explicit_recoveries+=state.recoveries_reserved;budget.platform_retries+=task.retries;
    budget.cooldown_probes+=task.cooldown_probes;budget.wait_reserved_ms+=task.wait_reserved_ms;
    budget.content_reads_reserved+=state.reads_reserved??op.attempts;
    budget.inventories_reserved+=state.inventories_reserved??0;budget.executions_reserved+=op.attempts;
    budget.actions_reserved+=Number(op.order_detail_check?.action_reserved??false);
    return budget;
  },{explicit_recoveries:0,platform_retries:0,cooldown_probes:0,wait_reserved_ms:0,content_reads_reserved:0,inventories_reserved:0,executions_reserved:0,actions_reserved:0});
}
