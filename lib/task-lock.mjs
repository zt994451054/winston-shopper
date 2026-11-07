import { open, readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ShoppingError } from './errors.mjs';

function busy() {
  return new ShoppingError('TASK_BUSY', 'The platform lock is held or cannot safely be recovered.',
    'Wait for the running task. Dead local process locks recover automatically; for an unreadable lock see references/tasks.md.');
}

async function removeDeadLock(root, filename) {
  const guardPath = path.join(root, '.lock-recovery');
  let guard;
  try { guard = await open(guardPath, 'wx', 0o600); }
  catch { throw busy(); }
  try {
    let owner;
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw busy();
    try { owner = JSON.parse(await readFile(filename, 'utf8')); } catch { throw busy(); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.hostname !== os.hostname()) throw busy();
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw busy();
      // Recovery holders are serialized so a second process cannot delete a newly acquired lock.
      const current = await lstat(filename);
      if (stat.ino !== current.ino || stat.dev !== current.dev) throw busy();
      await unlink(filename);
      return;
    }
    throw busy();
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  } finally {
    await guard.close();
    await unlink(guardPath);
  }
}

/**
 * Acquire the local platform lock, reclaiming it only when its recorded process is dead.
 * @param {string} directory Existing task directory. @param {string} task Valid task name.
 * @returns {Promise<() => Promise<void>>} Release callback, called exactly once by the owner.
 * @throws {ShoppingError} TASK_BUSY or CHECKPOINT_WRITE_FAILED.
 */
export async function acquireTaskLock(directory, task) {
  const filename = path.join(directory, '.taobao.lock');
  let file;
  try {
    try { file = await open(filename, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await removeDeadLock(directory, filename);
      file = await open(filename, 'wx', 0o600);
    }
    await file.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), task, created_at: new Date().toISOString() }));
    await file.sync();
  } catch (error) {
    if (file) { await file.close(); await unlink(filename); }
    if (error instanceof ShoppingError) throw error;
    if (error.code === 'EEXIST') throw busy();
    throw new ShoppingError('CHECKPOINT_WRITE_FAILED', 'The task lock could not be created or recovered.');
  }
  return async () => { await file.close(); await unlink(filename); };
}
