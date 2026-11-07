import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { withTaskStore } from '../lib/task-store.mjs';
import { diagnoseTask } from '../lib/task-diagnostics.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { productResult } from '../test-support/product-fixture.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';

async function fixture(t, search = true) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'shopping diagnosis '));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const { endpoint, state } = await mockBridge(t);
  const bridge = new BrowserBridge(endpoint);
  const options = { task: 'sample', stateDirectory, bridge };
  if (search) await createTask({ ...options, search: 'mouse', tabId: 41 });
  else {
    await saveBinding(stateDirectory, 'sample', { schema_version: 1, platform: 'taobao', endpoint,
      tab_id: 41, target: parseProductUrl('https://detail.tmall.com/item.htm?id=123'), created_at: new Date().toISOString() });
    await createTask({ ...options, bindings: ['sample'] });
  }
  return { options, state, filename: path.join(stateDirectory, 'tasks/sample.json') };
}

test('CLI diagnostics explain target mismatches without leaking other URLs, evaluating pages or changing stopped budgets', async t => {
  const { options, state, filename } = await fixture(t);
  await withTaskStore(options.stateDirectory, options.task, async store => {
    const task = await store.load();
    task.status = 'stopped'; task.retries = 1; task.wait_reserved_ms = 5000;
    Object.assign(task.operations[0], { attempts: 2, retries: 1, error: { code: 'RESEARCH_RECOVERY_FAILED', category: 'diagnostic' } });
    task.operations[0].read_action.observations = 2;
    await store.save(task);
  });
  const before = await readFile(filename, 'utf8');
  const expected = 'https://s.taobao.com/search?q=mouse&page=1&tab=all';
  const cases = [
    [null, 'tab_not_in_current_window'],
    ['https://mail.example.test/PRIVATE_PATH?token=PRIVATE_TOKEN', 'other_site_or_browser_page'],
    ['chrome://newtab/', 'other_site_or_browser_page'],
    ['https://s.taobao.com.evil.test/search?q=PRIVATE_QUERY', 'other_site_or_browser_page'],
    ['https://login.taobao.com/member/login.jhtml?token=PRIVATE_TOKEN', 'login_page'],
    ['https://s.taobao.com/search?q=PRIVATE_QUERY&page=1', 'different_search_query'],
    [`${expected}&sort=PRIVATE_SORT`, 'unsupported_search_url'],
    [`${expected}&q=PRIVATE_QUERY`, 'unsupported_search_url'],
    ['https://www.taobao.com/', 'search_home'],
    ['https://buyertrade.taobao.com/PRIVATE_PATH?id=PRIVATE_ID', 'target_mismatch'],
    [`${expected}&spm=PRIVATE_TRACKING`, 'matching_target'],
  ];
  for (const [url, reason] of cases) {
    state.tabs = [{ id: 42, url: `${expected}&spm=PRIVATE_TRACKING` }, ...(url ? [{ id: 41, url }] : [])];
    const start = state.commands.length;
    let output = '';
    const code = await main(['task-diagnose', '--task', options.task, '--state-dir', options.stateDirectory,
      '--endpoint', options.bridge.endpoint], { write: text => { output += text; } });
    const value = JSON.parse(output);
    assert.equal(code, 0);
    assert.equal(value.task_status, 'stopped');
    assert.equal(value.inventory_scope, 'playwright_connected_pages');
    assert.equal(value.operations[0].reason, reason);
    assert.equal(value.operations[0].expected_url, expected);
    assert.deepEqual(value.operations[0].matching_tab_ids, reason === 'matching_target' ? [42, 41] : [42]);
    assert.equal(value.page_content_read, false);
    assert.equal(value.state_changed, false);
    assert.ok(!output.includes('PRIVATE'));
    assert.ok(!output.includes('mail.example') && !output.includes('evil.test'));
    assert.deepEqual(state.commands.slice(start).map(command => command.action), ['tab_list']);
    assert.equal(await readFile(filename, 'utf8'), before);
  }
  await assert.rejects(runTask({ ...options, recovery: 'connection' }), { code: 'INVALID_RECOVERY' });
  assert.equal(await readFile(filename, 'utf8'), before);
});

test('diagnostics refuse a different endpoint and a disconnected extension without consuming reads', async t => {
  const { options, state, filename } = await fixture(t);
  const before = await readFile(filename, 'utf8');
  await assert.rejects(diagnoseTask({ ...options, bridge: new BrowserBridge('http://127.0.0.1:1') }), { code: 'BINDING_ENDPOINT_MISMATCH' });
  assert.equal(state.requests.length, 0);
  state.connected = false;
  await assert.rejects(diagnoseTask(options), { code: 'EXTENSION_DISCONNECTED' });
  assert.equal(state.commands.length, 0);
  assert.equal(await readFile(filename, 'utf8'), before);
});

test('product diagnosis finds only the same canonical product and skips completed operations', async t => {
  const { options, state, filename } = await fixture(t, false);
  state.tabs = [{ id: 41, url: 'https://detail.tmall.com/item.htm?id=999' },
    { id: 42, url: 'https://detail.tmall.com/item.htm?id=123&token=PRIVATE_TOKEN' }];
  const before = await readFile(filename, 'utf8');
  const result = await diagnoseTask(options);
  assert.equal(result.operations[0].reason, 'target_mismatch');
  assert.deepEqual(result.operations[0].matching_tab_ids, [42]);
  assert.equal(await readFile(filename, 'utf8'), before);
  await runTask({ ...options, bridge: { endpoint: options.bridge.endpoint, readProduct: async () => productResult('123') } });
  const requests = state.requests.length;
  assert.deepEqual((await diagnoseTask(options)).operations, []);
  assert.equal(state.requests.length, requests);
});
