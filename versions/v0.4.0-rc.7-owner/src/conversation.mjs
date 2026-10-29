import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fail, integer } from './errors.mjs';
import { operational } from './config.mjs';

const ownerKey = 'conversation_control';
const ownerTtl = 300000;
export const CONVERSATION_LIMITS = Object.freeze({ background_active: 2, held_events: 32 });
const states = new Set(['queued', 'running', 'waiting_for_authorization', 'ready', 'failed', 'cancelled']);
const finished = new Set(['ready', 'failed', 'cancelled']);
const text = (value, max) => typeof value === 'string' && Buffer.byteLength(value) <= max;

export function contextMode(value, fallback = 'full') {
  const mode = value ?? fallback;
  if (!['compact', 'full'].includes(mode)) fail('invalid_context_mode', 'context_mode must be compact or full.');
  return mode;
}
function excerpt(value, budget) {
  if (Buffer.byteLength(JSON.stringify(value)) <= budget + 2) return value;
  const points = Array.from(value);
  let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(points.slice(0, mid).join(''))) <= budget + 2) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join('');
}

// One durable conversation owner, with background work represented separately.
// This coordinates clients; it is not a sandbox against processes of the same UID.
export class Conversation {
  constructor(bridge) { this.bridge = bridge; this.claiming = false; }
  get store() { return this.bridge.store; }
  get enabled() { return this.store.get(ownerKey)?.enabled === true; }
  status() {
    const owner = this.store.get(ownerKey);
    return { mode: owner?.enabled ? 'coordinator' : 'legacy_workers',
      owner_active: !!owner?.token && owner.until > Date.now(),
      owner_expires_at: owner?.token ? new Date(owner.until).toISOString() : null,
      limits: CONVERSATION_LIMITS,
      context: { claim_default: 'compact', modes: ['compact', 'full'], compact_max_bytes: 16384 } };
  }
  start() {
    if (this.bridge.stopping || this.bridge.maintaining) fail('unavailable', 'Service is draining or performing maintenance.', 503);
    if (this.store.get('restore_review_required', false)) fail('restore_review_required', 'Reconcile restored state before opening a conversation.', 409);
    this.bridge.resources.check(4096);
    return this.store.transaction(() => {
      const prior = this.store.get(ownerKey);
      if (prior?.token && prior.until > Date.now()) fail('conversation_owned', 'A conversation owner is already active. Use its private session file.', 409);
      if (this.store.queueStats().leased || this.bridge.inflight.size) fail('conversation_handoff_required', 'Drain or safely reconcile existing leases and sends before changing the owner. Do not clear leases.', 409);
      const owner = { enabled: true, token: randomBytes(32).toString('hex'), until: Date.now() + ownerTtl };
      // Older bridges do not enforce the owner fence. Mark opt-in databases so
      // their existing future-schema check refuses an unsafe code-only rollback.
      this.store.db.exec('PRAGMA user_version=2');
      this.store.set(ownerKey, owner);
      return { mode: 'coordinator', session_token: owner.token, owner_expires_at: new Date(owner.until).toISOString(), limits: CONVERSATION_LIMITS };
    });
  }
  require(token, allowExpired = false, touch = true) {
    const owner = this.store.get(ownerKey);
    if (!owner?.enabled) return;
    const valid = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && typeof owner.token === 'string'
      && timingSafeEqual(Buffer.from(token), Buffer.from(owner.token));
    if (!valid || (!allowExpired && owner.until <= Date.now())) fail('conversation_owner_required', 'Use the active conversation owner session; executors must return results to it.', 409);
    // Do not commit a heartbeat on every iteration of a long poll.
    if (touch && (allowExpired || owner.until - Date.now() < ownerTtl - 60000)) {
      owner.until = Date.now() + ownerTtl; this.store.set(ownerKey, owner);
    }
  }
  probe(token) {
    if (!this.enabled) fail('conversation_not_enabled', 'Open a conversation session first.', 409);
    // A watchdog must not impersonate a living owner by renewing its heartbeat.
    this.require(token, true, false);
    const queue = this.store.queueStats();
    return { ...this.status(), recovery_allowed: !this.bridge.stopping && !this.bridge.maintaining
      && !this.store.get('restore_review_required', false), queue: { pending: queue.pending, ready: queue.ready, leased: queue.leased } };
  }
  renew(token) {
    if (!this.enabled) fail('conversation_not_enabled', 'Open a conversation session first.', 409);
    this.require(token, true);
    return this.status();
  }
  stop(token) {
    this.require(token);
    if (!this.enabled) fail('conversation_not_enabled', 'No conversation session exists.', 409);
    if (this.store.queueStats().leased || this.bridge.inflight.size) fail('conversation_handoff_required', 'Finish or safely hand off held tasks before closing the session.', 409);
    // Closing never silently re-enables competing legacy workers.
    this.store.set(ownerKey, { enabled: true, token: null, until: 0 });
    return this.status();
  }
  event(body) {
    if (!this.enabled) fail('conversation_not_enabled', 'Open a conversation session first.', 409);
    this.require(body?.session_token);
    if (typeof body?.event_id !== 'string' || !body.event_id || body.event_id.length > 512) fail('invalid_event_id', 'A current event ID of at most 512 characters is required.');
    const event = this.store.requireLease(body.event_id, body.lease_token).event;
    if (event.kind === 'alert' || event.binding !== this.bridge.config.binding || !event.from_wxid || !this.bridge.allowed(event.from_wxid)) fail('conversation_forbidden', 'A live event in an allowed conversation is required.', 403);
    return event;
  }
  context(body) {
    const started = performance.now(), mode = contextMode(body?.context_mode), compact = mode === 'compact';
    const event = this.event(body), db = this.store.db;
    const messageLimit = compact ? 4 : 20, replyLimit = compact ? 1 : 5;
    const cutoff = Date.now() - operational(this.bridge.config).event_retention_days * 86400000;
    const saved = db.prepare('SELECT * FROM conversation_memory WHERE binding=? AND sender=?')
      .get(event.binding, event.from_wxid);
    const recent = db.prepare(`SELECT id,body,received_ms,acked_ms FROM events
      WHERE json_extract(body,'$.binding')=? AND json_extract(body,'$.from_wxid')=?
      AND (acked_ms IS NULL OR acked_ms>=?) ORDER BY received_ms DESC,id DESC LIMIT ?`)
      .all(event.binding, event.from_wxid, cutoff, messageLimit + 1);
    let bytes = 0;
    const messages = [];
    const clip = (value = '') => compact ? excerpt(value, 512) : value.slice(0, 4000);
    for (const row of recent.slice(0, messageLimit)) {
      const request = JSON.parse(row.body);
      const replies = db.prepare(`SELECT s.state,s.created_ms AS submitted_ms,json_extract(s.result,'$.accepted_at') AS accepted_at,h.mode,h.text FROM send_events x
        JOIN sends s ON s.id=x.request_id JOIN reply_history h ON h.request_id=s.id
        WHERE x.event_id=? AND h.recorded_ms>=? ORDER BY s.created_ms DESC,s.rowid DESC LIMIT ?`).all(row.id, cutoff, replyLimit + 1);
      const requestText = clip(request.text), voiceText = clip(request.voice_text);
      const entry = { event_id: row.id, received_ms: row.received_ms, completed: row.acked_ms !== null,
        media: this.bridge.inbound.describe(row.id).map(({ part, type, state, mime_type, conversion_error, error }) => ({ part, type, state, ...(mime_type ? { mime_type } : {}), ...(conversion_error ? { conversion_error } : {}), ...(error ? { error } : {}) })),
        text: requestText, text_truncated: requestText !== (request.text ?? ''),
        voice_text: voiceText, voice_text_truncated: voiceText !== (request.voice_text ?? ''),
        replies_truncated: replies.length > replyLimit,
        replies: replies.slice(0, replyLimit).reverse().map((reply) => {
          const value = clip(reply.text);
          return { state: reply.state, mode: reply.mode, submitted_ms: reply.submitted_ms, accepted_at: reply.accepted_at,
            text: value, text_truncated: value !== reply.text };
        }) };
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (bytes > (compact ? 8 : 120) * 1024) break;
      messages.push(entry);
    }
    const tasks = db.prepare(`SELECT t.event_id,t.state,t.revision,t.detail,t.updated_ms FROM conversation_tasks t
      JOIN events e ON e.id=t.event_id WHERE json_extract(e.body,'$.binding')=?
      AND json_extract(e.body,'$.from_wxid')=? AND e.acked_ms IS NULL ORDER BY (e.id=?) DESC,e.received_ms,e.id LIMIT 33`)
      .all(event.binding, event.from_wxid, body.event_id).map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
    // Long prompts belong in notes or an explicitly read original history item.
    // The bounded recent window does not silently claim to be complete memory.
    const notes = saved && saved.updated_ms >= cutoff ? saved.notes : '';
    const returnedNotes = compact ? excerpt(notes, 2048) : notes;
    const result = { memory: { revision: saved?.revision ?? 0, notes: returnedNotes,
      notes_truncated: returnedNotes !== notes, updated_ms: saved?.updated_ms ?? null },
      messages: messages.reverse(), history_truncated: recent.length > messages.length, tasks: tasks.slice(0, 32), tasks_truncated: tasks.length > 32,
      limits: CONVERSATION_LIMITS, history_is_untrusted: true, phone_delivery_verified: false,
      context_mode: mode, context_bytes: 0, context_build_ms: 0 };
    const budget = (compact ? 16 : 240) * 1024;
    const tooLarge = () => Buffer.byteLength(JSON.stringify(result)) > budget - 128;
    while (tooLarge() && result.messages.length) { result.messages.shift(); result.history_truncated = true; }
    while (tooLarge() && result.tasks.length > 1) { result.tasks.pop(); result.tasks_truncated = true; }
    if (tooLarge()) fail('conversation_context_too_large', 'Private context exceeds the response budget.', 413);
    result.context_build_ms = Math.round((performance.now() - started) * 100) / 100;
    for (let i = 0; i < 3; i++) result.context_bytes = Buffer.byteLength(JSON.stringify(result));
    return result;
  }
  remember(body) {
    const event = this.event(body);
    integer(body.revision, 0, Number.MAX_SAFE_INTEGER - 1, 'revision');
    if (!text(body.notes, 16384) || Buffer.byteLength(JSON.stringify(body.notes)) > 16384) fail('invalid_memory', 'notes must be a string of at most 16 KiB.');
    this.bridge.resources.check(Buffer.byteLength(body.notes) + 4096);
    return this.store.transaction(() => {
      const prior = this.store.db.prepare('SELECT revision FROM conversation_memory WHERE binding=? AND sender=?').get(event.binding, event.from_wxid);
      if ((prior?.revision ?? 0) !== body.revision) fail('conversation_revision_conflict', 'Read current context before updating memory.', 409);
      this.store.db.prepare(`INSERT INTO conversation_memory VALUES (?,?,?,?,?)
        ON CONFLICT(binding,sender) DO UPDATE SET revision=excluded.revision,notes=excluded.notes,updated_ms=excluded.updated_ms`)
        .run(event.binding, event.from_wxid, body.revision + 1, body.notes, Date.now());
      return { revision: body.revision + 1 };
    });
  }
  task(body) {
    const event = this.event(body);
    integer(body.revision, 0, Number.MAX_SAFE_INTEGER - 1, 'revision');
    const detail = body.detail ?? {};
    if (!states.has(body.state) || !detail || typeof detail !== 'object' || Array.isArray(detail)
      || Buffer.byteLength(JSON.stringify(detail)) > 2048) fail('invalid_conversation_task', 'Provide a valid state and a detail object of at most 2 KiB.');
    for (const key of Object.keys(detail)) if (!['kind', 'handle', 'summary', 'related_event_id'].includes(key)) fail('invalid_conversation_task', 'Unknown task detail field.');
    if (detail.kind !== undefined && !['tool', 'native', 'chat'].includes(detail.kind)) fail('invalid_conversation_task', 'kind must be tool, native or chat.');
    for (const key of ['handle', 'summary', 'related_event_id']) if (detail[key] !== undefined && !text(detail[key], key === 'summary' ? 1400 : 512)) fail('invalid_conversation_task', 'Task detail contains an invalid value.');
    if (detail.related_event_id) {
      const related = this.store.event(detail.related_event_id)?.event;
      if (!related || related.from_wxid !== event.from_wxid || related.binding !== event.binding) fail('conversation_task_not_found', 'Related task is not in this conversation.', 404);
    }
    this.bridge.resources.check(4096);
    return this.store.transaction(() => {
      const prior = this.store.db.prepare('SELECT * FROM conversation_tasks WHERE event_id=?').get(body.event_id);
      if ((prior?.revision ?? 0) !== body.revision) fail('conversation_revision_conflict', 'Read current task state before updating it.', 409);
      if (prior && finished.has(prior.state) && body.state !== prior.state) fail('conversation_task_finished', 'A finished operation cannot be restarted under the same event.', 409);
      const merged = { ...(prior ? JSON.parse(prior.detail) : {}), ...detail };
      const originalDetail = prior ? JSON.parse(prior.detail) : {};
      if (originalDetail.handle && (merged.handle !== originalDetail.handle || merged.kind !== originalDetail.kind)) fail('conversation_executor_conflict', 'Retain the original executor and reconcile it instead of substituting another handle.', 409);
      if (body.state === 'running' && (!['tool', 'native'].includes(merged.kind) || !merged.handle?.trim())) fail('conversation_executor_required', 'Running background work needs its actual tool or native task handle.', 400);
      if (body.state === 'running' && prior?.state !== 'running') {
        const active = this.store.db.prepare(`SELECT count(*) AS n FROM conversation_tasks t JOIN events e ON e.id=t.event_id
          WHERE t.state='running' AND e.acked_ms IS NULL`).get().n;
        if (active >= CONVERSATION_LIMITS.background_active) fail('conversation_background_full', 'Background slots are busy. Keep this task queued and continue processing chat.', 429);
      }
      if (Buffer.byteLength(JSON.stringify(merged)) > 2048) fail('invalid_conversation_task', 'Merged task detail exceeds 2 KiB.');
      this.store.db.prepare(`INSERT INTO conversation_tasks VALUES (?,?,?,?,?)
        ON CONFLICT(event_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,detail=excluded.detail,updated_ms=excluded.updated_ms`)
        .run(body.event_id, body.state, body.revision + 1, JSON.stringify(merged), Date.now());
      return { event_id: body.event_id, state: body.state, revision: body.revision + 1, detail: merged };
    });
  }
  requireFinal(eventId) {
    if (!this.enabled) return;
    const task = this.store.db.prepare('SELECT state FROM conversation_tasks WHERE event_id=?').get(eventId);
    if (task && !finished.has(task.state)) fail('conversation_task_unfinished', 'The task is queued, running or awaiting authorization. Return a verified result to the conversation owner before final reply.', 409);
  }
}
