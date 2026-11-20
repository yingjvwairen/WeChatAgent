import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { validateTimedVoiceRequest, runTimedVoicePreview, validateMouseMarkerRequest, probeVoiceMouseMarker, validateTimedVoiceSendRequest, runTimedVoiceSend, warmVoiceMonitor } from './timed-voice-preview.mjs';
import {validateVoiceRecordingLayout} from './voice-recording-layout.mjs';

const root = path.resolve(import.meta.dirname, '..');
function wave(seconds = 0.1) {
  const size = Math.round(16000 * seconds) * 2, data = Buffer.alloc(44 + size);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(size, 40);
  return data;
}
function options() {
  return { id: '1'.repeat(64), audio: wave(), renderId: 'fixture-render', captureId: 'fixture-capture', idleMs: 1000,
    permission: { recordPreview: true, playAudio: true, submitPreview: true, cancelOwnedRecording: true },
    session: { version: 1, id: 'a'.repeat(32), calibrationHash: 'b'.repeat(64), accountScopeHash: 'c'.repeat(64), target: 'filehelper', executable: 'C:\\fixture\\Weixin.exe',
      hwnd: '100', focusHwnd: '100', processCreatedFileTimeUtc: '12345', pid: 42, dpi: 96, lastInputTick: 10, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 29000,
      clientRect: { left: 0, top: 0, right: 800, bottom: 600 }, captureRect: { left: 100, top: 100, right: 900, bottom: 700 }, editorRect: { left: 100, top: 400, right: 700, bottom: 590 },
      editorFocusProof: { kind: 'operator-calibrated-edit-region', calibrationHash: 'b'.repeat(64), lastInputTick: 10 }, emptyDraftConfirmed: true,
      mouseParkRect: { left: 20, top: 20, right: 40, bottom: 40 },
      recordStartRect: { left: 710, top: 400, right: 750, bottom: 440 }, recordingUi: { focusHwnd: '100',
        cancel: { rect: { left: 150, top: 450, right: 180, bottom: 480 }, rgbaSha256: 'd'.repeat(64) },
        submit: { rect: { left: 600, top: 450, right: 630, bottom: 480 }, rgbaSha256: 'e'.repeat(64) } } } };
}
function productionOptions() {
  const value = options(); value.session.version = 2; value.session.target = 'fixture-friend'; delete value.session.editorFocusProof;
  value.session.targetProof = { kind: 'verified-qt-private-chat-v1', target: 'fixture-friend', accountRef: 'f'.repeat(64),
    titleAnchor: { rect: { left: 100, top: 10, right: 400, bottom: 50 }, rgbaSha256: 'a'.repeat(64) } };
  value.permission = { recordNativeVoice: true, playAudio: true, submitNativeVoice: true, cancelOwnedRecording: true }; return value;
}

const focusHandoff = () => ({ version: 1, returnWindow: { hwnd: '200', pid: 99, processCreatedFileTimeUtc: '456' } });
const activation = () => ({rect:{left:200,top:8,right:320,bottom:32},rgbaSha256:'9'.repeat(64)});

test('automatic caption activation survives voice handoff without accepting arbitrary modes',()=>{
  for(const make of [options,productionOptions]){
    const value=make();value.focusHandoff={...focusHandoff(),activation:{rect:activation().rect,mode:'blank-caption-v1'}};
    const validate=value.session.version===2?validateTimedVoiceSendRequest:validateTimedVoiceRequest;
    assert.deepEqual(validate(value).focusHandoff,value.focusHandoff);
    for(const bad of [{...value.focusHandoff.activation,mode:'anywhere'},{...value.focusHandoff.activation,rgbaSha256:'a'.repeat(64)},{...value.focusHandoff.activation,rect:{left:200,top:60,right:320,bottom:80}}]){
      assert.throws(()=>validate({...value,focusHandoff:{...value.focusHandoff,activation:bad}}),{code:'VOICE_FOCUS_HANDOFF_INVALID'});
    }
  }
});
test('focus handoff requires a separate exact return-window identity and remains opt-in', () => {
  const value = options();
  assert.equal('focusHandoff' in validateTimedVoiceRequest(value), false);
  value.focusHandoff = focusHandoff();
  assert.deepEqual(validateTimedVoiceRequest(value).focusHandoff, value.focusHandoff);
  for (const mutate of [v => { v.version = 2; }, v => { v.returnWindow.pid = value.session.pid; },
    v => { v.returnWindow.hwnd = value.session.hwnd; }, v => { v.returnWindow.processCreatedFileTimeUtc = ''; },
    v => { v.returnWindow.title = 'not an identity'; }, v => { v.returnWindow.pid = 0; }]) {
    const bad = focusHandoff(); mutate(bad);
    assert.throws(() => validateTimedVoiceRequest({ ...value, focusHandoff: bad }), { code: 'VOICE_FOCUS_HANDOFF_INVALID' });
  }
  const production = productionOptions(); production.focusHandoff = focusHandoff();
  assert.deepEqual(validateTimedVoiceSendRequest(production).focusHandoff, production.focusHandoff);
});

test('optional focus activation is an exact bounded top-bar pixel anchor and is deeply copied', () => {
  for(const make of [options,productionOptions]) {
    const value=make();value.focusHandoff={...focusHandoff(),activation:activation()};
    const result=(value.session.version===2?validateTimedVoiceSendRequest:validateTimedVoiceRequest)(value).focusHandoff;
    assert.deepEqual(result,value.focusHandoff);assert.notEqual(result,value.focusHandoff);
    assert.notEqual(result.activation,value.focusHandoff.activation);assert.notEqual(result.activation.rect,value.focusHandoff.activation.rect);
    result.activation.rect.left=220;assert.equal(value.focusHandoff.activation.rect.left,200);
  }
  const mutations=[v=>{v.activation=null;},v=>{v.activation=undefined;},v=>{v.activation.extra=true;},v=>{v.activation.rect.extra=true;},
    v=>{v.activation.rgbaSha256='bad';},v=>{v.activation.rect.left=-1;},v=>{v.activation.rect.top=-1;},v=>{v.activation.rect.bottom=49;},
    v=>{v.activation.rect.right=219;},v=>{v.activation.rect.right=401;},v=>{v.activation.rect.bottom=15;},
    v=>{v.activation.rect={left:200,top:0,right:320,bottom:41};},v=>{v.activation.rect.left=200.5;},
    v=>{v.activation.rect.left=true;},v=>{v.activation.rect={left:620,top:8,right:650,bottom:32};},
    v=>{v.activation.rect={left:2**53,top:8,right:2**53+20,bottom:32};},v=>{v.unknown=true;}];
  for(const mutate of mutations){const value=options();value.focusHandoff={...focusHandoff(),activation:activation()};mutate(value.focusHandoff);
    assert.throws(()=>validateTimedVoiceRequest(value),{code:'VOICE_FOCUS_HANDOFF_INVALID'});}
});

