import test from 'node:test';
import assert from 'node:assert/strict';
import { newReviewCategoryState, runReviewCategories, validateReviewCategoryState, validateReviewCategoryResult } from '../lib/review-category-read.mjs';
import { reviewPanelLifecycleEvidence } from '../lib/review-panel-lifecycle.mjs';
import { reviewCategoryObservation } from '../test-support/review-category-fixture.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { ShoppingError } from '../lib/errors.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const fail = code => { throw new ShoppingError(code, 'Synthetic panel failure'); };
function fixture(settings = {}) {
  const plan = [null], op = { tab_id: 41, target, review_categories: plan, category_read: newReviewCategoryState(plan), recovery_kind: null };
  let time = 10000, reads = 0, opens = 0, closes = 0, cleanupReads = 0, visible = settings.initialOpen ?? false, saved;
  const bridge = {
    async readReviewCategories() {
      reads++;
      if (settings.read) return settings.read(reads);
      return visible ? reviewCategoryObservation(target) : { state: 'panel_action_required' };
    },
    async openReviewPanel() {
      assert.equal(saved.panel.action_reserved, true); opens++; visible = true;
      return settings.open ? settings.open() : { clicked: true };
    },
    async readReviewPanelState() {
      cleanupReads++;
      assert.equal(saved.panel_lifecycle.observations, cleanupReads);
      assert.equal(saved.panel_lifecycle.last_observation, null);
      assert.equal(saved.panel_lifecycle.closed_checks, 0);
      return settings.cleanupRead ? settings.cleanupRead(cleanupReads) : { state: visible ? 'open' : 'closed' };
    },
    async closeReviewPanel() {
      assert.equal(saved.panel_lifecycle.action_reserved, true); assert.equal(saved.panel_lifecycle.observations, 1);
      assert.equal(saved.panel_lifecycle.open_confirmed, true); closes++; visible = false;
      return settings.close ? settings.close() : { clicked: true };
    },
    async selectReviewCategory() { throw new Error('Unplanned category switch'); },
  };
  const context = { bridge, op, now: () => time, wait: async ms => { time += ms; },
    commit: async () => {
      validateReviewCategoryState(op.category_read, target, plan);
      saved = structuredClone(op.category_read);
      settings.commit?.(op);
    } };
  return { op, context, counts: () => ({ reads, opens, closes, cleanupReads }), saved: () => saved };
}

test('an initially open panel is preserved with zero cleanup reads or closes', async () => {
  const f = fixture({ initialOpen: true }), result = await runReviewCategories(f.context);
  assert.deepEqual(f.counts(), { reads: 2, opens: 0, closes: 0, cleanupReads: 0 });
  assert.equal(result.panel_lifecycle.initial_state, 'open'); assert.equal(result.panel_lifecycle.status, 'preserved_initial');
  validateReviewCategoryResult(result, target, [null], f.op.category_read);
});

test('a verifiably opened panel closes once after samples and needs two closed observations', async () => {
  const f = fixture(), result = await runReviewCategories(f.context);
  assert.deepEqual(f.counts(), { reads: 3, opens: 1, closes: 1, cleanupReads: 3 });
  assert.equal(result.panel_lifecycle.initial_state, 'closed'); assert.equal(result.panel_lifecycle.status, 'closed_confirmed');
  assert.equal(result.panel_lifecycle.closed_checks, 2); assert.equal(result.panel_lifecycle.close_acknowledgement, 'clicked');
  assert.equal(result.samples[0].reviews.returned_count, 2); assert.equal(Object.hasOwn(result.panel_lifecycle, 'opened_tab_id'), false);
  validateReviewCategoryResult(result, target, [null], f.op.category_read);
  await runReviewCategories(f.context); assert.equal(f.counts().closes, 1); assert.equal(f.counts().cleanupReads, 3);
});

test('lost opener replies and raced no-click replies do not confer cleanup ownership', async () => {
  for (const open of [() => fail('BRIDGE_TIMEOUT'), () => ({ clicked: false })]) {
    const f = fixture({ open }), result = await runReviewCategories(f.context);
    assert.equal(result.panel_lifecycle.status, 'preserved_uncertain');
    assert.equal(f.counts().closes, 0); assert.equal(f.counts().cleanupReads, 0);
    validateReviewCategoryResult(result, target, [null], f.op.category_read);
  }
});

test('a panel already closed before cleanup requires no close action', async () => {
  const f = fixture({ cleanupRead: () => ({ state: 'closed' }) }), result = await runReviewCategories(f.context);
  assert.equal(result.panel_lifecycle.status, 'already_closed'); assert.equal(f.counts().closes, 0); assert.equal(f.counts().cleanupReads, 1);
});

