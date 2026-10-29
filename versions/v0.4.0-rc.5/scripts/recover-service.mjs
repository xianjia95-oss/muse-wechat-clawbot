// Internal entry; the bash wrapper owns the lock for this process's lifetime.
import { fstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recoverService, recoveryDependencies } from '../src/service-recovery.mjs';

process.umask(0o077);
try {
  const mode = process.argv.slice(2);
  if (process.platform !== 'linux' || mode.length !== 1 || !['--check', '--apply'].includes(mode[0])) throw new Error('invalid_invocation');
  const lock = statSync(join(homedir(), '.local/state/muse-link-recovery/recovery.lock'));
  const fd = fstatSync(9);
  if (!fd.isFile() || fd.dev !== lock.dev || fd.ino !== lock.ino) throw new Error('missing_wrapper_lock');
  const report = await recoverService(recoveryDependencies(), { apply: mode[0] === '--apply' });
  console.log(JSON.stringify(report));
  process.exitCode = report.exit_code;
} catch {
  console.error(JSON.stringify({ ok: false, reason: 'recovery_check_failed', exit_code: 1 }));
  process.exitCode = 1;
}
