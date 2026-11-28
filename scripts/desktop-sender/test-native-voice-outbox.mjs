import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeVoiceOutbox } from './native-voice-outbox.mjs';
import { splitNativeVoiceWav } from './voice-segments.mjs';
import { acquireDeliveryLock } from './delivery-lock.mjs';
import { inspectPlaybackWav } from './cable-player.mjs';
import { voiceInterruptionEvidence, voiceRecordingCancellationEvidence } from './voice-interruption-evidence.mjs';

const hex = letter => letter.repeat(64);
function workerLocked(f) {
  const lease = acquireDeliveryLock(path.join(f.root, 'state/native-voice-outbox'), 'worker');
  lease?.release();
  return lease === null;
}
const cancelledRecording = job => ({
  confirmed: false,
  attempted: true,
  recordingPossible: false,
  stopBarrier: false,
  routeSafe: true,
  routeMode: 'unchanged',
  reason: 'DRAFT_HUMAN_ACTIVITY_CHANGED',
  interruptionCancellation: voiceInterruptionEvidence(
    {
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
    },
    job,
  ),
});
function wav(ms, floating = false) {
  const frames = ms * 16,
    sampleBytes = floating ? 4 : 2,
    data = Buffer.alloc(frames * sampleBytes),
    result = Buffer.alloc(44 + data.length);
  for (let frame = 0; frame < frames; frame++) {
    const value = Math.sin(frame * 0.13) * 0.1;
    if (floating) data.writeFloatLE(value, frame * sampleBytes);
    else data.writeInt16LE(Math.round(value * 32767), frame * sampleBytes);
  }
  result.write('RIFF');
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(floating ? 3 : 1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24);
  result.writeUInt32LE(16000 * sampleBytes, 28);
  result.writeUInt16LE(sampleBytes, 32);
  result.writeUInt16LE(sampleBytes * 8, 34);
  result.write('data', 36);
  result.writeUInt32LE(data.length, 40);
  data.copy(result, 44);
  return result;
}
function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-voice-outbox-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^native-voice-outbox-/);
    fs.rmSync(resolved, { recursive: true });
  });
  const state = { allowed: true, sends: [], queries: [], syntheses: 0, selectedVoice: hex('b'), durations: [9000] };
  const scope = {
    version: 1,
    accountRef: hex('c'),
    account: 'fixture-self',
    target: 'fixture-friend',
    eventId: 'fixture-event',
    selectionVersion: 1,
    grantId: hex('d'),
    token: hex('e'),
  };
  const request = {
    deliveryId: hex('a'),
    account: scope.account,
    target: scope.target,
    text: '你好，我是测试语音。',
    selectionScope: scope,
  };
  const confirmed = job => ({
    confirmed: true,
    recordingPossible: false,
    stopBarrier: false,
    audioRouteRestored: true,
    receipt: {
      type: 'wechat-database-voice-v1',
      deliveryId: job.id,
      account: job.account,
      target: job.target,
      accountDirectory: 'fixture-account',
      nativeVoiceRowConfirmed: true,
      audioContentVerified: false,
      timbreVerified: false,
      sourceShard: hex('f'),
      localId: '1',
      serverId: '500',
      durationMs: Math.ceil(job.durationMs),
      createTime: 1700000000,
      observedAt: 1700000000000,
    },
  });
  const synthesizer = {
    async synthesize() {
      state.syntheses++;
      const voiceId = state.selectedVoice;
      return {
        voiceId,
        modelVerification: 'api-acknowledged',
        segments: state.durations.map(ms => ({ audio: wav(ms), voiceId, modelVerification: 'api-acknowledged' })),
      };
    },
  };
  const transport = {
    async sendSegment(job, options) {
      assert.equal(options.canSubmit(), true);
      state.sends.push({ ...job, audio: Buffer.from(job.audio) });
      return confirmed(job);
    },
    async querySegment(job) {
      assert.equal(job.audio, undefined);
      state.queries.push(job);
      return confirmed(job);
    },
  };
  const config = {
    root,
    synthesizer,
    transport,
    authorizeScope: () => state.allowed,
    now: () => 1700000000000,
    ...changes,
  };
  return { root, state, request, config, transport, confirmed, box: new NativeVoiceOutbox(config) };
}

