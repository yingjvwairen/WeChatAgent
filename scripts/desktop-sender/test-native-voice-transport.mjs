import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeVoiceTransport } from './native-voice-transport.mjs';
import {
  voiceInterruptionEvidence,
  validVoiceInterruptionEvidence,
  voiceRecordingCancellationEvidence,
  validVoiceRecordingCancellationEvidence,
} from './voice-interruption-evidence.mjs';
import { validateTimedVoiceSendRequest, validateTimedVoiceReport } from './timed-voice-preview.mjs';
import { sanitizeUiaRecordingUi, sanitizeUiaBackgroundSubmit } from './voice-recording-layout.mjs';

const hex = value => value.repeat(64);
const measured = (phase, durationMs, includesContactNavigation = false) => ({
  phase,
  durationMs,
  includesContactNavigation,
  complete: true,
});
const interrupted = () => ({
  ok: false,
  reason: 'DRAFT_HUMAN_ACTIVITY_CHANGED',
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
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-transport-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(target), /^voice-transport-/);
    fs.rmSync(target, { recursive: true });
  });
  const audio = Buffer.alloc(3244);
  audio.write('RIFF');
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(3200, 40);
  const scope = {
    version: 1,
    accountRef: hex('a'),
    account: 'fixture-self',
    target: 'fixture-friend',
    eventId: 'fixture',
    selectionVersion: 1,
    grantId: hex('b'),
    token: hex('c'),
  };
  const job = {
    id: hex('d'),
    account: scope.account,
    target: scope.target,
    audio,
    audioSha256: crypto.createHash('sha256').update(audio).digest('hex'),
    voiceId: hex('e'),
    durationMs: 100,
    selectionScope: scope,
  };
  const at = 1700000000000,
    state = {
      nativeCalls: 0,
      preparations: 0,
      queries: 0,
      allowed: true,
      receiptFails: false,
      confirmed: true,
      freshChanges: null,
    };
  const fresh = () => {
    const session = {
      version: 2,
      id: 'a'.repeat(32),
      calibrationHash: hex('b'),
      accountScopeHash: hex('c'),
      target: job.target,
      executable: 'C:\\fixture\\Weixin.exe',
      hwnd: '100',
      focusHwnd: '100',
      processCreatedFileTimeUtc: '12345',
      pid: 42,
      dpi: 96,
      lastInputTick: 10,
      issuedAtMs: at,
      expiresAtMs: at + 29000,
      clientRect: { left: 0, top: 0, right: 800, bottom: 600 },
      captureRect: { left: 100, top: 100, right: 900, bottom: 700 },
      editorRect: { left: 100, top: 400, right: 700, bottom: 590 },
      emptyDraftConfirmed: true,
      mouseParkRect: { left: 20, top: 20, right: 40, bottom: 40 },
      recordStartRect: { left: 710, top: 400, right: 750, bottom: 440 },
      recordingUi: {
        focusHwnd: '100',
        cancel: { rect: { left: 150, top: 450, right: 180, bottom: 480 }, rgbaSha256: hex('d') },
        submit: { rect: { left: 600, top: 450, right: 630, bottom: 480 }, rgbaSha256: hex('e') },
      },
      targetProof: {
        kind: 'verified-qt-private-chat-v1',
        target: job.target,
        accountRef: scope.accountRef,
        titleAnchor: { rect: { left: 100, top: 10, right: 400, bottom: 50 }, rgbaSha256: hex('a') },
      },
    };
    const accountProof = {
      accountRef: scope.accountRef,
      accountScopeHash: session.accountScopeHash,
      evidence: {
        ok: true,
        proof: 'process-open-database-v1',
        complete: true,
        processOpenedExpectedDatabase: true,
        accountRootsObserved: 1,
        consistentPathScans: 2,
        snapshotAtomic: false,
        processId: 42,
        processCreatedFileTimeUtc: '12345',
        ready: false,
        desktopAccountVerified: false,
        targetVerified: false,
        draftVerified: false,
        inputSent: false,
        maximumEvidenceAgeMs: 500,
        expectedDatabaseHandles: 1,
        observedAtUtc: new Date(at).toISOString(),
      },
    };
    const result = { session, accountProof, focusHandoff: handoff() };
    state.freshChanges?.(result);
    return result;
  };
  const config = {
    root,
    audioEndpoints: () => ({ renderId: 'fixture-render', captureId: 'fixture-capture' }),
    now: () => at,
    receiptWaitMs: 0,
    driver: {
      async prepareVoiceSession() {
        return fresh();
      },
    },
    receiptContext: async () => ({
      baseUrl: 'http://127.0.0.1:12345',
      token: 'private-token',
      accountRef: scope.accountRef,
      accountWxid: job.account,
      accountDirectory: 'fixture-account',
    }),
    receiptsFactory: options => {
      assert.deepEqual(options.allowedTargets, [job.target]);
      return {
        async prepare(request) {
          state.preparations++;
          assert.equal(request.id, job.id);
          return { submissionAllowed: true };
        },
        async query() {
          state.queries++;
          if (state.receiptFails) throw new Error('offline');
          return { confirmed: state.confirmed, receipt: { fixture: true } };
        },
      };
    },
    runNative: async request => {
      state.nativeCalls++;
      assert.equal(request.session.target, job.target);
      assert.equal(request.permission.submitNativeVoice, true);
      return {
        recordingAttempted: true,
        submitAttempted: true,
        recordingPossible: false,
        stopBarrier: false,
        systemSettingsChanged: false,
      };
    },
  };
  return {
    root,
    state,
    job,
    config,
    fresh,
    transport: new NativeVoiceTransport(config),
    options: { canSubmit: () => state.allowed },
  };
}
test('production transport binds fresh account/chat, prepares receipt before native and never changes audio defaults', async t => {
  const f = fixture(t),
    result = await f.transport.sendSegment(f.job, f.options);
  assert.equal(result.confirmed, true);
  assert.equal(result.routeSafe, true);
  assert.equal(result.routeMode, 'unchanged');
  assert.equal(f.state.nativeCalls, 1);
  assert.equal(f.state.preparations, 1);
  const restarted = new NativeVoiceTransport({
    ...f.config,
    audioEndpoints: () => assert.fail('a saved attempt cannot inspect recording endpoints'),
  });
  assert.equal((await restarted.querySegment(f.job)).confirmed, true);
  const repeated = await restarted.sendSegment(f.job, f.options);
  assert.equal(repeated.confirmed, true);
  assert.equal(f.state.nativeCalls, 1);
  assert.equal(f.state.preparations, 1);
  const saved = fs.readFileSync(path.join(f.root, 'state/native-voice-transport', f.job.id + '.json'), 'utf8');
  assert.equal(saved.includes('private-token'), false);
});

