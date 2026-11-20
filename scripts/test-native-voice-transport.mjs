import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeVoiceTransport } from './native-voice-transport.mjs';
import {voiceInterruptionEvidence,validVoiceInterruptionEvidence} from './voice-interruption-evidence.mjs';

const hex = value => value.repeat(64);
const measured=(phase,durationMs,includesContactNavigation=false)=>({phase,durationMs,includesContactNavigation,complete:true});
const interrupted=()=>({ok:false,reason:'DRAFT_HUMAN_ACTIVITY_CHANGED',recordingAttempted:true,captureSessionBound:true,submitAttempted:false,submitInputApplied:false,cancelAttempted:true,cancelInputApplied:true,recordingEndedObserved:true,recordingPossible:false,stopBarrier:false,systemSettingsChanged:false});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-transport-'));
  t.after(() => { const target = fs.realpathSync(root); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(target), /^voice-transport-/); fs.rmSync(target, { recursive: true }); });
  const audio = Buffer.alloc(3244); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(3200, 40);
  const scope = { version: 1, accountRef: hex('a'), account: 'fixture-self', target: 'fixture-friend', eventId: 'fixture', selectionVersion: 1, grantId: hex('b'), token: hex('c') };
  const job = { id: hex('d'), account: scope.account, target: scope.target, audio, audioSha256: crypto.createHash('sha256').update(audio).digest('hex'), voiceId: hex('e'), durationMs: 100, selectionScope: scope };
  const at = 1700000000000, state = { nativeCalls: 0, preparations: 0, queries: 0, allowed: true, receiptFails: false, confirmed: true, freshChanges: null };
  const fresh = () => {
    const session = { version: 2, id: 'a'.repeat(32), calibrationHash: hex('b'), accountScopeHash: hex('c'), target: job.target, executable: 'C:\\fixture\\Weixin.exe',
      hwnd: '100', focusHwnd: '100', processCreatedFileTimeUtc: '12345', pid: 42, dpi: 96, lastInputTick: 10, issuedAtMs: at, expiresAtMs: at + 29000,
      clientRect: { left: 0, top: 0, right: 800, bottom: 600 }, captureRect: { left: 100, top: 100, right: 900, bottom: 700 }, editorRect: { left: 100, top: 400, right: 700, bottom: 590 },
      emptyDraftConfirmed: true, mouseParkRect: { left: 20, top: 20, right: 40, bottom: 40 }, recordStartRect: { left: 710, top: 400, right: 750, bottom: 440 },
      recordingUi: { focusHwnd: '100', cancel: { rect: { left: 150, top: 450, right: 180, bottom: 480 }, rgbaSha256: hex('d') }, submit: { rect: { left: 600, top: 450, right: 630, bottom: 480 }, rgbaSha256: hex('e') } },
      targetProof: { kind: 'verified-qt-private-chat-v1', target: job.target, accountRef: scope.accountRef, titleAnchor: { rect: { left: 100, top: 10, right: 400, bottom: 50 }, rgbaSha256: hex('a') } } };
    const accountProof = { accountRef: scope.accountRef, accountScopeHash: session.accountScopeHash,
      evidence: { ok: true, proof: 'process-open-database-v1', complete: true, processOpenedExpectedDatabase: true, accountRootsObserved: 1, consistentPathScans: 2, snapshotAtomic: false,
        processId: 42, processCreatedFileTimeUtc: '12345', ready: false, desktopAccountVerified: false, targetVerified: false, draftVerified: false, inputSent: false,
        maximumEvidenceAgeMs: 500, expectedDatabaseHandles: 1, observedAtUtc: new Date(at).toISOString() } };
    const result = { session, accountProof, focusHandoff:handoff() }; state.freshChanges?.(result); return result;
  };
  const config = { root, renderId: 'fixture-render', captureId: 'fixture-capture', now: () => at, receiptWaitMs: 0,
    driver: { async prepareVoiceSession() { return fresh(); } },
    receiptContext: async () => ({ baseUrl: 'http://127.0.0.1:12345', token: 'private-token', accountRef: scope.accountRef, accountWxid: job.account, accountDirectory: 'fixture-account' }),
    receiptsFactory: options => { assert.deepEqual(options.allowedTargets, [job.target]); return {
      async prepare(request) { state.preparations++; assert.equal(request.id, job.id); return { submissionAllowed: true }; },
      async query() { state.queries++; if (state.receiptFails) throw new Error('offline'); return { confirmed: state.confirmed, receipt: { fixture: true } }; },
    }; },
    runNative: async request => { state.nativeCalls++; assert.equal(request.session.target, job.target); assert.equal(request.permission.submitNativeVoice, true);
      return { recordingAttempted: true, submitAttempted: true, recordingPossible: false, stopBarrier: false, systemSettingsChanged: false }; },
  };
  return { root, state, job, config, fresh, transport: new NativeVoiceTransport(config), options: { canSubmit: () => state.allowed } };
}
test('production transport binds fresh account/chat, prepares receipt before native and never changes audio defaults', async t => {
  const f = fixture(t), result = await f.transport.sendSegment(f.job, f.options);
  assert.equal(result.confirmed, true); assert.equal(result.routeSafe, true); assert.equal(result.routeMode, 'unchanged');
  assert.equal(f.state.nativeCalls, 1); assert.equal(f.state.preparations, 1);
  const repeated = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(repeated.confirmed, true); assert.equal(f.state.nativeCalls, 1); assert.equal(f.state.preparations, 1);
  const saved = fs.readFileSync(path.join(f.root, 'state/native-voice-transport', f.job.id + '.json'), 'utf8'); assert.equal(saved.includes('private-token'), false);
});
test('a fully observed interrupted cancellation is durable and its old attempt can only return that evidence',async t=>{
  for(const reason of ['DRAFT_HUMAN_ACTIVITY_CHANGED','VOICE_BACKGROUND_WECHAT_ACTIVATED']){
    const f=fixture(t);f.config.runNative=async()=>{f.state.nativeCalls++;return{...interrupted(),reason};};const transport=new NativeVoiceTransport(f.config);
    const result=await transport.sendSegment(f.job,f.options);assert.equal(result.confirmed,false);assert.equal(result.attempted,true);assert.equal(validVoiceInterruptionEvidence(result.interruptionCancellation,f.job),true);assert.equal(f.state.queries,0);
    const later=new NativeVoiceTransport(f.config);for(const method of ['querySegment','sendSegment']){const old=await later[method](f.job,f.options);assert.deepEqual(old.interruptionCancellation,result.interruptionCancellation);assert.equal(old.confirmed,false);}
    assert.equal(f.state.nativeCalls,1);assert.equal(f.state.preparations,1);assert.equal(f.state.queries,0);
  }
});
test('every cancellation fact and original binding is required; an incomplete no-send result never confirms a coincidental receipt',async t=>{
  const f=fixture(t),base=interrupted(),evidence=voiceInterruptionEvidence(base,f.job);assert.equal(validVoiceInterruptionEvidence(evidence,f.job),true);
  for(const key of Object.keys(base)){const changed={...base};delete changed[key];assert.equal(voiceInterruptionEvidence(changed,f.job),undefined,key);}
  for(const key of Object.keys(base).filter(k=>typeof base[k]==='boolean'))assert.equal(voiceInterruptionEvidence({...base,[key]:!base[key]},f.job),undefined,key);
  for(const reason of ['VOICE_PROCESS_FAILED','DRAFT_WINDOW_CHANGED',null])assert.equal(voiceInterruptionEvidence({...base,reason},f.job),undefined);
  for(const key of ['id','account','target','voiceId','audioSha256'])assert.equal(validVoiceInterruptionEvidence(evidence,{...f.job,[key]:['account','target'].includes(key)?'changed':'0'.repeat(64)}),false,key);
  assert.equal(validVoiceInterruptionEvidence({...evidence,extra:true},f.job),false);
  f.config.runNative=async()=>{const result=interrupted();delete result.cancelInputApplied;return result;};const transport=new NativeVoiceTransport(f.config),result=await transport.sendSegment(f.job,f.options);
  assert.equal(result.interruptionCancellation,undefined);assert.equal(result.confirmed,false);assert.equal(result.attempted,true);assert.equal((await transport.querySegment(f.job)).confirmed,false);
});
test('tampered persisted cancellation binding or recording facts are rejected before old-ID query or input',async t=>{
  for(const key of ['attemptId','audioSha256','voiceId','accountSha256','targetSha256','cancelInputApplied']){
    const f=fixture(t);f.config.runNative=async()=>{f.state.nativeCalls++;return interrupted();};await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);
    const file=path.join(f.root,'state/native-voice-transport',f.job.id+'.json'),saved=JSON.parse(fs.readFileSync(file));saved.interruptionCancellation[key]=key==='cancelInputApplied'?false:'0'.repeat(64);fs.writeFileSync(file,JSON.stringify(saved));
    await assert.rejects(new NativeVoiceTransport(f.config).querySegment(f.job),{code:'NATIVE_VOICE_TRANSPORT_STATE_INVALID'});assert.equal(f.state.nativeCalls,1);assert.equal(f.state.queries,0);
  }
});
test('production keeps bounded adaptive diagnostics with its existing durable receipt instead of starting again',async t=>{
  const f=fixture(t),native=f.config.runNative,diagnostic={requested:true,bound:true,cancelScore:.99,submitScore:1,elapsedMs:82,pixelGuardsFixed:true};
  f.config.runNative=async request=>({...await native(request),adaptiveRecordingUi:diagnostic});const transport=new NativeVoiceTransport(f.config);
  assert.deepEqual((await transport.sendSegment(f.job,f.options)).adaptiveRecordingUi,diagnostic);
  assert.deepEqual((await transport.sendSegment(f.job,f.options)).adaptiveRecordingUi,diagnostic);assert.equal(f.state.nativeCalls,1);
});
test('stale or different native account proof cannot start a recording', async t => {
  for (const change of [value => { value.accountProof.evidence.observedAtUtc = new Date(1699999999000).toISOString(); },
    value => { value.accountProof.evidence.processId++; }, value => { value.accountProof.accountRef = hex('b'); },
    value => { value.session.targetProof.target = 'other'; }, value => { value.session.emptyDraftConfirmed = false; }]) {
    const f = fixture(t); f.state.freshChanges = change;
    const result = await f.transport.sendSegment(f.job, f.options); assert.equal(result.confirmed, false); assert.equal(result.attempted, false); assert.equal(f.state.nativeCalls, 0);
  }
});

