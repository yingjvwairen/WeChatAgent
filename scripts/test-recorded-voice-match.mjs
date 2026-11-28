import assert from 'node:assert/strict';
import test from 'node:test';
import { voiceShape, sameRecordedVoice } from './recorded-voice-match.mjs';
import { encodeVoice, decodeVoice, pcmWav, voicePcm } from './decode-wechat-voice.mjs';

function melody(notes, gain = 1) {
  const rate = 16000,
    segment = rate / 2;
  const pcm = Buffer.alloc(notes.length * segment * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const offset = i % segment,
      frequency = notes[Math.floor(i / segment)];
    const level = Math.max(0, Math.min(1, offset / 300, (segment - 600 - offset) / 300));
    pcm.writeInt16LE(Math.round(gain * 10000 * level * Math.sin((2 * Math.PI * frequency * offset) / rate)), i * 2);
  }
  return pcm;
}
const notes = [410, 730, 280, 560, 390, 695];

test('recorded speech matches after a SILK round trip with leading silence and a gain change', async () => {
  const reference = voiceShape(melody(notes));
  const recording = Buffer.concat([Buffer.alloc(320 * 18), melody(notes, 0.72), Buffer.alloc(320 * 32)]);
  const { silk } = await encodeVoice(pcmWav(recording));
  const decoded = await decodeVoice(silk);
  assert.equal(sameRecordedVoice(reference, voicePcm(Buffer.from(decoded.b64, 'base64'))), true);
});

test('matching also checks spectral changes, duration and signal information', () => {
  const source = melody(notes),
    reference = voiceShape(source);
  assert.equal(sameRecordedVoice(reference, melody(notes.toReversed())), false);
  assert.equal(sameRecordedVoice(reference, Buffer.alloc(source.length)), false);
  assert.equal(sameRecordedVoice(voiceShape(Buffer.alloc(source.length)), Buffer.alloc(source.length)), false);
  assert.equal(sameRecordedVoice(reference, source.subarray(0, 1000)), false);
  assert.equal(sameRecordedVoice('not base64', source), false);
});
