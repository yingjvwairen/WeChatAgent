import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createUiRuntimeControls, nativeInputHelpersStopped } from './ui-runtime-controls.mjs';
import { readerAccountId } from './reader-account-state.mjs';
import { ReplyPreferences } from './reply-preferences.mjs';
import { createConsole } from './console-server.mjs';

const example = JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json', import.meta.url), 'utf8'));
const rect = (left,top,right,bottom) => ({left,top,right,bottom});
const audio = () => ({ok:true,mode:'list',audioStarted:false,recordingSaved:false,defaultsUsedForAudio:false,devices:[
  {id:'fixture-render',name:'CABLE Input (VB-Audio Virtual Cable)',adapter:'VB-Audio Virtual Cable',flow:'render'},
  {id:'fixture-capture',name:'CABLE Output (VB-Audio Virtual Cable)',adapter:'VB-Audio Virtual Cable',flow:'capture'},
  {id:'physical-microphone',name:'Physical microphone',adapter:'Fixture hardware',flow:'capture'}]});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-runtime-controls-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
  const myWxid='wxid_fixture',dbPath=path.join(root,'wechat',myWxid),executable=path.join(root,'Weixin.exe');
  fs.mkdirSync(path.join(dbPath,'db_storage'),{recursive:true});
  const accountRef=readerAccountId(root,{dbPath,myWxid});
  const binding={account:{accountRef,myWxid,dbPath},request:{wechatExecutable:executable,wechatExecutableSha256:'b'.repeat(64)},cached:{protectedKey:'fixture-secret-not-real'}};
  const config=structuredClone(example);config.runtime.sender='wechat-ui';config.runtime.weflowMode='nt';
  write('config/wechatagent.json',config);write('state/weflow/active-account.json',{id:accountRef});write('state/weflow/WeFlow-config.json',{dbPath,myWxid,decryptKey:'fixture-secret-not-real'});
  const host={version:1,backend:'qt-visual',account:myWxid,accountRef,accountAlias:myWxid,executable,executableVersion:'4.1.15.56',executableSha256:'b'.repeat(64),hwnd:'auto',idleMs:1000,ocrBackend:'rapidocr',layout:{width:800,height:600,dpi:96,
    header:rect(310,20,600,60),search:rect(80,20,260,60),firstResult:rect(80,80,260,120),profileOpen:rect(720,20,760,60),profileAlias:rect(300,100,600,150),profileClose:rect(700,80,730,110),selfOpen:rect(10,20,50,60),selfAlias:rect(60,100,300,150),selfClose:rect(330,80,350,100),editor:rect(300,450,780,550),send:rect(700,560,780,590),emptyEditorSha256:'c'.repeat(64)}};
  write('state/ui-runtime/qt-visual.json',host);
  for(const file of ['state/ui-host/WechatQtActions.exe','state/ui-host/WechatAccountProbe.exe','state/ocr/venv/Scripts/python.exe','state/ui-host/WechatVoicePreview.exe','state/audio-probe/AudioRouteProbe.exe'])write(file,'fixture-helper-not-executable');
  const calls=[];let report=audio(),duringExecute=()=>{},nativeStopped=async()=>true;
  const controls=createUiRuntimeControls({root,check:()=>binding,helpersStopped:()=>nativeStopped(),executeImpl:async(exe,args,options)=>{calls.push({exe,args,options});duringExecute();return{stdout:JSON.stringify(report)};}});
  return{root,write,host,binding,controls,calls,setAudio:value=>report=value,onExecute:fn=>duringExecute=fn,setNativeStopped:fn=>nativeStopped=fn,file:path.join(root,'state/ui-bridge/config.json')};
}
test('read-only snapshot offers a disabled default; explicit save creates Qt config without credentials or starting service',async t=>{
  const f=fixture(t),before=f.controls.snapshot();
  assert.equal(before.configured,false);assert.equal(before.enabled,false);assert.equal(before.canEnable,true);assert.equal(before.liveUiVerified,false);
  assert.equal(fs.existsSync(f.file),false);assert.equal(f.calls.length,0);
  const result=await f.controls.save({expectedRevision:before.revision,enabled:true});
  assert.equal(result.enabled,true);assert.equal(result.saved,true);assert.equal(result.restartRequired,true);assert.equal(result.servicesStarted,false);assert.equal(result.inputSent,false);
  const saved=JSON.parse(fs.readFileSync(f.file,'utf8'));
  assert.equal(saved.driver,'qt-visual');assert.equal(saved.hostConfig,path.join(f.root,'state/ui-runtime/qt-visual.json'));
  assert.equal(saved.enableInput,true);assert.equal(saved.allowSubmit,true);assert.equal(JSON.stringify(saved).includes('fixture-secret'),false);
  await assert.rejects(f.controls.save({expectedRevision:before.revision,enabled:false}),{code:'UI_RUNTIME_VERSION_CONFLICT'});
});
test('account changes and missing helpers block enable while explicit disable remains available',async t=>{
  const f=fixture(t);let view=f.controls.snapshot();await f.controls.save({expectedRevision:view.revision,enabled:true});
  f.write('state/weflow/active-account.json',{id:'e'.repeat(64)});view=f.controls.snapshot();
  assert.equal(view.canEnable,false);assert.equal(view.calibration.accountMatches,false);
  await assert.rejects(f.controls.save({expectedRevision:view.revision,enabled:true}),{code:'UI_RUNTIME_READER_REQUIRED'});
  assert.equal((await f.controls.save({expectedRevision:view.revision,enabled:false})).enabled,false);
  f.write('state/weflow/active-account.json',{id:f.binding.account.accountRef});
  fs.unlinkSync(path.join(f.root,'state/ui-host/WechatQtActions.exe'));view=f.controls.snapshot();
  assert.equal(view.calibration.helpersReady,false);
  await assert.rejects(f.controls.save({expectedRevision:view.revision,enabled:true}),{code:'UI_RUNTIME_HELPERS_REQUIRED'});
});
test('voice enable requires model files, voice calibration, and a current enumerated virtual cable pair',async t=>{
  const f=fixture(t);new ReplyPreferences({root:f.root}).replace({expectedVersion:0,mode:'voice'});
  const view=f.controls.snapshot();assert.equal(view.canEnable,true);assert.equal(view.replyMode,'automatic');
  assert.equal(view.voice.available,false);assert.equal(view.voice.autoStart,true);
  assert.equal(view.blockers.some(b=>b.code.startsWith('UI_RUNTIME_VOICE_')),false);
  for(const enabled of [false,true])await assert.rejects(f.controls.save({expectedRevision:view.revision,enabled,voice:{renderId:'fixture-render',captureId:'fixture-capture'}}),
    error=>['UI_RUNTIME_VOICE_CONFIG_REQUIRED','UI_RUNTIME_VOICE_CALIBRATION_REQUIRED'].includes(error.code));
  assert.equal(fs.existsSync(f.file),false);
  f.host.voice={recordStartRect:rect(310,420,350,440),mouseParkRect:rect(310,400,320,410),recordingUi:{focusHwnd:'same',cancel:{rect:rect(400,500,450,530),rgbaSha256:'d'.repeat(64)},submit:{rect:rect(500,500,550,530),rgbaSha256:'e'.repeat(64)}}};
  f.write('state/ui-runtime/qt-visual.json',f.host);
  f.write('state/dania-voice/config.json',{installDir:f.root,root:'models',gptWeights:'a.ckpt',sovitsWeights:'b.pth',refAudio:'c.wav'});
  for(const file of ['models/a.ckpt','models/b.pth','models/c.wav'])f.write(file,'fixture-model');
  const metadata=await f.controls.audioDevices();assert.equal(metadata.audioStarted,false);assert.equal(metadata.devices.length,2);assert.equal(metadata.pairs.length,1);
  assert.deepEqual(f.calls[0].args,['--list']);assert.equal(f.calls[0].options.shell,false);
  const current=f.controls.snapshot();
  await assert.rejects(f.controls.save({expectedRevision:current.revision,enabled:true,voice:{renderId:'fixture-render',captureId:'physical-microphone'}}),{code:'UI_RUNTIME_AUDIO_PAIR_REQUIRED'});
  const result=await f.controls.save({expectedRevision:current.revision,enabled:true,voice:{renderId:metadata.pairs[0].renderId,captureId:metadata.pairs[0].captureId}});
  assert.equal(result.enabled,true);assert.equal(result.voice.configured,true);assert.equal(result.liveUiVerified,false);assert.equal(result.streamIsolationVerified,false);
});
function adaptiveVoice(f) {
  f.host.voice={recordStartRect:rect(310,555,340,585),mouseParkRect:rect(600,100,610,110),
    recordingUi:{focusHwnd:'same',adaptive:{version:1,executableVersion:'4.1.15.56',toolbarRect:rect(300,550,780,595)}}};
  f.write('state/ui-runtime/qt-visual.json',f.host);
  f.write('state/dania-voice/config.json',{installDir:f.root,root:'models',gptWeights:'a.ckpt',sovitsWeights:'b.pth',refAudio:'c.wav'});
  for(const file of ['models/a.ckpt','models/b.pth','models/c.wav'])f.write(file,'fixture-model');
}
test('cloud synthesis readiness is independent of local voice profile files', t => {
  const f=fixture(t);
  f.write('state/runtime/speech-providers.json', {version:1,
    asr:{mode:'local', model:'', endpoint:'', protectedKey:''},
    tts:{mode:'cloud', endpoint:'https://example.test/audio/speech', model:'test', voice:'test', protectedKey:''}});
  const snapshot=f.controls.snapshot();
  assert.equal(snapshot.voice.modelConfigured,true);
  assert.equal(snapshot.voice.available,false);
  assert.equal(f.calls.length,0);
});