test('production voice requires a separate verified private-chat session and title anchor', () => {
  assert.equal(validateTimedVoiceSendRequest(productionOptions()).action, 'timedVoiceSend');
  assert.throws(() => validateTimedVoiceRequest(productionOptions())); assert.throws(() => validateTimedVoiceSendRequest(options()));
  for (const change of [value => { value.session.targetProof.target = 'other'; }, value => { value.session.target = 'filehelper'; },
    value => { value.session.targetProof.titleAnchor.rect = value.session.editorRect; }, value => { value.session.targetProof.accountRef = ''; }]) {
    const value = productionOptions(); change(value); assert.throws(() => validateTimedVoiceSendRequest(value), { code: 'VOICE_TARGET_PROOF_INVALID' });
  }
});
test('production group voice requires a group-bound query proof and rejects private/group identity swaps',()=>{
  const group=()=>{const value=productionOptions();value.session.target=value.session.targetProof.target='fixture-room@chatroom';Object.assign(value.session.targetProof,{kind:'verified-qt-group-chat-v1',querySha256:'3'.repeat(64)});return value;};
  const valid=group(),result=validateTimedVoiceSendRequest(valid);assert.equal(result.session.target,valid.session.target);assert.deepEqual(result.session.targetProof,valid.session.targetProof);
  for(const alter of [v=>delete v.session.targetProof.querySha256,v=>v.session.targetProof.querySha256='bad',v=>v.session.targetProof.kind='verified-qt-private-chat-v1',v=>v.session.target=v.session.targetProof.target='private-friend']){
    const value=group();alter(value);assert.throws(()=>validateTimedVoiceSendRequest(value),{code:'VOICE_TARGET_PROOF_INVALID'});
  }
});
test('shared unchecked draft policy is explicit, preserves false evidence and never weakens dedicated sessions',()=>{
  for(const make of [options,productionOptions]){
    const value=make(),validate=value.session.version===2?validateTimedVoiceSendRequest:validateTimedVoiceRequest;
    value.session.draftPolicy='unchecked';value.session.emptyDraftConfirmed=false;
    assert.throws(()=>validate(value),{code:'VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED'});
    value.focusHandoff=focusHandoff();const valid=validate(value);assert.equal(valid.session.draftPolicy,'unchecked');assert.equal(valid.session.emptyDraftConfirmed,false);
    for(const change of [v=>v.session.emptyDraftConfirmed=true,v=>v.session.draftPolicy='verified',v=>v.session.draftPolicy=null,v=>delete v.session.emptyDraftConfirmed]){
      const bad=structuredClone(value);change(bad);bad.audio=Buffer.from(value.audio);assert.throws(()=>validate(bad),{code:'VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED'});
    }
    const bad={...value,focusHandoff:{version:2,returnWindow:focusHandoff().returnWindow}};assert.throws(()=>validate(bad),{code:'VOICE_FOCUS_HANDOFF_INVALID'});
  }
});

