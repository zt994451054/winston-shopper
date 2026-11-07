import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProductUrl } from '../lib/targets.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { newReviewCategoryState, runReviewCategories, validateReviewCategoryState } from '../lib/review-category-read.mjs';
import { unconfirmedReviewObservations } from '../lib/review-observations.mjs';
import { reviewCategoryObservation } from '../test-support/review-category-fixture.mjs';

const target = parseProductUrl('https://item.taobao.com/item.htm?id=123');

function fixture(plan, read) {
  let time = 1000, reads = 0, actions = 0, selected = '全部';
  const op = { tab_id: 1, target, review_categories: plan, category_read: newReviewCategoryState(plan), recovery_kind: null };
  const state = op.category_read;
  const context = { op, bridge: {
    readReviewCategories: async () => {
      reads++;
      assert.equal(state.observation_delivery.latest_read.read_index, state.observations);
      assert.equal(state.observation_delivery.latest_read.outcome, 'reserved');
      return read(reads, selected);
    },
    selectReviewCategory: async (_tab, _target, _before, label) => { actions++; selected = label; },
  }, commit: async () => validateReviewCategoryState(state, target, plan),
  now: () => time, wait: async ms => { time += ms; } };
  return { state, context, reads: () => reads, actions: () => actions };
}

const stale = (_index, selected) => reviewCategoryObservation(target, selected, 'Shared text');

test('unchanged lists preserve bounded unconfirmed text and original observation time without weakening confirmation', async () => {
  const snapshots = [];
  const f = fixture(['追评'], (index, selected) => {
    const observation = stale(index, selected); observation.snapshot.reviews.observed_at = `2026-09-23T00:00:0${index}.000Z`;
    snapshots.push(observation.snapshot); return observation;
  });
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  const [value] = unconfirmedReviewObservations(f.state);
  assert.equal(f.reads(), 4); assert.equal(f.actions(), 1);
  assert.equal(value.association.status, 'unverified');
  assert.deepEqual(value.association.reasons, ['text_unchanged_after_switch']);
  assert.deepEqual(value.snapshot, snapshots[3]);
  assert.equal(value.snapshot.reviews.observed_at, '2026-09-23T00:00:04.000Z');
  assert.equal(value.phase, 'after_switch'); assert.equal(value.read_index, 4);
  assert.equal(f.state.steps[0].after, null); assert.equal(f.state.steps[0].candidate, null);
  assert.equal(Object.hasOwn(f.state.observation_delivery, 'history'), false);
});

test('changed text can confirm normally and clears diagnostic text from successful steps', async () => {
  const f = fixture(['全部', '追评'], (_index, selected) => reviewCategoryObservation(target, selected));
  const result = await runReviewCategories(f.context);
  assert.equal(result.samples.length, 2); assert.equal(f.reads(), 5); assert.equal(f.actions(), 1);
  assert.deepEqual(unconfirmedReviewObservations(f.state), []);
  assert.equal(f.state.observation_delivery.last_observation, null);
});

test('loading breaks consecutive confirmation and preserves the earlier text as an older observation', async () => {
  const f = fixture(['追评'], (index, selected) => index >= 3 ? { state: 'waiting_result' } : reviewCategoryObservation(target, selected));
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  const [value] = unconfirmedReviewObservations(f.state);
  assert.equal(value.read_index, 2); assert.equal(value.latest_read.read_index, 4);
  assert.equal(value.latest_read.outcome, 'waiting_result'); assert.equal(value.observation_is_latest_read, false);
  assert.deepEqual(value.association.reasons, ['consecutive_confirmation_not_completed']);
  assert.equal(f.state.steps[0].candidate, null); assert.equal(f.state.steps[0].after, null);
});

