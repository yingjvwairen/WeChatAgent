import schema from './local-model-fields.json' with { type: 'json' };

export const maxAutomaticVoiceChars = schema.speechLimits.maxAutomaticVoiceChars;

export function suitableForAutomaticVoice(text) {
  return (
    typeof text === 'string' &&
    [...text].length <= maxAutomaticVoiceChars &&
    !/(?:https?:\/\/|www\.|`|~{3,})/iu.test(text)
  );
}