test('production UIA diagnostics survive a confirmed receipt and same-ID query without replay',async t=>{
  const f=fixture(t),native=f.config.runNative,diagnostic={version:1,requested:true,bound:true,stateChecks:7,conversationVerified:true,pixelsRead:false};
  f.config.runNative=async request=>({...await native(request),uiaRecordingUi:diagnostic});const transport=new NativeVoiceTransport(f.config);
  const first=await transport.sendSegment(f.job,f.options);assert.equal(first.confirmed,true);assert.deepEqual(first.uiaRecordingUi,diagnostic);
  assert.deepEqual((await transport.sendSegment(f.job,f.options)).uiaRecordingUi,diagnostic);assert.equal(f.state.nativeCalls,1);
});
test('selection changed during asynchronous preparation prevents native launch', async t => {
  const f = fixture(t); f.config.driver.prepareVoiceSession = async () => { f.state.allowed = false; return f.fresh(); };
  const result = await f.transport.sendSegment(f.job, f.options); assert.equal(result.attempted, false); assert.equal(result.recordingPossible, false); assert.equal(f.state.nativeCalls, 0);
});
test('waitable Qt preparation refusal keeps its exact reason and never starts or retries native recording', async t => {
  const f = fixture(t); f.state.confirmed = false;
  f.config.driver.prepareVoiceSession = async () => { throw Object.assign(new Error('QT_HUMAN_ACTIVE'), { code: 'QT_HUMAN_ACTIVE', attempted: false, waitable: true }); };
  const result = await f.transport.sendSegment(f.job, f.options);
  assert.equal(result.attempted, false); assert.equal(result.recordingPossible, false); assert.equal(result.stopBarrier, false); assert.equal(result.routeSafe, true); assert.equal(result.reason, 'QT_HUMAN_ACTIVE');
  const file = path.join(f.root, 'state/native-voice-transport', f.job.id + '.json'), saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.state, 'finished'); assert.equal(saved.attempted, false); assert.equal(f.state.preparations, 1); assert.equal(f.state.nativeCalls, 0);
  const repeated = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options); assert.equal(repeated.reason, 'QT_HUMAN_ACTIVE'); assert.equal(repeated.confirmed, false); assert.equal(f.state.nativeCalls, 0); assert.equal(f.state.preparations, 1);
});
test('a known pre-input refusal cannot be confirmed by a later same-duration manual voice receipt', async t => {
  const f = fixture(t); f.state.confirmed = false;
  f.config.driver.prepareVoiceSession = async () => { throw Object.assign(new Error('QT_HUMAN_ACTIVE'), { code: 'QT_HUMAN_ACTIVE', attempted: false, waitable: true }); };
  const initial = await f.transport.sendSegment(f.job, f.options); assert.equal(initial.attempted, false);
  // Simulate an unrelated matching database row arriving after the durable
  // refusal, before the caller had a chance to persist its cancellation.
  f.state.confirmed = true;
  const recovered = await new NativeVoiceTransport(f.config).querySegment(f.job);
  assert.equal(recovered.confirmed, false); assert.equal(recovered.receipt, undefined); assert.equal(recovered.attempted, false); assert.equal(recovered.recordingPossible, false);
  const repeated = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(repeated.confirmed, false); assert.equal(repeated.receipt, undefined); assert.equal(f.state.nativeCalls, 0); assert.equal(f.state.preparations, 1);
});
test('native uncertainty is durable and a receipt cannot clear unknown recording ownership', async t => {
  const f = fixture(t); f.config.runNative = async () => { f.state.nativeCalls++; throw new Error('native lost'); };
  const transport = new NativeVoiceTransport(f.config), result = await transport.sendSegment(f.job, f.options);
  assert.equal(result.confirmed, false); assert.equal(result.stopBarrier, true);
  const recovered = await new NativeVoiceTransport(f.config).querySegment(f.job, {}); assert.equal(recovered.confirmed, false); assert.equal(recovered.recordingPossible, true); assert.equal(f.state.nativeCalls, 1);
});
test('a temporary receipt outage preserves proven recording end for query-only recovery after revocation', async t => {
  const f = fixture(t); f.state.receiptFails = true;
  const result = await f.transport.sendSegment(f.job, f.options); assert.equal(result.confirmed, false); assert.equal(result.recordingPossible, false); assert.equal(result.routeSafe, true);
  f.state.receiptFails = false; f.state.allowed = false;
  assert.equal((await new NativeVoiceTransport(f.config).querySegment(f.job)).confirmed, true); assert.equal(f.state.nativeCalls, 1);
});
test('another reader account cannot prepare or query the saved target receipt', async t => {
  const f = fixture(t); await f.transport.sendSegment(f.job, f.options);
  f.config.receiptContext = async () => ({ accountWxid: 'other', accountRef: hex('a'), accountDirectory: 'fixture-account' });
  assert.equal((await new NativeVoiceTransport(f.config).querySegment(f.job)).confirmed, false); assert.equal(f.state.nativeCalls, 1);
});
test('changed target, audio or model under an existing segment ID is rejected', async t => {
  const f = fixture(t); await f.transport.sendSegment(f.job, f.options);
  for (const changed of [{ ...f.job, voiceId: hex('f') }, { ...f.job, audioSha256: hex('f') }, { ...f.job, target: 'other', selectionScope: { ...f.job.selectionScope, target: 'other' } }])
    await assert.rejects(new NativeVoiceTransport(f.config).querySegment(changed), { code: 'NATIVE_VOICE_TRANSPORT_STATE_INVALID' });
});
test('transport close requests cancellation and drain awaits native return', async t => {
  const f = fixture(t); let entered, release, aborted = false, drained = false;
  const ready = new Promise(resolve => { entered = resolve; }), done = new Promise(resolve => { release = resolve; });
  f.config.runNative = async request => { entered(); request.signal.addEventListener('abort', () => { aborted = true; }); await done;
    return { recordingAttempted: true, submitAttempted: false, recordingPossible: false, stopBarrier: false, systemSettingsChanged: false }; };
  const transport = new NativeVoiceTransport(f.config), running = transport.sendSegment(f.job, f.options); await ready;
  transport.close(); const draining = transport.drain().then(() => { drained = true; }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(aborted, true); assert.equal(drained, false); release(); await running; await draining; assert.equal(drained, true);
  await assert.rejects(transport.sendSegment(f.job, f.options), { code: 'NATIVE_VOICE_TRANSPORT_CLOSED' });
});

function sharedPlan() { return { allowed: true, executionMode: 'focus-handoff', requiresForeground: true,
  requiresActivityGuard: true, activityGuardScope: 'handoff-only', policyVersion: 7, textEntryMode: 'paste' }; }
function handoff() { return { version: 1, returnWindow: { hwnd: '200', pid: 99, processCreatedFileTimeUtc: '456' } }; }

test('shared transport warms before Qt navigation and carries the one-use monitor only to native execution',async t=>{
  const f=fixture(t),events=[],warmMonitor={close:async()=>{events.push('close');},drain:async()=>{events.push('drain');}};
  f.config.currentPlan=sharedPlan;
  f.config.warmMonitorFactory=async options=>{assert.equal(options.root,f.root);assert.equal(options.signal.aborted,false);events.push('warm');return warmMonitor;};
  f.config.driver.prepareVoiceSession=async()=>{events.push('prepare');return {...f.fresh(),focusHandoff:handoff()};};
  const original=f.config.runNative;f.config.runNative=async request=>{events.push('native');assert.equal(request.warmMonitor,warmMonitor);return original(request);};
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options)).confirmed,true);assert.deepEqual(events,['warm','prepare','native','close','drain']);
  const saved=fs.readFileSync(path.join(f.root,'state/native-voice-transport',f.job.id+'.json'),'utf8');assert.equal(saved.includes('warmMonitor'),false);
  await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);assert.deepEqual(events,['warm','prepare','native','close','drain']);
});

