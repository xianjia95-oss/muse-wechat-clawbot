import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApi } from '../src/server.mjs';
import { privateJson } from '../src/config.mjs';
import { fixture, deferred } from './helpers.mjs';
import { mediaItem } from '../src/media.mjs';

function cli(configPath, args, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--config', configPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${code}: ${stderr} ${stdout}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(text ?? '');
  });
}

test('real Muse CLI performs claim, progress, final and idempotent retry through HTTP', async (t) => {
  const { bridge, config, directory, calls, store } = fixture(t);
  const server = createApi(bridge);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  config.listen.port = server.address().port;
  const path = join(directory, 'config.json');
  privateJson(path, config);
  bridge.ingest({ msgs: [{ message_id: '123', from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] });
  const inbox = await cli(path, ['muse', 'next']);
  assert.equal(inbox.tasks[0].event_id, 'muse:123');
  const progress = await cli(path, ['muse', 'reply', 'muse:123', '--text', '-', '--progress', '--reply-id', 'started'], '正在处理😀');
  assert.equal(progress.event_completed, false);
  const result = await cli(path, ['muse', 'reply', 'muse:123', '--text', '-'], '任务完成😀');
  assert.equal(result.event_completed, true);
  assert.notEqual(store.event('muse:123').acked_ms, null);
  assert.equal(calls[1][2], '任务完成😀');
  const retry = await cli(path, ['muse', 'reply', 'muse:123', '--text', '-'], '任务完成😀');
  assert.equal(retry.cached, true);
  assert.equal(calls.length, 2);
});

test('real Muse CLI sends an image-only reply and a video without requiring text', async (t) => {
  const sent = [];
  const { bridge, config, directory, store } = fixture(t, {
    uploadMedia: async (session, to, record) => mediaItem(record, `download-${record.type}`),
    sendMedia: async (session, to, item) => sent.push(item.type),
  });
  const root = join(directory, 'assets'); mkdirSync(root); config.media_roots = [root];
  const image = join(root, 'generated image.png');
  const video = join(root, 'generated video.mp4');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
  writeFileSync(video, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]));
  const server = createApi(bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  config.listen.port = server.address().port;
  const path = join(directory, 'config.json'); privateJson(path, config);
  bridge.ingest({ msgs: [{ message_id: 'media-cli', from_user_id: 'owner', item_list: [] }] });
  await cli(path, ['muse', 'next']);
  const progress = await cli(path, ['muse', 'reply', 'muse:media-cli', '--image', image, '--progress', '--reply-id', 'preview']);
  assert.equal(progress.event_completed, false);
  const result = await cli(path, ['muse', 'reply', 'muse:media-cli', '--video', video]);
  assert.equal(result.event_completed, true);
  assert.deepEqual(sent, [2, 5]);
  assert.notEqual(store.event('muse:media-cli').acked_ms, null);
  const retry = await cli(path, ['muse', 'reply', 'muse:media-cli', '--video', video]);
  assert.equal(retry.cached, true);
  assert.deepEqual(sent, [2, 5]);
});

test('async media CLI returns while upload is held and lets the same worker reply to short messages', { timeout: 20000 }, async (t) => {
  const gate = deferred(), entered = deferred(), sent = []; let uploads = 0;
  const { bridge, config, directory, store } = fixture(t, {
    uploadMedia: async (session, to, record) => { uploads++; entered.resolve(); await gate.promise; return mediaItem(record, 'uploaded'); },
    sendText: async (_, to, text) => sent.push(text),
    sendMedia: async () => sent.push('image'),
  });
  config.require_lease_token = true; config.media_roots = [directory];
  const image = join(directory, 'image.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
  const server = createApi(bridge); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { gate.resolve(); await bridge.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  config.listen.port = server.address().port;
  const path = join(directory, 'config.json'); privateJson(path, config);
  const ingest = (id) => bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [] }] });
  ingest('slow-image');
  const task = (await cli(path, ['muse', 'next', '--limit', '1'])).tasks[0];
  const args = ['muse', 'reply', task.event_id, '--lease-token', task.lease_token, '--image', image, '--async'];
  const submitted = await cli(path, args);
  assert.equal(submitted.submitted, true); assert.equal(submitted.event_completed, false);
  await entered.promise;
  assert.equal(store.event(task.event_id).acked_ms, null);
  assert.equal((await cli(path, args)).request_id, submitted.request_id);
  assert.equal(uploads, 1);
  for (let i = 0; i < 5; i++) {
    ingest(`short-${i}`);
    const short = (await cli(path, ['muse', 'next', '--limit', '1'])).tasks[0];
    const result = await cli(path, ['muse', 'reply', short.event_id, '--lease-token', short.lease_token, '--text', '-'], `reply-${i}`);
    assert.equal(result.state, 'accepted');
  }
  assert.deepEqual(sent, ['reply-0', 'reply-1', 'reply-2', 'reply-3', 'reply-4']);
  assert.equal(store.event(task.event_id).acked_ms, null);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/muse/replies`, { method: 'POST',
    headers: { Authorization: `Bearer ${config.api_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_id: task.event_id, lease_token: task.lease_token, media: [{ type: 'image', path: image }], async: true }) });
  assert.equal(response.status, 202);
  gate.resolve(); await bridge.close();
  const receipt = await cli(path, ['request', submitted.request_id]);
  assert.equal(receipt.state, 'accepted'); assert.notEqual(store.event(task.event_id).acked_ms, null);
  assert.equal((await cli(path, args)).cached, true);
  assert.equal(uploads, 1); assert.equal(sent.at(-1), 'image');
});
