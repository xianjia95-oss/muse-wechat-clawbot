import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { JOB_DEFAULTS, configureJobs, jobStatus, listJobs, pendingJobs, startJob, enqueueJob, dispatchJobs, refreshQueuedJob, cancelJob, settleJob } from '../src/tool-jobs.mjs';
import { fixture } from './helpers.mjs';
import { MuseAdapter } from '../src/muse.mjs';
import { privateJson } from '../src/config.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 30000 };
const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'output_limit', 'interrupted', 'expired']);
const deadline = (ms = 60000) => new Date(Date.now() + ms).toISOString();
async function until(predicate) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const result = predicate(); if (result) return result; await pause(20); }
  assert.fail('Queue did not reach the expected state.');
}
const finished = (root, id) => until(() => listJobs(root).find((job) => job.id === id && terminal.has(job.state)));
function area(t) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-queue-')), root = join(directory, 'jobs');
  t.after(async () => {
    // Cancel queued work first so finishing active tools cannot refill it.
    for (const job of listJobs(root).filter((job) => job.state === 'queued')) cancelJob(root, job.id);
    for (const job of listJobs(root)) if (!terminal.has(job.state)) { cancelJob(root, job.id); await finished(root, job.id); }
    // A terminal record is visible just before its supervisor finishes refilling.
    await pause(150);
    rmSync(directory, { recursive: true, force: true });
  });
  const script = (name, source) => { const path = join(directory, name + '.mjs'); writeFileSync(path, source); return path; };
  return { directory, root, script };
}
async function cli(...args) {
  const path = fileURLToPath(new URL('../scripts/tool-job.mjs', import.meta.url));
  const child = spawn(process.execPath, [path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
  const [code] = await once(child, 'close'); assert.equal(code, 0, err);
  return JSON.parse(out);
}

test('scheduler status and pending on a missing directory are read-only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-empty-')), root = join(directory, 'absent');
  try {
    assert.deepEqual(jobStatus(root).limits, JOB_DEFAULTS);
    assert.equal(jobStatus(root).retained, 0); assert.equal(pendingJobs(root), 0);
    assert.equal(existsSync(root), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a long-queued job gets a fresh supervisor startup grace period when dispatched', async (t) => {
  const { root } = area(t), path = join(root, 'late');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const job = { id: 'late', state: 'starting', created_at: new Date(0).toISOString(), dispatched_at: new Date().toISOString() };
  try {
    privateJson(join(path, 'job.json'), job);
    assert.equal(listJobs(root)[0].attention_required, false);
    privateJson(join(path, 'job.json'), { ...job, dispatched_at: new Date(0).toISOString() });
    assert.equal(listJobs(root)[0].attention_required, true);
  } finally { privateJson(join(path, 'job.json'), { ...job, state: 'failed' }); }
});

test('ten queued tools refill automatically within global and CPU limits while short replies continue', linux, async (t) => {
  const { root, script } = area(t), held = new Map(), calls = [], active = new Set();
  let releaseAll = false, peak = 0, cpuPeak = 0;
  const server = createServer((req, res) => {
    const id = req.url.slice(1); calls.push(id); active.add(id);
    peak = Math.max(peak, active.size); cpuPeak = Math.max(cpuPeak, [...active].filter((key) => key.startsWith('cpu')).length);
    const release = () => { active.delete(id); held.delete(id); res.end('done'); };
    if (releaseAll) release(); else held.set(id, release);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const tool = script('http', `import {basename} from 'node:path'; const r=await fetch('http://127.0.0.1:${server.address().port}/'+basename(process.env.MUSE_LINK_JOB_DIR)); console.log(await r.text());`);
  await configureJobs(root, { max_active: 4, max_io: 4, max_cpu: 1 });
  const ids = ['cpu-a', 'io-a', 'io-b', 'io-c', 'cpu-b', 'io-d', 'io-e', 'cpu-c', 'io-f', 'io-g'];
  for (const id of ids) await enqueueJob(root, id, tool, 15000, { kind: id.startsWith('cpu') ? 'cpu' : 'io', startBefore: deadline() });
  await until(() => held.size === 4);
  assert.deepEqual(new Set(calls), new Set(ids.slice(0, 4)));
  assert.equal(jobStatus(root).queued.total, 6);
  for (const cached of await Promise.all(Array.from({ length: 4 }, () => enqueueJob(root, 'cpu-b', tool, 15000, { kind: 'cpu', startBefore: deadline() })))) assert.equal(cached.cached, true);
  // The bridge remains usable while all four tool slots are occupied.
  const { bridge, config, store } = fixture(t); config.require_lease_token = true;
  const muse = new MuseAdapter(bridge);
  for (let i = 0; i < 10; i++) {
    bridge.ingest({ msgs: [{ message_id: 'queue-short-' + i, from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: 'short' } }] }] });
    const task = (await muse.next()).tasks[0];
    assert.equal((await muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'reply' })).state, 'accepted');
  }
  assert.equal(store.queueStats().pending, 0); assert.equal(held.size, 4);
  held.get('io-a')(); await until(() => held.has('io-d'));
  held.get('io-b')(); await until(() => held.has('io-e'));
  assert.equal(calls.includes('cpu-b'), false); // CPU queue head does not block eligible IO.
  held.get('cpu-a')(); await until(() => held.has('cpu-b'));
  // Lowering the cap leaves existing tools alone, and blocks further admissions.
  await configureJobs(root, { max_active: 2 });
  held.get('io-c')(); await until(() => listJobs(root).find((job) => job.id === 'io-c').state === 'succeeded');
  assert.equal(jobStatus(root).active.total, 3); assert.equal(calls.includes('io-f'), false);
  releaseAll = true; for (const release of [...held.values()]) release();
  for (const id of ids) assert.equal((await finished(root, id)).state, 'succeeded');
  assert.equal(calls.length, 10); assert.equal(new Set(calls).size, 10);
  assert.equal(peak, 4); assert.equal(cpuPeak, 1); assert.equal(jobStatus(root).queued.total, 0);
  assert.equal(pendingJobs(root), 10);
  for (const id of ids) settleJob(root, id, true);
  assert.equal(pendingJobs(root), 0);
});

