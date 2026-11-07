import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, responseText, throwPageError } from './page-dom.mjs';
import { reviewsScript, validateReviews, validateSavedReviews, reviewPanelVisibility } from './reviews.mjs';
import { reviewPanelScript } from './review-panel.mjs';

/** @param {unknown} value @returns {Array<string|null>} One to three exact category labels; [null] reads the current category. @throws {ShoppingError} INVALID_REVIEW_CATEGORIES. @example normalizeReviewCategoryPlan(['全部', '追评']); */
export function normalizeReviewCategoryPlan(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length ||
      value.some(label => label === null ? value.length !== 1 : typeof label !== 'string' || !label ||
        label !== label.trim() || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label))) {
    throw new ShoppingError('INVALID_REVIEW_CATEGORIES', 'Use one to three distinct exact labels, or [null] for the current category.');
  }
  return [...value];
}

/** @param {object} value Raw or normalized review collection. @returns {string} Local comparison key, never a platform review ID. @example reviewListKey(snapshot.reviews); */
export function reviewListKey(value) {
  return JSON.stringify(value.reviews.map(review => [review.body, review.purchase_text,
    review.seller_replies.map(reply => reply.raw), review.followups.map(followup =>
      [followup.raw, followup.interval_text, followup.seller_replies.map(reply => reply.raw)])]));
}

function collectCategories(raw, dom, before, label, listKey, visibility) {
  if (raw.state !== 'observed') return raw.state === 'action_required' ? { state: 'review_panel_required' } : raw;
  const drawers = dom.all(document, dom.selector('Drawer')).filter(node => dom.one(node, 'Comments'));
  if (drawers.length !== 1) return { state: 'structure_changed' };
  const roots = dom.all(drawers[0], dom.selector('Comments'));
  if (roots.length !== 1) return { state: 'structure_changed' };
  const root = roots[0], wraps = dom.all(root, dom.selector('expressionWrap'));
  if (wraps.length !== 1) return { state: 'review_categories_ambiguous' };
  const nodes = dom.all(wraps[0], dom.selector('imprItem'));
  if (!nodes.length || nodes.length > 20) return { state: 'review_categories_ambiguous' };
  const categories = nodes.map((node, index) => {
    if (!['SPAN', 'BUTTON'].includes(node.tagName) || node.closest('a')) throw new Error('Unsupported category entry');
    const counts = dom.all(node, dom.selector('imprItemCount'));
    if (counts.length > 1) throw new Error('Ambiguous category count');
    const text = dom.text(node, 121), count = counts.length ? dom.text(counts[0], 41) : '';
    if (!text || text.length > 120 || count.length > 40 || (count && (!/^\d+[+]?$/.test(count) || !text.endsWith(count)))) {
      throw new Error('Ambiguous category label');
    }
    const name = (count ? text.slice(0, -count.length) : text).trim();
    const selected = node.matches(dom.selector('isSelected'));
    const aria = node.getAttribute('aria-selected');
    if (aria !== null && (aria !== 'true' && aria !== 'false' || (aria === 'true') !== selected)) throw new Error('Conflicting selected category');
    const rect = node.getBoundingClientRect();
    return { position: index + 1, label: name, count_text: count, selected,
      disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('data-disabled') === 'true'),
      in_viewport: visibility(node) === null && rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 &&
        rect.x + rect.width <= innerWidth && rect.y + rect.height <= innerHeight };
  });
  if (categories.some(category => !category.label || category.label.length > 80) ||
      new Set(categories.map(category => category.label)).size !== categories.length ||
      categories.filter(category => category.selected).length !== 1) return { state: 'review_categories_ambiguous' };
  const sorts = dom.all(root, dom.selector('sortByText'));
  if (sorts.length > 1) return { state: 'review_categories_ambiguous' };
  const sortText = sorts.length ? dom.text(sorts[0], 80) : '';
  if (!before) return { state: 'observed', reviews: raw, categories, sort_text: sortText };
  if (JSON.stringify(categories) !== JSON.stringify(before.categories) || sortText !== before.sort_text ||
      listKey(raw) !== before.list_key || raw.loaded_count !== before.loaded_count) return { state: 'target_changed' };
  const category = categories.find(category => category.label === label);
  if (!category || category.disabled || !category.in_viewport) return { state: 'review_category_unavailable' };
  if (category.selected) return { state: 'action_dispatched', clicked: false };
  nodes[category.position - 1].click();
  return { state: 'action_dispatched', clicked: true };
}

