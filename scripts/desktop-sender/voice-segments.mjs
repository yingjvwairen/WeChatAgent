import speechContract from '../../packages/speech-contract/local-model-fields.json' with { type: 'json' };
import { inspectPlaybackWav } from './cable-player.mjs';

const { minBubbleMs, maxAudioSeconds } = speechContract.speechLimits;

/** Split at sample boundaries near low-energy pauses. No sample is removed,
 * repeated or resampled. Each chunk fits the bounded native recording helper. */
export function splitNativeVoiceWav(audio, { maxDurationMs = 7500, searchMs = 1000 } = {}) {
  const format = inspectPlaybackWav(audio, { maxDurationMs: maxAudioSeconds * 1000, maxBytes: 128 * 1024 * 1024 });
  if (
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs < minBubbleMs ||
    maxDurationMs > 8000 ||
    !Number.isInteger(searchMs) ||
    searchMs < 0 ||
    searchMs > 1000
  )
    throw Error('NATIVE_VOICE_SPLIT_INVALID');
  let payload;
  for (let offset = 12; offset < audio.length;) {
    const bytes = audio.readUInt32LE(offset + 4),
      begin = offset + 8;
    if (audio.toString('ascii', offset, offset + 4) === 'data') payload = audio.subarray(begin, begin + bytes);
    offset = begin + bytes + (bytes & 1);
  }
  if (!payload) throw Error('NATIVE_VOICE_WAV_INVALID');
  const sampleBytes = format.bitsPerSample / 8,
    frames = payload.length / format.blockAlign;
  const maximum = Math.floor((maxDurationMs * format.sampleRate) / 1000),
    search = Math.floor((searchMs * format.sampleRate) / 1000);
  // Short utterances use the same one-second minimum as the acoustic Reader.
  const minimum = Math.ceil((minBubbleMs * format.sampleRate) / 1000);
  // Padding is needed only when the total cannot fit any combination of legal bubbles.
  const minimumTotal = Math.ceil(frames / maximum) * minimum;
  if (frames < minimumTotal) {
    const padded = Buffer.alloc(minimumTotal * format.blockAlign);
    payload.copy(padded);
    payload = padded;
  }
  const total = payload.length / format.blockAlign;
  const pieces = [];
  for (let start = 0; start < total;) {
    const remaining = total - start;
    const count = Math.ceil(remaining / maximum);
    let end = Math.min(start + maximum, total - (count - 1) * minimum);
    if (end < total && search > 0) {
      const window = Math.max(1, Math.floor(format.sampleRate * 0.01)),
        upper = end,
        lower = Math.max(start + minimum, total - (count - 1) * maximum, start + Math.floor(maximum / 2), end - search);
      let quiet = Infinity;
      for (let point = lower; point <= upper; point += window) {
        let energy = 0;
        for (let frame = Math.max(start, point - window); frame < point; frame++)
          for (let channel = 0; channel < format.channels; channel++) {
            const offset = frame * format.blockAlign + channel * sampleBytes;
            const value = format.encoding === 'pcm' ? payload.readInt16LE(offset) / 32768 : payload.readFloatLE(offset);
            energy += value * value;
          }
        if (energy <= quiet) {
          quiet = energy;
          end = point;
        }
      }
    }
    const data = payload.subarray(start * format.blockAlign, end * format.blockAlign),
      wave = Buffer.alloc(44 + data.length);
    wave.write('RIFF');
    wave.writeUInt32LE(wave.length - 8, 4);
    wave.write('WAVEfmt ', 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(format.encoding === 'pcm' ? 1 : 3, 20);
    wave.writeUInt16LE(format.channels, 22);
    wave.writeUInt32LE(format.sampleRate, 24);
    wave.writeUInt32LE(format.byteRate, 28);
    wave.writeUInt16LE(format.blockAlign, 32);
    wave.writeUInt16LE(format.bitsPerSample, 34);
    wave.write('data', 36);
    wave.writeUInt32LE(data.length, 40);
    data.copy(wave, 44);
    pieces.push(wave);
    start = end;
  }
  return pieces;
}