test('old fixed-mode preferences cannot block text, while an existing voice route requires its configured components',async t=>{
  const f=fixture(t),legacy=new ReplyPreferences({root:f.root});legacy.replace({expectedVersion:0,mode:'voice'});
  fs.writeFileSync(legacy.file,'{old corrupt preferences');
  const initial=f.controls.snapshot();assert.equal(initial.replyMode,'automatic');assert.equal(initial.canEnable,true);
  await f.controls.save({expectedRevision:initial.revision,enabled:true});
  assert.equal(fs.readFileSync(legacy.file,'utf8'),'{old corrupt preferences');assert.equal(f.calls.length,0);
  const config=JSON.parse(fs.readFileSync(f.file));config.voice={renderId:'fixture-render',captureId:'fixture-capture'};
  fs.writeFileSync(f.file,JSON.stringify(config));
  const broken=f.controls.snapshot();assert.equal(broken.canEnable,false);
  assert.ok(broken.blockers.some(row=>row.code==='UI_RUNTIME_VOICE_CONFIG_REQUIRED'));
  assert.ok(broken.blockers.some(row=>row.code==='UI_RUNTIME_VOICE_CALIBRATION_REQUIRED'));
  await assert.rejects(f.controls.save({expectedRevision:broken.revision,enabled:true}),{code:'UI_RUNTIME_VOICE_CALIBRATION_REQUIRED'});
  const restored=await f.controls.save({expectedRevision:broken.revision,enabled:true,voice:null});
  assert.equal(restored.enabled,true);assert.equal(restored.voice.configured,false);assert.equal(restored.canEnable,true);
  assert.equal(fs.readFileSync(legacy.file,'utf8'),'{old corrupt preferences');
});
test('adaptive voice readiness uses the execution schema without granting input or claiming identified buttons',async t=>{
  const f=fixture(t);adaptiveVoice(f);
  const initial=f.controls.snapshot();
  assert.equal(initial.configured,false);assert.equal(initial.enabled,false);
  assert.equal(initial.calibration.voiceConfigured,true);assert.equal(initial.voice.modelConfigured,true);
  assert.equal(initial.canEnable,true);assert.deepEqual(initial.blockers,[]);assert.equal(initial.voice.available,false);assert.equal(initial.replyMode,'automatic');
  assert.equal(initial.liveUiVerified,false);assert.equal(initial.streamIsolationVerified,false);
  assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.file),false);
  const saved=await f.controls.save({expectedRevision:initial.revision,enabled:false});
  assert.equal(saved.configured,true);assert.equal(saved.enabled,false);assert.equal(saved.servicesStarted,false);assert.equal(saved.inputSent,false);
  const disk=JSON.parse(fs.readFileSync(f.file,'utf8'));
  assert.deepEqual(Object.keys(disk).sort(),['allowSubmit','driver','enableInput','hostConfig','version']);
  assert.equal(disk.enableInput,false);assert.equal(disk.allowSubmit,false);
  assert.equal(disk.hostConfig,path.join(f.root,'state/ui-runtime/qt-visual.json'));
  assert.equal(f.calls.length,0);
  const enabled=await f.controls.save({expectedRevision:saved.revision,enabled:true,voice:{renderId:'fixture-render',captureId:'fixture-capture'}});
  assert.equal(enabled.enabled,true);assert.equal(enabled.calibration.voiceConfigured,true);
  assert.equal(enabled.liveUiVerified,false);assert.equal(enabled.servicesStarted,false);assert.equal(enabled.inputSent,false);
  assert.deepEqual(f.calls.map(call=>call.args),[['--list']]);
});
test('adaptive voice refuses mixed or malformed schemas and unsafe geometry before any permission is saved',async t=>{
  const f=fixture(t);adaptiveVoice(f);const original=structuredClone(f.host);
  for(const [name,alter] of [
    ['mixed templates',h=>h.voice.recordingUi.cancel={rect:rect(400,500,450,530),rgbaSha256:'d'.repeat(64)}],
    ['unknown schema',h=>h.voice.recordingUi.adaptive.version=2],
    ['unknown client',h=>h.voice.recordingUi.adaptive.executableVersion='4.1.15.57'],
    ['host version mismatch',h=>h.executableVersion='4.1.15.57'],
    ['extra authority',h=>h.voice.recordingUi.adaptive.allowSubmit=true],
    ['missing boundary',h=>delete h.voice.recordingUi.adaptive.toolbarRect],
    ['outside window',h=>h.voice.recordingUi.adaptive.toolbarRect.right=801],
    ['oversized boundary',h=>h.voice.recordingUi.adaptive.toolbarRect.top=400],
    ['entry outside boundary',h=>h.voice.recordStartRect.top=540],
    ['pointer in draft',h=>h.voice.mouseParkRect=rect(600,500,610,510)],
    ['fractional pixels',h=>h.voice.recordingUi.adaptive.toolbarRect.left=300.5],
    ['invalid focus',h=>h.voice.recordingUi.focusHwnd='0'],
    ['unbound extra pixels',h=>h.voice.recordingUi.adaptive.toolbarRect.extra=1],
  ]){
    const changed=structuredClone(original);alter(changed);f.write('state/ui-runtime/qt-visual.json',changed);
    const view=f.controls.snapshot();assert.equal(view.calibration.voiceConfigured,false,name);assert.equal(view.voice.available,false,name);
    await assert.rejects(f.controls.save({expectedRevision:view.revision,enabled:true,voice:{renderId:'fixture-render',captureId:'fixture-capture'}}),
      error=>['UI_RUNTIME_CALIBRATION_REQUIRED','UI_RUNTIME_VOICE_CALIBRATION_REQUIRED'].includes(error.code),name);
    assert.equal(fs.existsSync(f.file),false,name);
    assert(f.calls.every(call=>call.args.length===1&&call.args[0]==='--list'),name);
  }
});
test('slow device enumeration cannot overwrite concurrent calibration changes or accept ambiguous cables',async t=>{
  const f=fixture(t),view=f.controls.snapshot(),voice={renderId:'fixture-render',captureId:'fixture-capture'};
  f.onExecute(()=>{f.host.layout.emptyEditorSha256='f'.repeat(64);f.write('state/ui-runtime/qt-visual.json',f.host);});
  await assert.rejects(f.controls.save({expectedRevision:view.revision,enabled:false,voice}),{code:'UI_RUNTIME_VERSION_CONFLICT'});
  assert.equal(fs.existsSync(f.file),false);f.onExecute(()=>{});
  const report=audio();report.devices.push({...report.devices[0],id:'second-cable-render'});f.setAudio(report);
  assert.deepEqual((await f.controls.audioDevices()).pairs,[]);
  await assert.rejects(f.controls.save({expectedRevision:f.controls.snapshot().revision,enabled:false,voice}),{code:'UI_RUNTIME_AUDIO_PAIR_REQUIRED'});
});
test('running or unconfirmed service prevents enable, while disable remains permitted and new enable owns the startup barrier',async t=>{
  const f=fixture(t);await f.controls.save({expectedRevision:f.controls.snapshot().revision,enabled:true});
  f.write('state/ui-service.lock',{pid:123,lease:'fixture-service'});
  const running=f.controls.snapshot();assert.equal(running.serviceRunning,true);assert.equal(running.canEnable,false);
  assert(running.blockers.some(row=>row.code==='UI_RUNTIME_STOP_SERVICES'));
  await assert.rejects(f.controls.save({expectedRevision:running.revision,enabled:true}),{code:'UI_RUNTIME_STOP_SERVICES'});
  const disabled=await f.controls.save({expectedRevision:running.revision,enabled:false});assert.equal(disabled.enabled,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state/ui-service.lock'))).lease,'fixture-service');
  fs.unlinkSync(path.join(f.root,'state/ui-service.lock'));
  adaptiveVoice(f);
  f.onExecute(()=>{assert.equal(f.controls.snapshot().serviceRunning,true);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state/ui-service.lock'))).pid,process.pid);});
  await f.controls.save({expectedRevision:f.controls.snapshot().revision,enabled:true,voice:{renderId:'fixture-render',captureId:'fixture-capture'}});
  assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);
});
test('console exposes runtime controls behind its existing local request token and never starts a job on save',async t=>{
  const f=fixture(t),app=createConsole({root:f.root,port:0,uiRuntimeControls:f.controls,runner:async()=>{throw Error('must not start services');},fetchImpl:async()=>{throw Error('must not contact DSH');}});
  const address=await app.start(),base='http://127.0.0.1:'+address.port;
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const info=await(await fetch(base+'/api/info')).json();
  assert.equal((await fetch(base+'/api/ui-runtime-controls')).status,401);
  const headers={'X-Console-Token':info.token,'Content-Type':'application/json'};
  const view=await(await fetch(base+'/api/ui-runtime-controls',{headers})).json();
  assert.equal((await(await fetch(base+'/api/reader-component',{headers})).json()).ready,false);
  assert.equal((await fetch(base+'/api/reader-component',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:path.join(f.root,'missing.dll')})})).status,401);
  assert.equal((await fetch(base+'/api/reader-component',{method:'POST',headers,body:JSON.stringify({source:path.join(f.root,'missing.dll')})})).status,409);
  assert.equal((await fetch(base+'/api/jobs',{method:'POST',headers,body:JSON.stringify({action:'reader-connect'})})).status,409);
  const request={method:'POST',body:JSON.stringify({expectedRevision:view.revision,enabled:true})};
  assert.equal((await fetch(base+'/api/ui-runtime-controls',{...request,headers:{'Content-Type':'application/json'}})).status,401);
  assert.equal((await fetch(base+'/api/ui-runtime-controls',{...request,headers:{...headers,Origin:'https://untrusted.invalid'}})).status,403);
  assert.equal(fs.existsSync(f.file),false);
  const devices=await(await fetch(base+'/api/ui-runtime-controls/audio-devices',{headers})).json();assert.equal(devices.audioStarted,false);
  const result=await fetch(base+'/api/ui-runtime-controls',{method:'POST',headers,body:JSON.stringify({expectedRevision:view.revision,enabled:false})});
  assert.equal(result.status,200);assert.equal((await result.json()).servicesStarted,false);assert.equal(app.isBusy(),false);
});

