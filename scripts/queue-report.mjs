// Read-only per-message metadata; no API calls, leases, tokens or message text.
import { parseArgs } from 'node:util';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { defaultConfigPath, expand, loadConfig } from '../src/config.mjs';
import { duration, integer } from '../src/errors.mjs';
import { museRequestId } from '../src/muse.mjs';

try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' } } });
  const config = loadConfig(values.config ? expand(values.config) : defaultConfigPath());
  const now = Date.now();
  const since = integer(duration(values.since, 3600000), 1000, 7 * 86400000, 'since');
  const limit = integer(Number(values.limit ?? 50), 1, 200, 'limit');
  const path = join(config.state_dir, 'bridge.sqlite');
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw Object.assign(new Error(), { code: 'missing_or_unsafe_state' });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const events = db.prepare('SELECT id,received_ms,lease_until,acked_ms FROM events WHERE received_ms>=? ORDER BY received_ms DESC,id DESC LIMIT ?').all(now - since, limit).reverse();
    const messages = events.map((event) => {
      const request_id = museRequestId(event.id);
      const send = db.prepare('SELECT state,created_ms,result FROM sends WHERE id=?').get(request_id);
      const result = send?.result ? JSON.parse(send.result) : {};
      const accepted = send?.state === 'accepted' && Number.isFinite(Date.parse(result.accepted_at)) ? Date.parse(result.accepted_at) : null;
      const timing = Object.fromEntries(['queue_ms', 'upstream_ms', 'bridge_ms', 'model_to_submit_ms'].filter((key) => typeof result.timing?.[key] === 'number').map((key) => [key, result.timing[key]]));
      return { event_id: event.id, request_id, received_ms: event.received_ms, lease_until_ms: event.lease_until, acked_ms: event.acked_ms,
        stage: event.acked_ms !== null ? send?.state === 'accepted' ? 'final_reply_accepted' : 'ack_without_accepted_final'
          : send ? 'final_reply_' + send.state : event.lease_until > now ? 'leased_no_final_submission' : 'ready_no_final_submission',
        submitted_ms: send?.created_ms ?? null, accepted_ms: accepted,
        received_to_submit_ms: send ? send.created_ms - event.received_ms : null,
        submit_to_accept_ms: accepted === null ? null : accepted - send.created_ms, timing };
    });
    const remaining = db.prepare('SELECT count(*) AS n FROM events WHERE received_ms>=?').get(now - since).n;
    console.log(JSON.stringify({ mode: 'read_only_message_ledger', at: new Date(now).toISOString(), window_ms: since, total_in_window: remaining, truncated: remaining > limit,
      first_claim_time_available: false, phone_delivery_verified: false, messages }, null, 2));
  } finally { db.close(); }
} catch (error) { console.error(JSON.stringify({ read_only: true, error: error.code ?? 'queue_report_failed' })); process.exitCode = 1; }
