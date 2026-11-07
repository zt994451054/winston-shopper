/** Synthetic adapter evidence; these messages and fields are not a verified Taobao DOM layout. */
export function emptyListObservation(kind, plan = null) {
  const cart = kind === 'cart';
  return {
    state: 'observed_empty',
    url: cart ? 'https://cart.taobao.com/cart.htm' : 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
    observed_at: '2026-10-10T01:00:00.000Z',
    source: cart ? 'trade_cart_item_info_dom' : 'trade_bought_list_order_dom',
    [cart ? 'loaded_rows_seen' : 'loaded_orders_seen']: 0,
    [cart ? 'rows' : 'orders']: [],
    empty_evidence: {
      scope: 'current_list_view', basis: 'explicit_empty_notice',
      message: { text: '离线测试：当前列表没有项目', truncated: false },
      list_root_count: 1, notice_count: 1, notice_visible: true,
      notice_within_list: true, document_ready: true, gates_clear: true,
    },
    ...(plan ? { start: plan.start, limit: plan.limit, prefix: plan.guards } : {}),
  };
}