function preparationHold(f, overrides={}) {
  const account=crypto.createHash('sha256').update(f.host.account).digest('hex');
  const relative=`state/ui-text-deliveries/${account}/routes/preparation-control.json`;
  const value={version:1,revision:1,kind:'manual',reason:'QT_BINDING_CHANGED',deliveryId:'d'.repeat(64),attempts:1,nextAttemptAt:0,updatedAt:1000,...overrides};
  f.write(relative,value);return {file:path.join(f.root,relative),value};
}

test('review of a quote draft clears only the stopped delivery target marker',async t=>{
  const f=fixture(t);await f.controls.save({expectedRevision:f.controls.snapshot().revision,enabled:false});
  const hold=preparationHold(f,{reason:'UI_QT_QUOTE_DRAFT_CONFLICT'}),id=hold.value.deliveryId;
  const target='filehelper',other='another-contact';
  fs.writeFileSync(path.join(path.dirname(hold.file),id+'.json'),JSON.stringify({id,target}));
  const marker=name=>'state/ui-quote-drafts/'+f.host.accountRef+'/'+crypto.createHash('sha256').update(name).digest('hex')+'.json';
  f.write(marker(target),{id}); f.write(marker(other),{id:'b'.repeat(64)});
  const result=f.controls.recoverPreparation({expectedRevision:f.controls.snapshot().revision,acknowledgeReview:true});
  assert.equal(result.recovered,true);assert.equal(fs.existsSync(path.join(f.root,marker(target))),false);
  assert.equal(fs.existsSync(path.join(f.root,marker(other))),true);
});

