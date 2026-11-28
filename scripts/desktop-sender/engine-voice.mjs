import path from 'node:path';
import crypto from 'node:crypto';
import speechContract from '../../packages/speech-contract/local-model-fields.json' with { type: 'json' };
import { NativeVoiceOutbox } from './native-voice-outbox.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const maxPcmBytes = 32000 * speechContract.speechLimits.maxAudioSeconds;

export function pcmByteLength(encoded) {
  if (
    typeof encoded !== 'string' ||
    !encoded.length ||
    encoded.length % 4 ||
    encoded.length > 4 * Math.ceil(maxPcmBytes / 3) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw Error('DESKTOP_VOICE_PCM_INVALID');
  }
  // Only the final quartet can contain padding or unused bits.
  const tail = encoded.slice(-4);
  const last = Buffer.from(tail, 'base64');
  const bytes = (encoded.length / 4 - 1) * 3 + last.length;
  if (last.toString('base64') !== tail || !bytes || bytes % 2 || bytes > maxPcmBytes)
    throw Error('DESKTOP_VOICE_PCM_INVALID');
  return bytes;
}

export function pcmWave(encoded) {
  const bytes = pcmByteLength(encoded);
  const wave = Buffer.alloc(44 + bytes);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16000, 24);
  wave.writeUInt32LE(32000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(bytes, 40);
  wave.write(encoded, 44, bytes, 'base64');
  return wave;
}
export const voiceRequest = row => ({
  deliveryId: row.job.id,
  account: row.job.accountWxid,
  target: row.job.target,
  text: 'voice:' + row.job.id,
  selectionScope: row.scope,
});
export const voiceReceiptSegment = job => ({
  id: job.id,
  attemptId: job.id,
  index: job.index,
  audioSha256: job.audioSha256,
  durationMs: job.durationMs,
  path: job.path,
});
export const readerVoiceReceipt = (job, receipt) => ({
  ...receipt,
  type: 'desktop-reader-voice-v1',
  deliveryId: job.id,
  account: job.account,
  target: job.target,
  audioSha256: job.audioSha256,
});
export async function installVoice(engine, context) {
  if (context.voice) return context.voice;
  const transport = await context.driver.createVoiceTransport({
    receiptContext: async () => ({ ...context.account, accountDirectory: context.account.account }),
    receiptsFactory: ({ job }) => {
      const canonical = engine.callbackJob(context, {
        id: job.deliveryId,
        segment: voiceReceiptSegment(job),
      });
      return {
        prepare: (_native, options) => engine.receipt(canonical, { ...options, phase: 'prepare' }),
        submitted: (_native, at, options = {}) =>
          engine.receipt(canonical, { ...options, phase: 'submitted', submittedAt: at }),
        query: async (_native, options) => {
          const result = await engine.receipt(canonical, { ...options, phase: 'query' });
          if (result?.confirmed !== true) return result ?? { confirmed: false };
          return {
            confirmed: true,
            receipt: readerVoiceReceipt(job, result.receipt),
          };
        },
      };
    },
  });
  context.voice = new NativeVoiceOutbox({
    root: engine.root,
    directory: path.join(context.directory, 'voice'),
    transport,
    now: engine.now,
    operationTimeoutMs: 60000,
    isRetired: id => engine.isReviewed(context, id),
    authorizeScope: scope => {
      const row = [...context.metadata.values()].find(item => item.scope.token === scope.token);
      return !!row && engine.allowed(context, { id: row.job.id });
    },
    synthesizer: {
      synthesize: async text => {
        const row = engine.metadata(context, text.slice(6)),
          audio = context.store.readVoiceInput(row),
          voiceId = hash(audio);
        return {
          voiceId,
          modelVerification: 'provided-audio',
          segments: [{ voiceId, modelVerification: 'provided-audio', audio }],
        };
      },
    },
  });
  return context.voice;
}