test('filehelper is a normal production target and still requires its exact target proof and permission', t => {
  const f = fixture(t);
  f.job.target = 'filehelper';
  f.job.selectionScope.target = 'filehelper';
  const options = {
    id: f.job.id,
    audio: f.job.audio,
    session: f.fresh().session,
    ...f.config.audioEndpoints(),
    focusHandoff: handoff(),
    permission: {
      recordNativeVoice: true,
      playAudio: true,
      submitNativeVoice: true,
      cancelOwnedRecording: true,
    },
  };
  assert.equal(validateTimedVoiceSendRequest(options, f.config.now()).session.target, 'filehelper');
  assert.throws(
    () =>
      validateTimedVoiceSendRequest(
        {
          ...options,
          session: { ...options.session, targetProof: { ...options.session.targetProof, target: 'other' } },
        },
        f.config.now(),
      ),
    /VOICE_TARGET_PROOF_INVALID/,
  );
  assert.throws(
    () =>
      validateTimedVoiceSendRequest(
        { ...options, permission: { ...options.permission, recordNativeVoice: false } },
        f.config.now(),
      ),
    /VOICE_PERMISSION_REQUIRED/,
  );
});

test('a failed focus cleanup preserves the original proven unrecorded refusal across query and restart', async t => {
  const f = fixture(t);
  let calls = 0;
  const notifications = [];
  f.config.driver.prepareVoiceSession = async () => ({
    ...f.fresh(),
    releaseFocus: async () => {
      throw Object.assign(Error('QT_RETURN_CAPTION_WARMUP'), { code: 'QT_RETURN_CAPTION_WARMUP' });
    },
  });
  f.config.driver.finishVoiceInteraction = value => notifications.push(value);
  f.config.runNative = async () => {
    calls++;
    throw Object.assign(Error('VOICE_TARGET_PROOF_INVALID'), {
      code: 'VOICE_TARGET_PROOF_INVALID',
      nativeStarted: false,
      recordingPossible: false,
      submitAttempted: false,
    });
  };
  const first = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(first.reason, 'VOICE_TARGET_PROOF_INVALID');
  assert.equal(first.attempted, false);
  assert.equal(first.submitAttempted, false);
  assert.equal(first.recordingPossible, false);
  assert.equal(first.stopBarrier, false);
  assert.equal(first.routeSafe, true);
  assert.equal(first.focusRecoveryRequired, true);
  assert.equal(first.focusRecoveryError, 'QT_RETURN_CAPTION_WARMUP');
  const later = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(later.reason, first.reason);
  assert.equal(later.focusRecoveryRequired, true);
  assert.equal(later.confirmed, false);
  assert.equal(calls, 1);
  assert(notifications.every(value => value.cleanupConfirmed === false));
});
test('a fully observed interrupted cancellation is durable and its old attempt can only return that evidence', async t => {
  for (const reason of ['DRAFT_HUMAN_ACTIVITY_CHANGED', 'VOICE_BACKGROUND_WECHAT_ACTIVATED']) {
    const f = fixture(t);
    f.config.runNative = async () => {
      f.state.nativeCalls++;
      return { ...interrupted(), reason };
    };
    const transport = new NativeVoiceTransport(f.config);
    const result = await transport.sendSegment(f.job, f.options);
    assert.equal(result.confirmed, false);
    assert.equal(result.attempted, true);
    assert.equal(validVoiceInterruptionEvidence(result.interruptionCancellation, f.job), true);
    assert.equal(f.state.queries, 0);
    const later = new NativeVoiceTransport(f.config);
    for (const method of ['querySegment', 'sendSegment']) {
      const old = await later[method](f.job, f.options);
      assert.deepEqual(old.interruptionCancellation, result.interruptionCancellation);
      assert.equal(old.confirmed, false);
    }
    assert.equal(f.state.nativeCalls, 1);
    assert.equal(f.state.preparations, 1);
    assert.equal(f.state.queries, 0);
  }
});

test('a structural failure with proved cancellation remains terminal across query and never accepts a coincidental receipt', async t => {
  const f = fixture(t);
  const native = { ...interrupted(), reason: 'VOICE_CAPTION_WINDOW_CHANGED', captureVerified: true };
  f.config.runNative = async () => {
    f.state.nativeCalls++;
    return native;
  };
  const first = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(first.confirmed, false);
  assert.equal(first.submitAttempted, false);
  assert.equal(first.recordingPossible, false);
  assert(validVoiceRecordingCancellationEvidence(first.recordingCancellation, f.job));
  assert.equal(first.interruptionCancellation, undefined);
  assert.equal(f.state.queries, 0);
  const restarted = new NativeVoiceTransport(f.config);
  for (const method of ['sendSegment', 'querySegment']) {
    const later = await restarted[method](f.job, f.options);
    assert.deepEqual(later.recordingCancellation, first.recordingCancellation);
    assert.equal(later.confirmed, false);
  }
  assert.equal(f.state.nativeCalls, 1);
  assert.equal(f.state.queries, 0);
  for (const changed of [
    { cancelInputApplied: false },
    { recordingEndedObserved: false },
    { recordingPossible: true },
    { captureVerified: false },
    { stopBarrier: true },
    { submitAttempted: true },
    { systemSettingsChanged: true },
  ])
    assert.equal(voiceRecordingCancellationEvidence({ ...native, ...changed }, f.job), undefined);
  assert.equal(
    validVoiceRecordingCancellationEvidence({ ...first.recordingCancellation, audioSha256: hex('f') }, f.job),
    false,
  );
});

test('proved cancellation and failed focus return remain separate and survive the transport ledger', async t => {
  const f = fixture(t);
  f.config.runNative = async () => ({
    ...interrupted(),
    reason: 'VOICE_CAPTION_WINDOW_CHANGED',
    captureVerified: true,
    focusHandoff: {
      initialReturnAttempted: true,
      initialReturnConfirmed: true,
      finalReturnAttempted: true,
      finalReturnConfirmed: false,
      returnSkippedForHumanInput: false,
    },
  });
  const first = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(first.recordingPossible, false);
  assert.equal(first.focusRecoveryRequired, true);
  assert(first.recordingCancellation);
  const restored = await new NativeVoiceTransport(f.config).querySegment(f.job);
  assert.equal(restored.focusRecoveryRequired, true);
  assert.equal(restored.recordingPossible, false);
});

