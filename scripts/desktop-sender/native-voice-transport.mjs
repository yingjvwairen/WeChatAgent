import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runTimedVoiceSend, validateTimedVoiceSendRequest, validateVoiceFocusHandoff } from './timed-voice-preview.mjs';
import { warmVoiceMonitor } from './voice-warm-monitor.mjs';
const defaultReceipts = () => {
  throw new Error('DESKTOP_RECEIPT_PROVIDER_REQUIRED');
};
import { validSelectionScope } from './selection-scope.mjs';
import { validateAccountEvidence } from './account-probe.mjs';
import { makeForegroundTiming, recordForegroundTiming, sanitizeForegroundTiming } from './foreground-timing.mjs';
import { sanitizeAdaptiveRecordingUi, sanitizeUiaRecordingUi } from './voice-recording-layout.mjs';
import {
  voiceInterruptionEvidence,
  validVoiceInterruptionEvidence,
  voiceRecordingCancellationEvidence,
  validVoiceRecordingCancellationEvidence,
} from './voice-interruption-evidence.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = code => Object.assign(new Error(code), { code });
const defaultPlan = () => ({
  allowed: true,
  executionMode: 'focus-handoff',
  textEntryMode: 'paste',
  activityGuardScope: 'handoff-only',
  requiresForeground: true,
  requiresActivityGuard: true,
  policyVersion: null,
});
function voicePlan(value) {
  if (
    !object(value) ||
    value.allowed !== true ||
    value.executionMode !== 'focus-handoff' ||
    value.requiresForeground !== true ||
    value.requiresActivityGuard !== true ||
    value.activityGuardScope !== 'handoff-only'
  )
    throw fault('NATIVE_VOICE_INTERACTION_PLAN_BLOCKED');
  if (value.textEntryMode !== undefined && value.textEntryMode !== 'paste')
    throw fault('NATIVE_VOICE_INTERACTION_PLAN_BLOCKED');
  return {
    executionMode: 'focus-handoff',
    policyVersion: value.policyVersion ?? null,
    textEntryMode: 'paste',
    allowed: true,
    requiresForeground: true,
    requiresActivityGuard: true,
    activityGuardScope: 'handoff-only',
  };
}
const safeCode = value => (/^[A-Z][A-Z0-9_]{2,80}$/.test(value ?? '') ? value : 'NATIVE_VOICE_TRANSPORT_FAILED');
function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('NATIVE_VOICE_LINK_REJECTED');
    if (path.dirname(item) === item) return;
  }
}
function read(file) {
  noLinks(file);
  const info = fs.statSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.size > 32768) throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
  }
}
function atomic(file, value) {
  noLinks(file);
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    noLinks(file);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function bind(job) {
  if (
    !object(job) ||
    !digest(job.id) ||
    !digest(job.audioSha256) ||
    !digest(job.voiceId) ||
    !validSelectionScope(job.selectionScope) ||
    job.selectionScope?.account !== job.account ||
    job.selectionScope?.target !== job.target ||
    !digest(job.selectionScope?.accountRef) ||
    !Number.isFinite(job.durationMs) ||
    job.durationMs <= 0 ||
    job.durationMs > 8000
  )
    throw fault('NATIVE_VOICE_TRANSPORT_JOB_INVALID');
  return {
    version: 1,
    id: job.id,
    account: job.account,
    target: job.target,
    accountRef: job.selectionScope.accountRef,
    voiceId: job.voiceId,
    audioSha256: job.audioSha256,
    durationMs: job.durationMs,
  };
}
function readTransportState(directory, binding) {
  const state = read(path.join(directory, binding.id + '.json'));
  if (!state) return null;
  if (
    !object(state) ||
    Object.keys(binding).some(key => state[key] !== binding[key]) ||
    !['prepared', 'record-intent', 'finished', 'unknown'].includes(state.state) ||
    !Number.isSafeInteger(state.submittedAt) ||
    !Number.isSafeInteger(state.deadlineAt) ||
    state.deadlineAt <= state.submittedAt ||
    state.deadlineAt - state.submittedAt > 60000 ||
    typeof state.accountDirectory !== 'string' ||
    state.accountDirectory.length > 256 ||
    /[\\/\0]/.test(state.accountDirectory) ||
    (state.recording !== undefined &&
      (!object(state.recording) ||
        !Number.isSafeInteger(state.recording.startedAt) ||
        !Number.isSafeInteger(state.recording.releasedAt)))
  )
    throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
  if (
    state.submitAttempted !== undefined &&
    state.submitAttempted !== null &&
    typeof state.submitAttempted !== 'boolean'
  )
    throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
  if (
    state.focusRecoveryRequired !== undefined &&
    (state.focusRecoveryRequired !== true ||
      state.state !== 'finished' ||
      !(
        (state.attempted === false && state.submitAttempted === false) ||
        (state.attempted === true &&
          (state.submitAttempted === true ||
            validVoiceRecordingCancellationEvidence(state.recordingCancellation, binding)))
      ) ||
      state.recordingPossible !== false ||
      state.stopBarrier !== false ||
      state.routeSafe !== true ||
      safeCode(state.focusRecoveryError) !== state.focusRecoveryError)
  )
    throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
  if (
    state.interruptionCancellation !== undefined &&
    (!validVoiceInterruptionEvidence(state.interruptionCancellation, binding) ||
      state.state !== 'finished' ||
      state.attempted !== true ||
      state.submitAttempted !== false ||
      state.recordingPossible !== false ||
      state.stopBarrier !== false ||
      state.routeSafe !== true ||
      state.reason !== state.interruptionCancellation.reason)
  )
    throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
  if (
    state.recordingCancellation !== undefined &&
    (state.interruptionCancellation !== undefined ||
      !validVoiceRecordingCancellationEvidence(state.recordingCancellation, binding) ||
      state.state !== 'finished' ||
      state.attempted !== true ||
      state.submitAttempted !== false ||
      state.recordingPossible !== false ||
      state.stopBarrier !== false ||
      state.routeSafe !== true ||
      state.reason !== state.recordingCancellation.reason)
  )
    throw fault('NATIVE_VOICE_TRANSPORT_STATE_INVALID');
  return state;
}

const canQueryVoiceReceipt = state =>
  state?.attempted === true &&
  state.submitAttempted !== false &&
  !state.interruptionCancellation &&
  !state.recordingCancellation;

const recordingReleased = state =>
  state.recordingPossible === false && state.stopBarrier === false && state.routeSafe === true;

export function storedVoiceSubmission(root, job) {
  const state = readTransportState(path.join(root, 'state/native-voice-transport'), bind(job));
  if (!canQueryVoiceReceipt(state) || state.submitAttempted !== true) return null;
  return { recording: state.recording, inputReleased: recordingReleased(state) && !state.focusRecoveryRequired };
}

function validateFresh(fresh, job, request, now) {
  const session = fresh?.session,
    proof = fresh?.accountProof,
    evidence = proof?.evidence;
  if (
    !object(session) ||
    session.target !== job.target ||
    session.targetProof?.accountRef !== job.selectionScope.accountRef ||
    !object(proof) ||
    proof.accountRef !== job.selectionScope.accountRef ||
    proof.accountScopeHash !== session.accountScopeHash ||
    evidence?.ok !== true ||
    evidence.proof !== 'process-open-database-v1' ||
    evidence.complete !== true ||
    evidence.processOpenedExpectedDatabase !== true ||
    evidence.accountRootsObserved !== 1 ||
    evidence.consistentPathScans !== 2 ||
    evidence.snapshotAtomic !== false ||
    evidence.processId !== session.pid ||
    evidence.processCreatedFileTimeUtc !== session.processCreatedFileTimeUtc ||
    ['ready', 'desktopAccountVerified', 'targetVerified', 'draftVerified', 'inputSent'].some(
      key => evidence[key] !== false,
    ) ||
    !Number.isInteger(evidence.maximumEvidenceAgeMs) ||
    evidence.maximumEvidenceAgeMs < 1 ||
    evidence.maximumEvidenceAgeMs > 500
  )
    throw fault('NATIVE_VOICE_ACCOUNT_PROOF_INVALID');
  const age = now() - Date.parse(evidence.observedAtUtc);
  if (!Number.isFinite(age) || age < 0 || age > evidence.maximumEvidenceAgeMs)
    throw fault('NATIVE_VOICE_ACCOUNT_PROOF_EXPIRED');
  validateAccountEvidence(evidence, session, now());
  return validateTimedVoiceSendRequest({ ...request, session }, now()).session;
}

/** Concrete Qt -> bounded native voice -> database receipt transport. Windows
 * capture defaults must already select the configured CABLE endpoint. This
 * transport never changes them; routeMode:'unchanged' is not a restore claim. */
export class NativeVoiceTransport {
  constructor({
    root = path.resolve(import.meta.dirname, '../..'),
    driver,
    receiptContext,
    audioEndpoints,
    now = Date.now,
    runNative = runTimedVoiceSend,
    warmMonitorFactory = runNative === runTimedVoiceSend ? warmVoiceMonitor : null,
    currentPlan = defaultPlan,
    receiptsFactory = defaultReceipts,
    receiptPollMs = 200,
    receiptWaitMs = 5000,
  } = {}) {
    if (
      !driver ||
      typeof driver.prepareVoiceSession !== 'function' ||
      typeof receiptContext !== 'function' ||
      typeof runNative !== 'function' ||
      typeof receiptsFactory !== 'function' ||
      typeof audioEndpoints !== 'function' ||
      typeof now !== 'function' ||
      typeof currentPlan !== 'function' ||
      (warmMonitorFactory !== null && typeof warmMonitorFactory !== 'function') ||
      (runNative === runTimedVoiceSend && warmMonitorFactory === null) ||
      !Number.isInteger(receiptWaitMs) ||
      receiptWaitMs < 0 ||
      receiptWaitMs > 10000 ||
      !Number.isInteger(receiptPollMs) ||
      receiptPollMs < 10 ||
      receiptPollMs > 1000
    )
      throw fault('NATIVE_VOICE_TRANSPORT_CONFIG_INVALID');
    Object.assign(this, {
      root,
      driver,
      receiptContext,
      audioEndpoints,
      now,
      runNative,
      warmMonitorFactory,
      currentPlan,
      receiptsFactory,
      receiptPollMs,
      receiptWaitMs,
    });
    this.directory = path.join(root, 'state/native-voice-transport');
    this.running = false;
    this.closed = false;
  }
  #file(id) {
    return path.join(this.directory, id + '.json');
  }
  #receiptJob(state) {
    return {
      id: state.id,
      account: state.account,
      target: state.target,
      submittedAt: state.submittedAt,
      deadlineAt: state.deadlineAt,
      minDurationMs: Math.max(1, Math.floor(state.durationMs) - 250),
      maxDurationMs: Math.ceil(state.durationMs) + 4000,
    };
  }
  async #receipts(job, expectedDirectory) {
    const context = await this.receiptContext(job);
    if (
      context?.accountWxid !== job.account ||
      context.accountRef !== job.selectionScope.accountRef ||
      typeof context.accountDirectory !== 'string' ||
      (expectedDirectory !== undefined && context.accountDirectory !== expectedDirectory)
    )
      throw fault('NATIVE_VOICE_READER_BINDING_CHANGED');
    return {
      accountDirectory: context.accountDirectory,
      receipts: this.receiptsFactory({
        directory: path.join(this.directory, 'receipts'),
        job,
        baseUrl: context.baseUrl,
        token: context.token,
        accountWxid: job.account,
        accountDirectory: context.accountDirectory,
        allowedTargets: [job.target],
        now: this.now,
      }),
    };
  }
  #result(state, receipt) {
    const safe = recordingReleased(state);
    const cancellation = validVoiceInterruptionEvidence(state.interruptionCancellation, state)
      ? state.interruptionCancellation
      : undefined;
    const recordingCancellation = validVoiceRecordingCancellationEvidence(state.recordingCancellation, state)
      ? state.recordingCancellation
      : undefined;
    const confirmed = canQueryVoiceReceipt(state) && safe && receipt?.confirmed === true;
    const foregroundTiming = sanitizeForegroundTiming(state.foregroundTiming);
    const adaptiveRecordingUi = sanitizeAdaptiveRecordingUi(state.adaptiveRecordingUi);
    const uiaRecordingUi = sanitizeUiaRecordingUi(state.uiaRecordingUi);
    return {
      confirmed,
      ...(confirmed ? { receipt: receipt.receipt } : {}),
      ...(foregroundTiming ? { foregroundTiming } : {}),
      ...(adaptiveRecordingUi ? { adaptiveRecordingUi } : {}),
      ...(uiaRecordingUi ? { uiaRecordingUi } : {}),
      ...(cancellation ? { interruptionCancellation: structuredClone(cancellation) } : {}),
      ...(recordingCancellation ? { recordingCancellation: structuredClone(recordingCancellation) } : {}),
      ...(state.focusRecoveryRequired
        ? { focusRecoveryRequired: true, focusRecoveryError: state.focusRecoveryError }
        : {}),
      attempted: state.attempted ?? null,
      submitAttempted: state.submitAttempted ?? null,
      recordingPossible: state.recordingPossible ?? true,
      stopBarrier: state.stopBarrier !== false,
      routeSafe: state.routeSafe === true,
      routeMode: 'unchanged',
      reason: state.reason ?? receipt?.reason ?? null,
    };
  }
  async querySegment(job, { signal } = {}) {
    const binding = bind(job),
      state = readTransportState(this.directory, binding);
    if (!state)
      return {
        confirmed: false,
        recordingPossible: true,
        stopBarrier: true,
        routeSafe: false,
        reason: 'NATIVE_VOICE_ATTEMPT_MISSING',
      };
    if (!canQueryVoiceReceipt(state)) return this.#result(state);
    let result;
    try {
      const { receipts } = await this.#receipts(job, state.accountDirectory);
      result = await receipts.query(this.#receiptJob(state), { signal, recording: state.recording });
    } catch (error) {
      result = { confirmed: false, reason: safeCode(error.code) };
    }
    return this.#result(state, result);
  }
  async sendSegment(job, { signal, canSubmit, executionDeadlineAt } = {}) {
    const binding = bind(job);
    if (this.running) throw fault('NATIVE_VOICE_TRANSPORT_BUSY');
    if (this.closed) throw fault('NATIVE_VOICE_TRANSPORT_CLOSED');
    if (
      !Buffer.isBuffer(job.audio) ||
      hash(job.audio) !== job.audioSha256 ||
      typeof canSubmit !== 'function' ||
      (executionDeadlineAt !== undefined &&
        (!Number.isSafeInteger(executionDeadlineAt) || executionDeadlineAt <= this.now()))
    )
      throw fault('NATIVE_VOICE_TRANSPORT_JOB_INVALID');
    this.running = true;
    let finishRun;
    this.runController = new AbortController();
    signal = signal ? AbortSignal.any([signal, this.runController.signal]) : this.runController.signal;
    this.runCompletion = new Promise(resolve => {
      finishRun = resolve;
    });
    let state,
      fresh,
      warmMonitor,
      outcome,
      nativeStarted = false;
    const result = (saved, receipt) => {
      outcome = this.#result(saved, receipt);
      return outcome;
    };
    const active = () => {
      if (signal?.aborted || canSubmit() !== true) throw fault('NATIVE_VOICE_SELECTION_OR_ACTIVITY_CHANGED');
    };
    const write = patch => {
      state = { ...state, ...patch };
      atomic(this.#file(binding.id), state);
    };
    try {
      noLinks(this.directory);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      state = readTransportState(this.directory, binding);
      if (state) return await this.querySegment(job, { signal });
      const interactionPlan = voicePlan(this.currentPlan());
      const planUnchanged = () => {
        const live = voicePlan(this.currentPlan());
        if (
          live.executionMode !== interactionPlan.executionMode ||
          live.policyVersion !== interactionPlan.policyVersion ||
          live.textEntryMode !== interactionPlan.textEntryMode
        )
          throw fault('NATIVE_VOICE_INTERACTION_PLAN_CHANGED');
      };
      active();
      const { renderId, captureId } = await this.audioEndpoints();
      if (
        typeof renderId !== 'string' ||
        !renderId ||
        typeof captureId !== 'string' ||
        !captureId ||
        renderId === captureId
      )
        throw fault('AUDIO_ENDPOINT_INVALID');
      active();
      const { receipts, accountDirectory } = await this.#receipts(job);
      active();
      const submittedAt = this.now();
      state = {
        ...binding,
        accountDirectory,
        state: 'prepared',
        submittedAt,
        deadlineAt: submittedAt + 60000,
        attempted: false,
        recordingPossible: false,
        stopBarrier: false,
        routeSafe: true,
      };
      write({});
      const prepared = await receipts.prepare(this.#receiptJob(state), { signal });
      active();
      if (prepared?.submissionAllowed !== true) throw fault('NATIVE_VOICE_RECEIPT_PREPARATION_REFUSED');
      // Start read-only monitoring before Qt navigation. The native process
      // acquires no UI/audio mutex until the later, single execution commit.
      if (this.warmMonitorFactory) {
        warmMonitor = await this.warmMonitorFactory({ root: this.root, signal });
        if (!warmMonitor || typeof warmMonitor.close !== 'function' || typeof warmMonitor.drain !== 'function')
          throw fault('NATIVE_VOICE_WARMUP_INVALID');
        active();
        planUnchanged();
      }
      // A recording segment is a fresh navigation, even when it is part 2 or later.
      // Its sequence number belongs to receipts, never to a partially typed draft.
      const { id, deliveryId, account, target, selectionScope } = job;
      fresh = await this.driver.prepareVoiceSession(
        { id, deliveryId, account, target, selectionScope, mode: 'voice' },
        { signal, interactionPlan },
      );
      active();
      planUnchanged();
      const focusHandoff = validateVoiceFocusHandoff(fresh?.focusHandoff, fresh?.session);
      if (focusHandoff === undefined) throw fault('NATIVE_VOICE_FOCUS_HANDOFF_MISSING');
      const request = {
        root: this.root,
        id: job.id,
        audio: job.audio,
        renderId,
        captureId,
        permission: {
          recordNativeVoice: true,
          playAudio: true,
          submitNativeVoice: true,
          cancelOwnedRecording: true,
        },
        signal,
        focusHandoff,
        idleMs: fresh.idleMs ?? 1000,
        ...(warmMonitor ? { warmMonitor } : {}),
      };
      const session = validateFresh(fresh, job, request, this.now);
      active();
      // Navigation/OCR may consume most of the outer operation budget. Reserve
      // the bounded native process lifetime plus cleanup before opening a recorder.
      if (Math.min(state.deadlineAt, executionDeadlineAt ?? Infinity) - this.now() < 20000)
        throw fault('NATIVE_VOICE_START_BUDGET_EXHAUSTED');
      write({
        state: 'record-intent',
        attempted: null,
        recordingPossible: true,
        stopBarrier: true,
        routeSafe: false,
      });
      // Reserve this actual recording attempt before the native operation. A
      // definitely cancelled retry has a new id and a fresh Reader baseline.
      if (typeof receipts.submitted === 'function')
        await receipts.submitted(this.#receiptJob(state), this.now(), { baselineId: prepared.baselineId });
      validateFresh(fresh, job, request, this.now);
      active();
      planUnchanged();
      nativeStarted = true;
      const recordingStartedAt = this.now();
      const native = await this.runNative({ ...request, session });
      const recording = { startedAt: recordingStartedAt, releasedAt: this.now() };
      if (native?.nativeStarted === false && native?.recordingPossible === false) nativeStarted = false;
      const ended = native?.recordingPossible === false && native?.stopBarrier === false;
      const foregroundTiming = makeForegroundTiming({
        operation: 'voice',
        preparationIntervals: fresh?.foregroundIntervals,
        nativeIntervals: native?.focusHandoff?.foregroundIntervals,
      });
      const adaptiveRecordingUi = sanitizeAdaptiveRecordingUi(native?.adaptiveRecordingUi);
      const uiaRecordingUi = sanitizeUiaRecordingUi(native?.uiaRecordingUi);
      const interruptionCancellation = voiceInterruptionEvidence(native, binding);
      const recordingCancellation = interruptionCancellation
        ? undefined
        : voiceRecordingCancellationEvidence(native, binding);
      const focus = native?.focusHandoff;
      const focusRecoveryRequired = Boolean(
        ended &&
        focus &&
        !focus.returnSkippedForHumanInput &&
        ((focus.initialReturnAttempted && !focus.initialReturnConfirmed) ||
          (focus.finalReturnAttempted && !focus.finalReturnConfirmed)),
      );
      // Preserve the native result before Reader I/O so a journal outage cannot erase it.
      write({
        state: ended ? 'finished' : 'unknown',
        recording,
        attempted: native?.recordingAttempted === false && native?.submitAttempted === false ? false : true,
        submitAttempted: typeof native?.submitAttempted === 'boolean' ? native.submitAttempted : null,
        ...(foregroundTiming ? { foregroundTiming } : {}),
        ...(adaptiveRecordingUi ? { adaptiveRecordingUi } : {}),
        ...(uiaRecordingUi ? { uiaRecordingUi } : {}),
        ...(interruptionCancellation ? { interruptionCancellation } : {}),
        ...(recordingCancellation ? { recordingCancellation } : {}),
        ...(focusRecoveryRequired
          ? { focusRecoveryRequired: true, focusRecoveryError: 'VOICE_FOCUS_RETURN_UNCONFIRMED' }
          : {}),
        recordingPossible: native?.recordingPossible === false ? false : true,
        stopBarrier: !ended,
        routeSafe: native?.systemSettingsChanged === false,
        reason: native?.reason ? safeCode(native.reason) : null,
      });
      if (foregroundTiming) recordForegroundTiming({ root: this.root, timing: foregroundTiming, now: this.now });
      if (!canQueryVoiceReceipt(state)) return result(state);
      // Receipt checks for an attempted submission cannot retry input.
      const query = async () => {
        try {
          return await receipts.query(this.#receiptJob(state), { signal, recording });
        } catch (error) {
          return { confirmed: false, reason: safeCode(error.code) };
        }
      };
      let receipt = await query();
      const deadline = Date.now() + this.receiptWaitMs;
      while (!receipt?.confirmed && Date.now() < deadline && !signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, this.receiptPollMs));
        receipt = await query();
      }
      return result(state, receipt);
    } catch (error) {
      if (error?.nativeStarted === false && error.recordingPossible === false && error.submitAttempted === false)
        nativeStarted = false;
      if (state) {
        write({
          state: nativeStarted ? 'unknown' : 'finished',
          reason: safeCode(error.code),
          attempted: nativeStarted ? null : false,
          submitAttempted: nativeStarted ? (state.submitAttempted ?? null) : false,
          recordingPossible: nativeStarted,
          stopBarrier: nativeStarted,
          routeSafe: !nativeStarted,
        });
        return result(state);
      }
      // Before a receipt baseline/session exists, no recording helper has been
      // entered. Report that proof explicitly instead of creating an unknown
      // recording barrier for a missing reader or configuration.
      outcome = {
        confirmed: false,
        attempted: false,
        submitAttempted: false,
        recordingPossible: false,
        stopBarrier: false,
        routeSafe: true,
        routeMode: 'unchanged',
        reason: safeCode(error.code),
      };
      return outcome;
    } finally {
      // Before native ownership transfers, release a successful preparation's
      // focus lease even if authorization or validation failed afterwards.
      // Unknown native outcomes never cause a second blind foreground action.
      let focusCleanupConfirmed = nativeStarted || !fresh?.focusHandoff;
      try {
        try {
          if (typeof warmMonitor?.close === 'function') await warmMonitor.close();
          if (typeof warmMonitor?.drain === 'function') await warmMonitor.drain();
        } finally {
          if (!nativeStarted && typeof fresh?.releaseFocus === 'function') {
            const released = await fresh.releaseFocus();
            focusCleanupConfirmed = released?.restored === true || released?.skipped === true;
          }
        }
        if (!nativeStarted && fresh?.focusHandoff && !focusCleanupConfirmed)
          throw fault('NATIVE_VOICE_FOCUS_RETURN_UNCONFIRMED');
        this.driver.finishVoiceInteraction?.({
          jobId: job.id,
          cleanupConfirmed:
            focusCleanupConfirmed &&
            state?.recordingPossible === false &&
            state?.stopBarrier === false &&
            state?.routeSafe === true &&
            state?.focusRecoveryRequired !== true,
        });
      } catch (error) {
        // Cleanup cannot erase an already proved non-recording outcome. Keep
        // the original failure and put only the unreturned focus behind review.
        if (
          nativeStarted ||
          !outcome ||
          outcome.attempted !== false ||
          outcome.recordingPossible !== false ||
          outcome.stopBarrier !== false ||
          outcome.routeSafe !== true
        )
          throw error;
        if (!focusCleanupConfirmed) {
          const fields = {
            focusRecoveryRequired: true,
            focusRecoveryError: safeCode(error.code ?? error.message),
            submitAttempted: false,
          };
          if (state) write(fields);
          Object.assign(outcome, fields);
        }
        this.driver.finishVoiceInteraction?.({ jobId: job.id, cleanupConfirmed: false });
      } finally {
        this.running = false;
        this.runController = null;
        this.runCompletion = null;
        finishRun();
      }
    }
  }
  close() {
    this.closed = true;
    this.runController?.abort();
  }
  async drain() {
    if (this.runCompletion) await this.runCompletion;
  }
}
