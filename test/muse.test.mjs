import test from 'node:test';
import assert from 'node:assert/strict';
import { MuseAdapter, museRequestId } from '../src/muse.mjs';
import { BridgeError } from '../src/errors.mjs';
import { fixture } from './helpers.mjs';

function incoming(bridge, id = '7523456789012345678') {
  bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', context_token: 'fresh-context', item_list: [{ type: 1, text_item: { text: '请处理这个任务' } }] }], get_updates_buf: 'cursor-next' });
  return `muse:${id}`;
}

test('Muse claims a task and final reply automatically routes, deduplicates, and completes it', async (t) => {
  const { bridge, store, calls } = fixture(t);
  const adapter = new MuseAdapter(bridge);
  const eventId = incoming(bridge);
  const { tasks } = await adapter.next();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].completion.state, 'not_submitted');
  assert.equal(tasks[0].message_id, '7523456789012345678');
  const result = await adapter.reply({ event_id: eventId, text: 'Muse 的最终结果' });
  assert.equal(result.event_completed, true);
  assert.equal(calls[0][1], 'owner');
  assert.equal(calls[0][2], 'Muse 的最终结果');
  assert.equal(calls[0][3], 'fresh-context');
  assert.notEqual(store.event(eventId).acked_ms, null);
  const again = await adapter.reply({ event_id: eventId, text: 'Muse 的最终结果' });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 1);
  await assert.rejects(adapter.reply({ event_id: eventId, text: 'changed final answer' }), { code: 'id_conflict' });
});

test('Muse progress replies do not ack the task and have stable independent IDs', async (t) => {
  const { bridge, store, calls } = fixture(t);
  const adapter = new MuseAdapter(bridge);
  const eventId = incoming(bridge, '2');
  await adapter.next();
  const body = { event_id: eventId, mode: 'progress', reply_id: 'started', text: '正在处理' };
  const result = await adapter.reply(body);
  assert.equal(result.event_completed, false);
  assert.equal(store.event(eventId).acked_ms, null);
  await adapter.reply(body);
  await adapter.reply({ event_id: eventId, text: '完成' });
  assert.equal(calls.length, 2);
  assert.notEqual(result.request_id, museRequestId(eventId));
});

test('an uncertain WeChat response leaves the task unacked and exposes state on redelivery', async (t) => {
  let calls = 0;
  const { bridge, store } = fixture(t, { sendText: async () => { calls++; throw new BridgeError('upstream_unknown', 'timeout', 502); } });
  const adapter = new MuseAdapter(bridge);
  const eventId = incoming(bridge, '3');
  await adapter.next();
  await assert.rejects(adapter.reply({ event_id: eventId, text: '结果' }), { code: 'upstream_unknown' });
  assert.equal(store.event(eventId).acked_ms, null);
  store.db.exec('UPDATE events SET lease_until=0');
  assert.equal((await adapter.next()).tasks[0].completion.state, 'unknown');
  await assert.rejects(adapter.reply({ event_id: eventId, text: '结果' }), { code: 'send_unknown' });
  assert.equal(calls, 1);
});

test('a crash after accepted reply but before ack is recovered without rerunning the task', async (t) => {
  const { bridge, store, calls } = fixture(t);
  const adapter = new MuseAdapter(bridge);
  const eventId = incoming(bridge, '4');
  await adapter.next();
  const ack = store.ack.bind(store);
  store.ack = () => { throw new Error('simulated interruption before ack'); };
  await assert.rejects(adapter.reply({ event_id: eventId, text: '已完成' }), /simulated interruption/);
  assert.equal(store.send(museRequestId(eventId)).state, 'accepted');
  store.ack = ack;
  store.db.exec('UPDATE events SET lease_until=0');
  assert.deepEqual((await adapter.next()).tasks, []);
  assert.notEqual(store.event(eventId).acked_ms, null);
  assert.equal(calls.length, 1);
});

test('Muse cannot reply to unknown, unclaimed, completed or alert events or override routing', async (t) => {
  const { bridge, store, calls } = fixture(t);
  const adapter = new MuseAdapter(bridge);
  const eventId = incoming(bridge, '5');
  await assert.rejects(adapter.reply({ event_id: eventId, text: 'result' }), { code: 'event_not_leased' });
  await assert.rejects(adapter.reply({ event_id: 'missing', text: 'result' }), { code: 'event_not_found' });
  await assert.rejects(adapter.reply({ event_id: eventId, text: 'result', to: 'stranger' }), { code: 'automatic_routing' });
  await assert.rejects(adapter.reply({ event_id: eventId, text: 'result', mode: 'progress' }), { code: 'invalid_reply_id' });
  await adapter.next();
  store.ack([eventId]);
  await assert.rejects(adapter.reply({ event_id: eventId, text: 'result' }), { code: 'event_completed' });
  bridge.alert('test', 'Report only in Muse');
  const alert = (await adapter.next()).tasks[0];
  await assert.rejects(adapter.reply({ event_id: alert.event_id, text: 'result' }), { code: 'alert_not_replyable' });
  assert.equal(calls.length, 0);
});
