// Bridge recovery only. Native Muse task queries/creation belong to the platform.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, loadConfig, privateJson } from './config.mjs';
import { getRuntimeJson } from './runtime-check.mjs';

export function readPrivateJson(path, fallback) {
  if (!existsSync(path)) {
    // existsSync is false for dangling symlinks as well.
    try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
    throw new Error('unsafe_private_file');
  }
  const st = lstatSync(path);
  if (!st.isFile() || st.size > 65536 || (process.platform !== 'win32' &&
      (st.uid !== process.getuid() || (st.mode & 0o077) !== 0))) throw new Error('unsafe_private_file');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function command(program, args, timeout = 15000) {
  const r = spawnSync(program, args, { encoding: 'utf8', timeout, maxBuffer: 65536, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0 && !r.error, uncertain: !!r.error || !!r.signal, output: r.stdout ?? '' };
}

function serviceCommand(args) {
  return process.getuid() === 0 ? command('systemctl', args) : command('sudo', ['-n', 'systemctl', ...args]);
}

async function portState(config) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: config.listen.host, port: config.listen.port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => done('unknown'));
    socket.once('connect', () => done('listening'));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
  });
}

function bridgeProcesses() {
  try {
    for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      let argv;
      try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; return 'unknown'; }
      // Include unmanaged Muse Link installations; an uncertain consumer is kept.
      if (argv.includes('run') && argv.some((arg) => /(?:^|\/)src\/cli\.mjs$/.test(arg))) return 'present';
    }
    return 'absent';
  } catch { return 'unknown'; }
}

export function recoveryDependencies(home = homedir()) {
  const directory = join(home, '.local/state/muse-link-recovery');
  const policyPath = join(home, '.config/muse-link/recovery.json');
  const statePath = join(directory, 'state.json');
  const config = loadConfig(defaultConfigPath());
  const current = join(home, '.local/share/muse-link/current');
  return {
    now: Date.now, sleep: delay,
    policy: () => {
      const p = readPrivateJson(policyPath, { auto_start: false, maintenance: false });
      if (typeof p?.auto_start !== 'boolean' || typeof p.maintenance !== 'boolean') throw new Error('invalid_recovery_policy');
      return p;
    },
    state: () => {
      const s = readPrivateJson(statePath, { failures: 0, retry_at: 0, pending: false });
      if (!s || !Number.isSafeInteger(s.failures) || s.failures < 0 || !Number.isSafeInteger(s.retry_at) || s.retry_at < 0 || typeof s.pending !== 'boolean') throw new Error('invalid_recovery_state');
      return s;
    },
    save: (state) => {
      // Validate before replacing a private state file, never follow a symlink.
      readPrivateJson(statePath, null);
      privateJson(statePath, state);
    },
    probe: async () => {
      const [status, health, port] = await Promise.all([
        getRuntimeJson(config, '/v1/status'), getRuntimeJson(config, '/v1/health'), portState(config),
      ]);
      const r = command('systemctl', ['show', 'muse-link.service', '--property=LoadState,ActiveState,SubState,MainPID']);
      const fields = Object.fromEntries(r.output.trim().split('\n').filter((line) => line.includes('=')).map((line) => line.split('=')));
      const managerKnown = !r.uncertain && (r.ok || fields.LoadState === 'not-found') && ['loaded', 'not-found'].includes(fields.LoadState) &&
        ['inactive', 'failed', 'active', 'activating', 'deactivating', 'reloading'].includes(fields.ActiveState) && /^\d+$/.test(fields.MainPID ?? '');
      return {
        healthy: status.status === 200 && status.value?.version === '0.4.0-rc.5' && status.value?.logged_in === true && health.value?.healthy === true,
        occupied: port !== 'closed' || status.status !== undefined || health.status !== undefined ||
          !managerKnown || !['inactive', 'failed'].includes(fields.ActiveState) || fields.MainPID !== '0',
        processes: bridgeProcesses(),
      };
    },
    repair: (mode) => {
      // Refuse any version or installation other than the managed rc.5 release.
      const release = realpathSync(current);
      if (!lstatSync(current).isSymbolicLink() || !release.startsWith(join(home, '.local/share/muse-link/releases') + '/') ||
          JSON.parse(readFileSync(join(release, 'package.json'), 'utf8')).version !== '0.4.0-rc.5') throw new Error('invalid_installation');
      // A verified supplement can repair an older rc.5 without copying helpers
      // into its installed release or replacing a healthy running daemon.
      return command('bash', [fileURLToPath(new URL('../deploy/repair-service.sh', import.meta.url)), mode], 30000);
    },
    enable: () => serviceCommand(['enable', 'muse-link.service']),
    start: () => serviceCommand(['--no-block', 'start', 'muse-link.service']),
  };
}

