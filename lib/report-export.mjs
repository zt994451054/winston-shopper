import { open, link, unlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadTask } from './task-store.mjs';
import { buildCachedReport, renderCachedReport } from './cached-report.mjs';
import { ShoppingError } from './errors.mjs';

function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function protectedOutput() {
  return new ShoppingError('REPORT_OUTPUT_PROTECTED', 'Reports cannot be written inside the source state directory.',
    'Choose an existing local output directory outside the state directory.');
}

async function destination(stateDirectory, output) {
  const filename = path.resolve(output);
  if (inside(stateDirectory, filename)) throw protectedOutput();
  let stateRoot, parent;
  try {
    stateRoot = await realpath(stateDirectory);
    parent = await realpath(path.dirname(filename));
    if (!(await stat(parent)).isDirectory()) throw new Error('Output parent is not a directory');
  } catch {
    throw new ShoppingError('INVALID_REPORT_OUTPUT', 'The source and output parent directories must exist.',
      'Choose an existing local directory and an unused output filename.');
  }
  const resolved = path.join(parent, path.basename(filename));
  if (inside(stateRoot, resolved)) throw protectedOutput();
  return resolved;
}

async function writeExclusive(filename, bytes) {
  const temporary = path.join(path.dirname(filename), `.shopping-report-${randomUUID()}.tmp`);
  let file, created = false;
  try {
    file = await open(temporary, 'wx', 0o600);
    created = true;
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = null;
    // A hard link publishes complete bytes without replacing any existing destination.
    await link(temporary, filename);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new ShoppingError('REPORT_OUTPUT_EXISTS', 'The report destination already exists.',
        'Preserve the existing file and choose a new output filename.');
    }
    throw new ShoppingError('REPORT_WRITE_FAILED', 'The local report could not be saved.',
      'Check the output directory and preserve any existing report before retrying.');
  } finally {
    let cleanupFailed = false;
    if (file) await file.close().catch(() => { cleanupFailed = true; });
    if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') cleanupFailed = true; });
    if (cleanupFailed) {
      throw new ShoppingError('REPORT_WRITE_FAILED', 'The temporary report could not be removed.',
        'Inspect the output directory and preserve the report before retrying.');
    }
  }
}

/**
 * Export one validated local task cache without browser IO or state mutations.
 * @param {{stateDirectory: string, task: string, format: 'markdown'|'csv', output: string}} options
 * @returns {Promise<object>} Output metadata, byte count and SHA-256; content stays in the private file.
 * @throws {ShoppingError} Invalid arguments/checkpoints, unsupported task kinds, protected or existing destinations, or filesystem failures.
 * @example await exportReport({stateDirectory: './bindings', task: 'sample', format: 'markdown', output: './reports/sample.md'});
 */
export async function exportReport({ stateDirectory, task, format, output }) {
  if (!['markdown', 'csv'].includes(format)) {
    throw new ShoppingError('INVALID_REPORT_FORMAT', 'Choose markdown or csv for the report format.');
  }
  if (typeof output !== 'string' || output.trim() === '' || output.includes('\0')) {
    throw new ShoppingError('INVALID_REPORT_OUTPUT', 'Provide an unused local output filename.');
  }
  if (typeof stateDirectory !== 'string' || stateDirectory.trim() === '') {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Provide the source state directory.');
  }
  const stateRoot = path.resolve(stateDirectory);
  if (inside(stateRoot, path.resolve(output))) throw protectedOutput();
  const saved = await loadTask(stateRoot, task);
  const report = buildCachedReport(saved);
  const bytes = Buffer.from(renderCachedReport(report, format), 'utf8');
  const filename = await destination(stateRoot, output);
  await writeExclusive(filename, bytes);
  return { ok: true, status: 'report_exported', task: saved.id, task_kind: saved.kind,
    task_status: saved.status, format, output: filename, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    observation_count: report.observations.length, record_count: report.records.length,
    browser_accessed: false, state_changed: false };
}
