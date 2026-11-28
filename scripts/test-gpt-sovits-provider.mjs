import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { setup } from '../optional-extensions/speech-synthesis/index.mjs';
import { synthesizeText } from '../optional-extensions/speech-synthesis/lib/engine.mjs';
import { waveFile, maximumWavBytes } from '../optional-extensions/speech-synthesis/lib/wav.mjs';
import { emptyServices } from '../optional-extensions/speech-synthesis/ui/providers.mjs';

function settings(extraProfile = {}) {
  const services = emptyServices();
  services.tts = {
    entry: 'gpt-sovits',
    method: 'local',
    profiles: { 'gpt-sovits/local': { refAudio: 'voices/sample.wav', promptText: '示例', ...extraProfile } },
  };
  services.owners.tts = { entry: 'openai' };
  return { services, timeoutMs: 3000, voiceMode: 'separate', recognitionModel: '', ttsKey: 'previous-provider-secret' };
}

test('local GPT-SoVITS uses the normal plugin synthesize action and returns 16 kHz WAV to the host', async t => {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({
      route: request.url,
      method: request.method,
      auth: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'Content-Type': 'audio/wav' });
    response.end(waveFile(Buffer.alloc(6400), 32000));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const actions = new Map();
  setup({
    registerAction(action) {
      actions.set(action.id, action);
    },
  });
  const options = settings({
    endpoint: 'http://127.0.0.1:' + server.address().port,
    promptLang: 'zh',
    textLang: 'en',
    speed: 1.2,
  });
  const { ok } = await actions.get('validate').execute({ settings: options }, { settings: options });
  assert.equal(ok, true);
  const audio = [];
  const result = await actions
    .get('synthesize')
    .execute({ settings: options, audio: { write: b64 => audio.push(Buffer.from(b64, 'base64')) } }, { text: 'Hello' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      route: '/tts',
      method: 'POST',
      auth: undefined,
      body: {
        text: 'Hello',
        text_lang: 'en',
        ref_audio_path: 'voices/sample.wav',
        prompt_text: '示例',
        prompt_lang: 'zh',
        speed_factor: 1.2,
        text_split_method: 'cut2',
        media_type: 'wav',
        streaming_mode: false,
      },
    },
  ]);
  assert.deepEqual(Buffer.concat(audio), waveFile(Buffer.alloc(3200)));
});

test('only local GPT-SoVITS addresses and local reference paths reach the transport', async () => {
  const options = { fetchImpl: assert.fail };
  for (const endpoint of ['https://example.org', 'http://127.0.0.1:9880/control', 'http://user@127.0.0.1:9880']) {
    await assert.rejects(synthesizeText(settings({ endpoint }), 'Hello', options), /VOICE_GPT_SOVITS_ENDPOINT/);
  }
  for (const refAudio of ['', '\\\\server\\voice.wav', 'file:///voice.wav', 'https://example.org/voice.wav']) {
    await assert.rejects(synthesizeText(settings({ refAudio }), 'Hello', options), /VOICE_GPT_SOVITS_REFERENCE/);
  }
  await assert.rejects(synthesizeText(settings({ speed: 9 }), 'Hello', options), /VOICE_GPT_SOVITS_CONFIG/);
});

test('GPT-SoVITS redirects cannot relay chat text and malformed or oversized WAV is rejected', async () => {
  await assert.rejects(
    synthesizeText(settings(), 'Hello', {
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, 'error');
        return new Response('not audio', { headers: { 'Content-Type': 'audio/wav' } });
      },
    }),
    /VOICE_TTS_INVALID_AUDIO/,
  );
  await assert.rejects(
    synthesizeText(settings(), 'Hello', {
      fetchImpl: async () => new Response('', { headers: { 'Content-Length': String(maximumWavBytes + 1) } }),
    }),
    /VOICE_TTS_TOO_LARGE/,
  );
});
