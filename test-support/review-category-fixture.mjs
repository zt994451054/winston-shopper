import { validateReviewCategoryObservation } from '../lib/review-categories.mjs';

/** @param {object} target @param {string} [selected] @param {string} [body] @returns {object} Synthetic text-only categories and two main reviews. */
export function rawReviewCategories(target, selected = '全部', body = selected) {
  return { state: 'observed', reviews: { schema_version: 4, state: 'observed', product_id: target.product_id, url: target.url,
    total_text: '用户评价·100+', fold_notice_text: '', loaded_count: 2,
    reviews: [0, 1].map(index => ({ body: `${body} ${index}`, purchase_text: '2026年9月23日已购：黑色',
      seller_replies_seen: 0, seller_replies: [], followups_seen: 0, followups: [] })) },
    categories: ['全部', '追评', '静音效果好'].map((label, index) => ({ position: index + 1, label,
      count_text: index ? '20' : '', selected: label === selected, disabled: false, in_viewport: true })), sort_text: '默认排序' };
}

/** @param {object} target @param {string} [selected] @param {string} [body] @returns {object} Validated synthetic category observation. */
export function reviewCategoryObservation(target, selected, body) {
  return validateReviewCategoryObservation(rawReviewCategories(target, selected, body), target);
}
