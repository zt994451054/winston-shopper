import { isExtensionProtocol, requireLiveTaskChannel } from './bridge-protocol.mjs';
import { createBlockedPageDisplay, displayPausedPage } from './foreground.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { newServiceReadState, runServiceRead } from './service-read.mjs';
import { newDescriptionReadState, runDescriptionRead } from './description-read.mjs';
import { newDescriptionImageState, runDescriptionImageRead } from './description-image-read.mjs';
import { ShoppingError, publicError } from './errors.mjs';
import { validateLayoutEvidence } from './layout-evidence.mjs';
import { isProductStructureReason } from './product.mjs';
import { loadBinding } from './state.mjs';
import { createJdTask } from './jd/tasks.mjs';
import { JD_TASK_KINDS } from './jd/task-state.mjs';
import { PDD_TASK_KINDS } from './pdd/task-state.mjs';
import { createPddTask } from './pdd/tasks.mjs';
import { runPddProductRead } from './pdd/product-read.mjs';
import { runPddReviewsRead } from './pdd/reviews-read.mjs';
import { runPddSpecPricesRead } from './pdd/spec-prices-read.mjs';
import { runPddOrderDetailRead } from './pdd/order-detail-read.mjs';
import { runPddSortRead } from './pdd/search-sort-read.mjs';
import { runJdProductRead } from './jd/product-read.mjs';
import { runJdOrderDetailRead } from './jd/order-detail-read.mjs';
import { runJdSearchPagesRead } from './jd/search-pages-read.mjs';
import { runJdSearchSortRead } from './jd/search-sort-read.mjs';
import { PAGE_NOT_VISIBLE_NEXT_ACTION } from './jd/review-categories.mjs';
import { partialJdReviewSamples, runJdReviewRead } from './jd/review-read.mjs';
import { loadTask, taskName, withTaskStore } from './task-store.mjs';
import { TASK_POLICY, failureCategory, retryDecision, validateRecovery } from './task-policy.mjs';
import { loadSelectionPlan } from './selection-plan.mjs';
import { newSelectionState, selectionKey, readSelectedProduct } from './selections.mjs';
import { searchTarget, parseSearchUrl, parseSearchPageUrl, parseSortableSearchUrl } from './search.mjs';
import { parseTabId } from './targets.mjs';
import { parseCartUrl } from './cart-target.mjs';
import { newCartReadState, runCartRead } from './cart-read.mjs';
import { parseOrderListUrl } from './order-target.mjs';
import { newOrderReadState, runOrderRead } from './order-read.mjs';
import { newOrderDetailCheck, orderDetailSource, runOrderDetailCheck } from './order-detail-check.mjs';
import { newOrderBodyRead, orderBodySource, runOrderBodyRead } from './order-body-read.mjs';
import { newOrderCollection, orderCollectionPlan, orderCollectionResult, runOrderCollection } from './order-collection.mjs';
import { newCartCollection, cartCollectionPlan, cartCollectionResult, runCartCollection } from './cart-collection.mjs';
import { MAX_ORDER_PAGES, newOrderPagesState, runOrderPages, orderPagesCachedResult, invalidateOrderPagesCandidate } from './order-pages.mjs';
import { newReadActionState, runReadAction } from './read-action.mjs';
import { runSearchPages, searchPagesTargets } from './search-pages.mjs';
import { newSearchCollectionState, runSearchCollection, searchCollectionTargets, searchCollectionCachedResult, invalidateSearchCollectionCandidate } from './search-collection.mjs';
import { parseSearchRangeUrl } from './search-page-range.mjs';
import { newSearchSortState, runSearchSort, matchesSearchSort } from './search-sort.mjs';
import { newSearchPriceState, runSearchPrice } from './search-price.mjs';
import { createSearchPriceRequest } from './search-price-request.mjs';
import { runSearchControls } from './search-controls.mjs';
import { newPriceEntryState, runPriceEntry } from './price-entry.mjs';
import { loadReviewCategoryPlan } from './review-category-plan.mjs';
import { newReviewCategoryState, runReviewCategories } from './review-category-read.mjs';
import { unconfirmedReviewObservations } from './review-observations.mjs';
import { reviewPanelLifecycleEvidence } from './review-panel-lifecycle.mjs';
import { loadMainImagePlan } from './main-image-plan.mjs';
import { newMainImageState, runMainImages, mainImageSamples, unconfirmedMainImageObservations } from './main-image-read.mjs';

import { specificationImageBatchResult } from './specification-image-batches.mjs';
import { specificationImageContinuation } from './specification-images.mjs';
import { newSpecificationCollection, specificationCollectionPlan, reserveSpecificationCollectionRead,
  acceptSpecificationCollectionRead, specificationCollectionResult } from './specification-collection.mjs';

const FINISHED = new Set(['complete', 'partial', 'stopped', 'ended']);
// Saved waits longer than this come only from a used-up pacing quota; the run returns instead of sleeping in-process.
const PACING_HOLD_RETURN_MS = 60000;
const pacingHeld = task => task.status === 'pending' && task.operations.some(op => op.error?.code === 'PACING_LIMIT');

function boundedReadBudget(op) { return op.order_read ?? op.cart_read ?? op.search_collection ?? op.order_pages ?? null; }
function boundedReadCode(op, suffix) { return `${op.order_read || op.order_pages ? 'ORDER' : op.cart_read ? 'CART' : 'SEARCH'}_${suffix}`; }

function finishIfDone(task) {
  if (task.operations.every(op => ['succeeded', 'failed'].includes(op.status))) {
    task.status = task.operations.every(op => op.status === 'succeeded') ? 'complete' : 'partial';
    task.not_before = 0;
    return true;
  }
  return false;
}

