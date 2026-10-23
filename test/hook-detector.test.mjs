import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/server.mjs';
import { detectHook, probeResult, formatHook } from '../src/hook-detector.mjs';
import { fixture } from './helpers.mjs';

const exec = promisify(execFile);
const healthy = () => probeResult({ healthy: true, problems: [], queue: { ready: 0 }, poll: { state: 'waiting' } }, 200);
const stalled = () => probeResult({ healthy: false, problems: ['worker_lease_stalled'], queue: { ready: 0, leased: 1 }, poll: { state: 'waiting' } }, 503);
function state() {
  let value = null, reads = 0, writes = 0, clears = 0;
  return {
    readAlert: () => { reads++; return value; }, writeAlert: (next) => { writes++; value = next; }, clearAlert: () => { clears++; value = null; },
    inspect: () => ({ value, reads, writes, clears }), pending: () => 0,
  };
}

test('one transient readiness failure is retried and never reported as a persistent bridge failure', async () => {
  const s = state(); let calls = 0;
  const result = await detectHook({ ...s, probe: () => ++calls === 1 ? stalled() : healthy() });
  assert.equal(calls, 2); assert.equal(result.decision, 'silent'); assert.equal(s.inspect().writes, 0);
});

test('lease-stall warnings retain their actual sanitized evidence; same-code cooldown cannot hide a different fault', async () => {
  const s = state(), now = 10000000;
  const first = await detectHook({ ...s, probe: stalled, now });
  assert.match(first.reason, /worker_lease_stalled/); assert.doesNotMatch(first.reason, /wechat_poll_unhealthy/);
  assert.ok(first.reason.includes(new Date(now).toISOString()));
  assert.match(first.reason, /收到唤醒后先复查当前状态/);
  assert.equal(s.inspect().value.at, new Date(now).toISOString());
  assert.deepEqual(s.inspect().value.evidence.queue, { ready: 0, leased: 1 });
  assert.equal((await detectHook({ ...s, probe: stalled, now: now + 5000 })).decision, 'silent');
  const different = () => probeResult({ healthy: false, problems: ['send_outcome_unknown'], queue: {} }, 503);
  assert.equal((await detectHook({ ...s, probe: different, now: now + 10000 })).decision, 'wake');
  assert.equal(s.inspect().writes, 2);
  await detectHook({ ...s, probe: healthy, now: now + 15000 });
  assert.equal((await detectHook({ ...s, probe: stalled, now: now + 20000 })).decision, 'wake');
});

test('ready events and pending tool results bypass warning cooldown without performing a claim', async () => {
  const s = state(); await detectHook({ ...s, probe: stalled, now: 1000 });
  const ready = () => probeResult({ healthy: false, problems: ['worker_claim_gap'], queue: { ready: 10 } }, 503);
  assert.match((await detectHook({ ...s, probe: ready, now: 2000 })).reason, /10 条新事件/);
  assert.match((await detectHook({ ...s, probe: stalled, pending: () => 2, now: 2000 })).reason, /2 个后台任务/);
  assert.equal(s.inspect().writes, 1);
});

test('invalid/failed probes remain actionable and output one correctly escaped platform result with no response secrets', async () => {
  const s = state();
  const result = await detectHook({ ...s, probe: () => { throw new Error('SECRET'); } });
  const line = formatHook(result, 'hatch'); assert.equal(line.split('\n').length, 1);
  assert.equal(JSON.parse(line.slice('HATCH_HOOK_RESULT:'.length)).decision, 'wake');
  assert.equal(line.includes('SECRET'), false);
  const sanitized = probeResult({ healthy: false, problems: ['worker_lease_stalled', 'SECRET\nBODY'], queue: { ready: 0, lease_token: 'SECRET' }, bot_token: 'SECRET' }, 503);
  assert.equal(JSON.stringify(sanitized).includes('SECRET'), false);
  assert.equal(probeResult({}).healthy, false);
  assert.equal(probeResult({ healthy: true, problems: [], queue: { ready: 0 } }, 503).healthy, false);
  assert.throws(() => formatHook(result, 'unknown'), { code: 'invalid_hook_format' });
});

test('actual hook helper records a lease-stall sample privately, emits one Hatch result and leaves event ownership unchanged', { timeout: 15000 }, async (t) => {
  const { bridge, config, store, directory } = fixture(t);
  config.require_lease_token = true; bridge.poll = { state: 'waiting', last_ok_at: new Date().toISOString(), error: null };
  bridge.ingest({ msgs: [{ message_id: 'hook-stall', from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: 'PRIVATE-BODY' } }] }] });
  const task = store.claim(1)[0]; store.db.prepare('UPDATE events SET lease_activity_ms=?').run(Date.now() - 1200000);
  const before = store.event(task.event_id);
  const server = createApi(bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  config.listen.port = server.address().port;
  const path = join(directory, 'config.json'); writeFileSync(path, JSON.stringify(config));
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, MUSE_LINK_CONFIG: path, MUSE_LINK_HOOK_FORMAT: 'hatch', MUSE_LINK_JOB_DIR: join(directory, 'no-jobs') };
  delete env.MUSE_LINK; delete env.MUSE_LINK_JOB_HELPER;
  const script = fileURLToPath(new URL('../scripts/hook-check.mjs', import.meta.url));
  const first = (await exec(process.execPath, [script], { env })).stdout.trim();
  assert.equal(first.split('\n').length, 1);
  const output = JSON.parse(first.slice('HATCH_HOOK_RESULT:'.length));
  assert.equal(output.decision, 'wake'); assert.match(output.reason, /worker_lease_stalled/);
  const cache = readFileSync(join(directory, '.cache/muse-link/hook-alert-state.json'), 'utf8');
  assert.ok(output.reason.includes(JSON.parse(cache).at));
  assert.equal(JSON.parse(cache).evidence.queue.stalled_leases, 1);
  for (const secret of [task.lease_token, config.api_token, 'PRIVATE-BODY']) assert.equal((first + cache).includes(secret), false);
  assert.deepEqual(store.event(task.event_id), before); assert.equal(bridge.worker.claim_requests, 0);
  const second = (await exec(process.execPath, [script], { env })).stdout.trim();
  assert.equal(JSON.parse(second.slice('HATCH_HOOK_RESULT:'.length)).decision, 'silent');
});

test('a hung real health probe is terminated twice within a bounded hook invocation', { skip: process.platform !== 'linux', timeout: 12000 }, async (t) => {
  const { directory } = fixture(t);
  const hung = join(directory, 'hung-health');
  writeFileSync(hung, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n'); chmodSync(hung, 0o700);
  const env = { ...process.env, HOME: directory, MUSE_LINK: hung, MUSE_LINK_HOOK_FORMAT: 'hatch', MUSE_LINK_JOB_DIR: join(directory, 'no-jobs') };
  const script = fileURLToPath(new URL('../scripts/hook-check.mjs', import.meta.url));
  const began = performance.now(); const { stdout } = await exec(process.execPath, [script], { env });
  assert.ok(performance.now() - began < 8000);
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.match(JSON.parse(stdout.trim().slice('HATCH_HOOK_RESULT:'.length)).reason, /hook_probe_timeout/);
});
