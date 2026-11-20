import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UiVoiceSession } from './ui-voice-session.mjs';

const fail = code => Object.assign(new Error(code), { code });
function wav(durationMs = 100) {
  const frames = Math.round(8000 * durationMs / 1000), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  return bytes;
}
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-voice-session-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^ui-voice-session-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = { deliveryId: 'a'.repeat(64), account: 'test-account', target: 'test-chat', voiceId: 'test-voice', captureEndpointId: 'test-cable', audio: wav() };
  const state = { recording: false, leaseHeld: false, activity: 1, foreground: true, target: request.target, draft: '', idleMs: 20000,
    captureValid: true, calls: [], playerDelay: 15, cancelProof: true, receiptMode: 'confirmed', ...overrides };
  let unsafe, stopPlaying;
  const persisted = () => JSON.parse(fs.readFileSync(path.join(directory, 'jobs', request.deliveryId + '.json'), 'utf8'));
  const driver = {
    async acquireDesktop() {
      state.calls.push('lease');
      if (state.leaseHeld) return null;
      state.leaseHeld = true;
      return { token: 'desktop-token', owns: () => state.leaseHeld, async release() { state.calls.push('release'); state.leaseHeld = false; } };
    },
    async observe(job, { leaseToken }) {
      assert.equal(leaseToken, 'desktop-token');
      await state.beforeObserve?.(job);
      return { ready: true, inputEnabled: true, accountVerified: true, targetVerified: true, account: request.account, target: state.target,
        foreground: state.foreground, windowToken: 'test-window', processId: 123, activityRevision: state.activity, draft: state.draft, idleMs: state.idleMs,
        recording: state.recording ? { owned: true, sessionToken: 'recording-token', cancelAvailable: true } : null,
        capture: state.recording ? { verified: state.captureValid, active: true, singleProcess: true, processId: 123, sessionToken: 'recording-token',
          endpointId: request.captureEndpointId, flow: 'capture', name: 'CABLE Output (VB-Audio Virtual Cable)', adapter: 'VB-Audio Virtual Cable' } : null };
    },
    watchSafety(_job, { onUnsafe }) { state.calls.push('watch'); unsafe = onUnsafe; state.onWatch?.(onUnsafe); return () => { state.calls.push('unwatch'); unsafe = null; }; },
    async startRecording(job, { guard, signal, recordingLimitMs }) {
      state.calls.push('start'); assert.equal(persisted().state, 'starting'); assert.equal(persisted().recordingPossible, true);
      assert.equal(guard.activityRevision, state.activity); assert.equal(guard.leaseToken, 'desktop-token'); assert.equal(signal.aborted, false);
      assert.equal(recordingLimitMs, 5000);
      if (state.start) return state.start(job, { guard, signal });
      state.recording = true; return { performed: true, sessionToken: 'recording-token' };
    },
    async submitRecording(job, { guard }) {
      state.calls.push('submit'); assert.equal(persisted().state, 'submitting'); assert.equal(guard.sessionToken, 'recording-token');
      if (state.submit) return state.submit(job, { guard });
      state.recording = false; return { performed: true, recordingEnded: true, sessionToken: 'recording-token' };
    },
    async cancelRecording(job, { guard }) {
      state.calls.push('cancel'); assert.equal(persisted().cancellationIntended, true); assert.equal(guard.sessionToken, 'recording-token');
      assert.equal(guard.activityRevision, state.activity); assert.equal(state.foreground, true); assert.equal(state.target, job.target);
      state.recording = false;
      return { cancelled: true, recordingEnded: true, noSubmission: state.cancelProof, deliveryId: job.id, sessionToken: 'recording-token' };
    },
    async stopInputs() { state.calls.push('stop-inputs'); return { stopped: state.stopProof !== false }; },
    async receipt(job) {
      state.calls.push('receipt');
      if (state.receipt) return state.receipt(job);
      if (state.receiptMode === 'unknown') return { confirmed: false };
      return { confirmed: true, recordingEnded: true, deliveryId: job.id, account: job.account, target: job.target, receipt: { id: 'test-message' } };
    },
  };
  const player = {
    playWav(audio, { signal }) {
      state.calls.push('play'); assert.equal(persisted().state, 'playing'); assert.equal(state.recording, true); assert.deepEqual(audio, request.audio);
      const pending = new Promise((resolve, reject) => {
        let timer;
        const settle = error => { clearTimeout(timer); signal.removeEventListener('abort', abort); stopPlaying = null; if (error) reject(error); else resolve({ playbackComplete: true, durationMs: 100 }); };
        const abort = () => settle(fail('CABLE_PLAYER_ABORTED'));
        stopPlaying = abort;
        timer = setTimeout(() => settle(), state.playerDelay);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      state.onPlay?.(); return pending;
    },
    async stop() { state.calls.push('stop-audio'); stopPlaying?.(); },
  };
  const options = { directory, driver, player, allowSubmit: true, settings: { idleMs: 100, operationTimeoutMs: 30, receiptTimeoutMs: 30, pollMs: 10, maxRecordingMs: 5000, finishingMarginMs: 20 } };
  const create = more => new UiVoiceSession({ ...options, ...more });
  return { directory, request, state, driver, player, create, persisted, fire: reason => unsafe?.(reason), runner: create() };
}

test('default submission off prevents starting a recorder that could auto-send', async t => {
  const f = fixture(t), runner = f.create({ allowSubmit: false });
  const result = await runner.run(f.request);
  assert.equal(result.state, 'waiting'); assert.equal(result.reason, 'UI_VOICE_SUBMIT_DISABLED');
  assert.deepEqual(f.state.calls, []); assert.equal(result.recordingPossible, false);
});

test('voice run holds a shared desktop lease, journals before actions and confirms only a linked receipt', async t => {
  const f = fixture(t);
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'confirmed'); assert.equal(result.recordingPossible, false); assert.equal(f.state.leaseHeld, false);
  assert.deepEqual(f.state.calls.filter(call => ['lease', 'start', 'play', 'submit', 'receipt', 'release'].includes(call)), ['lease', 'start', 'play', 'submit', 'receipt', 'release']);
  assert.deepEqual(result.history.map(item => item.state), ['prepared', 'starting', 'recording', 'playing', 'submitting', 'submitted', 'confirmed']);
  const previous = [...f.state.calls];
  await f.runner.run(f.request); assert.deepEqual(f.state.calls, previous);
  const changed = { ...f.request, audio: Buffer.from(f.request.audio) }; changed.audio[44] = 1;
  await assert.rejects(f.runner.run(changed), { code: 'UI_VOICE_ID_CONFLICT' });
});

