import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { main } from '../lib/cli.mjs';
import { exportReport } from '../lib/report-export.mjs';
import { createTask, runTask } from '../lib/tasks.mjs';
import { validateCartRows } from '../lib/cart-rows.mjs';
import { parseCartUrl } from '../lib/cart-target.mjs';
import { cartRow, observeCart } from '../test-support/cart-fixture.mjs';

async function fixture(t, complete = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'shopping reports ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  const outputDirectory = path.join(root, 'reports');
  await mkdir(outputDirectory);
  const target = parseCartUrl('https://cart.taobao.com/cart.htm');
  const result = validateCartRows(observeCart([cartRow(1).row]), target);
  const bridge = { endpoint: 'http://127.0.0.1:19824', async requireConnected() {},
    async listTabs() { return [{ id: 41, url: target.url }]; }, async readCartRows() { return result; } };
  await createTask({ stateDirectory, task: 'sample', cart: true, tabId: 41, bridge });
  if (complete) await runTask({ stateDirectory, task: 'sample', bridge });
  const source = path.join(stateDirectory, 'tasks/sample.json');
  const before = await readFile(source);
  return { root, stateDirectory, outputDirectory, source, before, bridge,
    options: { stateDirectory, task: 'sample', format: 'markdown', output: path.join(outputDirectory, 'report.md') } };
}

async function cli(args) {
  let output = '';
  const code = await main(args, { write: value => { output += value; } });
  return { code, value: JSON.parse(output), output };
}

test('exports a private report from a validated cache without altering any source bytes', async t => {
  const f = await fixture(t);
  const result = await exportReport(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'report_exported');
  assert.equal(result.task, 'sample');
  assert.equal(result.format, 'markdown');
  assert.equal(result.output, f.options.output);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.bytes > 0);
  assert.equal((await stat(f.options.output)).mode & 0o777, 0o600);
  assert.match(await readFile(f.options.output, 'utf8'), /sample/);
  assert.deepEqual(await readFile(f.source), f.before);
  assert.deepEqual(await readdir(f.outputDirectory), ['report.md']);
});

test('an unfinished task produces an explicitly unfinished cached report without executing it', async t => {
  const f = await fixture(t, false);
  await exportReport(f.options);
  assert.match(await readFile(f.options.output, 'utf8'), /pending/);
  assert.deepEqual(await readFile(f.source), f.before);
});

test('rejects existing files, directories and symlinks without changing them or leaving temporary files', async t => {
  const f = await fixture(t);
  const existing = path.join(f.outputDirectory, 'existing');
  await writeFile(existing, 'PRIVATE existing bytes');
  await mkdir(path.join(f.outputDirectory, 'directory'));
  await symlink(existing, path.join(f.outputDirectory, 'link'));
  for (const name of ['existing', 'directory', 'link']) {
    await assert.rejects(exportReport({ ...f.options, output: path.join(f.outputDirectory, name) }), { code: 'REPORT_OUTPUT_EXISTS' });
  }
  assert.equal(await readFile(existing, 'utf8'), 'PRIVATE existing bytes');
  assert.deepEqual((await readdir(f.outputDirectory)).sort(), ['directory', 'existing', 'link']);
});

test('protects the state root through lexical paths, symlink aliases and symlinked parent directories', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'state-alias');
  const parentAlias = path.join(f.outputDirectory, 'source-parent');
  await symlink(f.stateDirectory, alias);
  await symlink(path.dirname(f.source), parentAlias);
  for (const output of [path.join(f.stateDirectory, 'new.md'), f.source,
    path.join(alias, 'new.md'), path.join(parentAlias, 'new.md')]) {
    await assert.rejects(exportReport({ ...f.options, output }), { code: 'REPORT_OUTPUT_PROTECTED' });
  }
  assert.deepEqual(await readFile(f.source), f.before);
  assert.deepEqual(await readdir(f.stateDirectory), ['tasks']);
});

test('a similarly named sibling output directory is allowed and parent aliases are resolved safely', async t => {
  const f = await fixture(t);
  const sibling = `${f.stateDirectory}-reports`;
  await mkdir(sibling);
  const alias = path.join(f.root, 'output-alias');
  await symlink(sibling, alias);
  const result = await exportReport({ ...f.options, output: path.join(alias, 'report.md') });
  assert.equal(result.output, path.join(sibling, 'report.md'));
  assert.deepEqual(await readFile(f.source), f.before);
});

test('simultaneous exports publish one complete report and preserve the winning file', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([exportReport(f.options), exportReport(f.options)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'REPORT_OUTPUT_EXISTS');
  assert.equal((await stat(f.options.output)).size, results.find(value => value.status === 'fulfilled').value.bytes);
  assert.deepEqual(await readdir(f.outputDirectory), ['report.md']);
  assert.deepEqual(await readFile(f.source), f.before);
});