test('native synthetic self-test uses no UI, devices, audio or input', { skip: process.platform !== 'win32' || !fs.existsSync(path.join(root, 'state/ui-host/WechatVoicePreview.exe')) }, () => {
  const result = spawnSync(path.join(root, 'state/ui-host/WechatVoicePreview.exe'), ['--self-test'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout); assert.equal(report.ok, true); assert.ok(report.checks >= 41);
  for (const field of ['uiAccessed', 'devicesAccessed', 'audioStarted', 'inputSent']) assert.equal(report[field], false);
});
function adaptiveOptions(make=options){const value=make();value.session.recordStartRect={left:710,top:550,right:740,bottom:580};value.session.recordingUi={focusHwnd:'100',adaptive:{version:1,executableVersion:'4.1.15.56',toolbarRect:{left:120,top:535,right:780,bottom:590}}};return value;}
const uiaFingerprint=()=>({version:1,scope:'chat-title-text-v1',sha256:'a'.repeat(64),headerRuntimeIdSha256:'b'.repeat(64),titleRuntimeIdSha256:'c'.repeat(64),textNodeCount:2,targetVerified:false});
function uiaOptions(make=options){const value=make();value.focusHandoff=focusHandoff();value.session.recordingUi={focusHwnd:'100',uia:{version:1,executableVersion:'4.1.15.56',conversationFingerprint:uiaFingerprint()}};if(value.session.targetProof){delete value.session.targetProof.titleAnchor;value.session.targetProof.conversationFingerprint=uiaFingerprint();}return value;}
test('UIA focus hints remain semantic and cannot fall back to pixel calibration',()=>{
  for(const make of [options,productionOptions]){
    const value=uiaOptions(make),validate=make===options?validateTimedVoiceRequest:validateTimedVoiceSendRequest;
    value.focusHandoff.activation={rect:activation().rect,mode:'uia-caption-v1'};
    const result=validate(value);assert.deepEqual(result.focusHandoff.activation,value.focusHandoff.activation);assert.equal(Object.hasOwn(result.focusHandoff.activation,'rgbaSha256'),false);
    result.focusHandoff.activation.rect.left++;assert.equal(value.focusHandoff.activation.rect.left,200);
    for(const mode of ['blank-caption-v1',undefined]){const downgraded={...value.focusHandoff,activation:mode?{rect:activation().rect,mode}:activation()};assert.throws(()=>validate({...value,focusHandoff:downgraded}),{code:'VOICE_UIA_FOCUS_MODE_REQUIRED'});}
    const legacy=make();legacy.focusHandoff=value.focusHandoff;assert.throws(()=>validate(legacy),{code:'VOICE_UIA_FOCUS_MODE_REQUIRED'});
    for(const hint of [{...value.focusHandoff.activation,rect:{left:0,top:0,right:30,bottom:10}},{...value.focusHandoff.activation,rgbaSha256:'a'.repeat(64)}]){
      assert.throws(()=>validate({...value,focusHandoff:{...value.focusHandoff,activation:hint}}),{code:'VOICE_FOCUS_HANDOFF_INVALID'});
    }
  }
});
test('UIA voice carries fresh title proof without manufacturing pixel templates',()=>{
  for(const make of [options,productionOptions]){const value=uiaOptions(make),validate=make===options?validateTimedVoiceRequest:validateTimedVoiceSendRequest,result=validate(value);
    assert.deepEqual(result.session.recordingUi,value.session.recordingUi);assert.notEqual(result.session.recordingUi.uia.conversationFingerprint,value.session.recordingUi.uia.conversationFingerprint);
    assert.equal(result.session.recordingUi.cancel,undefined);assert.equal(result.session.recordingUi.adaptive,undefined);
    if(make===productionOptions){assert.equal(result.session.targetProof.titleAnchor,undefined);assert.deepEqual(result.session.targetProof.conversationFingerprint,uiaFingerprint());}
  }
});
test('UIA preview and production voice omit unused mouse parking while retaining session guards',()=>{
  for(const make of [options,productionOptions]){
    const value=uiaOptions(make),validate=make===options?validateTimedVoiceRequest:validateTimedVoiceSendRequest;delete value.session.mouseParkRect;
    const result=validate(value);assert.equal(Object.hasOwn(result.session,'mouseParkRect'),false);assert.deepEqual(result.session.recordingUi,value.session.recordingUi);assert.deepEqual(result.focusHandoff,value.focusHandoff);
    for(const park of [null,{},value.session.editorRect,{left:0,top:0,right:1,bottom:1}])assert.throws(()=>validate({...value,session:{...value.session,mouseParkRect:park}}),{code:'VOICE_MOUSE_PARK_INVALID'});
    const invalid=structuredClone(value.session);invalid.editorRect.right=invalid.clientRect.right+1;assert.throws(()=>validate({...value,session:invalid}));
  }
});
test('OCR adaptive and static voice still require real mouse parking',()=>{
  for(const make of [options,productionOptions])for(const value of [make(),adaptiveOptions(make)]){
    const validate=make===options?validateTimedVoiceRequest:validateTimedVoiceSendRequest;delete value.session.mouseParkRect;assert.throws(()=>validate(value),{code:'VOICE_MOUSE_PARK_INVALID'});
  }
});
test('UIA configuration may defer the fingerprint until preparation but execution cannot',()=>{
  const value=uiaOptions(),session=value.session;delete session.recordingUi.uia.conversationFingerprint;session.recordingUi.focusHwnd='same';
  const shape={recordingUi:session.recordingUi,clientRect:session.clientRect,recordStartRect:session.recordStartRect,mouseParkRect:session.mouseParkRect,editorRect:session.editorRect,dpi:session.dpi,allowSameFocus:true};
  assert.deepEqual(validateVoiceRecordingLayout(shape),session.recordingUi);session.recordingUi.focusHwnd='100';assert.throws(()=>validateTimedVoiceRequest(value),{code:'VOICE_UIA_PLAN_INVALID'});
  session.recordingUi.uia.conversationFingerprint=uiaFingerprint();delete value.focusHandoff;assert.throws(()=>validateTimedVoiceRequest(value),{code:'VOICE_UIA_HANDOFF_REQUIRED'});
});
test('UIA voice rejects mixed pixel evidence, unknown plans and malformed fingerprint claims',()=>{
  for(const mutate of [v=>v.session.recordingUi.adaptive=adaptiveOptions().session.recordingUi.adaptive,v=>v.session.recordingUi.cancel=options().session.recordingUi.cancel,v=>v.session.recordingUi.uia.toolbarRect=v.session.editorRect,
    v=>v.session.recordingUi.uia.executableVersion='4.1.15.57',v=>v.session.recordingUi.uia.version=2,v=>v.session.recordingUi.uia.conversationFingerprint.targetVerified=true,
    v=>v.session.recordingUi.uia.conversationFingerprint.textNodeCount=0,v=>v.session.recordingUi.uia.conversationFingerprint.textNodeCount=5,v=>v.session.recordingUi.uia.conversationFingerprint.title='private text',
    v=>v.session.recordingUi.uia.conversationFingerprint.sha256='bad',v=>delete v.session.recordingUi.uia.conversationFingerprint.headerRuntimeIdSha256]){const value=uiaOptions();mutate(value);assert.throws(()=>validateTimedVoiceRequest(value),{code:'VOICE_UIA_PLAN_INVALID'});}
});
test('production UIA voice requires the same complete fingerprint in both target and recorder plans',()=>{
  for(const mutate of [v=>v.session.targetProof.titleAnchor=productionOptions().session.targetProof.titleAnchor,v=>delete v.session.targetProof.conversationFingerprint,v=>v.session.targetProof.conversationFingerprint.sha256='d'.repeat(64),
    v=>v.session.targetProof.conversationFingerprint.headerRuntimeIdSha256='d'.repeat(64),v=>v.session.targetProof.conversationFingerprint.titleRuntimeIdSha256='d'.repeat(64),v=>v.session.targetProof.conversationFingerprint.textNodeCount=1,
    v=>v.session.targetProof.extra=true,v=>v.session.targetProof.target='another-target']){const value=uiaOptions(productionOptions);mutate(value);assert.throws(()=>validateTimedVoiceSendRequest(value),{code:'VOICE_TARGET_PROOF_INVALID'});}
  const value=uiaOptions(productionOptions);value.session.target=value.session.targetProof.target='fixture-room@chatroom';value.session.targetProof.kind='verified-qt-group-chat-v1';value.session.targetProof.querySha256='d'.repeat(64);
  value.session.targetProof.conversationFingerprint=Object.fromEntries(Object.entries(uiaFingerprint()).reverse());assert.deepEqual(validateTimedVoiceSendRequest(value).session.targetProof,value.session.targetProof);
});
test('adaptive recording UI accepts only a bounded known-build template-search region and preserves production proof',()=>{
  for(const make of [options,productionOptions]){const value=adaptiveOptions(make),validate=make===options?validateTimedVoiceRequest:validateTimedVoiceSendRequest,result=validate(value);
    assert.deepEqual(result.session.recordingUi,value.session.recordingUi);assert.notEqual(result.session.recordingUi.adaptive,value.session.recordingUi.adaptive);
    assert.equal(result.session.recordingUi.cancel,undefined);if(make===productionOptions)assert.deepEqual(result.session.targetProof,value.session.targetProof);
  }
});
test('adaptive recording rejects mixed learned templates, arbitrary versions, crop bounds and mouse overlap',()=>{
  for(const change of [v=>v.session.recordingUi.cancel=options().session.recordingUi.cancel,v=>v.session.recordingUi.adaptive.template='arbitrary',v=>v.session.recordingUi.adaptive.executableVersion='4.1.15.57',
    v=>v.session.recordingUi.adaptive.version=2,v=>v.session.recordingUi.adaptive.toolbarRect.right=801,v=>v.session.recordingUi.adaptive.toolbarRect.top=100,
    v=>v.session.recordingUi.adaptive.toolbarRect.bottom=579,v=>v.session.recordingUi.adaptive.toolbarRect.left=735,v=>v.session.recordingUi.focusHwnd='same',
    v=>v.session.mouseParkRect={left:750,top:540,right:770,bottom:560},v=>v.session.recordingUi.adaptive.toolbarRect.left=true]){const value=adaptiveOptions();change(value);assert.throws(()=>validateTimedVoiceRequest(value));}
});

test('voice requires explicit permissions, both static templates, empty draft confirmation and bounded audio/session', () => {
  const valid = validateTimedVoiceRequest(options()); assert.equal(valid.action, 'timedVoicePreview'); assert.match(valid.audioSha256, /^[a-f0-9]{64}$/);
  const cases = [
    [value => { value.permission.recordPreview = false; }, 'VOICE_PERMISSION_REQUIRED'],
    [value => { value.permission.submitPreview = false; }, 'VOICE_PERMISSION_REQUIRED'],
    [value => { value.session.emptyDraftConfirmed = false; }, 'VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED'],
    [value => { value.audio = wave(8.01); }, 'VOICE_WAV_DURATION_LIMIT'],
    [value => { value.session.expiresAtMs = Date.now() + 15000; }, 'VOICE_SESSION_BUDGET_EXCEEDED'],
    [value => { value.captureId = value.renderId; }, 'VOICE_ENDPOINT_INVALID'],
    [value => { value.session.recordingUi.cancel.rect.right += 200; }, 'VOICE_TEMPLATE_INVALID'],
    [value => { value.session.recordingUi.submit = value.session.recordingUi.cancel; }, 'VOICE_TEMPLATE_INVALID'],
    [value => { delete value.session.recordingUi; }, 'VOICE_TEMPLATE_INVALID'],
    [value => { delete value.session.mouseParkRect; }, 'VOICE_MOUSE_PARK_INVALID'],
    [value => { value.session.mouseParkRect = value.session.editorRect; }, 'VOICE_MOUSE_PARK_INVALID'],
    [value => { value.session.mouseParkRect = value.session.recordStartRect; }, 'VOICE_MOUSE_PARK_INVALID'],
    [value => { value.session.mouseParkRect = value.session.recordingUi.submit.rect; }, 'VOICE_MOUSE_PARK_INVALID'],
    [value => { value.session.mouseParkRect = { left: 0, top: 0, right: 129, bottom: 20 }; }, 'VOICE_MOUSE_PARK_INVALID'],
  ];
  for (const [change, code] of cases) { const value = options(); change(value); assert.throws(() => validateTimedVoiceRequest(value), { code }); }
});

function fixture(t, mode = 'success') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'timed-voice-fixture-'));
  fs.mkdirSync(path.join(directory, 'state/ui-host'), { recursive: true }); fs.writeFileSync(path.join(directory, 'state/ui-host/WechatVoicePreview.exe'), 'mock');
  const source = path.join(directory, 'worker.mjs');
  fs.writeFileSync(source, `import fs from 'node:fs';let input='',nonce,monitorId='b'.repeat(32);process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(!input.includes('\\n'))return;
    if(process.env.FIXTURE_MODE==='lost'){process.stdout.write('invalid private '+input);process.exit(1);return;}
    let request=JSON.parse(input.slice(0,input.indexOf('\\n')));input=input.slice(input.indexOf('\\n')+1);
    if(request.action==='warmVoiceMonitor'){nonce=request.nonce;console.log(JSON.stringify({ok:true,phase:'ready',protocol:'voice-warm-v1',nonce,monitorId,readOnly:true,inputSent:false,mutexHeld:false,maximumWarmupMs:60000}));return;}
    if(request.action==='executeWarmVoice'){
      if(request.nonce!==nonce||request.monitorId!==monitorId||request.mode!==(process.env.FIXTURE_MODE==='production'?'private-send':'private-once'))process.exit(3);
      if(process.env.FIXTURE_MODE==='warm-rejected'){console.log(JSON.stringify({ok:false,phase:'rejected',protocol:'voice-warm-v1',nonce,monitorId,reason:'DRAFT_UI_MUTEX_BUSY',executionStarted:false,inputSent:false,recordingStarted:false,focusOwnershipTransferred:false}));process.exit(1);return;}
      request=request.request;
    }
    if(process.env.FIXTURE_MODE.startsWith('mouse-')){
      if(request.action!=='probeMouseMarker'||request.permission.mouseMoveDiagnostic!==true||request.audio||request.waveFile||request.renderId||request.captureId)process.exit(3);
      const blocked=process.env.FIXTURE_MODE==='mouse-unowned';const result={ok:!blocked,mode:'mouseMarkerDiagnostic',reason:blocked?'DRAFT_HUMAN_ACTIVITY_CHANGED':null,mouseMoveAttempted:true,mouseMoveInputApplied:true,ownMouseObserved:!blocked,humanActivity:blocked?{kind:'mouse',injected:true,ownMarker:false,lower32Matches:true,markerIsZero:false,message:512,timeAfterRecordStartMs:null,privatePayload:request.session.executable}:null,recordingAttempted:process.env.FIXTURE_MODE==='mouse-forbidden',audioStarted:false,submitAttempted:false,messageSent:false,systemSettingsChanged:false};console.log(JSON.stringify(result));process.exit(result.ok?0:1);return;
    }
    if(!fs.existsSync(request.waveFile))process.exit(3);
    if(process.env.FIXTURE_MODE==='shared-unchecked'&&(!request.focusHandoff||request.session.draftPolicy!=='unchecked'||request.session.emptyDraftConfirmed!==false))process.exit(4);
    if(process.env.FIXTURE_MODE==='activation'&&(request.focusHandoff?.activation?.rgbaSha256!=='9'.repeat(64)||JSON.stringify(request.focusHandoff.activation.rect)!==JSON.stringify({left:200,top:8,right:320,bottom:32})))process.exit(4);
    const interrupted=process.env.FIXTURE_MODE.startsWith('interrupted'),before=process.env.FIXTURE_MODE==='before';
    const result={ok:!interrupted&&!before,mode:process.env.FIXTURE_MODE==='production'?'timedVoiceSend':'timedVoicePreview',targetGuarded:process.env.FIXTURE_MODE==='production',reason:interrupted?'DRAFT_HUMAN_ACTIVITY_CHANGED':before?'AUDIO_DEFAULT_CAPTURE_NOT_CABLE':null,
      recordingAttempted:!before,recordingPossible:interrupted,captureVerified:!before,captureSessionBound:!before,audioStarted:!before,playbackComplete:!interrupted&&!before,
      submitAttempted:!interrupted&&!before,submitInputApplied:!interrupted&&!before,cancelAttempted:false,cancelInputApplied:false,recordingEndedObserved:!interrupted&&!before,
      deliveryConfirmed:false,unattendedReady:false,systemSettingsChanged:false,microphoneOpened:false,queuedAudioLimitMs:20,deviceLatencyBounded:false,mouseParkMovesApplied:before?0:interrupted?2:3,sourceDurationMs:100,playbackElapsedMs:interrupted||before?0:100,recordingElapsedMs:before?0:451,timelineMs:{recordStart:before?0:1000,captureReady:before?0:1050,playStart:before?0:1051,playDrained:interrupted||before?0:1151,submit:interrupted||before?0:1351,recordEnded:interrupted||before?0:1451},privatePayload:request.waveFile};
    result.humanActivity=interrupted?{kind:'mouse',injected:true,ownMarker:false,lower32Matches:false,markerIsZero:true,message:512,timeAfterRecordStartMs:0,keyCode:65,x:123,y:456,privatePayload:request.waveFile}:null;
    result.audioPump=before?null:{dedicatedThread:true,pollIntervalMs:5,queuedAudioLimitMs:20,paddingStarvationCount:0,maxPumpGapMs:5.1,startToDrainMs:interrupted?0:100,drainToStopMs:interrupted?0:2,threadJoined:true,outputStopped:true,timerPeriodMs:1,timerResolutionRequested:true,timerResolutionAcquired:true,timerResolutionRestored:true,privatePayload:request.waveFile};
    if(process.env.FIXTURE_MODE.startsWith('interrupted-cancel')){result.cancelAttempted=true;result.cancelInputApplied=true;result.mouseParkMovesApplied=2;if(process.env.FIXTURE_MODE==='interrupted-cancelled'){result.recordingPossible=false;result.recordingEndedObserved=true;result.timelineMs.recordEnded=2000;}}
    if(process.env.FIXTURE_MODE.startsWith('interrupted-cleanup')){result.cancellationCleanup={version:1,stage:'focus',reason:'VOICE_FOCUS_CHANGED'};
      if(process.env.FIXTURE_MODE==='interrupted-cleanup-ended'){Object.assign(result,{cancelAttempted:true,cancelInputApplied:true,recordingPossible:false,recordingEndedObserved:true});result.timelineMs.recordEnded=2000;result.cancellationCleanup={version:1,stage:'ended',reason:null};}
      if(process.env.FIXTURE_MODE==='interrupted-cleanup-invalid-stage')result.cancellationCleanup.stage='unknown';
      if(process.env.FIXTURE_MODE==='interrupted-cleanup-private')result.cancellationCleanup.privatePayload=request.waveFile;
      if(process.env.FIXTURE_MODE==='interrupted-cleanup-false-ended')result.cancellationCleanup={version:1,stage:'ended',reason:null};}
    if(process.env.FIXTURE_MODE.startsWith('adaptive-report')){result.adaptiveRecordingUi={requested:true,bound:true,cancelScore:.99,submitScore:1,elapsedMs:82,pixelGuardsFixed:true};if(process.env.FIXTURE_MODE==='adaptive-report-invalid')result.adaptiveRecordingUi.privatePayload=request.waveFile;}
    if(request.session?.recordingUi?.uia&&process.env.FIXTURE_MODE!=='uia-report-missing'){
      result.uiaRecordingUi={version:1,requested:true,bound:true,stateChecks:7,conversationVerified:true,pixelsRead:false};
      result.mouseParkMovesApplied=0;result.uiaPointerMessagesPosted=6;
      if(process.env.FIXTURE_MODE==='uia-report-unbound')result.uiaRecordingUi.bound=false;
      if(process.env.FIXTURE_MODE==='uia-report-private')result.uiaRecordingUi.privatePayload=request.waveFile;
      if(process.env.FIXTURE_MODE==='uia-report-pixels')result.uiaRecordingUi.pixelsRead=true;
      if(process.env.FIXTURE_MODE==='uia-report-mixed')result.adaptiveRecordingUi={requested:true,bound:false};
      const pointerMode=process.env.FIXTURE_MODE;
      if(pointerMode.startsWith('uia-pointer-failure-')){
        const count=Number(pointerMode.slice('uia-pointer-failure-'.length)),played=count>=4;
        Object.assign(result,{ok:false,reason:count===6?'VOICE_RECORDING_END_UNCONFIRMED':'VOICE_UIA_POINTER_QUEUE_REJECTED',uiaPointerMessagesPosted:count,recordingAttempted:count>0,recordingPossible:count>0,captureVerified:played,captureSessionBound:played,audioStarted:played,playbackComplete:played,submitAttempted:played,submitInputApplied:count===6,recordingEndedObserved:false,playbackElapsedMs:played?100:0,recordingElapsedMs:count>0?451:0});
        result.uiaRecordingUi.bound=played;if(!played)result.audioPump=null;
        result.timelineMs={recordStart:count>0?1000:0,captureReady:played?1050:0,playStart:played?1051:0,playDrained:played?1151:0,submit:played?1351:0,recordEnded:0};
      }
      if(pointerMode==='uia-pointer-missing')delete result.uiaPointerMessagesPosted;
      if(pointerMode==='uia-pointer-null')result.uiaPointerMessagesPosted=null;
      if(pointerMode==='uia-pointer-string')result.uiaPointerMessagesPosted='6';
      if(pointerMode==='uia-pointer-negative')result.uiaPointerMessagesPosted=-1;
      if(pointerMode==='uia-pointer-fraction')result.uiaPointerMessagesPosted=5.5;
      if(pointerMode==='uia-pointer-overflow')result.uiaPointerMessagesPosted=7;
      if(pointerMode==='uia-pointer-incomplete-success')result.uiaPointerMessagesPosted=5;
      if(pointerMode==='uia-pointer-parked')result.mouseParkMovesApplied=1;
    }
    if(process.env.FIXTURE_MODE==='ocr-pointer-zero')result.uiaPointerMessagesPosted=0;
    if(process.env.FIXTURE_MODE==='ocr-pointer-nonzero')result.uiaPointerMessagesPosted=3;
    if(process.env.FIXTURE_MODE==='ocr-pointer-null')result.uiaPointerMessagesPosted=null;
    if(process.env.FIXTURE_MODE==='ocr-pointer-uia-proof'){result.uiaRecordingUi={version:1,requested:true,bound:true,stateChecks:7,conversationVerified:true,pixelsRead:false};result.uiaPointerMessagesPosted=6;result.mouseParkMovesApplied=0;}
    if(process.env.FIXTURE_MODE==='false-success')result.captureVerified=false;
    if(process.env.FIXTURE_MODE==='unparked-success')result.mouseParkMovesApplied=2;
    if(process.env.FIXTURE_MODE==='unjoined-success')result.audioPump.threadJoined=false;
    if(process.env.FIXTURE_MODE==='false-drain')result.audioPump.startToDrainMs=150;
    if(process.env.FIXTURE_MODE==='unrestored-timer')result.audioPump.timerResolutionRestored=false;
    if(process.env.FIXTURE_MODE==='bad-activity')result.humanActivity={kind:'keyboard',injected:true,ownMarker:true,message:256,timeAfterRecordStartMs:0};
    if(request.focusHandoff&&process.env.FIXTURE_MODE!=='handoff-missing'){
      result.focusHandoff={version:1,initialReturnAttempted:true,initialReturnConfirmed:true,backgroundEntered:true,backgroundActivityObserved:true,
        submitActivationAttempted:true,submitActivationConfirmed:true,finalReturnAttempted:true,finalReturnConfirmed:true,returnSkippedForHumanInput:false,
        initialForegroundElapsedMs:300,backgroundElapsedMs:100,submitForegroundElapsedMs:200,privatePayload:request.focusHandoff.returnWindow};
      if(process.env.FIXTURE_MODE==='handoff-invalid')result.focusHandoff.submitActivationAttempted=false;
      if(process.env.FIXTURE_MODE.startsWith('background-submit')){
        Object.assign(result.focusHandoff,{submitActivationAttempted:false,submitActivationConfirmed:false,finalReturnAttempted:false,finalReturnConfirmed:false,submitForegroundElapsedMs:0,
          backgroundSubmit:{version:1,attempted:true,applied:true,confirmed:true,foregroundUnchanged:true},
          foregroundIntervals:[{phase:'record-start',durationMs:300,includesContactNavigation:true,complete:true},{phase:'record-submit',durationMs:0,includesContactNavigation:false,complete:true}]});
        const mode=process.env.FIXTURE_MODE,b=result.focusHandoff.backgroundSubmit;
        if(mode==='background-submit-user-switch'){b.foregroundUnchanged=false;result.focusHandoff.foregroundIntervals[1].complete=false;}
        if(mode==='background-submit-unconfirmed'){result.ok=false;result.reason='VOICE_RECORDING_END_UNCONFIRMED';result.recordingPossible=true;result.recordingEndedObserved=false;result.timelineMs.recordEnded=0;b.confirmed=false;result.focusHandoff.foregroundIntervals[1].complete=false;}
        if(mode==='background-submit-private')b.window=100;
        if(mode==='background-submit-foreground')result.focusHandoff.submitActivationAttempted=true;
        if(mode==='background-submit-false-applied')b.applied=false;
        if(mode==='background-submit-false-ended')result.recordingEndedObserved=false;
        if(mode==='background-submit-nonzero-time')result.focusHandoff.submitForegroundElapsedMs=1;
        if(mode==='background-submit-positive-interval')result.focusHandoff.foregroundIntervals[1].durationMs=1;
      }
      if(process.env.FIXTURE_MODE.startsWith('interrupted-cancel')){Object.assign(result.focusHandoff,{submitActivationAttempted:false,submitActivationConfirmed:false,finalReturnAttempted:false,finalReturnConfirmed:false,submitForegroundElapsedMs:0,foregroundIntervals:[{phase:'record-start',durationMs:300,includesContactNavigation:true,complete:true},{phase:'record-cancel',durationMs:250,includesContactNavigation:false,complete:true}]});}
      if(process.env.FIXTURE_MODE.startsWith('handoff-pointer')){Object.assign(result.focusHandoff,{initialPointerRestored:true,finalPointerRestored:false,pointerRestoreSkipped:true});if(process.env.FIXTURE_MODE==='handoff-pointer-partial')delete result.focusHandoff.pointerRestoreSkipped;if(process.env.FIXTURE_MODE==='handoff-pointer-invalid')result.focusHandoff.finalPointerRestored='false';}
      if(process.env.FIXTURE_MODE.startsWith('handoff-caption')){Object.assign(result.focusHandoff,{initialCaption:{prepared:true,requestAttempted:true,clickAttempted:true,clickApplied:true,verified:true},submitCaption:{prepared:true,requestAttempted:true,clickAttempted:false,clickApplied:false,verified:false},submitVisibility:{version:1,raiseAttempted:true,requestAccepted:true,confirmed:true,initialBlockingCount:2,lastBlockingCount:0,elapsedMs:12,reason:'raised-visible'}});if(process.env.FIXTURE_MODE==='handoff-caption-private')result.focusHandoff.initialCaption.center={x:123,y:456};if(process.env.FIXTURE_MODE==='handoff-caption-false-proof')result.focusHandoff.initialCaption.verified=false;if(process.env.FIXTURE_MODE==='handoff-caption-obscured')result.focusHandoff.submitVisibility.lastBlockingCount=1;if(process.env.FIXTURE_MODE==='handoff-caption-visibility-private')result.focusHandoff.submitVisibility.hwnd='200';}
    }
    console.log(JSON.stringify(result));process.exit(result.ok?0:1);});`);
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^timed-voice-fixture-/); fs.rmSync(directory, { recursive: true, force: true }); });
  let starts = 0;
  return { root: directory, starts: () => starts, spawnImpl(executable, args, settings) {
    starts++; if(args[0]!=='--private-warm')assert.deepEqual(args, [mode.startsWith('mouse-') ? '--private-mouse-diagnostic' : mode === 'production' ? '--private-send' : '--private-once']); assert.equal(settings.windowsHide, true); assert.equal(settings.shell, false);
    return spawn(process.execPath, [source], { ...settings, env: { ...process.env, FIXTURE_MODE: mode } });
  } };
}