test('default transport uses fast voice navigation and focus handoff even without an injected plan',async t=>{
  const f=fixture(t),events=[];
  f.config.warmMonitorFactory=async()=>{events.push('warm');return{close:async()=>events.push('close'),drain:async()=>events.push('drain')};};
  f.config.driver.prepareVoiceSession=async(_job,{interactionPlan})=>{assert.equal(interactionPlan.executionMode,'focus-handoff');assert.equal(interactionPlan.textEntryMode,'paste');events.push('prepare');return f.fresh();};
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options)).confirmed,true);assert.deepEqual(events,['warm','prepare','close','drain']);
});

test('retired continuous voice and humanized voice navigation are rejected before receipts or input',async t=>{
  for(const patch of [{executionMode:'foreground'},{textEntryMode:'humanized'},{activityGuardScope:'entire-send'}]){
    const f=fixture(t);f.config.currentPlan=()=>({...sharedPlan(),...patch});f.config.warmMonitorFactory=async()=>{assert.fail('blocked plan must not warm');};
    const result=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);
    assert.equal(result.reason,'NATIVE_VOICE_INTERACTION_PLAN_BLOCKED');assert.equal(result.attempted,false);assert.equal(result.recordingPossible,false);
    assert.equal(f.state.preparations,0);assert.equal(f.state.nativeCalls,0);
  }
});

