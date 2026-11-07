import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, throwPageError, responseText } from './page-dom.mjs';
import { collectReviewImages, normalizeReviewImages, restoreReviewImages } from './review-images.mjs';

/** @param {Element} root Actual review collection, not its drawer shell. @returns {string|null} Visibility failure state or null; serialized for page-local use. @example reviewPanelVisibility(root); */
export function reviewPanelVisibility(root) {
  const rect = root.getBoundingClientRect();
  if (![rect.x, rect.y, rect.width, rect.height, innerWidth, innerHeight].every(Number.isFinite) ||
      rect.width < 0 || rect.height < 0 || innerWidth <= 0 || innerHeight <= 0) return 'structure_changed';
  // Loaded rows can extend below the scrolling panel; the collection itself must intersect the viewport.
  if (!rect.width || !rect.height || rect.x >= innerWidth || rect.y >= innerHeight ||
      rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return 'review_drawer_not_visible';
  for (let node = root; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
        style.opacity === '0' || node.getAttribute('hidden') !== null || node.getAttribute('inert') !== null ||
        node.getAttribute('aria-hidden') === 'true') return 'review_drawer_not_visible';
  }
  return null;
}

function collectReviews(expected, expand, dom, images, textOnly, panelVisibility) {
  const current = new URL(location.href);
  if (current.origin !== expected.origin || current.pathname !== expected.pathname ||
      current.searchParams.getAll('id').length !== 1 || current.searchParams.get('id') !== expected.product_id) return { state: 'target_changed' };
  const drawers = dom.all(document, dom.selector('Drawer')).filter(node => dom.one(node, 'Comments'));
  const drawer = drawers.length === 1 ? drawers[0] : null;
  const blocked = dom.gate(drawer);
  if (blocked) return { state: blocked };
  if (drawers.length > 1 || dom.all(document, dom.selector('ItemTitle')).length !== 1) return { state: 'structure_changed' };
  if (drawer) {
    const roots = dom.all(drawer, dom.selector('Comments'));
    if (roots.length !== 1) return { state: 'structure_changed' };
    const root = roots[0], visibility = panelVisibility(root);
    if (visibility) return { state: visibility };
    if (expand) return { state: 'action_dispatched', clicked: false };
    const comments = dom.all(root, dom.selector('Comment'));
    if (!comments.length) return { state: 'waiting_result' };
    if (comments.some(comment => comment.parentElement?.closest(dom.selector('Comment')))) return { state: 'structure_changed' };
    const belongsTo = (node, ancestor, prefix) => node.closest(dom.selector(prefix)) === ancestor;
    const field = (owner, prefix) => {
      const comment = owner.closest(dom.selector('Comment'));
      const append = owner.closest(dom.selector('append'));
      const reply = owner.closest(dom.selector('reply'));
      const nodes = dom.all(owner, dom.selector(prefix)).filter(node =>
        node.closest(dom.selector('Comment')) === comment && node.closest(dom.selector('append')) === append &&
        node.closest(dom.selector('reply')) === reply);
      if (nodes.length > 1) throw new Error('Ambiguous review field');
      if (nodes[0] && dom.all(nodes[0], `${dom.selector('Comment')}, ${dom.selector('append')}, ${dom.selector('reply')}`).length) {
        throw new Error('Review field contains another entry');
      }
      return nodes[0];
    };
    const replies = owner => {
      const nodes = dom.all(owner, dom.selector('reply')).filter(node =>
        belongsTo(node, owner.closest(dom.selector('Comment')), 'Comment') &&
        node.closest(dom.selector('append')) === owner.closest(dom.selector('append')));
      if (nodes.some(node => node.parentElement?.closest(dom.selector('reply')))) throw new Error('Nested replies');
      return { seller_replies_seen: nodes.length,
        seller_replies: nodes.slice(0, 2).map(node => ({ raw: dom.text(field(node, 'text'), 1000) })) };
    };
    return { schema_version: textOnly ? 4 : 3, state: 'observed', product_id: expected.product_id, url: expected.url,
      total_text: dom.text(field(root, 'tabDetailItemTitle'), 120), loaded_count: comments.length,
      fold_notice_text: dom.text(field(root, 'foldInfoWrap'), 200),
      reviews: comments.slice(0, textOnly ? 10 : 20).map(comment => {
        const followups = dom.all(comment, dom.selector('append')).filter(node => belongsTo(node, comment, 'Comment'));
        if (followups.some(node => node.parentElement?.closest(dom.selector('append')))) throw new Error('Nested follow-ups');
        return { body: dom.text(field(comment, 'content'), 2000), purchase_text: dom.text(field(comment, 'meta'), 240),
          ...replies(comment), ...(textOnly ? {} : { images: images(comment, dom) }), followups_seen: followups.length,
          followups: followups.slice(0, 2).map(node => ({ raw: dom.text(field(node, 'content'), 1000),
            interval_text: dom.text(field(node, 'appendInternal'), 80), ...replies(node),
            ...(textOnly ? {} : { images: images(node, dom) }) })) };
      }) };
  }
  const roots = dom.all(document, dom.selector('Comments'));
  if (roots.length !== 1) return { state: document.readyState === 'complete' ? 'unsupported' : 'loading' };
  const buttons = dom.all(roots[0], dom.selector('ShowButton')).filter(node => dom.text(node, 40) === '查看全部评价');
  if (!buttons.length) return { state: 'unsupported' };
  if (buttons.length !== 1 || !['DIV', 'BUTTON'].includes(buttons[0].tagName)) return { state: 'structure_changed' };
  if (buttons[0].getAttribute('aria-disabled') === 'true' || buttons[0].disabled === true) return { state: 'unsupported' };
  if (!expand) return { state: 'action_required' };
  buttons[0].click();
  return { state: 'action_dispatched', clicked: true };
}

