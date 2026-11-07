#!/usr/bin/env node
// Build the install package from a clean git checkout: node scripts/build-package.mjs --output <directory outside the skill>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildPackage } from '../lib/package-build.mjs';
import { publicError } from '../lib/errors.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

try {
  const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true });
  if (!values.output) throw Object.assign(new Error('missing output'), { code: 'INVALID_ARGUMENTS' });
  print({ schema_version: 1, ok: true, status: 'package_built', ...(await buildPackage({ sourceRoot, outputDirectory: values.output })) });
} catch (error) {
  const invalid = error.code === 'INVALID_ARGUMENTS' || error.code?.startsWith?.('ERR_PARSE_ARGS');
  print({ schema_version: 1, ok: false, status: 'failed', error: invalid
    ? { code: 'INVALID_ARGUMENTS', message: 'Usage: build-package.mjs --output DIRECTORY', next_action: 'Pass an output directory outside the skill.' }
    : publicError(error) });
  process.exitCode = 1;
}
