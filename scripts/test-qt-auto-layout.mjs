import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {resolveQtAutoLayout,locateQtContactPanel,verifyQtContactPanelClosed,locateQtMainTitle,inspectQtPanelEditor,runQtLayoutPython} from './qt-auto-layout.mjs';
import {QtActionsClient} from './qt-visual-driver.mjs';
const r=(left,top,right,bottom)=>({left,top,right,bottom}),hex=c=>c.repeat(64),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qt-auto-layout-'));t.after(()=>fs.rmSync(root,{recursive:true}));
  const directory=path.join(root,'state/ui-host/qt-frames');fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'qt-'+ '1'.repeat(32)+'.png');
  const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(1000,16);bytes.writeUInt32BE(800,20);fs.writeFileSync(file,bytes);
  const currentFile=path.join(directory,'qt-'+ '2'.repeat(32)+'.png'),currentBytes=Buffer.from(bytes);currentBytes[32]=1;fs.writeFileSync(currentFile,currentBytes);
  const layout={header:r(310,40,850,90),profileOpen:r(320,45,420,70),search:r(80,40,250,80),selfOpen:r(10,40,50,80),editor:r(303,603,977,730),send:r(910,730,970,760),focusActivateRect:r(500,8,560,22)};
  const config={version:1,backend:'qt-visual',account:'wxid_fixture',accountRef:hex('a'),accountAlias:'fixture_alias',executable:path.join(root,'Weixin.exe'),executableVersion:'4.1.15.56',executableSha256:hex('b'),hwnd:'auto',idleMs:1000,ocrBackend:'rapidocr',layout:{width:1000,height:800,dpi:96,...layout,profileAlias:r(300,100,600,140),selfAlias:r(50,100,290,140),firstResult:r(60,90,250,120),emptyEditorSha256:hex('c')},selfCloseKey:'Escape',profileCloseKey:'Escape',selfSurface:{popupCalibration:{}},profileSurface:{popupCalibration:{}},searchPopupCalibration:{},voice:{oldUnknownTemplate:true}};
  config.layout.focusActivateRgbaSha256=hex('d');
  const popup=(kind='profile')=>({version:1,kind,className:'QtFixtureWindow',ownerRelation:'same-thread-unowned',ownerDepth:0,windowRect:kind==='search'?r(60,80,360,240):r(20,60,380,260),clientWidth:kind==='search'?300:360,clientHeight:kind==='search'?160:200,style:-2147483648,extendedStyle:128});
  for(const key of ['selfSurface','profileSurface'])config[key]={width:360,height:200,alias:r(20,60,320,110),close:r(330,10,350,30),popupCalibration:popup()};
  config.searchPopupCalibration=popup('search');
  const binding={hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',dpi:120,clientRect:r(0,0,1000,800),captureRect:r(-1000,0,0,800),foreground:false};
  const inspection={version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:config.executableVersion,executableSha256:config.executableSha256,binding};
  const evidence=['long-navigation-divider','long-chat-divider','editor-rounded-frame','search-label-and-control','send-label-and-control','record-template','self-avatar-component','chat-title-text'].map(kind=>({kind}));
  Object.assign(evidence[0],{support:1});Object.assign(evidence[1],{support:1});Object.assign(evidence[2],{rect:r(300,600,980,780)});Object.assign(evidence[3],{confidence:1});Object.assign(evidence[4],{confidence:1});Object.assign(evidence[5],{score:1});Object.assign(evidence[6],{rect:layout.selfOpen});Object.assign(evidence[7],{rect:layout.profileOpen,confidence:1});
  const located={version:1,ok:true,imageSha256:hash(bytes),width:1000,height:800,dpi:120,executableVersion:config.executableVersion,readOnly:true,inputSent:false,emptyDraftAuthorized:false,identityVerified:false,recordingState:false,layout,anchors:{editorFrame:r(300,600,980,780),toolbar:r(305,730,975,776),recordStartRect:r(850,730,880,760)},evidence};
  const regions={...layout,recordStartRect:located.anchors.recordStartRect},regionHashes=Object.fromEntries(Object.keys(regions).map(key=>[key,hex(key==='editor'?'c':'d')]));
  const pixels={version:1,ok:true,imageSha256:hash(bytes),width:1000,height:800,dpi:120,readOnly:true,inputSent:false,emptyDraftAuthorized:false,identityVerified:false,fullEditorExamined:true,caretCandidate:false,regionHashes,emptyEditorSha256s:[hex('c')]};
  const currentPixels={...structuredClone(pixels),imageSha256:hash(currentBytes)},pythonCalls=[];
  const calls=[],client={async request(action,input){calls.push({action,input});if(action==='inspectLayout')return structuredClone(inspection);assert.equal(action,'captureLayout');const current=input.regions.length>0,hashes=current?currentPixels.regionHashes:regionHashes;return {readOnly:true,inputSent:false,focusChanged:false,authorizationGranted:false,binding:structuredClone(binding),executableVersion:config.executableVersion,pixelFormat:'rgba-row-major-opaque-v1',regions:input.regions.map(rect=>({rect:structuredClone(rect),rgbaSha256:hashes[Object.keys(regions).find(key=>JSON.stringify(regions[key])===JSON.stringify(rect))]??hex('f')})),image:input.image?(current?{file:currentFile,sha256:hash(currentBytes)}:{file,sha256:hash(bytes)}):null};}};
  const dependencies={runPython:async request=>{pythonCalls.push(request);return request.script==='locate-wechat-layout.py'?structuredClone(located):structuredClone(request.input.image===currentFile?currentPixels:pixels);},popupCalibration:(_value,kind)=>({kind}),validateConfig:value=>value};
  return {root,file,currentFile,config,inspection,client,dependencies,located,pixels,currentPixels,calls,pythonCalls};
}
test('automatic candidate binds full image, observed anchors, empty candidates and later pixels without input authority',async t=>{
  const f=fixture(t),value=await resolveQtAutoLayout(f,f.dependencies);assert.equal(value.verified,true);assert.equal(value.config.layoutMode,'adaptive-v1');assert.equal(value.config.layout.dpi,120);assert.deepEqual(value.config.layout.editor,f.located.layout.editor);assert.deepEqual(value.config.voice.recordStartRect,f.located.anchors.recordStartRect);assert.equal(value.config.voice.recordingUi.adaptive.version,1);assert.equal(value.config.layout.profileMember,undefined);assert.equal(value.config.layout.emptyEditorSha256,hex('c'));assert.equal(fs.existsSync(f.file),false);
  assert.deepEqual(f.calls.map(call=>call.action),['captureLayout','captureLayout','inspectLayout']);assert.equal(f.calls.some(call=>call.action==='click'),false);assert.equal(fs.existsSync(path.join(f.root,'state/ui-runtime/qt-layout-profiles')),false);
});
test('missing click anchors, wrong source binding and shortened editor area are never accepted',async t=>{
  for(const mutate of [f=>delete f.located.layout.selfOpen,f=>f.located.evidence.pop(),f=>f.located.imageSha256=hex('f'),f=>f.located.layout.editor.bottom-=20,f=>f.pixels.emptyDraftAuthorized=true,f=>f.pixels.fullEditorExamined=false,f=>f.pixels.regionHashes.editor='bad']){
    const f=fixture(t);mutate(f);await assert.rejects(resolveQtAutoLayout(f,f.dependencies));assert.equal(f.calls.some(call=>call.action==='click'),false);assert.equal(fs.existsSync(f.file),false);
  }
});

