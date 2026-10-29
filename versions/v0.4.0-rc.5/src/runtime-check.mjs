// Read-only inspection. No bridge state lock, task claims or native-task guesses.
import { request } from 'node:http';
import { listJobs } from './tool-jobs.mjs';
import { localUrl, RECOVERY_REVISION } from './config.mjs';

export const EXPECTED_BUILD = 'rc5-inbound-media-20261028';
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeCode = (error) => /^[a-zA-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'inspection_failed';
const safeStamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

export function getRuntimeJson(config, path) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let timer;
    const req = request(localUrl(config) + path, { headers: { Authorization: `Bearer ${config.api_token}` } }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { done({ error: 'response_too_large' }); req.destroy(); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { done({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)) }); }
        catch { done({ error: 'invalid_response' }); }
      });
      response.on('error', () => done({ error: 'response_interrupted' }));
      response.on('aborted', () => done({ error: 'response_interrupted' }));
    });
    timer = setTimeout(() => { done({ error: 'api_timeout' }); req.destroy(); }, 5000);
    req.on('error', (error) => done({ error: 'api_unreachable', transport_code: safeCode(error) }));
    req.end();
  });
}

export async function inspectRuntime(config, jobDir, { get = getRuntimeJson, jobs = listJobs } = {}) {
  const [status, health] = await Promise.all(['/v1/status', '/v1/health'].map((path) => get(config, path)));
  const s = status.value ?? {}, h = health.value ?? {};
  let tools;
  try {
    const rows = jobs(jobDir);
    tools = { available: true, total: rows.length,
      unfinished: rows.filter((job) => !['succeeded', 'failed', 'timed_out', 'cancelled', 'output_limit', 'interrupted'].includes(job.state)).length,
      awaiting_review: rows.filter((job) => !job.settled_at && (['succeeded', 'failed', 'timed_out', 'cancelled', 'output_limit', 'interrupted'].includes(job.state) || job.attention_required)).length,
      attention_required: rows.filter((job) => job.attention_required).length };
  } catch (error) { tools = { available: false, error: safeCode(error) }; }
  return { mode: 'read_only_runtime_check', recovery_tools: RECOVERY_REVISION, at: new Date().toISOString(),
    bridge: { available: status.status === 200, status_http: status.status ?? null, error: status.error ?? null,
      transport_code: status.transport_code ?? null, since: safeStamp(s.worker?.since),
      version: typeof s.version === 'string' ? s.version : null, build: typeof s.build === 'string' ? s.build : null,
      expected_build: EXPECTED_BUILD, build_matches: s.version === '0.4.0-rc.5' && s.build === EXPECTED_BUILD,
      logged_in: typeof s.logged_in === 'boolean' ? s.logged_in : null,
      poll: { state: ['stopped', 'waiting', 'ok', 'running', 'error', 'backoff', 'failing', 'expired', 'restore_review', 'not_logged_in'].includes(s.poll?.state) ? s.poll.state : null,
        last_ok_at: safeStamp(s.poll?.last_ok_at), error_present: !!s.poll?.error,
        error_code: typeof s.poll?.error === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(s.poll.error) ? s.poll.error : null },
      queue: Object.fromEntries(['pending', 'ready', 'leased', 'started_steps', 'unresolved_steps', 'unknown_sends'].map((key) => [key, count(s.queue?.[key])])),
      last_claim_at: safeStamp(s.worker?.last_claim_at) },
    health: { available: typeof h.healthy === 'boolean', http_status: health.status ?? null,
      healthy: typeof h.healthy === 'boolean' ? h.healthy : null,
      problems: Array.isArray(h.problems) ? h.problems.filter((code) => typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)).slice(0, 32) : [], error: health.error ?? null },
    tools, worker: { platform_query_required: true, alive: null, replacement_authorized: false } };
}
