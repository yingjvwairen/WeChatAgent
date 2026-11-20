import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runVoiceSubmitPreview, validateVoiceSubmitPreview, isFinishedCancelledVoicePreview } from './ui-voice-preview-submit.mjs';
import {voiceInterruptionFacts,validVoiceInterruptionFacts} from './voice-interruption-evidence.mjs';
import { UiVoiceReaderReceipts } from './ui-voice-reader-receipts.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const focusHandoff = () => ({version:1,returnWindow:{hwnd:'200',pid:99,processCreatedFileTimeUtc:'456'}});
const handoffReport = () => ({version:1,initialReturnAttempted:true,initialReturnConfirmed:true,backgroundEntered:true,backgroundActivityObserved:true,
  submitActivationAttempted:true,submitActivationConfirmed:true,finalReturnAttempted:true,finalReturnConfirmed:true,returnSkippedForHumanInput:false,
  initialForegroundElapsedMs:400,backgroundElapsedMs:5200,submitForegroundElapsedMs:300});
function wave(seconds = 5) {
  const size = Math.round(16000 * seconds) * 2, data = Buffer.alloc(44 + size);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(size, 40); return data;
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-submit-preview-fixture-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^voice-submit-preview-fixture-/); fs.rmSync(directory, { recursive: true, force: true }); });
  let at = 1800000000000;
  const controller = new AbortController(), calls = [], counts = { native: 0, prepare: 0, query: 0 };
  const options = { root: directory, directory, deliveryId: '1'.repeat(64), accountWxid: 'fixture-self', accountDirectory: 'fixture-account', accountRef: '2'.repeat(64), accountScopeHash: '3'.repeat(64), target: 'filehelper',
    audio: wave(), renderId: 'fixture-render', captureId: 'fixture-capture', minDurationMs: 4500, maxDurationMs: 8000,
    permission: { sendVoicePreview: true, target: 'filehelper', recordPreview: true, playAudio: true, submitPreview: true, cancelOwnedRecording: true }, freshSession: async () => { calls.push('fresh'); return fresh(); } };
  options.permission.audioSha256 = hash(options.audio);
  const fresh = () => ({ session: { version: 1, id: 'a'.repeat(32), calibrationHash: 'b'.repeat(64), accountScopeHash: options.accountScopeHash, target: 'filehelper', executable: 'C:\\fixture\\Weixin.exe',
    hwnd: '100', focusHwnd: '100', processCreatedFileTimeUtc: '12345', pid: 42, dpi: 96, lastInputTick: 10, issuedAtMs: at, expiresAtMs: at + 29000,
    clientRect: { left: 0, top: 0, right: 800, bottom: 600 }, captureRect: { left: 100, top: 100, right: 900, bottom: 700 }, editorRect: { left: 100, top: 400, right: 700, bottom: 590 },
    editorFocusProof: { kind: 'operator-calibrated-edit-region', calibrationHash: 'b'.repeat(64), lastInputTick: 10 }, emptyDraftConfirmed: true,
    mouseParkRect: { left: 700, top: 60, right: 720, bottom: 80 },
    recordStartRect: { left: 710, top: 400, right: 750, bottom: 440 }, recordingUi: { focusHwnd: '100', cancel: { rect: { left: 150, top: 450, right: 180, bottom: 480 }, rgbaSha256: 'd'.repeat(64) }, submit: { rect: { left: 600, top: 450, right: 630, bottom: 480 }, rgbaSha256: 'e'.repeat(64) } } },
    accountProof: { accountRef: options.accountRef, accountScopeHash: options.accountScopeHash, evidence: { ok: true, proof: 'process-open-database-v1', complete: true, processOpenedExpectedDatabase: true,
      accountRootsObserved: 1, consistentPathScans: 2, snapshotAtomic: false, processId: 42, processCreatedFileTimeUtc: '12345', observedAtUtc: new Date(at).toISOString(), maximumEvidenceAgeMs: 500,
      ready: false, desktopAccountVerified: false, targetVerified: false, draftVerified: false, inputSent: false } } });
  const context = () => ({ accountWxid: options.accountWxid, accountDirectory: options.accountDirectory, accountRef: options.accountRef, baseUrl: 'http://127.0.0.1:1234', token: 'PRIVATE-TOKEN', signal: controller.signal, expiresAt: at + 24750 });
  const receipt = job => ({ type: 'wechat-database-voice-v1', deliveryId: job.id, account: job.account, accountDirectory: options.accountDirectory, target: job.target,
    sourceShard: 'c'.repeat(64), localId: '42', serverId: '1234567890123456789', createTime: Math.floor(at / 1000), durationMs: 6000, observedAt: at,
    nativeVoiceRowConfirmed: true, audioContentVerified: false, timbreVerified: false });
  const receipts = { checkBinding: async () => { calls.push('binding'); return { verified: true, account: options.accountWxid, accountDirectory: options.accountDirectory }; },
    prepare: async () => { calls.push('prepare'); counts.prepare++; return { submissionAllowed: true }; },
    query: async job => { calls.push('query'); counts.query++; return { confirmed: true, receipt: receipt(job) }; } };
  const dependencies = { now: () => at, wait: async ms => { at += ms; }, withLocalReceiptApi: async ({ callback, timeoutMs, expectedAccountRef }) => {
    assert.equal(timeoutMs, 30000); assert.equal(expectedAccountRef, options.accountRef); await callback(context()); return { processStopped: true };
  }, receiptsFactory: () => receipts, runTimedVoicePreview: async request => {
    calls.push('native'); counts.native++;
    const state = JSON.parse(fs.readFileSync(path.join(directory, options.deliveryId + '.json'), 'utf8'));
    assert.equal(state.state, 'voice-intent'); assert.equal(state.stopBarrier, true);
    assert.equal(request.id, options.deliveryId); assert.equal(hash(request.audio), options.permission.audioSha256); assert.equal(request.permission.submitPreview, true);
    at += 6500; return { recordingAttempted: true, recordingPossible: false, stopBarrier: false, submitAttempted: true, submitInputApplied: true, reason: null };
  } };
  return { options, dependencies, counts, calls, receipts, receipt, context, fresh, controller, advance: ms => { at += ms; },
    stored: () => JSON.parse(fs.readFileSync(path.join(directory, options.deliveryId + '.json'), 'utf8')), barrier: () => fs.existsSync(path.join(directory, 'active.json')) };
}
const cancelledNative=()=>({ok:false,reason:'DRAFT_HUMAN_ACTIVITY_CHANGED',recordingAttempted:true,captureSessionBound:true,submitAttempted:false,submitInputApplied:false,cancelAttempted:true,cancelInputApplied:true,recordingEndedObserved:true,recordingPossible:false,stopBarrier:false,systemSettingsChanged:false});

