import { isExtensionProtocol } from '../bridge-protocol.mjs';
import { ShoppingError } from '../errors.mjs';
import { parseTabId } from '../targets.mjs';
import { TASK_POLICY } from '../task-policy.mjs';
import { loadTask, taskName, withTaskStore } from '../task-store.mjs';
import { newPddProductReadState } from './product-read.mjs';
import { newPddReviewsReadState } from './reviews-read.mjs';
import { newPddSpecReadState } from './spec-prices-read.mjs';
import { newPddOrderDetailReadState } from './order-detail-read.mjs';
import { newPddSortReadState } from './search-sort-read.mjs';
import { PDD_SORTS } from './search-sort.mjs';
import { parsePddOrderListUrl, pddSearchTarget } from './targets.mjs';

// task-start modes of other platforms are refused for PDD rather than silently ignored.
const OTHER_PLATFORM_OPTIONS = ['bindings', 'plan', 'reviewCategories', 'mainImages', 'cart', 'cartRows', 'orderRows', 'source', 'filters', 'inspectControls', 'inspectPrice', 'inspectPriceHover', 'pages', 'details', 'services',
  'descriptionExpand', 'descriptionImageLoad', 'gallery', 'specificationImages', 'orderDetail', 'orderBody'];
const USAGE = 'PDD tasks support --search QUERY with --tab ID and optional --sort sales|price-asc|price-desc and --min-price A --max-price B, --source-task SEARCH_TASK with --position N, --source-task PRODUCT_TASK with --reviews or --spec-prices (optionally --spec-group NAME, and with it --spec-choose GROUP=TEXT), --orders with --tab ID, or --source-task ORDERS_TASK with --order-position N.';

function newTask(name, kind, bridge, op) {
  const now = new Date().toISOString();
  return { schema_version: 1, id: name, kind, platform: 'pdd', endpoint: bridge.endpoint, status: 'pending',
    created_at: now, updated_at: now, policy: TASK_POLICY, retries: 0, cooldown_probes: 0, wait_reserved_ms: 0, not_before: 0,
    operations: [{ tab_id: parseTabId(op.tab_id), target: op.target, status: 'pending', attempts: 0, retries: 0, not_before: 0, recovery_kind: null,
      error: null, result: null, ...op.extra }] };
}

/**
 * Save a PDD task: the loaded cards of a search page opened by `page-open --platform pdd --search` (`--search QUERY
 * --tab ID`; nothing is clicked or scrolled), or the product page of one card of a completed search task
 * (`--source-task NAME --position N`; card N is checked against the saved card, clicked once, and its page read in the
 * same tab), or the review page of a completed product task (`--source-task NAME --reviews`; 查看全部 is clicked once and
 * the loaded reviews of its default list are read), or the spec drawers of a completed product task (`--source-task NAME
 * --spec-prices`; each bar buy button opens its drawer once and the options are clicked one at a time). PDD products are reached only from a search card (user, 2026-10-27).
 * @param {{stateDirectory: string, task: string, search?: string, tabId?: number, sourceTask?: string, position?: number, reviews?: boolean, specPrices?: boolean,
 *   bridge: object}} options
 *   Other CLI options must be unset.
 * @returns {Promise<object>} Task identity.
 * @throws {ShoppingError} UNSUPPORTED_PLATFORM, INVALID_ARGUMENTS, INVALID_SEARCH, SOURCE_TASK_NOT_READY, TASK_EXISTS or PLATFORM_TASK_UNFINISHED.
 * @example await createPddTask({ stateDirectory, task: 'pdd-mouse', search: '罗技 M330', tabId: 88, bridge });
 * @example await createPddTask({ stateDirectory, task: 'pdd-mouse-2', sourceTask: 'pdd-mouse', position: 2, bridge });
 * @example await createPddTask({ stateDirectory, task: 'pdd-mouse-2-reviews', sourceTask: 'pdd-mouse-2', reviews: true, bridge });
 */
