import { mkdir, open, readFile, lstat, rename, unlink, readdir } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { assertWorkflowTaskAccess, assertWorkflowPlatformIdle } from './order-workflow-store.mjs';
import { validateLayoutEvidence } from './layout-evidence.mjs';
import { normalizeEndpoint } from './bridge.mjs';
import { parseProductUrl, parseTabId } from './targets.mjs';
import { parseCartUrl } from './cart-target.mjs';
import { validateCartReadState } from './cart-read.mjs';
import { parseOrderListUrl } from './order-target.mjs';
import { validateOrderReadState } from './order-read.mjs';
import { validateSavedOrderRows } from './order-rows.mjs';
import { validateOrderCollection } from './order-collection.mjs';
import { validateOrderPagesState, validateOrderPagesResult } from './order-pages.mjs';
import { validateOrderDetailCheckTask, orderDetailSource } from './order-detail-check.mjs';
import { validateOrderBodyTask, orderBodySource } from './order-body-read.mjs';
import { validateSavedCartRows } from './cart-rows.mjs';
import { validateCartCollection } from './cart-collection.mjs';
import { TASK_POLICY } from './task-policy.mjs';
import { acquireTaskLock } from './task-lock.mjs';
import { validateSavedProduct } from './product.mjs';
import { TASK_STATUSES as STATUSES, OPERATION_STATUSES as OP_STATUSES, integer, timestamp, validError } from './task-checks.mjs';
import { normalizeSelection, selectionKey, validateSelectionState, validateSelectedResult } from './selections.mjs';
import { searchTarget } from './search.mjs';
import { validateReadActionState, validateReadActionResult } from './read-action.mjs';
import { validateServiceReadState, validateServiceReadResult } from './service-read.mjs';
import { validateDescriptionReadState, validateDescriptionReadResult } from './description-read.mjs';
import { validateDescriptionImageState, validateDescriptionImageResult } from './description-image-read.mjs';
import { validateSavedDetails } from './details.mjs';
import { validateSavedGallery } from './gallery.mjs';
import { validateSavedSpecificationImages, specificationImageContinuation } from './specification-images.mjs';
import { validateSpecificationImageBatches, specificationImageBatchResult } from './specification-image-batches.mjs';
import { validateSpecificationCollection, specificationCollectionPlan, specificationCollectionResult } from './specification-collection.mjs';
import { validateSearchPagesState, validateSearchPagesResult } from './search-pages.mjs';
import { validateSearchCollectionState, validateSearchCollectionResult } from './search-collection.mjs';
import { validateSearchSortState, validateSearchSortResult } from './search-sort.mjs';
import { validateSearchPriceState, validateSearchPriceResult } from './search-price.mjs';
import { validateSavedSearchControls } from './search-controls.mjs';
import { validatePriceEntryState, validatePriceEntryResult } from './price-entry.mjs';
import { validateReviewCategoryState, validateReviewCategoryResult } from './review-category-read.mjs';
import { validateMainImageState, validateMainImageResult } from './main-image-read.mjs';
import { validateJdTask } from './jd/task-state.mjs';
import { validatePddTask } from './pdd/task-state.mjs';

const MAX_BYTES = 4194304;
const COLLECTION_MAX_BYTES = 33554432;
const workflowContext = new AsyncLocalStorage();

function invalid() { return new ShoppingError('INVALID_CHECKPOINT', 'The task checkpoint is invalid or incompatible. No browser operation was sent.'); }

/** @param {string} name @returns {string} A safe task filename component. @throws {ShoppingError} INVALID_TASK_NAME. */
export function taskName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new ShoppingError('INVALID_TASK_NAME', 'Use a task name with 1–64 lowercase letters, digits, underscores, or hyphens.');
  }
  return name;
}

/**
 * Validate persisted execution state before it can affect a browser or budgets.
 * @param {unknown} task @returns {object} Validated state.
 * @throws {ShoppingError} INVALID_CHECKPOINT.
 */
