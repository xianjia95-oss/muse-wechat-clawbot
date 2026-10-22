import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fixture, deferred, reply } from './helpers.mjs';
import { Bridge } from '../src/bridge.mjs';
import { BridgeError } from '../src/errors.mjs';
import { MuseAdapter } from '../src/muse.mjs';
import { Resources, health } from '../src/operations.mjs';
import { Store } from '../src/store.mjs';
import { lockState } from '../src/state-lock.mjs';
import { maintain } from '../src/maintenance.mjs';
import { backupState, verifyBackup, restoreState } from '../src/backup.mjs';
import { initConfig, loadConfig, privateJson, operational } from '../src/config.mjs';
import { prepareMedia, snapshotAvailable } from '../src/media.mjs';
import { createApi } from '../src/server.mjs';

const day = 86400000;
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const exec = promisify(execFile);
const cli = async (path, args, input) => {
  if (input === undefined) return JSON.parse((await exec(process.execPath, [cliPath, '--config', path, ...args])).stdout);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--config', path, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject); child.on('close', (code) => { try { if (code) throw new Error(stderr + stdout); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
    child.stdin.end(input);
  });
};
function area(t) { const root = mkdtempSync(join(tmpdir(), 'muse-link-ops-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function incoming(bridge, id = 'ops') { bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [] }], get_updates_buf: id }); return `muse:${id}`; }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');

test('old config adopts operational defaults; typos and invalid retention are rejected', (t) => {
  const path = join(area(t), 'config.json'); initConfig(path);
  const raw = JSON.parse(readFileSync(path)); delete raw.operations; delete raw.require_lease_token; privateJson(path, raw);
  const config = loadConfig(path);
  assert.equal(config.require_lease_token, true); assert.equal(config.operations.max_inflight_sends, 64);
  assert.equal(config.operations.worker_claim_warn_ms, 60000);
  privateJson(path, { ...raw, operations: { max_peer_send: 1 } }); assert.throws(() => loadConfig(path), /Unknown operations/);
  privateJson(path, { ...raw, operations: { send_retention_days: 1 } }); assert.throws(() => loadConfig(path), /retention/);
});

test('send capacity rejects new intents before persistence while duplicate in-flight IDs share work', async (t) => {
  const gate = deferred();
  const { bridge, config, store, calls } = fixture(t, { sendText: async (...args) => { calls.push(args); await gate.promise; } });
  config.operations = { max_inflight_sends: 1, max_peer_sends: 1 };
  const first = bridge.send(reply('bounded'));
  assert.equal(bridge.send(reply('bounded')), first);
  assert.throws(() => bridge.send(reply('overflow')), { code: 'queue_full', status: 429 });
  assert.equal(store.send('overflow'), null);
  gate.resolve(); await first;
  await bridge.send(reply('overflow')); assert.equal(calls.length, 2); assert.equal(bridge.peerCounts.size, 0);
});

test('inbox pressure rolls back the entire batch, tokens and cursor; duplicate batches remain safe', (t) => {
  const { bridge, config, store } = fixture(t); config.operations = { max_pending_events: 1 };
  incoming(bridge, 'one');
  assert.throws(() => bridge.ingest({ msgs: [{ message_id: 'two', from_user_id: 'owner', context_token: 'must-not-commit' }], get_updates_buf: 'new' }), { code: 'inbox_full' });
  assert.equal(store.get('cursor'), 'one'); assert.equal(store.context('owner'), 'context-1'); assert.equal(store.event('muse:two'), null);
  incoming(bridge, 'one'); assert.equal(store.queueStats().pending, 1);
  store.ack(['muse:one']); incoming(bridge, 'two'); assert.equal(store.get('cursor'), 'two');
});

test('storage pressure rejects before send; concurrent media reservations cannot overcommit', (t) => {
  const { bridge, config, store } = fixture(t);
  config.operations = { min_free_bytes: 100, max_state_bytes: 1000, max_outbox_bytes: 500 };
  const resources = new Resources(config, () => ({ free_bytes: 600, state_bytes: 100, outbox_bytes: 0 }));
  const release = resources.reserve(400);
  assert.throws(() => resources.reserve(101), { code: 'storage_pressure' }); release(); release(); assert.equal(resources.reserved, 0);
  bridge.resources = new Resources(config, () => ({ free_bytes: 1, state_bytes: 100, outbox_bytes: 0 }));
  assert.throws(() => bridge.send(reply()), { code: 'storage_pressure' }); assert.equal(store.send('request-1'), null);
});

test('production leases fence stale workers; a started tool step cannot be executed again', async (t) => {
  const { bridge, config, store, calls } = fixture(t); config.require_lease_token = true;
  const adapter = new MuseAdapter(bridge); const id = incoming(bridge);
  const first = (await adapter.next()).tasks[0];
  await assert.rejects(adapter.reply({ event_id: id, text: 'result' }), { code: 'stale_lease' });
  adapter.checkpoint({ event_id: id, lease_token: first.lease_token, step: 'external-action', phase: 'started' });
  store.db.exec('UPDATE events SET lease_until=0');
  const second = (await adapter.next()).tasks[0];
  assert.equal(second.execution.needs_review, true); assert.notEqual(second.lease_token, first.lease_token);
  assert.throws(() => adapter.renew({ event_id: id, lease_token: first.lease_token }), { code: 'stale_lease' });
  assert.throws(() => adapter.checkpoint({ event_id: id, lease_token: second.lease_token, step: 'external-action', phase: 'started' }), { code: 'step_uncertain' });
  assert.throws(() => adapter.checkpoint({ event_id: id, lease_token: second.lease_token, step: 'external-action', phase: 'completed' }), { code: 'step_review_required' });
  await assert.rejects(adapter.reply({ event_id: id, lease_token: second.lease_token, text: 'result' }), { code: 'task_step_uncertain' });
  adapter.checkpoint({ event_id: id, lease_token: second.lease_token, step: 'external-action', phase: 'completed', reviewed: true, result: { verified: 'done' } });
  assert.equal(adapter.checkpoint({ event_id: id, lease_token: second.lease_token, step: 'external-action', phase: 'started' }).cached, true);
  adapter.renew({ event_id: id, lease_token: second.lease_token, lease_ms: 60000 });
  await adapter.reply({ event_id: id, lease_token: second.lease_token, text: 'result' }); assert.equal(calls.length, 1);
});

test('readiness detects stale polls, backlog and unknown sends; review never permits a resend', async (t) => {
  const { bridge, config, store } = fixture(t, { sendText: async () => { throw new BridgeError('upstream_unknown', 'test uncertainty', 502); } });
  config.require_lease_token = true; bridge.poll = { state: 'waiting', last_ok_at: new Date().toISOString(), error: null };
  assert.equal(health(bridge).healthy, true);
  bridge.poll.last_ok_at = new Date(0).toISOString(); assert.ok(health(bridge).problems.includes('wechat_poll_unhealthy'));
  bridge.poll.last_ok_at = new Date().toISOString(); incoming(bridge);
  store.db.exec('UPDATE events SET received_ms=0'); assert.ok(health(bridge).problems.includes('worker_backlog'));
  store.ack(['muse:ops']); await assert.rejects(bridge.send(reply('uncertain')));
  assert.ok(health(bridge).problems.includes('send_outcome_unknown'));
  store.reviewSend('uncertain', 'Operator verified and recorded disposition');
  assert.equal(health(bridge).healthy, true);
  assert.throws(() => bridge.send(reply('uncertain')), { code: 'send_unknown' });
  config.operations = { min_free_bytes: 100, max_state_bytes: 1000, max_outbox_bytes: 500 };
  bridge.resources = new Resources(config, () => ({ free_bytes: 2000, state_bytes: 700, outbox_bytes: 600 }));
  assert.ok(health(bridge).problems.includes('storage_pressure'));
});

test('maintenance prunes completed history, preserves active/unknown intents and freezes expired media', async (t) => {
  const { bridge, config, store, directory } = fixture(t);
  incoming(bridge, 'acknowledged'); store.ack(['muse:acknowledged']);
  const pending = incoming(bridge, 'pending');
  await bridge.send(reply('old-success'));
  store.createSend('protected', 'hash', 'owner', ['protected-part'], pending); store.finish('protected', 'accepted', { timing: {} });
  store.createSend('old-unknown', 'hash2', 'owner', ['uncertain-part']); store.finish('old-unknown', 'unknown', {});
  const root = join(directory, 'media'); mkdirSync(root); config.media_roots = [root];
  const image = join(root, 'test.png'); writeFileSync(image, png);
  store.createSend('expired', 'hash3', 'owner', ['expired-part']);
  const record = await prepareMedia(config, 'expired', 0, { type: 'image', path: image }); store.saveMedia('expired', 0, record); store.finish('expired', 'failed', { retryable: true });
  const orphan = join(directory, 'outbox', 'old.tmp'); writeFileSync(orphan, 'abandoned'); utimesSync(orphan, new Date(0), new Date(0));
  const result = await maintain(bridge, Date.now() + 100 * day);
  assert.equal(result.events, 1); assert.equal(store.event('muse:acknowledged'), null); assert.ok(store.event(pending));
  assert.equal(store.send('old-success'), null); assert.ok(store.send('protected')); assert.ok(store.send('old-unknown'));
  assert.equal(store.send('expired').state, 'unknown'); assert.equal(existsSync(record.cipher_path), false); assert.equal(existsSync(orphan), false);
});

test('busy maintenance skips and shutdown drains existing work while refusing new sends', async (t) => {
  const gate = deferred(); const { bridge } = fixture(t, { sendText: () => gate.promise });
  const sent = bridge.send(reply('drain')); assert.equal((await maintain(bridge)).skipped, 'busy');
  const closing = bridge.close(); assert.throws(() => bridge.send(reply('late')), { code: 'unavailable' });
  gate.resolve(); await Promise.all([sent, closing]); assert.equal((await bridge.send(reply('drain'))).cached, true);
});

test('state ownership excludes a second process and is released after SIGKILL', { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'muse-link-lock-')); const state = join(root, 'state');
  const module = new URL('../src/state-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {lockState} from ${JSON.stringify(module)}; lockState(${JSON.stringify(state)}); console.log('locked'); setInterval(()=>{},1000);`]);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } rmSync(root, { recursive: true, force: true }); });
  await once(child.stdout, 'data'); assert.throws(() => lockState(state), { code: 'state_locked' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const release = lockState(state); release(); release();
});

test('backup refuses live state, verifies hashes and restores snapshots with a mandatory reconciliation gate', async (t) => {
  const root = area(t); const state = join(root, 'source'); const configPath = join(root, 'config.json');
  initConfig(configPath); const config = { ...loadConfig(configPath), state_dir: state, media_roots: [root] }; privateJson(configPath, config);
  const store = new Store(state); store.set('session', { ilink_user_id: 'owner' }); store.saveContext('owner', 'secret-context'); store.set('cursor', 'before-backup');
  const image = join(root, 'image.png'); writeFileSync(image, png);
  store.createSend('snapshot', 'fingerprint', 'owner', ['part']); const record = await prepareMedia(config, 'snapshot', 0, { type: 'image', path: image });
  store.saveMedia('snapshot', 0, record); store.finish('snapshot', 'failed', { retryable: true });
  const backup = join(root, 'backup'); const release = lockState(state);
  await assert.rejects(backupState(config, backup), { code: 'state_locked' }); release(); store.close();
  await backupState(config, backup); await verifyBackup(backup);
  const newConfig = { ...config, state_dir: join(root, 'restored') }; await restoreState(newConfig, backup);
  const restored = new Store(newConfig.state_dir);
  assert.equal(restored.get('cursor'), 'before-backup'); assert.equal(restored.context('owner'), 'secret-context');
  assert.equal(await snapshotAvailable(newConfig, 'snapshot', restored.media('snapshot', 0)), true);
  const bridge = new Bridge(newConfig, restored, {});
  assert.throws(() => bridge.send(reply('after-restore')), { code: 'restore_review_required' });
  await assert.rejects(new MuseAdapter(bridge).next(), { code: 'restore_review_required' });
  await bridge.runPoll(); assert.equal(bridge.poll.state, 'restore_review');
  writeFileSync(join(backup, 'state', 'bridge.sqlite'), 'tampered');
  await assert.rejects(restoreState(newConfig, backup), { code: 'corrupt_backup' });
  assert.equal(restored.get('cursor'), 'before-backup');
  restored.close();
});

test('v0.3 database migration preserves data and the old six-column send INSERT; newer schemas are refused', (t) => {
  const root = area(t); const state = join(root, 'state'); mkdirSync(state); const path = join(state, 'bridge.sqlite');
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE events(id TEXT PRIMARY KEY,body TEXT,received_ms INTEGER,lease_until INTEGER DEFAULT 0,acked_ms INTEGER); CREATE TABLE sends(id TEXT PRIMARY KEY,fingerprint TEXT,recipient TEXT,state TEXT,created_ms INTEGER,result TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES ('cursor','\"preserved\"');"); old.close();
  const store = new Store(state); assert.equal(store.get('cursor'), 'preserved');
  store.db.exec("INSERT INTO sends VALUES ('legacy','hash','owner','pending',0,NULL)");
  assert.equal(store.send('legacy').state, 'pending'); store.close();
  const future = new DatabaseSync(path); future.exec('PRAGMA user_version=999'); future.close();
  assert.throws(() => new Store(state), { code: 'future_schema' });
});

test('real HTTP and CLI enforce checkpoint leases, renewals and explicit review', async (t) => {
  const { bridge, config, store, directory } = fixture(t); config.require_lease_token = true;
  const server = createApi(bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  config.listen.port = server.address().port; const path = join(directory, 'config.json'); privateJson(path, config);
  const event = incoming(bridge, 'http-lease'); const claimed = (await cli(path, ['muse', 'next'])).tasks[0];
  const lease = ['--lease-token', claimed.lease_token];
  await cli(path, ['muse', 'renew', event, ...lease, '--lease', '1m']);
  await cli(path, ['muse', 'checkpoint', event, ...lease, '--step', 'work', '--phase', 'started']);
  await assert.rejects(cli(path, ['muse', 'reply', event, ...lease, '--text', '-'], 'premature'));
  await cli(path, ['muse', 'checkpoint', event, ...lease, '--step', 'work', '--phase', 'completed', '--text', '-'], 'tool result');
  assert.equal((await cli(path, ['muse', 'reply', event, ...lease, '--text', '-'], 'done')).state, 'accepted');
  const stale = await fetch(`http://127.0.0.1:${config.listen.port}/v1/muse/renew`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_token}` }, body: JSON.stringify({ event_id: event, lease_token: claimed.lease_token }) });
  assert.equal(stale.status, 409); assert.notEqual(store.event(event).acked_ms, null);
});

test('backup CLI roundtrip preserves config and requires an explicit restore review', async (t) => {
  const root = area(t); const path = join(root, 'config.json'); initConfig(path);
  const config = loadConfig(path); config.state_dir = join(root, 'state'); privateJson(path, config);
  const store = new Store(config.state_dir); store.set('cursor', 'cli-roundtrip'); store.close();
  const savedConfig = readFileSync(path, 'utf8'); const backup = join(root, 'backup');
  assert.equal((await cli(path, ['backup', '--output', backup])).ok, true);
  assert.equal((await cli(path, ['backup', 'verify', '--from', backup])).ok, true);
  assert.equal((await cli(path, ['restore', '--from', backup])).review_required, true);
  await assert.rejects(cli(path, ['restore', 'approve', '--text', '-'], 'missing explicit review'));
  assert.equal((await cli(path, ['restore', 'approve', '--reviewed', '--text', '-'], 'Reconciled external outcomes and inbox against private records')).approved, true);
  const restored = new Store(config.state_dir);
  assert.equal(restored.get('restore_review_required'), false); assert.equal(restored.get('cursor'), 'cli-roundtrip'); restored.close();
  assert.equal(readFileSync(path, 'utf8'), savedConfig);
});

test('HTTP readiness is authenticated and request saturation returns bounded Retry-After', async (t) => {
  const { bridge, config } = fixture(t); config.require_lease_token = true; config.operations = { max_http_requests: 1 };
  const server = createApi(bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const origin = `http://127.0.0.1:${server.address().port}`; const headers = { Authorization: `Bearer ${config.api_token}` };
  assert.equal((await fetch(origin + '/v1/health')).status, 401);
  const unhealthy = await fetch(origin + '/v1/health', { headers }); assert.equal(unhealthy.status, 503); assert.equal(unhealthy.headers.get('retry-after'), '5'); await unhealthy.json();
  const requested = once(server, 'request'); const waiting = fetch(origin + '/v1/muse/tasks?wait=2s', { headers }); await requested;
  const capacity = await fetch(origin + '/v1/status', { headers }); assert.equal(capacity.status, 503); assert.equal((await capacity.json()).error, 'http_capacity');
  incoming(bridge); assert.equal((await (await waiting).json()).tasks.length, 1);
  const tooLarge = await fetch(origin + '/v1/send', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(300000) }) });
  assert.equal(tooLarge.status, 413); await tooLarge.json();
});

test('failed media preparation releases reserved bytes and repeated alerts remain bounded', async (t) => {
  const { bridge, config, directory, store } = fixture(t); config.media_roots = [directory];
  const file = join(directory, 'invalid.png'); writeFileSync(file, 'not an image');
  await assert.rejects(prepareMedia(config, 'invalid', 0, { type: 'image', path: file }, (size) => bridge.resources.reserve(size)));
  assert.equal(bridge.resources.reserved, 0);
  bridge.alert('unreachable', 'test'); bridge.alert('unreachable', 'test again'); assert.equal(store.queueStats().pending, 1);
  config.operations = { max_pending_events: 1 }; bridge.alert('recovered', 'still bounded'); assert.equal(store.queueStats().pending, 1);
});

test('daemon state lock is independent of API port; read-only hook diagnostics work while running', { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'muse-link-daemon-')); const path = join(root, 'config.json'); initConfig(path);
  const config = loadConfig(path); config.state_dir = join(root, 'state');
  const portServer = createApi({ config }); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening'); config.listen.port = portServer.address().port;
  await new Promise((done) => portServer.close(done)); privateJson(path, config);
  const store = new Store(config.state_dir); store.set('restore_review_required', true); store.close(); // No real WeChat network.
  const child = spawn(process.execPath, [cliPath, '--config', path, 'run']); let logs = '';
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } rmSync(root, { recursive: true, force: true }); });
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Daemon startup timeout: ' + logs)), 5000);
    child.stdout.on('data', (chunk) => { logs += chunk; if (logs.includes('"event":"listening"')) { clearTimeout(timer); resolve(); } });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}: ${logs}`)); });
  });
  assert.equal(await cli(path, ['inbox', 'count']), 0);
  const other = join(root, 'other.json'); privateJson(other, { ...config, listen: { ...config.listen, port: config.listen.port === 65535 ? 65534 : config.listen.port + 1 } });
  await assert.rejects(cli(other, ['run']), (error) => error.stderr.includes('state_locked'));
  const done = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await done;
  if (process.platform !== 'win32') assert.equal(code, 0);
  const release = lockState(config.state_dir); release();
});

test('live observer writes private readiness evidence without sending or claiming work', { timeout: 15000 }, async (t) => {
  const { bridge, config, directory, calls } = fixture(t); config.require_lease_token = true;
  bridge.poll = { state: 'waiting', last_ok_at: new Date().toISOString(), error: null };
  const server = createApi(bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  config.listen.port = server.address().port; const path = join(directory, 'config.json'); privateJson(path, config);
  const observer = fileURLToPath(new URL('../scripts/observe.mjs', import.meta.url)); const report = join(directory, 'observation.json');
  await exec(process.execPath, [observer, '--config', path, '--duration', '1s', '--interval', '1s', '--report', report]);
  const body = readFileSync(report, 'utf8'); const value = JSON.parse(body);
  assert.equal(value.completed, true); assert.ok(value.sample_count >= 1); assert.equal(value.unhealthy_samples, 0); assert.equal(calls.length, 0);
  assert.equal(body.includes(config.api_token), false); assert.equal(value.phone_delivery_verified, false);
  bridge.poll.last_ok_at = new Date(0).toISOString();
  await assert.rejects(exec(process.execPath, [observer, '--config', path, '--duration', '1s', '--interval', '1s', '--report', report]));
  assert.ok(JSON.parse(readFileSync(report)).unhealthy_samples > 0);
});