test('wrong identity, personal draft, current recorder and insufficient idle time do not start recording', async t => {
  for (const change of [{ target: 'other-chat' }, { draft: 'personal draft' }, { recording: true }, { idleMs: 10 }]) {
    const f = fixture(t, change);
    const result = await f.runner.run(f.request);
    assert.equal(result.state, 'waiting'); assert.equal(f.state.calls.includes('start'), false); assert.equal(f.state.leaseHeld, false);
  }
});

test('only an explicitly verified active CABLE capture session permits audio playback', async t => {
  const f = fixture(t, { captureValid: false });
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'UI_VOICE_CAPTURE_NOT_VERIFIED');
  assert.equal(f.state.calls.includes('play'), false); assert.equal(f.state.calls.includes('submit'), false); assert.equal(f.state.calls.includes('cancel'), true);
});

test('human activity event stops playback and cancels only the still-bound recording with a fresh revision', async t => {
  const f = fixture(t, { playerDelay: 90 });
  f.state.onPlay = () => setTimeout(() => { f.state.activity++; f.fire('UI_USER_ACTIVE'); }, 5);
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'UI_USER_ACTIVE');
  assert.equal(f.state.calls.includes('stop-audio'), true); assert.equal(f.state.calls.includes('cancel'), true); assert.equal(f.state.calls.includes('submit'), false);
  assert.equal(f.state.leaseHeld, false);
});