export async function createPddTask(options) {
  const { stateDirectory, task: name, search, tabId, sourceTask, position, reviews = false, specPrices = false, specGroup, specChoose, orders = false, orderPosition, sort, minPrice, maxPrice, bridge } = options;
  taskName(name);
  if (OTHER_PLATFORM_OPTIONS.some(key => options[key] !== undefined && options[key] !== false)) throw new ShoppingError('UNSUPPORTED_PLATFORM', USAGE);
  if (!isExtensionProtocol(bridge.protocol)) throw new ShoppingError('INVALID_ARGUMENTS', 'PDD tasks run on the extension connection.');
  const ranged = minPrice !== undefined || maxPrice !== undefined;
  if ((sort !== undefined || ranged) && (search === undefined || tabId === undefined)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use --sort or --min-price/--max-price with --search QUERY --tab ID on a search page opened by page-open --platform pdd --search.');
  }
  if (orders) {
    if (tabId === undefined || [search, sourceTask, position, orderPosition].some(value => value !== undefined) || reviews) {
      throw new ShoppingError('INVALID_ARGUMENTS', 'Use task-start --platform pdd --task NAME --orders --tab ID on a list opened by page-open --platform pdd --orders.');
    }
    return withTaskStore(stateDirectory, name, async store => {
      await store.create(newTask(name, 'pdd_orders', bridge, { tab_id: tabId, target: parsePddOrderListUrl('https://mobile.pinduoduo.com/orders.html') }));
      return { ok: true, status: 'task_created', task: name, task_kind: 'pdd_orders', platform: 'pdd', products: 0, operations: 1,
        next_action: 'Run task-run for this task. It reads the loaded order cards once; nothing is clicked or scrolled. The list shows no order numbers.' };
    });
  }
  if (orderPosition !== undefined) {
    if (sourceTask === undefined || [search, tabId, position].some(value => value !== undefined) || reviews) {
      throw new ShoppingError('INVALID_ARGUMENTS', 'Use task-start --platform pdd --task NAME --source-task ORDERS_TASK --order-position N; the tab is the list task\'s.');
    }
    return createOrderDetailTask(stateDirectory, name, sourceTask, orderPosition, bridge);
  }
  if (reviews && specPrices) throw new ShoppingError('INVALID_ARGUMENTS', 'Use either --reviews or --spec-prices.');
  if (specGroup !== undefined && !specPrices) throw new ShoppingError('INVALID_ARGUMENTS', '--spec-group NAME goes with --spec-prices.');
  if (specChoose !== undefined && specGroup === undefined) throw new ShoppingError('INVALID_ARGUMENTS', '--spec-choose GROUP=TEXT goes with --spec-prices and --spec-group.');
  if (specPrices) {
    if (sourceTask === undefined || position !== undefined || search !== undefined || tabId !== undefined || orders || orderPosition !== undefined) {
      throw new ShoppingError('INVALID_ARGUMENTS', 'Use task-start --platform pdd --task NAME --source-task PRODUCT_TASK --spec-prices; the tab is the product task\'s.');
    }
    return createSpecPricesTask(stateDirectory, name, sourceTask, bridge, specGroup, specChoose);
  }
  if (reviews) {
    if (sourceTask === undefined || position !== undefined || search !== undefined || tabId !== undefined) {
      throw new ShoppingError('INVALID_ARGUMENTS', 'Use task-start --platform pdd --task NAME --source-task PRODUCT_TASK --reviews; the tab is the product task\'s.');
    }
    return createReviewsTask(stateDirectory, name, sourceTask, bridge);
  }
  if (sourceTask !== undefined || position !== undefined) {
    if (sourceTask === undefined || position === undefined || search !== undefined || tabId !== undefined) {
      throw new ShoppingError('INVALID_ARGUMENTS', 'Use task-start --platform pdd --task NAME --source-task SEARCH_TASK --position N; the tab is the search task\'s.');
    }
    return createProductTask(stateDirectory, name, sourceTask, position, bridge);
  }
  if (search === undefined || tabId === undefined) throw new ShoppingError('INVALID_ARGUMENTS', 'Use task-start --platform pdd --task NAME --search QUERY --tab ID.');
  const target = pddSearchTarget(search);
  if (sort !== undefined || ranged) {
    const wholeYuan = value => typeof value === 'string' && /^[0-9]{1,7}$/.test(value) ? Number(value) : Number.NaN;
    const state = newPddSortReadState(sort ?? null, ranged ? { minimum: wholeYuan(minPrice), maximum: wholeYuan(maxPrice) } : null);
    return withTaskStore(stateDirectory, name, async store => {
      await store.create(newTask(name, 'pdd_search_sort', bridge, { tab_id: tabId, target, extra: { sort_read: state } }));
      return { ok: true, status: 'task_created', task: name, task_kind: 'pdd_search_sort', platform: 'pdd', products: 0, operations: 1,
        next_action: `Run task-run for this task. On the fresh search page it ${state.range ? `opens 筛选, types ${state.range.minimum} and ${state.range.maximum} and clicks 确认 once` : ''}` +
          `${state.range && state.sort ? ', then ' : ''}${state.sort ? `clicks ${PDD_SORTS[state.sort].map(step => step.label).join(' then ')} once each` : ''}, ` +
          'checks the page after every action, then reads the loaded cards; nothing is scrolled.' };
    });
  }
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'pdd_search', bridge, { tab_id: tabId, target }));
    return { ok: true, status: 'task_created', task: name, task_kind: 'pdd_search', platform: 'pdd', products: 0, operations: 1,
      next_action: 'Run task-run for this task. It reads the loaded search cards once; nothing is clicked or scrolled. PDD cards carry no product number and a shortened title.' };
  });
}