function pinnedHeaderFixture(t){
  const f=fixture(t);Object.assign(f.located.anchors,{chatDivider:300,chromeBottom:40,headerBottom:94});
  f.located.evidence[7].headerBanner={method:'pinned-message-glyph-and-divider-v1',iconRect:r(320,102,342,122),score:.99,separatorY:152,titleRowBottom:94};return f;
}
test('pinned-message evidence keeps all eight recaptured anchors and excludes its content from title',async t=>{
  const f=pinnedHeaderFixture(t),value=await resolveQtAutoLayout(f,f.dependencies);
  assert.equal(value.verified,true);assert.equal(f.calls[1].input.regions.length,8);
  assert.ok(value.config.layout.header.bottom<f.located.evidence[7].headerBanner.iconRect.top);
});
test('pinned-message fallback rejects incomplete, weak, shifted and title-overlapping evidence',async t=>{
  for(const mutate of [b=>delete b.score,b=>b.score=.939,b=>b.method='unknown',b=>b.extra=true,b=>b.separatorY=130,b=>b.separatorY=181,
    b=>b.iconRect.left=300,b=>b.iconRect.top=80,b=>b.iconRect.bottom=150,b=>b.titleRowBottom=95,
    (_b,f)=>f.located.layout.header.bottom=104,(_b,f)=>f.located.anchors.headerBottom=100,(_b,f)=>f.located.layout.search.bottom=101]){
    const f=pinnedHeaderFixture(t);mutate(f.located.evidence[7].headerBanner,f);
    await assert.rejects(resolveQtAutoLayout(f,f.dependencies),{code:'UI_QT_LAYOUT_ANCHORS_UNVERIFIED'});
    assert.equal(f.calls.length,1);assert.equal(f.calls.some(call=>call.action==='click'),false);
  }
});

