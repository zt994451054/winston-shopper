import {mkdir,lstat,readdir,readFile,open,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ShoppingError} from './errors.mjs';
import {workflowName,validateOrderWorkflow,WORKFLOW_FINISHED} from './order-workflow-state.mjs';

const directory=root=>path.join(root,'order-workflows');
const invalid=()=>new ShoppingError('INVALID_WORKFLOW_CHECKPOINT','The saved order workflow is invalid. No browser operation was sent.');

async function rootExists(root){
  try{const info=await lstat(directory(root));if(!info.isDirectory()||info.isSymbolicLink())throw invalid();return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}

/** Read bounded metadata; absent workflow directories leave legacy state untouched.
 * @param {string} root Shared state directory. @param {string} name
 * @returns {object} Validated checkpoint. @throws {ShoppingError} WORKFLOW_MISSING or INVALID_WORKFLOW_CHECKPOINT.
 * @example readOrderWorkflow(stateDirectory,'order-read'); */
export async function readOrderWorkflow(root,name){
  workflowName(name);
  try{
    if(!await rootExists(root))throw new ShoppingError('WORKFLOW_MISSING','No checkpoint exists for this workflow.');
    const filename=path.join(directory(root),`${name}.json`),info=await lstat(filename);
    if(!info.isFile()||info.isSymbolicLink()||info.size>16384)throw invalid();
    const workflow=validateOrderWorkflow(JSON.parse(await readFile(filename,'utf8')));
    if(workflow.id!==name)throw invalid();return workflow;
  }catch(error){if(error instanceof ShoppingError)throw error;if(error.code==='ENOENT')throw new ShoppingError('WORKFLOW_MISSING','No checkpoint exists for this workflow.');throw invalid();}
}

/** Atomically commit metadata while the caller holds the original platform lock.
 * @param {string} root @param {object} workflow @returns {Promise<void>}
 * @throws {ShoppingError} CHECKPOINT_WRITE_FAILED or INVALID_WORKFLOW_CHECKPOINT.
 * @example writeOrderWorkflow(stateDirectory,workflow); */
export async function writeOrderWorkflow(root,workflow){
  validateOrderWorkflow(workflow);
  await mkdir(directory(root),{recursive:true,mode:0o700});await rootExists(root);
  const temporary=path.join(directory(root),`.${randomUUID()}.tmp`),filename=path.join(directory(root),`${workflow.id}.json`);
  let created=false;
  try{
    const file=await open(temporary,'wx',0o600);created=true;
    try{await file.writeFile(JSON.stringify(workflow,null,2)+'\n');await file.sync();}finally{await file.close();}
    await rename(temporary,filename);
  }catch{throw new ShoppingError('CHECKPOINT_WRITE_FAILED','The order workflow could not be checkpointed; execution stopped.');}
  finally{if(created)await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw new ShoppingError('CHECKPOINT_CLEANUP_FAILED','A temporary workflow checkpoint could not be removed.');});}
}

async function workflows(root){
  if(!await rootExists(root))return [];
  const result=[];for(const file of await readdir(directory(root)))if(file.endsWith('.json'))result.push(await readOrderWorkflow(root,file.slice(0,-5)));return result;
}

/** Enforce workflow ownership before a stage task can execute or be created.
 * @param {string} root @param {string} task @param {string|null} owner @param {boolean} creating @param {boolean} mutating
 * @returns {Promise<void>} @throws {ShoppingError} WORKFLOW_TASK_RESERVED or PLATFORM_WORKFLOW_UNFINISHED.
 * @example assertWorkflowTaskAccess(root,'order-read-list','order-read',true); */
export async function assertWorkflowTaskAccess(root,task,owner,creating=false,mutating=false){
  for(const workflow of await workflows(root)){
    const stage=workflow.stages.find(item=>item.task===task);
    if(stage&&(creating||mutating||!WORKFLOW_FINISHED.includes(workflow.status))){
      if(owner!==workflow.id||stage.status!=='reserved')throw new ShoppingError('WORKFLOW_TASK_RESERVED','Use the original order workflow command for this reserved stage.');
    }
    if(creating&&!WORKFLOW_FINISHED.includes(workflow.status)&&owner!==workflow.id)throw new ShoppingError('PLATFORM_WORKFLOW_UNFINISHED','A previous order workflow is unfinished or stopped. Resume that workflow without changing its name.');
  }
}

/** Block a new platform task/workflow while another workflow is unfinished, including stopped.
 * @param {string} root @param {string|null} owner @returns {Promise<void>}
 * @throws {ShoppingError} PLATFORM_WORKFLOW_UNFINISHED. @example assertWorkflowPlatformIdle(root,null); */
export async function assertWorkflowPlatformIdle(root,owner){
  for(const workflow of await workflows(root))if(!WORKFLOW_FINISHED.includes(workflow.status)&&workflow.id!==owner)throw new ShoppingError('PLATFORM_WORKFLOW_UNFINISHED','A previous order workflow is unfinished or stopped. Inspect and resume or explicitly end it.');
}
