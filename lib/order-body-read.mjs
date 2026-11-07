import {isDeepStrictEqual} from 'node:util';
import {ShoppingError,publicError} from './errors.mjs';
import {createBlockedPageDisplay,displayPausedPage} from './foreground.mjs';
import {parseTabId} from './targets.mjs';
import {savedTabUrl} from './saved-tab.mjs';
import {parseOrderListUrl,parseOrderDetailUrl} from './order-target.mjs';
import {validateOrderDetailCheckTask} from './order-detail-check.mjs';
import {validateSavedOrderDetailBody} from './order-detail-body.mjs';
import {TASK_POLICY,failureCategory,retryDecision} from './task-policy.mjs';

const LIMITS={item_limit:10,read_limit:6,inventory_limit:8,recovery_limit:2,recovery_wait_ms:5000};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const safeName=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const invalid=()=>new ShoppingError('INVALID_CHECKPOINT','The saved single-order body task is invalid. No browser operation was sent.');
const validError=value=>value===null||exact(value,['code','category'])&&typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)&&value.category===failureCategory(value.code);

/**
 * Bind the confirmed new page of one completed navigation check, without reopening or copying list items.
 * @param {object} task Saved navigation/page-state task; not a list, research receipt or previous body task.
 * @returns {object} Minimal source, canonical target and the fixed confirmed detail tab ID.
 * @throws {ShoppingError} ORDER_BODY_SOURCE_UNVERIFIED when the source has no usable confirmed page.
 * @example orderBodySource(completedEntryTask);
 */
export function orderBodySource(task){
  try{
    validateOrderDetailCheckTask(task);
    const op=task.operations[0],result=op.result;
    if(task.status!=='complete'||op.status!=='succeeded'||result.outcome!=='normal_content_unassessed'||!result.opening.navigation_verified||result.page.error_page!==null)throw Error();
    return {source:{task:task.id,observed_at:result.page.observed_at,list:op.source},target:op.target,tab_id:op.order_detail_check.detail_tab_id};
  }catch{throw new ShoppingError('ORDER_BODY_SOURCE_UNVERIFIED','Use one completed navigation check with its confirmed new detail page and no visible supported error panel.');}
}

/** @returns {object} Fixed content/inventory limits and shared explicit recoveries. @example newOrderBodyRead(); */
export function newOrderBodyRead(){return {schema_version:1,...LIMITS,reads_reserved:0,inventories_reserved:0,recoveries_reserved:0,failures:[]};}

/**
 * Validate sources, durable counters and a guarded body before state can influence IO or cached reports.
 * @param {unknown} task Dedicated order_body_snapshot task.
 * @returns {object} Unchanged task; common store separately checks endpoint and referenced files.
 * @throws {ShoppingError} INVALID_CHECKPOINT for changed identity, enlarged limits or invented body claims.
 * @example validateOrderBodyTask(saved);
 */
