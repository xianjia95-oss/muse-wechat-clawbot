import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, deferred, reply } from './helpers.mjs';
import { createApi } from '../src/server.mjs';
import { MuseAdapter, museRequestId } from '../src/muse.mjs';
import { lockState } from '../src/state-lock.mjs';
import { deliveryDiagnostics } from '../src/diagnostics.mjs';
import { consumerProgress } from '../src/worker-progress.mjs';
import { health } from '../src/operations.mjs';
import { detectHook, probeResult } from '../src/hook-detector.mjs';

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = async (path, args) => JSON.parse((await exec(process.execPath, [cliPath, '--config', path, ...args])).stdout);
const add = (bridge, id) => bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: 'PRIVATE-TEXT' } }] }] });
async function api(t, transport = {}) {
  const f = fixture(t, transport); f.config.require_lease_token = true;
  const server = createApi(f.bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  f.config.listen.port = server.address().port;
  const path = join(f.directory, 'config.json'); writeFileSync(path, JSON.stringify(f.config));
  return { ...f, server, path, origin: `http://127.0.0.1:${f.config.listen.port}`, headers: { Authorization: `Bearer ${f.config.api_token}` } };
}
function own(t, directory) {
  const release = lockState(directory);
  t.after(() => { release(); rmSync(directory + '.lock.sqlite', { force: true }); });
}

test('legacy inbox pull uses the daemon API instead of contending with its state lock', async (t) => {
  const { bridge, directory, path } = await api(t); own(t, directory); add(bridge, 'legacy-pull');
  const result = await cli(path, ['inbox', 'pull']);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].event_id, 'muse:legacy-pull');
  await assert.rejects(cli(path, ['inbox', 'pull', '--offline']), (error) => error.stderr.includes('state_locked'));
});

test('legacy inbox ack uses the daemon API and still requires the current lease', async (t) => {
  const { bridge, directory, path, store } = await api(t); own(t, directory); add(bridge, 'legacy-ack');
  const task = (await new MuseAdapter(bridge).next()).tasks[0];
  await assert.rejects(cli(path, ['inbox', 'ack', task.event_id]));
  assert.equal(store.event(task.event_id).acked_ms, null);
  assert.equal((await cli(path, ['inbox', 'ack', task.event_id, '--lease-token', task.lease_token])).acked, 1);
});

test('Muse adapter, HTTP and CLI claim one task by default; explicit batches remain available', async (t) => {
  const { bridge, origin, headers, path, store } = await api(t);
  for (let i = 0; i < 8; i++) add(bridge, 'default-' + i);
  assert.equal((await new MuseAdapter(bridge).next()).tasks.length, 1);
  assert.equal((await (await fetch(origin + '/v1/muse/tasks', { headers })).json()).tasks.length, 1);
  assert.equal((await cli(path, ['muse', 'next'])).tasks.length, 1);
  assert.equal((await cli(path, ['inbox', 'pull'])).events.length, 1);
  assert.equal((await cli(path, ['muse', 'next', '--limit', '2'])).tasks.length, 2);
  assert.equal(store.count(), 2);
});

test('diagnostics expose leased work and worker rejections without claiming or leaking messages/tokens', async (t) => {
  const { bridge, origin, headers, store, path, calls } = await api(t); add(bridge, 'hidden-task');
  const task = (await new MuseAdapter(bridge).next()).tasks[0];
  const rejected = await fetch(origin + '/v1/muse/replies', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: task.event_id, text: 'PRIVATE-REPLY' }) });
  assert.equal(rejected.status, 409); await rejected.json();
  const report = await cli(path, ['diagnose']); const serialized = JSON.stringify(report);
  assert.equal(report.queue.ready, 0); assert.equal(report.queue.leased, 1);
  assert.ok(report.queue.next_lease_expiry_in_ms > 1700000);
  assert.equal(report.worker.last_api_error.code, 'stale_lease');
  assert.equal(report.worker.last_api_error.lease_reason, 'missing_token');
  assert.ok(report.findings.some((entry) => entry.code === 'tasks_already_leased'));
  assert.ok(report.findings.some((entry) => entry.code === 'worker_api_rejected'));
  for (const value of [task.lease_token, 'PRIVATE-TEXT', 'PRIVATE-REPLY', 'context-1', 'TEST-SECRET']) assert.equal(serialized.includes(value), false);
  assert.equal(calls.length, 0); assert.equal(store.event(task.event_id).acked_ms, null);
  const completed = await fetch(origin + '/v1/muse/replies', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: task.event_id, lease_token: task.lease_token, text: 'done' }) });
  assert.equal(completed.status, 200); await completed.json();
  assert.equal((await cli(path, ['diagnose'])).worker.last_api_error, undefined);
});

