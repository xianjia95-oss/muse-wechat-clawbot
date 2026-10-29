import { EnvHttpProxyAgent, request } from 'undici';
import { randomBytes } from 'node:crypto';
import { BridgeError, fail } from './errors.mjs';
import { encryptedStream, mediaItem } from './media.mjs';

const BASE_INFO = { channel_version: '2.4.10', bot_agent: 'OpenClaw' };
export const AUTH_BASE = 'https://ilinkai.weixin.qq.com';
const ID_FIELDS = new Set(['message_id', 'seq', 'msg_id']);
const MAX_JSON_BYTES = 4 * 1024 * 1024;
async function boundedJsonText(body) {
  // Real Undici responses stream; the fallback supports injected test doubles.
  if (!body[Symbol.asyncIterator]) {
    const text = await body.text();
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) fail('upstream_response_too_large', 'WeChat JSON response exceeds the local 4 MiB budget.', 502);
    return text;
  }
  let size = 0; const chunks = [];
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) fail('upstream_response_too_large', 'WeChat JSON response exceeds the local 4 MiB budget.', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseWire(text) {
  return JSON.parse(text, (key, value, context) => ID_FIELDS.has(key) && typeof value === 'number' ? context.source : value);
}

export function wechatBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) || url.search || url.hash) {
    fail('invalid_host', 'Expected an HTTPS WeChat iLink host.');
  }
  return url.href.replace(/\/+$/, '');
}

export function wechatCdnUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_cdn_host', 'Invalid WeChat media upload host.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) {
    fail('invalid_cdn_host', 'Expected an HTTPS WeChat CDN host.');
  }
  return url.href;
}

