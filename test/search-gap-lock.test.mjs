import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main } from '../lib/cli.mjs';
import { SEARCH_GAP_POLICY, recordSearchOpened, waitForSearchGap } from '../lib/search-gap.mjs';
import { PLATFORM_LOCK_MS, lockPlatform, requirePlatformUnlocked, requireSearchHoldOver, unlockPlatform } from '../lib/platform-lock.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping gap lock '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function clock(start = Date.UTC(2026, 10, 8, 10, 0, 0)) {
  let now = start;
  const waits = [];
  return { now: () => now, wait: async ms => { waits.push(ms); now += ms; }, advance: ms => { now += ms; }, waits };
}

test('new searches on any platform are spaced by a random 2-4 minute gap; a short rest is waited out, a long one refused', async t => {
  const directory = await stateDirectory(t), time = clock();
  await waitForSearchGap(directory, time);
  assert.deepEqual(time.waits, [], 'the first search does not wait');
  for (const [random, gap] of [[0, 120_000], [1, 240_000], [0.5, 180_000]]) {
    const next = await recordSearchOpened(directory, { now: time.now, random: () => random });
    assert.equal(next - time.now(), gap);
  }
  time.advance(60_000);
  await assert.rejects(waitForSearchGap(directory, time), error => error.code === 'PACING_LIMIT' && error.actionNotDispatched &&
    error.allowedAt === time.now() + 120_000 && /all platforms/.test(error.nextAction ?? error.next_action ?? ''));
  time.advance(60_000);
  await waitForSearchGap(directory, time);
  assert.deepEqual(time.waits, [60_000], 'a rest under 90 seconds is waited in place');
  assert.deepEqual(SEARCH_GAP_POLICY.gap_ms, [120_000, 240_000]);

  await writeFile(path.join(directory, 'search-gap.json'), '{"schema_version":1,"next_allowed_at":"soon"}');
  await assert.rejects(waitForSearchGap(directory, time), { code: 'INVALID_PACING_STATE' });
});

test('a platform lock lasts 15 minutes, covers only that platform and can be lifted early', async t => {
  const directory = await stateDirectory(t), time = clock();
  await requirePlatformUnlocked(directory, 'jd', time);
  const lock = await lockPlatform(directory, 'jd', 'rate_limited', time);
  assert.equal(lock.until - time.now(), PLATFORM_LOCK_MS);
  assert.equal(PLATFORM_LOCK_MS, 15 * 60_000);
  await assert.rejects(requirePlatformUnlocked(directory, 'jd', time), error => error.code === 'PLATFORM_LOCKED' && error.actionNotDispatched &&
    error.allowedAt === lock.until);
  // 2026-11-08: a caller read the ISO time as local time; the message also gives the machine's wall-clock time and offset.
  const local = new Date(lock.until), pad = value => String(value).padStart(2, '0');
  await assert.rejects(requirePlatformUnlocked(directory, 'jd', time), error =>
    error.message.includes(`${new Date(lock.until).toISOString()} (${pad(local.getHours())}:${pad(local.getMinutes())} local time, `) &&
    /UTC[+-][0-9]{2}:[0-9]{2}\)\.$/.test(error.message));
  await requirePlatformUnlocked(directory, 'taobao', time);
  time.advance(PLATFORM_LOCK_MS);
  await requirePlatformUnlocked(directory, 'jd', time);
  await lockPlatform(directory, 'pdd', 'login_required', time);
  assert.deepEqual(await unlockPlatform(directory, 'pdd'), { unlocked: true });
  assert.deepEqual(await unlockPlatform(directory, 'pdd'), { unlocked: false });
  await requirePlatformUnlocked(directory, 'pdd', time);
  await assert.rejects(lockPlatform(directory, 'pdd', 'tired', time), { code: 'INVALID_ARGUMENTS' });
  await writeFile(path.join(directory, 'platform-locks.json'), '{"schema_version":1,"locks":{"other":{}}}');
  await assert.rejects(requirePlatformUnlocked(directory, 'jd', time), { code: 'INVALID_PACING_STATE' });
});