test('focus loss stops audio without injecting cancellation into another app and retains the desktop lease', async t => {
  const f = fixture(t, { playerDelay: 90 });
  f.state.onPlay = () => setTimeout(() => { f.state.foreground = false; f.fire('UI_FOREGROUND_REQUIRED'); }, 5);
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'uncertain'); assert.equal(result.desktopLeaseRetained, true); assert.equal(f.state.leaseHeld, true);
  assert.equal(f.state.calls.includes('cancel'), false); assert.equal(f.state.calls.includes('submit'), false);
  await assert.rejects(f.runner.run({ ...f.request, deliveryId: 'b'.repeat(64) }), { code: 'UI_VOICE_BUSY' });
});

test('periodic verification detects a target change even without a safety event', async t => {
  const f = fixture(t, { playerDelay: 90 });
  f.state.onPlay = () => setTimeout(() => { f.state.target = 'other-chat'; }, 5);
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'uncertain'); assert.equal(result.reason, 'UI_VOICE_CONTEXT_CHANGED');
  assert.equal(f.state.calls.includes('cancel'), false); assert.equal(f.state.calls.includes('submit'), false);
});

test('an external AbortSignal stops audio and proves discard before marking cancelled', async t => {
  const f = fixture(t, { playerDelay: 90 }), controller = new AbortController();
  f.state.onPlay = () => setTimeout(() => controller.abort(), 5);
  const result = await f.runner.run(f.request, { signal: controller.signal });
  assert.equal(result.state, 'cancelled'); assert.equal(result.recordingPossible, false); assert.equal(f.state.calls.includes('submit'), false);
});

test('cancel acknowledgement without proof of no submission remains uncertain and cannot be replayed after restart', async t => {
  const f = fixture(t, { captureValid: false, cancelProof: false, receiptMode: 'unknown' });
  const first = await f.runner.run(f.request);
  assert.equal(first.state, 'uncertain'); assert.equal(first.recordingPossible, true);
  const before = f.state.calls.filter(call => call === 'start').length;
  const next = await f.create().run(f.request);
  assert.equal(next.state, 'uncertain'); assert.equal(f.state.calls.filter(call => call === 'start').length, before);
});

test('a hung start is bounded, stops pending inputs and leaves a durable uncertain intent without retry', async t => {
  const f = fixture(t, { receiptMode: 'unknown' });
  f.state.start = () => new Promise(() => {});
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'uncertain'); assert.equal(result.desktopLeaseRetained, true); assert.equal(f.state.calls.includes('stop-inputs'), true);
  assert.equal(f.state.calls.includes('play'), false); assert.equal(f.state.calls.includes('cancel'), false);
  await f.create().run(f.request); assert.equal(f.state.calls.filter(call => call === 'start').length, 1);
});

test('an ambiguous submit never repeats and only a matching persisted delivery receipt can resolve it', async t => {
  const f = fixture(t, { receiptMode: 'unknown' });
  f.state.submit = () => { f.state.recording = false; throw Error('lost acknowledgement'); };
  const first = await f.runner.run(f.request);
  assert.equal(first.state, 'uncertain'); assert.equal(f.state.calls.filter(call => call === 'submit').length, 1);
  f.state.receipt = job => ({ confirmed: true, recordingEnded: true, deliveryId: 'b'.repeat(64), account: job.account, target: job.target, receipt: { id: 'wrong-message' } });
  assert.equal((await f.create().run(f.request)).state, 'uncertain');
  f.state.receipt = job => ({ confirmed: true, recordingEnded: true, deliveryId: job.id, account: job.account, target: job.target, receipt: { id: 'real-message' } });
  assert.equal((await f.create().reconcile(f.request.deliveryId)).state, 'confirmed');
  assert.equal(f.state.calls.filter(call => call === 'submit').length, 1);
});