export function validateTask(task) {
  try {
    if (typeof task?.kind === 'string' && task.kind.startsWith('jd_')) {
      validateJdTask(task);
      taskName(task.id);
      return task;
    }
    if (typeof task?.kind === 'string' && task.kind.startsWith('pdd_')) {
      validatePddTask(task);
      taskName(task.id);
      return task;
    }
    if (task?.kind === 'order_body_snapshot') {
      validateOrderBodyTask(task);
      taskName(task.id);
      if (normalizeEndpoint(task.endpoint) !== task.endpoint) throw invalid();
      return task;
    }
    if (task?.kind === 'order_detail_check') {
      validateOrderDetailCheckTask(task);
      taskName(task.id);
      if (normalizeEndpoint(task.endpoint) !== task.endpoint) throw invalid();
      return task;
    }
    if (task?.schema_version !== 1 || task.platform !== 'taobao' || !['order_snapshot', 'order_collection', 'order_pages', 'cart_snapshot', 'cart_collection', 'product_snapshot', 'product_selection', 'search', 'search_pages', 'search_collection', 'search_sort', 'search_price', 'search_controls', 'search_price_entry', 'search_price_hover', 'product_reviews', 'product_review_categories', 'product_details', 'product_services', 'product_description_expansion', 'product_description_image_loading', 'product_main_images', 'product_gallery', 'product_specification_images'].includes(task.kind) ||
        !STATUSES.includes(task.status) || !timestamp(task.created_at) || !timestamp(task.updated_at) ||
        !integer(task.retries, 5) || !integer(task.wait_reserved_ms, 120000) || !integer(task.cooldown_probes, 1) ||
        !integer(task.not_before, Number.MAX_SAFE_INTEGER) ||
        JSON.stringify(task.policy) !== JSON.stringify(TASK_POLICY) ||
        !Array.isArray(task.operations) || task.operations.length < 1 || task.operations.length > ({ order_snapshot: 1, order_collection: 1, order_pages: 1, cart_snapshot: 1, cart_collection: 1, product_selection: 20, product_snapshot: 50, search: 1, search_pages: 1, search_collection: 1, search_sort: 1, search_price: 1, search_controls: 1, search_price_entry: 1, search_price_hover: 1, product_reviews: 10, product_review_categories: 1, product_details: 10, product_services: 10, product_description_expansion: 1, product_description_image_loading: 1, product_main_images: 1, product_gallery: 1, product_specification_images: 1 }[task.kind])) throw invalid();
    taskName(task.id);
    if (['cart_snapshot', 'cart_collection', 'order_snapshot', 'order_collection', 'order_pages', 'search_collection', 'search_price'].includes(task.kind) && Object.keys(task).some(key => ![
      'schema_version', 'id', 'kind', 'platform', 'endpoint', 'status', 'created_at', 'updated_at',
      'policy', 'retries', 'cooldown_probes', 'wait_reserved_ms', 'not_before', 'operations', 'browser_session',
    ].includes(key))) throw invalid();
    if (task.layout_diagnostics_version !== undefined && (task.layout_diagnostics_version !== 1 || task.kind !== 'product_snapshot')) throw invalid();
    if (task.browser_session !== undefined && task.browser_session !== 'dedicated') throw invalid();
    if (normalizeEndpoint(task.endpoint) !== task.endpoint) throw invalid();
    const keys = new Set();
    let retries = task.cooldown_probes;
    for (const op of task.operations) {
      if (['order_snapshot', 'order_collection', 'order_pages', 'search_collection', 'search_price'].includes(task.kind) && !Object.hasOwn(op, 'recovery_kind')) throw invalid();
      op.recovery_kind ??= null;
      const searching = ['search', 'search_pages', 'search_collection', 'search_sort', 'search_price', 'search_controls', 'search_price_entry', 'search_price_hover'].includes(task.kind);
      const paging = task.kind === 'search_pages';
      const collectingSearch = task.kind === 'search_collection';
      const readingAction = ['search', 'search_controls', 'product_reviews'].includes(task.kind);
      const cart = ['cart_snapshot', 'cart_collection'].includes(task.kind);
      const pagingOrders = task.kind === 'order_pages';
      const orders = ['order_snapshot', 'order_collection', 'order_pages'].includes(task.kind);
      const collectingOrders = task.kind === 'order_collection';
      const collectingCart = task.kind === 'cart_collection';
      const target = orders ? parseOrderListUrl(op.target?.url) : cart ? parseCartUrl(op.target?.url) : searching ? searchTarget(op.target?.query) : parseProductUrl(op.target?.url);
      if (pagingOrders) {
        const expectedKeys = ['attempts', 'order_pages', 'error', 'not_before', 'recovery_kind', 'result', 'retries', 'status', 'tab_id', 'target'];
        if (Object.keys(op).sort().join(',') !== expectedKeys.sort().join(',')) throw invalid();
        validateOrderPagesState(op.order_pages, target, op);
        const automaticWait = op.retries === 0 ? 0 : 5000 + (op.retries === 2 ? 15000 : 0);
        if (task.wait_reserved_ms < op.order_pages.recoveries_reserved * op.order_pages.recovery_wait_ms + automaticWait) throw invalid();
      } else if (op.order_pages !== undefined) throw invalid();
      if (orders && !pagingOrders) {
        const expectedKeys = ['attempts', 'order_read', 'error', 'not_before', 'recovery_kind', 'result', 'retries', 'status', 'tab_id', 'target', ...(collectingOrders ? ['order_collection'] : [])];
        if (Object.keys(op).sort().join(',') !== expectedKeys.sort().join(',') || op.order_read?.schema_version !== (collectingOrders ? 2 : 1)) throw invalid();
        validateOrderReadState(op.order_read, op);
        if (task.wait_reserved_ms < op.order_read.recoveries_reserved * op.order_read.recovery_wait_ms) throw invalid();
        if (collectingOrders) validateOrderCollection(op.order_collection, target, op, task.status);
      } else if (op.order_read !== undefined || op.order_collection !== undefined) throw invalid();
      if (cart) {
        const expectedKeys = ['attempts', 'cart_read', 'error', 'not_before', 'recovery_kind', 'result', 'retries', 'status', 'tab_id', 'target', ...(collectingCart ? ['cart_collection'] : [])];
        if (Object.keys(op).sort().join(',') !== expectedKeys.sort().join(',') || op.cart_read?.schema_version !== (collectingCart ? 2 : 1)) throw invalid();
        validateCartReadState(op.cart_read, op);
        if (collectingCart) validateCartCollection(op.cart_collection, target, op, task.status);
      }
      else if (op.cart_read !== undefined || op.cart_collection !== undefined) throw invalid();
      const selecting = task.kind === 'product_selection';
      if (selecting) {
        if (JSON.stringify(normalizeSelection(op.selection)) !== JSON.stringify(op.selection)) throw invalid();
        validateSelectionState(op.selection_state, op.selection);
      }
      if (op.specification_image_batches !== undefined) {
        if (task.kind !== 'product_specification_images') throw invalid();
        validateSpecificationImageBatches(op.specification_image_batches, target, op.attempts);
        if (task.status === 'awaiting_batch' && (op.status !== 'pending' || op.error !== null || !op.specification_image_batches.batches.length ||
            op.specification_image_batches.batches.length >= op.specification_image_batches.batch_limit ||
            !specificationImageContinuation(op.specification_image_batches.batches, target))) throw invalid();
      } else if (task.status === 'awaiting_batch' && !collectingCart && !collectingOrders) throw invalid();
      if (op.specification_collection !== undefined) {
        if (task.kind !== 'product_specification_images' || op.specification_image_batches !== undefined) throw invalid();
        validateSpecificationCollection(op.specification_collection, target, op.attempts);
      }
      if (task.kind === 'product_services') validateServiceReadState(op.service_read, target);
      else if (op.service_read !== undefined) throw invalid();
      if (task.kind === 'product_description_expansion') validateDescriptionReadState(op.description_read, target);
      else if (op.description_read !== undefined) throw invalid();
      if (task.kind === 'product_description_image_loading') validateDescriptionImageState(op.description_image_read, target);
      else if (op.description_image_read !== undefined) throw invalid();
      if (task.kind === 'product_main_images') validateMainImageState(op.main_image_read, target, op.main_images);
      else if (op.main_image_read !== undefined || op.main_images !== undefined) throw invalid();
      if (task.kind === 'product_review_categories') validateReviewCategoryState(op.category_read, target, op.review_categories);
      else if (op.category_read !== undefined || op.review_categories !== undefined) throw invalid();
      if (readingAction) validateReadActionState(op.read_action);
      if (task.kind === 'search_controls' && (op.read_action.action_reserved || op.read_action.checks || op.read_action.not_before)) throw invalid();
      if (!readingAction && op.read_action !== undefined) throw invalid();
      if (paging) validateSearchPagesState(op.search_pages, target);
      else if (op.search_pages !== undefined) throw invalid();
      if (collectingSearch) {
        const expectedKeys = ['attempts', 'search_collection', 'error', 'not_before', 'recovery_kind', 'result', 'retries', 'status', 'tab_id', 'target'];
        if (Object.keys(op).sort().join(',') !== expectedKeys.sort().join(',')) throw invalid();
        validateSearchCollectionState(op.search_collection, target, op);
        const automaticWait = op.retries === 0 ? 0 : 5000 + (op.retries === 2 ? 15000 : 0);
        if (task.wait_reserved_ms < op.search_collection.recoveries_reserved * op.search_collection.recovery_wait_ms + automaticWait) throw invalid();
      } else if (op.search_collection !== undefined) throw invalid();
      if (['search_price_entry', 'search_price_hover'].includes(task.kind)) validatePriceEntryState(op.price_entry, target, task.kind === 'search_price_hover');
      else if (op.price_entry !== undefined) throw invalid();
      if (task.kind === 'search_sort') validateSearchSortState(op.search_sort, target);
      else if (op.search_sort !== undefined) throw invalid();
      if (task.kind === 'search_price') {
        const expectedKeys = ['attempts', 'error', 'not_before', 'recovery_kind', 'result', 'retries', 'search_price', 'status', 'tab_id', 'target'];
        if (Object.keys(op).sort().join(',') !== expectedKeys.join(',') || task.browser_session !== undefined) throw invalid();
        validateSearchPriceState(op.search_price, target);
      } else if (op.search_price !== undefined) throw invalid();
      const key = cart || orders || searching ? target?.url : selecting ? selectionKey(target?.product_id, op.selection) : target?.product_id;
      if (!target || target.url !== op.target.url || target.product_id !== op.target.product_id ||
          JSON.stringify(target) !== JSON.stringify(op.target) || keys.has(key) ||
          !OP_STATUSES.includes(op.status) || !(cart || orders || collectingSearch ? [null, 'user', 'cooldown', 'connection'] : [null, 'user', 'cooldown']).includes(op.recovery_kind) ||
          !integer(op.attempts, op.specification_collection?.schema_version === 3 ? 2403 : 1000) || !integer(op.retries, 2) ||
          op.attempts < op.retries || !integer(op.not_before, Number.MAX_SAFE_INTEGER) ||
          !validError(op.error) ||
          (op.status === 'succeeded' ? !op.result || op.result.product_id !== target.product_id : op.result !== null)) throw invalid();
      parseTabId(op.tab_id);
      if (op.layout_evidence !== undefined) {
        if (task.layout_diagnostics_version !== 1 || op.error?.code !== 'PAGE_STRUCTURE_CHANGED' ||
            op.error.reason !== op.layout_evidence.reason || op.attempts < 1 || !['stopped', 'ended'].includes(task.status)) throw invalid();
        validateLayoutEvidence(op.layout_evidence, target);
      }
      if (op.layout_evidence_error !== undefined && (op.layout_evidence_error !== 'COLLECTION_FAILED' ||
          op.layout_evidence !== undefined || task.layout_diagnostics_version !== 1 || op.error?.code !== 'PAGE_STRUCTURE_CHANGED' ||
          op.attempts < 1 || !['stopped', 'ended'].includes(task.status))) throw invalid();
      if (op.result) {
        if (pagingOrders) validateOrderPagesResult(op.result, target, op.order_pages);
        else if (orders) { if (!collectingOrders) validateSavedOrderRows(op.result, target); }
        else if (cart) { if (!collectingCart) validateSavedCartRows(op.result, target); }
        else if (task.kind === 'product_main_images') validateMainImageResult(op.result, target, op.main_images, op.main_image_read);
        else if (task.kind === 'product_review_categories') validateReviewCategoryResult(op.result, target, op.review_categories, op.category_read);
        else if (['search_price_entry', 'search_price_hover'].includes(task.kind)) validatePriceEntryResult(op.result, target, op.price_entry, task.kind === 'search_price_hover');
        else if (task.kind === 'search_controls') validateSavedSearchControls(op.result, target);
        else if (task.kind === 'search_sort') validateSearchSortResult(op.result, target, op.search_sort);
        else if (task.kind === 'search_price') validateSearchPriceResult(op.result, target, op.search_price);
        else if (paging) validateSearchPagesResult(op.result, target, op.search_pages);
        else if (collectingSearch) validateSearchCollectionResult(op.result, target, op.search_collection);
        else if (readingAction) validateReadActionResult(op.result, target, task.kind, op.read_action);
        else if (task.kind === 'product_services') validateServiceReadResult(op.result, target, op.service_read);
        else if (task.kind === 'product_description_expansion') validateDescriptionReadResult(op.result, target, op.description_read);
        else if (task.kind === 'product_description_image_loading') validateDescriptionImageResult(op.result, target, op.description_image_read);
        else if (task.kind === 'product_specification_images') {
          if (op.specification_collection) {
            const result = specificationCollectionResult(op.specification_collection, target);
            if (specificationCollectionPlan(op.specification_collection) || !result.coverage.scanned_supported_image_links_complete ||
                JSON.stringify(result) !== JSON.stringify(op.result)) throw invalid();
          } else if (op.specification_image_batches) {
            const result = specificationImageBatchResult(op.specification_image_batches, target);
            if (!result.coverage.scanned_image_options_sampled || JSON.stringify(result) !== JSON.stringify(op.result)) throw invalid();
          } else validateSavedSpecificationImages(op.result, target);
        }
        else if (task.kind === 'product_gallery') validateSavedGallery(op.result, target);
        else if (task.kind === 'product_details') validateSavedDetails(op.result, target);
        else if (selecting) validateSelectedResult(op.result, target, op.selection, op.selection_state);
        else validateSavedProduct(op.result, target);
      }
      keys.add(key);
      retries += op.retries;
    }
    if (task.retries !== retries || task.operations.filter(op => op.status === 'running').length > 1) throw invalid();
    const finished = task.operations.every(op => ['succeeded', 'failed'].includes(op.status));
    if (['complete', 'partial'].includes(task.status) !== finished && !['stopped', 'ended'].includes(task.status)) throw invalid();
    if (task.status === 'complete' && task.operations.some(op => op.status !== 'succeeded')) throw invalid();
    return task;
  } catch { throw invalid(); }
}

