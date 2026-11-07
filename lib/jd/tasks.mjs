import { isExtensionProtocol } from '../bridge-protocol.mjs';
import { ShoppingError } from '../errors.mjs';
import { parseTabId } from '../targets.mjs';
import { TASK_POLICY } from '../task-policy.mjs';
import { taskName, withTaskStore } from '../task-store.mjs';
import { loadBinding } from '../state.mjs';
import { loadReviewCategoryPlan } from '../review-category-plan.mjs';
import { newJdProductReadState } from './product-read.mjs';
import { newJdReviewReadState } from './review-read.mjs';
import { newJdOrderDetailReadState } from './order-detail-read.mjs';
import { newJdSearchPagesState } from './search-pages-read.mjs';
import { newJdSearchSortState } from './search-sort-read.mjs';
import { jdSearchTarget, parseJdCartUrl, parseJdOrderListUrl } from './targets.mjs';

// Taobao task modes without a JD implementation are refused rather than silently ignored.
const TAOBAO_ONLY_OPTIONS = ['plan', 'mainImages', 'cartRows', 'orderRows',
  'orderBody', 'sourceTask', 'source', 'filters', 'inspectControls', 'inspectPrice',
  'inspectPriceHover', 'reviews', 'services', 'descriptionExpand', 'descriptionImageLoad', 'gallery', 'specificationImages'];

function operation(tabId, target, extra = {}) {
  return { tab_id: parseTabId(tabId), target, status: 'pending', attempts: 0, retries: 0, not_before: 0, recovery_kind: null, error: null, result: null, ...extra };
}

function newTask(name, kind, bridge, op) {
  const now = new Date().toISOString();
  return { schema_version: 1, id: name, kind, platform: 'jd', endpoint: bridge.endpoint, status: 'pending',
    created_at: now, updated_at: now, policy: TASK_POLICY, retries: 0, cooldown_probes: 0, wait_reserved_ms: 0, not_before: 0, operations: [op] };
}

/**
 * Save a JD task: the first screen of a search (`--search QUERY --tab ID`), or of pages 1..N reached by clicking 下一页
 * (`--pages N`, 2-5, on a tab showing page 1), the same after one sort (`--sort sales|price-desc|price-asc`, in the default
 * 综合 view), the same after a price range (`--min-price A --max-price B`, whole yuan, set before any sort), one bound product page with its
 * 商品详情 section (`--bindings NAME --details`), up to three 全部评价 categories on one bound product
 * (`--bindings NAME --review-categories FILE`), the loaded cart rows (`--cart --tab ID`, a tab from
 * `page-open --platform jd --cart`), or the loaded order list cards (`--orders --tab ID`, a tab from
 * `page-open --platform jd --orders`), or one order's detail page opened from that list (`--order-detail --tab ID --order-position N`).
 * The binding comes from `bind --platform jd`.
 * @param {{stateDirectory: string, task: string, search?: string, tabId?: number, pages?: number, sort?: string, minPrice?: string, maxPrice?: string, bindings?: string[], details?: boolean, reviewCategories?: string, cart?: boolean, orders?: boolean,
 *   orderDetail?: boolean, orderPosition?: number, bridge: object}} options
 *   Other CLI options must be unset.
 * @returns {Promise<object>} Task identity. @throws {ShoppingError} UNSUPPORTED_PLATFORM, INVALID_ARGUMENTS, INVALID_SEARCH, INVALID_REVIEW_CATEGORIES, a binding error,
 *   TASK_EXISTS or PLATFORM_TASK_UNFINISHED (another unfinished JD task).
 * @example await createJdTask({ stateDirectory, task: 'jd-mouse', search: '罗技 M330', tabId: 88, bridge });
 * @example await createJdTask({ stateDirectory, task: 'jd-mouse-pages', search: '罗技 M330', tabId: 88, pages: 3, bridge });
 * @example await createJdTask({ stateDirectory, task: 'jd-mouse-cheap', search: '罗技 M330', tabId: 88, sort: 'price-asc', pages: 2, bridge });
 * @example await createJdTask({ stateDirectory, task: 'jd-mouse-60-90', search: '罗技 M330', tabId: 88, minPrice: '60', maxPrice: '90', sort: 'price-asc', bridge });
 * @example await createJdTask({ stateDirectory, task: 'jd-mouse-detail', bindings: ['jd-mouse'], details: true, bridge });
 * @example await createJdTask({ stateDirectory, task: 'jd-mouse-reviews', bindings: ['jd-mouse'], reviewCategories: 'categories.json', bridge });
 * @example await createJdTask({ stateDirectory, task: 'jd-cart', cart: true, tabId: 88, bridge });
 * @example await createJdTask({ stateDirectory, task: 'jd-orders', orders: true, tabId: 89, bridge });
 * @example await createJdTask({ stateDirectory, task: 'jd-order-1', orderDetail: true, orderPosition: 1, tabId: 89, bridge });
 */
