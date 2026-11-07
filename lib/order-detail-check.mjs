import { isDeepStrictEqual } from 'node:util';
import { ShoppingError, publicError } from './errors.mjs';
import { createBlockedPageDisplay, displayPausedPage } from './foreground.mjs';
import { parseTabId } from './targets.mjs';
import { parseOrderListUrl, parseOrderDetailUrl } from './order-target.mjs';
import { validateOrderDetailEntry, ENTRY_REFUSAL_REASONS } from './order-detail-entry.mjs';
import { validateSavedOrderDetailPage } from './order-detail-page.mjs';
import { TASK_POLICY, failureCategory, retryDecision } from './task-policy.mjs';

const LIMITS = { read_limit:8, inventory_limit:6, recovery_limit:2, recovery_wait_ms:5000 };
const finished = new Set(['complete','partial','stopped','ended']);
const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const safeName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const invalid = () => new ShoppingError('INVALID_CHECKPOINT', 'The single-order check checkpoint is invalid. No browser operation was sent.');

function validError(value) {
  return value === null || (exact(value, ['code','category']) && typeof value.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) && value.category === failureCategory(value.code));
}

/**
 * Bind one printed order and its observed link from a completed, validated list task; no browser access.
 * @param {object} task Validated list task. @param {number} position Saved position (1–50).
 * @returns {{source:object,target:object,tab_id:number}} Minimal local provenance, without item/contact data.
 * @throws {ShoppingError} INVALID_ARGUMENTS or ORDER_DETAIL_SOURCE_UNVERIFIED.
 * @example orderDetailSource(savedListTask, 2);
 */
export function orderDetailSource(task, position) {
  if (!Number.isSafeInteger(position) || position < 1 || position > 50) throw new ShoppingError('INVALID_ARGUMENTS', 'Choose one saved order position from 1 to 50.');
  const op = task?.operations?.[0];
  if (!['order_snapshot','order_collection'].includes(task?.kind) || task.status !== 'complete' || op?.status !== 'succeeded') {
    throw new ShoppingError('ORDER_DETAIL_SOURCE_UNVERIFIED', 'Use one completed, validated buyer order-list task.');
  }
  const row = op.result.orders.find(order => order.position === position);
  const target = parseOrderDetailUrl(row?.detail_entry.url);
  if (!row?.detail_entry.order_binding_verified || !target || target.order_id !== row.order_id) {
    throw new ShoppingError('ORDER_DETAIL_SOURCE_UNVERIFIED', 'The selected saved position has no directly bound detail entry.');
  }
  return { source:{ task:task.id, position, list_url:op.target.url, order_id:row.order_id,
    observed_at:row.observed_at ?? op.result.observed_at }, target, tab_id:op.tab_id };
}

/** @returns {object} Fixed finite budgets and an empty single-click journal. @example newOrderDetailCheck(); */
export function newOrderDetailCheck() {
  return { schema_version:1, ...LIMITS, reads_reserved:0, inventories_reserved:0, recoveries_reserved:0,
    phase:'prepare', before:null, prior_tab_ids:null, action_reserved:false, action_outcome:null, action_error:null,
    normal_wait_reserved_ms:0, detail_tab_id:null, page:null, failures:[] };
}

/**
 * @param {object} op Saved single-order operation.
 * @returns {object} Navigation/page-state result; never normal order fields or settlement proof.
 * @example orderDetailCheckResult(op);
 */
export function orderDetailCheckResult(op) {
  const state = op.order_detail_check;
  return { schema_version:1, scope:'single_order_navigation_and_page_state', source:op.source, target:op.target,
    outcome:state.page.page_state === 'error' ? 'page_unavailable' : 'normal_content_unassessed',
    opening:{ method:'extension_mouse_click', action_outcome:state.action_outcome, action_error:state.action_error,
      navigation_verified:true, opening_causality_verified:false, detail_tab_id:state.detail_tab_id },
    page:state.page, coverage:{ normal_detail_fields_read:false, printed_order_id_verified:false,
      account_identity_verified:false, settlement_verified:false, contact_fields_read:false, local_only:true } };
}

/**
 * Validate the whole dedicated task before it can influence IO, counters or cached results.
 * @param {unknown} task Single-order page-check task.
 * @returns {object} Unchanged task. Endpoint validation and task locking stay in the common store.
 * @throws {ShoppingError} INVALID_CHECKPOINT for incompatible state or an invented association/coverage.
 * @example validateOrderDetailCheckTask(saved);
 */