test('invalid injected monitor cannot hide the safe configuration refusal during cleanup',async t=>{
  for(const monitor of [null,{}, {close:async()=>{}}]){
    const f=fixture(t);f.config.currentPlan=sharedPlan;f.config.warmMonitorFactory=async()=>monitor;
    f.config.driver.prepareVoiceSession=async()=>{assert.fail('invalid monitor');};
    const result=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);assert.equal(result.reason,'NATIVE_VOICE_WARMUP_INVALID');assert.equal(result.attempted,false);assert.equal(result.recordingPossible,false);
  }
});

test('revocation during read-only warmup prevents Qt navigation and closes the monitor',async t=>{
  const f=fixture(t);let closed=0,drained=0;f.config.currentPlan=sharedPlan;
  f.config.warmMonitorFactory=async()=>{f.state.allowed=false;return {close:async()=>{closed++;},drain:async()=>{drained++;}};};
  f.config.driver.prepareVoiceSession=async()=>{assert.fail('revoked');};
  const result=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);assert.equal(result.attempted,false);assert.equal(result.recordingPossible,false);assert.equal(closed,1);assert.equal(drained,1);assert.equal(f.state.nativeCalls,0);
});

test('known warm rejection stops the monitor and releases prepared focus; unknown outcomes never return focus blindly',async t=>{
  for(const known of [true,false]){
    const f=fixture(t),events=[];f.config.currentPlan=sharedPlan;
    f.config.warmMonitorFactory=async()=>({close:async()=>{events.push('closed');},drain:async()=>{events.push('drained');}});
    f.config.driver.prepareVoiceSession=async()=>({...f.fresh(),focusHandoff:handoff(),releaseFocus:async()=>{events.push('focus');}});
    f.config.runNative=async()=>{throw Object.assign(new Error('failed'),{code:'VOICE_PIPE_FAILED',...(known?{warmExecutionStarted:false,nativeStarted:false,recordingPossible:false,submitAttempted:false}:{recordingPossible:true,submitAttempted:null})});};
    const result=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);assert.equal(result.recordingPossible,!known);assert.equal(result.stopBarrier,!known);assert.deepEqual(events,known?['closed','drained','focus']:['closed','drained']);
  }
});

