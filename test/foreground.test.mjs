import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBlockedPageDisplay, displayPausedPage } from '../lib/foreground.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { loadTask } from '../lib/task-store.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { parseJdProductUrl } from '../lib/jd/targets.mjs';
import { jdReviewReadScript, validateJdReviewObservation } from '../lib/jd/review-categories.mjs';
import { jdReviewPage } from '../test-support/jd-review-fixture.mjs';
import { main } from '../lib/cli.mjs';
import { playwrightStatus } from '../test-support/mock-bridge.mjs';
import { productResult } from '../test-support/product-fixture.mjs';

const ENDPOINT = 'http://127.0.0.1:19825';
const fail = code => { throw new ShoppingError(code, 'Synthetic page failure'); };
const timer = () => {
  let time = Date.parse('2026-11-04T00:00:00Z');
  return { now: () => time, wait: async ms => { time += ms; } };
};
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping foreground '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function taskFixture(t, platform, action) {
  const stateDirectory = await directory(t);
  const bridge = { endpoint: ENDPOINT, protocol: 'playwright-extension', readProduct: action, readJdSearch: action, readPddSearch: action };
  const options = { stateDirectory, platform, task: 'sample', bridge };
  if (platform === 'taobao') {
    await saveBinding(stateDirectory, 'sample', { schema_version: 1, platform, endpoint: ENDPOINT, tab_id: 41,
      target: parseProductUrl('https://detail.tmall.com/item.htm?id=123'), created_at: new Date().toISOString() });
    options.bindings = ['sample'];
  } else { options.search = 'synthetic'; options.tabId = 41; }
  await createTask(options);
  return { options, bridge, filename: path.join(stateDirectory, 'tasks/sample.json') };
}

test('display attempts are limited to explicit blocked tabs and contain missing, false and throwing implementations', async () => {
  const calls = [];
  const show = createBlockedPageDisplay({ showTab: async id => { calls.push(id); if (id === 42) throw new Error('Synthetic display failure'); return false; } });
  for (const id of [undefined, null, -1, 0, '41', NaN]) assert.equal(await show(id), false);
  assert.equal(await show(41), false);
  assert.equal(await show(41), false);
  assert.equal(await show(42), false);
  assert.equal(await show(42), false);
  assert.deepEqual(calls, [41, 42]);
  assert.equal(await createBlockedPageDisplay({})(41), false);
});

test('only committed human or platform pauses may request display, including the exact confirmed order page', async () => {
  const calls = [], showPage = async id => { calls.push(id); return true; };
  const op = { tab_id: 41, order_detail_check: { detail_tab_id: 81 } };
  for (const status of ['pending', 'running', 'retry_wait', 'complete', 'waiting_connection']) {
    await displayPausedPage({ task: { status }, op, error: { code: 'LOGIN_REQUIRED' }, showPage });
  }
  for (const code of ['PACING_LIMIT', 'BRIDGE_TIMEOUT', 'TARGET_MISSING', 'EXTENSION_DISCONNECTED', 'PAGE_STRUCTURE_CHANGED']) {
    await displayPausedPage({ task: { status: 'stopped' }, op, error: { code }, showPage });
  }
  assert.deepEqual(calls, []);
  assert.equal(await displayPausedPage({ task: { status: 'waiting_user' }, op, error: { code: 'LOGIN_REQUIRED' }, showPage }), true);
  assert.deepEqual(calls, [81]);
  assert.equal(await displayPausedPage({ task: { status: 'waiting_user' }, op, error: { code: 'LOGIN_REQUIRED' },
    showPage: async () => { throw new Error('Synthetic display failure'); } }), false);
});