test('fully cancelled owned recording becomes terminal without querying a coincidental receipt or replaying the old ID',async t=>{
  for(const reason of ['DRAFT_HUMAN_ACTIVITY_CHANGED','VOICE_BACKGROUND_WECHAT_ACTIVATED']){
    const f=fixture(t);f.dependencies.runTimedVoicePreview=async()=>{f.counts.native++;return{...cancelledNative(),reason};};
    const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.state,'cancelled');assert.equal(result.confirmed,false);assert.equal(result.stopBarrier,false);assert.equal(result.readerSessionStopped,true);assert.equal(result.receipt,undefined);assert.equal(f.barrier(),false);assert.equal(f.counts.query,0);
    const saved=f.stored();assert.equal(isFinishedCancelledVoicePreview(saved),true);assert.equal(saved.cancelledRecording.reason,reason);assert.equal(saved.submittedAt>0,true);assert.equal(saved.deadlineAt>saved.submittedAt,true);assert.equal(saved.accountHash,hash(f.options.accountWxid));
    const before=fs.readFileSync(path.join(f.options.directory,f.options.deliveryId+'.json'));f.dependencies.withLocalReceiptApi=async()=>{throw Error('terminal cancelled ID must not start Reader');};
    const again=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(again.reused,true);assert.equal(again.state,'cancelled');assert.equal(f.counts.native,1);assert.equal(f.counts.query,0);assert.deepEqual(fs.readFileSync(path.join(f.options.directory,f.options.deliveryId+'.json')),before);
  }
});
test('only a new delivery ID may record after a fully cancelled preview',async t=>{
  const f=fixture(t),original=f.options.deliveryId;f.dependencies.runTimedVoicePreview=async()=>{f.counts.native++;return cancelledNative();};
  await runVoiceSubmitPreview(f.options,f.dependencies);f.options.deliveryId='4'.repeat(64);const next=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(next.reused,false);assert.equal(f.counts.native,2);assert.equal(f.counts.prepare,2);assert.equal(f.counts.query,0);
  f.options.deliveryId=original;assert.equal((await runVoiceSubmitPreview(f.options,f.dependencies)).reused,true);assert.equal(f.counts.native,2);
});
test('cancellation intent, partial native facts and any submission uncertainty cannot become cancelled',async t=>{
  for(const mutate of [...Object.keys(cancelledNative()).map(key=>value=>{delete value[key];}),value=>{value.submitAttempted=true;},value=>{value.submitInputApplied=true;},value=>{value.cancelInputApplied=false;},value=>{value.recordingPossible=true;},value=>{value.stopBarrier=true;},value=>{value.reason='VOICE_PARENT_CLOSED';}]){
    const f=fixture(t),native=cancelledNative();mutate(native);f.dependencies.runTimedVoicePreview=async()=>{f.counts.native++;return native;};f.receipts.query=async()=>{f.counts.query++;return{confirmed:false};};
    const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.state,'unknown');assert.equal(result.cancelledRecording,undefined);assert.equal(result.stopBarrier,true);assert.equal(f.barrier(),true);
  }
});
test('cancelled preview requires observed Reader stop before releasing its barrier and never retries cleanup by opening another Reader',async t=>{
  const f=fixture(t);let apiCalls=0;f.dependencies.runTimedVoicePreview=async()=>{f.counts.native++;return cancelledNative();};
  f.dependencies.withLocalReceiptApi=async({callback})=>{apiCalls++;await callback(f.context());return{processStopped:false};};
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.state,'cancelled');assert.equal(result.cleanupUnknown,true);assert.equal(result.stopBarrier,true);assert.equal(f.barrier(),true);assert.equal(isFinishedCancelledVoicePreview(f.stored()),false);
  assert.equal((await runVoiceSubmitPreview(f.options,f.dependencies)).state,'cancelled');assert.equal(apiCalls,1);assert.equal(f.counts.native,1);assert.equal(f.counts.query,0);
  await assert.rejects(runVoiceSubmitPreview({...f.options,deliveryId:'4'.repeat(64)},f.dependencies),{code:'UI_VOICE_PREVIEW_RECOVERY_REQUIRED'});
});
test('crash after cancelled Reader shutdown may finish only the exact original barrier cleanup',async t=>{
  const f=fixture(t);f.dependencies.runTimedVoicePreview=async()=>{f.counts.native++;return cancelledNative();};await runVoiceSubmitPreview(f.options,f.dependencies);
  const file=path.join(f.options.directory,f.options.deliveryId+'.json'),row=f.stored();row.stopBarrier=true;fs.writeFileSync(file,JSON.stringify(row));fs.writeFileSync(path.join(f.options.directory,'active.json'),JSON.stringify({version:1,deliveryId:row.deliveryId,audioSha256:row.audioSha256,accountScopeHash:row.accountScopeHash}));
  f.dependencies.withLocalReceiptApi=async()=>{throw Error('cleanup must not start Reader');};const again=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(again.state,'cancelled');assert.equal(again.stopBarrier,false);assert.equal(f.barrier(),false);assert.equal(f.counts.native,1);assert.equal(f.counts.query,0);
});
test('saved cancellation facts are exact and cannot clear unknown or altered ownership records',async t=>{
  const f=fixture(t);f.dependencies.runTimedVoicePreview=async()=>cancelledNative();await runVoiceSubmitPreview(f.options,f.dependencies);const saved=f.stored(),file=path.join(f.options.directory,f.options.deliveryId+'.json');
  for(const mutate of [v=>delete v.cancelledRecording,v=>v.cancelledRecording.submitAttempted=true,v=>v.cancelledRecording.extra='private',v=>v.nativeReason='VOICE_OTHER',v=>v.recordingPossible=true,v=>v.nativeStopBarrier=true,v=>v.readerSessionStarted=false,v=>delete v.submittedAt,v=>v.receipt={},v=>v.state='unknown']){
    const changed=structuredClone(saved);mutate(changed);fs.writeFileSync(file,JSON.stringify(changed));assert.equal(isFinishedCancelledVoicePreview(changed),false);await assert.rejects(runVoiceSubmitPreview(f.options,f.dependencies),{code:'UI_VOICE_PREVIEW_STATE_INVALID'});
  }
  for(const key of ['deliveryId','audioSha256','accountScopeHash','accountRefHash','accountHash','accountDirectoryHash']){const changed=structuredClone(saved);changed[key]='invalid';assert.equal(isFinishedCancelledVoicePreview(changed),false);}
  const unknown={...saved,state:'unknown',stopBarrier:true};delete unknown.cancelledRecording;fs.writeFileSync(file,JSON.stringify(unknown));f.receipts.query=async()=>({confirmed:false});const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.state,'unknown');assert.equal(result.cancelledRecording,undefined);assert.equal(result.stopBarrier,true);
});
test('anonymous cancellation facts and separate cancel interval survive without claiming a successful send or inventing voice identity',async t=>{
  const f=fixture(t);f.options.freshSession=async()=>({...f.fresh(),focusHandoff:focusHandoff()});const raw={...cancelledNative(),private:'never persisted'};
  assert.equal(validVoiceInterruptionFacts(voiceInterruptionFacts(raw)),true);assert.equal(validVoiceInterruptionFacts(raw),false);assert.equal(Object.hasOwn(voiceInterruptionFacts(raw),'voiceId'),false);
  const intervals=[{phase:'record-start',durationMs:450,includesContactNavigation:false,complete:true},{phase:'record-cancel',durationMs:250,includesContactNavigation:false,complete:true}];
  f.dependencies.runTimedVoicePreview=async()=>({...raw,focusHandoff:{...handoffReport(),foregroundIntervals:intervals}});
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.deepEqual(result.focusHandoff.foregroundIntervals,intervals);assert.deepEqual(result.foregroundTiming.intervals,intervals);assert.equal(result.foregroundTiming.complete,false);assert.equal(result.foregroundTiming.maxContinuousForegroundMs,null);assert.equal(result.confirmed,false);assert.equal(JSON.stringify(f.stored()).includes('never persisted'),false);
});