function report(task) {
  const completed = task.operations.filter(op => op.status === 'succeeded');
  const failed = task.operations.filter(op => op.status === 'failed');
  return {
    ok: task.status === 'complete', status: task.status, task: task.id, platform: task.platform, task_kind: task.kind,
    // Search, cart and order tasks bind no product, so a per-product count does not apply (null rather than a misleading 0).
    total_operations: task.operations.length, distinct_products: task.operations.some(op => op.target.product_id)
      ? new Set(task.operations.map(op => op.target.product_id).filter(Boolean)).size : null,
    completed: completed.length, failed: failed.length, remaining: task.operations.length - completed.length - failed.length,
    automatic_retries: task.retries, cooldown_probes: task.cooldown_probes,
    wait_reserved_ms: task.wait_reserved_ms, policy: task.policy,
    not_before: task.not_before ? new Date(task.not_before).toISOString() : null,
    operations: task.operations.map(op => ({ ...(['cart_snapshot', 'cart_collection', 'jd_cart'].includes(task.kind) ? { cart_url: op.target.url }
      : ['order_detail_check', 'order_body_snapshot'].includes(task.kind) ? { order_detail_url: op.target.url, source: op.source }
      : ['order_snapshot', 'order_collection', 'order_pages', 'jd_orders', 'pdd_orders'].includes(task.kind) ? { order_list_url: op.target.url }
      : task.kind === 'pdd_order_detail' ? { order_list_url: op.target.url, order_position: op.order_detail_read.position }
      : task.kind === 'jd_order_detail' ? { order_list_url: op.target.url, order_position: op.order_detail_read.position }
      : task.kind === 'pdd_product' ? { query: op.target.query, card_position: op.product_read.position }
      : task.kind === 'pdd_reviews' ? { query: op.target.query, product_id: op.reviews_read.product_id }
      : task.kind === 'pdd_spec_prices' ? { query: op.target.query, product_id: op.spec_read.product_id }
      : ['search', 'search_pages', 'search_collection', 'search_sort', 'search_price', 'search_controls', 'search_price_entry', 'search_price_hover', 'jd_search', 'jd_search_pages', 'jd_search_sort', 'pdd_search', 'pdd_search_sort'].includes(task.kind) ? { query: op.target.query } : { product_id: op.target.product_id }), status: op.status,
      attempts: op.attempts, automatic_retries: op.retries, error: op.error, result: op.result,
      ...(op.cart_read ? { cart_budget: { ...op.cart_read, reads_reserved: op.attempts }, actions_reserved: 0 } : {}),
      ...(op.order_read ? { order_budget: { ...op.order_read, reads_reserved: op.attempts }, actions_reserved: 0 } : {}),
      ...(op.search_collection ? { requested_pages: op.search_collection.requested_pages,
        cards_per_page: op.search_collection.cards_per_page,
        search_budget: { read_limit: op.search_collection.read_limit, reads_reserved: op.attempts,
          recovery_limit: op.search_collection.recovery_limit, recovery_wait_ms: op.search_collection.recovery_wait_ms,
          recoveries_reserved: op.search_collection.recoveries_reserved, failures: op.search_collection.failures,
          observation_limit: op.search_collection.observation_limit },
        actions_reserved: op.search_collection.transitions.length,
        dom_observations_reserved: op.search_collection.observations, pages_observed: op.search_collection.pages.length,
        ...(!op.result ? { partial_pages: op.search_collection.pages } : {}) } : {}),
      ...(op.order_pages ? { requested_pages: op.order_pages.requested_pages, orders_per_page: op.order_pages.orders_per_page,
        order_budget: { read_limit: op.order_pages.read_limit, reads_reserved: op.attempts,
          recovery_limit: op.order_pages.recovery_limit, recovery_wait_ms: op.order_pages.recovery_wait_ms,
          recoveries_reserved: op.order_pages.recoveries_reserved, failures: op.order_pages.failures,
          observation_limit: op.order_pages.observation_limit },
        actions_reserved: op.order_pages.transitions.length,
        dom_observations_reserved: op.order_pages.observations, pages_observed: op.order_pages.pages.length,
        ...(!op.result ? { partial_pages: op.order_pages.pages } : {}) } : {}),
      ...(op.order_detail_check ? { order_detail_budget: op.order_detail_check, actions_reserved: Number(op.order_detail_check.action_reserved),
        normal_order_fields_read: false } : {}),
      ...(op.order_body_read ? { order_body_budget: op.order_body_read, actions_reserved: 0, normal_order_fields_read: op.result !== null } : {}),
      ...(op.cart_collection ? { cart_collection: cartCollectionResult(op.cart_collection, op.target, op.cart_read.row_limit) } : {}),
      ...(op.order_collection ? { order_collection: orderCollectionResult(op.order_collection, op.target, op.order_read.order_limit) } : {}),
      ...(op.layout_evidence ? { layout_evidence: op.layout_evidence } : {}),
      ...(op.layout_evidence_error ? { layout_evidence_error: op.layout_evidence_error } : {}),
      ...(op.specification_image_batches ? { image_batches: specificationImageBatchResult(op.specification_image_batches, op.target) } : {}),
      ...(op.specification_collection ? { image_collection: specificationCollectionResult(op.specification_collection, op.target) } : {}),
      ...(op.selection ? { requested_selection: op.selection, option_actions_reserved: op.selection_state.dispatches.length,
        dom_observations_reserved: op.selection_state.reads } : {}),
      ...(op.service_read ? { actions_reserved: Number(op.service_read.action_reserved), dom_observations_reserved: op.service_read.observations } : {}),
      ...(op.description_read ? { actions_reserved: Number(op.description_read.action_reserved), dom_observations_reserved: op.description_read.observations,
        ...(!op.result ? { unconfirmed_description_observations: { initial: op.description_read.initial, last: op.description_read.last,
          same_entry_expanded_verified: false, text_stability_confirmed: false } } : {}) } : {}),
      ...(op.description_image_read ? { requested_description_image: op.description_image_read.position,
        actions_reserved: Number(op.description_image_read.action_reserved), dom_observations_reserved: op.description_image_read.observations,
        description_image_action: { reserved: op.description_image_read.action_reserved, scrolled: op.description_image_read.scrolled,
          reason: op.description_image_read.guard_reason, acknowledgement_error: op.description_image_read.acknowledgement_error },
        ...(!op.result ? { unconfirmed_description_image_observations: { initial: op.description_image_read.initial, guard: op.description_image_read.guard,
          last: op.description_image_read.last, normal_image_stability_confirmed: false, physical_element_identity_verified: false } } : {}) } : {}),
      ...(op.main_image_read ? { requested_thumbnails: op.main_images,
        actions_reserved: op.main_image_read.steps.filter(step => step.action_reserved).length,
        dom_observations_reserved: op.main_image_read.observations,
        ...(!op.result ? { partial_main_images: mainImageSamples(op.main_image_read),
          ...(op.main_image_read.schema_version === 2 ? { unconfirmed_main_image_observations: unconfirmedMainImageObservations(op) } : {}) } : {}) } : {}),
      ...(op.read_action ? { actions_reserved: Number(op.read_action.action_reserved), dom_observations_reserved: op.read_action.observations } : {}),
      ...(op.product_read ? { actions_reserved: Number(op.product_read.scroll_reserved), dom_observations_reserved: op.product_read.observations } : {}),
      ...(op.order_detail_read ? { actions_reserved: Number(op.order_detail_read.click_reserved), dom_observations_reserved: op.order_detail_read.reads,
        order_detail_tab_checks: op.order_detail_read.checks } : {}),
      ...(op.search_pages_read ? { requested_pages: op.search_pages_read.requested_pages, actions_reserved: op.search_pages_read.transitions.length,
        dom_observations_reserved: op.search_pages_read.reads, pages_observed: op.search_pages_read.pages.length } : {}),
      ...(op.search_sort_read ? { requested_sort: op.search_sort_read.sort, requested_pages: op.search_sort_read.paging.requested_pages,
        ...(op.search_sort_read.price_range ? { requested_price_range: { minimum: op.search_sort_read.price_range.minimum, maximum: op.search_sort_read.price_range.maximum },
          price_range_confirm_reserved: op.search_sort_read.price_range.reserved } : {}),
        sort_clicks_reserved: op.search_sort_read.steps.length,
        actions_reserved: (op.search_sort_read.price_range?.reserved ? 1 : 0) + op.search_sort_read.steps.length + op.search_sort_read.paging.transitions.length,
        dom_observations_reserved: op.search_sort_read.reads + op.search_sort_read.paging.reads, pages_observed: op.search_sort_read.paging.pages.length } : {}),
      ...(op.review_read ? { requested_categories: op.review_categories,
        actions_reserved: Number(op.review_read.open.reserved) + op.review_read.steps.filter(step => step.action_reserved).length + Number(op.review_read.close.reserved),
        dom_observations_reserved: op.review_read.observations,
        ...(!op.result ? { partial_review_samples: partialJdReviewSamples(op.review_read) } : {}) } : {}),
      ...(op.category_read ? { requested_categories: op.review_categories,
        panel_actions_reserved: Number(op.category_read.panel.action_reserved),
        actions_reserved: op.category_read.steps.filter(step => step.action_reserved).length,
        dom_observations_reserved: op.category_read.observations,
        ...(op.category_read.panel_lifecycle ? { panel_lifecycle: reviewPanelLifecycleEvidence(op.category_read),
          total_dom_observations_reserved: op.category_read.observations + op.category_read.panel_lifecycle.observations } : {}),
        ...(!op.result && op.category_read.observation_delivery ? {
          unconfirmed_category_observations: unconfirmedReviewObservations(op.category_read) } : {}),
        ...(!op.result ? { partial_category_samples: op.category_read.steps.filter(step => step.after).map(step => ({
          category: step.after.selected_category, snapshot: step.after })) } : {}) } : {}),
      ...(op.price_entry ? { actions_reserved: Number(op.price_entry.action_reserved), dom_observations_reserved: op.price_entry.observations,
        ...(!op.result ? { partial_inspection: op.price_entry.before } : {}) } : {}),
      ...(op.search_price ? { requested_price: op.search_price.request, ...(op.search_price.requested_pages ? { requested_pages: op.search_price.requested_pages } : {}),
        ...(op.search_price.conditions ? { requested_conditions: op.search_price.conditions } : {}),
        actions_reserved: op.search_price.actions.length,
        dom_observations_reserved: op.search_price.observations, observation_limit: op.search_price.observation_limit,
        ...(op.search_price.mismatches ? { observation_mismatches: op.search_price.mismatches } : {}),
        ...(!op.result ? { partial_search: op.search_price.before } : {}) } : {}),
      ...(op.search_sort ? { requested_sort: 'sales', actions_reserved: Number(op.search_sort.action_reserved),
        dom_observations_reserved: op.search_sort.observations,
        ...(!op.result ? { partial_search: op.search_sort.before } : {}) } : {}),
      ...(op.search_pages ? { actions_reserved: Number(op.search_pages.action_reserved), dom_observations_reserved: op.search_pages.observations,
        pages_observed: [op.search_pages.before, op.search_pages.after].filter(Boolean).length,
        ...(!op.result ? { partial_pages: [op.search_pages.before, op.search_pages.after].filter(Boolean) } : {}) } : {}) })),
    ...(pacingHeld(task) ? { pacing_hold: { allowed_after: new Date(task.not_before).toISOString() } } : {}),
    login_verified: false,
    next_action: {
      pending: pacingHeld(task)
        ? 'The local pacing quota is used up and nothing was sent. Run task-run with the same task after pacing_hold.allowed_after.'
        : 'Run task-run with the same task.', running: 'Run task-run with the same task after the current process exits.',
      retry_wait: 'Run task-run with the same task; its saved wait and retry reservation remain in force.',
      awaiting_batch: task.kind === 'order_collection'
        ? 'Return saved orders. Use task-next-batch with this same task for up to five further loaded groups; all limits and retries remain shared.'
        : task.kind === 'cart_collection'
        ? 'Return saved cart rows. Use task-next-batch with this same task for up to five further loaded rows; saved limits and retries remain shared.'
        : 'Return the current image batches. Use task-next-batch with this same task to read at most five further options within the saved budget.',
      waiting_user: task.operations.some(item => item.error?.code === 'PAGE_NOT_VISIBLE')
        ? PAGE_NOT_VISIBLE_NEXT_ACTION
        : 'After the user completes login or verification, run task-resume --after-user once.',
      waiting_cooldown: 'No verified platform wait duration is available. Stay paused; only after the user asks to resume later, run task-resume --after-cooldown once.',
      waiting_connection: task.kind === 'order_body_snapshot'
        ? 'Restore the original connection/window and the confirmed detail tab ID. No replacement tab, reopening or rebinding is allowed; resume within this same body task budget.'
        : task.kind === 'order_detail_check'
        ? 'Restore the original connection/window. Before any reserved action, task-rebind --tab may restore the list. After the intent, recovery only reconciles a unique new matching page; it never clicks again or borrows an old detail tab.'
        : task.kind === 'order_pages'
        ? 'Restore the selected buyer order-list tab, still on its last confirmed page (or the next page after a saved click). The address does not show the page; the next read checks the pager. Rebind with task-rebind --tab if the ID changed, then task-resume --after-connection.'
        : ['order_snapshot', 'order_collection'].includes(task.kind)
        ? 'Restore the selected buyer order-list tab and original connection. For a changed tab ID, check tabs and use task-rebind --tab, then task-resume --after-connection. Account and filter continuity are not verified.'
        : ['cart_snapshot', 'cart_collection'].includes(task.kind)
        ? 'Restore the selected cart tab and original connection. For a changed tab ID, check tabs and use task-rebind --tab, then task-resume --after-connection. Account continuity is not verified.'
        : ['search_controls', 'search_price_entry', 'search_price_hover'].includes(task.kind)
        ? 'Restore the same query first or second page. A dispatched price interaction will not repeat; diagnose and rebind if needed, then resume after connection.'
        : task.kind === 'search_sort'
        ? 'Restore this query first or second page; a sort URL is allowed only after its saved click intent. Diagnose and rebind if needed, then resume after connection.'
        : task.kind === 'search_price'
        ? 'Restore the original search tab. Before any pointer action another first-page tab may be rebound; afterwards only the original tab carries the applied state.'
        : task.kind === 'search_pages'
        ? 'Restore the same query first page, or page 2 only if the next-page action was reserved. Diagnose, task-rebind --tab if needed, then task-resume --after-connection.'
        : task.kind === 'search_collection'
        ? 'Restore the same query current confirmed page, or its next page only after the saved next-page intent. Diagnose and rebind if needed, then resume within this collection budget.'
        : task.kind === 'search'
        ? 'Restore the connection or the same query first page. For a new tab ID, use task-rebind --tab, then task-resume --after-connection.'
        : 'Restore the connection or same product tab. For a new tab ID, bind it and use task-rebind, then task-resume --after-connection.',
      complete: task.kind === 'order_detail_check'
        ? 'Return the saved navigation/page-state check. Normal order details remain unassessed; rerunning only returns the cache.'
        : 'Return the saved snapshots and their partial coverage; rerunning returns these same observations.',
      partial: 'Return completed snapshots and item failures; this task has ended and cannot reset its counters.',
      stopped: 'Stop this platform round and inspect the recorded error. Do not create another task to bypass the stop; see references/tasks.md.',
      ended: 'This task was explicitly ended. Preserve its results and counters; a distinct future task needs a new name.',
    }[task.status],
  };
}

