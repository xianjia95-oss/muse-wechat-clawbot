// Runs against rc.1/rc.2 as well as the current daemon. Built-in Node modules
// only; no install, restart, task claim, ack, send or database writes.
import { parseArgs } from 'node:util';
import { request } from 'node:http';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { defaultConfigPath, expand, loadConfig, localUrl } from '../src/config.mjs';
import { deliveryDiagnostics } from '../src/diagnostics.mjs';
import { inspectLease } from '../src/lease.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'event-id': { type: 'string' }, 'lease-token-stdin': { type: 'boolean' } } });
function get(config, path) {
  return new Promise((resolve) => {
    const req = request(localUrl(config) + path, { headers: { Authorization: `Bearer ${config.api_token}` } }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) req.destroy(); else chunks.push(chunk); });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)) }); }
        catch { resolve({ error: 'invalid_response' }); }
      });
      response.on('error', () => resolve({ error: 'response_interrupted' }));
    });
    const timer = setTimeout(() => req.destroy(), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => resolve({ error: 'api_unreachable' }));
    req.end();
  });
}
async function eventState(config) {
  let supplied;
  if (values['lease-token-stdin']) {
    let token = '';
    for await (const chunk of process.stdin) { token += chunk; if (Buffer.byteLength(token) > 1024) throw new Error('Token input too large'); }
    supplied = token.replace(/[\r\n]+$/, '');
  }
  const file = join(config.state_dir, 'bridge.sqlite');
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return { error: 'missing_or_unsafe_state' };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT lease_until,lease_token,acked_ms FROM events WHERE id=?').get(values['event-id']);
    const now = Date.now();
    const result = { event_found: !!row, checked_at_ms: now, acknowledged_at_ms: row?.acked_ms ?? null, lease_until_ms: row?.lease_until ?? null,
      lease_currently_valid: !!row && row.acked_ms === null && row.lease_until > now };
    if (values['lease-token-stdin']) result.supplied_token_check = inspectLease(row, supplied, now);
    return result;
  } finally { db.close(); }
}
try {
  if (values['lease-token-stdin'] && !values['event-id']) throw new Error('event-id required');
  const config = loadConfig(values.config ? expand(values.config) : defaultConfigPath());
  const [status, readiness, metrics] = await Promise.all(['/v1/status', '/v1/health', '/v1/metrics'].map((path) => get(config, path)));
  const report = deliveryDiagnostics({ status: status.value, readiness: readiness.value, metrics: metrics.value });
  report.endpoints = Object.fromEntries([['status', status], ['health', readiness], ['metrics', metrics]].map(([name, result]) => [name, { status: result.status, error: result.error }]));
  report.client_endpoint = localUrl(config);
  if (values['event-id']) report.event = await eventState(config);
  if (status.status !== 200) report.findings.unshift({ code: 'status_unavailable', next: '检查后台进程、配置端口和 API token；当前报告无法确认 worker 或队列状态。' });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ read_only: true, error: error.code ?? 'diagnose_failed' }));
  process.exitCode = 1;
}
