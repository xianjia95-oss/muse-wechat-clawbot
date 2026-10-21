import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApi } from '../src/server.mjs';
import { privateJson } from '../src/config.mjs';
import { fixture } from './helpers.mjs';
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
