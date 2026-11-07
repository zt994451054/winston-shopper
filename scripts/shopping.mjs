#!/usr/bin/env node

// Check before importing modern APIs so an older Node receives an actionable error.
if (Number.parseInt(process.versions.node.split('.')[0], 10) < 22) {
  process.stdout.write(JSON.stringify({
    schema_version: 1, ok: false, status: 'needs_runtime',
    error: { code: 'UNSUPPORTED_NODE', message: 'Node.js 22 or newer is required.',
      next_action: 'Run this command with a Node.js 22+ executable. Verify node --version in this directory.' },
    actual_node: process.versions.node,
  }) + '\n');
  process.exitCode = 2;
} else {
  import('../lib/cli.mjs').then(async ({ main }) => {
    process.exitCode = await main(process.argv.slice(2));
  }).catch(() => {
    process.stdout.write(JSON.stringify({ schema_version: 1, ok: false, status: 'failed',
      error: { code: 'STARTUP_FAILED', message: 'The runtime files could not be loaded.', next_action: 'Restore the complete skill directory and rerun.' } }) + '\n');
    process.exitCode = 1;
  });
}
