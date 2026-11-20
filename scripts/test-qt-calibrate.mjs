import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {captureQtCalibration,captureQtVoiceCalibration,captureQtFocusCalibration} from './qt-calibrate.mjs';

const rect=(left,top,right,bottom)=>({left,top,right,bottom});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qt-calibrate-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const frames=path.join(root,'state/ui-host/qt-frames');fs.mkdirSync(frames,{recursive:true});const file=path.join(frames,'qt-'+ 'a'.repeat(32)+'.png');
  const image=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(image);image.writeUInt32BE(800,16);image.writeUInt32BE(600,20);fs.writeFileSync(file,image);
  const plan={layout:{header:rect(300,10,600,40),search:rect(60,10,250,50),firstResult:rect(60,80,250,120),profileOpen:rect(700,10,760,50),profileAlias:rect(300,80,600,120),selfOpen:rect(10,20,40,60),selfAlias:rect(50,80,290,120),editor:rect(300,450,780,540),send:rect(700,550,780,590)},selfCloseKey:'Escape',profileCloseKey:'Escape'};
  const binding={hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',foreground:true,clientRect:rect(0,0,800,600),captureRect:rect(10,10,810,610),dpi:120};
  const reader={account:{myWxid:'wxid_fixture_abc1',accountRef:'a'.repeat(64)},request:{wechatExecutable:path.join(root,'Weixin.exe'),wechatExecutableSha256:'b'.repeat(64)}};
  const calls=[];
  const clientFactory=options=>{assert.equal(options.enableInput,false);assert.equal(options.calibration,true);return{
    async request(action,values){calls.push(action);return{binding,pixelFormat:'rgba-row-major-opaque-v1',inputSent:false,executableVersion:'4.1.15.56',regions:values.regions.map(rect=>({rect,rgbaSha256:'c'.repeat(64)})),image:{file,sha256:crypto.createHash('sha256').update(image).digest('hex')}};},
    async release(){calls.push('release');return{processStopped:true};},async close(){calls.push('close');return{processStopped:true};}
  };};
  return{root,plan,clientFactory,check:()=>reader,probeAccount:async()=>({accountRef:reader.account.accountRef,evidence:{processId:42,processCreatedFileTimeUtc:'12345',processOpenedExpectedDatabase:true}}),calls};
}
test('readonly calibration measures binding and hashes but does not claim desktop identity or empty draft',async t=>{
  const f=fixture(t);const result=await captureQtCalibration(f);assert.equal(result.config.hwnd,'auto');assert.equal(result.config.account,'wxid_fixture');assert.equal(result.config.accountAlias,'wxid_fixture');assert.equal(result.config.layout.width,800);assert.equal(result.config.layout.dpi,120);
  assert.equal(result.summary.draftVerified,false);assert.equal(result.summary.targetVerified,false);assert.equal(result.summary.desktopAccountVerified,false);assert.equal(result.summary.inputSent,false);assert.equal(result.file,null);assert.deepEqual(f.calls,['capture','release']);
});
test('background layout capture needs explicit no-input evidence and does not require foreground',async t=>{
  const f=fixture(t);let evidence=true;
  const factory=options=>{const base=f.clientFactory(options);return{...base,async request(action,args){assert.equal(action,'captureLayout');const frame=await base.request(action,args);frame.binding.foreground=false;return{...frame,readOnly:true,focusChanged:false,authorizationGranted:!evidence};}};};
  const result=await captureQtCalibration({...f,background:true,clientFactory:factory});assert.equal(result.summary.inputSent,false);assert.equal(result.summary.draftVerified,false);assert.deepEqual(f.calls,['captureLayout','release']);
  evidence=false;await assert.rejects(captureQtCalibration({...f,background:true,clientFactory:factory}),{code:'UI_QT_CALIBRATION_CAPTURE_INVALID'});
});
test('calibration plan cannot inject identity verification flags, runtime dimensions or blank hashes',async t=>{
  for(const change of [p=>p.targetVerified=true,p=>p.layout.emptyEditorSha256='d'.repeat(64),p=>p.layout.focusActivateRgbaSha256='d'.repeat(64),p=>p.layout.dpi=120,p=>p.account='wxid_other']){
    const f=fixture(t);change(f.plan);await assert.rejects(captureQtCalibration(f),{code:'UI_QT_CALIBRATION_PLAN_INVALID'});assert.equal(f.calls.length,0);
  }
});