test('PCM and float chunks preserve every original sample with bounded durations', () => {
  for (const floating of [false, true]) {
    const audio = wav(19000, floating),
      parts = splitNativeVoiceWav(audio);
    assert.ok(parts.length >= 3);
    assert.ok(parts.every(part => inspectPlaybackWav(part).durationMs <= 7500));
    assert.deepEqual(Buffer.concat(parts.map(part => part.subarray(44))), audio.subarray(44));
  }
});
test('short tails move the preceding cut without losing samples', () => {
  for (const duration of [7501, 8000, 15020, 23001]) {
    const audio = wav(duration);
    for (const searchMs of [0, 1000]) {
      const parts = splitNativeVoiceWav(audio, { searchMs });
      assert.ok(
        parts.every(part => inspectPlaybackWav(part).durationMs >= 1000 && inspectPlaybackWav(part).durationMs <= 7500),
      );
      assert.deepEqual(Buffer.concat(parts.map(part => part.subarray(44))), audio.subarray(44));
    }
  }
});
test('quiet split chooses a pause and retains non-audio chunk compatibility', () => {
  const audio = wav(12000);
  audio.fill(0, 44 + 6800 * 32, 44 + 6950 * 32);
  const parts = splitNativeVoiceWav(audio);
  assert.ok(inspectPlaybackWav(parts[0]).durationMs >= 6800 && inspectPlaybackWav(parts[0]).durationMs <= 6960);
  assert.deepEqual(Buffer.concat(parts.map(part => part.subarray(44))), audio.subarray(44));
});
test('complete task freezes selected model once and confirms every segment before the next', async t => {
  const f = fixture(t);
  const send = f.transport.sendSegment;
  f.transport.sendSegment = async (job, options) => {
    f.state.selectedVoice = hex('c');
    return send(job, options);
  };
  const result = await f.box.run(f.request);
  assert.equal(result.state, 'confirmed');
  assert.equal(f.state.syntheses, 1);
  assert.equal(f.state.sends.length, 2);
  assert.ok(f.state.sends.every(part => part.voiceId === hex('b')));
  assert.equal(new Set(f.state.sends.map(part => part.id)).size, 2);
  assert.deepEqual(Buffer.concat(f.state.sends.map(part => part.audio.subarray(44))), wav(9000).subarray(44));
  await new NativeVoiceOutbox(f.config).run(f.request);
  assert.equal(f.state.sends.length, 2);
  assert.equal(f.state.syntheses, 1);
  assert.equal(
    fs
      .readFileSync(path.join(f.root, 'state/native-voice-outbox/archive/aa', f.request.deliveryId + '.json'), 'utf8')
      .includes(f.request.text),
    false,
  );
});

test('proved cancellation for a structural error terminates the remaining voice without retry-wait or a recording barrier', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async job => {
    f.state.sends.push(job);
    return {
      confirmed: false,
      attempted: true,
      submitAttempted: false,
      recordingPossible: false,
      stopBarrier: false,
      routeSafe: true,
      routeMode: 'unchanged',
      recordingCancellation: voiceRecordingCancellationEvidence(
        {
          ok: false,
          reason: 'VOICE_CAPTION_WINDOW_CHANGED',
          recordingAttempted: true,
          captureVerified: true,
          captureSessionBound: true,
          submitAttempted: false,
          submitInputApplied: false,
          cancelAttempted: true,
          cancelInputApplied: true,
          recordingEndedObserved: true,
          recordingPossible: false,
          stopBarrier: false,
          systemSettingsChanged: false,
        },
        job,
      ),
    };
  };
  const result = await f.box.run(f.request);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.segments[0].state, 'cancelled');
  assert(result.segments[0].recordingCancellation);
  assert.equal(result.segments[0].nextAttemptAt, undefined);
  assert.equal(result.segments[1].state, 'prepared');
  assert.equal(f.state.sends.length, 1);
  const restarted = new NativeVoiceOutbox(f.config);
  assert.equal((await restarted.run(f.request)).state, 'cancelled');
  assert.equal(f.state.sends.length, 1);
  assert.equal((await restarted.query(f.request)).state, 'cancelled');
  assert.equal(f.state.queries.length, 0);
});