test('baseline and intent precede native recording, raw server ID and duration receipt alone confirm', async t => {
  const f = fixture(t), original = Buffer.from(f.options.audio);
  const result = await runVoiceSubmitPreview(f.options, f.dependencies);
  assert.deepEqual(f.calls, ['binding', 'prepare', 'fresh', 'native', 'query']); assert.equal(result.confirmed, true);
  assert.equal(result.receipt.serverId, '1234567890123456789'); assert.equal(result.receipt.durationMs, 6000);
  assert.equal(result.audioContentVerified, false); assert.equal(result.timbreVerified, false); assert.equal(result.ready, false);
  assert.equal(result.stopBarrier, false); assert.equal(f.barrier(), false); assert.equal(result.readerSessionStopped, true);
  assert.deepEqual(f.options.audio, original);
  const saved = JSON.stringify(f.stored()); assert.equal(saved.includes('PRIVATE-TOKEN'), false); assert.equal(saved.includes(f.options.renderId), false); assert.equal(saved.includes(original.toString('base64')), false);
  assert.equal((await runVoiceSubmitPreview(f.options, f.dependencies)).reused, true); assert.equal(f.counts.native, 1); assert.equal(f.counts.prepare, 1);
});

test('operator recovery in progress blocks a new preview before receipt preparation or recording', async t => {
  for (const name of ['lock','transaction.json']) {
    const f = fixture(t), folder = path.join(f.options.root, 'state/voice-operator-recovery'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, name), '{}');
    await assert.rejects(runVoiceSubmitPreview(f.options, f.dependencies), { code: 'VOICE_OPERATOR_RECOVERY_REQUIRED' });
    assert.equal(f.counts.native, 0); assert.equal(f.counts.prepare, 0); assert.equal(f.barrier(), false); assert.equal(fs.existsSync(path.join(f.options.directory, 'worker.lock')), false);
  }
});
test('an operator-reviewed old preview keeps its exact unknown ledger and never recreates a barrier or records again', async t => {
  const f = fixture(t); f.dependencies.runTimedVoicePreview = async () => { f.counts.native++; return { recordingAttempted: true, recordingPossible: true, stopBarrier: true, submitAttempted: true, submitInputApplied: true }; };
  f.receipts.query = async () => { f.counts.query++; return { confirmed: false }; };
  const initial = await runVoiceSubmitPreview(f.options, f.dependencies); assert.equal(initial.state, 'unknown');
  const file = path.join(f.options.directory, f.options.deliveryId + '.json'), before = fs.readFileSync(file), nativeCalls = f.counts.native, queryCalls = f.counts.query;
  const barrier = JSON.parse(fs.readFileSync(path.join(f.options.directory, 'active.json')));
  fs.writeFileSync(path.join(f.options.directory, 'operator-recovered-' + f.options.deliveryId + '.json'), JSON.stringify(barrier)); fs.unlinkSync(path.join(f.options.directory, 'active.json'));
  const reused = await runVoiceSubmitPreview(f.options, f.dependencies); assert.equal(reused.reused, true); assert.equal(reused.state, 'unknown'); assert.equal(reused.confirmed, false);
  assert.equal(f.counts.native, nativeCalls); assert.equal(f.counts.query, queryCalls); assert.equal(f.barrier(), false); assert.deepEqual(fs.readFileSync(file), before);
});
test('an existing preview query cannot mutate its ledger concurrently with operator recovery', async t => {
  const f = fixture(t); await runVoiceSubmitPreview(f.options, f.dependencies);
  const file = path.join(f.options.directory, f.options.deliveryId + '.json'), before = fs.readFileSync(file), calls = { ...f.counts };
  const folder = path.join(f.options.root, 'state/voice-operator-recovery'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'lock'), '{}');
  await assert.rejects(runVoiceSubmitPreview(f.options, f.dependencies), { code: 'VOICE_OPERATOR_RECOVERY_REQUIRED' });
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(f.counts, calls); assert.equal(fs.existsSync(path.join(f.options.directory, 'worker.lock')), false);
});
test('adaptive diagnostics survive receipt confirmation and same-ID query without retrying input',async t=>{
  const f=fixture(t),native=f.dependencies.runTimedVoicePreview,diagnostic={requested:true,bound:true,cancelScore:.99,submitScore:1,elapsedMs:82,pixelGuardsFixed:true};
  f.dependencies.runTimedVoicePreview=async request=>({...await native(request),adaptiveRecordingUi:diagnostic});
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.confirmed,true);assert.deepEqual(result.adaptiveRecordingUi,diagnostic);
  assert.deepEqual((await runVoiceSubmitPreview(f.options,f.dependencies)).adaptiveRecordingUi,diagnostic);assert.equal(f.counts.native,1);
});

