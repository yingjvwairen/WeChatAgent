import { failureMessages, responseBytes } from './service.mjs';
import { maximumWavBytes, normalizeWav } from './wav.mjs';
import { localSpeechEndpoint } from '../ui/providers.mjs';

export function validateLocalVoice(profile) {
  if (!localSpeechEndpoint(profile.endpoint)) throw Error('VOICE_GPT_SOVITS_ENDPOINT');
  const reference = typeof profile.refAudio === 'string' ? profile.refAudio.trim() : '';
  const uri = /^[a-z][a-z\d+.-]*:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference);
  if (
    !reference ||
    reference.length > 2048 ||
    /[\x00-\x1f]/.test(reference) ||
    /^[/\\]{2}/.test(reference) ||
    uri ||
    typeof profile.promptText !== 'string' ||
    profile.promptText.length > 4000 ||
    profile.promptText.includes('\0')
  ) {
    throw Error('VOICE_GPT_SOVITS_REFERENCE');
  }
  if (
    ![profile.promptLang, profile.textLang].every(value => typeof value === 'string' && /^[a-z_]{1,32}$/.test(value)) ||
    !Number.isFinite(profile.speed) ||
    profile.speed < 0.5 ||
    profile.speed > 2
  )
    throw Error('VOICE_GPT_SOVITS_CONFIG');
}

export async function synthesizeLocalVoice(service, text, { signal, fetchImpl = fetch } = {}) {
  const profile = service.profile;
  const timeout = AbortSignal.timeout(service.flat.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const response = await fetchImpl(localSpeechEndpoint(profile.endpoint), {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({
        text,
        text_lang: profile.textLang,
        ref_audio_path: profile.refAudio.trim(),
        prompt_text: profile.promptText,
        prompt_lang: profile.promptLang,
        speed_factor: profile.speed,
        text_split_method: 'cut2',
        media_type: 'wav',
        streaming_mode: false,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('VOICE_TTS_HTTP');
    }
    return normalizeWav(await responseBytes(response, maximumWavBytes), 16000, { maxSeconds: 1024 });
  } catch (error) {
    if (requestSignal.aborted) throw Error('VOICE_TTS_TIMEOUT');
    if (Object.hasOwn(failureMessages, error.message)) throw error;
    throw Error('VOICE_TTS_NETWORK');
  }
}
