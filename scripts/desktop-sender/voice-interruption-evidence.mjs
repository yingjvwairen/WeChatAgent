import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const facts = Object.freeze({
  ok: false,
  recordingAttempted: true,
  captureSessionBound: true,
  submitAttempted: false,
  submitInputApplied: false,
  cancelAttempted: true,
  cancelInputApplied: true,
  recordingEndedObserved: true,
  recordingPossible: false,
  stopBarrier: false,
  systemSettingsChanged: false,
});
const reasons = new Set(['DRAFT_HUMAN_ACTIVITY_CHANGED', 'VOICE_BACKGROUND_WECHAT_ACTIVATED']);
function identity(binding) {
  if (
    !object(binding) ||
    ![binding.id, binding.audioSha256, binding.voiceId].every(digest) ||
    typeof binding.account !== 'string' ||
    !binding.account ||
    typeof binding.target !== 'string' ||
    !binding.target
  )
    return null;
  return {
    version: 1,
    attemptId: binding.id,
    audioSha256: binding.audioSha256,
    voiceId: binding.voiceId,
    accountSha256: hash(binding.account),
    targetSha256: hash(binding.target),
  };
}
/** A cancelled recording is different from an unattempted send. Only these
 * complete native facts allow a new attempt; the old ID stays query-only. */
export function voiceInterruptionFacts(native) {
  if (
    !object(native) ||
    !reasons.has(native.reason) ||
    !Object.entries(facts).every(([key, value]) => native[key] === value)
  )
    return undefined;
  return { reason: native.reason, ...facts };
}
export function validVoiceInterruptionFacts(value) {
  const expected = voiceInterruptionFacts(value);
  return Boolean(
    expected &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, entry]) => value[key] === entry),
  );
}
export function voiceInterruptionEvidence(native, binding) {
  const bound = identity(binding),
    cancelled = voiceInterruptionFacts(native);
  if (!bound || !cancelled) return undefined;
  return { ...bound, ...cancelled };
}
export function validVoiceInterruptionEvidence(value, binding) {
  const expected = voiceInterruptionEvidence(value, binding);
  return Boolean(
    expected &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, entry]) => value[key] === entry),
  );
}

/** A complete cancellation following a structural/pre-submit failure is
 * terminal. Unlike a verified human interruption it grants no retry. */
export function voiceRecordingCancellationEvidence(native, binding) {
  const bound = identity(binding);
  if (
    !bound ||
    !object(native) ||
    reasons.has(native.reason) ||
    !/^(VOICE|DRAFT|AUDIO)_[A-Z0-9_]{1,80}$/.test(native.reason ?? '') ||
    native.captureVerified !== true ||
    !Object.entries(facts).every(([key, value]) => native[key] === value)
  )
    return undefined;
  return {
    ...bound,
    kind: 'native-recording-cancelled-v1',
    reason: native.reason,
    ...facts,
    captureVerified: true,
    routeSafe: true,
  };
}
export function validVoiceRecordingCancellationEvidence(value, binding) {
  const expected = voiceRecordingCancellationEvidence(value, binding);
  return Boolean(
    expected &&
    value.routeSafe === true &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, entry]) => value[key] === entry),
  );
}
