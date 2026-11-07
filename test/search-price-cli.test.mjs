import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTask, runTask } from '../lib/tasks.mjs';
import { searchTarget, validateSearch } from '../lib/search.mjs';
import { rawSearch } from '../test-support/search-review-fixture.mjs';

const script = fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping price CLI '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  const preload = path.join(root, 'forbid-network.mjs');
  await writeFile(preload, "import http from 'node:http';\nimport https from 'node:https';\nimport {syncBuiltinESMExports} from 'node:module';\nconst deny=()=>{throw new Error('Network forbidden in offline price CLI test');};\nhttp.request=http.get=https.request=https.get=globalThis.fetch=deny;\nsyncBuiltinESMExports();\n");
  const invoke = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SHOPPING_STATE_DIR: stateDirectory, SHOPPING_BRIDGE_ENDPOINT: 'https://not-a-loopback-bridge.invalid' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolve({ code, value: JSON.parse(stdout), stdout, stderr }); }
      catch (error) { reject(new Error(`Price CLI returned invalid JSON: ${stderr}`, { cause: error })); }
    });
  });
  return { root, stateDirectory, invoke };
}

async function savedSearch(t) {
  const f = await fixture(t), target = searchTarget('Synthetic mouse');
  const raw = rawSearch(target);
  raw.items = raw.items.slice(0, 2).map((item, index) => ({ ...item,
    url: `https://item.taobao.com/item.htm?id=${100 + index}`,
    price: { raw: `¥${index ? '12.50' : '10.00'}`, amount_text: index ? '12.50' : '10.00', label: '' } }));
  raw.cards_seen = 2;
  const bridge = { endpoint: 'http://127.0.0.1:19999', protocol: 'playwright-extension',
    readSearch: async () => validateSearch(raw, target) };
  const options = { stateDirectory: f.stateDirectory, task: 'sample', search: target.query, tabId: 41, bridge };
  await createTask(options);
  const completed = await runTask(options);
  assert.equal(completed.status, 'complete');
  return { ...f, options, completed };
}

test('actual CLI creates a price request plan without a browser service or state directory', async t => {
  const f = await fixture(t);
  const result = await f.invoke(['search-price-plan', '--search', 'Synthetic mouse', '--min-price', '10']);
  assert.equal(result.code, 0);
  assert.equal(result.value.ok, true); assert.equal(result.value.command, 'search-price-plan');
  assert.equal(result.value.status, 'waiting_layout_evidence');
  assert.deepEqual(result.value.request.price_range, { currency: 'CNY', minimum: { amount: '10.00', cents: 1000 }, maximum: null, inclusive: true });
  assert.equal(result.value.request.price_sort, null);
  assert.equal(result.value.platform_applied, false); assert.equal(result.value.browser_accessed, false);
  assert.equal(result.value.state_changed, false); assert.equal(result.value.actions_reserved, 0);
  await assert.rejects(readdir(f.stateDirectory), { code: 'ENOENT' });
});

test('actual CLI passes explicit decimal price bounds and both planned directions', async t => {
  const f = await fixture(t);
  for (const sort of ['price-asc', 'price-desc']) {
    const result = await f.invoke(['search-price-plan', '--search', 'Synthetic mouse', '--sort', sort,
      '--min-price', '10.00', '--max-price', '12.50']);
    assert.equal(result.code, 0); assert.equal(result.value.ok, true);
    assert.equal(result.value.command, 'search-price-plan');
    assert.equal(result.value.request.price_sort, sort);
    assert.equal(result.value.request.price_range.minimum.cents, 1000);
    assert.equal(result.value.request.price_range.maximum.cents, 1250);
  }
  await assert.rejects(readdir(f.stateDirectory), { code: 'ENOENT' });
});

