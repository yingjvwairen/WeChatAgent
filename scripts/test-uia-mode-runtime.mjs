import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createUiaControlProvider,createUiaModeRuntime,UiaVerifierClient} from './uia-mode-runtime.mjs';

const r=(left,top,right,bottom)=>({left,top,right,bottom});
const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverse(item)])):value;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixtureConfig(root){
  const popup=kind=>({version:1,kind,className:'QtFixture',ownerRelation:'same-thread-unowned',ownerDepth:0,style:-2147483648,extendedStyle:128});
  return{version:1,backend:'qt-visual',account:'wxid_fixture',accountRef:'a'.repeat(64),accountAlias:'fixture_alias',executable:path.join(root,'Weixin.exe'),executableVersion:'4.1.15.56',executableSha256:'b'.repeat(64),hwnd:'auto',idleMs:1000,ocrBackend:'rapidocr',layoutMode:'adaptive-v1',
    layout:{width:800,height:600,dpi:96,header:r(300,10,600,40),search:r(60,10,250,50),profileOpen:r(320,15,390,35),selfOpen:r(10,20,40,60),editor:r(300,450,780,540),send:r(700,550,780,590),emptyEditorSha256:'c'.repeat(64)},
    selfCloseKey:'Escape',profileCloseKey:'Escape',selfSurface:{popupCalibration:popup('profile')},profileSurface:{popupCalibration:popup('profile')},searchPopupCalibration:popup('search'),
    voice:{recordStartRect:r(700,550,720,580),mouseParkRect:r(400,2,420,8),recordingUi:{focusHwnd:'same',adaptive:{version:1,executableVersion:'4.1.15.56',toolbarRect:r(300,545,780,595)}}}};
}
function inspection(config){return{version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:config.executableVersion,executableSha256:config.executableSha256,
  binding:{hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',clientRect:r(0,0,config.layout.width,config.layout.height),captureRect:r(-800,0,config.layout.width-800,config.layout.height),dpi:config.layout.dpi,foreground:false}};}
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-uia-mode-')),config=fixtureConfig(root),configFile=path.join(root,'qt-visual.json');
  fs.writeFileSync(configFile,JSON.stringify(config));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true});});
  return{root,config,configFile,inspection:inspection(config)};
}
test('offscreen movement is enabled only for an explicit sender provider and cleanup returns its restoration evidence',async t=>{
  const f=setup(t),events=[];const factory=()=>({prepareWindow:async()=>events.push('park-boundary'),getState:()=>({state:'parked'}),close:async()=>{events.push('restore');return{processStopped:true,released:true,state:{state:'restored'}};}});
  const readOnly=createUiaControlProvider({root:f.root,configFile:f.configFile,createOffscreen:()=>assert.fail('read-only mode startup must not construct a window owner')});assert.equal(readOnly.prepareWindow,undefined);assert.equal(readOnly.inspectOffscreen(),null);assert.deepEqual(await readOnly.close(),{processStopped:true});
  const sender=createUiaControlProvider({root:f.root,configFile:f.configFile,enableOffscreen:true,createOffscreen:factory});assert.deepEqual(events,[]);await sender.prepareWindow({config:f.config,releaseInput:async()=>{}});assert.deepEqual(sender.inspectOffscreen(),{state:'parked'});const cleanup=await sender.close();assert.equal(cleanup.offscreen.state.state,'restored');assert.deepEqual(events,['park-boundary','restore']);await sender.close();assert.equal(events.length,2);
});
function gatePacket(f,binding){
  const bound={hwnd:binding.hwnd,pid:binding.pid,processCreatedFileTimeUtc:binding.processCreatedFileTimeUtc,executable:f.config.executable,executableSha256:f.config.executableSha256,coreSha256:'d'.repeat(64)};
  return{ok:true,inputSent:false,gateEnabled:false,binding:bound,candidateRequest:{version:1,configPath:f.configFile,hwnd:bound.hwnd,expected:structuredClone(bound)}};
}
function missingRootError(patch={},failure={}){return Object.assign(new Error('native root unavailable'),{code:1,killed:false,signal:null,stderr:'',stdout:JSON.stringify({ok:false,schemaVersion:1,error:'UI_CONTROLS_ROOT_UNAVAILABLE',readOnly:true,uiAccessed:true,inputSent:false,messageSendAttempted:false,namesAndValuesRead:false,titleTextRead:false,searchValueIncluded:false,eligibleForAutomation:false,...patch}),...failure});}
function emptyTreePacket(binding){const before={hwnd:binding.hwnd,pid:binding.pid,processCreatedFileTimeUtc:binding.processCreatedFileTimeUtc,threadId:9,nativeClassName:'QtFixture',visible:true,minimized:false,foregroundHwnd:'200',cursorX:1,cursorY:2,lastInputTick:123};return {ok:true,schemaVersion:1,readOnly:true,inputSent:false,namesAndValuesRead:false,eligibleForAutomation:false,bindingStable:true,complete:true,reason:null,foregroundUnchanged:true,cursorUnchanged:true,inputTickUnchanged:true,mmuiControlCount:0,nodeCount:1,nodes:[{className:'QtFixture'}],before,after:structuredClone(before)};}
function layoutPacket(f,binding=f.inspection.binding){return{ok:true,version:1,readOnly:true,inputSent:false,foregroundUnchanged:true,bindingStable:true,complete:true,layoutAvailable:true,binding:structuredClone(binding),
  layout:{width:binding.clientRect.right,height:binding.clientRect.bottom,dpi:binding.dpi,...Object.fromEntries(['search','editor','header','send'].map(key=>[key,structuredClone(f.config.layout[key])]))},
  voice:{recordStartRect:structuredClone(f.config.voice.recordStartRect),toolbarRect:structuredClone(f.config.voice.recordingUi.adaptive.toolbarRect)},missing:[],ambiguous:[]};}
function providerFixture(t,{createVerifier=null}={}){
  const f=setup(t),calls=[];let gateBinding=f.inspection.binding;
  const state={gate:undefined,layout:undefined,verify:undefined,verifyError:undefined,enabled:undefined,error:undefined};
  const executeImpl=async(executable,args,options)=>{
    // Match execFile: a null signal is an invalid argument, not "no signal".
    if(Object.hasOwn(options,'signal')&&options.signal===null)throw Object.assign(new TypeError('The options.signal argument must be an instance of AbortSignal'),{code:'ERR_INVALID_ARG_TYPE'});
    const requestFile=args[args.indexOf('--request')+1],request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
    calls.push({executable,args,options,request,requestFile});
    assert.equal(options.windowsHide,true);assert.equal(options.shell,false);assert.equal(options.timeout,15000);
    if(state.block)await state.block(options);
    if(state.error)throw state.error;
    let value;
    if(args[0]==='--inspect')value=path.basename(executable)==='WechatAccessibilityGate.exe'?state.gate??gatePacket(f,gateBinding):state.emptyTree??emptyTreePacket(gateBinding);
    else if(args[0]==='--enable')value=state.enabled??{ok:true,inputSent:false,gateEnabled:true,binding:structuredClone(request.expected),bytesWritten:1};
    else {assert.equal(path.basename(executable),'WechatBackgroundControls.exe');assert.ok(['--layout','--verify-layout'].includes(args[0]));if(args[0]==='--verify-layout'){const error=state.verifyErrors?.shift()??state.verifyError;if(error)throw error;value=state.verify??fastPacket(state.layout,request.verifyPhase);}else {const error=state.layoutErrors?.shift();if(error)throw error;value=state.layout??layoutPacket(f,gateBinding);}}
    return{stdout:JSON.stringify(value)};
  };
  const provider=createUiaControlProvider({root:f.root.replaceAll('\\','/'),configFile:f.configFile.replaceAll('\\','/'),executeImpl,createVerifier});
  const client={async request(action){assert.fail(`Control discovery must not request physical activation geometry: ${action}`);}};
  const resolve=provider.resolveControls;provider.resolveControls=options=>resolve({client,...options});
  return{...f,provider,state,calls,client,setBinding(binding){gateBinding=binding;},assertClean(){for(const call of calls)assert.equal(fs.existsSync(call.requestFile),false);}};
}

test('forward-slash paths and reordered identity/rect fields retain exact bindings',async t=>{
  const f=providerFixture(t),gate=gatePacket(f,f.inspection.binding);gate.candidateRequest.expected=reverse(gate.binding);gate.candidateRequest.configPath=f.configFile.replaceAll('\\','/');f.state.gate=gate;f.state.layout=reverse(layoutPacket(f));
  assert.deepEqual(await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'voice-start'}),{verified:true,proof:'uia-controls-v1'});
  assert.equal(f.provider.controlVerificationPolicy,'input-boundaries-v1');
  assert.deepEqual(f.calls.map(call=>call.args[0]),['--layout']);
  assert.equal(f.calls[0].args.includes('--allow-gate-write'),false);
  assert.deepEqual(f.calls[0].request,{version:1,hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',executable:f.config.executable});f.assertClean();
});