test('UIA diagnostics survive receipt confirmation and same-ID query without retrying input',async t=>{
  const f=fixture(t),native=f.dependencies.runTimedVoicePreview,diagnostic={version:1,requested:true,bound:true,stateChecks:7,conversationVerified:true,pixelsRead:false};
  f.dependencies.runTimedVoicePreview=async request=>({...await native(request),uiaRecordingUi:diagnostic});
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.confirmed,true);assert.deepEqual(result.uiaRecordingUi,diagnostic);
  assert.deepEqual((await runVoiceSubmitPreview(f.options,f.dependencies)).uiaRecordingUi,diagnostic);assert.equal(f.counts.native,1);
});

test('authenticated warm pre-execution refusal is durable without an uncertain recording barrier',async t=>{
  const f=fixture(t);f.options.freshSession=async()=>({...f.fresh(),focusHandoff:focusHandoff()});
  f.dependencies.runTimedVoicePreview=async()=>{f.counts.native++;throw Object.assign(new Error('DRAFT_UI_MUTEX_BUSY'),{code:'DRAFT_UI_MUTEX_BUSY',warmExecutionStarted:false,nativeStarted:false,recordingPossible:false,submitAttempted:false});};
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.state,'not-recorded');assert.equal(result.recordingPossible,false);assert.equal(result.stopBarrier,false);assert.equal(f.barrier(),false);assert.equal(f.counts.query,0);
  const repeated=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(repeated.reused,true);assert.equal(f.counts.native,1);
});

test('partial or uncertain warm rejection evidence cannot clear preview recording ownership',async t=>{
  for(const evidence of [{nativeStarted:false,recordingPossible:false,submitAttempted:false},{warmExecutionStarted:false,nativeStarted:false,recordingPossible:true,submitAttempted:false}]){
    const f=fixture(t);f.receipts.query=async()=>({confirmed:false});f.dependencies.runTimedVoicePreview=async()=>{throw Object.assign(new Error('VOICE_PIPE_FAILED'),{code:'VOICE_PIPE_FAILED',...evidence});};
    const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.state,'unknown');assert.equal(result.stopBarrier,true);assert.equal(f.barrier(),true);
  }
});