for (const platform of ['taobao', 'jd', 'pdd']) {
  test(`${platform} saves login, verification and rate pauses before one display; display outcomes preserve the checkpoint`, async t => {
    for (const [code, status] of [['LOGIN_REQUIRED', 'waiting_user'], ['VERIFICATION_REQUIRED', 'waiting_user'], ['RATE_LIMITED', 'waiting_cooldown']]) {
      for (const outcome of ['shown', 'hidden', 'throw']) {
        const f = await taskFixture(t, platform, async () => fail(code));
        const seen = [], limits = [];
        f.bridge.showTab = async tabId => {
          seen.push({ tabId, bytes: await readFile(f.filename), saved: await loadTask(f.options.stateDirectory, 'sample'), limits: limits.length });
          if (outcome === 'throw') throw new Error('Synthetic display failure');
          return outcome === 'shown';
        };
        const options = { ...f.options, onPlatformLimit: async observation => { limits.push(observation); } };
        const result = await runTask(options, timer());
        assert.equal(result.status, status);
        assert.equal(result.operations[0].error.code, code);
        assert.equal(result.operations[0].attempts, 1);
        assert.equal(result.automatic_retries, 0);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].tabId, 41);
        assert.equal(seen[0].saved.status, status);
        assert.equal(seen[0].saved.operations[0].error.code, code);
        assert.equal(seen[0].limits, platform !== 'taobao' && code !== 'LOGIN_REQUIRED' ? 1 : 0);
        assert.deepEqual(await readFile(f.filename), seen[0].bytes);
        await taskStatus(options);
        await assert.rejects(runTask(options, timer()), { code: 'RECOVERY_REQUIRED' });
        assert.equal(seen.length, 1);
        assert.deepEqual(await readFile(f.filename), seen[0].bytes);
      }
    }
  });
}

test('successful reads, cache reads, connection pauses, transient retries and diagnostics never request display', async t => {
  for (const code of [null, 'TARGET_MISSING', 'EXTENSION_DISCONNECTED', 'BRIDGE_TIMEOUT', 'PAGE_STRUCTURE_CHANGED']) {
    const f = await taskFixture(t, 'taobao', async () => code ? fail(code) : productResult('123'));
    const calls = [];
    f.bridge.showTab = async id => { calls.push(id); return true; };
    const result = await runTask(f.options, timer());
    if (code === null) assert.equal((await runTask(f.options, timer())).status, 'complete');
    else assert.equal(result.operations[0].error.code === code || result.operations[0].error.code === 'OPERATION_RETRY_LIMIT', true);
    assert.deepEqual(calls, []);
  }
});

test('an explicit cooldown probe may show a new blocking outcome once, while stopped cache reads never show again', async t => {
  const f = await taskFixture(t, 'taobao', async () => fail('RATE_LIMITED'));
  let shows = 0;
  f.bridge.showTab = async () => { shows++; return true; };
  await runTask(f.options, timer());
  assert.equal(shows, 1);
  const result = await runTask({ ...f.options, recovery: 'cooldown' }, timer());
  assert.equal(result.status, 'stopped');
  assert.equal(result.cooldown_probes, 1);
  assert.equal(shows, 2);
  await runTask(f.options, timer());
  assert.equal(shows, 2);
});

test('an unexplained empty search pauses like a limit and displays once without a retry', async t => {
  const f = await taskFixture(t, 'taobao', async () => fail('SEARCH_RESULTS_UNAVAILABLE'));
  const calls = [];
  f.bridge.showTab = async id => { calls.push(id); return true; };
  assert.equal((await runTask(f.options, timer())).status, 'waiting_cooldown');
  assert.deepEqual(calls, [41]);
});

test('JD hidden-review recovery shares its single display attempt with the eventual user pause', async t => {
  for (const outcome of ['shown', 'hidden', 'throw']) {
    const stateDirectory = await directory(t), page = jdReviewPage({ visibility: 'hidden', initiallyOpen: true });
    const shows = [], reads = [];
    const bridge = { endpoint: ENDPOINT, protocol: 'playwright-extension',
      readJdReviewCategories: async () => {
        reads.push(page.visibility);
        return { observed_at: new Date().toISOString(), raw: validateJdReviewObservation(page.evaluate(jdReviewReadScript(page.target))) };
      },
      showTab: async id => {
        shows.push(id);
        if (outcome === 'throw') throw new Error('Synthetic display failure');
        if (outcome === 'shown') page.visibility = 'visible';
        return true;
      } };
    await saveBinding(stateDirectory, 'sample', { schema_version: 1, platform: 'jd', endpoint: ENDPOINT, tab_id: 88,
      target: page.target, created_at: new Date().toISOString() });
    const plan = path.join(stateDirectory, 'plan.json'); await writeFile(plan, JSON.stringify([null]));
    const options = { stateDirectory, task: 'sample', platform: 'jd', bridge, bindings: ['sample'], reviewCategories: plan };
    await createTask(options);
    const result = await runTask(options, timer());
    assert.deepEqual(shows, [88]);
    if (outcome === 'shown') { assert.equal(result.status, 'complete'); assert.equal(reads[0], 'hidden'); }
    else {
      assert.equal(result.status, 'waiting_user');
      assert.equal(result.operations[0].error.code, 'PAGE_NOT_VISIBLE');
      assert.equal((await loadTask(stateDirectory, 'sample')).status, 'waiting_user');
    }
  }
});