test('standard tree discovery is serialized per HWND/PID/creation time without gate access; geometry refreshes every operation',async t=>{
  const f=providerFixture(t),binding=f.inspection.binding;
  await Promise.all([f.provider.ensure(binding),f.provider.ensure(binding),f.provider.ensure(binding)]);
  assert.deepEqual(f.calls.map(call=>call.args[0]),['--layout']);
  await f.provider.inspectControls(f.config,binding);await f.provider.inspectControls(f.config,{...binding,foreground:true});
  assert.equal(f.calls.filter(call=>call.args[0]==='--layout').length,3);assert.equal(f.calls.filter(call=>call.args[0]==='--enable').length,0);
  for(const [key,value]of [['processCreatedFileTimeUtc','12346'],['pid',43],['hwnd','101']]){binding[key]=value;f.setBinding(binding);await f.provider.ensure(binding);}
  assert.equal(f.calls.length,6);
  f.provider.reset();await f.provider.ensure(binding);assert.equal(f.calls.length,7);assert.ok(f.calls.every(call=>call.args[0]==='--layout'));f.assertClean();
});

test('an available standard tree never inspects or writes the gate regardless of its value',async t=>{
  const f=providerFixture(t);f.state.gate={...gatePacket(f,f.inspection.binding),gateEnabled:true};await f.provider.ensure(f.inspection.binding);await f.provider.ensure(f.inspection.binding);
  assert.deepEqual(f.calls.map(call=>call.args[0]),['--layout']);f.assertClean();
});

test('confirmed missing standard tree permits one pinned gate activation and reuses the verified first layout',async t=>{
  const f=providerFixture(t);f.state.layoutErrors=[missingRootError()];
  assert.equal((await f.provider.inspectControls(f.config,f.inspection.binding)).ok,true);
  assert.deepEqual(f.calls.map(call=>[path.basename(call.executable),call.args[0]]),[
    ['WechatBackgroundControls.exe','--layout'],['WechatBackgroundControls.exe','--inspect'],
    ['WechatAccessibilityGate.exe','--inspect'],['WechatAccessibilityGate.exe','--enable'],['WechatBackgroundControls.exe','--layout']]);
  assert.deepEqual(f.calls[3].request,gatePacket(f,f.inspection.binding).candidateRequest);assert.equal(f.calls[3].args.at(-1),'--allow-gate-write');
  await f.provider.inspectControls(f.config,f.inspection.binding);assert.equal(f.calls.length,6);assert.equal(f.calls.at(-1).args[0],'--layout');f.assertClean();
});

test('confirmed missing tree with an already active gate does not write it again',async t=>{
  const f=providerFixture(t);f.state.layoutErrors=[missingRootError()];f.state.gate={...gatePacket(f,f.inspection.binding),gateEnabled:true};
  await f.provider.inspectControls(f.config,f.inspection.binding);assert.deepEqual(f.calls.map(call=>call.args[0]),['--layout','--inspect','--inspect','--layout']);f.assertClean();
});

test('a tree arriving during the extra standard observation gets one full role check without gate access',async t=>{
  const f=providerFixture(t);f.state.layoutErrors=[missingRootError()];f.state.emptyTree=emptyTreePacket(f.inspection.binding);f.state.emptyTree.mmuiControlCount=1;f.state.emptyTree.nodes=[{className:'mmui::MainWindow'}];
  await f.provider.inspectControls(f.config,f.inspection.binding);assert.deepEqual(f.calls.map(call=>call.args[0]),['--layout','--inspect','--layout']);assert.ok(f.calls.every(call=>path.basename(call.executable)==='WechatBackgroundControls.exe'));f.assertClean();
});

for(const [name,patch,failure]of [
  ['timeout',{}, {killed:true}],['signal',{}, {signal:'SIGTERM'}],['stderr',{}, {stderr:'unexpected'}],['exit',{}, {code:2}],
  ['changed identity',{error:'UI_CONTROLS_PROCESS_CHANGED'},{}],['changed focus',{error:'UI_CONTROLS_WECHAT_FOREGROUND'},{}],['changed activity',{error:'UI_CONTROLS_ACTIVITY_CHANGED'},{}],
  ['unaccessed UI',{uiAccessed:false},{}],['input report',{inputSent:true},{}],['provider text',{namesAndValuesRead:true},{}],
])test(`standard discovery ${name} never authorizes gate fallback`,async t=>{
  const f=providerFixture(t);f.state.layoutErrors=[missingRootError(patch,failure)];
  await assert.rejects(f.provider.inspectControls(f.config,f.inspection.binding),{code:'UIA_MODE_RESULT_UNCONFIRMED'});assert.equal(f.calls.length,1);f.assertClean();
});

for(const [name,change]of Object.entries({
  partial:p=>p.complete=false,activity:p=>p.inputTickUnchanged=false,foreground:p=>p.foregroundUnchanged=false,cursor:p=>p.cursorUnchanged=false,
  pid:p=>p.after.pid++,created:p=>p.before.processCreatedFileTimeUtc='12346',actualActivity:p=>p.after.lastInputTick++,actualFocus:p=>p.after.foregroundHwnd='300',
  wechatForeground:p=>p.before.foregroundHwnd=p.after.foregroundHwnd='100',mmui:p=>p.mmuiControlCount=1,hiddenMmui:p=>p.nodes[0].className='mmui::MainWindow',empty:p=>{p.nodes=[];p.nodeCount=0;},
}))test(`missing-root fallback rejects ${name} tree evidence before gate access`,async t=>{
  const f=providerFixture(t);f.state.layoutErrors=[missingRootError()];f.state.emptyTree=emptyTreePacket(f.inspection.binding);change(f.state.emptyTree);
  await assert.rejects(f.provider.inspectControls(f.config,f.inspection.binding),{code:'UIA_MODE_CONTROLS_UNAVAILABLE'});assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>path.basename(call.executable)==='WechatBackgroundControls.exe'));f.assertClean();
});

test('a gate activation cannot authorize unavailable roles or a failed subsequent layout',async t=>{
  const f=providerFixture(t);f.state.layoutErrors=[missingRootError()];f.state.layout=layoutPacket(f);f.state.layout.missing=['editor'];
  await assert.rejects(f.provider.inspectControls(f.config,f.inspection.binding),{code:'UIA_MODE_CONTROLS_UNAVAILABLE'});assert.equal(f.calls.length,5);
  f.state.layout=layoutPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);assert.equal(f.calls.length,6);assert.equal(f.calls.at(-1).args[0],'--layout');f.assertClean();
});

test('post-preparation null signal becomes a valid owned AbortSignal for native exec',async t=>{
  const f=providerFixture(t);
  for(const operation of ['text-input','text-submit','image-input','image-submit']){
    assert.deepEqual(await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation,signal:null}),{verified:true,proof:'uia-controls-v1'});
  }
  assert.equal(f.calls.filter(call=>call.args[0]==='--layout').length,4);
  for(const call of f.calls)assert.ok(call.options.signal instanceof AbortSignal);
  const controller=new AbortController();
  await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'image-input',signal:controller.signal});
  assert.equal(f.calls.at(-1).options.signal.aborted,false);controller.abort();assert.equal(f.calls.at(-1).options.signal.aborted,true);f.assertClean();
});

for(const [name,change]of Object.entries({hwnd:b=>b.hwnd='0',pid:b=>b.pid=0,overflowPid:b=>b.pid=2147483648,created:b=>b.processCreatedFileTimeUtc='9223372036854775808',numericHandle:b=>b.hwnd=100}))test(`invalid ${name} is refused before invoking a helper`,async t=>{
  const f=providerFixture(t),binding=structuredClone(f.inspection.binding);change(binding);await assert.rejects(f.provider.ensure(binding),{code:'UIA_MODE_BINDING_INVALID'});assert.equal(f.calls.length,0);
});

for(const [name,change]of Object.entries({pid:g=>g.binding.pid++,creation:g=>g.binding.processCreatedFileTimeUtc='20000',hwnd:g=>g.binding.hwnd='999',input:g=>g.inputSent=true,unknownGate:g=>g.gateEnabled=undefined,stringGate:g=>g.gateEnabled='false',candidateVersion:g=>g.candidateRequest.version=2,candidateHwnd:g=>g.candidateRequest.hwnd='99',candidateFile:g=>g.candidateRequest.configPath=path.join(os.tmpdir(),'other.json'),expected:g=>g.candidateRequest.expected.coreSha256='e'.repeat(64)}))test(`gate inspection rejects changed ${name} before enabling`,async t=>{
  const f=providerFixture(t);f.state.layoutErrors=[missingRootError()];f.state.gate=gatePacket(f,f.inspection.binding);change(f.state.gate);await assert.rejects(f.provider.ensure(f.inspection.binding),{code:'UIA_MODE_BINDING_CHANGED'});assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.args[0]!=='--enable'));f.assertClean();
});

