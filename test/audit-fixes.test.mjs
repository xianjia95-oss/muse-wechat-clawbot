import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { Ilink } from '../src/ilink.mjs';
import { Bridge } from '../src/bridge.mjs';
import { Store } from '../src/store.mjs';
import { MuseAdapter } from '../src/muse.mjs';
import { health } from '../src/operations.mjs';
import { deliveryDiagnostics } from '../src/diagnostics.mjs';

function incoming(bridge, id) {
  bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [] }] });
  return `muse:${id}`;
}

test('empty/whitespace HTTP 200 never accepts or acknowledges a final; valid JSON without ret stays compatible', async (t) => {
  let output = '', calls = 0;
  const { config, store } = fixture(t); config.require_lease_token = true;
  const ilink = new Ilink(config, { env: {}, requestFn: async () => {
    calls++; return { statusCode: 200, body: { text: async () => output } };
  } });
  t.after(() => ilink.close());
  const bridge = new Bridge(config, store, ilink), muse = new MuseAdapter(bridge);
  for (const [i, body] of ['', ' \n\t', '{}', '{"ret":0}'].entries()) {
    output = body; const id = incoming(bridge, `empty-${i}`), task = (await muse.next()).tasks[0];
    const reply = { event_id: id, lease_token: task.lease_token, text: 'reply' };
    if (i < 2) {
      await assert.rejects(muse.reply(reply), { code: 'upstream_unknown' });
      assert.equal(store.event(id).acked_ms, null);
      await assert.rejects(muse.reply(reply), { code: 'send_unknown' });
    } else {
      assert.equal((await muse.reply(reply)).state, 'accepted');
      assert.notEqual(store.event(id).acked_ms, null);
    }
  }
  assert.equal(calls, 4);
});

test('empty, absent and invalid cursors preserve the committed cursor, including event batches', (t) => {
  const { bridge, store } = fixture(t); store.set('cursor', 'valid');
  for (const value of [undefined, '', null, false, 0, {}, []]) {
    bridge.ingest({ msgs: [], get_updates_buf: value });
    assert.equal(store.get('cursor'), 'valid');
  }
  bridge.ingest({ msgs: [{ message_id: 'cursor-empty', from_user_id: 'owner' }], get_updates_buf: '' });
  assert.ok(store.event('muse:cursor-empty')); assert.equal(store.get('cursor'), 'valid');
  bridge.ingest({ msgs: [], get_updates_buf: 'next' }); assert.equal(store.get('cursor'), 'next');
});

test('leased-task activity persists, reports stalls without modifying leases, and clears on renew/checkpoint', async (t) => {
  const { bridge, store, config, directory } = fixture(t); config.require_lease_token = true;
  bridge.poll = { state: 'waiting', last_ok_at: new Date().toISOString(), error: null };
  const muse = new MuseAdapter(bridge), id = incoming(bridge, 'activity');
  store.db.exec('UPDATE events SET received_ms=0');
  const task = (await muse.next()).tasks[0];
  assert.equal(health(bridge).healthy, true); // Freshly claimed old event.
  store.db.exec('UPDATE events SET lease_activity_ms=1');
  const before = store.event(id);
  const readiness = health(bridge);
  assert.ok(readiness.problems.includes('worker_lease_stalled'));
  assert.deepEqual(store.event(id), before);
  const diagnostics = deliveryDiagnostics({ status: bridge.status(), readiness });
  assert.equal(diagnostics.findings.filter((f) => f.code === 'worker_lease_stalled').length, 1);
  assert.equal(JSON.stringify(diagnostics).includes(task.lease_token), false);
  const reopened = new Store(directory);
  try { assert.equal(reopened.queueStats().stalled_leases, 1); } finally { reopened.close(); }
  muse.renew({ event_id: id, lease_token: task.lease_token });
  assert.equal(health(bridge).healthy, true);
  store.db.exec('UPDATE events SET lease_activity_ms=1');
  muse.checkpoint({ event_id: id, lease_token: task.lease_token, step: 'check', phase: 'started' });
  assert.equal(health(bridge).healthy, true);
  assert.equal(store.event(id).lease_token, task.lease_token);
  assert.equal(store.event(id).acked_ms, null);
  store.db.exec('UPDATE events SET lease_activity_ms=NULL, received_ms=1');
  assert.equal(store.queueStats().stalled_leases, 1); // Legacy active row, no inferred heartbeat.
});
