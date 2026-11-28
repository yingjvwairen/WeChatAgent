import crypto from 'node:crypto';
import { sanitizeForegroundIntervals } from './foreground-timing.mjs';
import { validateVoiceRecordingLayout } from './voice-recording-layout.mjs';
import path from 'node:path';
import fs from 'node:fs';

const fault = (code, properties = {}) => Object.assign(new Error(code), { code, ...properties });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pasteCommands = new Set(['paste', 'pasteImage', 'pasteFile', 'pasteUiaFile', 'pasteUiaImage']);
function clipboardSettled(report, allowReplacement) {
  if (report?.clipboardRestored === true) return report.clipboardReplaced !== true;
  return allowReplacement === true && report?.clipboardRestored === false && report.clipboardReplaced === true;
}
export function appliedPasteResult(result, text, revision, allowReplacement) {
  if (
    result?.performed !== true ||
    result.attempted !== true ||
    result.pasteApplied !== true ||
    result.readbackPerformed !== false ||
    result.intendedText !== text ||
    !clipboardSettled(result, allowReplacement) ||
    typeof result.interrupted !== 'boolean' ||
    !Number.isSafeInteger(revision) ||
    result.revision !== revision ||
    result.clipboardConsumerConfirmed !== true
  )
    throw fault('UI_QT_PASTE_UNCONFIRMED');
  return result;
}
const preparedTargetLookup = Symbol('qt-prepared-target-lookup');
const observedLayout = config => config.layoutMode === 'adaptive-v1' || config.layoutMode === 'uia-v1';
const sharedTargetProof = proof => ['database-query-search-enter-v1', 'uia-database-title-v1'].includes(proof?.kind);
const uiaTargetEvidence = lookup =>
  lookup?.uiaTarget?.version === 1 &&
  ['database-unique-display-name-v1', 'database-exact-search-v1'].includes(lookup.uiaTarget.proof) &&
  /^[a-f0-9]{64}$/.test(lookup.uiaTarget.titleSha256) &&
  lookup.uiaTarget.querySha256 === crypto.createHash('sha256').update(lookup.displayedId).digest('hex');
