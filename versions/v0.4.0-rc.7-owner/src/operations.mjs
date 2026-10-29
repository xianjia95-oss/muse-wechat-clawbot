import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { operational } from './config.mjs';
import { consumerProgress } from './worker-progress.mjs';
import { fail } from './errors.mjs';

export function treeBytes(directory) {
  let size = 0;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    let info;
    try { info = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) fail('unsafe_state', 'State directory must not contain symbolic links.', 503);
    size += info.isDirectory() ? treeBytes(path) : info.size;
  }
  return size;
}

export class Resources {
  constructor(config, inspect) { this.config = config; this.reserved = 0; this.inspectOverride = inspect; }
  inspect() {
    if (this.inspectOverride) return this.inspectOverride();
    const disk = statfsSync(this.config.state_dir);
    let outbox = 0;
    try { outbox = treeBytes(join(this.config.state_dir, 'outbox')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { free_bytes: disk.bavail * disk.bsize, state_bytes: treeBytes(this.config.state_dir), outbox_bytes: outbox };
  }
  check(extra = 0, media = false) {
    const limits = operational(this.config);
    const value = this.inspect();
    const required = extra + this.reserved;
    if (value.free_bytes - required < limits.min_free_bytes || value.state_bytes + required > limits.max_state_bytes ||
        (media && value.outbox_bytes + required > limits.max_outbox_bytes)) {
      fail('storage_pressure', 'Storage capacity threshold reached; free space or archive state before retrying.', 507);
    }
    return value;
  }
  reserve(bytes) {
    this.check(bytes, true);
    this.reserved += bytes;
    let released = false;
    return () => { if (!released) { this.reserved -= bytes; released = true; } };
  }
}

export function health(bridge) {
  const limits = operational(bridge.config);
  const status = bridge.status();
  const queue = status.queue;
  const consumer = consumerProgress(queue, status.worker, limits.worker_claim_warn_ms);
  const problems = [];
  if (bridge.stopping) problems.push('shutting_down');
  if (bridge.store.get('restore_review_required', false)) problems.push('restore_review_required');
  if (!status.simulation_mode && !status.logged_in) problems.push('not_logged_in');
  const last = Date.parse(status.poll.last_ok_at ?? '');
  if (!status.simulation_mode && (!Number.isFinite(last) || Date.now() - last > limits.poll_stale_ms || !['waiting', 'ok'].includes(status.poll.state) || status.poll.error)) problems.push('wechat_poll_unhealthy');
  if (queue.oldest_ready_ms !== null && Date.now() - queue.oldest_ready_ms > limits.backlog_warn_ms) problems.push('worker_backlog');
  if (consumer.state === 'claim_gap') problems.push('worker_claim_gap');
  if (queue.stalled_leases) problems.push('worker_lease_stalled');
  if (queue.pending >= limits.max_pending_events) problems.push('inbox_capacity');
  if (queue.unknown_sends) problems.push('send_outcome_unknown');
  if (queue.unresolved_steps) problems.push('task_step_needs_review');
  if (bridge.config.require_lease_token === false) problems.push('legacy_worker_protocol');
  let storage;
  try { storage = bridge.resources.check(0, true); } catch (error) { problems.push(error.code ?? 'storage_check_failed'); }
  return { healthy: problems.length === 0, problems, queue, storage, consumer, ...status };
}