for(const [name,change]of Object.entries({gate:g=>g.gateEnabled=false,input:g=>g.inputSent=true,identity:g=>g.binding.coreSha256='e'.repeat(64)}))test(`enable confirmation rejects changed ${name} and never caches it`,async t=>{
  const f=providerFixture(t);f.state.layoutErrors=[missingRootError()];f.state.enabled={ok:true,inputSent:false,gateEnabled:true,binding:gatePacket(f,f.inspection.binding).binding};change(f.state.enabled);
  await assert.rejects(f.provider.ensure(f.inspection.binding),{code:'UIA_MODE_BINDING_CHANGED'});f.state.enabled=undefined;f.state.layoutErrors=[missingRootError()];await f.provider.ensure(f.inspection.binding);
  assert.equal(f.calls.filter(call=>path.basename(call.executable)==='WechatAccessibilityGate.exe'&&call.args[0]==='--inspect').length,2);f.assertClean();
});

test('a failed or timed-out helper cannot authorize success from stdout and temporary requests are removed',async t=>{
  const f=providerFixture(t);f.state.error=Object.assign(new Error('private child error'),{stdout:JSON.stringify(gatePacket(f,f.inspection.binding)),killed:true});
  await assert.rejects(f.provider.ensure(f.inspection.binding),error=>error.code==='UIA_MODE_RESULT_UNCONFIRMED'&&!error.message.includes('private'));
  f.assertClean();f.state.error=undefined;await f.provider.ensure(f.inspection.binding);assert.equal(f.calls.length,2);
});

for(const [name,change]of Object.entries({pid:p=>p.binding.pid++,creation:p=>p.binding.processCreatedFileTimeUtc='98765',hwnd:p=>p.binding.hwnd='101',dpi:p=>p.binding.dpi=120,client:p=>p.binding.clientRect.right++,capture:p=>p.binding.captureRect.left++,readOnly:p=>p.readOnly=false,input:p=>p.inputSent=true,foreground:p=>p.foregroundUnchanged=false,stable:p=>p.bindingStable=false,complete:p=>p.complete=false}))test(`fresh layout refuses changed ${name}`,async t=>{
  const f=providerFixture(t);f.state.layout=layoutPacket(f);change(f.state.layout);await assert.rejects(f.provider.inspectControls(f.config,f.inspection.binding),{code:'UIA_MODE_BINDING_CHANGED'});f.assertClean();
});

for(const [name,change]of Object.entries({client:b=>b.clientRect.left=1,capture:b=>b.captureRect.right++,dpi:b=>b.dpi=0,extraCoordinate:b=>b.captureRect.extra=0}))test(`malformed ${name} binding never requests a gate write`,async t=>{
  const f=providerFixture(t),binding=structuredClone(f.inspection.binding);change(binding);await assert.rejects(f.provider.inspectControls(f.config,binding),{code:'UIA_MODE_BINDING_INVALID'});assert.equal(f.calls.length,0);
});

for(const role of ['search','editor','header','send','recordStart','toolbar'])for(const field of ['missing','ambiguous'])test(`${field} required ${role} refuses controls`,async t=>{
  const f=providerFixture(t);f.state.layout=layoutPacket(f);f.state.layout[field]=[role];await assert.rejects(f.provider.inspectControls(f.config,f.inspection.binding),{code:'UIA_MODE_CONTROLS_UNAVAILABLE'});
});

test('missing optional image/file buttons does not disable image paste through the verified editor',async t=>{
  const f=providerFixture(t);f.state.layout=layoutPacket(f);f.state.layout.missing=['image','file'];f.state.layout.imageAvailable=false;f.state.layout.layoutAvailable=false;
  assert.equal((await f.provider.inspectControls(f.config,f.inspection.binding)).ok,true);
});

for(const [name,change]of Object.entries({missing:p=>p.missing={},ambiguous:p=>p.ambiguous=[42],width:p=>p.layout.width++,height:p=>p.layout.height++,dpi:p=>p.layout.dpi++,editor:p=>p.layout.editor.left=-1,send:p=>p.layout.send.right=801,voice:p=>delete p.voice.recordStartRect,toolbar:p=>p.voice.toolbarRect.bottom=601}))test(`invalid ${name} layout is refused`,async t=>{
  const f=providerFixture(t);f.state.layout=layoutPacket(f);change(f.state.layout);await assert.rejects(f.provider.inspectControls(f.config,f.inspection.binding),{code:'UIA_MODE_LAYOUT_INVALID'});
});

test('resolveControls builds UIA geometry without pixel calibration or physical mouse parking',async t=>{
  const f=providerFixture(t),before=structuredClone(f.config);f.state.layout=layoutPacket(f);f.state.layout.layout.editor.left=302;f.state.layout.layout.send.left=702;f.state.layout.voice.recordStartRect=r(725,550,745,580);f.state.layout.voice.toolbarRect=r(301,545,779,595);
  const result=await f.provider.resolveControls({config:f.config,inspection:f.inspection});assert.equal(result.verified,true);assert.equal(result.proof,'uia-controls-v1');assert.deepEqual(f.config,before);
  assert.equal(result.config.layoutMode,'uia-v1');assert.equal(result.config.focusActivationMode,'uia-caption-v1');assert.deepEqual(Object.keys(result.config.layout).sort(),['width','height','dpi','search','header','editor','send'].sort());
  assert.equal(result.config.layout.editor.left,302);assert.equal(result.config.layout.send.left,702);assert.deepEqual(result.config.voice.recordStartRect,r(725,550,745,580));assert.deepEqual(result.config.voice.toolbarRect,r(301,545,779,595));assert.deepEqual(result.config.voice.recordingUi.uia,{version:1,executableVersion:'4.1.15.56'});assert.equal(Object.hasOwn(result.config.voice,'mouseParkRect'),false);
  for(const key of ['account','accountRef','accountAlias','executable','executableSha256','executableVersion','idleMs'])assert.equal(result.config[key],before[key]);
  for(const key of ['selfSurface','profileSurface','selfCloseKey','profileCloseKey'])assert.equal(Object.hasOwn(result.config,key),false);
  const missing=structuredClone(f.config);delete missing.voice;assert.ok((await f.provider.resolveControls({config:missing,inspection:f.inspection})).config.voice.recordingUi.uia);
});

for(const role of ['editor','send','header','recordStart','toolbar'])test(`verification rereads live controls and rejects moved ${role}`,async t=>{
  const f=providerFixture(t);await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'voice-start'});f.state.layout=layoutPacket(f);
  const area=role==='recordStart'?f.state.layout.voice.recordStartRect:role==='toolbar'?f.state.layout.voice.toolbarRect:f.state.layout.layout[role];area.left++;
  await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'voice-start'}),{code:'UIA_MODE_CONTROLS_CHANGED'});
  assert.equal(f.calls.filter(call=>call.args[0]==='--layout').length,2);assert.equal(f.calls.filter(call=>call.args[0]==='--enable').length,0);
});

test('fresh verification cannot reuse prior controls after helper failure or cancellation',async t=>{
  const f=providerFixture(t);await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'image-input'});f.state.error=new Error('reader failed');
  await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-input'}),{code:'UIA_MODE_RESULT_UNCONFIRMED'});
  const count=f.calls.length,abort=new AbortController();abort.abort();await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-input',signal:abort.signal}),{code:'UIA_MODE_ABORTED'});assert.equal(f.calls.length,count);f.assertClean();
});

function proofPacket(f){
  const packet=layoutPacket(f);packet.binding.rootRuntimeIdSha256='f'.repeat(64);packet.controls={};
  for(const [index,role]of ['search','editor','header','send','recordStart','toolbar'].entries()){
    packet.controls[role]={runtimeIdSha256:String(index+1).padStart(64,'0'),path:[0,index],className:'mmui::Fixture'+role,controlType:role==='editor'||role==='search'?'ControlType.Edit':'ControlType.Group',automationId:role==='editor'?'chat_input_field':null,
      rect:structuredClone(role==='recordStart'?packet.voice.recordStartRect:role==='toolbar'?packet.voice.toolbarRect:packet.layout[role]),staticLabel:role==='send'?'发送':role==='recordStart'?'语音消息':null,enabled:true,offscreen:false,labelSource:null};
  }
  packet.verification={version:1,rootRuntimeIdSha256:packet.binding.rootRuntimeIdSha256,clientRect:structuredClone(packet.binding.clientRect),captureRect:structuredClone(packet.binding.captureRect),dpi:packet.binding.dpi,roles:structuredClone(packet.controls)};return packet;
}
function fastPacket(packet,phase='input'){const roles=['editor','send','header',...(phase==='voice-start'?['recordStart','toolbar']:[])];return{...structuredClone(packet),operation:'verify-layout',verifiedRoleCount:roles.length,verifiedRoles:roles,controls:Object.fromEntries(roles.map(role=>[role,structuredClone(packet.controls[role])]))};}
function fingerprintPacket(packet,phase='input'){return{...fastPacket(packet,phase),titleTextRead:true,fingerprintUnavailable:false,conversationFingerprint:{version:1,scope:'chat-title-text-v1',sha256:'a'.repeat(64),headerRuntimeIdSha256:packet.controls.header.runtimeIdSha256,titleRuntimeIdSha256:'b'.repeat(64),textNodeCount:1,targetVerified:false}};}
function geometryReadinessPacket(packet){const roles=['search','editor','header','send','recordStart','toolbar'];return{...readinessPacket(packet),controls:structuredClone(packet.controls),verifiedRoles:roles,verifiedRoleCount:roles.length,navigationGeometryRefreshed:true,verification:structuredClone(packet.verification)};}
function staleLocatorError(patch={},failure={}){return Object.assign(new Error('safe refusal'),{code:1,killed:false,signal:null,stderr:'',stdout:JSON.stringify({ok:false,schemaVersion:1,error:'UI_CONTROLS_FAST_LOCATOR_CHANGED',readOnly:true,inputSent:false,messageSendAttempted:false,namesAndValuesRead:false,searchValueIncluded:false,eligibleForAutomation:false,...patch}),...failure});}

