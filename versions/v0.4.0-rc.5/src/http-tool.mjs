// A bounded, non-retrying GET/HEAD transport for authorized local tool jobs.
// URLs and headers go over curl's stdin, never process arguments or public logs.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { privateJson } from './config.mjs';
import { readPrivateJson } from './service-recovery.mjs';

const quoted = (value) => {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid_http_request');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};

export async function runHttpTool(requestFile, outputDirectory) {
  if (!isAbsolute(requestFile) || !isAbsolute(outputDirectory)) throw new Error('absolute_paths_required');
  const spec = readPrivateJson(requestFile, null);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.url !== 'string' || /[\x00-\x1f\x7f]/.test(spec.url)) throw new Error('invalid_http_request');
  const url = new URL(spec.url);
  if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('invalid_http_url');
  const method = spec.method ?? 'GET';
  const connect = spec.connect_timeout_seconds ?? 10, total = spec.timeout_seconds ?? 60;
  const maxBytes = spec.max_bytes ?? 1048576;
  if (!['GET', 'HEAD'].includes(method) || !Number.isInteger(connect) || connect < 1 || connect > 60 ||
      !Number.isInteger(total) || total < connect || total > 1200 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 67108864) throw new Error('invalid_http_budget');
  const headers = spec.headers ?? {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 32) throw new Error('invalid_http_headers');
  const lines = [`url = ${quoted(url.href)}`];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string') throw new Error('invalid_http_header');
    lines.push(`header = ${quoted(`${name}: ${value}`)}`);
  }
  // An exclusive new result directory prevents overwriting an earlier outcome.
  mkdirSync(outputDirectory, { mode: 0o700 });
  const body = join(outputDirectory, 'body.bin');
  const bodyFd = openSync(body, 'wx', 0o600);
  let stderr;
  try { stderr = openSync(join(outputDirectory, 'stderr.log'), 'wx', 0o600); }
  catch (error) { closeSync(bodyFd); throw error; }
  const args = ['--disable', '--config', '-', '--silent', '--show-error', '--proto', '=https,http',
    '--connect-timeout', String(connect), '--max-time', String(total), '--retry', '0',
    '--max-filesize', String(maxBytes), '--output', '-', '--write-out', '%{stderr}\nMUSE_HTTP_STATUS:%{http_code}\n'];
  if (method === 'HEAD') args.push('--head');
  const started = Date.now();
  let outcome;
  try { outcome = await new Promise((resolve) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let tail = '', expired = false, limited = false, bodyBytes = 0, logBytes = 0, spawnFailure = 0, ioFailure = 0;
    const write = (fd, data) => {
      try { let offset = 0; while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset); }
      catch { ioFailure = 23; child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, total * 1000 + 2000);
    // Older curl only checks Content-Length for --max-filesize. Enforce the
    // byte limit ourselves as well, including chunked/unbounded responses.
    child.stdout.on('data', (chunk) => {
      const allowed = chunk.subarray(0, Math.max(0, maxBytes - bodyBytes));
      if (allowed.length && !ioFailure) write(bodyFd, allowed);
      bodyBytes += allowed.length;
      if (allowed.length < chunk.length) { limited = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (chunk) => {
      tail = (tail + chunk.toString()).slice(-128);
      const allowed = chunk.subarray(0, Math.max(0, 65536 - logBytes));
      if (allowed.length && !ioFailure) write(stderr, allowed);
      logBytes += allowed.length;
    });
    child.stdin.on('error', () => {}); // curl can fail before consuming its config.
    child.once('error', (error) => { spawnFailure = error.code === 'ENOENT' ? 127 : 1; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: spawnFailure || ioFailure || (limited ? 63 : expired ? 28 : code ?? 1),
        curlExit: Number.isInteger(code) && code >= 0 ? code : null, signal: signal ?? null, tail });
    });
    child.stdin.end(lines.join('\n') + '\n');
  }); } finally { closeSync(bodyFd); closeSync(stderr); }
  const http = Number(outcome.tail.match(/\r?\nMUSE_HTTP_STATUS:(\d{3})\r?\n$/)?.[1] ?? 0);
  const ok = outcome.code === 0 && http >= 200 && http < 300;
  const exit_code = ok ? 0 : outcome.code || 22;
  const report = { ok, exit_code, curl_exit: outcome.curlExit, signal: outcome.signal, http_status: http,
    reason: ok ? 'http_success' : outcome.code === 63 ? 'http_response_limit' : outcome.code === 28 ? 'http_timeout' : outcome.code ? 'http_transport_failed' : 'http_status_failed',
    elapsed_ms: Date.now() - started, outcome_uncertain: !ok && (http === 0 || outcome.code !== 0) };
  privateJson(join(outputDirectory, 'result.json'), report);
  return report;
}