test('a gated read keeps earlier text and its failed-read status but cannot reuse the old candidate', async () => {
  const f = fixture(['追评'], (index, selected) => {
    if (index === 3) throw new ShoppingError('VERIFICATION_REQUIRED', 'Synthetic gate');
    return reviewCategoryObservation(target, selected);
  });
  await assert.rejects(runReviewCategories(f.context), { code: 'VERIFICATION_REQUIRED' });
  const [value] = unconfirmedReviewObservations(f.state);
  assert.equal(value.read_index, 2); assert.equal(value.observation_is_latest_read, false);
  assert.equal(value.latest_read.outcome, 'error'); assert.equal(value.latest_read.error_code, 'VERIFICATION_REQUIRED');
  assert.equal(f.state.steps[0].candidate, null);
  await runReviewCategories(f.context);
  assert.equal(f.reads(), 5); assert.equal(f.actions(), 1);
  assert.deepEqual(unconfirmedReviewObservations(f.state), []);
});

test('an interrupted reserved read retains older diagnostics and requires fresh consecutive confirmation on resume', async () => {
  const f = fixture(['追评'], (_index, selected) => reviewCategoryObservation(target, selected));
  const commit = f.context.commit;
  f.context.commit = async () => {
    await commit();
    if (f.state.observations === 3 && f.state.observation_delivery.latest_read.outcome === 'reserved') throw new Error('Synthetic process stop');
  };
  await assert.rejects(runReviewCategories(f.context), /Synthetic process stop/);
  const [value] = unconfirmedReviewObservations(f.state);
  assert.equal(value.read_index, 2); assert.equal(value.latest_read.outcome, 'reserved');
  assert.equal(value.observation_is_latest_read, false); assert.equal(f.state.steps[0].candidate, null);
  f.context.commit = commit;
  await runReviewCategories(f.context);
  assert.equal(f.state.observations, 5); assert.equal(f.actions(), 1);
});

test('current-category plans retain their starting category when a later marker changes', async () => {
  const f = fixture([null], index => reviewCategoryObservation(target, index === 1 ? '全部' : '追评'));
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  const [value] = unconfirmedReviewObservations(f.state);
  assert.equal(value.requested_category, '全部'); assert.equal(value.selected_category_observed, '追评');
  assert.deepEqual(value.association.reasons, ['requested_category_not_selected']);
  assert.equal(f.actions(), 0);
});

test('sort changes remain explicit and a missing requested category can deliver the observed starting text', async () => {
  const changed = fixture(['追评'], (index, selected) => {
    const observation = reviewCategoryObservation(target, selected);
    if (index > 1) observation.snapshot.sort_text = '时间排序';
    return observation;
  });
  await assert.rejects(runReviewCategories(changed.context), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  assert.deepEqual(unconfirmedReviewObservations(changed.state)[0].association.reasons, ['sort_changed']);
  const missing = fixture(['不存在'], () => reviewCategoryObservation(target));
  await assert.rejects(runReviewCategories(missing.context), { code: 'REVIEW_CATEGORY_UNAVAILABLE' });
  validateReviewCategoryState(missing.state, target, ['不存在']);
  const [value] = unconfirmedReviewObservations(missing.state);
  assert.equal(value.phase, 'initial'); assert.equal(value.requested_category, '不存在');
  assert.equal(value.selected_category_observed, '全部'); assert.equal(missing.actions(), 0);
});

test('delivery validation rejects fabricated metadata, altered text and extra confirmation claims', async () => {
  const f = fixture(['追评'], stale);
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  for (const mutate of [s => { s.observation_delivery.schema_version = 2; },
    s => { s.observation_delivery.latest_read.read_index = 3; },
    s => { s.observation_delivery.latest_read.error_code = 'SECRET'; },
    s => { s.observation_delivery.latest_read.phase = 'confirmation'; },
    s => { s.observation_delivery.last_observation.read_index = 5; },
    s => { s.observation_delivery.last_observation.step_index = 1; },
    s => { s.observation_delivery.last_observation.snapshot.reviews.product_id = '999'; },
    s => { s.observation_delivery.last_observation.snapshot.reviews.reviews[0].images = {}; },
    s => { s.observation_delivery.last_observation.association = { status: 'verified' }; },
    s => { s.observation_delivery.last_observation = null; }]) {
    const copy = structuredClone(f.state); mutate(copy);
    assert.throws(() => validateReviewCategoryState(copy, target, ['追评']), { code: 'INVALID_CHECKPOINT' });
  }
});
