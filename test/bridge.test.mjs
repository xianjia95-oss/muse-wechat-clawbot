import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { BridgeError } from '../src/errors.mjs';
import { Bridge } from '../src/bridge.mjs';
import { fixture, reply, deferred } from './helpers.mjs';

test('send is immediate, concurrent same-id calls share one operation, accepted retries are cached', async (t) => {
  const gate = deferred();
  const entered = deferred();
  let count = 0;
  const { bridge } = fixture(t, { sendText: async () => { count++; entered.resolve(); await gate.promise; } });
  const first = bridge.send(reply());
  const second = bridge.send(reply());
  assert.equal(first, second);
  await entered.promise;
  assert.equal(count, 1);
  gate.resolve();
  const result = await first;
  assert.equal(result.state, 'accepted');
  assert.equal((await bridge.send(reply())).cached, true);
  assert.equal(count, 1);
  assert.throws(() => bridge.send(reply('request-1', 'different')), { code: 'id_conflict' });
});

test('Unicode chunks keep order, with no fixed delay or batch flush', async (t) => {
  const { bridge, calls } = fixture(t);
  const text = '😀'.repeat(2001) + 'done';
  const result = await bridge.send(reply('unicode', text));
  assert.equal(calls.length, 2);
  assert.equal(Array.from(calls[0][2]).length, 2000);
  assert.equal(calls.map((call) => call[2]).join(''), text);
  assert.equal(result.total_chunks, 2);
  assert.ok(result.timing.first_chunk_ms <= result.timing.bridge_ms);
  assert.equal(calls[0][3], 'context-1');
});

test('one recipient preserves order while a different recipient is not blocked', async (t) => {
  const gate = deferred();
  const seen = [];
  const { bridge, config, store } = fixture(t, { sendText: async (_, to, text) => { seen.push(`${to}:${text}`); if (text === 'first') await gate.promise; } });
  config.allow_wxids = ['owner', 'other'];
  store.saveContext('other', 'context-other');
  const first = bridge.send(reply('one', 'first'));
  const second = bridge.send(reply('two', 'second'));
  const other = bridge.send({ ...reply('three', 'third'), to: 'other' });
  await other;
  assert.deepEqual(seen, ['owner:first', 'other:third']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(seen.at(-1), 'owner:second');
});

test('uncertain send is persisted and never automatically retried', async (t) => {
  let count = 0;
  const { bridge, store, config, ilink } = fixture(t, { sendText: async () => { count++; throw new BridgeError('upstream_unknown', 'timeout', 502); } });
  await assert.rejects(bridge.send(reply()), { code: 'upstream_unknown' });
  assert.equal(store.send('request-1').state, 'unknown');
  assert.throws(() => bridge.send(reply()), { code: 'send_unknown' });
  const restarted = new Bridge(config, store, ilink);
  assert.throws(() => restarted.send(reply()), { code: 'send_unknown' });
  assert.equal(count, 1);
});

test('partial delivery reports accepted chunks and does not duplicate them', async (t) => {
  let count = 0;
  const { bridge, store } = fixture(t, { sendText: async () => { if (++count === 2) throw new BridgeError('upstream_rejected', 'rejected', 502); } });
  await assert.rejects(bridge.send(reply('partial', 'x'.repeat(4001))), (error) => {
    assert.equal(error.details.accepted_chunks, 1);
    assert.equal(error.details.total_chunks, 3);
    return true;
  });
  assert.equal(store.send('partial').state, 'rejected');
  assert.throws(() => bridge.send(reply('partial', 'x'.repeat(4001))), { code: 'send_rejected' });
  assert.equal(count, 2);
});

test('startup marks a process-interrupted request unknown', (t) => {
  const { store } = fixture(t);
  store.createSend('interrupted', 'hash', 'owner', ['client-1']);
  store.partState('interrupted', 0, 'sending');
  store.recoverUncertain();
  assert.equal(store.send('interrupted').state, 'unknown');
  assert.equal(store.parts('interrupted')[0].state, 'unknown');
});

test('whitelist, missing context, invalid request ID and unsupported attachment fail before send', (t) => {
  const { bridge, calls, store } = fixture(t);
  assert.throws(() => bridge.send({ ...reply(), to: 'stranger' }), { code: 'forbidden' });
  assert.throws(() => bridge.send({ ...reply(), request_id: '' }), { code: 'invalid_request_id' });
  assert.throws(() => bridge.send({ ...reply(), request_id: ['request-1'] }), { code: 'invalid_request_id' });
  assert.throws(() => bridge.send({ ...reply(), image: 'a.png' }), { code: 'unsupported_media' });
  store.db.exec('DELETE FROM peers');
  assert.throws(() => bridge.send(reply()), { code: 'no_context' });
  assert.equal(calls.length, 0);
});

test('batch cursor, tokens and events are atomic; duplicates remain one event', async (t) => {
  const { bridge, store } = fixture(t);
  const message = { message_id: '7523456789012345678', from_user_id: 'owner', context_token: 'new-context', item_list: [{ type: 1, text_item: { text: 'hi' } }] };
  bridge.ingest({ msgs: [message], get_updates_buf: 'cursor-a' });
  bridge.ingest({ msgs: [message], get_updates_buf: 'cursor-a' });
  assert.equal(store.count(), 1);
  assert.equal(store.context('owner'), 'new-context');
  assert.throws(() => bridge.ingest({ msgs: [{ ...message, message_id: '2', context_token: 'bad' }, { from_user_id: 'owner' }], get_updates_buf: 'cursor-b' }));
  assert.equal(store.context('owner'), 'new-context');
  assert.equal(store.get('cursor'), 'cursor-a');
  assert.equal(store.count(), 1);
  const events = store.claim(20, 1000);
  assert.equal(events[0].message_id, '7523456789012345678');
  assert.equal(store.count(), 0);
  store.db.exec('UPDATE events SET lease_until=0');
  assert.equal(store.claim().length, 1);
  assert.equal(store.ack([events[0].event_id]), 1);
  assert.equal(store.ack([events[0].event_id]), 0);
});

test('waiting inbox request wakes on ingest and does not delay sending', async (t) => {
  const { bridge } = fixture(t);
  const waiting = bridge.claim({ wait: 5000 });
  await bridge.send(reply());
  bridge.ingest({ msgs: [{ message_id: '1', from_user_id: 'owner', item_list: [] }] });
  assert.equal((await waiting).length, 1);
});

test('reply timing exposes client-side gap separately from bridge and network time', async (t) => {
  const { bridge, store } = fixture(t, { sendText: () => sleep(20) });
  const result = await bridge.send({ ...reply('timing'), model_ready_at: Date.now() - 5000 });
  assert.ok(result.timing.model_to_submit_ms >= 5000);
  assert.ok(result.timing.upstream_ms >= 15);
  assert.ok(result.timing.bridge_ms < 2000);
  assert.equal(store.metrics().states.accepted, 1);
});
