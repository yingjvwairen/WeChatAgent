import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runUiService, readUiServiceSettings } from './ui-service.mjs';
import { validateUiBridgeConfig } from './ui-onebot.mjs';
import { activateLocalReaderAccount } from './reader-local-setup.mjs';
import { readerAccountId, activeReaderAccount } from './reader-account-state.mjs';
import { validateConfig } from './project-config.mjs';
import {UiaModeStore} from './uia-mode.mjs';
import {createUiaOffscreenManager} from './uia-offscreen.mjs';

const example = JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json', import.meta.url), 'utf8'));
const protectedKey = 'userdpapi:' + Buffer.concat([Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb','hex'),Buffer.alloc(48,7)]).toString('base64');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file,JSON.stringify(value)); };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-ui-service-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root,{recursive:true,force:true}); });
  const dbPath = path.join(root, 'wechat/wxid_fixture'), myWxid = 'wxid_fixture'; fs.mkdirSync(path.join(dbPath,'db_storage'),{recursive:true});
  const accountRef = readerAccountId(root,{dbPath,myWxid});
  const binding = {account:{dbPath,myWxid,accountRef},python:path.join(root,'python.exe'),cached:{schemaVersion:1,accountRef,protectedKey,savedAt:new Date().toISOString()}};
  write(path.join(root,'config/wechatagent.example.json'),example);
  return {root,binding,check:()=>binding};
}
test('verified local account activates DSH scope without Hook and without starting replies', t => {
  const f=fixture(t), result=activateLocalReaderAccount(f);
  assert.equal(result.liveAccountVerified,false); assert.equal(result.automaticReplies,false);
  assert.equal(activeReaderAccount(f.root).id,f.binding.account.accountRef);
  const config=JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json')));
  assert.equal(config.runtime.sender,'wechat-ui'); assert.equal(validateConfig(config),config);
  assert.equal(JSON.stringify(result).includes(protectedKey),false);
  assert.equal(activateLocalReaderAccount(f).needsDshRestart,false);
});
test('activation rejects another active account and a running Reader before modifying files', t => {
  const f=fixture(t); write(path.join(f.root,'state/weflow/active-account.json'),{id:'b'.repeat(64)});
  assert.throws(()=>activateLocalReaderAccount(f),{code:'READER_LOCAL_ACTIVATION_ACCOUNT_MISMATCH'});
  assert.equal(fs.existsSync(path.join(f.root,'config/wechatagent.json')),false);
  write(path.join(f.root,'state/weflow/active-account.json'),{id:''});
  write(path.join(f.root,'state/reader-service/service.lock'),{pid:123});
  assert.throws(()=>activateLocalReaderAccount(f),{code:'READER_LOCAL_ACTIVATION_BUSY'});
});
test('reactivating the same Reader preserves an explicitly configured local UI settings path',t=>{
  const f=fixture(t);activateLocalReaderAccount(f);
  const file=path.join(f.root,'config/wechatagent.json'),config=JSON.parse(fs.readFileSync(file));
  config.ui.bridgeConfig=path.join(f.root,'state/ui-bridge/custom-config.json');write(file,config);
  activateLocalReaderAccount(f);
  assert.equal(JSON.parse(fs.readFileSync(file)).ui.bridgeConfig,config.ui.bridgeConfig);
});
test('service settings reject disk tokens and unactivated Reader identities', t => {
  const f=fixture(t);activateLocalReaderAccount(f);
  const hostConfig=path.join(f.root,'state/ui-runtime/qt-visual.json');write(hostConfig,{version:1});
  const bridgeFile=path.join(f.root,'state/ui-bridge/config.json');
  write(bridgeFile,{version:1,hostConfig,enableInput:false,allowSubmit:false});
  assert.equal(readUiServiceSettings(f).accountRef,f.binding.account.accountRef);
  write(bridgeFile,{version:1,hostConfig,enableInput:false,allowSubmit:false,reader:{token:'x'}});
  assert.throws(()=>readUiServiceSettings(f),{code:'UI_SERVICE_CONFIG_INVALID'});
  write(bridgeFile,{version:1,hostConfig,enableInput:false,allowSubmit:false});
  write(path.join(f.root,'state/weflow/active-account.json'),{id:'c'.repeat(64)});
  assert.throws(()=>readUiServiceSettings(f),{code:'UI_SERVICE_ACCOUNT_NOT_ACTIVATED'});
});
test('local bridge settings only allow clipboard replacement with an explicit boolean opt-in', t=>{
  const f=fixture(t);activateLocalReaderAccount(f);
  const hostConfig=path.join(f.root,'state/ui-runtime/qt-visual.json');
  write(hostConfig,{version:1});
  const file=path.join(f.root,'state/ui-bridge/config.json');
  const settings={version:1,driver:'qt-visual',hostConfig,enableInput:true,allowSubmit:true};
  const binding={accountDirectory:'fixture-account',accountWxid:'fixture_me',targets:[],
    reader:{baseUrl:'http://127.0.0.1:10001',token:'a'.repeat(64)},onebotUrl:'ws://127.0.0.1:10002/ws'};
  for(const value of [undefined,false,true]){
    write(file,value===undefined?settings:{...settings,allowClipboardReplacement:value});
    assert.equal(validateUiBridgeConfig({...readUiServiceSettings(f).settings,...binding}).allowClipboardReplacement,value===true);
  }
  for(const value of [null,1,'true']){
    const invalid={...settings,allowClipboardReplacement:value};
    write(file,invalid);
    assert.throws(()=>readUiServiceSettings(f),{code:'UI_SERVICE_CONFIG_INVALID'});
    assert.throws(()=>validateUiBridgeConfig({...invalid,...binding}),{code:'UI_CONFIG_INVALID'});
  }
});
function harness() {
  const controller=new AbortController(),events=[]; let version=1;
  const load=()=>({accountRef:'a'.repeat(64),settingsFile:'fixture',settings:{version:1,hostConfig:'fixture-host',enableInput:true,allowSubmit:true},config:{ports:{weflow:25001,onebot:25002}}});
  const createStore=()=>({file:'fixture-selection',get:()=>({version,targets:[{wxid:'fixture_friend',id:'1'}]})});
  const startReader=async({signal})=>{
    const current=version;events.push('reader-start-'+current);let resolve;
    const done=new Promise(r=>resolve=r);let stopped=false;
    const stop=async()=>{if(!stopped){stopped=true;events.push('reader-stop-'+current);resolve({stopped:true});}return done;};
    signal.addEventListener('abort',()=>void stop(),{once:true});
    return{accountWxid:'fixture_me',accountDirectory:'fixture-directory',baseUrl:'http://127.0.0.1:25001',token:'private-token',initialCursor:'e'.repeat(32)+':0',done,stop};
  };
  const createUiaStore=()=>({get:()=>({version:0,enabled:false})});
  const createOffscreenStore=()=>({get:()=>({schemaVersion:1,version:0,enabled:false})});
  const createVoiceService=()=>({ensureReady:async()=>({ready:true}),close:async()=>{}});
  return{root:path.join(os.tmpdir(),'wechat-service-offline-'+crypto.randomUUID()),controller,events,load,createStore,startReader,createUiaStore,createOffscreenStore,createVoiceService,setVersion:v=>version=v};
}
function offscreenHarness(){
  const h=harness();let mode={version:1,enabled:true},setting={schemaVersion:1,version:0,enabled:false},control,modeControl,bridges=0,safe=true;
  const events=h.events;
  return{...h,get control(){return control;},get modeControl(){return modeControl;},get mode(){return mode;},get setting(){return setting;},setSafe:value=>{safe=value;},setInitial:value=>{setting={...setting,...value};},
    createUiaStore:()=>({get:()=>({...mode}),replace:r=>mode={version:r.expectedVersion+1,enabled:r.enabled}}),inspectUia:()=>({canEnable:true}),
    createOffscreenStore:()=>({get:()=>({...setting}),replace:r=>{assert.equal(r.expectedVersion,setting.version);events.push('save-'+r.enabled);return setting={schemaVersion:1,version:r.expectedVersion+1,enabled:r.enabled};}}),
    readHostConfig:()=>({fixture:true}),createOffscreenManager:()=>({setEnabled:async({enabled})=>{events.push('window-'+enabled);return{state:enabled?'parked':'restored',parked:enabled,restored:!enabled,released:!enabled};},close:async()=>{events.push('window-close');}}),
    createUiaRuntime:()=>({start:async()=>({ready:true}),close:async()=>{}}),onOffscreenControl:handler=>{control=handler;},onSenderControl:handler=>{modeControl=handler;},
    runBridge:async({signal,onSenderSwitchCheck,uiaMode})=>{const n=++bridges;events.push('bridge-start-'+n+'-'+uiaMode);onSenderSwitchCheck(()=>safe);await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});events.push('bridge-stop-'+n);return{senderSwitchSafe:safe};}
  };
}
async function controlsReady(h){for(let i=0;i<100&&!h.control;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(typeof h.control,'function');await new Promise(resolve=>setImmediate(resolve));}
test('explicit offscreen toggles move immediately with no queued message and keep UIA and Reader running',async()=>{
  const h=offscreenHarness(),pause={kind:'manual',revision:110},before=JSON.stringify(pause);const run=runUiService({...h,signal:h.controller.signal,pollMs:10});await controlsReady(h);
  assert.equal(h.events.some(v=>v.startsWith('window-')),false);
  const on=await h.control({backend:'uia-offscreen',expectedVersion:0,enabled:true});assert.equal(on.enabled,true);assert.equal(on.windowState.parked,true);assert.equal(h.mode.version,1);assert.equal(h.mode.enabled,true);
  const off=await h.control({backend:'uia-offscreen',expectedVersion:1,enabled:false});assert.equal(off.enabled,false);assert.equal(off.windowState.restored,true);assert.equal(h.mode.version,1);assert.equal(JSON.stringify(pause),before);
  assert.equal(h.events.filter(v=>v.startsWith('reader-start')).length,1);assert.ok(h.events.indexOf('bridge-stop-1')<h.events.indexOf('window-true'));assert.ok(h.events.indexOf('window-true')<h.events.indexOf('bridge-start-2-true'));assert.ok(h.events.indexOf('bridge-stop-2')<h.events.indexOf('window-false'));
  h.controller.abort();await run;assert.equal(h.events.filter(v=>v==='window-close').length,1);
});
test('persisted offscreen selection is applied before sender startup and UIA off restores it',async()=>{
  const h=offscreenHarness();h.setInitial({version:3,enabled:true});const run=runUiService({...h,signal:h.controller.signal,pollMs:10});await controlsReady(h);
  assert.ok(h.events.indexOf('window-true')<h.events.indexOf('bridge-start-1-true'));
  await h.modeControl({backend:'uia',expectedVersion:1,enabled:false});assert.equal(h.setting.enabled,false);assert.equal(h.setting.version,4);assert.equal(h.mode.enabled,false);assert.ok(h.events.indexOf('window-false')<h.events.indexOf('bridge-start-2-false'));
  await assert.rejects(h.control({backend:'uia-offscreen',expectedVersion:4,enabled:true}),{code:'UIA_OFFSCREEN_UIA_REQUIRED'});h.controller.abort();await run;
});
test('offscreen version conflicts and in-progress delivery refuse before draining or moving',async()=>{
  const h=offscreenHarness(),run=runUiService({...h,signal:h.controller.signal,pollMs:10});await controlsReady(h);const before=[...h.events];
  await assert.rejects(h.control({backend:'uia-offscreen',expectedVersion:1,enabled:true}),{code:'UIA_OFFSCREEN_VERSION_CONFLICT'});h.setSafe(false);
  await assert.rejects(h.control({backend:'uia-offscreen',expectedVersion:0,enabled:true}),{code:'UIA_OFFSCREEN_PENDING_DELIVERY'});assert.deepEqual(h.events,before);assert.equal(h.setting.version,0);h.setSafe(true);h.controller.abort();await run;
});
test('an unchanged pre-move activity refusal resumes the prior sender without changing the toggle or Reader',async()=>{
  const h=offscreenHarness(),r=(left,top,right,bottom)=>({left,top,right,bottom});
  const config={version:1,backend:'qt-visual',account:'wxid_fixture',accountRef:'a'.repeat(64),accountAlias:'fixture',executable:path.resolve('Weixin.exe'),executableVersion:'4.1.15.56',executableSha256:'b'.repeat(64),hwnd:'auto',idleMs:1000,ocrBackend:'rapidocr',layout:{width:800,height:600,dpi:96,header:r(300,10,600,40),search:r(60,10,250,50),firstResult:r(60,80,250,120),profileOpen:r(700,10,760,50),profileAlias:r(300,80,600,120),selfOpen:r(10,20,40,60),selfAlias:r(50,80,290,120),editor:r(300,450,780,540),send:r(700,550,780,590),emptyEditorSha256:'c'.repeat(64)},selfCloseKey:'Escape',profileCloseKey:'Escape'};
  const binding={hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',dpi:96,clientRect:r(0,0,800,600),captureRect:r(0,0,800,600)};let parkingCalls=0;
  const manager=createUiaOffscreenManager({root:h.root,createInspector:()=>({request:async()=>({version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:config.executableVersion,executableSha256:config.executableSha256,binding}),close:async()=>{}}),createHost:()=>({request:async()=>{parkingCalls++;return{version:1,action:'park-explicit',state:'deferred',reason:'OFFSCREEN_USER_ACTIVITY_CHANGED',released:true,parked:false,windowMoved:false,inputSent:false,clipboardAccessed:false,foregroundChanged:false,binding};},close:async()=>({processStopped:true,released:true})})});
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,readHostConfig:()=>config,createOffscreenManager:()=>manager});await controlsReady(h);
  await assert.rejects(h.control({backend:'uia-offscreen',expectedVersion:0,enabled:true}),{code:'OFFSCREEN_USER_ACTIVITY_CHANGED'});
  assert.equal(parkingCalls,1);assert.equal(h.setting.version,0);assert.equal(h.setting.enabled,false);assert.equal(h.mode.enabled,true);assert.equal(h.events.filter(v=>v.startsWith('reader-start')).length,1);assert.equal(h.events.some(v=>v.startsWith('reader-stop')),false);assert.equal(h.events.filter(v=>v.startsWith('bridge-start')).length,2);
  h.controller.abort();await run;
});
test('an unproved same-code parking failure cannot restart the sender',async()=>{
  const h=offscreenHarness(),error=Object.assign(Error(),{code:'OFFSCREEN_KEYS_HELD'});
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,createOffscreenManager:()=>({setEnabled:async()=>{throw error;},close:async()=>{}})}),failed=assert.rejects(run,{code:'OFFSCREEN_KEYS_HELD'});await controlsReady(h);
  await assert.rejects(h.control({backend:'uia-offscreen',expectedVersion:0,enabled:true}),{code:'OFFSCREEN_KEYS_HELD'});await failed;assert.equal(h.setting.version,0);assert.equal(h.events.filter(v=>v.startsWith('bridge-start')).length,1);
});
test('selection change waits for old bridge cleanup then rotates Reader token in memory',async()=>{
  const h=harness();let calls=0;
  const runBridge=async({config,signal,onState})=>{
    calls++;const n=calls;h.events.push('bridge-start-'+n);
    assert.equal(config.reader.token,'private-token');assert.equal(config.selectionVersion,n);
    onState({ob_connected:true,reader_connected:true});
    if(n===1)setTimeout(()=>h.setVersion(2),10);else setTimeout(()=>h.controller.abort(),10);
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    await new Promise(resolve=>setTimeout(resolve,10));h.events.push('bridge-stop-'+n);
  };
  await runUiService({...h,runBridge,signal:h.controller.signal,pollMs:10});
  assert.equal(calls,2);assert(h.events.indexOf('reader-start-2')>h.events.indexOf('bridge-stop-1'));
});
test('startup recalls an unfinished offscreen lease before any Reader or sender even when UIA is disabled',async()=>{
  const h=harness();await runUiService({...h,signal:h.controller.signal,pollMs:10,recoverOffscreen:async()=>{h.events.push('offscreen-recovery');return{recovered:true};},runBridge:async({uiaMode})=>{assert.equal(uiaMode,false);h.events.push('bridge');h.controller.abort();}});
  assert.equal(h.events[0],'offscreen-recovery');assert(h.events.indexOf('reader-start-1')>h.events.indexOf('offscreen-recovery'));
});
test('unconfirmed startup window recovery blocks senders and still closes the voice service',async()=>{
  const h=harness();let closed=false;await assert.rejects(runUiService({...h,signal:h.controller.signal,recoverOffscreen:async()=>{throw Object.assign(Error(),{code:'UIA_OFFSCREEN_CLEANUP_UNCONFIRMED'});},createVoiceService:()=>({ensureReady:async()=>{},close:async()=>{closed=true;}}),startReader:async()=>assert.fail('reader must not start before recovery'),runBridge:async()=>assert.fail('sender must not start before recovery')}),{code:'UIA_OFFSCREEN_CLEANUP_UNCONFIRMED'});assert.equal(closed,true);
});
test('uncertain Reader cleanup blocks restart after selection change',async()=>{
  const h=harness();let calls=0;
  const startReader=async input=>{const r=await h.startReader(input);return{...r,stop:async()=>{await r.stop();throw Object.assign(new Error('fixture'),{code:'READER_TARGET_CLEANUP_UNCONFIRMED'});}};};
  const runBridge=async({signal})=>{calls++;setTimeout(()=>h.setVersion(2),10);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));};
  await assert.rejects(runUiService({...h,startReader,runBridge,signal:h.controller.signal,pollMs:10}),{code:'READER_TARGET_CLEANUP_UNCONFIRMED'});
  assert.equal(calls,1);
});
test('ordinary bridge failure is not retried automatically',async()=>{
  const h=harness();let calls=0;
  await assert.rejects(runUiService({...h,signal:h.controller.signal,pollMs:10,runBridge:async()=>{calls++;throw Object.assign(new Error('fixture'),{code:'UI_FIXTURE_FAILED'});}}),{code:'UI_FIXTURE_FAILED'});
  assert.equal(calls,1);assert(h.events.includes('reader-stop-1'));
});

