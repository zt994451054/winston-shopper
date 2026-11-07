import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { playwrightStatus, mockBridge, isAddressProbe, answerAddressProbe } from '../test-support/mock-bridge.mjs';
import { orderPageGroups, orderTarget, runOnOrderPage } from '../test-support/order-fixture.mjs';

const script = fileURLToPath(new URL('../scripts/shopping.mjs', import.meta.url));

/** A local bridge whose single tab shows a synthetic order list; a script that clicks next turns the page. */
async function orderListServer(t, total) {
  let current = 1, clicks = 0, evaluations = 0;
  const server = await mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: 43, url: orderTarget.url }] } });
    if (isAddressProbe(body)) return answerAddressProbe(body, state, send);
    evaluations++;
    const result = runOnOrderPage(body.script, orderPageGroups(current, current === total ? 4 : 30), { page: current, total });
    if (result.clicks.length) { clicks++; current++; }
    send({ id: body.id, success: true, data: { result: result.value } });
  } });
  return { server, clicks: () => clicks, evaluations: () => evaluations };
}

async function stateDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping order pages bridge '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function cli(args, preload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolve({ code, value: JSON.parse(output) }); } catch (error) { reject(new Error(`CLI produced invalid JSON: ${stderr}`, { cause: error })); }
    });
  });
}

test('the real bridge reads three synthetic order pages with two guarded clicks', async t => {
  const local = await orderListServer(t, 9);
  const bridge = new BrowserBridge(local.server.endpoint);
  let now = 10000;
  const clock = { now: () => now, wait: async ms => { now += ms; } };
  const options = { stateDirectory: await stateDirectory(t), task: 'pages', orders: true, pages: 3, tabId: 43, bridge };
  await createTask(options);
  const report = await runTask(options, clock);
  assert.equal(report.status, 'complete');
  const result = report.operations[0].result;
  assert.deepEqual(result.pages.map(page => [page.pager.current_page, page.rows.orders.length]), [[1, 30], [2, 30], [3, 30]]);
  assert.equal(result.distinct_orders, 90);
  assert.equal(local.clicks(), 2);
  assert.equal(local.evaluations(), 7);
});

// The real CLI paces every page operation (seconds between reads, longer after the page load), so this run takes a while.
test('the real CLI reads a two-page list to its end, then serves status and a report with HTTP disabled', { timeout: 180000 }, async t => {
  const local = await orderListServer(t, 2);
  const root = await stateDirectory(t);
  const args = ['--task', 'pages', '--state-dir', path.join(root, 'state')];
  const withEndpoint = ['--endpoint', local.server.endpoint];
  const created = await cli(['task-start', ...args, ...withEndpoint, '--orders', '--pages', '10', '--tab', '43']);
  assert.equal(created.code, 0); assert.equal(created.value.task_kind, 'order_pages');
  const completed = await cli(['task-run', ...args, ...withEndpoint]);
  assert.equal(completed.code, 0); assert.equal(completed.value.status, 'complete');
  const result = completed.value.operations[0].result;
  assert.equal(result.end_reason, 'last_page');
  assert.equal(result.coverage.all_listed_pages_read, true);
  assert.equal(result.returned_orders, 34);
  assert.equal(local.clicks(), 1);
  const ledger = JSON.parse(await readFile(path.join(root, 'state', 'pacing.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['page']);
  const preload = path.join(root, 'forbid-http.mjs');
  await writeFile(preload, "import http from 'node:http';\nimport https from 'node:https';\nimport {syncBuiltinESMExports} from 'node:module';\nconst deny=()=>{throw new Error('HTTP forbidden in completed cache test');};\nhttp.request=http.get=https.request=https.get=globalThis.fetch=deny;\nsyncBuiltinESMExports();\n");
  const requests = local.server.state.requests.length;
  for (const command of ['task-run', 'task-status']) {
    const cached = await cli([command, ...args, ...(command === 'task-run' ? withEndpoint : [])], preload);
    assert.equal(cached.code, 0);
    assert.deepEqual(cached.value.operations[0].result, result);
  }
  const output = path.join(root, 'report.csv');
  const exported = await cli(['report-export', ...args, '--format', 'csv', '--output', output, '--json'], preload);
  assert.equal(exported.code, 0);
  const csv = await readFile(output, 'utf8');
  assert.equal(csv.split('\n').filter(line => line.startsWith('"order_pagination",')).length, 2);
  assert.equal(local.server.state.requests.length, requests);
});