test('local preparation recovery keeps delivery and permission bytes, requires review, and survives controls restart',async t=>{
  const f=fixture(t);await f.controls.save({expectedRevision:f.controls.snapshot().revision,enabled:false});
  const hold=preparationHold(f),permission=fs.readFileSync(f.file);
  const delivery=path.join(path.dirname(hold.file),'d'.repeat(64)+'.json');
  fs.writeFileSync(delivery,'{"fixture":"unfinished delivery must be preserved"}');const beforeDelivery=fs.readFileSync(delivery);
  const view=f.controls.snapshot();assert.equal(view.preparationRecovery.required,true);assert.equal(view.preparationRecovery.canRecover,true);assert.equal(view.canEnable,false);
  assert.equal(JSON.stringify(view).includes('d'.repeat(64)),false);
  const restarted=createUiRuntimeControls({root:f.root,check:()=>f.binding});assert.equal(restarted.snapshot().preparationRecovery.required,true);
  const before=fs.readFileSync(hold.file);
  assert.throws(()=>f.controls.recoverPreparation({expectedRevision:view.revision,acknowledgeReview:false}),{code:'UI_RUNTIME_OPTIONS_INVALID'});
  assert.deepEqual(fs.readFileSync(hold.file),before);
  const result=f.controls.recoverPreparation({expectedRevision:view.revision,acknowledgeReview:true});
  assert.equal(result.recovered,true);assert.equal(result.preparationRecovery.required,false);assert.equal(result.enabled,false);
  assert.equal(result.servicesStarted,false);assert.equal(result.inputSent,false);assert.equal(result.preparationRecovery.revision,2);
  assert.deepEqual(fs.readFileSync(delivery),beforeDelivery);assert.deepEqual(fs.readFileSync(f.file),permission);
  assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);
  assert.equal(fs.existsSync(path.join(f.root,'state/ui-bridge/controls.lock')),false);
  assert.equal(f.calls.length,0);
  assert.throws(()=>f.controls.recoverPreparation({expectedRevision:view.revision,acknowledgeReview:true}),{code:'UI_RUNTIME_VERSION_CONFLICT'});
});

