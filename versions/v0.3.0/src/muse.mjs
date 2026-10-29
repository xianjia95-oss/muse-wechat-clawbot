import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

// These are bridge adapter commands for Muse's native hooks. They do not call
// or emulate a Muse model API. The real Muse runtime performs the agent task.
export function museRequestId(eventId, mode = 'final', replyId = '') {
  return `muse-${createHash('sha256').update(JSON.stringify([eventId, mode, replyId])).digest('hex')}`;
}

export class MuseAdapter {
  constructor(bridge) { this.bridge = bridge; }

  async next(options = {}, signal) {
    const events = await this.bridge.claim(options, signal);
    const tasks = [];
    for (const event of events) {
      const finalId = museRequestId(event.event_id);
      const completed = this.bridge.store.send(finalId);
      // Recover a crash after WeChat accepted the reply but before inbox ack.
      if (event.kind !== 'alert' && completed?.state === 'accepted') {
        this.bridge.store.ack([event.event_id]);
        continue;
      }
      tasks.push({
        ...event,
        completion: {
          request_id: finalId,
          state: completed?.state ?? 'not_submitted',
          ...(completed?.result ? { result: completed.result } : {}),
        },
      });
    }
    return { tasks };
  }

  async reply(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_body', 'JSON object required.');
    if (typeof body.event_id !== 'string' || !body.event_id || body.event_id.length > 512) fail('invalid_event_id', 'event_id is required.');
    const mode = body.mode ?? 'final';
    if (!['final', 'progress'].includes(mode)) fail('invalid_mode', 'mode must be final or progress.');
    if (mode === 'progress' && (typeof body.reply_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(body.reply_id))) {
      fail('invalid_reply_id', 'Progress replies require a stable reply_id (1..64 letters, digits, _, ., :, -).');
    }
    if (mode === 'final' && body.reply_id !== undefined) fail('invalid_reply_id', 'The final reply has one automatic stable ID; omit reply_id.');
    if (['to', 'binding', 'request_id'].some((key) => body[key] !== undefined)) fail('automatic_routing', 'Recipient and request_id are derived from event_id.');
    const row = this.bridge.store.event(body.event_id);
    if (!row) fail('event_not_found', 'Unknown event_id.', 404);
    const event = row.event;
    if (event.kind === 'alert') fail('alert_not_replyable', 'Report bridge alerts in Muse and ack them; do not reply on WeChat.');
    if (event.binding !== this.bridge.config.binding || !event.from_wxid) fail('invalid_event', 'Event has no valid WeChat route.');
    const requestId = museRequestId(body.event_id, mode, mode === 'progress' ? body.reply_id : '');
    const prior = this.bridge.store.send(requestId);
    if (row.acked_ms !== null && prior?.state !== 'accepted') fail('event_completed', 'This event has already been acknowledged.', 409);
    if (!prior && row.lease_until <= Date.now()) fail('event_not_leased', 'Claim the event with muse next before replying.', 409);
    const result = await this.bridge.send({
      to: event.from_wxid, text: body.text, request_id: requestId,
      ...(body.media !== undefined ? { media: body.media } : {}),
      ...(body.model_ready_at !== undefined ? { model_ready_at: body.model_ready_at } : {}),
    });
    // A timeout, rejected reply or uncertain outcome never reaches this ack.
    if (mode === 'final') this.bridge.store.ack([body.event_id]);
    return { ...result, event_id: body.event_id, mode, event_completed: mode === 'final' || row.acked_ms !== null };
  }
}