export async function createJdTask(options) {
  const { stateDirectory, task: name, search, tabId, pages, sort, minPrice, maxPrice, bindings, details = false, reviewCategories, cart = false, orders = false, orderDetail = false,
    orderPosition, bridge } = options;
  taskName(name);
  const ranged = minPrice !== undefined || maxPrice !== undefined;
  // --pages, --sort and the price range exist on JD for searches only; with any other JD mode they stay Taobao options.
  if (TAOBAO_ONLY_OPTIONS.some(key => options[key] !== undefined && options[key] !== false) || ((pages !== undefined || sort !== undefined || ranged) && search === undefined)) {
    throw new ShoppingError('UNSUPPORTED_PLATFORM', 'JD tasks support --search QUERY with --tab ID [--min-price A --max-price B] [--sort sales|price-desc|price-asc] [--pages N], one --bindings NAME with --details, one --bindings NAME with --review-categories FILE, --cart or --orders with --tab ID, or --order-detail with --tab ID and --order-position N.');
  }
  if (!isExtensionProtocol(bridge.protocol)) throw new ShoppingError('INVALID_ARGUMENTS', 'JD tasks run on the extension connection.');
  if (orderPosition !== undefined && !orderDetail) throw jdUsageError();
  if (cart || orders || orderDetail) {
    if ([cart, orders, orderDetail].filter(Boolean).length !== 1 || tabId === undefined || search !== undefined || bindings !== undefined || details ||
        reviewCategories !== undefined || (orderDetail && orderPosition === undefined)) throw jdUsageError();
    if (orderDetail) return createOrderDetailTask(stateDirectory, name, tabId, orderPosition, bridge);
    return cart ? createCartTask(stateDirectory, name, tabId, bridge) : createOrdersTask(stateDirectory, name, tabId, bridge);
  }
  if (search !== undefined && tabId !== undefined && bindings === undefined && !details && reviewCategories === undefined) {
    if (sort !== undefined || ranged) {
      const priceRange = ranged ? { minimum: wholeYuan(minPrice), maximum: wholeYuan(maxPrice) } : null;
      return createSearchSortTask(stateDirectory, name, search, tabId, sort ?? null, pages, priceRange, bridge);
    }
    return pages === undefined ? createSearchTask(stateDirectory, name, search, tabId, bridge) : createSearchPagesTask(stateDirectory, name, search, tabId, pages, bridge);
  }
  if (bindings?.length === 1 && details && search === undefined && tabId === undefined && reviewCategories === undefined) return createProductTask(stateDirectory, name, bindings[0], bridge);
  if (bindings?.length === 1 && reviewCategories && !details && search === undefined && tabId === undefined) return createReviewTask(stateDirectory, name, bindings[0], reviewCategories, bridge);
  throw jdUsageError();
}

function jdUsageError() {
  return new ShoppingError('INVALID_ARGUMENTS', 'Use task-start --platform jd --task NAME with --search QUERY --tab ID [--min-price A --max-price B] [--sort sales|price-desc|price-asc] [--pages 2-5], one --bindings NAME and --details, one --bindings NAME and --review-categories FILE, --cart or --orders with --tab ID, or --order-detail --tab ID --order-position N.');
}

async function createSearchTask(stateDirectory, name, search, tabId, bridge) {
  const target = jdSearchTarget(search);
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'jd_search', bridge, operation(tabId, target)));
    return { ok: true, status: 'task_created', task: name, task_kind: 'jd_search', platform: 'jd', products: 0, operations: 1,
      next_action: 'Run task-run for this task. It reads the loaded first screen of results once; nothing is clicked or scrolled.' };
  });
}

async function createSearchPagesTask(stateDirectory, name, search, tabId, pages, bridge) {
  const target = jdSearchTarget(search);
  const state = newJdSearchPagesState(pages);
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'jd_search_pages', bridge, operation(tabId, target, { search_pages_read: state })));
    return { ok: true, status: 'task_created', task: name, task_kind: 'jd_search_pages', platform: 'jd', products: 0, operations: 1,
      next_action: 'Run task-run for this task. The tab must show page 1. It reads the loaded first screen of each page and clicks 下一页 once per further page; nothing is scrolled.' };
  });
}

/** CLI text to whole yuan; anything else becomes NaN, which newJdSearchSortState refuses. */
function wholeYuan(value) {
  return typeof value === 'string' && /^[0-9]{1,7}$/.test(value) ? Number(value) : Number.NaN;
}