test('transport drain waits for unused warm process exit before releasing prepared focus',async t=>{
  const f=fixture(t);let release,closing,drained=false,focus=0;const wait=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{closing=resolve;});
  f.config.currentPlan=sharedPlan;f.config.warmMonitorFactory=async()=>({close:async()=>{closing();await wait;},drain:async()=>{}});
  f.config.driver.prepareVoiceSession=async()=>{f.state.allowed=false;return {...f.fresh(),focusHandoff:handoff(),releaseFocus:async()=>{focus++;}};};
  const transport=new NativeVoiceTransport(f.config),run=transport.sendSegment(f.job,f.options);await started;
  const drain=transport.drain().then(()=>{drained=true;});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(drained,false);assert.equal(focus,0);
  release();await run;await drain;assert.equal(drained,true);assert.equal(focus,1);
});

test('production transport copies a calibrated activation anchor from fresh preparation only',async t=>{
  const f=fixture(t),focus={...handoff(),activation:{rect:{left:200,top:8,right:320,bottom:32},rgbaSha256:hex('9')}};
  f.config.currentPlan=sharedPlan;
  f.config.driver.prepareVoiceSession=async()=>({...f.fresh(),focusHandoff:focus});
  f.config.runNative=async request=>{
    f.state.nativeCalls++;assert.deepEqual(request.focusHandoff,focus);assert.notEqual(request.focusHandoff.activation,focus.activation);assert.notEqual(request.focusHandoff.activation.rect,focus.activation.rect);
    return {recordingAttempted:true,submitAttempted:true,recordingPossible:false,stopBarrier:false,systemSettingsChanged:false};
  };
  const result=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);assert.equal(result.confirmed,true);assert.equal(f.state.nativeCalls,1);
  const saved=fs.readFileSync(path.join(f.root,'state/native-voice-transport',f.job.id+'.json'),'utf8');
  assert.equal(saved.includes('activation'),false);assert.equal(saved.includes('rgbaSha256'),false);
});

