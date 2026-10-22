import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { startJob, listJobs, pendingJobs, cancelJob, settleJob } from '../src/tool-jobs.mjs';
import { fixture } from './helpers.mjs';
import { MuseAdapter } from '../src/muse.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 20000 };
const complete = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'output_limit']);
async function waitJob(root, id, predicate = (job) => complete.has(job.state)) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const job = listJobs(root).find((entry) => entry.id === id);
    if (job && predicate(job)) return job;
    await pause(25);
  }
  assert.fail('Tool job did not reach the expected state.');
}
function area(t) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-jobs-')); const root = join(directory, 'jobs');
  t.after(async () => {
    for (const job of listJobs(root)) if (!complete.has(job.state)) { cancelJob(root, job.id); await waitJob(root, job.id); }
    rmSync(directory, { recursive: true, force: true });
  });
  const script = (name, text) => { const path = join(directory, name + '.mjs'); writeFileSync(path, text); return path; };
  return { root, directory, script };
}

test('a blocked background HTTP tool leaves the serial message loop free to reply to a burst', linux, async (t) => {
  const { root, script } = area(t); let release;
  const entered = new Promise((resolve) => {
    const server = createServer((req, res) => { release = () => res.end('PRIVATE-TOOL-RESULT'); resolve(); });
    server.listen(0, '127.0.0.1');
    t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
    t.server = server;
  });
  if (!t.server.listening) await once(t.server, 'listening');
  const tool = script('http-tool', `import {get} from 'node:http'; get('http://127.0.0.1:${t.server.address().port}', res=>res.pipe(process.stdout));`);
  const job = await startJob(root, 'image-test', tool, 10000);
  await entered;
  const { bridge, config, store } = fixture(t); config.require_lease_token = true;
  const muse = new MuseAdapter(bridge);
  for (let i = 0; i < 5; i++) bridge.ingest({ msgs: [{ message_id: 'short-' + i, from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: 'short' } }] }] });
  for (let i = 0; i < 5; i++) {
    const task = (await muse.next()).tasks[0];
    assert.equal((await muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'reply' })).state, 'accepted');
  }
  assert.equal(store.queueStats().pending, 0);
  assert.equal(listJobs(root)[0].state, 'running'); // HTTP request is still held.
  release(); const finished = await waitJob(root, 'image-test');
  assert.equal(finished.state, 'succeeded');
  assert.equal(readFileSync(join(job.directory, 'stdout.log'), 'utf8'), 'PRIVATE-TOOL-RESULT');
  assert.equal(JSON.stringify(listJobs(root)).includes('PRIVATE-TOOL-RESULT'), false);
  assert.equal(statSync(join(job.directory, 'stdout.log')).mode & 0o777, 0o600);
});

test('stable tool job IDs never rerun a script, including failed jobs', linux, async (t) => {
  const { root, script, directory } = area(t); const marker = join(directory, 'calls');
  const tool = script('once', `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},${JSON.stringify('called\n')}); process.exitCode=1;`);
  await startJob(root, 'stable', tool, 1000); assert.equal((await waitJob(root, 'stable')).state, 'failed');
  assert.equal((await startJob(root, 'stable', tool, 1000)).cached, true);
  assert.equal(readFileSync(marker, 'utf8'), 'called\n');
  await assert.rejects(startJob(root, 'stable', tool, 2000), { code: 'job_id_conflict' });
});

test('tool deadlines and output limits stop local processes and preserve review state', linux, async (t) => {
  const { root, script } = area(t);
  await startJob(root, 'timeout', script('blocked', 'setInterval(()=>{},1000);'), 200);
  const expired = await waitJob(root, 'timeout'); assert.equal(expired.state, 'timed_out'); assert.equal(expired.needs_review, true);
  await startJob(root, 'limit', script('noisy', "process.stdout.write('x'.repeat(2*1024*1024)); setInterval(()=>{},1000);"), 2000);
  const limited = await waitJob(root, 'limit'); assert.equal(limited.state, 'output_limit'); assert.ok(limited.output_bytes <= 1024 * 1024);
});

test('finished tool jobs wake once until explicitly settled; cancellation does not ack a message', linux, async (t) => {
  const { root, script } = area(t);
  await startJob(root, 'cancelled', script('wait', 'setInterval(()=>{},1000);'), 5000);
  await waitJob(root, 'cancelled', (job) => job.state === 'running'); cancelJob(root, 'cancelled');
  assert.equal((await waitJob(root, 'cancelled')).state, 'cancelled'); assert.equal(pendingJobs(root), 1);
  assert.throws(() => settleJob(root, 'cancelled', false), { code: 'review_required' });
  assert.equal(settleJob(root, 'cancelled', true).event_acknowledged, false); assert.equal(pendingJobs(root), 0);
});

test('tool job capacity rejects a third active tool without launching it', linux, async (t) => {
  const { root, script } = area(t); const tool = script('bounded', 'setInterval(()=>{},1000);');
  await startJob(root, 'first', tool, 5000); await startJob(root, 'second', tool, 5000);
  await assert.rejects(startJob(root, 'third', tool, 5000), { code: 'job_capacity' });
  assert.equal(listJobs(root).length, 2);
});
