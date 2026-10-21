#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { once } from 'node:events';
import { Agent, request } from 'undici';
import { VERSION, defaultConfigPath, expand, initConfig, loadConfig, localUrl } from './config.mjs';
import { Store } from './store.mjs';
import { Ilink } from './ilink.mjs';
import { Bridge } from './bridge.mjs';
import { createApi } from './server.mjs';
import { duration, fail, integer } from './errors.mjs';
import { login, submitVerifyCode, waitForVerifyCode } from './login.mjs';

process.umask(0o077);
const print = (value) => console.log(JSON.stringify(value));
const help = `muse-link ${VERSION} — Meta Muse / WeChat ClawBot bridge (Node.js 24+)
  init [--config PATH]
  login [--qr-dir PATH] [--timeout 10m]
  login verify --code-file PATH --text -
  run
  send --to WXID --text - --request-id UNIQUE_ID [--ready-at ISO_TIME]
  inbox count | inbox pull [--limit 20] [--lease 30m] [--wait 30s]
  inbox ack EVENT_ID...
  muse next [--limit 20] [--lease 30m] [--wait 30s]
  muse reply EVENT_ID --text - [--progress --reply-id STABLE_ID] [--ready-at ISO_TIME]
    [--image /absolute/image.png] [--video /absolute/video.mp4] (repeatable; text optional with media)
  muse ack EVENT_ID...
  status | metrics | request REQUEST_ID | health [--liveness]
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
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  const path = values.config ? expand(values.config) : defaultConfigPath();
  if (command === 'init') { print(initConfig(path)); return; }
  const config = loadConfig(path);
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
    if (action === 'next') {
      const lease = integer(duration(values.lease, 1800000), 1000, 3600000, 'lease');
      const limit = integer(Number(values.limit ?? 20), 1, 100, 'limit');
      const wait = integer(duration(values.wait, 0), 0, 60000, 'wait');
      const result = await local(config, `/v1/muse/tasks?${new URLSearchParams({ limit, lease: `${lease}ms`, wait: `${wait}ms` })}`, { timeout: wait + 5000 });
      if (result) print(result);
      return;
    }
    if (action === 'reply') {
      const text = values.text === '-' ? await stdin() : values.text;
      const result = await local(config, '/v1/muse/replies', { timeout: 10 * 60000, body: {
        event_id: positionals[2], text, mode: values.progress ? 'progress' : 'final',
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
      const result = await local(config, '/v1/events/ack', { body: { event_ids: ids } });
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
  if (['status', 'metrics', 'request', 'health'].includes(command)) {
    const route = command === 'request' ? `/v1/requests/${encodeURIComponent(positionals[1] ?? '')}` : command === 'metrics' ? '/v1/metrics' : '/v1/status';
    const result = await local(config, route, { timeout: values.liveness ? 1000 : 5000 });
    if (!result) return;
    if (command === 'health') {
      if (values.liveness) { console.log('alive'); return; }
      const healthy = result.logged_in && ['waiting', 'ok'].includes(result.poll.state) && !!result.poll.last_ok_at && !result.poll.error;
      print({ healthy, ...result });
      if (!healthy) process.exitCode = 1;
    } else print(result);
    return;
  }
  const store = new Store(config.state_dir);
  if (command === 'inbox') {
    try {
      const action = positionals[1];
      if (action === 'count') { console.log(store.count()); return; }
      if (action === 'ack') {
        const ids = positionals.slice(2);
        if (!ids.length) fail('missing_ids', 'Provide event IDs.');
        print({ acked: store.ack(ids) }); return;
      }
      if (action === 'pull') {
        const lease = integer(duration(values.lease, 1800000), 1000, 3600000, 'lease');
        const limit = integer(Number(values.limit ?? 20), 1, 100, 'limit');
        const wait = integer(duration(values.wait, 0), 0, 60000, 'wait');
        if (!wait) print({ events: store.claim(limit, lease) });
        else {
          const result = await local(config, `/v1/events?${new URLSearchParams({ limit, lease: `${lease}ms`, wait: `${wait}ms` })}`, { timeout: wait + 5000 });
          if (result) print(result);
        }
        return;
      }
      fail('unknown_command', 'Use inbox count, pull, or ack.');
    } finally { store.close(); }
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
      await ilink.close(); store.close();
    }
    return;
  }
  if (command !== 'run') { await ilink.close(); store.close(); fail('unknown_command', help); }
  const log = (event, fields) => print({ time: new Date().toISOString(), event, ...fields });
  const bridge = new Bridge(config, store, ilink, log);
  const server = createApi(bridge);
  try {
    server.listen(config.listen.port, config.listen.host);
    await once(server, 'listening');
    store.recoverUncertain();
  } catch (error) { await ilink.close(); store.close(); throw error; }
  bridge.pollTask = bridge.runPoll();
  log('listening', { address: localUrl(config), binding: config.binding });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 20000);
    timeout.unref();
    server.close();
    await bridge.close();
    server.closeAllConnections();
    store.close();
    clearTimeout(timeout);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.code ?? 'error', message: error.message }));
  process.exitCode = 1;
});
