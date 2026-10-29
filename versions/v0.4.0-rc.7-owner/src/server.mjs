import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, duration, fail } from './errors.mjs';
import { MuseAdapter, museRequestId } from './muse.mjs';
import { operational } from './config.mjs';
import { health } from './operations.mjs';
import { deliveryDiagnostics } from './diagnostics.mjs';

const workerActions = new Map([
  ['GET /v1/events', 'claim'], ['GET /v1/muse/tasks', 'claim'],
  ['POST /v1/muse/replies', 'reply'], ['POST /v1/muse/renew', 'renew'],
  ['POST /v1/muse/checkpoints', 'checkpoint'], ['POST /v1/events/ack', 'ack'],
  ['POST /v1/muse/history', 'history'],
  ['POST /v1/muse/media', 'media'],
  ['POST /v1/send', 'send'],
]);

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
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    request.resume(); fail('content_type', 'Content-Type must be application/json.', 415);
  }
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
function requestId(encoded) {
  let id;
  try { id = decodeURIComponent(encoded); } catch { fail('invalid_request_id', 'Malformed request_id encoding.'); }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) fail('invalid_request_id', 'Invalid request_id.');
  return id;
}

function taskErrorScope(action, body) {
  const id = body?.event_id ?? (action === 'ack' && Array.isArray(body?.event_ids) && body.event_ids.length === 1 ? body.event_ids[0] : undefined);
  if (typeof id !== 'string' || !id || id.length > 512) return {};
  const scope = { task_request_id: museRequestId(id) };
  if (action === 'reply') {
    if ((body.mode ?? 'final') === 'final') scope.request_id = scope.task_request_id;
    else if (body.mode === 'progress' && typeof body.reply_id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(body.reply_id)) scope.request_id = museRequestId(id, 'progress', body.reply_id);
  }
  return scope;
}