async function createProductTask(stateDirectory, name, sourceTask, position, bridge) {
  taskName(sourceTask);
  if (sourceTask === name) throw new ShoppingError('INVALID_ARGUMENTS', 'The source task must be another task.');
  const source = await loadTask(stateDirectory, sourceTask);
  const [op] = source.operations;
  // A sorted or ranged search leaves its cards on the tab in the saved order, so card N is clicked the same way (2026-11-08).
  if (!['pdd_search', 'pdd_search_sort'].includes(source.kind) || source.status !== 'complete' || op?.status !== 'succeeded') {
    throw new ShoppingError('SOURCE_TASK_NOT_READY', 'The source must be a completed PDD search or sorted search task.');
  }
  if (source.endpoint !== bridge.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'The source task must use the selected bridge.');
  const items = source.kind === 'pdd_search' ? op.result.items : op.result.search.items;
  const item = items[position - 1];
  if (!item) throw new ShoppingError('INVALID_ARGUMENTS', `The source search read ${items.length} cards; choose --position within them.`);
  const state = newPddProductReadState(sourceTask, position, item);
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'pdd_product', bridge, { tab_id: op.tab_id, target: op.target, extra: { product_read: state } }));
    return { ok: true, status: 'task_created', task: name, task_kind: 'pdd_product', platform: 'pdd', products: 1, operations: 1,
      next_action: 'Run task-run for this task. It checks card N on the search tab, clicks it once and reads the product page that opens in the same tab; the search page is left behind.' };
  });
}

async function createReviewsTask(stateDirectory, name, sourceTask, bridge) {
  taskName(sourceTask);
  if (sourceTask === name) throw new ShoppingError('INVALID_ARGUMENTS', 'The source task must be another task.');
  const source = await loadTask(stateDirectory, sourceTask);
  const [op] = source.operations;
  if (source.kind !== 'pdd_product' || source.status !== 'complete' || op?.status !== 'succeeded') {
    throw new ShoppingError('SOURCE_TASK_NOT_READY', 'The source must be a completed PDD product task.');
  }
  if (source.endpoint !== bridge.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'The source task must use the selected bridge.');
  const state = newPddReviewsReadState(sourceTask, op.result);
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'pdd_reviews', bridge, { tab_id: op.tab_id, target: op.target, extra: { reviews_read: state } }));
    return { ok: true, status: 'task_created', task: name, task_kind: 'pdd_reviews', platform: 'pdd', products: 1, operations: 1,
      next_action: state.review_count ? 'Run task-run for this task. It checks the product page still shows the saved review count, clicks 查看全部 once and reads the loaded reviews of the page that opens in the same tab; nothing is scrolled.'
        : 'Run task-run for this task. The product page showed no reviews, so nothing is clicked and the result says so.' };
  });
}