test('navigation continuation and every media input boundary request the bounded title digest',async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.resolveControls({config:f.config,inspection:f.inspection});
  for(const operation of ['navigation-continuation','text-input','text-submit','prepare','image-input','image-post-paste','image-submit','image-resume','voice-start','background-warmup']){
    const selected=['navigation-continuation','text-input','text-submit','image-input','image-post-paste','image-submit','image-resume','voice-start'].includes(operation);
    f.state.verify=selected?fingerprintPacket(f.state.layout,operation==='voice-start'?'voice-start':'input'):fastPacket(f.state.layout);
    const result=await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation});
    assert.equal(Object.hasOwn(f.calls.at(-1).request,'includeConversationFingerprint'),selected);if(selected)assert.equal(f.calls.at(-1).request.includeConversationFingerprint,true);
    assert.deepEqual(result,{verified:true,proof:'uia-controls-v1',...(selected?{conversationFingerprint:f.state.verify.conversationFingerprint}:{})});
    if(selected){result.conversationFingerprint.sha256='c'.repeat(64);assert.equal(f.state.verify.conversationFingerprint.sha256,'a'.repeat(64));}
  }f.assertClean();
});

test('missing or unavailable title hints allow verified controls with no cached positive fingerprint',async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.resolveControls({config:f.config,inspection:f.inspection});
  f.state.verify=fingerprintPacket(f.state.layout);assert.ok((await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-input'})).conversationFingerprint);
  for(const report of [fastPacket(f.state.layout),{...fastPacket(f.state.layout),conversationFingerprint:null,fingerprintUnavailable:true,titleTextRead:true}]){
    f.state.verify=report;assert.deepEqual(await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'navigation-continuation'}),{verified:true,proof:'uia-controls-v1'});
    assert.equal(f.calls.at(-1).request.includeConversationFingerprint,true);
  }f.assertClean();
});

for(const [name,change]of Object.entries({
  version:p=>p.conversationFingerprint.version=2,scope:p=>p.conversationFingerprint.scope='whole-window',digest:p=>p.conversationFingerprint.sha256='a'.repeat(63),uppercase:p=>p.conversationFingerprint.sha256='A'.repeat(64),
  header:p=>p.conversationFingerprint.headerRuntimeIdSha256='e'.repeat(64),title:p=>p.conversationFingerprint.titleRuntimeIdSha256=null,target:p=>p.conversationFingerprint.targetVerified=true,
  noText:p=>p.conversationFingerprint.textNodeCount=0,tooMany:p=>p.conversationFingerprint.textNodeCount=5,fractional:p=>p.conversationFingerprint.textNodeCount=1.5,
  extraName:p=>p.conversationFingerprint.name='PRIVATE_TITLE_FIXTURE',missing:p=>delete p.conversationFingerprint.scope,array:p=>p.conversationFingerprint=[],
  unread:p=>p.titleTextRead=false,unavailable:p=>p.fingerprintUnavailable=true,
}))test(`malformed ${name} title fingerprint never becomes a continuation proof`,async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.resolveControls({config:f.config,inspection:f.inspection});f.state.verify=fingerprintPacket(f.state.layout);change(f.state.verify);
  await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'navigation-continuation'}),error=>error.code==='UIA_MODE_VERIFICATION_INVALID'&&!JSON.stringify(error).includes('PRIVATE_TITLE_FIXTURE')&&!error.message.includes('PRIVATE_TITLE_FIXTURE'));f.assertClean();
});

test('background resolution discovers identities once and foreground verification uses fresh limited locators',async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);
  await f.provider.resolveControls({config:f.config,inspection:f.inspection});
  for(const operation of ['prepare','text-input','text-submit','image-input','image-submit','voice-start'])assert.equal((await f.provider.verifyControls({config:f.config,binding:{...reverse(f.inspection.binding),foreground:true},operation,signal:null})).verified,true);
  assert.equal(f.calls.filter(call=>call.args[0]==='--layout').length,1);assert.equal(f.calls.filter(call=>call.args[0]==='--verify-layout').length,6);
  assert.deepEqual(f.calls.filter(call=>call.args[0]==='--verify-layout').map(call=>call.request.verifyPhase),['input','input','input','input','input','voice-start']);
  assert.deepEqual(f.calls.at(-1).request.verification,f.state.layout.verification);f.assertClean();
});

test('a changed window geometry or explicit reset discards cached locators before verification',async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);
  const moved=structuredClone(f.inspection.binding);moved.captureRect.left+=20;moved.captureRect.right+=20;f.state.layout.binding.captureRect=structuredClone(moved.captureRect);f.state.layout.verification.captureRect=structuredClone(moved.captureRect);
  await f.provider.verifyControls({config:f.config,binding:moved,operation:'text-input'});assert.deepEqual(f.calls.slice(-2).map(call=>call.args[0]),['--layout','--verify-layout']);
  f.provider.reset();await f.provider.verifyControls({config:f.config,binding:moved,operation:'text-input'});assert.equal(f.calls.at(-1).args[0],'--verify-layout');assert.equal(f.calls.filter(call=>call.args[0]==='--verify-layout').length,2);
});

for(const [name,change]of Object.entries({root:p=>p.verification.rootRuntimeIdSha256='b'.repeat(64),path:p=>p.verification.roles.editor.path=[512],emptyPath:p=>p.verification.roles.editor.path=[],duplicate:p=>p.verification.roles.editor.runtimeIdSha256=p.verification.roles.search.runtimeIdSha256,missing:p=>delete p.verification.roles.send,geometry:p=>p.verification.captureRect.left++,control:p=>p.verification.roles.editor.rect.left++}))test(`malformed ${name} locator proof is never cached`,async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);change(f.state.layout);await assert.rejects(f.provider.resolveControls({config:f.config,inspection:f.inspection}),{code:'UIA_MODE_VERIFICATION_INVALID'});assert.equal(f.calls.filter(call=>call.args[0]==='--verify-layout').length,0);
});

test('an explicitly stale read-only locator performs one full rediscovery before accepting a replacement',async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);f.state.verifyErrors=[staleLocatorError()];
  f.state.layout.controls.editor.runtimeIdSha256='e'.repeat(64);f.state.layout.verification.roles.editor.runtimeIdSha256='e'.repeat(64);
  f.state.verify=fingerprintPacket(f.state.layout);
  const result=await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'image-input'});assert.deepEqual(f.calls.slice(-3).map(call=>call.args[0]),['--verify-layout','--layout','--verify-layout']);assert.deepEqual(result.conversationFingerprint,f.state.verify.conversationFingerprint);
  f.state.verifyError=undefined;await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'image-submit'});assert.equal(f.calls.at(-1).request.verification.roles.editor.runtimeIdSha256,'e'.repeat(64));
});

test('stale rediscovery cannot drop its proof and substitute an unverified full-scan fingerprint',async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);f.state.verifyErrors=[staleLocatorError()];
  delete f.state.layout.verification;f.state.layout.conversationFingerprint=fingerprintPacket(f.state.layout).conversationFingerprint;
  await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'image-input'}),{code:'UIA_MODE_RESULT_UNCONFIRMED'});
  assert.deepEqual(f.calls.slice(-2).map(call=>call.args[0]),['--verify-layout','--layout']);
});

for(const [name,packet,failure]of [
  ['nonzero success',{ok:true},{}],['input',{inputSent:true},{}],['not readonly',{readOnly:false},{}],['unknown code',{error:'UI_CONTROLS_PROVIDER_FAILED'},{}],['changed geometry',{error:'UI_CONTROLS_LAYOUT_BINDING_CHANGED'},{}],['timeout',{}, {killed:true}],['stderr',{}, {stderr:'private diagnostic'}],['unknown exit',{}, {code:'ERR_INVALID_ARG_TYPE'}],
])test(`fast ${name} failure cannot trigger full-scan fallback or authorize input`,async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);const count=f.calls.length;f.state.verifyError=staleLocatorError(packet,failure);
  await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'image-input'}),{code:'UIA_MODE_RESULT_UNCONFIRMED'});assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1).args[0],'--verify-layout');f.assertClean();
});

