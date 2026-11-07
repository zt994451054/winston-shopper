import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProductUrl } from '../lib/targets.mjs';
import { normalizeReviewCategoryPlan, reviewCategoriesScript, validateReviewCategoryObservation, validateReviewCategorySnapshot } from '../lib/review-categories.mjs';
import { newReviewCategoryState, runReviewCategories, validateReviewCategoryState, validateReviewCategoryResult } from '../lib/review-category-read.mjs';
import { validateSavedReviews } from '../lib/reviews.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { rawReviewCategories, reviewCategoryObservation } from '../test-support/review-category-fixture.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');

test('category plans keep exact labels and bound the batch without assuming a taxonomy', () => {
  assert.deepEqual(normalizeReviewCategoryPlan([null]), [null]);
  assert.deepEqual(normalizeReviewCategoryPlan(['全部', '追评']), ['全部', '追评']);
  for (const value of [null, [], [null, '全部'], ['全部', '全部'], [' 全部'], [1], ['x'.repeat(81)], ['a', 'b', 'c', 'd']]) {
    assert.throws(() => normalizeReviewCategoryPlan(value), { code: 'INVALID_REVIEW_CATEGORIES' });
  }
});

test('text-only snapshots keep empty positions and relations, reject media, and round trip exactly', () => {
  const raw = rawReviewCategories(target);
  raw.reviews.reviews[0].body = '';
  raw.reviews.reviews[0].followups_seen = 1;
  raw.reviews.reviews[0].followups = [{ raw: '7天后追评：', interval_text: '7天后追评：', seller_replies_seen: 0, seller_replies: [] }];
  const snapshot = validateReviewCategoryObservation(raw, target).snapshot;
  assert.equal(snapshot.reviews.reviews[0].text_observed, false);
  assert.equal(snapshot.reviews.reviews[0].followups[0].text_observed, false);
  assert.equal(snapshot.reviews.media_read, false);
  assert.equal(snapshot.reviews.returned_count, 2);
  validateSavedReviews(snapshot.reviews, target); validateReviewCategorySnapshot(snapshot, target);
  raw.reviews.reviews[0].images = {};
  assert.throws(() => validateReviewCategoryObservation(raw, target), { code: 'INVALID_RESPONSE' });
});

test('text-only follow-ups preserve unfamiliar interval labels and uncertain body separation without inventing text', () => {
  for (const [interval, raw, body] of [['当天追评：', '当天追评：使用正常', '使用正常'], ['收货当天追评：', '收货当天追评：使用正常', '使用正常'],
    ['1个月后追评：', '1个月后追评：', ''], ['追评', '正文另行排列', null], ['', '只有原文', null], ['', '', null]]) {
    const value = rawReviewCategories(target), review = value.reviews.reviews[0];
    review.followups_seen = 1;
    review.followups = [{ raw, interval_text: interval, seller_replies_seen: 0, seller_replies: [] }];
    const snapshot = validateReviewCategoryObservation(value, target).snapshot;
    const followup = snapshot.reviews.reviews[0].followups[0];
    assert.equal(followup.raw, raw); assert.equal(followup.interval_text, interval); assert.equal(followup.body, body);
    assert.equal(followup.text_observed, body === null ? null : Boolean(body));
    validateReviewCategorySnapshot(snapshot, target);
  }
});

