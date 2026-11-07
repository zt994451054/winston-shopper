/** @returns {object} Synthetic search cards, with duplicates and a tracking URL. */
export function rawSearch(target) {
  const card = { url: 'https://detail.tmall.com/item.htm?id=123&tracking=secret', title: 'Synthetic mouse', shop: 'Synthetic shop',
    price: { raw: '补贴后 ¥89起', amount_text: '89', label: '补贴后' }, sales_text: '100+人付款' };
  return { state: 'observed', query: target.query, url: target.url, cards_seen: 3,
    items: [card, { ...card }, { ...card, url: 'https://item.taobao.com/item.htm?id=456' }] };
}

/** @returns {object} Synthetic identical reviews that must remain separate observations. */
export function rawReviews(target) {
  return { state: 'observed', product_id: target.product_id, url: target.url, total_text: '用户评价·100+', loaded_count: 2,
    reviews: [1, 2].map(() => ({ body: 'Synthetic review', purchase_text: '2026年9月22日已购：黑色', username: 'DO_NOT_KEEP' })) };
}
