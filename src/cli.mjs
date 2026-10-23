#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { once } from 'node:events';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Agent, request } from 'undici';
import { VERSION, defaultConfigPath, expand, initConfig, loadConfig, localUrl, operational } from './config.mjs';
import { Store } from './store.mjs';
import { Ilink } from './ilink.mjs';
import { Bridge } from './bridge.mjs';
import { createApi } from './server.mjs';
import { duration, fail, integer } from './errors.mjs';
import { login, submitVerifyCode, waitForVerifyCode } from './login.mjs';
import { lockState } from './state-lock.mjs';
import { maintain } from './maintenance.mjs';
import { backupState, restoreState, verifyBackup } from './backup.mjs';
import { reserveTaskFile, reserveTaskDirectory, readTaskLease } from './task-file.mjs';

process.umask(0o077);
const print = (value) => console.log(JSON.stringify(value));
const help = `muse-link ${VERSION} — Meta Muse / WeChat ClawBot bridge (Node.js 24+)
  init [--config PATH]
  login [--qr-dir PATH] [--timeout 10m]
  login verify --code-file PATH --text -
  run
  send --to WXID --text - --request-id UNIQUE_ID [--ready-at ISO_TIME]
  inbox count | inbox pull [--limit 1] [--lease 30m] [--wait 30s] [--offline]
  inbox ack EVENT_ID... --lease-token TOKEN [--offline]
  muse next [--limit 1] [--lease 30m] [--wait 30s] [--output /private/new-task.json | --output-dir /private/claims]
  muse reply EVENT_ID --lease-token TOKEN --text - [--progress --reply-id STABLE_ID] [--ready-at ISO_TIME] [--async]
    [--image /absolute/image.png] [--video /absolute/video.mp4] (repeatable; text optional with media)
  muse ack EVENT_ID... --lease-token TOKEN
  muse renew EVENT_ID --lease-token TOKEN [--lease 30m]
  muse checkpoint EVENT_ID --lease-token TOKEN --step NAME --phase started|completed [--text -] [--reviewed]
    reply/renew/checkpoint: --task-file /private/task.json may replace --lease-token TOKEN
  review REQUEST_ID --reviewed --text -
  maintain                         (service must be stopped)
  backup --output /private/backup   (service must be stopped)
  backup verify --from /private/backup
  restore --from /private/backup    (service must be stopped; pauses work for review)
  restore approve --reviewed --text -
  status | metrics | request REQUEST_ID | health [--liveness] | diagnose
Every command accepts --config PATH. No send health probe or direct-send fallback.
`;

