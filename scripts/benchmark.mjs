// A local simulation, not a benchmark of WeChat or Muse production latency.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Agent, request } from 'undici';
import { Store } from '../src/store.mjs';
import { Ilink } from '../src/ilink.mjs';
import { Bridge } from '../src/bridge.mjs';
import { createApi } from '../src/server.mjs';

process.umask(0o077);
const temp = mkdtempSync(join(tmpdir(), 'muse-link-bench-'));
const config = { binding: 'muse', state_dir: temp, allow_wxids: [], api_token: 'test-only-token-'.repeat(4), send_timeout_ms: 2000, poll_timeout_ms: 120000 };
const store = new Store(temp);
store.set('session', { bot_token: 'FAKE', base_url: 'https://ilinkai.weixin.qq.com', ilink_bot_id: 'test', ilink_user_id: 'owner' });
store.saveContext('owner', 'FAKE');
let held;
let signalPoll;
const polling = new Promise((resolve) => { signalPoll = resolve; });
const upstream = createServer((req, res) => {
  req.resume();
  if (req.url.endsWith('getupdates')) { held = res; signalPoll(); }
  else setTimeout(() => res.end('{"ret":0}'), 20);
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const ilink = new Ilink(config, {
  agents: { send: new Agent({ connections: 4 }), poll: new Agent({ connections: 1 }) },
  requestFn: (url, options) => request(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, options),
});
const bridge = new Bridge(config, store, ilink);
const api = createApi(bridge);
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const client = new Agent({ connections: 1 });
const pending = ilink.updates(store.get('session'), '');
await polling;
try {
  const times = [];
  for (let index = 0; index < 55; index++) {
    const began = performance.now();
    const response = await request(`http://127.0.0.1:${api.address().port}/v1/send`, {
      method: 'POST', dispatcher: client, headers: { Authorization: `Bearer ${config.api_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: `bench-${index}`, to: 'owner', text: '本地模拟回复' }),
    });
    const result = await response.body.json();
    if (response.statusCode !== 200 || !result.ok) throw new Error(JSON.stringify(result));
    if (index >= 5) times.push(performance.now() - began);
  }
  times.sort((a, b) => a - b);
  const report = {
    kind: 'local_simulation_not_real_wechat', node: process.version, platform: process.platform,
    samples: times.length, simulated_wechat_ms: 20, receive_poll_still_held: !held.writableEnded,
    http_roundtrip_ms: { p50: +times[Math.ceil(times.length * .5) - 1].toFixed(2), p95: +times[Math.ceil(times.length * .95) - 1].toFixed(2) },
    ...store.metrics(),
  };
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/benchmark-local.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  held.end('{"msgs":[]}');
  await pending;
  await client.close(); await ilink.close();
  api.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => upstream.close(r))]);
  store.close(); rmSync(temp, { recursive: true, force: true });
}
