import { mkdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Bridge } from './bridge.mjs';
import { Store } from './store.mjs';
import { createApi } from './server.mjs';
import { loadConfig, localUrl, privateJson, VERSION } from './config.mjs';
import { readPrivateDocument } from './task-file.mjs';
import { lockState } from './state-lock.mjs';
import { museRequestId } from './muse.mjs';
import { fail, integer } from './errors.mjs';

export const SIMULATION_MODE = 'isolated_simulation_v1';
const PEER = 'simulation-client';
const MAX_MESSAGES = 1000;
const checkId = (id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail('invalid_test_id', 'id requires 1..64 letters, digits, _ or -.');
  return id;
};
const eventId = (id) => `simulation:test-${checkId(id)}`;
const iso = (ms) => ms == null ? null : new Date(ms).toISOString();

// Explicit opt-in, fresh directory, synthetic identity and separate client key.
// Never reads the production config, session, database or login credentials.
export function initSimulation(directory, port = 18792) {
  integer(port, 1, 65535, 'port');
  const root = resolve(directory);
  const parent = realpathSync(dirname(root));
  if (parent !== dirname(root)) fail('simulation_path', 'Use a canonical path without symlink ancestors.');
  mkdirSync(root, { mode: 0o700 }); // EEXIST is intentional: never adopt old state.
  // Protect runtime credentials even if somebody chooses a path inside a repo.
  writeFileSync(join(root, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' });
  const configPath = join(root, 'config.json');
  privateJson(configPath, {
    transport: SIMULATION_MODE, binding: 'simulation', state_dir: join(root, 'state'),
    listen: { host: '127.0.0.1', port }, api_token: randomBytes(32).toString('hex'),
    allow_wxids: [PEER], send_timeout_ms: 1000, poll_timeout_ms: 45000,
    media_roots: [], require_lease_token: true,
    operations: { max_pending_events: 128, max_http_requests: 32 },
  });
  privateJson(join(root, 'client.json'), { mode: SIMULATION_MODE, origin: `http://127.0.0.1:${port}`, token: randomBytes(32).toString('hex') });
  return { mode: SIMULATION_MODE, config_file: configPath, client_file: join(root, 'client.json'), network_opened: false };
}

function simulationConfig(directory) {
  const root = resolve(directory);
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root) !== root
    || (process.platform !== 'win32' && (info.mode & 0o077))) fail('simulation_path', 'Use the original private simulation directory.');
  const raw = readPrivateDocument(join(root, 'config.json'));
  if (raw.transport !== SIMULATION_MODE || raw.binding !== 'simulation' || raw.state_dir !== join(root, 'state')
    || raw.allow_wxids?.length !== 1 || raw.allow_wxids[0] !== PEER || raw.media_roots?.length !== 0 || raw.require_lease_token !== true)
    fail('simulation_scope', 'Simulation cannot adopt another binding, state directory or recipient.');
  const config = loadConfig(join(root, 'config.json'));
  const client = readPrivateDocument(join(root, 'client.json'));
  if (client.mode !== SIMULATION_MODE || client.origin !== localUrl(config) || !/^[a-f0-9]{64}$/.test(client.token ?? '') || client.token === config.api_token)
    fail('simulation_scope', 'Use the original separate test client credentials.');
  return { config, client };
}

// No network implementation exists in this transport. An accepted result means
// local simulation transport acceptance, never WeChat delivery or model success.
class SimulationTransport {
  mode = SIMULATION_MODE;
  async sendText(session, recipient) {
    if (session?.simulation !== true || recipient !== PEER) fail('simulation_scope', 'Only the synthetic test conversation is allowed.', 403);
  }
  async close() {}
}

