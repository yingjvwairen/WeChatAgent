// @ts-check
/** @typedef {import('./qt-visual-driver.mjs').QtVisualDriver} Driver */
// Each session sees only the driver state and commands it uses. Reads stay live when a client or frame is renewed.
/**
 * @template {keyof Driver} K
 * @param {Driver} owner
 * @param {readonly K[]} names
 * @returns {Readonly<Pick<Driver,K>>}
 */
function view(owner, names) {
  const access = Object.create(null);
  for (const name of names) {
    const member =
      typeof owner[name] === 'function'
        ? { value: (...args) => Reflect.apply(owner[name], owner, args) }
        : { get: () => owner[name] };
    Object.defineProperty(access, name, member);
  }
  return Object.freeze(access);
}
const shared = /** @type {const} */ ([
  'checkJob',
  'nativeOwner',
  'controlVerificationPolicy',
  'current',
  'now',
  'requestNative',
  'verifyControlBinding',
]);
const navigation = /** @type {const} */ ([
  ...shared,
  'active',
  'allowClipboardReplacement',
  'appliedPaste',
  'draftHold',
  'operationSignal',
  'resolveTarget',
  'sharedAction',
  'sharedDraftResume',
  'wait',
]);
export const navigationAccess = owner => view(owner, navigation);
const attachment = /** @type {const} */ ([
  ...shared,
  'active',
  'allowClipboardReplacement',
  'allowSubmit',
  'beginImageSubmission',
  'beginOperation',
  'busy',
  'closed',
  'config',
  'discardDraft',
  'freshAccount',
  'holdDraft',
  'imageSubmitAttempted',
  'invalidateNavigation',
  'rememberImageDraft',
  'rememberPausedImage',
  'rememberResumedImage',
  'recognize',
  'refuseImageSubmission',
  'resetInputSession',
  'root',
  'textResume',
]);
export const attachmentAccess = owner => view(owner, attachment);
const voice = /** @type {const} */ ([
  ...shared,
  'beginOperation',
  'busy',
  'inspectEmptyDraftPhase',
  'prepare',
  'probeAccount',
  'root',
  'verifyControls',
  'warmRecognition',
]);
export const voiceAccess = owner => view(owner, voice);