for(const [name,change]of Object.entries({root:p=>p.binding.rootRuntimeIdSha256='e'.repeat(64),roleCount:p=>p.verifiedRoleCount=5,identity:p=>p.controls.editor.runtimeIdSha256='e'.repeat(64),path:p=>p.controls.editor.path=[1,2],metadata:p=>p.controls.editor.className='mmui::Other',position:p=>{p.controls.editor.rect.left++;p.layout.editor.left++;}}))test(`fast verification cannot accept changed ${name} from cached proof`,async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);f.state.verify=fastPacket(f.state.layout);change(f.state.verify);
  await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-input'}),{code:'UIA_MODE_VERIFICATION_INVALID'});assert.equal(f.calls.at(-1).args[0],'--verify-layout');
});

function runtimeFixture(t){
  const f=setup(t),state={events:[],inspection:f.inspection,request:undefined,controls:undefined,close:undefined,clientOptions:undefined,providerOptions:undefined};
  const runtime=createUiaModeRuntime({root:f.root,hostConfig:f.configFile,
    createClient(options){state.clientOptions=options;state.events.push('createClient');return{async request(action){assert.equal(action,'inspectLayout');state.events.push(action);return state.request?await state.request():structuredClone(state.inspection);},async close(){state.events.push('close');if(state.close)await state.close();}};},
    createProvider(options){state.providerOptions=options;return{async inspectControls(config,binding,{signal}){state.events.push('inspectControls');state.observed={config:structuredClone(config),binding:structuredClone(binding),signal};if(state.controls)return state.controls(signal);return layoutPacket(f,binding);},resolveControls(){assert.fail('startup must not merge calibration or resolve input geometry');}};}});
  return{...f,runtime,state};
}

test('startup is read-only, accepts current dimensions independently of old config, and closes its child',async t=>{
  const f=runtimeFixture(t);f.state.inspection.binding.clientRect=r(0,0,1080,1848);f.state.inspection.binding.captureRect=r(-1080,0,0,1848);
  assert.deepEqual(await f.runtime.start(),{ready:true,backend:'uia',accessibilityEnabled:true});assert.equal(f.state.clientOptions.enableInput,false);
  assert.deepEqual(f.state.events,['createClient','inspectLayout','inspectControls','close']);assert.deepEqual(f.state.observed.config,f.config);assert.equal(f.state.observed.binding.clientRect.bottom,1848);assert.equal(f.state.observed.config.layout.height,600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile,'utf8')),f.config);assert.equal(f.state.observed.signal.aborted,false);
  assert.deepEqual(await f.runtime.close(),{stopped:true,backend:'uia',accessibilityMayRemainEnabled:true});await f.runtime.close();assert.equal(f.state.events.filter(x=>x==='close').length,1);
  await assert.rejects(f.runtime.start(),{code:'UIA_MODE_LIFECYCLE_INVALID'});
});

for(const [name,change,code]of [
  ['input',p=>p.inputSent=true,'UI_QT_LAYOUT_INSPECTION_INVALID'],['focus',p=>p.focusChanged=true,'UI_QT_LAYOUT_INSPECTION_INVALID'],['clipboard',p=>p.clipboardAccessed=true,'UI_QT_LAYOUT_INSPECTION_INVALID'],['readOnly',p=>p.readOnly=false,'UI_QT_LAYOUT_INSPECTION_INVALID'],
  ['executable hash',p=>p.executableSha256='e'.repeat(64),'UIA_MODE_BINDING_CHANGED'],['executable version',p=>p.executableVersion='4.1.15.57','UIA_MODE_BINDING_CHANGED'],['capture',p=>p.binding.captureRect.right++,'UIA_MODE_BINDING_CHANGED'],
])test(`unsafe startup ${name} closes child without opening the gate`,async t=>{
  const f=runtimeFixture(t);change(f.state.inspection);await assert.rejects(f.runtime.start(),{code});assert.deepEqual(f.state.events,['createClient','inspectLayout','close']);assert.equal((await f.runtime.close()).accessibilityMayRemainEnabled,false);
});

test('inspection or controls failures close the child and never return ready',async t=>{
  for(const stage of ['request','controls']){const f=runtimeFixture(t);f.state[stage]=async()=>{throw Object.assign(new Error('fixture failure'),{code:'FIXTURE_FAILURE'});};await assert.rejects(f.runtime.start(),{code:'FIXTURE_FAILURE'});await f.runtime.close();assert.equal(f.state.events.filter(x=>x==='close').length,1);}
});

test('concurrent start is rejected; closing a pending inspection aborts startup and joins cleanup once',async t=>{
  const f=runtimeFixture(t),read=deferred(),entered=deferred();f.state.request=async()=>{entered.resolve();return read.promise;};
  const start=f.runtime.start();const rejected=assert.rejects(start,{code:'UIA_MODE_ABORTED'});await entered.promise;await assert.rejects(f.runtime.start(),{code:'UIA_MODE_LIFECYCLE_INVALID'});
  let stopped=false;const closing=f.runtime.close().then(result=>{stopped=true;return result;});await Promise.resolve();assert.equal(stopped,false);read.resolve(f.inspection);await rejected;
  assert.equal((await closing).accessibilityMayRemainEnabled,false);assert.equal(f.state.events.includes('inspectControls'),false);assert.equal(f.state.events.filter(x=>x==='close').length,1);
});

test('close aborts a pending controls read and waits until it settles',async t=>{
  const f=runtimeFixture(t),entered=deferred(),read=deferred();f.state.controls=async signal=>{entered.resolve(signal);return read.promise;};
  const start=f.runtime.start(),rejected=assert.rejects(start,{code:'UIA_MODE_ABORTED'}),signal=await entered.promise,closing=f.runtime.close();assert.equal(signal.aborted,true);
  read.resolve(layoutPacket(f));await rejected;assert.equal((await closing).accessibilityMayRemainEnabled,true);assert.equal(f.state.events.filter(x=>x==='close').length,1);
});

for(const stage of ['request','controls','close'])test(`caller abort during ${stage} is checked after await and cannot return ready`,async t=>{
  const f=runtimeFixture(t),abort=new AbortController();f.state[stage]=async()=>{abort.abort();return stage==='request'?f.inspection:undefined;};
  await assert.rejects(f.runtime.start({signal:abort.signal}),{code:'UIA_MODE_ABORTED'});await f.runtime.close();assert.equal(f.state.events.filter(x=>x==='close').length,1);
});

test('closed or pre-aborted startup creates no child',async t=>{
  const f=runtimeFixture(t);assert.equal((await f.runtime.close()).accessibilityMayRemainEnabled,false);await assert.rejects(f.runtime.start(),{code:'UIA_MODE_LIFECYCLE_INVALID'});assert.deepEqual(f.state.events,[]);
  const g=runtimeFixture(t),abort=new AbortController();abort.abort();await assert.rejects(g.runtime.start({signal:abort.signal}),{code:'UIA_MODE_LIFECYCLE_INVALID'});assert.deepEqual(g.state.events,[]);
});

test('cleanup errors are surfaced rather than reporting stopped or ready',async t=>{
  const f=runtimeFixture(t);f.state.close=async()=>{throw Object.assign(new Error('fixture close failure'),{code:'FIXTURE_CLEANUP_FAILED'});};
  await assert.rejects(f.runtime.start(),{code:'FIXTURE_CLEANUP_FAILED'});await assert.rejects(f.runtime.close(),{code:'FIXTURE_CLEANUP_FAILED'});assert.equal(f.state.events.filter(x=>x==='close').length,1);
});

function workerFixture(t,{ready=true,respond=true,exitOnKill=true,exitOnEnd=true,startTimeoutMs=100,requestTimeoutMs=100,closeTimeoutMs=30}={}){
  const f=setup(t),state={children:[],packets:[],spawnOptions:[],respond,exitOnKill,exitOnEnd};
  const spawnImpl=(executable,args,options)=>{
    assert.equal(path.basename(executable),'WechatBackgroundControls.exe');assert.deepEqual(args,['--serve-layout']);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);state.spawnOptions.push(options);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=0;child.ended=false;child.exited=false;
    child.exit=(code=0,signal=null)=>{if(child.exited)return;child.exited=true;child.emit('close',code,signal);};
    child.reply=packet=>child.stdout.write(JSON.stringify(packet)+'\n');
    child.stdin=new Writable({write(chunk,_encoding,callback){const packet=JSON.parse(chunk.toString());state.packets.push(packet);queueMicrotask(()=>{if(typeof state.respond==='function')state.respond(packet,child);else if(state.respond)child.reply({version:1,id:packet.id,report:{ok:true,readOnly:true,inputSent:false,echo:packet.request}});});callback();},final(callback){child.ended=true;callback();if(state.exitOnEnd)queueMicrotask(()=>child.exit());}});
    child.kill=()=>{child.kills++;if(state.exitOnKill)queueMicrotask(()=>child.exit(null,'SIGTERM'));return true;};state.children.push(child);
    if(ready)queueMicrotask(()=>child.reply({version:1,ready:true,backend:'uia-verifier',readOnly:true,inputSent:false}));return child;
  };
  const client=new UiaVerifierClient({root:f.root,spawnImpl,startTimeoutMs,requestTimeoutMs,closeTimeoutMs});t.after(()=>client.close().catch(()=>{}));return{...f,client,state};
}