test('private Reader publisher is revoked before shutdown and rotates with the selection',async()=>{
  const h=harness();let calls=0;
  const onReader=({reader,accountRef,selectionVersion,targets,signal,validateCurrent})=>{
    assert.equal(reader.token,'private-token');assert.equal(accountRef,'a'.repeat(64));assert.equal(targets[0].id,'1');assert.equal(signal.aborted,false);validateCurrent();
    h.events.push('publish-'+selectionVersion);return()=>h.events.push('release-'+selectionVersion);
  };
  const runBridge=async({signal})=>{const n=++calls;setTimeout(()=>n===1?h.setVersion(2):h.controller.abort(),10);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));};
  await runUiService({...h,onReader,runBridge,signal:h.controller.signal,pollMs:10});
  assert.equal(calls,2);assert(h.events.indexOf('release-1')<h.events.indexOf('publish-2'));assert(h.events.indexOf('release-2')>=0);
});
test('clean stream cancellation during selection change starts the new generation',async()=>{
  const h=harness();let calls=0;
  const runBridge=async({signal})=>{
    const n=++calls;setTimeout(()=>n===1?h.setVersion(2):h.controller.abort(),10);
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    throw Object.assign(new Error('fixture cancellation'),{code:'UI_STREAM_CANCELLED'});
  };
  await runUiService({...h,runBridge,signal:h.controller.signal,pollMs:10});assert.equal(calls,2);
});
test('clean Qt cancellation during a selection change rotates after bridge cleanup',async()=>{
  for(const code of ['UI_QT_CANCELLED','UI_QT_CLOSED']){
    const h=harness();let calls=0;
    const runBridge=async({signal})=>{const n=++calls;setTimeout(()=>n===1?h.setVersion(2):h.controller.abort(),10);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));h.events.push('qt-closed-'+n);throw Object.assign(new Error(code),{code});};
    await runUiService({...h,runBridge,signal:h.controller.signal,pollMs:10});assert.equal(calls,2);assert(h.events.indexOf('reader-start-2')>h.events.indexOf('qt-closed-1'));
  }
});