test('an old finished/unknown ledger without cancellation evidence is never upgraded by reconstruction', async t => {
  const f = fixture(t);
  f.config.runNative = async () => ({
    ...interrupted(),
    reason: 'VOICE_CAPTION_WINDOW_CHANGED',
    captureVerified: true,
  });
  await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  const file = path.join(f.root, 'state/native-voice-transport', f.job.id + '.json'),
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.recordingCancellation;
  fs.writeFileSync(file, JSON.stringify(saved));
  const old = await new NativeVoiceTransport(f.config).querySegment(f.job);
  assert.equal(old.recordingCancellation, undefined);
  assert.equal(old.confirmed, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recordingCancellation, undefined);
});
test('every cancellation fact and original binding is required; an incomplete no-send result never confirms a coincidental receipt', async t => {
  const f = fixture(t),
    base = interrupted(),
    evidence = voiceInterruptionEvidence(base, f.job);
  assert.equal(validVoiceInterruptionEvidence(evidence, f.job), true);
  for (const key of Object.keys(base)) {
    const changed = { ...base };
    delete changed[key];
    assert.equal(voiceInterruptionEvidence(changed, f.job), undefined, key);
  }
  for (const key of Object.keys(base).filter(k => typeof base[k] === 'boolean'))
    assert.equal(voiceInterruptionEvidence({ ...base, [key]: !base[key] }, f.job), undefined, key);
  for (const reason of ['VOICE_PROCESS_FAILED', 'DRAFT_WINDOW_CHANGED', null])
    assert.equal(voiceInterruptionEvidence({ ...base, reason }, f.job), undefined);
  for (const key of ['id', 'account', 'target', 'voiceId', 'audioSha256'])
    assert.equal(
      validVoiceInterruptionEvidence(evidence, {
        ...f.job,
        [key]: ['account', 'target'].includes(key) ? 'changed' : '0'.repeat(64),
      }),
      false,
      key,
    );
  assert.equal(validVoiceInterruptionEvidence({ ...evidence, extra: true }, f.job), false);
  f.config.runNative = async () => {
    const result = interrupted();
    delete result.cancelInputApplied;
    return result;
  };
  const transport = new NativeVoiceTransport(f.config),
    result = await transport.sendSegment(f.job, f.options);
  assert.equal(result.interruptionCancellation, undefined);
  assert.equal(result.confirmed, false);
  assert.equal(result.attempted, true);
  assert.equal((await transport.querySegment(f.job)).confirmed, false);
});
test('tampered persisted cancellation binding or recording facts are rejected before old-ID query or input', async t => {
  for (const key of ['attemptId', 'audioSha256', 'voiceId', 'accountSha256', 'targetSha256', 'cancelInputApplied']) {
    const f = fixture(t);
    f.config.runNative = async () => {
      f.state.nativeCalls++;
      return interrupted();
    };
    await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
    const file = path.join(f.root, 'state/native-voice-transport', f.job.id + '.json'),
      saved = JSON.parse(fs.readFileSync(file));
    saved.interruptionCancellation[key] = key === 'cancelInputApplied' ? false : '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(saved));
    await assert.rejects(new NativeVoiceTransport(f.config).querySegment(f.job), {
      code: 'NATIVE_VOICE_TRANSPORT_STATE_INVALID',
    });
    assert.equal(f.state.nativeCalls, 1);
    assert.equal(f.state.queries, 0);
  }
});
test('production keeps bounded adaptive diagnostics with its existing durable receipt instead of starting again', async t => {
  const f = fixture(t),
    native = f.config.runNative,
    diagnostic = {
      requested: true,
      bound: true,
      cancelScore: 0.99,
      submitScore: 1,
      elapsedMs: 82,
      pixelGuardsFixed: true,
    };
  f.config.runNative = async request => ({ ...(await native(request)), adaptiveRecordingUi: diagnostic });
  const transport = new NativeVoiceTransport(f.config);
  assert.deepEqual((await transport.sendSegment(f.job, f.options)).adaptiveRecordingUi, diagnostic);
  assert.deepEqual((await transport.sendSegment(f.job, f.options)).adaptiveRecordingUi, diagnostic);
  assert.equal(f.state.nativeCalls, 1);
});
test('stale or different native account proof cannot start a recording', async t => {
  for (const change of [
    value => {
      value.accountProof.evidence.observedAtUtc = new Date(1699999999000).toISOString();
    },
    value => {
      value.accountProof.evidence.processId++;
    },
    value => {
      value.accountProof.accountRef = hex('b');
    },
    value => {
      value.session.targetProof.target = 'other';
    },
    value => {
      value.session.emptyDraftConfirmed = false;
    },
  ]) {
    const f = fixture(t);
    f.state.freshChanges = change;
    const result = await f.transport.sendSegment(f.job, f.options);
    assert.equal(result.confirmed, false);
    assert.equal(result.attempted, false);
    assert.equal(f.state.nativeCalls, 0);
  }
});

test('production UIA diagnostics survive a confirmed receipt and same-ID query without replay', async t => {
  const f = fixture(t),
    native = f.config.runNative,
    diagnostic = {
      version: 1,
      requested: true,
      bound: true,
      stateChecks: 7,
      conversationVerified: true,
      pixelsRead: false,
      startObservation: {
        inputMethod: 'send-input',
        afterInputState: 'recording',
        finalState: 'idle',
        captureCandidateObserved: true,
        pointer: { expected: [100, 200], actual: [100, 200], matched: true, pressConsumed: true },
      },
    };
  f.config.runNative = async request => ({ ...(await native(request)), uiaRecordingUi: diagnostic });
  const transport = new NativeVoiceTransport(f.config);
  const first = await transport.sendSegment(f.job, f.options);
  assert.equal(first.confirmed, true);
  assert.deepEqual(first.uiaRecordingUi, diagnostic);
  assert.deepEqual((await transport.sendSegment(f.job, f.options)).uiaRecordingUi, diagnostic);
  assert.equal(f.state.nativeCalls, 1);
});
test('start-state diagnostics are bounded enums and never carry labels or arbitrary native text', () => {
  const value = {
    version: 1,
    requested: true,
    bound: false,
    stateChecks: 3,
    conversationVerified: true,
    pixelsRead: false,
    startObservation: {
      inputMethod: 'window-message',
      afterInputState: 'idle',
      finalState: 'idle',
      captureCandidateObserved: false,
    },
  };
  assert.deepEqual(sanitizeUiaRecordingUi(value), value);
  for (const changed of [
    null,
    { ...value.startObservation, finalState: 'unexpected caption' },
    { ...value.startObservation, label: 'private text' },
  ])
    assert.equal(sanitizeUiaRecordingUi({ ...value, startObservation: changed }), undefined);
  assert.equal(
    sanitizeUiaRecordingUi({
      ...value,
      startObservation: {
        ...value.startObservation,
        inputMethod: 'send-input',
        pointer: { expected: [100, 200], actual: [300, 400], matched: true, pressConsumed: true },
      },
    }),
    undefined,
  );
  const frame = {
    file: 'voice-start-' + hex('a').slice(0, 32) + '.png',
    width: 700,
    height: 121,
    scope: 'input-toolbar',
    pixelsRead: true,
    inputSent: false,
  };
  assert.ok(
    sanitizeUiaRecordingUi({
      ...value,
      startObservation: {
        ...value.startObservation,
        beforeUpState: 'recording',
        captureWhileDown: true,
        failureFrame: frame,
      },
    }),
  );
  assert.equal(
    sanitizeUiaRecordingUi({
      ...value,
      startObservation: { ...value.startObservation, failureFrame: { ...frame, file: '../private.png' } },
    }),
    undefined,
  );
});

