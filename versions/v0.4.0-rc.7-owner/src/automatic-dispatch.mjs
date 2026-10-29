import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readdirSync, chmodSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Agent, request } from 'undici';
import { loadConfig, localUrl, privateJson } from './config.mjs';
import { ExecutorPool, executorJobId } from './executor-pool.mjs';
import { readConversationSession, readPrivateDocument, readTaskLease, reserveTaskDirectory } from './task-file.mjs';
import { lockState } from './state-lock.mjs';
import { fail, integer } from './errors.mjs';
import { museRequestId } from './muse.mjs';
import { rejectPlaceholderFinal } from './reply-policy.mjs';

export const AUTOMATIC_PROTOCOL = 'muse-link-automatic-dispatch/v1';
const terminal = new Set(['done']);
const safeCode = (error) => /^[a-z][a-z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'automatic_local_failure';
const settingsDefaults = { poll_ms: 250, max_pending: 16, fast_greetings: true, max_hold_ms: 1800000 };

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('automatic_config', 'Use canonical absolute private paths.');
  return path;
}
function privateDirectory(path, create = false) {
  if (create && !existsSync(path)) { privateDirectory(dirname(path)); mkdirSync(path, { mode: 0o700 }); }
  for (let p = path; ; p = dirname(p)) {
    const stat = lstatSync(p);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (p === path && process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())))
      fail('automatic_private_path', 'Use an owned private directory without symlinks.');
    if (p === dirname(p)) break;
  }
}
export function loadAutomaticConfig(path) {
  const raw = readPrivateDocument(absolute(path));
  const required = ['bridge_config', 'session_file', 'pool_dir', 'state_dir'];
  if (!raw || Array.isArray(raw) || Object.keys(raw).some((k) => ![...required, 'reply_policy', ...Object.keys(settingsDefaults)].includes(k)))
    fail('automatic_config', 'Unknown automatic dispatcher setting.');
  if (raw.reply_policy !== 'rules_only') fail('automatic_config', 'Explicitly select reply_policy=rules_only; no second Muse review occurs.');
  for (const key of required) absolute(raw[key]);
  if (new Set(required.map((k) => raw[k])).size !== required.length) fail('automatic_config', 'Use separate state, mailbox, bridge and session paths.');
  const settings = { ...settingsDefaults, ...raw };
  integer(settings.poll_ms, 50, 2000, 'poll_ms'); integer(settings.max_pending, 2, 32, 'max_pending');
  integer(settings.max_hold_ms, 60000, 3600000, 'max_hold_ms');
  if (typeof settings.fast_greetings !== 'boolean') fail('automatic_config', 'fast_greetings must be boolean.');
  return settings;
}

// Exact greetings are actual answers, not progress placeholders. A saved
// preference disables this shortcut; tasks, attachments and recovered work do
// not qualify. This deliberately does not classify arbitrary short questions.
export function greetingAnswer(task) {
  if (task.kind === 'alert' || task.media?.length || task.media_errors?.length || task.voice_text
    || task.execution?.needs_review || task.execution?.steps?.length || task.completion?.state !== 'not_submitted'
    || !task.context || task.context_error || task.context.memory?.notes || task.context.memory?.notes_truncated
    || task.context.tasks?.some((row) => row.event_id === task.event_id)) return null;
  if (typeof task.text !== 'string' || task.text.length > 24) return null;
  return /^(?:你好|您好|嗨|哈喽|hi|hello)[\s!！。.,，?？]*$/iu.test(task.text.trim()) ? '你好，有什么可以帮你？' : null;
}