function measured96(f){
  f.inspection.binding.dpi=f.located.dpi=f.pixels.dpi=96;
  const editor=f.located.layout.editor,proof={version:1,method:'signed-frame-gradient-96',...Object.fromEntries(['left','top','right'].map(side=>[side,{position:editor[side],support:1}]))};
  Object.assign(f.located.evidence[2],{contentRect:structuredClone(editor),innerEdges:proof});return f;
}
test('96 DPI editor uses measured frame inner sides and preserves complete height without persistent authority',async t=>{
  const f=measured96(fixture(t));const result=await resolveQtAutoLayout(f,f.dependencies);
  assert.deepEqual(result.config.layout.editor,f.located.evidence[2].contentRect);assert.equal(result.config.layout.dpi,96);
  assert.equal(f.calls[1].input.regions.some(area=>JSON.stringify(area)===JSON.stringify(f.located.layout.editor)),true);
});
test('measured inner sides reject missing, weak, outside, shortened and wrong-DPI evidence',async t=>{
  for(const mutate of [f=>delete f.located.evidence[2].innerEdges,f=>f.located.evidence[2].innerEdges.left.support=.94999,
    f=>f.located.evidence[2].innerEdges.method='unknown',f=>f.located.evidence[2].innerEdges.extra=true,
    f=>f.located.evidence[2].innerEdges.left.position+=1,f=>f.located.evidence[2].contentRect.bottom-=10,
    f=>{f.located.layout.editor.left+=8;f.located.evidence[2].contentRect.left+=8;f.located.evidence[2].innerEdges.left.position+=8;},
    f=>{f.located.dpi=f.pixels.dpi=f.inspection.binding.dpi=120;}]){
    const f=measured96(fixture(t));mutate(f);
    await assert.rejects(resolveQtAutoLayout(f,f.dependencies),{code:'UI_QT_LAYOUT_EDITOR_COVERAGE_UNVERIFIED'});
    assert.equal(f.calls.length,1);
  }
});
test('current program build changes and cancellation cannot create automatic layout candidates',async t=>{
  const f=fixture(t);f.inspection.executableSha256=hex('e');assert.equal(await resolveQtAutoLayout(f,f.dependencies),null);assert.equal(f.calls.length,0);
  const controller=new AbortController();controller.abort();await assert.rejects(resolveQtAutoLayout({...f,signal:controller.signal},f.dependencies),{code:'UI_QT_CANCELLED'});
});
test('later pixel or process change rejects candidate without active template reuse',async t=>{
  for(const kind of ['pixels','process']){const f=fixture(t),run=f.client.request;let captures=0;f.client.request=async(action,input)=>{const value=await run(action,input);if(action==='captureLayout'&&++captures===2){if(kind==='pixels')value.regions[0].rgbaSha256=hex('e');else value.binding.processCreatedFileTimeUtc='999';}return value;};await assert.rejects(resolveQtAutoLayout(f,f.dependencies));}
});
test('unrelated chat animation cannot require whole-window stability while every action anchor is rechecked',async t=>{
  const f=fixture(t),request=f.client.request;f.client.request=async(action,input)=>{
    if(action==='captureLayout'&&f.calls.length===0){assert.deepEqual(input.regions,[]);}
    if(action==='captureLayout'&&f.calls.length===1){assert.equal(input.regions.length,8);assert.equal(input.regions.some(area=>area.left===0&&area.top===0&&area.right===1000&&area.bottom===800),false);}
    return request(action,input);
  };
  assert.equal((await resolveQtAutoLayout(f,f.dependencies)).verified,true);
  assert.equal(f.calls[1].input.image,true);assert.deepEqual(f.calls[1].input.regions.map(area=>JSON.stringify(area)).sort(),Object.values({...f.located.layout,recordStartRect:f.located.anchors.recordStartRect}).map(area=>JSON.stringify(area)).sort());
});
function caretPhase(f){
  f.currentPixels.regionHashes.editor=hex('e');f.currentPixels.caretCandidate=true;f.currentPixels.emptyEditorSha256s=[hex('e'),hex('c')];return f;
}
test('no-caret to real caret transition revalidates the complete second image and stores only its two candidates',async t=>{
  const f=caretPhase(fixture(t)),value=await resolveQtAutoLayout(f,f.dependencies);
  assert.deepEqual(value.config.layout.emptyEditorSha256s,[hex('e'),hex('c')]);assert.equal(value.config.layout.emptyEditorSha256,hex('e'));
  assert.deepEqual(f.pythonCalls.map(call=>call.script),['locate-wechat-layout.py','qt-auto-layout-image.py','qt-auto-layout-image.py']);
  assert.equal(f.pythonCalls[2].input.image,f.currentFile);assert.equal(f.pythonCalls[2].input.imageSha256,f.currentPixels.imageSha256);
  assert.deepEqual(f.pythonCalls[2].input.regions,f.pythonCalls[1].input.regions);
  assert.deepEqual(f.calls.map(call=>call.action),['captureLayout','captureLayout','inspectLayout']);
  assert.equal(fs.existsSync(f.file),false);assert.equal(fs.existsSync(f.currentFile),false);
  assert.equal(value.config.emptyDraftAuthorized,undefined);assert.equal(value.config.identityVerified,undefined);
});
test('different strictly proven caret positions share one canonical full image without accumulating raw variants',async t=>{
  const f=caretPhase(fixture(t));f.pixels.caretCandidate=true;f.pixels.emptyEditorSha256s=[hex('c'),hex('b')];f.currentPixels.emptyEditorSha256s=[hex('e'),hex('b')];
  assert.deepEqual((await resolveQtAutoLayout(f,f.dependencies)).config.layout.emptyEditorSha256s,[hex('e'),hex('b')]);
});
test('already proven raw editor phases use the original fast path without another Python analysis',async t=>{
  const f=fixture(t);f.pixels.caretCandidate=true;f.pixels.emptyEditorSha256s=[hex('c'),hex('e')];f.currentPixels.regionHashes.editor=hex('e');
  assert.equal((await resolveQtAutoLayout(f,f.dependencies)).verified,true);assert.equal(f.pythonCalls.length,2);
  assert.equal(fs.existsSync(f.file),false);assert.equal(fs.existsSync(f.currentFile),false);
});
test('caret candidates require the flag, raw first hash, exact canonical equality and complete current evidence',async t=>{
  const mutations=[p=>p.emptyEditorSha256s=[hex('e')],p=>p.caretCandidate=false,p=>p.emptyEditorSha256s=[hex('c'),hex('e')],
    p=>p.emptyEditorSha256s=[hex('e'),hex('b')],p=>p.emptyEditorSha256s.push(hex('b')),p=>p.emptyEditorSha256s=[hex('e'),hex('e')],
    p=>p.fullEditorExamined=false,p=>p.emptyDraftAuthorized=true,p=>p.identityVerified=true,p=>p.inputSent=true,p=>p.imageSha256=hex('a'),
    p=>p.width=999,p=>p.dpi=144];
  for(const mutate of mutations){const f=caretPhase(fixture(t));mutate(f.currentPixels);
    await assert.rejects(resolveQtAutoLayout(f,f.dependencies));assert.equal(f.calls.length,2);assert.equal(fs.existsSync(f.file),false);assert.equal(fs.existsSync(f.currentFile),false);
  }
  const f=fixture(t);f.pixels.emptyEditorSha256s.push(hex('e'));await assert.rejects(resolveQtAutoLayout(f,f.dependencies),{code:'UI_QT_LAYOUT_EMPTY_TEMPLATE_UNVERIFIED'});assert.equal(f.calls.length,1);
});
test('every current image region must equal its native sample including the raw editor',async t=>{
  for(const key of ['header','profileOpen','search','selfOpen','editor','send','focusActivateRect','recordStartRect']){
    const f=caretPhase(fixture(t)),run=f.dependencies.runPython;f.dependencies.runPython=async input=>{const value=await run(input);if(input.input?.image===f.currentFile){value.regionHashes[key]=hex('f');if(key==='editor')value.emptyEditorSha256s[0]=hex('f');}return value;};
    await assert.rejects(resolveQtAutoLayout(f,f.dependencies),{code:'UI_QT_LAYOUT_PIXELS_CHANGED'});assert.equal(f.calls.length,2);assert.equal(f.pythonCalls.length,3);
  }
});
test('changed action anchors, native binding, foreground, rects and malformed pixels never reach phase fallback',async t=>{
  const mutations=[v=>v.regions[0].rgbaSha256=hex('f'),v=>v.regions[0].rect.left++,v=>v.regions.pop(),v=>v.regions[4].rgbaSha256='bad',
    v=>v.binding.foreground=true,v=>v.binding.pid++,v=>v.binding.clientRect.bottom--,v=>v.inputSent=true];
  for(const mutate of mutations){const f=caretPhase(fixture(t)),run=f.client.request;f.client.request=async(action,input)=>{const value=await run(action,input);if(action==='captureLayout'&&input.regions.length)mutate(value);return value;};
    await assert.rejects(resolveQtAutoLayout(f,f.dependencies));assert.equal(f.pythonCalls.length,2);assert.equal(f.calls.length,2);
  }
});
test('current and original PNG mutation, helper refusal and cancellation cannot turn a phase mismatch into a valid layout',async t=>{
  for(const mode of ['current-png','source-png','text','cancel','final-binding']){
    const f=caretPhase(fixture(t)),run=f.dependencies.runPython,controller=new AbortController();
    f.dependencies.runPython=async input=>{const value=await run(input);if(input.input?.image===f.currentFile){
      if(mode.endsWith('-png'))fs.appendFileSync(mode==='current-png'?f.currentFile:f.file,'changed');
      if(mode==='text')throw Object.assign(new Error('text'),{code:'UI_QT_LAYOUT_EDITOR_CONTENT_PRESENT',attempted:false});
      if(mode==='cancel')controller.abort();
    }return value;};
    if(mode==='final-binding'){const request=f.client.request;f.client.request=async(action,input)=>{const value=await request(action,input);if(action==='inspectLayout')value.binding.pid++;return value;};}
    await assert.rejects(resolveQtAutoLayout({...f,signal:controller.signal},f.dependencies));
    assert.equal(f.calls.filter(c=>c.action==='captureLayout').length,2);assert.equal(fs.existsSync(f.file),false);assert.equal(fs.existsSync(f.currentFile),false);
  }
});
const pixelFailure=(attempted=false)=>Object.assign(new Error('QT_PIXELS_CHANGED'),{code:'QT_PIXELS_CHANGED',attempted});
function nativeFixture(t,f){
  fs.writeFileSync(f.config.executable,'fixture app');f.config.executableSha256=hash('fixture app');f.inspection.executableSha256=f.config.executableSha256;
  fs.writeFileSync(path.join(f.root,'state/ui-host/WechatQtActions.exe'),'fixture helper');
  const child=new EventEmitter();child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  const packet=value=>child.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n'));
  f.nativeReply=f.client.request;
  child.stdin.write=line=>{const {id,action,...input}=JSON.parse(line);queueMicrotask(async()=>{
    if(action==='stop'){packet({id,ok:true,result:{stopped:true}});child.emit('close',0,null);return;}
    try{packet({id,ok:true,result:await f.nativeReply(action,input)});}catch(error){packet({id,ok:false,error:{code:error.code,...(Object.hasOwn(error,'attempted')?{attempted:error.attempted}:{}),...(error.focusRestoreOutcome?{focusRestoreOutcome:error.focusRestoreOutcome}:{}),...(error.visibilityRestoreOutcome?{visibilityRestoreOutcome:error.visibilityRestoreOutcome}:{})}});}
  });return true;};
  f.client=new QtActionsClient({root:f.root,config:f.config,enableInput:false,calibration:true,spawnImpl:()=>child});t.after(()=>f.client.close());return f;
}
test('native read-only capture retries at most three samples and preserves all later proof checks',async t=>{
  for(const phase of ['source','current']){
    const f=nativeFixture(t,caretPhase(fixture(t))),run=f.nativeReply;let failures=0;
    f.nativeReply=async(action,input)=>{if(action==='captureLayout'&&(phase==='source'?!input.regions.length:input.regions.length)&&failures++<2){f.calls.push({action,input});throw pixelFailure();}return run(action,input);};
    assert.equal((await resolveQtAutoLayout(f,f.dependencies)).verified,true);assert.equal(f.calls.filter(c=>c.action==='captureLayout').length,4);
    assert.equal(f.calls.every(c=>['captureLayout','inspectLayout'].includes(c.action)),true);
  }
  const f=nativeFixture(t,fixture(t));f.nativeReply=async(action,input)=>{f.calls.push({action,input});throw pixelFailure();};
  await assert.rejects(resolveQtAutoLayout(f,f.dependencies),{code:'QT_PIXELS_CHANGED'});assert.equal(f.calls.length,3);assert.equal(f.pythonCalls.length,0);
});
test('capture wrappers, unknown attempted status and unrelated native errors never retry',async t=>{
  for(const mode of ['proxy','attempted','unknown','other']){
    const f=mode==='proxy'?fixture(t):nativeFixture(t,fixture(t));const reject=async(action,input)=>{f.calls.push({action,input});const error=pixelFailure(mode==='attempted'?true:false);if(mode==='unknown')delete error.attempted;if(mode==='other')error.code='QT_WINDOW_OBSCURED';throw error;};if(mode==='proxy')f.client.request=reject;else f.nativeReply=reject;
    await assert.rejects(resolveQtAutoLayout(f,f.dependencies));assert.equal(f.calls.length,1);assert.equal(f.pythonCalls.length,0);
  }
});

