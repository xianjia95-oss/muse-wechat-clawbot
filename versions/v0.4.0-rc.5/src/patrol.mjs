// Monitoring only: no bridge database, claims, sends or native task creation.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { RECOVERY_REVISION } from './config.mjs';

const stamp = (ms) => new Date(ms).toISOString();
const code = (v) => typeof v === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(v) ? v : null;
const time = (v) => Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const hash = (v) => createHash('sha256').update(v).digest('hex');
const changed = (a, b) => a != null && b != null ? a !== b : null;

function serviceStatus() {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/systemctl', ['show', 'muse-link.service', '--property=LoadState,ActiveState,SubState'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '', oversized = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 3000);
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 8192) { oversized = true; child.kill('SIGKILL'); }
      else output += chunk;
    });
    child.on('error', () => { clearTimeout(timer); resolve({ available: false, error: 'service_query_failed' }); });
    child.on('close', (exit) => {
      clearTimeout(timer);
      const fields = Object.fromEntries(output.trim().split('\n').map((line) => line.split('=')));
      const known = !oversized && !timedOut && (exit === 0 || fields.LoadState === 'not-found');
      resolve({ available: known, load: known ? code(fields.LoadState?.replaceAll('-', '_')) : null,
        active: known ? code(fields.ActiveState) : null,
        error: known ? null : timedOut ? 'service_query_timeout' : 'service_query_failed' });
    });
  });
}

