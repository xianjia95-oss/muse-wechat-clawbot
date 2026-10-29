import { createHash, createDecipheriv, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MEDIA_LIMITS, mediaFormat, within } from './media.mjs';
import { voiceCodec, wav, VOICE_MAX_BYTES, VOICE_MAX_MS } from './voice-codec.mjs';
import { mkdirDurable, syncFile, syncDirectory } from './durability.mjs';
import { BridgeError, fail } from './errors.mjs';

const kinds = { 2: 'image', 3: 'voice', 5: 'video' };
const digest = (s) => createHash('sha256').update(s).digest('hex');
export const inboundDirectory = (config, eventId) => join(resolve(config.state_dir), 'inbound', digest(eventId));
const safeCode = (error) => /^(?:inbound_[a-z_]+|invalid_cdn_host|unsupported_media_format|storage_pressure)$/.test(error?.code ?? '') ? error.code : 'inbound_download_failed';

function keyBytes(source) {
  if (source.aeskey !== undefined) {
    if (typeof source.aeskey !== 'string' || !/^[a-f0-9]{32}$/i.test(source.aeskey)) fail('inbound_invalid_key', 'Invalid media key.');
    return Buffer.from(source.aeskey, 'hex');
  }
  const value = source.media?.aes_key;
  if (!value) {
    if (source.type === 'image') return null; // Official plaintext image variant.
    fail('inbound_invalid_key', 'Encrypted media requires a key.');
  }
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('inbound_invalid_key', 'Invalid media key.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('inbound_invalid_key', 'Invalid media key.');
  if (bytes.length === 16) return bytes;
  if (bytes.length === 32 && /^[a-f0-9]{32}$/i.test(bytes.toString('ascii'))) return Buffer.from(bytes.toString('ascii'), 'hex');
  fail('inbound_invalid_key', 'Invalid media key.');
}

export function inboundSource(item) {
  const type = kinds[item.type], wire = item[`${type}_item`];
  if (!type || !wire || !wire.media || typeof wire.media !== 'object') fail('inbound_missing_reference', 'Attachment reference is unavailable.');
  const media = wire.media;
  const source = { type, media: { ...(media.full_url !== undefined ? { full_url: media.full_url } : {}),
    ...(media.encrypt_query_param !== undefined ? { encrypt_query_param: media.encrypt_query_param } : {}), ...(media.aes_key !== undefined ? { aes_key: media.aes_key } : {}) },
    ...(type === 'image' && wire.aeskey !== undefined ? { aeskey: wire.aeskey } : {}) };
  if (![source.media.full_url, source.media.encrypt_query_param].some((v) => typeof v === 'string' && v.length && v.length <= 16384)
    || Object.values(source.media).some((v) => typeof v !== 'string' || v.length > 16384)) fail('inbound_missing_reference', 'Invalid media reference.');
  keyBytes(source); // Validate before writing a queued row.
  if (type === 'voice') for (const key of ['encode_type', 'sample_rate', 'bits_per_sample', 'playtime']) {
    if (wire[key] !== undefined) {
      if (!Number.isSafeInteger(wire[key]) || wire[key] < 0 || wire[key] > 192000) fail('inbound_invalid_voice', 'Invalid voice metadata.');
      source[key] = wire[key];
    }
  }
  return source;
}

export class InboundMedia {
  constructor(bridge) { this.bridge = bridge; this.active = new Map(); this.recovered = false; }
  get db() { return this.bridge.store.db; }
  add(eventId, items) {
    let count = 0;
    for (const item of items) {
      if (!kinds[item.type]) continue;
      if (count >= 4) break;
      // A transcript-only voice message needs no binary reference.
      if (item.type === 3 && item.voice_item?.text && !item.voice_item?.media) continue;
      let source = null, error = null;
      try { source = inboundSource(item); } catch (e) { error = safeCode(e); }
      this.db.prepare('INSERT OR IGNORE INTO inbound_media VALUES (?,?,?,?,?,?,?,?)')
        .run(eventId, count++, kinds[item.type], source ? JSON.stringify(source) : null, error ? 'failed' : 'queued',
          error ? JSON.stringify({ error }) : null, 0, Date.now());
    }
    return this.describe(eventId);
  }
  describe(eventId) {
    return this.db.prepare('SELECT part,type,state,result,attempts FROM inbound_media WHERE event_id=? ORDER BY part').all(eventId)
      .map((row) => ({ part: row.part, type: row.type, state: row.state, attempts: row.attempts, ...(row.result ? JSON.parse(row.result) : {}) }));
  }
  async inspect(body) {
    if (this.bridge.store.get('restore_review_required', false)) fail('restore_review_required', 'Reconcile restored state before accessing media.', 409);
    const event = this.bridge.store.requireLease(body?.event_id, body?.lease_token).event;
    if (event.kind === 'alert' || event.binding !== this.bridge.config.binding || !this.bridge.allowed(event.from_wxid)) fail('inbound_forbidden', 'Use an allowed live event.', 403);
    if (body.retry !== undefined && typeof body.retry !== 'boolean') fail('invalid_argument', 'retry must be boolean.');
    // A deleted or replaced cache must not keep reporting ready. The download
    // hash remains available for the consuming tool to verify file contents.
    for (const media of this.describe(body.event_id).filter((m) => m.state === 'ready')) {
      try {
        for (const field of ['path', 'raw_path']) if (media[field]) {
          if (!within(inboundDirectory(this.bridge.config, body.event_id), resolve(media[field]))) throw new Error('path');
          const info = await lstat(media[field]);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== media[field === 'path' ? 'size' : 'raw_size']) throw new Error('cache');
        }
      } catch {
        this.db.prepare("UPDATE inbound_media SET state='failed',result=?,updated_ms=? WHERE event_id=? AND part=? AND state='ready'")
          .run(JSON.stringify({ error: 'inbound_cache_unavailable' }), Date.now(), body.event_id, media.part);
      }
    }
    if (body.retry) this.db.prepare("UPDATE inbound_media SET state='queued',result=NULL,updated_ms=? WHERE event_id=? AND source IS NOT NULL AND state='failed' AND attempts<3")
      .run(Date.now(), body.event_id);
    this.dispatch();
    return { event_id: body.event_id, media: this.describe(body.event_id), content_is_untrusted: true, muse_understanding_verified: false };
  }
  dispatch() {
    const bridge = this.bridge;
    if (bridge.stopping || bridge.maintaining || bridge.store.get('restore_review_required', false)) return;
    if (!this.recovered) {
      // GET downloads are safe to resume after a crash; attempts remain bounded.
      this.db.prepare("UPDATE inbound_media SET state=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,result=?,updated_ms=? WHERE state='downloading'")
        .run(JSON.stringify({ error: 'inbound_interrupted' }), Date.now());
      this.recovered = true;
    }
    while (this.active.size < 2) {
      const row = this.db.prepare("SELECT m.* FROM inbound_media m JOIN events e ON e.id=m.event_id WHERE m.state='queued' AND m.attempts<3 AND e.acked_ms IS NULL ORDER BY e.received_ms,m.part LIMIT 1").get();
      if (!row) break;
      this.db.prepare("UPDATE inbound_media SET state='downloading',attempts=attempts+1,result=NULL,updated_ms=? WHERE event_id=? AND part=?")
        .run(Date.now(), row.event_id, row.part);
      const id = `${row.event_id}/${row.part}`;
      const task = this.download(row).then((result) => {
        this.db.prepare("UPDATE inbound_media SET state='ready',result=?,updated_ms=? WHERE event_id=? AND part=?")
          .run(JSON.stringify(result), Date.now(), row.event_id, row.part);
      }, (error) => {
        this.db.prepare("UPDATE inbound_media SET state=CASE WHEN ?=1 AND attempts<3 THEN 'queued' ELSE 'failed' END,result=?,updated_ms=? WHERE event_id=? AND part=?")
          .run(bridge.stopping ? 1 : 0, JSON.stringify({ error: bridge.stopping ? 'inbound_interrupted' : safeCode(error) }), Date.now(), row.event_id, row.part);
        bridge.log('inbound_media_failed', { code: safeCode(error) });
      }).finally(() => { this.active.delete(id); bridge.events.emit('new'); this.dispatch(); });
      this.active.set(id, task);
    }
  }
  async download(row) {
    const { bridge } = this, source = JSON.parse(row.source), limit = MEDIA_LIMITS[row.type], key = keyBytes(source);
    if (typeof bridge.ilink.downloadMedia !== 'function') fail('inbound_transport_missing', 'Use the matching media transport.');
    if (row.type === 'voice' && source.playtime > VOICE_MAX_MS) fail('inbound_voice_too_long', 'Voice exceeds 60 seconds.');
    const release = bridge.resources.reserve(limit + 16 + (row.type === 'voice' ? VOICE_MAX_BYTES : 0));
    const directory = inboundDirectory(bridge.config, row.event_id), temp = join(directory, `${row.part}-${randomUUID()}.tmp`);
    let response;
    const signal = AbortSignal.any([bridge.controller.signal, AbortSignal.timeout(bridge.config.inbound_media_timeout_ms ?? 30000)]);
    try {
      await mkdirDurable(directory);
      response = await bridge.ilink.downloadMedia(source.media, signal);
      const length = response.headers?.['content-length'];
      if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > limit + (key ? 16 : 0)))
        fail('inbound_media_too_large', 'Media exceeds its local budget.', 413);
      let wireSize = 0, size = 0, head = Buffer.alloc(0);
      const sha = createHash('sha256');
      const wire = new Transform({ transform(chunk, encoding, done) {
        wireSize += chunk.length;
        done(wireSize > limit + (key ? 16 : 0) ? new BridgeError('inbound_media_too_large', 'Media exceeds its local budget.', 413) : null, chunk);
      } });
      const plain = new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        if (size > limit) return done(new BridgeError('inbound_media_too_large', 'Media exceeds its local budget.', 413));
        if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
        sha.update(chunk); done(null, chunk);
      } });
      await pipeline(response.body, wire, ...(key ? [createDecipheriv('aes-128-ecb', key, null)] : []), plain,
        createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
      if (!size || (length !== undefined && wireSize !== Number(length))) fail('inbound_incomplete_media', 'Incomplete media file.');
      let format;
      if (row.type === 'voice' && source.encode_type === 1) format = { ext: 'pcm', mime: 'audio/L16' };
      else format = mediaFormat(row.type, head);
      if (row.type === 'voice' && format.encode_type && source.encode_type !== undefined && format.encode_type !== source.encode_type)
        fail('inbound_voice_format_mismatch', 'Voice encoding does not match its file header.');
      await syncFile(temp);
      const path = join(directory, `${row.part}.${format.ext}`);
      await rename(temp, path); await syncDirectory(directory);
      const result = { path, mime_type: format.mime, size, sha256: sha.digest('hex'), ...(source.playtime ? { duration_ms: source.playtime } : {}) };
      if (row.type === 'voice' && ['silk', 'pcm'].includes(format.ext)) {
        const target = join(directory, `${row.part}-decoded.wav`), temporary = target + '.tmp';
        try {
          const bytes = await readFile(path);
          const decoded = format.ext === 'silk' ? await voiceCodec('decode', bytes, signal) :
            { data: wav(bytes, source.sample_rate ?? 24000), duration_ms: bytes.length / ((source.sample_rate ?? 24000) * 2) * 1000 };
          if (source.bits_per_sample !== undefined && source.bits_per_sample !== 16 && format.ext === 'pcm') throw new Error('unsupported PCM');
          if (decoded.duration_ms > VOICE_MAX_MS || decoded.data.length > VOICE_MAX_BYTES) throw new Error('voice budget');
          // A prior interrupted conversion never makes an incomplete WAV usable.
          await rm(temporary, { force: true });
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(decoded.data); await file.sync(); } finally { await file.close(); }
          await rename(temporary, target); await syncDirectory(directory);
          Object.assign(result, { raw_path: path, raw_mime_type: format.mime, raw_size: size, raw_sha256: result.sha256,
            path: target, mime_type: 'audio/wav', size: decoded.data.length, sha256: digest(decoded.data), duration_ms: decoded.duration_ms });
        } catch { result.conversion_error = 'inbound_voice_decode_failed_raw_preserved'; }
        finally { await rm(temporary, { force: true }); }
      }
      return result;
    } finally { response?.body?.destroy?.(); await rm(temp, { force: true }); release(); }
  }
  async remove(eventId) {
    const directory = inboundDirectory(this.bridge.config, eventId);
    if (!within(join(resolve(this.bridge.config.state_dir), 'inbound'), directory)) fail('inbound_unsafe_path', 'Invalid media cache path.');
    let entries;
    try { entries = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of entries) {
      const path = join(directory, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) fail('inbound_unsafe_path', 'Media cache contains an unexpected entry.');
      await rm(path);
    }
    await rmdir(directory);
  }
  async close() { await Promise.allSettled(this.active.values()); }
}