const sharedVoicePreparation = Symbol('qt-shared-voice-preparation');
const navigationTransitionFailure = Symbol('qt-navigation-transition-failure');
const uiaVerificationRefusal = Symbol('qt-uia-verification-refusal');
function markUiaVerificationRefusal(error, operation, { hadTextLease, hadVoiceLease, returned }) {
  if (
    !/^UIA_MODE_[A-Z0-9_]{1,70}$/.test(error?.code ?? '') ||
    /CLEANUP_UNCONFIRMED|STOP_UNCONFIRMED|RECORDING_POSSIBLE/.test(error.code) ||
    error.controlsCleanupFailed ||
    hadVoiceLease ||
    !['prepare', 'navigation-ready', 'navigation-continuation'].includes(operation)
  )
    return error;
  const restored = returned?.released === true && returned.restored === true && returned.skipped === false;
  const unborrowed =
    (returned?.inPlace === true && returned.released === true) ||
    (!hadTextLease && returned?.released === false && returned.restored === false && returned.skipped === true);
  if (restored || unborrowed)
    error[uiaVerificationRefusal] = { operation, focus: restored ? 'restored' : 'not-borrowed' };
  return error;
}
function markNavigationRefusal(error, focus) {
  if (error?.[navigationTransitionFailure] && error.clipboardRestored !== false && error.popupCleanup?.closed !== false)
    error.navigationRefusal = { version: 1, focus, messageInputAttempted: false };
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nativeLeaseId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
function qtEmptyEditorHashes(layout) {
  if (object(layout) && layout.emptyEditorSha256 === undefined && layout.emptyEditorSha256s === undefined) return [];
  if (!object(layout) || !hash(layout.emptyEditorSha256)) throw fault('UI_QT_EMPTY_TEMPLATES_INVALID');
  const variants = layout.emptyEditorSha256s;
  if (
    variants !== undefined &&
    (!Array.isArray(variants) ||
      variants.length < 1 ||
      variants.length > 4 ||
      variants.some(value => !hash(value)) ||
      new Set(variants).size !== variants.length)
  )
    throw fault('UI_QT_EMPTY_TEMPLATES_INVALID');
  const combined = [...new Set([layout.emptyEditorSha256, ...(variants ?? [])])];
  if (combined.length > 4) throw fault('UI_QT_EMPTY_TEMPLATES_INVALID');
  return combined;
}
function qtEmptyEditorPhaseMatches(before, after, verifiedHashes) {
  return (
    hash(before) &&
    hash(after) &&
    Array.isArray(verifiedHashes) &&
    verifiedHashes.length > 0 &&
    verifiedHashes.length <= 4 &&
    verifiedHashes.every(hash) &&
    new Set(verifiedHashes).size === verifiedHashes.length &&
    verifiedHashes.includes(before) &&
    verifiedHashes.includes(after)
  );
}
function validateQtEmptyDraftPhaseProof(value, editorRect, verifiedHashes) {
  if (value === undefined) return undefined;
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    value.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(value.id ?? '') ||
    !rect(value.editorRect) ||
    Object.keys(value.editorRect).length !== 4 ||
    !sameRect(value.editorRect, editorRect) ||
    !Array.isArray(value.knownEmptySha256s) ||
    value.knownEmptySha256s.length !== verifiedHashes.length ||
    value.knownEmptySha256s.some(item => !hash(item)) ||
    new Set(value.knownEmptySha256s).size !== value.knownEmptySha256s.length ||
    value.knownEmptySha256s.some(item => !verifiedHashes.includes(item))
  )
    throw fault('UI_QT_EMPTY_PHASE_PROOF_INVALID');
  return structuredClone(value);
}
function validateQtEmptyDraftPhase(value, proof, frame) {
  const actual = frame?.regions?.find(region => sameRect(region.rect, proof?.editorRect))?.rgbaSha256;
  if (
    !object(proof) ||
    !Array.isArray(proof.knownEmptySha256s) ||
    !object(value) ||
    Object.keys(value).length !== 9 ||
    value.version !== 1 ||
    value.emptyDraftPhaseVerified !== true ||
    value.proofId !== proof?.id ||
    value.readOnly !== true ||
    value.inputSent !== false ||
    value.revision !== frame?.revision ||
    !hash(value.actualRgbaSha256) ||
    value.actualRgbaSha256 !== actual ||
    !hash(value.normalizedRgbaSha256) ||
    !proof.knownEmptySha256s.includes(value.normalizedRgbaSha256) ||
    typeof value.caretRemoved !== 'boolean' ||
    (value.caretRemoved
      ? value.actualRgbaSha256 === value.normalizedRgbaSha256
      : value.actualRgbaSha256 !== value.normalizedRgbaSha256)
  )
    throw fault('UI_QT_EMPTY_PHASE_UNVERIFIED');
  return structuredClone(value);
}
const positiveDecimal = value =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
function validForegroundLease(value) {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    value.version === 1 &&
    Number.isSafeInteger(value.startedAtTickMs) &&
    value.startedAtTickMs > 0 &&
    typeof value.includesContactNavigation === 'boolean'
  );
}
function validUiaPointerDelivery(value, scope) {
  return (
    object(value) &&
    Object.keys(value).length === 8 &&
    value.version === 1 &&
    value.method === 'window-message-v1' &&
    value.scope === scope &&
    value.messagesPosted === 3 &&
    value.queueAccepted === true &&
    value.systemCursorMovementRequested === false &&
    value.cursorUnchanged === true &&
    value.completion === (scope === 'editor-focus' ? 'uia-focus' : 'receipt-pending')
  );
}
function uiaEditorFocusReused(value) {
  return (
    value?.performed === true &&
    value.attempted === false &&
    value.inputSent === false &&
    value.editorFocused === true &&
    value.editorFocusReused === true &&
    value.pointerDelivery === null
  );
}
function incompleteForegroundInterval(value) {
  const intervals = sanitizeForegroundIntervals([value], {
    phases: ['contact-navigation', 'preparation'],
    maxCount: 1,
  });
  return intervals ? { ...intervals[0], complete: false } : undefined;
}
function validFocusHandoff(value) {
  const w = value?.returnWindow;
  return (
    object(value) &&
    Object.keys(value).every(key => ['version', 'returnWindow', 'activation', 'foregroundLease'].includes(key)) &&
    value.version === 1 &&
    object(w) &&
    Object.keys(w).length === 3 &&
    positiveDecimal(w.hwnd) &&
    positiveDecimal(w.processCreatedFileTimeUtc) &&
    Number.isSafeInteger(w.pid) &&
    w.pid > 0 &&
    w.pid <= 0xffffffff &&
    (value.activation === undefined ||
      (object(value.activation) &&
        Object.keys(value.activation).length === 2 &&
        validFocusActivation(value.activation))) &&
    (value.foregroundLease === undefined || validForegroundLease(value.foregroundLease))
  );
}
function validForegroundSession(value) {
  const keys = [
    'version',
    'inPlace',
    'sessionId',
    'window',
    'revision',
    'activated',
    'inputSent',
    'focusChanged',
    'clipboardAccessed',
  ];
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key)) &&
    value.version === 1 &&
    value.inPlace === true &&
    /^[a-f0-9]{32}$/.test(value.sessionId ?? '') &&
    validFocusHandoff({ version: 1, returnWindow: value.window }) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    value.activated === false &&
    value.inputSent === false &&
    value.focusChanged === false &&
    value.clipboardAccessed === false
  );
}
function validForegroundSessionRelease(value, sessionId) {
  const keys = [
    'version',
    'inPlace',
    'sessionId',
    'released',
    'restored',
    'skipped',
    'inputSent',
    'focusChanged',
    'clipboardAccessed',
    'identitiesUnchanged',
    'foregroundOwnedByWechat',
    'activityUnchanged',
  ];
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key)) &&
    value.version === 1 &&
    value.inPlace === true &&
    value.sessionId === sessionId &&
    value.released === true &&
    value.restored === false &&
    value.skipped === true &&
    value.inputSent === false &&
    value.focusChanged === false &&
    value.clipboardAccessed === false &&
    ['identitiesUnchanged', 'foregroundOwnedByWechat', 'activityUnchanged'].every(
      key => typeof value[key] === 'boolean',
    )
  );
}
function transferredFocusValidation(value, frame, originalHandoff, now) {
  const c = value?.cleanup,
    w = c?.wechatWindow,
    r = c?.returnWindow,
    returned = value?.focusHandoff?.returnWindow,
    original = originalHandoff?.returnWindow;
  const matches = (a, b) =>
    object(a) && object(b) && ['hwnd', 'pid', 'processCreatedFileTimeUtc'].every(key => a[key] === b[key]);
  const timestampValid = Number.isSafeInteger(c?.issuedAtMs) && c.issuedAtMs > 0,
    age = timestampValid ? now - c.issuedAtMs : null;
  const result = {
    version: 1,
    transferred: value?.transferred === true,
    handoffValid: validFocusHandoff(value?.focusHandoff),
    revisionMatches: value?.revision === frame?.revision,
    cleanupShapeValid:
      object(c) &&
      Object.keys(c).length === 5 &&
      c.version === 1 &&
      validFocusHandoff({ version: 1, returnWindow: w }) &&
      validFocusHandoff({ version: 1, returnWindow: r }),
    wechatMatchesFrame: matches(w, frame?.binding),
    returnMatchesOriginal: matches(r, original),
    returnMatchesHandoff: matches(r, returned),
    handoffMatchesOriginal: matches(returned, original),
    distinctProcesses: object(w) && object(r) && r.pid !== w.pid,
    lastInputTickValid: Number.isSafeInteger(c?.lastInputTick) && c.lastInputTick >= 0 && c.lastInputTick <= 0xffffffff,
    // Native UTC and V8's clock can straddle a Windows clock tick. The native
    // owner still enforces its monotonic lease, identity and input generation.
    timestampValid,
    ageValid: timestampValid && age >= -16 && age <= 30000,
    ageMs: Number.isSafeInteger(age) && Math.abs(age) <= 60000 ? age : null,
  };
  // Cleanup is a separate capability. Its native endpoint rechecks expiry,
  // both process identities and the actual last-input tick before restoring.
  result.cleanupAvailable =
    result.transferred &&
    result.cleanupShapeValid &&
    result.wechatMatchesFrame &&
    result.returnMatchesOriginal &&
    result.distinctProcesses &&
    result.lastInputTickValid &&
    result.timestampValid;
  result.valid =
    result.cleanupAvailable &&
    result.handoffValid &&
    result.revisionMatches &&
    result.returnMatchesHandoff &&
    result.handoffMatchesOriginal &&
    result.ageValid;
  return result;
}
const id = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const alias = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const rect = value =>
  object(value) &&
  ['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(value[key])) &&
  value.left >= 0 &&
  value.top >= 0 &&
  value.right > value.left &&
  value.bottom > value.top;
function validVoiceLayout(voice, layout, uia = false) {
  if (
    !object(voice) ||
    !object(layout) ||
    (voice.mouseParkRect === undefined && (!uia || !object(voice.recordingUi?.uia)))
  )
    return false;
  try {
    validateVoiceRecordingLayout({
      recordingUi: voice.recordingUi,
      clientRect: { left: 0, top: 0, right: layout.width, bottom: layout.height },
      recordStartRect: voice.recordStartRect,
      ...(voice.mouseParkRect !== undefined ? { mouseParkRect: voice.mouseParkRect } : {}),
      editorRect: layout.editor,
      dpi: layout.dpi,
      allowSameFocus: true,
    });
    return true;
  } catch {
    return false;
  }
}
const inside = (outer, inner) =>
  inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
const sameRect = (a, b) => object(a) && object(b) && ['left', 'top', 'right', 'bottom'].every(key => a[key] === b[key]);
const sameHeaderView = (first, second) =>
  first.revision === second.revision &&
  first.epoch === second.epoch &&
  first.regions[0].rgbaSha256 === second.regions[0].rgbaSha256 &&
  ['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi'].every(
    key => first.binding[key] === second.binding[key],
  ) &&
  sameRect(first.binding.captureRect, second.binding.captureRect);
const validFocusActivation = (value, width = 4096) =>
  rect(value?.rect) &&
  ((hash(value.rgbaSha256) && value.mode === undefined) ||
    (['blank-caption-v1', 'uia-caption-v1'].includes(value.mode) && value.rgbaSha256 === undefined)) &&
  value.rect.left >= 160 &&
  value.rect.right <= width - 160 &&
  value.rect.bottom <= 48 &&
  value.rect.right - value.rect.left >= 20 &&
  value.rect.right - value.rect.left <= 200 &&
  value.rect.bottom - value.rect.top >= 8 &&
  value.rect.bottom - value.rect.top <= 40;
const validPointerParkRect = (value, width) =>
  rect(value) &&
  Object.keys(value).length === 4 &&
  value.left >= 160 &&
  value.right <= width - 160 &&
  value.bottom <= 48 &&
  value.right - value.left >= 20 &&
  value.right - value.left <= 200 &&
  value.bottom - value.top >= 8 &&
  value.bottom - value.top <= 40;
function validatePopupCalibration(value, kind) {
  const bounds = value?.windowRect;
  if (
    !object(value) ||
    Object.keys(value).length !==
      (Object.hasOwn(value, 'heightVariants') || Object.hasOwn(value, 'heightRange') ? 11 : 10) ||
    value.version !== 1 ||
    value.kind !== kind ||
    typeof value.className !== 'string' ||
    value.className.length < 1 ||
    value.className.length > 256 ||
    /[\0\r\n]/u.test(value.className) ||
    !['root-owned', 'same-thread-unowned'].includes(value.ownerRelation) ||
    !Number.isSafeInteger(value.ownerDepth) ||
    (value.ownerRelation === 'root-owned' ? value.ownerDepth < 1 || value.ownerDepth > 16 : value.ownerDepth !== 0) ||
    !['clientWidth', 'clientHeight'].every(
      key => Number.isSafeInteger(value[key]) && value[key] >= 20 && value[key] <= 4096,
    ) ||
    !['style', 'extendedStyle'].every(
      key => Number.isSafeInteger(value[key]) && value[key] >= -2147483648 && value[key] <= 4294967295,
    ) ||
    !object(bounds) ||
    Object.keys(bounds).length !== 4 ||
    !['left', 'top', 'right', 'bottom'].every(
      key => Number.isSafeInteger(bounds[key]) && bounds[key] >= -32768 && bounds[key] <= 32768,
    ) ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top ||
    bounds.right - bounds.left > 4096 ||
    bounds.bottom - bounds.top > 4096
  )
    throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  if (
    Object.hasOwn(value, 'heightVariants') &&
    (kind !== 'search' ||
      !Array.isArray(value.heightVariants) ||
      value.heightVariants.length < 1 ||
      value.heightVariants.length > 4 ||
      new Set(value.heightVariants).size !== value.heightVariants.length ||
      value.heightVariants.some(n => !Number.isInteger(n) || n < 20 || n > 4096) ||
      bounds.bottom - bounds.top !== value.clientHeight)
  )
    throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  if (
    Object.hasOwn(value, 'heightRange') &&
    (kind !== 'search' ||
      !object(value.heightRange) ||
      Object.keys(value.heightRange).length !== 2 ||
      !Number.isInteger(value.heightRange.min) ||
      !Number.isInteger(value.heightRange.max) ||
      value.heightRange.min < 20 ||
      value.heightRange.max > 4096 ||
      value.heightRange.min > value.clientHeight ||
      value.heightRange.max < value.clientHeight ||
      bounds.bottom - bounds.top !== value.clientHeight)
  )
    throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  return value;
}
const popupIdentityFields = ['version', 'kind', 'className', 'ownerRelation', 'ownerDepth', 'style', 'extendedStyle'];
function toObservedPopupCalibration(value, kind) {
  if (!object(value)) throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  if (Object.keys(value).length !== 7) {
    validatePopupCalibration(value, kind);
    value = Object.fromEntries(popupIdentityFields.map(key => [key, value[key]]));
  }
  if (
    Object.keys(value).some(key => !popupIdentityFields.includes(key)) ||
    value.version !== 1 ||
    value.kind !== kind ||
    !['profile', 'search'].includes(kind) ||
    typeof value.className !== 'string' ||
    value.className.length < 1 ||
    value.className.length > 256 ||
    /[\0\r\n]/u.test(value.className) ||
    !['root-owned', 'same-thread-unowned'].includes(value.ownerRelation) ||
    !Number.isSafeInteger(value.ownerDepth) ||
    (value.ownerRelation === 'root-owned' ? value.ownerDepth < 1 || value.ownerDepth > 16 : value.ownerDepth !== 0) ||
    !['style', 'extendedStyle'].every(
      key => Number.isSafeInteger(value[key]) && value[key] >= -2147483648 && value[key] <= 4294967295,
    )
  )
    throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  return structuredClone(value);
}
const noLinks = file => {
  for (let at = path.resolve(file); ;) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_QT_LINK_REFUSED');
    const parent = path.dirname(at);
    if (parent === at) return path.resolve(file);
    at = parent;
  }
};
const regions = [
  'header',
  'search',
  'firstResult',
  'profileOpen',
  'profileAlias',
  'profileClose',
  'selfOpen',
  'selfAlias',
  'selfClose',
  'editor',
  'send',
];
function validConversationFingerprint(value) {
  return (
    object(value) &&
    Object.keys(value).length === 7 &&
    value.version === 1 &&
    value.scope === 'chat-title-text-v1' &&
    value.targetVerified === false &&
    ['sha256', 'headerRuntimeIdSha256', 'titleRuntimeIdSha256'].every(key => hash(value[key])) &&
    Number.isInteger(value.textNodeCount) &&
    value.textNodeCount >= 1 &&
    value.textNodeCount <= 4
  );
}
function validUiaImageProof(value, image) {
  return (
    object(value) &&
    Object.keys(value).length === 4 &&
    value.version === 1 &&
    /^[a-f0-9]{32}$/.test(value.id ?? '') &&
    hash(value.imageSha256) &&
    value.imageSha256 === image?.sha256 &&
    value.imageFormat === (image.format === 'file' ? 'file' : image.format === 'gif' ? 'gif' : 'static')
  );
}
const codeFor = error =>
  /^(?:UI_|UIA_MODE_|QT_|DRAFT_|CONTACT_IDENTITY_)[A-Z0-9_]{1,80}$/.test(error?.code ?? '')
    ? error.code
    : 'UI_QT_OPERATION_FAILED';