test('production voice uses separate protocol/state and rejects cross-target delivery ID reuse', async t => {
  const f = fixture(t, 'production'), value = productionOptions();
  const result = await runTimedVoiceSend({ ...value, ...f }); assert.equal(result.mode, 'timedVoiceSend'); assert.equal(result.targetGuarded, true);
  assert.equal(result.stopBarrier, false); assert.equal((await runTimedVoiceSend({ ...value, ...f })).reused, true); assert.equal(f.starts(), 1);
  value.session.target = 'other'; value.session.targetProof.target = 'other';
  await assert.rejects(runTimedVoiceSend({ ...value, ...f }), { code: 'VOICE_ID_CONFLICT' });
  assert.equal(fs.existsSync(path.join(f.root, 'state/native-voice-attempts', value.id + '.json')), true);
});
test('optional adaptive diagnostics retain only anonymous validated fields and never alter retry safety',async t=>{
  for(const mode of ['adaptive-report','adaptive-report-invalid']){const f=fixture(t,mode),result=await runTimedVoicePreview({...adaptiveOptions(),...f});assert.equal(result.ok,true);assert.equal(result.stopBarrier,false);
    if(mode==='adaptive-report')assert.deepEqual(result.adaptiveRecordingUi,{requested:true,bound:true,cancelScore:.99,submitScore:1,elapsedMs:82,pixelGuardsFixed:true});else assert.equal(result.adaptiveRecordingUi,undefined);
  }
});

