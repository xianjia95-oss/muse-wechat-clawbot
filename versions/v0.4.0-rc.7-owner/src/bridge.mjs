import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { BridgeError, fail, integer } from './errors.mjs';
import { VERSION, operational } from './config.mjs';
import { Conversation } from './conversation.mjs';
import { InboundMedia } from './inbound-media.mjs';
import { Resources } from './operations.mjs';
import { normalizeMedia, prepareMedia, snapshotAvailable, removeSnapshot } from './media.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const ms = (value) => Math.round(value * 100) / 100;
export const splitText = (text) => {
  const chars = Array.from(text);
  const chunks = [];
  for (let index = 0; index < chars.length; index += 2000) chunks.push(chars.slice(index, index + 2000).join(''));
  return chunks;
};

export class Bridge {
  constructor(config, store, ilink, log = () => {}) {
    if (config.transport === 'isolated_simulation_v1' && ilink.mode !== config.transport) fail('simulation_scope', 'Simulation requires its local transport.');
    if (config.transport !== 'isolated_simulation_v1' && store.get('transport_mode') === 'isolated_simulation_v1') fail('simulation_scope', 'Simulation storage cannot be opened as a WeChat bridge.');
    this.config = config;
    this.store = store;
    this.ilink = ilink;
    this.log = log;
    this.inflight = new Map();
    this.peerTails = new Map();
    this.peerCounts = new Map();
    this.deliveries = new Map();
    this.worker = { since: new Date().toISOString(), claim_requests: 0, claimed_events: 0, last_claim_at: null, last_task_at: null, reply_requests: 0, last_reply_at: null, last_api_error: null, last_ingest_at: null };
    this.resources = new Resources(config);
    this.conversation = new Conversation(this);
    this.stopping = false;
    this.events = new EventEmitter();
    this.events.setMaxListeners(operational(config).max_http_requests + 1);
    this.poll = { state: 'stopped', last_ok_at: null, error: null };
    this.controller = new AbortController();
    this.inbound = new InboundMedia(this);
  }
  allowed(wxid) {
    const allow = this.config.allow_wxids;
    return allow.length ? allow.includes(wxid) : wxid === this.store.get('session')?.ilink_user_id;
  }
  status() {
    const simulated = this.config.transport === 'isolated_simulation_v1';
    const session = this.store.get('session');
    const queue = this.store.queueStats(operational(this.config).worker_stale_ms);
    const deliveries = [...this.deliveries.values()];
    return {
      binding: this.config.binding,
      version: VERSION,
      capabilities: { send: simulated ? ['text'] : ['text', 'image', 'video', 'voice'], receive: simulated ? ['text'] : ['text', 'voice_transcript', 'image', 'video', 'voice'],
        media_handoff: 'private_local_file', muse_understanding_verified: false },
      inbound_media: { active: this.inbound.active.size, max_active: 2 },
      logged_in: !simulated && !!session && !this.store.get('expired', false),
      ...(simulated ? { simulation_mode: true } : {}),
      poll: this.poll,
      conversation: this.conversation.status(),
      ready_events: queue.ready, queue, worker: { ...this.worker },
      inflight_sends: this.inflight.size,
      delivery: { ...Object.fromEntries(['queued', 'preparing', 'uploading', 'sending'].map((stage) => [stage, deliveries.filter((item) => item.stage === stage).length])), oldest_inflight_ms: deliveries.length ? Date.now() - Math.min(...deliveries.map((item) => item.at)) : null },
      transport: simulated ? 'isolated_simulation_v1' : 'direct-send / dedicated-send-and-poll-pools',
    };
  }
  validateSend(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_body', 'JSON object required.');
    if (body.binding !== undefined && body.binding !== this.config.binding) fail('unknown_binding', 'Unknown binding.', 404);
    if (typeof body.to !== 'string' || !body.to || body.to.length > 256) fail('invalid_to', 'to is required.');
    const media = normalizeMedia(body.media);
    if (this.config.transport === 'isolated_simulation_v1' && media.length) fail('simulation_text_only', 'This test interface supports text only.', 400);
    const text = body.text ?? '';
    if (typeof text !== 'string' || (!text.trim() && !media.length)) fail('invalid_text', 'Nonempty text or media is required.');
    if (Array.from(text).length > 32000) fail('text_too_long', 'Maximum reply is 32000 Unicode code points.', 413);
    if (['image', 'file', 'video', 'voice'].some((key) => body[key] !== undefined)) fail('unsupported_media', 'Use typed local media descriptors. Files are not supported.');
    if (typeof body.request_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.request_id)) fail('invalid_request_id', 'request_id is required (1..128 letters, digits, _, ., :, -).');
    if (body.model_ready_at !== undefined && (!Number.isSafeInteger(body.model_ready_at) || body.model_ready_at < 0 || body.model_ready_at > Date.now() + 5000)) {
      fail('invalid_ready_time', 'model_ready_at must be an epoch-millisecond timestamp, not in the future.');
    }
    if (!this.allowed(body.to)) fail('forbidden', 'Recipient is outside the allowlist.', 403);
    return { ...body, text, media };
  }

  // The response is only successful after WeChat has accepted every chunk.
  // No timer, scheduled flush, receive-loop wait, or process-per-chunk execution.
  send(body, { eventId = null, leaseToken, replyMetadata } = {}) {
    body = this.validateSend(body);
    // Preserve v0.2 text fingerprints. Media IDs bind the supplied paths to the
    // first prepared snapshots; retries never substitute changed file bytes.
    const fingerprint = hash(JSON.stringify(body.media.length ? [body.to, body.text, body.media] : [body.to, body.text]));
    const prior = this.store.send(body.request_id);
    if (prior && prior.fingerprint !== fingerprint) fail('id_conflict', 'request_id already belongs to another payload.', 409);
    if (this.inflight.has(body.request_id)) return this.inflight.get(body.request_id);
    if (prior?.state === 'accepted') return Promise.resolve({ ...prior.result, cached: true });
    if (prior && ['unknown', 'rejected'].includes(prior.state)) {
      fail(prior.state === 'unknown' ? 'send_unknown' : 'send_rejected', 'Previous outcome must be reviewed; this request will not be resent.', 409, { request: prior.result, state: prior.state });
    }
    if (this.stopping || this.maintaining) fail('unavailable', 'Service is draining or performing maintenance; retry the same request later.', 503);
    if (this.store.get('restore_review_required', false)) fail('restore_review_required', 'Restored state requires operator reconciliation before work resumes.', 409);
    const limits = operational(this.config);
    if (this.inflight.size >= limits.max_inflight_sends || (this.peerCounts.get(body.to) ?? 0) >= limits.max_peer_sends) fail('queue_full', 'Send queue capacity reached; retry the same request later.', 429, { retry_after_seconds: 5 });
    this.resources.check(Buffer.byteLength(body.text) + 16384);
    const session = this.store.get('session');
    if (!session || this.store.get('expired', false)) fail('not_logged_in', '请先扫码登录，并启动或重启 muse-link。', 401);
    if (!this.store.context(body.to)) fail('no_context', '请先用微信给 ClawBot 发一条消息。', 409);
    const chunks = [
      ...splitText(body.text.trim() ? body.text : '').map((text) => ({ type: 'text', text })),
      ...body.media,
    ];
    if (!prior) this.store.createSend(body.request_id, fingerprint, body.to,
      chunks.map((_, index) => `ml-${hash(`${body.request_id}:${index}`).slice(0, 32)}`), eventId,
      replyMetadata ? { ...replyMetadata, text: body.text, media: body.media.map(({ type }) => ({ type })) } : null);
    else if (prior.state === 'failed') this.store.retrySend(body.request_id);
    const began = performance.now();
    const submittedAt = Date.now();
    this.deliveries.set(body.request_id, { stage: 'queued', at: submittedAt });
    const work = Promise.resolve().then(() => this.deliver(body, chunks, began, submittedAt, eventId, leaseToken));
    this.inflight.set(body.request_id, work);
    this.peerCounts.set(body.to, (this.peerCounts.get(body.to) ?? 0) + 1);
    const clean = () => {
      this.inflight.delete(body.request_id);
      this.deliveries.delete(body.request_id);
      const count = this.peerCounts.get(body.to) - 1;
      if (count) this.peerCounts.set(body.to, count); else this.peerCounts.delete(body.to);
    };
    work.then(clean, clean);
    return work;
  }

  queuePeer(peer, action) {
    const previous = this.peerTails.get(peer) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(action);
    this.peerTails.set(peer, work);
    const clean = () => { if (this.peerTails.get(peer) === work) this.peerTails.delete(peer); };
    work.then(clean, clean);
    return work;
  }

  async deliver(body, chunks, began, submittedAt, eventId, leaseToken) {
    let queueMs = 0;
    let firstChunkMs = null;
    let upstreamMs = 0;
    let prepareMs = 0;
    let uploadMs = 0;
    let sendMs = 0;
    const parts = this.store.parts(body.request_id);
    let accepted = parts.filter((part) => part.state === 'accepted').length;
    const timing = () => ({
      queue_ms: ms(queueMs), upstream_ms: ms(upstreamMs),
      media_prepare_ms: ms(prepareMs), media_upload_ms: ms(uploadMs), send_message_ms: ms(sendMs),
      first_chunk_ms: firstChunkMs === null ? null : ms(firstChunkMs),
      bridge_ms: ms(performance.now() - began),
      model_to_submit_ms: body.model_ready_at === undefined ? null : submittedAt - body.model_ready_at,
    });
    const failDelivery = (error, phase, part) => {
      const rejected = ['session_expired', 'upstream_rejected'].includes(error.code);
      const state = phase === 'send' ? (rejected ? 'rejected' : 'unknown') : (rejected ? 'rejected' : 'failed');
      if (error.code === 'session_expired') this.store.set('expired', true);
      if (part) this.store.partState(body.request_id, part.part, state === 'failed' ? 'prepared' : state);
      const code = error instanceof BridgeError ? error.code : phase === 'prepare' ? 'media_prepare_failed' : phase === 'upload' ? 'media_upload_failed' : 'upstream_unknown';
      const result = { ok: false, request_id: body.request_id, state, phase, retryable: state === 'failed',
        accepted_chunks: accepted, total_chunks: chunks.length, accepted_parts: accepted, total_parts: chunks.length, error: code, timing: timing(),
        ...(code === 'stale_lease' ? { lease_reason: error.details?.lease_reason, lease_until: error.details?.lease_until, acked_ms: error.details?.acked_ms, server_time: error.details?.server_time } : {}) };
      this.store.finish(body.request_id, state, result);
      this.log('send_failed', result);
      throw new BridgeError(code, error instanceof BridgeError ? error.message : 'Sending failed; inspect request status before retrying.', error.status ?? 502, result);
    };
    const checkLease = () => {
      if (eventId && this.config.require_lease_token !== false) {
        try { this.store.requireLease(eventId, leaseToken); }
        catch (error) { failDelivery(error, 'lease'); }
      }
    };
    checkLease();
    if (parts.some((part) => ['unknown', 'sending'].includes(part.state))) {
      const result = { ok: false, request_id: body.request_id, state: 'unknown', retryable: false, accepted_chunks: accepted, total_chunks: chunks.length, timing: timing() };
      this.store.finish(body.request_id, 'unknown', result);
      fail('send_unknown', '上次发送中断，微信是否收到尚不确定，已停止自动重发。', 409, result);
    }
    // Validate and snapshot all attachments before sending even the caption.
    const preparing = performance.now();
    this.deliveries.get(body.request_id).stage = 'preparing';
    try {
      for (const part of parts) {
        if (part.state === 'accepted' || chunks[part.part].type === 'text') continue;
        const record = this.store.media(body.request_id, part.part);
        if (!record) this.store.saveMedia(body.request_id, part.part, await prepareMedia(this.config, body.request_id, part.part, chunks[part.part], (bytes) => this.resources.reserve(bytes)));
        else if (!record.media_item && !await snapshotAvailable(this.config, body.request_id, record)) fail('media_snapshot_missing', 'Prepared media snapshot is unavailable. Do not replace its bytes under this request ID.');
      }
    } catch (error) {
      prepareMs = performance.now() - preparing;
      failDelivery(error, 'prepare');
    }
    prepareMs = body.media.length ? performance.now() - preparing : 0;
    for (const part of parts) {
      if (part.state === 'accepted') continue;
      checkLease();
      if (this.store.get('expired', false)) failDelivery(new BridgeError('session_expired', '微信登录已过期，请重新扫码。', 401), 'send', part);
      const chunk = chunks[part.part];
      let record;
      if (chunk.type !== 'text') {
        record = this.store.media(body.request_id, part.part);
        if (!record.media_item) {
          const uploading = performance.now();
          this.deliveries.get(body.request_id).stage = 'uploading';
          try {
            record.media_item = await this.ilink.uploadMedia(this.store.get('session'), body.to, record);
            this.store.saveMedia(body.request_id, part.part, record);
          } catch (error) {
            const elapsed = performance.now() - uploading;
            uploadMs += elapsed; upstreamMs += elapsed;
            failDelivery(error, 'upload', part);
          }
          const elapsed = performance.now() - uploading;
          uploadMs += elapsed; upstreamMs += elapsed;
        }
      }
      // Only actual chat submissions occupy a recipient's ordered lane.
      // Slow preparation/uploads leave that lane available to short replies.
      this.deliveries.get(body.request_id).stage = 'queued';
      const queued = performance.now();
      await this.queuePeer(body.to, async () => {
        queueMs += performance.now() - queued;
        checkLease();
        if (this.store.get('expired', false)) failDelivery(new BridgeError('session_expired', '微信登录已过期，请重新扫码。', 401), 'lease');
        this.store.partState(body.request_id, part.part, 'sending');
        this.deliveries.get(body.request_id).stage = 'sending';
        const started = performance.now();
        try {
          if (chunk.type === 'text') await this.ilink.sendText(this.store.get('session'), body.to, chunk.text, this.store.context(body.to), part.client_id);
          else await this.ilink.sendMedia(this.store.get('session'), body.to, record.media_item, this.store.context(body.to), part.client_id);
        } catch (error) {
          const elapsed = performance.now() - started;
          upstreamMs += elapsed; sendMs += elapsed;
          failDelivery(error, 'send', part);
        }
        const elapsed = performance.now() - started;
        upstreamMs += elapsed; sendMs += elapsed;
        accepted++;
        this.store.partState(body.request_id, part.part, 'accepted', ms(elapsed));
        firstChunkMs ??= performance.now() - began;
        this.log('chunk_accepted', { request_id: body.request_id, chunk: part.part + 1, upstream_ms: ms(elapsed) });
      });
      if (record) {
        try {
          await removeSnapshot(this.config, body.request_id, record);
          this.store.deleteMedia(body.request_id, part.part);
        } catch { this.log('media_cleanup_failed', { request_id: body.request_id, part: part.part }); }
      }
    }
    const result = { ok: true, request_id: body.request_id, state: 'accepted', accepted_chunks: accepted, total_chunks: chunks.length,
      accepted_parts: accepted, total_parts: chunks.length, media_count: body.media.length, accepted_at: new Date().toISOString(), timing: timing() };
    this.store.finish(body.request_id, 'accepted', result);
    this.log('send_accepted', result);
    return result;
  }

  alert(code, message) {
    // Coalesce outstanding alerts by type and keep a full inbox/disk failure
    // from generating still more state. Poll health and logs remain observable.
    if (this.store.db.prepare("SELECT 1 FROM events WHERE acked_ms IS NULL AND json_extract(body,'$.alert.code')=? LIMIT 1").get(code)) return;
    if (this.store.queueStats().pending >= operational(this.config).max_pending_events) return;
    try { this.resources.check(4096); } catch { return; }
    const event = {
      schema: 'muselink.event.v1', binding: this.config.binding, event_id: `${this.config.binding}:alert:${randomUUID()}`,
      kind: 'alert', text: '', media: [], alert: { code, message }, create_time: Math.floor(Date.now() / 1000),
    };
    this.store.addEvent(event);
    this.events.emit('new');
  }
  ingest(response) {
    let added = 0;
    this.resources.check(Buffer.byteLength(JSON.stringify(response)) + 16384);
    const pending = this.store.queueStats().pending;
    this.store.transaction(() => {
      for (const message of response.msgs ?? []) {
        if (!message.from_user_id || !this.allowed(message.from_user_id)) continue;
        if (message.message_id === undefined) throw new Error('Message is missing message_id');
        if (!this.store.event(`${this.config.binding}:${message.message_id}`) && pending + added >= operational(this.config).max_pending_events) fail('inbox_full', 'Inbox capacity reached; cursor remains unchanged until the worker drains events.', 503);
        if (message.context_token) this.store.saveContext(message.from_user_id, message.context_token);
        const items = message.item_list ?? [];
        const unsupported = items.filter((item) => ![1, 2, 3, 5].includes(item.type));
        const event = {
          schema: 'muselink.event.v1', event_id: `${this.config.binding}:${message.message_id}`,
          binding: this.config.binding, kind: 'message', message_id: String(message.message_id),
          from_wxid: message.from_user_id, to_bot_id: message.to_user_id ?? '',
          create_time: Math.floor((message.create_time_ms ?? Date.now()) / 1000),
          received_at: new Date().toISOString(),
          text: items.filter((item) => item.type === 1).map((item) => item.text_item?.text ?? '').join('\n'),
          voice_text: items.filter((item) => item.type === 3).map((item) => item.voice_item?.text ?? '').filter(Boolean).join('\n'),
          media: [], media_errors: [...unsupported.map((item) => `当前版本尚不支持读取微信入站附件类型 ${Number.isInteger(item.type) ? item.type : 'unknown'}。`),
            ...(items.filter((item) => [2, 3, 5].includes(item.type)).length > 4 ? ['inbound_media_count_limit_4'] : [])],
          has_context_token: !!this.store.context(message.from_user_id),
        };
        const inserted = this.store.addEvent(event);
        if (inserted) {
          event.media = this.inbound.add(event.event_id, items);
          this.store.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event), event.event_id);
        }
        added += inserted;
      }
      // Events, tokens and cursor commit together; a failed batch is replayable.
      if (typeof response.get_updates_buf === 'string' && response.get_updates_buf.length) this.store.set('cursor', response.get_updates_buf);
    });
    if (added) {
      this.worker.last_ingest_at = new Date().toISOString();
      this.log('messages_received', { count: added });
      this.events.emit('new');
      this.inbound.dispatch();
    }
    return added;
  }
  async runPoll() {
    if (this.store.get('restore_review_required', false)) { this.poll = { ...this.poll, state: 'restore_review' }; return; }
    if (!this.store.get('session')) { this.poll = { ...this.poll, state: 'not_logged_in' }; return; }
    this.inbound.dispatch();
    let failures = 0;
    let firstFailure = null;
    let alerted = false;
    while (!this.controller.signal.aborted && !this.store.get('expired', false)) {
      this.poll = { ...this.poll, state: 'waiting' };
      try {
        const response = await this.ilink.updates(this.store.get('session'), this.store.get('cursor', ''), this.controller.signal);
        this.ingest(response);
        this.poll = { state: 'ok', last_ok_at: new Date().toISOString(), error: null };
        if (alerted) this.alert('recovered', '微信连接已恢复。');
        failures = 0; firstFailure = null; alerted = false;
      } catch (error) {
        if (this.controller.signal.aborted) break;
        this.poll = { ...this.poll, state: 'failing', error: error.code ?? 'poll_error' };
        if (error.code === 'session_expired') {
          this.store.set('expired', true);
          this.poll.state = 'expired';
          this.alert('session_expired', '微信登录过期，需要重新扫码并重启 muse-link。');
          break;
        }
        firstFailure ??= Date.now();
        if (!alerted && Date.now() - firstFailure > 30000) {
          this.alert('unreachable', '微信桥连接连续失败超过 30 秒，请检查网络和服务代理设置。');
          alerted = true;
        }
        this.log('poll_error', { code: error.code ?? 'poll_error' });
        await pause(Math.min(10000, 500 * 2 ** Math.min(failures++, 5)), undefined, { signal: this.controller.signal }).catch(() => {});
      }
    }
    if (this.store.get('expired', false)) this.poll.state = 'expired';
  }
  async claim(options = {}, signal) {
    const { limit = 20, session_token } = options;
    this.conversation.require(session_token);
    if (!this.conversation.enabled) return this.claimEvents(options, signal);
    if (limit !== 1) fail('conversation_single_claim', 'The conversation owner claims one new event at a time. Background execution is managed separately.', 400);
    if (this.conversation.claiming) fail('conversation_claim_inflight', 'A next request is already pending for this owner.', 409);
    this.conversation.claiming = true;
    try { return await this.claimEvents(options, signal); }
    finally { this.conversation.claiming = false; }
  }
  async claimEvents({ limit = 20, lease = 1800000, wait = 0, session_token } = {}, signal) {
    if (this.store.get('restore_review_required', false)) fail('restore_review_required', 'Reconcile restored state before claiming work.', 409);
    integer(limit, 1, 100, 'limit');
    integer(lease, 1000, 3600000, 'lease');
    integer(wait, 0, 60000, 'wait');
    this.worker.claim_requests++;
    this.worker.last_claim_at = new Date().toISOString();
    const deadline = Date.now() + wait;
    for (;;) {
      if (this.stopping) fail('unavailable', 'Service is draining.', 503);
      // A disconnected waiter must not take work away from a live worker.
      if (signal?.aborted) return [];
      this.conversation.require(session_token);
      if (this.conversation.enabled && this.store.queueStats().leased >= 32) fail('conversation_held_capacity', 'Maintain held tasks before claiming more work.', 429);
      const events = this.store.claim(limit, lease);
      if (events.length) {
        this.worker.claimed_events += events.length;
        this.worker.last_task_at = new Date().toISOString();
        this.log('tasks_claimed', { count: events.length });
      }
      if (events.length || Date.now() >= deadline) return events.map((event) => ({ ...event, media: this.inbound.describe(event.event_id) }));
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); this.events.off('new', done); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(250, deadline - Date.now()));
        this.events.once('new', done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  async close() {
    this.stopping = true;
    this.controller.abort();
    await this.pollTask;
    await this.inbound.close();
    await Promise.allSettled(this.inflight.values());
    await this.ilink.close();
  }
}
