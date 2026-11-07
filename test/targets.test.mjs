import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { metadataScript, productTargetScript, parseProductUrl, summarizeTab, validateMetadata } from '../lib/targets.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');

test('saved product address checks require no document, storage, title or active-tab identity', () => {
  const forbidden = new Proxy({}, { get() { throw new Error('Unexpected page content access'); } });
  const result = vm.runInNewContext(productTargetScript(target), { URL, location: { href: `${target.url}&skuId=456&token=PRIVATE` },
    document: forbidden, localStorage: forbidden, sessionStorage: forbidden });
  assert.equal(result.url, target.url); assert.equal(result.state, 'observed');
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(Object.keys(result).length, 2);
});

test('product address probes reject changed hosts, schemes, credentials and duplicate IDs without returning the address', () => {
  for (const url of ['https://example.test/private?token=PRIVATE', target.url.replace('123', '999'),
    `${target.url}&id=123`, target.url.replace('https:', 'http:'), target.url.replace('https://', 'https://user:pass@'),
    target.url.replace('.com/', '.com:999/'), 'https://detail.tmall.com.evil.test/item.htm?id=123']) {
    const result = vm.runInNewContext(productTargetScript(target), { URL, location: { href: url } });
    assert.equal(result.state, 'target_changed'); assert.deepEqual(Object.keys(result), ['state']);
  }
});

test('product address probes classify only known login hosts and reject invalid requested identities locally', () => {
  const result = vm.runInNewContext(productTargetScript(target), { URL, location: { href: 'https://login.taobao.com/member/login.jhtml?token=PRIVATE' } });
  assert.equal(result.state, 'login_required'); assert.equal(Object.keys(result).length, 1);
  for (const value of [null, {}, {url:'https://example.test/'}]) assert.throws(() => productTargetScript(value), { code: 'INVALID_TARGET' });
});

test('tracking parameters are removed while platform IDs remain strings', () => {
  const result = parseProductUrl('https://item.taobao.com/item.htm?id=12345678901234567890&token=SECRET');
  assert.equal(result.product_id, '12345678901234567890');
  assert.equal(result.url, 'https://item.taobao.com/item.htm?id=12345678901234567890');
});

test('lookalike hosts, ambiguous IDs and non-product paths are rejected', () => {
  for (const url of ['https://detail.tmall.com.evil.test/item.htm?id=1',
    'https://user:secret@detail.tmall.com/item.htm?id=1',
    'https://detail.tmall.com/item.htm?id=1&id=2',
    'https://detail.tmall.com/item.htm?id=x',
    'https://detail.tmall.com/other?id=1',
    'https://detail.tmall.com:999/item.htm?id=1',
    'javascript:alert(1)']) assert.equal(parseProductUrl(url), null);
});

test('private order URLs are reduced to origin and unrelated sites are omitted', () => {
  assert.deepEqual(summarizeTab({ id: 1, url: 'https://buyertrade.taobao.com/trade/detail.htm?orderId=PRIVATE_ORDER' }), {
    tab_id: 1, origin: 'https://buyertrade.taobao.com', kind: 'other',
  });
  assert.equal(summarizeTab({ id: 2, url: 'https://mail.example.com/' }), null);
});

test('in-page identity guard runs before accessing document content', () => {
  const expression = metadataScript(target);
  const wrongLocation = new URL('https://detail.tmall.com/item.htm?id=999');
  const result = vm.runInNewContext(expression, { URL, location: wrongLocation,
    document: { get title() { throw new Error('must not read a different page'); } } });
  assert.equal(result.state, 'target_changed');
});

test('metadata probe only needs location, URL and public document title', () => {
  const result = vm.runInNewContext(metadataScript(target), {
    URL, location: new URL(`${target.url}&tracking=PRIVATE`), document: { title: 'Example product' },
  });
  const metadata = validateMetadata(result, target);
  assert.equal(metadata.title, 'Example product');
  assert.equal(metadata.page_state, 'not_assessed');
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE'));
});

test('malformed metadata and identity races do not produce a product result', () => {
  assert.throws(() => validateMetadata({ state: 'target_changed' }, target), { code: 'TARGET_CHANGED' });
  assert.throws(() => validateMetadata({ state: 'observed', product_id: '999' }, target), { code: 'INVALID_RESPONSE' });
});
