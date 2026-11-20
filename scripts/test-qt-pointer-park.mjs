import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {QtVisualDriver,validateQtConfig} from './qt-visual-driver.mjs';
import {resolveQtAutoLayout} from './qt-auto-layout.mjs';

const r=(left,top,right,bottom)=>({left,top,right,bottom}),hex=c=>c.repeat(64);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function config(){return {version:1,backend:'qt-visual',account:'wxid_fixture',accountRef:hex('a'),accountAlias:'fixture_alias',executable:path.resolve('Weixin.exe'),executableVersion:'4.1.15.56',executableSha256:hex('b'),hwnd:'100',idleMs:1000,ocrBackend:'rapidocr',layout:{width:800,height:600,dpi:96,
  header:r(310,20,600,60),search:r(80,20,260,60),firstResult:r(80,80,260,120),profileOpen:r(720,20,760,60),profileAlias:r(300,100,600,150),profileClose:r(700,80,730,110),selfOpen:r(10,20,50,60),selfAlias:r(60,100,300,150),selfClose:r(330,80,350,100),editor:r(300,450,780,550),send:r(700,560,780,590),emptyEditorSha256:hex('c')}};}
function draftFixture(amend=()=>{}){
  const cfg=config();cfg.layout.pointerParkRect=r(400,8,500,22);amend(cfg);
  const calls=[],responses={};let count=0;
  const binding={hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',dpi:96,foreground:true,clientRect:r(0,0,800,600),captureRect:r(10,10,810,610)};
  const client={async request(action,input){calls.push({action,input:structuredClone(input)});
    if(responses[action])return responses[action](input);
    if(action==='capture')return{binding:structuredClone(binding),pixelFormat:'rgba-row-major-opaque-v1',token:(++count).toString(16).padStart(32,'0'),epoch:'2'.repeat(32),revision:7,idleMs:2000,regions:input.regions.map(rect=>({rect:structuredClone(rect),rgbaSha256:JSON.stringify(rect)===JSON.stringify(cfg.layout.editor)?hex('c'):hex('d')}))};
    if(action==='movePointer')return{performed:true,attempted:true,revision:7,pointerParked:true,focusPreserved:true};
    if(action==='readDraft')return{draft:'',draftVerified:true,clipboardRestored:true,emptyTemplateMatched:true,revision:7};
    assert.fail(`unexpected action ${action}`);
  }};
  const driver=new QtVisualDriver({root:path.resolve('.'),config:cfg,client,wait:async()=>{}});
  driver.transaction={epoch:'2'.repeat(32),revision:7,pid:42,created:'12345'};
  return{cfg,calls,responses,binding,driver};
}

test('pointer park accepts only exact native title geometry without an activation hash',()=>{
  for(const area of [r(160,0,180,8),r(440,8,640,48),r(400,8,500,22)]){
    const c=config();c.layout.pointerParkRect=area;const checked=validateQtConfig(c);
    assert.deepEqual(checked.layout.pointerParkRect,area);assert.notEqual(checked.layout.pointerParkRect,area);
    assert.equal(checked.layout.focusActivateRect,undefined);assert.equal(checked.layout.focusActivateRgbaSha256,undefined);
  }
  for(const area of [null,[],{},r(159,8,200,22),r(500,8,641,22),r(400,-1,500,22),r(400,9,500,49),r(400,8,419,22),r(200,8,401,22),r(400,8,500,15),r(400,0,500,41),r(400.5,8,500,22),{...r(400,8,500,22),rgbaSha256:hex('d')},{...r(400,8,500,22),activate:true}]){
    const c=config();c.layout.pointerParkRect=area;assert.throws(()=>validateQtConfig(c),{code:'UI_QT_POINTER_PARK_INVALID'});
  }
  const narrower=config();narrower.layout.width=600;narrower.layout.pointerParkRect=r(400,8,460,22);
  assert.throws(()=>validateQtConfig(narrower),{code:'UI_QT_POINTER_PARK_INVALID'});
});
test('pointer geometry cannot replace missing or malformed focus activation credentials',()=>{
  const f=draftFixture();assert.deepEqual(f.driver.focusActivation(),{});
  for(const amend of [c=>c.layout.focusActivateRect=r(400,8,500,22),c=>c.layout.focusActivateRgbaSha256=hex('d'),c=>{c.layout.focusActivateRect=r(400,8,500,22);c.layout.focusActivateRgbaSha256='invalid';}]){
    const c=config();c.layout.pointerParkRect=r(400,8,500,22);amend(c);assert.throws(()=>validateQtConfig(c),{code:'UI_QT_FOCUS_CALIBRATION_INVALID'});
  }
});

test('adaptive blank caption supports background activation without an inactive calibration',()=>{
  const f=draftFixture();f.driver.config.layoutMode='adaptive-v1';
  assert.deepEqual(f.driver.focusActivation(),{focusActivation:{rect:f.cfg.layout.pointerParkRect,mode:'blank-caption-v1'}});
  delete f.driver.config.layout.pointerParkRect;assert.deepEqual(f.driver.focusActivation(),{});
});
test('foreground draft parking gets a fresh exact rectangle anchor and preserves subsequent complete draft checks',async()=>{
  const f=draftFixture();assert.equal((await f.driver.readDraft()).draft,'');
  assert.deepEqual(f.calls.map(c=>c.action),['capture','movePointer','capture','readDraft','capture']);
  const [before,move,header,draft,after]=f.calls;
  assert.deepEqual(before.input.regions,[f.cfg.layout.pointerParkRect]);assert.equal(before.input.surface,'main');
  assert.deepEqual(move.input.rect,f.cfg.layout.pointerParkRect);assert.equal(move.input.token,'1'.padStart(32,'0'));
  assert.equal(move.input.epoch,f.driver.transaction.epoch);assert.equal(move.input.revision,7);assert.equal(move.input.idleMs,1000);
  assert.equal(move.input.focusActivation,undefined);assert.deepEqual(header.input.regions,[f.cfg.layout.header]);
  assert.equal(draft.input.token,'2'.padStart(32,'0'));assert.deepEqual(draft.input.editorRect,f.cfg.layout.editor);
  assert.equal(draft.input.emptyEditorSha256,hex('c'));assert.deepEqual(draft.input.emptyEditorSha256s,[hex('c')]);
  assert.deepEqual(after.input.regions,[f.cfg.layout.header,f.cfg.layout.editor]);
  assert.deepEqual(f.driver.focusActivation(),{});
});
test('explicit pointer park overrides old focus geometry while legacy and absent park configs keep working',async()=>{
  for(const mode of ['both','legacy','neither']){
    const f=draftFixture(c=>{if(mode!=='both')delete c.layout.pointerParkRect;if(mode!=='neither'){c.layout.focusActivateRect=r(200,8,300,22);c.layout.focusActivateRgbaSha256=hex('e');}});
    await f.driver.readDraft();const move=f.calls.find(call=>call.action==='movePointer');
    if(mode==='neither'){assert.equal(move,undefined);assert.deepEqual(f.calls.map(c=>c.action),['capture','readDraft','capture']);}
    else{const area=mode==='both'?f.cfg.layout.pointerParkRect:f.cfg.layout.focusActivateRect;assert.deepEqual(f.calls[0].input.regions,[area]);assert.deepEqual(move.input.rect,area);assert.deepEqual(f.driver.focusActivation(),{focusActivation:{rect:f.cfg.layout.focusActivateRect,rgbaSha256:hex('e')}});}
  }
});
test('stale transaction or nonforeground observation prevents pointer movement and draft read',async()=>{
  for(const mutate of [f=>f.driver.transaction.revision++,f=>f.driver.transaction.created='999',f=>f.binding.foreground=false,f=>f.binding.dpi=120]){
    const f=draftFixture();mutate(f);await assert.rejects(f.driver.readDraft());assert.deepEqual(f.calls.map(c=>c.action),['capture']);
  }
});
test('native guarded move failure never retries movement or proceeds to clipboard access',async()=>{
  for(const code of ['QT_HUMAN_ACTIVITY_CHANGED','QT_PIXELS_CHANGED','QT_CLICK_OBSCURED','QT_POINTER_PARK_INVALID']){
    const f=draftFixture();f.responses.movePointer=()=>{throw Object.assign(new Error(code),{code,attempted:false});};
    await assert.rejects(f.driver.readDraft(),{code});assert.deepEqual(f.calls.map(c=>c.action),['capture','movePointer']);
  }
  for(const field of ['performed','pointerParked','focusPreserved']){
    const f=draftFixture();f.responses.movePointer=()=>({performed:true,attempted:true,revision:7,pointerParked:true,focusPreserved:true,[field]:false});
    await assert.rejects(f.driver.readDraft(),{code:'UI_QT_POINTER_PARK_UNCONFIRMED'});assert.deepEqual(f.calls.map(c=>c.action),['capture','movePointer']);
  }
});
test('parking does not authorize an unverified draft, nonempty template or unrestored clipboard',async()=>{
  for(const field of ['draftVerified','clipboardRestored','emptyTemplateMatched']){
    const f=draftFixture();f.responses.readDraft=()=>({draft:'',draftVerified:true,clipboardRestored:true,emptyTemplateMatched:true,revision:7,[field]:false});
    await assert.rejects(f.driver.readDraft(),{code:'UI_QT_DRAFT_UNVERIFIED'});
    assert.deepEqual(f.calls.map(c=>c.action),['capture','movePointer','capture','readDraft']);
  }
});

function autoFixture(t,foreground){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qt-pointer-layout-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'state/ui-host/qt-frames');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`qt-${'1'.repeat(32)}.png`),bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(1000,16);bytes.writeUInt32BE(800,20);fs.writeFileSync(file,bytes);
  const layout={header:r(310,40,850,90),profileOpen:r(320,45,420,70),search:r(80,40,250,80),selfOpen:r(10,40,50,80),editor:r(303,603,977,730),send:r(910,730,970,760),focusActivateRect:r(500,8,560,22)};
  const cfg=config();Object.assign(cfg,{executable:path.join(root,'Weixin.exe'),hwnd:'auto',layoutMode:'adaptive-v1',selfCloseKey:'Escape',profileCloseKey:'Escape'});
  const popup=kind=>({version:1,kind,className:'QtFixtureWindow',ownerRelation:'same-thread-unowned',ownerDepth:0,style:-2147483648,extendedStyle:128});
  cfg.selfSurface={popupCalibration:popup('profile')};cfg.profileSurface={popupCalibration:popup('profile')};cfg.searchPopupCalibration=popup('search');
  cfg.layout={width:1000,height:800,dpi:120,...layout,focusActivateRgbaSha256:hex('f'),pointerParkRect:r(180,8,240,22),emptyEditorSha256:hex('c')};
  const binding={hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',dpi:120,clientRect:r(0,0,1000,800),captureRect:r(-1000,0,0,800),foreground};
  const inspection={version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:cfg.executableVersion,executableSha256:cfg.executableSha256,binding};
  const evidence=[{kind:'long-navigation-divider',support:1},{kind:'long-chat-divider',support:1},{kind:'editor-rounded-frame',rect:r(300,600,980,780)},{kind:'search-label-and-control',confidence:1},{kind:'send-label-and-control',confidence:1},{kind:'record-template',score:1},{kind:'self-avatar-component',rect:layout.selfOpen},{kind:'chat-title-text',rect:layout.profileOpen,confidence:1}];
  const located={version:1,ok:true,imageSha256:digest(bytes),width:1000,height:800,dpi:120,executableVersion:cfg.executableVersion,readOnly:true,inputSent:false,emptyDraftAuthorized:false,identityVerified:false,recordingState:false,layout,anchors:{editorFrame:r(300,600,980,780),toolbar:r(305,730,975,776),recordStartRect:r(850,730,880,760)},evidence};
  const regions={...layout,recordStartRect:located.anchors.recordStartRect},regionHashes=Object.fromEntries(Object.keys(regions).map(key=>[key,hex(key==='editor'?'c':'d')]));
  const pixels={version:1,ok:true,imageSha256:digest(bytes),width:1000,height:800,dpi:120,readOnly:true,inputSent:false,emptyDraftAuthorized:false,identityVerified:false,fullEditorExamined:true,caretCandidate:false,regionHashes,emptyEditorSha256s:[hex('c')]};
  const calls=[],client={async request(action,input){calls.push({action,input});if(action==='inspectLayout')return structuredClone(inspection);assert.equal(action,'captureLayout');return{readOnly:true,inputSent:false,focusChanged:false,authorizationGranted:false,binding:structuredClone(binding),executableVersion:cfg.executableVersion,pixelFormat:'rgba-row-major-opaque-v1',regions:input.regions.map(rect=>({rect:structuredClone(rect),rgbaSha256:regionHashes[Object.keys(regions).find(key=>JSON.stringify(regions[key])===JSON.stringify(rect))]})),image:{file,sha256:digest(bytes)}};}};
  const dependencies={runPython:async request=>structuredClone(request.script==='locate-wechat-layout.py'?located:pixels)};
  return{root,config:cfg,inspection,client,dependencies,located,calls,file};
}
test('readonly automatic foreground layout supplies pointer geometry with no activation authority',async t=>{
  const f=autoFixture(t,true),value=await resolveQtAutoLayout(f,f.dependencies);
  assert.equal(value.verified,true);assert.deepEqual(value.config.layout.pointerParkRect,f.located.layout.focusActivateRect);
  assert.equal(value.config.layout.focusActivateRect,undefined);assert.equal(value.config.layout.focusActivateRgbaSha256,undefined);
  assert.deepEqual(f.calls.map(c=>c.action),['captureLayout','captureLayout','inspectLayout']);
  assert.equal(f.calls[1].input.regions.length,8);assert.equal(fs.existsSync(f.file),false);
});
test('readonly automatic background layout preserves separate proven activation and fresh pointer geometry',async t=>{
  const f=autoFixture(t,false),value=await resolveQtAutoLayout(f,f.dependencies);
  assert.deepEqual(value.config.layout.pointerParkRect,f.located.layout.focusActivateRect);
  assert.deepEqual(value.config.layout.focusActivateRect,f.located.layout.focusActivateRect);assert.equal(value.config.layout.focusActivateRgbaSha256,hex('d'));
  assert.deepEqual(f.calls.map(c=>c.action),['captureLayout','captureLayout','inspectLayout']);
});