async function readTask(filename) {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > COLLECTION_MAX_BYTES) throw invalid();
    const task = validateTask(JSON.parse(await readFile(filename, 'utf8')));
    if (stat.size > checkpointByteLimit(task)) throw invalid();
    return task;
  } catch (error) {
    if (error instanceof ShoppingError) throw error;
    if (error.code === 'ENOENT') throw new ShoppingError('TASK_MISSING', 'No checkpoint exists for this task.');
    throw invalid();
  }
}

async function writeTask(filename, task) {
  validateTask(task);
  const text = JSON.stringify(task, null, 2);
  if (Buffer.byteLength(text) + 1 > checkpointByteLimit(task)) throw new ShoppingError('CHECKPOINT_TOO_LARGE', 'The public task result exceeds the checkpoint size limit.');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try { await file.writeFile(`${text}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, filename);
  } catch (error) {
    if (error instanceof ShoppingError) throw error;
    throw new ShoppingError('CHECKPOINT_WRITE_FAILED', 'The task could not be checkpointed; execution stopped.');
  } finally {
    if (created) await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw new ShoppingError('CHECKPOINT_CLEANUP_FAILED', 'A temporary checkpoint could not be removed.');
    });
  }
}

function checkpointByteLimit(task) {
  return task.operations.some(op => op.specification_collection?.schema_version === 3 || op.order_pages) ? COLLECTION_MAX_BYTES : MAX_BYTES;
}

/**
 * Load a task without acquiring the execution lock. Atomic commits give a coherent view.
 * @param {string} directory Binding state directory. @param {string} name
 * @returns {Promise<object>} Checkpoint, containing only scoped public results.
 * @throws {ShoppingError} TASK_MISSING or INVALID_CHECKPOINT.
 */
export async function loadTask(directory, name) {
  const task = await readTask(path.join(directory, 'tasks', `${taskName(name)}.json`));
  if (task.id !== name) throw invalid();
  let detailSource = task.kind === 'order_detail_check' ? task : null;
  if (task.kind === 'order_body_snapshot') {
    const op = task.operations[0];
    try {
      detailSource = await readTask(path.join(directory, 'tasks', `${taskName(op.source.task)}.json`));
      const expected = orderBodySource(detailSource);
      if (detailSource.id !== op.source.task || detailSource.endpoint !== task.endpoint ||
          !isDeepStrictEqual(expected.source, op.source) || !isDeepStrictEqual(expected.target, op.target) || expected.tab_id !== op.tab_id) throw invalid();
    } catch { throw invalid(); }
  }
  if (detailSource) {
    const op = detailSource.operations[0];
    try {
      const source = await readTask(path.join(directory, 'tasks', `${taskName(op.source.task)}.json`));
      const expected = orderDetailSource(source, op.source.position);
      if (source.id !== op.source.task || source.endpoint !== detailSource.endpoint || source.browser_session !== undefined ||
          !isDeepStrictEqual(expected.source, op.source) || !isDeepStrictEqual(expected.target, op.target)) throw invalid();
    } catch { throw invalid(); }
  }
  return task;
}

// Each platform runs one task at a time; an unfinished task on one platform does not hold the other. Names stay unique across both.
async function assertPlatformIdle(root, platform, newFilename = null) {
  for (const entry of (await readdir(root)).filter(item => item.endsWith('.json'))) {
    if (entry === newFilename) throw new ShoppingError('TASK_EXISTS', 'This task already exists. Run or resume it; its counters cannot be reset.');
    const previous = await readTask(path.join(root, entry));
    if (previous.platform === platform && !['complete', 'partial', 'ended'].includes(previous.status)) {
      throw new ShoppingError('PLATFORM_TASK_UNFINISHED', 'A previous platform task is unfinished or stopped.',
        'Check that task with task-status and tell the user why it stopped; resume it, or end it only if the user agrees. Do not create another name to evade the stop.');
    }
  }
}

/**
 * Serialize all tasks sharing this directory; recover only confirmed dead local locks.
 * @param {string} directory @param {string} name
 * @param {(store: object) => Promise<unknown>} action The only holder of the platform lock.
 * @returns {Promise<unknown>} Action result.
 * @throws {ShoppingError} TASK_BUSY, state errors, or the action's failure.
 */
export async function withTaskStore(directory, name, action) {
  taskName(name);
  const root = path.join(directory, 'tasks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ShoppingError('INVALID_STATE_DIRECTORY', 'Task state must use a real directory.');
  const context = workflowContext.getStore();
  if (context && (context.root !== path.resolve(root) || context.childActive)) throw new ShoppingError('TASK_BUSY', 'Workflow stage tasks must execute sequentially in the original state directory.');
  const release = context ? null : await acquireTaskLock(root, name);
  if (context) context.childActive = true;
  try {
    const filename = path.join(root, `${name}.json`);
    return await action({
      async load() { await assertWorkflowTaskAccess(directory, name, context?.owner ?? null); return loadTask(directory, name); },
      async save(task) {
        await assertWorkflowTaskAccess(directory, name, context?.owner ?? null, false, true);
        if (context) await context.beforeSave(task);
        return writeTask(filename, task);
      },
      // Image export and order workflows are Taobao-only.
      async assertPlatformIdle() { await assertWorkflowPlatformIdle(directory, context?.owner ?? null); await assertPlatformIdle(root, 'taobao'); },
      async create(task) {
        await assertWorkflowTaskAccess(directory, name, context?.owner ?? null, true);
        // Order workflows are Taobao work, so they hold only Taobao tasks.
        if (task.platform === 'taobao') await assertWorkflowPlatformIdle(directory, context?.owner ?? null);
        await assertPlatformIdle(root, task.platform, `${name}.json`);
        if (context) await context.beforeSave(task);
        await writeTask(filename, task);
      },
    });
  } finally {
    if (context) context.childActive = false;
    else await release();
  }
}

/** Hold the existing platform lock across one workflow and its sequential stage transactions.
 * @param {string} directory Shared state directory. @param {string} owner Saved workflow name.
 * @param {(task:object)=>Promise<void>} beforeSave Validate stage ownership and aggregate reservations before commits.
 * @param {()=>Promise<unknown>} action Workflow operation; nested stage stores reuse this lock.
 * @returns {Promise<unknown>} @throws {ShoppingError} TASK_BUSY or state/commit failures.
 * @example withWorkflowPlatform(directory,name,guard,async()=>runStages()); */
export async function withWorkflowPlatform(directory, owner, beforeSave, action) {
  taskName(owner);
  if (workflowContext.getStore()) throw new ShoppingError('TASK_BUSY', 'An order workflow cannot nest another workflow.');
  const root = path.join(directory, 'tasks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ShoppingError('INVALID_STATE_DIRECTORY', 'Task state must use a real directory.');
  const release = await acquireTaskLock(root, owner);
  try { return await workflowContext.run({root:path.resolve(root),owner,childActive:false,beforeSave}, action); }
  finally { await release(); }
}
