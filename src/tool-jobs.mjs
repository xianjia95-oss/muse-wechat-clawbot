import { spawn } from 'node:child_process';
import { existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { privateJson } from './config.mjs';
import { fail, integer } from './errors.mjs';
import { lockState } from './state-lock.mjs';

const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'output_limit', 'interrupted', 'expired']);
// Existing workers retain their old limits until explicitly configured.
export const JOB_DEFAULTS = Object.freeze({ max_active: 2, max_io: 2, max_cpu: 2, max_queued: 64 });
const helper = fileURLToPath(new URL('../scripts/tool-job.mjs', import.meta.url));
const stamp = () => new Date().toISOString();
function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], group: Number(fields[2]), identity: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19] };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
function supervisorAlive(job) {
  if (!job.supervisor_pid) return false;
  if (process.platform === 'linux') {
    const info = processInfo(job.supervisor_pid);
    return !!info && !['Z', 'X'].includes(info.state) && (!job.supervisor_identity || job.supervisor_identity === info.identity);
  }
  try { process.kill(job.supervisor_pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function groupAlive(pid) {
  // Conservative: a reused live group also prevents reconciliation. Never signal it.
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).some((name) => {
    const info = processInfo(Number(name));
    return info?.group === pid && !['Z', 'X'].includes(info.state);
  });
}
function area(root, create = false) {
  root = resolve(root);
  const firstCreated = create && mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(root)) return null;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('unsafe_job_directory', 'Use a private real directory (0700) for tool jobs.');
  if (realpathSync(root) !== root) fail('unsafe_job_directory', 'Use the canonical path without symbolic links.');
  if (firstCreated && process.platform !== 'win32') for (let directory = root; ; directory = dirname(directory)) {
    syncDirectory(directory);
    if (directory === dirname(firstCreated)) break;
  }
  return root;
}
function location(root, id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id ?? '')) fail('invalid_job_id', 'Job IDs use 1..64 letters, digits, _ or -.');
  const path = join(root, id);
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) fail('unsafe_job_directory', 'Job must be a real directory.');
  return path;
}
function read(path) {
  const file = join(path, 'job.json');
  if (lstatSync(file).isSymbolicLink()) fail('unsafe_job_directory', 'Job metadata must not be a symbolic link.');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function listJobs(root) {
  root = area(root); if (!root) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
    .map((entry) => {
      const job = read(location(root, entry.name));
      const alive = supervisorAlive(job);
      const launchedAt = Date.parse(job.dispatched_at ?? job.created_at);
      const { review_note, ...metadata } = job;
      return { ...metadata, kind: job.kind ?? 'cpu', directory: join(root, entry.name),
        attention_required: job.state !== 'queued' && !terminal.has(job.state) && (job.supervisor_pid ? !alive : !Number.isFinite(launchedAt) || Date.now() - launchedAt > 5000) };
    });
}
function validatePolicy(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail('invalid_job_policy', 'Scheduler policy must be an object.');
  for (const key of Object.keys(values)) if (!Object.hasOwn(JOB_DEFAULTS, key)) fail('invalid_job_policy', `Unknown scheduler option: ${key}`);
  const limits = { ...JOB_DEFAULTS, ...values };
  for (const [key, value] of Object.entries(limits)) integer(value, 1, key === 'max_queued' ? 256 : 32, key);
  return limits;
}
function policy(root) {
  const path = root && join(root, '.scheduler.json');
  if (!path || !existsSync(path)) return { ...JOB_DEFAULTS };
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) fail('unsafe_job_policy', 'Scheduler policy must be a private regular file.');
  return validatePolicy(JSON.parse(readFileSync(path, 'utf8')));
}
function activeJobs(jobs) { return jobs.filter((job) => job.state !== 'queued' && !terminal.has(job.state)); }
function available(jobs, limits, kind) {
  const active = activeJobs(jobs);
  return active.length < limits.max_active && active.filter((job) => job.kind === kind).length < limits[`max_${kind}`];
}
function queuedJobs(jobs) { return jobs.filter((job) => job.state === 'queued').sort((a, b) => a.queue_sequence - b.queue_sequence); }
export function jobStatus(root) {
  root = area(root); const limits = policy(root), jobs = root ? listJobs(root) : [], active = activeJobs(jobs), queued = queuedJobs(jobs);
  return { limits, active: { total: active.length, io: active.filter((job) => job.kind === 'io').length, cpu: active.filter((job) => job.kind === 'cpu').length },
    queued: { total: queued.length, io: queued.filter((job) => job.kind === 'io').length, cpu: queued.filter((job) => job.kind === 'cpu').length },
    oldest_queued_ms: queued.length ? Math.max(0, Date.now() - Date.parse(queued[0].created_at)) : null,
    retained: jobs.length, attention_required: jobs.filter((job) => job.attention_required).length };
}
export function pendingJobs(root) {
  root = area(root); if (!root) return 0;
  const jobs = listJobs(root), limits = policy(root);
  return jobs.filter((job) => !job.settled_at && (terminal.has(job.state) || job.attention_required ||
    (job.state === 'queued' && (Date.parse(job.start_before) <= Date.now() || available(jobs, limits, job.kind))))).length;
}
async function launchLock(root) {
  const until = Date.now() + 2000;
  for (;;) {
    try { return lockState(join(root, '.launch')); }
    catch (error) { if (error.code !== 'state_locked' || Date.now() >= until) throw error; await pause(10); }
  }
}
function toolArguments(root, id, script, timeout, kind) {
  if (!['io', 'cpu'].includes(kind)) fail('invalid_job_kind', 'Explicitly classify trusted tools as io or cpu.');
  integer(timeout, 100, 1200000, 'timeout');
  script = resolve(script);
  return { path: location(root, id), script };
}
function validateScript(script) {
  if (!script.endsWith('.mjs') || !lstatSync(script).isFile() || lstatSync(script).isSymbolicLink()) fail('invalid_job_script', 'Use a trusted local .mjs tool script.');
}
function cachedJob(path, script, timeout, kind) {
  if (!existsSync(path)) return null;
  const prior = read(path);
  if (prior.script !== script || prior.timeout_ms !== timeout || (prior.kind ?? 'cpu') !== kind) fail('job_id_conflict', 'This job ID belongs to another script, class or deadline.');
  const { review_note, ...metadata } = prior;
  return { ...metadata, cached: true, directory: path };
}
function startDeadline(value) {
  const deadline = typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 3600000)
    fail('invalid_start_deadline', 'Set start_before to a future ISO time within one hour, before the event lease expires.');
  return new Date(deadline).toISOString();
}
function syncDirectory(root) {
  const fd = openSync(root, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function publishJob(root, path, record) {
  // Readers must never observe a final job directory without its metadata.
  // Interrupted staging records cannot authorize a tool and stay private.
  const staging = mkdtempSync(join(root, '.new-'));
  privateJson(join(staging, 'job.json'), record);
  renameSync(staging, path);
  syncDirectory(root);
}
async function launch(root, record) {
  const path = location(root, record.id);
  privateJson(join(path, 'job.json'), { ...record, state: 'starting', dispatched_at: stamp() });
  // Persist a newly created job directory before permitting any tool effects.
  syncDirectory(root);
  const supervisor = spawn(process.execPath, [helper, '__run', '--dir', root, '--id', record.id], { detached: true, stdio: 'ignore', windowsHide: true });
  try { await new Promise((done, reject) => { supervisor.once('spawn', done); supervisor.once('error', reject); }); }
  catch {
    privateJson(join(path, 'job.json'), { ...record, state: 'failed', finished_at: stamp(), needs_review: true, error: 'supervisor_start_failed' });
    fail('supervisor_start_failed', 'Tool supervisor could not start.', 500);
  }
  supervisor.unref();
  return { ...record, state: 'starting', directory: path, supervisor_pid: supervisor.pid, cached: false };
}
// Caller holds the admission lock. A full CPU lane does not block IO.
async function drainQueue(root) {
  const limits = policy(root), started = [], expired = [], failed = [];
  for (const queued of queuedJobs(listJobs(root))) {
    const path = location(root, queued.id), record = read(path);
    if (record.state !== 'queued') continue;
    if (!Number.isFinite(Date.parse(record.start_before)) || Date.parse(record.start_before) <= Date.now()) {
      privateJson(join(path, 'job.json'), { ...record, state: 'expired', finished_at: stamp(), needs_review: false, error: 'queue_start_deadline_passed' });
      expired.push(record.id); continue;
    }
    if (!available(listJobs(root), limits, record.kind)) continue;
    try { await launch(root, record); started.push(record.id); }
    catch (error) { if (error.code !== 'supervisor_start_failed') throw error; failed.push(record.id); }
  }
  return { started, expired, failed };
}
export async function dispatchJobs(root) {
  if (process.platform !== 'linux') fail('job_platform_unsupported', 'Background tool supervision currently supports Linux only.');
  const requested = root; root = area(root);
  if (!root) return { started: [], expired: [], failed: [], ...jobStatus(requested) };
  const unlock = await launchLock(root);
  try { return { ...await drainQueue(root), ...jobStatus(root) }; }
  finally { unlock(); }
}
export async function configureJobs(root, changes) {
  root = area(root, true); const unlock = await launchLock(root);
  try {
    const limits = validatePolicy({ ...policy(root), ...changes });
    privateJson(join(root, '.scheduler.json'), limits);
    return jobStatus(root);
  } finally { unlock(); }
}
export async function enqueueJob(root, id, script, timeout = 120000, { kind, startBefore } = {}) {
  if (process.platform !== 'linux') fail('job_platform_unsupported', 'Background tool supervision currently supports Linux only.');
  root = area(root, true);
  const args = toolArguments(root, id, script, timeout, kind), unlock = await launchLock(root);
  try {
    const cached = cachedJob(args.path, args.script, timeout, kind); if (cached) return cached;
    validateScript(args.script);
    const start_before = startDeadline(startBefore), limits = policy(root), jobs = listJobs(root);
    if (jobs.length >= 256 || queuedJobs(jobs).length >= limits.max_queued) fail('job_capacity', 'Durable job queue or retained-record capacity reached; preserve the original task and retry later.', 429);
    const record = { id, kind, run_id: randomUUID(), script: args.script, timeout_ms: timeout, state: 'queued', start_before,
      queue_sequence: Math.max(0, ...jobs.map((job) => job.queue_sequence ?? 0)) + 1, created_at: stamp() };
    publishJob(root, args.path, record);
    await drainQueue(root);
    return { ...read(args.path), directory: args.path, cached: false };
  } finally { unlock(); }
}
export async function refreshQueuedJob(root, id, startBefore) {
  root = area(root); if (!root) fail('job_not_found', 'Unknown job.');
  const unlock = await launchLock(root);
  try {
    const path = location(root, id), record = read(path);
    if (record.state !== 'queued') return { id, state: record.state, refreshed: false };
    const start_before = startDeadline(startBefore);
    privateJson(join(path, 'job.json'), { ...record, start_before });
    return { id, state: 'queued', start_before, refreshed: true };
  } finally { unlock(); }
}
export async function startJob(root, id, script, timeout = 120000, { kind = 'cpu' } = {}) {
  if (process.platform !== 'linux') fail('job_platform_unsupported', 'Background tool supervision currently supports Linux only.');
  root = area(root, true); const args = toolArguments(root, id, script, timeout, kind), unlock = await launchLock(root);
  try {
    const cached = cachedJob(args.path, args.script, timeout, kind); if (cached) return cached;
    validateScript(args.script);
    const jobs = listJobs(root);
    if (jobs.length >= 256 || queuedJobs(jobs).length || !available(jobs, policy(root), kind)) fail('job_capacity', 'Active capacity reached or queued work is ahead; use enqueue for durable scheduling.', 429);
    const record = { id, kind, run_id: randomUUID(), script: args.script, timeout_ms: timeout, state: 'starting', created_at: stamp(), settled_at: null };
    publishJob(root, args.path, record);
    return await launch(root, record);
  } finally { unlock(); }
}
export function cancelJob(root, id) {
  root = area(root); if (!root) fail('job_not_found', 'Unknown job.');
  const path = location(root, id); let job = read(path);
  if (job.state === 'queued') {
    const unlock = lockState(join(root, '.launch'));
    try {
      job = read(path);
      if (job.state === 'queued') {
        privateJson(join(path, 'job.json'), { ...job, state: 'cancelled', finished_at: stamp(), needs_review: false });
        return { id, state: 'cancelled', event_acknowledged: false };
      }
    } finally { unlock(); }
  }
  if (!terminal.has(job.state)) {
    try { writeFileSync(join(path, 'cancel'), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return { id, cancel_requested: !terminal.has(job.state), state: job.state };
}
export function settleJob(root, id, reviewed) {
  if (!reviewed) fail('review_required', 'Verify the result and its reply/review disposition before settling a notification.');
  root = area(root); if (!root) fail('job_not_found', 'Unknown job.');
  const path = location(root, id); const job = read(path);
  if (!terminal.has(job.state)) fail('job_running', 'Job is not finished.');
  privateJson(join(path, 'job.json'), { ...job, settled_at: job.settled_at ?? stamp() });
  return { id, settled: true, event_acknowledged: false };
}

export function reconcileJob(root, id, reviewed, note) {
  if (process.platform !== 'linux') fail('job_platform_unsupported', 'Orphan reconciliation supports Linux only.');
  if (!reviewed || typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 8192) fail('review_required', 'Supply --reviewed and a private review note of 1..8192 bytes through stdin.');
  root = area(root); if (!root) fail('job_not_found', 'Unknown job.');
  const path = location(root, id);
  if (!existsSync(path)) fail('job_not_found', 'Unknown job.');
  const launch = lockState(join(root, '.launch'));
  let release;
  try {
    try { release = lockState(join(path, '.supervisor')); }
    catch (error) { if (error.code === 'state_locked') fail('job_active', 'Supervisor is still active; request cancellation and inspect it first.', 409); throw error; }
    const job = read(path);
    if (terminal.has(job.state)) return { id, state: job.state, cached: true, event_acknowledged: false };
    if (job.state === 'queued') fail('job_not_started', 'Queued tools have not executed; cancel them or resume normal dispatch instead.');
    if (supervisorAlive(job) || (job.pid && groupAlive(job.pid))) fail('job_active', 'A recorded supervisor or tool process group is still alive. No process was signalled.', 409);
    if (!job.run_id && !job.pid) fail('job_identity_unknown', 'Legacy job has no tool identity; preserve it for manual investigation.', 409);
    privateJson(join(path, 'job.json'), { ...job, state: 'interrupted', finished_at: stamp(), needs_review: true,
      reconciled_at: stamp(), review_note: note.trim(), settled_at: null });
    return { id, state: 'interrupted', cached: false, event_acknowledged: false };
  } finally { release?.(); launch(); }
}

// Record-before-execution barrier: a supervisor killed between spawn and save
// cannot leave an unrecorded script performing external side effects.
export async function runTool(root, id, runId) {
  root = area(root); const path = location(root, id);
  if (!process.send || !process.connected) fail('job_bootstrap_unconfirmed', 'No supervisor permission channel.');
  const permitted = await new Promise((resolve) => {
    const done = (allowed) => { clearTimeout(timer); process.off('message', message); process.off('disconnect', disconnected); resolve(allowed); };
    const message = (value) => done(value?.execute === true && value.run_id === runId);
    const disconnected = () => done(false);
    const timer = setTimeout(() => done(false), 5000);
    process.once('message', message); process.once('disconnect', disconnected);
    process.send({ ready: true, run_id: runId }, (error) => { if (error) done(false); });
  });
  if (process.connected) process.disconnect();
  const job = read(path);
  if (!permitted || (job.start_before && Date.parse(job.start_before) <= Date.now()) || job.run_id !== runId || job.state !== 'running' || job.pid !== process.pid ||
      job.tool_identity !== processInfo(process.pid)?.identity || !supervisorAlive(job)) fail('job_bootstrap_unconfirmed', 'Tool execution was not durably authorized by its supervisor.');
  process.argv = [process.execPath, job.script];
  await import(pathToFileURL(job.script));
}

// Separate OS process, not a parallel Muse model. No bridge calls, token access,
// automatic checkpoints, acknowledgements, tool retries or WeChat messages.
export async function runJob(root, id) {
  if (process.platform !== 'linux') fail('job_platform_unsupported', 'Background tool supervision currently supports Linux only.');
  root = area(root); const path = location(root, id); let record;
  const unlock = lockState(join(path, '.supervisor'));
  const output = [], streams = ['stdout', 'stderr'];
  let child, reason, timer, watcher, escalation, size = 0;
  const finish = (state, details = {}) => {
    for (const fd of output) fsyncSync(fd);
    privateJson(join(path, 'job.json'), { ...record, state, supervisor_pid: process.pid, finished_at: stamp(), output_bytes: size, needs_review: state !== 'succeeded', ...details });
  };
  const signal = (name) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const terminate = (why) => {
    if (reason) return; reason = why;
    signal('SIGTERM'); escalation = setTimeout(() => signal('SIGKILL'), 1000);
  };
  const interrupted = () => terminate('cancelled');
  process.on('SIGTERM', interrupted); process.on('SIGINT', interrupted);
  try {
    record = read(path);
    if (record.state !== 'starting') return;
    if (existsSync(join(path, 'cancel'))) { finish('cancelled'); return; }
    if (record.start_before && Date.parse(record.start_before) <= Date.now()) { finish('expired', { needs_review: false, error: 'queue_start_deadline_passed' }); return; }
    for (const name of streams) output.push(openSync(join(path, name + '.log'), 'wx', 0o600));
    child = spawn(process.execPath, [helper, '__exec', '--dir', root, '--id', id, '--run-id', record.run_id], { cwd: dirname(record.script), detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: { ...process.env, MUSE_LINK_JOB_DIR: path } });
    record = { ...record, state: 'running', supervisor_pid: process.pid, supervisor_identity: processInfo(process.pid)?.identity,
      pid: child.pid, tool_identity: processInfo(child.pid)?.identity, started_at: stamp() };
    privateJson(join(path, 'job.json'), record);
    // A renamed file can be visible before the directory fsync finishes. IPC
    // permission is issued only after privateJson returns from durable save.
    child.once('message', (value) => {
      if (value?.ready === true && value.run_id === record.run_id && child.connected)
        child.send({ execute: true, run_id: record.run_id }, () => {});
    });
    streams.forEach((name, index) => child[name].on('data', (chunk) => {
      const remaining = Math.max(0, 1024 * 1024 - size);
      if (remaining) {
        const bytes = chunk.subarray(0, remaining);
        try { for (let offset = 0; offset < bytes.length;) offset += writeSync(output[index], bytes, offset, bytes.length - offset); size += bytes.length; }
        catch { terminate('failed'); }
      }
      if (chunk.length > remaining) terminate('output_limit');
    }));
    timer = setTimeout(() => terminate('timed_out'), record.timeout_ms);
    watcher = setInterval(() => { if (existsSync(join(path, 'cancel'))) terminate('cancelled'); }, 100);
    const result = await new Promise((done) => { child.once('error', () => done({ error: 'tool_start_failed' })); child.once('close', (code, signal) => done({ exit_code: code, signal })); });
    // Scripts must not leave background descendants after they finish.
    signal('SIGKILL');
    finish(reason ?? (result.exit_code === 0 ? 'succeeded' : 'failed'), result);
  } catch {
    terminate('failed'); signal('SIGKILL');
    try { finish('failed', { error: 'supervisor_failed' }); } catch { /* Disk failure leaves the record unresolved for review. */ }
  }
  finally {
    clearTimeout(timer); clearTimeout(escalation); clearInterval(watcher);
    process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted);
    for (const fd of output) closeSync(fd);
    unlock();
    // Free slots refill while Muse handles other messages. Failed dispatch is
    // recoverable through read-only pending detection and the next worker loop.
    try { await dispatchJobs(root); } catch { /* Durable queued records remain. */ }
  }
}