test('UIA voice requires its native state proof and preserves it on same-ID recovery',async t=>{
  const f=fixture(t,'uia-report'),value={...uiaOptions(),...f},result=await runTimedVoicePreview(value);
  assert.equal(result.ok,true);assert.equal(result.stopBarrier,false);
  assert.equal(result.mouseParkMovesApplied,0);assert.equal(result.uiaPointerMessagesPosted,6);
  assert.deepEqual(result.uiaRecordingUi,{version:1,requested:true,bound:true,stateChecks:7,conversationVerified:true,pixelsRead:false});
  assert.deepEqual((await runTimedVoicePreview(value)).uiaRecordingUi,result.uiaRecordingUi);assert.equal(f.starts(),1);
});

test('UIA background submit keeps zero foreground time and never invents focus acquisition or return',async t=>{
  for(const mode of ['background-submit','background-submit-user-switch','background-submit-unconfirmed']){
    const f=fixture(t,mode),value={...uiaOptions(),...f,focusHandoff:focusHandoff()},result=await runTimedVoicePreview(value);
    assert.equal(result.ok,mode!=='background-submit-unconfirmed');assert.equal(result.focusHandoff.submitActivationAttempted,false);assert.equal(result.focusHandoff.finalReturnConfirmed,false);
    assert.equal(result.focusHandoff.submitForegroundElapsedMs,0);assert.equal(result.focusHandoff.backgroundSubmit.applied,true);
    assert.equal(result.focusHandoff.backgroundSubmit.confirmed,mode!=='background-submit-unconfirmed');
    assert.equal(result.focusHandoff.foregroundIntervals[1].complete,mode==='background-submit');
    assert.equal(result.stopBarrier,mode==='background-submit-unconfirmed');
    assert.equal((await runTimedVoicePreview(value)).reused,true);assert.equal(f.starts(),1);
  }
});
test('background submit cannot authorize OCR, positive foreground occupancy or inconsistent completion',async t=>{
  for(const mode of ['background-submit-private','background-submit-foreground','background-submit-false-applied','background-submit-false-ended','background-submit-nonzero-time','background-submit-positive-interval']){
    const f=fixture(t,mode),value={...uiaOptions(),...f,focusHandoff:focusHandoff()};await assert.rejects(runTimedVoicePreview(value),{code:'VOICE_PROTOCOL_INVALID'});assert.equal(f.starts(),1);
    const recovered=await runTimedVoicePreview(value);assert.equal(recovered.reused,true);assert.equal(recovered.stopBarrier,true);assert.equal(f.starts(),1);
  }
  const f=fixture(t,'background-submit');await assert.rejects(runTimedVoicePreview({...options(),...f,focusHandoff:focusHandoff()}),{code:'VOICE_PROTOCOL_INVALID'});
});

