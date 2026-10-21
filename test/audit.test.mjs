import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fixture, deferred, reply } from './helpers.mjs';
import { createApi } from '../src/server.mjs';
import { backupState, restoreState } from '../src/backup.mjs';
import { initConfig, loadConfig, privateJson } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { MuseAdapter, museRequestId } from '../src/muse.mjs';
import { maintain } from '../src/maintenance.mjs';

const exec = promisify(execFile);
const add = (bridge, id) => bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [] }] });

test('cancelled claim must not lease an already available task', async (t) => {
  const { bridge, store } = fixture(t); add(bridge, 'cancelled');
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await bridge.claim({ wait: 1000 }, abort.signal), []);
  assert.equal(store.count(), 1); assert.equal(store.event('muse:cancelled').lease_until, 0);
});

test('a cancelled waiting claimant leaves new work for the next live worker', async (t) => {
  const { bridge, store } = fixture(t); const abort = new AbortController();
  const pending = bridge.claim({ wait: 1000 }, abort.signal);
  abort.abort(); add(bridge, 'after-cancel');
  assert.deepEqual(await pending, []); assert.equal(store.count(), 1);
  assert.equal((await bridge.claim())[0].event_id, 'muse:after-cancel');
});

test('invalid JSON media types and malformed percent-encoding return client errors', async (t) => {
  const { bridge, config, calls } = fixture(t); const server = createApi(bridge);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${config.api_token}` };
  const wrongType = await fetch(origin + '/v1/send', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/jsonp' }, body: JSON.stringify({ request_id: 'bad-type', to: 'owner', text: 'must not send' }) });
  assert.equal(wrongType.status, 415); await wrongType.json(); assert.equal(calls.length, 0);
  for (const path of ['/v1/requests/%ZZ', '/v1/requests/%FF']) {
    const response = await fetch(origin + path, { headers }); assert.equal(response.status, 400); assert.equal((await response.json()).error, 'invalid_request_id');
  }
  const review = await fetch(origin + '/v1/requests/%ZZ/review', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ reviewed: true, note: 'Checked privately' }) });
  assert.equal(review.status, 400); assert.equal((await review.json()).error, 'invalid_request_id');
  const valid = await fetch(origin + '/v1/send', { method: 'POST', headers: { ...headers, 'Content-Type': 'Application/JSON; charset=utf-8' }, body: JSON.stringify(reply('valid-type')) });
  assert.equal(valid.status, 200); await valid.json(); assert.equal(calls.length, 1);
});

test('example token and inherited operation names cannot become valid runtime configuration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'muse-link-config-audit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'config.json'); initConfig(path); const original = JSON.parse(readFileSync(path));
  privateJson(path, { ...original, api_token: 'Run muse-link init to generate a private token' });
  assert.throws(() => loadConfig(path), { code: 'invalid_config' });
  privateJson(path, { ...original, operations: { toString: 1 } }); assert.throws(() => loadConfig(path), /Unknown operations/);
  privateJson(path, { ...original, api_token: 'abcDEF0123456789+/='.repeat(3) }); assert.doesNotThrow(() => loadConfig(path));
});

test('backup cannot be placed inside state through a parent-directory alias', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'muse-link-backup-audit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'state'); const store = new Store(directory); store.close();
  const alias = join(root, 'alias'); symlinkSync(directory, alias, 'junction');
  await assert.rejects(backupState({ state_dir: directory }, join(alias, 'nested')), { code: 'invalid_backup_path' });
});

test('restore rejects a source nested inside target through a parent-directory alias', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'muse-link-restore-audit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'state'); mkdirSync(target); const alias = join(root, 'alias'); symlinkSync(target, alias, 'junction');
  await assert.rejects(restoreState({ state_dir: target }, join(alias, 'missing-backup')), { code: 'invalid_restore_path' });
});

test('restore protects the real home when an ancestor is a symlink', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'muse-link-home-audit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const protectedHome = join(root, 'protected-user'); mkdirSync(protectedHome); writeFileSync(join(protectedHome, 'keep.txt'), 'untouched');
  const alias = join(root, 'alias'); symlinkSync(root, alias, 'junction');
  const target = join(alias, basename(protectedHome));
  const module = new URL('../src/backup.mjs', import.meta.url).href;
  const source = `import assert from 'node:assert/strict'; import {restoreState} from ${JSON.stringify(module)}; await assert.rejects(restoreState({state_dir:${JSON.stringify(target)}},${JSON.stringify(join(root, 'missing-backup'))}),{code:'invalid_restore_path'});`;
  await exec(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, HOME: protectedHome, USERPROFILE: protectedHome } });
  assert.equal(readFileSync(join(protectedHome, 'keep.txt'), 'utf8'), 'untouched');
});

test('queued Muse replies recheck their lease before sending on the network', async (t) => {
  const gate = deferred(); let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const calls = [];
  const { bridge, store, config } = fixture(t, { sendText: async (_session, _to, text) => {
    calls.push(text); if (text === 'blocker') { entered(); await gate.promise; }
  } });
  config.require_lease_token = true;
  const muse = new MuseAdapter(bridge); add(bridge, 'queued-lease');
  const task = (await muse.next()).tasks[0];
  const blocker = bridge.send(reply('blocker', 'blocker')); await started;
  const oldReply = muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'final' });
  const rejected = assert.rejects(oldReply, { code: 'stale_lease' });
  store.db.prepare('UPDATE events SET lease_until=0 WHERE id=?').run(task.event_id);
  const current = (await muse.next()).tasks[0];
  gate.resolve(); await blocker; await rejected;
  assert.deepEqual(calls, ['blocker']); assert.equal(store.event(task.event_id).acked_ms, null);
  assert.equal((await muse.reply({ event_id: current.event_id, lease_token: current.lease_token, text: 'final' })).state, 'accepted');
  assert.deepEqual(calls, ['blocker', 'final']);
});

test('retention keeps unlinked legacy Muse replies until pending tasks are reconciled', async (t) => {
  const { bridge, store } = fixture(t); add(bridge, 'legacy-pending');
  const id = museRequestId('muse:legacy-pending');
  // v0.3 had no send_events relation. Simulate an accepted reply before inbox ack.
  store.createSend(id, 'old-fingerprint', 'owner', ['old-client-id']);
  store.finish(id, 'accepted', { state: 'accepted' });
  const future = Date.now() + 100 * 86400000;
  await maintain(bridge, future); assert.ok(store.send(id));
  assert.deepEqual((await new MuseAdapter(bridge).next()).tasks, []);
  assert.notEqual(store.event('muse:legacy-pending').acked_ms, null);
  await maintain(bridge, future); assert.equal(store.send(id), null);
});

test('an aborted real HTTP long-poll releases its waiter without leasing the next message', async (t) => {
  const { bridge, config, store } = fixture(t); const server = createApi(bridge);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const arrived = once(server, 'request');
  const waiting = httpRequest(origin + '/v1/muse/tasks?wait=30s', { headers: { Authorization: `Bearer ${config.api_token}` } });
  waiting.on('error', () => {}); waiting.end();
  const [, response] = await arrived; const closed = once(response, 'close'); waiting.destroy(); await closed;
  await new Promise((done) => setImmediate(done));
  assert.equal(bridge.events.listenerCount('new'), 0);
  add(bridge, 'http-after-cancel'); assert.equal(store.count(), 1);
  const next = await fetch(origin + '/v1/muse/tasks', { headers: { Authorization: `Bearer ${config.api_token}` } });
  assert.equal((await next.json()).tasks[0].event_id, 'muse:http-after-cancel');
});

test('Muse rechecks the lease after a media upload and preserves it for a live worker', async (t) => {
  const gate = deferred(); const entered = deferred(); let sent = 0, uploads = 0;
  const { bridge, config, store, directory } = fixture(t, {
    uploadMedia: async () => { uploads++; entered.resolve(); await gate.promise; return { type: 2, image_item: { media: {} } }; },
    sendMedia: async () => { sent++; },
  });
  config.require_lease_token = true; config.media_roots = [directory];
  const image = join(directory, 'image.png'); writeFileSync(image, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const muse = new MuseAdapter(bridge); add(bridge, 'media-lease'); const task = (await muse.next()).tasks[0];
  const body = { event_id: task.event_id, lease_token: task.lease_token, media: [{ type: 'image', path: image }] };
  const pending = muse.reply(body); const rejected = assert.rejects(pending, { code: 'stale_lease' }); await entered.promise;
  store.db.prepare('UPDATE events SET lease_until=0 WHERE id=?').run(task.event_id);
  const current = (await muse.next()).tasks[0]; gate.resolve(); await rejected; assert.equal(sent, 0);
  assert.equal((await muse.reply({ ...body, lease_token: current.lease_token })).state, 'accepted');
  assert.equal(sent, 1); assert.equal(uploads, 1);
});

test('checkpoint steps require string names rather than implicitly coerced values', (t) => {
  const { bridge } = fixture(t); const muse = new MuseAdapter(bridge);
  assert.throws(() => muse.checkpoint({ event_id: 'event', step: 123, phase: 'started' }), { code: 'invalid_checkpoint' });
});

test('restore rejects placing live state inside the backup source', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'muse-link-restore-overlap-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(restoreState({ state_dir: join(root, 'backup', 'state') }, join(root, 'backup')), { code: 'invalid_restore_path' });
});