/** @param {object} target @param {boolean} [expand] @param {{textOnly?: boolean}} [options] @returns {string} Fixed review observation; textOnly reads ten positions without accessing media. @throws {ShoppingError} INVALID_TARGET or INVALID_ARGUMENTS. */
export function reviewsScript(target, expand = false, { textOnly = false } = {}) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required for reviews.');
  if (typeof expand !== 'boolean' || typeof textOnly !== 'boolean') throw new ShoppingError('INVALID_ARGUMENTS', 'Review mode flags must be boolean.');
  return `(() => { try { return (${collectReviews.toString()})(${JSON.stringify(expected)}, ${JSON.stringify(expand)}, (${pageDom.toString()})(), ${textOnly ? 'null' : collectReviewImages.toString()}, ${textOnly}, ${reviewPanelVisibility.toString()}); }
    catch { return { state: 'structure_changed' }; } })()`;
}

/** @param {unknown} value @param {object} target @returns {object} Panel state or bounded public review observations. @throws {ShoppingError} Page or schema errors. */
export function validateReviews(value, target) {
  throwPageError(value?.state);
  if (['action_required', 'waiting_result'].includes(value?.state)) return { state: value.state };
  const version = value?.schema_version;
  const enriched = [2, 3, 4].includes(version), scoped = version === 3 || version === 4, textOnly = version === 4;
  const limit = textOnly ? 10 : 20;
  if ((value?.schema_version !== undefined && !enriched) || value?.state !== 'observed' || value.url !== target.url || value.product_id !== target.product_id ||
      !Array.isArray(value.reviews) || !value.reviews.length || value.reviews.length > limit ||
      !Number.isSafeInteger(value.loaded_count) || value.loaded_count < value.reviews.length || value.loaded_count > 10000) {
    throw new ShoppingError('INVALID_RESPONSE', 'The review response does not match the bound product.');
  }
  const reviews = value.reviews.map((review, index) => {
    const body = responseText(review?.body, 2000), purchaseText = responseText(review?.purchase_text, 240);
    const images = version === 3 ? normalizeReviewImages(review?.images) : null;
    if (!textOnly && !body && !images?.slots_seen) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'A loaded review has no supported body text.');
    if (textOnly && (Object.hasOwn(review, 'images') || review.followups?.some(entry => Object.hasOwn(entry, 'images')))) {
      throw new ShoppingError('INVALID_RESPONSE', 'Text-only reviews must not contain media observations.');
    }
    const parts = purchaseText.match(/^(\d{4}年\d{1,2}月\d{1,2}日)(?:已购：(.*))?$/);
    return { observation_index: index + 1, body, purchase_text: purchaseText, date_text: parts?.[1] ?? null,
      variant_text: parts?.[2] ?? null, review_id: null, text_may_be_truncated: true,
      ...(enriched ? { seller_replies: normalizeReplies(review.seller_replies), followups: normalizeFollowups(review.followups, version),
        relation_basis: 'same_review_dom_container' } : {}),
      ...(version === 3 ? { images } : {}), ...(textOnly ? { text_observed: Boolean(body) } : {}),
      ...(scoped ? { relation_scope: {
        followups: relationScope(review.followups_seen, review.followups),
        seller_replies: relationScope(review.seller_replies_seen, review.seller_replies) } } : {}) };
  });
  if (scoped && reviews.length !== Math.min(value.loaded_count, limit)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The returned reviews do not match the bounded collection.');
  }
  return { state: 'ready', result: { product_id: target.product_id, url: target.url, source: 'loaded_review_drawer',
    ...(enriched ? { schema_version: version } : {}),
    observed_at: new Date().toISOString(), login_verified: false, total_text: responseText(value.total_text, 120),
    loaded_count: value.loaded_count, returned_count: reviews.length, reviews,
    ...(scoped ? { omitted_count: value.loaded_count - reviews.length } : {}),
    ...(textOnly ? { media_read: false, excluded: ['review_images', 'review_videos'] } : {}),
    ...(enriched ? { fold_notice_text: responseText(value.fold_notice_text, 200) } : {}),
    coverage: { status: 'partial', scope: 'currently_loaded_drawer', sort_verified: false, filters_verified: false, full_list: false },
    limits: { reviews: limit, review_characters: 2000, ...(enriched ? { followups_per_review: 2, replies_per_entry: 2, related_characters: 1000 } : {}),
      ...(version === 3 ? { image_slots_per_entry: 6 } : {}) },
    missing: ['stable_review_ids', 'subsequent_pages', 'verified_sort_and_filters',
      ...(enriched ? ['unloaded_or_folded_relations'] : ['followups_and_seller_replies']),
      ...(version === 3 ? ['unloaded_or_covered_review_images', 'review_image_files', 'video_contents'] : textOnly ? [] : ['media'])],
  } };
}