test('UIA voice retains every partial pointer prefix without retrying recording or submit',async t=>{
  for(let count=0;count<=6;count++){
    const f=fixture(t,'uia-pointer-failure-'+count),value={...uiaOptions(),...f},result=await runTimedVoicePreview(value);
    assert.equal(result.ok,false);assert.equal(result.uiaPointerMessagesPosted,count);assert.equal(result.mouseParkMovesApplied,0);
    assert.equal(result.recordingPossible,count>0);assert.equal(result.submitAttempted,count>=4);assert.equal(result.stopBarrier,count>0);
    assert.equal(result.reason,count===6?'VOICE_RECORDING_END_UNCONFIRMED':'VOICE_UIA_POINTER_QUEUE_REJECTED');
    const recovered=await runTimedVoicePreview(value);assert.equal(recovered.reused,true);assert.equal(recovered.uiaPointerMessagesPosted,count);assert.equal(f.starts(),1);
  }
});

test('production UIA success accepts six directed messages and zero physical park moves',async t=>{
  const f=fixture(t,'production'),value={...uiaOptions(productionOptions),...f},result=await runTimedVoiceSend(value);
  assert.equal(result.ok,true);assert.equal(result.targetGuarded,true);assert.equal(result.uiaPointerMessagesPosted,6);assert.equal(result.mouseParkMovesApplied,0);assert.equal(result.stopBarrier,false);
  assert.equal((await runTimedVoiceSend(value)).reused,true);assert.equal(f.starts(),1);
});

test('UIA pointer counts and parking mismatches retain the unknown barrier',async t=>{
  for(const mode of ['uia-pointer-missing','uia-pointer-null','uia-pointer-string','uia-pointer-negative','uia-pointer-fraction','uia-pointer-overflow','uia-pointer-incomplete-success','uia-pointer-parked']){
    const f=fixture(t,mode),value={...uiaOptions(),...f};await assert.rejects(runTimedVoicePreview(value),{code:'VOICE_PROTOCOL_INVALID'});
    assert.equal((await runTimedVoicePreview(value)).stopBarrier,true);assert.equal(f.starts(),1);
  }
});

test('OCR preserves legacy parking and accepts only absent or zero UIA pointer count',async t=>{
  for(const mode of ['success','ocr-pointer-zero']){
    const f=fixture(t,mode),result=await runTimedVoicePreview({...options(),...f});assert.equal(result.ok,true);assert.equal(result.mouseParkMovesApplied,3);assert.equal(result.uiaPointerMessagesPosted,mode==='success'?undefined:0);
  }
  for(const mode of ['ocr-pointer-nonzero','ocr-pointer-null','ocr-pointer-uia-proof']){
    const f=fixture(t,mode),value={...options(),...f};await assert.rejects(runTimedVoicePreview(value),{code:'VOICE_PROTOCOL_INVALID'});assert.equal((await runTimedVoicePreview(value)).stopBarrier,true);assert.equal(f.starts(),1);
  }
});

test('UIA voice missing, mixed, unbound or unsanitized native state retains an unknown barrier',async t=>{
  for(const mode of ['uia-report-missing','uia-report-unbound','uia-report-private','uia-report-pixels','uia-report-mixed']){
    const f=fixture(t,mode),value={...uiaOptions(),...f};await assert.rejects(runTimedVoicePreview(value),{code:'VOICE_PROTOCOL_INVALID'});
    assert.equal(f.starts(),1);const saved=JSON.parse(fs.readFileSync(path.join(f.root,'state/voice-preview/timed',value.id+'.json'),'utf8'));
    assert.equal(saved.state,'uncertain');assert.equal(saved.result.recordingPossible,true);
    assert.equal(fs.existsSync(path.join(f.root,'state/voice-preview/timed','active.json')),true);
    assert.equal((await runTimedVoicePreview(value)).stopBarrier,true);assert.equal(f.starts(),1);
  }
});

test('cancellation cleanup reports the failed step separately from the original interruption and never grants a retry',async t=>{
  for(const mode of ['interrupted-cleanup-focus','interrupted-cleanup-ended']){
    const f=fixture(t,mode),value={...options(),...f},result=await runTimedVoicePreview(value),ended=mode.endsWith('ended');
    assert.equal(result.reason,'DRAFT_HUMAN_ACTIVITY_CHANGED');assert.deepEqual(result.cancellationCleanup,{version:1,stage:ended?'ended':'focus',reason:ended?null:'VOICE_FOCUS_CHANGED'});
    assert.equal(result.recordingPossible,!ended);assert.equal(result.stopBarrier,!ended);assert.equal(result.submitAttempted,false);
    assert.equal((await runTimedVoicePreview(value)).reused,true);assert.equal(f.starts(),1);
  }
});
test('unknown or private cancellation diagnostics and false ended claims retain the unknown recording barrier',async t=>{
  for(const mode of ['interrupted-cleanup-invalid-stage','interrupted-cleanup-private','interrupted-cleanup-false-ended']){
    const f=fixture(t,mode),value={...options(),...f};await assert.rejects(runTimedVoicePreview(value),{code:'VOICE_PROTOCOL_INVALID'});
    assert.equal(fs.existsSync(path.join(f.root,'state/voice-preview/timed/active.json')),true);assert.equal(f.starts(),1);
  }
});

test('shared preview reuses a warmed process, validates the normal report and never commits its ID twice',async t=>{
  const f=fixture(t),warmMonitor=await warmVoiceMonitor(f),value={...options(),...f,focusHandoff:focusHandoff(),warmMonitor};
  t.after(()=>warmMonitor.close());const result=await runTimedVoicePreview(value);
  assert.equal(result.ok,true);assert.equal(result.focusHandoff.finalReturnConfirmed,true);assert.equal(f.starts(),1);
  const repeated=await runTimedVoicePreview(value);assert.equal(repeated.reused,true);assert.equal(f.starts(),1);
  const saved=fs.readFileSync(path.join(f.root,'state/voice-preview/timed',value.id+'.json'),'utf8');assert.equal(saved.includes('monitorId'),false);assert.equal(saved.includes('nonce'),false);
});
test('unchecked shared preview reaches native without claiming an empty draft and still commits the ID only once',async t=>{
  const f=fixture(t,'shared-unchecked'),value={...options(),...f,focusHandoff:focusHandoff()};value.session.draftPolicy='unchecked';value.session.emptyDraftConfirmed=false;
  const result=await runTimedVoicePreview(value);assert.equal(result.ok,true);assert.equal(result.deliveryConfirmed,false);
  assert.equal((await runTimedVoicePreview(value)).reused,true);assert.equal(f.starts(),1);
});

test('known warm pre-execution refusal clears the recording barrier but remains durable and cannot replay',async t=>{
  const f=fixture(t,'warm-rejected'),warmMonitor=await warmVoiceMonitor(f),value={...options(),...f,focusHandoff:focusHandoff(),warmMonitor};
  t.after(()=>warmMonitor.close());await assert.rejects(runTimedVoicePreview(value),{code:'DRAFT_UI_MUTEX_BUSY',nativeStarted:false,recordingPossible:false,submitAttempted:false});
  assert.equal(fs.existsSync(path.join(f.root,'state/voice-preview/timed/active.json')),false);
  const saved=JSON.parse(fs.readFileSync(path.join(f.root,'state/voice-preview/timed',value.id+'.json')));assert.equal(saved.state,'finished');assert.equal(saved.result.recordingAttempted,false);
  const repeated=await runTimedVoicePreview(value);assert.equal(repeated.reused,true);assert.equal(repeated.nativeStarted,false);assert.equal(repeated.stopBarrier,false);assert.equal(f.starts(),1);
});