test('format, destination and missing parent errors are explicit and do not expose input contents', async t => {
  const f = await fixture(t);
  for (const format of ['html', undefined, '', 'PRIVATE format']) {
    await assert.rejects(exportReport({ ...f.options, format }), { code: 'INVALID_REPORT_FORMAT' });
  }
  for (const output of [undefined, '', 1]) {
    await assert.rejects(exportReport({ ...f.options, output }), { code: 'INVALID_REPORT_OUTPUT' });
  }
  await assert.rejects(exportReport({ ...f.options, output: path.join(f.root, 'missing/report.md') }), { code: 'INVALID_REPORT_OUTPUT' });
  const parentFile = path.join(f.root, 'parent-file');
  await writeFile(parentFile, 'PRIVATE parent file');
  await assert.rejects(exportReport({ ...f.options, output: path.join(parentFile, 'report.md') }), { code: 'INVALID_REPORT_OUTPUT' });
  await assert.rejects(exportReport({ ...f.options, stateDirectory: '' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(exportReport({ ...f.options, output: 'a\0b' }), { code: 'INVALID_REPORT_OUTPUT' });
  assert.deepEqual(await readdir(f.outputDirectory), []);
});

test('filesystem write refusal returns a clear error and leaves source and output directories intact', async t => {
  if (process.getuid?.() === 0) return t.skip('Directory permissions cannot refuse a superuser write.');
  const f = await fixture(t);
  await chmod(f.outputDirectory, 0o500);
  try {
    await assert.rejects(exportReport(f.options), { code: 'REPORT_WRITE_FAILED' });
    assert.deepEqual(await readdir(f.outputDirectory), []);
    assert.deepEqual(await readFile(f.source), f.before);
  } finally {
    await chmod(f.outputDirectory, 0o700);
  }
});

test('invalid or missing source checkpoints fail before creating any report', async t => {
  const f = await fixture(t);
  await assert.rejects(exportReport({ ...f.options, task: 'missing' }), { code: 'TASK_MISSING' });
  await writeFile(f.source, 'PRIVATE malformed checkpoint');
  await assert.rejects(exportReport(f.options), { code: 'INVALID_CHECKPOINT' });
  assert.deepEqual(await readdir(f.outputDirectory), []);
});

test('unsupported cached task kinds fail explicitly without executing or changing their checkpoints', async t => {
  const f = await fixture(t);
  await createTask({ stateDirectory: f.stateDirectory, task: 'controls', search: 'mouse', inspectControls: true, tabId: 41, bridge: f.bridge });
  const source = path.join(f.stateDirectory, 'tasks/controls.json');
  const before = await readFile(source);
  await assert.rejects(exportReport({ ...f.options, task: 'controls' }), { code: 'UNSUPPORTED_REPORT_KIND' });
  assert.deepEqual(await readFile(source), before);
  assert.deepEqual(await readdir(f.outputDirectory), []);
});

test('the CLI rejects browser options and validates required report arguments', async t => {
  const f = await fixture(t);
  const args = ['report-export', '--task', 'sample', '--state-dir', f.stateDirectory];
  for (const extra of [[], ['--format', 'markdown'], ['--format', 'csv', '--output', f.options.output, '--endpoint', 'http://PRIVATE.invalid'], ['--format', 'html', '--output', f.options.output]]) {
    const result = await cli([...args, ...extra]);
    assert.equal(result.code, 2);
    assert.equal(result.value.ok, false);
    assert.ok(!result.output.includes('PRIVATE'));
  }
  assert.deepEqual(await readFile(f.source), f.before);
  assert.deepEqual(await readdir(f.outputDirectory), []);
});

test('real CLI subprocess exports CSV while every HTTP, HTTPS and fetch request is forbidden', async t => {
  const f = await fixture(t);
  const preload = path.join(f.root, 'forbid-network.mjs');
  await writeFile(preload, `import http from 'node:http';\nimport https from 'node:https';\nimport { syncBuiltinESMExports } from 'node:module';\nconst deny = () => { throw new Error('NETWORK_FORBIDDEN'); };\nhttp.request = http.get = https.request = https.get = globalThis.fetch = deny;\nsyncBuiltinESMExports();\n`);
  const output = path.join(f.outputDirectory, 'report.csv');
  const script = path.resolve('scripts/shopping.mjs');
  const child = spawn(process.execPath, ['--import', preload, script, 'report-export', '--task', 'sample',
    '--state-dir', f.stateDirectory, '--format', 'csv', '--output', output, '--json'],
  { env: { ...process.env, SHOPPING_BRIDGE_ENDPOINT: 'INVALID PRIVATE endpoint' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr || stdout);
  assert.equal(JSON.parse(stdout).status, 'report_exported');
  assert.ok(!stdout.includes('PRIVATE'));
  assert.ok((await readFile(output, 'utf8')).startsWith('\uFEFF'));
  assert.deepEqual(await readFile(f.source), f.before);
});
