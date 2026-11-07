import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadBinding, saveBinding } from '../lib/state.mjs';

const binding = { schema_version: 1, platform: 'taobao', endpoint: 'http://127.0.0.1:19824',
  tab_id: 41, created_at: '2026-09-15T00:00:00.000Z', target: { url: 'https://detail.tmall.com/item.htm?id=123' } };

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('simultaneous first writes have exactly one winner and no temporary files remain', async t => {
  const root = await directory(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => saveBinding(root, 'same', binding)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(outcomes.filter(result => result.status === 'rejected').every(result => result.reason.code === 'BINDING_EXISTS'));
  assert.deepEqual(await readdir(root), ['same.json']);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(root, 'same.json'))).mode & 0o777, 0o600);
});

test('replacement is explicit and saved state has no arbitrary extra fields', async t => {
  const root = await directory(t);
  await saveBinding(root, 'sample', { ...binding, cookie: 'PRIVATE_SECRET' });
  await assert.rejects(saveBinding(root, 'sample', binding), { code: 'BINDING_EXISTS' });
  await saveBinding(root, 'sample', { ...binding, tab_id: 99 }, { replace: true });
  const loaded = await loadBinding(root, 'sample');
  assert.equal(loaded.tab_id, 99);
  assert.equal(loaded.cookie, undefined);
});

test('unsupported state versions fail', async t => {
  const root = await directory(t);
  await writeFile(path.join(root, 'sample.json'), JSON.stringify({ ...binding, schema_version: 99 }));
  await assert.rejects(loadBinding(root, 'sample'), { code: 'INVALID_BINDING' });
});

test('symbolic-link binding files are rejected', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t);
  await saveBinding(root, 'original', binding);
  await symlink(path.join(root, 'original.json'), path.join(root, 'link.json'));
  await assert.rejects(loadBinding(root, 'link'), { code: 'INVALID_BINDING' });
});
