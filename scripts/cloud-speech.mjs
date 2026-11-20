import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpeechProviders, readSpeechProviderView } from './speech-provider-settings.mjs';
import { inspectWav, splitVoiceText } from './voice-synthesis.mjs';
import { maximumWavBytes, normalizeWav, waveFile } from './cloud-speech-wav.mjs';

const fail = code => Object.assign(new Error(code), { code });
const maxAsrBytes = 300 * 24000 * 2 + 4096;
const cloudVerification = 'cloud-audio-response';

async function boundedBytes(body, maximum, code) {
  if (!body) throw fail(code);
  const buffers = [];
  let total = 0;
  for await (const bytes of body) {
    total += bytes.length;
    if (total > maximum) throw fail(code);
    buffers.push(Buffer.from(bytes));
  }
  return Buffer.concat(buffers, total);
}

async function postAudioApi(provider, body, contentType, maximum, { signal, fetchImpl = fetch } = {}) {
  if (provider.mode !== 'cloud') throw fail('VOICE_CLOUD_DISABLED');
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
  const timeout = AbortSignal.timeout(65000);
  try {
    const response = await fetchImpl(provider.endpoint, {
      method: 'POST', redirect: 'error', headers, body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw fail('VOICE_CLOUD_AUTH_FAILED');
      throw fail('VOICE_CLOUD_REQUEST_FAILED');
    }
    if (Number(response.headers.get('content-length')) > maximum) {
      await response.body?.cancel();
      throw fail('VOICE_CLOUD_RESPONSE_LIMIT');
    }
    return await boundedBytes(response.body, maximum, 'VOICE_CLOUD_RESPONSE_LIMIT');
  } catch (error) {
    if (signal?.aborted) throw fail('VOICE_ABORTED');
    if (timeout.aborted) throw fail('VOICE_CLOUD_TIMEOUT');
    if (['VOICE_CLOUD_AUTH_FAILED', 'VOICE_CLOUD_RESPONSE_LIMIT', 'VOICE_CLOUD_REQUEST_FAILED'].includes(error?.code)) throw error;
    // Provider error bodies and exception messages may contain credentials or chat text.
    throw fail('VOICE_CLOUD_REQUEST_FAILED');
  }
}

export async function synthesizeCloud(provider, text, options = {}) {
  const parts = splitVoiceText(text);
  const voiceId = crypto.createHash('sha256').update(JSON.stringify(['cloud-tts-v1', provider.endpoint, provider.model, provider.voice])).digest('hex');
  const segments = [];
  let totalBytes = 0, durationMs = 0;
  for (const part of parts) {
    if (options.canSynthesize && !options.canSynthesize()) throw fail('VOICE_CLOUD_SELECTION_CHANGED');
    const bytes = await postAudioApi(provider, JSON.stringify({ model: provider.model, voice: provider.voice, input: part, response_format: 'wav' }), 'application/json', maximumWavBytes, options);
    let pcm;
    try { ({ pcm } = normalizeWav(bytes)); } catch { throw fail('VOICE_CLOUD_WAV_INVALID'); }
    const audio = waveFile(pcm);
    const format = inspectWav(audio);
    totalBytes += audio.length;
    if (totalBytes > 128 * 1024 * 1024) throw fail('VOICE_CLOUD_RESPONSE_LIMIT');
    durationMs += format.durationMs;
    segments.push({ text: part, audio, format, durationMs: format.durationMs, voiceId, modelVerification: cloudVerification });
  }
  return { segments, durationMs, voiceId, modelId: provider.model, modelVerification: cloudVerification };
}

export async function synthesizeConfigured({root, text, signal, canSynthesize, synthesizeLocal}) {
  const settings = readSpeechProviders({root, capability:'tts'});
  if (settings.tts.mode === 'local') return synthesizeLocal(text, {signal});
  const stillSelected = () => {
    const current = readSpeechProviderView({root}).tts;
    return (!canSynthesize || canSynthesize()) && ['mode','endpoint','model','voice'].every(key=>current[key]===settings.tts[key]);
  };
  return synthesizeCloud(settings.tts, text, {signal, canSynthesize:stillSelected});
}

export async function transcribeCloud(provider, audio, options = {}) {
  if (!Buffer.isBuffer(audio) || audio.length > maxAsrBytes) throw fail('MEDIA_CLOUD_AUDIO_INVALID');
  const format = inspectWav(audio);
  if (format.encoding !== 'pcm' || format.bitsPerSample !== 16 || format.channels !== 1 || ![16000, 24000].includes(format.sampleRate) || format.durationMs > 300000) throw fail('MEDIA_CLOUD_AUDIO_INVALID');
  const form = new FormData();
  form.set('model', provider.model);
  form.set('response_format', 'json');
  form.set('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
  const response = await postAudioApi(provider, form, null, 256 * 1024, options);
  let text;
  try { ({ text } = JSON.parse(response.toString('utf8'))); } catch { throw fail('MEDIA_CLOUD_TRANSCRIPT_INVALID'); }
  if (typeof text !== 'string' || text.length > 12000 || text.includes('\0')) throw fail('MEDIA_CLOUD_TRANSCRIPT_INVALID');
  text = text.trim();
  return { status: text ? 'ready' : 'no_speech', text, segments: [], automated: true, engine: 'cloud-asr' };
}

// Private Reader child. Only decoded PCM WAV travels over stdin. Look up the
// current credential here so neither command lines nor media replies carry it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--transcribe' || !/^[a-f0-9]{64}$/.test(process.argv[3])) throw fail('MEDIA_CLOUD_ARGUMENTS_INVALID');
    const audio = await boundedBytes(process.stdin, maxAsrBytes, 'MEDIA_CLOUD_AUDIO_INVALID');
    const settings = readSpeechProviders({ root: process.cwd(), capability: 'asr' });
    const selection = crypto.createHash('sha256').update(['asr-v1',settings.asr.endpoint,settings.asr.model].join('\0')).digest('hex');
    if (selection !== process.argv[3] || settings.asr.mode !== 'cloud') throw fail('MEDIA_CLOUD_SETTINGS_CHANGED');
    console.log(JSON.stringify(await transcribeCloud(settings.asr, audio)));
  } catch (error) {
    const code = /^[A-Z_]{3,64}$/.test(error?.code ?? '') ? error.code : 'MEDIA_CLOUD_TRANSCRIPTION_FAILED';
    process.stderr.write(code); process.exitCode = 1;
  }
}
