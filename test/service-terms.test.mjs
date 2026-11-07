import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServiceTerms } from '../lib/service-terms.mjs';
import { validateDetails, validateSavedDetails } from '../lib/details.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawDetails } from '../test-support/detail-fixture.mjs';

const label = '7天无理由退换';
function rawTerms() {
  return { schema_version: 1, panel_observed: true, entry_expanded: true, items_seen: 1,
    items: [{ label, header_text: `${label}\n更多`, body_text: '剪标、使用、洗涤后不支持。',
      body_truncated: false, body_clipped: false, additional_entry_labels: ['更多'] }] };
}

test('service summaries retain restrictions and secondary entries without verifying full rules or eligibility', () => {
  const terms = normalizeServiceTerms(rawTerms(), [label]);
  assert.equal(terms.items[0].body_text, '剪标、使用、洗涤后不支持。');
  assert.deepEqual(terms.items[0].additional_entry_labels, ['更多']);
  assert.equal(terms.association_basis, 'expanded_entry_and_matching_labels');
  assert.equal(terms.full_terms_verified, false); assert.equal(terms.eligibility_verified, false);
});

test('unrelated labels, contradictory expansion, bad counts and hidden text are rejected', () => {
  for (const mutate of [r => { r.entry_expanded = false; }, r => { r.panel_observed = false; },
    r => { r.items_seen++; }, r => { r.items[0].label = 'A different product'; },
    r => { r.items[0].header_text = 'Different title'; }, r => { r.items[0].body_clipped = true; },
    r => { r.items[0].additional_entry_labels = ['Buy now']; }, r => { r.items[0].body_text = ''; }]) {
    const r = rawTerms(); mutate(r); assert.throws(() => normalizeServiceTerms(r, [label]), { code: 'INVALID_RESPONSE' });
  }
});

test('service summaries are optional for old caches and cannot acquire stronger saved guarantees', () => {
  const raw = rawDetails(), target = parseProductUrl(raw.url);
  const old = validateDetails(raw, target); validateSavedDetails(old, target);
  assert.equal(old.details.services.terms, undefined);
  raw.details.services.terms = rawTerms();
  const result = validateDetails(raw, target); validateSavedDetails(result, target);
  for (const mutate of [r => { r.full_terms_verified = true; }, r => { r.eligibility_verified = true; },
    r => { r.items_returned = 9; }, r => { r.association_basis = 'platform_verified'; }]) {
    const forged = structuredClone(result); mutate(forged.details.services.terms);
    assert.throws(() => validateSavedDetails(forged, target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('an unobserved service panel stays distinct from a missing legacy observation', () => {
  const terms = normalizeServiceTerms({ schema_version: 1, panel_observed: false, entry_expanded: false, items_seen: 0, items: [] }, [label]);
  assert.equal(terms.items_returned, 0); assert.equal(terms.association_basis, null);
  const clipped = rawTerms(); Object.assign(clipped.items[0], { body_text: '', body_clipped: true });
  assert.equal(normalizeServiceTerms(clipped, [label]).items[0].body_clipped, true);
});