// Called while deploy/recover-service.sh holds the OS lock. Dependency injection
// keeps isolated checks from ever invoking a real system manager or native task.
export async function recoverService(deps, { apply = false, waitMs = 45000 } = {}) {
  const actions = [];
  let attempt = null;
  let state = deps.state();
  const result = (exit_code, reason) => ({ ok: exit_code === 0, exit_code, reason, actions,
    at: new Date(deps.now()).toISOString(), worker_recovery: 'requires_platform_main_chat' });
  const save = (changes) => {
    state = { ...state, ...changes, checked_at: new Date(deps.now()).toISOString() };
    if (attempt) state.last_attempt = { ...attempt, actions: [...actions], reason: state.reason,
      finished_at: state.pending ? null : state.checked_at };
    if (apply) deps.save(state);
  };
  const fail = (code, reason, pending = false) => {
    const failures = Math.min(state.failures + 1, 20);
    save({ failures, retry_at: deps.now() + Math.min(180000 * 2 ** (failures - 1), 1800000), pending, reason });
    return result(code, reason);
  };
  const blocked = () => {
    const p = deps.policy(); // Always reread under the lock, including before start.
    return p.maintenance ? 'maintenance' : !p.auto_start ? 'automatic_start_not_authorized' : null;
  };
  let guard = blocked();
  if (guard === 'maintenance') return result(3, guard);
  let observed = await deps.probe();
  if (observed.healthy) { save({ failures: 0, retry_at: 0, pending: false, reason: 'healthy' }); return result(0, 'healthy'); }
  if (guard) return result(3, guard);
  if (observed.occupied || observed.processes !== 'absent') return result(3, 'existing_or_unverified_instance');
  if (state.pending) return result(3, 'previous_recovery_outcome_unknown');
  if (state.retry_at > deps.now()) return result(4, 'backoff');
  if (!apply) return result(10, 'recovery_required');
  guard = blocked();
  if (guard) return result(3, guard);
  attempt = { id: randomUUID(), started_at: new Date(deps.now()).toISOString() };
  save({ pending: true, reason: 'repairing' });
  let r = deps.repair('--check'); actions.push('repair_check');
  if (!r.ok) return fail(5, 'repair_check_failed', r.uncertain);
  // The policy may change while an earlier command is in progress.
  guard = blocked();
  if (guard) { save({ pending: false, reason: guard }); return result(3, guard); }
  r = deps.repair('--apply'); actions.push('repair_apply');
  if (!r.ok) return fail(5, 'repair_failed', r.uncertain);
  observed = await deps.probe();
  if (observed.healthy) { save({ failures: 0, retry_at: 0, pending: false, reason: 'healthy' }); return result(0, 'healthy'); }
  guard = blocked();
  if (guard || observed.occupied || observed.processes !== 'absent') {
    const reason = guard ?? 'existing_or_unverified_instance';
    save({ pending: false, reason }); return result(3, reason);
  }
  r = deps.enable(); actions.push('enable');
  if (!r.ok) return fail(6, 'enable_failed', r.uncertain);
  observed = await deps.probe();
  guard = blocked();
  if (observed.healthy) { save({ failures: 0, retry_at: 0, pending: false, reason: 'healthy' }); return result(0, 'healthy'); }
  if (guard || observed.occupied || observed.processes !== 'absent') {
    const reason = guard ?? 'existing_or_unverified_instance';
    save({ pending: false, reason }); return result(3, reason);
  }
  // Persist intent before the only start call. A crash leaves pending=true.
  save({ pending: true, reason: 'starting' });
  r = deps.start(); actions.push('start');
  if (!r.ok) return fail(6, 'start_failed', r.uncertain);
  const deadline = deps.now() + waitMs;
  do {
    observed = await deps.probe();
    if (observed.healthy) { save({ failures: 0, retry_at: 0, pending: false, reason: 'recovered' }); return result(0, 'recovered'); }
    if (deps.now() >= deadline) break;
    await deps.sleep(Math.min(2000, deadline - deps.now()));
  } while (deps.now() <= deadline);
  return fail(6, 'startup_unverified', true);
}
