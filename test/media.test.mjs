import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent, request } from 'undici';
import { Ilink, wechatCdnUrl } from '../src/ilink.mjs';
import { prepareMedia, normalizeMedia, mediaItem, MEDIA_LIMITS } from '../src/media.mjs';
import { Bridge } from '../src/bridge.mjs';
import { MuseAdapter } from '../src/muse.mjs';
import { BridgeError } from '../src/errors.mjs';
import { createApi } from '../src/server.mjs';
import { fixture, session, reply } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
// A container header for wire tests; playback/codec compatibility needs live QA.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from('simulation-video-bytes')]);
function assets(t, transport = {}) {
  const result = fixture(t, transport);
  const root = join(result.directory, 'assets');
  mkdirSync(root);
  result.config.media_roots = [root];
  const image = join(root, 'image.png');
  const video = join(root, 'video.mp4');
  writeFileSync(image, PNG); writeFileSync(video, MP4);
  return { ...result, root, image, video };
}
function decrypt(record, bytes = readFileSync(record.cipher_path)) {
  const cipher = createDecipheriv('aes-128-ecb', Buffer.from(record.key_hex, 'hex'), null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
function incoming(bridge, id = 'media') {
  bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', context_token: 'media-context', item_list: [{ type: 1, text_item: { text: '请把生成的图片发来' } }] }] });
  return `muse:${id}`;
}

test('media input requires bounded typed absolute paths and CDN hosts cannot leak credentials', () => {
  for (const media of [null, {}, [{ type: 'file', path: '/tmp/x' }], [{ type: 'image', path: 'https://example.com/x.png' }],
    [{ type: 'image', path: 'relative.png' }], [{ type: 'image', path: '/tmp/x', url: 'extra' }], Array(5).fill({ type: 'image', path: '/tmp/x' })]) {
    assert.throws(() => normalizeMedia(media), { code: 'invalid_media' });
  }
  for (const url of ['http://cdn.weixin.qq.com/upload', 'https://weixin.qq.com.evil.test/upload', 'https://user:pass@cdn.weixin.qq.com/upload', 'https://evil.test/upload']) {
    assert.throws(() => wechatCdnUrl(url), { code: 'invalid_cdn_host' });
  }
  assert.equal(new URL(wechatCdnUrl('https://novac2c.cdn.weixin.qq.com/c2c/upload?param=opaque')).searchParams.get('param'), 'opaque');
});

test('media preparation streams an encrypted snapshot with matching MD5, SHA256 and PKCS7 size', async (t) => {
  const { config, image } = assets(t);
  const record = await prepareMedia(config, 'snapshot', 0, { type: 'image', path: image });
  assert.deepEqual(decrypt(record), PNG);
  assert.notDeepEqual(readFileSync(record.cipher_path), PNG);
  assert.equal(record.raw_md5, createHash('md5').update(PNG).digest('hex'));
  assert.equal(record.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.equal(record.cipher_size, (Math.floor(PNG.length / 16) + 1) * 16);
  assert.equal(record.raw_size, PNG.length);
});

test('missing, wrong-format, oversized and outside-root media fail before sending the caption', async (t) => {
  const { bridge, directory, image, root, calls, store } = assets(t);
  const wrong = join(root, 'wrong.png'); writeFileSync(wrong, 'not an image');
  const outside = join(directory, 'outside.png'); writeFileSync(outside, PNG);
  const huge = join(root, 'huge.png');
  const fd = openSync(huge, 'w'); ftruncateSync(fd, MEDIA_LIMITS.image + 1); closeSync(fd);
  const cases = [[join(root, 'missing.png'), 'media_file_missing'], [wrong, 'unsupported_media_format'], [outside, 'media_path_forbidden'], [huge, 'media_too_large'], [root, 'invalid_media_file']];
  for (const [index, [path, code]] of cases.entries()) {
    const id = `invalid-${index}`;
    await assert.rejects(bridge.send({ ...reply(id, 'caption must not be sent'), media: [{ type: 'image', path }] }), { code });
    assert.equal(store.send(id).state, 'failed');
  }
  assert.equal(calls.length, 0);
  assert.equal(existsSync(image), true);
});

test('text plus image and video keep order, cache retries after files disappear, and clean snapshots', async (t) => {
  const outgoing = [], prepared = [];
  const { bridge, image, video, store } = assets(t, {
    sendText: async (...args) => outgoing.push(['text', args[2]]),
    uploadMedia: async (session, to, record) => {
      prepared.push(record);
      assert.deepEqual(decrypt(record), record.type === 'image' ? PNG : MP4);
      return mediaItem(record, `download-${record.type}`);
    },
    sendMedia: async (session, to, item) => outgoing.push([item.type === 2 ? 'image' : 'video', to]),
  });
  const body = { ...reply('both', '生成好了'), media: [{ type: 'image', path: image }, { type: 'video', path: video }] };
  const first = bridge.send(body);
  assert.equal(bridge.send(body), first);
  const result = await first;
  assert.equal(result.media_count, 2);
  assert.equal(result.total_parts, 3);
  assert.deepEqual(outgoing, [['text', '生成好了'], ['image', 'owner'], ['video', 'owner']]);
  assert.equal(prepared.every((record) => !existsSync(record.cipher_path)), true);
  assert.equal(store.media('both', 1), null);
  const { unlinkSync } = await import('node:fs'); unlinkSync(image); unlinkSync(video);
  assert.equal((await bridge.send(body)).cached, true);
  assert.equal(outgoing.length, 3);
  assert.throws(() => bridge.send({ ...body, media: [{ type: 'image', path: image + '.changed' }] }), { code: 'id_conflict' });
});

test('a failed upload resumes the same snapshot without repeating an accepted caption', async (t) => {
  let uploads = 0, captions = 0, sends = 0, originalKey;
  const { bridge, image, store } = assets(t, {
    sendText: async () => { captions++; },
    uploadMedia: async (session, to, record) => {
      uploads++;
      assert.deepEqual(decrypt(record), PNG);
      if (uploads === 1) { originalKey = record.filekey; throw new BridgeError('media_upload_failed', 'simulated upload failure', 502); }
      assert.equal(record.filekey, originalKey);
      return mediaItem(record, 'uploaded');
    },
    sendMedia: async () => { sends++; },
  });
  const body = { ...reply('retry-upload', 'caption'), media: [{ type: 'image', path: image }] };
  await assert.rejects(bridge.send(body), (error) => {
    assert.equal(error.details.state, 'failed');
    assert.equal(error.details.phase, 'upload');
    assert.equal(error.details.retryable, true);
    assert.equal(error.details.accepted_parts, 1);
    return true;
  });
  writeFileSync(image, Buffer.concat([PNG, Buffer.from('changed after snapshot')]));
  const result = await bridge.send(body);
  assert.equal(result.state, 'accepted');
  assert.equal(captions, 1); assert.equal(sends, 1); assert.equal(uploads, 2);
  assert.equal(store.parts('retry-upload').every((part) => part.state === 'accepted'), true);
});

test('an uncertain media chat send stays unacked and is never automatically uploaded or sent again', async (t) => {
  let uploads = 0, sends = 0;
  const { bridge, image, store } = assets(t, {
    uploadMedia: async (session, to, record) => { uploads++; return mediaItem(record, 'secret-download-ref'); },
    sendMedia: async () => { sends++; throw new BridgeError('upstream_unknown', 'simulated network uncertainty', 502); },
  });
  const adapter = new MuseAdapter(bridge);
  const eventId = incoming(bridge);
  await adapter.next();
  const body = { event_id: eventId, media: [{ type: 'image', path: image }] };
  await assert.rejects(adapter.reply(body), (error) => {
    assert.equal(error.details.state, 'unknown');
    assert.equal(error.details.retryable, false);
    assert.equal(JSON.stringify(error.details).includes('secret-download-ref'), false);
    assert.equal(JSON.stringify(error.details).includes(image), false);
    return true;
  });
  await assert.rejects(adapter.reply(body), { code: 'send_unknown' });
  assert.equal(uploads, 1); assert.equal(sends, 1);
  assert.equal(store.event(eventId).acked_ms, null);
  store.db.exec('UPDATE events SET lease_until=0');
  assert.equal((await adapter.next()).tasks[0].completion.state, 'unknown');
});

test('a restart after persisted upload but before chat submission reuses the media reference', async (t) => {
  let uploads = 0, sends = 0, interrupted = false;
  const { bridge, image, store, config, ilink } = assets(t, {
    uploadMedia: async (session, to, record) => { uploads++; return mediaItem(record, 'persisted-reference'); },
    sendMedia: async () => { sends++; },
  });
  const update = store.partState.bind(store);
  store.partState = (...args) => {
    if (args[2] === 'sending' && !interrupted) { interrupted = true; throw new Error('simulated restart before chat submission'); }
    return update(...args);
  };
  const body = { request_id: 'restart-media', to: 'owner', media: [{ type: 'image', path: image }] };
  await assert.rejects(bridge.send(body), /simulated restart/);
  assert.equal(store.parts('restart-media')[0].state, 'prepared');
  assert.equal(store.media('restart-media', 0).media_item.image_item.media.encrypt_query_param, 'persisted-reference');
  store.partState = update;
  store.recoverUncertain();
  const recovered = await new Bridge(config, store, ilink).send(body);
  assert.equal(recovered.state, 'accepted');
  assert.equal(uploads, 1); assert.equal(sends, 1);
});

test('CDN retries only upload bytes, uses fallback query encoding and sends no bot token to CDN', async (t) => {
  const { config, image } = assets(t);
  const record = await prepareMedia(config, 'cdn-retry', 0, { type: 'image', path: image });
  let uploads = 0;
  const ilink = new Ilink(config, { env: {}, requestFn: async (url, options) => {
    if (new URL(url).pathname.endsWith('getuploadurl')) {
      const body = JSON.parse(options.body);
      assert.equal(body.media_type, 1); assert.equal(body.no_need_thumb, true);
      assert.equal(body.rawsize, PNG.length); assert.equal(body.aeskey, record.key_hex);
      assert.equal(options.headers.Authorization, 'Bearer TEST-SECRET');
      return { statusCode: 200, body: { text: async () => JSON.stringify({ upload_param: 'opaque+/=&' }) } };
    }
    uploads++;
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(new URL(url).searchParams.get('encrypted_query_param'), 'opaque+/=&');
    assert.equal(new URL(url).searchParams.get('filekey'), record.filekey);
    assert.equal(Buffer.isBuffer(options.body), false);
    const pieces = []; for await (const chunk of options.body) pieces.push(chunk);
    assert.deepEqual(decrypt(record, Buffer.concat(pieces)), PNG);
    return { statusCode: uploads === 1 ? 503 : 200, headers: { 'x-encrypted-param': 'download-ref' }, body: { dump: async () => {} } };
  } });
  try {
    const item = await ilink.uploadMedia(session, 'owner', record);
    assert.equal(uploads, 2);
    assert.equal(item.type, 2);
    assert.equal(Buffer.from(item.image_item.media.aes_key, 'base64').toString('ascii'), record.key_hex);
  } finally { await ilink.close(); }
});

test('CDN 4xx stops immediately, missing success header stops after three uploads, and foreign hosts are rejected', async (t) => {
  const { config, image } = assets(t);
  const record = await prepareMedia(config, 'cdn-failures', 0, { type: 'image', path: image });
  for (const mode of ['4xx', 'no-header', 'foreign']) {
    let uploads = 0;
    const ilink = new Ilink(config, { env: {}, requestFn: async (url, options) => {
      if (new URL(url).pathname.endsWith('getuploadurl')) return { statusCode: 200, body: { text: async () => JSON.stringify({ upload_full_url: mode === 'foreign' ? 'https://evil.test/upload' : 'https://novac2c.cdn.weixin.qq.com/c2c/upload?opaque=secret' }) } };
      uploads++; for await (const chunk of options.body) { /* drain stream */ }
      return { statusCode: mode === '4xx' ? 403 : 200, headers: {}, body: { dump: async () => {} } };
    } });
    try {
      await assert.rejects(ilink.uploadMedia(session, 'owner', record), { code: mode === '4xx' ? 'media_upload_rejected' : mode === 'foreign' ? 'invalid_cdn_host' : 'media_upload_failed' });
      assert.equal(uploads, mode === '4xx' ? 1 : mode === 'foreign' ? 0 : 3);
    } finally { await ilink.close(); }
  }
});

test('real HTTP media flow encrypts uploads, sends image/video items, completes Muse event and caches retry', async (t) => {
  const { config, store, image, video } = assets(t);
  const uploadRequests = [], encrypted = [], messages = [];
  const upstream = createServer(async (req, res) => {
    const pieces = []; for await (const chunk of req) pieces.push(chunk);
    const bytes = Buffer.concat(pieces);
    if (req.url === '/ilink/bot/getuploadurl') {
      uploadRequests.push(JSON.parse(bytes.toString()));
      res.end(JSON.stringify({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?opaque=test' }));
    } else if (req.url.startsWith('/c2c/upload')) {
      encrypted.push(bytes);
      assert.equal(req.headers.authorization, undefined);
      res.setHeader('x-encrypted-param', `download-${encrypted.length}`);
      res.end();
    } else if (req.url === '/ilink/bot/sendmessage') {
      messages.push(JSON.parse(bytes.toString()).msg);
      res.end('{"ret":0}');
    } else res.writeHead(404).end('{}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const ilink = new Ilink(config, {
    agents: { send: new Agent({ connections: 2 }), poll: new Agent({ connections: 1 }), media: new Agent({ connections: 1 }) },
    requestFn: (url, options) => { const parsed = new URL(url); return request(`http://127.0.0.1:${upstream.address().port}${parsed.pathname}${parsed.search}`, options); },
  });
  const bridge = new Bridge(config, store, ilink);
  const api = createApi(bridge); api.listen(0, '127.0.0.1'); await once(api, 'listening');
  t.after(async () => {
    await ilink.close(); api.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((done) => api.close(done)), new Promise((done) => upstream.close(done))]);
  });
  incoming(bridge, 'http');
  await new MuseAdapter(bridge).next();
  const body = { event_id: 'muse:http', text: '图片视频生成好了', media: [{ type: 'image', path: image }, { type: 'video', path: video }] };
  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/v1/muse/replies`, { method: 'POST',
      headers: { Authorization: `Bearer ${config.api_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  const result = await send();
  assert.equal(result.event_completed, true); assert.equal(result.media_count, 2);
  assert.deepEqual(messages.map((msg) => msg.item_list[0].type), [1, 2, 5]);
  assert.equal(messages.every((msg) => msg.to_user_id === 'owner' && msg.context_token === 'media-context'), true);
  assert.deepEqual(uploadRequests.map((item) => item.media_type), [1, 2]);
  for (let i = 0; i < 2; i++) {
    const upload = uploadRequests[i];
    assert.deepEqual(decrypt({ key_hex: upload.aeskey }, encrypted[i]), i === 0 ? PNG : MP4);
    assert.equal(encrypted[i].length, upload.filesize);
  }
  assert.equal((await send()).cached, true);
  assert.equal(messages.length, 3); assert.equal(encrypted.length, 2);
  assert.notEqual(store.event('muse:http').acked_ms, null);
  assert.equal(bridge.status().capabilities.send.includes('video'), true);
});