test('an obscured native read-only layout capture yields a queue wait without focus or local retries',async t=>{
  for(const phase of ['source','current']){
    const f=nativeFixture(t,fixture(t)),run=f.nativeReply;
    f.nativeReply=async(action,input)=>{
      if(action==='captureLayout'&&(phase==='source'||input.regions.length)){
        f.calls.push({action,input});throw Object.assign(Error('private window detail'),{code:'QT_WINDOW_OBSCURED',attempted:false});
      }
      return run(action,input);
    };
    await assert.rejects(resolveQtAutoLayout(f,f.dependencies),{code:'UI_QT_LAYOUT_WINDOW_OBSCURED',attempted:false,waitable:true});
    assert.equal(f.calls.length,phase==='source'?1:2);assert.equal(f.calls.every(call=>call.action==='captureLayout'),true);
    if(phase==='current')assert.equal(fs.existsSync(f.file),false);
    assert.equal(fs.existsSync(path.join(f.root,'state/ui-runtime/qt-layout-profiles')),false);
  }
});

test('obscured wrapped captures and unknown input outcomes are not classified as a read-only wait; cancellation wins',async t=>{
  for(const mode of ['wrapper','attempted','unknown','cancel']){
    const f=nativeFixture(t,fixture(t)),controller=new AbortController();
    const reject=async(action,input)=>{
      f.calls.push({action,input});if(mode==='cancel')controller.abort();
      throw Object.assign(Error('QT_WINDOW_OBSCURED'),{code:'QT_WINDOW_OBSCURED',...(mode==='unknown'?{}:{attempted:mode==='attempted'})});
    };
    if(mode==='wrapper')f.client.request=reject;else f.nativeReply=reject;
    await assert.rejects(resolveQtAutoLayout({...f,signal:controller.signal},f.dependencies),{code:mode==='cancel'?'UI_QT_CANCELLED':'QT_WINDOW_OBSCURED'});
    assert.equal(f.calls.length,1);assert.equal(f.pythonCalls.length,0);
    // Restore the protocol method so fixture teardown can stop the fake helper.
    if(mode==='wrapper')delete f.client.request;
  }
});

function handoffFixture(t){
  const f=nativeFixture(t,fixture(t)),run=f.nativeReply;f.client.enableInput=true;f.restored=false;
  f.packet={version:1,mode:'visibility-topmost-layout-pair-v1',focusChanged:false,inputSent:false,chatInputSent:false,clipboardAccessed:false,authorizationGranted:false,restored:true,activityUnchanged:true,temporaryTopmostApplied:true,temporaryTopmostRolledBack:true,
    visibilityRestoreOutcome:{version:1,reason:'source-order-restored',restored:true,foregroundPreserved:true,identitiesUnchanged:true,activityUnchanged:true,placementUnchanged:true,topmostUnchanged:true,originalFailureCode:null,
      temporaryTopmost:{version:1,originalTargetTopmost:false,temporaryTopmostAttempted:true,temporaryTopmostApplied:true,temporaryTopmostRollbackAttempted:true,temporaryTopmostRolledBack:true,topmostRollbackConfirmed:true,targetDestroyed:false}},
    raisedVisibilityInterval:{version:1,phase:'layout-visibility',durationMs:47,complete:true,keyboardFocusChanged:false},targetRaiseAttempted:true,sourceLowerAttempted:false,restoreRaiseAttempted:false,relativeOrderRestoreAttempted:true,frames:[]};
  f.nativeReply=async(action,input)=>{
    if(action==='captureLayout'){f.calls.push({action,input});throw Object.assign(Error('QT_WINDOW_OBSCURED'),{code:'QT_WINDOW_OBSCURED',attempted:false});}
    if(action==='captureLayoutRaised'){
      f.calls.push({action,input});assert.deepEqual(input.expectedBinding,Object.fromEntries(['hwnd','pid','processCreatedFileTimeUtc','dpi','clientRect','captureRect'].map(key=>[key,f.inspection.binding[key]])));
      assert.equal(input.idleMs,1000);assert.equal(input.focusActivation,undefined);
      const first=await run('captureLayout',{regions:[],image:true}),second=await run('captureLayout',{regions:Object.values(f.located.layout),image:true});
      f.calls.splice(-2);for(const frame of [first,second]){frame.binding.foreground=false;frame.focusChanged=false;frame.regions=[];}
      f.packet.frames=[first,second];f.mutate?.(f.packet);f.restored=true;return f.packet;
    }
    return run(action,input);
  };
  const python=f.dependencies.runPython;f.dependencies.runPython=async request=>{assert.equal(f.restored,true,'OCR must run after native return');return python(request);};
  return f;
}

