#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AutomaticDispatcher, loadAutomaticConfig, automaticStatus } from '../src/automatic-dispatch.mjs';
import { expand } from '../src/config.mjs';
import { fail } from '../src/errors.mjs';

process.umask(0o077);
let dispatcher;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' } } });
  if (positionals.length !== 1 || !['run', 'status'].includes(positionals[0]) || !values.config)
    fail('automatic_usage', 'Use run|status --config /private/automatic.json.');
  const settings = loadAutomaticConfig(expand(values.config));
  if (positionals[0] === 'status') console.log(JSON.stringify(automaticStatus(settings)));
  else {
    dispatcher = new AutomaticDispatcher(settings);
    const stop = new AbortController();
    process.once('SIGTERM', () => stop.abort()); process.once('SIGINT', () => stop.abort());
    await dispatcher.run(stop.signal);
  }
} catch (error) {
  const code = /^[a-z][a-z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'automatic_failed';
  console.error(JSON.stringify({ error: code, action: 'retain_original_session_claims_and_receipts' })); process.exitCode = 1;
} finally { await dispatcher?.close(); }