test('category metadata rejects duplicate labels, conflicting selection, excessive lists and invisible selected controls', () => {
  for (const mutate of [r => { r.categories[1].label = '全部'; }, r => { r.categories[1].selected = true; },
    r => { r.categories[0].in_viewport = false; }, r => { r.categories[0].disabled = true; },
    r => { r.categories[0].position = 2; }, r => { r.categories[1].count_text = 'invented'; },
    r => { r.categories[1].token = 'DO_NOT_KEEP'; }]) {
    const raw = rawReviewCategories(target); mutate(raw);
    assert.throws(() => validateReviewCategoryObservation(raw, target));
  }
  const snapshot = reviewCategoryObservation(target).snapshot;
  for (const mutate of [s => { s.selected_category = '追评'; }, s => { s.reviews.media_read = true; },
    s => { s.categories[0].category_id = 'invented'; }, s => { s.reviews.reviews[0].body = ''; }]) {
    const copy = structuredClone(snapshot); mutate(copy);
    assert.throws(() => validateReviewCategorySnapshot(copy, target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('category scripts require a valid saved baseline before accepting action labels', () => {
  assert.throws(() => reviewCategoriesScript(target, { label: '追评' }), { code: 'INVALID_REVIEW_CATEGORIES' });
  assert.throws(() => reviewCategoriesScript(target, { before: {}, label: '追评' }), { code: 'INVALID_CHECKPOINT' });
  assert.throws(() => validateReviewCategoryObservation({ state: 'review_panel_required' }, target), { code: 'REVIEW_PANEL_REQUIRED' });
});

function context(plan = ['全部', '追评'], settings = {}) {
  let clock = 1000, selected = '全部', actions = 0, reads = 0;
  const op = { tab_id: 1, target, review_categories: plan, category_read: newReviewCategoryState(plan), recovery_kind: null };
  const bridge = {
    readReviewCategories: async () => {
      reads++;
      if (settings.readError) throw settings.readError;
      return reviewCategoryObservation(target, selected, settings.stale ? 'unchanged' : selected);
    },
    selectReviewCategory: async (_tab, _target, _before, label) => {
      assert.equal(op.category_read.steps.find(step => !step.after).action_reserved, true);
      actions++; selected = label;
      if (settings.interrupt) throw new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic lost reply');
    },
  };
  return { op, bridge, context: { bridge, op,
    commit: async () => validateReviewCategoryState(op.category_read, target, plan),
    now: () => clock, wait: async ms => { clock += ms; } }, actions: () => actions, reads: () => reads };
}

test('current text category needs two matching reads, preserves page order and performs no action', async () => {
  const f = context([null]);
  const result = await runReviewCategories(f.context);
  assert.equal(f.reads(), 2); assert.equal(f.actions(), 0);
  assert.equal(result.samples[0].category, '全部');
  assert.equal(result.coverage.unique_review_count, null);
  assert.equal(result.coverage.media_read, false);
  validateReviewCategoryResult(result, target, [null], f.op.category_read);
});

test('category switches require changed text and two stable reads; lost replies never cause a second click', async () => {
  const f = context(['全部', '追评', '静音效果好'], { interrupt: true });
  const result = await runReviewCategories(f.context);
  assert.equal(f.reads(), 8); assert.equal(f.actions(), 2);
  assert.deepEqual(result.samples.map(sample => sample.category), ['全部', '追评', '静音效果好']);
  assert.equal(result.action_evidence.categories[1].acknowledgement_error, 'BRIDGE_TIMEOUT');
  assert.equal(result.samples[1].association.content_changed_after_switch, true);
  const copy = structuredClone(result); copy.samples[1].category = '全部';
  assert.throws(() => validateReviewCategoryResult(copy, target, f.op.review_categories, f.op.category_read), { code: 'INVALID_CHECKPOINT' });
});

test('selected markers with unchanged text cannot relabel the old list and stop within three checks', async () => {
  const f = context(['追评'], { stale: true });
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  assert.equal(f.actions(), 1); assert.equal(f.reads(), 4);
  assert.equal(f.op.category_read.steps[0].after, null);
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  assert.equal(f.reads(), 4); assert.equal(f.actions(), 1);
});

test('a saved category intent with no acknowledgement resumes through observations only', async () => {
  const f = context(['追评']);
  const state = f.op.category_read, step = state.steps[0];
  state.observations = 1; step.before = reviewCategoryObservation(target).snapshot; step.action_reserved = true;
  f.bridge.readReviewCategories = async () => reviewCategoryObservation(target, '追评');
  const result = await runReviewCategories(f.context);
  assert.equal(f.actions(), 0); assert.equal(result.action_evidence.observations_reserved, 3);
});

test('visibility and verification errors preserve a spent read without category actions', async () => {
  for (const code of ['REVIEW_DRAWER_NOT_VISIBLE', 'VERIFICATION_REQUIRED']) {
    const f = context(['追评'], { readError: new ShoppingError(code, 'Synthetic guard') });
    await assert.rejects(runReviewCategories(f.context), { code });
    assert.equal(f.op.category_read.observations, 1); assert.equal(f.actions(), 0);
    validateReviewCategoryState(f.op.category_read, target, ['追评']);
  }
});

test('category journals reject fabricated confirmations, absent baselines and budget changes', () => {
  for (const mutate of [s => { s.observations = 13; }, s => { s.steps[0].action_reserved = true; },
    s => { s.steps[0].after = reviewCategoryObservation(target).snapshot; }, s => { s.steps[0].checks = 1; },
    s => { s.steps[0].requested = '追评'; }]) {
    const state = newReviewCategoryState(['全部']); mutate(state);
    assert.throws(() => validateReviewCategoryState(state, target, ['全部']), { code: 'INVALID_CHECKPOINT' });
  }
});

test('automatic panel opening reserves one intent and verifies visibility without replaying a lost reply', async () => {
  const f = context([null]); let reads = 0, actions = 0;
  f.bridge.readReviewCategories = async () => ++reads === 1 ? { state: 'panel_action_required' } : reviewCategoryObservation(target);
  f.bridge.openReviewPanel = async () => {
    assert.equal(f.op.category_read.panel.action_reserved, true); actions++;
    throw new ShoppingError('BRIDGE_TIMEOUT', 'Lost opening reply');
  };
  const result = await runReviewCategories(f.context);
  assert.equal(reads, 3); assert.equal(actions, 1);
  assert.equal(result.action_evidence.panel.acknowledgement_error, 'BRIDGE_TIMEOUT');
  validateReviewCategoryResult(result, target, [null], f.op.category_read);
});

test('an opening that leaves the review panel closed stops after three checks and cannot repeat', async () => {
  const f = context([null]); let actions = 0, reads = 0;
  f.bridge.readReviewCategories = async () => { reads++; return { state: 'panel_action_required' }; };
  f.bridge.openReviewPanel = async () => { actions++; return { clicked: true }; };
  await assert.rejects(runReviewCategories(f.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  await assert.rejects(runReviewCategories(f.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(actions, 1); assert.equal(reads, 4);
});

test('saved opening intents recover by observing only, and cannot exceed inherited read reservations', async () => {
  const f = context([null]); let actions = 0;
  f.bridge.openReviewPanel = async () => { actions++; };
  f.op.category_read.observations = 10; f.op.category_read.panel.action_reserved = true;
  const result = await runReviewCategories(f.context);
  assert.equal(actions, 0); assert.equal(result.action_evidence.observations_reserved, 12);
  const exhausted = context([null]); exhausted.op.category_read.observations = 12;
  await assert.rejects(runReviewCategories(exhausted.context), { code: 'ACTION_OBSERVATION_LIMIT' });
  assert.equal(exhausted.reads(), 0);
});

test('verification during automatic panel opening pauses before any postcheck', async () => {
  const f = context([null]); let reads = 0;
  f.bridge.readReviewCategories = async () => { reads++; return { state: 'panel_action_required' }; };
  f.bridge.openReviewPanel = async () => { throw new ShoppingError('VERIFICATION_REQUIRED', 'Gate'); };
  await assert.rejects(runReviewCategories(f.context), { code: 'VERIFICATION_REQUIRED' });
  assert.equal(reads, 1); assert.equal(f.op.category_read.panel.action_reserved, true);
});