test('invalid activation is refused before recording and releases transferred focus',async t=>{
  const f=fixture(t);let released=0;f.config.currentPlan=sharedPlan;
  f.config.driver.prepareVoiceSession=async()=>({...f.fresh(),focusHandoff:{...handoff(),activation:{rect:{left:200,top:400,right:320,bottom:424},rgbaSha256:hex('9')}},releaseFocus:async()=>{released++;}});
  const result=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);
  assert.equal(result.attempted,false);assert.equal(result.recordingPossible,false);assert.equal(result.reason,'VOICE_FOCUS_HANDOFF_INVALID');assert.equal(released,1);assert.equal(f.state.nativeCalls,0);
});

test('shared voice freezes its plan and transports the exact preparation return window', async t => {
  const f = fixture(t); let plan = sharedPlan(), released = 0;
  f.config.currentPlan = () => plan;
  f.config.driver.prepareVoiceSession = async (_job, options) => {
    assert.equal(options.interactionPlan.executionMode, 'focus-handoff');
    assert.equal(options.interactionPlan.textEntryMode, 'paste');
    return { ...f.fresh(), focusHandoff: handoff(), releaseFocus: async () => { released++; } };
  };
  f.config.runNative = async request => {
    f.state.nativeCalls++; assert.deepEqual(request.focusHandoff, handoff());
    // Changing mode after start affects subsequent segments, never swaps this
    // recording's actions or causes it to be sent again.
    plan = { ...plan, policyVersion: 8, executionMode: 'foreground' };
    return { recordingAttempted: true, submitAttempted: true, recordingPossible: false, stopBarrier: false, systemSettingsChanged: false };
  };
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options)).confirmed, true);
  assert.equal(released, 0);
  assert.equal((await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options)).confirmed, true);
  assert.equal(f.state.nativeCalls, 1);
});