/**
 * Save a bounded task from existing bindings or an explicit search/cart/order-list tab without browser access.
 * @param {number} [options.cartRows] New cart collection range (1–50); omit to retain the legacy first-five task.
 * @param {number} [options.pages] Search collection range (1–5); with a price sort or range, the price task reads that many result pages.
 * With --orders, reads 1–10 whole order-list pages (not combined with orderRows). Omit for the first page only.
 * @param {boolean} [options.orderDetail] Check one saved order entry and page state, with one native mouse intent.
 * @param {boolean} [options.orderBody] Read the fixed confirmed page of one completed navigation check; no new action.
 * @param {string} [options.sourceTask] Completed order-list source for orderDetail, or completed navigation check for orderBody.
 * @param {number} [options.orderPosition] One saved source position (1–50).
 * @param {string} [options.minPrice] Inclusive CNY minimum for a first-page price range; requires --search and --tab.
 * @param {string} [options.maxPrice] Inclusive CNY maximum for a first-page price range; sort may also be price-asc or price-desc.
 * @param {'tmall'} [options.source] Switch the search to the 天猫 source tab first. @param {string[]} [options.filters] Filter-strip labels to select; only 包邮.
 * With platform 'jd', accepted forms are search with tabId, one binding with details, or one binding with review categories (lib/jd/tasks.mjs).
 * @param {{platform?: 'taobao'|'jd', stateDirectory: string, task: string, bindings?: string[], plan?: string, reviewCategories?: string, mainImages?: string, search?: string, cart?: boolean, orders?: boolean, orderRows?: number, orderDetail?: boolean, orderBody?: boolean, sourceTask?: string, orderPosition?: number, pages?: number, sort?: string, inspectControls?: boolean, inspectPrice?: boolean, inspectPriceHover?: boolean, tabId?: number, reviews?: boolean, details?: boolean, services?: boolean, descriptionExpand?: boolean, descriptionImageLoad?: number, gallery?: boolean, specificationImages?: boolean, bridge: object}} options
 * @returns {Promise<object>} Task identity and count.
 * @throws {ShoppingError} Invalid bindings, TASK_EXISTS, or an unfinished platform task.
 * @example await createTask({stateDirectory:'.runtime/verification-bindings',task:'body-read',orderBody:true,sourceTask:'entry-check',bridge});
 */
