import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { MuseAdapter, museRequestId } from '../src/muse.mjs';

const add = (bridge, id) => bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: 'message ' + id } }] }] });

test('accepted recovery must not report an empty inbox while later burst messages are ready', async (t) => {
  const { bridge, store, calls, config } = fixture(t); config.require_lease_token = true;
  const muse = new MuseAdapter(bridge);
  for (let i = 0; i < 3; i++) {
    const id = 'recovered-' + i; add(bridge, id);
    const task = (await muse.next()).tasks[0];
    await muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'already sent' });
  }
  // Reproduce crashes after accepted, before ack. No external call is repeated.
  store.db.exec("UPDATE events SET acked_ms=NULL,lease_until=0 WHERE id GLOB 'muse:recovered-*'");
  for (let i = 0; i < 5; i++) add(bridge, 'burst-' + i);
  const replied = [];
  for (;;) {
    const { tasks } = await muse.next({ limit: 1 });
    if (!tasks.length) break;
    assert.equal(tasks.length, 1);
    const task = tasks[0]; replied.push(task.event_id);
    await muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'reply ' + task.event_id });
  }
  assert.equal(replied.length, 5); assert.equal(store.queueStats().pending, 0);
  assert.equal(calls.length, 8);
});

test('a leased task waiting for an external tool does not prevent claiming and replying to later messages', async (t) => {
  const { bridge, store, config, calls } = fixture(t); config.require_lease_token = true;
  const muse = new MuseAdapter(bridge); add(bridge, 'long-tool');
  const first = (await muse.next()).tasks[0];
  muse.checkpoint({ event_id: first.event_id, lease_token: first.lease_token, step: 'external-tool', phase: 'started' });
  await muse.reply({ event_id: first.event_id, lease_token: first.lease_token, mode: 'progress', reply_id: 'started', text: 'Processing the earlier task.' });
  for (let i = 0; i < 4; i++) add(bridge, 'short-' + i);
  for (let i = 0; i < 4; i++) {
    const task = (await muse.next()).tasks[0];
    await muse.reply({ event_id: task.event_id, lease_token: task.lease_token, text: 'short result' });
    assert.equal(store.send(museRequestId(task.event_id)).state, 'accepted');
  }
  assert.equal(store.event(first.event_id).acked_ms, null);
  assert.equal(store.queueStats().leased, 1); assert.equal(store.queueStats().ready, 0);
  muse.checkpoint({ event_id: first.event_id, lease_token: first.lease_token, step: 'external-tool', phase: 'completed', result: 'original result' });
  await muse.reply({ event_id: first.event_id, lease_token: first.lease_token, text: 'earlier task completed' });
  assert.equal(store.queueStats().pending, 0); assert.equal(calls.length, 6);
});

test('cancelling during accepted recovery does not prelease the following real message', async (t) => {
  const { bridge, store, config } = fixture(t); config.require_lease_token = true;
  const muse = new MuseAdapter(bridge); add(bridge, 'accepted-before-cancel');
  const prior = (await muse.next()).tasks[0];
  await muse.reply({ event_id: prior.event_id, lease_token: prior.lease_token, text: 'done' });
  store.db.prepare('UPDATE events SET acked_ms=NULL,lease_until=0 WHERE id=?').run(prior.event_id);
  add(bridge, 'still-ready'); const controller = new AbortController();
  bridge.log = (event, details) => { if (event === 'task_acknowledged' && details.source === 'accepted_recovery') controller.abort(); };
  assert.deepEqual((await muse.next({}, controller.signal)).tasks, []);
  assert.equal(store.event('muse:still-ready').lease_until, 0); assert.equal(store.count(), 1);
});