test('a rejected final reply retains task correlation across unrelated and progress successes', async (t) => {
  const { bridge, origin, headers, path, calls } = await api(t);
  const logs = []; bridge.log = (name, value) => logs.push({ name, ...value });
  add(bridge, 'rejected-final'); add(bridge, 'other-final');
  const muse = new MuseAdapter(bridge), first = (await muse.next()).tasks[0], other = (await muse.next()).tasks[0];
  const post = async (body) => {
    const response = await fetch(origin + '/v1/muse/replies', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const rejected = await post({ event_id: first.event_id, lease_token: first.lease_token.slice(0, 16), text: 'PRIVATE-REPLY' });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.lease_reason, 'token_mismatch');
  const failure = { ...bridge.worker.last_api_error };
  assert.equal(failure.task_request_id, museRequestId(first.event_id));
  assert.equal(failure.request_id, museRequestId(first.event_id));
  assert.equal((await post({ event_id: other.event_id, lease_token: other.lease_token, text: 'OTHER-RESULT' })).status, 200);
  assert.deepEqual(bridge.worker.last_api_error, failure);
  assert.equal((await post({ event_id: first.event_id, lease_token: first.lease_token, mode: 'progress', reply_id: 'verified-blocker', text: 'VERIFIED-BLOCKER' })).status, 200);
  assert.deepEqual(bridge.worker.last_api_error, failure);
  const report = await cli(path, ['diagnose']);
  assert.equal(report.worker.last_api_error.task_request_id, failure.task_request_id);
  assert.equal(report.worker.last_api_error.request_id, failure.request_id);
  const evidence = JSON.stringify({ report, logs });
  for (const secret of [first.lease_token, first.lease_token.slice(0, 16), 'PRIVATE-TEXT', 'PRIVATE-REPLY', first.event_id]) assert.equal(evidence.includes(secret), false);
  assert.equal(logs.filter((entry) => entry.name === 'worker_api_rejected').length, 1);
  assert.equal((await post({ event_id: first.event_id, lease_token: first.lease_token, text: 'FINAL-RESULT' })).status, 200);
  assert.equal(bridge.worker.last_api_error, null); assert.equal(calls.length, 3);
});

test('an earlier in-flight success cannot erase a newer rejection for the same task', { timeout: 10000 }, async (t) => {
  const gate = deferred(), entered = deferred();
  const { bridge, origin, headers } = await api(t, { sendText: async () => { entered.resolve(); await gate.promise; } });
  t.after(() => gate.resolve());
  add(bridge, 'inflight-error-race');
  const task = (await new MuseAdapter(bridge).next()).tasks[0];
  const post = async (body) => {
    const response = await fetch(origin + '/v1/muse/replies', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const sending = post({ event_id: task.event_id, lease_token: task.lease_token, text: 'RESULT' });
  await entered.promise;
  assert.equal((await post({ event_id: task.event_id, text: 'RESULT' })).body.lease_reason, 'missing_token');
  const failure = { ...bridge.worker.last_api_error };
  gate.resolve(); assert.equal((await sending).status, 200);
  assert.deepEqual(bridge.worker.last_api_error, failure);
});

test('diagnostic script works with rc.2-shaped status and performs only three read requests', async (t) => {
  const { createServer } = await import('node:http');
  const { config, directory } = fixture(t); const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url); assert.equal(req.headers.authorization, `Bearer ${config.api_token}`);
    const body = req.url === '/v1/status' ? { version: '0.4.0-rc.2', logged_in: true, ready_events: 0, poll: { state: 'ok' }, bot_token: 'DO-NOT-LEAK' } : req.url === '/v1/health' ? { healthy: true, queue: { pending: 3, leased: 3 }, problems: [] } : { window_requests: 0 };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  config.listen.port = server.address().port; const path = join(directory, 'config.json'); writeFileSync(path, JSON.stringify(config));
  const script = fileURLToPath(new URL('../scripts/diagnose.mjs', import.meta.url));
  const { stdout } = await exec(process.execPath, [script, '--config', path], { env: { ...process.env, HTTP_PROXY: 'http://invalid:1', HTTPS_PROXY: 'http://invalid:1' } });
  const report = JSON.parse(stdout);
  assert.equal(report.queue.ready, 0); assert.equal(report.queue.leased, 3); assert.equal(report.worker_telemetry_available, false);
  assert.deepEqual(paths.sort(), ['/v1/health', '/v1/metrics', '/v1/status']); assert.equal(stdout.includes('DO-NOT-LEAK'), false);
  assert.equal(report.consumer.state, 'no_ready_work');
  assert.equal(report.consumer.worker_liveness_verified, false);
});

test('unclaimed messages warn before five-minute backlog without claiming, acking or assuming a platform fault', async (t) => {
  const { bridge, store, origin, headers, path, calls } = await api(t);
  bridge.poll = { state: 'waiting', last_ok_at: new Date().toISOString(), error: null };
  for (let i = 0; i < 10; i++) add(bridge, 'no-consumer-' + i);
  store.db.prepare('UPDATE events SET received_ms=?').run(Date.now() - 90000);
  const before = store.event('muse:no-consumer-0');
  // Merely polling unsuccessfully is not successful consumption.
  bridge.worker.claim_requests = 20; bridge.worker.last_claim_at = new Date().toISOString();
  const response = await fetch(origin + '/v1/health', { headers });
  assert.equal(response.status, 503);
  const readiness = await response.json();
  assert.ok(readiness.problems.includes('worker_claim_gap'));
  assert.equal(readiness.problems.includes('worker_backlog'), false);
  const report = await cli(path, ['diagnose']);
  assert.equal(report.consumer.state, 'claim_gap');
  assert.equal(report.consumer.worker_liveness_verified, false);
  assert.equal(report.consumer.platform_dispatch_verified, false);
  assert.ok(report.findings.some((item) => item.code === 'worker_claim_gap'));
  assert.equal(store.count(), 10); assert.deepEqual(store.event('muse:no-consumer-0'), before);
  assert.equal(calls.length, 0); assert.equal(JSON.stringify(report).includes('PRIVATE-TEXT'), false);
  await new MuseAdapter(bridge).next();
  assert.equal(health(bridge).consumer.state, 'within_grace');
  assert.equal(health(bridge).healthy, true);
});

test('consumer evidence respects custom grace, recent successful claims, leased work and missing telemetry', () => {
  const now = Date.now(), queue = { ready: 10, oldest_ready_ms: now - 90000 };
  const stalled = { last_task_at: new Date(now - 100000).toISOString(), last_claim_at: new Date(now).toISOString() };
  assert.equal(consumerProgress(queue, stalled, 60000, now).state, 'claim_gap');
  assert.equal(consumerProgress(queue, stalled, 120000, now).state, 'within_grace');
  assert.equal(consumerProgress(queue, { ...stalled, last_task_at: new Date(now - 5000).toISOString() }, 60000, now).state, 'within_grace');
  assert.equal(consumerProgress({ ready: 0, leased: 10, pending: 10 }, stalled, 60000, now).state, 'no_ready_work');
  const report = deliveryDiagnostics({ status: { queue } }, now);
  assert.equal(report.consumer.state, 'telemetry_unavailable');
  assert.equal(report.findings.some((item) => item.code === 'worker_claim_gap'), false);
});

test('an unresolved leased operation and readiness 503 do not block another same-chat claim or reply', { timeout: 10000 }, async (t) => {
  const { bridge, store, origin, headers, calls } = await api(t);
  bridge.poll = { state: 'waiting', last_ok_at: new Date().toISOString(), error: null };
  const post = async (route, body) => {
    const response = await fetch(origin + route, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const claim = async () => {
    const response = await fetch(origin + '/v1/muse/tasks?limit=1', { headers });
    assert.equal(response.status, 200);
    return (await response.json()).tasks[0];
  };
  // This models bridge state while an external executor has no result. It does
  // not emulate Muse's native permission UI or prove platform task isolation.
  add(bridge, 'external-operation-waiting');
  const waiting = await claim();
  assert.equal((await post('/v1/muse/checkpoints', {
    event_id: waiting.event_id, lease_token: waiting.lease_token, step: 'external-model-list', phase: 'started',
  })).status, 200);
  store.db.prepare('UPDATE events SET lease_activity_ms=? WHERE id=?').run(Date.now() - 1200000, waiting.event_id);
  const waitingEvent = store.event(waiting.event_id), waitingSteps = store.steps(waiting.event_id);

  add(bridge, 'independent-short-message');
  store.db.prepare('UPDATE events SET received_ms=? WHERE id=?').run(Date.now() - 360000, 'muse:independent-short-message');
  const response = await fetch(origin + '/v1/health', { headers });
  assert.equal(response.status, 503);
  const readiness = await response.json();
  assert.ok(readiness.problems.includes('worker_lease_stalled'));
  assert.ok(readiness.problems.includes('worker_backlog'));
  // Even an active warning cooldown must not suppress a ready message.
  const wake = await detectHook({
    probe: () => probeResult(readiness, response.status), pending: () => 0,
    readAlert: () => { throw new Error('Ready work must bypass alert cooldown'); },
    writeAlert: () => { throw new Error('Ready work must not change warning state'); },
    clearAlert: () => { throw new Error('Ready work must not change warning state'); },
  });
  assert.equal(wake.decision, 'wake');

  const short = await claim();
  assert.equal(short.event_id, 'muse:independent-short-message');
  assert.notEqual(short.lease_token, waiting.lease_token);
  const sent = await post('/v1/muse/replies', { event_id: short.event_id, lease_token: short.lease_token, text: 'SHORT-RESULT' });
  assert.equal(sent.status, 200); assert.equal(sent.body.state, 'accepted');
  assert.notEqual(store.event(short.event_id).acked_ms, null);
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'owner'); assert.equal(calls[0][2], 'SHORT-RESULT');
  assert.deepEqual(store.event(waiting.event_id), waitingEvent);
  assert.deepEqual(store.steps(waiting.event_id), waitingSteps);
  assert.equal((await post('/v1/muse/replies', {
    event_id: waiting.event_id, lease_token: waiting.lease_token, text: 'Cannot finish an unresolved operation',
  })).body.error, 'task_step_uncertain');
  const finalHealth = health(bridge);
  assert.equal(finalHealth.healthy, false); assert.ok(finalHealth.problems.includes('worker_lease_stalled'));
  assert.equal(finalHealth.queue.ready, 0); assert.equal(finalHealth.queue.leased, 1);
});

test('delivery status separates recipient queueing from a pending network send', async (t) => {
  const gate = deferred(); const entered = deferred();
  const { bridge } = fixture(t, { sendText: async () => { entered.resolve(); await gate.promise; } });
  const first = bridge.send(reply('first')); await entered.promise;
  const second = bridge.send(reply('second')); await new Promise((done) => setImmediate(done));
  const status = bridge.status();
  assert.equal(status.delivery.sending, 1); assert.equal(status.delivery.queued, 1);
  assert.ok(deliveryDiagnostics({ status }).findings.some((entry) => entry.code === 'outbound_work_inflight'));
  gate.resolve(); await Promise.all([first, second]); assert.equal(bridge.status().inflight_sends, 0);
});

test('lease errors distinguish missing tokens, mismatches, expiry and acknowledgement', async (t) => {
  const { bridge, store } = fixture(t); add(bridge, 'lease-reasons');
  const task = (await new MuseAdapter(bridge).next()).tasks[0];
  const check = (token, reason) => assert.throws(() => store.requireLease(task.event_id, token), (error) => {
    assert.equal(error.code, 'stale_lease'); assert.equal(error.details.lease_reason, reason);
    assert.equal(JSON.stringify(error).includes(task.lease_token), false); return true;
  });
  check(undefined, 'missing_token'); check('wrong', 'token_mismatch');
  assert.equal(store.requireLease(task.event_id, task.lease_token).acked_ms, null);
  store.db.prepare('UPDATE events SET lease_until=0 WHERE id=?').run(task.event_id); check(task.lease_token, 'lease_expired');
  store.ack([task.event_id]); check(task.lease_token, 'event_acknowledged');
});

test('event diagnostic compares a captured token privately without changing the live lease', async (t) => {
  const { bridge, store, path, config } = await api(t); add(bridge, 'inspect-private');
  const task = (await new MuseAdapter(bridge).next()).tasks[0]; const before = store.event(task.event_id);
  const script = fileURLToPath(new URL('../scripts/diagnose.mjs', import.meta.url));
  const pending = exec(process.execPath, [script, '--config', path, '--event-id', task.event_id, '--lease-token-stdin']);
  pending.child.stdin.end(task.lease_token + '\n'); const { stdout } = await pending;
  const report = JSON.parse(stdout);
  assert.equal(report.event.lease_currently_valid, true); assert.equal(report.event.supplied_token_check.lease_reason, null);
  assert.equal(report.event.lease_until_ms, task.lease_until);
  assert.equal(stdout.includes(task.lease_token), false); assert.equal(stdout.includes(config.api_token), false);
  assert.deepEqual(store.event(task.event_id), before);
});

test('claim output preserves the original task for a later worker without reading a database token', async (t) => {
  const { bridge, path, directory, store } = await api(t); add(bridge, 'handoff');
  const output = join(directory, 'claimed-task.json');
  const result = await cli(path, ['muse', 'next', '--output', output]);
  const saved = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(saved.tasks, result.tasks); assert.equal(saved.claim_state, 'response_saved');
  if (process.platform !== 'win32') assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(saved.config_path, path); assert.equal(result.handoff_file, output);
  // A new CLI invocation can resume with the original token after the old CLI
  // exits; expired or superseded tokens still go through normal server fencing.
  const task = saved.tasks[0];
  assert.equal((await cli(path, ['muse', 'reply', task.event_id, '--lease-token', task.lease_token, '--text', 'done'])).state, 'accepted');
  assert.notEqual(store.event(task.event_id).acked_ms, null);
});

test('existing or unwritable claim output fails before leasing another event', async (t) => {
  const { bridge, path, directory, store } = await api(t); add(bridge, 'no-overwrite');
  const output = join(directory, 'existing.json'); writeFileSync(output, 'old handoff');
  await assert.rejects(cli(path, ['muse', 'next', '--output', output]));
  assert.equal(readFileSync(output, 'utf8'), 'old handoff'); assert.equal(store.count(), 1);
  await assert.rejects(cli(path, ['muse', 'next', '--output', join(directory, 'missing', 'task.json')]));
  assert.equal(store.count(), 1);
});

test('message ledger distinguishes pre-submit delays from accepted sends and acknowledgements without final replies', async (t) => {
  const { bridge, store, path, config } = await api(t);
  add(bridge, 'ledger-accepted'); add(bridge, 'ledger-acked-only'); add(bridge, 'ledger-leased');
  const muse = new MuseAdapter(bridge);
  const first = (await muse.next()).tasks[0];
  await muse.reply({ event_id: first.event_id, lease_token: first.lease_token, text: 'PRIVATE-REPLY' });
  const second = (await muse.next()).tasks[0]; store.ack([second.event_id]);
  const third = (await muse.next()).tasks[0];
  const before = store.event(third.event_id);
  const script = fileURLToPath(new URL('../scripts/queue-report.mjs', import.meta.url));
  const { stdout } = await exec(process.execPath, [script, '--config', path, '--since', '1h']);
  const report = JSON.parse(stdout);
  assert.equal(report.messages.length, 3);
  assert.deepEqual(new Set(report.messages.map((entry) => entry.stage)), new Set(['final_reply_accepted', 'ack_without_accepted_final', 'leased_no_final_submission']));
  assert.equal(report.first_claim_time_available, false);
  for (const value of [third.lease_token, config.api_token, 'PRIVATE-TEXT', 'PRIVATE-REPLY']) assert.equal(stdout.includes(value), false);
  assert.deepEqual(store.event(third.event_id), before);
});
