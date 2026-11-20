import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runTimedVoiceSend, validateTimedVoiceSendRequest, validateVoiceFocusHandoff } from './timed-voice-preview.mjs';
import { warmVoiceMonitor } from './voice-warm-monitor.mjs';
import { UiVoiceReaderReceipts } from './ui-voice-reader-receipts.mjs';
import { validSelectionScope } from '../components/qq-bridge/src/core/selection-scope.js';
import { validateAccountEvidence } from './account-probe.mjs';
import { makeForegroundTiming, recordForegroundTiming, sanitizeForegroundTiming } from './foreground-timing.mjs';
import {sanitizeAdaptiveRecordingUi,sanitizeUiaRecordingUi} from './voice-recording-layout.mjs';
import {voiceInterruptionEvidence,validVoiceInterruptionEvidence} from './voice-interruption-evidence.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = code => Object.assign(new Error(code), { code });
const defaultPlan = () => ({ allowed: true, executionMode: 'focus-handoff', textEntryMode:'paste', activityGuardScope:'handoff-only', requiresForeground: true, requiresActivityGuard: true, policyVersion: null });
function voicePlan(value) {
  if (!object(value) || value.allowed !== true || value.executionMode !== 'focus-handoff' ||
      value.requiresForeground !== true || value.requiresActivityGuard !== true ||
      value.activityGuardScope !== 'handoff-only') throw fault('NATIVE_VOICE_INTERACTION_PLAN_BLOCKED');
  if (value.textEntryMode !== undefined && value.textEntryMode!=='paste') throw fault('NATIVE_VOICE_INTERACTION_PLAN_BLOCKED');
  return { executionMode:'focus-handoff', policyVersion: value.policyVersion ?? null, textEntryMode:'paste', allowed: true,
    requiresForeground: true, requiresActivityGuard: true, activityGuardScope:'handoff-only' };
}
const safeCode = value => /^[A-Z][A-Z0-9_]{2,80}$/.test(value ?? '') ? value : 'NATIVE_VOICE_TRANSPORT_FAILED';
function noLinks(file) { for (let item = path.resolve(file); ; item = path.dirname(item)) { if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('NATIVE_VOICE_LINK_REJECTED'); if (path.dirname(item) === item) return; } }
function read(file) {
  noLinks(file); const info = fs.statSync(file, { throwIfNoEntry: false }); if (!info) return null;
  if (!info.isFile() || info.size > 32768) throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID'); }
}
function atomic(file, value) {
  noLinks(file); const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { const fd = fs.openSync(temp, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } noLinks(file); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function bind(job) {
  if (!object(job) || !digest(job.id) || !digest(job.audioSha256) || !digest(job.voiceId) || !validSelectionScope(job.selectionScope) || job.selectionScope?.account !== job.account || job.selectionScope?.target !== job.target ||
      !digest(job.selectionScope?.accountRef) || !Number.isFinite(job.durationMs) || job.durationMs <= 0 || job.durationMs > 8000) throw fault('NATIVE_VOICE_TRANSPORT_JOB_INVALID');
  return { version: 1, id: job.id, account: job.account, target: job.target, accountRef: job.selectionScope.accountRef, voiceId: job.voiceId, audioSha256: job.audioSha256, durationMs: job.durationMs };
}
function validateFresh(fresh, job, request, now) {
  const session = fresh?.session, proof = fresh?.accountProof, evidence = proof?.evidence;
  if (!object(session) || session.target !== job.target || session.targetProof?.accountRef !== job.selectionScope.accountRef || !object(proof) ||
      proof.accountRef !== job.selectionScope.accountRef || proof.accountScopeHash !== session.accountScopeHash ||
      evidence?.ok !== true || evidence.proof !== 'process-open-database-v1' || evidence.complete !== true || evidence.processOpenedExpectedDatabase !== true ||
      evidence.accountRootsObserved !== 1 || evidence.consistentPathScans !== 2 || evidence.snapshotAtomic !== false || evidence.processId !== session.pid || evidence.processCreatedFileTimeUtc !== session.processCreatedFileTimeUtc ||
      ['ready', 'desktopAccountVerified', 'targetVerified', 'draftVerified', 'inputSent'].some(key => evidence[key] !== false) ||
      !Number.isInteger(evidence.maximumEvidenceAgeMs) || evidence.maximumEvidenceAgeMs < 1 || evidence.maximumEvidenceAgeMs > 500) throw fault('NATIVE_VOICE_ACCOUNT_PROOF_INVALID');
  const age = now() - Date.parse(evidence.observedAtUtc);
  if (!Number.isFinite(age) || age < 0 || age > evidence.maximumEvidenceAgeMs) throw fault('NATIVE_VOICE_ACCOUNT_PROOF_EXPIRED');
  validateAccountEvidence(evidence, session, now());
  return validateTimedVoiceSendRequest({ ...request, session }, now()).session;
}

/** Concrete Qt -> bounded native voice -> database receipt transport. Windows
 * capture defaults must already select the configured CABLE endpoint. This
 * transport never changes them; routeMode:'unchanged' is not a restore claim. */
export class NativeVoiceTransport {
  constructor({ root = path.resolve(import.meta.dirname, '..'), driver, receiptContext, renderId, captureId, now = Date.now,
    runNative = runTimedVoiceSend, warmMonitorFactory = runNative === runTimedVoiceSend ? warmVoiceMonitor : null,
    currentPlan = defaultPlan, receiptsFactory = config => new UiVoiceReaderReceipts(config), receiptPollMs = 200, receiptWaitMs = 5000 } = {}) {
    if (!driver || typeof driver.prepareVoiceSession !== 'function' || typeof receiptContext !== 'function' || typeof runNative !== 'function' || typeof receiptsFactory !== 'function' ||
        typeof renderId !== 'string' || !renderId || typeof captureId !== 'string' || !captureId || renderId === captureId || typeof now !== 'function' || typeof currentPlan !== 'function' ||
        warmMonitorFactory !== null && typeof warmMonitorFactory !== 'function' || runNative === runTimedVoiceSend && warmMonitorFactory === null ||
        !Number.isInteger(receiptWaitMs) || receiptWaitMs < 0 || receiptWaitMs > 10000 || !Number.isInteger(receiptPollMs) || receiptPollMs < 10 || receiptPollMs > 1000)
      throw fault('NATIVE_VOICE_TRANSPORT_CONFIG_INVALID');
    Object.assign(this, { root, driver, receiptContext, renderId, captureId, now, runNative, warmMonitorFactory, currentPlan, receiptsFactory, receiptPollMs, receiptWaitMs });
    this.directory = path.join(root, 'state/native-voice-transport'); this.running = false; this.closed = false;
  }
  #file(id) { return path.join(this.directory, id + '.json'); }
  #load(binding) {
    const state = read(this.#file(binding.id)); if (!state) return null;
    if (!object(state) || Object.keys(binding).some(key => state[key] !== binding[key]) || !['prepared', 'record-intent', 'finished', 'unknown'].includes(state.state) ||
        !Number.isSafeInteger(state.submittedAt) || !Number.isSafeInteger(state.deadlineAt) || state.deadlineAt <= state.submittedAt || state.deadlineAt - state.submittedAt > 60000 ||
        typeof state.accountDirectory !== 'string' || state.accountDirectory.length > 256 || /[\\/\0]/.test(state.accountDirectory)) throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
    if(state.submitAttempted!==undefined&&state.submitAttempted!==null&&typeof state.submitAttempted!=='boolean')throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
    if(state.interruptionCancellation!==undefined&&(!validVoiceInterruptionEvidence(state.interruptionCancellation,binding)||state.state!=='finished'||state.attempted!==true||state.submitAttempted!==false||state.recordingPossible!==false||state.stopBarrier!==false||state.routeSafe!==true||state.reason!==state.interruptionCancellation.reason))throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
    return state;
  }
  #receiptJob(state) { return { id: state.id, account: state.account, target: state.target, submittedAt: state.submittedAt, deadlineAt: state.deadlineAt,
    minDurationMs: Math.max(1, Math.floor(state.durationMs) - 250), maxDurationMs: Math.ceil(state.durationMs) + 4000 }; }
  async #receipts(job, expectedDirectory) {
    const context = await this.receiptContext(job);
    if (context?.accountWxid !== job.account || context.accountRef !== job.selectionScope.accountRef || typeof context.accountDirectory !== 'string' ||
        expectedDirectory !== undefined && context.accountDirectory !== expectedDirectory) throw fault('NATIVE_VOICE_READER_BINDING_CHANGED');
    return { accountDirectory: context.accountDirectory, receipts: this.receiptsFactory({ directory: path.join(this.directory, 'receipts'),
      baseUrl: context.baseUrl, token: context.token, accountWxid: job.account, accountDirectory: context.accountDirectory, allowedTargets: [job.target], now: this.now }) };
  }
  #result(state, receipt) {
    const safe = state.recordingPossible === false && state.stopBarrier === false && state.routeSafe === true;
    const cancellation=validVoiceInterruptionEvidence(state.interruptionCancellation,state)?state.interruptionCancellation:undefined;
    const confirmed = !cancellation && state.submitAttempted!==false && safe && state.attempted === true && receipt?.confirmed === true;
    const foregroundTiming=sanitizeForegroundTiming(state.foregroundTiming);
    const adaptiveRecordingUi=sanitizeAdaptiveRecordingUi(state.adaptiveRecordingUi);
    const uiaRecordingUi=sanitizeUiaRecordingUi(state.uiaRecordingUi);
    return { confirmed, ...(confirmed ? { receipt: receipt.receipt } : {}),...(foregroundTiming?{foregroundTiming}:{}),
      ...(adaptiveRecordingUi?{adaptiveRecordingUi}:{}),...(uiaRecordingUi?{uiaRecordingUi}:{}),...(cancellation?{interruptionCancellation:structuredClone(cancellation)}:{}),
      attempted: state.attempted ?? null, recordingPossible: state.recordingPossible ?? true, stopBarrier: state.stopBarrier !== false,
      routeSafe: state.routeSafe === true, routeMode: 'unchanged', reason: state.reason ?? receipt?.reason ?? null };
  }
  async querySegment(job, { signal } = {}) {
    const binding = bind(job), state = this.#load(binding);
    if (!state) return { confirmed: false, recordingPossible: true, stopBarrier: true, routeSafe: false, reason: 'NATIVE_VOICE_ATTEMPT_MISSING' };
    if(state.interruptionCancellation)return this.#result(state);
    let result;
    try { const { receipts } = await this.#receipts(job, state.accountDirectory); result = await receipts.query(this.#receiptJob(state), { signal }); }
    catch (error) { result = { confirmed: false, reason: safeCode(error.code) }; }
    return this.#result(state, result);
  }
  async sendSegment(job, { signal, canSubmit, executionDeadlineAt } = {}) {
    const binding = bind(job);
    if (this.running) throw fault('NATIVE_VOICE_TRANSPORT_BUSY');
    if (this.closed) throw fault('NATIVE_VOICE_TRANSPORT_CLOSED');
    if (!Buffer.isBuffer(job.audio) || hash(job.audio) !== job.audioSha256 || typeof canSubmit !== 'function' ||
        executionDeadlineAt !== undefined && (!Number.isSafeInteger(executionDeadlineAt) || executionDeadlineAt <= this.now())) throw fault('NATIVE_VOICE_TRANSPORT_JOB_INVALID');
    this.running = true; let finishRun;
    this.runController = new AbortController(); signal = signal ? AbortSignal.any([signal, this.runController.signal]) : this.runController.signal;
    this.runCompletion = new Promise(resolve => { finishRun = resolve; });
    let state, fresh, warmMonitor, nativeStarted = false;
    const active = () => { if (signal?.aborted || canSubmit() !== true) throw fault('NATIVE_VOICE_SELECTION_OR_ACTIVITY_CHANGED'); };
    const write = patch => { state = { ...state, ...patch }; atomic(this.#file(binding.id), state); };
    try {
      noLinks(this.directory); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      state = this.#load(binding); if (state) return await this.querySegment(job, { signal });
      const interactionPlan = voicePlan(this.currentPlan());
      const planUnchanged = () => { const live = voicePlan(this.currentPlan());
        if (live.executionMode !== interactionPlan.executionMode || live.policyVersion !== interactionPlan.policyVersion || live.textEntryMode !== interactionPlan.textEntryMode) throw fault('NATIVE_VOICE_INTERACTION_PLAN_CHANGED'); };
      active(); const { receipts, accountDirectory } = await this.#receipts(job); active();
      state = { ...binding, accountDirectory, state: 'prepared', submittedAt: this.now(), deadlineAt: this.now() + 60000,
        attempted: false, recordingPossible: false, stopBarrier: false, routeSafe: true }; write({});
      const prepared = await receipts.prepare(this.#receiptJob(state), { signal }); active();
      if (prepared?.submissionAllowed !== true) throw fault('NATIVE_VOICE_RECEIPT_PREPARATION_REFUSED');
      // Start read-only monitoring before Qt navigation. The native process
      // acquires no UI/audio mutex until the later, single execution commit.
      if (this.warmMonitorFactory) {
        warmMonitor = await this.warmMonitorFactory({ root: this.root, signal });
        if (!warmMonitor || typeof warmMonitor.close !== 'function' || typeof warmMonitor.drain !== 'function') throw fault('NATIVE_VOICE_WARMUP_INVALID');
        active(); planUnchanged();
      }
      fresh = await this.driver.prepareVoiceSession(job, { signal, interactionPlan }); active(); planUnchanged();
      const focusHandoff = validateVoiceFocusHandoff(fresh?.focusHandoff, fresh?.session);
      if (focusHandoff === undefined) throw fault('NATIVE_VOICE_FOCUS_HANDOFF_MISSING');
      const request = { root: this.root, id: job.id, audio: job.audio, renderId: this.renderId, captureId: this.captureId,
        permission: { recordNativeVoice: true, playAudio: true, submitNativeVoice: true, cancelOwnedRecording: true }, signal,
        focusHandoff, ...(warmMonitor ? { warmMonitor } : {}) };
      const session = validateFresh(fresh, job, request, this.now); active();
      // Navigation/OCR may consume most of the outer operation budget. Reserve
      // the bounded native process lifetime plus cleanup before opening a recorder.
      if (Math.min(state.deadlineAt, executionDeadlineAt ?? Infinity) - this.now() < 20000) throw fault('NATIVE_VOICE_START_BUDGET_EXHAUSTED');
      write({ state: 'record-intent', attempted: null, recordingPossible: true, stopBarrier: true, routeSafe: false });
      validateFresh(fresh, job, request, this.now); active(); planUnchanged(); nativeStarted = true;
      const native = await this.runNative({ ...request, session });
      if (native?.nativeStarted === false && native?.recordingPossible === false) nativeStarted = false;
      const ended = native?.recordingPossible === false && native?.stopBarrier === false;
      const foregroundTiming=makeForegroundTiming({operation:'voice',preparationIntervals:fresh?.foregroundIntervals,nativeIntervals:native?.focusHandoff?.foregroundIntervals});
      const adaptiveRecordingUi=sanitizeAdaptiveRecordingUi(native?.adaptiveRecordingUi);
      const uiaRecordingUi=sanitizeUiaRecordingUi(native?.uiaRecordingUi);
      const interruptionCancellation=voiceInterruptionEvidence(native,binding);
      if(foregroundTiming)recordForegroundTiming({root:this.root,timing:foregroundTiming,now:this.now});
      write({ state: ended ? 'finished' : 'unknown', attempted: native?.recordingAttempted === false && native?.submitAttempted === false ? false : true,
        submitAttempted:typeof native?.submitAttempted==='boolean'?native.submitAttempted:null,
        ...(foregroundTiming?{foregroundTiming}:{}),
        ...(adaptiveRecordingUi?{adaptiveRecordingUi}:{}),...(uiaRecordingUi?{uiaRecordingUi}:{}),...(interruptionCancellation?{interruptionCancellation}:{}),
        recordingPossible: native?.recordingPossible === false ? false : true, stopBarrier: !ended,
        routeSafe: native?.systemSettingsChanged === false, reason: native?.reason ? safeCode(native.reason) : null });
      if(interruptionCancellation)return this.#result(state);
      // Receipt reads remain permitted after cancellation; they never retry input.
      const query = async () => { try { return await receipts.query(this.#receiptJob(state), { signal }); } catch (error) { return { confirmed: false, reason: safeCode(error.code) }; } };
      let result = await query();
      const deadline = Date.now() + this.receiptWaitMs;
      while (!result?.confirmed && Date.now() < deadline && !signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, this.receiptPollMs));
        result = await query();
      }
      return this.#result(state, result);
    } catch (error) {
      if (error?.nativeStarted === false && error.recordingPossible === false && error.submitAttempted === false) nativeStarted = false;
      if (state) {
        write({ state: nativeStarted ? 'unknown' : 'finished', reason: safeCode(error.code), attempted: nativeStarted ? null : false,
          recordingPossible: nativeStarted, stopBarrier: nativeStarted, routeSafe: !nativeStarted });
        return this.#result(state);
      }
      // Before a receipt baseline/session exists, no recording helper has been
      // entered. Report that proof explicitly instead of creating an unknown
      // recording barrier for a missing reader or configuration.
      return { confirmed: false, attempted: false, recordingPossible: false, stopBarrier: false, routeSafe: true, routeMode: 'unchanged', reason: safeCode(error.code) };
    } finally {
      // Before native ownership transfers, release a successful preparation's
      // focus lease even if authorization or validation failed afterwards.
      // Unknown native outcomes never cause a second blind foreground action.
      try {
        let focusCleanupConfirmed=nativeStarted||!fresh?.focusHandoff;
        try { if (typeof warmMonitor?.close === 'function') await warmMonitor.close(); if (typeof warmMonitor?.drain === 'function') await warmMonitor.drain(); }
        finally { if (!nativeStarted && typeof fresh?.releaseFocus === 'function') {const released=await fresh.releaseFocus();focusCleanupConfirmed=released?.restored===true||released?.skipped===true;} }
        this.driver.finishVoiceInteraction?.({jobId:job.id,cleanupConfirmed:focusCleanupConfirmed&&state?.recordingPossible===false&&state?.stopBarrier===false&&state?.routeSafe===true});
      }
      finally { this.running = false; this.runController = null; this.runCompletion = null; finishRun(); }
    }
  }
  close() { this.closed = true; this.runController?.abort(); }
  async drain() { if (this.runCompletion) await this.runCompletion; }
}
