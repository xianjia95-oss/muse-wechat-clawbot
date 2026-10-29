// A detector only: no claiming, dispatching, lease changes or claim cleanup.
// Keep structured, sanitized readiness evidence instead of calling every 503 a
// generic bridge failure or asserting that the Muse process must be dead.
const codes = (items) => Array.isArray(items) ? [...new Set(items.filter((value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)))].sort() : [];
const counts = (queue = {}) => Object.fromEntries(['pending', 'ready', 'leased', 'stalled_leases', 'started_steps', 'unresolved_steps', 'unknown_sends', 'oldest_lease_activity_ms']
  .filter((key) => typeof queue[key] === 'number' && Number.isFinite(queue[key]) && queue[key] >= 0).map((key) => [key, queue[key]]));

export function probeResult(value, httpEquivalent = 0) {
  if (!value || typeof value.healthy !== 'boolean' || !Array.isArray(value.problems)) return { healthy: false, problems: ['hook_probe_invalid_response'], ready: 0 };
  const problems = codes(value.problems);
  if (!value.healthy && !problems.length) problems.push('readiness_not_ready');
  const queue = counts(value.queue);
  const ready = queue.ready ?? Math.max(0, (queue.pending ?? 0) - (queue.leased ?? 0));
  return {
    healthy: value.healthy && problems.length === 0 && httpEquivalent === 200,
    problems, ready,
    evidence: {
      healthy: value.healthy, http_status: httpEquivalent, problems, queue,
      ...(typeof value.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(value.version) ? { version: value.version } : {}),
      poll: { state: ['waiting', 'ok', 'idle', 'error', 'stopped'].includes(value.poll?.state) ? value.poll.state : 'unknown',
        last_ok_at: Number.isFinite(Date.parse(value.poll?.last_ok_at)) ? new Date(value.poll.last_ok_at).toISOString() : null,
        error_present: !!value.poll?.error },
    },
  };
}

export async function detectHook({ probe, pending, readAlert, writeAlert, clearAlert, now = Date.now(), cooldownMs = 3600000 }) {
  const check = async () => { try { return await probe(); } catch { return { healthy: false, problems: ['hook_probe_failed'], ready: 0 }; } };
  const wake = (reason) => ({ decision: 'wake', reason });
  const detectedAt = new Date(now).toISOString();
  const warn = (reason) => wake(`${reason}；检测于 ${detectedAt}；收到唤醒后先复查当前状态`);
  let result = await check();
  if (result.ready > 0) return wake(`微信有 ${result.ready} 条新事件${result.problems.length ? `；readiness: ${result.problems.join(', ')}` : ''}`);
  let jobProblems = [];
  try {
    const count = await pending();
    if (!Number.isSafeInteger(count) || count < 0) throw new Error();
    if (count > 0) return wake(`Muse 有 ${count} 个后台任务或结果待处理`);
  } catch { jobProblems = ['background_jobs_unreadable']; }
  if (!result.healthy) {
    // Retry without an unbounded CLI wait or a sleep spanning the hook period.
    result = await check();
    if (result.ready > 0) return wake(`微信有 ${result.ready} 条新事件${result.problems.length ? `；readiness: ${result.problems.join(', ')}` : ''}`);
  }
  if (result.healthy && !jobProblems.length) {
    try { await clearAlert(); } catch { return warn('Muse 微信桥检测器：alert_state_unwritable'); }
    return { decision: 'silent', reason: '' };
  }
  const problems = codes([...result.problems, ...jobProblems]);
  if (!problems.length) problems.push('hook_probe_failed');
  const signature = problems.join(',');
  let prior;
  try { prior = await readAlert(); } catch { /* Missing or corrupt cache cannot suppress an alert. */ }
  if (prior?.signature === signature && Number.isFinite(prior.at_ms) && now >= prior.at_ms && now - prior.at_ms < cooldownMs) return { decision: 'silent', reason: '' };
  try { await writeAlert({ at: detectedAt, at_ms: now, signature, problems, evidence: result.evidence ?? null }); }
  catch { problems.push('alert_state_unwritable'); }
  return warn(`Muse 微信桥 readiness: ${problems.join(', ')}；检查实际领取、续租、步骤和轮询；不据此重启或清租约`);
}

export function formatHook(result, format = 'plain') {
  if (format === 'hatch') return 'HATCH_HOOK_RESULT:' + JSON.stringify(result);
  if (format !== 'plain') throw Object.assign(new Error('Unknown hook format.'), { code: 'invalid_hook_format' });
  return result.decision === 'silent' ? 'silent' : `wake: ${result.reason}`;
}