test('a background submit that activates WeChat reports its real one-time return interval without inventing an acquisition', () => {
  const submission = {
    version: 1,
    attempted: true,
    applied: true,
    confirmed: true,
    foregroundUnchanged: false,
    activationReturn: {
      observed: true,
      attempted: true,
      confirmed: true,
      activityUnchanged: true,
      sourceObservation: {
        threadMatched: true,
        pidMatched: true,
        guiRead: true,
        menuInactive: true,
        captureReleased: true,
        captureOwned: false,
        windowBoundsMatched: true,
      },
    },
  };
  const handoff = {
    backgroundEntered: true,
    initialReturnConfirmed: true,
    submitActivationAttempted: false,
    submitActivationConfirmed: false,
    finalReturnAttempted: true,
    finalReturnConfirmed: true,
    submitForegroundElapsedMs: 340,
    foregroundIntervals: [
      { phase: 'record-submit', durationMs: 340, includesContactNavigation: false, complete: true },
    ],
  };
  assert.deepEqual(sanitizeUiaBackgroundSubmit(submission, handoff), submission);
  for (const changed of [
    { ...submission, foregroundUnchanged: true },
    { ...submission, activationReturn: { ...submission.activationReturn, activityUnchanged: false } },
    { ...submission, activationReturn: { ...submission.activationReturn, attempted: false } },
    { ...submission, applied: false },
  ])
    assert.equal(sanitizeUiaBackgroundSubmit(changed, handoff), undefined);
  assert.equal(sanitizeUiaBackgroundSubmit(submission, { ...handoff, submitForegroundElapsedMs: 0 }), undefined);
  assert.equal(sanitizeUiaBackgroundSubmit(submission, { ...handoff, submitActivationAttempted: true }), undefined);
  assert.equal(
    sanitizeUiaBackgroundSubmit(
      {
        ...submission,
        activationReturn: {
          ...submission.activationReturn,
          sourceObservation: { ...submission.activationReturn.sourceObservation, windowBoundsMatched: false },
        },
      },
      handoff,
    ),
    undefined,
  );
});