export async function createTask(options) {
  if (options.bridge?.protocol === 'owned-chrome-cdp') throw new ShoppingError('INVALID_TRANSPORT', 'New tasks use the Playwright extension channel.');
  if (options.platform === 'pdd') return createPddTask(options);
  if (options.position !== undefined) throw new ShoppingError('UNSUPPORTED_PLATFORM', '--position in task-start picks a PDD search card; use --order-position for orders.');
  if (options.specPrices) throw new ShoppingError('UNSUPPORTED_PLATFORM', '--spec-prices reads PDD spec drawers; use it with --platform pdd.');
  return options.platform === 'jd' ? createJdTask(options) : createTaobaoTask(options);
}

async function createTaobaoTask({ stateDirectory, task: name, bindings, plan, reviewCategories, mainImages, search, cart = false, cartRows, orders = false, orderRows, orderDetail = false, orderBody = false, sourceTask, orderPosition, pages, sort, minPrice, maxPrice, source, filters, tabId, inspectControls = false, inspectPrice = false, inspectPriceHover = false, reviews = false, details = false, services = false, descriptionExpand = false, descriptionImageLoad, gallery = false, specificationImages = false, bridge }) {
  taskName(name);
  if (typeof orderDetail !== 'boolean' || typeof orderBody !== 'boolean' || (!orderDetail && !orderBody && (sourceTask !== undefined || orderPosition !== undefined))) throw new ShoppingError('INVALID_ARGUMENTS', 'Source options belong only to --order-detail or --order-body.');
  if (orderBody) {
    if ([bindings, plan, reviewCategories, mainImages, search, cartRows, orderRows, pages, sort, minPrice, maxPrice, descriptionImageLoad, tabId, orderPosition].some(value => value !== undefined) ||
        [orderDetail, cart, orders, inspectControls, inspectPrice, inspectPriceHover, reviews, details, services, descriptionExpand, gallery, specificationImages].some(Boolean) ||
        !isExtensionProtocol(bridge.protocol)) throw new ShoppingError('INVALID_ARGUMENTS', 'Use --order-body with only --source-task on the original extension connection; the source fixes its confirmed new tab.');
    taskName(sourceTask);
    return withTaskStore(stateDirectory, name, async store => {
      const source = await loadTask(stateDirectory, sourceTask);
      if (source.endpoint !== bridge.endpoint || source.browser_session !== undefined || sourceTask === name) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'Restore the saved navigation source endpoint and extension connection.');
      const record = orderBodySource(source), now = new Date().toISOString();
      const task = {schema_version:1,id:name,kind:'order_body_snapshot',platform:'taobao',endpoint:bridge.endpoint,status:'pending',
        created_at:now,updated_at:now,policy:TASK_POLICY,retries:0,cooldown_probes:0,wait_reserved_ms:0,not_before:0,
        operations:[{...record,status:'pending',attempts:0,retries:0,not_before:0,recovery_kind:null,error:null,result:null,order_body_read:newOrderBodyRead()}]};
      await store.create(task);
      return {ok:true,status:'task_created',task:name,task_kind:task.kind,products:0,operations:1,
        next_action:'Run task-run for this one guarded body observation. The confirmed tab, source and all budgets are fixed.'};
    });
  }
  if (orderDetail) {
    if ([bindings, plan, reviewCategories, mainImages, search, cartRows, orderRows, pages, sort, minPrice, maxPrice, descriptionImageLoad].some(value => value !== undefined) ||
        [cart, orders, inspectControls, inspectPrice, inspectPriceHover, reviews, details, services, descriptionExpand, gallery, specificationImages].some(Boolean) ||
        tabId === undefined || !isExtensionProtocol(bridge.protocol)) throw new ShoppingError('INVALID_ARGUMENTS', 'Use --order-detail with --source-task, --order-position and an explicit --tab on the original extension connection.');
    taskName(sourceTask);
    return withTaskStore(stateDirectory, name, async store => {
      const source = await loadTask(stateDirectory, sourceTask);
      if (source.endpoint !== bridge.endpoint || source.browser_session !== undefined || sourceTask === name) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'Restore the saved list source endpoint and extension connection.');
      const record = orderDetailSource(source, orderPosition), now = new Date().toISOString();
      const task = {schema_version:1,id:name,kind:'order_detail_check',platform:'taobao',endpoint:bridge.endpoint,status:'pending',
        created_at:now,updated_at:now,policy:TASK_POLICY,retries:0,cooldown_probes:0,wait_reserved_ms:0,not_before:0,
        operations:[{...record,tab_id:parseTabId(tabId),status:'pending',attempts:0,retries:0,not_before:0,recovery_kind:null,error:null,result:null,
          order_detail_check:newOrderDetailCheck()}]};
      await store.create(task);
      return {ok:true,status:'task_created',task:name,task_kind:task.kind,products:0,operations:1,
        next_action:'Run task-run for this single-order navigation/page-state check; normal detail fields are outside this task scope.'};
    });
  }
  const searching = search !== undefined, categoryMode = reviewCategories !== undefined, mainImageMode = mainImages !== undefined;
  // 天猫 and 包邮 run in the price task, before any price controls; they may also be requested alone.
  const conditionMode = source !== undefined || filters !== undefined;
  const priceMode = ['price-asc', 'price-desc'].includes(sort) || minPrice !== undefined || maxPrice !== undefined || conditionMode;
  const imageLoadingMode = descriptionImageLoad !== undefined;
  const imageLoadingState = imageLoadingMode ? newDescriptionImageState(descriptionImageLoad) : null;
  if ((cartRows !== undefined && !cart) || (orderRows !== undefined && !orders) || typeof cart !== 'boolean' || typeof orders !== 'boolean' || [Boolean(plan), Boolean(bindings), searching, cart, orders].filter(Boolean).length !== 1 ||
      ((reviews || details || services || descriptionExpand || imageLoadingMode || gallery || specificationImages || categoryMode || mainImageMode) && (plan || searching || cart || orders)) || [reviews, details, services, descriptionExpand, imageLoadingMode, gallery, specificationImages, categoryMode, mainImageMode].filter(Boolean).length > 1 || ((searching || cart || orders) !== (tabId !== undefined)) ||
      (pages !== undefined && (!Number.isSafeInteger(pages) || pages < 1 || (searching ? pages > 5 : !orders || orderRows !== undefined || pages > MAX_ORDER_PAGES))) ||
      (sort !== undefined && (!searching || !['sales', 'price-asc', 'price-desc'].includes(sort) || (sort === 'sales' && pages !== undefined))) ||
      (priceMode && (!searching || sort === 'sales' || !isExtensionProtocol(bridge.protocol))) ||
      ((inspectControls || inspectPrice || inspectPriceHover) && (!searching || pages !== undefined || sort !== undefined || priceMode || [inspectControls, inspectPrice, inspectPriceHover].filter(Boolean).length > 1))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use --bindings, --plan, --search with --tab, --cart with --tab, or --orders with --tab. Search supports --pages 1–5 and its sales and price modes; orders support --pages 1–10 or --order-rows, not both; price controls need the extension connection.');
  }
  const priceRequest = priceMode ? createSearchPriceRequest({ query: search, sort: sort ?? null,
    minPrice: minPrice ?? null, maxPrice: maxPrice ?? null }, { allowNoPrice: conditionMode }) : null;
  const cartBudget = cart ? newCartReadState(cartRows) : null;
  const bindingLimit = imageLoadingMode || descriptionExpand || specificationImages || gallery || categoryMode || mainImageMode ? 1 : reviews || details || services ? 10 : 50;
  if (!plan && !searching && !cart && !orders && (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > bindingLimit || bindings.some(name => !name))) {
    throw new ShoppingError('INVALID_BINDINGS', `Supply 1–${bindingLimit} binding names separated by commas.`);
  }
  const searchRecord = searching ? { endpoint: bridge.endpoint, tab_id: parseTabId(tabId), target: searchTarget(search), selection: null } : null;
  const cartRecord = cart ? { endpoint: bridge.endpoint, tab_id: parseTabId(tabId), target: parseCartUrl('https://cart.taobao.com/cart.htm'), selection: null } : null;
  const orderRecord = orders ? { endpoint: bridge.endpoint, tab_id: parseTabId(tabId), target: parseOrderListUrl('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'), selection: null } : null;
  const categories = categoryMode ? await loadReviewCategoryPlan(reviewCategories) : null;
  const thumbnails = mainImageMode ? await loadMainImagePlan(mainImages) : null;
  const requests = plan ? await loadSelectionPlan(plan) : (bindings ?? []).map(binding => ({ binding, selection: null }));
  return withTaskStore(stateDirectory, name, async store => {
    const records = orderRecord ? [orderRecord] : cartRecord ? [cartRecord] : searchRecord ? [searchRecord] : [];
    const keys = new Set();
    for (const { binding, selection } of requests) {
      const record = await loadBinding(stateDirectory, binding);
      if (record.platform !== 'taobao') throw new ShoppingError('UNSUPPORTED_PLATFORM', 'Only Taobao bindings can be used in Taobao tasks; start JD tasks with --platform jd.');
      if (record.endpoint !== bridge.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'All task bindings must use the selected bridge.');
      const key = selection ? selectionKey(record.target.product_id, selection) : record.target.product_id;
      if (!keys.has(key)) { records.push({ ...record, selection }); keys.add(key); }
    }
    const now = new Date().toISOString();
    const kind = orders ? (pages !== undefined ? 'order_pages' : orderRows === undefined ? 'order_snapshot' : 'order_collection') : cart ? (cartRows === undefined ? 'cart_snapshot' : 'cart_collection') : searching ? (inspectPriceHover ? 'search_price_hover' : inspectPrice ? 'search_price_entry' : inspectControls ? 'search_controls' : sort === 'sales' ? 'search_sort' : priceMode ? 'search_price' : pages !== undefined ? 'search_collection' : 'search') : specificationImages ? 'product_specification_images' : gallery ? 'product_gallery' : mainImageMode ? 'product_main_images' : categoryMode ? 'product_review_categories' : imageLoadingMode ? 'product_description_image_loading' : descriptionExpand ? 'product_description_expansion' : services ? 'product_services' : reviews ? 'product_reviews' : details ? 'product_details' : plan ? 'product_selection' : 'product_snapshot';
    const task = { schema_version: 1, id: name, kind, platform: 'taobao', endpoint: bridge.endpoint,
      ...(kind === 'product_snapshot' ? { layout_diagnostics_version: 1 } : {}),
      status: 'pending', created_at: now, updated_at: now, policy: TASK_POLICY,
      retries: 0, cooldown_probes: 0, wait_reserved_ms: 0, not_before: 0,
      operations: records.map(record => ({ tab_id: record.tab_id, target: record.target,
        status: 'pending', attempts: 0, retries: 0, not_before: 0, recovery_kind: null, error: null, result: null,
        ...(cart ? { cart_read: cartBudget } : {}),
        ...(orders && kind !== 'order_pages' ? { order_read: newOrderReadState(orderRows) } : {}),
        ...(kind === 'order_pages' ? { order_pages: newOrderPagesState(pages) } : {}),
        ...(kind === 'order_collection' ? { order_collection: newOrderCollection() } : {}),
        ...(kind === 'cart_collection' ? { cart_collection: newCartCollection() } : {}),
        ...(specificationImages ? { specification_collection: newSpecificationCollection() } : {}),
        ...(record.selection ? { selection: record.selection, selection_state: newSelectionState() } : {}),
        ...(['search_price_entry', 'search_price_hover'].includes(kind) ? { price_entry: newPriceEntryState() } : kind === 'search_sort' ? { search_sort: newSearchSortState() } : kind === 'search_price' ? { search_price: newSearchPriceState(priceRequest, undefined, { pages: pages ?? 1, conditions: { source, filters } }) } : kind === 'search_collection' ? { search_collection: newSearchCollectionState(pages) }
          : mainImageMode ? { main_images: thumbnails, main_image_read: newMainImageState(thumbnails) }
          : categoryMode ? { review_categories: categories, category_read: newReviewCategoryState(categories) }
          : imageLoadingMode ? { description_image_read: imageLoadingState } : descriptionExpand ? { description_read: newDescriptionReadState() } : services ? { service_read: newServiceReadState() } : searching || reviews ? { read_action: newReadActionState() } : {}) })) };
    await store.create(task);
    return { ok: true, status: 'task_created', task: name, task_kind: task.kind,
      products: new Set(records.map(record => record.target.product_id).filter(Boolean)).size, operations: records.length,
      next_action: 'Run task-run with the same task and state directory.' };
  });
}

