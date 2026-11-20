import fs from 'node:fs';
import { sanitizeForegroundIntervals } from './foreground-timing.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertVoiceRecoveryIdle } from './voice-operator-recovery.mjs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {isDeepStrictEqual} from 'node:util';
import { validateDraftRequest } from './draft-probe.mjs';
import { inspectPlaybackWav } from './cable-player.mjs';
import {isVoiceWarmMonitor} from './voice-warm-monitor.mjs';
import {validateVoiceRecordingLayout,sanitizeAdaptiveRecordingUi,sanitizeUiaRecordingUi,sanitizeUiaBackgroundSubmit,validVoiceConversationFingerprint} from './voice-recording-layout.mjs';
export {warmVoiceMonitor} from './voice-warm-monitor.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactFields=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const rect = value => object(value) && ['left', 'top', 'right', 'bottom'].every(key => Number.isInteger(value[key])) && value.right > value.left && value.bottom > value.top;
const within = (outer, inner) => rect(inner) && inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const endpoint = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value);

export function validateVoiceFocusHandoff(value, session) {
  if (value === undefined) return undefined;
  const target = value?.returnWindow;
  const exactKeys = (input, required, optional = []) => object(input) && required.every(key => Object.hasOwn(input,key)) && Object.keys(input).every(key => required.includes(key) || optional.includes(key));
  if (!exactKeys(value,['version','returnWindow'],['activation','foregroundLease']) || value.version !== 1 || !exactKeys(target,['hwnd','pid','processCreatedFileTimeUtc']) ||
      !decimal(target.hwnd) || !decimal(target.processCreatedFileTimeUtc) || !Number.isSafeInteger(target.pid) || target.pid < 1 || target.pid > 0xffffffff ||
      target.hwnd === session?.hwnd || target.pid === session?.pid) throw fault('VOICE_FOCUS_HANDOFF_INVALID');
  let activation;
  if(Object.hasOwn(value,'activation')) {
    const candidate=value.activation,area=candidate?.rect;
    const automatic=exactKeys(candidate,['rect','mode'])&&['blank-caption-v1','uia-caption-v1'].includes(candidate.mode);
    if(!(automatic||exactKeys(candidate,['rect','rgbaSha256'])&&hex(candidate.rgbaSha256)) || !exactKeys(area,['left','top','right','bottom']) ||
      !Object.values(area).every(Number.isSafeInteger) || area.left<160 || area.top<0 || area.bottom>48 ||
      area.right-area.left<20 || area.right-area.left>200 || area.bottom-area.top<8 || area.bottom-area.top>40 ||
      rect(session?.clientRect)&&(!within(session.clientRect,area)||area.right>session.clientRect.right-160)) throw fault('VOICE_FOCUS_HANDOFF_INVALID');
    activation={rect:{left:area.left,top:area.top,right:area.right,bottom:area.bottom},...(automatic?{mode:candidate.mode}:{rgbaSha256:candidate.rgbaSha256})};
  }
  let foregroundLease;
  if (Object.hasOwn(value,'foregroundLease')) {
    const lease=value.foregroundLease;
    if (!exactKeys(lease,['version','startedAtTickMs','includesContactNavigation']) || lease.version!==1 ||
        !Number.isSafeInteger(lease.startedAtTickMs) || lease.startedAtTickMs<=0 || typeof lease.includesContactNavigation!=='boolean') throw fault('VOICE_FOCUS_HANDOFF_INVALID');
    foregroundLease={version:1,startedAtTickMs:lease.startedAtTickMs,includesContactNavigation:lease.includesContactNavigation};
  }
  return { version: 1, returnWindow: { hwnd: target.hwnd, pid: target.pid, processCreatedFileTimeUtc: target.processCreatedFileTimeUtc }, ...(activation?{activation}:{}),...(foregroundLease?{foregroundLease}:{}) };
}