test('a successful physical UIA start permits only the three submit messages, not the old six-message assumption', () => {
  const packet = {
    ok: true,
    mode: 'timedVoiceSend',
    targetGuarded: true,
    recordingAttempted: true,
    recordingPossible: false,
    captureVerified: true,
    captureSessionBound: true,
    audioStarted: true,
    playbackComplete: true,
    submitAttempted: true,
    submitInputApplied: true,
    cancelAttempted: false,
    cancelInputApplied: false,
    recordingEndedObserved: true,
    deliveryConfirmed: false,
    unattendedReady: false,
    systemSettingsChanged: false,
    microphoneOpened: false,
    reason: null,
    queuedAudioLimitMs: 20,
    deviceLatencyBounded: false,
    mouseParkMovesApplied: 0,
    uiaPointerMessagesPosted: 3,
    humanActivity: null,
    sourceDurationMs: 1000,
    playbackElapsedMs: 1000,
    recordingElapsedMs: 1200,
    audioPump: {
      dedicatedThread: true,
      pollIntervalMs: 5,
      queuedAudioLimitMs: 20,
      paddingStarvationCount: 0,
      threadJoined: true,
      outputStopped: true,
      timerPeriodMs: 1,
      timerResolutionRequested: true,
      timerResolutionAcquired: true,
      timerResolutionRestored: true,
      maxPumpGapMs: 5,
      startToDrainMs: 1000,
      drainToStopMs: 0,
    },
    timelineMs: {
      recordStart: 1000,
      captureReady: 1100,
      playStart: 1200,
      playDrained: 2200,
      submit: 2300,
      recordEnded: 2400,
    },
    uiaRecordingUi: {
      version: 1,
      requested: true,
      bound: true,
      stateChecks: 5,
      conversationVerified: true,
      pixelsRead: false,
      startObservation: {
        inputMethod: 'send-input',
        afterInputState: 'recording',
        finalState: 'idle',
        captureCandidateObserved: true,
        pointer: { expected: [100, 200], actual: [100, 200], matched: true, pressConsumed: true },
      },
    },
  };
  assert.equal(validateTimedVoiceReport(packet, true, false, true).ok, true);
  assert.throws(
    () => validateTimedVoiceReport({ ...packet, uiaPointerMessagesPosted: 6 }, true, false, true),
    /VOICE_PROTOCOL_INVALID/,
  );
  const returned = {
    version: 1,
    initialReturnAttempted: true,
    initialReturnConfirmed: true,
    backgroundEntered: true,
    backgroundActivityObserved: false,
    submitActivationAttempted: false,
    submitActivationConfirmed: false,
    finalReturnAttempted: true,
    finalReturnConfirmed: true,
    returnSkippedForHumanInput: false,
    initialForegroundElapsedMs: 400,
    backgroundElapsedMs: 1000,
    submitForegroundElapsedMs: 340,
    foregroundIntervals: [
      { phase: 'record-start', durationMs: 400, includesContactNavigation: true, complete: true },
      { phase: 'record-submit', durationMs: 340, includesContactNavigation: false, complete: true },
    ],
    backgroundSubmit: {
      version: 1,
      attempted: true,
      applied: true,
      confirmed: true,
      foregroundUnchanged: false,
      activationReturn: { observed: true, attempted: true, confirmed: true, activityUnchanged: true },
    },
  };
  const actual = validateTimedVoiceReport({ ...packet, focusHandoff: returned }, true, true, true);
  assert.equal(actual.ok, true);
  assert.equal(actual.focusHandoff.submitForegroundElapsedMs, 340);
  assert.equal(actual.recordingPossible, false);
  const visibility = {
    version: 1,
    raiseAttempted: true,
    requestAccepted: true,
    confirmed: true,
    initialBlockingCount: 1,
    lastBlockingCount: 0,
    elapsedMs: 10,
    reason: 'raised-visible',
  };
  const restored = { attempted: false, accepted: null, confirmed: true, reason: 'source-order-restored' };
  const afterRaise = validateTimedVoiceReport(
    {
      ...packet,
      focusHandoff: { ...returned, startVisibility: visibility, startVisibilityRestore: restored },
    },
    true,
    true,
    true,
  );
  assert.deepEqual(afterRaise.focusHandoff.startVisibility, visibility);
  assert.deepEqual(afterRaise.focusHandoff.startVisibilityRestore, restored);
  for (const bad of [
    { ...restored, title: 'private' },
    { ...restored, confirmed: false },
    { ...restored, accepted: true },
  ])
    assert.throws(
      () =>
        validateTimedVoiceReport(
          {
            ...packet,
            focusHandoff: { ...returned, startVisibility: visibility, startVisibilityRestore: bad },
          },
          true,
          true,
          true,
        ),
      /VOICE_PROTOCOL_INVALID/,
    );
});
test('obscured-button report preserves bounded window and DPI metadata without titles or input', () => {
  const area = { left: 10, top: 20, right: 1033, bottom: 793 },
    dpi = { context: '-4', awareness: 2, perMonitorV2: true };
  const window = {
    hwnd: '200',
    pid: 99,
    threadId: 2,
    className: 'Chrome_WidgetWin_1',
    rootHwnd: '200',
    rootPid: 99,
    rootClassName: 'Chrome_WidgetWin_1',
    rootRect: area,
  };
  const hit = {
    version: 1,
    readOnly: true,
    phase: 0,
    point: [912, 750],
    expectedHwnd: '100',
    expectedPid: 42,
    expectedDpi: 120,
    captureRect: area,
    hit: window,
    foreground: {
      ...window,
      hwnd: '100',
      pid: 42,
      rootHwnd: '100',
      rootPid: 42,
      className: 'Qt51514QWindowIcon',
      rootClassName: 'Qt51514QWindowIcon',
    },
    threadId: 3,
    threadDpi: dpi,
    beforeCaptionDpi: dpi,
  };
  const packet = {
    ok: false,
    mode: 'timedVoiceSend',
    targetGuarded: true,
    recordingAttempted: false,
    recordingPossible: false,
    captureVerified: false,
    captureSessionBound: false,
    audioStarted: false,
    playbackComplete: false,
    submitAttempted: false,
    submitInputApplied: false,
    cancelAttempted: false,
    cancelInputApplied: false,
    recordingEndedObserved: false,
    deliveryConfirmed: false,
    unattendedReady: false,
    systemSettingsChanged: false,
    microphoneOpened: false,
    reason: 'VOICE_BUTTON_OBSCURED',
    queuedAudioLimitMs: 20,
    deviceLatencyBounded: false,
    mouseParkMovesApplied: 0,
    uiaPointerMessagesPosted: 0,
    humanActivity: null,
    sourceDurationMs: 3000,
    playbackElapsedMs: 0,
    recordingElapsedMs: 0,
    audioPump: null,
    timelineMs: { recordStart: 0, captureReady: 0, playStart: 0, playDrained: 0, submit: 0, recordEnded: 0 },
    buttonHit: hit,
  };
  const result = validateTimedVoiceReport(packet, true, false, false);
  assert.deepEqual(result.buttonHit, hit);
  assert.equal(result.recordingAttempted, false);
  assert.equal(result.submitAttempted, false);
  assert.notEqual(result.buttonHit, hit);
  for (const bad of [
    { ...hit, title: 'private title' },
    { ...hit, hit: { ...window, title: 'private title' } },
    { ...hit, threadDpi: { ...dpi, context: 'not-a-number' } },
    { ...hit, hit: { ...window, pid: -1 } },
    { ...hit, point: [NaN, 20] },
    { ...hit, readOnly: false },
    { ...hit, phase: 3 },
  ])
    assert.throws(
      () => validateTimedVoiceReport({ ...packet, buttonHit: bad }, true, false, false),
      /VOICE_PROTOCOL_INVALID/,
    );
  assert.throws(
    () => validateTimedVoiceReport({ ...packet, reason: 'VOICE_CAPTURE_NOT_READY' }, true, false, false),
    /VOICE_PROTOCOL_INVALID/,
  );
});
test('selection changed during asynchronous preparation prevents native launch', async t => {
  const f = fixture(t);
  f.config.driver.prepareVoiceSession = async () => {
    f.state.allowed = false;
    return f.fresh();
  };
  const result = await f.transport.sendSegment(f.job, f.options);
  assert.equal(result.attempted, false);
  assert.equal(result.recordingPossible, false);
  assert.equal(f.state.nativeCalls, 0);
});
test('waitable Qt preparation refusal keeps its exact reason and never starts or retries native recording', async t => {
  const f = fixture(t);
  f.state.confirmed = false;
  f.config.driver.prepareVoiceSession = async () => {
    throw Object.assign(new Error('QT_HUMAN_ACTIVE'), {
      code: 'QT_HUMAN_ACTIVE',
      attempted: false,
      waitable: true,
    });
  };
  const result = await f.transport.sendSegment(f.job, f.options);
  assert.equal(result.attempted, false);
  assert.equal(result.recordingPossible, false);
  assert.equal(result.stopBarrier, false);
  assert.equal(result.routeSafe, true);
  assert.equal(result.reason, 'QT_HUMAN_ACTIVE');
  const file = path.join(f.root, 'state/native-voice-transport', f.job.id + '.json'),
    saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.state, 'finished');
  assert.equal(saved.attempted, false);
  assert.equal(f.state.preparations, 1);
  assert.equal(f.state.nativeCalls, 0);
  const repeated = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(repeated.reason, 'QT_HUMAN_ACTIVE');
  assert.equal(repeated.confirmed, false);
  assert.equal(f.state.nativeCalls, 0);
  assert.equal(f.state.preparations, 1);
});
test('a known pre-input refusal cannot be confirmed by a later same-duration manual voice receipt', async t => {
  const f = fixture(t);
  f.state.confirmed = false;
  f.config.driver.prepareVoiceSession = async () => {
    throw Object.assign(new Error('QT_HUMAN_ACTIVE'), {
      code: 'QT_HUMAN_ACTIVE',
      attempted: false,
      waitable: true,
    });
  };
  const initial = await f.transport.sendSegment(f.job, f.options);
  assert.equal(initial.attempted, false);
  // Simulate an unrelated matching database row arriving after the durable
  // refusal, before the caller had a chance to persist its cancellation.
  f.state.confirmed = true;
  const recovered = await new NativeVoiceTransport(f.config).querySegment(f.job);
  assert.equal(recovered.confirmed, false);
  assert.equal(recovered.receipt, undefined);
  assert.equal(recovered.attempted, false);
  assert.equal(recovered.recordingPossible, false);
  const repeated = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(repeated.confirmed, false);
  assert.equal(repeated.receipt, undefined);
  assert.equal(f.state.nativeCalls, 0);
  assert.equal(f.state.preparations, 1);
});
test('native uncertainty is durable and a receipt cannot clear unknown recording ownership', async t => {
  const f = fixture(t);
  f.config.runNative = async () => {
    f.state.nativeCalls++;
    throw new Error('native lost');
  };
  const transport = new NativeVoiceTransport(f.config),
    result = await transport.sendSegment(f.job, f.options);
  assert.equal(result.confirmed, false);
  assert.equal(result.stopBarrier, true);
  const recovered = await new NativeVoiceTransport(f.config).querySegment(f.job, {});
  assert.equal(recovered.confirmed, false);
  assert.equal(recovered.recordingPossible, true);
  assert.equal(f.state.nativeCalls, 1);
});
test('a temporary receipt outage preserves proven recording end for query-only recovery after revocation', async t => {
  const f = fixture(t);
  f.state.receiptFails = true;
  const result = await f.transport.sendSegment(f.job, f.options);
  assert.equal(result.confirmed, false);
  assert.equal(result.recordingPossible, false);
  assert.equal(result.routeSafe, true);
  f.state.receiptFails = false;
  f.state.allowed = false;
  assert.equal((await new NativeVoiceTransport(f.config).querySegment(f.job)).confirmed, true);
  assert.equal(f.state.nativeCalls, 1);
});
test('another reader account cannot prepare or query the saved target receipt', async t => {
  const f = fixture(t);
  await f.transport.sendSegment(f.job, f.options);
  f.config.receiptContext = async () => ({
    accountWxid: 'other',
    accountRef: hex('a'),
    accountDirectory: 'fixture-account',
  });
  assert.equal((await new NativeVoiceTransport(f.config).querySegment(f.job)).confirmed, false);
  assert.equal(f.state.nativeCalls, 1);
});
test('changed target, audio or model under an existing segment ID is rejected', async t => {
  const f = fixture(t);
  await f.transport.sendSegment(f.job, f.options);
  for (const changed of [
    { ...f.job, voiceId: hex('f') },
    { ...f.job, audioSha256: hex('f') },
    { ...f.job, target: 'other', selectionScope: { ...f.job.selectionScope, target: 'other' } },
  ])
    await assert.rejects(new NativeVoiceTransport(f.config).querySegment(changed), {
      code: 'NATIVE_VOICE_TRANSPORT_STATE_INVALID',
    });
});
test('transport close requests cancellation and drain awaits native return', async t => {
  const f = fixture(t);
  let entered,
    release,
    aborted = false,
    drained = false;
  const ready = new Promise(resolve => {
      entered = resolve;
    }),
    done = new Promise(resolve => {
      release = resolve;
    });
  f.config.runNative = async request => {
    entered();
    request.signal.addEventListener('abort', () => {
      aborted = true;
    });
    await done;
    return {
      recordingAttempted: true,
      submitAttempted: false,
      recordingPossible: false,
      stopBarrier: false,
      systemSettingsChanged: false,
    };
  };
  const transport = new NativeVoiceTransport(f.config),
    running = transport.sendSegment(f.job, f.options);
  await ready;
  transport.close();
  const draining = transport.drain().then(() => {
    drained = true;
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(aborted, true);
  assert.equal(drained, false);
  release();
  await running;
  await draining;
  assert.equal(drained, true);
  await assert.rejects(transport.sendSegment(f.job, f.options), { code: 'NATIVE_VOICE_TRANSPORT_CLOSED' });
});

function sharedPlan() {
  return {
    allowed: true,
    executionMode: 'focus-handoff',
    requiresForeground: true,
    requiresActivityGuard: true,
    activityGuardScope: 'handoff-only',
    policyVersion: 7,
    textEntryMode: 'paste',
  };
}
function handoff() {
  return { version: 1, returnWindow: { hwnd: '200', pid: 99, processCreatedFileTimeUtc: '456' } };
}

test('shared transport warms before Qt navigation and carries the one-use monitor only to native execution', async t => {
  const f = fixture(t),
    events = [],
    warmMonitor = {
      close: async () => {
        events.push('close');
      },
      drain: async () => {
        events.push('drain');
      },
    };
  f.config.currentPlan = sharedPlan;
  f.config.warmMonitorFactory = async options => {
    assert.equal(options.root, f.root);
    assert.equal(options.signal.aborted, false);
    events.push('warm');
    return warmMonitor;
  };
  f.config.driver.prepareVoiceSession = async () => {
    events.push('prepare');
    return { ...f.fresh(), focusHandoff: handoff() };
  };
  const original = f.config.runNative;
  f.config.runNative = async request => {
    events.push('native');
    assert.equal(request.warmMonitor, warmMonitor);
    return original(request);
  };
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options)).confirmed, true);
  assert.deepEqual(events, ['warm', 'prepare', 'native', 'close', 'drain']);
  const saved = fs.readFileSync(path.join(f.root, 'state/native-voice-transport', f.job.id + '.json'), 'utf8');
  assert.equal(saved.includes('warmMonitor'), false);
  await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.deepEqual(events, ['warm', 'prepare', 'native', 'close', 'drain']);
});