test('persistent verifier warms without UI requests then reuses one process with independent correlated bindings',async t=>{
  const f=workerFixture(t);assert.deepEqual(await f.client.start(),{ready:true,readOnly:true,inputSent:false});assert.equal(f.state.packets.length,0);
  const first={hwnd:'100',pid:42,processCreatedFileTimeUtc:'1'},second={hwnd:'101',pid:43,processCreatedFileTimeUtc:'2'};
  assert.deepEqual((await f.client.request(first,{signal:null})).echo,first);assert.deepEqual((await f.client.request(second)).echo,second);assert.equal(f.state.children.length,1);assert.deepEqual(f.state.packets.map(p=>p.id),[1,2]);
  const closing=f.client.close();assert.equal(f.client.close(),closing);assert.deepEqual(await closing,{processStopped:true,forced:false});assert.equal(f.state.children[0].ended,true);assert.equal(f.state.children[0].kills,0);
  await assert.rejects(f.client.request(first),{code:'UIA_MODE_VERIFIER_CLOSED'});
});

test('a pre-aborted verifier never spawns, and closing an unused client is confirmed',async t=>{
  const f=workerFixture(t),abort=new AbortController();abort.abort();await assert.rejects(f.client.start({signal:abort.signal}),{code:'UIA_MODE_ABORTED'});assert.equal(f.state.children.length,0);assert.deepEqual(await f.client.close(),{processStopped:true});
});

for(const phase of ['startup','request'])test(`persistent ${phase} timeout kills and confirms the read-only child`,async t=>{
  const f=workerFixture(t,{ready:phase!=='startup',respond:false,startTimeoutMs:20,requestTimeoutMs:20});
  await assert.rejects(phase==='startup'?f.client.start():f.client.request({}),{code:'UIA_MODE_VERIFIER_TIMEOUT'});assert.equal(f.state.children[0].exited,true);assert.ok(f.state.children[0].kills>=1);assert.equal((await f.client.close()).processStopped,true);
});

test('aborting an active verification waits for worker exit and never replays its request',async t=>{
  const f=workerFixture(t,{respond:false}),abort=new AbortController();await f.client.start();const pending=f.client.request({hwnd:'100'},{signal:abort.signal}),rejected=assert.rejects(pending,{code:'UIA_MODE_ABORTED'});
  await new Promise(resolve=>setImmediate(resolve));abort.abort();await rejected;assert.equal(f.state.packets.length,1);assert.equal(f.state.children[0].exited,true);assert.equal((await f.client.close()).processStopped,true);
});

test('closing during a pending request rejects it, kills once owned work is abandoned, and confirms exit',async t=>{
  const f=workerFixture(t,{respond:false});await f.client.start();const pending=f.client.request({}),rejected=assert.rejects(pending,{code:'UIA_MODE_VERIFIER_CLOSED'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.client.close()).processStopped,true);await rejected;assert.equal(f.state.packets.length,1);assert.equal(f.state.children[0].exited,true);
});

test('concurrent verification is rejected without canceling the existing read',async t=>{
  const f=workerFixture(t,{respond:false});await f.client.start();const first=f.client.request({first:true});await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.client.request({second:true}),{code:'UIA_MODE_VERIFIER_BUSY'});
  f.state.children[0].reply({version:1,id:1,report:{ok:true}});assert.equal((await first).ok,true);assert.equal(f.state.packets.length,1);assert.equal(f.state.children[0].kills,0);
});

for(const invalid of ['id','json','stderr','unsolicited','oversize'])test(`persistent ${invalid} output is redacted, fails closed, and stops its child`,async t=>{
  const f=workerFixture(t,{respond:false});await f.client.start();const pending=f.client.request({}),rejected=assert.rejects(pending,error=>error.code==='UIA_MODE_VERIFIER_PROTOCOL_INVALID'&&!error.message.includes('private'));
  await new Promise(resolve=>setImmediate(resolve));const child=f.state.children[0];
  if(invalid==='id')child.reply({version:1,id:999,report:{ok:true}});if(invalid==='json')child.stdout.write('private not-json\n');if(invalid==='stderr')child.stderr.write('private stderr');if(invalid==='unsolicited')child.reply({version:1,ready:true});if(invalid==='oversize')child.stdout.write('x'.repeat(2*1024*1024+1));
  await rejected;assert.equal(child.exited,true);
});

test('native read-only refusals preserve the worker and do not become cached success',async t=>{
  const f=workerFixture(t);f.state.respond=(packet,child)=>child.reply({version:1,id:packet.id,report:{ok:false,error:'UI_CONTROLS_FAST_LOCATOR_CHANGED',readOnly:true,inputSent:false}});
  assert.equal((await f.client.request({})).ok,false);assert.equal((await f.client.request({})).ok,false);assert.equal(f.state.children.length,1);assert.equal(f.state.children[0].kills,0);
});

test('unexpected worker exit is never replaced or retried inside an input boundary',async t=>{
  const f=workerFixture(t);await f.client.start();f.state.children[0].exit(1);await assert.rejects(f.client.request({}),{code:'UIA_MODE_VERIFIER_EXITED'});assert.equal(f.state.children.length,1);assert.equal(f.state.packets.length,0);assert.equal((await f.client.close()).processStopped,true);
});

test('a worker that cannot confirm exit cannot claim processStopped',async t=>{
  const f=workerFixture(t,{respond:false,exitOnKill:false,exitOnEnd:false,requestTimeoutMs:15,closeTimeoutMs:10});
  await assert.rejects(f.client.request({}),{code:'UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED'});await assert.rejects(f.client.close(),{code:'UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED'});
  f.state.children[0].exit(null,'SIGTERM');
});

test('provider prewarms in background resolution and uses the same read-only worker for both body boundaries',async t=>{
  const events=[],requests=[];let closes=0;
  const f=providerFixture(t,{createVerifier:()=>({async start(){events.push('warm');},async request(request){events.push('verify');requests.push(request);return fastPacket(f.state.layout,request.verifyPhase);},async close(){closes++;return{processStopped:true};}})});f.state.layout=proofPacket(f);
  await f.provider.resolveControls({config:f.config,inspection:f.inspection});assert.deepEqual(events,['warm','verify']);assert.equal(requests[0].verifyPhase,'input');
  await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-input'});await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-submit'});
  assert.deepEqual(events,['warm','verify','verify','verify']);assert.equal(f.calls.filter(call=>call.args[0]==='--verify-layout').length,0);assert.equal(requests.length,3);
  assert.deepEqual(await f.provider.close(),{processStopped:true});await f.provider.close();assert.equal(closes,1);await assert.rejects(f.provider.ensure(f.inspection.binding),{code:'UIA_MODE_VERIFIER_CLOSED'});
});

test('provider closure aborts and joins pending one-shot work before reporting stopped',async t=>{
  const f=providerFixture(t),entered=deferred();f.state.block=({signal})=>new Promise((resolve,reject)=>{entered.resolve(signal);signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{code:'ABORT_ERR'})),{once:true});});
  const pending=f.provider.ensure(f.inspection.binding),rejected=assert.rejects(pending,{code:'UIA_MODE_VERIFIER_CLOSED'}),signal=await entered.promise;
  assert.deepEqual(await f.provider.close(),{processStopped:true});await rejected;assert.equal(signal.aborted,true);f.assertClean();
});

test('a failed worker is recreated only at the next background resolution after its exit is confirmed',async t=>{
  const events=[],workers=[];let failNext=false;
  const f=providerFixture(t,{createVerifier:()=>{const id=workers.length+1,worker={async start(){events.push('start'+id);},async request(request){events.push('verify'+id);if(failNext){failNext=false;this.failure=Object.assign(new Error('timeout'),{code:'UIA_MODE_VERIFIER_TIMEOUT'});throw this.failure;}return fastPacket(f.state.layout,request.verifyPhase);},async close(){events.push('close'+id);return{processStopped:true};}};workers.push(worker);return worker;}});f.state.layout=proofPacket(f);
  await f.provider.resolveControls({config:f.config,inspection:f.inspection});failNext=true;
  await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-submit'}),{code:'UIA_MODE_VERIFIER_TIMEOUT'});
  assert.equal(workers.length,1);assert.deepEqual(events,['start1','verify1','verify1']);
  await f.provider.resolveControls({config:f.config,inspection:f.inspection});assert.deepEqual(events.slice(-3),['close1','start2','verify2']);assert.equal(workers.length,2);
  await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-input'});assert.equal(events.at(-1),'verify2');
  await f.provider.close();assert.equal(events.at(-1),'close2');
});

test('provider refuses cleanup confirmation when a worker does not report processStopped',async t=>{
  const f=providerFixture(t,{createVerifier:()=>({start:async()=>{},request:async request=>fastPacket(f.state.layout,request.verifyPhase),close:async()=>({processStopped:false})})});f.state.layout=proofPacket(f);
  await f.provider.resolveControls({config:f.config,inspection:f.inspection});await assert.rejects(f.provider.close(),{code:'UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED'});
});