/** Parse --spec-choose GROUP=TEXT (such as 颜色分类=白色) into the journal's preset; undefined stays null. */
function parseSpecChoose(value) {
  if (value === undefined) return null;
  const at = typeof value === 'string' ? value.indexOf('=') : -1;
  const group = at > 0 ? value.slice(0, at).trim() : '', text = at > 0 ? value.slice(at + 1).trim() : '';
  if (!group || group.length > 40 || !text || text.length > 40) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use --spec-choose GROUP=TEXT with a spec group name the product task read and part of an option text, such as 颜色分类=白色.');
  }
  return { group, text };
}

async function createSpecPricesTask(stateDirectory, name, sourceTask, bridge, specGroup, specChoose) {
  if (specGroup !== undefined && (typeof specGroup !== 'string' || !specGroup.trim() || specGroup.length > 40)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use --spec-group with a spec group name as the product task read it, such as 鞋码.');
  }
  const preset = parseSpecChoose(specChoose);
  taskName(sourceTask);
  if (sourceTask === name) throw new ShoppingError('INVALID_ARGUMENTS', 'The source task must be another task.');
  const source = await loadTask(stateDirectory, sourceTask);
  const [op] = source.operations;
  if (source.kind !== 'pdd_product' || source.status !== 'complete' || op?.status !== 'succeeded') {
    throw new ShoppingError('SOURCE_TASK_NOT_READY', 'The source must be a completed PDD product task.');
  }
  if (source.endpoint !== bridge.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'The source task must use the selected bridge.');
  const state = newPddSpecReadState(sourceTask, op.result, { focusGroup: specGroup?.trim() ?? null, preset });
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'pdd_spec_prices', bridge, { tab_id: op.tab_id, target: op.target, extra: { spec_read: state } }));
    return { ok: true, status: 'task_created', task: name, task_kind: 'pdd_spec_prices', platform: 'pdd', products: 1, operations: 1,
      ...(state.focus_group ? { focus_group: state.focus_group } : {}), ...(state.preset ? { preset: state.preset } : {}),
      next_action: `Run task-run for this task. On the product page it opens the drawer of each bottom bar buy button once, ${state.preset ? `first clicks the one ${state.preset.group} option containing ${JSON.stringify(state.preset.text)} (none if no single option matches or it is greyed; drawers[].preset says what happened), then ` : ''}clicks the options that are not selected one at a time${state.focus_group ? ` in the group ${state.focus_group} only (the other groups keep ${state.preset ? 'that choice and ' : ''}the page's selection)` : ''} (at most 12 clicks per drawer), reads the drawer header after each and closes the drawer with its close icon. It never clicks 确定, the drawer's own buttons or the quantity, and stops if the tab leaves the product page. Each click waits about 4 s, so the run often takes 1-3 minutes: give task-run a command timeout of 10 minutes, not 2.` };
  });
}

async function createOrderDetailTask(stateDirectory, name, sourceTask, position, bridge) {
  taskName(sourceTask);
  if (sourceTask === name) throw new ShoppingError('INVALID_ARGUMENTS', 'The source task must be another task.');
  const source = await loadTask(stateDirectory, sourceTask);
  const [op] = source.operations;
  if (source.kind !== 'pdd_orders' || source.status !== 'complete' || op?.status !== 'succeeded') {
    throw new ShoppingError('SOURCE_TASK_NOT_READY', 'The source must be a completed PDD order list task.');
  }
  if (source.endpoint !== bridge.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'The source task must use the selected bridge.');
  const order = op.result.orders[position - 1];
  if (!order) throw new ShoppingError('INVALID_ARGUMENTS', `The source list read ${op.result.orders.length} orders; choose --order-position within them.`);
  const state = newPddOrderDetailReadState(sourceTask, position, order);
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'pdd_order_detail', bridge, { tab_id: op.tab_id, target: op.target, extra: { order_detail_read: state } }));
    return { ok: true, status: 'task_created', task: name, task_kind: 'pdd_order_detail', platform: 'pdd', products: 0, operations: 1,
      next_action: 'Run task-run for this task. It checks order N on the list tab, clicks its product name once, clicks 查看更多订单和优惠信息 once on the order page that opens in the same tab and reads it without the consignee, payment and logistics rows.' };
  });
}
