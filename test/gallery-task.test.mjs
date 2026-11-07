import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawDetails } from '../test-support/detail-fixture.mjs';
import { validateGallery } from '../lib/gallery.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { main } from '../lib/cli.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const raw = () => ({ state: 'observed', product_id: target.product_id, url: target.url,
  observed_at: '2026-09-28T01:00:00.000Z', gallery: rawDetails().details.gallery });
const fail = code => { throw new ShoppingError(code, 'Synthetic gallery failure'); };

async function fixture(t, read) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping gallery '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now(), reads = 0;
  const waits = [];
  const bridge = { endpoint: 'http://127.0.0.1:19824',
    async readGallery() {
      reads++;
      const stored = JSON.parse(await readFile(path.join(directory, 'tasks/gallery.json')));
      assert.equal(stored.operations[0].attempts, reads);
      return read ? read(reads) : validateGallery(raw(), target);
    },
    async readDetails() { throw new Error('Gallery tasks must not read details'); },
    async selectMainImage() { throw new Error('Gallery tasks must not select images'); } };
  await saveBinding(directory, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint,
    tab_id: 41, target, created_at: new Date(now).toISOString() });
  const options = { stateDirectory: directory, task: 'gallery', bindings: ['sample'], gallery: true, bridge };
  const clock = { now: () => now, wait: async ms => { waits.push(ms); now += ms; } };
  return { directory, options, clock, waits, reads: () => reads,
    filename: path.join(directory, 'tasks/gallery.json') };
}

test('gallery task persists one read, returns only gallery fields and reuses completed bytes', async t => {
  const f = await fixture(t);
  assert.equal((await createTask(f.options)).task_kind, 'product_gallery');
  assert.equal(f.reads(), 0);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  assert.equal(report.operations[0].attempts, 1);
  assert.equal(report.operations[0].result.gallery.items.length, 2);
  assert.equal(report.operations[0].result.details, undefined);
  const before = await readFile(f.filename, 'utf8');
  assert.deepEqual(await runTask(f.options, f.clock), await taskStatus(f.options));
  assert.equal(f.reads(), 1);
  assert.equal(await readFile(f.filename, 'utf8'), before);
});

test('gallery tasks enforce one binding and reject all other reading and action modes before IO', async t => {
  const f = await fixture(t);
  for (const mode of [{ details: true }, { services: true }, { reviews: true }, { reviewCategories: 'unused.json' },
    { mainImages: 'unused.json' }, { plan: 'unused.json' }, { search: 'mouse', tabId: 41 }]) {
    await assert.rejects(createTask({ ...f.options, ...mode }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(createTask({ ...f.options, bindings: ['sample', 'sample'] }), { code: 'INVALID_BINDINGS' });
  assert.equal(f.reads(), 0);
});

test('gallery retries retain the existing wait limits and exhausted reads remain cached failures', async t => {
  const f = await fixture(t, () => fail('PAGE_LOADING'));
  await createTask(f.options);
  const stopped = await runTask(f.options, f.clock);
  assert.equal(stopped.status, 'partial');
  assert.equal(stopped.operations[0].attempts, 3);
  assert.equal(stopped.automatic_retries, 2);
  assert.equal(stopped.wait_reserved_ms, 20000);
  assert.deepEqual(f.waits, [5000, 15000]);
  await runTask(f.options, f.clock);
  assert.equal(f.reads(), 3);
});

test('a stopped gallery task prevents a replacement task from refreshing the platform budget', async t => {
  const f = await fixture(t, () => fail('PAGE_STRUCTURE_CHANGED'));
  await createTask(f.options);
  assert.equal((await runTask(f.options, f.clock)).status, 'stopped');
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }));
  assert.equal(f.reads(), 1);
});

test('gallery verification pauses without automatic retry and only explicit recovery continues', async t => {
  const f = await fixture(t, index => index === 1 ? fail('VERIFICATION_REQUIRED') : validateGallery(raw(), target));
  await createTask(f.options);
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user');
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.reads(), 1);
  const complete = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.operations[0].attempts, 2);
});

test('forged gallery coverage is rejected before any cached task IO', async t => {
  const f = await fixture(t); await createTask(f.options); await runTask(f.options, f.clock);
  const stored = JSON.parse(await readFile(f.filename));
  stored.operations[0].result.coverage.current_main_image_read = true;
  await writeFile(f.filename, JSON.stringify(stored));
  await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  assert.equal(f.reads(), 1);
});

test('CLI gallery mode reaches the fixed bridge reader and cache without reading unrelated regions', async t => {
  const f = await fixture(t);
  const server = await mockBridge(t, { handler({ req, res, body, state }) {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    res.end(JSON.stringify({ id: body.id, success: true,
      data: body.action === 'tab_list' ? { tabs: state.tabs } : { result: raw() } }));
  } });
  await saveBinding(f.directory, 'sample', { schema_version: 1, platform: 'taobao', endpoint: server.endpoint,
    tab_id: 41, target, created_at: new Date().toISOString() }, { replace: true });
  const run = async args => {
    let output = '';
    const code = await main(args, { write: text => { output += text; } });
    return { code, value: JSON.parse(output) };
  };
  const common = ['--task', 'gallery', '--state-dir', f.directory, '--endpoint', server.endpoint];
  assert.equal((await run(['task-start', ...common, '--bindings', 'sample', '--gallery', '--details'])).value.error.code, 'INVALID_ARGUMENTS');
  assert.equal((await run(['task-start', ...common, '--bindings', 'sample', '--gallery'])).value.task_kind, 'product_gallery');
  assert.equal(server.state.commands.length, 0);
  const complete = await run(['task-run', ...common]);
  assert.equal(complete.code, 0);
  assert.equal(complete.value.operations[0].result.gallery.items.length, 2);
  assert.deepEqual(server.state.commands.map(command => command.action), ['tab_list', 'eval']);
  const script = server.state.commands[1].script;
  assert.match(script, /thumbnailPic/);
  assert.doesNotMatch(script, /\.click\(|elementsFromPoint|priceText|ItemTitle|imageTextInfo/);
  await run(['task-run', ...common]);
  assert.equal(server.state.commands.length, 2);
});