test('separate enqueue processes share admission locks and a stable ID executes once', linux, async (t) => {
  const { root, directory, script } = area(t), marker = join(directory, 'calls');
  const tool = script('once', `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},${JSON.stringify('call\n')}); await new Promise(r=>setTimeout(r,200));`);
  await configureJobs(root, { max_active: 4, max_io: 4, max_cpu: 1 });
  const results = await Promise.all(Array.from({ length: 8 }, () => cli('enqueue', '--dir', root, '--id', 'same', '--script', tool, '--kind', 'io', '--start-before', deadline(), '--timeout', '5s')));
  assert.equal(results.filter((result) => !result.cached).length, 1);
  assert.equal((await finished(root, 'same')).state, 'succeeded');
  assert.equal(readFileSync(marker, 'utf8'), 'call\n'); assert.equal(jobStatus(root).retained, 1);
});

test('bounded queues retain cancelled and expired IDs without running their tools', linux, async (t) => {
  const { root, directory, script } = area(t), marker = join(directory, 'unexpected');
  await configureJobs(root, { max_active: 1, max_io: 1, max_cpu: 1, max_queued: 2 });
  await startJob(root, 'blocker', script('block', 'setInterval(()=>{},1000);'), 10000);
  const tool = script('never', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'unsafe');`);
  await enqueueJob(root, 'expired', tool, 1000, { kind: 'io', startBefore: deadline(1000) });
  await enqueueJob(root, 'cancelled', tool, 1000, { kind: 'io', startBefore: deadline() });
  await assert.rejects(enqueueJob(root, 'overflow', tool, 1000, { kind: 'io', startBefore: deadline() }), { code: 'job_capacity' });
  assert.equal(cancelJob(root, 'cancelled').event_acknowledged, false);
  assert.equal((await refreshQueuedJob(root, 'cancelled', deadline())).refreshed, false);
  await pause(1100);
  assert.equal(pendingJobs(root), 2); assert.equal(listJobs(root).find((job) => job.id === 'expired').state, 'queued');
  const result = await dispatchJobs(root); assert.deepEqual(result.expired, ['expired']);
  assert.equal((await refreshQueuedJob(root, 'expired', deadline())).refreshed, false);
  for (const id of ['expired', 'cancelled']) assert.equal((await enqueueJob(root, id, tool, 1000, { kind: 'io', startBefore: deadline() })).cached, true);
  cancelJob(root, 'blocker'); await finished(root, 'blocker');
  assert.equal(existsSync(marker), false); assert.equal(jobStatus(root).active.total, 0);
  assert.equal(jobStatus(root).retained, 3);
});

test('persisted queues wake read-only and dispatch after policy changes; renewal refresh is explicit', linux, async (t) => {
  const { root, script } = area(t);
  await configureJobs(root, { max_active: 1, max_io: 1, max_cpu: 1 });
  await startJob(root, 'blocker', script('block', 'setInterval(()=>{},1000);'), 10000);
  const tool = script('done', 'console.log("done");');
  await enqueueJob(root, 'waiting', tool, 3000, { kind: 'io', startBefore: deadline(2000) });
  const extended = deadline(30000);
  assert.equal((await refreshQueuedJob(root, 'waiting', extended)).start_before, extended);
  assert.equal(pendingJobs(root), 0);
  await configureJobs(root, { max_active: 2, max_io: 2 }); // Does not implicitly execute queued tools.
  const before = readFileSync(join(root, 'waiting/job.json'), 'utf8');
  assert.equal(pendingJobs(root), 1); assert.equal(readFileSync(join(root, 'waiting/job.json'), 'utf8'), before);
  const dispatched = await cli('dispatch', '--dir', root);
  assert.deepEqual(dispatched.started, ['waiting']); assert.equal((await finished(root, 'waiting')).state, 'succeeded');
  assert.equal((await refreshQueuedJob(root, 'waiting', deadline())).refreshed, false);
});

test('scheduler rejects invalid policy, unclassified tools, bad deadlines and conflicting IDs', linux, async (t) => {
  const { root, script } = area(t), tool = script('done', '');
  for (const changes of [{ max_active: 0 }, { max_io: 33 }, { max_cpu: 1.5 }, { max_queued: 257 }, { extra: 1 }])
    await assert.rejects(configureJobs(root, changes));
  assert.deepEqual(jobStatus(root).limits, JOB_DEFAULTS);
  await assert.rejects(enqueueJob(root, 'no-kind', tool, 1000, { startBefore: deadline() }), { code: 'invalid_job_kind' });
  for (const value of [undefined, 'tomorrow', new Date(0).toISOString(), deadline(7200000)])
    await assert.rejects(enqueueJob(root, 'invalid', tool, 1000, { kind: 'io', startBefore: value }), { code: 'invalid_start_deadline' });
  await enqueueJob(root, 'stable', tool, 1000, { kind: 'io', startBefore: deadline() });
  await assert.rejects(enqueueJob(root, 'stable', tool, 1000, { kind: 'cpu', startBefore: deadline() }), { code: 'job_id_conflict' });
  await finished(root, 'stable');
});

test('IO lane limits also apply to simultaneous submissions from separate processes', linux, async (t) => {
  const { root, script } = area(t), tool = script('held', 'setInterval(()=>{},1000);');
  await configureJobs(root, { max_active: 3, max_io: 1, max_cpu: 2 });
  await Promise.all(['io-a', 'io-b', 'io-c', 'cpu-a', 'cpu-b'].map((id) => cli('enqueue', '--dir', root, '--id', id,
    '--script', tool, '--kind', id.startsWith('io') ? 'io' : 'cpu', '--start-before', deadline(), '--timeout', '15s')));
  const status = jobStatus(root);
  assert.deepEqual(status.active, { total: 3, io: 1, cpu: 2 });
  assert.deepEqual(status.queued, { total: 2, io: 2, cpu: 0 });
});
