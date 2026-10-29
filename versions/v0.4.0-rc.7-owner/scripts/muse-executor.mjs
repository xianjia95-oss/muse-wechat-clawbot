#!/usr/bin/env node
// Mailbox client for prestarted REAL Muse tasks. This script never calls a
// model, starts a native task, sends a WeChat reply or acknowledges an event.
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { Agent, request } from 'undici';
import { ExecutorPool } from '../src/executor-pool.mjs';
import { loadConfig, expand, localUrl } from '../src/config.mjs';
import { readPrivateDocument, readTaskLease, readConversationSession, reserveTaskFile, reserveTaskDirectory } from '../src/task-file.mjs';
import { museRequestId } from '../src/muse.mjs';
import { fail, duration, integer } from '../src/errors.mjs';

process.umask(0o077);
const print = (value) => console.log(JSON.stringify(value));
let pool, phase = 'validate_input';
async function input() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) fail('executor_result_limit', 'Result exceeds 64 KiB.');
  }
  return text.replace(/[\r\n]+$/, '');
}
async function api(config, path, body) {
  const agent = new Agent({ connections: 1 });
  try {
    const response = await request(localUrl(config) + path, { dispatcher: agent, signal: AbortSignal.timeout(5000),
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${config.api_token}`,
        'X-Muse-Conversation': config.conversationSessionToken, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let size = 0, chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) fail('executor_bridge_response_limit', 'Bridge response exceeded its budget.');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (response.statusCode !== 200) fail('executor_bridge_rejected', 'Retain the original task and inspect the bridge privately.', response.statusCode, {
      ...(typeof value.error === 'string' && /^[a-z]+(?:_[a-z]+){1,8}$/.test(value.error) ? { bridge_error: value.error } : {}),
      ...(['missing_token', 'event_not_found', 'event_acknowledged', 'lease_expired', 'token_mismatch'].includes(value.lease_reason) ? { lease_reason: value.lease_reason } : {}),
    });
    return value;
  } finally { await agent.close(); }
}
try {
  const { values: v, positionals: p } = parseArgs({ allowPositionals: true, options: {
    dir: { type: 'string' }, config: { type: 'string' }, 'session-file': { type: 'string' }, 'task-file': { type: 'string' },
    'event-id': { type: 'string' }, 'worker-file': { type: 'string' }, 'claim-file': { type: 'string' },
    slot: { type: 'string' }, runner: { type: 'string' }, output: { type: 'string' }, 'output-dir': { type: 'string' },
    id: { type: 'string' }, state: { type: 'string' }, text: { type: 'string' }, wait: { type: 'string' }, reviewed: { type: 'boolean' },
  } });
  const action = p[0];
  if (p.length !== 1 || !['register', 'submit', 'status', 'results', 'inspect', 'settle', 'cancel', 'recover', 'take', 'finish'].includes(action))
    fail('executor_usage', 'Use register/submit/status/results/inspect/settle/cancel/recover (owner), take/finish (executor).');
  const workerAction = ['take', 'finish'].includes(action);
  let config, endpoint, sessionPath, worker;
  if (workerAction) {
    if (v.config || v['session-file'] || v['task-file'] || v.dir) fail('executor_credential_scope', 'Executors use only their worker file and draft claim.');
    worker = readPrivateDocument(expand(v['worker-file'] ?? ''));
    if (worker.claim_state !== 'response_saved' || worker.kind !== 'muse_executor_slot' || worker.endpoint !== 'muse-executor') fail('executor_worker_file', 'Use the original private slot file.');
    phase = 'open_mailbox'; pool = new ExecutorPool(worker.pool_dir);
  } else {
    if (!v.config || !v['session-file'] || !v.dir) fail('executor_owner_files', 'Supply --config, --session-file and --dir.');
    config = loadConfig(expand(v.config)); endpoint = localUrl(config); sessionPath = expand(v['session-file']);
    config.conversationSessionToken = readConversationSession(sessionPath, endpoint, config.path);
    const probe = await api(config, '/v1/muse/conversation/probe', {});
    if (probe.mode !== 'coordinator' || !probe.owner_active || !probe.recovery_allowed) fail('executor_owner_inactive', 'Renew the original session or reconcile recovery before using the mailbox.');
    phase = 'open_mailbox'; pool = new ExecutorPool(expand(v.dir));
    pool.bindOwner({ config: config.path, session: sessionPath, endpoint }, v.reviewed === true);
  }
  phase = action;
  const original = (id) => {
    const row = pool.inspect(id), files = row.owner_files;
    if (files.config !== config.path || files.session !== sessionPath || files.endpoint !== endpoint) fail('executor_owner_scope', 'Use the original owner config, session and task files.');
    return row;
  };
  if (action === 'register') {
    if (!v['worker-file']) fail('executor_worker_file', 'Supply a new private --worker-file.');
    const handoff = reserveTaskFile(expand(v['worker-file']), 'muse-executor', null);
    try {
      const result = pool.register(Number(v.slot));
      handoff.save({ ...result, kind: 'muse_executor_slot' });
      print({ slot: result.slot, worker_file: expand(v['worker-file']), native_task_started: false });
    } finally { handoff.close(); }
  } else if (action === 'submit') {
    if (!v['task-file'] || !v['event-id']) fail('executor_task_file', 'Use the original event and --task-file.');
    const taskPath = expand(v['task-file']), lease = readTaskLease(taskPath, v['event-id'], endpoint, config.path);
    const document = readPrivateDocument(taskPath), task = document.tasks.find((item) => item.event_id === v['event-id']);
    if (task.media?.length) fail('executor_media_task', 'Use the owner actual multimodal tools; this mailbox accepts text drafts only.');
    if (task.kind === 'alert' || task.execution?.needs_review || task.completion?.state !== 'not_submitted')
      fail('executor_task_review', 'Reconcile alerts, unfinished effects and existing final sends first.');
    const body = { event_id: v['event-id'], lease_token: lease };
    const context = await api(config, '/v1/muse/conversation/context', body);
    const prior = context.tasks.find((item) => item.event_id === v['event-id']);
    if (prior && (prior.state !== 'queued' || prior.detail.kind !== 'chat' || prior.detail.summary !== 'Muse draft mailbox'))
      fail('executor_task_review', 'This event already has a different operation; reconcile it first.');
    const payload = { request: { text: task.text ?? '', voice_text: task.voice_text ?? '', media_errors: task.media_errors ?? [] },
      context, mode: 'draft_only_no_external_actions' };
    const encoded = JSON.stringify(payload);
    if ([lease, config.conversationSessionToken, config.api_token].some((secret) => encoded.includes(secret)))
      fail('executor_private_credential', 'Remove bridge credentials from the scoped input before delegation.');
    // Fence premature final/ack BEFORE the separate mailbox write. A crash here
    // leaves queued evidence and the original claim, never a lost event.
    if (!prior) await api(config, '/v1/muse/conversation/task', { ...body, revision: 0, state: 'queued', detail: { kind: 'chat', summary: 'Muse draft mailbox' } });
    const result = pool.submit({ ...body, owner_files: { config: config.path, session: sessionPath, task: taskPath, endpoint }, payload });
    print(result);
  } else if (action === 'status') print(pool.status());
  else if (action === 'results') print({ results: pool.results() });
  else if (action === 'inspect') print(original(v.id));
  else if (action === 'cancel') { original(v.id); print(pool.cancel(v.id)); }
  else if (action === 'settle') {
    const row = original(v.id), receipt = await api(config, `/v1/requests/${encodeURIComponent(museRequestId(row.event_id))}`);
    if (receipt.state !== 'accepted') fail('executor_final_not_accepted', 'Keep the draft until the original final request is accepted.');
    print(pool.settle(v.id));
  } else if (action === 'take' || action === 'recover') {
    if (Boolean(v.output) === Boolean(v['output-dir'])) fail('executor_output', 'Choose a new --output or private --output-dir.');
    const root = action === 'take' ? worker.pool_dir : pool.root;
    phase = 'reserve_draft_file';
    const managed = v['output-dir'] ? reserveTaskDirectory(expand(v['output-dir']), 'muse-executor', null) : null;
    const file = managed ?? reserveTaskFile(expand(v.output), 'muse-executor', null);
    const path = managed?.path ?? expand(v.output);
    let workerHandoff;
    try {
      // Reserve both outputs before rotating anything. A lost response is
      // reconciled through the retained reservations, never automatic replay.
      if (action === 'recover' && v['worker-file']) {
        phase = 'reserve_worker_file';
        workerHandoff = reserveTaskFile(expand(v['worker-file']), 'muse-executor', null);
      }
      const deadline = Date.now() + integer(duration(v.wait, 0), 0, 35000, 'wait');
      let result;
      do {
        phase = 'claim_draft';
        result = action === 'take' ? pool.take(worker.slot, worker.worker_token, v.runner)
          : pool.recover(Number(v.slot), v.runner, v.reviewed === true, { rotateWorker: !!workerHandoff });
        if (result.task || result.recovery_required || action === 'recover' || Date.now() >= deadline) break;
        await pause(Math.min(1000, deadline - Date.now()));
      } while (true);
      const { worker: rotatedWorker, ...claimResult } = result;
      if (rotatedWorker) {
        phase = 'save_worker_file';
        workerHandoff.save(rotatedWorker);
      }
      phase = 'save_draft_claim';
      file.save({ kind: 'muse_executor_claim', pool_dir: root, slot: action === 'take' ? worker.slot : Number(v.slot), runner: v.runner,
        ...claimResult, tasks: result.task ? [result.task] : [] });
      phase = 'discard_confirmed_empty';
      const discarded = managed?.discardEmpty() ?? false;
      print({ task_available: !!result.task, claim_file: discarded ? null : path, recovery_required: result.recovery_required ?? false,
        ...(result.active_job ? { active_job: result.active_job, state: result.state } : {}),
        ...(rotatedWorker ? { worker_file: expand(v['worker-file']) } : {}) });
    } finally { workerHandoff?.close(); file.close(); }
  } else if (action === 'finish') {
    if (v.text !== '-' || !v['claim-file']) fail('executor_result_input', 'Use --claim-file and --text - for the actual result.');
    const claim = readPrivateDocument(expand(v['claim-file']));
    if (claim.claim_state !== 'response_saved' || claim.kind !== 'muse_executor_claim' || claim.pool_dir !== worker.pool_dir
      || claim.slot !== worker.slot || claim.runner !== v.runner || !claim.task) fail('executor_claim_file', 'Use this executor original private draft claim.');
    print(pool.finish(worker.slot, worker.worker_token, v.runner, claim.task.id, claim.task.claim_token, v.state, { text: await input() }));
  }
} catch (error) {
  const safe = typeof error.code === 'string' && /^(executor_[a-z_]+|invalid_[a-z_]+|unsafe_[a-z_]+|stale_executor_claim)$/.test(error.code);
  const storageCode = ['ERR_SQLITE_ERROR', 'EBUSY', 'EACCES', 'EPERM', 'EEXIST', 'ENOENT', 'ENOSPC'].includes(error.code) ? error.code : undefined;
  console.error(JSON.stringify({ error: safe ? error.code : 'executor_failed', phase,
    ...(storageCode ? { storage_code: storageCode } : {}), ...(Number.isInteger(error.errcode) ? { sqlite_code: error.errcode } : {}),
    ...(error.code === 'executor_bridge_rejected' ? error.details : {}),
    action: 'retain_original_files_and_inspect_privately' }));
  process.exitCode = 1;
} finally { pool?.close(); }