test('shared hidden-layout capture reveals once without keyboard focus and verifies both images after restoring visibility',async t=>{
  const f=handoffFixture(t);
  const value=await resolveQtAutoLayout({...f,allowFocusCapture:true},f.dependencies);
  assert.equal(value.verified,true);assert.equal(value.config.layout.width,1000);assert.equal(value.config.layout.dpi,120);
  assert.deepEqual(f.calls.map(call=>call.action),['captureLayout','captureLayoutRaised','inspectLayout']);
  assert.deepEqual(f.pythonCalls.map(call=>call.script),['locate-wechat-layout.py','qt-auto-layout-image.py','qt-auto-layout-image.py']);
  assert.deepEqual(value.config.layout.focusActivateRect,f.located.layout.focusActivateRect);assert.equal(value.config.layout.focusActivateRgbaSha256,hex('d'));
  assert.equal(fs.existsSync(f.file),false);assert.equal(fs.existsSync(f.currentFile),false);
});

test('layout visibility raise requires shared authorization and an unchanged native client, and never repeats a refusal',async t=>{
  for(const mode of ['disabled','readonly-client','wrapped','refused']){
    const f=handoffFixture(t);if(mode==='readonly-client')f.client.enableInput=false;
    if(mode==='wrapped'){const native=f.client.request.bind(f.client);f.client.request=(action,input)=>native(action,input);}
    if(mode==='refused'){const run=f.nativeReply;f.nativeReply=async(action,input)=>{if(action==='captureLayoutRaised'){f.calls.push({action,input});throw Object.assign(Error('QT_USER_ACTIVE'),{code:'QT_USER_ACTIVE',attempted:false});}return run(action,input);};}
    await assert.rejects(resolveQtAutoLayout({...f,allowFocusCapture:mode!=='disabled'},f.dependencies),{code:mode==='readonly-client'?'UI_QT_INPUT_DISABLED':mode==='wrapped'?'QT_WINDOW_OBSCURED':mode==='refused'?'QT_USER_ACTIVE':'UI_QT_LAYOUT_WINDOW_OBSCURED'});
    assert.equal(f.calls.filter(call=>call.action==='captureLayoutRaised').length,mode==='refused'?1:0);assert.equal(f.pythonCalls.length,0);
    if(mode==='wrapped')delete f.client.request;
  }
});

test('unrestored, changed, malformed or cancelled visibility captures never run OCR or retain images',async t=>{
  for(const mode of ['return','activity','identity','placement','topmost','missing-topmost-proof','unobserved-apply','missing-rollback','unconfirmed-rollback','destroyed','original-topmost','claim-mismatch','source-lowered','legacy-mode','focus','interval','input','chat-input','authorization','count','same-file','binding','foreground','cancel']){
    const f=handoffFixture(t),controller=new AbortController();
    f.mutate=packet=>{
      if(mode==='return')packet.restored=false;
      else if(mode==='activity')packet.visibilityRestoreOutcome.activityUnchanged=false;
      else if(mode==='identity')packet.visibilityRestoreOutcome.identitiesUnchanged=false;
      else if(mode==='placement')packet.visibilityRestoreOutcome.placementUnchanged=false;
      else if(mode==='topmost')packet.visibilityRestoreOutcome.topmostUnchanged=false;
      else if(mode==='missing-topmost-proof')delete packet.visibilityRestoreOutcome.temporaryTopmost;
      else if(mode==='unobserved-apply')packet.visibilityRestoreOutcome.temporaryTopmost.temporaryTopmostApplied=false;
      else if(mode==='missing-rollback')packet.visibilityRestoreOutcome.temporaryTopmost.temporaryTopmostRollbackAttempted=false;
      else if(mode==='unconfirmed-rollback')packet.visibilityRestoreOutcome.temporaryTopmost.topmostRollbackConfirmed=false;
      else if(mode==='destroyed')packet.visibilityRestoreOutcome.temporaryTopmost.targetDestroyed=true;
      else if(mode==='original-topmost')packet.visibilityRestoreOutcome.temporaryTopmost.originalTargetTopmost=true;
      else if(mode==='claim-mismatch')packet.temporaryTopmostRolledBack=false;
      else if(mode==='source-lowered')packet.sourceLowerAttempted=true;
      else if(mode==='legacy-mode')packet.mode='visibility-raise-layout-pair-v1';
      else if(mode==='focus')packet.focusChanged=true;
      else if(mode==='interval')packet.raisedVisibilityInterval.complete=false;
      else if(mode==='input')packet.inputSent=true;
      else if(mode==='chat-input')packet.chatInputSent=true;
      else if(mode==='authorization')packet.authorizationGranted=true;
      else if(mode==='count')packet.frames.push(packet.frames[0]);
      else if(mode==='same-file')packet.frames[1].image=packet.frames[0].image;
      else if(mode==='binding')packet.frames[1].binding.dpi=144;
      else if(mode==='foreground')packet.frames[1].binding.foreground=true;
      else controller.abort();
    };
    await assert.rejects(resolveQtAutoLayout({...f,allowFocusCapture:true,signal:controller.signal},f.dependencies));
    assert.equal(f.pythonCalls.length,0);assert.equal(fs.existsSync(f.file),false);
    if(mode!=='same-file')assert.equal(fs.existsSync(f.currentFile),false);
  }
});

test('visibility image pair compares every later anchor and full editor before publishing coordinates',async t=>{
  for(const mode of ['header','editor','process','source-mutation']){
    const f=handoffFixture(t);
    if(mode==='header')f.currentPixels.regionHashes.header=hex('f');
    if(mode==='editor'){f.currentPixels.regionHashes.editor=hex('f');f.currentPixels.emptyEditorSha256s=[hex('f')];}
    if(mode==='process'){const run=f.nativeReply;f.nativeReply=async(action,input)=>{const value=await run(action,input);if(action==='inspectLayout')value.binding.pid++;return value;};}
    if(mode==='source-mutation'){const run=f.dependencies.runPython;f.dependencies.runPython=async input=>{const value=await run(input);if(input.input?.image===f.currentFile)fs.appendFileSync(f.file,'changed');return value;};}
    await assert.rejects(resolveQtAutoLayout({...f,allowFocusCapture:true},f.dependencies));
    assert.equal(f.calls.filter(call=>call.action==='captureLayoutRaised').length,1);assert.equal(fs.existsSync(f.file),false);assert.equal(fs.existsSync(f.currentFile),false);
  }
});

