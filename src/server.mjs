import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, duration, fail } from './errors.mjs';
import { MuseAdapter } from './muse.mjs';
import { operational } from './config.mjs';
import { health } from './operations.mjs';

function authorized(actual, token) {
  const left = Buffer.from(actual ?? '');
  const right = Buffer.from(`Bearer ${token}`);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...([429, 503, 507].includes(status) ? { 'Retry-After': '5' } : {}) });
  response.end(JSON.stringify(value) + '\n');
}
async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) fail('content_type', 'Content-Type must be application/json.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 256 * 1024) { request.resume(); fail('body_too_large', 'Maximum request body is 256 KiB.', 413); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('invalid_json', 'Invalid JSON.'); }
}

export function createApi(bridge) {
  const muse = new MuseAdapter(bridge);
  let active = 0;
  const server = createServer(async (request, response) => {
    if (active >= operational(bridge.config).max_http_requests) { json(response, 503, { error: 'http_capacity' }); request.resume(); return; }
    active++;
    response.once('close', () => { active--; });
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    try {
      const url = new URL(request.url, 'http://localhost');
      const route = `${request.method} ${url.pathname}`;
      if (route === 'GET /healthz') return json(response, 200, { alive: true });
      if (!authorized(request.headers.authorization, bridge.config.api_token)) return json(response, 401, { error: 'unauthorized' });
      if (route === 'GET /v1/health') { const result = health(bridge); return json(response, result.healthy ? 200 : 503, result); }
      if (route === 'GET /v1/status') return json(response, 200, bridge.status());
      if (route === 'GET /v1/metrics') return json(response, 200, bridge.store.metrics());
      if (route === 'POST /v1/send') {
        const body = await readJson(request);
        if (body && typeof body === 'object' && !body.request_id) body.request_id = request.headers['idempotency-key'];
        return json(response, 200, await bridge.send(body));
      }
      if (route === 'POST /v1/muse/replies') return json(response, 200, await muse.reply(await readJson(request)));
      if (route === 'POST /v1/muse/renew') return json(response, 200, muse.renew(await readJson(request)));
      if (route === 'POST /v1/muse/checkpoints') return json(response, 200, muse.checkpoint(await readJson(request)));
      if (route === 'GET /v1/events' || route === 'GET /v1/muse/tasks') {
        const binding = url.searchParams.get('binding');
        if (binding && binding !== bridge.config.binding) fail('unknown_binding', 'Unknown binding.', 404);
        const options = {
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20,
          lease: duration(url.searchParams.get('lease') ?? undefined, 1800000),
          wait: duration(url.searchParams.get('wait') ?? undefined, 0),
        };
        if (route === 'GET /v1/muse/tasks') return json(response, 200, await muse.next(options, controller.signal));
        return json(response, 200, { events: await bridge.claim(options, controller.signal) });
      }
      if (route === 'POST /v1/events/ack') {
        const body = await readJson(request);
        if (!Array.isArray(body?.event_ids) || !body.event_ids.length || body.event_ids.length > 100 || body.event_ids.some((id) => typeof id !== 'string')) fail('invalid_ids', 'event_ids requires 1..100 strings.');
        if (bridge.config.require_lease_token !== false) for (const id of body.event_ids) {
          bridge.store.requireLease(id, body.lease_tokens?.[id] ?? body.lease_token);
          if (bridge.store.steps(id).some((step) => step.state === 'started')) fail('task_step_uncertain', 'Resolve unfinished tool steps before acknowledging.', 409);
        }
        return json(response, 200, { acked: bridge.store.ack(body.event_ids) });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/requests/')) {
        const row = bridge.store.send(decodeURIComponent(url.pathname.slice('/v1/requests/'.length)));
        if (!row) fail('not_found', 'Unknown request_id.', 404);
        // Never return tokens, recipient identifiers, or reply text in diagnostics.
        return json(response, 200, { request_id: row.id, state: row.state, result: row.result });
      }
      const review = /^\/v1\/requests\/([^/]+)\/review$/.exec(url.pathname);
      if (request.method === 'POST' && review) {
        const body = await readJson(request);
        if (body?.reviewed !== true || typeof body.note !== 'string' || !body.note.trim() || body.note.length > 1000) fail('review_required', 'Explicit reviewed=true and a note (up to 1000 characters) are required.');
        return json(response, 200, bridge.store.reviewSend(decodeURIComponent(review[1]), body.note));
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof BridgeError) return json(response, error.status, { ok: false, error: error.code, message: error.message, ...error.details });
      bridge.log('internal_error', { name: error.name });
      return json(response, 500, { ok: false, error: 'internal_error' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 65000;
  server.maxConnections = operational(bridge.config).max_http_requests * 2;
  return server;
}