/** @param {{stateDirectory: string, task: string}} options @returns {Promise<object>} Saved progress, with no browser access. @throws {ShoppingError} Checkpoint errors. */
export async function taskStatus({ stateDirectory, task }) { return report(await loadTask(stateDirectory, task)); }

/**
 * Move an unfinished public target to an explicitly bound new tab, preserving all budgets.
 * @param {{stateDirectory: string, task: string, binding?: string, tabId?: number, bridge: object}} options
 * @returns {Promise<object>} Updated saved progress. Product bindings are local; search reattachment checks the current-window tab inventory.
 * @throws {ShoppingError} RECOVERY_REQUIRED or TASK_TARGET_MISMATCH.
 */
export async function rebindTask({ stateDirectory, task: name, binding, tabId, bridge }) {
  return withTaskStore(stateDirectory, name, async store => {
    const task = await store.load();
    requireLiveTaskChannel(task);
    if (task.platform !== 'taobao') throw new ShoppingError('UNSUPPORTED_PLATFORM', 'Rebinding is not available for JD tasks yet; open the page again and start a new task.');
    if (task.status !== 'waiting_connection') throw new ShoppingError('RECOVERY_REQUIRED', 'Rebinding requires a task paused for its connection or target.');
    if (task.kind === 'order_body_snapshot') throw new ShoppingError('INVALID_RECOVERY', 'Restore the original confirmed detail tab; a body task cannot substitute or reopen another same-order page.');
    if (task.kind === 'order_detail_check') {
      const op = task.operations[0];
      if (binding !== undefined || op.order_detail_check.action_reserved) throw new ShoppingError('INVALID_RECOVERY', 'Only an unclicked list can be explicitly rebound; reserved actions reconcile their own new page.');
      if (bridge.endpoint !== task.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'Restore the original endpoint.');
      const id = parseTabId(tabId);
      await bridge.requireConnected();
      if (parseOrderListUrl((await bridge.listTabs()).find(tab => tab.id === id)?.url)?.url !== op.source.list_url) throw new ShoppingError('TASK_TARGET_MISMATCH', 'Select the saved buyer-list route.');
      op.tab_id = id; task.updated_at = new Date().toISOString(); await store.save(task);
      return {...report(task),ok:true,status:'task_rebound',next_action:'Run task-resume --after-connection with the same task.'};
    }
    if (['cart_snapshot', 'cart_collection', 'order_snapshot', 'order_collection', 'order_pages'].includes(task.kind)) {
      if (['order_snapshot', 'order_collection', 'order_pages'].includes(task.kind) && binding !== undefined) throw new ShoppingError('INVALID_ARGUMENTS', 'Order reattachment uses an explicit --tab without a product binding.');
      const id = parseTabId(tabId);
      if (bridge.endpoint !== task.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'Restore the original bridge endpoint.');
      await bridge.requireConnected();
      const tab = (await bridge.listTabs()).find(item => item.id === id);
      const parser = ['order_snapshot', 'order_collection', 'order_pages'].includes(task.kind) ? parseOrderListUrl : parseCartUrl;
      if (parser(tab?.url)?.url !== task.operations[0].target.url) {
        throw new ShoppingError('TASK_TARGET_MISMATCH', 'Select the saved HTTPS list route in the current window.');
      }
      task.operations[0].tab_id = id;
      task.updated_at = new Date().toISOString();
      await store.save(task);
      return { ...report(task), ok: true, status: 'task_rebound', next_action: 'Run task-resume --after-connection with the same task.' };
    }
    if (['search', 'search_pages', 'search_collection', 'search_sort', 'search_price', 'search_controls', 'search_price_entry', 'search_price_hover'].includes(task.kind)) {
      if (task.kind === 'search_price' && task.operations[0].search_price.actions.length) {
        throw new ShoppingError('INVALID_RECOVERY', 'Price controls were already operated on the original tab; another tab would not carry that state.');
      }
      const id = parseTabId(tabId);
      if (bridge.endpoint !== task.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'Restore the original bridge endpoint.');
      await bridge.requireConnected();
      const tab = (await bridge.listTabs()).find(item => item.id === id);
      const operation = task.operations[0];
      const targets = task.kind === 'search_collection' ? searchCollectionTargets(operation.target, operation.search_collection)
        : task.kind === 'search_pages' ? searchPagesTargets(operation.target, operation.search_pages) : [operation.target];
      const actual = ['search_controls', 'search_price_entry', 'search_price_hover'].includes(task.kind) ? parseSortableSearchUrl(tab?.url)
        : task.kind === 'search_collection' ? parseSearchRangeUrl(tab?.url) : task.kind === 'search_pages' ? parseSearchPageUrl(tab?.url) : parseSearchUrl(tab?.url);
      if (!(['search_controls', 'search_price_entry', 'search_price_hover'].includes(task.kind) ? actual?.query === operation.target.query : task.kind === 'search_sort' ? matchesSearchSort(tab?.url, operation.target, operation.search_sort) : targets.some(target => actual?.url === target.url))) throw new ShoppingError('TASK_TARGET_MISMATCH', 'Select the same query and a page allowed by its saved action intent.');
      task.operations[0].tab_id = id;
      task.updated_at = new Date().toISOString();
      await store.save(task);
      return { ...report(task), ok: true, status: 'task_rebound', next_action: 'Run task-resume --after-connection with the same task.' };
    }
    if (tabId !== undefined) throw new ShoppingError('INVALID_ARGUMENTS', 'Product tasks use --binding for reattachment.');
    const record = await loadBinding(stateDirectory, binding);
    const op = task.operations.find(item => item.target.url === record.target.url && !['succeeded', 'failed'].includes(item.status));
    if (!op || bridge.endpoint !== task.endpoint || record.endpoint !== task.endpoint) {
      throw new ShoppingError('TASK_TARGET_MISMATCH', 'The new binding must identify the exact original product and endpoint.');
    }
    for (const pending of task.operations.filter(item => item.target.url === record.target.url && !['succeeded', 'failed'].includes(item.status))) {
      pending.tab_id = record.tab_id;
    }
    task.updated_at = new Date().toISOString();
    await store.save(task);
    return { ...report(task), ok: true, status: 'task_rebound', next_action: 'Run task-resume --after-connection with the same task.' };
  });
}