test('an obscured raised window becomes a manual refusal only after a fully confirmed visibility restore',async t=>{
  for(const mode of ['restored','unknown','activity','placement','identity','foreground','rollback','unobserved','other-error']){
    const f=handoffFixture(t),run=f.nativeReply;
    f.nativeReply=async(action,input)=>{
      if(action!=='captureLayoutRaised')return run(action,input);
      f.calls.push({action,input});const outcome=structuredClone(f.packet.visibilityRestoreOutcome);
      if(mode==='activity')outcome.activityUnchanged=false;
      if(mode==='placement')outcome.placementUnchanged=false;
      if(mode==='identity')outcome.identitiesUnchanged=false;
      if(mode==='foreground')outcome.foregroundPreserved=false;
      if(mode==='rollback')outcome.temporaryTopmost.topmostRollbackConfirmed=false;
      if(mode==='unobserved')outcome.temporaryTopmost.temporaryTopmostApplied=false;
      throw Object.assign(Error('private native visibility detail'),{code:mode==='other-error'?'QT_BINDING_CHANGED':'QT_WINDOW_OBSCURED',...(mode==='unknown'?{}:{visibilityRestoreOutcome:outcome})});
    };
    await assert.rejects(resolveQtAutoLayout({...f,allowFocusCapture:true},f.dependencies),mode==='restored'?{code:'UI_QT_LAYOUT_VISIBILITY_BLOCKED',waitable:false,visibilityRestored:true}:{code:mode==='other-error'?'QT_BINDING_CHANGED':'QT_WINDOW_OBSCURED'});
    assert.equal(f.calls.filter(call=>call.action==='captureLayoutRaised').length,1);assert.equal(f.pythonCalls.length,0);
  }
});
test('a real native instance with a request wrapper is ineligible and a late wrapper is never invoked by retry',async t=>{
  const wrapped=nativeFixture(t,fixture(t));let wrappedCalls=0;
  wrapped.client.request=async()=>{wrappedCalls++;throw pixelFailure();};
  await assert.rejects(resolveQtAutoLayout(wrapped,wrapped.dependencies),{code:'QT_PIXELS_CHANGED'});assert.equal(wrappedCalls,1);assert.equal(wrapped.calls.length,0);
  const changed=nativeFixture(t,fixture(t));let unexpected=0;
  changed.nativeReply=async(action,input)=>{changed.calls.push({action,input});setTimeout(()=>{changed.client.request=async()=>{unexpected++;throw pixelFailure();};},5);throw pixelFailure();};
  await assert.rejects(resolveQtAutoLayout(changed,changed.dependencies),{code:'QT_PIXELS_CHANGED'});assert.equal(changed.calls.length,1);assert.equal(unexpected,0);
});
test('capture retry cancellation and elapsed retry budget stop sampling and remove late successful PNGs',async t=>{
  const cancelled=nativeFixture(t,fixture(t)),controller=new AbortController();cancelled.nativeReply=async(action,input)=>{cancelled.calls.push({action,input});setTimeout(()=>controller.abort(),5);throw pixelFailure();};
  await assert.rejects(resolveQtAutoLayout({...cancelled,signal:controller.signal},cancelled.dependencies),{code:'UI_QT_CANCELLED'});assert.equal(cancelled.calls.length,1);
  const slow=nativeFixture(t,fixture(t)),run=slow.nativeReply;let attempts=0;
  slow.nativeReply=async(action,input)=>{if(attempts++===0){slow.calls.push({action,input});throw pixelFailure();}await new Promise(resolve=>setTimeout(resolve,760));return run(action,input);};
  await assert.rejects(resolveQtAutoLayout(slow,slow.dependencies),{code:'QT_PIXELS_CHANGED'});assert.equal(slow.calls.length,2);assert.equal(slow.pythonCalls.length,0);assert.equal(fs.existsSync(slow.file),false);
});
test('foreground captures never learn an inactive activation template',async t=>{
  const f=fixture(t);f.inspection.binding.foreground=true;const value=await resolveQtAutoLayout(f,f.dependencies);assert.equal(value.config.layout.focusActivateRect,undefined);assert.equal(value.config.layout.focusActivateRgbaSha256,undefined);
});
test('formal candidate passes the real adaptive config validator and popup identities exclude old geometry',async t=>{
  const f=fixture(t),value=await resolveQtAutoLayout(f,{runPython:f.dependencies.runPython});
  assert.equal(Object.keys(value.config.profileSurface.popupCalibration).length,7);assert.equal(value.config.profileSurface.popupCalibration.windowRect,undefined);
});
test('anchor evidence requires exact unique roles, original rects and original confidence thresholds',async t=>{
  for(const mutate of [f=>f.located.evidence[0].support=.77,f=>f.located.evidence[1].support=.93,f=>f.located.evidence[3].confidence=.969,
    f=>f.located.evidence[5].score=.88,f=>f.located.evidence[6].rect=r(0,0,20,20),f=>f.located.evidence[7].confidence=NaN,
    f=>f.located.evidence.push(f.located.evidence[0])]){const f=fixture(t);mutate(f);await assert.rejects(resolveQtAutoLayout(f,f.dependencies),{code:'UI_QT_LAYOUT_ANCHORS_UNVERIFIED'});}
});
test('RGB navigation fallback requires both bounded long-edge supports and exact method evidence',async t=>{
  const f=fixture(t);Object.assign(f.located.evidence[0],{method:'neutral-rgb-step',neutralSupport:.86});
  assert.equal((await resolveQtAutoLayout(f,f.dependencies)).verified,true);
  for(const change of ['weak-edge','weak-neutral','unknown','missing-method','extra']){
    const invalid=fixture(t),evidence=invalid.located.evidence[0];Object.assign(evidence,{method:'neutral-rgb-step',neutralSupport:.86});
    if(change==='weak-edge')evidence.support=.94999;
    else if(change==='weak-neutral')evidence.neutralSupport=.78;
    else if(change==='unknown')evidence.method='any-colour';
    else if(change==='missing-method')delete evidence.method;
    else evidence.guessed=true;
    await assert.rejects(resolveQtAutoLayout(invalid,invalid.dependencies),{code:'UI_QT_LAYOUT_ANCHORS_UNVERIFIED'});
  }
});
function glyphNavigation(f){
  measured96(f);f.located.anchors.navDivider=60;f.located.anchors.chatDivider=300;
  f.located.evidence[0]={kind:'long-navigation-divider',method:'known-glyph-constellation',templateSha256:'7f10b2c4d70489b61d2fa1a94cc98f40e3181c77e3f3c4c4894987a83682c005',glyphs:[
    {kind:'contacts',rect:r(17,148,43,174),score:1},{kind:'box',rect:r(18,195,43,222),score:1},{kind:'compass',rect:r(17,243,43,270),score:1}]};return f;
}
test('gradient navigation is a three-shape candidate with independent avatar search and chat evidence',async t=>{
  const f=glyphNavigation(fixture(t)),value=await resolveQtAutoLayout(f,f.dependencies);
  assert.equal(value.verified,true);assert.equal(f.calls.length,3);
  assert.equal(f.calls.some(call=>['click','type','paste'].includes(call.action)),false);
  assert.equal(value.config.identityVerified,undefined);
});
test('native 125 percent public glyph samples retain the same independent anchor protocol',async t=>{
  const f=fixture(t);f.located.anchors.navDivider=75;f.located.anchors.chatDivider=300;
  Object.assign(f.located.layout.selfOpen,r(15,53,60,98));Object.assign(f.located.layout.search,r(91,53,261,87));
  f.located.evidence[0]={kind:'long-navigation-divider',method:'known-glyph-constellation',templateSha256:'7f10b2c4d70489b61d2fa1a94cc98f40e3181c77e3f3c4c4894987a83682c005',glyphs:[
    {kind:'contacts',rect:r(21,185,54,218),score:.999999},{kind:'box',rect:r(21,245,54,278),score:.999999},{kind:'compass',rect:r(21,305,54,338),score:.999999}]};
  const value=await resolveQtAutoLayout(f,f.dependencies);assert.equal(value.verified,true);assert.equal(value.config.layout.dpi,120);
  assert.equal(f.calls.some(call=>['click','type','paste'].includes(call.action)),false);
});

