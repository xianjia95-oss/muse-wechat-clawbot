import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { backupState, restoreState, verifyBackup } from '../src/backup.mjs';
import { Store } from '../src/store.mjs';
import { MuseAdapter } from '../src/muse.mjs';
import { mediaDirectory } from '../src/media.mjs';
import { reserveTaskFile } from '../src/task-file.mjs';
import { startJob, enqueueJob, listJobs, cancelJob, jobStatus, dispatchJobs } from '../src/tool-jobs.mjs';
import { fixture } from './helpers.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 30000 };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'expired']);
const deadline = () => new Date(Date.now() + 60000).toISOString();
const ioError = () => Object.assign(new Error('Injected disk sync/publication failure'), { code: 'EIO' });
async function finished(root, id) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const job = listJobs(root).find((job) => job.id === id);
    if (job && terminal.has(job.state)) return job;
    await pause(20);
  }
  assert.fail('Tool did not finish.');
}
function jobs(t) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-durable-')), root = join(directory, 'jobs');
  t.after(async () => {
    for (const job of listJobs(root)) if (!terminal.has(job.state)) { cancelJob(root, job.id); await finished(root, job.id); }
    await pause(150);
    rmSync(directory, { recursive: true, force: true });
  });
  const marker = join(directory, 'effects');
  const script = join(directory, 'tool.mjs');
  writeFileSync(script, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},${JSON.stringify('once\n')});`);
  return { directory, root, marker, script };
}
async function failFileSync(t, directory) {
  const handle = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(handle), original = prototype.sync;
  await handle.close();
  return t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isFile()) throw ioError();
    return original.call(this);
  });
}

test('stable job IDs remain cached after script cleanup, including failed tools', linux, async (t) => {
  const { directory, root, marker } = jobs(t);
  for (const method of [startJob, enqueueJob]) for (const failure of [false, true]) {
    const id = `${method.name}-${failure}`, script = join(directory, id + '.mjs');
    writeFileSync(script, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},${JSON.stringify('once\n')}); ${failure ? 'throw new Error("expected failure");' : ''}`);
    const options = { kind: 'io', startBefore: deadline() };
    await method(root, id, script, 3000, options);
    assert.equal((await finished(root, id)).state, failure ? 'failed' : 'succeeded');
    rmSync(script);
    assert.equal((await startJob(root, id, script, 3000, options)).cached, true);
    assert.equal((await enqueueJob(root, id, script, 3000, options)).cached, true);
    await assert.rejects(method(root, id, script, 3001, options), { code: 'job_id_conflict' });
    await assert.rejects(method(root, id, script, 3000, { ...options, kind: 'cpu' }), { code: 'job_id_conflict' });
  }
  assert.equal(readFileSync(marker, 'utf8'), 'once\nonce\nonce\nonce\n');
});

