import { parentPort, workerData } from 'node:worker_threads';
import { encode, decode, getDuration, isSilk, getWavFileInfo } from 'silk-wasm';
import { wav, VOICE_MAX_BYTES, VOICE_MAX_MS } from './voice-codec.mjs';

try {
  const input = Buffer.from(workerData.bytes);
  if (!input.length || input.length > VOICE_MAX_BYTES) throw new Error('budget');
  let data, duration;
  if (workerData.action === 'decode') {
    if (!isSilk(input) || (duration = getDuration(input)) <= 0 || duration > VOICE_MAX_MS) throw new Error('silk');
    const result = await decode(input, 24000);
    if (result.data.length > 24000 * 2 * 60) throw new Error('pcm budget');
    data = wav(Buffer.from(result.data)); duration = result.data.length / 48;
  } else {
    const info = getWavFileInfo(input);
    if (info.fmt.numberOfChannels !== 1 || info.fmt.bitsPerSample !== 16 || info.fmt.formatCode !== 1
      || ![8000, 12000, 16000, 24000, 32000, 44100, 48000].includes(info.fmt.sampleRate)) throw new Error('wav');
    // Parse and bound PCM duration before invoking the encoder.
    const pcm = info.chunkInfo.filter((item) => item.chunkId === 'data');
    if (pcm.length !== 1 || pcm[0].dataLength <= 0 || pcm[0].dataOffset + pcm[0].dataLength > input.length
      || pcm[0].dataLength / (info.fmt.sampleRate * 2) > VOICE_MAX_MS / 1000) throw new Error('duration');
    const result = await encode(input, 0); data = result.data; duration = result.duration;
  }
  parentPort.postMessage({ ok: true, data, duration_ms: duration });
} catch { parentPort.postMessage({ ok: false }); }