export function validateOrderDetailCheckTask(task) {
  try {
    const top = ['schema_version','id','kind','platform','endpoint','status','created_at','updated_at','policy','retries','cooldown_probes','wait_reserved_ms','not_before','operations'];
    if (!exact(task, top) || task.schema_version !== 1 || task.kind !== 'order_detail_check' || task.platform !== 'taobao' || !safeName(task.id) ||
        !['pending','running','retry_wait','waiting_user','waiting_connection','waiting_cooldown','complete','stopped','ended'].includes(task.status) ||
        !timestamp(task.created_at) || !timestamp(task.updated_at) || !isDeepStrictEqual(task.policy, TASK_POLICY) ||
        !integer(task.retries, 5) || !integer(task.cooldown_probes, 1) || !integer(task.wait_reserved_ms, 120000) ||
        !integer(task.not_before, Number.MAX_SAFE_INTEGER) || !Array.isArray(task.operations) || task.operations.length !== 1) throw invalid();
    const op = task.operations[0], state = op.order_detail_check, source = op.source;
    if (!exact(op, ['tab_id','target','source','status','attempts','retries','not_before','recovery_kind','error','result','order_detail_check']) ||
        !exact(source, ['task','position','list_url','order_id','observed_at']) || !safeName(source.task) || source.task === task.id ||
        !Number.isSafeInteger(source.position) || source.position < 1 || source.position > 50 || !timestamp(source.observed_at) ||
        parseOrderListUrl(source.list_url)?.url !== source.list_url || !isDeepStrictEqual(parseOrderDetailUrl(op.target?.url), op.target) || source.order_id !== op.target.order_id ||
        !['pending','running','retry_wait','succeeded'].includes(op.status) || !integer(op.attempts, 8) || !integer(op.retries, 2) ||
        task.retries !== op.retries + task.cooldown_probes || op.attempts < op.retries || !integer(op.not_before, Number.MAX_SAFE_INTEGER) ||
        ![null,'user','connection','cooldown'].includes(op.recovery_kind) || !validError(op.error)) throw invalid();
    parseTabId(op.tab_id);
    if (!exact(state, Object.keys(newOrderDetailCheck())) || state.schema_version !== 1 || Object.entries(LIMITS).some(([key,value]) => state[key] !== value) ||
        !integer(state.reads_reserved, LIMITS.read_limit) || !integer(state.inventories_reserved, LIMITS.inventory_limit) || !integer(state.recoveries_reserved, LIMITS.recovery_limit) ||
        !['prepare','open','reconcile','page','done'].includes(state.phase) || typeof state.action_reserved !== 'boolean' ||
        ![null,'acknowledged','uncertain','not_dispatched'].includes(state.action_outcome) || !validError(state.action_error) ||
        ![0,5000].includes(state.normal_wait_reserved_ms) || !Array.isArray(state.failures) || state.failures.length > op.attempts ||
        (op.recovery_kind !== null && state.recoveries_reserved === 0) ||
        task.wait_reserved_ms < state.normal_wait_reserved_ms + state.recoveries_reserved * 5000 + TASK_POLICY.retry_delays_ms.slice(0,op.retries).reduce((a,b) => a+b, 0)) throw invalid();
    if (op.attempts === 0 && !isDeepStrictEqual(state, newOrderDetailCheck()) ||
        state.before !== null && (state.reads_reserved < 1 || state.inventories_reserved < 1) ||
        state.action_reserved && state.action_outcome === null && !['running','ended'].includes(task.status)) throw invalid();
    let attempt = 0;
    for (const failure of state.failures) {
      // A refused entry may carry one fixed reason (added 2026-10-12); earlier records have none.
      const withReason = Object.hasOwn(failure, 'reason');
      if (!exact(failure, ['attempt','phase','code','category', ...(withReason ? ['reason'] : [])]) ||
          (withReason && (failure.code !== 'UNSUPPORTED_CAPABILITY' || !['prepare','open'].includes(failure.phase) || !ENTRY_REFUSAL_REASONS.includes(failure.reason))) ||
          !Number.isSafeInteger(failure.attempt) || failure.attempt <= attempt || failure.attempt > op.attempts ||
          !['prepare','open','reconcile','page'].includes(failure.phase) || !validError({ code:failure.code, category:failure.category })) throw invalid();
      attempt = failure.attempt;
    }
    if (state.before !== null) validateOrderDetailEntry(state.before, {url:source.list_url}, op.target, source.position);
    if ((state.phase === 'prepare') !== (state.before === null) || (state.action_reserved !== ['reconcile','page','done'].includes(state.phase)) ||
        (state.action_reserved ? state.reads_reserved < 4 || state.inventories_reserved < 2 || state.normal_wait_reserved_ms !== 5000 :
          state.action_outcome !== null || state.action_error !== null || state.prior_tab_ids !== null || state.normal_wait_reserved_ms !== 0) ||
        (state.action_outcome === 'acknowledged' && state.action_error !== null) ||
        (['uncertain','not_dispatched'].includes(state.action_outcome) && state.action_error === null)) throw invalid();
    if (state.action_reserved) {
      if (!Array.isArray(state.prior_tab_ids) || !state.prior_tab_ids.length || state.prior_tab_ids.length > 2000 ||
          !state.prior_tab_ids.includes(op.tab_id) || new Set(state.prior_tab_ids).size !== state.prior_tab_ids.length) throw invalid();
      state.prior_tab_ids.forEach(parseTabId);
    }
    if (['page','done'].includes(state.phase)) {
      parseTabId(state.detail_tab_id);
      if (state.prior_tab_ids.includes(state.detail_tab_id) && state.detail_tab_id !== op.tab_id || state.action_outcome === 'not_dispatched') throw invalid();
    } else if (state.detail_tab_id !== null) throw invalid();
    if (state.phase === 'done') {
      validateSavedOrderDetailPage(state.page, op.target);
      if (state.reads_reserved < 5 || state.inventories_reserved < 4 || !['acknowledged','uncertain'].includes(state.action_outcome)) throw invalid();
    } else if (state.page !== null) throw invalid();
    if (op.status === 'succeeded' ? state.phase !== 'done' || !isDeepStrictEqual(op.result, orderDetailCheckResult(op)) || op.error !== null || op.recovery_kind !== null : op.result !== null) throw invalid();
    if ((task.status === 'complete') !== (op.status === 'succeeded') && task.status !== 'ended' ||
        op.status === 'running' && (task.status !== 'running' && task.status !== 'ended' || op.attempts === 0)) throw invalid();
    return task;
  } catch { throw invalid(); }
}

