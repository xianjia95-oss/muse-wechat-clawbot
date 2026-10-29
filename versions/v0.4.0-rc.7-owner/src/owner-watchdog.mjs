import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { Agent, request } from 'undici';
import { loadConfig, localUrl, privateJson } from './config.mjs';
import { fail, integer } from './errors.mjs';
import { readConversationSession, readPrivateDocument } from './task-file.mjs';
import { lockState } from './state-lock.mjs';

export const WATCHDOG_PROTOCOL = 'muse-link-owner-watchdog/v1';
const active = new Set(['starting', 'running', 'waiting_for_authorization']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'terminated']);
const validHandle = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const defaults = { interval_ms: 15000, failure_threshold: 3, adapter_timeout_ms: 10000,
  retry_base_ms: 30000, recovery_window_ms: 900000, max_recoveries: 3 };

function directory(path, requirePrivate = true) {
  for (let parent = path; ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_watchdog_path', 'Watchdog paths must not traverse symbolic links.');
    if (requirePrivate && parent === path && process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))
      fail('unsafe_watchdog_path', 'Watchdog data directories must be owned by this user with mode 0700.');
    if (parent === parse(parent).root) break;
  }
}
function absolute(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) fail('invalid_watchdog_config', 'Use normalized absolute paths.');
  return value;
}

export function loadWatchdogConfig(path) {
  const raw = readPrivateDocument(absolute(path));
  const required = ['bridge_config', 'session_file', 'claims_dir', 'state_dir', 'slot'];
  const allowed = new Set([...required, ...Object.keys(defaults), 'adapter_script', 'recovery_enabled']);
  if (!raw || Array.isArray(raw) || Object.keys(raw).some((key) => !allowed.has(key))) fail('invalid_watchdog_config', 'Unknown watchdog configuration field.');
  for (const key of required.slice(0, 4)) absolute(raw[key]);
  if (typeof raw.slot !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.slot)
    || (raw.recovery_enabled !== undefined && typeof raw.recovery_enabled !== 'boolean')) fail('invalid_watchdog_config', 'Provide a slot and an explicit boolean recovery_enabled.');
  const config = { ...defaults, recovery_enabled: false, adapter_script: null, ...raw };
  integer(config.interval_ms, 1000, 300000, 'interval_ms');
  integer(config.failure_threshold, 2, 20, 'failure_threshold');
  integer(config.adapter_timeout_ms, 100, 60000, 'adapter_timeout_ms');
  integer(config.retry_base_ms, 1000, 300000, 'retry_base_ms');
  integer(config.recovery_window_ms, 60000, 3600000, 'recovery_window_ms');
  integer(config.max_recoveries, 1, 10, 'max_recoveries');
  directory(dirname(config.state_dir), false);
  if (!existsSync(config.state_dir)) mkdirSync(config.state_dir, { mode: 0o700 });
  directory(config.state_dir); directory(config.claims_dir);
  if (config.adapter_script !== null) {
    absolute(config.adapter_script); directory(dirname(config.adapter_script));
    const stat = lstatSync(config.adapter_script);
    if (!stat.isFile() || stat.isSymbolicLink() || !config.adapter_script.endsWith('.mjs')
      || (process.platform !== 'win32' && ((stat.mode & 0o022) || stat.uid !== process.getuid())))
      fail('unsafe_watchdog_adapter', 'Use a trusted local .mjs adapter owned by this user.');
  }
  const bridge = loadConfig(config.bridge_config);
  if (resolve(bridge.state_dir) === config.state_dir) fail('invalid_watchdog_config', 'The watchdog needs its own state directory.');
  readConversationSession(config.session_file, localUrl(bridge), bridge.path);
  return config;
}

// The adapter is trusted platform integration code, never a shell command or
// model prompt. A timeout can leave a remote task alive: retain the request ID.
export async function invokeOwnerAdapter(config, input) {
  if (!config.adapter_script) fail('platform_adapter_not_connected', 'No native task adapter is configured.');
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [config.adapter_script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let settled = false, size = 0, chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(Object.assign(new Error('Native task adapter failed; inspect its private platform records.'), { code: error })); }
      else done(value);
    };
    const timer = setTimeout(() => finish('platform_adapter_timeout'), config.adapter_timeout_ms);
    child.on('error', () => finish('platform_adapter_failed'));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16384) finish('platform_adapter_output_limit'); else chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish('platform_adapter_failed');
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish('platform_adapter_invalid_response'); }
    });
    child.stdin.end(JSON.stringify(input) + '\n');
  });
}