function headers(token, identityOnly = false) {
  const result = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132106' };
  if (!identityOnly) result['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
  if (token) Object.assign(result, { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${token}` });
  return result;
}

export class Ilink {
  constructor(config, { requestFn = request, agents, env = process.env } = {}) {
    if (config.transport === 'isolated_simulation_v1') fail('simulation_scope', 'Simulation cannot initialize the WeChat network transport.');
    this.config = config;
    this.requestFn = requestFn;
    // Dedicated connection pools: a held getupdates request cannot occupy send sockets.
    if (agents) this.agents = agents;
    else {
      const all = env.all_proxy ?? env.ALL_PROXY;
      const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? all;
      const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? httpProxy;
      for (const proxy of [httpProxy, httpsProxy].filter(Boolean)) {
        let protocol;
        try { protocol = new URL(proxy).protocol; } catch { /* no credential output */ }
        if (!['http:', 'https:'].includes(protocol)) fail('invalid_proxy', '请使用 HTTP/HTTPS 代理设置 http_proxy 或 https_proxy；当前不支持 SOCKS。');
      }
      const options = { httpProxy, httpsProxy, noProxy: env.no_proxy ?? env.NO_PROXY };
      this.agents = {
        send: new EnvHttpProxyAgent({ ...options, connections: 4, pipelining: 1, connectTimeout: 5000 }),
        poll: new EnvHttpProxyAgent({ ...options, connections: 1, pipelining: 1, connectTimeout: 5000 }),
        media: new EnvHttpProxyAgent({ ...options, connections: 2, pipelining: 1, connectTimeout: 5000 }),
        download: new EnvHttpProxyAgent({ ...options, connections: 2, pipelining: 1, connectTimeout: 5000 }),
      };
    }
  }
  async close() { await Promise.all(Object.values(this.agents).map((agent) => agent.close())); }

  async json(url, { lane = 'send', token, body, identityOnly = false, authorizationType = false, signal, timeout } = {}) {
    const timeoutMs = timeout ?? this.config.send_timeout_ms;
    let response;
    try {
      response = await this.requestFn(url, {
        method: body === undefined ? 'GET' : 'POST',
        dispatcher: this.agents[lane],
        headers: { ...headers(token, identityOnly), ...(authorizationType ? { AuthorizationType: 'ilink_bot_token' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        maxRedirections: 0,
      });
      const text = await boundedJsonText(response.body);
      if (response.statusCode !== 200) throw new BridgeError('upstream_http', `WeChat HTTP ${response.statusCode}`, 502);
      // An empty HTTP 200 is not a JSON receipt. Preserve uncertainty rather
      // than acknowledging a task whose delivery cannot be established.
      const parsed = parseWire(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid iLink response');
      if ([parsed.ret, parsed.errcode].some((code) => Number(code) === -14)) throw new BridgeError('session_expired', '微信登录已过期，请重新扫码。', 401);
      if (Number(parsed.ret ?? 0) !== 0 || Number(parsed.errcode ?? 0) !== 0) {
        throw new BridgeError('upstream_rejected', `WeChat rejected request (ret=${parsed.ret ?? 0}, errcode=${parsed.errcode ?? 0})`, 502);
      }
      return parsed;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      // No automatic retries: after a network failure the server may have accepted it.
      throw new BridgeError('upstream_unknown', '微信接口连接中断或响应无法确认，请按 request_id 查询状态，勿重复发送。', 502);
    }
  }
  updates(session, cursor, signal) {
    return this.json(`${wechatBase(session.base_url)}/ilink/bot/getupdates`, {
      lane: 'poll', token: session.bot_token, signal, timeout: this.config.poll_timeout_ms,
      body: { get_updates_buf: cursor, base_info: BASE_INFO },
    });
  }
  sendText(session, to, text, context, clientId) {
    return this.sendItem(session, to, { type: 1, text_item: { text } }, context, clientId);
  }
  sendMedia(session, to, item, context, clientId) {
    return this.sendItem(session, to, item, context, clientId);
  }
  sendItem(session, to, item, context, clientId) {
    return this.json(`${wechatBase(session.base_url)}/ilink/bot/sendmessage`, {
      token: session.bot_token,
      body: {
        msg: {
          from_user_id: session.ilink_bot_id, to_user_id: to, client_id: clientId,
          message_type: 2, message_state: 2, context_token: context,
          item_list: [item],
        },
        base_info: BASE_INFO,
      },
    });
  }
  async uploadMedia(session, to, record) {
    const result = await this.json(`${wechatBase(session.base_url)}/ilink/bot/getuploadurl`, {
      token: session.bot_token,
      body: { filekey: record.filekey, media_type: record.type === 'image' ? 1 : record.type === 'voice' ? 4 : 2, to_user_id: to,
        rawsize: record.raw_size, rawfilemd5: record.raw_md5, filesize: record.cipher_size,
        no_need_thumb: true, aeskey: record.key_hex, base_info: BASE_INFO },
    });
    let target;
    if (typeof result.upload_full_url === 'string' && result.upload_full_url.trim()) target = wechatCdnUrl(result.upload_full_url.trim());
    else if (typeof result.upload_param === 'string' && result.upload_param) {
      target = wechatCdnUrl(`https://novac2c.cdn.weixin.qq.com/c2c/upload?${new URLSearchParams({ encrypted_query_param: result.upload_param, filekey: record.filekey })}`);
    } else fail('media_upload_failed', 'WeChat did not provide media upload parameters.', 502);
    const timeout = this.config.media_timeout_ms ?? 120000;
    const deadline = Date.now() + timeout;
    // Upload retries reuse one encrypted snapshot and filekey. They do not send
    // a chat message; sendmessage itself is never automatically retried.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const source = encryptedStream(record);
      try {
        const response = await this.requestFn(target, {
          method: 'POST', dispatcher: this.agents.media ?? this.agents.send,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(record.cipher_size) },
          body: source, maxRedirections: 0, headersTimeout: remaining, bodyTimeout: remaining, signal: AbortSignal.timeout(remaining),
        });
        await response.body.dump();
        if (response.statusCode >= 400 && response.statusCode < 500) fail('media_upload_rejected', `WeChat CDN HTTP ${response.statusCode}.`, 502);
        const param = response.headers['x-encrypted-param'];
        if (response.statusCode === 200 && typeof param === 'string' && param.trim() && param.length <= 16384) return mediaItem(record, param);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        // Network and 5xx failures are safe to retry before any chat send.
      } finally { source.destroy(); }
    }
    fail('media_upload_failed', 'WeChat media upload was not confirmed within the timeout/up to three attempts; no media chat message was sent.', 502);
  }
  qr(signal) {
    return this.json(`${AUTH_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, { body: { local_token_list: [] }, authorizationType: true, signal });
  }
  qrStatus(id, host = AUTH_BASE, signal, verifyCode) {
    const params = new URLSearchParams({ qrcode: id });
    if (verifyCode !== undefined) {
      if (typeof verifyCode !== 'string' || !/^[0-9]{1,32}$/.test(verifyCode)) fail('invalid_verify_code', '微信配对验证码应为 1..32 位数字。');
      params.set('verify_code', verifyCode);
    }
    return this.json(`${wechatBase(host)}/ilink/bot/get_qrcode_status?${params}`, {
      lane: 'poll', identityOnly: true, timeout: 40000, signal,
    });
  }
  async downloadMedia(reference, signal) {
    const value = reference.full_url || `https://novac2c.cdn.weixin.qq.com/c2c/download?${new URLSearchParams({ encrypted_query_param: reference.encrypt_query_param })}`;
    const target = wechatCdnUrl(value);
    if (!(new URL(target).hostname.endsWith('.cdn.weixin.qq.com'))) fail('invalid_cdn_host', 'Expected a WeChat media CDN host.');
    const timeout = this.config.inbound_media_timeout_ms ?? 30000;
    const response = await this.requestFn(target, { method: 'GET', dispatcher: this.agents.download ?? this.agents.media ?? this.agents.send,
      headers: {}, maxRedirections: 0, headersTimeout: timeout, bodyTimeout: timeout,
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]) });
    if (response.statusCode !== 200) { response.body.destroy?.(); fail('inbound_download_rejected', 'WeChat CDN did not return a media file.', 502); }
    return response;
  }
}