// This is a local queue consumer and publisher, NEVER a model runner or native
// task creator. Prestarted real Muse executors continue using the private
// mailbox. Only this process receives the NEW owner session and original leases.
export class AutomaticDispatcher {
  constructor(settings) {
    this.settings = settings;
    this.config = loadConfig(settings.bridge_config); this.endpoint = localUrl(this.config);
    if ([this.config.state_dir, settings.pool_dir].includes(settings.state_dir)) fail('automatic_config', 'Dispatcher storage must be separate from bridge and mailbox.');
    this.session = readConversationSession(settings.session_file, this.endpoint, this.config.path);
    privateDirectory(settings.pool_dir); privateDirectory(settings.state_dir, true);
    this.claims = join(settings.state_dir, 'claims'); privateDirectory(this.claims, true);
    this.references = join(settings.state_dir, 'references'); privateDirectory(this.references, true);
    this.work = new Map(); this.lastChecked = new Map(); this.claimUncertain = false; this.started = false; this.closed = false;
    try {
      // Lock by mailbox, not by user-selected journal directory. Different
      // state_dir values must not create two competing automatic publishers.
      this.unlock = lockState(join(settings.pool_dir, '.automatic-owner'));
      this.pool = new ExecutorPool(settings.pool_dir);
      this.scope = { config: this.config.path, session: settings.session_file, endpoint: this.endpoint };
      this.pool.bindOwner(this.scope);
      this.pool.transaction(() => {
        const prior = this.pool.db.prepare("SELECT value FROM pool_metadata WHERE key='automatic_state'").get();
        if (prior && prior.value !== settings.state_dir) fail('automatic_owner_scope', 'Use the original dispatcher journal.');
        if (!prior) this.pool.db.prepare("INSERT INTO pool_metadata VALUES ('automatic_state',?)").run(settings.state_dir);
      });
      const path = join(settings.state_dir, 'dispatcher.sqlite');
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.mode & 0o077)))
          fail('automatic_private_path', 'Dispatcher journal must be a private regular file.');
      }
      this.db = new DatabaseSync(path); chmodSync(path, 0o600);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      if (this.db.prepare('PRAGMA user_version').get().user_version > 1) fail('automatic_future_schema', 'Retain the newer automatic journal.');
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,value TEXT NOT NULL);
        PRAGMA user_version=1;`);
      const scope = JSON.stringify({ ...this.scope, pool: settings.pool_dir });
      const prior = this.meta('scope');
      if (prior && prior !== scope) fail('automatic_owner_scope', 'Use the original dispatcher config, session and mailbox.');
      this.setMeta('scope', scope);
      this.agent = new Agent({ connections: 6 });
      this.recoverClaims();
      this.setMeta('claim_uncertain', this.claimUncertain);
      const owned = new Set(this.records().map((r) => r.id));
      if (this.pool.db.prepare('SELECT event_id FROM jobs WHERE settled_ms IS NULL').all().some((row) => !owned.has(row.event_id)))
        fail('automatic_mailbox_handoff', 'Reconcile previous manual drafts before enabling automatic publication.');
    } catch (error) { this.db?.close(); this.pool?.close(); this.unlock?.(); throw error; }
  }
  meta(key) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  records() { return this.db.prepare('SELECT value FROM events').all().map((r) => JSON.parse(r.value)); }
  get(id) { const row = this.db.prepare('SELECT value FROM events WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; }
  save(record) {
    record.updated_ms = Date.now();
    this.db.prepare('INSERT INTO events VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record));
    return record;
  }
  addClaim(path, document) {
    if (document.claim_state !== 'response_saved' || document.endpoint !== this.endpoint || document.config_path !== this.config.path
      || !Array.isArray(document.tasks) || document.tasks.length > 1) fail('automatic_claim_file', 'Retain the original dispatcher claim for review.');
    for (const task of document.tasks) {
      readTaskLease(path, task.event_id, this.endpoint, this.config.path);
      const prior = this.get(task.event_id);
      if (prior) {
        // A second lease must never silently replace the original queued job.
        const original = readTaskLease(prior.file, task.event_id, this.endpoint, this.config.path);
        if (original !== task.lease_token) fail('automatic_lease_changed', 'Reconcile the original event lease and draft before replacement.');
        continue;
      }
      this.save({ id: task.event_id, file: path, phase: 'claimed', received_ms: Number.isFinite(Date.parse(task.received_at)) ? Date.parse(task.received_at) : null,
        claimed_ms: Date.now(), lease_until: task.lease_until, next_renew_ms: Date.now() + 300000 });
    }
  }
  recoverClaims() {
    for (const entry of readdirSync(this.claims, { withFileTypes: true })) {
      if (!entry.name.startsWith('claim.') || !entry.isDirectory()) continue;
      const file = join(this.claims, entry.name, 'task.json');
      const doc = readPrivateDocument(file);
      if (doc.claim_state === 'awaiting_response') { this.claimUncertain = true; continue; }
      this.addClaim(file, doc);
    }
  }
  task(record) {
    const lease = readTaskLease(record.file, record.id, this.endpoint, this.config.path);
    const task = readPrivateDocument(record.file).tasks.find((item) => item.event_id === record.id);
    return { task, body: { event_id: record.id, lease_token: lease } };
  }
  async api(path, body, { signal, missing = false } = {}) {
    const signals = [AbortSignal.timeout(6000), ...(signal ? [signal] : [])];
    const response = await request(this.endpoint + path, { dispatcher: this.agent, signal: AbortSignal.any(signals),
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.config.api_token}`,
        'X-Muse-Conversation': this.session, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) { response.body.destroy(); fail('automatic_response_limit', 'Local response exceeded its budget.'); } chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('automatic_invalid_response', 'Retain private records; local response is incomplete.'); }
    if (missing && response.statusCode === 404) return null;
    if (response.statusCode < 200 || response.statusCode >= 300) fail(safeCode({ code: value.error }), 'Local bridge rejected this automatic operation.', response.statusCode,
      { ...(typeof value.lease_reason === 'string' ? { lease_reason: value.lease_reason } : {}) });
    return value;
  }
  async start() {
    if (this.started && Date.now() - this.sessionRenewedMs < 60000) return;
    if (!this.started) {
      const status = this.pool.status();
      if (status.slots.length !== 2 || status.slots.some((slot) => !slot.runner)) fail('automatic_executors_unprepared', 'Start and bind both real Muse executors before running the dispatcher.');
    }
    // This only renews an original session, never creates or steals ownership.
    const probe = await this.api('/v1/muse/conversation/renew', {});
    if (probe.mode !== 'coordinator') fail('automatic_owner_required', 'Use a dedicated coordinator session.');
    this.sessionRenewedMs = Date.now();
    if (!this.started) this.setMeta('started_at', new Date().toISOString());
    this.started = true;
  }
  async intake(signal) {
    await this.start();
    if (this.claimUncertain || this.records().filter((r) => !terminal.has(r.phase)).length >= this.settings.max_pending) return false;
    this.prune();
    if (this.records().length >= 2000) fail('automatic_journal_full', 'Archive reviewed private records before accepting more events.');
    const handoff = reserveTaskDirectory(this.claims, this.endpoint, this.config.path);
    let responseSaved = false;
    try {
      const result = await this.api('/v1/muse/tasks?limit=1&lease=30m&wait=1s&with_context=true&context_mode=compact', undefined, { signal });
      handoff.save(result); responseSaved = true;
      this.addClaim(handoff.path, readPrivateDocument(handoff.path));
      handoff.discardEmpty();
      return result.tasks.length > 0;
    } catch (error) {
      // Never repeat an ambiguous claim: its lease may exist without a token.
      if (!responseSaved) { this.claimUncertain = true; this.setMeta('claim_uncertain', true); }
      throw error;
    } finally { handoff.close(); }
  }
  async context(record, body) {
    return this.api('/v1/muse/conversation/context', { ...body, context_mode: 'compact' });
  }
  prune() {
    if (Date.now() - (this.lastPrune ?? 0) < 3600000) return;
    this.lastPrune = Date.now();
    const cutoff = Date.now() - 7 * 86400000;
    for (const record of this.records().filter((r) => r.phase === 'done' && Date.parse(r.accepted_at ?? '') < cutoff).slice(0, 100)) {
      // Only remove the exact private response file owned by this journal,
      // after final acceptance and retention. Never glob or recursively delete.
      if (dirname(dirname(record.file)) !== this.claims) fail('automatic_claim_file', 'Unexpected claim location during retention.');
      if (existsSync(record.file)) {
        const doc = readPrivateDocument(record.file), folder = dirname(record.file);
        if (doc.endpoint !== this.endpoint || doc.config_path !== this.config.path || doc.tasks?.length !== 1 || doc.tasks[0].event_id !== record.id
          || readdirSync(folder).length !== 1 || lstatSync(record.file).nlink !== 1) continue;
        unlinkSync(record.file); rmdirSync(folder);
      }
      if (record.reference_file && existsSync(record.reference_file)) {
        if (record.reference_file !== join(this.references, executorJobId(record.id) + '.json')) fail('automatic_claim_file', 'Unexpected context reference location.');
        const ref = readPrivateDocument(record.reference_file);
        if (ref.event_id !== record.id || lstatSync(record.reference_file).nlink !== 1) continue;
        unlinkSync(record.reference_file);
      }
      this.db.prepare('DELETE FROM events WHERE id=?').run(record.id); this.lastChecked.delete(record.id);
    }
  }
  async setTask(record, body, state) {
    const context = await this.context(record, body);
    const current = context.tasks.find((r) => r.event_id === record.id);
    if (current && (current.detail.kind !== 'chat' || current.detail.summary !== 'Automatic text mailbox'))
      fail('automatic_task_review', 'This event belongs to another operation.');
    if (current?.state === state) return;
    await this.api('/v1/muse/conversation/task', { ...body, revision: current?.revision ?? 0, state,
      detail: { kind: 'chat', summary: 'Automatic text mailbox' } });
  }
  async notice(record, body, text) {
    if (!record.notice) { record.notice = text; this.save(record); }
    if (record.notice_sent) return;
    await this.api('/v1/muse/replies', { ...body, mode: 'progress', reply_id: 'automatic-handoff-v1', text: record.notice, async: true });
    // A durable asynchronous submission is not phone delivery or final ack.
    record.notice_sent = true; this.save(record);
  }
  async process(record) {
    if (terminal.has(record.phase)) return;
    const { task, body } = this.task(record);
    const receiptId = museRequestId(record.id);
    if (['attention', 'handoff'].includes(record.phase)) {
      const receipt = await this.api('/v1/requests/' + receiptId, undefined, { missing: true });
      if (receipt?.state === 'accepted') {
        if (record.job) {
          const draft = this.pool.inspect(record.job);
          if (!['ready', 'failed'].includes(draft.state)) fail('automatic_unsettled_draft', 'The manually completed event still has an unfinished native draft.');
          this.pool.settle(record.job);
        }
        record.phase = 'done'; record.accepted_at = receipt.result?.accepted_at ?? null;
        delete record.answer; this.save(record); return;
      }
    }
    if (['publishing', 'sending'].includes(record.phase)) {
      const receipt = await this.api('/v1/requests/' + receiptId, undefined, { missing: true });
      if (receipt?.state === 'accepted') {
        if (record.job) this.pool.settle(record.job);
        record.phase = 'done'; record.accepted_at = receipt.result?.accepted_at ?? null;
        delete record.answer; this.save(record); return;
      }
      if (receipt && receipt.state !== 'pending') fail('automatic_send_review', 'Retain the original intent; its delivery outcome needs review.');
      if (receipt) {
        if (Date.now() - record.claimed_ms > this.settings.max_hold_ms) {
          record.phase = 'attention'; record.error = 'automatic_pending_deadline'; this.save(record); return;
        }
        if (record.next_renew_ms <= Date.now() && Date.now() - record.claimed_ms <= this.settings.max_hold_ms) {
          const renewal = await this.api('/v1/muse/renew', { ...body, lease_ms: 1800000 });
          record.lease_until = renewal.lease_until; record.next_renew_ms = Date.now() + 300000; this.save(record);
        }
        return;
      }
      // No intent exists: submit the exact durably saved answer with the same
      // automatic request ID. An existing unknown/rejected intent is never retried.
      record.submission_started_ms ??= Date.now(); this.save(record);
      await this.api('/v1/muse/replies', { ...body, text: record.answer, async: true, model_ready_at: record.answer_ready_ms });
      record.phase = 'sending'; record.submitted_ms ??= Date.now(); this.save(record); return;
    }
    if (Date.now() - record.claimed_ms > this.settings.max_hold_ms) {
      record.phase = 'attention'; record.error = 'automatic_hold_deadline'; this.save(record); return;
    }
    if (record.next_renew_ms <= Date.now()) {
      const renewal = await this.api('/v1/muse/renew', { ...body, lease_ms: 1800000 });
      record.lease_until = renewal.lease_until; record.next_renew_ms = Date.now() + 300000; this.save(record);
    }
    if (record.phase === 'attention') {
      if (['placeholder_final_reply', 'reply_contains_credential', 'reply_contains_internal_narration', 'automatic_empty_answer'].includes(record.error))
        await this.notice(record, body, '这条消息尚未得到可发送的有效答案，仍需继续处理；其他文字消息可以继续发送。');
      return;
    }
    if (record.phase === 'handoff') {
      if (task.kind !== 'alert') await this.notice(record, body, '这条任务需要在 Muse 中继续处理，当前自动通道尚未完成；其他文字消息可以继续发送。');
      return;
    }
    if (record.phase === 'claimed') {
      if (task.kind === 'alert' || task.media?.length || task.execution?.needs_review || task.execution?.steps?.length || task.completion?.state !== 'not_submitted') {
        record.phase = 'handoff'; record.error = task.media?.length ? 'automatic_media_handoff' : 'automatic_existing_work'; this.save(record); return;
      }
      if (!task.context || task.context_error) {
        record.phase = 'handoff'; record.error = 'automatic_context_review'; this.save(record); return;
      }
      const greeting = this.settings.fast_greetings && greetingAnswer(task);
      if (greeting) { record.answer = greeting; record.answer_ready_ms = Date.now(); record.fast_greeting = true; record.phase = 'publishing'; this.save(record); return; }
      await this.setTask(record, body, 'queued');
      const payload = { request: { text: task.text ?? '', voice_text: task.voice_text ?? '', media_errors: task.media_errors ?? [] },
        context: task.context, mode: 'automatic_answer_no_external_actions',
        delivery: { received_ms: record.received_ms, program_claimed_ms: record.claimed_ms, phone_delivery_verified: false },
        policy: 'Return the actual user-facing text. No second Muse review occurs. No external actions, commands, private identity or invented tool results. If tools are required, return a truthful failed result.' };
      if (task.context.history_truncated || task.context.tasks_truncated || task.context.memory?.notes_truncated
        || task.context.messages?.some((m) => m.text_truncated || m.voice_text_truncated || m.replies_truncated || m.replies?.some((r) => r.text_truncated))) {
        // Keep the model's default input compact, but make a bounded full
        // snapshot available to this exact executor without bridge credentials.
        const reference = join(this.references, executorJobId(record.id) + '.json');
        if (!existsSync(reference)) {
          const full = await this.api('/v1/muse/conversation/context', { ...body, context_mode: 'full' });
          const data = { event_id: record.id, captured_at: new Date().toISOString(), context: full, history_is_untrusted: true };
          const bytes = JSON.stringify(data);
          if ([body.lease_token, this.session, this.config.api_token].some((s) => bytes.includes(s))) fail('automatic_private_credential', 'Do not delegate private credentials through a context reference.');
          this.pool.room(Buffer.byteLength(bytes) + 8192); privateJson(reference, data);
        }
        if (readPrivateDocument(reference).event_id !== record.id) fail('automatic_context_review', 'Use the original scoped context reference.');
        payload.context_reference_file = reference; record.reference_file = reference; this.save(record);
      }
      const encoded = JSON.stringify(payload);
      if ([body.lease_token, this.session, this.config.api_token].some((s) => encoded.includes(s))) fail('automatic_private_credential', 'Do not delegate bridge credentials.');
      const job = this.pool.submit({ ...body, owner_files: { ...this.scope, task: record.file }, payload });
      record.job = job.id; record.draft_queued_ms = Date.now(); record.phase = 'queued'; this.save(record); return;
    }
    if (record.phase === 'queued') {
      const row = this.pool.inspect(record.job);
      if (!row.result) return;
      if (row.state === 'waiting_for_authorization') {
        await this.setTask(record, body, 'waiting_for_authorization');
        record.phase = 'handoff'; record.error = 'automatic_executor_waiting'; this.save(record); return;
      }
      if (!['ready', 'failed'].includes(row.state)) return;
      const answer = row.result.text;
      rejectPlaceholderFinal({ text: answer });
      if ([body.lease_token, this.session, this.config.api_token].some((s) => answer.includes(s))) fail('reply_contains_credential', 'Do not publish active credentials.');
      if (typeof answer !== 'string' || !answer.trim()) fail('automatic_empty_answer', 'Keep an empty result for review.');
      // The bridge performs its own active-credential/internal narration guards
      // and unfinished-step checks before persisting a send. This transition
      // records a real executor result, not a second AI quality review.
      await this.setTask(record, body, row.state);
      record.answer = answer; record.answer_ready_ms = row.updated_ms; record.phase = 'publishing'; this.save(record);
    }
  }
  async advance(record) {
    try { await this.process(record); }
    catch (error) {
      record.error = safeCode(error); record.next_check_ms = Date.now() + 2000;
      if (['stale_lease', 'conversation_owner_required', 'conversation_revision_conflict', 'conversation_task_finished', 'automatic_task_review',
        'automatic_send_review', 'placeholder_final_reply', 'reply_contains_credential', 'reply_contains_internal_narration',
        'task_step_uncertain', 'executor_lease_changed', 'automatic_private_credential', 'automatic_empty_answer',
        'automatic_context_review', 'automatic_unsettled_draft'].includes(record.error)) record.phase = 'attention';
      this.save(record);
    }
  }
  async tick() {
    if (Date.now() - (this.lastHeartbeat ?? 0) >= 5000) {
      this.setMeta('heartbeat_at', new Date().toISOString()); this.lastHeartbeat = Date.now();
    }
    const ready = new Set(this.pool.results().map((row) => row.id));
    const priority = (r) => r.phase === 'claimed' || (r.phase === 'queued' && ready.has(r.job)) ? 0 : 1;
    for (const row of this.records().sort((a, b) => priority(a) - priority(b) || (this.lastChecked.get(a.id) ?? 0) - (this.lastChecked.get(b.id) ?? 0))) {
      if (this.work.size >= 4) break;
      if (terminal.has(row.phase) || this.work.has(row.id) || (row.next_check_ms ?? 0) > Date.now()) continue;
      this.lastChecked.set(row.id, Date.now());
      const pending = this.advance(row).catch((error) => {
        // Persistence failure must stop admission, not become an unhandled
        // promise or leave an unjournaled automatic publisher running.
        this.fatalError = error; this.runController?.abort();
      }).finally(() => this.work.delete(row.id));
      this.work.set(row.id, pending);
    }
  }
  status() {
    const rows = this.records();
    return { protocol: AUTOMATIC_PROTOCOL, mode: 'automatic_text', native_liveness_verified: false,
      heartbeat_at: this.meta('heartbeat_at') ?? null, claim_uncertain: this.claimUncertain,
      states: Object.fromEntries([...new Set(rows.map((r) => r.phase))].map((state) => [state, rows.filter((r) => r.phase === state).length])),
      accepted_replies: rows.filter((r) => r.phase === 'done').length, fast_greetings: rows.filter((r) => r.phase === 'done' && r.fast_greeting).length,
      errors: [...new Set([...rows.map((r) => r.error), this.meta('intake_error')].filter(Boolean))],
      executors: this.pool.status().slots.map(({ id, activity_ms, runner }) => ({ slot: id, bound: !!runner, activity_ms })) };
  }
  async run(signal) {
    await this.start();
    this.runController = new AbortController();
    const stop = () => this.runController.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const stopped = () => this.runController.signal.aborted;
    const intake = async () => {
      while (!stopped()) {
        // Let the at-most-one-second poll finish on graceful shutdown, so an
        // intentional SIGTERM does not turn a saved claim into an ambiguity.
        try { if (!await this.intake()) await pause(this.settings.poll_ms); }
        catch (error) { if (!stopped()) this.setMeta('intake_error', safeCode(error)); await pause(this.settings.poll_ms); }
      }
    };
    const maintain = async () => { while (!stopped()) { await this.tick(); await pause(this.settings.poll_ms); } };
    this.loops = [intake(), maintain()];
    try { await Promise.all(this.loops); }
    finally {
      stop(); await Promise.allSettled(this.loops); await Promise.allSettled(this.work.values());
      signal?.removeEventListener('abort', stop);
    }
    if (this.fatalError) throw this.fatalError;
  }
  async close() {
    if (this.closed) return; this.closed = true;
    this.runController?.abort(); await Promise.allSettled(this.loops ?? []);
    await Promise.allSettled(this.work.values());
    await this.agent?.close(); this.db?.close(); this.pool?.close(); this.unlock?.();
  }
}

export function automaticStatus(settings) {
  privateDirectory(settings.state_dir);
  const path = join(settings.state_dir, 'dispatcher.sqlite');
  if (!existsSync(path)) return { protocol: AUTOMATIC_PROTOCOL, installed: false };
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || (process.platform !== 'win32' && (s.mode & 0o077))) fail('automatic_private_path', 'Use the original private journal.');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT value FROM events').all().map((r) => JSON.parse(r.value));
    return { protocol: AUTOMATIC_PROTOCOL, installed: true, mode: 'automatic_text', native_liveness_verified: false,
      heartbeat_at: db.prepare("SELECT value FROM metadata WHERE key='heartbeat_at'").get()?.value ?? null,
      claim_uncertain: db.prepare("SELECT value FROM metadata WHERE key='claim_uncertain'").get()?.value === 'true',
      states: Object.fromEntries([...new Set(rows.map((r) => r.phase))].map((state) => [state, rows.filter((r) => r.phase === state).length])),
      accepted_replies: rows.filter((r) => r.phase === 'done').length,
      errors: [...new Set([...rows.map((r) => r.error), db.prepare("SELECT value FROM metadata WHERE key='intake_error'").get()?.value].filter(Boolean))] };
  } finally { db.close(); }
}