test('one lazy voice lifecycle survives selection rotation and stops only after native bridge drain',async()=>{
  const h=harness();let created=0,calls=0;
  const voice={ensureReady:async()=>{h.events.push('voice-ready');},close:async()=>{h.events.push('voice-close');}};
  await runUiService({...h,signal:h.controller.signal,pollMs:10,createVoiceService:()=>{created++;return voice;},runBridge:async({signal,voiceService})=>{
    assert.equal(voiceService,voice);const n=++calls;if(n===1)await voiceService.ensureReady();
    setTimeout(()=>n===1?h.setVersion(2):h.controller.abort(),10);
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    await new Promise(resolve=>setTimeout(resolve,10));h.events.push('native-drained-'+n);
  }});
  assert.equal(created,1);assert.equal(calls,2);assert.equal(h.events.at(-1),'voice-close');assert(h.events.indexOf('native-drained-2')<h.events.indexOf('voice-close'));
});

test('uncertain model cleanup is not marked as a clean service exit',async()=>{
  const h=harness();
  await assert.rejects(runUiService({...h,signal:h.controller.signal,pollMs:10,
    createVoiceService:()=>({close:async()=>{throw Object.assign(Error(),{code:'VOICE_SERVICE_CLEANUP_UNCONFIRMED'});}}),
    runBridge:async({signal})=>{setTimeout(()=>h.controller.abort(),1);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}}),
    error=>error.code==='VOICE_SERVICE_CLEANUP_UNCONFIRMED'&&error.cleanupConfirmed!==true);
});