test('default transport uses fast voice navigation and focus handoff even without an injected plan', async t => {
  const f = fixture(t),
    events = [];
  f.config.warmMonitorFactory = async () => {
    events.push('warm');
    return { close: async () => events.push('close'), drain: async () => events.push('drain') };
  };
  f.config.driver.prepareVoiceSession = async (_job, { interactionPlan }) => {
    assert.equal(interactionPlan.executionMode, 'focus-handoff');
    assert.equal(interactionPlan.textEntryMode, 'paste');
    events.push('prepare');
    return f.fresh();
  };
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options)).confirmed, true);
  assert.deepEqual(events, ['warm', 'prepare', 'close', 'drain']);
});

test('retired continuous voice and humanized voice navigation are rejected before receipts or input', async t => {
  for (const patch of [
    { executionMode: 'foreground' },
    { textEntryMode: 'humanized' },
    { activityGuardScope: 'entire-send' },
  ]) {
    const f = fixture(t);
    f.config.currentPlan = () => ({ ...sharedPlan(), ...patch });
    f.config.warmMonitorFactory = async () => {
      assert.fail('blocked plan must not warm');
    };
    const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
    assert.equal(result.reason, 'NATIVE_VOICE_INTERACTION_PLAN_BLOCKED');
    assert.equal(result.attempted, false);
    assert.equal(result.recordingPossible, false);
    assert.equal(f.state.preparations, 0);
    assert.equal(f.state.nativeCalls, 0);
  }
});

