#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runMcpChild, startPlaywrightService } from '../lib/playwright-service.mjs';
import { publicError, ShoppingError } from '../lib/errors.mjs';
import { runManagedBridge } from '../lib/bridge-service.mjs';

const run = async () => {
  if (process.argv[2] === '--mcp-child') return runMcpChild(process.argv.slice(3));
  if (process.argv.length === 3 && process.argv[2] === '--managed') return runManagedBridge({ startService: startPlaywrightService });
  let values;
  try {
    ({ values } = parseArgs({ options: {
      port: { type: 'string', default: '19825' }, 'token-file': { type: 'string' },
      profile: { type: 'string' }, 'local-headless': { type: 'boolean', default: false },
    } }));
  } catch { throw new ShoppingError('INVALID_ARGUMENTS', 'Use the documented Playwright service options.'); }
  await startPlaywrightService({ port: Number(values.port), profile: values.profile,
    tokenFile: values['token-file'], localHeadless: values['local-headless'] });
};

run().catch(error => {
  if (error.code === 'SERVICE_STOPPING') return;
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  process.exitCode = 1;
});