test('robot startup leaves voice idle, and a console click loads on the same managed instance',async()=>{
  const h=harness(),states=[],loads=[];let control,removed=false;
  await runUiService({...h,signal:h.controller.signal,pollMs:10,onState:value=>states.push(value),
    onVoiceControl:handler=>{control=handler;return()=>{removed=true;};},
    createVoiceService:()=>({ensureReady:async()=>assert.fail('no automatic preparation'),useProfile:async request=>{loads.push(request);return{selectedId:request.id,applied:true};},close:async()=>{}}),
    runBridge:async()=>{assert.deepEqual(loads,[]);assert.equal(states.at(-1).voiceService.phase,'idle');
      assert.equal((await control({id:'dania',expectedVersion:1})).applied,true);h.controller.abort();}});
  assert.equal(removed,true);
  assert.deepEqual(loads,[{id:'dania',expectedVersion:1}]);
  assert(states.some(value=>value.voiceService.phase==='ready'));
});

test('a live UIA switch retains the Reader and full-media bridge, then restores UI only after UIA closes',async()=>{
  const h=harness();let control,mode={version:0,enabled:false},bridges=0,starts=0;
  const voice={ensureReady:async()=>({ready:true}),close:async()=>{}},settings={...h.load().settings,driver:'qt-visual',voice:{fixture:'native-voice'},images:{fixture:'image-options'}};
  const createUiaStore=()=>({get:()=>({...mode}),replace:body=>{assert.equal(body.expectedVersion,mode.version);h.events.push('save-'+body.enabled);return mode={version:mode.version+1,enabled:body.enabled};}});
  const run=runUiService({...h,load:()=>({...h.load(),settings}),createVoiceService:()=>voice,createUiaStore,signal:h.controller.signal,pollMs:10,inspectUia:()=>({canEnable:true}),
    onSenderControl:handler=>{control=handler;return()=>{control=undefined;};},
    createUiaRuntime:()=>({start:async()=>{starts++;h.events.push('uia-start');return{ready:true};},close:async()=>{h.events.push('uia-close');}}),
    runBridge:async options=>{
      const {signal,uiaMode,config,voiceService}=options;bridges++;const kind=uiaMode?'uia':'ui';h.events.push('bridge-start-'+kind);
      assert.equal(config.driver,'qt-visual');assert.deepEqual(config.voice,settings.voice);assert.deepEqual(config.images,settings.images);assert.equal(voiceService,voice);
      assert.equal(config.reader.token,'private-token');assert.equal(config.accountWxid,'fixture_me');assert.equal(config.targets[0].wxid,'fixture_friend');assert.equal(config.allowSubmit,true);
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));h.events.push('bridge-stop-'+kind);return{stopped:true,senderSwitchSafe:true};}});
  while(!control)await new Promise(resolve=>setTimeout(resolve,1));
  const enabled=await control({backend:'uia',expectedVersion:0,enabled:true});assert.equal(enabled.runtimeActive,true);assert.equal(enabled.backend,'uia');assert.equal(enabled.senderMode,'uia');
  assert.ok(h.events.indexOf('uia-start')>h.events.indexOf('bridge-stop-ui'));
  assert.ok(h.events.indexOf('save-true')>h.events.indexOf('uia-start'));
  assert.equal((await control({backend:'uia',expectedVersion:1,enabled:false})).enabled,false);
  assert.ok(h.events.indexOf('save-false')>h.events.indexOf('uia-close'));
  h.controller.abort();await run;
  assert.equal(starts,1);assert.equal(bridges,3);assert.equal(h.events.filter(value=>value==='reader-start-1').length,1);
  assert.equal(h.events.filter(value=>value==='reader-stop-1').length,1);assert.equal(mode.enabled,false);
});

