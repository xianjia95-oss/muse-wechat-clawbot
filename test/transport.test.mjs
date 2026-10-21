import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent, request } from 'undici';
import { Ilink, parseWire, wechatBase } from '../src/ilink.mjs';
import { session, deferred } from './helpers.mjs';

test('real int64 IDs are lossless without rewriting text containing JSON-like strings', () => {
  const result = parseWire('{"message_id":7523456789012345678,"text":"a \\\"message_id\\\":123 marker"}');
  assert.equal(result.message_id, '7523456789012345678');
  assert.equal(result.text, 'a "message_id":123 marker');
});

test('QR and send use expected wire identities, reject errcode even with ret=0', async () => {
  const calls = [];
  const ilink = new Ilink({ send_timeout_ms: 1000, poll_timeout_ms: 1000 }, {
    requestFn: async (url, options) => {
      calls.push({ url, options });
      return { statusCode: 200, body: { text: async () => calls.length === 3 ? '{"ret":0,"errcode":1001}' : '{}' } };
    },
  });
  try {
    await ilink.qr();
    assert.equal(calls[0].options.headers.AuthorizationType, 'ilink_bot_token');
    assert.equal(calls[0].options.headers.Authorization, undefined);
    await ilink.sendText(session, 'owner', '你好', 'ctx', 'client-1');
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.msg.context_token, 'ctx');
    assert.equal(body.msg.item_list[0].text_item.text, '你好');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer TEST-SECRET');
    await assert.rejects(ilink.sendText(session, 'owner', 'x', 'ctx', 'client-2'), { code: 'upstream_rejected' });
    assert.notEqual(ilink.agents.send, ilink.agents.poll);
  } finally { await ilink.close(); }
});

test('a held real HTTP long-poll cannot occupy the text-send pool', async () => {
  const held = deferred();
  let pendingResponse;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url.endsWith('getupdates')) { pendingResponse = res; held.resolve(); return; }
    res.end('{"ret":0}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ilink = new Ilink({ send_timeout_ms: 1000, poll_timeout_ms: 5000 }, {
    agents: { send: new Agent({ connections: 1 }), poll: new Agent({ connections: 1 }) },
    requestFn: (url, options) => request(origin + new URL(url).pathname, options),
  });
  try {
    const poll = ilink.updates(session, 'cursor');
    await held.promise;
    await ilink.sendText(session, 'owner', 'fast', 'ctx', 'id');
    assert.equal(pendingResponse.writableEnded, false);
    pendingResponse.end('{"msgs":[]}');
    await poll;
  } finally {
    pendingResponse?.end('{}');
    await ilink.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('session expiration, malformed response and network uncertainty are distinct; no retry', async () => {
  let count = 0;
  let output = '{"ret":-14}';
  const ilink = new Ilink({ send_timeout_ms: 1000 }, {
    requestFn: async () => { count++; return { statusCode: 200, body: { text: async () => output } }; },
  });
  try {
    await assert.rejects(ilink.sendText(session, 'owner', 'x', 'ctx', '1'), { code: 'session_expired' });
    output = 'not JSON';
    await assert.rejects(ilink.sendText(session, 'owner', 'x', 'ctx', '2'), { code: 'upstream_unknown' });
    assert.equal(count, 2);
  } finally { await ilink.close(); }
});

test('credentials and QR redirects are restricted to HTTPS WeChat hosts', () => {
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.attacker.test', 'https://evil.test', 'https://user:pass@ilinkai.weixin.qq.com']) {
    assert.throws(() => wechatBase(url), { code: 'invalid_host' });
  }
  assert.equal(wechatBase('https://ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com');
});

test('QR verification sends digits only to the WeChat status endpoint without bot auth', async () => {
  const calls = [];
  const ilink = new Ilink({ send_timeout_ms: 1000 }, {
    requestFn: async (url, options) => {
      calls.push({ url, options });
      return { statusCode: 200, body: { text: async () => '{"status":"scaned"}' } };
    },
  });
  try {
    await ilink.qrStatus('qr+/?', session.base_url, undefined, '001234');
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('qrcode'), 'qr+/?');
    assert.equal(url.searchParams.get('verify_code'), '001234');
    assert.equal(url.pathname, '/ilink/bot/get_qrcode_status');
    assert.equal(calls[0].options.headers.Authorization, undefined);
    assert.equal(calls[0].options.headers.AuthorizationType, undefined);
    assert.equal(calls[0].options.headers['X-WECHAT-UIN'], undefined);
    assert.throws(() => ilink.qrStatus('qr', session.base_url, undefined, '123&evil=1'), { code: 'invalid_verify_code' });
    assert.equal(calls.length, 1);
  } finally { await ilink.close(); }
});

test('unsupported proxy settings fail explicitly without exposing proxy credentials', () => {
  assert.throws(() => new Ilink({}, { env: { ALL_PROXY: 'socks5://sensitive-user:sensitive-password@localhost:1080' } }), (error) => {
    assert.equal(error.code, 'invalid_proxy');
    assert.equal(error.message.includes('sensitive'), false);
    return true;
  });
});