test('inactive titlebar calibration measures a matching visible region without raising or activating',async t=>{
  const f=fixture(t);await captureQtCalibration({...f,save:true});f.calls.length=0;const plan={rect:rect(350,8,450,22)};
  let alter=()=>{},warmup=true;
  const clientFactory=options=>{const base=f.clientFactory(options);return{...base,async request(action,values){f.calls.push(action);assert.equal(action,'inspectFocusActivation');if(warmup){warmup=false;throw Object.assign(new Error(),{code:'QT_ACTIVITY_WARMUP'});}const result={rect:values.rect,rgbaSha256:'d'.repeat(64),stableObservations:2,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,binding:{pid:42,processCreatedFileTimeUtc:'12345',foreground:false,clientRect:rect(0,0,800,600),dpi:120}};alter(result);return result;}};};
  const options={...f,plan,clientFactory,wait:async ms=>assert.equal(ms,1000),save:true};
  const result=await captureQtFocusCalibration(options);
  assert.deepEqual(result.config.layout.focusActivateRect,plan.rect);assert.equal(result.config.layout.focusActivateRgbaSha256,'d'.repeat(64));
  assert.equal(result.summary.inputSent,false);assert.equal(result.summary.inactiveTemplate,true);assert.deepEqual(f.calls,['inspectFocusActivation','inspectFocusActivation','release']);
  const recalibrated=await captureQtCalibration({...f,save:true,replace:true});assert.equal(recalibrated.config.layout.focusActivateRgbaSha256,'d'.repeat(64));
  for(const change of [r=>r.binding.foreground=true,r=>r.focusChanged=true,r=>r.inputSent=true,r=>r.stableObservations=1,r=>r.rect=rect(350,9,450,23)]){
    alter=change;await assert.rejects(captureQtFocusCalibration({...options,replace:true}),{code:'UI_QT_FOCUS_CAPTURE_INVALID'});
    assert.equal(JSON.parse(fs.readFileSync(result.file)).layout.focusActivateRgbaSha256,'d'.repeat(64));
  }
  await assert.rejects(captureQtCalibration({...f,plan:{...f.plan,layout:{...f.plan.layout,focusActivateRect:plan.rect}}}),{code:'UI_QT_CALIBRATION_PLAN_INVALID'});
});