export function validateOrderBodyTask(task){
  try{
    if(!exact(task,['schema_version','id','kind','platform','endpoint','status','created_at','updated_at','policy','retries','cooldown_probes','wait_reserved_ms','not_before','operations'])||
        task.schema_version!==1||task.kind!=='order_body_snapshot'||task.platform!=='taobao'||!safeName(task.id)||
        !['pending','running','retry_wait','waiting_user','waiting_connection','waiting_cooldown','complete','stopped','ended'].includes(task.status)||
        !timestamp(task.created_at)||!timestamp(task.updated_at)||!isDeepStrictEqual(task.policy,TASK_POLICY)||!integer(task.retries,5)||!integer(task.cooldown_probes,1)||
        !integer(task.wait_reserved_ms,120000)||!integer(task.not_before,Number.MAX_SAFE_INTEGER)||!Array.isArray(task.operations)||task.operations.length!==1)throw invalid();
    const op=task.operations[0],source=op.source,state=op.order_body_read;
    if(!exact(op,['tab_id','target','source','status','attempts','retries','not_before','recovery_kind','error','result','order_body_read'])||
        !exact(source,['task','observed_at','list'])||!safeName(source.task)||source.task===task.id||!timestamp(source.observed_at)||
        !exact(source.list,['task','position','list_url','order_id','observed_at'])||!safeName(source.list.task)||source.list.task===task.id||source.list.task===source.task||
        !Number.isSafeInteger(source.list.position)||source.list.position<1||source.list.position>50||!timestamp(source.list.observed_at)||
        parseOrderListUrl(source.list.list_url)?.url!==source.list.list_url||!isDeepStrictEqual(parseOrderDetailUrl(op.target?.url),op.target)||source.list.order_id!==op.target.order_id||
        !['pending','running','retry_wait','succeeded'].includes(op.status)||!integer(op.attempts,8)||!integer(op.retries,2)||op.attempts<op.retries||
        task.retries!==op.retries+task.cooldown_probes||op.not_before!==0||![null,'user','connection','cooldown'].includes(op.recovery_kind)||!validError(op.error))throw invalid();
    parseTabId(op.tab_id);
    if(!exact(state,Object.keys(newOrderBodyRead()))||state.schema_version!==1||Object.entries(LIMITS).some(([key,value])=>state[key]!==value)||
        !integer(state.reads_reserved,6)||!integer(state.inventories_reserved,8)||!integer(state.recoveries_reserved,2)||
        state.reads_reserved>state.inventories_reserved||state.inventories_reserved>op.attempts||state.recoveries_reserved>op.attempts||
        !Array.isArray(state.failures)||state.failures.length>op.attempts||(op.recovery_kind!==null&&state.recoveries_reserved===0)||
        task.wait_reserved_ms<state.recoveries_reserved*5000+TASK_POLICY.retry_delays_ms.slice(0,op.retries).reduce((a,b)=>a+b,0)||
        op.attempts===0&&!isDeepStrictEqual(state,newOrderBodyRead()))throw invalid();
    let previous=0;
    for(const failure of state.failures){
      if(!exact(failure,['attempt','code','category'])||!Number.isSafeInteger(failure.attempt)||failure.attempt<=previous||failure.attempt>op.attempts||
          ['running','succeeded'].includes(op.status)&&failure.attempt===op.attempts||!validError({code:failure.code,category:failure.category}))throw invalid();
      previous=failure.attempt;
    }
    if(op.status==='succeeded'){
      if(!state.reads_reserved||op.error!==null||op.recovery_kind!==null||!op.result)throw invalid();
      validateSavedOrderDetailBody(op.result.body,op.target);
      if(!isDeepStrictEqual(op.result,{schema_version:1,scope:'single_order_body',source,target:op.target,body:op.result.body}))throw invalid();
    }else if(op.result!==null)throw invalid();
    if((task.status==='complete')!==(op.status==='succeeded')&&task.status!=='ended'||
        op.status==='running'&&(!['running','ended'].includes(task.status)||!op.attempts)||
        task.status==='retry_wait'&&op.status!=='retry_wait'||task.status.startsWith('waiting_')&&op.status!=='pending')throw invalid();
    return task;
  }catch{throw invalid();}
}

function requireBodyTab(address,op){
  if(parseOrderDetailUrl(address)?.url===op.target.url)return;
  let url;try{url=new URL(address);}catch{ /* Unknown routes remain target failures. */ }
  if(url?.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['login.taobao.com','login.tmall.com'].includes(url.hostname))throw new ShoppingError('LOGIN_REQUIRED','Complete login in the saved detail tab.');
  throw new ShoppingError('TARGET_CHANGED','The confirmed detail tab no longer matches the saved route.');
}

