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

// These are persistent HTTP consumers, not real Muse agents. In particular this
// does not exercise the platform's spawn, task lifetime or permission prompts.
test('three resident consumers keep polling across bursts while one task is blocked', { timeout: 15000 }, async (t) => {
  const { bridge, store, calls, add, api, reply } = await setup(t);
  const blocked = deferred(), firstClaimed = deferred(), firstBurst = deferred(), secondBurst = deferred();
  const owners = new Map(), tokens = new Set(), completed = [], histories = [[], [], []];
  let stopping = false;
  const worker = async (slot) => {
    while (!stopping) {
      const response = await api('/v1/muse/tasks?limit=1&lease=30m&wait=1s');
      assert.equal(response.status, 200);
      for (const task of response.tasks) {
        assert.equal(owners.has(task.event_id), false, 'an event has one resident owner');
        assert.equal(tokens.has(task.lease_token), false);
        owners.set(task.event_id, slot); tokens.add(task.lease_token);
        histories[slot].push(task.event_id);
        if (task.text === 'resident-long') { firstClaimed.resolve(task); await blocked.promise; }
        const result = await reply(task);
        assert.equal(result.state, 'accepted');
        assert.equal(result.request_id, museRequestId(task.event_id));
        completed.push(task.event_id);
        if (completed.length === 9) firstBurst.resolve();
        if (completed.length === 15) secondBurst.resolve();
      }
    }
  };
  // Start all consumers before ingestion, so they also exercise long-poll wake.
  const running = histories.map((_, slot) => worker(slot));
  const failure = Promise.all(running).then(() => { throw new Error('resident pool unexpectedly exited'); });
  let watchdog;
  const deadline = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('resident pool made no progress')), 8000); });
  try {
    while (bridge.worker.claim_requests < 3) {
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 5)), failure, deadline]);
    }
    add('resident-long');
    const long = await Promise.race([firstClaimed.promise, failure, deadline]);
    for (let i = 0; i < 9; i++) add(`resident-first-${i}`);
    await Promise.race([firstBurst.promise, failure, deadline]);
    assert.equal(store.event(long.event_id).acked_ms, null);
    assert.equal(store.queueStats().pending, 1);
    // The same workers consume another burst without any new model task spawn.
    for (let i = 0; i < 6; i++) add(`resident-second-${i}`);
    await Promise.race([secondBurst.promise, failure, deadline]);
    assert.equal(store.event(long.event_id).acked_ms, null);
    assert.equal(calls.length, 15);
    assert.ok(histories.some((events, slot) => slot !== owners.get(long.event_id) && events.length > 1));
    stopping = true; blocked.resolve();
    await Promise.all(running);
    assert.equal(owners.size, 16); assert.equal(tokens.size, 16);
    assert.equal(calls.length, 16); assert.equal(store.queueStats().pending, 0);
    assert.equal(completed.at(-1), long.event_id);
    assert.equal((await reply(long)).cached, true); assert.equal(calls.length, 16);
  } finally {
    clearTimeout(watchdog);
    stopping = true; blocked.resolve();
    await Promise.allSettled(running);
  }
});

test('six resident consumers hold six of ten tasks and refill as soon as any slot completes', { timeout: 15000 }, async (t) => {
  const { bridge, store, calls, add, api, reply } = await setup(t);
  const poolSize = 6, gates = Array.from({ length: poolSize }, deferred);
  const full = deferred(), refilled = deferred(), owners = new Map(), tokens = new Set();
  const histories = Array.from({ length: poolSize }, () => []);
  let stopping = false, completed = 0, watchdog;
  const worker = async (slot) => {
    while (!stopping) {
      const response = await api('/v1/muse/tasks?limit=1&lease=30m&wait=1s');
      assert.equal(response.status, 200);
      for (const task of response.tasks) {
        assert.equal(owners.has(task.event_id), false);
        assert.equal(tokens.has(task.lease_token), false);
        owners.set(task.event_id, slot); tokens.add(task.lease_token);
        histories[slot].push(task);
        if (owners.size === poolSize) full.resolve();
        if (histories[slot].length === 1) await gates[slot].promise;
        assert.equal((await reply(task)).state, 'accepted');
        if (++completed === 5) refilled.resolve();
      }
    }
  };
  const running = histories.map((_, slot) => worker(slot));
  const failure = Promise.all(running).then(() => { throw new Error('resident pool unexpectedly exited'); });
  const deadline = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('six-slot pool made no progress')), 8000); });
  try {
    while (bridge.worker.claim_requests < poolSize) {
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 5)), failure, deadline]);
    }
    for (let i = 0; i < 10; i++) add(`six-slot-${i}`);
    await Promise.race([full.promise, failure, deadline]);
    assert.ok(histories.every((tasks) => tasks.length === 1));
    assert.equal(store.queueStats().leased, 6);
    assert.equal(store.queueStats().ready, 4);
    assert.equal(calls.length, 0);
    // Release just one slot; it must serve the remaining four without waiting
    // for the other five first-wave tasks to finish. No new consumer is spawned.
    gates[2].resolve();
    await Promise.race([refilled.promise, failure, deadline]);
    assert.equal(histories[2].length, 5);
    assert.equal(owners.size, 10); assert.equal(tokens.size, 10);
    assert.equal(calls.length, 5); assert.equal(store.queueStats().ready, 0);
    assert.equal(store.queueStats().leased, 5);
    for (const [slot, tasks] of histories.entries()) if (slot !== 2) {
      assert.equal(tasks.length, 1);
      assert.equal(store.event(tasks[0].event_id).acked_ms, null);
    }
    stopping = true; gates.forEach((gate) => gate.resolve());
    await Promise.all(running);
    assert.equal(completed, 10); assert.equal(calls.length, 10);
    assert.equal(store.queueStats().pending, 0);
  } finally {
    clearTimeout(watchdog); stopping = true;
    gates.forEach((gate) => gate.resolve());
    await Promise.allSettled(running);
  }
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