test('successful submit without a receipt stays submitted and blocks subsequent jobs', async t => {
  const f = fixture(t, { receiptMode: 'unknown' });
  assert.equal((await f.runner.run(f.request)).state, 'submitted'); assert.equal(f.state.leaseHeld, false);
  await assert.rejects(f.create().run({ ...f.request, deliveryId: 'b'.repeat(64) }), { code: 'UI_VOICE_RECOVERY_REQUIRED' });
  await f.create().run(f.request); assert.equal(f.state.calls.filter(call => call === 'submit').length, 1);
});

test('pre-input refusal can be retried while a crash after start intention can only query receipts', async t => {
  const f = fixture(t);
  f.state.start = () => ({ performed: false, attempted: false, reason: 'UI_USER_ACTIVE' });
  assert.equal((await f.runner.run(f.request)).state, 'waiting'); assert.equal(f.persisted().recordingPossible, false);
  delete f.state.start;
  assert.equal((await f.runner.run(f.request)).state, 'confirmed');
  const saved = f.persisted(); saved.state = 'starting'; saved.recordingPossible = true; delete saved.sessionToken;
  fs.writeFileSync(path.join(f.directory, 'jobs', saved.id + '.json'), JSON.stringify(saved));
  f.state.receiptMode = 'unknown';
  const count = f.state.calls.filter(call => call === 'start').length;
  assert.equal((await f.create().run(f.request)).state, 'starting');
  assert.equal(f.state.calls.filter(call => call === 'start').length, count);
});

test('a safety event before the start call prevents even the initial recording input', async t => {
  const f = fixture(t); f.state.onWatch = notify => notify('UI_USER_ACTIVE');
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'cancelled'); assert.equal(result.recordingPossible, false); assert.equal(f.state.calls.includes('start'), false);
});

test('worker lock serializes processes and class stop stops the active audio', async t => {
  const f = fixture(t, { playerDelay: 90 }); let began;
  const playing = new Promise(resolve => { began = resolve; }); f.state.onPlay = began;
  const running = f.runner.run(f.request); await playing;
  await assert.rejects(f.create().run(f.request), { code: 'UI_VOICE_BUSY' });
  f.runner.stop(); const result = await running;
  assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'UI_VOICE_STOPPED');
});

test('recording deadline is checked again before submit and unsafe durations are rejected before leasing', async t => {
  const f = fixture(t); let now = 1000;
  f.state.onPlay = () => { now += 10000; };
  const result = await f.create({ now: () => now }).run(f.request);
  assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'UI_VOICE_RECORDING_TIMEOUT'); assert.equal(f.state.calls.includes('submit'), false);
  const g = fixture(t);
  await assert.rejects(g.runner.run({ ...g.request, audio: wav(4950) }), { code: 'UI_VOICE_DURATION_LIMIT' });
  assert.deepEqual(g.state.calls, []);
});

test('invalid abort signals are rejected before acquiring a desktop and busy leases remain waiting', async t => {
  const f = fixture(t);
  await assert.rejects(f.runner.run(f.request, { signal: {} }), { code: 'UI_VOICE_SIGNAL_INVALID' });
  assert.deepEqual(f.state.calls, []);
  f.state.leaseHeld = true;
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'waiting'); assert.equal(result.reason, 'UI_VOICE_DESKTOP_BUSY');
  assert.equal(f.state.calls.includes('start'), false); assert.equal(f.state.calls.includes('release'), false);
});

test('an invalid lease with unconfirmed release persists a recovery barrier across restart', async t => {
  const f = fixture(t);
  f.driver.acquireDesktop = async () => ({ token: '', owns: () => true, release: () => new Promise(() => {}) });
  await assert.rejects(f.runner.run(f.request), { code: 'UI_VOICE_LEASE_INVALID' });
  assert.equal(f.persisted().desktopLeaseRetained, true);
  assert.equal(f.persisted().acquisitionPending, true);
  assert.equal(f.state.calls.includes('start'), false);
  await assert.rejects(f.create().run(f.request), { code: 'UI_VOICE_RECOVERY_REQUIRED' });
  await assert.rejects(f.create().run({ ...f.request, deliveryId: 'b'.repeat(64) }), { code: 'UI_VOICE_RECOVERY_REQUIRED' });
});

