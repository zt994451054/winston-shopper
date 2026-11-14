import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../lib/cli.mjs';
import { PAGE_GAP_POLICY, recordPageOpened, waitForPageGap } from '../lib/page-gap.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping page gap '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function clock(start = Date.UTC(2026, 10, 14, 10, 0, 0)) {
  let now = start;
  const waits = [];
  return { now: () => now, wait: async ms => { waits.push(ms); now += ms; }, advance: ms => { now += ms; }, random: () => 0.5, waits };
}

// 2026-11-13: three Taobao product pages opened 13 and 9 seconds apart; the last two showed 访问异常提示.
test('pages on one platform are spaced by a random 15-20 second gap that is waited in place, per platform', async t => {
  const directory = await stateDirectory(t), time = clock();
  assert.equal(await waitForPageGap(directory, 'taobao', time), 0, 'the first page does not wait');
  for (const [random, gap] of [[0, 15_000], [1, 20_000]]) {
    assert.equal(await recordPageOpened(directory, 'taobao', { now: time.now, random: () => random }) - time.now(), gap);
  }
  time.advance(9_000);
  assert.equal(await waitForPageGap(directory, 'taobao', time), 11_000);
  assert.equal(await waitForPageGap(directory, 'jd', time), 0, 'another platform keeps its own gap');
  await recordPageOpened(directory, 'jd', time);
  const saved = JSON.parse(await readFile(path.join(directory, 'page-gap.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.next_allowed_at).sort(), ['jd', 'taobao']);
  assert.deepEqual(PAGE_GAP_POLICY.gap_ms, [15_000, 20_000]);

  // A clock set back never turns into a wait longer than one gap.
  await writeFile(path.join(directory, 'page-gap.json'), JSON.stringify({ schema_version: 1, next_allowed_at: { pdd: time.now() + 3_600_000 } }));
  assert.equal(await waitForPageGap(directory, 'pdd', time), 20_000);
  for (const broken of ['{"schema_version":1,"next_allowed_at":{"pdd":"soon"}}', '{"schema_version":1,"next_allowed_at":{"other":1}}', 'x']) {
    await writeFile(path.join(directory, 'page-gap.json'), broken);
    await assert.rejects(waitForPageGap(directory, 'pdd', time), { code: 'INVALID_PACING_STATE' });
  }
});

test('page-open waits the page gap before a product, order or cart page, counting a search on the same platform', async t => {
  const server = await mockBridge(t, { handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_new') return send({ id: body.id, success: true, data: { tabId: 88, title: 'x', url: body.url } });
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
  const directory = await stateDirectory(t), time = clock(Date.now());
  const run = async args => {
    let output = '';
    await main([...args, '--endpoint', server.endpoint, '--state-dir', directory], { write: value => { output += value; }, environment: { pageGapClock: time } });
    return JSON.parse(output);
  };
  assert.equal((await run(['page-open', '--search', 'Synthetic mouse'])).status, 'page_opened');
  assert.deepEqual(time.waits, [], 'a search waits only for the search gap');
  assert.equal((await run(['page-open', '--url', 'https://item.taobao.com/item.htm?id=5'])).status, 'page_opened');
  assert.deepEqual(time.waits, [17_500], 'a product page right after a search on the same platform waits');
  assert.equal((await run(['page-open', '--platform', 'jd', '--url', 'https://item.jd.com/100.html'])).status, 'page_opened');
  assert.deepEqual(time.waits, [17_500], 'the first JD page does not wait for Taobao');
  assert.equal((await run(['page-open', '--orders'])).status, 'page_opened');
  assert.deepEqual(time.waits, [17_500, 17_500]);
});