test('offline price commands reject browser, output and unrelated options', async t => {
  const f = await fixture(t);
  const invalid = [['--endpoint', 'http://127.0.0.1:19824'], ['--tab', '41'], ['--pages', '2'],
    ['--platform', 'taobao'], ['--dedicated'], ['--timeout-ms', '5000'], ['--output', 'file.json'],
    ['--format', 'csv'], ['--inspect-price'], ['--after-user']];
  for (const [command, common] of [['search-price-plan', ['--search', 'mouse']], ['search-price-check', ['--task', 'sample']]]) {
    for (const extra of invalid) {
      const result = await f.invoke([command, ...common, ...extra]);
      assert.equal(result.code, 2); assert.equal(result.value.error.code, 'INVALID_ARGUMENTS');
    }
  }
  for (const extra of [['--task', 'sample'], ['--state-dir', f.stateDirectory]]) {
    assert.equal((await f.invoke(['search-price-plan', '--search', 'mouse', ...extra])).value.error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal((await f.invoke(['search-price-check', '--task', 'sample', '--search', 'mouse'])).value.error.code, 'INVALID_ARGUMENTS');
});

test('actual CLI rejects invalid bounds, sorting and ambiguous argument forms without browser construction', async t => {
  const f = await fixture(t);
  for (const extra of [['--sort', 'sales'], ['--sort', 'price'], ['--min-price', '-1'], ['--min-price', '1e2'],
    ['--max-price', '12.345'], ['--min-price', 'NaN'], ['--min-price', '20', '--max-price', '10'], ['--min-price', '']]) {
    const result = await f.invoke(['search-price-plan', '--search', 'mouse', ...extra]);
    assert.equal(result.code, 2); assert.equal(result.value.ok, false);
    assert.notEqual(result.value.error.code, 'INVALID_ENDPOINT'); assert.notEqual(result.value.error.code, 'INTERNAL_ERROR');
    const check = await f.invoke(['search-price-check', '--task', 'missing', ...extra]);
    assert.equal(check.code, 2); assert.equal(check.value.error.code, 'INVALID_ARGUMENTS');
  }
  for (const args of [['search-price-plan'], ['search-price-plan', '--search', 'mouse'], ['search-price-plan', '--search'],
    ['search-price-check'], ['search-price-check', '--task', '../escape'], ['search-price-plan', '--search', 'mouse', 'extra']]) {
    const result = await f.invoke(args);
    assert.equal(result.code, 2); assert.equal(result.value.ok, false);
    assert.notEqual(result.value.error.code, 'INVALID_ENDPOINT');
  }
});

test('cached price check keeps source ranking even when requested direction contradicts the sample', async t => {
  const f = await savedSearch(t), filename = path.join(f.stateDirectory, 'tasks', 'sample.json');
  const before = await readFile(filename);
  const result = await f.invoke(['search-price-check', '--task', 'sample', '--sort', 'price-desc']);
  assert.equal(result.code, 0); assert.equal(result.value.ok, true);
  assert.equal(result.value.order_check.status, 'contradicted_sample');
  assert.equal(result.value.range_check.status, 'not_requested');
  assert.deepEqual(result.value.records.map(record => record.product_id), ['100', '101']);
  assert.deepEqual(await readFile(filename), before);
});

test('pending or malformed saved searches fail through the original checkpoint boundary without IO', async t => {
  const pending = await fixture(t);
  await createTask({ stateDirectory: pending.stateDirectory, task: 'pending', search: 'Synthetic mouse', tabId: 41,
    bridge: { endpoint: 'http://127.0.0.1:19999', protocol: 'playwright-extension' } });
  const result = await pending.invoke(['search-price-check', '--task', 'pending', '--min-price', '1']);
  assert.equal(result.code, 2); assert.equal(result.value.error.code, 'CACHE_NOT_COMPLETE');
  const complete = await savedSearch(t), filename = path.join(complete.stateDirectory, 'tasks', 'sample.json');
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  saved.operations[0].result.coverage.sort_verified = true;
  await writeFile(filename, JSON.stringify(saved));
  const bad = await complete.invoke(['search-price-check', '--task', 'sample', '--sort', 'price-asc']);
  assert.equal(bad.code, 2); assert.equal(bad.value.error.code, 'INVALID_CHECKPOINT');
});

test('actual CLI checks a completed cached search with HTTP HTTPS fetch disabled and preserves bytes', async t => {
  const f = await savedSearch(t), filename = path.join(f.stateDirectory, 'tasks', 'sample.json');
  const before = await readFile(filename);
  const files = await readdir(f.stateDirectory, { recursive: true });
  const result = await f.invoke(['search-price-check', '--task', 'sample', '--sort', 'price-asc', '--min-price', '10', '--max-price', '12.50']);
  assert.equal(result.code, 0); assert.equal(result.value.ok, true);
  assert.equal(result.value.command, 'search-price-check');
  assert.equal(result.value.status, 'cached_prices_checked');
  assert.equal(result.value.order_check.status, 'matched_sample');
  assert.equal(result.value.range_check.status, 'matched_sample');
  assert.equal(result.value.records.length, 2);
  assert.equal(result.value.platform_applied, false); assert.equal(result.value.platform_sort_verified, false);
  assert.equal(result.value.platform_filter_verified, false); assert.equal(result.value.browser_accessed, false);
  assert.deepEqual(await readFile(filename), before);
  assert.deepEqual(await readdir(f.stateDirectory, { recursive: true }), files);
});

test('cached check missing sources and unsupported task kinds fail locally', async t => {
  const f = await fixture(t);
  const missing = await f.invoke(['search-price-check', '--task', 'missing', '--min-price', '1']);
  assert.equal(missing.code, 2); assert.equal(missing.value.error.code, 'TASK_MISSING');
  await createTask({ stateDirectory: f.stateDirectory, task: 'cart', cart: true, tabId: 41,
    bridge: { endpoint: 'http://127.0.0.1:19999', protocol: 'playwright-extension' } });
  const unsupported = await f.invoke(['search-price-check', '--task', 'cart', '--min-price', '1']);
  assert.equal(unsupported.code, 2); assert.equal(unsupported.value.ok, false);
  assert.equal(unsupported.value.error.code, 'UNSUPPORTED_CAPABILITY');
  await mkdir(path.join(f.root, 'empty'), { recursive: true });
  const explicitMissing = await f.invoke(['search-price-check', '--task', 'sample', '--state-dir', path.join(f.root, 'empty'), '--max-price', '10']);
  assert.equal(explicitMissing.value.error.code, 'TASK_MISSING');
});

test('task-start keeps sales sorting and saves explicit price requests as their own bounded kind', async t => {
  const f = await fixture(t);
  const common = ['--search', 'Synthetic mouse', '--tab', '41', '--endpoint', 'http://127.0.0.1:19999'];
  const sales = await f.invoke(['task-start', '--task', 'legacy', ...common, '--sort', 'sales']);
  assert.equal(sales.code, 0); assert.equal(sales.value.task_kind, 'search_sort');
  // A price sort may now continue onto pages 2-5; sales sorting still reads only its single switch.
  for (const extra of [['--sort', 'price-asc', '--pages', '6'], ['--sort', 'sales', '--pages', '2'], ['--sort', 'price-up'], ['--min-price', '60', '--max-price', '10'],
    ['--min-price', '1e2'], ['--max-price', '-1'], ['--inspect-price', '--max-price', '9']]) {
    const result = await f.invoke(['task-start', '--task', 'rejected', ...common, ...extra]);
    assert.equal(result.code, 2); assert.equal(result.value.error.code, 'INVALID_ARGUMENTS', extra.join(' '));
  }
  // Local-only commands work even though this fixture's SHOPPING_BRIDGE_ENDPOINT is deliberately invalid.
  const ended = await f.invoke(['task-end', '--task', 'legacy']);
  assert.equal(ended.code, 0); assert.equal(ended.value.status, 'ended');
  const browserCommand = await f.invoke(['task-run', '--task', 'legacy']);
  assert.equal(browserCommand.code, 2); assert.equal(browserCommand.value.error.code, 'INVALID_ENDPOINT');
  const price = await f.invoke(['task-start', '--task', 'price', ...common, '--sort', 'price-desc', '--min-price', '40', '--max-price', '60.5']);
  assert.equal(price.code, 0); assert.equal(price.value.task_kind, 'search_price');
  const status = await f.invoke(['task-status', '--task', 'price']);
  assert.equal(status.code, 2, 'a pending task reports ok:false but is still delivered');
  assert.deepEqual(status.value.operations[0].requested_price, { schema_version: 1, platform: 'taobao', query: 'Synthetic mouse', price_sort: 'price-desc',
    price_range: { currency: 'CNY', minimum: { amount: '40.00', cents: 4000 }, maximum: { amount: '60.50', cents: 6050 }, inclusive: true } });
  assert.equal(status.value.operations[0].actions_reserved, 0);
});