test('preparation recovery refuses changed records, active service or voice cleanup, and changed account',t=>{
  const f=fixture(t),hold=preparationHold(f),view=f.controls.snapshot();
  f.write(path.relative(f.root,hold.file),{...hold.value,revision:2});
  assert.throws(()=>f.controls.recoverPreparation({expectedRevision:view.revision,acknowledgeReview:true}),{code:'UI_RUNTIME_VERSION_CONFLICT'});
  for(const relative of ['state/ui-service.lock','state/native-voice-attempts/active.json','state/voice-preview/timed/active.json']){
    f.write(relative,{fixture:'owned operation'});const current=f.controls.snapshot(),before=fs.readFileSync(hold.file);
    assert.equal(current.preparationRecovery.canRecover,false);
    assert.throws(()=>f.controls.recoverPreparation({expectedRevision:current.revision,acknowledgeReview:true}),{code:'UI_RUNTIME_STOP_SERVICES'});
    assert.deepEqual(fs.readFileSync(hold.file),before);assert(fs.existsSync(path.join(f.root,relative)));fs.unlinkSync(path.join(f.root,relative));
  }
  const before=fs.readFileSync(hold.file);f.write('state/weflow/active-account.json',{id:'e'.repeat(64)});
  const changed=f.controls.snapshot();assert.equal(changed.preparationRecovery.canRecover,false);
  assert.throws(()=>f.controls.recoverPreparation({expectedRevision:changed.revision,acknowledgeReview:true}),{code:'UI_RUNTIME_PREPARATION_RECOVERY_REQUIRED'});
  assert.deepEqual(fs.readFileSync(hold.file),before);
});

