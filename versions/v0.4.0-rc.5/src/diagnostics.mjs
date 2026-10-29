const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));

// Select only operational metadata: never forward task bodies, lease tokens,
// credentials, tool results or arbitrary request/response objects.
export function deliveryDiagnostics({ status = {}, readiness = {}, metrics = {} }, now = Date.now()) {
  const queue = pick(status.queue ?? readiness.queue, ['pending', 'ready', 'leased', 'oldest_ready_ms', 'oldest_pending_ms', 'next_lease_expiry_ms', 'stalled_leases', 'oldest_lease_activity_ms', 'started_steps', 'unresolved_steps', 'unknown_sends']);
  queue.ready ??= Math.max(0, (queue.pending ?? 0) - (queue.leased ?? 0));
  const worker = pick(status.worker, ['since', 'claim_requests', 'claimed_events', 'last_claim_at', 'last_task_at', 'reply_requests', 'last_reply_at', 'last_ingest_at']);
  if (status.worker?.last_api_error) worker.last_api_error = pick(status.worker.last_api_error, ['at', 'action', 'code', 'status', 'lease_reason', 'lease_until', 'acked_ms', 'server_time']);
  const findings = [];
  const add = (code, next) => { if (!findings.some((finding) => finding.code === code)) findings.push({ code, next }); };
  if (queue.ready > 0) add('ready_tasks_waiting_for_worker', '消息已入库但尚未领取：检查 Muse hook 是否启用、实际检测间隔及 worker 的领取命令/退出码。');
  if (queue.leased > 0) add('tasks_already_leased', '存在已领取任务，不代表已回复；检查原 worker 是否仍执行、保存的 token 和租约截止时间，不要盲目清租约重做工具。');
  if (queue.stalled_leases > 0) add('worker_lease_stalled', '已领取任务长期没有续租或 checkpoint 活动；核对原 worker 与工具后交接，不自动清租约或重做工具。');
  if (queue.started_steps > 0) add('tool_steps_pending', '存在 started 工具步骤；保存实际工具结果并正确写 completed，遗留结果需先核对。');
  if (worker.last_api_error) add('worker_api_rejected', `最近 worker 调用被拒绝（${worker.last_api_error.code}${worker.last_api_error.lease_reason ? '/' + worker.last_api_error.lease_reason : ''}），结合时间和 action 检查 token、步骤及升级指令。`);
  if (status.inflight_sends > 0) add('outbound_work_inflight', '回复已提交桥：查看 delivery 的排队、准备、上传和发送数量及 oldest_inflight_ms。');
  if (queue.pending === 0) add('no_pending_tasks', '当前没有未完成消息；用一条新测试消息观察接收日志、白名单、hook 和回复提交，不能据此断言手机已收到。');
  for (const code of readiness.problems ?? []) add(code, '查看 health 的对应故障；不要绕过恢复核对、未知发送或工具步骤保护。');
  return {
    mode: 'read_only_delivery_diagnostics', at: new Date(now).toISOString(),
    version: status.version ?? readiness.version, logged_in: status.logged_in ?? readiness.logged_in,
    poll: pick(status.poll ?? readiness.poll, ['state', 'last_ok_at', 'error']),
    queue: { ...queue, next_lease_expiry_in_ms: queue.next_lease_expiry_ms == null ? null : Math.max(0, queue.next_lease_expiry_ms - now) },
    worker, worker_telemetry_available: !!status.worker,
    inflight_sends: status.inflight_sends,
    delivery: pick(status.delivery, ['queued', 'preparing', 'uploading', 'sending', 'oldest_inflight_ms']),
    metrics: pick(metrics, ['window_requests', 'states', 'accepted_latency_ms', 'first_chunk_ms']),
    findings, phone_delivery_verified: false,
  };
}
