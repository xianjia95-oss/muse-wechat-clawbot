import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, defaultConfigPath, expand } from '../src/config.mjs';
import { inspectRuntime } from '../src/runtime-check.mjs';

process.umask(0o077);
try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'job-dir': { type: 'string' } } });
  const report = await inspectRuntime(loadConfig(values.config ? expand(values.config) : defaultConfigPath()),
    values['job-dir'] ? expand(values['job-dir']) : join(homedir(), '.local/state/muse-link-worker/jobs'));
  console.log(JSON.stringify(report, null, 2));
  if (!report.bridge.available || !report.health.available || !report.tools.available || report.health.healthy !== true || report.bridge.logged_in !== true) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ mode: 'read_only_runtime_check', error: /^[a-zA-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'inspection_failed' }));
  process.exitCode = 2;
}