test('invalid injected monitor cannot hide the safe configuration refusal during cleanup', async t => {
  for (const monitor of [null, {}, { close: async () => {} }]) {
    const f = fixture(t);
    f.config.currentPlan = sharedPlan;
    f.config.warmMonitorFactory = async () => monitor;
    f.config.driver.prepareVoiceSession = async () => {
      assert.fail('invalid monitor');
    };
    const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
    assert.equal(result.reason, 'NATIVE_VOICE_WARMUP_INVALID');
    assert.equal(result.attempted, false);
    assert.equal(result.recordingPossible, false);
  }
});

test('revocation during read-only warmup prevents Qt navigation and closes the monitor', async t => {
  const f = fixture(t);
  let closed = 0,
    drained = 0;
  f.config.currentPlan = sharedPlan;
  f.config.warmMonitorFactory = async () => {
    f.state.allowed = false;
    return {
      close: async () => {
        closed++;
      },
      drain: async () => {
        drained++;
      },
    };
  };
  f.config.driver.prepareVoiceSession = async () => {
    assert.fail('revoked');
  };
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.attempted, false);
  assert.equal(result.recordingPossible, false);
  assert.equal(closed, 1);
  assert.equal(drained, 1);
  assert.equal(f.state.nativeCalls, 0);
});

test('known warm rejection stops the monitor and releases prepared focus; unknown outcomes never return focus blindly', async t => {
  for (const known of [true, false]) {
    const f = fixture(t),
      events = [];
    f.config.currentPlan = sharedPlan;
    f.config.warmMonitorFactory = async () => ({
      close: async () => {
        events.push('closed');
      },
      drain: async () => {
        events.push('drained');
      },
    });
    f.config.driver.prepareVoiceSession = async () => ({
      ...f.fresh(),
      focusHandoff: handoff(),
      releaseFocus: async () => {
        events.push('focus');
      },
    });
    f.config.runNative = async () => {
      throw Object.assign(new Error('failed'), {
        code: 'VOICE_PIPE_FAILED',
        ...(known
          ? {
              warmExecutionStarted: false,
              nativeStarted: false,
              recordingPossible: false,
              submitAttempted: false,
            }
          : { recordingPossible: true, submitAttempted: null }),
      });
    };
    const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
    assert.equal(result.recordingPossible, !known);
    assert.equal(result.stopBarrier, !known);
    assert.deepEqual(events, known ? ['closed', 'drained', 'focus'] : ['closed', 'drained']);
  }
});

test('transport drain waits for unused warm process exit before releasing prepared focus', async t => {
  const f = fixture(t);
  let release,
    closing,
    drained = false,
    focus = 0;
  const wait = new Promise(resolve => {
      release = resolve;
    }),
    started = new Promise(resolve => {
      closing = resolve;
    });
  f.config.currentPlan = sharedPlan;
  f.config.warmMonitorFactory = async () => ({
    close: async () => {
      closing();
      await wait;
    },
    drain: async () => {},
  });
  f.config.driver.prepareVoiceSession = async () => {
    f.state.allowed = false;
    return {
      ...f.fresh(),
      focusHandoff: handoff(),
      releaseFocus: async () => {
        focus++;
      },
    };
  };
  const transport = new NativeVoiceTransport(f.config),
    run = transport.sendSegment(f.job, f.options);
  await started;
  const drain = transport.drain().then(() => {
    drained = true;
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(drained, false);
  assert.equal(focus, 0);
  release();
  await run;
  await drain;
  assert.equal(drained, true);
  assert.equal(focus, 1);
});

test('production transport copies a calibrated activation anchor from fresh preparation only', async t => {
  const f = fixture(t),
    focus = {
      ...handoff(),
      activation: { rect: { left: 200, top: 8, right: 320, bottom: 32 }, rgbaSha256: hex('9') },
    };
  f.config.currentPlan = sharedPlan;
  f.config.driver.prepareVoiceSession = async () => ({ ...f.fresh(), focusHandoff: focus });
  f.config.runNative = async request => {
    f.state.nativeCalls++;
    assert.deepEqual(request.focusHandoff, focus);
    assert.notEqual(request.focusHandoff.activation, focus.activation);
    assert.notEqual(request.focusHandoff.activation.rect, focus.activation.rect);
    return {
      recordingAttempted: true,
      submitAttempted: true,
      recordingPossible: false,
      stopBarrier: false,
      systemSettingsChanged: false,
    };
  };
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.confirmed, true);
  assert.equal(f.state.nativeCalls, 1);
  const saved = fs.readFileSync(path.join(f.root, 'state/native-voice-transport', f.job.id + '.json'), 'utf8');
  assert.equal(saved.includes('activation'), false);
  assert.equal(saved.includes('rgbaSha256'), false);
});

test('invalid activation is refused before recording and releases transferred focus', async t => {
  const f = fixture(t);
  let released = 0;
  f.config.currentPlan = sharedPlan;
  f.config.driver.prepareVoiceSession = async () => ({
    ...f.fresh(),
    focusHandoff: {
      ...handoff(),
      activation: { rect: { left: 200, top: 400, right: 320, bottom: 424 }, rgbaSha256: hex('9') },
    },
    releaseFocus: async () => {
      released++;
    },
  });
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.attempted, false);
  assert.equal(result.recordingPossible, false);
  assert.equal(result.reason, 'VOICE_FOCUS_HANDOFF_INVALID');
  assert.equal(released, 1);
  assert.equal(f.state.nativeCalls, 0);
});

test('shared voice freezes its plan and transports the exact preparation return window', async t => {
  const f = fixture(t);
  let plan = sharedPlan(),
    released = 0;
  f.config.currentPlan = () => plan;
  f.job.index = 1;
  f.job.deliveryId = hex('9');
  f.config.driver.prepareVoiceSession = async (navigation, options) => {
    assert.equal(navigation.mode, 'voice');
    assert.equal(navigation.deliveryId, f.job.deliveryId);
    assert.equal(Object.hasOwn(navigation, 'index'), false);
    assert.equal(options.interactionPlan.executionMode, 'focus-handoff');
    assert.equal(options.interactionPlan.textEntryMode, 'paste');
    return {
      ...f.fresh(),
      focusHandoff: handoff(),
      releaseFocus: async () => {
        released++;
      },
    };
  };
  f.config.runNative = async request => {
    f.state.nativeCalls++;
    assert.deepEqual(request.focusHandoff, handoff());
    // Changing mode after start affects subsequent segments, never swaps this
    // recording's actions or causes it to be sent again.
    plan = { ...plan, policyVersion: 8, executionMode: 'foreground' };
    return {
      recordingAttempted: true,
      submitAttempted: true,
      recordingPossible: false,
      stopBarrier: false,
      systemSettingsChanged: false,
    };
  };
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options)).confirmed, true);
  assert.equal(released, 0);
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options)).confirmed, true);
  assert.equal(f.state.nativeCalls, 1);
});

