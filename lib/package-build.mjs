import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ShoppingError } from './errors.mjs';
import { findPrivateMarkers, selectPackageFiles, stripOutsideLinks } from './package-contents.mjs';

const run = promisify(execFile);
const PACKAGE_NAME = 'winston-shopper';

async function command(file, args, cwd, failure) {
  try {
    return (await run(file, args, { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })).stdout;
  } catch {
    throw failure;
  }
}

function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function missing(filename) {
  try { await stat(filename); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function sourceState(sourceRoot) {
  const gitFailure = new ShoppingError('PACKAGE_SOURCE_UNAVAILABLE', 'The skill directory is not readable as a git checkout.',
    'Run the build from a git checkout of the skill with git installed.');
  // A clean tree guarantees the package equals the recorded commit.
  if ((await command('git', ['status', '--porcelain', '--', '.'], sourceRoot, gitFailure)).trim()) {
    throw new ShoppingError('PACKAGE_SOURCE_DIRTY', 'The skill directory has uncommitted changes.', 'Commit or discard the changes, then build again.');
  }
  const tracked = (await command('git', ['ls-files', '-z', '--', '.'], sourceRoot, gitFailure)).split('\0').filter(Boolean);
  const commit = (await command('git', ['rev-parse', 'HEAD'], sourceRoot, gitFailure)).trim();
  return { tracked, commit };
}

async function prepareFile(sourceRoot, file, packaged) {
  const source = path.join(sourceRoot, ...file.split('/'));
  let text = await readFile(source, 'utf8');
  let linksRemoved = 0;
  if (file.endsWith('.md')) ({ text, removed: linksRemoved } = stripOutsideLinks(text, file, packaged));
  const markers = findPrivateMarkers(text);
  if (markers.length) {
    throw new ShoppingError('PACKAGE_PRIVATE_MARKER', `${file} contains ${markers.join(', ')}.`,
      'Remove the private value from the tracked file, commit, and build again.');
  }
  return { file, bytes: Buffer.from(text, 'utf8'), mode: (await stat(source)).mode & 0o755, linksRemoved };
}

async function writePrepared(packageRoot, { file, bytes, mode, linksRemoved }) {
  const destination = path.join(packageRoot, ...file.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx' });
  await chmod(destination, mode);
  return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(linksRemoved ? { links_removed: linksRemoved } : {}) };
}

/**
 * Build the install package from the committed skill files.
 * @param {{sourceRoot: string, outputDirectory: string, now?: () => Date}} options
 * @returns {Promise<{directory: string, archive: string, archive_sha256: string, version: string, source_commit: string, files: number, links_removed: number}>}
 * @throws {ShoppingError} PACKAGE_SOURCE_DIRTY, PACKAGE_SOURCE_UNAVAILABLE, PACKAGE_OUTPUT_EXISTS, PACKAGE_OUTPUT_PROTECTED,
 *   PACKAGE_PRIVATE_MARKER, INVALID_PACKAGE_PATH or PACKAGE_ARCHIVE_FAILED.
 * @example await buildPackage({ sourceRoot: '/repo/consumer-shopping-skill', outputDirectory: '/repo/dist' });
 */
export async function buildPackage({ sourceRoot, outputDirectory, now = () => new Date() }) {
  const root = path.resolve(sourceRoot), output = path.resolve(outputDirectory);
  if (inside(root, output)) {
    throw new ShoppingError('PACKAGE_OUTPUT_PROTECTED', 'The package cannot be written inside the skill directory.', 'Choose an output directory outside the skill.');
  }
  const { tracked, commit } = await sourceState(root);
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const packageRoot = path.join(output, PACKAGE_NAME), archive = path.join(output, `${PACKAGE_NAME}-${version}.tar.gz`);
  if (!(await missing(packageRoot)) || !(await missing(archive))) {
    throw new ShoppingError('PACKAGE_OUTPUT_EXISTS', 'A package with this name already exists in the output directory.',
      'Choose an empty output directory or move the previous package away.');
  }
  const files = selectPackageFiles(tracked), packaged = new Set(files);
  // Check every file before writing any, so a refused build leaves no partial package behind.
  const prepared = [];
  for (const file of files) prepared.push(await prepareFile(root, file, packaged));
  await mkdir(packageRoot, { recursive: true });
  const entries = [];
  for (const file of prepared) entries.push(await writePrepared(packageRoot, file));
  const manifest = { schema_version: 1, name: PACKAGE_NAME, version, source_commit: commit, built_at: now().toISOString(),
    excludes: 'Only committed files from the allowlist are included; private state, installed dependencies and development history are not.',
    files: entries };
  await writeFile(path.join(packageRoot, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await command('tar', ['-czf', archive, '-C', output, PACKAGE_NAME], output,
    new ShoppingError('PACKAGE_ARCHIVE_FAILED', 'The package directory was written but the archive could not be created.', 'Check that tar is installed, then build again into an empty directory.'));
  const archiveSha = createHash('sha256').update(await readFile(archive)).digest('hex');
  return { directory: packageRoot, archive, archive_sha256: archiveSha, version, source_commit: commit, files: entries.length,
    links_removed: entries.reduce((total, entry) => total + (entry.links_removed ?? 0), 0) };
}
