import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListEmptyEvidence } from '../lib/list-empty-state.mjs';
import { emptyListObservation } from '../test-support/list-empty-fixture.mjs';

const evidence = () => emptyListObservation('cart').empty_evidence;

test('explicit empty evidence is a bounded current-view observation and returns an independent value', () => {
  const raw = evidence(), before = structuredClone(raw);
  const result = normalizeListEmptyEvidence(raw);
  assert.deepEqual(result, before);
  result.message.text = 'modified';
  assert.deepEqual(raw, before);
});

test('empty evidence rejects ambiguous, hidden, outside-list, loading and access-gated notices', () => {
  for (const [key, value] of [
    ['scope', 'whole_account'], ['basis', 'zero_extracted_rows'], ['list_root_count', 0],
    ['list_root_count', 2], ['notice_count', 0], ['notice_count', 2], ['notice_visible', false],
    ['notice_within_list', false], ['document_ready', false], ['gates_clear', false],
    ['notice_visible', 1], ['unknown_field', true],
  ]) assert.throws(() => normalizeListEmptyEvidence({ ...evidence(), [key]: value }), { code: 'INVALID_RESPONSE' });
  for (const key of Object.keys(evidence())) {
    const raw = evidence(); delete raw[key];
    assert.throws(() => normalizeListEmptyEvidence(raw), { code: 'INVALID_RESPONSE' });
  }
});

test('empty messages must be complete bounded original text, not truncated or silently sanitized', () => {
  for (const message of [null, [], {}, { text: '', truncated: false }, { text: ' ', truncated: false },
    { text: ' spaced ', truncated: false }, { text: 'private\u0000field', truncated: false },
    { text: 'private\u0085field', truncated: false }, { text: 'private\u009ffield', truncated: false },
    { text: 'x'.repeat(501), truncated: false }, { text: 'empty', truncated: true },
    { text: 'empty', truncated: false, extra: true }, { text: 0, truncated: false }]) {
    assert.throws(() => normalizeListEmptyEvidence({ ...evidence(), message }), { code: 'INVALID_RESPONSE' });
  }
  assert.equal(normalizeListEmptyEvidence({ ...evidence(), message: { text: 'x'.repeat(500), truncated: false } }).message.text.length, 500);
  for (const raw of [null, [], 'empty', true]) {
    assert.throws(() => normalizeListEmptyEvidence(raw), { code: 'INVALID_RESPONSE' });
  }
});