export class SimulationClientApi {
  constructor(bridge, token) {
    if (bridge.config.transport !== SIMULATION_MODE || bridge.ilink.mode !== SIMULATION_MODE
      || bridge.store.get('transport_mode') !== SIMULATION_MODE) fail('simulation_scope', 'Test API requires isolated simulation storage and transport.');
    this.bridge = bridge;
    this.token = token;
  }
  status() {
    const status = this.bridge.status();
    return { mode: SIMULATION_MODE, version: VERSION, queue: status.queue,
      worker: { claim_requests: status.worker.claim_requests, claimed_events: status.worker.claimed_events,
        last_claim_at: status.worker.last_claim_at, reply_requests: status.worker.reply_requests },
      max_messages: MAX_MESSAGES, transport: 'local_text_only',
      muse_liveness_verified: false, wechat_connected: false, phone_delivery_verified: false };
  }
  inject(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['id', 'text'].includes(key)))
      fail('invalid_test_message', 'Only id and text are accepted.');
    const id = checkId(body.id);
    if (typeof body.text !== 'string' || !body.text.trim()) fail('invalid_test_text', 'Nonempty text is required.');
    if (Buffer.byteLength(body.text) > 16 * 1024) fail('test_text_too_large', 'Maximum test message is 16 KiB.', 413);
    const prior = this.bridge.store.event(eventId(id));
    if (prior) {
      if (prior.event.text !== body.text) fail('test_id_conflict', 'This id belongs to another message. Use a new id.', 409);
      return { created: false, ...this.message(id) };
    }
    if (this.bridge.store.db.prepare('SELECT count(*) AS n FROM events').get().n >= MAX_MESSAGES)
      fail('simulation_capacity', 'Use a fresh simulation directory after this test run.', 429);
    this.bridge.ingest({ msgs: [{ message_id: `test-${id}`, from_user_id: PEER,
      context_token: 'simulation-context', item_list: [{ type: 1, text_item: { text: body.text } }] }] });
    return { created: true, ...this.message(id) };
  }
  message(id, { offset = 0, limit = 10 } = {}) {
    const eid = eventId(id);
    integer(offset, 0, 100000, 'offset'); integer(limit, 1, 20, 'limit');
    const db = this.bridge.store.db;
    const row = db.prepare('SELECT body,received_ms,acked_ms,lease_until,lease_activity_ms FROM events WHERE id=?').get(eid);
    if (!row || JSON.parse(row.body).from_wxid !== PEER) fail('test_not_found', 'Unknown retained test message.', 404);
    const final = this.bridge.store.send(museRequestId(eid));
    const task = db.prepare('SELECT state,updated_ms FROM conversation_tasks WHERE event_id=?').get(eid);
    const records = db.prepare(`SELECT s.state,s.created_ms,s.result,h.mode,h.text,h.recorded_ms
      FROM send_events x JOIN sends s ON s.id=x.request_id LEFT JOIN reply_history h ON h.request_id=s.id
      WHERE x.event_id=? ORDER BY s.created_ms,s.rowid LIMIT ? OFFSET ?`).all(eid, limit + 1, offset);
    const replies = []; let bytes = 0;
    for (const record of records.slice(0, limit)) {
      const result = record.result ? JSON.parse(record.result) : null;
      const reply = { mode: record.mode ?? 'unknown', state: record.state,
        text: record.recorded_ms == null ? null : record.text,
        content_status: record.recorded_ms == null ? 'not_recorded' : 'recorded',
        submitted_at: iso(record.created_ms), accepted_at: record.state === 'accepted' ? result?.accepted_at ?? null : null,
        error: result?.error ?? null };
      const size = Buffer.byteLength(JSON.stringify(reply));
      if (bytes + size > 240 * 1024) break;
      bytes += size; replies.push(reply);
    }
    const done = final?.state === 'accepted' && row.acked_ms !== null;
    const stage = done ? 'done' : final?.state === 'accepted' ? 'accepted_awaiting_ack'
      : final ? final.state === 'pending' ? 'sending' : final.state
        : row.acked_ms !== null ? 'acked_without_final' : row.lease_until > Date.now() ? 'leased' : 'queued';
    return { mode: SIMULATION_MODE, id, state: stage, done,
      received_at: iso(row.received_ms), last_lease_activity_at: iso(row.lease_activity_ms),
      task_state: task?.state ?? null, task_updated_at: iso(task?.updated_ms),
      lease_until: row.lease_until ? iso(row.lease_until) : null, acked_at: iso(row.acked_ms),
      accepted_at: final?.state === 'accepted' ? final.result?.accepted_at ?? null : null,
      elapsed_ms: done ? Math.max(0, row.acked_ms - row.received_ms) : Date.now() - row.received_ms,
      replies, has_more: records.length > replies.length,
      next_offset: records.length > replies.length ? offset + replies.length : null,
      wechat_connected: false, phone_delivery_verified: false };
  }
}

export async function startSimulation(directory) {
  const { config, client } = simulationConfig(directory);
  const unlock = lockState(config.state_dir);
  let store, bridge, server;
  try {
    store = new Store(config.state_dir);
    const mode = store.get('transport_mode');
    if (mode !== null && mode !== SIMULATION_MODE) fail('simulation_scope', 'Unexpected database transport.');
    if (mode === null && (store.get('session') || store.db.prepare('SELECT count(*) AS n FROM events').get().n))
      fail('simulation_scope', 'An existing database cannot be adopted as simulation.');
    store.set('transport_mode', SIMULATION_MODE);
    store.set('session', { simulation: true, ilink_user_id: PEER });
    store.recoverUncertain();
    bridge = new Bridge(config, store, new SimulationTransport());
    bridge.poll = { state: 'simulation', last_ok_at: null, error: null };
    server = createApi(bridge, { testClient: new SimulationClientApi(bridge, client.token) });
    server.listen(config.listen.port, config.listen.host);
    await once(server, 'listening');
    let closed = false;
    return { bridge, server, config, async close() {
      if (closed) return; closed = true;
      bridge.stopping = true; server.close();
      await bridge.close(); server.closeAllConnections(); store.close(); unlock();
    } };
  } catch (error) {
    server?.close(); server?.closeAllConnections(); await bridge?.close(); store?.close(); unlock(); throw error;
  }
}