test('navigation glyph protocol rejects missing duplicate reordered displaced resized or unbound evidence',async t=>{
  const mutations=[
    f=>f.located.evidence[0].glyphs.pop(),f=>f.located.evidence[0].glyphs.push(f.located.evidence[0].glyphs[0]),
    f=>f.located.evidence[0].glyphs.reverse(),f=>f.located.evidence[0].glyphs[0].score=.92999,
    f=>f.located.evidence[0].glyphs[0].score=NaN,f=>f.located.evidence[0].templateSha256=hex('a'),
    f=>f.located.evidence[0].glyphs[1].rect.left+=5,f=>f.located.evidence[0].glyphs[1].rect.top+=8,
    f=>f.located.evidence[0].glyphs[1].rect.bottom+=8,f=>f.located.evidence[0].glyphs[2].kind='contacts',
    f=>f.located.evidence[0].glyphs[0].expected=true,f=>f.located.evidence[0].guessed=true,
    f=>f.located.anchors.navDivider=61,f=>f.located.anchors.chatDivider='300',
    f=>f.located.anchors.chatDivider=200,f=>f.located.layout.selfOpen.left+=6,
    f=>f.located.layout.selfOpen.top+=12,f=>f.located.layout.search.left=61,
    f=>f.located.layout.search.right=290,f=>f.located.evidence[1].support=.93,
    f=>f.located.evidence[3].confidence=.969,f=>f.located.evidence[6].rect=r(0,0,30,30)
  ];
  for(const [index,mutate] of mutations.entries()){const f=glyphNavigation(fixture(t));mutate(f);
    await assert.rejects(resolveQtAutoLayout(f,f.dependencies),{code:'UI_QT_LAYOUT_ANCHORS_UNVERIFIED'},`mutation ${index}`);
    assert.equal(f.calls.length,1);assert.equal(f.calls.some(call=>call.action==='click'),false);
  }
});
function panelFixture(f){const panel=r(700,100,980,780),member=r(720,120,770,170),close=r(320,45,420,70),add=r(800,120,850,170);
  return {version:1,ok:true,mode:'contact-panel',imageSha256:f.located.imageSha256,width:1000,height:800,dpi:120,executableVersion:'4.1.15.56',readOnly:true,inputSent:false,identityVerified:false,emptyDraftAuthorized:false,
    anchors:{panel,profileMember:member,profilePanelClose:close},panelRgbaSha256:hex('a'),memberRgbaSha256:hex('b'),closeRgbaSha256:hex('c'),evidence:[{kind:'contact-panel-boundary',support:1},{kind:'contact-panel-controls',count:5,confidence:1},{kind:'member-avatar-component',rect:member},{kind:'member-add-control',rect:add},{kind:'header-title-toggle',rect:close,confidence:1}]};}
const frameOptions=f=>({root:f.root,file:f.file,imageSha256:f.located.imageSha256,width:1000,height:800,dpi:120,executableVersion:'4.1.15.56'});
test('contact panel and later full main layout are independently bound with no file ownership transfer',async t=>{
  const f=fixture(t),panel=panelFixture(f),options=frameOptions(f);
  const result=await locateQtContactPanel(options,{runPython:async()=>panel});assert.equal(result.closeRole,'header-title-toggle');assert.deepEqual(result.closeRect,panel.anchors.profilePanelClose);assert.equal(result.token,undefined);
  assert.equal((await verifyQtContactPanelClosed(options,{runPython:async()=>f.located})).closed,true);assert.equal(fs.existsSync(f.file),true);
  await assert.rejects(verifyQtContactPanelClosed(options,{runPython:async()=>panel}));
});

function controlsBoundedPanel(f){const p=panelFixture(f);p.anchors.panel=r(700,100,995,795);p.evidence[3].rect=r(800,178,830,198);
  p.evidence[0]={kind:'contact-panel-boundary',method:'controls-bounded-region',rightSupport:1,bottomSupport:1,separators:[r(700,209,978,210),r(700,273,978,274),r(700,376,978,378)].map(rect=>({rect,support:1,contrastMin:9}))};
  p.evidence[1].labels=[['add',structuredClone(p.evidence[3].rect)],['lookup',r(700,233,790,251)],['mute',r(700,296,775,314)],['pin',r(702,338,758,356)],['clear',r(794,399,884,417)]].map(([role,rect])=>({role,rect}));return p;}
