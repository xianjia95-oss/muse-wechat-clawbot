import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail, integer } from './errors.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const name = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(s);
const final = new Set(['ready', 'failed']);
export const executorJobId = (eventId) => `draft-${hash(eventId).slice(0, 40)}`;

function openSchema(fn) {
  // SQLite may return BUSY immediately when concurrent first openers switch
  // the journal mode or invalidate an initial schema snapshot. Retry ONLY
  // this idempotent bootstrap, never a business operation or external action.
  const until = Date.now() + 5000, sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return fn(); }
    catch (error) {
      if ((error.errcode & 255) !== 5 || Date.now() >= until) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(20, until - Date.now()));
    }
  }
}

// A mailbox for REAL, prestarted Muse tasks, not a local model runner. Only the
// conversation owner holds bridge/session/event credentials. Same-UID clients
// cooperate through this protocol; filesystem access is not a security sandbox.
export class ExecutorPool {
  constructor(root) {
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) fail('unsafe_executor_pool', 'Use a normalized absolute private directory.');
    this.root = resolve(root);
    for (let path = existsSync(this.root) ? this.root : dirname(this.root); ; path = dirname(path)) {
      const s = lstatSync(path);
      if (!s.isDirectory() || s.isSymbolicLink() || (path === this.root && process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid())))
        fail('unsafe_executor_pool', 'Use a private real directory without symbolic links.');
      if (path === dirname(path)) break;
    }
    try { mkdirSync(this.root, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const rootStat = lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.platform !== 'win32' && ((rootStat.mode & 0o077) || rootStat.uid !== process.getuid())))
      fail('unsafe_executor_pool', 'Use a private real directory without symbolic links.');
    const path = join(this.root, 'executor.sqlite');
    const existed = existsSync(path);
    if (existed) {
      const s = lstatSync(path);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid())))
        fail('unsafe_executor_pool', 'Executor database must be a private regular file.');
    }
    this.db = new DatabaseSync(path);
    try {
      if (!existed) chmodSync(path, 0o600);
      openSchema(() => {
        // Set the busy handler BEFORE the first schema read. Every process opens
        // its own connection; a concurrent writer may already hold the WAL lock.
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version > 2) fail('executor_future_schema', 'Retain the executor database; its schema is newer.');
        if (version === 0) this.db.exec('PRAGMA journal_mode=WAL;');
        if (version < 2) this.transaction(() => {
          // Another opener may have completed migration while this one waited.
          let current = this.db.prepare('PRAGMA user_version').get().user_version;
          if (current > 2) fail('executor_future_schema', 'Retain the executor database; its schema is newer.');
          if (current === 0) {
            this.db.exec(`CREATE TABLE slots (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, runner TEXT, activity_ms INTEGER);
              CREATE TABLE jobs (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, lease_hash TEXT NOT NULL,
                owner_files TEXT NOT NULL, payload TEXT, state TEXT NOT NULL, slot INTEGER, claim_token TEXT,
                result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, settled_ms INTEGER);
              CREATE INDEX job_queue ON jobs(state,created_ms);`);
            current = 1;
          }
          if (current === 1) {
            this.db.exec(`ALTER TABLE jobs ADD COLUMN assigned_runner TEXT;
              CREATE TABLE pool_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
              PRAGMA user_version=2;`);
            // Older jobs have no captured runner. Do not guess from today's slot.
          }
        });
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  room(bytes) {
    const s = statfsSync(this.root);
    if (s.bavail * s.bsize < 128 * 1024 * 1024 + bytes) fail('executor_disk_low', 'Preserve the pending event; executor storage has insufficient headroom.', 507);
  }
  bindOwner(scope, reviewed = false) {
    if (!scope || ['config', 'session', 'endpoint'].some((key) => typeof scope[key] !== 'string' || !scope[key]))
      fail('executor_owner_scope', 'Supply the verified original owner scope.');
    const normalized = JSON.stringify({ config: scope.config, session: scope.session, endpoint: scope.endpoint });
    return this.transaction(() => {
      const bound = this.db.prepare("SELECT value FROM pool_metadata WHERE key='owner_scope'").get();
      if (bound) {
        if (bound.value !== normalized) fail('executor_owner_scope', 'Use the original owner config, session and mailbox.');
        return;
      }
      const old = this.db.prepare('SELECT DISTINCT owner_files FROM jobs').all();
      for (const row of old) {
        const files = JSON.parse(row.owner_files);
        if (['config', 'session', 'endpoint'].some((key) => files[key] !== scope[key]))
          fail('executor_owner_scope', 'Reconcile historical owner scopes before adopting this mailbox.');
      }
      if (!old.length && this.db.prepare('SELECT count(*) AS n FROM slots').get().n && reviewed !== true)
        fail('executor_owner_review_required', 'Review this older registered mailbox before adopting its owner scope.');
      this.db.prepare("INSERT INTO pool_metadata(key,value) VALUES ('owner_scope',?)").run(normalized);
    });
  }
  uniqueRunner(slot, runner) {
    if (this.db.prepare('SELECT 1 FROM slots WHERE runner=? AND id<>?').get(runner, slot))
      fail('executor_runner_conflict', 'A native task handle cannot occupy both executor slots.', 409);
  }
  register(slot) {
    integer(slot, 1, 2, 'slot');
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM slots WHERE id=?').get(slot)) fail('executor_slot_registered', 'Use the original private executor file. Do not rotate an active slot.', 409);
      const token = randomBytes(32).toString('hex');
      this.db.prepare('INSERT INTO slots(id,token_hash) VALUES (?,?)').run(slot, hash(token));
      return { slot, worker_token: token, pool_dir: this.root, kind: 'muse_executor' };
    });
  }
  authenticate(slot, token, runner) {
    integer(slot, 1, 2, 'slot');
    if (!name(runner)) fail('invalid_executor_runner', 'Supply the actual stable native task handle.');
    const row = this.db.prepare('SELECT * FROM slots WHERE id=?').get(slot);
    if (!row || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
      || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash(token)))) fail('executor_unauthorized', 'Use this slot original private executor file.', 403);
    if (row.runner && row.runner !== runner) fail('executor_slot_owned', 'Another native task owns this slot. Reconcile it before replacement.', 409);
    this.uniqueRunner(slot, runner);
    this.db.prepare('UPDATE slots SET runner=?,activity_ms=? WHERE id=?').run(runner, Date.now(), slot);
  }
  submit({ event_id, lease_token, owner_files, payload }) {
    if (typeof event_id !== 'string' || !event_id || event_id.length > 512 || !/^[a-f0-9]{48}$/.test(lease_token ?? '')) fail('invalid_executor_task', 'Use a captured current event lease.');
    const serialized = JSON.stringify(payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.byteLength(serialized) > 512 * 1024) fail('executor_payload_limit', 'Executor payload must be a scoped snapshot of at most 512 KiB.');
    // These exact credentials can never be part of an executor's task input.
    if (serialized.includes(lease_token)) fail('executor_private_credential', 'Do not pass event credentials to an executor.');
    const id = executorJobId(event_id), leaseHash = hash(lease_token);
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT id,state,lease_hash FROM jobs WHERE id=?').get(id);
      if (prior) {
        if (prior.lease_hash !== leaseHash) fail('executor_lease_changed', 'Reconcile the original draft and external effects before using a different event lease.', 409);
        return { id, state: prior.state, cached: true };
      }
      if (this.db.prepare('SELECT count(*) AS n FROM slots WHERE runner IS NOT NULL').get().n !== 2) fail('executor_pool_not_prepared', 'Start both real Muse tasks, bind their handles, and verify them before submission.', 409);
      this.db.prepare('DELETE FROM jobs WHERE settled_ms IS NOT NULL AND settled_ms<?').run(Date.now() - 7 * 86400000);
      if (this.db.prepare('SELECT count(*) AS n FROM jobs WHERE settled_ms IS NULL').get().n >= 32
        || this.db.prepare('SELECT count(*) AS n FROM jobs').get().n >= 2000) fail('executor_capacity', 'Keep unsubmitted events pending; the bounded executor mailbox is full.', 429);
      this.room(Buffer.byteLength(serialized) + 8192);
      this.db.prepare('INSERT INTO jobs(id,event_id,lease_hash,owner_files,payload,state,created_ms,updated_ms) VALUES (?,?,?,?,?,\'queued\',?,?)')
        .run(id, event_id, leaseHash, JSON.stringify(owner_files), serialized, Date.now(), Date.now());
      return { id, state: 'queued', cached: false };
    });
  }
  take(slot, token, runner) {
    return this.transaction(() => {
      this.authenticate(slot, token, runner);
      const held = this.db.prepare("SELECT id,state FROM jobs WHERE slot=? AND state IN ('running','waiting_for_authorization')").get(slot);
      // A missed response is not permission to rerun a possibly started tool.
      if (held) return { task: null, active_job: held.id, state: held.state, recovery_required: true };
      const row = this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created_ms,rowid LIMIT 1").get();
      if (!row) return { task: null };
      const claimToken = randomBytes(24).toString('hex');
      this.db.prepare("UPDATE jobs SET state='running',slot=?,claim_token=?,assigned_runner=?,updated_ms=? WHERE id=?")
        .run(slot, claimToken, runner, Date.now(), row.id);
      return { task: { id: row.id, claim_token: claimToken, payload: JSON.parse(row.payload) } };
    });
  }
  finish(slot, token, runner, id, claimToken, state, result) {
    if (!['ready', 'failed', 'waiting_for_authorization'].includes(state) || !name(id)) fail('invalid_executor_result', 'Provide a bounded real result or verified authorization block.');
    const serialized = JSON.stringify(result);
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.text !== 'string'
      || !result.text.trim() || Buffer.byteLength(serialized) > 65536 || Object.keys(result).some((k) => !['text', 'evidence'].includes(k))) fail('invalid_executor_result', 'Result requires real text and optional evidence, at most 64 KiB.');
    return this.transaction(() => {
      this.authenticate(slot, token, runner);
      const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (!row || row.slot !== slot || typeof claimToken !== 'string' || row.claim_token !== claimToken) fail('stale_executor_claim', 'Use the original executor claim; do not copy database tokens.', 409);
      if (serialized.includes(token) || serialized.includes(claimToken))
        fail('executor_private_credential', 'Do not include executor credentials in draft text or evidence.');
      if (row.settled_ms) fail('executor_settled', 'The owner already completed this draft.', 409);
      if (final.has(row.state)) {
        if (row.state === state && row.result === serialized) return { id, state, cached: true };
        fail('executor_result_conflict', 'A final draft result is immutable.', 409);
      }
      this.room(Buffer.byteLength(serialized) + 4096);
      this.db.prepare('UPDATE jobs SET state=?,result=?,updated_ms=? WHERE id=?').run(state, serialized, Date.now(), id);
      return { id, state, cached: false, event_acknowledged: false };
    });
  }
  status() {
    return { slots: this.db.prepare('SELECT id,runner,activity_ms FROM slots ORDER BY id').all(),
      states: Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM jobs GROUP BY state').all().map((r) => [r.state, r.n])),
      native_liveness_verified: false };
  }
  results() {
    return this.db.prepare("SELECT id,event_id,state,owner_files,updated_ms FROM jobs WHERE settled_ms IS NULL AND state IN ('ready','failed','waiting_for_authorization') ORDER BY updated_ms,id LIMIT 32")
      .all().map((row) => ({ ...row, owner_files: JSON.parse(row.owner_files) }));
  }
  inspect(id) {
    if (!name(id)) fail('invalid_executor_id', 'Provide a stable executor job ID.');
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) fail('executor_not_found', 'No draft with this ID exists.', 404);
    return { id, event_id: row.event_id, state: row.state, slot: row.slot,
      runner: row.assigned_runner, owner_files: JSON.parse(row.owner_files),
      result: row.result ? JSON.parse(row.result) : null, updated_ms: row.updated_ms, settled_ms: row.settled_ms };
  }
  cancel(id) {
    return this.transaction(() => {
      const row = this.inspect(id);
      if (row.state !== 'queued') fail('executor_cancel_requires_review', 'Only an unclaimed draft can be cancelled here. Reconcile a running native task first.', 409);
      this.db.prepare("UPDATE jobs SET state='failed',result=?,updated_ms=? WHERE id=?").run(JSON.stringify({ text: 'Cancelled before any executor claim.' }), Date.now(), id);
      return { id, state: 'failed', cancelled_before_claim: true };
    });
  }
  settle(id) {
    return this.transaction(() => {
      const row = this.inspect(id);
      if (!final.has(row.state)) fail('executor_unfinished', 'Review the original native task before settling.', 409);
      this.db.prepare('UPDATE jobs SET payload=NULL,result=NULL,claim_token=NULL,settled_ms=coalesce(settled_ms,?) WHERE id=?').run(Date.now(), id);
      return { id, settled: true };
    });
  }
  recover(slot, newRunner, reviewed, { rotateWorker = false } = {}) {
    integer(slot, 1, 2, 'slot');
    if (reviewed !== true || !name(newRunner)) fail('executor_review_required', 'Confirm the original native task stopped and reconcile its external effects before recovery.');
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM slots WHERE id=?').get(slot)) fail('executor_not_found', 'No registered slot.', 404);
      this.uniqueRunner(slot, newRunner);
      const row = this.db.prepare("SELECT * FROM jobs WHERE slot=? AND state IN ('running','waiting_for_authorization')").get(slot);
      const claimToken = randomBytes(24).toString('hex');
      this.db.prepare('UPDATE slots SET runner=?,activity_ms=? WHERE id=?').run(newRunner, Date.now(), slot);
      let worker;
      if (rotateWorker) {
        const token = randomBytes(32).toString('hex');
        this.db.prepare('UPDATE slots SET token_hash=? WHERE id=?').run(hash(token), slot);
        worker = { slot, worker_token: token, pool_dir: this.root, kind: 'muse_executor_slot' };
      }
      if (!row) return { task: null, slot, ...(worker ? { worker } : {}) };
      this.db.prepare('UPDATE jobs SET claim_token=?,assigned_runner=?,updated_ms=? WHERE id=?').run(claimToken, newRunner, Date.now(), row.id);
      return { task: { id: row.id, claim_token: claimToken, payload: JSON.parse(row.payload),
        prior_state: row.state, prior_result: row.result ? JSON.parse(row.result) : null, reconcile_before_execution: true }, ...(worker ? { worker } : {}) };
    });
  }
}