test('interrupted job publication cannot block the queue or execute an unrecorded tool', linux, async (t) => {
  const { root, marker, script } = jobs(t), original = fs.renameSync;
  for (const method of [startJob, enqueueJob]) {
    const id = method.name;
    const mock = t.mock.method(fs, 'renameSync', (source, target) => {
      if ((method === startJob && basename(target) === 'job.json') ||
          (basename(source).startsWith('.new-') && target === join(root, id))) throw ioError();
      return original(source, target);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(method(root, id, script, 3000, { kind: 'io', startBefore: deadline() }), { code: 'EIO' });
      assert.equal(existsSync(join(root, id)), false);
      assert.equal(existsSync(marker), method === enqueueJob);
      assert.ok(readdirSync(root).some((name) => name.startsWith('.new-')));
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(jobStatus(root).active.total, 0);
    await dispatchJobs(root);
    await method(root, id, script, 3000, { kind: 'io', startBefore: deadline() });
    assert.equal((await finished(root, id)).state, 'succeeded');
  }
  assert.equal(listJobs(root).length, 2);
  assert.equal(readFileSync(marker, 'utf8'), 'once\nonce\n');
});

test('racing cancellation markers are idempotent', linux, async (t) => {
  const { directory, root } = jobs(t), script = join(directory, 'wait.mjs');
  writeFileSync(script, 'setInterval(()=>{},1000);');
  await startJob(root, 'cancel', script, 5000);
  const original = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (path, bytes, options) => {
    if (path === join(root, 'cancel', 'cancel')) original(path, bytes, { mode: 0o600 });
    return original(path, bytes, options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(cancelJob(root, 'cancel').cancel_requested, true);
    assert.equal(cancelJob(root, 'cancel').cancel_requested, true);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await finished(root, 'cancel')).state, 'cancelled');
});

test('handoff reservation fails closed before claiming if directory persistence fails', linux, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-handoff-test-')), path = join(directory, 'task.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = fs.fsyncSync;
  const mock = t.mock.method(fs, 'fsyncSync', (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw ioError();
    return original(fd);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => reserveTaskFile(path, 'http://127.0.0.1:18791', '/private/config.json'), { code: 'EIO' }); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(JSON.parse(readFileSync(path)).claim_state, 'awaiting_response');
  assert.throws(() => reserveTaskFile(path, 'http://127.0.0.1:18791', '/private/config.json'), { code: 'EEXIST' });
});

test('media sync failure sends no caption, records no snapshot, and leaves the task unacknowledged', async (t) => {
  const { bridge, store, directory, config, calls } = fixture(t);
  config.require_lease_token = true; config.media_roots = [directory];
  const image = join(directory, 'image.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
  bridge.ingest({ msgs: [{ message_id: 'durable', from_user_id: 'owner', item_list: [] }] });
  const muse = new MuseAdapter(bridge), task = (await muse.next()).tasks[0];
  const mock = await failFileSync(t, directory);
  try {
    await assert.rejects(muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'caption', media: [{ type: 'image', path: image }] }), { code: 'media_prepare_failed' });
  } finally { mock.mock.restore(); }
  const send = store.db.prepare('SELECT id,state FROM sends').get();
  assert.equal(send.state, 'failed'); assert.equal(store.media(send.id, 1), null);
  assert.equal(existsSync(join(mediaDirectory(config, send.id), '1.bin')), false);
  assert.equal(calls.length, 0); assert.equal(store.event(task.event_id).acked_ms, null);
  assert.equal(bridge.resources.reserved, 0);
});

test('backup sync failure never publishes success and a fresh retry verifies', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-state-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { state_dir: join(directory, 'state') }, store = new Store(config.state_dir);
  const external = mkdtempSync(join(tmpdir(), 'muse-link-backup-test-')), output = join(external, 'backup');
  t.after(() => rmSync(external, { recursive: true, force: true }));
  store.set('cursor', 'durable-backup'); store.close();
  const mock = await failFileSync(t, directory);
  try { await assert.rejects(backupState(config, output), { code: 'EIO' }); }
  finally { mock.mock.restore(); }
  assert.equal(existsSync(output), false);
  assert.ok(readdirSync(external).some((name) => name.startsWith('.muse-link-backup-')));
  assert.equal((await backupState(config, output)).ok, true);
  await verifyBackup(output);
});

test('restore sync failure leaves original state in place and releases state ownership', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-state-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { state_dir: join(directory, 'state') }, store = new Store(config.state_dir);
  const external = mkdtempSync(join(tmpdir(), 'muse-link-restore-test-')), output = join(external, 'backup');
  t.after(() => rmSync(external, { recursive: true, force: true }));
  store.set('cursor', 'backup-version'); store.close();
  await backupState(config, output);
  const live = new Store(config.state_dir); live.set('cursor', 'live-version'); live.close();
  const mock = await failFileSync(t, directory);
  try { await assert.rejects(restoreState(config, output), { code: 'EIO' }); }
  finally { mock.mock.restore(); }
  const untouched = new Store(config.state_dir);
  try { assert.equal(untouched.get('cursor'), 'live-version'); assert.equal(untouched.get('restore_review_required', false), false); }
  finally { untouched.close(); }
  assert.equal((await restoreState(config, output)).review_required, true);
  const restored = new Store(config.state_dir);
  try { assert.equal(restored.get('cursor'), 'backup-version'); assert.equal(restored.get('restore_review_required'), true); }
  finally { restored.close(); }
});