test('preview retains only complete boolean pointer-return diagnostics, including safe skipped restoration',async t=>{
  const f=fixture(t),native=f.dependencies.runTimedVoicePreview,diagnostic={...handoffReport(),initialPointerRestored:true,finalPointerRestored:false,pointerRestoreSkipped:true};
  f.options.freshSession=async()=>({...f.fresh(),focusHandoff:focusHandoff()});
  f.dependencies.runTimedVoicePreview=async request=>({...await native(request),focusHandoff:{...diagnostic,pointerX:300,pointerY:200}});
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.confirmed,true);assert.deepEqual(result.focusHandoff,diagnostic);assert.equal(JSON.stringify(f.stored()).includes('pointerX'),false);
  for(const extra of [{initialPointerRestored:true},{initialPointerRestored:true,finalPointerRestored:'false',pointerRestoreSkipped:true}]){
    const bad=fixture(t),run=bad.dependencies.runTimedVoicePreview;bad.options.freshSession=async()=>({...bad.fresh(),focusHandoff:focusHandoff()});
    bad.dependencies.runTimedVoicePreview=async request=>({...await run(request),focusHandoff:{...handoffReport(),...extra}});
    assert.equal((await runVoiceSubmitPreview(bad.options,bad.dependencies)).reason,'UI_VOICE_PREVIEW_NATIVE_REPORT_INVALID');
  }
});

test('fresh handoff reaches the native preview and only anonymous timing survives reports and replay',async t=>{
  const f=fixture(t),handoff=focusHandoff(),diagnostic=handoffReport();
  handoff.activation={rect:{left:200,top:8,right:320,bottom:32},rgbaSha256:'9'.repeat(64)};
  f.options.freshSession=async()=>({...f.fresh(),focusHandoff:handoff});
  const run=f.dependencies.runTimedVoicePreview;
  f.dependencies.runTimedVoicePreview=async request=>{
    assert.deepEqual(request.focusHandoff,handoff);assert.notEqual(request.focusHandoff,handoff);assert.notEqual(request.focusHandoff.returnWindow,handoff.returnWindow);
    assert.notEqual(request.focusHandoff.activation,handoff.activation);assert.notEqual(request.focusHandoff.activation.rect,handoff.activation.rect);
    const result=await run(request);
    return {...result,focusHandoff:{...diagnostic,returnWindow:handoff.returnWindow,activation:handoff.activation,privatePayload:'HANDOFF_PRIVATE'},
      sourceDurationMs:5000,playbackElapsedMs:5000,recordingElapsedMs:5900,
      timelineMs:{recordStart:1000,captureReady:1200,playStart:1201,playDrained:6201,submit:6500,recordEnded:6900,privatePayload:'TIMING_PRIVATE'}};
  };
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.confirmed,true);assert.deepEqual(result.focusHandoff,diagnostic);
  assert.deepEqual(result.nativeTiming,{sourceDurationMs:5000,playbackElapsedMs:5000,recordingElapsedMs:5900,
    timelineMs:{recordStart:1000,captureReady:1200,playStart:1201,playDrained:6201,submit:6500,recordEnded:6900}});
  for(const saved of [JSON.stringify(result),JSON.stringify(f.stored())])for(const privateValue of ['HANDOFF_PRIVATE','TIMING_PRIVATE','returnWindow','hwnd','processCreatedFileTimeUtc','activation','rgbaSha256','9'.repeat(64)])assert.equal(saved.includes(privateValue),false);
  result.focusHandoff.backgroundElapsedMs=9999;
  f.options.freshSession=async()=>{throw Error('existing id must not prepare or reacquire focus');};
  const repeated=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(repeated.reused,true);assert.deepEqual(repeated.focusHandoff,diagnostic);
  assert.equal(f.counts.native,1);assert.equal(f.counts.prepare,1);
});

test('ordinary foreground preview has no implicit handoff request or diagnostic',async t=>{
  const f=fixture(t),run=f.dependencies.runTimedVoicePreview;
  f.dependencies.runTimedVoicePreview=async request=>{assert.equal(Object.hasOwn(request,'focusHandoff'),false);return run(request);};
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(Object.hasOwn(result,'focusHandoff'),false);assert.equal(Object.hasOwn(result,'nativeTiming'),false);
});

test('malformed or same-WeChat return windows cannot reach native recording',async t=>{
  for(const focus of [null,{version:2,returnWindow:focusHandoff().returnWindow},
    {version:1,returnWindow:{...focusHandoff().returnWindow,pid:42}},
    {version:1,returnWindow:{...focusHandoff().returnWindow,hwnd:'100'}},
    {version:1,returnWindow:{...focusHandoff().returnWindow,processCreatedFileTimeUtc:'0'}},
    {...focusHandoff(),ignoreActivity:true},
    {...focusHandoff(),activation:{rect:{left:200,top:100,right:320,bottom:124},rgbaSha256:'9'.repeat(64)}},
    {...focusHandoff(),activation:{rect:{left:200,top:8,right:320,bottom:32},rgbaSha256:'9'.repeat(64),extra:true}}]){
    const f=fixture(t);f.options.freshSession=async()=>({...f.fresh(),focusHandoff:focus});
    const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.state,'not-recorded');assert.equal(result.reason,'VOICE_FOCUS_HANDOFF_INVALID');assert.equal(f.counts.native,0);
  }
});

