import { spawn } from 'node:child_process';
import { existsSync, fsyncSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateJson } from './config.mjs';
import { fail, integer } from './errors.mjs';
import { lockState } from './state-lock.mjs';

const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'output_limit']);
const helper = fileURLToPath(new URL('../scripts/tool-job.mjs', import.meta.url));
const stamp = () => new Date().toISOString();
function area(root, create = false) {
  root = resolve(root);
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(root)) return null;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('unsafe_job_directory', 'Use a private real directory (0700) for tool jobs.');
  if (realpathSync(root) !== root) fail('unsafe_job_directory', 'Use the canonical path without symbolic links.');
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
      let alive = false;
      if (Number.isSafeInteger(job.supervisor_pid)) {
        try { process.kill(job.supervisor_pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
      }
      return { ...job, directory: join(root, entry.name), attention_required: !terminal.has(job.state) && (job.supervisor_pid ? !alive : Date.now() - Date.parse(job.created_at) > 5000) };
    });
}
export function pendingJobs(root) { return listJobs(root).filter((job) => (terminal.has(job.state) || job.attention_required) && !job.settled_at).length; }
export async function startJob(root, id, script, timeout = 120000) {
  if (process.platform !== 'linux') fail('job_platform_unsupported', 'Background tool supervision currently supports Linux only.');
  root = area(root, true); const path = location(root, id);
  integer(timeout, 100, 1200000, 'timeout');
  script = resolve(script);
  if (!script.endsWith('.mjs') || !lstatSync(script).isFile() || lstatSync(script).isSymbolicLink()) fail('invalid_job_script', 'Use a trusted local .mjs tool script.');
  const unlock = lockState(join(root, '.launch'));
  try {
    if (existsSync(path)) {
      const prior = read(path);
      if (prior.script !== script || prior.timeout_ms !== timeout) fail('job_id_conflict', 'This job ID belongs to another script or deadline.');
      return { ...prior, directory: path, cached: true };
    }
    const jobs = listJobs(root);
    if (jobs.length >= 256 || jobs.filter((job) => !terminal.has(job.state)).length >= 2) fail('job_capacity', 'At most two unfinished jobs and 256 retained records; inspect existing jobs first.', 429);
    mkdirSync(path, { mode: 0o700 });
    const record = { id, script, timeout_ms: timeout, state: 'starting', created_at: stamp(), settled_at: null };
    privateJson(join(path, 'job.json'), record);
    const supervisor = spawn(process.execPath, [helper, '__run', '--dir', root, '--id', id], { detached: true, stdio: 'ignore', windowsHide: true });
    try { await new Promise((done, reject) => { supervisor.once('spawn', done); supervisor.once('error', reject); }); }
    catch { privateJson(join(path, 'job.json'), { ...record, state: 'failed', finished_at: stamp(), needs_review: true, error: 'supervisor_start_failed' }); fail('supervisor_start_failed', 'Tool supervisor could not start.', 500); }
    supervisor.unref();
    return { ...record, directory: path, supervisor_pid: supervisor.pid, cached: false };
  } finally { unlock(); }
}
export function cancelJob(root, id) {
  root = area(root); if (!root) fail('job_not_found', 'Unknown job.');
  const path = location(root, id); const job = read(path);
  if (!terminal.has(job.state) && !existsSync(join(path, 'cancel'))) writeFileSync(join(path, 'cancel'), '', { flag: 'wx', mode: 0o600 });
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

// Separate OS process, not a parallel Muse model. No bridge calls, token access,
// automatic checkpoints, acknowledgements, tool retries or WeChat messages.
export async function runJob(root, id) {
  if (process.platform !== 'linux') fail('job_platform_unsupported', 'Background tool supervision currently supports Linux only.');
  root = area(root); const path = location(root, id); let record = read(path);
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
    if (record.state !== 'starting') return;
    if (existsSync(join(path, 'cancel'))) { finish('cancelled'); return; }
    for (const name of streams) output.push(openSync(join(path, name + '.log'), 'wx', 0o600));
    child = spawn(process.execPath, [record.script], { cwd: dirname(record.script), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, MUSE_LINK_JOB_DIR: path } });
    record = { ...record, state: 'running', supervisor_pid: process.pid, pid: child.pid, started_at: stamp() };
    privateJson(join(path, 'job.json'), record);
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
  }
}
