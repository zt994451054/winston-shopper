import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { searchTarget, parseSearchUrl, isSearchHome, searchScript, validateSearch, validateSavedSearch } from '../lib/search.mjs';
import { reviewsScript, validateReviews, validateSavedReviews } from '../lib/reviews.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { newReadActionState, runReadAction, validateReadActionAcknowledgement, validateReadActionState } from '../lib/read-action.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { rawSearch, rawReviews } from '../test-support/search-review-fixture.mjs';

const search = searchTarget('罗技 M330');
const product = parseProductUrl('https://detail.tmall.com/item.htm?id=123');

test('search target rejects ambiguity, filters, later pages and lookalike origins', () => {
  assert.equal(parseSearchUrl('https://s.taobao.com/search?q=%E7%BD%97%E6%8A%80+M330&spm=tracking').url, search.url);
  for (const url of ['https://s.taobao.com.evil/search?q=mouse', 'https://s.taobao.com/search?q=mouse&q=other',
    'https://s.taobao.com/search?q=mouse&page=2', 'https://s.taobao.com/search?q=mouse&tab=mall',
    'https://s.taobao.com/search?q=mouse&sort=price-asc', 'https://user@s.taobao.com/search?q=mouse',
    'https://s.taobao.com/search?q=mouse#other', 'https://s.taobao.com/search?q=%20mouse%20']) assert.equal(parseSearchUrl(url), null);
  assert.equal(isSearchHome('https://www.taobao.com/'), true);
  for (const url of ['https://www.taobao.com/order', 'https://www.taobao.com/?q=other', 'http://www.taobao.com/']) assert.equal(isSearchHome(url), false);
  for (const query of ['', ' ', '\nsecret', 'x'.repeat(101), null]) assert.throws(() => searchTarget(query), { code: 'INVALID_SEARCH' });
});

test('both serialized collectors reject a changed identity before touching DOM', () => {
  const document = new Proxy({}, { get() { throw new Error('No DOM reads permitted'); } });
  for (const script of [searchScript(search), searchScript(search, true), reviewsScript(product), reviewsScript(product, true)]) {
    assert.equal(vm.runInNewContext(script, { URL, location: { href: 'https://example.com/' }, document }).state, 'target_changed');
  }
});

test('search query remains data in the serialized navigation expression', () => {
  const query = `mouse');globalThis.COMPROMISED=true;//`;
  const target = searchTarget(query), destinations = [];
  const context = { URL, location: { href: 'https://www.taobao.com/', assign: url => destinations.push(url) },
    document: { readyState: 'complete', title: '淘宝', querySelectorAll: () => [] }, getComputedStyle: () => ({}) };
  assert.equal(vm.runInNewContext(searchScript(target, true), context).state, 'action_dispatched');
  assert.deepEqual(destinations, [target.url]);
  assert.equal(context.COMPROMISED, undefined);
});

test('search deduplicates by item identity, retains source positions and does not assert payable prices', () => {
  const result = validateSearch(rawSearch(search), search).result;
  assert.deepEqual(result.items.map(item => item.position), [1, 3]);
  assert.equal(result.duplicates_omitted, 1);
  assert.equal(result.items[0].price.kind, 'starting_from');
  assert.equal(result.items[0].price.amount, null);
  assert.equal(result.coverage.sort_verified, false);
  assert.ok(!JSON.stringify(result).includes('secret'));
  validateSavedSearch(result, search);
  assert.throws(() => validateSavedSearch({ ...result, token: 'DO_NOT_KEEP' }, search), { code: 'INVALID_CHECKPOINT' });
});

test('reviews keep repeated text as separate observations and exclude reviewer identities', () => {
  const result = validateReviews(rawReviews(product), product).result;
  assert.equal(result.reviews.length, 2);
  assert.equal(result.reviews[0].date_text, '2026年9月22日');
  assert.equal(result.reviews[0].variant_text, '黑色');
  assert.equal(result.coverage.full_list, false);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_KEEP'));
  validateSavedReviews(result, product);
  const modified = structuredClone(result); modified.reviews[0].review_id = 'invented';
  assert.throws(() => validateSavedReviews(modified, product), { code: 'INVALID_CHECKPOINT' });
});

function enrichedReviews() {
  const raw = rawReviews(product);
  raw.schema_version = 2; raw.fold_notice_text = '已折叠20条评价';
  raw.reviews.forEach(review => {
    review.seller_replies = [{ raw: '商家回复：Thank you' }];
    review.followups = [{ raw: '7天后追评：Still works', interval_text: '7天后追评：', seller_replies: [{ raw: '商家回复：We are glad' }] }];
  });
  return raw;
}

test('versioned review output keeps parent associations and revalidates saved related fields', () => {
  const result = validateReviews(enrichedReviews(), product).result;
  assert.equal(result.reviews[0].followups[0].body, 'Still works');
  assert.equal(result.reviews[0].seller_replies[0].body, 'Thank you');
  assert.equal(result.reviews[0].relation_basis, 'same_review_dom_container');
  assert.ok(result.missing.includes('unloaded_or_folded_relations'));
  validateSavedReviews(result, product);
  const modified = structuredClone(result); modified.reviews[0].followups[0].seller_replies[0].body = 'Changed parent reply';
  assert.throws(() => validateSavedReviews(modified, product), { code: 'INVALID_CHECKPOINT' });
  // Existing v0.4 checkpoints keep their old schema and do not invent newly observed fields.
  const legacy = validateReviews(rawReviews(product), product).result;
  validateSavedReviews(legacy, product);
  assert.equal(legacy.reviews[0].followups, undefined);
});

