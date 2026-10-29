import { Agent, request } from 'undici';
import { setTimeout as pause } from 'node:timers/promises';
import { readPrivateDocument } from './task-file.mjs';
import { SIMULATION_MODE } from './simulation.mjs';
import { fail, integer } from './errors.mjs';

// A client may use an explicitly provisioned HTTPS private gateway later.
// Plain HTTP is restricted to numeric loopback. No redirects or proxy env use.
export class TestClient {
  constructor(connectionFile) {
    const connection = readPrivateDocument(connectionFile);
    let url;
    try { url = new URL(connection.origin); } catch { fail('test_connection', 'Invalid test endpoint.'); }
    if (connection.mode !== SIMULATION_MODE || !/^[a-f0-9]{64}$/.test(connection.token ?? '')
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))))
      fail('test_connection', 'Use a private simulation connection with HTTPS or numeric loopback.');
    this.origin = url.origin; this.token = connection.token;
    this.agent = new Agent({ connections: 2 });
  }
  async call(path, body) {
    try { return await this.callOnce(path, body); }
    catch (error) {
      // A service restart can close a pooled socket. Only a read-only GET may
      // be retried, once; never replay a POST after an ambiguous disconnect.
      if (body !== undefined || !['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(error.code)) throw error;
      await pause(100);
      return this.callOnce(path, body);
    }
  }
  async callOnce(path, body) {
    const response = await request(this.origin + path, {
      method: body === undefined ? 'GET' : 'POST', dispatcher: this.agent, maxRedirections: 0,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
      headersTimeout: 10000, bodyTimeout: 10000,
    });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 256 * 1024) { response.body.destroy(); fail('test_response_too_large', 'Test response exceeds 256 KiB.'); }
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('test_response', 'Invalid test server response.'); }
    if (response.statusCode >= 300) fail(/^[a-z_]{1,80}$/.test(result.error ?? '') ? result.error : 'test_http_error', 'Test API request rejected.', response.statusCode);
    if (result.mode !== SIMULATION_MODE || result.wechat_connected !== false) fail('test_response', 'Endpoint is not an isolated simulation.');
    return result;
  }
  status() { return this.call('/v1/test/status'); }
  async send(id, text) {
    // Read-only preflight happens before injection; an uncertain POST is never
    // retried automatically. GET the same id to establish its actual state.
    await this.status();
    return this.call('/v1/test/messages', { id, text });
  }
  get(id, offset = 0) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail('invalid_test_id', 'Invalid test message id.');
    integer(offset, 0, 100000, 'offset');
    return this.call(`/v1/test/messages/${id}?offset=${offset}`);
  }
  async wait(id, timeoutMs = 180000) {
    integer(timeoutMs, 1, 3600000, 'timeout_ms');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.get(id);
      if (result.done || ['failed', 'unknown', 'rejected', 'acked_without_final'].includes(result.state)) return result;
      if (Date.now() >= deadline) return { ...result, wait_timed_out: true };
      await pause(Math.min(500, deadline - Date.now()));
    }
  }
  async close() { await this.agent.close(); }
}