test('malformed preparation state blocks enable and is never cleared by the local recovery control',async t=>{
  const f=fixture(t),hold=preparationHold(f,{extraPermission:true}),before=fs.readFileSync(hold.file),view=f.controls.snapshot();
  assert.equal(view.canEnable,false);assert.equal(view.preparationRecovery.canRecover,false);
  assert(view.blockers.some(row=>row.code==='UI_RUNTIME_PREPARATION_STATE_INVALID'));
  await assert.rejects(f.controls.save({expectedRevision:view.revision,enabled:true}),{code:'UI_RUNTIME_PREPARATION_STATE_INVALID'});
  assert.throws(()=>f.controls.recoverPreparation({expectedRevision:view.revision,acknowledgeReview:true}),{code:'UI_RUNTIME_PREPARATION_RECOVERY_REQUIRED'});
  assert.deepEqual(fs.readFileSync(hold.file),before);
});

test('preparation recovery HTTP endpoint requires local token, origin, review and current revision',async t=>{
  const f=fixture(t),hold=preparationHold(f),app=createConsole({root:f.root,port:0,uiRuntimeControls:f.controls,runner:async()=>{throw Error('must not start services');},fetchImpl:async()=>{throw Error('must not contact DSH');}});
  const address=await app.start(),base='http://127.0.0.1:'+address.port;
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const {token}=await(await fetch(base+'/api/info')).json(),headers={'X-Console-Token':token,'Content-Type':'application/json'};
  const view=f.controls.snapshot(),request={method:'POST',body:JSON.stringify({expectedRevision:view.revision,acknowledgeReview:true})},endpoint=base+'/api/ui-runtime-controls/recover-preparation';
  assert.equal((await fetch(endpoint,{...request,headers:{'Content-Type':'application/json'}})).status,401);
  assert.equal((await fetch(endpoint,{...request,headers:{...headers,Origin:'https://untrusted.invalid'}})).status,403);
  assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({expectedRevision:view.revision})})).status,409);
  assert.equal(JSON.parse(fs.readFileSync(hold.file)).kind,'manual');
  const response=await fetch(endpoint,{...request,headers});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.recovered,true);assert.equal(result.servicesStarted,false);assert.equal(result.inputSent,false);
  assert.equal(fs.existsSync(f.file),false);assert.equal(app.isBusy(),false);
  assert.equal((await fetch(endpoint,{...request,headers})).status,409);
});

