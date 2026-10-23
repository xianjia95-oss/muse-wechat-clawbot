import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture, deferred } from './helpers.mjs';
import { MuseAdapter } from '../src/muse.mjs';
import { createApi } from '../src/server.mjs';

const add = (bridge, id) => bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [] }] });

test('a persisted final reply prevents a new tool step while its network result is pending', async (t) => {
  const gate = deferred(), entered = deferred();
  const { bridge, config, store } = fixture(t, { sendText: async () => { entered.resolve(); await gate.promise; } });
  config.require_lease_token = true;
  const muse = new MuseAdapter(bridge); add(bridge, 'final-step-race');
  const task = (await muse.next()).tasks[0];
  const final = muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'FINAL' });
  try {
    await entered.promise;
    assert.throws(() => muse.checkpoint({ event_id: task.event_id, lease_token: task.lease_token, step: 'new-effect', phase: 'started' }), { code: 'task_final_submitted' });
    assert.deepEqual(store.steps(task.event_id), []); assert.equal(store.event(task.event_id).acked_ms, null);
    gate.resolve(); assert.equal((await final).state, 'accepted');
    assert.notEqual(store.event(task.event_id).acked_ms, null);
  } finally { gate.resolve(); await Promise.allSettled([final]); }
});

for (const mode of ['final', 'progress']) test(`explicit HTTP ack validates the entire batch while an async ${mode} reply is pending`, async (t) => {
  const gate = deferred(), entered = deferred();
  const { bridge, config, store } = fixture(t, { sendText: async () => { entered.resolve(); await gate.promise; } });
  config.require_lease_token = true;
  const server = createApi(bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${config.api_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    add(bridge, 'untouched-ack'); add(bridge, `pending-${mode}-ack`);
    const tasks = (await new MuseAdapter(bridge).next({ limit: 2 })).tasks;
    const task = tasks.find((entry) => entry.event_id === `muse:pending-${mode}-ack`);
    const untouched = tasks.find((entry) => entry.event_id === 'muse:untouched-ack');
    const submitted = await post('/v1/muse/replies', { event_id: task.event_id, lease_token: task.lease_token, text: 'RESULT', mode, ...(mode === 'progress' ? { reply_id: 'verified-stage' } : {}), async: true });
    assert.equal(submitted.status, 202); await entered.promise;
    const ack = await post('/v1/events/ack', { event_ids: [untouched.event_id, task.event_id], lease_tokens: Object.fromEntries(tasks.map((entry) => [entry.event_id, entry.lease_token])) });
    assert.equal(ack.status, 409); assert.equal(ack.body.error, 'task_reply_inflight');
    assert.equal(store.event(task.event_id).acked_ms, null);
    assert.equal(store.event(untouched.event_id).acked_ms, null);
    gate.resolve(); await Promise.allSettled(bridge.inflight.values());
    assert.equal(store.event(task.event_id).acked_ms !== null, mode === 'final');
  } finally { gate.resolve(); await Promise.allSettled(bridge.inflight.values()); server.closeAllConnections(); await new Promise((done) => server.close(done)); }
});

test('accepted recovery preserves a legacy unresolved tool step instead of silently acknowledging it', async (t) => {
  const { bridge, config, store, calls } = fixture(t); config.require_lease_token = true;
  const muse = new MuseAdapter(bridge); add(bridge, 'accepted-with-unresolved-step');
  const task = (await muse.next()).tasks[0], ack = store.ack.bind(store);
  store.ack = () => { throw new Error('simulated crash before inbox acknowledgement'); };
  try { await assert.rejects(muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'FINAL' })); }
  finally { store.ack = ack; }
  // Model an older version's inconsistent persisted state in this disposable DB.
  store.db.prepare('INSERT INTO task_steps VALUES (?,?,?,?,?,?)').run(task.event_id, 'unresolved-effect', 'started', task.lease_token, 'null', Date.now());
  store.db.prepare('UPDATE events SET lease_until=0 WHERE id=?').run(task.event_id);
  const recovered = (await muse.next()).tasks[0];
  assert.ok(recovered); assert.equal(recovered.completion.state, 'accepted');
  assert.equal(recovered.execution.needs_review, true); assert.equal(store.event(task.event_id).acked_ms, null);
  muse.checkpoint({ event_id: task.event_id, lease_token: recovered.lease_token, step: 'unresolved-effect', phase: 'completed', reviewed: true, result: 'external outcome checked' });
  assert.equal((await muse.reply({ event_id: task.event_id, lease_token: recovered.lease_token, text: 'FINAL' })).cached, true);
  assert.equal(calls.length, 1); assert.notEqual(store.event(task.event_id).acked_ms, null);
});
