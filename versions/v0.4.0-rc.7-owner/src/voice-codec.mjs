import { Worker } from 'node:worker_threads';
import { BridgeError, fail } from './errors.mjs';

export const VOICE_MAX_BYTES = 4 * 1024 * 1024;
export const VOICE_MAX_MS = 60000;
let tail = Promise.resolve(), pending = 0;

export function wav(pcm, rate = 24000) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > VOICE_MAX_BYTES
    || ![8000, 12000, 16000, 24000, 32000, 44100, 48000].includes(rate)) fail('invalid_voice_pcm', 'Expected bounded mono 16-bit PCM.');
  const head = Buffer.alloc(44);
  head.write('RIFF'); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// One bounded codec worker at a time. This never runs on the bridge event loop
// and never calls a model, a speech API or an external executable.
export async function voiceCodec(action, bytes, signal) {
  if (!['decode', 'encode'].includes(action) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > VOICE_MAX_BYTES)
    fail('invalid_voice_input', 'Voice conversion input exceeds its budget.');
  if (pending >= 3) fail('voice_codec_busy', 'Voice conversion queue is full; retain the original media.', 429);
  pending++;
  const prior = tail;
  let release;
  tail = new Promise((done) => { release = done; });
  try {
    await prior;
    if (signal?.aborted) fail('voice_codec_cancelled', 'Voice conversion stopped.');
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./voice-codec-worker.mjs', import.meta.url), {
        workerData: { action, bytes }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        worker.terminate().then(() => error ? reject(new BridgeError(error, 'Voice codec failed; retain the source media.', 422)) : resolve(result),
          () => reject(new BridgeError('voice_codec_failed', 'Voice codec could not stop safely.', 503)));
      };
      const abort = () => finish('voice_codec_cancelled');
      const timer = setTimeout(() => finish('voice_codec_timeout'), 10000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      worker.on('error', () => finish('voice_codec_failed'));
      worker.on('exit', () => { if (!settled) finish('voice_codec_failed'); });
      worker.on('message', (result) => {
        if (!result?.ok || !(result.data instanceof Uint8Array) || !result.data.length || result.data.length > VOICE_MAX_BYTES
          || !Number.isFinite(result.duration_ms) || result.duration_ms <= 0 || result.duration_ms > VOICE_MAX_MS)
          return finish('voice_codec_invalid');
        finish(null, { data: Buffer.from(result.data), duration_ms: Math.ceil(result.duration_ms) });
      });
    });
  } finally { pending--; release(); }
}
