// Use deploy/patrol.sh so hook and scheduled patrol hold the same OS lock.
import { parseArgs } from 'node:util';
import { fstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, defaultConfigPath, expand, privateJson } from '../src/config.mjs';
import { inspectRuntime } from '../src/runtime-check.mjs';
import { readPrivateJson } from '../src/service-recovery.mjs';
import { systemEvidence, recoveryEvidence, evaluatePatrol } from '../src/patrol.mjs';

process.umask(0o077);
try {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, config: { type: 'string' },
    'job-dir': { type: 'string' }, format: { type: 'string', default: 'json' } } });
  if (!['json', 'hook'].includes(values.format)) throw new Error('invalid_format');
  const directory = resolve(process.env.MUSE_LINK_PATROL_STATE_DIR || join(homedir(), '.local/state/muse-link-patrol'));
  const lock = statSync(join(directory, 'patrol.lock')), fd = fstatSync(9);
  if (!fd.isFile() || fd.dev !== lock.dev || fd.ino !== lock.ino) throw new Error('missing_wrapper_lock');
  const [runtime, system] = await Promise.all([
    inspectRuntime(loadConfig(values.config ? expand(values.config) : defaultConfigPath()),
      values['job-dir'] ? expand(values['job-dir']) : join(homedir(), '.local/state/muse-link-worker/jobs')),
    systemEvidence(),
  ]);
  const statePath = join(directory, 'state.json'), prior = readPrivateJson(statePath, {});
  const policy = readPrivateJson(join(homedir(), '.config/muse-link/recovery.json'), { maintenance: false });
  if (typeof policy?.maintenance !== 'boolean') throw new Error('invalid_maintenance_policy');
  let recovery = null, recovery_error = null;
  try { recovery = recoveryEvidence(join(homedir(), '.local/state/muse-link-recovery'), readPrivateJson); }
  catch { recovery_error = 'recovery_evidence_unavailable'; }
  const { state, report } = evaluatePatrol(runtime, system, prior, { recovery, maintenance: policy.maintenance });
  if (recovery_error) report.snapshot.recovery_error = recovery_error;
  if (values.check) {
    report.mode = 'read_only_patrol_check'; report.decision = 'silent';
    report.notification = { kind: 'none', notify_user: false, reason: '', delivery_verified: false };
  } else privateJson(statePath, state);
  if (values.format === 'hook') console.log(report.decision === 'wake' ? `wake: ${report.notification.reason}` : 'silent');
  else console.log(JSON.stringify(report));
  // Faults are data in record mode; --check has conventional health exits.
  if (values.check && (!runtime.bridge.available || runtime.bridge.logged_in !== true || runtime.health.healthy !== true || !runtime.tools.available)) process.exitCode = 2;
} catch {
  console.error(JSON.stringify({ mode: 'patrol', error: 'patrol_check_failed', exit_code: 2 }));
  process.exitCode = 2;
}
