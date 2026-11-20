import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertVoiceRecoveryIdle, inspectVoiceOperatorRecovery, recoverVoiceOperatorRecovery } from './voice-operator-recovery.mjs';

const accountScopeHash = 'a'.repeat(64), id = 'b'.repeat(64), audioSha256 = 'c'.repeat(64);
const lease = '12345678-1234-1234-1234-123456789012';
function fixture(t, production = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-operator-recovery-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const put = (relative, value) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const folder = production ? 'state/native-voice-attempts' : 'state/voice-preview/timed';
  const native = { version: 1, id, audioSha256, accountScopeHash, lease, processId: 987654, ...(production ? { targetSha256: 'd'.repeat(64) } : {}) };
  const nativeAttempt = { version: 1, id, audioSha256, accountScopeHash, state: 'uncertain', result: { recordingPossible: true, submitAttempted: true }, ...(production ? { targetSha256: 'd'.repeat(64) } : {}) };
  put(folder + '/active.json', native); put(folder + '/' + id + '.json', nativeAttempt);
  const preview = { version: 1, deliveryId: id, audioSha256, accountScopeHash };
  if (!production) { put('state/ui-voice-submit-previews/active.json', preview); put('state/ui-voice-submit-previews/' + id + '.json', { ...preview, state: 'unknown', stopBarrier: true, nativeStopBarrier: true, recordingPossible: true, privateField: 'fixture-only-ledger-value' }); }
  const options = { root, accountScopeHash, assertStopped: async () => true };
  const confirmations = { acknowledgeRecordingEnded: true, acknowledgeMessageOutcomeReviewed: true };
  return { root, folder, native, preview, options, confirmations, put, read: relative => JSON.parse(fs.readFileSync(path.join(root, relative))), exists: relative => fs.existsSync(path.join(root, relative)),
    previewRecovery: overrides => inspectVoiceOperatorRecovery({ ...options, ...overrides }),
    recover: async overrides => { const snapshot = await inspectVoiceOperatorRecovery(options); return recoverVoiceOperatorRecovery({ ...options, ...confirmations, expectedRevision: snapshot.revision, ...overrides }); } };
}

test('explicit local recovery preserves original ledgers and releases only exact owned recording barriers', async t => {
  const f = fixture(t), originalNative = fs.readFileSync(path.join(f.root, f.folder, id + '.json')), originalPreview = fs.readFileSync(path.join(f.root, 'state/ui-voice-submit-previews', id + '.json'));
  const before = await f.previewRecovery(); assert.equal(before.required, true); assert.equal(before.attemptCount, 2);
  assert.equal(JSON.stringify(before).includes(id), false); assert.equal(JSON.stringify(before).includes(accountScopeHash), false);
  const result = await f.recover();
  assert.equal(result.originalIdsReplayable, false); assert.equal(result.deliveryConfirmed, false); assert.equal(result.unknownMessagesPreserved, true); assert.equal(result.servicesStarted, false); assert.equal(result.inputSent, false);
  assert.equal(f.exists(f.folder + '/active.json'), false); assert.equal(f.exists('state/ui-voice-submit-previews/active.json'), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.folder, id + '.json')), originalNative); assert.deepEqual(fs.readFileSync(path.join(f.root, 'state/ui-voice-submit-previews', id + '.json')), originalPreview);
  assert.deepEqual(f.read(f.folder + '/operator-recovered-' + id + '.json'), f.native); assert.deepEqual(f.read('state/ui-voice-submit-previews/operator-recovered-' + id + '.json'), f.preview);
  const audit = f.read('state/voice-operator-recovery/audits/' + result.recoveryId + '/completed.json'); assert.equal(audit.attemptLedgersChanged, false); assert.equal(audit.deliveryConfirmed, false);
  assert.equal((await f.previewRecovery()).required, false); assert.doesNotThrow(() => assertVoiceRecoveryIdle(f.root));
  assert.equal(f.exists('state/ui-service.lock'), false); assert.equal(f.exists('state/ui-bridge/controls.lock'), false);
});
test('production attempt recovery retains target and does not rewrite transport or outbox delivery state', async t => {
  const f = fixture(t, true); const unrelated = 'state/native-voice-transport/' + id + '.json'; f.put(unrelated, { state: 'unknown', id });
  const result = await f.recover(); assert.equal(result.attemptCount, 1); assert.equal(f.read(unrelated).state, 'unknown'); assert.equal(f.read(f.folder + '/' + id + '.json').state, 'uncertain');
  assert.equal(f.read(f.folder + '/operator-recovered-' + id + '.json').targetSha256, 'd'.repeat(64));
});