test('rebinding to a different tab never transfers ownership of the old panel', async () => {
  const f = fixture({ commit: op => { if (op.category_read.steps[0].after) op.tab_id = 42; } });
  const result = await runReviewCategories(f.context);
  assert.equal(result.panel_lifecycle.status, 'preserved_changed_tab'); assert.equal(f.counts().cleanupReads, 0);
});

test('a close timeout resumes via bounded reads and never repeats the command', async () => {
  const f = fixture({ close: () => fail('BRIDGE_TIMEOUT') }), result = await runReviewCategories(f.context);
  assert.equal(result.panel_lifecycle.status, 'closed_confirmed');
  assert.equal(result.panel_lifecycle.acknowledgement_error, 'BRIDGE_TIMEOUT');
  assert.equal(result.panel_lifecycle.close_acknowledgement, null); assert.equal(f.counts().closes, 1);
});

test('failed post-close reads retain samples, break confirmation and cannot overrun cleanup budget', async () => {
  const f = fixture({ cleanupRead: count => count === 1 ? { state: 'open' } : count === 2 ? fail('VERIFICATION_REQUIRED') : { state: 'closed' } });
  await assert.rejects(runReviewCategories(f.context), { code: 'VERIFICATION_REQUIRED' });
  assert(f.op.category_read.steps[0].after); assert.equal(f.op.category_read.panel_lifecycle.last_read_error, 'VERIFICATION_REQUIRED');
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_PANEL_CLEANUP_UNCONFIRMED' });
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_PANEL_CLEANUP_UNCONFIRMED' });
  assert.deepEqual(f.counts(), { reads: 3, opens: 1, closes: 1, cleanupReads: 3 });
});

test('a failure during sampling does not attempt cleanup or consume cleanup allowance', async () => {
  const f = fixture({ read: count => count === 1 ? { state: 'panel_action_required' } : count === 2 ? reviewCategoryObservation(target) : fail('RATE_LIMITED') });
  await assert.rejects(runReviewCategories(f.context), { code: 'RATE_LIMITED' });
  assert.equal(f.counts().closes, 0); assert.equal(f.counts().cleanupReads, 0);
  assert.equal(f.op.category_read.panel_lifecycle.status, 'pending');
});

test('interruption after durable close reservation never reissues that intent', async () => {
  let interrupt = true;
  const f = fixture({ commit: op => {
    if (interrupt && op.category_read.panel_lifecycle.action_reserved) { interrupt = false; throw new Error('Process interrupted'); }
  } });
  await assert.rejects(runReviewCategories(f.context), /Process interrupted/);
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_PANEL_CLEANUP_UNCONFIRMED' });
  assert.equal(f.counts().closes, 0); assert.equal(f.counts().cleanupReads, 3);
});

test('a failed cleanup precheck cannot consume the room needed for confirmation and then close anyway', async () => {
  const f = fixture({ cleanupRead: count => count === 1 ? fail('BRIDGE_TIMEOUT') : { state: 'open' } });
  await assert.rejects(runReviewCategories(f.context), { code: 'BRIDGE_TIMEOUT' });
  await assert.rejects(runReviewCategories(f.context), { code: 'REVIEW_PANEL_CLEANUP_UNCONFIRMED' });
  assert.equal(f.counts().closes, 0); assert.equal(f.counts().cleanupReads, 2);
});

test('legacy category journals have no new cleanup actions or result backfill', async () => {
  const f = fixture(); delete f.op.category_read.panel_lifecycle;
  const result = await runReviewCategories(f.context);
  assert.equal(Object.hasOwn(result, 'panel_lifecycle'), false); assert.equal(f.counts().cleanupReads, 0);
  validateReviewCategoryResult(result, target, [null], f.op.category_read);
});

test('cleanup journals reject forged ownership, completion and extra budgets', async () => {
  const f = fixture(); await runReviewCategories(f.context);
  for (const mutate of [p => { p.initial_state = 'open'; }, p => { p.open_acknowledgement = null; },
    p => { p.opened_tab_id = null; }, p => { p.observations = 4; }, p => { p.closed_checks = 1; },
    p => { p.action_reserved = false; }, p => { p.last_read_error = 'VERIFICATION_REQUIRED'; }, p => { p.extra_close = true; }]) {
    const state = structuredClone(f.op.category_read); mutate(state.panel_lifecycle);
    assert.throws(() => validateReviewCategoryState(state, target, [null]), { code: 'INVALID_CHECKPOINT' });
  }
  assert.equal(reviewPanelLifecycleEvidence({}), undefined);
});