function offlineHttp(t, respond) {
  const requests = [];
  t.mock.method(http, 'request', (url, options, onResponse) => {
    const outgoing = new EventEmitter();
    outgoing.end = text => {
      const body = text ? JSON.parse(text) : null;
      requests.push({ url, body });
      void Promise.resolve().then(async () => {
        const value = url.endsWith('/status') ? playwrightStatus() : await respond(body);
        const response = Readable.from([Buffer.from(JSON.stringify(value))]); response.statusCode = 200; onResponse(response);
      }).catch(error => outgoing.emit('error', error));
    };
    return outgoing;
  });
  return requests;
}

async function cli(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output), output };
}

test('page-open saves its page record and limit observation before showing a login or risk landing once', async t => {
  for (const platform of ['jd', 'pdd']) {
    for (const landing of ['login', 'risk', 'requested']) {
      const stateDirectory = await directory(t), seen = [];
      const urls = { jd: { login: 'https://passport.jd.com/new/login.aspx', risk: 'https://pc-frequent-pro.pf.jd.com/' },
        pdd: { login: 'https://mobile.pinduoduo.com/login.html', risk: 'https://mobile.pinduoduo.com/psnl_verification.html' } };
      const requests = offlineHttp(t, async body => {
        if (body.action === 'tab_new') return { id: body.id, success: true, data: { tabId: 88, url: urls[platform][landing] ?? body.url } };
        if (body.action === 'tab_show') {
          seen.push({ tabId: body.tabId, ledger: JSON.parse(await readFile(path.join(stateDirectory, 'opened-pages.json'), 'utf8')),
            ...(landing === 'risk' ? { limit: await readFile(path.join(stateDirectory, 'throttle-observations.json'), 'utf8') } : {}) });
          throw new Error('Synthetic display failure');
        }
        assert.fail('Unexpected page command');
      });
      const result = await cli(['page-open', '--endpoint', ENDPOINT, '--platform', platform, '--search', 'synthetic', '--state-dir', stateDirectory]);
      assert.equal(result.value.status, 'page_opened');
      assert.equal(result.value.landing, landing === 'login' ? 'login_page' : landing === 'risk' ? 'risk_page' : 'requested');
      assert.equal(seen.length, landing === 'requested' ? 0 : 1);
      if (seen.length) { assert.equal(seen[0].tabId, 88); assert.equal(seen[0].ledger.pages[0].tab_id, 88); }
      assert.equal(requests.filter(request => request.body?.action === 'tab_new').length, 1);
      assert.ok(!result.output.includes('Synthetic display failure'));
      t.mock.restoreAll();
    }
  }
});

test('bind and probe display their explicit blocked page without replacing the original page error', async t => {
  for (const command of ['bind', 'probe']) {
    const stateDirectory = await directory(t), target = parseJdProductUrl('https://item.jd.com/1000123.html'), seen = [];
    if (command === 'probe') await saveBinding(stateDirectory, 'sample', { schema_version: 1, platform: 'jd', endpoint: ENDPOINT,
      tab_id: 52, target, created_at: new Date().toISOString() });
    offlineHttp(t, async body => {
      if (body.action === 'tab_list') return { id: body.id, success: true, data: { tabs: [{ id: 52, url: target.url }] } };
      if (body.action === 'eval') return { id: body.id, success: true, data: { result: { state: 'rate_limited' } } };
      if (body.action === 'tab_show') {
        seen.push({ tabId: body.tabId, limit: await readFile(path.join(stateDirectory, 'throttle-observations.json'), 'utf8') });
        return { id: body.id, success: false, error: 'Synthetic display failure' };
      }
      assert.fail('Unexpected page command');
    });
    const result = await cli([command, '--endpoint', ENDPOINT, '--state-dir', stateDirectory, '--binding', 'sample',
      ...(command === 'bind' ? ['--platform', 'jd', '--tab', '52'] : [])]);
    assert.equal(result.code, 2);
    assert.equal(result.value.error.code, 'RATE_LIMITED');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tabId, 52);
    assert.ok(!result.output.includes('Synthetic display failure'));
    t.mock.restoreAll();
  }
});