test('shared production keeps its guarded production mode through the warmed process',async t=>{
  const f=fixture(t,'production'),warmMonitor=await warmVoiceMonitor(f);t.after(()=>warmMonitor.close());
  const result=await runTimedVoiceSend({...productionOptions(),...f,focusHandoff:focusHandoff(),warmMonitor});
  assert.equal(result.ok,true);assert.equal(result.mode,'timedVoiceSend');assert.equal(result.targetGuarded,true);assert.equal(result.nativeStarted,true);assert.equal(f.starts(),1);
});

test('warm handles cannot be forged or used without explicit focus handoff',async t=>{
  const f=fixture(t),warmMonitor=await warmVoiceMonitor(f);
  try{
    await assert.rejects(runTimedVoicePreview({...options(),...f,warmMonitor}),{code:'VOICE_WARMUP_REQUEST_INVALID'});
    await assert.rejects(runTimedVoicePreview({...options(),...f,warmMonitor:{...warmMonitor},focusHandoff:focusHandoff()}),{code:'VOICE_WARMUP_REQUEST_INVALID'});
    assert.equal(f.starts(),1);
  }finally{await warmMonitor.close();}
});

test('production failures before native entry provide explicit safe focus-release evidence', async t => {
  const f = fixture(t, 'production'), controller = new AbortController(); controller.abort();
  await assert.rejects(runTimedVoiceSend({ ...productionOptions(), ...f, signal: controller.signal }),
    { code: 'VOICE_CANCELLED_BEFORE_START', nativeStarted: false, recordingPossible: false, submitAttempted: false });
  fs.unlinkSync(path.join(f.root, 'state/ui-host/WechatVoicePreview.exe'));
  await assert.rejects(runTimedVoiceSend({ ...productionOptions(), ...f }),
    { code: 'VOICE_COMPONENT_MISSING', nativeStarted: false, recordingPossible: false, submitAttempted: false });
  assert.equal(f.starts(), 0);
});

test('completed preview only claims playback/click, cleans owned WAV and never replays the same id', async t => {
  const fixtureOptions = fixture(t), value = options();
  const result = await runTimedVoicePreview({ ...value, ...fixtureOptions });
  assert.equal(result.ok, true); assert.equal(result.deliveryConfirmed, false); assert.equal(result.stopBarrier, false);
  assert.equal(result.audioPump.threadJoined, true); assert.equal(result.audioPump.outputStopped, true); assert.equal(result.audioPump.startToDrainMs, result.playbackElapsedMs); assert.equal('privatePayload' in result.audioPump, false);
  assert.equal(result.audioPump.timerResolutionAcquired, true); assert.equal(result.audioPump.timerResolutionRestored, true);
  assert.equal(JSON.stringify(result).includes(fixtureOptions.root), false);
  const second = await runTimedVoicePreview({ ...value, ...fixtureOptions }); assert.equal(second.reused, true); assert.equal(fixtureOptions.starts(), 1);
  const files = fs.readdirSync(path.join(fixtureOptions.root, 'state/voice-preview/timed'));
  assert.deepEqual(files, [value.id + '.json']);
});
test('an interrupted clip clears its recording barrier only after confirmed cancellation and its old ID never records again',async t=>{
  for(const mode of ['interrupted-cancelled','interrupted-cancel-unconfirmed']){
    const f=fixture(t,mode),value={...options(),...f,focusHandoff:focusHandoff()},ended=mode==='interrupted-cancelled';
    const result=await runTimedVoicePreview(value);assert.equal(result.ok,false);assert.equal(result.reason,'DRAFT_HUMAN_ACTIVITY_CHANGED');
    assert.equal(result.submitAttempted,false);assert.equal(result.submitInputApplied,false);assert.equal(result.cancelInputApplied,true);
    assert.equal(result.recordingEndedObserved,ended);assert.equal(result.stopBarrier,!ended);assert.equal(result.deliveryConfirmed,false);
    assert.deepEqual(result.focusHandoff.foregroundIntervals.map(v=>v.phase),['record-start','record-cancel']);
    assert.equal(fs.existsSync(path.join(f.root,'state/voice-preview/timed/active.json')),!ended);
    const old=await runTimedVoicePreview(value);assert.equal(old.reused,true);assert.equal(old.stopBarrier,!ended);assert.equal(f.starts(),1);
  }
});

test('handoff result must confirm the requested phases and suppress other-app identity', async t => {
  const f = fixture(t), result = await runTimedVoicePreview({ ...options(), ...f, focusHandoff: focusHandoff() });
  assert.equal(result.focusHandoff.backgroundEntered, true);
  assert.equal(result.focusHandoff.backgroundActivityObserved, true);
  assert.equal(result.focusHandoff.finalReturnConfirmed, true);
  assert.equal('privatePayload' in result.focusHandoff, false);
  assert.equal(JSON.stringify(result).includes('processCreatedFileTimeUtc'), false);
  for (const mode of ['handoff-missing', 'handoff-invalid']) {
    const broken = fixture(t, mode);
    await assert.rejects(runTimedVoicePreview({ ...options(), ...broken, focusHandoff: focusHandoff() }), { code: 'VOICE_PROTOCOL_INVALID' });
    assert.equal(fs.existsSync(path.join(broken.root, 'state/voice-preview/timed/active.json')), true);
  }
});

test('activation anchor reaches the private native request but never the public report or durable result',async t=>{
  const f=fixture(t,'activation'),value={...options(),...f,focusHandoff:{...focusHandoff(),activation:activation()}};
  const result=await runTimedVoicePreview(value);
  assert.equal(result.ok,true);assert.equal(f.starts(),1);
  for(const serialized of [JSON.stringify(result),fs.readFileSync(path.join(f.root,'state/voice-preview/timed',value.id+'.json'),'utf8')]){
    assert.equal(serialized.includes('rgbaSha256'),false);assert.equal(serialized.includes('"activation"'),false);assert.equal(serialized.includes('9'.repeat(64)),false);
  }
});

test('optional pointer restoration diagnostics are a complete boolean group and do not imply delivery',async t=>{
  const f=fixture(t,'handoff-pointer'),result=await runTimedVoicePreview({...options(),...f,focusHandoff:focusHandoff()});
  assert.equal(result.ok,true);assert.equal(result.focusHandoff.initialPointerRestored,true);assert.equal(result.focusHandoff.finalPointerRestored,false);assert.equal(result.focusHandoff.pointerRestoreSkipped,true);assert.equal(result.deliveryConfirmed,false);
  for(const mode of ['handoff-pointer-partial','handoff-pointer-invalid']){
    const bad=fixture(t,mode);await assert.rejects(runTimedVoicePreview({...options(),...bad,focusHandoff:focusHandoff()}),{code:'VOICE_PROTOCOL_INVALID'});
  }
});

test('voice-local caption and complete visibility evidence are anonymous and cannot claim a blocked window is ready',async t=>{
  const f=fixture(t,'handoff-caption'),result=await runTimedVoicePreview({...options(),...f,focusHandoff:focusHandoff()});
  assert.deepEqual(result.focusHandoff.initialCaption,{prepared:true,requestAttempted:true,clickAttempted:true,clickApplied:true,verified:true});assert.equal(result.focusHandoff.submitVisibility.confirmed,true);assert.equal(result.focusHandoff.submitVisibility.lastBlockingCount,0);assert.equal(result.deliveryConfirmed,false);assert.equal(JSON.stringify(result).includes('returnWindow'),false);
  for(const mode of ['handoff-caption-private','handoff-caption-false-proof','handoff-caption-obscured','handoff-caption-visibility-private']){const bad=fixture(t,mode);await assert.rejects(runTimedVoicePreview({...options(),...bad,focusHandoff:focusHandoff()}),{code:'VOICE_PROTOCOL_INVALID'});}
});