export function validateTimedVoiceRequest({ id, audio, session, renderId, captureId, permission, idleMs = 1000, focusHandoff }, now = Date.now()) {
  if (!hex(id) || !Buffer.isBuffer(audio)) throw fault('VOICE_REQUEST_INVALID');
  if (!object(permission) || ['recordPreview', 'playAudio', 'submitPreview'].some(key => permission[key] !== true) ||
      (permission.cancelOwnedRecording !== undefined && typeof permission.cancelOwnedRecording !== 'boolean')) throw fault('VOICE_PERMISSION_REQUIRED');
  const uncheckedDraft=object(session)&&session.draftPolicy==='unchecked'&&session.emptyDraftConfirmed===false&&object(focusHandoff);
  if (!object(session) || !(uncheckedDraft || !Object.hasOwn(session,'draftPolicy')&&session.emptyDraftConfirmed===true)) throw fault('VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED');
  const calibration = validateDraftRequest({ session, idleMs, expectedDraft: 'voice calibration only', permission: { selectionCopy: true, caretToEnd: true, clipboardRestore: true } }, now).session;
  if (!calibration.editorFocusProof || calibration.expiresAtMs - now < 16000) throw fault('VOICE_SESSION_BUDGET_EXCEEDED');
  if (!endpoint(renderId) || !endpoint(captureId) || renderId === captureId) throw fault('VOICE_ENDPOINT_INVALID');
  const format = inspectPlaybackWav(audio);
  if (!(format.durationMs > 0 && format.durationMs <= 8000)) throw fault('VOICE_WAV_DURATION_LIMIT');
  const park = session.mouseParkRect;
  const ui=validateVoiceRecordingLayout({recordingUi:session.recordingUi,clientRect:calibration.clientRect,recordStartRect:session.recordStartRect,mouseParkRect:park,editorRect:calibration.editorRect,dpi:calibration.dpi});
  const handoff = validateVoiceFocusHandoff(focusHandoff, calibration);
  if(ui.uia&&!handoff)throw fault('VOICE_UIA_HANDOFF_REQUIRED');
  if(handoff?.activation&&(!!ui.uia!==(handoff.activation.mode==='uia-caption-v1')))throw fault('VOICE_UIA_FOCUS_MODE_REQUIRED');
  return { action: 'timedVoicePreview', id, audioSha256: crypto.createHash('sha256').update(audio).digest('hex'), renderId, captureId, idleMs,
    ...(handoff ? { focusHandoff: handoff } : {}),
    permission: { recordPreview: true, playAudio: true, submitPreview: true, cancelOwnedRecording: permission.cancelOwnedRecording === true },
    session: JSON.parse(JSON.stringify({ ...calibration, emptyDraftConfirmed: !uncheckedDraft,...(uncheckedDraft?{draftPolicy:'unchecked'}:{}), recordStartRect: session.recordStartRect,...(park===undefined?{}:{mouseParkRect:{left:park.left,top:park.top,right:park.right,bottom:park.bottom}}), recordingUi: ui })) };
}

/** Production sessions are issued by the Qt identity driver. The native
 * helper rechecks the bound title through UIA or the original pixel path. */
export function validateTimedVoiceSendRequest(options, now = Date.now()) {
  const { session, permission } = options ?? {}, proof = session?.targetProof;
  const target = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value) && value !== 'filehelper';
  const group=typeof session?.target==='string'&&session.target.endsWith('@chatroom');
  if (!object(session) || session.version !== 2 || !target(session.target) || !object(proof) || proof.kind !== (group?'verified-qt-group-chat-v1':'verified-qt-private-chat-v1') || group&&!hex(proof.querySha256) ||
      proof.target !== session.target || !hex(proof.accountRef))throw fault('VOICE_TARGET_PROOF_INVALID');
  if(session.recordingUi?.uia){
    if(!exactFields(proof,group?['kind','target','accountRef','querySha256','conversationFingerprint']:['kind','target','accountRef','conversationFingerprint'])||!validVoiceConversationFingerprint(proof.conversationFingerprint)||!isDeepStrictEqual(proof.conversationFingerprint,session.recordingUi.uia.conversationFingerprint))throw fault('VOICE_TARGET_PROOF_INVALID');
  }else if(Object.hasOwn(proof,'conversationFingerprint')||!object(proof.titleAnchor)||!hex(proof.titleAnchor.rgbaSha256)||!rect(session.clientRect)||!within(session.clientRect,proof.titleAnchor.rect)||proof.titleAnchor.rect.right-proof.titleAnchor.rect.left>1024||proof.titleAnchor.rect.bottom-proof.titleAnchor.rect.top>256||overlaps(proof.titleAnchor.rect,session.editorRect??{}))throw fault('VOICE_TARGET_PROOF_INVALID');
  if (permission?.recordNativeVoice !== true || permission?.playAudio !== true || permission?.submitNativeVoice !== true || typeof permission?.cancelOwnedRecording !== 'boolean') throw fault('VOICE_PERMISSION_REQUIRED');
  // Reuse the window/layout validator. Its preview identity is not transported
  // or treated as a target proof; the production target/anchor stay separate.
  const common = validateTimedVoiceRequest({ ...options, session: { ...session, version: 1, target: 'filehelper',
    editorFocusProof: { kind: 'operator-calibrated-edit-region', calibrationHash: session.calibrationHash, lastInputTick: session.lastInputTick } },
    permission: { recordPreview: true, playAudio: true, submitPreview: true, cancelOwnedRecording: permission.cancelOwnedRecording } }, now);
  const { editorFocusProof, ...binding } = common.session;
  return { ...common, action: 'timedVoiceSend', permission: { recordNativeVoice: true, playAudio: true, submitNativeVoice: true, cancelOwnedRecording: permission.cancelOwnedRecording },
    session: { ...binding, version: 2, target: session.target, targetProof: structuredClone(proof) } };
}