function cancelledPreview(f, readerSessionStopped = false) {
  return { ...f.preview, state:'cancelled', target:'filehelper', accountRefHash:'d'.repeat(64), accountHash:'e'.repeat(64), accountDirectoryHash:'f'.repeat(64),
    stopBarrier:true, nativeStopBarrier:false, recordingPossible:false, readerSessionStarted:true, readerSessionStopped, submittedAt:1000, deadlineAt:31000,
    nativeReason:'DRAFT_HUMAN_ACTIVITY_CHANGED', cancelledRecording:{ reason:'DRAFT_HUMAN_ACTIVITY_CHANGED', ok:false, recordingAttempted:true, captureSessionBound:true,
      submitAttempted:false, submitInputApplied:false, cancelAttempted:true, cancelInputApplied:true, recordingEndedObserved:true, recordingPossible:false, stopBarrier:false, systemSettingsChanged:false } };
}

test('cancelled preview with unfinished Reader cleanup supports explicit recovery without rewriting or replaying its old attempt', async t => {
  for (const readerSessionStopped of [false, true]) {
    const f=fixture(t), relative='state/ui-voice-submit-previews/'+id+'.json';
    f.put(relative,cancelledPreview(f,readerSessionStopped)); const original=fs.readFileSync(path.join(f.root,relative));
    const before=await f.previewRecovery(); assert.equal(before.required,true); assert.equal(before.attemptCount,2);
    await assert.rejects(f.previewRecovery({assertStopped:async()=>false}),{code:'VOICE_RECOVERY_STOP_SERVICES'});
    const result=await f.recover(); assert.equal(result.recovered,true); assert.equal(result.deliveryConfirmed,false); assert.equal(result.originalIdsReplayable,false);
    assert.deepEqual(fs.readFileSync(path.join(f.root,relative)),original); assert.equal(f.exists('state/ui-voice-submit-previews/active.json'),false);
    assert.deepEqual(f.read('state/ui-voice-submit-previews/operator-recovered-'+id+'.json'),f.preview);
  }
});