async function reserve(op, key, amount, commit) {
  const state = op.order_detail_check, limit = key === 'reads_reserved' ? state.read_limit : state.inventory_limit;
  if (state[key] + amount > limit) throw new ShoppingError('ORDER_DETAIL_BUDGET_LIMIT', 'The saved single-order check budget is exhausted.');
  state[key] += amount;
  await commit();
}

async function inventory(bridge, op, commit) {
  await reserve(op, 'inventories_reserved', 1, commit);
  await bridge.requireConnected();
  return bridge.listTabs();
}

function requireTab(tabs, id, target, parser) {
  const tab = tabs.find(value => value.id === id);
  if (!tab) throw new ShoppingError('TARGET_MISSING', 'The saved tab is absent from the current window.');
  if (parser(tab.url)?.url === target.url) return;
  let url;
  try { url = new URL(tab.url); } catch { /* Unsupported addresses follow the target-change path. */ }
  if (url?.protocol === 'https:' && ['login.taobao.com','login.tmall.com'].includes(url.hostname)) throw new ShoppingError('LOGIN_REQUIRED', 'Complete login in the saved tab.');
  throw new ShoppingError('TARGET_CHANGED', 'The selected tab no longer matches the saved route.');
}

async function prepare(bridge, op, commit) {
  const list = {url:op.source.list_url}, state = op.order_detail_check;
  requireTab(await inventory(bridge, op, commit), op.tab_id, list, parseOrderListUrl);
  await reserve(op, 'reads_reserved', 1, commit);
  state.before = validateOrderDetailEntry(await bridge.inspectOrderDetailEntry(op.tab_id, list, op.target, op.source.position), list, op.target, op.source.position);
  state.phase = 'open';
  await commit();
}