/**
 * Explicitly end a local task while retaining its results and counters. Does not visit a site.
 * @param {{stateDirectory: string, task: string}} options @returns {Promise<object>} Saved final state.
 * @throws {ShoppingError} State or locking errors.
 */
export async function endTask({ stateDirectory, task: name }) {
  return withTaskStore(stateDirectory, name, async store => {
    const task = await store.load();
    task.status = 'ended'; task.updated_at = new Date().toISOString();
    await store.save(task);
    return { ...report(task), ok: true };
  });
}

async function applyFailure(task, op, error, commit, now, recoveryKind, showPage) {
  if (op.search_collection) invalidateSearchCollectionCandidate(op.search_collection);
  if (op.order_pages) invalidateOrderPagesCandidate(op.order_pages);
  if (op.description_read) op.description_read.confirmations = 0;
  if (op.description_image_read) op.description_image_read.confirmations = 0;
  const code = publicError(error).code;
  const category = failureCategory(code);
  op.error = { code, category };
  const budget = boundedReadBudget(op);
  if (budget) budget.failures.push({ attempt: op.attempts, code, category });
  if (code === 'PAGE_STRUCTURE_CHANGED' && isProductStructureReason(error.productStructureReason)) {
    op.error.reason = error.productStructureReason;
    if (task.layout_diagnostics_version === 1 && error.layoutEvidence) {
      op.layout_evidence = validateLayoutEvidence(error.layoutEvidence, op.target);
    }
    if (task.layout_diagnostics_version === 1 && error.layoutEvidenceError === 'COLLECTION_FAILED') {
      op.layout_evidence_error = 'COLLECTION_FAILED';
    }
  }
  op.status = 'pending';
  op.recovery_kind = null;
  if (budget && op.attempts >= budget.read_limit) {
    task.status = 'stopped'; op.error = { code: boundedReadCode(op, 'READ_LIMIT'), category: 'budget', cause: code };
  }
  else if (category === 'user') task.status = 'waiting_user';
  else if (recoveryKind === 'cooldown') task.status = 'stopped';
  else if (category === 'connection') task.status = 'waiting_connection';
  else if (category === 'rate') task.status = task.cooldown_probes ? 'stopped' : 'waiting_cooldown';
  else if (category === 'item') { op.status = 'failed'; task.status = 'running'; finishIfDone(task); }
  else if (budget && recoveryKind === 'connection' && category === 'transient') task.status = 'waiting_connection';
  else if (category === 'transient' && recoveryKind !== 'user') {
    const decision = retryDecision(task, op);
    if (decision.allowed) {
      op.status = 'retry_wait'; task.status = 'retry_wait';
      op.retries += 1; task.retries += 1;
      task.wait_reserved_ms += decision.delay_ms;
      op.not_before = now() + decision.delay_ms;
      task.not_before = Math.max(task.not_before, op.not_before);
    } else {
      op.error = { code: decision.code, category: 'budget', cause: code };
      if (decision.code === 'OPERATION_RETRY_LIMIT') { op.status = 'failed'; task.status = 'running'; finishIfDone(task); }
      else task.status = 'stopped';
    }
  } else if (recoveryKind === 'user' && category === 'transient') task.status = 'waiting_user';
  else task.status = 'stopped';
  if (op.status === 'failed' && task.status === 'running') task.not_before = now() + TASK_POLICY.operation_interval_ms;
  await commit();
  await displayPausedPage({ task, op, error, showPage });
}