test('runtime startup cleanup closes both its temporary Qt client and verifier provider',async t=>{
  const f=setup(t),closed=[];const runtime=createUiaModeRuntime({root:f.root,hostConfig:f.configFile,createClient:()=>({request:async()=>f.inspection,close:async()=>{closed.push('qt');}}),createProvider:()=>({inspectControls:async()=>layoutPacket(f),close:async()=>{closed.push('uia');return{processStopped:true};}})});
  assert.equal((await runtime.start()).ready,true);assert.deepEqual(closed.sort(),['qt','uia']);await runtime.close();assert.equal(closed.length,2);
});

test('UIA resolution derives current size and DPI before any old pixel layout is selected',async t=>{
  const f=providerFixture(t),observed=structuredClone(f.inspection);observed.binding.clientRect=r(0,0,1000,700);observed.binding.captureRect=r(-1000,20,0,720);observed.binding.dpi=120;f.setBinding(observed.binding);
  f.state.layout=layoutPacket(f,observed.binding);f.state.layout.layout.editor=r(300,550,980,640);f.state.layout.layout.send=r(900,650,980,690);f.state.layout.voice={recordStartRect:r(900,650,920,680),toolbarRect:r(300,645,980,695)};
  const result=await f.provider.resolveControls({config:f.config,inspection:observed});assert.deepEqual([result.config.layout.width,result.config.layout.height,result.config.layout.dpi],[1000,700,120]);assert.deepEqual(result.config.layout.editor,r(300,550,980,640));assert.equal(Object.hasOwn(result.config.voice,'mouseParkRect'),false);assert.equal(f.config.layout.width,800);
});

test('UIA discovery succeeds without a caption-capable client and never queries fallback geometry',async t=>{
  for(const client of [undefined,{}, {request(){throw Object.assign(new Error('caption root unavailable'),{code:'UIA_CAPTION_ROOT_MISMATCH'});}}]){
    const f=providerFixture(t),result=await f.provider.resolveControls({config:f.config,inspection:f.inspection,client});
    assert.equal(result.verified,true);assert.equal(result.config.focusActivationMode,'uia-caption-v1');assert.equal(Object.hasOwn(result.config.voice,'mouseParkRect'),false);f.assertClean();
  }
});

test('UIA first resolution checks executable integrity before any gate request',async t=>{
  for(const kind of ['hash','version','unsupported']){
    const f=providerFixture(t),config=structuredClone(f.config),observed=structuredClone(f.inspection);
    if(kind==='hash')observed.executableSha256='e'.repeat(64);if(kind==='version')observed.executableVersion='4.1.15.57';if(kind==='unsupported')config.executableVersion=observed.executableVersion='4.1.15.57';
    await assert.rejects(f.provider.resolveControls({config,inspection:observed}),{code:'UIA_MODE_BINDING_CHANGED'});assert.equal(f.calls.length,0);
  }
});

const readinessRequest=()=>({version:1,expectedTitleSha256:'1'.repeat(64),expectedQuerySha256:'2'.repeat(64),searchPopupHwnd:'101'});
function readinessPacket(packet,request=readinessRequest()){
  return{...fingerprintPacket(packet),navigationReadiness:{version:1,ready:true,reason:null,primaryTitleSha256:request.expectedTitleSha256,querySha256:request.expectedQuerySha256,samePage:true,pageRuntimeIdSha256:'3'.repeat(64),editorWritable:true,searchClosed:true,searchPopupHwnd:request.searchPopupHwnd,targetVerified:false}};
}
test('navigation readiness requests exact title/query/popup proof from a fresh read-only verifier',async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.resolveControls({config:f.config,inspection:f.inspection});
  for(const hwnd of ['101','0']){
    const request={...readinessRequest(),searchPopupHwnd:hwnd};f.state.verify=readinessPacket(f.state.layout,request);
    const result=await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:request});assert.equal(result.verified,true);assert.equal(result.navigationReady.ready,true);assert.equal(result.navigationReady.targetVerified,false);assert.deepEqual(f.calls.at(-1).request.navigationReadiness,request);assert.equal(f.calls.at(-1).request.verifyPhase,'navigation-ready');assert.equal(f.calls.at(-1).request.includeConversationFingerprint,true);
    result.navigationReady.ready=false;assert.equal(f.state.verify.navigationReadiness.ready,true);
  }
  f.state.verify=readinessPacket(f.state.layout);Object.assign(f.state.verify.navigationReadiness,{ready:false,reason:'UI_CONTROLS_CONVERSATION_SEARCH_OPEN',primaryTitleSha256:null,pageRuntimeIdSha256:null,samePage:false,editorWritable:false,searchClosed:false});delete f.state.verify.conversationFingerprint;
  const waiting=await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:readinessRequest()});assert.equal(waiting.verified,true);assert.equal(waiting.navigationReady.ready,false);assert.equal(waiting.conversationFingerprint,undefined);f.assertClean();
});

test('navigation readiness refuses invalid requests before invoking any helper',async t=>{
  for(const change of [r=>r.version=2,r=>r.expectedTitleSha256='PRIVATE_TITLE',r=>delete r.expectedQuerySha256,r=>r.searchPopupHwnd=101,r=>r.searchPopupHwnd='-1',r=>r.extra=true]){
    const f=providerFixture(t),request=readinessRequest();change(request);await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:request}),{code:'UIA_MODE_READINESS_INVALID'});assert.equal(f.calls.length,0);
  }
});

test('navigation readiness cannot accept mismatched, incomplete or unsanitized positive results',async t=>{
  const changes=[p=>p.navigationReadiness.version=2,p=>p.navigationReadiness.ready='true',p=>p.navigationReadiness.reason='unexpected',p=>p.navigationReadiness.primaryTitleSha256='4'.repeat(64),p=>p.navigationReadiness.querySha256='4'.repeat(64),p=>p.navigationReadiness.pageRuntimeIdSha256=null,p=>p.navigationReadiness.samePage=false,p=>p.navigationReadiness.editorWritable=false,p=>p.navigationReadiness.searchClosed=false,p=>p.navigationReadiness.searchPopupHwnd='102',p=>p.navigationReadiness.targetVerified=true,p=>p.navigationReadiness.name='PRIVATE_TITLE',p=>delete p.conversationFingerprint,p=>{p.navigationReadiness.ready=false;p.navigationReadiness.reason='PRIVATE_TITLE';}];
  for(const change of changes){const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.resolveControls({config:f.config,inspection:f.inspection});f.state.verify=readinessPacket(f.state.layout);change(f.state.verify);
    await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:readinessRequest()}),error=>error.code==='UIA_MODE_READINESS_INVALID'&&!error.message.includes('PRIVATE_TITLE'));f.assertClean();}
});

test('readiness cannot treat a full-scan cache refresh as conversation-ready proof',async t=>{
  const f=providerFixture(t);f.state.layout=proofPacket(f);f.state.verify=readinessPacket(f.state.layout);
  assert.equal((await f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:readinessRequest()})).navigationReady.ready,true);
  assert.deepEqual(f.calls.slice(-2).map(call=>call.args[0]),['--layout','--verify-layout']);
  f.state.verifyError=staleLocatorError();const baseline=f.calls.length;
  await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:readinessRequest()}),{code:'UIA_MODE_RESULT_UNCONFIRMED'});
  assert.deepEqual(f.calls.slice(baseline).map(call=>call.args[0]),['--verify-layout','--layout','--verify-layout']);f.assertClean();
});

test('post-search geometry refresh keeps exact native roles and avoids a second whole-tree scan',async t=>{
  const f=providerFixture(t);f.inspection.binding.threadId=7;f.state.layout=proofPacket(f);f.state.layout.inputTickUnchanged=true;
  await f.provider.inspectControls(f.config,f.inspection.binding);
  f.state.layout.layout.header.bottom=100;f.state.layout.controls.header.rect.bottom=100;f.state.layout.verification.roles.header.rect.bottom=100;
  f.state.verify=geometryReadinessPacket(f.state.layout);
  const config={...f.config,layoutMode:'uia-v1'},result=await f.provider.verifyControls({config,binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:readinessRequest(),allowLayoutRefresh:true});
  assert.equal(result.navigationReady.ready,true);assert.equal(result.navigationLayout.layout.header.bottom,100);
  assert.equal(f.calls.at(-1).request.refreshNavigationGeometry,true);assert.equal(f.calls.filter(c=>c.args[0]==='--layout').length,1);
  f.state.verify=fingerprintPacket(f.state.layout);
  await f.provider.verifyControls({config:{...config,layout:{...config.layout,...result.navigationLayout.layout}},binding:f.inspection.binding,operation:'text-input'});
  assert.equal(f.calls.at(-1).request.verification.roles.header.rect.bottom,100);
  assert.equal(f.calls.at(-1).request.refreshNavigationGeometry,undefined);
});