test('cancelled preview recovery rejects incomplete cancellation facts, altered identity and submission ambiguity', async t => {
  const mutations=[...Object.keys(cancelledPreview({preview:{}}).cancelledRecording).map(key=>value=>{delete value.cancelledRecording[key];}),
    value=>value.cancelledRecording.submitAttempted=true,value=>value.cancelledRecording.extra=true,value=>value.nativeReason='VOICE_OTHER',
    value=>value.target='other',value=>delete value.accountHash,value=>value.nativeStopBarrier=true,value=>value.recordingPossible=true,
    value=>delete value.readerSessionStopped,value=>value.readerSessionStarted=false,value=>value.receipt={},value=>delete value.submittedAt,value=>value.deadlineAt=400000];
  for(const mutate of mutations){
    const f=fixture(t),relative='state/ui-voice-submit-previews/'+id+'.json',row=cancelledPreview(f); mutate(row); f.put(relative,row);
    await assert.rejects(f.previewRecovery(),{code:'VOICE_RECOVERY_BINDING_INVALID'});
    assert.equal(f.exists('state/ui-voice-submit-previews/active.json'),true); assert.equal(f.exists('state/voice-operator-recovery/transaction.json'),false);
  }
});
test('both operator acknowledgements and exact preview revision are mandatory', async t => {
  for (const change of [{ acknowledgeRecordingEnded: false }, { acknowledgeMessageOutcomeReviewed: false }, { expectedRevision: '0'.repeat(64) }]) {
    const f = fixture(t); await assert.rejects(f.recover(change)); assert.equal(f.exists(f.folder + '/active.json'), true); assert.equal(f.exists('state/voice-operator-recovery/transaction.json'), false);
  }
});
test('fresh account and helper quiescence are required, including after the local service lease is acquired', async t => {
  const f = fixture(t); await assert.rejects(f.previewRecovery({ assertStopped: undefined }), { code: 'VOICE_RECOVERY_CONFIG_INVALID' });
  await assert.rejects(f.previewRecovery({ assertStopped: async () => false }), { code: 'VOICE_RECOVERY_STOP_SERVICES' });
  await assert.rejects(f.previewRecovery({ accountScopeHash: 'f'.repeat(64) }), { code: 'VOICE_RECOVERY_BINDING_INVALID' });
  const before = await f.previewRecovery(); let calls = 0;
  await assert.rejects(recoverVoiceOperatorRecovery({ ...f.options, ...f.confirmations, expectedRevision: before.revision, assertStopped: async () => ++calls < 2 }), { code: 'VOICE_RECOVERY_STOP_SERVICES' });
  assert.equal(f.exists(f.folder + '/active.json'), true); assert.equal(f.exists('state/ui-service.lock'), false);
});
test('runtime and worker or foreign controls/service locks prevent recovery and remain untouched', async t => {
  for (const relative of ['state/ui-service.lock','state/ui-bridge/controls.lock','state/reader-service/service.lock','state/native-voice-outbox/worker.lock','state/ui-voice-submit-previews/worker.lock']) {
    const f = fixture(t); f.put(relative, { pid: 1, owner: 'foreign' }); await assert.rejects(f.previewRecovery(), { code: 'VOICE_RECOVERY_STOP_SERVICES' }); assert.equal(f.read(relative).owner, 'foreign');
  }
  const f = fixture(t); f.put('state/runtime.json', { adapter: { pid: 123 } }); await assert.rejects(f.previewRecovery(), { code: 'VOICE_RECOVERY_STOP_SERVICES' });
});
test('malformed or conflicting id audio account lease target and missing attempts fail closed', async t => {
  for (const kind of ['id','audio','account','lease','missing','extra','pair']) {
    const f = fixture(t); const a = f.read(f.folder + '/active.json');
    if (kind === 'id') a.id = '../escape'; if (kind === 'audio') a.audioSha256 = 'e'.repeat(64); if (kind === 'account') a.accountScopeHash = 'e'.repeat(64); if (kind === 'lease') a.lease = 'bad'; if (kind === 'extra') a.extra = true;
    f.put(f.folder + '/active.json', a); if (kind === 'missing') fs.unlinkSync(path.join(f.root, f.folder, id + '.json'));
    if (kind === 'pair') { const p = { ...f.preview, deliveryId: 'e'.repeat(64) }; f.put('state/ui-voice-submit-previews/active.json', p); f.put('state/ui-voice-submit-previews/' + p.deliveryId + '.json', { ...p, state: 'unknown' }); }
    await assert.rejects(f.previewRecovery()); assert.equal(f.exists(f.folder + '/active.json'), true);
  }
});
test('byte CAS detects a changed attempt or active barrier before any recovery mutation', async t => {
  for (const name of ['active.json', id + '.json']) {
    const f = fixture(t), before = await f.previewRecovery(), file = path.join(f.root, f.folder, name); fs.appendFileSync(file, '\n');
    await assert.rejects(recoverVoiceOperatorRecovery({ ...f.options, ...f.confirmations, expectedRevision: before.revision }), { code: 'VOICE_RECOVERY_VERSION_CONFLICT' });
    assert.equal(f.exists(f.folder + '/active.json'), true); assert.equal(f.exists('state/voice-operator-recovery/transaction.json'), false);
  }
});
test('partial recovery remains blocked by a durable journal and resumes only the same immutable attempt set', async t => {
  const f = fixture(t), before = await f.previewRecovery(); let interrupted = false;
  await assert.rejects(recoverVoiceOperatorRecovery({ ...f.options, ...f.confirmations, expectedRevision: before.revision, assertStopped: async () => {
    if (!f.exists(f.folder + '/active.json')) { interrupted = true; return false; } return true;
  } }), { code: 'VOICE_RECOVERY_STOP_SERVICES' });
  assert.equal(interrupted, true); assert.equal(f.exists('state/voice-operator-recovery/transaction.json'), true); assert.equal(f.exists('state/ui-voice-submit-previews/active.json'), true);
  assert.throws(() => assertVoiceRecoveryIdle(f.root), { code: 'VOICE_OPERATOR_RECOVERY_REQUIRED' });
  const next = await f.previewRecovery(); assert.equal(next.interruptedRecovery, true); assert.notEqual(next.revision, before.revision);
  const result = await recoverVoiceOperatorRecovery({ ...f.options, ...f.confirmations, expectedRevision: next.revision }); assert.equal(result.recovered, true); assert.equal(f.exists('state/voice-operator-recovery/transaction.json'), false);
  assert.equal(f.read(f.folder + '/' + id + '.json').state, 'uncertain');
});
test('changed attempt or replaced barrier during interrupted recovery cannot be blessed by a new preview', async t => {
  const f = fixture(t); await assert.rejects(f.recover({ assertStopped: async () => f.exists(f.folder + '/active.json') }));
  f.put(f.folder + '/active.json', { ...f.native, lease: crypto.randomUUID() });
  await assert.rejects(f.previewRecovery(), { code: 'VOICE_RECOVERY_VERSION_CONFLICT' }); assert.equal(f.exists('state/voice-operator-recovery/transaction.json'), true);
});
test('an unrelated new barrier cannot be hidden behind a pending recovery journal', async t => {
  const f = fixture(t); await assert.rejects(f.recover({ assertStopped: async () => f.exists(f.folder + '/active.json') }));
  f.put('state/native-voice-attempts/active.json', { ...f.native, targetSha256: 'd'.repeat(64) });
  await assert.rejects(f.previewRecovery(), { code: 'VOICE_RECOVERY_VERSION_CONFLICT' });
});
test('a resumable journal must retain semantic id lease and attempt binding even when its stored hashes are self-consistent', async t => {
  for (const change of ['entry-id','lease','attempt-id']) {
    const f = fixture(t); await assert.rejects(f.recover({ assertStopped: async () => f.exists(f.folder + '/active.json') }));
    const journalFile = 'state/voice-operator-recovery/transaction.json', journal = f.read(journalFile), e = journal.entries[0];
    if (change === 'entry-id') e.id = 'e'.repeat(64);
    if (change === 'lease') e.active.lease = 'invalid';
    if (change === 'attempt-id') {
      const backup = 'state/voice-operator-recovery/audits/' + journal.recoveryId + '/0-attempt.json', altered = f.read(backup); altered.id = 'e'.repeat(64); f.put(backup, altered);
      e.attemptSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root, backup))).digest('hex');
    }
    f.put(journalFile, journal); await assert.rejects(f.previewRecovery()); assert.equal(f.exists('state/ui-voice-submit-previews/active.json'), true);
  }
});
test('simultaneous recovery is exclusive and does not erase the first owner lock', async t => {
  const f = fixture(t), before = await f.previewRecovery(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; }); let calls = 0;
  const first = recoverVoiceOperatorRecovery({ ...f.options, ...f.confirmations, expectedRevision: before.revision, assertStopped: async () => { if (++calls === 1) { entered(); await hold; } return true; } });
  await ready; await assert.rejects(recoverVoiceOperatorRecovery({ ...f.options, ...f.confirmations, expectedRevision: before.revision }), { code: 'VOICE_RECOVERY_BUSY' });
  assert.equal(f.exists('state/voice-operator-recovery/lock'), true); release(); assert.equal((await first).recovered, true);
});
test('pending journal and recovery lock prohibit a new recording without touching its state', t => {
  for (const name of ['lock','transaction.json']) { const f = fixture(t); f.put('state/voice-operator-recovery/' + name, { fixture: true }); assert.throws(() => assertVoiceRecoveryIdle(f.root), { code: 'VOICE_OPERATOR_RECOVERY_REQUIRED' }); assert.equal(f.exists(f.folder + '/active.json'), true); }
});
test('linked paths and malformed journals never allow cleanup outside the project', async t => {
  const f = fixture(t); f.put('state/voice-operator-recovery/transaction.json', { version: 1, recoveryId: '../escape' }); await assert.rejects(f.previewRecovery());
  const g = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-recovery-outside-')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(g.root, 'state/voice-operator-recovery'), { recursive: true }); fs.symlinkSync(outside, path.join(g.root, 'state/voice-operator-recovery/audits'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(g.recover(), { code: 'VOICE_RECOVERY_LINK_REJECTED' }); assert.deepEqual(fs.readdirSync(outside), []);
});