async function opener(t) {
  return mockBridge(t, { handler({ req, res, body }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_new') return send({ id: body.id, success: true, data: { tabId: 88, title: 'x', url: body.url } });
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

async function run(args) {
  let output = '';
  const code = await main(args, { write: value => { output += value; } });
  return { code, value: JSON.parse(output) };
}

test('page-open refuses a second new search on another platform within the gap and sends nothing', async t => {
  const server = await opener(t), directory = await stateDirectory(t);
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  const first = await run(['page-open', '--search', 'Synthetic mouse', ...common]);
  assert.equal(first.value.status, 'page_opened');
  const gap = JSON.parse(await readFile(path.join(directory, 'search-gap.json'), 'utf8'));
  const rest = gap.next_allowed_at - Date.now();
  assert.ok(rest > 100_000 && rest <= 240_000, `the next search waits ${rest} ms`);
  const sent = server.state.commands.filter(command => command.action === 'tab_new').length;
  const second = await run(['page-open', '--platform', 'jd', '--search', 'Synthetic mouse', ...common]);
  assert.deepEqual([second.code, second.value.error.code], [2, 'PACING_LIMIT']);
  assert.equal(server.state.commands.filter(command => command.action === 'tab_new').length, sent);
  const product = await run(['page-open', '--platform', 'jd', '--url', 'https://item.jd.com/100.html', ...common]);
  assert.equal(product.value.status, 'page_opened', 'product pages are not spaced like new searches');
});

// 2026-11-08: right after the user said JD was fine, a new JD search met the limit again; 37 minutes later it read fine.
test('after platform-unlock, other page work goes on but a new search on that platform waits until the lock would have ended', async t => {
  const directory = await stateDirectory(t), time = clock();
  const lock = await lockPlatform(directory, 'jd', 'rate_limited', time);
  time.advance(60_000);
  const unlocked = await unlockPlatform(directory, 'jd', { holdSearches: true, now: time.now });
  assert.equal(unlocked.unlocked, true);
  assert.match(unlocked.searches_wait_until, new RegExp(`^${new Date(lock.until).toISOString().replace(/[.]/g, '\\.')} \\(`));
  await requirePlatformUnlocked(directory, 'jd', time);
  await assert.rejects(requireSearchHoldOver(directory, 'jd', time), error => error.code === 'PACING_LIMIT' && error.allowedAt === lock.until &&
    error.actionNotDispatched);
  await requireSearchHoldOver(directory, 'pdd', time);
  time.advance(PLATFORM_LOCK_MS);
  await requireSearchHoldOver(directory, 'jd', time);
  // A resume that met no signal lifts the lock without holding searches: the platform has just served a page.
  await lockPlatform(directory, 'pdd', 'rate_limited', time);
  assert.deepEqual(await unlockPlatform(directory, 'pdd', { now: time.now }), { unlocked: true });
  await requireSearchHoldOver(directory, 'pdd', time);
});

test('page-open --search is refused after platform-unlock until the lock would have ended, and sends nothing', async t => {
  const server = await opener(t), directory = await stateDirectory(t);
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  await lockPlatform(directory, 'jd', 'rate_limited');
  const unlocked = await run(['platform-unlock', '--platform', 'jd', '--state-dir', directory]);
  assert.match(unlocked.value.next_action, /a new search page on this platform waits until/);
  const search = await run(['page-open', '--platform', 'jd', '--search', 'Synthetic mouse', ...common]);
  assert.deepEqual([search.code, search.value.error.code], [2, 'PACING_LIMIT']);
  assert.match(search.value.error.message, /local time/);
  assert.equal(server.state.commands.filter(command => command.action === 'tab_new').length, 0);
});

test('unsupported options are named, and a task command explains that a saved task keeps its platform', async () => {
  const platform = await run(['task-run', '--task', 'x', '--platform', 'jd']);
  assert.equal(platform.value.error.message, 'task-run does not take --platform.');
  assert.match(platform.value.error.next_action, /keeps its platform/);
  assert.match((await run(['tabs', '--task', 'x'])).value.error.message, /--task/);
  assert.equal((await run(['platform-unlock'])).value.error.code, 'INVALID_ARGUMENTS');
});
