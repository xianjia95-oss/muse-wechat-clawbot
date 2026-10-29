// Read-only observation of the locally deployed bridge. Does not send messages,
// claim tasks, acknowledge work, restart services, or bypass readiness failures.
import { parseArgs } from 'node:util';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Agent, request } from 'undici';
import { defaultConfigPath, expand, loadConfig, localUrl, VERSION } from '../src/config.mjs';
import { duration, integer } from '../src/errors.mjs';

process.umask(0o077);
const { values } = parseArgs({ options: { config: { type: 'string' }, duration: { type: 'string' }, interval: { type: 'string' }, report: { type: 'string' } } });
const runtime = integer(duration(values.duration, 72 * 3600000), 1000, 7 * 86400000, 'duration');
const interval = integer(duration(values.interval, 30000), 1000, 3600000, 'interval');
if (Math.ceil(runtime / interval) > 30000) throw new Error('Use a longer interval (maximum 30000 samples).');
const config = loadConfig(values.config ? expand(values.config) : defaultConfigPath());
const path = resolve(values.report ?? 'dist/observe-live.json'); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const agent = new Agent({ connections: 1 }); const abort = new AbortController();
process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
const began = Date.now(); const samples = [];
const save = (completed = false) => {
  const report = { version: VERSION, mode: 'read_only_live_bridge_observation', started_at: new Date(began).toISOString(), updated_at: new Date().toISOString(), requested_ms: runtime, elapsed_ms: Date.now() - began, completed, sample_count: samples.length, unhealthy_samples: samples.filter((value) => !value.healthy).length, phone_delivery_verified: false, tool_execution_verified: false, samples };
  writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); renameSync(path + '.tmp', path); return report;
};
async function get(route) {
  const response = await request(localUrl(config) + route, { dispatcher: agent, headers: { Authorization: `Bearer ${config.api_token}` }, headersTimeout: 5000, bodyTimeout: 5000, signal: AbortSignal.timeout(5000) });
  return { status: response.statusCode, value: await response.body.json() };
}
console.log(JSON.stringify({ observing: true, report: path, duration_ms: runtime, read_only: true }));
try {
  do {
    const at = new Date().toISOString();
    try {
      const health = await get('/v1/health'); const metrics = await get('/v1/metrics');
      samples.push({ at, healthy: health.status === 200 && health.value.healthy === true, http_status: health.status, version: health.value.version, problems: health.value.problems ?? [health.value.error ?? 'unknown_health'], poll: health.value.poll, queue: health.value.queue, storage: health.value.storage, metrics: metrics.status === 200 ? metrics.value : { error: 'metrics_unavailable' } });
    } catch (error) { samples.push({ at, healthy: false, error: error.code ?? 'connection_failed' }); }
    save();
    if (Date.now() - began >= runtime || abort.signal.aborted) break;
    await pause(Math.min(interval, Math.max(1, runtime - (Date.now() - began))), undefined, { signal: abort.signal }).catch(() => {});
  } while (!abort.signal.aborted);
} finally {
  const report = save(!abort.signal.aborted && Date.now() - began >= runtime); await agent.close();
  console.log(JSON.stringify({ completed: report.completed, sample_count: report.sample_count, unhealthy_samples: report.unhealthy_samples, report: path }));
  if (!report.completed || report.unhealthy_samples) process.exitCode = 1;
}
