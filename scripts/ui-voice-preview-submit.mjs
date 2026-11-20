import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertVoiceRecoveryIdle } from './voice-operator-recovery.mjs';
import { fileURLToPath } from 'node:url';
import { UiVoiceReaderReceipts } from './ui-voice-reader-receipts.mjs';
import { inspectPlaybackWav } from './cable-player.mjs';
import { validateTimedVoiceRequest } from './timed-voice-preview.mjs';
import {sanitizeAdaptiveRecordingUi,sanitizeUiaRecordingUi,sanitizeUiaBackgroundSubmit} from './voice-recording-layout.mjs';
import { makeForegroundTiming, recordForegroundTiming, sanitizeForegroundTiming, sanitizeForegroundIntervals } from './foreground-timing.mjs';
import {voiceInterruptionFacts,validVoiceInterruptionFacts} from './voice-interruption-evidence.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const fault = code => Object.assign(new Error(code), { code });
const safeReason = error => /^(?:UI|VOICE|DRAFT|AUDIO|READER_LOCAL_API)_[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'UI_VOICE_PREVIEW_FAILED';
const nativeReason = value => typeof value === 'string' && /^(?:VOICE|DRAFT|AUDIO)_[A-Z_]{1,80}$/.test(value) ? value : null;
const states = new Set(['created', 'preparing', 'prepared', 'voice-intent', 'submitted', 'unknown', 'not-recorded', 'confirmed', 'cancelled']);
const handoffFlags = ['initialReturnAttempted','initialReturnConfirmed','backgroundEntered','backgroundActivityObserved',
  'submitActivationAttempted','submitActivationConfirmed','finalReturnAttempted','finalReturnConfirmed','returnSkippedForHumanInput'];
const handoffTimes = ['initialForegroundElapsedMs','backgroundElapsedMs','submitForegroundElapsedMs'];
const handoffPointerFlags = ['initialPointerRestored','finalPointerRestored','pointerRestoreSkipped'];
const durationFields = ['sourceDurationMs','playbackElapsedMs','recordingElapsedMs'];
const timelineFields = ['recordStart','captureReady','playStart','playDrained','submit','recordEnded'];
const duration = value => Number.isFinite(value) && value >= 0 && value <= 30000;
function safeHandoffReport(value) {
  if (value === undefined) return undefined;
  if (!object(value) || value.version !== 1 || handoffFlags.some(key => typeof value[key] !== 'boolean') || handoffTimes.some(key => !duration(value[key])) ||
      value.initialReturnConfirmed && !value.initialReturnAttempted || value.backgroundEntered && !value.initialReturnConfirmed ||
      value.submitActivationConfirmed && !value.submitActivationAttempted || value.finalReturnConfirmed && !value.finalReturnAttempted ||
      value.submitActivationAttempted && !value.backgroundEntered || value.backgroundActivityObserved && !value.backgroundEntered)
    throw fault('UI_VOICE_PREVIEW_NATIVE_REPORT_INVALID');
  const pointerFields=handoffPointerFlags.some(key=>Object.hasOwn(value,key))?handoffPointerFlags:[];
  if(pointerFields.some(key=>typeof value[key]!=='boolean'))throw fault('UI_VOICE_PREVIEW_NATIVE_REPORT_INVALID');
  const intervals=sanitizeForegroundIntervals(value.foregroundIntervals,{phases:['record-start','record-submit','record-cancel'],maxCount:3});
  const backgroundSubmit=Object.hasOwn(value,'backgroundSubmit')?sanitizeUiaBackgroundSubmit(value.backgroundSubmit,value):undefined;
  if(Object.hasOwn(value,'backgroundSubmit')&&!backgroundSubmit)throw fault('UI_VOICE_PREVIEW_NATIVE_REPORT_INVALID');
  return {...Object.fromEntries(['version',...handoffFlags,...handoffTimes,...pointerFields].map(key => [key,value[key]])),...(intervals?{foregroundIntervals:intervals}:{}),...(backgroundSubmit?{backgroundSubmit}:{})};
}
function safeNativeTiming(value) {
  if (value === undefined) return undefined;
  if (!object(value) || durationFields.some(key => !duration(value[key])) || !object(value.timelineMs) || timelineFields.some(key => !integer(value.timelineMs[key])))
    throw fault('UI_VOICE_PREVIEW_NATIVE_REPORT_INVALID');
  return {...Object.fromEntries(durationFields.map(key => [key,value[key]])),timelineMs:Object.fromEntries(timelineFields.map(key => [key,value.timelineMs[key]]))};
}

export function validateVoiceSubmitPreview(options) {
  const { directory, deliveryId, accountWxid, accountDirectory, accountRef, accountScopeHash, target, audio, renderId, captureId, minDurationMs, maxDurationMs, permission } = options ?? {};
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || options.root !== undefined && (typeof options.root !== 'string' || !path.isAbsolute(options.root)) ||
      !digest(deliveryId) || !identifier(accountWxid) || !identifier(accountDirectory) || /[\\/]/u.test(accountDirectory) || ['.', '..'].includes(accountDirectory) ||
      !digest(accountRef) || !digest(accountScopeHash) || target !== 'filehelper' || !Buffer.isBuffer(audio) || !identifier(renderId) || !identifier(captureId) || renderId === captureId ||
      !integer(minDurationMs) || minDurationMs < 1 || !integer(maxDurationMs) || maxDurationMs < minDurationMs || maxDurationMs > 12000 || maxDurationMs - minDurationMs > 5000)
    throw fault('UI_VOICE_PREVIEW_CONFIG_INVALID');
  let format; try { format = inspectPlaybackWav(audio); } catch { throw fault('UI_VOICE_PREVIEW_AUDIO_INVALID'); }
  if (!(format.durationMs > 0 && format.durationMs <= 5000)) throw fault('UI_VOICE_PREVIEW_AUDIO_DURATION_LIMIT');
  const audioSha256 = hash(audio);
  if (!object(permission) || permission.sendVoicePreview !== true || permission.target !== 'filehelper' || permission.audioSha256 !== audioSha256 ||
      ['recordPreview', 'playAudio', 'submitPreview'].some(key => permission[key] !== true) || typeof permission.cancelOwnedRecording !== 'boolean') throw fault('UI_VOICE_PREVIEW_AUDIO_PERMISSION_REQUIRED');
  return { version: 1, deliveryId, accountScopeHash, accountRefHash: hash(accountRef), accountHash: hash(accountWxid), accountDirectoryHash: hash(accountDirectory),
    target, audioSha256, audioDurationMs: format.durationMs, minDurationMs, maxDurationMs, routeHash: hash(JSON.stringify([renderId, captureId])) };
}
function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_VOICE_PREVIEW_LINK_REFUSED');
    if (path.dirname(item) === item) return;
  }
}
function atomic(file, value) {
  noLinks(file); const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    noLinks(file); fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function read(file) {
  noLinks(file); const stat = fs.statSync(file, { throwIfNoEntry: false }); if (!stat) return null;
  if (!stat.isFile() || stat.size > 32768) throw fault('UI_VOICE_PREVIEW_STATE_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('UI_VOICE_PREVIEW_STATE_INVALID'); }
}
function readState(file, binding) {
  const value = read(file); if (value === null) return null;
  if (!object(value) || Object.keys(binding).some(key => value[key] !== binding[key]) || !states.has(value.state) || !integer(value.createdAt) || !integer(value.updatedAt) || value.updatedAt < value.createdAt ||
      value.recordingPossible !== null && typeof value.recordingPossible !== 'boolean' || typeof value.stopBarrier !== 'boolean' || typeof value.nativeStopBarrier !== 'boolean' ||
      ['readerSessionStarted', 'readerSessionStopped'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean') ||
      ['reason', 'cleanupReason'].some(key => value[key] != null && !/^(?:UI|VOICE|DRAFT|AUDIO|READER_LOCAL_API)_[A-Z0-9_]{1,80}$/.test(value[key])) ||
      value.nativeReason != null && nativeReason(value.nativeReason) !== value.nativeReason ||
      value.submittedAt !== undefined && (!integer(value.submittedAt) || !integer(value.deadlineAt) || value.deadlineAt <= value.submittedAt || value.deadlineAt - value.submittedAt > 300000))
    throw fault('UI_VOICE_PREVIEW_STATE_INVALID');
  if(value.state==='cancelled'&&(!validVoiceInterruptionFacts(value.cancelledRecording)||value.recordingPossible!==false||value.nativeStopBarrier!==false||value.nativeReason!==value.cancelledRecording.reason||value.readerSessionStarted!==true||value.submittedAt===undefined||value.receipt!==undefined)||value.state!=='cancelled'&&value.cancelledRecording!==undefined)throw fault('UI_VOICE_PREVIEW_STATE_INVALID');
  try { safeHandoffReport(value.focusHandoff); safeNativeTiming(value.nativeTiming); }
  catch { throw fault('UI_VOICE_PREVIEW_STATE_INVALID'); }
  return value;
}
/** A cancelled clip is terminal only after the original Reader also stopped.
 * This is local ledger evidence; it never means a message was delivered. */
export function isFinishedCancelledVoicePreview(value){
  return object(value)&&value.version===1&&['deliveryId','audioSha256','accountScopeHash','accountRefHash','accountHash','accountDirectoryHash'].every(key=>digest(value[key]))&&
    value.target==='filehelper'&&value.state==='cancelled'&&validVoiceInterruptionFacts(value.cancelledRecording)&&value.nativeReason===value.cancelledRecording.reason&&value.receipt===undefined&&
    integer(value.submittedAt)&&integer(value.deadlineAt)&&value.deadlineAt>value.submittedAt&&value.deadlineAt-value.submittedAt<=300000&&
    value.recordingPossible===false&&value.nativeStopBarrier===false&&value.stopBarrier===false&&value.readerSessionStarted===true&&value.readerSessionStopped===true;
}
function acquire(file) {
  noLinks(file); const owner = crypto.randomUUID();
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return () => { noLinks(file); if (read(file)?.owner === owner) fs.unlinkSync(file); };
  } catch (error) { if (error.code === 'EEXIST') throw fault('UI_VOICE_PREVIEW_BUSY'); throw error; }
}
function receiptMatches(r, job, accountDirectory) {
  return object(r) && Object.keys(r).length === 14 && r.type === 'wechat-database-voice-v1' && r.deliveryId === job.id && r.account === job.account && r.accountDirectory === accountDirectory && r.target === 'filehelper' &&
    digest(r.sourceShard) && decimal(r.localId) && decimal(r.serverId) && integer(r.createTime) && r.createTime >= Math.floor(job.submittedAt / 1000) && r.createTime <= Math.floor(job.deadlineAt / 1000) &&
    integer(r.durationMs) && r.durationMs >= job.minDurationMs && r.durationMs <= job.maxDurationMs && integer(r.observedAt) && r.observedAt >= job.submittedAt &&
    r.nativeVoiceRowConfirmed === true && r.audioContentVerified === false && r.timbreVerified === false;
}
function freshSession(value, options, audio, now) {
  const { session, accountProof } = value ?? {}, evidence = accountProof?.evidence;
  if (!object(session) || session.target !== 'filehelper' || session.accountScopeHash !== options.accountScopeHash ||
      !object(accountProof) || accountProof.accountRef !== options.accountRef || accountProof.accountScopeHash !== options.accountScopeHash ||
      !object(evidence) || evidence.ok !== true || evidence.proof !== 'process-open-database-v1' || evidence.complete !== true || evidence.processOpenedExpectedDatabase !== true ||
      evidence.accountRootsObserved !== 1 || evidence.consistentPathScans !== 2 || evidence.snapshotAtomic !== false || evidence.processId !== session.pid || evidence.processCreatedFileTimeUtc !== session.processCreatedFileTimeUtc ||
      ['ready', 'desktopAccountVerified', 'targetVerified', 'draftVerified', 'inputSent'].some(key => evidence[key] !== false) || !integer(evidence.maximumEvidenceAgeMs) || evidence.maximumEvidenceAgeMs < 1 || evidence.maximumEvidenceAgeMs > 500)
    throw fault('UI_VOICE_PREVIEW_ACCOUNT_PROOF_INVALID');
  const observed = Date.parse(evidence.observedAtUtc), age = now() - observed;
  if (!Number.isFinite(observed) || age < 0 || age > evidence.maximumEvidenceAgeMs) throw fault('UI_VOICE_PREVIEW_ACCOUNT_PROOF_EXPIRED');
  const validated = validateTimedVoiceRequest({ id: options.deliveryId, audio, session, renderId: options.renderId, captureId: options.captureId,
    permission: options.permission, idleMs: options.idleMs ?? 1000, ...(value.focusHandoff !== undefined ? {focusHandoff:value.focusHandoff} : {}) }, now());
  return {session:structuredClone(session),...(validated.focusHandoff ? {focusHandoff:structuredClone(validated.focusHandoff)} : {})};
}
function report(state, reused) {
  const foregroundTiming=sanitizeForegroundTiming(state.foregroundTiming);
  const adaptiveRecordingUi=sanitizeAdaptiveRecordingUi(state.adaptiveRecordingUi);
  const uiaRecordingUi=sanitizeUiaRecordingUi(state.uiaRecordingUi);
  return { deliveryId: state.deliveryId, state: state.state, confirmed: state.state === 'confirmed', reused, audioSha256: state.audioSha256, audioDurationMs: state.audioDurationMs,
    ...(foregroundTiming?{foregroundTiming}:{}),
    ...(adaptiveRecordingUi?{adaptiveRecordingUi}:{}),...(uiaRecordingUi?{uiaRecordingUi}:{}),
    minDurationMs: state.minDurationMs, maxDurationMs: state.maxDurationMs, recordingPossible: state.recordingPossible, stopBarrier: state.stopBarrier, nativeStopBarrier: state.nativeStopBarrier,
    reason: state.reason ?? null, nativeReason: state.nativeReason ?? null, readerSessionStopped: state.readerSessionStopped === true,
    cleanupUnknown: state.readerSessionStarted === true && state.readerSessionStopped !== true, cleanupReason: state.cleanupReason ?? null,
    audioContentVerified: false, timbreVerified: false, ready: false, unattendedReady: false,
    ...(state.focusHandoff !== undefined ? {focusHandoff:safeHandoffReport(state.focusHandoff)} : {}),
    ...(state.nativeTiming !== undefined ? {nativeTiming:safeNativeTiming(state.nativeTiming)} : {}),
    ...(state.state === 'cancelled' ? {cancelledRecording:structuredClone(state.cancelledRecording)} : {}),
    ...(state.state === 'confirmed' ? { receipt: structuredClone(state.receipt) } : {}) };
}

/** Single filehelper preview. Existing IDs only query; an unresolved attempt
 * blocks other IDs. A row receipt never proves sound content or speaker timbre. */
export async function runVoiceSubmitPreview(options, dependencies = {}) {
  const binding = validateVoiceSubmitPreview(options), now = dependencies.now ?? Date.now;
  if (typeof options.freshSession !== 'function' || typeof now !== 'function') throw fault('UI_VOICE_PREVIEW_CONFIG_INVALID');
  if (options.signal?.aborted) throw fault('UI_VOICE_PREVIEW_ABORTED');
  const audio = Buffer.from(options.audio);
  options = { ...options, permission: { ...options.permission }, audio };
  let unlock, state, reused, callbackLive = true, nativeCalled = false;
  const directory = path.resolve(options.directory), file = path.join(directory, binding.deliveryId + '.json'), barrierFile = path.join(directory, 'active.json');
  const write = patch => { state = { ...state, ...patch, updatedAt: now() }; atomic(file, state); return state; };
  const releaseBarrier = () => {
    const barrier = read(barrierFile);
    if (barrier?.deliveryId !== binding.deliveryId || barrier.audioSha256 !== binding.audioSha256 || barrier.accountScopeHash !== binding.accountScopeHash) throw fault('UI_VOICE_PREVIEW_BARRIER_CHANGED');
    fs.unlinkSync(barrierFile); write({ stopBarrier: false });
  };
  try {
    noLinks(directory); fs.mkdirSync(directory, { recursive: true }); unlock = acquire(path.join(directory, 'worker.lock'));
    state = readState(file, binding); reused = state !== null;
    // Even a query can update this preview ledger. Do not race the operator's
    // byte-CAS reconciliation; the acquired worker lock closes the check race.
    assertVoiceRecoveryIdle(options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const barrier = read(barrierFile);
    if (barrier && (!object(barrier) || !digest(barrier.deliveryId) || !digest(barrier.audioSha256) || !digest(barrier.accountScopeHash))) throw fault('UI_VOICE_PREVIEW_STATE_INVALID');
    const operatorRecovery = reused ? read(path.join(directory, 'operator-recovered-' + binding.deliveryId + '.json')) : null;
    if (operatorRecovery) {
      if (Object.keys(operatorRecovery).length !== 4 || operatorRecovery.version !== 1 || operatorRecovery.deliveryId !== binding.deliveryId || operatorRecovery.audioSha256 !== binding.audioSha256 || operatorRecovery.accountScopeHash !== binding.accountScopeHash) throw fault('UI_VOICE_PREVIEW_STATE_INVALID');
      // The operator reviewed this old attempt and only released its recording
      // ownership. Keep the original result, never recreate its active barrier
      // or turn the same delivery ID into another recording.
      return report(state, true);
    }
    if (barrier && (barrier.deliveryId !== binding.deliveryId || !state)) throw fault('UI_VOICE_PREVIEW_RECOVERY_REQUIRED');
    if (!state) {
      atomic(barrierFile, { version: 1, deliveryId: binding.deliveryId, audioSha256: binding.audioSha256, accountScopeHash: binding.accountScopeHash });
      state = { ...binding, state: 'created', createdAt: now(), updatedAt: now(), recordingPossible: false, stopBarrier: true, nativeStopBarrier: false }; atomic(file, state);
    }
    const job = () => ({ id: binding.deliveryId, account: options.accountWxid, target: 'filehelper', submittedAt: state.submittedAt, deadlineAt: state.deadlineAt,
      minDurationMs: binding.minDurationMs, maxDurationMs: binding.maxDurationMs });
    if (state.state === 'confirmed') { if (!receiptMatches(state.receipt, job(), options.accountDirectory)) throw fault('UI_VOICE_PREVIEW_STATE_INVALID'); return report(state, true); }
    if(state.state==='cancelled'){
      // A crash after observing Reader shutdown but before deleting active.json
      // may finish only that exact cleanup. No new Reader or input is started.
      if(barrier&&state.readerSessionStopped===true)releaseBarrier();
      return report(state,true);
    }
    if (state.state === 'not-recorded' || reused && state.submittedAt === undefined) return report(state, true);
    // If an operator removed an unresolved barrier, do not silently enable a new ID.
    if (reused && !barrier) atomic(barrierFile, { version: 1, deliveryId: binding.deliveryId, audioSha256: binding.audioSha256, accountScopeHash: binding.accountScopeHash });
    const withApi = dependencies.withLocalReceiptApi ?? (await import('./reader-local-api.mjs')).withLocalReceiptApi;
    const receiptsFactory = dependencies.receiptsFactory ?? (config => new UiVoiceReaderReceipts(config));
    const runNative = dependencies.runTimedVoicePreview ?? (async request => (await import('./timed-voice-preview.mjs')).runTimedVoicePreview(request));
    const wait = dependencies.wait ?? ((ms, signal) => new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => finish(fault('UI_VOICE_PREVIEW_ABORTED'));
      const timer = setTimeout(() => finish(), ms); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    }));
    try {
      write({ readerSessionStarted: true, readerSessionStopped: false, cleanupReason: null });
      const apiResult = await withApi({ root: options.root, expectedAccountRef: options.accountRef, timeoutMs: 30000, signal: options.signal, callback: async context => {
        const signal = options.signal ? AbortSignal.any([options.signal, context.signal]) : context.signal;
        const active = () => {
          if (!callbackLive) throw fault('UI_VOICE_PREVIEW_CALLBACK_CLOSED');
          if (signal?.aborted) throw fault('UI_VOICE_PREVIEW_ABORTED');
          if (!integer(context.expiresAt) || now() >= context.expiresAt) throw fault('UI_VOICE_PREVIEW_SESSION_EXPIRED');
        };
        active();
        if (context.accountRef !== options.accountRef || context.accountWxid !== options.accountWxid || context.accountDirectory !== options.accountDirectory) throw fault('UI_VOICE_PREVIEW_READER_ACCOUNT_MISMATCH');
        const receipts = receiptsFactory({ directory: path.join(directory, 'receipts'), baseUrl: context.baseUrl, token: context.token, accountWxid: options.accountWxid, accountDirectory: options.accountDirectory, now });
        const checked = await receipts.checkBinding({ signal }); active();
        if (checked?.verified !== true || checked.account !== options.accountWxid || checked.accountDirectory !== options.accountDirectory) throw fault('UI_VOICE_PREVIEW_READER_ACCOUNT_MISMATCH');
        if (!reused) {
          if (context.expiresAt - now() < 22000) throw fault('UI_VOICE_PREVIEW_SESSION_EXPIRED');
          write({ state: 'preparing', submittedAt: now(), deadlineAt: context.expiresAt - 250 });
          const prepared = await receipts.prepare(job(), { signal }); active();
          if (prepared?.submissionAllowed !== true) throw fault('UI_VOICE_PREVIEW_PREPARATION_REFUSED');
          write({ state: 'prepared' });
          const fresh = await options.freshSession({ accountRef: options.accountRef, accountScopeHash: options.accountScopeHash, signal }); active();
          const {session,focusHandoff} = freshSession(fresh, options, audio, now); active();
          if (context.expiresAt - now() < 21000) throw fault('UI_VOICE_PREVIEW_SESSION_EXPIRED');
          write({ state: 'voice-intent', recordingPossible: null, nativeStopBarrier: true, reason: null });
          freshSession(fresh, options, audio, now); active();
          nativeCalled = true;
          let native;
          try { native = await runNative({ root: options.root, id: binding.deliveryId, audio, session, renderId: options.renderId, captureId: options.captureId,
            permission: options.permission, idleMs: options.idleMs ?? 1000, signal, ...(focusHandoff ? {focusHandoff} : {}) }); }
          catch (error) {
            const rejectedBeforeExecution = error?.warmExecutionStarted === false && error.nativeStarted === false && error.recordingPossible === false && error.submitAttempted === false;
            native = { recordingPossible: error?.recordingPossible, submitAttempted: error?.submitAttempted, reason: nativeReason(error?.code),
              ...(rejectedBeforeExecution ? { recordingAttempted: false, stopBarrier: false } : {}) };
          }
          active();
          // Retain only bounded, anonymous native diagnostics. Return-window
          // handles, process identities and arbitrary helper output stay local
          // to the request and never enter persisted/public preview reports.
          if (!focusHandoff && native?.focusHandoff !== undefined || focusHandoff && native?.submitInputApplied === true && native?.focusHandoff === undefined)
            throw fault('UI_VOICE_PREVIEW_NATIVE_REPORT_INVALID');
          const handoff = safeHandoffReport(native?.focusHandoff);
          const adaptiveRecordingUi=sanitizeAdaptiveRecordingUi(native?.adaptiveRecordingUi);
          const uiaRecordingUi=sanitizeUiaRecordingUi(native?.uiaRecordingUi);
          if(handoff?.backgroundSubmit&&(!session.recordingUi?.uia||!uiaRecordingUi?.bound||!uiaRecordingUi.conversationVerified||
              handoff.backgroundSubmit.attempted!==native.submitAttempted||handoff.backgroundSubmit.applied!==native.submitInputApplied||
              handoff.backgroundSubmit.confirmed&&(native.recordingEndedObserved!==true||native.recordingPossible!==false)))throw fault('UI_VOICE_PREVIEW_NATIVE_REPORT_INVALID');
          const foregroundTiming=makeForegroundTiming({operation:'voice',preparationIntervals:fresh?.foregroundIntervals,nativeIntervals:handoff?.foregroundIntervals});
          if(foregroundTiming)recordForegroundTiming({root:options.root,timing:foregroundTiming,now});
          const timing = durationFields.some(key => native?.[key] !== undefined) || native?.timelineMs !== undefined ? safeNativeTiming(native) : undefined;
          const recordingPossible = typeof native?.recordingPossible === 'boolean' ? native.recordingPossible : null;
          const nativeStopBarrier = native?.stopBarrier !== false;
          const refused = native?.recordingAttempted === false && native?.submitAttempted === false && recordingPossible === false && !nativeStopBarrier;
          const cancelledRecording=voiceInterruptionFacts(native);
          write({ state: cancelledRecording ? 'cancelled' : refused ? 'not-recorded' : native?.submitAttempted === true && native?.submitInputApplied === true ? 'submitted' : 'unknown',
            recordingPossible, nativeStopBarrier, nativeReason: nativeReason(native?.reason), reason: cancelledRecording ? 'UI_VOICE_PREVIEW_INTERRUPTED_CANCELLED' : refused ? 'UI_VOICE_PREVIEW_NATIVE_REFUSED' : null,
            ...(cancelledRecording?{cancelledRecording}:{}),
            ...(handoff ? {focusHandoff:handoff} : {}),...(timing ? {nativeTiming:timing} : {}),...(foregroundTiming?{foregroundTiming}:{}),...(adaptiveRecordingUi?{adaptiveRecordingUi}:{}),...(uiaRecordingUi?{uiaRecordingUi}:{}) });
          if (refused||cancelledRecording) return;
        }
        // A recorder that may still be active needs the operator immediately.
        // One bounded receipt read can observe a just-submitted bubble, but a
        // polling loop would waste the remaining time before auto-submission.
        const recordingMayContinue = state.recordingPossible !== false;
        for (let count = 0; count < (recordingMayContinue ? 1 : 40); count++) {
          active(); const result = await receipts.query(job(), { signal }); active();
          if (result?.confirmed === true) {
            if (!receiptMatches(result.receipt, job(), options.accountDirectory)) throw fault('UI_VOICE_PREVIEW_RECEIPT_MISMATCH');
            write({ state: 'confirmed', receipt: structuredClone(result.receipt), reason: null }); return;
          }
          if (recordingMayContinue) break;
          if (now() >= state.deadlineAt || context.expiresAt - now() < 750) break;
          await wait(500, signal);
        }
        write({ state: 'unknown', reason: 'UI_VOICE_PREVIEW_RECEIPT_UNCONFIRMED' });
      } });
      callbackLive = false;
      if (apiResult?.processStopped !== true) throw fault('UI_VOICE_PREVIEW_READER_CLEANUP_UNCONFIRMED');
      write({ readerSessionStopped: true, cleanupReason: null });
    } catch (error) {
      callbackLive = false;
      const neverCalled = !reused && !nativeCalled;
      write({ readerSessionStopped: false, cleanupReason: safeReason(error),
        ...(state.state !== 'confirmed' && state.state !== 'not-recorded' && state.state !== 'cancelled' ? { state: neverCalled ? 'not-recorded' : 'unknown', recordingPossible: neverCalled ? false : state.recordingPossible, nativeStopBarrier: neverCalled ? false : state.nativeStopBarrier, reason: safeReason(error) } : {}) });
    } finally { callbackLive = false; }
    if (state.state === 'not-recorded' || ['confirmed','cancelled'].includes(state.state) && state.recordingPossible === false && !state.nativeStopBarrier && state.readerSessionStopped === true) releaseBarrier();
    return report(state, reused);
  } finally { callbackLive = false; audio.fill(0); unlock?.(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--check') console.log(JSON.stringify({ module: 'ui-voice-preview-submit', target: 'filehelper', developmentOnly: true, ready: false, inputSent: false, cliSendSupported: false }));
  else { console.error('UI_VOICE_PREVIEW_CLI_SEND_UNSUPPORTED'); process.exitCode = 1; }
}