async function open(bridge, task, op, commit, now) {
  const state = op.order_detail_check, list = {url:op.source.list_url};
  const tabs = await inventory(bridge, op, commit);
  requireTab(tabs, op.tab_id, list, parseOrderListUrl);
  if (task.wait_reserved_ms + 5000 > TASK_POLICY.wait_budget_ms) throw new ShoppingError('WAIT_BUDGET_EXHAUSTED', 'The saved wait budget is exhausted.');
  // Persist the entire adapter preparation and click intent together before any of its IO.
  if (state.reads_reserved + 3 > state.read_limit) throw new ShoppingError('ORDER_DETAIL_BUDGET_LIMIT', 'Insufficient budget for the guarded mouse preparation.');
  state.reads_reserved += 3;
  state.prior_tab_ids = tabs.map(tab => parseTabId(tab.id));
  state.action_reserved = true; state.phase = 'reconcile'; state.normal_wait_reserved_ms = 5000;
  task.wait_reserved_ms += 5000; task.not_before = now() + 5000;
  await commit();
  try {
    const ack = await bridge.openOrderDetailEntry(op.tab_id, list, op.target, state.before);
    if (!isDeepStrictEqual(ack, {clicked:true,navigation_verified:false})) throw new ShoppingError('INVALID_RESPONSE', 'The mouse acknowledgement is invalid.');
    state.action_outcome = 'acknowledged';
  } catch (error) {
    const code = publicError(error).code;
    state.action_error = {code,category:failureCategory(code)};
    state.action_outcome = error.actionNotDispatched ? 'not_dispatched' : 'uncertain';
    if (error.actionNotDispatched) { await commit(); throw error; }
  }
  task.not_before = now() + 5000;
  await commit();
}

async function reconcile(bridge, op, commit) {
  const state = op.order_detail_check;
  if (state.action_outcome === 'not_dispatched') throw new ShoppingError('ORDER_DETAIL_ACTION_NOT_DISPATCHED', 'Preparation stopped before clicking; its intent is sealed.');
  const tabs = await inventory(bridge, op, commit);
  const matches = orderDetailMatchingTabs(op, tabs);
  if (matches.length > 1) throw new ShoppingError('ORDER_DETAIL_NAVIGATION_AMBIGUOUS', 'Multiple new matching pages cannot be safely attributed.');
  if (!matches.length) throw new ShoppingError('TARGET_MISSING', 'No unique new matching detail page was found in the current window.');
  state.detail_tab_id = parseTabId(matches[0].id); state.phase = 'page';
  await commit();
}

/**
 * Filter fresh metadata without borrowing a previously open detail tab or substituting a known result tab.
 * @param {object} op Validated operation. @param {object[]} tabs Current-window inventory.
 * @returns {object[]} Allowed exact-route candidates; no page reads or state changes.
 * @example orderDetailMatchingTabs(op, tabs);
 */
export function orderDetailMatchingTabs(op, tabs) {
  const state = op.order_detail_check;
  if (!state.action_reserved) return tabs.filter(tab => parseOrderListUrl(tab.url)?.url === op.source.list_url);
  return tabs.filter(tab => parseOrderDetailUrl(tab.url)?.url === op.target.url &&
    (state.detail_tab_id === null ? !state.prior_tab_ids.includes(tab.id) || tab.id === op.tab_id : tab.id === state.detail_tab_id));
}

async function readPage(bridge, op, commit) {
  const state = op.order_detail_check;
  requireTab(await inventory(bridge, op, commit), state.detail_tab_id, op.target, parseOrderDetailUrl);
  await reserve(op, 'reads_reserved', 1, commit);
  const page = await bridge.readOrderDetailPageState(state.detail_tab_id, op.target);
  try { validateSavedOrderDetailPage(page, op.target); }
  catch { throw new ShoppingError('INVALID_RESPONSE', 'The detail adapter returned invalid page-state evidence.'); }
  state.page = page; state.phase = 'done';
  op.result = orderDetailCheckResult(op); op.status = 'succeeded'; op.error = null; op.recovery_kind = null;
}