test('geometry refresh rejects different role identities and unverified geometry packets',async t=>{
  for(const kind of ['runtime','class','path','proof','bounds','marker']){
    const f=providerFixture(t);f.inspection.binding.threadId=7;f.state.layout=proofPacket(f);f.state.layout.inputTickUnchanged=true;await f.provider.inspectControls(f.config,f.inspection.binding);
    f.state.verify=geometryReadinessPacket(f.state.layout);
    if(kind==='runtime')f.state.verify.controls.editor.runtimeIdSha256='9'.repeat(64);
    if(kind==='class')f.state.verify.controls.editor.className='OtherEdit';
    if(kind==='path')f.state.verify.controls.editor.path=[2,1];
    if(kind==='proof')delete f.state.verify.verification;
    if(kind==='bounds')f.state.verify.layout.header.right=f.state.verify.controls.header.rect.right=801;
    if(kind==='marker')delete f.state.verify.navigationGeometryRefreshed;
    await assert.rejects(f.provider.verifyControls({config:{...f.config,layoutMode:'uia-v1'},binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:readinessRequest(),allowLayoutRefresh:true}),{code:'UIA_MODE_VERIFICATION_INVALID'});
  }
});

test('only post-search readiness rediscovers a moved group header and returns fresh bounded geometry',async t=>{
  const f=providerFixture(t);f.inspection.binding.threadId=7;f.state.layout=proofPacket(f);f.state.layout.inputTickUnchanged=true;
  await f.provider.inspectControls(f.config,f.inspection.binding);
  const oldHeader=structuredClone(f.config.layout.header),header={...oldHeader,bottom:100};
  f.state.layout.layout.header=header;f.state.layout.controls.header.rect=structuredClone(header);f.state.layout.verification.roles.header.rect=structuredClone(header);
  f.state.verify=geometryReadinessPacket(f.state.layout);f.state.verifyErrors=[staleLocatorError({error:'UI_CONTROLS_LAYOUT_MOVED'})];
  const config={...f.config,layoutMode:'uia-v1'},request=readinessRequest();
  const proof=await f.provider.verifyControls({config,binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:request,allowLayoutRefresh:true});
  assert.equal(proof.navigationReady.ready,true);assert.deepEqual(proof.navigationLayout.layout.header,header);assert.deepEqual(f.config.layout.header,oldHeader);
  assert.deepEqual(Object.keys(proof.navigationLayout).sort(),['binding','layout','version','voice']);assert.equal(Object.keys(proof.navigationLayout.layout).length,7);assert.equal(Object.keys(proof.navigationLayout.voice).length,2);
  assert.deepEqual(f.calls.slice(-3).map(call=>call.args[0]),['--verify-layout','--layout','--verify-layout']);assert.deepEqual(proof.conversationFingerprint,f.state.verify.conversationFingerprint);
  const adopted={...config,layout:{...config.layout,...proof.navigationLayout.layout}};f.state.verify=fingerprintPacket(f.state.layout);
  assert.equal((await f.provider.verifyControls({config:adopted,binding:f.inspection.binding,operation:'text-input'})).verified,true);f.assertClean();
});

test('navigation layout refresh cannot bypass readiness, changed activity, thread or a second native refusal',async t=>{
  for(const kind of ['not-ready','activity','thread','second-refusal']){
    const f=providerFixture(t);f.inspection.binding.threadId=7;f.state.layout=proofPacket(f);f.state.layout.inputTickUnchanged=true;await f.provider.inspectControls(f.config,f.inspection.binding);
    f.state.layout.layout.header.bottom=100;f.state.layout.controls.header.rect.bottom=100;f.state.layout.verification.roles.header.rect.bottom=100;
    if(kind==='activity')f.state.layout.inputTickUnchanged=false;if(kind==='thread')f.state.layout.binding.threadId=8;
    f.state.verify=geometryReadinessPacket(f.state.layout);f.state.verifyErrors=[staleLocatorError({error:'UI_CONTROLS_LAYOUT_MOVED'}),...(kind==='second-refusal'?[staleLocatorError({error:'UI_CONTROLS_LAYOUT_MOVED'})]:[])];
    if(kind==='not-ready')Object.assign(f.state.verify.navigationReadiness,{ready:false,reason:'UI_CONTROLS_CONVERSATION_TITLE_MISMATCH',primaryTitleSha256:'3'.repeat(64)});
    const operation=f.provider.verifyControls({config:{...f.config,layoutMode:'uia-v1'},binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:readinessRequest(),allowLayoutRefresh:true});
    if(kind==='not-ready'){const result=await operation;assert.equal(result.navigationReady.ready,false);assert.equal(result.navigationLayout,undefined);}
    else await assert.rejects(operation,{code:kind==='second-refusal'?'UIA_MODE_RESULT_UNCONFIRMED':'UIA_MODE_BINDING_CHANGED'});
    assert.equal(f.calls.filter(c=>c.args[0]==='--layout').length,2,kind);
  }
});

test('post-search final control movement after bounded title reads requests one full rediscovery and fresh readiness',async t=>{
  const f=providerFixture(t);f.inspection.binding.threadId=7;f.state.layout=proofPacket(f);f.state.layout.inputTickUnchanged=true;await f.provider.inspectControls(f.config,f.inspection.binding);
  f.state.layout.layout.header.bottom=100;f.state.layout.controls.header.rect.bottom=100;f.state.layout.verification.roles.header.rect.bottom=100;f.state.verify=geometryReadinessPacket(f.state.layout);
  f.state.verifyErrors=[staleLocatorError({error:'UI_CONTROLS_LAYOUT_CONTROL_CHANGED',namesAndValuesRead:true,titleTextRead:true})];
  const result=await f.provider.verifyControls({config:{...f.config,layoutMode:'uia-v1'},binding:f.inspection.binding,operation:'navigation-ready',navigationReadiness:readinessRequest(),allowLayoutRefresh:true});
  assert.equal(result.navigationReady.ready,true);assert.equal(result.navigationLayout.layout.header.bottom,100);assert.deepEqual(f.calls.slice(-3).map(c=>c.args[0]),['--verify-layout','--layout','--verify-layout']);
});

test('title-read error envelopes need the exact opt-in and never expand body-boundary layout recovery',async t=>{
  for(const [operation,patch,reason]of [['text-input',{namesAndValuesRead:true,titleTextRead:true},true],['background-warmup',{namesAndValuesRead:true,titleTextRead:true},false],['text-input',{namesAndValuesRead:true,titleTextRead:false},false],['text-input',{namesAndValuesRead:true,titleTextRead:true,searchValueIncluded:true},false],['text-input',{namesAndValuesRead:true,titleTextRead:true,inputSent:true},false]]){
    const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);f.state.verifyError=staleLocatorError({error:'UI_CONTROLS_LAYOUT_CONTROL_CHANGED',...patch});
    await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation}),error=>error.code==='UIA_MODE_RESULT_UNCONFIRMED'&&(reason?error.nativeReason==='UI_CONTROLS_LAYOUT_CONTROL_CHANGED':error.nativeReason===undefined));assert.equal(f.calls.filter(c=>c.args[0]==='--layout').length,1);
  }
});

test('layout changes stay rejected outside an explicit real-search readiness boundary',async t=>{
  for(const operation of ['navigation-ready','text-input','image-input','voice-start']){
    const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);f.state.verifyError=staleLocatorError({error:'UI_CONTROLS_LAYOUT_MOVED'});
    await assert.rejects(f.provider.verifyControls({config:{...f.config,layoutMode:'uia-v1'},binding:f.inspection.binding,operation,...(operation==='navigation-ready'?{navigationReadiness:readinessRequest()}:{})}),error=>error.code==='UIA_MODE_RESULT_UNCONFIRMED'&&error.nativeReason==='UI_CONTROLS_LAYOUT_MOVED');
    assert.equal(f.calls.at(-1).args[0],'--verify-layout');assert.equal(f.calls.filter(c=>c.args[0]==='--layout').length,1);
  }
  for(const options of [{operation:'text-input'},{operation:'navigation-ready',navigationReadiness:{...readinessRequest(),searchPopupHwnd:'0'}},{operation:'navigation-ready',navigationReadiness:readinessRequest(),legacy:true}]){
    const f=providerFixture(t);await assert.rejects(f.provider.verifyControls({config:{...f.config,layoutMode:options.legacy?'adaptive-v1':'uia-v1'},binding:f.inspection.binding,...options,allowLayoutRefresh:true}),{code:'UIA_MODE_READINESS_INVALID'});assert.equal(f.calls.length,0);
  }
});

test('native refusal diagnostics preserve only allowlisted codes with confirmed read-only envelopes',async t=>{
  for(const [code,patch,expected]of [['UI_CONTROLS_LAYOUT_LABEL_CHANGED',{},true],['UI_CONTROLS_PRIVATE_TITLE',{},false],['UI_CONTROLS_LAYOUT_MOVED',{inputSent:true},false]]){
    const f=providerFixture(t);f.state.layout=proofPacket(f);await f.provider.inspectControls(f.config,f.inspection.binding);f.state.verifyError=staleLocatorError({error:code,...patch});
    await assert.rejects(f.provider.verifyControls({config:f.config,binding:f.inspection.binding,operation:'text-input'}),error=>error.code==='UIA_MODE_RESULT_UNCONFIRMED'&&(expected?error.nativeReason===code:error.nativeReason===undefined));
  }
});