test('shared mode refuses missing handoff support and releases prepared focus on revocation', async t => {
  for (const cause of ['missing', 'changed', 'revoked', 'bad-proof']) {
    const f = fixture(t);
    let plan = sharedPlan(),
      released = 0;
    f.config.currentPlan = () => plan;
    f.config.driver.prepareVoiceSession = async () => {
      const result = {
        ...f.fresh(),
        releaseFocus: async () => {
          released++;
        },
      };
      if (cause === 'missing') delete result.focusHandoff;
      if (cause === 'changed') plan = { ...plan, policyVersion: 8 };
      if (cause === 'revoked') f.state.allowed = false;
      if (cause === 'bad-proof') result.accountProof.accountRef = hex('f');
      return result;
    };
    const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
    assert.equal(result.confirmed, false);
    assert.equal(result.attempted, false);
    assert.equal(f.state.nativeCalls, 0);
    assert.equal(released, 1);
  }
});

test('unknown native handoff never triggers a second focus action or recording attempt', async t => {
  const f = fixture(t);
  let released = 0;
  f.config.currentPlan = sharedPlan;
  f.config.driver.prepareVoiceSession = async () => ({
    ...f.fresh(),
    focusHandoff: handoff(),
    releaseFocus: async () => {
      released++;
    },
  });
  f.config.runNative = async () => {
    f.state.nativeCalls++;
    throw new Error('lost');
  };
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.stopBarrier, true);
  assert.equal(result.recordingPossible, true);
  assert.equal(released, 0);
  await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(f.state.nativeCalls, 1);
});

test('proved native pre-start failure releases transferred focus without creating a recording barrier', async t => {
  const f = fixture(t);
  let released = 0;
  f.config.currentPlan = sharedPlan;
  f.config.driver.prepareVoiceSession = async () => ({
    ...f.fresh(),
    focusHandoff: handoff(),
    releaseFocus: async () => {
      released++;
    },
  });
  f.config.runNative = async () => {
    throw Object.assign(new Error('missing'), {
      code: 'VOICE_COMPONENT_MISSING',
      nativeStarted: false,
      recordingPossible: false,
      submitAttempted: false,
    });
  };
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.attempted, false);
  assert.equal(result.recordingPossible, false);
  assert.equal(result.stopBarrier, false);
  assert.equal(released, 1);
});

test('slow preparation cannot open a recorder without sufficient execution and receipt time', async t => {
  const f = fixture(t);
  let released = 0;
  f.config.currentPlan = sharedPlan;
  f.config.driver.prepareVoiceSession = async () => ({
    ...f.fresh(),
    focusHandoff: handoff(),
    releaseFocus: async () => {
      released++;
    },
  });
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, {
    ...f.options,
    executionDeadlineAt: f.config.now() + 19000,
  });
  assert.equal(result.reason, 'NATIVE_VOICE_START_BUDGET_EXHAUSTED');
  assert.equal(result.attempted, false);
  assert.equal(result.recordingPossible, false);
  assert.equal(f.state.nativeCalls, 0);
  assert.equal(released, 1);
});

test('continuous focus intervals survive production receipts and restart without replay or cumulative substitution', async t => {
  const f = fixture(t),
    run = f.config.runNative;
  f.config.driver.prepareVoiceSession = async () => ({
    ...f.fresh(),
    foregroundIntervals: [measured('contact-navigation', 9800, true)],
  });
  f.config.runNative = async request => ({
    ...(await run(request)),
    focusHandoff: { foregroundIntervals: [measured('record-start', 2200), measured('record-submit', 410)] },
  });
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.confirmed, true);
  assert.equal(result.foregroundTiming.maxContinuousForegroundMs, 9800);
  assert.deepEqual(
    result.foregroundTiming.intervals.map(row => row.durationMs),
    [9800, 2200, 410],
  );
  assert.equal(JSON.stringify(result.foregroundTiming).includes(f.job.target), false);
  const repeated = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.deepEqual(repeated.foregroundTiming, result.foregroundTiming);
  assert.equal(f.state.nativeCalls, 1);
});
test('malformed optional timing does not turn a confirmed send into a retry or leak arbitrary fields', async t => {
  const f = fixture(t),
    run = f.config.runNative;
  f.config.runNative = async request => ({
    ...(await run(request)),
    focusHandoff: { foregroundIntervals: [{ ...measured('record-start', 1234), private: 'SECRET' }] },
  });
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.confirmed, true);
  assert.equal(result.foregroundTiming, undefined);
  assert.equal(f.state.nativeCalls, 1);
});

test('layout facade ownership is released only after known native completion and helper cleanup', async t => {
  for (const unknown of [false, true]) {
    const f = fixture(t),
      released = [];
    f.config.driver.finishVoiceInteraction = value => released.push(value);
    if (unknown)
      f.config.runNative = async () => {
        throw Object.assign(new Error(), { code: 'VOICE_PROTOCOL_INVALID' });
      };
    await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
    assert.deepEqual(released, [{ jobId: f.job.id, cleanupConfirmed: !unknown }]);
  }
});

test('submitted voice focus failure survives receipt confirmation and transport restart', async t => {
  const f = fixture(t),
    cleanup = [];
  f.config.driver.finishVoiceInteraction = value => cleanup.push(value);
  f.config.runNative = async () => {
    f.state.nativeCalls++;
    return {
      ok: false,
      reason: 'VOICE_FOCUS_RETURN_UNCONFIRMED',
      recordingAttempted: true,
      submitAttempted: true,
      recordingEndedObserved: true,
      recordingPossible: false,
      stopBarrier: false,
      systemSettingsChanged: false,
      focusHandoff: {
        initialReturnAttempted: true,
        initialReturnConfirmed: true,
        backgroundEntered: true,
        finalReturnAttempted: true,
        finalReturnConfirmed: false,
        returnSkippedForHumanInput: false,
      },
    };
  };
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.confirmed, true);
  assert.equal(result.focusRecoveryRequired, true);
  assert.equal(cleanup[0].cleanupConfirmed, false);
  const replay = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(replay.confirmed, true);
  assert.equal(replay.focusRecoveryRequired, true);
  assert.equal(f.state.nativeCalls, 1);
});

test('configured zero idle reaches the native voice request', async t => {
  const f = fixture(t);
  f.state.freshChanges = fresh => {
    fresh.idleMs = 0;
  };
  const run = f.config.runNative;
  f.config.runNative = async request => {
    assert.equal(request.idleMs, 0);
    return run(request);
  };
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options)).confirmed, true);
});