function relatedEntries(value) {
  if (!Array.isArray(value) || value.length > 2) throw new ShoppingError('INVALID_RESPONSE', 'The related review collection exceeds its supported bounds.');
  return value;
}

function normalizeReplies(value) {
  return relatedEntries(value).map(reply => {
    const raw = responseText(reply?.raw, 1000);
    if (!raw.startsWith('商家回复：') || !raw.slice(5).trim()) {
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The seller reply label could not be verified.');
    }
    return { raw, body: raw.slice(5).trim(), text_may_be_truncated: true };
  });
}

function relationScope(seen, entries) {
  if (!Number.isSafeInteger(seen) || seen < 0 || seen > 10000 || Math.min(seen, 2) !== entries.length) {
    throw new ShoppingError('INVALID_RESPONSE', 'The related review counts do not match the returned entries.');
  }
  return { seen, returned: entries.length, omitted: seen - entries.length };
}

function normalizeFollowups(value, version) {
  return relatedEntries(value).map(followup => {
    const raw = responseText(followup?.raw, 1000), interval = responseText(followup?.interval_text, 80);
    const images = version === 3 ? normalizeReviewImages(followup.images) : null;
    const separated = Boolean(interval) && raw.startsWith(interval);
    if (version !== 4 && (!/^\d{1,5}天后追评：$/.test(interval) || !separated ||
        !raw.slice(interval.length).trim() && !images?.slots_seen)) {
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The follow-up label or body could not be verified.');
    }
    const body = separated ? raw.slice(interval.length).trim() : null;
    return { raw, interval_text: interval, body, text_may_be_truncated: true,
      seller_replies: normalizeReplies(followup.seller_replies),
      ...(version === 3 ? { images } : {}),
      ...(version === 4 ? { text_observed: body === null ? null : Boolean(body) } : {}),
      ...([3, 4].includes(version) ? { relation_scope: { seller_replies: relationScope(followup.seller_replies_seen, followup.seller_replies) } } : {}) };
  });
}

/** @param {object} value @param {object} target @returns {void} @throws {ShoppingError} INVALID_CHECKPOINT for changed cached fields. */
export function validateSavedReviews(value, target) {
  try {
    if (typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at))) throw new Error();
    const normalized = validateReviews({ state: 'observed', product_id: value.product_id, url: value.url,
      schema_version: value.schema_version, fold_notice_text: value.fold_notice_text,
      total_text: value.total_text, loaded_count: value.loaded_count,
      reviews: [3, 4].includes(value.schema_version) ? value.reviews.map(review => ({ ...review,
        ...(value.schema_version === 3 ? { images: restoreReviewImages(review.images) } : {}), followups_seen: review.relation_scope.followups.seen,
        seller_replies_seen: review.relation_scope.seller_replies.seen,
        followups: review.followups.map(followup => ({ ...followup,
          ...(value.schema_version === 3 ? { images: restoreReviewImages(followup.images) } : {}),
          seller_replies_seen: followup.relation_scope.seller_replies.seen })) })) : value.reviews }, target).result;
    normalized.observed_at = value.observed_at;
    if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error();
  } catch { throw new ShoppingError('INVALID_CHECKPOINT', 'The saved review observations are invalid.'); }
}
