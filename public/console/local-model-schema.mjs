export { MODEL_FIELDS, VOICE_PARAMETERS, modelDefaults } from '../../packages/speech-contract/model-schema.mjs';

// Drafts survive page replacement; their original revision remains the save
// precondition so navigating does not overwrite a concurrent model edit.
export function createLocalModelDrafts(onChange = () => {}) {
  const entries = new Map();
  return {
    get: kind => entries.get(kind),
    hasDraft: () => entries.size > 0,
    set(kind, value) {
      entries.set(kind, structuredClone(value));
      onChange();
    },
    clear(kind) {
      entries.delete(kind);
      onChange();
    },
    discard() {
      entries.clear();
      onChange();
    },
    async save(api) {
      let count = 0;
      for (const [kind, draft] of entries) {
        const profiles = { ...draft.saved.profiles, [draft.id]: draft.profile };
        await api('/api/local-models/profiles', { kind, profiles, revision: draft.saved.revision });
        if (entries.get(kind) === draft) entries.delete(kind);
        count++;
      }
      onChange();
      return count;
    },
  };
}
