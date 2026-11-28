// The browser, Node validator and Python service use this same field contract.
import fields from './local-model-fields.json' with { type: 'json' };
export const MODEL_FIELDS = fields;
export const VOICE_PARAMETERS = Object.fromEntries(
  MODEL_FIELDS.tts
    .filter(field => field.min !== undefined)
    .map(({ key, min, max, default: value }) => [key, [min, max, value]]),
);
export const modelDefaults = kind =>
  Object.fromEntries(MODEL_FIELDS[kind].map(field => [field.key, field.default ?? '']));