test('a switch never reports runtimeActive when its replacement bridge immediately fails or exits',async()=>{
  for(const enabled of [false,true])for(const failure of ['throw','reject','exit']){
    const h=harness(),states=[];let control,bridges=0,closed=0,mode={version:2,enabled:!enabled};
    const expected=failure==='exit'?'UI_SERVICE_UNEXPECTED_EXIT':'UIA_MODE_GEOMETRY_CHANGED';
    const run=runUiService({...h,signal:h.controller.signal,pollMs:10,inspectUia:()=>({canEnable:true}),onState:state=>states.push(state),
      createUiaStore:()=>({get:()=>({...mode}),replace:request=>mode={version:request.expectedVersion+1,enabled:request.enabled}}),onSenderControl:handler=>{control=handler;},
      createUiaRuntime:()=>({start:async()=>({ready:true}),close:async()=>{closed++;}}),
      runBridge:({signal})=>{
        if(++bridges===1)return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({senderSwitchSafe:true}),{once:true}));
        if(failure==='exit')return Promise.resolve({stopped:true});
        const error=Object.assign(Error('private startup detail'),{code:expected});if(failure==='throw')throw error;return Promise.reject(error);
      }}).then(()=>null,error=>error);
    while(!control)await new Promise(resolve=>setTimeout(resolve,1));
    await assert.rejects(control({backend:'uia',expectedVersion:2,enabled}),{code:expected});
    const result=await run;assert.equal(result.code,expected);assert.equal(bridges,2);assert.equal(closed,1);
    assert.ok(states.some(state=>state.phase==='sender-blocked'&&state.reason===expected));assert.equal(JSON.stringify(states).includes('private startup detail'),false);
  }
});