export function validateMouseMarkerRequest({ session, mouseTargetRect, permission, idleMs = 1000 }, now = Date.now()) {
  if (permission?.mouseMoveDiagnostic !== true) throw fault('VOICE_PERMISSION_REQUIRED');
  const calibration = validateDraftRequest({ session, idleMs, expectedDraft: 'mouse calibration only', permission: { selectionCopy: true, caretToEnd: true, clipboardRestore: true } }, now).session;
  if (!calibration.editorFocusProof || idleMs > 1500 || calibration.expiresAtMs - now < 4000) throw fault('VOICE_MOUSE_SESSION_INVALID');
  if (!within(calibration.clientRect, mouseTargetRect) || mouseTargetRect.right - mouseTargetRect.left < 2 || mouseTargetRect.right - mouseTargetRect.left > 128 || mouseTargetRect.bottom - mouseTargetRect.top < 2 || mouseTargetRect.bottom - mouseTargetRect.top > 128) throw fault('VOICE_MOUSE_TARGET_INVALID');
  return { action: 'probeMouseMarker', session: JSON.parse(JSON.stringify(calibration)), mouseTargetRect: { left: mouseTargetRect.left, top: mouseTargetRect.top, right: mouseTargetRect.right, bottom: mouseTargetRect.bottom }, permission: { mouseMoveDiagnostic: true }, idleMs };
}