test('shared mode refuses missing handoff support and releases prepared focus on revocation', async t => {
  for (const cause of ['missing', 'changed', 'revoked', 'bad-proof']) {
    const f = fixture(t); let plan = sharedPlan(), released = 0;
    f.config.currentPlan = () => plan;
    f.config.driver.prepareVoiceSession = async () => {
      const result = { ...f.fresh(), releaseFocus: async () => { released++; } };
      if (cause === 'missing') delete result.focusHandoff;
      if (cause === 'changed') plan = { ...plan, policyVersion: 8 };
      if (cause === 'revoked') f.state.allowed = false;
      if (cause === 'bad-proof') result.accountProof.accountRef = hex('f');
      return result;
    };
    const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
    assert.equal(result.confirmed, false); assert.equal(result.attempted, false);
    assert.equal(f.state.nativeCalls, 0); assert.equal(released, 1);
  }
});

test('unknown native handoff never triggers a second focus action or recording attempt', async t => {
  const f = fixture(t); let released = 0;
  f.config.currentPlan = sharedPlan;
  f.config.driver.prepareVoiceSession = async () => ({ ...f.fresh(), focusHandoff: handoff(), releaseFocus: async () => { released++; } });
  f.config.runNative = async () => { f.state.nativeCalls++; throw new Error('lost'); };
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.stopBarrier, true); assert.equal(result.recordingPossible, true); assert.equal(released, 0);
  await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(f.state.nativeCalls, 1);
});