test('uncertain pending delivery blocks a UIA switch without startup or automatic UI retry',async()=>{
  const h=harness();let control,starts=0,saves=0;
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,inspectUia:()=>({canEnable:true}),
    createUiaStore:()=>({get:()=>({version:0,enabled:false}),replace:()=>{saves++;}}),onSenderControl:handler=>{control=handler;},
    createUiaRuntime:()=>({start:async()=>{starts++;}}),
    runBridge:async({signal})=>{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{stopped:true,senderSwitchSafe:false};}});
  while(!control)await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UIA_MODE_PENDING_DELIVERY'});
  assert.equal(starts,0);assert.equal(saves,0);assert.equal(h.events.filter(value=>value==='reader-stop-1').length,0);
  await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UIA_MODE_PENDING_DELIVERY'});h.controller.abort();await run;
});

test('live pending-input preflight leaves the original bridge connected and can be retried after recovery',async()=>{
  const h=harness();let control,safe=false,bridges=0,starts=0,mode={version:0,enabled:false};
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,inspectUia:()=>({canEnable:true}),
    createUiaStore:()=>({get:()=>({...mode}),replace:r=>mode={version:r.expectedVersion+1,enabled:r.enabled}}),onSenderControl:handler=>{control=handler;},
    createUiaRuntime:()=>({start:async()=>{starts++;return{ready:true};},close:async()=>{}}),
    runBridge:async({signal,onSenderSwitchCheck})=>{bridges++;onSenderSwitchCheck(()=>safe);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));h.events.push('bridge-stop');return{stopped:true,senderSwitchSafe:safe};}});
  while(!control)await new Promise(resolve=>setTimeout(resolve,1));
  for(let i=0;i<2;i++)await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UIA_MODE_PENDING_DELIVERY'});
  assert.equal(h.events.includes('bridge-stop'),false);assert.equal(starts,0);assert.equal(mode.enabled,false);
  safe=true;assert.equal((await control({backend:'uia',expectedVersion:0,enabled:true})).runtimeActive,true);assert.equal(starts,1);assert.equal(bridges,2);
  h.controller.abort();await run;
});

