import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { voicePcm } from './decode-wechat-voice.mjs';
import { waveFile, normalizeWav } from '../optional-extensions/speech-synthesis/lib/wav.mjs';
import { speechSynthesize } from '../optional-extensions/speech-synthesis/lib/service.mjs';
import { qwenSynthesize } from '../optional-extensions/speech-synthesis/lib/qwen.mjs';
import { pcmWave } from './desktop-sender/engine-voice.mjs';
import { NativeVoiceOutbox } from './desktop-sender/native-voice-outbox.mjs';
import { inspectPlaybackWav } from './desktop-sender/cable-player.mjs';
const wave = seconds => waveFile(Buffer.alloc(seconds * 32000));
const hex = letter => letter.repeat(64);

test('long outgoing normalization is explicit; incoming and direct playback stay bounded at 60 seconds', () => {
  const wav = wave(65);
  assert.throws(() => voicePcm(wav));
  assert.throws(() => normalizeWav(wav), /VOICE_TTS_TOO_LONG/);
  assert.throws(() => inspectPlaybackWav(wav), /CABLE_WAV_DURATION_LIMIT/);
  assert.equal(voicePcm(wav, { maxSeconds: 1024 }).length, 65 * 32000);
  assert.equal(normalizeWav(wav, 16000, { maxSeconds: 1024 }).durationMs, 65000);
});
test('ordinary speech API accepts a 65 second WAV without changing Realtime limits', async () => {
  const result = await speechSynthesize(
    {
      entry: 'custom',
      key: '',
      profile: { auth: 'none' },
      flat: {
        endpoint: 'https://fixture.test/v1',
        model: 'voice',
        voice: 'voice',
        timeoutMs: 5000,
        instructions: '',
        apiKey: '',
      },
    },
    'test',
    {
      fetchImpl: async () => new Response(wave(65), { headers: { 'Content-Type': 'audio/wav' } }),
    },
  );
  assert.equal(result.durationMs, 65000);
});
test('Qwen long text is split within its existing 2000 character request boundary', async () => {
  const texts = [];
  const result = await qwenSynthesize(
    {
      key: 'fixture',
      flat: { endpoint: 'https://fixture.test/api/v1', model: 'voice', voice: 'voice', speed: 1, timeoutMs: 5000 },
    },
    '字'.repeat(4000),
    {
      fetchImpl: async (_url, request) => {
        texts.push(JSON.parse(request.body).input.text);
        return new Response(
          'data: ' +
            JSON.stringify({
              output: { audio: { data: Buffer.alloc(32000).toString('base64') }, finish_reason: 'stop' },
            }) +
            '\n',
        );
      },
    },
  );
  assert.deepEqual(
    texts.map(text => text.length),
    [2000, 2000],
  );
  assert.equal(texts.join(''), '字'.repeat(4000));
  assert.equal(result.durationMs, 2000);
});
test('a 1024 second logical reply is admitted into more than 128 bounded native segments', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-long-voice-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^desktop-long-voice-/);
    fs.rmSync(resolved, { recursive: true });
  });
  const wav = pcmWave(Buffer.alloc(1024 * 32000).toString('base64')),
    voiceId = crypto.createHash('sha256').update(wav).digest('hex');
  let calls = 0;
  const box = new NativeVoiceOutbox({
    root,
    authorizeScope: () => true,
    synthesizer: {
      synthesize: async () => ({
        voiceId,
        modelVerification: 'provided-audio',
        segments: [{ voiceId, modelVerification: 'provided-audio', audio: wav }],
      }),
    },
    transport: {
      sendSegment: async () => {
        calls++;
        return { confirmed: false, recordingPossible: true, stopBarrier: true, routeSafe: false };
      },
      querySegment: async () => ({ confirmed: false }),
    },
  });
  const scope = {
    version: 1,
    accountRef: hex('a'),
    account: 'self',
    target: 'friend',
    eventId: 'long-voice',
    selectionVersion: 1,
    grantId: hex('b'),
    token: hex('c'),
  };
  const result = await box.run({
    deliveryId: hex('d'),
    account: scope.account,
    target: scope.target,
    text: 'long',
    selectionScope: scope,
  });
  assert.equal(calls, 1);
  assert.ok(result.segments.length > 128 && result.segments.length <= 256);
  assert.equal(
    result.segments.reduce((total, p) => total + p.durationMs, 0),
    1024000,
  );
  assert.ok(result.segments.every(p => p.durationMs <= 8000));
  box.close();
  await box.drain();
});

test('desktop PCM validates canonical padding, complete samples and duration before admission', () => {
  for (const data of ['', 'AA==', 'AAB=', 'AA=A', 'A A=', 'AAAA\n', Buffer.alloc(1024 * 32000 + 2).toString('base64')])
    assert.throws(() => pcmWave(data), /DESKTOP_VOICE_PCM_INVALID/);
  assert.deepEqual(pcmWave('AAE=').subarray(44), Buffer.from([0, 1]));
});
