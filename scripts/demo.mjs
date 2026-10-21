// A complete local protocol simulation. No real Muse model or WeChat account.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { Agent, request } from 'undici';
import { Store } from '../src/store.mjs';
import { Ilink } from '../src/ilink.mjs';
import { Bridge } from '../src/bridge.mjs';
import { createApi } from '../src/server.mjs';

process.umask(0o077);
const { values } = parseArgs({ options: { report: { type: 'string' } } });
const directory = mkdtempSync(join(tmpdir(), 'muse-clawbot-demo-'));
const store = new Store(directory);
const config = { binding: 'muse', allow_wxids: [], api_token: 'local-simulation-only-'.repeat(3), send_timeout_ms: 2000, poll_timeout_ms: 45000 };
store.set('session', { bot_token: 'SIMULATION-ONLY', base_url: 'https://ilinkai.weixin.qq.com', ilink_bot_id: 'demo-bot', ilink_user_id: 'demo-owner' });
let inboxDelivered = false;
const outbound = [];
const heldResponses = new Set();
const wechat = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (req.url === '/ilink/bot/getupdates' && !inboxDelivered) {
    inboxDelivered = true;
    res.end('{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":7523456789012345678,"from_user_id":"demo-owner","context_token":"demo-context","item_list":[{"type":1,"text_item":{"text":"请回复：连接成功"}}]}]}');
  } else if (req.url === '/ilink/bot/getupdates') {
    heldResponses.add(res);
    res.on('close', () => heldResponses.delete(res));
  } else if (req.url === '/ilink/bot/sendmessage') {
    outbound.push(body.msg);
    res.end('{"ret":0}');
  } else { res.writeHead(404).end('{}'); }
});
wechat.listen(0, '127.0.0.1');
await once(wechat, 'listening');
const ilink = new Ilink(config, {
  agents: { send: new Agent({ connections: 4 }), poll: new Agent({ connections: 1 }) },
  // Every WeChat URL is rewritten to this local test server, including failures.
  requestFn: (url, options) => request(`http://127.0.0.1:${wechat.address().port}${new URL(url).pathname}`, options),
});
const bridge = new Bridge(config, store, ilink);
const api = createApi(bridge);
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const client = new Agent({ connections: 1 });
const origin = `http://127.0.0.1:${api.address().port}`;
async function call(path, body) {
  const response = await request(origin + path, {
    dispatcher: client, method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.api_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.body.json();
  if (response.statusCode !== 200) throw new Error(JSON.stringify(result));
  return result;
}
bridge.pollTask = bridge.runPoll();
try {
  const { tasks } = await call('/v1/muse/tasks?wait=2s&lease=30m');
  if (tasks.length !== 1) throw new Error('Expected one local simulated WeChat task');
  const task = tasks[0];
  const body = { event_id: task.event_id, text: '连接成功（模拟 Muse 回复）' };
  const reply = await call('/v1/muse/replies', body);
  const retry = await call('/v1/muse/replies', body);
  const completed = store.event(task.event_id).acked_ms !== null;
  if (!completed || outbound.length !== 1 || !retry.cached) throw new Error('Reply completion/idempotency check failed');
  const report = {
    mode: 'local_protocol_simulation', real_muse_model: false, real_wechat_account: false,
    inbound_text: task.text, event_id: task.event_id,
    outbound_text: outbound[0].item_list[0].text_item.text,
    recipient_matched: outbound[0].to_user_id === 'demo-owner',
    wechat_api_accepted: reply.state === 'accepted', event_completed: completed,
    retry_cached: retry.cached, outgoing_message_count: outbound.length,
    timing: reply.timing,
  };
  if (values.report) {
    const path = resolve(values.report);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  bridge.controller.abort();
  for (const res of heldResponses) res.end('{"msgs":[]}');
  await bridge.close();
  await client.close();
  api.closeAllConnections(); wechat.closeAllConnections();
  await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => wechat.close(resolve))]);
  store.close(); rmSync(directory, { recursive: true, force: true });
}