export async function systemEvidence({ platform = process.platform, read = readFileSync, stat = lstatSync, service = serviceStatus } = {}) {
  const value = { supported: platform === 'linux', boot: null, uptime_seconds: null,
    unit_present: null, unit_identity: null, service: { available: false } };
  if (!value.supported) return value;
  try {
    const boot = read('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (/^[a-f0-9-]{36}$/.test(boot)) value.boot = hash(boot);
  } catch { /* Missing evidence stays unknown, never implies a reset. */ }
  try {
    const seconds = Number(read('/proc/uptime', 'utf8').split(' ')[0]);
    if (Number.isFinite(seconds) && seconds >= 0) value.uptime_seconds = Math.floor(seconds);
  } catch { /* unavailable */ }
  try {
    const s = stat('/etc/systemd/system/muse-link.service');
    value.unit_present = true; value.unit_identity = hash(`${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`);
  } catch (error) { if (error.code === 'ENOENT') value.unit_present = false; }
  value.service = await service();
  return value;
}

export function recoveryEvidence(directory, readPrivate) {
  const state = readPrivate(join(directory, 'state.json'), null), a = state?.last_attempt;
  if (!a || time(a.started_at) === null || time(a.finished_at) === null) return null;
  return { started_at: stamp(time(a.started_at)), finished_at: stamp(time(a.finished_at)),
    reason: code(a.reason), actions: Array.isArray(a.actions) ? a.actions.filter((v) =>
      ['repair_check', 'repair_apply', 'enable', 'start'].includes(v)) : [] };
}

function faultCodes(r) {
  const codes = [];
  if (!r.bridge.available) codes.push('bridge_api_unreachable');
  else {
    if (r.bridge.logged_in !== true) codes.push('login_unverified');
    if (r.health.healthy !== true) codes.push(...(r.health.problems.length ? r.health.problems : ['health_unavailable']));
  }
  if (!r.tools.available) codes.push('tools_unavailable');
  return [...new Set(codes)].sort();
}

// Hook and scheduled patrol share this state under the wrapper's flock.
// "emitted" means handed to the caller, never verified platform delivery.
export function evaluatePatrol(runtime, system, prior = {}, { now = Date.now(), recovery = null, maintenance = false } = {}) {
  if (prior.schema !== undefined && prior.schema !== 1) throw new Error('unsupported_patrol_state');
  if (prior.incident && (!Array.isArray(prior.incident.codes) || prior.incident.codes.some((v) => !code(v)) ||
      !Number.isSafeInteger(prior.incident.consecutive) || prior.incident.consecutive < 1 ||
      time(prior.incident.first_at) === null || time(prior.incident.code_since) === null ||
      (prior.incident.emitted_at !== null && time(prior.incident.emitted_at) === null))) throw new Error('invalid_patrol_state');
  const at = stamp(now), codes = faultCodes(runtime), fault = codes.length > 0, previous = prior.observation;
  const changes = { boot_changed: changed(previous?.boot, system.boot),
    unit_changed: changed(previous?.unit_identity, system.unit_identity),
    unit_disappeared: previous?.unit_present === true && system.unit_present === false,
    bridge_restarted: changed(previous?.bridge_since, runtime.bridge.since) };
  const snapshot = { at, maintenance, bridge: runtime.bridge, health: runtime.health, tools: runtime.tools,
    system: { supported: system.supported, uptime_seconds: system.uptime_seconds,
      unit_present: system.unit_present, service: system.service, ...changes }, recovery };
  const state = { ...prior, schema: 1, checked_at: at, observation: {
    // Keep last known identities through an outage to compare on recovery.
    boot: system.boot ?? previous?.boot ?? null, unit_identity: system.unit_identity ?? previous?.unit_identity ?? null,
    unit_present: system.unit_present, bridge_since: runtime.bridge.since ?? previous?.bridge_since ?? null }, latest: snapshot };
  let kind = 'none', notify = false;
  if (fault) {
    let incident = prior.incident;
    if (!incident) incident = { id: randomUUID(), first_at: at, first_evidence: snapshot, emitted_at: null, emitted_key: null };
    const key = codes.join(','), same = incident.codes?.join(',') === key;
    incident = { ...incident, codes, last_at: at, last_evidence: snapshot, consecutive: same ? incident.consecutive + 1 : 1,
      code_since: same ? incident.code_since : at };
    incident.consecutive = Math.min(incident.consecutive, 1000000);
    // Only debounce transient polling; lost bridge/login/storage stay immediate.
    const soft = codes.every((c) => c === 'wechat_poll_unhealthy') && runtime.bridge.poll.error_present;
    const confirmed = !soft || (incident.consecutive >= 2 && now - time(incident.code_since) >= 10000);
    if (!maintenance && confirmed && (incident.emitted_key !== key || now - time(incident.emitted_at) >= 3600000)) {
      kind = incident.emitted_at ? 'fault_changed' : 'fault'; notify = true;
      incident.emitted_at = at; incident.emitted_key = key;
    }
    state.incident = incident;
  } else if (prior.incident) {
    state.last_incident = { ...prior.incident, recovered_at: at, recovery_evidence: snapshot };
    delete state.incident;
    if (!maintenance && prior.incident.emitted_at) { kind = 'recovered'; notify = true; }
  }
  const buildKey = runtime.bridge.available ? `${runtime.bridge.version}:${runtime.bridge.build}` : null;
  if (!maintenance && !fault && kind === 'none' && runtime.bridge.available && !runtime.bridge.build_matches && state.build_warning !== buildKey) {
    kind = 'build_unverified'; notify = true; state.build_warning = buildKey;
  }
  if (runtime.bridge.build_matches) state.build_warning = null;
  const work = (runtime.bridge.queue.ready ?? 0) > 0 || (runtime.tools.awaiting_review ?? 0) > 0;
  if (!work) state.work_emitted_at = null;
  else if (!maintenance && kind === 'none' && (!prior.work_emitted_at || now - time(prior.work_emitted_at) >= 60000)) {
    kind = 'work'; state.work_emitted_at = at;
  }
  const reasonCodes = codes.length ? codes : kind === 'build_unverified' ? ['build_unverified'] : [];
  const report = { mode: 'patrol', revision: RECOVERY_REVISION, at, decision: kind === 'none' ? 'silent' : 'wake',
    notification: { kind, notify_user: notify, delivery_verified: false,
      reason: kind === 'none' ? '' : `${kind}; code=${reasonCodes.join(',') || 'none'}; transport=${code(runtime.bridge.transport_code) || 'none'}; detected_at_utc=${at}` }, snapshot,
    worker: { alive: null, platform_query_required: true, replacement_authorized: false } };
  if (kind === 'recovered' && recovery?.reason === 'recovered' && recovery.actions.includes('start') &&
      time(recovery.finished_at) >= time(prior.incident.first_at) && time(recovery.finished_at) <= now) {
    report.notification.recovery_source = 'trusted_recovery_entry';
  }
  return { state, report };
}