const preparationWaits = new Set([
  'UI_USER_ACTIVE',
  'UI_QT_HUMAN_ACTIVITY_CHANGED',
  'UI_QT_DRAFT_CONFLICT',
  'UI_QT_PARTIAL_DRAFT_RECHECK_REQUIRED',
  'QT_ACTIVITY_WARMUP',
  'QT_USER_ACTIVE',
  'QT_HUMAN_ACTIVITY_CHANGED',
  'QT_PIXELS_CHANGED',
  'QT_OBSERVATION_CHANGED',
  'QT_OBSERVATION_EXPIRED',
  'QT_RETURN_CAPTION_UNAVAILABLE',
  'QT_RETURN_CAPTION_WARMUP',
  'QT_WINDOW_OBSCURED',
  'QT_CLICK_OBSCURED',
  'QT_FOCUS_UNAVAILABLE',
  'QT_POPUP_NOT_OWNED',
  'QT_BINDING_CHANGED',
  'DRAFT_EXECUTABLE_MISMATCH',
  'DRAFT_WINDOW_NOT_FOREGROUND',
  'DRAFT_WINDOW_NOT_VISIBLE',
  'DRAFT_WINDOW_POPUP_ACTIVE',
  'DRAFT_FOCUS_UNAVAILABLE',
  'DRAFT_KEYS_HELD',
  'DRAFT_MENU_OR_MOVE_ACTIVE',
  'DRAFT_DESKTOP_UNAVAILABLE',
  'DRAFT_HUMAN_ACTIVITY_CHANGED',
  'DRAFT_EDITOR_FOCUS_CHANGED',
  'DRAFT_CLIPBOARD_CHANGED',
  'DRAFT_CLIPBOARD_BUSY',
]);
function validateQtConfig(value, { searchOnly = false } = {}) {
  const uia = value?.layoutMode === 'uia-v1';
  if (
    !object(value) ||
    value.version !== 1 ||
    value.backend !== 'qt-visual' ||
    !id(value.account) ||
    !hash(value.accountRef) ||
    (value.accountAlias !== undefined && !alias(value.accountAlias)) ||
    typeof value.executable !== 'string' ||
    !path.isAbsolute(value.executable) ||
    !/(?:^|[\\/])(?:Weixin|WeChat)\.exe$/i.test(value.executable) ||
    typeof value.hwnd !== 'string' ||
    (value.hwnd !== 'auto' && (!/^[1-9][0-9]{0,18}$/.test(value.hwnd) || BigInt(value.hwnd) > 9223372036854775807n)) ||
    typeof value.executableVersion !== 'string' ||
    !/^\d+(\.\d+){3}$/.test(value.executableVersion) ||
    !hash(value.executableSha256) ||
    !object(value.layout) ||
    !Number.isInteger(value.layout.width) ||
    value.layout.width < 600 ||
    value.layout.width > 4096 ||
    !Number.isInteger(value.layout.height) ||
    value.layout.height < 400 ||
    value.layout.height > 4096 ||
    value.layout.width * value.layout.height > 12000000 ||
    !Number.isInteger(value.layout.dpi) ||
    value.layout.dpi < 48 ||
    value.layout.dpi > 768 ||
    (!uia && value.sharedDesktop !== true && !hash(value.layout.emptyEditorSha256)) ||
    !Number.isSafeInteger(value.idleMs) ||
    value.idleMs < 0 ||
    value.idleMs > 300000 ||
    !['windows', 'rapidocr'].includes(value.ocrBackend)
  )
    throw fault('UI_QT_CONFIG_INVALID');
  if (searchOnly) {
    const { width, height, search, pointerParkRect } = value.layout;
    const client = { left: 0, top: 0, right: width, bottom: height };
    if (
      value.sharedDesktop !== true ||
      !['adaptive-v1', 'uia-v1'].includes(value.layoutMode) ||
      !rect(search) ||
      !inside(client, search) ||
      Object.keys(value.layout).some(key => !['width', 'height', 'dpi', 'search', 'pointerParkRect'].includes(key)) ||
      (pointerParkRect !== undefined && !validPointerParkRect(pointerParkRect, width))
    )
      throw fault('UI_QT_SEARCH_LAYOUT_INVALID');
    toObservedPopupCalibration(value.searchPopupCalibration, 'search');
    return structuredClone(value);
  }
  if (uia) {
    const client = { left: 0, top: 0, right: value.layout.width, bottom: value.layout.height };
    if (
      value.focusActivationMode !== 'uia-caption-v1' ||
      !['header', 'search', 'editor', 'send'].every(
        key => rect(value.layout[key]) && inside(client, value.layout[key]),
      ) ||
      Object.keys(value.layout).some(
        key => !['width', 'height', 'dpi', 'header', 'search', 'editor', 'send'].includes(key),
      ) ||
      ['selfSurface', 'profileSurface', 'focusActivation', 'selfCloseKey', 'profileCloseKey'].some(
        key => value[key] !== undefined,
      )
    )
      throw fault('UI_QT_LAYOUT_INVALID');
    if (
      value.layout.send.left < value.layout.editor.right &&
      value.layout.send.right > value.layout.editor.left &&
      value.layout.send.top < value.layout.editor.bottom &&
      value.layout.send.bottom > value.layout.editor.top
    )
      throw fault('UI_QT_LAYOUT_INVALID');
    toObservedPopupCalibration(value.searchPopupCalibration, 'search');
    if (value.voice !== undefined && !validVoiceLayout(value.voice, value.layout, true))
      throw fault('UI_QT_VOICE_CALIBRATION_REQUIRED');
    if (value.newlineKey !== undefined && value.newlineKey !== 'Shift+Enter')
      throw fault('UI_QT_NEWLINE_CALIBRATION_INVALID');
    return structuredClone(value);
  }
  qtEmptyEditorHashes(value.layout);
  if (
    value.layout.pointerParkRect !== undefined &&
    !validPointerParkRect(value.layout.pointerParkRect, value.layout.width)
  )
    throw fault('UI_QT_POINTER_PARK_INVALID');
  if (value.layout.focusActivateRect !== undefined || value.layout.focusActivateRgbaSha256 !== undefined)
    if (
      !validFocusActivation(
        { rect: value.layout.focusActivateRect, rgbaSha256: value.layout.focusActivateRgbaSha256 },
        value.layout.width,
      )
    )
      throw fault('UI_QT_FOCUS_CALIBRATION_INVALID');
  if (value.layoutMode !== undefined && !['calibrated', 'adaptive-v1'].includes(value.layoutMode))
    throw fault('UI_QT_LAYOUT_INVALID');
  const adaptive = value.layoutMode === 'adaptive-v1';
  const client = { left: 0, top: 0, right: value.layout.width, bottom: value.layout.height };
  if (
    (adaptive ? ['header', 'search', 'profileOpen', 'selfOpen', 'editor', 'send'] : regions).some(
      key =>
        !(['profileClose', 'selfClose'].includes(key) && value[key + 'Key'] === 'Escape') &&
        (!rect(value.layout[key]) || !inside(client, value.layout[key])),
    )
  )
    throw fault('UI_QT_LAYOUT_INVALID');
  if (adaptive && !inside(value.layout.header, value.layout.profileOpen)) throw fault('UI_QT_LAYOUT_INVALID');
  if (
    value.layout.send.left < value.layout.editor.right &&
    value.layout.send.right > value.layout.editor.left &&
    value.layout.send.top < value.layout.editor.bottom &&
    value.layout.send.bottom > value.layout.editor.top
  )
    throw fault('UI_QT_LAYOUT_INVALID');
  for (const key of ['profileSurface', 'selfSurface'])
    if (adaptive) {
      if (value.sharedDesktop === true && value[key] === undefined) continue;
      if (
        !object(value[key]) ||
        Object.keys(value[key]).length !== 1 ||
        value[key.slice(0, -7) + 'CloseKey'] !== 'Escape'
      )
        throw fault('UI_QT_LAYOUT_INVALID');
      toObservedPopupCalibration(value[key].popupCalibration, 'profile');
    } else if (value[key] !== undefined) {
      const p = value[key];
      if (
        !object(p) ||
        !Number.isInteger(p.width) ||
        p.width < 100 ||
        p.width > 4096 ||
        !Number.isInteger(p.height) ||
        p.height < 100 ||
        p.height > 4096 ||
        !rect(p.alias) ||
        !rect(p.close) ||
        !inside({ left: 0, top: 0, right: p.width, bottom: p.height }, p.alias) ||
        !inside({ left: 0, top: 0, right: p.width, bottom: p.height }, p.close)
      )
        throw fault('UI_QT_LAYOUT_INVALID');
      if (p.popupCalibration !== undefined) {
        const popup = validatePopupCalibration(p.popupCalibration, 'profile');
        if (p.width !== popup.clientWidth || p.height !== popup.clientHeight)
          throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
      }
    }
  // WeChat's search field belongs to the main window; only its result list is
  // a separate popup. Requiring the input field inside that list rejects the
  // actual Windows layout. The field is still bounded by the main client.
  if (adaptive) toObservedPopupCalibration(value.searchPopupCalibration, 'search');
  else if (value.searchPopupCalibration !== undefined) {
    const popup = validatePopupCalibration(value.searchPopupCalibration, 'search');
    if (
      !inside(popup.windowRect, value.layout.firstResult) ||
      (popup.heightRange && popup.windowRect.top + popup.heightRange.max > value.layout.height)
    )
      throw fault('UI_QT_POPUP_CALIBRATION_INVALID');
  }
  if (value.newlineKey !== undefined && value.newlineKey !== 'Shift+Enter')
    throw fault('UI_QT_NEWLINE_CALIBRATION_INVALID');
  for (const key of ['profileCloseKey', 'selfCloseKey'])
    if (value[key] !== undefined && value[key] !== 'Escape') throw fault('UI_QT_LAYOUT_INVALID');
  if (value.layout.profileMember !== undefined || value.layout.profilePanelClose !== undefined)
    for (const key of ['profileMember', 'profilePanelClose'])
      if (!rect(value.layout[key]) || !inside(client, value.layout[key])) throw fault('UI_QT_LAYOUT_INVALID');
  if (!adaptive && value.layout.searchResultIdentity !== undefined) {
    const area = value.layout.searchResultIdentity,
      click = value.layout.firstResult,
      x = (click.left + click.right) / 2,
      y = (click.top + click.bottom) / 2,
      popup = value.searchPopupCalibration;
    const searchBounds = popup
      ? {
          ...popup.windowRect,
          bottom:
            popup.windowRect.top +
            Math.max(popup.clientHeight, ...(popup.heightVariants ?? []), popup.heightRange?.max ?? 0),
        }
      : null;
    if (
      !rect(area) ||
      !inside(client, area) ||
      !inside(area, click) ||
      x < area.left ||
      x >= area.right ||
      y < area.top ||
      y >= area.bottom ||
      (searchBounds && !inside(searchBounds, area))
    )
      throw fault('UI_QT_LAYOUT_INVALID');
  }
  if (
    value.settleMs !== undefined &&
    (!Number.isInteger(value.settleMs) || value.settleMs < 100 || value.settleMs > 2000)
  )
    throw fault('UI_QT_LAYOUT_INVALID');
  return structuredClone(value);
}

export {
  fault,
  object,
  pasteCommands,
  clipboardSettled,
  preparedTargetLookup,
  observedLayout,
  sharedTargetProof,
  uiaTargetEvidence,
  sharedVoicePreparation,
  navigationTransitionFailure,
  uiaVerificationRefusal,
  markUiaVerificationRefusal,
  markNavigationRefusal,
  hash,
  nativeLeaseId,
  qtEmptyEditorHashes,
  qtEmptyEditorPhaseMatches,
  validateQtEmptyDraftPhaseProof,
  validateQtEmptyDraftPhase,
  positiveDecimal,
  validForegroundLease,
  validUiaPointerDelivery,
  uiaEditorFocusReused,
  incompleteForegroundInterval,
  validFocusHandoff,
  validForegroundSession,
  validForegroundSessionRelease,
  transferredFocusValidation,
  id,
  alias,
  rect,
  validVoiceLayout,
  inside,
  sameRect,
  sameHeaderView,
  validFocusActivation,
  validPointerParkRect,
  validatePopupCalibration,
  popupIdentityFields,
  toObservedPopupCalibration,
  noLinks,
  regions,
  validConversationFingerprint,
  validUiaImageProof,
  codeFor,
  preparationWaits,
  validateQtConfig,
};
