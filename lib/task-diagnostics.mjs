import { ShoppingError } from './errors.mjs';
import { EXTENSION_INVENTORY_SCOPE, requireLiveTaskChannel } from './bridge-protocol.mjs';
import { withTaskStore } from './task-store.mjs';
import { parseProductUrl } from './targets.mjs';
import { isSearchHome, parseSearchPageUrl, parseSortableSearchUrl } from './search.mjs';
import { searchPagesTargets } from './search-pages.mjs';
import { searchCollectionTargets } from './search-collection.mjs';
import { orderPagesAllowed } from './order-pages.mjs';
import { parseSearchRangeUrl } from './search-page-range.mjs';
import { matchesSearchSort } from './search-sort.mjs';
import { parseCartUrl } from './cart-target.mjs';
import { parseOrderListUrl, parseOrderDetailUrl } from './order-target.mjs';
import { orderDetailMatchingTabs } from './order-detail-check.mjs';

function matchesTarget(url, target, searching, cart = false, orders = false) {
  return (orders ? parseOrderListUrl(url) : cart ? parseCartUrl(url) : searching ? parseSearchPageUrl(url) : parseProductUrl(url))?.url === target.url;
}

function targetReason(tab, target, searching) {
  if (!tab) return 'tab_not_in_current_window';
  if (matchesTarget(tab.url, target, searching)) return 'matching_target';
  let url;
  try { url = new URL(tab.url); } catch { return 'unsupported_url'; }
  if (['login.taobao.com', 'login.tmall.com'].includes(url.hostname)) return 'login_page';
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['taobao.com', 'tmall.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    return 'other_site_or_browser_page';
  }
  if (searching && isSearchHome(tab.url)) return 'search_home';
  if (searching && url.origin === target.origin && url.pathname === target.pathname) {
    return url.searchParams.getAll('q').length === 1 && url.searchParams.get('q') !== target.query
      ? 'different_search_query' : 'unsupported_search_url';
  }
  return 'target_mismatch';
}

/**
 * Compare unfinished task targets with one fresh tab inventory, without evaluating pages.
 * Only expected URLs, reason codes and exact-match tab IDs leave this boundary; unrelated
 * URLs, search terms and private page parameters are never returned or stored.
 * @param {{stateDirectory: string, task: string, bridge: object}} options
 * @returns {Promise<object>} Address diagnostics, without changing checkpoints or budgets.
 * @throws {ShoppingError} Checkpoint, lock, endpoint, connection or tab protocol errors; no retries.
 * @example await diagnoseTask({ stateDirectory, task: 'mouse-search', bridge });
 */
export async function diagnoseTask({ stateDirectory, task: name, bridge }) {
  return withTaskStore(stateDirectory, name, async store => {
    const task = await store.load();
    if (task.endpoint !== bridge.endpoint) {
      throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'Restore the original bridge endpoint before diagnosing this task.');
    }
    const pending = task.operations.map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => !['succeeded', 'failed'].includes(operation.status));
    if (pending.length) requireLiveTaskChannel(task);
    let tabs = [];
    if (pending.length) {
      await bridge.requireConnected();
      tabs = await bridge.listTabs();
    }
    const searching = ['search', 'search_pages', 'search_collection', 'search_sort', 'search_price', 'search_controls', 'search_price_entry', 'search_price_hover'].includes(task.kind);
    return {
      ok: true, status: 'target_diagnosed', task: task.id, task_status: task.status,
      observed_at: new Date().toISOString(),
      inventory_scope: bridge.inventoryScope ?? EXTENSION_INVENTORY_SCOPE,
      operations: pending.map(({ operation, index }) => {
        if (task.kind === 'order_body_snapshot') {
          const current = tabs.find(tab => tab.id === operation.tab_id);
          const matches = tabs.filter(tab => parseOrderDetailUrl(tab.url)?.url === operation.target.url);
          return {operation_index:index+1,tab_id:operation.tab_id,expected_url:operation.target.url,
            reason:!current ? 'saved_tab_unavailable' : matches.some(tab => tab.id === operation.tab_id) ? 'matching_target' : targetReason(current, operation.target, false),
            matching_tab_ids:matches.map(tab => tab.id),replacement_allowed:false,action_reserved:false,action_will_repeat:false};
        }
        if (task.kind === 'order_detail_check') {
          const matches = orderDetailMatchingTabs(operation, tabs), state = operation.order_detail_check;
          return {operation_index:index+1,tab_id:state.detail_tab_id ?? operation.tab_id,
            expected_url:state.action_reserved ? operation.target.url : operation.source.list_url,
            reason:matches.some(tab => tab.id === (state.detail_tab_id ?? operation.tab_id)) ? 'matching_target' : 'saved_or_new_target_unconfirmed',
            matching_tab_ids:matches.map(tab => tab.id),action_reserved:state.action_reserved,action_will_repeat:false};
        }
        const targets = task.kind === 'search_collection' ? searchCollectionTargets(operation.target, operation.search_collection)
          : task.kind === 'search_pages' ? searchPagesTargets(operation.target, operation.search_pages) : [operation.target];
        const current = tabs.find(tab => tab.id === operation.tab_id);
        const matches = url => ['search_controls', 'search_price_entry', 'search_price_hover'].includes(task.kind) ? parseSortableSearchUrl(url)?.query === operation.target.query : task.kind === 'search_sort' ? matchesSearchSort(url, operation.target, operation.search_sort)
          : task.kind === 'search_collection' ? targets.some(target => parseSearchRangeUrl(url)?.url === target.url)
          : targets.some(target => matchesTarget(url, target, searching, ['cart_snapshot', 'cart_collection'].includes(task.kind), ['order_snapshot', 'order_collection', 'order_pages'].includes(task.kind)));
        return {
        operation_index: index + 1, tab_id: operation.tab_id, expected_url: operation.target.url,
        ...(['search_pages', 'search_collection'].includes(task.kind) ? { allowed_urls: targets.map(target => target.url) } : {}),
        ...(['search_controls', 'search_price_entry', 'search_price_hover'].includes(task.kind) ? { allowed_pages: [1, 2], sort_parameter_allowed: true } : {}),
        ...(task.kind === 'search_sort' ? { allowed_pages: [1, 2], sort_parameter_allowed: operation.search_sort.action_reserved } : {}),
        // The list address is the same on every page; only the next read can confirm the page from the pager.
        ...(task.kind === 'order_pages' ? { allowed_pages: orderPagesAllowed(operation.order_pages), page_shown_in_address: false,
          actions_reserved: operation.order_pages.transitions.length, action_will_repeat: false } : {}),
        ...(task.kind === 'search_price' ? { allowed_pages: [1], replacement_allowed: operation.search_price.actions.length === 0,
          actions_reserved: operation.search_price.actions.length, action_will_repeat: false } : {}),
        reason: matches(current?.url) ? 'matching_target' : targetReason(current, operation.target, searching),
        matching_tab_ids: tabs.filter(tab => matches(tab.url)).map(tab => tab.id),
      }; }),
      page_content_read: false, state_changed: false, login_verified: false,
      next_action: bridge.inventoryScope === 'saved_session_page'
        ? 'Address check of the saved dedicated page only. Restore its target, then use the recovery allowed by the saved task status. No other session was selected.'
        : 'Address check only, limited to the extension current window. Bring the target Chrome window forward, restore the exact target, then use the recovery allowed by the saved task status. No tab was selected or changed.',
    };
  });
}