test('input racing switch preflight remains stopped until an explicit safe recheck without automatic replay',async()=>{
  const h=harness();let control,safe=true,bridges=0,starts=0,mode={version:0,enabled:false};
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,inspectUia:()=>({canEnable:true}),
    createUiaStore:()=>({get:()=>({...mode}),replace:r=>mode={version:r.expectedVersion+1,enabled:r.enabled}}),onSenderControl:handler=>{control=handler;},
    createUiaRuntime:()=>({start:async()=>{starts++;return{ready:true};},close:async()=>{}}),
    runBridge:async({signal,onSenderSwitchCheck})=>{const old=++bridges===1;onSenderSwitchCheck(()=>safe);await new Promise(resolve=>signal.addEventListener('abort',()=>{if(old)safe=false;resolve();},{once:true}));return{stopped:true,senderSwitchSafe:safe};}});
  while(!control)await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UIA_MODE_PENDING_DELIVERY'});
  await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UIA_MODE_PENDING_DELIVERY'});
  assert.equal(bridges,1);assert.equal(starts,0);assert.equal(mode.enabled,false);
  safe=true;assert.equal((await control({backend:'uia',expectedVersion:0,enabled:true})).runtimeActive,true);assert.equal(bridges,2);assert.equal(starts,1);
  h.controller.abort();await run;
});

