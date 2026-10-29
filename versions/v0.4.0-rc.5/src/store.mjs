import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fail } from './errors.mjs';
import { inspectLease } from './lease.mjs';

export const SCHEMA_VERSION = 1;

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, 'bridge.sqlite');
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail('unsafe_state', 'Database must not be a symbolic link.');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    if (this.db.prepare('PRAGMA user_version').get().user_version > SCHEMA_VERSION) { this.db.close(); fail('future_schema', 'Database schema is newer than this program.'); }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (wxid TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, received_ms INTEGER NOT NULL,
        lease_until INTEGER NOT NULL DEFAULT 0, acked_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS events_ready ON events(acked_ms, lease_until, received_ms);
      CREATE TABLE IF NOT EXISTS sends (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, recipient TEXT NOT NULL,
        state TEXT NOT NULL, created_ms INTEGER NOT NULL, result TEXT
      );
      CREATE TABLE IF NOT EXISTS parts (
        request_id TEXT NOT NULL, part INTEGER NOT NULL, client_id TEXT NOT NULL,
        state TEXT NOT NULL, elapsed_ms REAL, PRIMARY KEY(request_id, part)
      );
      CREATE TABLE IF NOT EXISTS media_jobs (
        request_id TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(request_id, part)
      );
    `);
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(events)').all();
      if (!columns.some((column) => column.name === 'lease_token')) this.db.exec("ALTER TABLE events ADD COLUMN lease_token TEXT");
      if (!columns.some((column) => column.name === 'lease_activity_ms')) this.db.exec('ALTER TABLE events ADD COLUMN lease_activity_ms INTEGER');
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_steps (
        event_id TEXT NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL, lease_token TEXT NOT NULL,
        result TEXT, updated_ms INTEGER NOT NULL, PRIMARY KEY(event_id,step));
        CREATE TABLE IF NOT EXISTS inbound_media (
          event_id TEXT NOT NULL, part INTEGER NOT NULL, type TEXT NOT NULL, source TEXT,
          state TEXT NOT NULL, result TEXT, attempts INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
          PRIMARY KEY(event_id,part));
        CREATE INDEX IF NOT EXISTS inbound_media_state ON inbound_media(state,event_id);
        CREATE TABLE IF NOT EXISTS send_events (request_id TEXT PRIMARY KEY, event_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS sends_created ON sends(created_ms);
        PRAGMA user_version=${SCHEMA_VERSION};`);
    });
  }

  close() { this.db.close(); }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  context(wxid) { return this.db.prepare('SELECT token FROM peers WHERE wxid=?').get(wxid)?.token; }
  saveContext(wxid, token) {
    this.db.prepare('INSERT INTO peers VALUES (?,?) ON CONFLICT(wxid) DO UPDATE SET token=excluded.token').run(wxid, token);
  }
  addEvent(event) {
    return this.db.prepare('INSERT OR IGNORE INTO events(id,body,received_ms) VALUES (?,?,?)')
      .run(event.event_id, JSON.stringify(event), Date.now()).changes;
  }
  event(id) {
    const row = this.db.prepare('SELECT body,lease_until,lease_token,acked_ms FROM events WHERE id=?').get(id);
    return row ? { event: JSON.parse(row.body), lease_until: row.lease_until, lease_token: row.lease_token, acked_ms: row.acked_ms } : null;
  }
  count() {
    return this.db.prepare('SELECT count(*) AS n FROM events WHERE acked_ms IS NULL AND lease_until<=?').get(Date.now()).n;
  }
  claim(limit = 20, leaseMs = 1800000) {
    return this.transaction(() => {
      const now = Date.now();
      const rows = this.db.prepare('SELECT id,body FROM events WHERE acked_ms IS NULL AND lease_until<=? ORDER BY received_ms,id LIMIT ?').all(now, limit);
      const update = this.db.prepare('UPDATE events SET lease_until=?,lease_token=?,lease_activity_ms=? WHERE id=?');
      return rows.map((row) => {
        const lease_token = randomBytes(24).toString('hex');
        update.run(now + leaseMs, lease_token, now, row.id);
        return { ...JSON.parse(row.body), lease_token, lease_until: now + leaseMs };
      });
    });
  }
  requireLease(id, token) {
    if (typeof id !== 'string' || !id) fail('stale_lease', 'event_id is required.', 409, { lease_reason: 'invalid_event_id', server_time: Date.now() });
    const row = this.event(id);
    const detail = inspectLease(row, token);
    if (detail.lease_reason) fail('stale_lease', `Lease rejected: ${detail.lease_reason}. Use the captured lease for this event; do not bypass the check.`, 409, detail);
    return row;
  }
  renew(id, token, leaseMs) {
    this.requireLease(id, token);
    const until = Date.now() + leaseMs;
    this.db.prepare('UPDATE events SET lease_until=?,lease_activity_ms=? WHERE id=? AND lease_token=?').run(until, Date.now(), id, token);
    return { event_id: id, lease_until: until };
  }
  steps(id) { return this.db.prepare('SELECT step,state,result,updated_ms FROM task_steps WHERE event_id=? ORDER BY step').all(id).map((row) => ({ ...row, result: row.result === null ? null : JSON.parse(row.result) })); }
  checkpoint(id, token, step, phase, result, reviewed = false) {
    return this.transaction(() => {
      this.requireLease(id, token);
      this.db.prepare('UPDATE events SET lease_activity_ms=? WHERE id=?').run(Date.now(), id);
      const prior = this.db.prepare('SELECT * FROM task_steps WHERE event_id=? AND step=?').get(id, step);
      if (prior?.state === 'completed') return { cached: true, step, state: 'completed', result: JSON.parse(prior.result) };
      if (phase === 'started' && prior) fail('step_uncertain', 'This step was already started; verify its external outcome before resolving it.', 409);
      if (phase === 'started' && this.steps(id).some((entry) => entry.state === 'started')) fail('step_uncertain', 'An unfinished step must be reconciled before starting another tool operation.', 409);
      if (phase === 'completed' && (!prior || (prior.lease_token !== token && !reviewed))) fail('step_review_required', 'Completion requires the owning lease, or explicit reviewed=true after verifying the external outcome.', 409);
      this.db.prepare('INSERT INTO task_steps VALUES (?,?,?,?,?,?) ON CONFLICT(event_id,step) DO UPDATE SET state=excluded.state,lease_token=excluded.lease_token,result=excluded.result,updated_ms=excluded.updated_ms')
        .run(id, step, phase, token, JSON.stringify(result ?? null), Date.now());
      return { cached: false, step, state: phase, result: result ?? null };
    });
  }
  queueStats(staleMs = 600000) {
    const now = Date.now();
    const pending = this.db.prepare('SELECT count(*) AS n,min(received_ms) AS oldest,min(CASE WHEN lease_until>? THEN lease_until END) AS next_expiry FROM events WHERE acked_ms IS NULL').get(now);
    const leased = this.db.prepare('SELECT count(*) AS n FROM events WHERE acked_ms IS NULL AND lease_until>?').get(now).n;
    return {
      pending: pending.n, leased, ready: pending.n - leased,
      oldest_pending_ms: pending.oldest, next_lease_expiry_ms: pending.next_expiry,
      stalled_leases: this.db.prepare('SELECT count(*) AS n FROM events WHERE acked_ms IS NULL AND lease_until>? AND coalesce(lease_activity_ms,received_ms)<?').get(now, now - staleMs).n,
      oldest_lease_activity_ms: this.db.prepare('SELECT min(coalesce(lease_activity_ms,received_ms)) AS n FROM events WHERE acked_ms IS NULL AND lease_until>?').get(now).n,
      oldest_ready_ms: this.db.prepare('SELECT min(received_ms) AS n FROM events WHERE acked_ms IS NULL AND lease_until<=?').get(now).n,
      unknown_sends: this.db.prepare("SELECT count(*) AS n FROM sends WHERE state='unknown' AND coalesce(json_extract(result,'$.reviewed'),0)=0").get().n,
      unresolved_steps: this.db.prepare("SELECT count(*) AS n FROM task_steps s JOIN events e ON e.id=s.event_id WHERE s.state='started' AND (s.lease_token<>e.lease_token OR e.lease_until<=?)").get(now).n,
      started_steps: this.db.prepare("SELECT count(*) AS n FROM task_steps s JOIN events e ON e.id=s.event_id WHERE s.state='started' AND e.acked_ms IS NULL").get().n,
    };
  }
  ack(ids) {
    return this.transaction(() => {
      let count = 0;
      const update = this.db.prepare('UPDATE events SET acked_ms=? WHERE id=? AND acked_ms IS NULL');
      for (const id of ids) count += update.run(Date.now(), id).changes;
      return count;
    });
  }
  send(id) {
    const row = this.db.prepare('SELECT * FROM sends WHERE id=?').get(id);
    return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null;
  }
  createSend(id, fingerprint, recipient, clientIds, eventId = null) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO sends(id,fingerprint,recipient,state,created_ms,result) VALUES (?,?,?,?,?,NULL)').run(id, fingerprint, recipient, 'pending', Date.now());
      if (eventId) this.db.prepare('INSERT INTO send_events VALUES (?,?)').run(id, eventId);
      const insert = this.db.prepare('INSERT INTO parts VALUES (?,?,?,?,NULL)');
      clientIds.forEach((clientId, index) => insert.run(id, index, clientId, 'prepared'));
    });
  }
  parts(id) { return this.db.prepare('SELECT * FROM parts WHERE request_id=? ORDER BY part').all(id); }
  media(id, part) {
    const row = this.db.prepare('SELECT body FROM media_jobs WHERE request_id=? AND part=?').get(id, part);
    return row ? JSON.parse(row.body) : null;
  }
  saveMedia(id, part, record) {
    this.db.prepare('INSERT INTO media_jobs VALUES (?,?,?) ON CONFLICT(request_id,part) DO UPDATE SET body=excluded.body').run(id, part, JSON.stringify(record));
  }
  deleteMedia(id, part) { this.db.prepare('DELETE FROM media_jobs WHERE request_id=? AND part=?').run(id, part); }
  retrySend(id) { this.db.prepare("UPDATE sends SET state='pending',result=NULL WHERE id=?").run(id); }
  partState(id, part, state, ms = null) {
    this.db.prepare('UPDATE parts SET state=?,elapsed_ms=? WHERE request_id=? AND part=?').run(state, ms, id, part);
  }
  finish(id, state, result) {
    this.db.prepare('UPDATE sends SET state=?,result=? WHERE id=?').run(state, JSON.stringify(result), id);
  }
  reviewSend(id, note) {
    const row = this.send(id);
    if (!row || row.state !== 'unknown') fail('not_unknown', 'Only an unknown request can be marked reviewed.', 409);
    const result = { ...row.result, reviewed: true, reviewed_at: new Date().toISOString(), review_note: note };
    this.finish(id, 'unknown', result);
    return { request_id: id, state: 'unknown', reviewed: true, resend_allowed: false };
  }
  recoverUncertain() {
    this.transaction(() => {
      this.db.exec("UPDATE parts SET state='unknown' WHERE state='sending'");
      const ids = this.db.prepare("SELECT DISTINCT request_id FROM parts WHERE state='unknown'").all();
      for (const { request_id: id } of ids) {
        if (this.send(id)?.state !== 'unknown') {
          this.finish(id, 'unknown', { ok: false, request_id: id, state: 'unknown', error: 'process_interrupted', accepted_chunks: this.parts(id).filter((part) => part.state === 'accepted').length });
        }
      }
      for (const row of this.db.prepare("SELECT id FROM sends WHERE state='pending'").all()) {
        this.finish(row.id, 'failed', { ok: false, request_id: row.id, state: 'failed', retryable: true, error: 'interrupted_before_confirmation', accepted_chunks: this.parts(row.id).filter((part) => part.state === 'accepted').length });
      }
    });
  }
  metrics() {
    const rows = this.db.prepare('SELECT state,result FROM sends ORDER BY created_ms DESC LIMIT 300').all();
    const accepted = rows.filter((row) => row.state === 'accepted').map((row) => JSON.parse(row.result));
    const percentile = (field, p) => {
      const values = accepted.map((row) => row.timing?.[field]).filter(Number.isFinite).sort((a, b) => a - b);
      return values.length ? values[Math.ceil(values.length * p) - 1] : null;
    };
    return {
      window_requests: rows.length,
      states: Object.fromEntries(['pending', 'accepted', 'rejected', 'unknown', 'failed'].map((state) => [state, rows.filter((row) => row.state === state).length])),
      accepted_latency_ms: { p50: percentile('bridge_ms', 0.5), p95: percentile('bridge_ms', 0.95) },
      first_chunk_ms: { p50: percentile('first_chunk_ms', 0.5), p95: percentile('first_chunk_ms', 0.95) },
    };
  }
}
