import { createHash, createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BridgeError, fail } from './errors.mjs';

export const MEDIA_LIMITS = { image: 20 * 1024 * 1024, video: 50 * 1024 * 1024 };
export const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

export function normalizeMedia(value = []) {
  if (!Array.isArray(value) || value.length > 4) fail('invalid_media', 'media must contain at most four image/video objects.');
  return value.map((item) => {
    if (!item || !['image', 'video'].includes(item.type) || typeof item.path !== 'string' ||
        item.path.length > 4096 || item.path.includes('\0') || !isAbsolute(item.path)) {
      fail('invalid_media', 'Each media item requires type=image/video and an absolute local path.');
    }
    if (Object.keys(item).some((key) => !['type', 'path'].includes(key))) fail('invalid_media', 'Only type and path are supported for media items.');
    return { type: item.type, path: resolve(item.path) };
  });
}

function checkFormat(type, head) {
  const image = head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii')) ||
    (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP');
  const video = head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp';
  if (!(type === 'image' ? image : video)) {
    fail('unsupported_media_format', type === 'image' ? 'Images must be PNG, JPEG, GIF or WebP.' : 'Videos must be MP4/MOV containers; no transcoding is performed.');
  }
}

export function mediaDirectory(config, requestId) {
  return join(resolve(config.state_dir), 'outbox', createHash('sha256').update(requestId).digest('hex'));
}

// Stream a bounded, encrypted snapshot to disk; large videos are never read
// into one buffer. The first successfully prepared snapshot is bound to the ID.
export async function prepareMedia(config, requestId, part, descriptor) {
  const roots = config.media_roots ?? [join(homedir(), 'workspace')];
  let source;
  try { source = await realpath(descriptor.path); } catch { fail('media_file_missing', 'Media file is missing or unreadable.'); }
  const allowed = await Promise.all(roots.map(async (root) => { try { return within(await realpath(root), source); } catch { return false; } }));
  if (!allowed.some(Boolean)) fail('media_path_forbidden', 'Media file is outside config.media_roots.', 403);
  if (!(await stat(source)).isFile()) fail('invalid_media_file', 'Media path must be a regular file.');
  let file;
  try { file = await open(source, 'r'); } catch { fail('media_file_missing', 'Media file is missing or unreadable.'); }
  const directory = mediaDirectory(config, requestId);
  const path = join(directory, `${part}.bin`);
  const temp = join(directory, `${part}-${randomUUID()}.tmp`);
  try {
    const before = await file.stat();
    if (!before.isFile()) fail('invalid_media_file', 'Media path must be a regular file.');
    if (before.size <= 0 || before.size > MEDIA_LIMITS[descriptor.type]) fail('media_too_large', 'Media is empty or exceeds the local limit (image 20 MiB; video 50 MiB).', 413);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const key = randomBytes(16);
    const md5 = createHash('md5');
    const sha256 = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const inspect = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > MEDIA_LIMITS[descriptor.type]) { done(new BridgeError('media_too_large', 'Media grew beyond the local size limit.', 413)); return; }
      if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
      md5.update(chunk); sha256.update(chunk);
      done(null, chunk);
    } });
    await pipeline(file.createReadStream({ autoClose: false }), inspect, createCipheriv('aes-128-ecb', key, null), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    const after = await file.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('media_changed', 'Media changed while preparing; submit only completed files.');
    checkFormat(descriptor.type, head);
    await rename(temp, path);
    return { type: descriptor.type, cipher_path: path, raw_size: size, cipher_size: (Math.floor(size / 16) + 1) * 16,
      raw_md5: md5.digest('hex'), sha256: sha256.digest('hex'), key_hex: key.toString('hex'), filekey: randomBytes(16).toString('hex') };
  } finally {
    await file.close();
    await rm(temp, { force: true });
  }
}

export async function snapshotAvailable(config, requestId, record) {
  if (!within(mediaDirectory(config, requestId), resolve(record.cipher_path))) return false;
  try { const info = await stat(record.cipher_path); return info.isFile() && info.size === record.cipher_size; } catch { return false; }
}

export async function removeSnapshot(config, requestId, record) {
  if (within(mediaDirectory(config, requestId), resolve(record.cipher_path))) await rm(record.cipher_path, { force: true });
}

export function mediaItem(record, downloadParam) {
  const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(record.key_hex, 'ascii').toString('base64'), encrypt_type: 1 };
  return record.type === 'image' ? { type: 2, image_item: { media, mid_size: record.cipher_size } } :
    { type: 5, video_item: { media, video_size: record.cipher_size } };
}

export const encryptedStream = (record) => createReadStream(record.cipher_path);