test('contact panel controls-bounded observation validates visible endpoints without claiming a left border',async t=>{
  const f=fixture(t),panel=controlsBoundedPanel(f),result=await locateQtContactPanel(frameOptions(f),{runPython:async()=>panel});
  assert.deepEqual(result.panelRect,panel.anchors.panel);assert.equal(result.panelRgbaSha256,panel.panelRgbaSha256);assert.equal(result.token,undefined);
});
test('controls-bounded panel evidence rejects missing, mixed, shifted, duplicate and weak structural proofs',async t=>{
  const changes=[p=>p.evidence[0].method='guessed-border',p=>p.evidence[0].support=1,p=>p.evidence[0].rightSupport=.96,p=>p.evidence[0].bottomSupport=.96,
    p=>p.evidence[0].separators.pop(),p=>p.evidence[0].separators.push(p.evidence[0].separators[0]),p=>p.evidence[0].separators[0].support=.99,
    p=>p.evidence[0].separators[0].contrastMin=3,p=>p.evidence[0].separators[0].rect.left++,p=>p.evidence[0].separators[1].rect.right++,
    p=>p.evidence[0].separators[1].rect.bottom+=3,p=>p.evidence[0].separators[0].rect.top=2000,p=>p.evidence[1].labels.pop(),
    p=>p.evidence[1].labels[0].role='member',p=>p.evidence[1].labels[0].rect.left++,p=>p.evidence[1].labels[1].rect.top=209,
    p=>p.evidence[1].labels[2].rect.left+=5,p=>p.evidence[1].labels[4].rect.left+=20,p=>p.anchors.panel.right=980,p=>p.anchors.panel.bottom=770];
  for(const [index,mutate] of changes.entries()){const f=fixture(t),panel=controlsBoundedPanel(f);mutate(panel);
    await assert.rejects(locateQtContactPanel(frameOptions(f),{runPython:async()=>panel}),{code:'UI_QT_CONTACT_PANEL_UNVERIFIED'},`change ${index}`);}
});

test('current title observation binds independent main anchors and the full original header without empty-draft authorization',async t=>{
  const f=fixture(t);Object.assign(f.located,{headerRgbaSha256:hex('a'),titleRgbaSha256:hex('b')});
  const value=await locateQtMainTitle(frameOptions(f),{runPython:async()=>f.located});
  assert.deepEqual(value.titleRect,f.located.layout.profileOpen);assert.deepEqual(value.headerRect,f.located.layout.header);
  assert.equal(value.headerRgbaSha256,hex('a'));assert.equal(value.titleRgbaSha256,hex('b'));assert.equal(value.emptyDraftAuthorized,false);assert.equal(value.identityVerified,false);assert.equal(value.token,undefined);
  for(const mutate of [v=>delete v.headerRgbaSha256,v=>v.titleRgbaSha256='bad',v=>v.evidence[7].confidence=.96,v=>v.evidence[7].rect=r(0,0,1,1),v=>v.evidence.pop(),v=>v.dpi=144,v=>v.width++,v=>v.imageSha256=hex('f'),v=>v.inputSent=true,v=>v.emptyDraftAuthorized=true]){
    const bad=structuredClone(f.located);mutate(bad);await assert.rejects(locateQtMainTitle(frameOptions(f),{runPython:async()=>bad}));
  }
});

test('panel editor inspection binds complete native header/editor pixels and reports only visual caret normalization',async t=>{
  const f=fixture(t),options={...frameOptions(f),header:f.config.layout.header,editor:f.config.layout.editor};
  const pixels={...f.pixels,regionHashes:{header:hex('d'),editor:hex('c')},emptyEditorSha256s:[hex('c'),hex('e')],caretCandidate:true};
  const result=await inspectQtPanelEditor(options,{runPython:async input=>{assert.deepEqual(Object.keys(input.input.regions),['header','editor']);return pixels;}});
  assert.equal(result.canonicalEditorSha256,hex('e'));assert.equal(result.editorRgbaSha256,hex('c'));assert.equal(result.caretCandidate,true);assert.equal(result.emptyDraftAuthorized,false);
  for(const mutate of [p=>p.imageSha256=hex('f'),p=>p.regionHashes.header='bad',p=>p.emptyEditorSha256s[0]=hex('d'),p=>p.emptyEditorSha256s.push(hex('a')),p=>p.fullEditorExamined=false,p=>p.emptyDraftAuthorized=true,p=>p.width++,p=>p.caretCandidate=false]){
    const bad=structuredClone(pixels);mutate(bad);await assert.rejects(inspectQtPanelEditor(options,{runPython:async()=>bad}));
  }
});
test('contact panel rejects weak labels, wrong close role evidence, source changes and ambiguous controls',async t=>{
  for(const mutate of [p=>p.mode='main',p=>p.imageSha256=hex('f'),p=>p.evidence[1].count=4,p=>p.evidence[1].confidence=.96,p=>p.evidence[4].confidence=.96,p=>p.evidence[4].rect=r(0,0,20,20),p=>p.anchors.profileMember=r(600,120,770,170),p=>p.evidence.push(p.evidence[0]),p=>p.inputSent=true]){
    const f=fixture(t),panel=panelFixture(f);mutate(panel);await assert.rejects(locateQtContactPanel(frameOptions(f),{runPython:async()=>panel}));
  }
});
test('all image consumers reject path escape, source SHA change and dimensions before Python',async t=>{
  for(const kind of ['path','sha','size']){const f=fixture(t),options=frameOptions(f);if(kind==='path')options.file=path.join(f.root,'outside.png');if(kind==='sha')options.imageSha256=hex('f');if(kind==='size')options.width=1001;
    let called=false;for(const method of [locateQtContactPanel,verifyQtContactPanelClosed,locateQtMainTitle])await assert.rejects(method(options,{runPython:async()=>{called=true;}}));assert.equal(called,false);
  }
});
function workerFixture(t){const f=fixture(t);for(const name of ['state/ocr/venv/Scripts/python.exe','scripts/locate-wechat-layout.py']){const file=path.join(f.root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');}
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=0;child.kill=()=>{child.kills++;};
  const spawnImpl=(executable,args,options)=>{assert.equal(executable,path.join(f.root,'state/ocr/venv/Scripts/python.exe'));assert.deepEqual(args.slice(0,2),['-I','-B']);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);return child;};return{...f,child,spawnImpl};}
test('local worker cancellation and output overflow terminate before settling, without private error data',async t=>{
  for(const mode of ['cancel','overflow']){const f=workerFixture(t),controller=new AbortController();let settled=false;
    const pending=runQtLayoutPython({root:f.root,script:'locate-wechat-layout.py',spawnImpl:f.spawnImpl,signal:controller.signal}).catch(error=>{settled=true;return error;});
    if(mode==='cancel')controller.abort();else f.child.stdout.write(Buffer.alloc(65537,65));await Promise.resolve();assert.equal(f.child.kills,1);assert.equal(settled,false);
    f.child.emit('close',1,null);assert.equal((await pending).code,mode==='cancel'?'UI_QT_CANCELLED':'UI_QT_LAYOUT_PROTOCOL_INVALID');
  }
});
const project=path.resolve(import.meta.dirname,'..'),python=path.join(project,'state/ocr/venv/Scripts/python.exe');
test('full-editor pixel validator rejects real synthetic text, attachments, scrollbar and truncated regions',{skip:!fs.existsSync(python)},()=>{
  const result=spawnSync(python,['-I','-B',path.join(project,'scripts/test-qt-auto-layout-image.py')],{windowsHide:true,shell:false,encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);
});