export async function probeConversation(config) {
  // Reload credentials each time, but never extend the owner's session.
  const bridge = loadConfig(config.bridge_config), endpoint = localUrl(bridge);
  const token = readConversationSession(config.session_file, endpoint, bridge.path);
  const agent = new Agent({ connections: 1 });
  try {
    const response = await request(endpoint + '/v1/muse/conversation/probe', {
      method: 'POST', dispatcher: agent, signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${bridge.api_token}`, 'X-Muse-Conversation': token, 'Content-Type': 'application/json' }, body: '{}',
    });
    let size = 0, chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8192) fail('watchdog_probe_invalid', 'Probe response exceeds its budget.');
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (response.statusCode !== 200 || result.mode !== 'coordinator' || typeof result.owner_active !== 'boolean'
      || typeof result.recovery_allowed !== 'boolean') fail('watchdog_probe_invalid', 'The original session must match a compatible running bridge.');
    return result;
  } finally { await agent.close(); }
}

function snapshot(value, input) {
  if (!value || value.protocol !== WATCHDOG_PROTOCOL || value.slot !== input.slot || value.authoritative !== true
    || !Array.isArray(value.owners) || value.owners.length > 8) fail('platform_inspection_unverified', 'A complete authoritative native task inspection is required.');
  const owner = (item) => item && validHandle(item.handle) && (active.has(item.state) || terminal.has(item.state) || item.state === 'unknown');
  if (!value.owners.every(owner) || new Set(value.owners.map((item) => item.handle)).size !== value.owners.length)
    fail('platform_inspection_unverified', 'Invalid native task records.');
  if (input.tracked_handle && (!owner(value.tracked) || value.tracked.handle !== input.tracked_handle))
    fail('platform_inspection_unverified', 'The previously tracked task must be queried explicitly.');
  if (value.tracked && !owner(value.tracked)) fail('platform_inspection_unverified', 'Invalid tracked task.');
  const entries = [...value.owners, ...(value.tracked ? [value.tracked] : [])];
  const states = new Map();
  for (const entry of entries) {
    if (states.has(entry.handle) && states.get(entry.handle) !== entry.state) fail('platform_inspection_unverified', 'Conflicting task observations.');
    states.set(entry.handle, entry.state);
  }
  const live = [...states].filter(([, state]) => active.has(state));
  if (live.length > 1) fail('owner_conflict', 'Multiple live owners exist. No task was started or killed.');
  if ([...states.values()].includes('unknown')) fail('platform_inspection_unverified', 'Unknown task state is not proof of exit.');
  return { live: live[0] ? { handle: live[0][0], state: live[0][1] } : null,
    previous: input.tracked_handle ?? value.owners[0]?.handle ?? null };
}

// Hold this object for the lifetime of the independent watchdog. The OS lock
// releases on crashes; recovery intent is durable before any platform mutation.
export class OwnerWatchdog {
  constructor(config, { probe = probeConversation, adapter = invokeOwnerAdapter, now = Date.now, save = privateJson } = {}) {
    this.config = config; this.probe = probe; this.adapter = adapter; this.now = now; this.save = save;
    this.release = lockState(config.state_dir);
    this.path = join(config.state_dir, 'owner-watchdog.json');
    const scope = createHash('sha256').update(JSON.stringify([config.slot, config.bridge_config, config.session_file, config.claims_dir])).digest('hex');
    const adapterId = config.adapter_script === null ? null : createHash('sha256').update(config.adapter_script).digest('hex');
    try {
      this.state = existsSync(this.path) ? readPrivateDocument(this.path) : { version: 1, scope, adapter: adapterId, observed_handle: null, dead_count: 0, dead_handle: null, pending: null, attempts: [], last: null };
      const s = this.state;
      const p = s.pending;
      const pendingValid = p === null || (p && typeof p === 'object' && !Array.isArray(p)
        && typeof p.request_id === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.request_id)
        && Number.isSafeInteger(p.next_attempt_ms) && p.next_attempt_ms >= 0
        && Number.isSafeInteger(p.count) && p.count >= 0 && p.count <= 100
        && (p.previous_handle === null || validHandle(p.previous_handle)));
      if (s.version !== 1 || s.scope !== scope || !(s.observed_handle === null || validHandle(s.observed_handle))
        || !Number.isSafeInteger(s.dead_count) || s.dead_count < 0 || s.dead_count > 20 || !(s.dead_handle === null || validHandle(s.dead_handle))
        || !Array.isArray(s.attempts) || s.attempts.length > 100 || !s.attempts.every((n) => Number.isSafeInteger(n) && n >= 0)
        || !pendingValid)
        fail('invalid_watchdog_state', 'Retain the original watchdog state for review; do not delete an uncertain recovery intent.');
      // It is safe to connect the first adapter after observation-only checks.
      // Once native ownership or an intent was recorded, changes need review.
      if (s.adapter !== adapterId && !(s.adapter === null && s.observed_handle === null && s.pending === null && s.dead_count === 0))
        fail('invalid_watchdog_state', 'Reconcile the existing native adapter and pending ownership before changing its path.');
      s.adapter = adapterId;
    } catch (error) { this.release(); throw error; }
  }
  close() {
    if (this.busy) fail('watchdog_busy', 'Wait for the in-flight check before releasing the monitor lock.');
    this.closed = true; this.release();
  }
  record(code, extra = {}) {
    this.state.last = { at: new Date(this.now()).toISOString(), code, ...extra };
    this.save(this.path, this.state);
    return this.state.last;
  }
  async tick({ observeOnly = false } = {}) {
    if (this.closed) fail('watchdog_closed', 'The watchdog is closed.');
    if (this.busy) fail('watchdog_busy', 'A watchdog check is already running.');
    this.busy = true;
    try { return await this.check(observeOnly); }
    finally { this.busy = false; }
  }
  async check(observeOnly) {
    const config = this.config, state = this.state, now = this.now();
    let bridge;
    try { bridge = await this.probe(config); }
    catch { state.dead_count = 0; return this.record('bridge_or_session_unavailable'); }
    if (bridge.recovery_allowed !== true) { state.dead_count = 0; return this.record('recovery_paused'); }
    if (!config.adapter_script) {
      state.dead_count = 0;
      return this.record('platform_adapter_not_connected', { owner_active: bridge.owner_active === true,
        queue: Object.fromEntries(['pending', 'ready', 'leased'].map((key) => [key,
          Number.isSafeInteger(bridge.queue?.[key]) && bridge.queue[key] >= 0 ? bridge.queue[key] : null])), native_task_query_available: false });
    }
    const input = { protocol: WATCHDOG_PROTOCOL, action: 'inspect', slot: config.slot, tracked_handle: state.observed_handle };
    let inspected;
    try { inspected = snapshot(await this.adapter(config, input), input); }
    catch (error) { state.dead_count = 0; return this.record(error.code === 'owner_conflict' ? 'owner_conflict' : 'platform_inspection_unverified'); }
    if (inspected.live) {
      state.observed_handle = inspected.live.handle; state.dead_count = 0; state.dead_handle = null; state.pending = null;
      return this.record(inspected.live.state === 'waiting_for_authorization' ? 'worker_waiting_for_authorization'
        : inspected.live.state === 'starting' ? 'worker_starting' : bridge.owner_active ? 'worker_running' : 'worker_heartbeat_stale',
      { platform_state: inspected.live.state, owner_active: bridge.owner_active === true });
    }
    if (state.dead_handle !== inspected.previous) state.dead_count = 0;
    state.dead_handle = inspected.previous;
    if (observeOnly || config.recovery_enabled !== true) { state.dead_count = 0; return this.record('recovery_disabled'); }
    // These are consecutive authoritative confirmations, never missed probes.
    state.dead_count = Math.min(config.failure_threshold, state.dead_count + 1);
    if (state.dead_count < config.failure_threshold) return this.record('confirming_worker_exit');
    if (state.pending && state.pending.previous_handle !== inspected.previous) return this.record('recovery_handoff_conflict');
    state.attempts = state.attempts.filter((at) => at > now - config.recovery_window_ms);
    if (state.attempts.length >= config.max_recoveries) return this.record('recovery_rate_limited');
    if (state.pending && state.pending.next_attempt_ms > now) return this.record('recovery_backoff');
    if (!state.pending) state.pending = { request_id: randomUUID(), previous_handle: inspected.previous, count: 0, next_attempt_ms: now };
    const pending = state.pending;
    pending.count = Math.min(100, pending.count + 1);
    pending.next_attempt_ms = now + Math.min(300000, config.retry_base_ms * 2 ** Math.min(8, pending.count - 1));
    state.attempts.push(now);
    // A crash, disk failure, timeout or lost response must never produce a new ID.
    this.record('recovery_submitting');
    const ensure = { ...input, action: 'ensure', recovery_id: pending.request_id, expected_previous_handle: pending.previous_handle,
      handoff: { bridge_config: config.bridge_config, session_file: config.session_file, claims_dir: config.claims_dir } };
    // Revalidate the saved session and maintenance gate immediately before start.
    try { if ((await this.probe(config)).recovery_allowed !== true) return this.record('recovery_paused'); }
    catch { return this.record('bridge_or_session_unavailable'); }
    let result;
    try {
      result = await this.adapter(config, ensure);
      if (result?.recovery_id !== pending.request_id) return this.record('recovery_outcome_unknown');
      const verified = snapshot(result, input);
      if (!verified.live) return this.record('recovery_outcome_unknown');
      state.observed_handle = verified.live.handle; state.dead_count = 0; state.dead_handle = null; state.pending = null;
      return this.record('recovery_started', { platform_state: verified.live.state });
    } catch { return this.record('recovery_outcome_unknown'); }
  }
}
