import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from '../src/server.mjs';
import { fixture, deferred } from './helpers.mjs';
import { museRequestId } from '../src/muse.mjs';

// Independent HTTP clients simulate native tasks. This does not launch Muse.
async function setup(t) {
  const state = fixture(t); state.config.require_lease_token = true;
  const server = createApi(state.bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await state.bridge.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${state.config.api_token}`, 'Content-Type': 'application/json' };
  const api = async (path, body) => {
    const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() };
  };
  const add = (id) => state.bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: id } }] }] });
  const claim = async () => { const result = await api('/v1/muse/tasks?limit=1&lease=30m'); assert.equal(result.status, 200); return result.tasks[0]; };
  const reply = (task, text = 'result ' + task.event_id) => api('/v1/muse/replies', { event_id: task.event_id, lease_token: task.lease_token, text });
  return { ...state, api, add, claim, reply };
}

test('ten independent clients claim unique events and return in completion order without waiting for the first', { timeout: 15000 }, async (t) => {
  const { store, calls, api, add, claim, reply } = await setup(t);
  for (let i = 0; i < 10; i++) add(`native-${i}`);
  const tasks = await Promise.all(Array.from({ length: 10 }, claim));
  assert.equal(new Set(tasks.map((task) => task.event_id)).size, 10);
  assert.equal(new Set(tasks.map((task) => task.lease_token)).size, 10);
  assert.equal(store.queueStats().leased, 10);
  const gates = tasks.map(() => deferred()), started = [];
  t.after(() => gates.forEach((gate) => gate.resolve()));
  const running = tasks.map(async (task, index) => { started.push(task.event_id); await gates[index].promise; return reply(task); });
  assert.equal(started.length, 10); // No four-model admission limit in the bridge.
  const renewal = await api('/v1/muse/renew', { event_id: tasks[0].event_id, lease_token: tasks[0].lease_token, lease_ms: 1800000 });
  assert.equal(renewal.status, 200);
  for (let i = 9; i >= 1; i--) {
    gates[i].resolve(); const result = await running[i];
    assert.equal(result.state, 'accepted'); assert.equal(result.request_id, museRequestId(tasks[i].event_id));
    assert.equal(store.event(tasks[0].event_id).acked_ms, null);
  }
  assert.deepEqual(calls.map((call) => call[2]), tasks.slice(1).reverse().map((task) => 'result ' + task.event_id));
  add('native-new-while-first-running'); const fresh = await claim();
  assert.equal((await reply(fresh)).state, 'accepted');
  assert.equal(store.event(tasks[0].event_id).acked_ms, null);
  gates[0].resolve(); assert.equal((await running[0]).state, 'accepted');
  assert.equal(store.queueStats().pending, 0); assert.equal(calls.length, 11);
  assert.equal((await reply(tasks[0])).cached, true); assert.equal(calls.length, 11);
});

test('parallel task tokens cannot reply, renew, checkpoint or ack another event', async (t) => {
  const { store, calls, add, claim, api, reply } = await setup(t);
  add('owner-a'); add('owner-b'); const [a, b] = await Promise.all([claim(), claim()]);
  const wrong = { event_id: b.event_id, lease_token: a.lease_token };
  for (const [path, body] of [
    ['/v1/muse/replies', { ...wrong, text: 'wrong result' }],
    ['/v1/muse/renew', { ...wrong, lease_ms: 1800000 }],
    ['/v1/muse/checkpoints', { ...wrong, step: 'tool', phase: 'started' }],
    ['/v1/events/ack', { event_ids: [b.event_id], lease_token: a.lease_token }],
  ]) {
    const rejected = await api(path, body); assert.equal(rejected.status, 409); assert.equal(rejected.error, 'stale_lease');
  }
  assert.equal(calls.length, 0); assert.deepEqual(store.steps(b.event_id), []);
  assert.equal(store.event(b.event_id).acked_ms, null); assert.equal(store.event(b.event_id).lease_token, b.lease_token);
  assert.equal((await reply(b)).state, 'accepted'); assert.equal(store.event(a.event_id).acked_ms, null);
  assert.equal((await reply(a)).state, 'accepted'); assert.equal(calls.length, 2);
});

test('a stale parallel task is fenced while unrelated tasks finish and duplicate final replies send once', async (t) => {
  const { store, calls, add, claim, api, reply } = await setup(t);
  add('rotate'); const old = await claim(); add('unrelated'); const other = await claim();
  // Local isolated fixture only: simulate lease expiry before recovery.
  store.db.prepare('UPDATE events SET lease_until=0 WHERE id=?').run(old.event_id);
  const current = await claim(); assert.equal(current.event_id, old.event_id); assert.notEqual(current.lease_token, old.lease_token);
  assert.equal((await reply(old)).error, 'stale_lease'); assert.equal(calls.length, 0);
  const wrongRenew = await api('/v1/muse/renew', { event_id: old.event_id, lease_token: old.lease_token, lease_ms: 1800000 });
  assert.equal(wrongRenew.status, 409);
  assert.equal((await reply(other)).state, 'accepted');
  const results = await Promise.all(Array.from({ length: 5 }, () => reply(current)));
  assert.ok(results.every((result) => result.state === 'accepted'));
  assert.equal(calls.length, 2); assert.equal(store.queueStats().pending, 0);
});