function voiceHold(f) {
  const id='9'.repeat(64),audioSha256='8'.repeat(64),accountScopeHash=f.binding.account.accountRef,folder='state/voice-preview/timed';
  const active={version:1,id,audioSha256,accountScopeHash,lease:'11111111-1111-4111-8111-111111111111',processId:999999};
  const attempt={version:1,id,audioSha256,accountScopeHash,state:'uncertain',result:{recordingPossible:true}};
  f.write(folder+'/active.json',active);f.write(folder+'/'+id+'.json',attempt);
  return {id,active:path.join(f.root,folder,'active.json'),attempt:path.join(f.root,folder,id+'.json')};
}
const voiceAcknowledgement=revision=>({expectedRevision:revision,acknowledgeRecordingEnded:true,acknowledgeMessageOutcomeReviewed:true});

test('voice recovery separately acknowledges ended recording and message review, preserves permissions and old attempt',async t=>{
  const f=fixture(t);await f.controls.save({expectedRevision:f.controls.snapshot().revision,enabled:false});
  const hold=voiceHold(f),attempt=fs.readFileSync(hold.attempt),permission=fs.readFileSync(f.file),view=await f.controls.inspectVoiceRecovery();
  assert.equal(view.required,true);assert.equal(view.canRecover,true);assert.equal(view.attemptCount,1);assert.equal(f.controls.snapshot().canEnable,false);
  assert.equal(JSON.stringify(view).includes(hold.id),false);assert.equal(JSON.stringify(view).includes(f.binding.account.accountRef),false);
  for(const bad of [{expectedRevision:view.revision,acknowledgeRecordingEnded:true},{expectedRevision:view.revision,acknowledgeMessageOutcomeReviewed:true},{...voiceAcknowledgement(view.revision),assertStopped:true}])await assert.rejects(f.controls.recoverVoice(bad),{code:'UI_RUNTIME_OPTIONS_INVALID'});
  assert.equal(fs.existsSync(hold.active),true);
  const result=await f.controls.recoverVoice(voiceAcknowledgement(view.revision));
  assert.equal(result.recovered,true);assert.equal(result.originalIdsReplayable,false);assert.equal(result.deliveryConfirmed,false);assert.equal(result.unknownMessagesPreserved,true);assert.equal(result.inputSent,false);assert.equal(result.servicesStarted,false);
  assert.equal(fs.existsSync(hold.active),false);assert.deepEqual(fs.readFileSync(hold.attempt),attempt);assert.deepEqual(fs.readFileSync(f.file),permission);
  assert.equal((await f.controls.inspectVoiceRecovery()).required,false);assert.equal(f.controls.snapshot().preparationRecovery.required,false);
  await assert.rejects(f.controls.recoverVoice(voiceAcknowledgement(view.revision)),{code:'UI_RUNTIME_VERSION_CONFLICT'});
});

test('voice recovery rejects changed config, account, active record and running native helper',async t=>{
  for(const mode of ['config','account','attempt','helper']) {
    const f=fixture(t),hold=voiceHold(f),before=fs.readFileSync(hold.active),view=await f.controls.inspectVoiceRecovery();
    if(mode==='config'){f.host.layout.emptyEditorSha256='a'.repeat(64);f.write('state/ui-runtime/qt-visual.json',f.host);}
    if(mode==='account')f.write('state/weflow/active-account.json',{id:'a'.repeat(64)});
    if(mode==='attempt'){const attempt=JSON.parse(fs.readFileSync(hold.attempt));attempt.diagnostic='changed';fs.writeFileSync(hold.attempt,JSON.stringify(attempt));}
    if(mode==='helper')f.setNativeStopped(async()=>false);
    await assert.rejects(f.controls.recoverVoice(voiceAcknowledgement(view.revision)));
    assert.deepEqual(fs.readFileSync(hold.active),before);assert.equal(fs.existsSync(path.join(f.root,'state/voice-operator-recovery/transaction.json')),false);
  }
});

test('native helper or config change during trusted stop proof prevents recovery',async t=>{
  for(const mode of ['helper','config']) {
    const f=fixture(t),hold=voiceHold(f),view=await f.controls.inspectVoiceRecovery();let calls=0;
    f.setNativeStopped(async()=>{calls++;if(calls===2&&mode==='config'){f.host.layout.emptyEditorSha256='d'.repeat(64);f.write('state/ui-runtime/qt-visual.json',f.host);}return mode!=='helper'||calls<2;});
    await assert.rejects(f.controls.recoverVoice(voiceAcknowledgement(view.revision)),{code:'VOICE_RECOVERY_STOP_SERVICES'});
    assert.equal(fs.existsSync(hold.active),true);assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);assert.equal(fs.existsSync(path.join(f.root,'state/ui-bridge/controls.lock')),false);
  }
});

