import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, 'bridge.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
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
    const row = this.db.prepare('SELECT body,lease_until,acked_ms FROM events WHERE id=?').get(id);
    return row ? { event: JSON.parse(row.body), lease_until: row.lease_until, acked_ms: row.acked_ms } : null;
  }
  count() {
    return this.db.prepare('SELECT count(*) AS n FROM events WHERE acked_ms IS NULL AND lease_until<=?').get(Date.now()).n;
  }
  claim(limit = 20, leaseMs = 1800000) {
    return this.transaction(() => {
      const now = Date.now();
      const rows = this.db.prepare('SELECT id,body FROM events WHERE acked_ms IS NULL AND lease_until<=? ORDER BY received_ms,id LIMIT ?').all(now, limit);
      const update = this.db.prepare('UPDATE events SET lease_until=? WHERE id=?');
      for (const row of rows) update.run(now + leaseMs, row.id);
      return rows.map((row) => JSON.parse(row.body));
    });
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
  createSend(id, fingerprint, recipient, clientIds) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO sends VALUES (?,?,?,?,?,NULL)').run(id, fingerprint, recipient, 'pending', Date.now());
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
  recoverUncertain() {
    this.transaction(() => {
      this.db.exec("UPDATE parts SET state='unknown' WHERE state='sending'");
      const ids = this.db.prepare("SELECT DISTINCT request_id FROM parts WHERE state='unknown'").all();
      for (const { request_id: id } of ids) {
        if (this.send(id)?.state !== 'unknown') {
          this.finish(id, 'unknown', { ok: false, request_id: id, state: 'unknown', error: 'process_interrupted', accepted_chunks: this.parts(id).filter((part) => part.state === 'accepted').length });
        }
      }
    });
  }
  metrics() {
    const rows = this.db.prepare('SELECT state,result FROM sends ORDER BY created_ms DESC LIMIT 300').all();
    const accepted = rows.filter((row) => row.state === 'accepted').map((row) => JSON.parse(row.result));
    const percentile = (field, p) => {
      const values = accepted.map((row) => row.timing[field]).filter(Number.isFinite).sort((a, b) => a - b);
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