test('incomplete generic cancellation cannot turn an unknown attempt into cancellation or retry', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async job => ({
    confirmed: false,
    attempted: true,
    submitAttempted: false,
    recordingPossible: false,
    stopBarrier: false,
    routeSafe: true,
    routeMode: 'unchanged',
    recordingCancellation: {
      ...voiceRecordingCancellationEvidence(
        {
          ok: false,
          reason: 'VOICE_CAPTION_WINDOW_CHANGED',
          recordingAttempted: true,
          captureVerified: true,
          captureSessionBound: true,
          submitAttempted: false,
          submitInputApplied: false,
          cancelAttempted: true,
          cancelInputApplied: true,
          recordingEndedObserved: true,
          recordingPossible: false,
          stopBarrier: false,
          systemSettingsChanged: false,
        },
        job,
      ),
      recordingEndedObserved: false,
    },
  });
  const result = await f.box.run(f.request);
  assert.equal(result.state, 'unknown');
  assert.equal(result.segments[0].reason, 'NATIVE_VOICE_CANCELLATION_UNVERIFIED');
  assert.equal(result.segments[0].recordingCancellation, undefined);
  assert.equal(result.segments[0].nextAttemptAt, undefined);
});
test('confirmed interruption cancellation schedules a new attempt after durable backoff without resynthesis or replaying the old ID', async t => {
  const f = fixture(t);
  let at = 1700000000000;
  f.config.now = () => at;
  f.box = new NativeVoiceOutbox(f.config);
  const send = f.transport.sendSegment;
  f.transport.sendSegment = async (job, options) => {
    if (!f.state.sends.length) {
      f.state.sends.push({ ...job, audio: Buffer.from(job.audio) });
      return cancelledRecording(job);
    }
    return send(job, options);
  };
  const first = await f.box.run(f.request),
    part = first.segments[0],
    old = f.state.sends[0];
  assert.equal(first.state, 'sending');
  assert.equal(part.state, 'retry-wait');
  assert.equal(part.cancelledAttempts.length, 1);
  assert.equal(part.cancelledAttempts[0].id, old.id);
  assert.notEqual(part.id, old.id);
  assert.equal(part.nextAttemptAt, at + 1000);
  assert.equal(f.state.sends.length, 1);
  const next = new NativeVoiceOutbox(f.config);
  await next.query(f.request);
  await next.run(f.request);
  at += 999;
  await next.run(f.request);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.queries.length, 0);
  assert.equal(f.state.syntheses, 1);
  f.state.selectedVoice = hex('c');
  at++;
  const done = await next.run(f.request);
  assert.equal(done.state, 'confirmed');
  assert.equal(f.state.sends.length, 3);
  assert.equal(f.state.sends[1].id, part.id);
  assert.deepEqual(f.state.sends[1].audio, old.audio);
  assert.equal(f.state.sends[1].voiceId, old.voiceId);
  assert.equal(f.state.syntheses, 1);
  assert.equal(done.segments[0].receipt.deliveryId, part.id);
  assert.deepEqual(done.segments[0].cancelledAttempts, part.cancelledAttempts);
  assert.equal(next.prune().archived, 1);
  assert.deepEqual(next.get(f.request.deliveryId).segments[0].cancelledAttempts, part.cancelledAttempts);
  await next.run(f.request);
  assert.equal(f.state.sends.length, 3);
});
test('receipt-only recovery can persist a proven cancellation but never records its replacement in the same query', async t => {
  const f = fixture(t);
  let at = 1700000000000;
  f.config.now = () => at;
  f.box = new NativeVoiceOutbox(f.config);
  f.transport.sendSegment = async job => {
    f.state.sends.push(job);
    return { confirmed: false, recordingPossible: true, stopBarrier: true, routeSafe: false };
  };
  assert.equal((await f.box.run(f.request)).state, 'unknown');
  f.transport.querySegment = async job => {
    f.state.queries.push(job);
    return cancelledRecording(job);
  };
  const recovered = await new NativeVoiceOutbox(f.config).query(f.request);
  assert.equal(recovered.state, 'sending');
  assert.equal(recovered.segments[0].state, 'retry-wait');
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.queries.length, 1);
  at += 1000;
  await new NativeVoiceOutbox(f.config).query(f.request);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.queries.length, 1);
});
test('each interrupted recording keeps a separate immutable attempt and increasing persistent retry delay', async t => {
  const f = fixture(t);
  let at = 1700000000000;
  f.config.now = () => at;
  f.box = new NativeVoiceOutbox(f.config);
  f.transport.sendSegment = async job => {
    f.state.sends.push({ ...job, audio: Buffer.from(job.audio) });
    return cancelledRecording(job);
  };
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    const result = await new NativeVoiceOutbox(f.config).run(f.request);
    assert.equal(result.segments[0].nextAttemptAt, at + delay);
    assert.equal(result.segments[0].cancelledAttempts.length, f.state.sends.length);
    at += delay;
  }
  assert.equal(new Set(f.state.sends.map(job => job.id)).size, 6);
  assert.equal(f.state.syntheses, 1);
  assert.equal(
    f.state.sends.every(job => job.audioSha256 === f.state.sends[0].audioSha256),
    true,
  );
});
test('no incomplete contradictory or foreign cancellation result can authorize re-recording', async t => {
  for (const kind of [
    'missing',
    'wrong-id',
    'wrong-audio',
    'wrong-account',
    'cancel-missing',
    'sent',
    'possible',
    'barrier',
    'settings',
    'confirmed',
    'route',
    'attempted',
  ]) {
    const f = fixture(t);
    f.transport.sendSegment = async job => {
      f.state.sends.push(job);
      const result = cancelledRecording(job),
        proof = result.interruptionCancellation;
      if (kind === 'missing') delete result.interruptionCancellation;
      if (kind === 'wrong-id') proof.attemptId = hex('0');
      if (kind === 'wrong-audio') proof.audioSha256 = hex('0');
      if (kind === 'wrong-account') proof.accountSha256 = hex('0');
      if (kind === 'cancel-missing') delete proof.cancelInputApplied;
      if (kind === 'sent') proof.submitAttempted = true;
      if (kind === 'possible') proof.recordingPossible = true;
      if (kind === 'barrier') result.stopBarrier = true;
      if (kind === 'settings') proof.systemSettingsChanged = true;
      if (kind === 'confirmed') {
        result.confirmed = true;
        result.receipt = f.confirmed(job).receipt;
      }
      if (kind === 'route') result.routeSafe = false;
      if (kind === 'attempted') result.attempted = false;
      return result;
    };
    const result = await f.box.run(f.request);
    assert.equal(result.state, 'unknown', kind);
    assert.equal(result.segments[0].cancelledAttempts, undefined, kind);
    assert.equal(f.state.sends.length, 1);
  }
});
test('cancel or revoked selection during retry wait never records the replacement', async t => {
  for (const kind of ['cancel', 'revoked', 'query-cancel']) {
    const f = fixture(t);
    let at = 1700000000000;
    f.config.now = () => at;
    f.box = new NativeVoiceOutbox(f.config);
    f.transport.sendSegment = async job => {
      f.state.sends.push(job);
      return kind === 'query-cancel' ? { recordingPossible: true, stopBarrier: true } : cancelledRecording(job);
    };
    f.transport.querySegment = async job => cancelledRecording(job);
    await f.box.run(f.request);
    at += 1000;
    let final;
    if (kind === 'revoked') {
      f.state.allowed = false;
      final = await f.box.run(f.request);
    } else final = await f.box.query(f.request, { cancelPending: true });
    assert.equal(final.state, 'cancelled');
    assert.equal(
      final.segments.every(part => part.state === 'cancelled'),
      true,
    );
    assert.equal(f.state.sends.length, 1);
  }
});
test('persisted attempt chain evidence and retry time are validated before any new input', async t => {
  for (const kind of ['old-id', 'next-id', 'evidence', 'time', 'backoff', 'extra', 'bypass-wait', 'fake-terminal']) {
    const f = fixture(t);
    f.transport.sendSegment = async job => {
      f.state.sends.push(job);
      return cancelledRecording(job);
    };
    await f.box.run(f.request);
    const file = path.join(f.root, 'state/native-voice-outbox', f.request.deliveryId, 'job.json'),
      saved = JSON.parse(fs.readFileSync(file)),
      part = saved.segments[0];
    if (kind === 'old-id') part.cancelledAttempts[0].id = hex('0');
    if (kind === 'next-id') part.id = hex('0');
    if (kind === 'evidence') part.cancelledAttempts[0].evidence.cancelInputApplied = false;
    if (kind === 'time') part.cancelledAttempts[0].at--;
    if (kind === 'backoff') part.nextAttemptAt--;
    if (kind === 'extra') part.cancelledAttempts[0].extra = true;
    if (kind === 'bypass-wait') part.state = 'prepared';
    if (kind === 'fake-terminal') saved.state = 'confirmed';
    fs.writeFileSync(file, JSON.stringify(saved));
    await assert.rejects(new NativeVoiceOutbox(f.config).run(f.request), { code: 'NATIVE_VOICE_STATE_INVALID' });
    assert.equal(f.state.sends.length, 1);
  }
});
test('caller-provided window and activation hints never enter transport jobs or saved delivery state', async t => {
  const f = fixture(t);
  f.request.focusHandoff = {
    version: 1,
    returnWindow: { hwnd: '123', pid: 456, processCreatedFileTimeUtc: '789' },
    activation: { rect: { left: 200, top: 8, right: 320, bottom: 32 }, rgbaSha256: '9'.repeat(64) },
  };
  const result = await f.box.run(f.request);
  assert.equal(result.state, 'confirmed');
  assert.ok(f.state.sends.length > 0);
  for (const job of f.state.sends) {
    assert.equal(Object.hasOwn(job, 'focusHandoff'), false);
    assert.equal(Object.hasOwn(job, 'activation'), false);
  }
  for (const serialized of [JSON.stringify(result), JSON.stringify(f.box.get(f.request.deliveryId))]) {
    assert.equal(serialized.includes('focusHandoff'), false);
    assert.equal(serialized.includes('rgbaSha256'), false);
  }
});
test('unacknowledged model result is rejected before transport', async t => {
  const f = fixture(t);
  f.config.synthesizer.synthesize = async () => ({
    voiceId: hex('b'),
    modelVerification: 'caller-configured',
    segments: [],
  });
  await assert.rejects(f.box.run(f.request), { code: 'NATIVE_VOICE_SYNTHESIS_UNVERIFIED' });
  assert.equal(f.state.sends.length, 0);
});
test('revocation during synthesis never starts a recording', async t => {
  const f = fixture(t),
    synthesize = f.config.synthesizer.synthesize;
  f.config.synthesizer.synthesize = async () => {
    const result = await synthesize();
    f.state.allowed = false;
    return result;
  };
  await assert.rejects(f.box.run(f.request), { code: 'NATIVE_VOICE_SELECTION_REVOKED' });
  assert.equal(f.state.sends.length, 0);
});
test('revocation after one sent chunk cancels remaining chunks even across restart', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async job => {
    f.state.sends.push(job.id);
    f.state.allowed = false;
    return f.confirmed(job);
  };
  const result = await f.box.run(f.request);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.segments[0].state, 'confirmed');
  f.state.allowed = true;
  await new NativeVoiceOutbox(f.config).run(f.request);
  assert.equal(f.state.sends.length, 1);
});
test('revocation while transport waits aborts its signal and closes the late submit gate', async t => {
  const f = fixture(t, { scopePollMs: 10 });
  f.transport.sendSegment = async (job, options) => {
    setTimeout(() => {
      f.state.allowed = false;
    }, 5);
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(options.canSubmit(), false);
    return { attempted: false, recordingPossible: false, stopBarrier: false, audioRouteRestored: true };
  };
  assert.equal((await f.box.run(f.request)).state, 'cancelled');
});
test('unknown segment only queries on restart, and confirmation allows later prepared chunks', async t => {
  const f = fixture(t);
  let first = true;
  const send = f.transport.sendSegment;
  f.transport.sendSegment = async (job, options) => {
    if (first) {
      first = false;
      f.state.sends.push(job.id);
      return { recordingPossible: false };
    }
    return send(job, options);
  };
  assert.equal((await f.box.run(f.request)).state, 'unknown');
  assert.equal(f.state.sends.length, 1);
  assert.equal((await new NativeVoiceOutbox(f.config).run(f.request)).state, 'confirmed');
  assert.equal(f.state.queries.length, 1);
  assert.equal(f.state.sends.length, 2);
  assert.equal(f.state.syntheses, 1);
});
test('unknown delivery blocks a different ID and receipt spoofing cannot clear it', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async job => ({
    ...f.confirmed(job),
    receipt: { ...f.confirmed(job).receipt, target: 'other' },
  });
  assert.equal((await f.box.run(f.request)).state, 'unknown');
  await assert.rejects(new NativeVoiceOutbox(f.config).run({ ...f.request, deliveryId: hex('b') }), {
    code: 'NATIVE_VOICE_RECOVERY_REQUIRED',
  });
});
test('an un-restored route blocks next recording despite a valid delivered receipt', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async job => ({ ...f.confirmed(job), audioRouteRestored: false });
  assert.equal((await f.box.run(f.request)).state, 'unknown');
});
test('timeout does not consume a late confirmation or start a second segment', async t => {
  const f = fixture(t, { operationTimeoutMs: 20 });
  f.transport.sendSegment = async job => {
    f.state.sends.push(job.id);
    await new Promise(resolve => setTimeout(resolve, 50));
    return f.confirmed(job);
  };
  assert.equal((await f.box.run(f.request)).state, 'unknown');
  assert.equal(workerLocked(f), true);
  await assert.rejects(new NativeVoiceOutbox(f.config).run(f.request), { code: 'NATIVE_VOICE_BUSY' });
  await assert.rejects(f.box.run(f.request), { code: 'NATIVE_VOICE_BUSY' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(workerLocked(f), false);
  assert.equal(f.box.get(f.request.deliveryId).state, 'unknown');
  assert.equal(f.state.sends.length, 1);
});
test('query cannot turn a persisted recording intent into not-attempted cancellation', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async () => ({ recordingPossible: true });
  await f.box.run(f.request);
  f.transport.querySegment = async () => ({
    attempted: false,
    recordingPossible: false,
    stopBarrier: false,
    audioRouteRestored: true,
  });
  assert.equal((await new NativeVoiceOutbox(f.config).run(f.request)).state, 'unknown');
});
test('crash after intent write only queries and missing WAV never causes resynthesis', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async () => {
    throw new Error('lost pipe');
  };
  await f.box.run(f.request);
  const saved = f.box.get(f.request.deliveryId),
    file = path.join(f.root, 'state/native-voice-outbox', f.request.deliveryId, 'job.json');
  saved.segments[0].state = 'record-intent';
  fs.writeFileSync(file, JSON.stringify(saved));
  fs.unlinkSync(path.join(path.dirname(file), saved.segments[1].file));
  const next = await new NativeVoiceOutbox(f.config).run(f.request);
  assert.equal(f.state.queries.length, 1);
  assert.equal(next.state, 'unknown');
  assert.equal(f.state.syntheses, 1);
});
test('changed text or event grant on existing delivery is rejected', async t => {
  const f = fixture(t);
  await f.box.run(f.request);
  for (const changed of [
    { ...f.request, text: 'changed' },
    { ...f.request, selectionScope: { ...f.request.selectionScope, token: hex('f') } },
  ])
    await assert.rejects(new NativeVoiceOutbox(f.config).run(changed), { code: 'NATIVE_VOICE_ID_CONFLICT' });
});
test('closed outbox never calls synthesizer', async t => {
  const f = fixture(t);
  f.box.close();
  await assert.rejects(f.box.run(f.request), { code: 'NATIVE_VOICE_ABORTED' });
  assert.equal(f.state.syntheses, 0);
});
test('close aborts an active transport and drain waits for native cleanup to exit', async t => {
  const f = fixture(t, { operationTimeoutMs: 20 });
  let entered,
    release,
    aborted = false,
    drained = false;
  const ready = new Promise(resolve => {
      entered = resolve;
    }),
    stopped = new Promise(resolve => {
      release = resolve;
    });
  f.transport.sendSegment = async (job, options) => {
    entered();
    options.signal.addEventListener('abort', () => {
      aborted = true;
    });
    await stopped;
    return f.confirmed(job);
  };
  const running = f.box.run(f.request);
  await ready;
  f.box.close();
  const draining = f.box.drain().then(() => {
    drained = true;
  });
  assert.equal((await running).state, 'unknown');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(aborted, true);
  assert.equal(drained, false);
  assert.equal(workerLocked(f), true);
  release();
  await draining;
  assert.equal(drained, true);
  assert.equal(workerLocked(f), false);
});
test('stored audio tampering blocks sending after successful recovery', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async () => ({ recordingPossible: true });
  await f.box.run(f.request);
  const saved = f.box.get(f.request.deliveryId),
    target = path.join(f.root, 'state/native-voice-outbox', f.request.deliveryId, saved.segments[1].file);
  const bytes = fs.readFileSync(target);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(target, bytes);
  assert.equal((await new NativeVoiceOutbox(f.config).run(f.request)).state, 'unknown');
  assert.equal(f.state.queries.length, 1);
});
test('more than 256 confirmed voice jobs archive without scanning history or allowing old IDs to send again', async t => {
  const f = fixture(t);
  f.state.durations = [100];
  for (let index = 1; index <= 260; index++)
    await f.box.run({ ...f.request, deliveryId: index.toString(16).padStart(64, '0') });
  assert.equal(f.box.prune().archived, 1);
  assert.equal(
    fs.readdirSync(path.join(f.root, 'state/native-voice-outbox')).filter(name => /^[a-f0-9]{64}$/.test(name)).length,
    0,
  );
  const old = { ...f.request, deliveryId: '1'.padStart(64, '0') },
    saved = f.box.get(old.deliveryId);
  assert.equal(saved.state, 'confirmed');
  assert.equal(
    fs.existsSync(path.join(f.root, 'state/native-voice-outbox/archive/00', old.deliveryId + '.payload')),
    false,
  );
  assert.equal((await new NativeVoiceOutbox(f.config).run(old)).state, 'confirmed');
  assert.equal(f.state.sends.length, 260);
  assert.equal(f.state.syntheses, 260);
  await assert.rejects(f.box.run({ ...old, text: 'different' }), { code: 'NATIVE_VOICE_ID_CONFLICT' });
});
test('cancelled voice keeps its result and deletes audio while an unknown recording retains its evidence', async t => {
  const f = fixture(t);
  f.state.durations = [100];
  f.transport.sendSegment = async () => ({
    attempted: false,
    recordingPossible: false,
    stopBarrier: false,
    routeSafe: true,
    routeMode: 'unchanged',
  });
  assert.equal((await f.box.run(f.request)).state, 'cancelled');
  assert.equal(f.box.prune().archived, 1);
  assert.ok(
    !fs
      .readdirSync(path.join(f.root, 'state/native-voice-outbox'), { recursive: true })
      .some(file => file.endsWith('.wav')),
  );
  assert.equal((await f.box.run(f.request)).state, 'cancelled');
  assert.equal(f.state.syntheses, 1);
  const g = fixture(t);
  g.transport.sendSegment = async () => ({ recordingPossible: true });
  await g.box.run(g.request);
  assert.equal(g.box.prune().archived, 0);
  assert.equal(g.box.get(g.request.deliveryId).state, 'unknown');
  assert.ok(fs.existsSync(path.join(g.root, 'state/native-voice-outbox', g.request.deliveryId, 'segment-001.wav')));
});