test('voice inspection is read only and refuses a busy or malformed local state without leaking IDs',async t=>{
  const f=fixture(t),hold=voiceHold(f),before=fs.readFileSync(hold.active);
  for(const relative of ['state/ui-service.lock','state/native-voice-outbox/worker.lock','state/voice-operator-recovery/lock']) {
    f.write(relative,{pid:100});const view=await f.controls.inspectVoiceRecovery();assert.equal(view.available,false);assert.equal(view.canRecover,false);assert.equal(view.revision,null);assert.deepEqual(fs.readFileSync(hold.active),before);fs.unlinkSync(path.join(f.root,relative));
  }
  f.write('state/voice-preview/timed/active.json',{version:1,id:hold.id,extra:true});const malformed=await f.controls.inspectVoiceRecovery();assert.equal(malformed.available,false);assert.equal(malformed.canRecover,false);assert.equal(JSON.stringify(malformed).includes(hold.id),false);assert.equal(f.calls.length,0);
});

test('a recovery journal or lock blocks new permission enable independently of original active files',async t=>{
  const f=fixture(t);
  for(const name of ['transaction.json','lock']) {f.write('state/voice-operator-recovery/'+name,{version:1});const view=f.controls.snapshot();assert.equal(view.canEnable,false);await assert.rejects(f.controls.save({expectedRevision:view.revision,enabled:true}),{code:'UI_RUNTIME_STOP_SERVICES'});fs.unlinkSync(path.join(f.root,'state/voice-operator-recovery',name));}
});

test('native helper stop probe is hidden read-only enumeration and fails closed for active or incomplete evidence',async()=>{
  const executeImpl=async(exe,args,options)=>{assert.match(exe,/powershell\.exe$/i);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);const code=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.match(code,/Get-CimInstance Win32_Process/);for(const name of ['WechatVoicePreview.exe','WechatQtActions.exe','WechatUiHost.exe','WechatDraftProbe.exe','WechatWindowMessageProbe.exe','AudioRouteProbe.exe'])assert.ok(code.includes("Name='"+name+"'"));assert.doesNotMatch(code,/Stop-Process|Start-Process|SendInput/);return{stdout:JSON.stringify({version:1,complete:true,count:0})};};
  assert.equal(await nativeInputHelpersStopped({executeImpl,platform:'win32'}),true);
  for(const value of [{version:1,complete:true,count:1},{version:1,complete:false,count:0},{version:1,complete:true,count:0,extra:true},null])assert.equal(await nativeInputHelpersStopped({executeImpl:async()=>({stdout:JSON.stringify(value)}),platform:'win32'}),false);
  assert.equal(await nativeInputHelpersStopped({executeImpl:async()=>{throw Error('denied');},platform:'win32'}),false);
  assert.equal(await nativeInputHelpersStopped({executeImpl:async()=>assert.fail('no non-Windows fallback'),platform:'linux'}),false);
});

test('voice recovery HTTP endpoint requires local token, same origin, both acknowledgements and CAS',async t=>{
  const f=fixture(t),hold=voiceHold(f),app=createConsole({root:f.root,port:0,uiRuntimeControls:f.controls,runner:async()=>assert.fail('no service start'),fetchImpl:async()=>assert.fail('no external call')});
  const address=await app.start(),base='http://127.0.0.1:'+address.port;t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const {token}=await(await fetch(base+'/api/info')).json(),headers={'X-Console-Token':token,'Content-Type':'application/json'},endpoint=base+'/api/ui-runtime-controls/recover-voice';
  assert.equal((await fetch(base+'/api/ui-runtime-controls/voice-recovery')).status,401);
  const view=await(await fetch(base+'/api/ui-runtime-controls/voice-recovery',{headers})).json(),request={method:'POST',body:JSON.stringify(voiceAcknowledgement(view.revision))};
  assert.equal((await fetch(endpoint,{...request,headers:{'Content-Type':'application/json'}})).status,401);assert.equal((await fetch(endpoint,{...request,headers:{...headers,Origin:'https://untrusted.invalid'}})).status,403);
  assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({expectedRevision:view.revision,acknowledgeRecordingEnded:true})})).status,409);assert.equal(fs.existsSync(hold.active),true);
  const response=await fetch(endpoint,{...request,headers});assert.equal(response.status,200);const result=await response.json();assert.equal(result.deliveryConfirmed,false);assert.equal(result.inputSent,false);assert.equal(result.servicesStarted,false);assert.equal(fs.existsSync(hold.active),false);
  assert.equal((await fetch(endpoint,{...request,headers})).status,409);
});
