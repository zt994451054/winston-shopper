import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BrowserBridge } from '../lib/bridge.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawProduct } from '../test-support/product-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

async function fixture(t, { loseAcknowledgement = false } = {}) {
  let selected = '黑色';
  let resolveClicked;
  const clicked = new Promise(resolve => { resolveClicked = resolve; });
  let clicks = 0;
  const choice = { group: '颜色分类', option: '白色' };
  const bridge = await mockBridge(t, { handler({ req, res, body }) {
    const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/status') return send(playwrightStatus());
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: [{ id: 41, url: 'https://detail.tmall.com/item.htm?id=123' }] } });
    if (body.script.endsWith(`, ${JSON.stringify(choice)})`)) {
      clicks += 1; selected = '白色';
      if (loseAcknowledgement) req.socket.destroy();
      else send({ id: body.id, success: true, data: { result: { state: 'selection_dispatched', ...choice, clicked: true } } });
      resolveClicked();
      return;
    }
    const raw = rawProduct();
    raw.groups[0].options.forEach(option => { option.selected = option.label === selected ? true : null; option.disabled = null; });
    raw.prices = [{ raw: '合成价格', label: '活动价', amount_text: selected === '白色' ? '20' : '10', qualifier: '' }];
    send({ id: body.id, success: true, data: { result: raw } });
  } });
  const root = await mkdtemp(path.join(os.tmpdir(), 'selection bridge '));
  t.after(() => rm(root, { force: true, recursive: true }));
  await saveBinding(root, 'mouse', { schema_version: 1, platform: 'taobao', target: parseProductUrl('https://detail.tmall.com/item.htm?id=123'), endpoint: bridge.endpoint, tab_id: 41, created_at: new Date().toISOString() });
  const plan = path.join(root, 'plan.json');
  await writeFile(plan, JSON.stringify({ schema_version: 1, items: [{ binding: 'mouse', selection: [choice] }] }));
  const options = { stateDirectory: root, task: 'selected', bridge: new BrowserBridge(bridge.endpoint), plan };
  await createTask(options);
  let time = Date.now();
  const clock = { now: () => time, wait: async ms => { time += ms; } };
  return { options, clock, clicked, clickCount: () => clicks, endpoint: bridge.endpoint, root };
}

test('lost bridge acknowledgement after an actual dispatched option does not cause a second command', async t => {
  const f = await fixture(t, { loseAcknowledgement: true });
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete');
  assert.equal(result.operations[0].result.selection_evidence.status, 'confirmed');
  assert.equal(f.clickCount(), 1);
  assert.equal(result.automatic_retries, 0);
});

test('killing the CLI after dispatch recovers from the journal and does not repeat the click', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const script = new URL('../scripts/shopping.mjs', import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(script), 'task-run', '--task', 'selected', '--state-dir', f.root, '--endpoint', f.endpoint], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([f.clicked, once(child, 'exit').then(() => { throw new Error('CLI exited before dispatch'); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const result = await runTask(f.options, f.clock);
  assert.equal(result.status, 'complete');
  assert.equal(result.operations[0].attempts, 2);
  assert.equal(result.automatic_retries, 1);
  assert.equal(result.operations[0].result.selection_evidence.status, 'confirmed');
  assert.equal(f.clickCount(), 1);
});