test('a safe queue cannot override unconfirmed native cleanup during a sender switch',async()=>{
  const h=harness();let control,starts=0,saves=0;
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,inspectUia:()=>({canEnable:true}),
    createUiaStore:()=>({get:()=>({version:0,enabled:false}),replace:()=>{saves++;}}),onSenderControl:handler=>{control=handler;},
    createUiaRuntime:()=>({start:async()=>{starts++;return{ready:true};}}),
    runBridge:async({signal,onSenderSwitchCheck})=>{onSenderSwitchCheck(()=>true);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw Object.assign(Error('private cleanup'),{code:'UI_NATIVE_CLEANUP_UNCONFIRMED'});}}).then(()=>null,error=>error);
  while(!control)await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UI_NATIVE_CLEANUP_UNCONFIRMED'});
  assert.equal(starts,0);assert.equal(saves,0);await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UIA_MODE_BUSY'});
  h.controller.abort();assert.equal((await run).code,'UI_NATIVE_CLEANUP_UNCONFIRMED');
});

test('UIA startup failure after UI drain leaves the Reader running and never falls back or persists enabled',async()=>{
  const h=harness();let control,bridges=0,closed=0,saves=0;
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,inspectUia:()=>({canEnable:true}),
    createUiaStore:()=>({get:()=>({version:0,enabled:false}),replace:()=>{saves++;}}),onSenderControl:handler=>{control=handler;},
    createUiaRuntime:()=>({start:async()=>{throw Object.assign(Error(),{code:'UIA_MODE_NOT_READY'});},close:async()=>{closed++;}}),
    runBridge:async({signal})=>{bridges++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{stopped:true,senderSwitchSafe:true};}});
  while(!control)await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UIA_MODE_NOT_READY'});
  assert.equal(saves,0);assert.equal(bridges,1);assert.equal(closed,1);assert.equal(h.events.includes('reader-stop-1'),false);
  h.controller.abort();await run;
});

test('old or malformed sender requests are rejected before draining a bridge or inspecting UIA',async()=>{
  const h=harness();let control,starts=0,saves=0,inspections=0;
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,inspectUia:()=>{inspections++;return{canEnable:true};},
    createUiaStore:()=>({get:()=>({version:0,enabled:false}),replace:()=>{saves++;}}),onSenderControl:handler=>{control=handler;},
    createUiaRuntime:()=>({start:async()=>{starts++;return{ready:true};}}),
    runBridge:async({signal})=>{h.events.push('bridge-start');await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));h.events.push('bridge-stop');return{senderSwitchSafe:true};}});
  while(!control)await new Promise(resolve=>setTimeout(resolve,1));
  for(const request of [{expectedVersion:0,enabled:true},{backend:'background-injection',expectedVersion:0,enabled:true},{backend:'uia',expectedVersion:0,enabled:'true'},{backend:'uia',expectedVersion:0,enabled:true,extra:true}])
    await assert.rejects(control(request),{code:'UIA_MODE_SETTINGS_INVALID'});
  await assert.rejects(control({backend:'uia',expectedVersion:1,enabled:true}),{code:'UIA_MODE_VERSION_CONFLICT'});
  assert.equal(starts,0);assert.equal(saves,0);assert.equal(inspections,0);assert.equal(h.events.includes('bridge-stop'),false);
  h.controller.abort();await run;
});

test('a runtime without explicit readiness cannot persist UIA or start its media bridge',async()=>{
  const h=harness();let control,bridges=0,closed=0,saves=0;
  const run=runUiService({...h,signal:h.controller.signal,pollMs:10,inspectUia:()=>({canEnable:true}),
    createUiaStore:()=>({get:()=>({version:0,enabled:false}),replace:()=>{saves++;}}),onSenderControl:handler=>{control=handler;},
    createUiaRuntime:()=>({start:async()=>({}),close:async()=>{closed++;}}),
    runBridge:async({signal})=>{bridges++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{senderSwitchSafe:true};}});
  while(!control)await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(control({backend:'uia',expectedVersion:0,enabled:true}),{code:'UIA_MODE_NOT_READY'});
  assert.equal(closed,1);assert.equal(saves,0);assert.equal(bridges,1);h.controller.abort();await run;
});

test('historical enabled state cannot start the UIA sender',async t=>{
  const f=fixture(t),h=harness(),root=f.root;let starts=0,bridges=0;
  write(path.join(root,'state/runtime/background-injection.json'),{schemaVersion:1,version:4,enabled:true});
  await runUiService({...h,root,createUiaStore:input=>new UiaModeStore(input),signal:h.controller.signal,pollMs:10,
    createUiaRuntime:()=>({start:async()=>{starts++;return{ready:true};}}),runBridge:async({uiaMode,signal})=>{
      bridges++;assert.equal(uiaMode,false);setTimeout(()=>h.controller.abort(),1);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{senderSwitchSafe:true};}});
  assert.equal(starts,0);assert.equal(bridges,1);

});