test('missing, inconsistent or unbounded handoff reports retain an unknown result without receipt claims',async t=>{
  for(const change of [result=>{delete result.focusHandoff;},result=>{result.focusHandoff.initialReturnAttempted=false;},
    result=>{result.focusHandoff.backgroundElapsedMs=30001;},result=>{result.focusHandoff.finalReturnConfirmed='yes';},
    result=>{result.sourceDurationMs=5000;result.playbackElapsedMs=5000;result.recordingElapsedMs=-1;result.timelineMs={};}]){
    const f=fixture(t);f.options.freshSession=async()=>({...f.fresh(),focusHandoff:focusHandoff()});
    const run=f.dependencies.runTimedVoicePreview;f.dependencies.runTimedVoicePreview=async request=>{const result={...await run(request),focusHandoff:handoffReport()};change(result);return result;};
    const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.state,'unknown');assert.equal(result.reason,'UI_VOICE_PREVIEW_NATIVE_REPORT_INVALID');
    assert.equal(result.confirmed,false);assert.equal(result.stopBarrier,true);assert.equal(f.counts.query,0);assert.equal(f.counts.native,1);
  }
});

test('invalid saved handoff diagnostics fail closed on same-id recovery',async t=>{
  const f=fixture(t);f.options.freshSession=async()=>({...f.fresh(),focusHandoff:focusHandoff()});const run=f.dependencies.runTimedVoicePreview;
  f.dependencies.runTimedVoicePreview=async request=>({...await run(request),focusHandoff:handoffReport()});await runVoiceSubmitPreview(f.options,f.dependencies);
  const saved=f.stored();saved.focusHandoff.backgroundElapsedMs=-1;fs.writeFileSync(path.join(f.options.directory,f.options.deliveryId+'.json'),JSON.stringify(saved));
  await assert.rejects(runVoiceSubmitPreview(f.options,f.dependencies),{code:'UI_VOICE_PREVIEW_STATE_INVALID'});assert.equal(f.counts.native,1);
});

test('background UIA submission keeps honest focus facts through receipt confirmation and restart',async t=>{
  const f=fixture(t),run=f.dependencies.runTimedVoicePreview;
  const background={version:1,attempted:true,applied:true,confirmed:true,foregroundUnchanged:true};
  const diagnostic={...handoffReport(),submitActivationAttempted:false,submitActivationConfirmed:false,finalReturnAttempted:false,finalReturnConfirmed:false,submitForegroundElapsedMs:0,backgroundSubmit:background,
    foregroundIntervals:[{phase:'record-start',durationMs:400,includesContactNavigation:true,complete:true},{phase:'record-submit',durationMs:0,includesContactNavigation:false,complete:true}]};
  f.options.freshSession=async()=>{const fresh=f.fresh();fresh.focusHandoff=focusHandoff();fresh.session.recordingUi={focusHwnd:'100',uia:{version:1,executableVersion:'4.1.15.56',conversationFingerprint:{version:1,scope:'chat-title-text-v1',sha256:'1'.repeat(64),headerRuntimeIdSha256:'2'.repeat(64),titleRuntimeIdSha256:'3'.repeat(64),textNodeCount:1,targetVerified:false}}};return fresh;};
  f.dependencies.runTimedVoicePreview=async request=>({...await run(request),recordingEndedObserved:true,focusHandoff:diagnostic,uiaRecordingUi:{version:1,requested:true,bound:true,stateChecks:5,conversationVerified:true,pixelsRead:false}});
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);assert.equal(result.confirmed,true);assert.equal(result.stopBarrier,false);assert.deepEqual(result.focusHandoff.backgroundSubmit,background);
  assert.equal(result.foregroundTiming.complete,true);assert.equal(result.foregroundTiming.maxContinuousForegroundMs,400);assert.equal(result.focusHandoff.finalReturnConfirmed,false);
  const recovered=await runVoiceSubmitPreview(f.options,f.dependencies);assert.deepEqual(recovered.focusHandoff.backgroundSubmit,background);assert.equal(f.counts.native,1);
});

test('specific audio permission, filehelper, bounded audio and distinct endpoints are required before state', async t => {
  const f = fixture(t);
  for (const change of [v => { v.target = 'other'; }, v => { v.permission.audioSha256 = 'f'.repeat(64); }, v => { v.permission.submitPreview = false; },
    v => { v.audio = wave(5.01); }, v => { v.captureId = v.renderId; }, v => { v.maxDurationMs = 12001; }]) {
    const value = { ...f.options, permission: { ...f.options.permission } }; change(value);
    await assert.rejects(runVoiceSubmitPreview(value, f.dependencies));
  }
  assert.deepEqual(fs.readdirSync(f.options.directory), []); assert.equal(f.counts.native, 0);
});

test('unknown native outcome still queries, same ID never rerecords and new ID cannot bypass barrier', async t => {
  const f = fixture(t); f.dependencies.runTimedVoicePreview = async () => { f.counts.native++; throw Error('PRIVATE native failure'); };
  f.receipts.query = async () => { f.counts.query++; return { confirmed: false }; };
  const first = await runVoiceSubmitPreview(f.options, f.dependencies); assert.equal(first.state, 'unknown'); assert.equal(first.stopBarrier, true); assert.ok(f.counts.query > 0);
  await assert.rejects(runVoiceSubmitPreview({ ...f.options, deliveryId: '9'.repeat(64) }, f.dependencies), { code: 'UI_VOICE_PREVIEW_RECOVERY_REQUIRED' });
  f.receipts.query = async job => ({ confirmed: true, receipt: { ...f.receipt(job), createTime: Math.floor(job.submittedAt / 1000), observedAt: f.dependencies.now() } });
  const recovered = await runVoiceSubmitPreview(f.options, f.dependencies);
  assert.equal(recovered.confirmed, true); assert.equal(recovered.stopBarrier, true); assert.equal(recovered.recordingPossible, null);
  assert.equal(f.counts.native, 1); assert.equal(f.counts.prepare, 1);
});

