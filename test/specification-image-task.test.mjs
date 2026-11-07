import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask as createCurrentTask, runTask, taskStatus } from '../lib/tasks.mjs';
import { newSpecificationImageBatches } from '../lib/specification-image-batches.mjs';
import { saveBinding } from '../lib/state.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawSpecificationImages as raw } from '../test-support/specification-image-fixture.mjs';
import { validateSpecificationImages } from '../lib/specification-images.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { main } from '../lib/cli.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const fail = code => { throw new ShoppingError(code, 'Synthetic specification image failure'); };

async function createTask(options) {
  const result = await createCurrentTask(options);
  const file = path.join(options.stateDirectory, 'tasks', `${options.task}.json`);
  const legacy = JSON.parse(await readFile(file));
  delete legacy.operations[0].specification_collection;
  legacy.operations[0].specification_image_batches = newSpecificationImageBatches();
  await writeFile(file, JSON.stringify(legacy));
  return result;
}

async function fixture(t, read) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping specification image '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now(), reads = 0;
  const waits = [];
  const bridge = { endpoint: 'http://127.0.0.1:19824',
    async readSpecificationImages() {
      reads++;
      const stored = JSON.parse(await readFile(path.join(directory, 'tasks/option-images.json')));
      assert.equal(stored.operations[0].attempts, reads);
      return read ? read(reads) : validateSpecificationImages(raw(), target);
    },
    async readDetails() { throw new Error('Specification image tasks must not read details'); },
    async selectMainImage() { throw new Error('Specification image tasks must not select images'); } };
  await saveBinding(directory, 'sample', { schema_version: 1, platform: 'taobao', endpoint: bridge.endpoint,
    tab_id: 41, target, created_at: new Date(now).toISOString() });
  const options = { stateDirectory: directory, task: 'option-images', bindings: ['sample'], specificationImages: true, bridge };
  const clock = { now: () => now, wait: async ms => { waits.push(ms); now += ms; } };
  return { directory, options, clock, waits, reads: () => reads,
    filename: path.join(directory, 'tasks/option-images.json') };
}

test('specification image task persists one read, returns only specification image fields and reuses completed bytes', async t => {
  const f = await fixture(t);
  assert.equal((await createTask(f.options)).task_kind, 'product_specification_images');
  assert.equal(f.reads(), 0);
  const report = await runTask(f.options, f.clock);
  assert.equal(report.status, 'complete');
  assert.equal(report.operations[0].attempts, 1);
  assert.equal(report.operations[0].result.batches[0].groups[0].options.length, 2);
  assert.equal(report.operations[0].result.details, undefined);
  const before = await readFile(f.filename, 'utf8');
  assert.deepEqual(await runTask(f.options, f.clock), await taskStatus(f.options));
  assert.equal(f.reads(), 1);
  assert.equal(await readFile(f.filename, 'utf8'), before);
});

test('specification image tasks enforce one binding and reject all other reading and action modes before IO', async t => {
  const f = await fixture(t);
  for (const mode of [{ gallery: true }, { details: true }, { services: true }, { reviews: true }, { reviewCategories: 'unused.json' },
    { mainImages: 'unused.json' }, { plan: 'unused.json' }, { search: 'mouse', tabId: 41 }]) {
    await assert.rejects(createTask({ ...f.options, ...mode }), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(createTask({ ...f.options, bindings: ['sample', 'sample'] }), { code: 'INVALID_BINDINGS' });
  assert.equal(f.reads(), 0);
});

test('specification image retries retain the existing wait limits and exhausted reads remain cached failures', async t => {
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

test('a stopped specification image task prevents a replacement task from refreshing the platform budget', async t => {
  const f = await fixture(t, () => fail('PAGE_STRUCTURE_CHANGED'));
  await createTask(f.options);
  assert.equal((await runTask(f.options, f.clock)).status, 'stopped');
  await assert.rejects(createTask({ ...f.options, task: 'replacement' }));
  assert.equal(f.reads(), 1);
});

test('specification image verification pauses without automatic retry and only explicit recovery continues', async t => {
  const f = await fixture(t, index => index === 1 ? fail('VERIFICATION_REQUIRED') : validateSpecificationImages(raw(), target));
  await createTask(f.options);
  assert.equal((await runTask(f.options, f.clock)).status, 'waiting_user');
  await assert.rejects(runTask(f.options, f.clock), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.reads(), 1);
  const complete = await runTask({ ...f.options, recovery: 'user' }, f.clock);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.operations[0].attempts, 2);
});

test('forged specification image coverage is rejected before any cached task IO', async t => {
  const f = await fixture(t); await createTask(f.options); await runTask(f.options, f.clock);
  const stored = JSON.parse(await readFile(f.filename));
  stored.operations[0].result.coverage.current_main_image_read = true;
  await writeFile(f.filename, JSON.stringify(stored));
  await assert.rejects(runTask(f.options, f.clock), { code: 'INVALID_CHECKPOINT' });
  assert.equal(f.reads(), 1);
});

test('CLI specification image mode reaches the fixed bridge reader and cache without reading unrelated regions', async t => {
  const f = await fixture(t);
  const server = await mockBridge(t, { handler({ req, res, body, state }) {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    const legacy = raw();
    const result = { state: 'observed', product_id: legacy.product_id, url: legacy.url, observed_at: legacy.observed_at,
      inventory: { groups_seen: legacy.groups_seen, groups: legacy.groups.map((group, index) => ({ position: index + 1,
        name: group.name, options_seen: group.options_seen, options: Array.from({ length: group.options_seen }, (_, index) => {
          const option = group.options.find(option => option.position === index + 1);
          return { position: index + 1, label: option?.label ?? `文字选项${index + 1}`, image_regions_seen: option?.image_regions_seen ?? 0 };
        }) })) },
      samples: body.script?.includes('\"inventory_only\":true') ? [] : legacy.groups.flatMap((group, index) => group.options.map(option => ({ group_position: index + 1, ...option }))) };
    res.end(JSON.stringify({ id: body.id, success: true,
      data: body.action === 'tab_list' ? { tabs: state.tabs } : { result } }));
  } });
  await saveBinding(f.directory, 'sample', { schema_version: 1, platform: 'taobao', endpoint: server.endpoint,
    tab_id: 41, target, created_at: new Date().toISOString() }, { replace: true });
  const run = async args => {
    let output = '';
    const code = await main(args, { write: text => { output += text; } });
    return { code, value: JSON.parse(output) };
  };
  const common = ['--task', 'option-images', '--state-dir', f.directory, '--endpoint', server.endpoint];
  assert.equal((await run(['task-start', ...common, '--bindings', 'sample', '--specification-images', '--details'])).value.error.code, 'INVALID_ARGUMENTS');
  assert.equal((await run(['task-start', ...common, '--bindings', 'sample', '--specification-images'])).value.task_kind, 'product_specification_images');
  assert.equal(server.state.commands.length, 0);
  const complete = await run(['task-run', ...common]);
  assert.equal(complete.code, 0);
  assert.equal(complete.value.operations[0].result.options.length, 5);
  assert.equal(complete.value.operations[0].result.coverage.loaded_image_links, 2);
  assert.deepEqual(server.state.commands.map(command => command.action), ['tab_list', 'eval', 'tab_list', 'eval']);
  const script = server.state.commands[1].script;
  assert.match(script, /valueItemImgWrap/);
  assert.doesNotMatch(script, /\.click\(|elementsFromPoint|priceText|ItemTitle|imageTextInfo|thumbnailPic/);
  await run(['task-run', ...common]);
  assert.equal(server.state.commands.length, 4);
});
