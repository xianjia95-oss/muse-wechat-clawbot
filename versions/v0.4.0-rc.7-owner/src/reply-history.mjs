import { fail, integer } from './errors.mjs';
import { operational } from './config.mjs';

const excerpt = (text = '') => Array.from(text).slice(0, 160).join('');
const byteBudget = 240 * 1024; // Leave room for the envelope below 256 KiB.

// Content is deliberately separate from receipts and diagnostics. Every lookup
// needs a live context lease and is scoped to that event's sender and binding.
export function readReplyHistory(bridge, body, finalRequestId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_body', 'JSON object required.');
  const context = bridge.store.requireLease(body.event_id, body.lease_token).event;
  if (context.kind === 'alert' || context.binding !== bridge.config.binding || !context.from_wxid || !bridge.allowed(context.from_wxid)) {
    fail('history_forbidden', 'History requires a current WeChat event in an allowed conversation.', 403);
  }
  const limit = integer(body.limit ?? 5, 1, 20, 'limit');
  const offset = integer(body.offset ?? 0, 0, 100000, 'offset');
  const days = operational(bridge.config).event_retention_days;
  const cutoff = Date.now() - days * 86400000;
  const common = { retention_days: days, phone_delivery_verified: false };
  const db = bridge.store.db;
  if (body.target_event_id !== undefined) {
    if (body.query !== undefined) fail('invalid_history_query', 'Choose query or target_event_id, not both.');
    if (typeof body.target_event_id !== 'string' || !body.target_event_id || body.target_event_id.length > 512) fail('invalid_event_id', 'target_event_id is required.');
    const target = db.prepare(`SELECT id,body,received_ms,acked_ms FROM events WHERE id=?
      AND json_extract(body,'$.from_wxid')=? AND json_extract(body,'$.binding')=?
      AND (acked_ms IS NULL OR acked_ms>=?)`).get(body.target_event_id, context.from_wxid, context.binding, cutoff);
    // Do not reveal whether an unavailable ID belongs to a different sender.
    if (!target) fail('history_not_found', 'No retained event is available in this conversation.', 404);
    const rows = db.prepare(`SELECT s.id,s.state,s.created_ms,s.result,h.mode,h.reply_id,h.text,h.media,h.recorded_ms
      FROM send_events x JOIN sends s ON s.id=x.request_id LEFT JOIN reply_history h ON h.request_id=s.id
      WHERE x.event_id=? ORDER BY s.created_ms,s.rowid LIMIT ? OFFSET ?`).all(target.id, limit + 1, offset);
    const replies = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const available = row.recorded_ms !== null && row.recorded_ms >= cutoff;
      const result = row.result ? JSON.parse(row.result) : null;
      const entry = {
        request_id: row.id, mode: row.mode ?? (row.id === finalRequestId(target.id) ? 'final' : 'unknown'),
        reply_id: row.reply_id, state: row.state, submitted_ms: row.created_ms,
        accepted_at: row.state === 'accepted' ? result?.accepted_at ?? null : null,
        content_status: available ? 'recorded' : 'not_recorded_or_expired',
        text: available ? row.text : null, media: available ? JSON.parse(row.media) : null,
      };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > byteBudget) break;
      bytes += size; replies.push(entry);
    }
    if (rows.length && !replies.length) fail('history_record_too_large', 'The private history record exceeds the response budget.', 413);
    const hasMore = rows.length > replies.length;
    return { ...common, event_id: target.id, request_excerpt: excerpt(JSON.parse(target.body).text), received_ms: target.received_ms,
      acked_ms: target.acked_ms, replies, has_more: hasMore, next_offset: hasMore ? offset + replies.length : null };
  }
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 128) fail('invalid_history_query', 'Provide a literal query (1..128 characters) or target_event_id.');
  const pattern = '%' + body.query.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = db.prepare(`SELECT id,body,received_ms,acked_ms FROM events WHERE id<>?
    AND json_extract(body,'$.from_wxid')=? AND json_extract(body,'$.binding')=?
    AND (acked_ms IS NULL OR acked_ms>=?) AND json_extract(body,'$.text') LIKE ? ESCAPE '\\'
    ORDER BY received_ms DESC,id DESC LIMIT ? OFFSET ?`).all(body.event_id, context.from_wxid, context.binding, cutoff, pattern, limit + 1, offset);
  const matches = rows.slice(0, limit).map((row) => ({ event_id: row.id, request_excerpt: excerpt(JSON.parse(row.body).text),
    received_ms: row.received_ms, acked_ms: row.acked_ms, final_state: bridge.store.send(finalRequestId(row.id))?.state ?? 'not_submitted' }));
  const hasMore = rows.length > limit;
  return { ...common, matches, has_more: hasMore, next_offset: hasMore ? offset + matches.length : null };
}
