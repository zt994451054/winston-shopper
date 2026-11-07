import { parseProductUrl } from '../lib/targets.mjs';
import { validateProduct } from '../lib/product.mjs';

/** Build synthetic public observations, without real customer information. */
export function rawProduct(id = '123') {
  return { state: 'observed', product_id: id, url: `https://detail.tmall.com/item.htm?id=${id}`, title: 'Example mouse',
    groups: [{ name: '颜色分类', options: [{ label: '黑色', selected: true, disabled: null }, { label: '白色', selected: null, disabled: true }] }],
    prices: [{ raw: '店铺优惠后 ￥89 起', label: '店铺优惠后', amount_text: '89', qualifier: '起' }],
    reviews: [{ body: 'Synthetic review', date_text: '2026-09-01' }] };
}

/** Return a normalized snapshot for task-controller tests. */
export function productResult(id = '123') {
  const raw = rawProduct(id);
  return validateProduct(raw, parseProductUrl(raw.url));
}