export function createApi(bridge, { testClient } = {}) {
  const muse = new MuseAdapter(bridge);
  let active = 0;
  const server = createServer(async (request, response) => {
    if (active >= operational(bridge.config).max_http_requests) { json(response, 503, { error: 'http_capacity' }); request.resume(); return; }
    active++;
    response.once('close', () => { active--; });
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    let action, scope = {};
    const errorAtStart = bridge.worker.last_api_error;
    const readWorkerBody = async () => {
      const body = await readJson(request);
      scope = taskErrorScope(action, body);
      bridge.conversation.require(request.headers['x-muse-conversation']);
      return body && typeof body === 'object' && !Array.isArray(body) ? { ...body, session_token: request.headers['x-muse-conversation'] } : body;
    };
    response.once('finish', () => {
      const error = bridge.worker.last_api_error;
      // A different event, progress reply or older in-flight success must not
      // erase a newer rejection. Durable logs retain each rejection separately.
      if (action && response.statusCode < 300 && error && error === errorAtStart && error.action === action && error.task_request_id === scope.task_request_id && error.request_id === scope.request_id) bridge.worker.last_api_error = null;
    });
    try {
      const url = new URL(request.url, 'http://localhost');
      const route = `${request.method} ${url.pathname}`;
      if (route === 'GET /healthz') return json(response, 200, { alive: true });
      // This namespace is absent on the production server. Its separate token
      // never grants leases, owner sessions, admin routes or production history.
      if (url.pathname.startsWith('/v1/test/')) {
        if (!testClient) return json(response, 404, { error: 'not_found' });
        if (!authorized(request.headers.authorization, testClient.token)) { request.resume(); return json(response, 401, { error: 'unauthorized' }); }
        if (route === 'GET /v1/test/status') return json(response, 200, testClient.status());
        if (route === 'POST /v1/test/messages') {
          const result = testClient.inject(await readJson(request));
          return json(response, result.created ? 201 : 200, result);
        }
        const testMessage = /^\/v1\/test\/messages\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
        if (request.method === 'GET' && testMessage) return json(response, 200, testClient.message(testMessage[1], {
          ...(url.searchParams.has('offset') ? { offset: Number(url.searchParams.get('offset')) } : {}),
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
        }));
        return json(response, 404, { error: 'not_found' });
      }
      if (!authorized(request.headers.authorization, bridge.config.api_token)) return json(response, 401, { error: 'unauthorized' });
      action = workerActions.get(route);
      const sessionToken = request.headers['x-muse-conversation'];
      if (action) bridge.conversation.require(sessionToken);
      if (route === 'POST /v1/muse/conversation/start') { await readJson(request); return json(response, 200, bridge.conversation.start()); }
      if (route === 'POST /v1/muse/conversation/probe') { await readJson(request); return json(response, 200, bridge.conversation.probe(sessionToken)); }
      if (route === 'POST /v1/muse/conversation/renew') { await readJson(request); return json(response, 200, bridge.conversation.renew(sessionToken)); }
      if (route === 'POST /v1/muse/conversation/stop') { await readJson(request); return json(response, 200, bridge.conversation.stop(sessionToken)); }
      const conversationActions = { 'POST /v1/muse/conversation/context': 'context', 'POST /v1/muse/conversation/memory': 'remember', 'POST /v1/muse/conversation/task': 'task' };
      if (conversationActions[route]) return json(response, 200, bridge.conversation[conversationActions[route]](await readWorkerBody()));
      if (route === 'GET /v1/health') { const result = health(bridge); return json(response, result.healthy ? 200 : 503, result); }
      if (route === 'GET /v1/status') return json(response, 200, bridge.status());
      if (route === 'GET /v1/metrics') return json(response, 200, bridge.store.metrics());
      if (route === 'GET /v1/diagnostics') {
        const readiness = health(bridge);
        return json(response, 200, deliveryDiagnostics({ status: readiness, readiness, metrics: bridge.store.metrics() }));
      }
      if (route === 'POST /v1/send') {
        const body = await readJson(request);
        bridge.conversation.require(sessionToken);
        if (bridge.conversation.enabled) fail('conversation_routed_reply_required', 'Use the conversation owner and muse reply for user-visible answers.', 409);
        if (body && typeof body === 'object' && !body.request_id) body.request_id = request.headers['idempotency-key'];
        return json(response, 200, await bridge.send(body));
      }
      if (route === 'POST /v1/muse/replies') {
        const result = await muse.reply(await readWorkerBody());
        return json(response, result.submitted ? 202 : 200, result);
      }
      if (route === 'POST /v1/muse/renew') return json(response, 200, muse.renew(await readWorkerBody()));
      if (route === 'POST /v1/muse/history') return json(response, 200, muse.history(await readWorkerBody()));
      if (route === 'POST /v1/muse/media') return json(response, 200, await bridge.inbound.inspect(await readWorkerBody()));
      if (route === 'POST /v1/muse/checkpoints') return json(response, 200, muse.checkpoint(await readWorkerBody()));
      if (route === 'GET /v1/events' || route === 'GET /v1/muse/tasks') {
        const withContext = url.searchParams.get('with_context');
        if (withContext !== null && (route !== 'GET /v1/muse/tasks' || !['true', 'false'].includes(withContext))) fail('invalid_argument', 'with_context accepts true/false only on Muse task claims.');
        const contextMode = url.searchParams.get('context_mode');
        if (contextMode !== null && route !== 'GET /v1/muse/tasks') fail('invalid_context_mode', 'context_mode is only supported on Muse task claims.');
        const binding = url.searchParams.get('binding');
        if (binding && binding !== bridge.config.binding) fail('unknown_binding', 'Unknown binding.', 404);
        const options = {
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : route === 'GET /v1/muse/tasks' ? 1 : 20,
          lease: duration(url.searchParams.get('lease') ?? undefined, 1800000),
          wait: duration(url.searchParams.get('wait') ?? undefined, 0),
          session_token: sessionToken,
          ...(withContext !== null ? { with_context: withContext === 'true' } : {}),
          ...(contextMode !== null ? { context_mode: contextMode } : {}),
        };
        if (route === 'GET /v1/muse/tasks') return json(response, 200, await muse.next(options, controller.signal));
        return json(response, 200, { events: await bridge.claim(options, controller.signal) });
      }
      if (route === 'POST /v1/events/ack') {
        const body = await readWorkerBody();
        if (!Array.isArray(body?.event_ids) || !body.event_ids.length || body.event_ids.length > 100 || body.event_ids.some((id) => typeof id !== 'string')) fail('invalid_ids', 'event_ids requires 1..100 strings.');
        for (const id of body.event_ids) {
          if (bridge.config.require_lease_token !== false || bridge.conversation.enabled) bridge.store.requireLease(id, body.lease_tokens?.[id] ?? body.lease_token);
          bridge.conversation.requireFinal(id);
          bridge.store.requireAckable(id);
        }
        const acked = bridge.store.ack(body.event_ids);
        for (const id of body.event_ids) bridge.log('task_acknowledged', { request_id: museRequestId(id), source: 'explicit_ack' });
        return json(response, 200, { acked });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/requests/')) {
        const row = bridge.store.send(requestId(url.pathname.slice('/v1/requests/'.length)));
        if (!row) fail('not_found', 'Unknown request_id.', 404);
        // Never return tokens, recipient identifiers, or reply text in diagnostics.
        return json(response, 200, { request_id: row.id, state: row.state, result: row.result });
      }
      const review = /^\/v1\/requests\/([^/]+)\/review$/.exec(url.pathname);
      if (request.method === 'POST' && review) {
        const body = await readJson(request);
        if (body?.reviewed !== true || typeof body.note !== 'string' || !body.note.trim() || body.note.length > 1000) fail('review_required', 'Explicit reviewed=true and a note (up to 1000 characters) are required.');
        return json(response, 200, bridge.store.reviewSend(requestId(review[1]), body.note));
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (action) {
        bridge.worker.last_api_error = { at: new Date().toISOString(), action, ...scope, code: error instanceof BridgeError ? error.code : 'internal_error', status: error instanceof BridgeError ? error.status : 500 };
        if (error.code === 'stale_lease') Object.assign(bridge.worker.last_api_error, { lease_reason: error.details?.lease_reason, lease_until: error.details?.lease_until, acked_ms: error.details?.acked_ms, server_time: error.details?.server_time });
        bridge.log('worker_api_rejected', { ...bridge.worker.last_api_error });
      }
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
