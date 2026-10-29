#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { resolve } from 'node:path';
import { loadWatchdogConfig, OwnerWatchdog } from '../src/owner-watchdog.mjs';

process.umask(0o077);
let monitor;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' } } });
  const action = positionals[0];
  if (!['check', 'once', 'run'].includes(action) || positionals.length !== 1 || !values.config)
    throw Object.assign(new Error(), { code: 'use_check_once_or_run_with_config' });
  const config = loadWatchdogConfig(resolve(values.config));
  monitor = new OwnerWatchdog(config);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  let prior;
  do {
    const result = await monitor.tick({ observeOnly: action === 'check' });
    const signature = JSON.stringify([result.code, result.platform_state, result.owner_active]);
    // Bounded, sanitized transitions only; native handles stay in private state.
    if (signature !== prior || action !== 'run') { console.log(JSON.stringify(result)); prior = signature; }
    if (action !== 'run' || controller.signal.aborted) break;
    try { await pause(config.interval_ms, undefined, { signal: controller.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  } while (!controller.signal.aborted);
} catch (error) {
  const known = new Set(['invalid_watchdog_state', 'invalid_watchdog_config', 'unsafe_watchdog_path', 'unsafe_watchdog_adapter',
    'invalid_session_file', 'invalid_task_file', 'unsafe_task_file', 'unsafe_task_output', 'state_locked', 'use_check_once_or_run_with_config']);
  console.error(JSON.stringify({ error: known.has(error.code) ? error.code : 'watchdog_failed',
    action: 'inspect_private_configuration_and_state' }));
  process.exitCode = 1;
} finally { monitor?.close(); }