async function local(config, path, { body, timeout = 30000 } = {}) {
  // Loopback calls must never traverse an HTTP proxy.
  const agent = new Agent({ connections: 1 });
  try {
    const response = await request(localUrl(config) + path, {
      method: body === undefined ? 'GET' : 'POST', dispatcher: agent,
      headers: { Authorization: `Bearer ${config.api_token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: timeout, bodyTimeout: timeout, signal: AbortSignal.timeout(timeout),
    });
    const result = await response.body.json();
    if (response.statusCode >= 300) {
      print(result);
      process.exitCode = 1;
      return null;
    }
    return result;
  } finally { await agent.close(); }
}

async function stdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const data of process.stdin) {
    text += data;
    if (Buffer.byteLength(text) > 256 * 1024) fail('text_too_long', 'stdin exceeds 256 KiB.');
  }
  return text.replace(/[\r\n]+$/, '');
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' },
    'request-id': { type: 'string' }, 'ready-at': { type: 'string' },
    from: { type: 'string' }, 'qr-dir': { type: 'string' }, timeout: { type: 'string' }, 'code-file': { type: 'string' },
    limit: { type: 'string' }, lease: { type: 'string' }, wait: { type: 'string' },
    binding: { type: 'string' }, liveness: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    progress: { type: 'boolean' }, 'reply-id': { type: 'string' },
    image: { type: 'string', multiple: true }, video: { type: 'string', multiple: true },
    'lease-token': { type: 'string' }, 'task-file': { type: 'string' }, step: { type: 'string' }, phase: { type: 'string' },
    reviewed: { type: 'boolean' }, output: { type: 'string' }, 'output-dir': { type: 'string' },
    offline: { type: 'boolean' },
    async: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (values.async && !(command === 'muse' && positionals[1] === 'reply')) fail('invalid_argument', '--async is only supported for muse reply.');
  if (values['task-file'] !== undefined && !(command === 'muse' && ['reply', 'renew', 'checkpoint'].includes(positionals[1]))) fail('invalid_argument', '--task-file is only supported for muse reply/renew/checkpoint.');
  if (values['task-file'] !== undefined && values['lease-token'] !== undefined) fail('invalid_argument', 'Choose --task-file or --lease-token, not both.');
  if (values.output && command !== 'backup' && !(command === 'muse' && positionals[1] === 'next')) fail('invalid_argument', '--output is only supported for backup and muse next.');
  if (values['output-dir'] && !(command === 'muse' && positionals[1] === 'next')) fail('invalid_argument', '--output-dir is only supported for muse next.');
  if (values['output-dir'] && values.output) fail('invalid_argument', 'Choose --output or --output-dir, not both.');
  if (values.offline && !(command === 'inbox' && ['pull', 'ack'].includes(positionals[1]))) fail('invalid_argument', '--offline is only supported for inbox pull/ack.');
  if (values.offline && duration(values.wait, 0) !== 0) fail('invalid_argument', 'Offline claims cannot wait for a running daemon.');
  const path = values.config ? expand(values.config) : defaultConfigPath();
  if (command === 'init') { print(initConfig(path)); return; }
  const config = loadConfig(path);
  if (command === 'backup') {
    if (positionals[1] === 'verify') {
      if (!values.from) fail('missing_from', '--from is required.');
      const manifest = await verifyBackup(expand(values.from));
      print({ ok: true, version: manifest.version, created_at: manifest.created_at, files: Object.keys(manifest.files).length });
    } else {
      if (!values.output) fail('missing_output', '--output is required.');
      print(await backupState(config, expand(values.output)));
    }
    return;
  }
  if (command === 'restore') {
    if (positionals[1] === 'approve') {
      const note = values.text === '-' ? await stdin() : '';
      if (!values.reviewed || !note.trim() || note.length > 1000) fail('review_required', 'Use --reviewed --text - after reconciling messages and external tool outcomes.');
      const release = lockState(config.state_dir);
      let state;
      try { state = new Store(config.state_dir); state.set('restore_review_required', false); state.set('restore_review', { at: new Date().toISOString(), note }); print({ approved: true, service_restart_required: true }); }
      finally { state?.close(); release(); }
    } else {
      if (!values.from) fail('missing_from', '--from is required.');
      print(await restoreState(config, expand(values.from)));
    }
    return;
  }
  if (command === 'review') {
    const note = values.text === '-' ? await stdin() : '';
    const result = await local(config, `/v1/requests/${encodeURIComponent(positionals[1] ?? '')}/review`, { body: { reviewed: values.reviewed === true, note } });
    if (result) print(result);
    return;
  }
  const media = [...(values.image ?? []).map((path) => ({ type: 'image', path: expand(path) })),
    ...(values.video ?? []).map((path) => ({ type: 'video', path: expand(path) }))];
  if (values.binding && values.binding !== config.binding) fail('unknown_binding', 'Unknown binding.');
  if (command === 'login' && positionals[1] === 'verify') {
    if (!values['code-file'] || values.text !== '-') fail('missing_verification_input', 'Use login verify --code-file PATH --text - and provide the code on stdin.');
    print(submitVerifyCode(expand(values['code-file']), await stdin()));
    return;
  }
  if (command === 'muse') {
    const action = positionals[1];
    const leaseToken = values['task-file'] !== undefined ? readTaskLease(expand(values['task-file']), positionals[2], localUrl(config), config.path) : values['lease-token'];
    if (['renew', 'checkpoint'].includes(action)) {
      const body = { event_id: positionals[2], lease_token: leaseToken };
      if (action === 'renew') body.lease_ms = integer(duration(values.lease, 1800000), 1000, 3600000, 'lease');
      else Object.assign(body, { step: values.step, phase: values.phase, result: values.text === '-' ? await stdin() : values.text ?? null, reviewed: values.reviewed === true });
      const result = await local(config, `/v1/muse/${action === 'renew' ? 'renew' : 'checkpoints'}`, { body });
      if (result) print(result);
      return;
    }
    if (action === 'next') {
      const lease = integer(duration(values.lease, 1800000), 1000, 3600000, 'lease');
      const limit = integer(Number(values.limit ?? 1), 1, 100, 'limit');
      const wait = integer(duration(values.wait, 0), 0, 60000, 'wait');
      const output = values.output ? expand(values.output) : null;
      const managed = values['output-dir'] ? reserveTaskDirectory(expand(values['output-dir']), localUrl(config), config.path) : null;
      const handoff = managed ?? (output ? reserveTaskFile(output, localUrl(config), config.path) : null);
      let saved = false;
      try {
        const result = await local(config, `/v1/muse/tasks?${new URLSearchParams({ limit, lease: `${lease}ms`, wait: `${wait}ms` })}`, { timeout: wait + 5000 });
        if (result) {
          try { handoff?.save(result); saved = true; }
          catch {
            // Preserve the received claim in stdout if durable storage fails;
            // the original worker must retain it and report the failure.
            print({ ...result, handoff_saved: false });
            fail('task_handoff_write_failed', 'Claim received but could not be saved; retain stdout privately before continuing.', 500);
          }
          const discarded = managed?.discardEmpty() ?? false;
          print({ ...result, ...(managed ? { handoff_file: discarded ? null : managed.path } : output ? { handoff_file: output } : {}) });
        }
      } finally {
        if (managed && !saved) console.error(JSON.stringify({ error: 'claim_handoff_retained', handoff_file: managed.path }));
        handoff?.close();
      }
      return;
    }
    if (action === 'reply') {
      const text = values.text === '-' ? await stdin() : values.text;
      const result = await local(config, '/v1/muse/replies', { timeout: 10 * 60000, body: {
        event_id: positionals[2], text, mode: values.progress ? 'progress' : 'final',
        lease_token: leaseToken,
        ...(values.async ? { async: true } : {}),
        ...(media.length ? { media } : {}),
        ...(values['reply-id'] !== undefined ? { reply_id: values['reply-id'] } : {}),
        ...(values['ready-at'] ? { model_ready_at: Date.parse(values['ready-at']) } : {}),
      } });
      if (result) print(result);
      return;
    }
    if (action === 'ack') {
      const ids = positionals.slice(2);
      if (!ids.length) fail('missing_ids', 'Provide event IDs.');
      const result = await local(config, '/v1/events/ack', { body: { event_ids: ids, lease_token: values['lease-token'] } });
      if (result) print(result);
      return;
    }
    fail('unknown_command', 'Use muse next, reply, or ack.');
  }
  if (command === 'send') {
    const text = values.text === '-' ? await stdin() : values.text;
    const result = await local(config, '/v1/send', {
      body: { to: values.to, text, request_id: values['request-id'],
        ...(media.length ? { media } : {}),
        ...(values['ready-at'] ? { model_ready_at: Date.parse(values['ready-at']) } : {}) },
      timeout: 10 * 60000,
    });
    if (result) print(result);
    return;
  }
  if (['status', 'metrics', 'request', 'health', 'diagnose'].includes(command)) {
    const route = command === 'diagnose' ? '/v1/diagnostics' : command === 'request' ? `/v1/requests/${encodeURIComponent(positionals[1] ?? '')}` : command === 'metrics' ? '/v1/metrics' : command === 'health' && !values.liveness ? '/v1/health' : '/v1/status';
    const result = await local(config, route, { timeout: values.liveness ? 1000 : 5000 });
    if (!result) return;
    if (command === 'health') {
      if (values.liveness) { console.log('alive'); return; }
      const healthy = result.healthy;
      print({ healthy, ...result });
      if (!healthy) process.exitCode = 1;
    } else print(result);
    return;
  }
  if (command === 'inbox' && positionals[1] === 'count') {
    const file = join(config.state_dir, 'bridge.sqlite');
    if (!existsSync(file)) { console.log(0); return; }
    if (lstatSync(file).isSymbolicLink()) fail('unsafe_state', 'Database must not be a symbolic link.');
    const db = new DatabaseSync(file, { readOnly: true });
    try { console.log(db.prepare('SELECT count(*) AS n FROM events WHERE acked_ms IS NULL AND lease_until<=?').get(Date.now()).n); }
    finally { db.close(); }
    return;
  }
  if (command === 'inbox' && positionals[1] === 'ack' && !values.offline) {
    const ids = positionals.slice(2);
    if (!ids.length) fail('missing_ids', 'Provide event IDs.');
    const result = await local(config, '/v1/events/ack', { body: { event_ids: ids, lease_token: values['lease-token'] } });
    if (result) print(result);
    return;
  }
  if (command === 'inbox' && positionals[1] === 'pull' && !values.offline) {
    const lease = integer(duration(values.lease, 1800000), 1000, 3600000, 'lease');
    const limit = integer(Number(values.limit ?? 1), 1, 100, 'limit');
    const wait = integer(duration(values.wait, 0), 0, 60000, 'wait');
    const result = await local(config, `/v1/events?${new URLSearchParams({ limit, lease: `${lease}ms`, wait: `${wait}ms` })}`, { timeout: wait + 5000 });
    if (result) print(result);
    return;
  }
  const unlock = lockState(config.state_dir);
  let store;
  try { store = new Store(config.state_dir); } catch (error) { unlock(); throw error; }
  if (command === 'maintain') {
    try { print(await maintain(new Bridge(config, store, {}))); } finally { store.close(); unlock(); }
    return;
  }
  if (command === 'inbox') {
    try {
      const action = positionals[1];
      if (action === 'ack') {
        const ids = positionals.slice(2);
        if (!ids.length) fail('missing_ids', 'Provide event IDs.');
        for (const id of ids) {
          if (config.require_lease_token !== false) store.requireLease(id, values['lease-token']);
          store.requireAckable(id);
        }
        print({ acked: store.ack(ids) }); return;
      }
      if (action === 'pull') {
        if (store.get('restore_review_required', false)) fail('restore_review_required', 'Reconcile restored state before claiming work.', 409);
        const lease = integer(duration(values.lease, 1800000), 1000, 3600000, 'lease');
        const limit = integer(Number(values.limit ?? 1), 1, 100, 'limit');
        print({ events: store.claim(limit, lease) });
        return;
      }
      fail('unknown_command', 'Use inbox count, pull, or ack.');
    } finally { store.close(); unlock(); }
  }
  const ilink = new Ilink(config);
  if (command === 'login') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      print(await login(store, ilink, {
        directory: expand(values['qr-dir'] ?? join(homedir(), 'workspace')),
        timeout: integer(duration(values.timeout, 600000), 1000, 1800000, 'timeout'), onQr: print,
        onVerifyCode: (options) => waitForVerifyCode({ ...options, onRequired: print }),
        signal: controller.signal,
      }));
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
      await ilink.close(); store.close(); unlock();
    }
    return;
  }
  if (command !== 'run') { await ilink.close(); store.close(); unlock(); fail('unknown_command', help); }
  const log = (event, fields) => print({ time: new Date().toISOString(), event, ...fields });
  const bridge = new Bridge(config, store, ilink, log);
  const server = createApi(bridge);
  try {
    server.listen(config.listen.port, config.listen.host);
    await once(server, 'listening');
    store.recoverUncertain();
  } catch (error) { await ilink.close(); store.close(); unlock(); throw error; }
  const maintenance = () => {
    if (bridge.stopping || bridge.maintaining) return;
    bridge.maintenanceTask = maintain(bridge).then((result) => log('maintenance', result)).catch((error) => log('maintenance_failed', { code: error.code ?? 'maintenance_error' }));
  };
  maintenance();
  await bridge.maintenanceTask;
  const maintenanceTimer = setInterval(maintenance, operational(config).maintenance_interval_ms);
  maintenanceTimer.unref();
  bridge.pollTask = bridge.runPoll();
  log('listening', { address: localUrl(config), binding: config.binding });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    bridge.stopping = true;
    clearInterval(maintenanceTimer);
    const timeout = setTimeout(() => { log('shutdown_deadline', { inflight: bridge.inflight.size }); process.exit(1); }, operational(config).shutdown_timeout_ms);
    timeout.unref();
    server.close();
    await bridge.maintenanceTask;
    await bridge.close();
    server.closeAllConnections();
    store.close();
    unlock();
    clearTimeout(timeout);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.code ?? 'error', message: error.message }));
  process.exitCode = 1;
});