test('possible or unknown ongoing recording gets at most one receipt read and no polling delay', async t => {
  for (const recordingPossible of [true, null, undefined]) {
    const f = fixture(t); let waits = 0;
    f.dependencies.runTimedVoicePreview = async () => { f.counts.native++; return { recordingAttempted: true, recordingPossible, stopBarrier: true, submitAttempted: false, reason: 'DRAFT_HUMAN_ACTIVITY_CHANGED' }; };
    f.dependencies.wait = async () => { waits++; };
    f.receipts.query = async () => { f.counts.query++; return { confirmed: false }; };
    const result = await runVoiceSubmitPreview(f.options, f.dependencies);
    assert.equal(result.state, 'unknown'); assert.equal(result.stopBarrier, true); assert.equal(f.barrier(), true);
    assert.equal(f.counts.query, 1); assert.equal(waits, 0); assert.equal(result.nativeReason, 'DRAFT_HUMAN_ACTIVITY_CHANGED');
  }
});

test('a just-confirmed bubble with an uncertain recorder returns immediately and keeps its barrier', async t => {
  const f = fixture(t); let waits = 0;
  f.dependencies.runTimedVoicePreview = async () => ({ recordingAttempted: true, recordingPossible: true, stopBarrier: true, submitAttempted: true, submitInputApplied: true });
  f.dependencies.wait = async () => { waits++; };
  const result = await runVoiceSubmitPreview(f.options, f.dependencies);
  assert.equal(result.confirmed, true); assert.equal(result.recordingPossible, true); assert.equal(result.stopBarrier, true);
  assert.equal(f.counts.query, 1); assert.equal(waits, 0); assert.equal(f.barrier(), true);
});

test('valid receipt does not clear a possible ongoing recording or hide Reader cleanup failure', async t => {
  for (const mode of ['recording', 'cleanup', 'native-barrier']) {
    const f = fixture(t);
    if (mode === 'recording') f.dependencies.runTimedVoicePreview = async () => ({ recordingAttempted: true, recordingPossible: true, submitAttempted: true, submitInputApplied: false });
    else if (mode === 'native-barrier') f.dependencies.runTimedVoicePreview = async () => ({ recordingAttempted: true, recordingPossible: false, stopBarrier: true, submitAttempted: true, submitInputApplied: true });
    else f.dependencies.withLocalReceiptApi = async ({ callback }) => { await callback(f.context()); throw Object.assign(Error('private'), { code: 'READER_LOCAL_API_CLEANUP_UNCONFIRMED' }); };
    const result = await runVoiceSubmitPreview(f.options, f.dependencies);
    assert.equal(result.confirmed, true); assert.equal(result.stopBarrier, true); assert.equal(f.barrier(), true);
    if (mode === 'cleanup') assert.equal(result.cleanupUnknown, true);
  }
});

test('definite pre-recording refusal persists not-recorded and same ID cannot run again', async t => {
  const f = fixture(t); f.dependencies.runTimedVoicePreview = async () => { f.counts.native++; return { recordingAttempted: false, recordingPossible: false, stopBarrier: false, submitAttempted: false, reason: 'AUDIO_DEFAULT_CAPTURE_NOT_CABLE' }; };
  const result = await runVoiceSubmitPreview(f.options, f.dependencies);
  assert.equal(result.state, 'not-recorded'); assert.equal(result.nativeReason, 'AUDIO_DEFAULT_CAPTURE_NOT_CABLE'); assert.equal(f.barrier(), false); assert.equal(f.counts.query, 0);
  await runVoiceSubmitPreview(f.options, f.dependencies); assert.equal(f.counts.native, 1);
});

test('mismatched or stale account proof, invalid calibration and short API budget cannot invoke native', async t => {
  for (const mode of ['account', 'process', 'stale', 'empty', 'budget']) {
    const f = fixture(t);
    f.options.freshSession = async () => { const value = f.fresh();
      if (mode === 'account') value.accountProof.accountRef = 'wrong';
      if (mode === 'process') value.accountProof.evidence.processId++;
      if (mode === 'stale') f.advance(501);
      if (mode === 'empty') value.session.emptyDraftConfirmed = false;
      return value;
    };
    if (mode === 'budget') f.dependencies.withLocalReceiptApi = async ({ callback }) => { await callback({ ...f.context(), expiresAt: f.dependencies.now() + 21000 }); return { processStopped: true }; };
    const result = await runVoiceSubmitPreview(f.options, f.dependencies); assert.equal(result.state, 'not-recorded'); assert.equal(f.counts.native, 0);
  }
});

test('unbound, missing server ID, wrong duration, or content-claim receipts never confirm', async t => {
  for (const patch of [{ account: 'wrong' }, { deliveryId: '9'.repeat(64) }, { serverId: '0' }, { durationMs: 8001 }, { audioContentVerified: true }, { rawXml: 'PRIVATE' }]) {
    const f = fixture(t); f.receipts.query = async job => ({ confirmed: true, receipt: { ...f.receipt(job), ...patch } });
    const result = await runVoiceSubmitPreview(f.options, f.dependencies); assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'UI_VOICE_PREVIEW_RECEIPT_MISMATCH'); assert.equal(result.stopBarrier, true);
  }
});

