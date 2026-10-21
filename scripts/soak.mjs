// Real local HTTP + SQLite stress. All Tencent URLs are redirected to localhost.
// This is not a live Muse/WeChat acceptance test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { Agent, request } from 'undici';
import { duration, integer } from '../src/errors.mjs';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { Ilink } from '../src/ilink.mjs';
import { createApi } from '../src/server.mjs';
import { lockState } from '../src/state-lock.mjs';
import { maintain } from '../src/maintenance.mjs';

process.umask(0o077);
const { values } = parseArgs({ options: { duration: { type: 'string' }, report: { type: 'string' } } });
const runtime = integer(duration(values.duration, 60000), 1000, 7 * 86400000, 'duration');
const root = mkdtempSync(join(tmpdir(), 'muse-link-soak-'));
const config = { binding: 'muse', state_dir: root, require_lease_token: true, allow_wxids: [], api_token: 'simulation-only-'.repeat(4), send_timeout_ms: 2000, poll_timeout_ms: 45000 };
let upstreamCount = 0, duplicateUpstream = 0;
const recent = new Set();
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (req.url.endsWith('getupdates')) {
    const timer = setTimeout(() => res.end('{"ret":0,"msgs":[]}'), 100);
    res.once('close', () => clearTimeout(timer));
  } else if (req.url.endsWith('sendmessage')) {
    const id = body.msg.client_id;
    if (recent.has(id)) duplicateUpstream++;
    recent.add(id); upstreamCount++;
    if (recent.size > 10000) recent.delete(recent.values().next().value);
    setTimeout(() => res.end('{"ret":0}'), 5);
  } else res.writeHead(404).end('{}');
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const client = new Agent({ connections: 8 });
let store, bridge, api, unlock, origin;
const start = async () => {
  unlock = lockState(root); store = new Store(root);
  store.set('session', { bot_token: 'SIMULATION', base_url: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'owner' });
  store.saveContext('owner', 'SIMULATION'); store.recoverUncertain();
  const ilink = new Ilink(config, { requestFn: (url, options) => request(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, options) });
  bridge = new Bridge(config, store, ilink); api = createApi(bridge);
  api.listen(0, '127.0.0.1'); await once(api, 'listening'); origin = `http://127.0.0.1:${api.address().port}`;
  bridge.pollTask = bridge.runPoll();
};
const stop = async () => {
  if (bridge) await bridge.close();
  if (api) { api.closeAllConnections(); await new Promise((done) => api.close(done)); }
  store?.close(); store = null; unlock?.(); unlock = null;
};
async function call(path, body) {
  const response = await request(origin + path, { dispatcher: client, method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.api_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.body.json(); assert.equal(response.statusCode, 200, JSON.stringify(value)); return value;
}
const began = performance.now();
let tasks = 0, restarts = 0, cached = 0, maxRss = 0, peakState = 0, maxPending = 0;
const latencies = [];
try {
  await start();
  while (performance.now() - began < runtime) {
    const batch = Array.from({ length: 4 }, (_, index) => ({ message_id: `soak-${tasks + index}`, from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: 'simulated task' } }] }));
    bridge.ingest({ msgs: batch }); bridge.ingest({ msgs: batch }); // replay the incoming batch
    maxPending = Math.max(maxPending, store.queueStats().pending);
    const claimed = (await call('/v1/muse/tasks?limit=4')).tasks; assert.equal(claimed.length, 4);
    await Promise.all(claimed.map(async (task) => {
      const identity = { event_id: task.event_id, lease_token: task.lease_token };
      await call('/v1/muse/checkpoints', { ...identity, step: 'tool', phase: 'started' });
      await call('/v1/muse/renew', { ...identity, lease_ms: 60000 });
      await call('/v1/muse/checkpoints', { ...identity, step: 'tool', phase: 'completed', result: 'simulated result' });
      const body = { ...identity, text: `result ${task.event_id}` };
      const result = await call('/v1/muse/replies', body); latencies.push(result.timing.bridge_ms);
      if (latencies.length > 10000) latencies.shift();
      assert.equal((await call('/v1/muse/replies', body)).cached, true); cached++;
    }));
    tasks += claimed.length;
    assert.equal(store.queueStats().pending, 0); assert.equal(bridge.resources.reserved, 0);
    const storage = bridge.resources.inspect(); peakState = Math.max(peakState, storage.state_bytes); maxRss = Math.max(maxRss, process.memoryUsage().rss);
    if (tasks % 200 === 0) {
      await maintain(bridge); await stop(); await start(); restarts++;
    }
    await pause(10);
  }
  assert.equal(upstreamCount, tasks); assert.equal(duplicateUpstream, 0);
  latencies.sort((a, b) => a - b);
  const report = { mode: 'local_http_sqlite_simulation', real_muse: false, real_wechat: false, platform: process.platform, node: process.version, elapsed_ms: Math.round(performance.now() - began), tasks, cached_retries: cached, restarts, upstream_messages: upstreamCount, duplicate_upstream_messages: duplicateUpstream, peak_pending: maxPending, peak_state_bytes: peakState, peak_process_rss_bytes: maxRss, latency_window: latencies.length, simulated_send_latency_ms: 5, bridge_ms: { p50: latencies[Math.ceil(latencies.length * .5) - 1], p95: latencies[Math.ceil(latencies.length * .95) - 1] } };
  if (values.report) { const path = resolve(values.report); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stop(); await client.close(); upstream.closeAllConnections(); await new Promise((done) => upstream.close(done)); rmSync(root, { recursive: true, force: true });
}