test('search result identity region and bounded search heights survive calibration save and reload',async t=>{
  for(const heights of [{heightVariants:[280,363,400]},{heightRange:{min:120,max:400}}]){
    const f=fixture(t);
    f.plan.layout.searchResultIdentity=rect(60,60,250,140);
    f.plan.searchPopupCalibration={version:1,kind:'search',className:'QtFixtureSearch',ownerRelation:'same-thread-unowned',ownerDepth:0,windowRect:rect(50,55,280,205),clientWidth:230,clientHeight:150,style:-2147483648,extendedStyle:128,...heights};
    const result=await captureQtCalibration({...f,save:true});const saved=JSON.parse(fs.readFileSync(result.file,'utf8'));
    assert.deepEqual(saved.layout.searchResultIdentity,f.plan.layout.searchResultIdentity);
    for(const key of Object.keys(heights))assert.deepEqual(saved.searchPopupCalibration[key],heights[key]);
    const next=await captureQtCalibration({...f,save:true,replace:true});assert.deepEqual(next.config.searchPopupCalibration,saved.searchPopupCalibration);
  }
});
test('saving creates one local calibration and refuses overwrite without explicit replacement',async t=>{
  const f=fixture(t);const result=await captureQtCalibration({...f,save:true});assert.equal(fs.existsSync(result.file),true);assert.equal(JSON.parse(fs.readFileSync(result.file,'utf8')).layout.emptyEditorSha256,'c'.repeat(64));
  await assert.rejects(captureQtCalibration({...f,save:true}),{code:'UI_QT_CALIBRATION_EXISTS'});assert.equal((await captureQtCalibration({...f,save:true,replace:true})).summary.saved,true);
});
test('account mismatch closes native capture and writes no calibration',async t=>{
  const f=fixture(t);await assert.rejects(captureQtCalibration({...f,save:true,probeAccount:async()=>({accountRef:'f'.repeat(64)})}),{code:'UI_QT_ACCOUNT_UNVERIFIED'});assert.equal(f.calls.at(-1),'close');assert.equal(fs.existsSync(path.join(f.root,'state/ui-runtime/qt-visual.json')),false);
});
const voicePlan=()=>({recordStartRect:rect(300,400,340,430),mouseParkRect:rect(300,350,320,370),cancelRect:rect(350,460,390,500),submitRect:rect(650,460,690,500)});
test('voice template capture accepts rectangles only, saves measured pixels and makes no recording claim',async t=>{
  const f=fixture(t);await captureQtCalibration({...f,save:true});f.calls.length=0;
  const result=await captureQtVoiceCalibration({...f,plan:voicePlan(),save:true});
  assert.deepEqual(f.calls,['capture','release']);assert.equal(result.config.voice.recordingUi.focusHwnd,'same');assert.equal(result.config.voice.recordingUi.cancel.rgbaSha256,'c'.repeat(64));
  assert.equal(result.summary.recordingStarted,false);assert.equal(result.summary.recordingCancelled,false);assert.equal(result.summary.operatorMustCancel,true);assert.equal(result.summary.recordingUiVerified,false);
  assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);
  await assert.rejects(captureQtVoiceCalibration({...f,plan:{...voicePlan(),verified:true}}),{code:'UI_QT_VOICE_PLAN_INVALID'});
  await assert.rejects(captureQtVoiceCalibration({...f,plan:{...voicePlan(),cancelRect:voicePlan().submitRect}}),{code:'UI_QT_VOICE_PLAN_INVALID'});
});
test('text replacement preserves compatible voice templates and requires explicit discard after layout changes',async t=>{
  const f=fixture(t);await captureQtCalibration({...f,save:true});await captureQtVoiceCalibration({...f,plan:voicePlan(),save:true});
  const next=await captureQtCalibration({...f,save:true,replace:true});assert.equal(next.summary.voicePreserved,true);assert.equal(next.config.voice.recordingUi.cancel.rgbaSha256,'c'.repeat(64));
  f.plan.layout.editor.left=320;
  await assert.rejects(captureQtCalibration({...f,save:true,replace:true}),{code:'UI_QT_VOICE_RECALIBRATION_REQUIRED'});
  assert.equal(JSON.parse(fs.readFileSync(next.file)).layout.editor.left,300);
  const discarded=await captureQtCalibration({...f,save:true,replace:true,discardVoice:true});assert.equal(discarded.summary.voiceDiscarded,true);assert.equal(discarded.config.voice,undefined);
});
test('voice capture rejects a changed account and refuses to overwrite concurrent configuration edits',async t=>{
  const f=fixture(t),saved=await captureQtCalibration({...f,save:true});
  await assert.rejects(captureQtVoiceCalibration({...f,plan:voicePlan(),save:true,check:()=>({...f.check(),account:{...f.check().account,accountRef:'e'.repeat(64)}})}),{code:'UI_QT_ACCOUNT_CHANGED'});
  const probeAccount=async input=>{const original=JSON.parse(fs.readFileSync(saved.file));original.idleMs=2000;fs.writeFileSync(saved.file,JSON.stringify(original));return f.probeAccount(input);};
  await assert.rejects(captureQtVoiceCalibration({...f,plan:voicePlan(),save:true,probeAccount}),{code:'UI_QT_CALIBRATION_CHANGED'});
  assert.equal(JSON.parse(fs.readFileSync(saved.file)).voice,undefined);
});
test('calibration will not run beside an active service and keeps its barrier on uncertain cleanup',async t=>{
  const f=fixture(t);await captureQtCalibration({...f,save:true});const lock=path.join(f.root,'state/ui-service.lock');fs.writeFileSync(lock,JSON.stringify({pid:1,lease:'another-service'}));f.calls.length=0;
  await assert.rejects(captureQtVoiceCalibration({...f,plan:voicePlan(),save:true}),{code:'UI_QT_CALIBRATION_STOP_SERVICES'});assert.equal(f.calls.length,0);fs.unlinkSync(lock);
  const factory=options=>({...f.clientFactory(options),async request(){throw Object.assign(new Error(),{code:'UI_QT_TIMEOUT'});},async close(){throw Object.assign(new Error(),{code:'UI_QT_CLEANUP_UNCONFIRMED'});}});
  await assert.rejects(captureQtVoiceCalibration({...f,plan:voicePlan(),save:true,clientFactory:factory}),{code:'UI_QT_CLEANUP_UNCONFIRMED'});
  assert.equal(fs.existsSync(lock),true);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state/ui-runtime/qt-visual.json'))).voice,undefined);
});

test('saving a new calibration archives both exact layouts without transferring unknown pixel templates',async t=>{
  const f=fixture(t);const first=await captureQtCalibration({...f,save:true});
  const {selectQtLayoutProfile}=await import('./qt-layout-profiles.mjs');
  const original=JSON.parse(fs.readFileSync(first.file));
  const profileDir=path.join(f.root,'state/ui-runtime/qt-layout-profiles');assert.equal(fs.readdirSync(profileDir).length,1);
  const replacement=structuredClone(original);replacement.layout.width=1000;
  fs.writeFileSync(first.file,JSON.stringify(replacement));
  await captureQtCalibration({...f,save:true,replace:true});
  assert.equal(fs.readdirSync(profileDir).length,2);
  const inspection={version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:replacement.executableVersion,executableSha256:replacement.executableSha256,binding:{hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',clientRect:{left:0,top:0,right:1000,bottom:600},dpi:120}};
  assert.equal(selectQtLayoutProfile({root:f.root,currentConfig:original,inspection}).config.layout.width,1000);
});
