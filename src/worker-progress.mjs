// Bridge observations cannot prove that a Muse process is alive or that the
// platform accepted a wake. Report a lack of claim progress, not a root cause.
export function consumerProgress(queue = {}, worker, warnAfter = 60000, now = Date.now()) {
  const oldest = queue.oldest_ready_ms;
  const ready = queue.ready ?? Math.max(0, (queue.pending ?? 0) - (queue.leased ?? 0));
  const oldestValid = typeof oldest === 'number' && Number.isFinite(oldest);
  const claimed = Date.parse(worker?.last_task_at ?? '');
  const readyWait = ready > 0 && oldestValid ? Math.max(0, now - oldest) : null;
  const withoutProgress = readyWait === null ? null : Math.max(0, now - Math.max(oldest, Number.isFinite(claimed) ? claimed : oldest));
  return {
    state: ready <= 0 ? 'no_ready_work' : !worker || !oldestValid ? 'telemetry_unavailable'
      : withoutProgress >= warnAfter ? 'claim_gap' : 'within_grace',
    ready_wait_ms: readyWait,
    without_claim_progress_ms: worker ? withoutProgress : null,
    last_successful_claim_at: Number.isFinite(claimed) ? new Date(claimed).toISOString() : null,
    warn_after_ms: warnAfter,
    platform_dispatch_verified: false,
    worker_liveness_verified: false,
  };
}