function noLinks(target) {
  for (let current = path.resolve(target);;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('VOICE_LINK_REJECTED');
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
function readJson(file) {
  noLinks(file); const info = fs.statSync(file);
  if (!info.isFile() || info.size > 32768) throw fault('VOICE_STATE_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('VOICE_STATE_INVALID'); }
}
function atomic(file, value) {
  noLinks(file); const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function activityReport(activity) {
  if (activity === null || activity === undefined) return null;
  if (!object(activity) || !['mouse', 'keyboard'].includes(activity.kind) || ['injected', 'ownMarker', 'lower32Matches', 'markerIsZero'].some(key => typeof activity[key] !== 'boolean') ||
      activity.injected && activity.ownMarker || activity.markerIsZero && (activity.ownMarker || activity.lower32Matches) || activity.ownMarker && !activity.lower32Matches ||
      !Number.isSafeInteger(activity.message) || activity.message < 0 || activity.message > 65535 ||
      activity.timeAfterRecordStartMs !== null && (!Number.isSafeInteger(activity.timeAfterRecordStartMs) || activity.timeAfterRecordStartMs < 0 || activity.timeAfterRecordStartMs > 30000)) throw fault('VOICE_PROTOCOL_INVALID');
  return { kind: activity.kind, injected: activity.injected, ownMarker: activity.ownMarker, lower32Matches: activity.lower32Matches, markerIsZero: activity.markerIsZero, message: activity.message, timeAfterRecordStartMs: activity.timeAfterRecordStartMs };
}
function mouseReport(raw) {
  if (!object(raw) || raw.mode !== 'mouseMarkerDiagnostic' || typeof raw.ok !== 'boolean') throw fault('VOICE_PROTOCOL_INVALID');
  const result = { ok: raw.ok, mode: raw.mode };
  for (const key of ['mouseMoveAttempted', 'mouseMoveInputApplied', 'ownMouseObserved', 'recordingAttempted', 'audioStarted', 'submitAttempted', 'messageSent', 'systemSettingsChanged']) {
    if (typeof raw[key] !== 'boolean') throw fault('VOICE_PROTOCOL_INVALID'); result[key] = raw[key];
  }
  if (['recordingAttempted', 'audioStarted', 'submitAttempted', 'messageSent', 'systemSettingsChanged'].some(key => result[key]) || result.mouseMoveInputApplied && !result.mouseMoveAttempted) throw fault('VOICE_PROTOCOL_INVALID');
  if (raw.reason !== null && !(typeof raw.reason === 'string' && /^(VOICE|DRAFT|AUDIO)_[A-Z_]{1,80}$/.test(raw.reason))) throw fault('VOICE_PROTOCOL_INVALID'); result.reason = raw.reason;
  result.humanActivity = activityReport(raw.humanActivity);
  if (result.humanActivity?.timeAfterRecordStartMs !== null && result.humanActivity !== null || result.ok && (!result.mouseMoveInputApplied || !result.ownMouseObserved || result.humanActivity !== null || result.reason !== null)) throw fault('VOICE_PROTOCOL_INVALID');
  return result;
}
function pumpReport(raw) {
  if (raw === null || raw === undefined) return null;
  if (!object(raw) || raw.dedicatedThread !== true || raw.pollIntervalMs !== 5 || raw.queuedAudioLimitMs !== 20 ||
      typeof raw.threadJoined !== 'boolean' || typeof raw.outputStopped !== 'boolean' || !Number.isSafeInteger(raw.paddingStarvationCount) || raw.paddingStarvationCount < 0 || raw.paddingStarvationCount > 100000) throw fault('VOICE_PROTOCOL_INVALID');
  if (raw.timerPeriodMs !== 1 || ['timerResolutionRequested', 'timerResolutionAcquired', 'timerResolutionRestored'].some(key => typeof raw[key] !== 'boolean') ||
      raw.timerResolutionAcquired && !raw.timerResolutionRequested || raw.timerResolutionRestored && !raw.timerResolutionAcquired) throw fault('VOICE_PROTOCOL_INVALID');
  const result = { dedicatedThread: true, pollIntervalMs: 5, queuedAudioLimitMs: 20, paddingStarvationCount: raw.paddingStarvationCount, threadJoined: raw.threadJoined, outputStopped: raw.outputStopped,
    timerPeriodMs: 1, timerResolutionRequested: raw.timerResolutionRequested, timerResolutionAcquired: raw.timerResolutionAcquired, timerResolutionRestored: raw.timerResolutionRestored };
  for (const key of ['maxPumpGapMs', 'startToDrainMs', 'drainToStopMs']) { if (!Number.isFinite(raw[key]) || raw[key] < 0 || raw[key] > 30000) throw fault('VOICE_PROTOCOL_INVALID'); result[key] = raw[key]; }
  return result;
}
function handoffReport(raw) {
  if (!object(raw) || raw.version !== 1) throw fault('VOICE_PROTOCOL_INVALID');
  const result = { version: 1 };
  const intervals=sanitizeForegroundIntervals(raw.foregroundIntervals,{phases:['record-start','record-submit','record-cancel'],maxCount:3});
  if(intervals)result.foregroundIntervals=intervals;
  for (const key of ['initialReturnAttempted', 'initialReturnConfirmed', 'backgroundEntered', 'backgroundActivityObserved',
    'submitActivationAttempted', 'submitActivationConfirmed', 'finalReturnAttempted', 'finalReturnConfirmed', 'returnSkippedForHumanInput']) {
    if (typeof raw[key] !== 'boolean') throw fault('VOICE_PROTOCOL_INVALID'); result[key] = raw[key];
  }
  for (const key of ['initialForegroundElapsedMs', 'backgroundElapsedMs', 'submitForegroundElapsedMs']) {
    if (!Number.isFinite(raw[key]) || raw[key] < 0 || raw[key] > 30000) throw fault('VOICE_PROTOCOL_INVALID'); result[key] = raw[key];
  }
  const pointerFlags=['initialPointerRestored','finalPointerRestored','pointerRestoreSkipped'];
  if(pointerFlags.some(key=>Object.hasOwn(raw,key)))for(const key of pointerFlags){if(typeof raw[key]!=='boolean')throw fault('VOICE_PROTOCOL_INVALID');result[key]=raw[key];}
  for(const key of ['initialCaption','submitCaption'])if(Object.hasOwn(raw,key)){
    const value=raw[key],fields=['prepared','requestAttempted','clickAttempted','clickApplied','verified'];
    if(!object(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(field=>!fields.includes(field))||fields.some(field=>typeof value[field]!=='boolean')||value.prepared!==true||value.clickAttempted&&(!value.requestAttempted||!value.verified)||value.clickApplied&&!value.clickAttempted||value.verified&&!value.clickAttempted)throw fault('VOICE_PROTOCOL_INVALID');
    result[key]=Object.fromEntries(fields.map(field=>[field,value[field]]));
  }
  if(Object.hasOwn(raw,'submitVisibility')){
    const value=raw.submitVisibility,fields=['version','raiseAttempted','requestAccepted','confirmed','initialBlockingCount','lastBlockingCount','elapsedMs','reason'];
    if(!object(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(field=>!fields.includes(field))||value.version!==1||typeof value.raiseAttempted!=='boolean'||typeof value.confirmed!=='boolean'||value.requestAccepted!==null&&typeof value.requestAccepted!=='boolean'||!value.raiseAttempted&&value.requestAccepted!==null||!['already-visible','raised-visible','timeout','guard-failed'].includes(value.reason)||!Number.isSafeInteger(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>30000||!['initialBlockingCount','lastBlockingCount'].every(field=>value[field]===null||Number.isSafeInteger(value[field])&&value[field]>=0&&value[field]<=1000000)||value.confirmed&&(!['already-visible','raised-visible'].includes(value.reason)||value.lastBlockingCount!==0))throw fault('VOICE_PROTOCOL_INVALID');
    result.submitVisibility=Object.fromEntries(fields.map(field=>[field,value[field]]));
  }
  if (result.initialReturnConfirmed && !result.initialReturnAttempted || result.backgroundEntered && !result.initialReturnConfirmed ||
      result.submitActivationConfirmed && !result.submitActivationAttempted || result.finalReturnConfirmed && !result.finalReturnAttempted ||
      result.submitActivationAttempted && !result.backgroundEntered || result.backgroundActivityObserved && !result.backgroundEntered)
    throw fault('VOICE_PROTOCOL_INVALID');
  if(result.submitVisibility&&(!result.submitActivationAttempted||result.submitActivationConfirmed&&!result.submitVisibility.confirmed))throw fault('VOICE_PROTOCOL_INVALID');
  if(Object.hasOwn(raw,'backgroundSubmit')){
    const background=sanitizeUiaBackgroundSubmit(raw.backgroundSubmit,{...result,submitCaption:raw.submitCaption,submitVisibility:raw.submitVisibility});
    if(!background)throw fault('VOICE_PROTOCOL_INVALID');result.backgroundSubmit=background;
  }
  return result;
}
function report(raw, production = false, expectedHandoff = false, expectedUia = false) {
  if (!object(raw) || raw.mode !== (production ? 'timedVoiceSend' : 'timedVoicePreview') || typeof raw.ok !== 'boolean' || production && raw.targetGuarded !== true) throw fault('VOICE_PROTOCOL_INVALID');
  const result = { ok: raw.ok, mode: raw.mode };
  const adaptiveRecordingUi=sanitizeAdaptiveRecordingUi(raw.adaptiveRecordingUi);
  if(adaptiveRecordingUi)result.adaptiveRecordingUi=adaptiveRecordingUi;
  const uiaRecordingUi=sanitizeUiaRecordingUi(raw.uiaRecordingUi);
  if(expectedUia&&(!uiaRecordingUi||raw.ok&&(!uiaRecordingUi.bound||!uiaRecordingUi.conversationVerified))||raw.uiaRecordingUi!==undefined&&!uiaRecordingUi||uiaRecordingUi&&(!expectedUia||adaptiveRecordingUi))throw fault('VOICE_PROTOCOL_INVALID');
  if(uiaRecordingUi)result.uiaRecordingUi=uiaRecordingUi;
  if (expectedHandoff) result.focusHandoff = handoffReport(raw.focusHandoff);
  else if (raw.focusHandoff !== undefined) throw fault('VOICE_PROTOCOL_INVALID');
  const backgroundSubmit=result.focusHandoff?.backgroundSubmit;
  if(backgroundSubmit&&(!expectedUia||!uiaRecordingUi?.bound||!uiaRecordingUi.conversationVerified))throw fault('VOICE_PROTOCOL_INVALID');
  if (result.ok && expectedHandoff && (!result.focusHandoff.backgroundEntered || (backgroundSubmit?!backgroundSubmit.confirmed:
      !result.focusHandoff.submitActivationConfirmed || !result.focusHandoff.finalReturnConfirmed && !result.focusHandoff.returnSkippedForHumanInput))) throw fault('VOICE_PROTOCOL_INVALID');
  if (production) result.targetGuarded = true;
  for (const key of ['recordingAttempted', 'recordingPossible', 'captureVerified', 'captureSessionBound', 'audioStarted', 'playbackComplete', 'submitAttempted', 'submitInputApplied',
    'cancelAttempted', 'cancelInputApplied', 'recordingEndedObserved', 'deliveryConfirmed', 'unattendedReady', 'systemSettingsChanged', 'microphoneOpened']) {
    if (typeof raw[key] !== 'boolean') throw fault('VOICE_PROTOCOL_INVALID'); result[key] = raw[key];
  }
  if (result.deliveryConfirmed || result.unattendedReady || result.systemSettingsChanged || result.microphoneOpened || result.submitInputApplied && !result.submitAttempted || result.cancelInputApplied && !result.cancelAttempted || result.playbackComplete && !result.audioStarted ||
      result.audioStarted && (!result.captureVerified || !result.captureSessionBound) || result.recordingEndedObserved && result.recordingPossible ||
      result.recordingAttempted && !result.recordingPossible && !result.recordingEndedObserved || (result.submitAttempted || result.cancelAttempted) && !result.recordingAttempted) throw fault('VOICE_PROTOCOL_INVALID');
  if(backgroundSubmit&&(backgroundSubmit.attempted!==result.submitAttempted||backgroundSubmit.applied!==result.submitInputApplied||
      backgroundSubmit.confirmed&&(!result.recordingEndedObserved||result.recordingPossible)||result.cancelAttempted))throw fault('VOICE_PROTOCOL_INVALID');
  if (raw.reason !== null && !(typeof raw.reason === 'string' && /^(VOICE|DRAFT|AUDIO)_[A-Z_]{1,80}$/.test(raw.reason))) throw fault('VOICE_PROTOCOL_INVALID');
  result.reason = raw.reason;
  if(raw.cancellationCleanup!==undefined){
    const value=raw.cancellationCleanup,fields=['version','stage','reason'];
    if(!object(value)||Object.keys(value).length!==fields.length||fields.some(key=>!Object.hasOwn(value,key))||value.version!==1||!['quiet','focus','esc','end','ended'].includes(value.stage)||
      value.reason!==null&&!(typeof value.reason==='string'&&/^(VOICE|DRAFT|AUDIO)_[A-Z_]{1,80}$/.test(value.reason))||result.ok||value.stage==='ended'&&(value.reason!==null||!result.cancelInputApplied||!result.recordingEndedObserved||result.recordingPossible))throw fault('VOICE_PROTOCOL_INVALID');
    result.cancellationCleanup={version:1,stage:value.stage,reason:value.reason};
  }
  if (raw.queuedAudioLimitMs !== 20 || raw.deviceLatencyBounded !== false) throw fault('VOICE_PROTOCOL_INVALID');
  result.queuedAudioLimitMs = 20; result.deviceLatencyBounded = false;
  if (!Number.isSafeInteger(raw.mouseParkMovesApplied) || raw.mouseParkMovesApplied < 0 || raw.mouseParkMovesApplied > 3 ||
      (expectedUia ? raw.mouseParkMovesApplied !== 0 : result.ok && raw.mouseParkMovesApplied !== 3)) throw fault('VOICE_PROTOCOL_INVALID');
  result.mouseParkMovesApplied = raw.mouseParkMovesApplied;
  if(expectedUia){
    if(!Number.isSafeInteger(raw.uiaPointerMessagesPosted)||raw.uiaPointerMessagesPosted<0||raw.uiaPointerMessagesPosted>6||result.ok&&raw.uiaPointerMessagesPosted!==6)throw fault('VOICE_PROTOCOL_INVALID');
    result.uiaPointerMessagesPosted=raw.uiaPointerMessagesPosted;
  }else if(raw.uiaPointerMessagesPosted!==undefined){
    if(raw.uiaPointerMessagesPosted!==0)throw fault('VOICE_PROTOCOL_INVALID');result.uiaPointerMessagesPosted=0;
  }
  result.humanActivity = activityReport(raw.humanActivity);
  if (result.humanActivity !== null && result.ok) throw fault('VOICE_PROTOCOL_INVALID');
  result.audioPump = pumpReport(raw.audioPump);
  if (result.audioStarted && (!result.audioPump || !result.audioPump.threadJoined) || result.ok && (!result.audioPump?.outputStopped || !result.audioPump.timerResolutionAcquired || !result.audioPump.timerResolutionRestored)) throw fault('VOICE_PROTOCOL_INVALID');
  for (const field of ['sourceDurationMs', 'playbackElapsedMs', 'recordingElapsedMs']) {
    if (!Number.isFinite(raw[field]) || raw[field] < 0 || raw[field] > 30000) throw fault('VOICE_PROTOCOL_INVALID'); result[field] = raw[field];
  }
  if (result.sourceDurationMs > 8000 || result.ok && result.sourceDurationMs <= 0) throw fault('VOICE_PROTOCOL_INVALID');
  if (result.audioPump && result.audioPump.startToDrainMs !== result.playbackElapsedMs) throw fault('VOICE_PROTOCOL_INVALID');
  if (!object(raw.timelineMs)) throw fault('VOICE_PROTOCOL_INVALID'); result.timelineMs = {};
  for (const key of ['recordStart', 'captureReady', 'playStart', 'playDrained', 'submit', 'recordEnded']) {
    const value = raw.timelineMs[key]; if (!Number.isSafeInteger(value) || value < 0) throw fault('VOICE_PROTOCOL_INVALID'); result.timelineMs[key] = value;
  }
  if (result.ok && (!result.recordingAttempted || !result.captureVerified || !result.captureSessionBound || !result.audioStarted || !result.playbackComplete || !result.submitInputApplied || !result.recordingEndedObserved || result.recordingPossible || result.cancelAttempted || result.reason !== null)) throw fault('VOICE_PROTOCOL_INVALID');
  return result;
}

function runNative(executable, request, { root, spawnImpl, signal, mouseDiagnostic = false, production = false }) {
  return new Promise((resolve, reject) => {
    let child, text = '', bytes = 0, errors = 0, finished = false, cancelling = false, force, reap;
    const decoder = new StringDecoder('utf8');
    const unknown = code => Object.assign(fault(code), mouseDiagnostic ? { mouseMoveAttempted: null, mouseMoveInputApplied: null, recordingAttempted: false, audioStarted: false, submitAttempted: false } : { recordingPossible: true, submitAttempted: null });
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(deadline); clearTimeout(force); clearTimeout(reap); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
    const stop = code => {
      if (finished || cancelling) return; cancelling = true;
      try { child?.stdin.end('cancel\n'); } catch {}
      // A kill request is not process-exit proof. Keep this promise pending
      // until close, so an outer outbox can retain its cross-process barrier
      // and drain cannot announce completion while input may still run.
      force = setTimeout(() => { try { child?.kill(); } catch {} }, 1500);
    };
    const cancel = () => stop('VOICE_CANCELLED');
    const deadline = setTimeout(() => stop('VOICE_PROCESS_TIMEOUT'), mouseDiagnostic ? 5500 : 18500);
    try {
      child = spawnImpl(executable, [mouseDiagnostic ? '--private-mouse-diagnostic' : production ? '--private-send' : '--private-once'], { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', () => stop('VOICE_START_FAILED')); child.stdin.on('error', () => stop('VOICE_PIPE_FAILED'));
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 32768) { stop('VOICE_PROTOCOL_INVALID'); return; } text += decoder.write(chunk); });
      child.stderr.on('data', chunk => { errors += chunk.length; if (errors > 32768) stop('VOICE_PROTOCOL_INVALID'); });
      child.on('close', (code, terminationSignal) => {
        let value;
        try { const raw = JSON.parse(text + decoder.end()); value = mouseDiagnostic ? mouseReport(raw) : report(raw, production, request.focusHandoff !== undefined, Boolean(request.session?.recordingUi?.uia)); } catch { finish(unknown('VOICE_PROTOCOL_INVALID')); return; }
        if (terminationSignal || (value.ok ? code !== 0 : code !== 1)) { finish(unknown('VOICE_PROCESS_FAILED')); return; }
        if (cancelling && value.ok) { finish(unknown('VOICE_CANCELLED_RESULT_UNCERTAIN')); return; }
        finish(null, value);
      });
      child.stdin.write(JSON.stringify(request) + '\n');
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    } catch { finish(unknown('VOICE_START_FAILED')); }
  });
}

/** One marked mouse move, with no button press, recording, clipboard, or audio. No retry. */
export async function probeVoiceMouseMarker({ root = projectRoot, spawnImpl = spawn, signal, ...options } = {}) {
  if (signal?.aborted) throw fault('VOICE_CANCELLED_BEFORE_START');
  const request = validateMouseMarkerRequest(options);
  const executable = path.resolve(root, 'state/ui-host/WechatVoicePreview.exe'); noLinks(executable);
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw fault('VOICE_COMPONENT_MISSING');
  return runNative(executable, request, { root, spawnImpl, signal, mouseDiagnostic: true });
}

/** Controlled filehelper demo only. Same ID never starts a second recording. */
export async function runTimedVoicePreview({ root = projectRoot, spawnImpl = spawn, signal, warmMonitor, ...options } = {}) {
  return runTimedVoice({ root, spawnImpl, signal, warmMonitor, options, production: false });
}
export async function runTimedVoiceSend({ root = projectRoot, spawnImpl = spawn, signal, warmMonitor, ...options } = {}) {
  let nativeStarted = false;
  try {
    const result = await runTimedVoice({ root, spawnImpl, signal, warmMonitor, options, production: true, onNativeStart: () => { nativeStarted = true; } });
    return { ...result, nativeStarted };
  } catch (error) {
    // This evidence is produced by our local coordinator before entering the
    // native process, never inferred from a missing/invalid helper response.
    if (!nativeStarted) Object.assign(error, { nativeStarted: false, recordingPossible: false, submitAttempted: false });
    throw error;
  }
}
async function runTimedVoice({ root, spawnImpl, signal, warmMonitor, options, production, onNativeStart }) {
  if (signal?.aborted) throw fault('VOICE_CANCELLED_BEFORE_START');
  const audio = Buffer.isBuffer(options.audio) ? Buffer.from(options.audio) : options.audio;
  let request;
  try { request = (production ? validateTimedVoiceSendRequest : validateTimedVoiceRequest)({ ...options, audio }); } catch (error) { audio?.fill?.(0); throw error; }
  if(warmMonitor!==undefined&&(!isVoiceWarmMonitor(warmMonitor,root)||!request.focusHandoff)){audio.fill(0);throw fault('VOICE_WARMUP_REQUEST_INVALID');}
  const directory = path.resolve(root, production ? 'state/native-voice-attempts' : 'state/voice-preview/timed'); noLinks(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const executable = path.resolve(root, 'state/ui-host/WechatVoicePreview.exe'); noLinks(executable);
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) { audio.fill(0); throw fault('VOICE_COMPONENT_MISSING'); }
  const stateFile = path.join(directory, request.id + '.json'), barrier = path.join(directory, 'active.json');
  let locked = false, work, waveFile, enteredNative = false, clearBarrier = false;
  const lease = crypto.randomUUID();
  const identity = { version: 1, id: request.id, audioSha256: request.audioSha256, accountScopeHash: request.session.accountScopeHash,
    ...(production ? { targetSha256: crypto.createHash('sha256').update(request.session.target).digest('hex') } : {}) };
  try {
    if (fs.existsSync(stateFile)) {
      const saved = readJson(stateFile);
      if (Object.keys(identity).some(key => saved[key] !== identity[key]) || !['planned', 'finished', 'uncertain'].includes(saved.state)) throw fault('VOICE_ID_CONFLICT');
      return { ...(saved.result ?? { ok: false, recordingPossible: true, submitAttempted: null }), reused: true, stopBarrier: saved.state !== 'finished' || saved.result?.recordingPossible !== false, deliveryConfirmed: false };
    }
    assertVoiceRecoveryIdle(root);
    noLinks(barrier);
    try { fs.writeFileSync(barrier, JSON.stringify({ ...identity, lease, processId: process.pid }), { flag: 'wx', mode: 0o600 }); locked = true; }
    catch { throw fault('VOICE_RECOVERY_BARRIER'); }
    assertVoiceRecoveryIdle(root);
    work = fs.mkdtempSync(path.join(directory, 'attempt-')); noLinks(work); waveFile = path.join(work, 'input.wav');
    fs.writeFileSync(waveFile, audio, { flag: 'wx', mode: 0o600 }); audio.fill(0);
    atomic(stateFile, { ...identity, state: 'planned', recordingPossible: true });
    if (signal?.aborted) { clearBarrier = true; throw fault('VOICE_CANCELLED_BEFORE_START'); }
    const commit=()=>{enteredNative=true;onNativeStart?.();};
    let result;
    if(warmMonitor){
      const response=await warmMonitor.execute({...request,waveFile},{production,signal,onCommit:commit});
      try{result=report(response.raw,production,true,Boolean(request.session?.recordingUi?.uia));}catch{throw Object.assign(fault('VOICE_PROTOCOL_INVALID'),{recordingPossible:true,submitAttempted:null});}
      if((result.ok?response.exitCode!==0:response.exitCode!==1)||response.cancelling&&result.ok)throw Object.assign(fault('VOICE_PROCESS_FAILED'),{recordingPossible:true,submitAttempted:null});
    }else{commit();result=await runNative(executable,{...request,waveFile},{root,spawnImpl,signal,production});}
    clearBarrier = result.recordingPossible === false;
    atomic(stateFile, { ...identity, state: clearBarrier ? 'finished' : 'uncertain', result });
    return { ...result, reused: false, stopBarrier: !clearBarrier };
  } catch (error) {
    if(warmMonitor&&error?.warmExecutionStarted===false&&error.nativeStarted===false&&error.recordingPossible===false&&error.submitAttempted===false){
      enteredNative=false;clearBarrier=true;
      if(locked)atomic(stateFile,{...identity,state:'finished',result:{ok:false,reason:/^(VOICE|DRAFT|AUDIO)_[A-Z0-9_]{1,80}$/.test(error.code??'')?error.code:'VOICE_WARMUP_REJECTED',nativeStarted:false,recordingAttempted:false,recordingPossible:false,submitAttempted:false,deliveryConfirmed:false}});
    }
    if (locked && enteredNative) { try { atomic(stateFile, { ...identity, state: 'uncertain', result: { ok: false, reason: /^VOICE_[A-Z_]+$/.test(error?.code) ? error.code : 'VOICE_PREVIEW_FAILED', recordingPossible: true, submitAttempted: null, deliveryConfirmed: false } }); } catch {} }
    if (!enteredNative) clearBarrier = true;
    throw error;
  } finally {
    audio.fill(0);
    if (waveFile) { noLinks(waveFile); if (fs.existsSync(waveFile)) fs.unlinkSync(waveFile); }
    if (work) { noLinks(work); if (path.dirname(path.resolve(work)) !== directory || !/^attempt-[A-Za-z0-9_-]{6,64}$/.test(path.basename(work))) throw fault('VOICE_CLEANUP_FAILED'); fs.rmdirSync(work); }
    if (locked && clearBarrier) { const owner = readJson(barrier); if (owner.lease !== lease) throw fault('VOICE_BARRIER_OWNERSHIP_CHANGED'); fs.unlinkSync(barrier); }
  }
}
