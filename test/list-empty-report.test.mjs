import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCachedReport, renderCachedReport } from '../lib/cached-report.mjs';
import { emptyListObservation } from '../test-support/list-empty-fixture.mjs';

function savedTask(kind, collection = false) {
  const raw = emptyListObservation(kind), { state, loaded_rows_seen, loaded_orders_seen, ...snapshot } = raw;
  snapshot.schema_version = 3;
  snapshot.coverage = kind === 'cart' ? { empty_cart_verified: true, full_cart: false, page_total_rows: null }
    : { empty_orders_verified: true, full_order_history: false, page_total_orders: null };
  const op = { status: 'succeeded', result: snapshot };
  if (collection) {
    op[kind === 'cart' ? 'cart_collection' : 'order_collection'] = { batches: [{ snapshot }] };
    op.result = { batches: [{ snapshot }], coverage: snapshot.coverage };
  }
  return { id: 'synthetic-empty', kind: (kind === 'cart' ? 'cart_' : 'order_') + (collection ? 'collection' : 'snapshot'),
    status: 'complete', created_at: '2026-10-10T00:00:00.000Z', updated_at: '2026-10-10T02:00:00.000Z', operations: [op] };
}

for (const kind of ['cart', 'orders']) {
  for (const collection of [false, true]) {
    test(`${kind} ${collection ? 'collection' : 'snapshot'} reports retain explicit emptiness separately from absent cache`, () => {
      const input = savedTask(kind, collection), before = structuredClone(input), report = buildCachedReport(input);
      assert.equal(report.observations[0].available, true);
      assert.equal(report.observations[0].observed_at, emptyListObservation(kind).observed_at);
      const notice = report.records.find(record => record.record_type === 'empty_notice');
      assert.ok(notice);
      assert.equal(notice.text, emptyListObservation(kind).empty_evidence.message.text);
      assert.equal(notice.label, 'current_list_view');
      assert.equal(notice.qualifier, 'explicit_empty_notice');
      assert.equal(notice.verified, true);
      assert.equal(report.records.length, 1);
      for (const format of ['markdown', 'csv']) {
        const text = renderCachedReport(report, format);
        assert.ok(text.includes(notice.text));
        assert.ok(text.includes(notice.observed_at));
        assert.ok(text.includes(format === 'markdown' ? 'current\\_list\\_view' : 'current_list_view'));
        assert.equal(text.includes('无已缓存内容记录'), false);
        assert.ok(text.includes('当前列表视图'));
      }
      assert.deepEqual(input, before);
    });
  }
}

test('report generation never infers empty evidence from a missing result or a legacy zero-item array', () => {
  for (const value of [null, { schema_version: 1, rows: [], coverage: { empty_cart_verified: false } }]) {
    const input = savedTask('cart'); input.operations[0].result = value;
    const report = buildCachedReport(input);
    assert.equal(report.records.some(record => record.record_type === 'empty_notice'), false);
    assert.equal(report.observations[0].available, value !== null);
  }
});

test('empty notice reports retain raw formula text while escaping each output format', () => {
  const input = savedTask('cart'), snapshot = input.operations[0].result;
  snapshot.empty_evidence.message.text = '=1+1 <test>|[link](javascript:bad)';
  const report = buildCachedReport(input), markdown = renderCachedReport(report, 'markdown'), csv = renderCachedReport(report, 'csv');
  assert.equal(report.records[0].text, snapshot.empty_evidence.message.text);
  assert.equal(markdown.includes('<test>'), false);
  assert.equal(markdown.includes('[link](javascript:bad)'), false);
  assert.ok(csv.includes("'=1+1"));
});