async function fail(task, op, error, commit, now, showPage) {
  const state = op.order_detail_check, code = publicError(error).code, category = failureCategory(code), recovery = op.recovery_kind;
  op.error = {code,category};
  state.failures.push({attempt:op.attempts,phase:state.phase,code,category,
    ...(code === 'UNSUPPORTED_CAPABILITY' && ENTRY_REFUSAL_REASONS.includes(error.entryReason) ? {reason:error.entryReason} : {})});
  op.status = 'pending'; op.recovery_kind = null;
  if (state.action_outcome === 'not_dispatched' || ['ORDER_DETAIL_BUDGET_LIMIT','WAIT_BUDGET_EXHAUSTED'].includes(code)) task.status = 'stopped';
  else if (category === 'user') task.status = 'waiting_user';
  else if (recovery === 'cooldown') task.status = 'stopped';
  else if (category === 'connection') task.status = 'waiting_connection';
  else if (category === 'rate') task.status = task.cooldown_probes ? 'stopped' : 'waiting_cooldown';
  else if (category === 'transient' && recovery) task.status = `waiting_${recovery}`;
  else if (category === 'transient') {
    const retry = retryDecision(task, op);
    if (retry.allowed) {
      op.retries++; task.retries++; task.wait_reserved_ms += retry.delay_ms;
      task.not_before = Math.max(task.not_before, now() + retry.delay_ms);
      op.status = 'retry_wait'; task.status = 'retry_wait';
    } else task.status = 'stopped';
  } else task.status = 'stopped';
  await commit();
  await displayPausedPage({ task, op, error, showPage });
}

/**
 * Execute or resume the dedicated single-order navigation/page check under the common platform lock.
 * @param {{task:object,bridge:object,commit:()=>Promise<void>,now:()=>number,wait:(ms:number)=>Promise<void>,recovery?:string,nextBatch?:boolean,showPage?:Function}} options
 * @returns {Promise<void>} Commits all reservations, pauses and observations; never repeats a reserved mouse action.
 * @throws {ShoppingError} Invalid recovery, checkpoint IO, or an interrupted host wait. No hidden retries.
 * @example await runOrderDetailCheck({task,bridge,commit,now,wait});
 */
export async function runOrderDetailCheck({task,bridge,commit,now,wait,recovery,nextBatch,showPage=createBlockedPageDisplay(bridge)}) {
  if (finished.has(task.status)) return;
  if (nextBatch) throw new ShoppingError('INVALID_RECOVERY', 'A single-order check has no additional batch.');
  const op = task.operations[0], state = op.order_detail_check;
  if (recovery) {
    if (state.recoveries_reserved >= 2 || task.wait_reserved_ms + 5000 > TASK_POLICY.wait_budget_ms) {
      const code = state.recoveries_reserved >= 2 ? 'ORDER_DETAIL_RECOVERY_LIMIT' : 'WAIT_BUDGET_EXHAUSTED';
      task.status = 'stopped'; op.error = {code,category:failureCategory(code)}; await commit(); return;
    }
    state.recoveries_reserved++; task.wait_reserved_ms += 5000;
    task.not_before = Math.max(task.not_before, now() + 5000); op.recovery_kind = recovery; task.status = 'running';
    if (recovery === 'cooldown') { task.cooldown_probes++; task.retries++; }
    await commit();
  }
  if (op.status === 'running') {
    if (state.action_reserved && state.action_outcome === null) {
      state.action_outcome = 'uncertain'; state.action_error = {code:'READ_INTERRUPTED',category:'transient'};
    }
    await fail(task, op, new ShoppingError('READ_INTERRUPTED', 'A previous check has no committed result.'), commit, now, showPage);
  }
  while (['pending','running','retry_wait'].includes(task.status)) {
    const remaining = task.not_before - now();
    if (remaining > 0) { await wait(Math.min(remaining,15000)); continue; }
    if (op.attempts >= 8) { task.status = 'stopped'; op.error = {code:'ORDER_DETAIL_ATTEMPT_LIMIT',category:'diagnostic'}; await commit(); break; }
    op.status = 'running'; op.attempts++; task.status = 'running'; task.not_before = 0;
    await commit();
    let hostWaiting = false;
    try {
      if (state.phase === 'prepare') await prepare(bridge, op, commit);
      if (state.phase === 'open') await open(bridge, task, op, commit, now);
      const remainingWait = task.not_before - now();
      if (remainingWait > 0) { hostWaiting = true; await wait(remainingWait); hostWaiting = false; }
      if (state.phase === 'reconcile') await reconcile(bridge, op, commit);
      if (state.phase === 'page') await readPage(bridge, op, commit);
      task.status = 'complete'; task.not_before = 0; await commit();
    } catch (error) {
      if (hostWaiting || error.code?.startsWith('CHECKPOINT_') || error.code === 'INVALID_CHECKPOINT') throw error;
      await fail(task, op, error, commit, now, showPage);
    }
  }
}
