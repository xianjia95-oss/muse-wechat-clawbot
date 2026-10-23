import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateJson } from '../src/config.mjs';
import { detectHook, formatHook, probeResult } from '../src/hook-detector.mjs';

process.umask(0o077);
const exec = promisify(execFile);
const cache = join(homedir(), '.cache/muse-link/hook-alert-state.json');
const format = process.env.MUSE_LINK_HOOK_FORMAT ?? 'plain';
const options = { timeout: 1500, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 512 * 1024 };
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const probe = async () => {
  const args = [...(process.env.MUSE_LINK_CONFIG ? ['--config', process.env.MUSE_LINK_CONFIG] : []), 'health'];
  let output, status;
  try {
    const reply = await exec(process.env.MUSE_LINK ?? process.execPath, process.env.MUSE_LINK ? args : [cli, ...args], options);
    output = reply.stdout; status = 200;
  } catch (error) {
    if (error.killed || error.signal) return { healthy: false, problems: ['hook_probe_timeout'], ready: 0 };
    output = error.stdout; status = error.code === 1 ? 503 : 0;
  }
  try { return probeResult(JSON.parse(output), status); }
  catch { return { healthy: false, problems: ['bridge_probe_unavailable'], ready: 0 }; }
};
const pending = async () => {
  const root = process.env.MUSE_LINK_JOB_DIR ?? join(homedir(), '.local/state/muse-link-worker/jobs');
  if (!existsSync(root)) return 0;
  const script = process.env.MUSE_LINK_JOB_HELPER ?? fileURLToPath(new URL('./tool-job.mjs', import.meta.url));
  const { stdout } = await exec(process.execPath, [script, 'pending', '--dir', root], { ...options, timeout: 1000 });
  if (!/^\d+\s*$/.test(stdout)) throw new Error();
  return Number(stdout);
};
try {
  // Validate output mode before probing. Never print arbitrary CLI output,
  // readiness response bodies, credentials or exception messages in a hook.
  formatHook({ decision: 'silent', reason: '' }, format);
  const result = await detectHook({ probe, pending,
    readAlert: () => lstatSync(cache).isSymbolicLink() ? null : JSON.parse(readFileSync(cache, 'utf8')),
    writeAlert: (value) => privateJson(cache, value),
    clearAlert: () => { try { unlinkSync(cache); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
  });
  console.log(formatHook(result, format));
} catch {
  console.log(formatHook({ decision: 'wake', reason: `Muse 微信桥检测器：hook_detector_failed；检测于 ${new Date().toISOString()}；收到唤醒后先复查当前状态；检查安装和输出格式` }, format === 'hatch' ? 'hatch' : 'plain'));
  process.exitCode = 1;
}