test('concurrent different IDs cannot record and orphan barrier is never overwritten', async t => {
  const f = fixture(t); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { release = resolve; });
  f.options.freshSession = async () => { entered(); await pending; return f.fresh(); };
  const first = runVoiceSubmitPreview(f.options, f.dependencies); await ready;
  await assert.rejects(runVoiceSubmitPreview({ ...f.options, deliveryId: '9'.repeat(64) }, f.dependencies), { code: 'UI_VOICE_PREVIEW_BUSY' });
  release(); await first;
  fs.writeFileSync(path.join(f.options.directory, 'active.json'), JSON.stringify({ version: 1, deliveryId: '8'.repeat(64), audioSha256: hash(f.options.audio), accountScopeHash: f.options.accountScopeHash }));
  await assert.rejects(runVoiceSubmitPreview({ ...f.options, deliveryId: '8'.repeat(64) }, f.dependencies), { code: 'UI_VOICE_PREVIEW_RECOVERY_REQUIRED' });
  assert.equal(f.counts.native, 1);
});

test('late calibration after Reader timeout cannot start native or modify final state', async t => {
  const f = fixture(t); let entered, release, background;
  const ready = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { release = resolve; });
  f.options.freshSession = async () => { entered(); await pending; return f.fresh(); };
  f.dependencies.withLocalReceiptApi = async ({ callback }) => { background = callback(f.context()).catch(() => {}); await ready; throw Error('timeout'); };
  const result = await runVoiceSubmitPreview(f.options, f.dependencies), saved = f.stored();
  assert.equal(result.state, 'not-recorded'); release(); await background;
  assert.equal(f.counts.native, 0); assert.deepEqual(f.stored(), saved);
});

test('existing ID with changed audio, range or route rejects without re-recording', async t => {
  const f = fixture(t); await runVoiceSubmitPreview(f.options, f.dependencies);
  const audio = wave(4);
  for (const options of [{ ...f.options, audio, permission: { ...f.options.permission, audioSha256: hash(audio) } }, { ...f.options, minDurationMs: 4000 }, { ...f.options, renderId: 'other-render' }])
    await assert.rejects(runVoiceSubmitPreview(options, f.dependencies), { code: 'UI_VOICE_PREVIEW_STATE_INVALID' });
  assert.equal(f.counts.native, 1);
});

test('actual voice receipt module confirms only post-native new row over fake HTTP', async t => {
  const f = fixture(t); let sent = false, baseline = 0;
  f.dependencies.receiptsFactory = config => new UiVoiceReaderReceipts({ ...config, fetchImpl: async url => {
    const u = new URL(url), data = u.pathname.endsWith('/status') ? { success: true, backend: 'weflow-cli-nt', ownWxid: f.options.accountWxid, accountDirectory: f.options.accountDirectory } :
      { success: true, scope: { version: 1, complete: true, accountWxid: f.options.accountWxid, accountDirectory: f.options.accountDirectory, talker: 'filehelper', fromTime: Number(u.searchParams.get('from_time')), throughTime: Math.floor(f.dependencies.now() / 1000) },
        messages: sent ? [{ sourceShard: 'c'.repeat(64), localId: '42', serverId: '1234567890123456789', localType: 34, createTime: Math.floor(f.dependencies.now() / 1000), senderUsername: f.options.accountWxid, isSend: 1, voice: { version: 1, durationMs: 6000 } }] : [] };
    if (!u.pathname.endsWith('/status') && !sent) baseline++;
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  } });
  const run = f.dependencies.runTimedVoicePreview; f.dependencies.runTimedVoicePreview = async request => { const result = await run(request); sent = true; return result; };
  const result = await runVoiceSubmitPreview(f.options, f.dependencies); assert.equal(result.confirmed, true); assert.equal(baseline, 1); assert.equal(f.counts.native, 1);
});

test('crash-created state without a baseline never replays recording', async t => {
  const f = fixture(t), binding = validateVoiceSubmitPreview(f.options), at = f.dependencies.now();
  fs.writeFileSync(path.join(f.options.directory, f.options.deliveryId + '.json'), JSON.stringify({ ...binding, state: 'created', createdAt: at, updatedAt: at, recordingPossible: false, stopBarrier: true, nativeStopBarrier: false }));
  const result = await runVoiceSubmitPreview(f.options, f.dependencies); assert.equal(result.reused, true); assert.equal(f.counts.native, 0); assert.equal(f.counts.prepare, 0);
});

test('preview persists continuous intervals separately from legacy native elapsed times',async t=>{
  const f=fixture(t),run=f.dependencies.runTimedVoicePreview;
  const segment=(phase,durationMs,includesContactNavigation=false)=>({phase,durationMs,includesContactNavigation,complete:true});
  f.options.freshSession=async()=>({...f.fresh(),focusHandoff:focusHandoff(),foregroundIntervals:[segment('contact-navigation',9900,true)]});
  f.dependencies.runTimedVoicePreview=async request=>({...await run(request),focusHandoff:{...handoffReport(),foregroundIntervals:[segment('record-start',2300),segment('record-submit',390)]}});
  const result=await runVoiceSubmitPreview(f.options,f.dependencies);
  assert.equal(result.confirmed,true);assert.equal(result.foregroundTiming.maxContinuousForegroundMs,9900);
  assert.deepEqual(result.foregroundTiming.intervals.map(row=>row.durationMs),[9900,2300,390]);
  const repeated=await runVoiceSubmitPreview(f.options,f.dependencies);assert.deepEqual(repeated.foregroundTiming,result.foregroundTiming);assert.equal(repeated.reused,true);
});