/**
 * Build a text-only category read or one guarded category click. The caller persists intent first.
 * @param {object} target @param {{before?: object, label?: string}} [options]
 * @returns {string} Fixed page expression; never reads image nodes or paginates.
 * @throws {ShoppingError} Invalid target, plan or baseline.
 * @example reviewCategoriesScript(target, { before: snapshot, label: '追评' });
 */
export function reviewCategoriesScript(target, { before, label } = {}) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required.');
  let baseline = null;
  if (before) {
    validateReviewCategorySnapshot(before, expected);
    normalizeReviewCategoryPlan([label]);
    if (label === null) throw new ShoppingError('INVALID_REVIEW_CATEGORIES', 'A click requires an exact observed label.');
    baseline = { categories: before.categories, sort_text: before.sort_text,
      list_key: reviewListKey(before.reviews), loaded_count: before.reviews.loaded_count };
  } else if (label !== undefined) throw new ShoppingError('INVALID_REVIEW_CATEGORIES', 'A click requires its saved baseline.');
  return `(() => { try { const raw = ${reviewsScript(expected, false, { textOnly: true })};
    if (${before ? 'false' : 'true'} && ['action_required', 'review_drawer_not_visible'].includes(raw.state)) {
      const panel = ${reviewPanelScript(expected)};
      if (panel.state === 'panel_action_required') return panel;
    }
    return (${collectCategories.toString()})(raw, (${pageDom.toString()})(), ${JSON.stringify(baseline)}, ${JSON.stringify(label ?? null)}, ${reviewListKey.toString()}, ${reviewPanelVisibility.toString()});
  } catch { return { state: 'review_categories_ambiguous' }; } })()`;
}

function normalizeCategories(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new ShoppingError('INVALID_RESPONSE', 'Invalid category inventory.');
  const categories = value.map((category, index) => {
    if (!category || Object.keys(category).sort().join(',') !== 'count_text,disabled,in_viewport,label,position,selected' ||
        category.position !== index + 1 || ['selected', 'disabled', 'in_viewport'].some(key => typeof category[key] !== 'boolean')) {
      throw new ShoppingError('INVALID_RESPONSE', 'Invalid category metadata.');
    }
    const label = responseText(category.label, 80), count = responseText(category.count_text, 40);
    if (!label || label !== category.label || (count && !/^\d+[+]?$/.test(count))) throw new ShoppingError('INVALID_RESPONSE', 'Invalid category label or count.');
    return { position: category.position, label, count_text: count, selected: category.selected,
      disabled: category.disabled, in_viewport: category.in_viewport };
  });
  if (new Set(categories.map(category => category.label)).size !== categories.length || categories.filter(category => category.selected).length !== 1) {
    throw new ShoppingError('REVIEW_CATEGORIES_AMBIGUOUS', 'Category labels or selected markers are ambiguous.');
  }
  const selected = categories.find(category => category.selected);
  if (selected.disabled || !selected.in_viewport) throw new ShoppingError('REVIEW_CATEGORY_UNAVAILABLE', 'The selected category is disabled or outside the viewport.');
  return categories;
}

/** @param {unknown} value @param {object} target @returns {object} Text snapshot with the observed category inventory, or bounded loading/opening state. @throws {ShoppingError} Page gates, ambiguity or malformed data. @example validateReviewCategoryObservation(raw, target); */
export function validateReviewCategoryObservation(value, target) {
  throwPageError(value?.state);
  if (value?.state === 'panel_action_required') return { state: 'panel_action_required' };
  if (value?.state === 'waiting_result') return { state: 'waiting_result' };
  if (value?.state !== 'observed' || value.reviews?.schema_version !== 4) throw new ShoppingError('INVALID_RESPONSE', 'Expected text-only review categories.');
  const reviews = validateReviews(value.reviews, target).result;
  const categories = normalizeCategories(value.categories);
  return { state: 'observed', snapshot: { reviews, categories,
    selected_category: categories.find(category => category.selected).label, sort_text: responseText(value.sort_text, 80) } };
}

/** @param {object} value @param {object} target @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for altered text or category evidence. @example validateReviewCategorySnapshot(snapshot, target); */
export function validateReviewCategorySnapshot(value, target) {
  try {
    if (Object.keys(value).join(',') !== 'reviews,categories,selected_category,sort_text' || value.reviews.schema_version !== 4) throw new Error();
    validateSavedReviews(value.reviews, target);
    const categories = normalizeCategories(value.categories);
    if (JSON.stringify(categories) !== JSON.stringify(value.categories) || value.selected_category !== categories.find(category => category.selected).label ||
        responseText(value.sort_text, 80) !== value.sort_text) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved text category snapshot is invalid.'); }
}