test('human interruption retains recovery barrier and refuses another id without rerecording', async t => {
  const fixtureOptions = fixture(t, 'interrupted'), value = options();
  const result = await runTimedVoicePreview({ ...value, ...fixtureOptions });
  assert.equal(result.recordingPossible, true); assert.equal(result.stopBarrier, true); assert.equal(result.cancelAttempted, false);
  assert.deepEqual(result.humanActivity, { kind: 'mouse', injected: true, ownMarker: false, lower32Matches: false, markerIsZero: true, message: 512, timeAfterRecordStartMs: 0 });
  const saved = JSON.parse(fs.readFileSync(path.join(fixtureOptions.root, 'state/voice-preview/timed', value.id + '.json'), 'utf8'));
  assert.deepEqual(saved.result.humanActivity, result.humanActivity);
  for (const forbidden of ['keyCode', '"x"', '"y"', 'privatePayload', fixtureOptions.root]) assert.equal(JSON.stringify(saved).includes(forbidden), false);
  await assert.rejects(runTimedVoicePreview({ ...options(), id: '2'.repeat(64), ...fixtureOptions }), { code: 'VOICE_RECOVERY_BARRIER' });
  const repeated = await runTimedVoicePreview({ ...value, ...fixtureOptions }); assert.equal(repeated.reused, true); assert.equal(repeated.stopBarrier, true);
  assert.equal(fixtureOptions.starts(), 1);
});

test('operator recovery lock and transaction block new native recordings but never replay existing IDs', async t => {
  for (const name of ['lock','transaction.json']) {
    const f = fixture(t), folder = path.join(f.root, 'state/voice-operator-recovery'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, name), '{}');
    await assert.rejects(runTimedVoicePreview({ ...options(), ...f }), { code: 'VOICE_OPERATOR_RECOVERY_REQUIRED' }); assert.equal(f.starts(), 0);
    assert.equal(fs.existsSync(path.join(f.root, 'state/voice-preview/timed/active.json')), false);
  }
  const f = fixture(t, 'interrupted'), value = options(); await runTimedVoicePreview({ ...value, ...f });
  const folder = path.join(f.root, 'state/voice-operator-recovery'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'transaction.json'), '{}');
  const old = await runTimedVoicePreview({ ...value, ...f }); assert.equal(old.reused, true); assert.equal(f.starts(), 1);
});

test('unreadable output and inconsistent success retain uncertain barrier and suppress private payloads', async t => {
  for (const mode of ['lost', 'false-success', 'bad-activity', 'unparked-success', 'unjoined-success', 'false-drain', 'unrestored-timer']) {
    const f = fixture(t, mode);
    await assert.rejects(runTimedVoicePreview({ ...options(), ...f }), error => {
      assert.equal(error.code, 'VOICE_PROTOCOL_INVALID'); assert.equal(error.recordingPossible, true); assert.equal(error.submitAttempted, null);
      assert.equal(error.message.includes(f.root), false); return true;
    });
    assert.equal(fs.existsSync(path.join(f.root, 'state/voice-preview/timed/active.json')), true);
    assert.equal(f.starts(), 1);
  }
});

test('proved pre-recording routing refusal cleans the stop barrier without claiming capture', async t => {
  const f = fixture(t, 'before'); const result = await runTimedVoicePreview({ ...options(), ...f });
  assert.equal(result.ok, false); assert.equal(result.recordingAttempted, false); assert.equal(result.stopBarrier, false);
  assert.equal(result.reason, 'AUDIO_DEFAULT_CAPTURE_NOT_CABLE'); assert.equal(fs.existsSync(path.join(f.root, 'state/voice-preview/timed/active.json')), false);
});

test('already-aborted request never spawns, writes state, or changes the caller audio', async t => {
  const f = fixture(t), value = options(), expected = Buffer.from(value.audio), controller = new AbortController(); controller.abort();
  await assert.rejects(runTimedVoicePreview({ ...value, ...f, signal: controller.signal }), { code: 'VOICE_CANCELLED_BEFORE_START' });
  assert.deepEqual(value.audio, expected); assert.equal(f.starts(), 0);
  assert.equal(fs.existsSync(path.join(f.root, 'state/voice-preview/timed')), false);
});

function mouseOptions() { return { session: options().session, mouseTargetRect: { left: 20, top: 20, right: 30, bottom: 30 }, permission: { mouseMoveDiagnostic: true }, idleMs: 1000 }; }
test('mouse-only probe requires exact permission, bounded target and remaining calibration lifetime', () => {
  const value = mouseOptions(), request = validateMouseMarkerRequest(value);
  assert.equal(request.action, 'probeMouseMarker'); assert.deepEqual(request.permission, { mouseMoveDiagnostic: true });
  assert.equal('recordStartRect' in request.session, false); assert.equal('audio' in request, false);
  assert.throws(() => validateMouseMarkerRequest({ ...value, permission: {} }), { code: 'VOICE_PERMISSION_REQUIRED' });
  assert.throws(() => validateMouseMarkerRequest({ ...value, idleMs: 2000 }), { code: 'VOICE_MOUSE_SESSION_INVALID' });
  assert.throws(() => validateMouseMarkerRequest({ ...value, session: { ...value.session, expiresAtMs: Date.now() + 3000 } }), { code: 'VOICE_MOUSE_SESSION_INVALID' });
  assert.throws(() => validateMouseMarkerRequest({ ...value, mouseTargetRect: { ...value.mouseTargetRect, right: 900 } }), { code: 'VOICE_MOUSE_TARGET_INVALID' });
});
test('mouse-only probe reports own roundtrip or strict unowned stop without recording, audio, retries or durable state', async t => {
  for (const mode of ['mouse-success', 'mouse-unowned']) {
    const f = fixture(t, mode), result = await probeVoiceMouseMarker({ ...mouseOptions(), ...f });
    assert.equal(result.ok, mode === 'mouse-success'); assert.equal(result.mouseMoveInputApplied, true); assert.equal(f.starts(), 1);
    for (const key of ['recordingAttempted', 'audioStarted', 'submitAttempted', 'messageSent', 'systemSettingsChanged']) assert.equal(result[key], false);
    if (mode === 'mouse-unowned') { assert.equal(result.humanActivity.lower32Matches, true); assert.equal(result.humanActivity.ownMarker, false); assert.equal(result.humanActivity.timeAfterRecordStartMs, null); }
    assert.equal(JSON.stringify(result).includes('fixture'), false); assert.equal(JSON.stringify(result).includes('privatePayload'), false);
    assert.equal(fs.existsSync(path.join(f.root, 'state/voice-preview')), false);
  }
});
test('mouse-only malformed or cancelled result cannot claim no mouse move but still cannot start recording', async t => {
  const f = fixture(t, 'mouse-forbidden'); await assert.rejects(probeVoiceMouseMarker({ ...mouseOptions(), ...f }), { code: 'VOICE_PROTOCOL_INVALID', mouseMoveAttempted: null, mouseMoveInputApplied: null, recordingAttempted: false, audioStarted: false, submitAttempted: false });
  const fresh = fixture(t, 'mouse-success'), controller = new AbortController(); controller.abort();
  await assert.rejects(probeVoiceMouseMarker({ ...mouseOptions(), ...fresh, signal: controller.signal }), { code: 'VOICE_CANCELLED_BEFORE_START' }); assert.equal(fresh.starts(), 0);
});

test('optional foreground lease is copied only in the private native request and strictly validated',()=>{
  const value={...options(),focusHandoff:{...focusHandoff(),foregroundLease:{version:1,startedAtTickMs:123456,includesContactNavigation:true}}};
  const result=validateTimedVoiceRequest(value);assert.deepEqual(result.focusHandoff.foregroundLease,value.focusHandoff.foregroundLease);assert.notEqual(result.focusHandoff.foregroundLease,value.focusHandoff.foregroundLease);
  for(const lease of [null,{version:1,startedAtTickMs:0,includesContactNavigation:true},{version:1,startedAtTickMs:1.5,includesContactNavigation:true},{version:1,startedAtTickMs:1,includesContactNavigation:1},{version:1,startedAtTickMs:1,includesContactNavigation:true,private:'x'}])assert.throws(()=>validateTimedVoiceRequest({...value,focusHandoff:{...value.focusHandoff,foregroundLease:lease}}),{code:'VOICE_FOCUS_HANDOFF_INVALID'});
});
