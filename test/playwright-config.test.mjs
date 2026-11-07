import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PLAYWRIGHT_BACKEND_DIRECTORY, PLAYWRIGHT_TOKEN_FILE, readExtensionToken } from '../lib/playwright-config.mjs';
import { readExtensionToken as serviceTokenReader, PLAYWRIGHT_BACKEND_DIRECTORY as serviceBackendDirectory } from '../lib/playwright-service.mjs';
import { publicError } from '../lib/errors.mjs';

const TOKEN = `synthetic_${'x'.repeat(24)}_token`;

async function fixture(t, text = TOKEN) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shopping playwright token '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'token');
  await writeFile(tokenFile, text, { mode: 0o600 });
  return { root, tokenFile };
}

async function expectSafeError(tokenFile, code) {
  await assert.rejects(readExtensionToken(tokenFile), error => {
    assert.equal(error.code, code);
    const output = JSON.stringify(publicError(error));
    assert.ok(!output.includes(TOKEN));
    assert.ok(!output.includes(tokenFile));
    return true;
  });
}

test('default paths belong to the installed skill and existing service exports remain compatible', () => {
  assert.equal(PLAYWRIGHT_BACKEND_DIRECTORY, fileURLToPath(new URL('../runtime/playwright-backend/', import.meta.url)));
  assert.equal(PLAYWRIGHT_TOKEN_FILE, fileURLToPath(new URL('../.runtime/pw-ext-token', import.meta.url)));
  assert.equal(serviceTokenReader, readExtensionToken);
  assert.equal(serviceBackendDirectory, PLAYWRIGHT_BACKEND_DIRECTORY);
});

test('reading a synthetic token trims surrounding whitespace and does not modify the file', async t => {
  const text = `\n ${TOKEN}\n`;
  const { root, tokenFile } = await fixture(t, text);
  const before = await lstat(tokenFile);
  assert.equal(await readExtensionToken(tokenFile), TOKEN);
  assert.equal(await readFile(tokenFile, 'utf8'), text);
  const after = await lstat(tokenFile);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(root), ['token']);
});

test('valid minimum and maximum token lengths and URL-safe characters are accepted', async t => {
  for (const text of ['a'.repeat(16), 'A'.repeat(256), 'A1_-'.repeat(8)]) {
    const { tokenFile } = await fixture(t, text);
    assert.equal(await readExtensionToken(tokenFile), text);
  }
});

test('explicit relative token paths retain the existing launcher behavior', async t => {
  const { tokenFile } = await fixture(t);
  assert.equal(await readExtensionToken(path.relative(process.cwd(), tokenFile)), TOKEN);
});

test('missing token files and missing directories have a distinct safe error and are not created', async t => {
  const { root, tokenFile } = await fixture(t);
  await rm(tokenFile);
  await expectSafeError(tokenFile, 'PLAYWRIGHT_TOKEN_MISSING');
  await expectSafeError(path.join(root, 'absent', 'token'), 'PLAYWRIGHT_TOKEN_MISSING');
  assert.deepEqual(await readdir(root), []);
});

test('empty, malformed and overlong tokens never appear in error output', async t => {
  for (const text of ['', ' ', 'a'.repeat(15), 'a'.repeat(257), `${TOKEN}\nother`, `${TOKEN}/`, '\ufffd'.repeat(20)]) {
    const { tokenFile } = await fixture(t, text);
    await expectSafeError(tokenFile, 'PLAYWRIGHT_TOKEN_INVALID');
  }
});

test('oversized token files and directories are rejected before reading content', async t => {
  const { root, tokenFile } = await fixture(t, `${TOKEN}${' '.repeat(1025)}`);
  await expectSafeError(tokenFile, 'PLAYWRIGHT_TOKEN_FILE_INVALID');
  const folder = path.join(root, 'folder');
  await mkdir(folder, { mode: 0o600 });
  await expectSafeError(folder, 'PLAYWRIGHT_TOKEN_FILE_INVALID');
});

test('token-file and immediate parent symlinks are refused without changing their targets', async t => {
  const { root, tokenFile } = await fixture(t);
  const alias = path.join(root, 'token-link');
  await symlink(tokenFile, alias);
  await expectSafeError(alias, 'PLAYWRIGHT_TOKEN_FILE_INVALID');
  const parentAlias = path.join(root, 'parent-link');
  await symlink(root, parentAlias, 'dir');
  await expectSafeError(path.join(parentAlias, 'token'), 'PLAYWRIGHT_TOKEN_FILE_INVALID');
  assert.equal(await readFile(tokenFile, 'utf8'), TOKEN);
});

test('POSIX token permissions must be exactly 0600 and are never repaired implicitly', { skip: process.platform === 'win32' }, async t => {
  const { tokenFile } = await fixture(t);
  for (const mode of [0o644, 0o400, 0o660, 0o700, 0o000]) {
    await chmod(tokenFile, mode);
    await expectSafeError(tokenFile, 'PLAYWRIGHT_TOKEN_PERMISSIONS');
    assert.equal((await lstat(tokenFile)).mode & 0o777, mode);
  }
  await chmod(tokenFile, 0o600);
  assert.equal(await readExtensionToken(tokenFile), TOKEN);
});

test('a non-directory parent is rejected as an invalid token file', async t => {
  const { tokenFile } = await fixture(t);
  await expectSafeError(path.join(tokenFile, 'token'), 'PLAYWRIGHT_TOKEN_FILE_INVALID');
});

test('OS access failures are distinct from missing files and never disclose content',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
    const { root } = await fixture(t);
    const parent = path.join(root, 'private');
    await mkdir(parent, { mode: 0o700 });
    const tokenFile = path.join(parent, 'token');
    await writeFile(tokenFile, TOKEN, { mode: 0o600 });
    await chmod(parent, 0o000);
    try { await expectSafeError(tokenFile, 'PLAYWRIGHT_TOKEN_ACCESS_FAILED'); }
    finally { await chmod(parent, 0o700); }
});

test('invalid token paths fail with fixed messages instead of echoing arguments', async () => {
  for (const value of ['', null, 42]) {
    await assert.rejects(readExtensionToken(value), error => {
      assert.equal(error.code, 'PLAYWRIGHT_TOKEN_FILE_INVALID');
      assert.ok(!JSON.stringify(publicError(error)).includes(TOKEN));
      return true;
    });
  }
});