test('related fields reject unknown labels, excessive counts and fields masquerading as observed relations', () => {
  for (const mutate of [raw => { raw.reviews[0].seller_replies[0].raw = '其他用户回复：secret'; },
    raw => { raw.reviews[0].followups[0].interval_text = '昨天'; },
    raw => { raw.reviews[0].followups = new Array(3).fill(raw.reviews[0].followups[0]); },
    raw => { delete raw.reviews[0].seller_replies; }, raw => { raw.schema_version = 999; }]) {
    const raw = enrichedReviews(); mutate(raw);
    assert.throws(() => validateReviews(raw, product));
  }
});

test('unsupported advertising redirect cards are counted without following them or discarding valid products', () => {
  const raw = rawSearch(search); raw.items.unshift({ url: null }); raw.cards_seen += 1;
  const result = validateSearch(raw, search).result;
  assert.equal(result.unsupported_cards_omitted, 1);
  assert.equal(result.duplicates_omitted, 1);
  assert.deepEqual(result.items.map(item => item.position), [2, 4]);
  validateSavedSearch(result, search);
  raw.items = [{ url: null }];
  assert.throws(() => validateSearch(raw, search), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('empty or malformed search and review collections are never reported as a confirmed zero result', () => {
  for (const [raw, validate, target, field] of [[rawSearch(search), validateSearch, search, 'items'], [rawReviews(product), validateReviews, product, 'reviews']]) {
    raw[field] = [];
    assert.throws(() => validate(raw, target), { code: 'INVALID_RESPONSE' });
  }
  const raw = rawReviews(product); raw.reviews[0].body = '';
  assert.throws(() => validateReviews(raw, product), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('known page gates reject plausible stale results and mark actions definitely undispatched', () => {
  for (const [state, code] of [['verification_required', 'VERIFICATION_REQUIRED'], ['rate_limited', 'RATE_LIMITED'], ['login_required', 'LOGIN_REQUIRED']]) {
    assert.throws(() => validateSearch({ ...rawSearch(search), state }, search), { code });
    assert.throws(() => validateReviews({ ...rawReviews(product), state }, product), { code });
    assert.throws(() => validateReadActionAcknowledgement({ state }), error => error.code === code && error.actionNotDispatched === true);
  }
  for (const state of ['constructor', '__proto__', 'unexpected']) {
    assert.throws(() => validateReadActionAcknowledgement({ state }), error => error.code === 'INVALID_RESPONSE' && !error.actionNotDispatched);
  }
});

async function actionFixture({ kind = 'search', dispatched = false, neverAppears = false, failDispatch = false } = {}) {
  let now = 10000, actions = 0, commits = 0;
  const op = { tab_id: 1, target: kind === 'search' ? search : product, read_action: newReadActionState(), recovery_kind: null };
  if (dispatched) { op.read_action.action_reserved = true; op.read_action.observations = 1; }
  const observe = async () => (dispatched && !neverAppears) ? { state: 'ready', result: { synthetic: true } } : { state: 'action_required' };
  const act = async () => { actions += 1; dispatched = true; if (failDispatch) throw new ShoppingError('BRIDGE_TIMEOUT', 'Synthetic timeout'); };
  const bridge = { readSearch: observe, readReviews: observe, navigateSearch: act, expandReviews: act };
  return { op, context: { kind, bridge, op, commit: async () => { commits += 1; validateReadActionState(op.read_action); },
    now: () => now, wait: async ms => { now += ms; } }, actions: () => actions, commits: () => commits };
}

test('uncertain search and review actions are observed without redispatch', async () => {
  for (const kind of ['search', 'product_reviews']) {
    const f = await actionFixture({ kind, failDispatch: true });
    const result = await runReadAction(f.context);
    assert.equal(f.actions(), 1);
    assert.equal(result.action_evidence.acknowledgement_error, 'BRIDGE_TIMEOUT');
    assert.equal(result.action_evidence.observations_reserved, 2);
  }
});

test('saved dispatches resume with observations only; an action that never appears stops after three checks', async () => {
  const restored = await actionFixture({ dispatched: true });
  await runReadAction(restored.context);
  assert.equal(restored.actions(), 0);
  const missing = await actionFixture({ neverAppears: true });
  await assert.rejects(runReadAction(missing.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(missing.actions(), 1);
  assert.equal(missing.op.read_action.checks, 3);
  assert.equal(missing.op.read_action.observations, 4);
  await assert.rejects(runReadAction(missing.context), { code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal(missing.op.read_action.observations, 4);
});

test('a verification guard never consumes an action reservation or continues behind the gate', async () => {
  const f = await actionFixture();
  f.context.bridge.navigateSearch = async () => validateReadActionAcknowledgement({ state: 'verification_required' });
  await assert.rejects(runReadAction(f.context), { code: 'VERIFICATION_REQUIRED' });
  assert.equal(f.op.read_action.action_reserved, false);
  assert.equal(f.op.read_action.observations, 1);
});