test('desktop lease ownership requires synchronous true before observing or recording', async t => {
  const f = fixture(t);
  const acquire = f.driver.acquireDesktop;
  f.driver.acquireDesktop = async () => ({ ...await acquire(), owns: async () => true });
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'waiting'); assert.equal(result.reason, 'UI_VOICE_OBSERVATION_FAILED');
  assert.equal(f.state.calls.includes('start'), false); assert.equal(f.state.leaseHeld, false);
});

test('malformed playback observations stop audio and take the guarded cancellation path', async t => {
  const f = fixture(t, { playerDelay: 90 }), observe = f.driver.observe;
  let malformed = false;
  f.driver.observe = async (job, options) => {
    if (job.state === 'playing' && !malformed) { malformed = true; return null; }
    return observe(job, options);
  };
  const result = await f.runner.run(f.request);
  assert.equal(malformed, true); assert.equal(result.state, 'cancelled');
  assert.equal(result.reason, 'UI_VOICE_CONTEXT_CHANGED'); assert.equal(f.state.calls.includes('submit'), false);
  assert.equal(f.state.calls.includes('stop-audio'), true); assert.equal(f.state.calls.includes('cancel'), true);
});

test('stop during pending desktop acquisition cancels this run before recording can start', async t => {
  const f = fixture(t), acquire = f.driver.acquireDesktop;
  let requested, resume;
  const waiting = new Promise(resolve => { requested = resolve; });
  f.driver.acquireDesktop = async () => { requested(); await new Promise(resolve => { resume = resolve; }); return acquire(); };
  const running = f.runner.run(f.request); await waiting;
  f.runner.stop(); resume();
  const result = await running;
  assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'UI_VOICE_STOPPED');
  assert.equal(f.state.calls.includes('start'), false); assert.equal(f.state.leaseHeld, false);
});

test('an unresponsive desktop release is bounded, retains an uncertainty marker and blocks reuse', async t => {
  const f = fixture(t), acquire = f.driver.acquireDesktop;
  f.driver.acquireDesktop = async () => ({ ...await acquire(), release: () => new Promise(() => {}) });
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'confirmed'); assert.equal(result.reason, 'UI_VOICE_LEASE_RELEASE_UNCERTAIN');
  assert.equal(result.desktopLeaseRetained, true);
  assert.equal(fs.existsSync(path.join(f.directory, 'worker.lock')), false);
  await assert.rejects(f.runner.run(f.request), { code: 'UI_VOICE_BUSY' });
});

test('a late desktop lease after acquisition timeout is aborted and its failed release blocks reuse and restart', async t => {
  const f = fixture(t); let grant, observedSignal;
  f.driver.acquireDesktop = (_job, { signal }) => { observedSignal = signal; return new Promise(resolve => { grant = resolve; }); };
  const result = await f.runner.run(f.request);
  assert.equal(result.state, 'waiting'); assert.equal(result.acquisitionPending, true); assert.equal(observedSignal.aborted, true);
  await assert.rejects(f.create().run(f.request), { code: 'UI_VOICE_RECOVERY_REQUIRED' });
  grant({ token: 'late-token', owns: () => true, release: async () => { throw Error('release failed'); } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.persisted().desktopLeaseRetained, true);
  await assert.rejects(f.runner.run(f.request), { code: 'UI_VOICE_BUSY' });
  assert.equal(f.state.calls.includes('start'), false);
});

test('a late desktop lease with a confirmed release clears only the pending acquisition barrier', async t => {
  const f = fixture(t); let grant;
  const acquire = f.driver.acquireDesktop;
  f.driver.acquireDesktop = () => new Promise(resolve => { grant = resolve; });
  const first = await f.runner.run(f.request); assert.equal(first.acquisitionPending, true);
  let released = false;
  grant({ token: 'late-token', owns: () => true, release: async () => { released = true; } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(released, true); assert.equal(f.persisted().acquisitionPending, false);
  f.driver.acquireDesktop = acquire;
  assert.equal((await f.runner.run(f.request)).state, 'confirmed');
});