test('proved native pre-start failure releases transferred focus without creating a recording barrier', async t => {
  const f = fixture(t); let released = 0;
  f.config.currentPlan = sharedPlan;
  f.config.driver.prepareVoiceSession = async () => ({ ...f.fresh(), focusHandoff: handoff(), releaseFocus: async () => { released++; } });
  f.config.runNative = async () => { throw Object.assign(new Error('missing'), { code: 'VOICE_COMPONENT_MISSING', nativeStarted: false, recordingPossible: false, submitAttempted: false }); };
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, f.options);
  assert.equal(result.attempted, false); assert.equal(result.recordingPossible, false); assert.equal(result.stopBarrier, false); assert.equal(released, 1);
});

test('slow preparation cannot open a recorder without sufficient execution and receipt time', async t => {
  const f = fixture(t); let released = 0;
  f.config.currentPlan = sharedPlan;
  f.config.driver.prepareVoiceSession = async () => ({ ...f.fresh(), focusHandoff: handoff(), releaseFocus: async () => { released++; } });
  const result = await new NativeVoiceTransport(f.config).sendSegment(f.job, { ...f.options, executionDeadlineAt: f.config.now() + 19000 });
  assert.equal(result.reason, 'NATIVE_VOICE_START_BUDGET_EXHAUSTED');
  assert.equal(result.attempted, false); assert.equal(result.recordingPossible, false);
  assert.equal(f.state.nativeCalls, 0); assert.equal(released, 1);
});

test('continuous focus intervals survive production receipts and restart without replay or cumulative substitution',async t=>{
  const f=fixture(t),run=f.config.runNative;
  f.config.driver.prepareVoiceSession=async()=>({...f.fresh(),foregroundIntervals:[measured('contact-navigation',9800,true)]});
  f.config.runNative=async request=>({...await run(request),focusHandoff:{foregroundIntervals:[measured('record-start',2200),measured('record-submit',410)]}});
  const result=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);
  assert.equal(result.confirmed,true);assert.equal(result.foregroundTiming.maxContinuousForegroundMs,9800);
  assert.deepEqual(result.foregroundTiming.intervals.map(row=>row.durationMs),[9800,2200,410]);
  assert.equal(JSON.stringify(result.foregroundTiming).includes(f.job.target),false);
  const repeated=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);
  assert.deepEqual(repeated.foregroundTiming,result.foregroundTiming);assert.equal(f.state.nativeCalls,1);
});
test('malformed optional timing does not turn a confirmed send into a retry or leak arbitrary fields',async t=>{
  const f=fixture(t),run=f.config.runNative;
  f.config.runNative=async request=>({...await run(request),focusHandoff:{foregroundIntervals:[{...measured('record-start',1234),private:'SECRET'}]}});
  const result=await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);
  assert.equal(result.confirmed,true);assert.equal(result.foregroundTiming,undefined);assert.equal(f.state.nativeCalls,1);
});

test('layout facade ownership is released only after known native completion and helper cleanup',async t=>{
  for(const unknown of [false,true]){const f=fixture(t),released=[];f.config.driver.finishVoiceInteraction=value=>released.push(value);
    if(unknown)f.config.runNative=async()=>{throw Object.assign(new Error(),{code:'VOICE_PROTOCOL_INVALID'});};
    await new NativeVoiceTransport(f.config).sendSegment(f.job,f.options);
    assert.deepEqual(released,[{jobId:f.job.id,cleanupConfirmed:!unknown}]);
  }
});