async function readBody(bridge,op,commit){
  const state=op.order_body_read;
  state.inventories_reserved++;await commit();
  await bridge.requireConnected();
  requireBodyTab(await savedTabUrl(bridge,op.tab_id,'The confirmed detail tab is neither listed nor reachable. Restore that tab; another same-order page cannot substitute.'),op);
  state.reads_reserved++;await commit();
  const body=await bridge.readOrderDetailBody(op.tab_id,op.target);
  try{validateSavedOrderDetailBody(body,op.target);}catch{throw new ShoppingError('INVALID_RESPONSE','The body adapter returned invalid bounded evidence.');}
  op.result={schema_version:1,scope:'single_order_body',source:op.source,target:op.target,body};
  op.status='succeeded';op.error=null;op.recovery_kind=null;
}

async function fail(task,op,error,commit,now,showPage){
  const code=publicError(error).code,category=failureCategory(code),recovery=op.recovery_kind;
  op.error={code,category};op.order_body_read.failures.push({attempt:op.attempts,code,category});op.status='pending';op.recovery_kind=null;
  if(category==='user')task.status='waiting_user';
  else if(recovery==='cooldown')task.status='stopped';
  else if(category==='connection')task.status='waiting_connection';
  else if(category==='rate')task.status=task.cooldown_probes?'stopped':'waiting_cooldown';
  else if(category==='transient'&&recovery)task.status=`waiting_${recovery}`;
  else if(category==='transient'){
    const retry=retryDecision(task,op);
    if(retry.allowed){op.retries++;task.retries++;task.wait_reserved_ms+=retry.delay_ms;task.not_before=Math.max(task.not_before,now()+retry.delay_ms);op.status='retry_wait';task.status='retry_wait';}
    else task.status='stopped';
  }else task.status='stopped';
  await commit();
  await displayPausedPage({task,op,error,showPage});
}

/**
 * Read or resume one fixed confirmed detail page under the common store lock; all IO reservations precede dispatch.
 * @param {{task:object,bridge:object,commit:()=>Promise<void>,now:()=>number,wait:(ms:number)=>Promise<void>,recovery?:string,showPage?:Function}} options
 * @returns {Promise<void>} Saves the original body or safe failure/counters; no navigation, actions or internal adapter retries.
 * @throws {ShoppingError} Checkpoint IO or interrupted host wait; reservations remain durable.
 * @example await runOrderBodyRead({task,bridge,commit,now,wait});
 */
export async function runOrderBodyRead({task,bridge,commit,now,wait,recovery,showPage=createBlockedPageDisplay(bridge)}){
  const op=task.operations[0],state=op.order_body_read;
  const exhausted=()=>state.reads_reserved>=state.read_limit||state.inventories_reserved>=state.inventory_limit||op.attempts>=8;
  async function stop(code){task.status='stopped';op.error={code,category:failureCategory(code)};await commit();}
  if(recovery){
    if(exhausted()){await stop('ORDER_BODY_BUDGET_LIMIT');return;}
    if(state.recoveries_reserved>=2||task.wait_reserved_ms+5000>TASK_POLICY.wait_budget_ms){await stop(state.recoveries_reserved>=2?'ORDER_BODY_RECOVERY_LIMIT':'WAIT_BUDGET_EXHAUSTED');return;}
    state.recoveries_reserved++;task.wait_reserved_ms+=5000;task.not_before=Math.max(task.not_before,now()+5000);op.recovery_kind=recovery;task.status='running';
    if(recovery==='cooldown'){task.cooldown_probes++;task.retries++;}await commit();
  }
  if(op.status==='running')await fail(task,op,new ShoppingError('READ_INTERRUPTED','A reserved body observation has no committed result.'),commit,now,showPage);
  while(['pending','running','retry_wait'].includes(task.status)){
    const remaining=task.not_before-now();if(remaining>0){await wait(Math.min(remaining,15000));continue;}
    if(exhausted()){await stop('ORDER_BODY_BUDGET_LIMIT');break;}
    op.status='running';op.attempts++;task.status='running';task.not_before=0;await commit();
    try{await readBody(bridge,op,commit);task.status='complete';await commit();}
    catch(error){if(error.code?.startsWith('CHECKPOINT_')||error.code==='INVALID_CHECKPOINT')throw error;await fail(task,op,error,commit,now,showPage);}
  }
}