async function createSearchSortTask(stateDirectory, name, search, tabId, sort, pages, priceRange, bridge) {
  const target = jdSearchTarget(search);
  const state = newJdSearchSortState(sort, pages ?? 1, priceRange);
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'jd_search_sort', bridge, operation(tabId, target, { search_sort_read: state })));
    return { ok: true, status: 'task_created', task: name, task_kind: 'jd_search_sort', platform: 'jd', products: 0, operations: 1,
      next_action: priceRange ? 'Run task-run for this task. The tab must show page 1 in the default 综合 sort with no price range. It opens 价格区间, types both bounds and clicks 确定 once, checks the range on the page and that every card lies inside it, then sorts if asked and reads the first screen of each requested page; nothing is scrolled. 确定 and each click count as a search load, so a long task may pause for the pacing quota; run task-run again after the wait.'
        : 'Run task-run for this task. The tab must show page 1 in the default 综合 sort. It clicks 销量 once, or 价格 once (high to low) or twice (low to high), checks the sort on the page and the cards, then reads the first screen of each requested page; nothing is scrolled. Each click counts as a search load, so a long task may pause for the pacing quota; run task-run again after the wait.' };
  });
}

async function createCartTask(stateDirectory, name, tabId, bridge) {
  const target = parseJdCartUrl('https://cart.jd.com/cart_index');
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'jd_cart', bridge, operation(tabId, target)));
    return { ok: true, status: 'task_created', task: name, task_kind: 'jd_cart', platform: 'jd', products: 0, operations: 1,
      next_action: 'Run task-run for this task. It reads the loaded cart rows once; nothing is clicked or scrolled.' };
  });
}

async function createOrdersTask(stateDirectory, name, tabId, bridge) {
  const target = parseJdOrderListUrl('https://order.jd.com/center/list.action');
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'jd_orders', bridge, operation(tabId, target)));
    return { ok: true, status: 'task_created', task: name, task_kind: 'jd_orders', platform: 'jd', products: 0, operations: 1,
      next_action: 'Run task-run for this task. It reads the loaded order cards once; nothing is clicked, scrolled or paged.' };
  });
}

async function createOrderDetailTask(stateDirectory, name, tabId, position, bridge) {
  const target = parseJdOrderListUrl('https://order.jd.com/center/list.action');
  const state = newJdOrderDetailReadState(position);
  return withTaskStore(stateDirectory, name, async store => {
    await store.create(newTask(name, 'jd_order_detail', bridge, operation(tabId, target, { order_detail_read: state })));
    return { ok: true, status: 'task_created', task: name, task_kind: 'jd_order_detail', platform: 'jd', products: 0, operations: 1,
      next_action: 'Run task-run for this task. It reads the order at this position on the list, clicks 订单详情 once, reads the new detail tab and closes it. Pop-ups must be allowed for order.jd.com.' };
  });
}

async function createReviewTask(stateDirectory, name, binding, reviewCategories, bridge) {
  const plan = await loadReviewCategoryPlan(reviewCategories);
  return withTaskStore(stateDirectory, name, async store => {
    const record = await loadBinding(stateDirectory, binding);
    if (record.platform !== 'jd') throw new ShoppingError('UNSUPPORTED_PLATFORM', 'Use a binding made with bind --platform jd.');
    if (record.endpoint !== bridge.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'The binding must use the selected bridge.');
    await store.create(newTask(name, 'jd_review_categories', bridge, operation(record.tab_id, record.target, {
      review_categories: plan, review_read: newJdReviewReadState(plan),
    })));
    return { ok: true, status: 'task_created', task: name, task_kind: 'jd_review_categories', platform: 'jd', products: 1, operations: 1,
      next_action: 'Run task-run for this task. It reads up to three 全部评价 categories; the page must be visible, and the panel is closed only if this task opened it.' };
  });
}

async function createProductTask(stateDirectory, name, binding, bridge) {
  return withTaskStore(stateDirectory, name, async store => {
    const record = await loadBinding(stateDirectory, binding);
    if (record.platform !== 'jd') throw new ShoppingError('UNSUPPORTED_PLATFORM', 'Use a binding made with bind --platform jd.');
    if (record.endpoint !== bridge.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'The binding must use the selected bridge.');
    await store.create(newTask(name, 'jd_product', bridge, operation(record.tab_id, record.target, { product_read: newJdProductReadState() })));
    return { ok: true, status: 'task_created', task: name, task_kind: 'jd_product', platform: 'jd', products: 1, operations: 1,
      next_action: 'Run task-run for this task. It reads the product page and, if the 商品详情 section has not loaded, scrolls to it once; nothing is clicked.' };
  });
}