/**
 * Execute fixed snapshots or specified selections, with durable accounting and pauses.
 * All waits and retries belong to this layer; the browser adapter must not retry.
 * @param {{stateDirectory: string, task: string, bridge: object, recovery?: string, nextBatch?: boolean,
 *   onPlatformLimit?: (observation: {signal: string, page_kind: string}) => Promise<void>, showPage?: Function}} options
 *   onPlatformLimit is called when a JD read meets a rate limit or verification, before the task pauses.
 *   An order workflow defers showPage until its parent pause is committed as well.
 * @param {{now?: () => number, wait?: (ms: number) => Promise<void>}} clock Injectable for offline tests.
 * @returns {Promise<object>} Saved progress including partial results and recovery state.
 * @throws {ShoppingError} Invalid state, concurrent execution, or a wrong recovery action.
 */
export async function runTask(options, { now = Date.now, wait = sleep } = {}) {
  const { stateDirectory, task: name, bridge, recovery, nextBatch = false } = options;
  const showPage = options.showPage ?? createBlockedPageDisplay(bridge);
  return withTaskStore(stateDirectory, name, async store => {
    const task = await store.load();
    if (!FINISHED.has(task.status)) requireLiveTaskChannel(task);
    if (task.endpoint !== bridge.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'The task endpoint is fixed; restore its original connection.');
    validateRecovery(task, recovery);
    if (FINISHED.has(task.status)) return report(task);
    if (nextBatch && (recovery || task.status !== 'awaiting_batch' || !['product_specification_images', 'cart_collection', 'order_collection'].includes(task.kind))) {
      throw new ShoppingError('INVALID_RECOVERY', 'The task is not waiting for its next saved batch.');
    }
    if (task.status === 'awaiting_batch' && !nextBatch) return report(task);
    const commit = async () => { task.updated_at = new Date(now()).toISOString(); await store.save(task); };
    if (['search_collection', 'order_pages'].includes(task.kind)) {
      const op = task.operations[0];
      const cached = op.order_pages ? orderPagesCachedResult(op.target, op.order_pages) : searchCollectionCachedResult(op.target, op.search_collection);
      if (cached) {
        op.result = cached; op.status = 'succeeded'; op.error = null; op.recovery_kind = null;
        finishIfDone(task); await commit(); return report(task);
      }
    }
    if (task.kind === 'order_body_snapshot') {
      await runOrderBodyRead({task,bridge,commit,now,wait,recovery,showPage});
      return report(task);
    }
    if (task.kind === 'order_detail_check') {
      await runOrderDetailCheck({task,bridge,commit,now,wait,recovery,nextBatch,showPage});
      return report(task);
    }
    if (nextBatch) { task.status = 'pending'; await commit(); }
    if (recovery) {
      const next = task.operations.find(op => !['succeeded', 'failed'].includes(op.status));
      const budget = boundedReadBudget(next);
      if (budget) {
        const limit = next.attempts >= budget.read_limit ? boundedReadCode(next, 'READ_LIMIT')
          : budget.recoveries_reserved >= budget.recovery_limit ? boundedReadCode(next, 'RECOVERY_LIMIT')
          : task.wait_reserved_ms + budget.recovery_wait_ms > TASK_POLICY.wait_budget_ms ? 'WAIT_BUDGET_EXHAUSTED' : null;
        if (limit) {
          next.error = { code: limit, category: 'budget', ...(next.error ? { cause: next.error.code } : {}) };
          task.status = 'stopped'; await commit(); return report(task);
        }
        budget.recoveries_reserved += 1;
        task.wait_reserved_ms += budget.recovery_wait_ms;
        task.not_before = Math.max(task.not_before, now() + budget.recovery_wait_ms);
      }
      next.recovery_kind = recovery === 'connection' && !budget ? null : recovery;
    }
    if (recovery === 'cooldown') {
      if (task.cooldown_probes >= 1 || task.retries >= TASK_POLICY.platform_retries) {
        task.status = 'stopped'; await commit(); return report(task);
      }
      task.cooldown_probes += 1; task.retries += 1;
    }
    // A killed process may have dispatched an action. Persisted action intents make the next step read-only.
    const interrupted = task.operations.find(op => op.status === 'running');
    if (interrupted) {
      await applyFailure(task, interrupted, new ShoppingError('READ_INTERRUPTED', 'A previous read has no committed result.'), commit, now, interrupted.recovery_kind, showPage);
    } else if (recovery) { task.status = 'running'; await commit(); }
    while (['pending', 'running', 'retry_wait'].includes(task.status)) {
      const op = task.operations.find(item => !['succeeded', 'failed'].includes(item.status));
      if (!op) { finishIfDone(task); await commit(); break; }
      const budget = boundedReadBudget(op);
      if (budget && op.attempts >= budget.read_limit) {
        task.status = 'stopped'; op.error = { code: boundedReadCode(op, 'READ_LIMIT'), category: 'budget' };
        await commit(); break;
      }
      if (op.specification_collection && !specificationCollectionPlan(op.specification_collection)) {
        const result = specificationCollectionResult(op.specification_collection, op.target);
        if (result.coverage.scanned_supported_image_links_complete) {
          op.result = result; op.error = null; op.status = 'succeeded'; op.recovery_kind = null;
          finishIfDone(task);
        } else {
          op.status = 'pending'; task.status = 'stopped';
          op.error = { code: 'SPECIFICATION_IMAGES_INCOMPLETE', category: 'budget' };
        }
        await commit(); break;
      }
      if (op.specification_image_batches && op.attempts >= op.specification_image_batches.read_limit) {
        task.status = 'stopped'; op.error = { code: 'SPECIFICATION_IMAGE_READ_LIMIT', category: 'budget' };
        await commit(); break;
      }
      const due = Math.max(task.not_before, op.not_before);
      const remaining = due - now();
      if (remaining > PACING_HOLD_RETURN_MS && op.error?.code === 'PACING_LIMIT') return report(task);
      if (remaining > 0) {
        // Short bounded waits keep host tools responsive; no page request is sent while waiting.
        await wait(Math.min(remaining, 15000));
        continue;
      }
      const collectionPlan = op.specification_collection ? reserveSpecificationCollectionRead(op.specification_collection) : null;
      op.status = 'running'; op.attempts += 1;
      task.status = 'running'; task.not_before = 0; op.not_before = 0;
      await commit();
      let result;
      try {
        if (task.kind === 'order_snapshot') result = await runOrderRead({ bridge, op });
        else if (task.kind === 'order_collection') result = await runOrderCollection({ bridge, op });
        else if (task.kind === 'order_pages') result = await runOrderPages({ bridge, op, commit, now, wait });
        else if (task.kind === 'cart_snapshot') result = await runCartRead({ bridge, op });
        else if (task.kind === 'cart_collection') result = await runCartCollection({ bridge, op });
        else if (task.kind === 'product_selection') result = await readSelectedProduct({ bridge, op, commit, now, wait });
        else if (task.kind === 'product_main_images') result = await runMainImages({ bridge, op, commit, now, wait });
        else if (task.kind === 'product_review_categories') result = await runReviewCategories({ bridge, op, commit, now, wait });
        else if (task.kind === 'product_services') result = await runServiceRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'product_description_expansion') result = await runDescriptionRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'product_description_image_loading') result = await runDescriptionImageRead({ bridge, op, commit, now, wait });
        else if (op.specification_collection) {
          result = await bridge.readSpecificationCollection(op.tab_id, op.target, collectionPlan);
          acceptSpecificationCollectionRead(op.specification_collection, result, op.target);
        }
        else if (task.kind === 'product_specification_images') result = await bridge.readSpecificationImages(op.tab_id, op.target, op.specification_image_batches?.batches);
        else if (task.kind === 'product_gallery') result = await bridge.readGallery(op.tab_id, op.target);
        else if (task.kind === 'product_details') result = await bridge.readDetails(op.tab_id, op.target);
        else if (['search_price_entry', 'search_price_hover'].includes(task.kind)) result = await runPriceEntry({ bridge, op, commit, now, wait, hover: task.kind === 'search_price_hover' });
        else if (task.kind === 'search_controls') result = await runSearchControls({ bridge, op, commit });
        else if (task.kind === 'search_sort') result = await runSearchSort({ bridge, op, commit, now, wait });
        else if (task.kind === 'search_price') result = await runSearchPrice({ bridge, op, commit, now, wait });
        else if (task.kind === 'search_pages') result = await runSearchPages({ bridge, op, commit, now, wait });
        else if (task.kind === 'search_collection') result = await runSearchCollection({ bridge, op, commit, now, wait });
        else if (['search', 'product_reviews'].includes(task.kind)) result = await runReadAction({ kind: task.kind, bridge, op, commit, now, wait });
        else if (task.kind === 'jd_search') result = await bridge.readJdSearch(op.tab_id, op.target);
        else if (task.kind === 'pdd_search') result = await bridge.readPddSearch(op.tab_id, op.target);
        else if (task.kind === 'pdd_search_sort') result = await runPddSortRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'pdd_product') result = await runPddProductRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'pdd_reviews') result = await runPddReviewsRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'pdd_spec_prices') result = await runPddSpecPricesRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'pdd_orders') result = await bridge.readPddOrders(op.tab_id);
        else if (task.kind === 'pdd_order_detail') result = await runPddOrderDetailRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'jd_cart') result = await bridge.readJdCart(op.tab_id, op.target);
        else if (task.kind === 'jd_orders') result = await bridge.readJdOrders(op.tab_id, op.target);
        else if (task.kind === 'jd_order_detail') result = await runJdOrderDetailRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'jd_search_pages') result = await runJdSearchPagesRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'jd_search_sort') result = await runJdSearchSortRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'jd_product') result = await runJdProductRead({ bridge, op, commit, now, wait });
        else if (task.kind === 'jd_review_categories') result = await runJdReviewRead({ bridge, op, commit, now, wait, showPage });
        else result = await bridge.readProduct(op.tab_id, op.target, { layoutDiagnostics: task.layout_diagnostics_version === 1 });
      }
      catch (error) {
        if (error.code === 'PACING_LIMIT' && Number.isSafeInteger(error.allowedAt)) {
          // A self-imposed quota is neither a platform failure nor a retry: hold the task without spending recovery budgets.
          op.status = 'pending'; op.error = { code: 'PACING_LIMIT', category: 'pacing' }; op.recovery_kind = null;
          task.status = 'pending'; task.not_before = Math.max(task.not_before, error.allowedAt);
          await commit(); return report(task);
        }
        if (['jd', 'pdd'].includes(task.platform) && ['RATE_LIMITED', 'VERIFICATION_REQUIRED'].includes(error.code)) {
          await options.onPlatformLimit?.({ signal: error.code === 'RATE_LIMITED' ? 'rate_limited' : 'verification_required',
            page_kind: (task.platform === 'jd' ? JD_TASK_KINDS : PDD_TASK_KINDS)[task.kind] });
        }
        await applyFailure(task, op, error, commit, now, op.recovery_kind, showPage);
        continue;
      }
      if (op.cart_collection || op.order_collection) {
        const collection = op.order_collection ?? op.cart_collection;
        const limit = op.order_read?.order_limit ?? op.cart_read.row_limit;
        const planNextCollection = op.order_collection ? orderCollectionPlan : cartCollectionPlan;
        collection.batches.push({ attempt: op.attempts, snapshot: result });
        op.status = 'pending'; op.error = null; op.recovery_kind = null;
        task.not_before = now() + TASK_POLICY.operation_interval_ms;
        let continuation;
        try { continuation = planNextCollection(collection, limit); }
        catch (error) {
          task.status = 'stopped'; op.error = { code: error.code, category: 'diagnostic' };
          await commit(); break;
        }
        if (continuation) {
          task.status = op.attempts >= boundedReadBudget(op).read_limit ? 'stopped' : 'awaiting_batch';
          if (task.status === 'stopped') op.error = { code: boundedReadCode(op, 'READ_LIMIT'), category: 'budget' };
          await commit(); break;
        }
        result = op.order_collection ? orderCollectionResult(collection, op.target, limit) : cartCollectionResult(collection, op.target, limit);
      }
      if (op.specification_collection) {
        op.status = 'pending'; op.error = null; op.recovery_kind = null;
        task.not_before = now() + TASK_POLICY.operation_interval_ms;
        await commit(); continue;
      }
      if (op.specification_image_batches) {
        const state = op.specification_image_batches;
        state.batches.push(result);
        const continuation = specificationImageContinuation(state.batches, op.target);
        if (continuation) {
          op.status = 'pending'; op.error = null; op.recovery_kind = null;
          task.status = state.batches.length === state.batch_limit ? 'stopped' : 'awaiting_batch';
          if (task.status === 'stopped') op.error = { code: 'SPECIFICATION_IMAGE_BATCH_LIMIT', category: 'budget' };
          task.not_before = now() + TASK_POLICY.operation_interval_ms;
          await commit(); break;
        }
        result = specificationImageBatchResult(state, op.target);
      }
      op.result = result; op.error = null; op.status = 'succeeded'; op.recovery_kind = null;
      task.not_before = now() + TASK_POLICY.operation_interval_ms;
      finishIfDone(task);
      await commit();
    }
    return report(task);
  });
}