test('interrupted audio preparation leaves no blocking job and can safely retry after restart', async t => {
  const f = fixture(t);
  const open = fs.openSync;
  const failure = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (typeof file === 'string' && file.endsWith('segment-002.wav'))
      throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' });
    return open(file, ...args);
  });
  await assert.rejects(f.box.run(f.request), { code: 'ENOSPC' });
  failure.mock.restore();
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.box.get(f.request.deliveryId), null);
  const scratch = path.join(f.root, 'state/native-voice-outbox', '.preparing');
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, 'segment-001.wav'), 'interrupted staging');
  const restarted = new NativeVoiceOutbox(f.config);
  assert.equal((await restarted.run({ ...f.request, deliveryId: hex('8') })).state, 'confirmed');
  assert.equal((await restarted.run(f.request)).state, 'confirmed');
  assert.equal(fs.existsSync(scratch), false);
});

test('read-only recovery never synthesizes absent jobs or records prepared segments after confirmation', async t => {
  const f = fixture(t);
  assert.equal(await f.box.query(f.request), null);
  assert.equal(f.state.syntheses, 0);
  f.transport.sendSegment = async job => {
    f.state.sends.push(job.id);
    return { recordingPossible: true };
  };
  await f.box.run(f.request);
  f.state.allowed = false;
  const result = await new NativeVoiceOutbox(f.config).query(f.request);
  assert.equal(result.state, 'sending');
  assert.equal(result.segments[0].state, 'confirmed');
  assert.equal(result.segments[1].state, 'prepared');
  assert.equal(f.state.syntheses, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.queries.length, 1);
  await f.box.query(f.request);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.queries.length, 1);
});
test('cancel pending segments preserves an unknown recording until a receipt safely clears it', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async job => {
    f.state.sends.push(job.id);
    return { recordingPossible: true };
  };
  await f.box.run(f.request);
  f.state.allowed = false;
  f.transport.querySegment = async job => {
    f.state.queries.push(job);
    return { attempted: false, recordingPossible: false, stopBarrier: false, audioRouteRestored: true };
  };
  const uncertain = await f.box.query(f.request, { cancelPending: true });
  assert.equal(uncertain.state, 'unknown');
  assert.deepEqual(
    uncertain.segments.map(part => part.state),
    ['unknown', 'cancelled'],
  );
  assert.equal(f.box.prune().archived, 0);
  f.transport.querySegment = async job => {
    f.state.queries.push(job);
    return f.confirmed(job);
  };
  const final = await f.box.query(f.request, { cancelPending: true });
  assert.equal(final.state, 'cancelled');
  assert.deepEqual(
    final.segments.map(part => part.state),
    ['confirmed', 'cancelled'],
  );
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.syntheses, 1);
  await f.box.run(f.request);
  assert.equal(f.state.sends.length, 1);
});
test('construction and receipt recovery do not read missing or malformed model configuration', async t => {
  const f = fixture(t);
  f.transport.sendSegment = async () => ({ recordingPossible: true });
  await f.box.run(f.request);
  const folder = path.join(f.root, 'state/dania-voice');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'config.json'), '{ malformed fixture');
  const restored = new NativeVoiceOutbox({ root: f.root, transport: f.transport, authorizeScope: () => false });
  assert.equal((await restored.query(f.request)).state, 'sending');
  assert.equal(await restored.query({ ...f.request, deliveryId: hex('b') }), null);
  assert.equal(f.state.syntheses, 1);
  assert.equal(f.state.queries.length, 1);
  assert.equal(fs.readFileSync(path.join(folder, 'config.json'), 'utf8'), '{ malformed fixture');
});
