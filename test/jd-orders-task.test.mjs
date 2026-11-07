import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { readThrottleObservations } from '../lib/throttle-log.mjs';
import { jdOrdersScript } from '../lib/jd/orders.mjs';
import { mockBridge } from '../test-support/mock-bridge.mjs';
import { jdOrdersPage } from '../test-support/jd-orders-fixture.mjs';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd orders '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// The fixture also hides page words such as 金额 and 状态, which the report's own headings use; only page-specific texts are checked.
function absent(text, secrets) {
  for (const secret of secrets.filter(value => /合成|synthetic|在线支付|申请售后|立即购买|查看发票/.test(value))) {
    assert.equal(text.includes(secret), false, `${secret} must not be exported`);
  }
}

const ORDER_LIST = 'https://order.jd.com/center/list.action';

test('a JD order list task runs on the JD ledger, saves the loaded cards, reports the list address and exports Markdown and CSV', async t => {
  const page = jdOrdersPage();
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 89, url: ORDER_LIST }, { id: 41, url: 'https://s.taobao.com/search?q=mouse&page=1&tab=all' }];
  state.metadata = page.evaluate(jdOrdersScript(page.target));
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const [extra, code] of [
    [['--orders'], 'INVALID_ARGUMENTS'],
    [['--orders', '--tab', '89', '--cart'], 'INVALID_ARGUMENTS'],
    [['--orders', '--tab', '89', '--search', 'mouse'], 'INVALID_ARGUMENTS'],
    [['--orders', '--tab', '89', '--bindings', 'jd-mouse'], 'INVALID_ARGUMENTS'],
    [['--orders', '--tab', '89', '--details'], 'INVALID_ARGUMENTS'],
    [['--orders', '--tab', '89', '--pages', '2'], 'UNSUPPORTED_PLATFORM'],
    [['--orders', '--tab', '89', '--order-rows', '5'], 'UNSUPPORTED_PLATFORM'],
  ]) {
    assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, code, extra.join(' '));
  }
  const created = await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-orders', '--orders', '--tab', '89']);
  assert.deepEqual([created.code, created.value.task_kind, created.value.platform, created.value.products], [0, 'jd_orders', 'jd', 0]);
  const ran = await run(['task-run', ...common, '--task', 'jd-orders']);
  assert.deepEqual([ran.code, ran.value.status, ran.value.operations[0].order_list_url, ran.value.distinct_products], [0, 'complete', ORDER_LIST, null]);
  const result = ran.value.operations[0].result;
  assert.deepEqual([result.groups_seen, result.orders_seen, result.orders_returned, result.items_seen, result.split_notices.length],
    [4, 4, 4, 5, 1]);
  assert.deepEqual(result.orders.map(order => [order.group_position, order.split_order]), [[1, false], [2, false], [3, true], [4, true]]);
  assert.deepEqual(state.commands.filter(command => command.action === 'eval').map(command => command.script.includes('collectJdOrders')), [true]);
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false, 'the JD read uses the JD ledger');
  assert.ok(existsSync(path.join(directory, 'pacing-jd.json')));
  const status = await run(['task-status', '--state-dir', directory, '--task', 'jd-orders']);
  assert.deepEqual(status.value.operations[0].result, result);

  const markdown = path.join(directory, '..', `jd-orders-${path.basename(directory)}.md`);
  const csv = path.join(directory, '..', `jd-orders-${path.basename(directory)}.csv`);
  t.after(() => Promise.all([rm(markdown, { force: true }), rm(csv, { force: true })]));
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-orders', '--format', 'markdown', '--output', markdown])).code, 0);
  assert.equal((await run(['report-export', '--state-dir', directory, '--task', 'jd-orders', '--format', 'csv', '--output', csv])).code, 0);
  const rows = await readFile(csv, 'utf8');
  for (const pattern of [/"order_list_view",[^\n]*"time_range","近3个月订单"/, /"order_list_view",[^\n]*"status_filter","全部"/,
    /"order_scan",[^\n]*"items_seen","5"/, /"order_split_notice",[^\n]*info=2026-08-15 08:00:00 \/ null \/ 合成原单说明丙; detail_entry=true/,
    /"order",[^\n]*"'123456789012"[^\n]*split_order=false; detail_entry=true; items_seen=2; items_returned=2/,
    /"order_price",[^\n]*"¥127.21"[^\n]*notes=获得了7京豆/, /"order_price",[^\n]*"¥0.00"/,
    /"order_item",[^\n]*"'10086002","合成鼠标垫 大号","https:\/\/item.jd.com\/10086002.html"/,
    /"coverage",[^\n]*"scope","loaded_orders_only"/, /"coverage",[^\n]*"full_order_history","false"/,
    /"missing_field",[^\n]*"orders_outside_time_range"/]) {
    assert.match(rows, pattern);
  }
  const text = await readFile(markdown, 'utf8');
  assert.match(text, /jd\\_orders/);
  absent(rows, page.secrets);
  absent(text, page.secrets);

  const file = path.join(directory, 'tasks', 'jd-orders.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.operations[0].result.orders[0].items[0].url = 'https://item.jd.com/1.html';
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await run(['task-status', '--state-dir', directory, '--task', 'jd-orders'])).value.error.code, 'INVALID_CHECKPOINT');
});

test('a JD order list limit pauses the task, records the orders page kind and holds only JD tasks', async t => {
  const { endpoint, state } = await mockBridge(t);
  state.tabs = [{ id: 89, url: ORDER_LIST }, { id: 41, url: 'https://s.taobao.com/search?q=mouse&page=1&tab=all' }];
  state.metadata = { state: 'rate_limited' };
  const directory = await stateDirectory(t);
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-orders', '--orders', '--tab', '89']);
  const paused = await run(['task-run', ...common, '--task', 'jd-orders']);
  assert.deepEqual([paused.value.status, paused.value.operations[0].error.code], ['waiting_cooldown', 'RATE_LIMITED']);
  const log = await readThrottleObservations(directory);
  assert.deepEqual(log.observations.map(entry => [entry.platform, entry.signal, entry.page_kind]), [['jd', 'rate_limited', 'orders']]);
  assert.equal((await run(['task-start', '--platform', 'jd', ...common, '--task', 'jd-second', '--orders', '--tab', '89'])).value.error.code, 'PLATFORM_TASK_UNFINISHED');
  const taobao = await run(['task-start', ...common, '--task', 'taobao-search', '--search', 'mouse', '--tab', '41']);
  assert.deepEqual([taobao.code, taobao.value.task_kind], [0, 'search'], 'the paused JD order task does not hold Taobao');
});
