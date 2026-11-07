import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../lib/cli.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

async function daemon(t) {
  return mockBridge(t, { handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_new') return send({ id: body.id, success: true, data: { tabId: 88, title: 'x', url: body.url } });
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

async function invoke(t, args) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping page open '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  return { stateDirectory, run: async (extra = []) => {
    let output = '';
    const code = await main([...args, ...extra, '--state-dir', stateDirectory], { write: value => { output += value; } });
    return { code, value: JSON.parse(output) };
  } };
}

test('page-open opens one canonical search or product page and records it in the state directory ledger', async t => {
  const server = await daemon(t);
  const search = await invoke(t, ['page-open', '--search', 'Synthetic mouse', '--endpoint', server.endpoint]);
  const opened = await search.run();
  assert.equal(opened.code, 0);
  assert.deepEqual({ status: opened.value.status, tab_id: opened.value.tab_id, kind: opened.value.kind, url_matches: opened.value.url_matches },
    { status: 'page_opened', tab_id: 88, kind: 'search', url_matches: true });
  assert.equal(opened.value.url, undefined, 'no URL is echoed');
  const ledger = JSON.parse(await readFile(path.join(search.stateDirectory, 'pacing.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['search']);
  const product = await invoke(t, ['page-open', '--url', 'https://item.taobao.com/item.htm?id=5&spm=tracking', '--endpoint', server.endpoint]);
  const item = await product.run();
  assert.equal(item.value.kind, 'product'); assert.equal(server.state.commands.at(-1).url, 'https://item.taobao.com/item.htm?id=5');
  const orders = await (await invoke(t, ['page-open', '--orders', '--endpoint', server.endpoint])).run();
  assert.equal(orders.value.kind, 'orders'); assert.equal(orders.value.status, 'page_opened');
  const cart = await (await invoke(t, ['page-open', '--cart', '--endpoint', server.endpoint])).run();
  assert.equal(cart.value.kind, 'cart'); assert.equal(cart.value.status, 'page_opened');
  assert.equal(server.state.commands.at(-1).url, 'https://cart.taobao.com/cart.htm');
});

test('page-open rejects missing or conflicting targets and, with no quota left, sends nothing and says when to continue', async t => {
  const server = await daemon(t);
  for (const args of [['page-open'], ['page-open', '--search', 'a', '--url', 'https://item.taobao.com/item.htm?id=5'], ['page-open', '--orders', '--search', 'a'], ['page-open', '--cart', '--orders']]) {
    const result = await (await invoke(t, [...args, '--endpoint', server.endpoint])).run();
    assert.equal(result.code, 2); assert.equal(result.value.error.code, 'INVALID_ARGUMENTS');
  }
  const limited = await invoke(t, ['page-open', '--search', 'Synthetic mouse', '--endpoint', server.endpoint]);
  const now = Date.now();
  await writeFile(path.join(limited.stateDirectory, 'pacing.json'), JSON.stringify({ schema_version: 1, last_interaction_at: 0, last_load_at: 0,
    gap: null, load_gap: null, loads: [5, 4, 3, 2, 1].map(minutes => ({ at: now - minutes * 60_000, category: 'search' })) }));
  const commands = server.state.commands.length;
  const result = await limited.run();
  assert.equal(result.code, 2); assert.equal(result.value.error.code, 'PACING_LIMIT');
  assert.match(result.value.error.next_action, /^Wait until \d{4}-\d{2}-\d{2}T/);
  assert.equal(server.state.commands.length, commands);
});
