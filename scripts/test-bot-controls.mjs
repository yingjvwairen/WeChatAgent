import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createBotControls, botControlsError } from './bot-controls.mjs';
import { ReplyPreferences } from './reply-preferences.mjs';
import { createConsole,validateConsoleConfig } from './console-server.mjs';
import { projectRoot } from './project-config.mjs';
import { createBotControlsUI } from '../public/console/bot-controls.js';
import {UiaModeStore} from './uia-mode.mjs';
import {UiaOffscreenStore} from './uia-offscreen-mode.mjs';

const hex=letter=>letter.repeat(64),fail=code=>Object.assign(new Error('private detail must stay local'),{code});
function folder(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bot-controls-'));t.after(()=>{const target=fs.realpathSync(root);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.match(path.basename(target),/^bot-controls-/);fs.rmSync(target,{recursive:true});});return root;}
function service(t,changes={}){
  const root=folder(t),state={accountRef:hex('a'),initialized:true,initializes:0,selected:null,saved:null,contacts:null,targets:[{wxid:'friend-one',id:'123',label:'好友',alias:'friend_alias',grantId:'private-grant'}]};
  class TargetStore{constructor({accountRef}){if(!state.initialized)throw fail('UI_TARGET_SELECTION_NOT_INITIALIZED');this.accountRef=accountRef;}get(){return{version:3,accountRef:this.accountRef,targets:state.targets};}async replace(value){state.replace=value;return this.get();}}
  class VoiceStore{async snapshot(){return{version:2,status:'pending',selectedId:'dania',applied:false,profiles:[]};}async save(value){state.saved=value;return this.snapshot();}async select(value){state.selected=value;return this.snapshot();}async discover(){return{root:'fixture-models',gptWeights:['voice.ckpt'],sovitsWeights:['voice.pth'],refAudio:['reference.wav']};}}
  const options={root,check:()=>({account:{accountRef:state.accountRef}}),TargetStore,VoiceStore,useVoiceProfile:async request=>new VoiceStore().select({...request,apply:true}),
    initialize:async()=>{state.initializes++;state.initialized=true;},contacts:async value=>{state.contacts=value;return{contacts:[],accountRef:value.expectedAccountRef};},...changes};
  return{root,state,options,controls:createBotControls(options)};
}
test('settings snapshot initializes protected target state once and excludes delivery grants',async t=>{const f=service(t);f.state.initialized=false;const value=await f.controls.snapshot();assert.equal(f.state.initializes,1);assert.equal(value.targets.targets[0].grantId,undefined);assert.equal(JSON.stringify(value).includes('private-grant'),false);assert.equal(value.targets.automaticReplies,false);assert.equal(value.interaction.canDisablePause,false);assert.equal(value.reply.mode,'automatic');await f.controls.snapshot();assert.equal(f.state.initializes,1);});
test('reader failure is isolated and does not hide voice or reply preferences',async t=>{const f=service(t,{check:()=>{throw fail('READER_LOCAL_CONFIG_MISSING');}}),value=await f.controls.snapshot();assert.ok(value.targets.error);assert.equal(value.voice.status,'pending');assert.equal(value.reply.mode,'automatic');assert.equal(JSON.stringify(value).includes('private detail'),false);});
test('contact catalog and selected-target save carry current account and revision',async t=>{const f=service(t);await f.controls.contacts({accountRef:hex('a'),keyword:'好友'});assert.equal(f.state.contacts.expectedAccountRef,hex('a'));assert.equal(f.state.contacts.keyword,'好友');assert.equal(f.state.contacts.limit,100);await f.controls.replaceTargets({accountRef:hex('a'),expectedVersion:3,targetWxids:['friend-one']});assert.deepEqual(f.state.replace,{expectedVersion:3,targetWxids:['friend-one']});f.state.accountRef=hex('b');await assert.rejects(f.controls.replaceTargets({accountRef:hex('a'),expectedVersion:3,targetWxids:[]}),{status:409});});
test('voice selection warms the service and immediately applies the chosen profile',async t=>{const f=service(t);await f.controls.selectVoice({expectedVersion:2,id:'voice-two',apply:true});assert.deepEqual(f.state.selected,{expectedVersion:2,id:'voice-two',apply:true});await f.controls.saveVoice({expectedVersion:2,name:'方案',config:{gptWeights:'a.ckpt'},id:'voice-two'});assert.deepEqual(f.state.saved,{expectedVersion:2,name:'方案',config:{gptWeights:'a.ckpt'},id:'voice-two'});});

test('saving selected and unused voices never starts or loads a service',async t=>{
  let saves=0;
  class VoiceStore{async save(body){saves++;return{version:9,selectedId:'active',savedId:body.id,profiles:[],applied:false,status:'pending'};}}
  const f=service(t,{VoiceStore,useVoiceProfile:async()=>assert.fail('save must not load a model')});
  for(const id of ['active','unused']){
    const result=await f.controls.saveVoice({expectedVersion:8,id,name:id,config:{}});
    assert.equal(result.version,9);assert.equal(result.applied,false);assert.match(result.statusText,/尚未加载/);
  }
  assert.equal(saves,2);
});
test('running robot owns a requested voice load even after the console closes',async t=>{
  const root=folder(t),token='a'.repeat(64),requests=[];
  fs.mkdirSync(path.join(root,'state'));fs.mkdirSync(path.join(root,'config'));
  fs.writeFileSync(path.join(root,'state/ui-service.lock'),JSON.stringify({pid:process.pid}));
  fs.writeFileSync(path.join(root,'state/social-dsh-token.txt'),token);
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/status'){res.end(JSON.stringify({backend:'wechat-ui',project:'WeChatAgent',projectRoot:root}));return;}
    assert.equal(req.url,'/voice-profile/select');assert.equal(req.headers.authorization,'Bearer '+token);
    let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
    res.end(JSON.stringify({selectedId:'chosen',applied:true,profiles:[],version:5}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({ports:{adapter:server.address().port}}));
  const controls=createBotControls({root,VoiceStore:class{constructor(){assert.fail('the console cannot own this model')}}});
  const selected=await controls.selectVoice({expectedVersion:4,id:'chosen'});await controls.close();
  assert.equal(selected.applied,true);assert.deepEqual(requests,[{expectedVersion:4,id:'chosen'}]);
});
test('failed explicit voice startup does not report a loaded profile',async t=>{
  const f=service(t,{useVoiceProfile:async()=>{throw fail('VOICE_SERVICE_START_FAILED');}});
  await assert.rejects(f.controls.selectVoice({expectedVersion:2,id:'voice-two'}),{status:400});assert.equal(f.state.selected,null);
});
test('human-input guard stays enabled and obsolete fixed reply choices cannot change automatic output',async t=>{const f=service(t);await assert.rejects(f.controls.replaceInteraction({expectedVersion:0,pauseOnHumanActivity:false}),{status:409});assert.equal((await f.controls.snapshot()).interaction.pauseOnHumanActivity,true);for(const mode of ['file','voice','text','automatic'])assert.throws(()=>f.controls.replaceReply({expectedVersion:0,mode}),{status:409});assert.deepEqual((await f.controls.snapshot()).reply,{mode:'automatic'});assert.equal(fs.existsSync(new ReplyPreferences({root:f.root}).file),false);});

test('OCR settings default to fast text with focus handoff and normalize legacy updates',async t=>{
  const f=service(t),initial=(await f.controls.snapshot()).interaction;
  assert.equal(initial.sendMode,'focus-handoff');assert.equal(initial.canUseFocusHandoff,true);
  assert.match(initial.statusText,/OCR 快速链路.*快速搜索联系人.*文字正文快速粘贴/);assert.doesNotMatch(initial.statusText,/副机|双机|另一台电脑/);
  assert.equal(initial.focusHandoffVerified,true);assert.equal(initial.focusHandoffProductionReady,false);
  const shared=await f.controls.replaceInteraction({expectedVersion:initial.version,pauseOnHumanActivity:true,sendMode:'focus-handoff'});
  assert.equal(shared.sendMode,'focus-handoff');assert.equal(shared.pauseOnHumanActivity,true);assert.equal(shared.canDisablePause,false);
  assert.match(shared.statusText,/OCR 快速链路/);assert.match(shared.statusText,/文字正文快速粘贴/);assert.match(shared.statusText,/文字和语音均通过微信界面/);assert.doesNotMatch(shared.statusText,/Hook|注入|直发/);
  assert.equal(shared.textEntryMode,'paste');assert.equal(shared.textTransportPreference,undefined);assert.equal(shared.canPasteText,undefined);assert.equal(shared.hookTextAvailable,undefined);
  assert.equal((await f.controls.replaceInteraction({expectedVersion:shared.version,pauseOnHumanActivity:true})).sendMode,'focus-handoff');
  await assert.rejects(f.controls.replaceInteraction({expectedVersion:2,pauseOnHumanActivity:true,sendMode:'background'}),{status:400});
  await assert.rejects(f.controls.replaceInteraction({expectedVersion:2,pauseOnHumanActivity:false,sendMode:'focus-handoff'}),{status:409});
  assert.equal((await f.controls.replaceInteraction({expectedVersion:2,pauseOnHumanActivity:true,sendMode:'foreground'})).sendMode,'focus-handoff');
  assert.deepEqual(fs.readdirSync(path.join(f.root,'state')),['runtime']);
  assert.deepEqual(fs.readdirSync(path.join(f.root,'state/runtime')),['interaction-policy.json']);
});

test('bot settings preserve the selected UI preference while UIA is enabled and restore it after disabling',async t=>{
  const f=service(t),shared=await f.controls.replaceInteraction({expectedVersion:0,pauseOnHumanActivity:true,sendMode:'focus-handoff'});
  const uia=new UiaModeStore({root:f.root}),policyFile=path.join(f.root,'state/runtime/interaction-policy.json');
  const before=fs.readFileSync(policyFile,'utf8');
  fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:2,backend:'uia',version:4,enabled:true}));
  const blocked=(await f.controls.snapshot()).interaction;
  assert.equal(blocked.uiaMode.enabled,true);assert.equal(blocked.canUseFocusHandoff,true);assert.match(blocked.statusText,/UIA 快速链路/);assert.match(blocked.statusText,/文字、图片与语音/);
  assert.equal(blocked.sendMode,'focus-handoff');assert.equal(blocked.textEntryMode,'paste');
  await assert.rejects(f.controls.replaceInteraction({expectedVersion:shared.version,pauseOnHumanActivity:true,sendMode:'foreground'}),{status:409});
  assert.equal(fs.readFileSync(policyFile,'utf8'),before);
  const disabled=await f.controls.replaceUiaMode({expectedVersion:4,enabled:false});assert.equal(disabled.enabled,false);
  const restored=(await f.controls.snapshot()).interaction;
  assert.equal(restored.canUseFocusHandoff,true);assert.equal(restored.sendMode,'focus-handoff');assert.equal(restored.version,shared.version);
  assert.equal(fs.readFileSync(policyFile,'utf8'),before);
});

test('a stopped service allows UIA preferences without requiring a ready UIA host',async t=>{
  const f=service(t,{requestUia:async()=>assert.fail('do not contact a stopped sender')});
  const snapshot=(await f.controls.snapshot()).interaction;
  assert.equal(snapshot.uiaMode.canEnable,true);assert.equal(snapshot.uiaMode.runtimeActive,false);
  const saved=await f.controls.replaceUiaMode({expectedVersion:0,enabled:true});
  assert.equal(saved.enabled,true);assert.equal(saved.runtimeActive,false);
  await assert.rejects(f.controls.replaceUiaMode({expectedVersion:0,enabled:false}),{status:409});
  assert.equal(new UiaModeStore({root:f.root}).get().enabled,true);
  assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);
});

test('historical injection choice is displayed as a disabled UIA migration without changing the saved UI preference',async t=>{
  const f=service(t);await f.controls.replaceInteraction({expectedVersion:0,pauseOnHumanActivity:true,sendMode:'focus-handoff'});
  const uia=new UiaModeStore({root:f.root});fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:1,version:6,enabled:true}));
  const view=(await f.controls.snapshot()).interaction;assert.equal(view.uiaMode.enabled,false);assert.equal(view.uiaMode.migrationRequired,true);assert.equal(view.uiaMode.version,6);assert.equal(view.sendMode,'focus-handoff');assert.equal(view.canUseFocusHandoff,true);
  assert.equal(JSON.parse(fs.readFileSync(uia.file)).schemaVersion,1);
});

test('console mode uses only the UIA runtime switch and preserves its acknowledged state',async t=>{
  const calls=[],f=service(t,{requestUia:async value=>{calls.push(value.request);return{backend:'uia',version:value.request.expectedVersion+1,enabled:value.request.enabled,runtimeActive:true};}});
  fs.mkdirSync(path.join(f.root,'state'));fs.writeFileSync(path.join(f.root,'state/ui-service.lock'),'fixture host');
  const result=await f.controls.replaceUiaMode({expectedVersion:2,enabled:true});assert.equal(result.backend,'uia');assert.equal(result.runtimeActive,true);assert.equal(result.enabled,true);
  assert.deepEqual(calls,[{expectedVersion:2,enabled:true}]);
});
test('offscreen preference defaults off without moving windows or changing UIA on settings reads',async t=>{
  const calls=[],f=service(t,{requestOffscreen:async value=>{calls.push(value);throw Error('must not move on read');}});
  const uia=new UiaModeStore({root:f.root}),offscreen=new UiaOffscreenStore({root:f.root});
  fs.mkdirSync(path.dirname(uia.file),{recursive:true});fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:2,backend:'uia',version:3,enabled:true}));
  const first=(await f.controls.snapshot()).interaction;
  assert.equal(first.uiaMode.enabled,true);assert.equal(first.offscreenMode.enabled,false);assert.equal(first.offscreenMode.version,0);assert.equal(first.offscreenMode.canChange,true);
  assert.equal(fs.existsSync(offscreen.file),false);assert.equal(calls.length,0);assert.equal(uia.get().version,3);
});
test('offscreen console delegates immediate movement to the running host and preserves independent UIA settings',async t=>{
  const calls=[],f=service(t,{inspectUia:()=>({backend:'uia',canEnable:true}),requestOffscreen:async value=>{calls.push(value.request);return{backend:'uia-offscreen',runtimeActive:true,version:value.request.expectedVersion+1,enabled:value.request.enabled,windowState:{state:value.request.enabled?'parked':'restored',restored:!value.request.enabled}};}});
  const uia=new UiaModeStore({root:f.root});fs.mkdirSync(path.dirname(uia.file),{recursive:true});fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:2,backend:'uia',version:3,enabled:true}));
  const before=fs.readFileSync(uia.file,'utf8');fs.writeFileSync(path.join(f.root,'state/ui-service.lock'),'fixture host');
  const enabled=await f.controls.replaceUiaOffscreen({expectedVersion:0,enabled:true});assert.equal(enabled.enabled,true);assert.equal(enabled.runtimeActive,true);assert.equal(enabled.canEnable,true);
  const disabled=await f.controls.replaceUiaOffscreen({expectedVersion:1,enabled:false});assert.equal(disabled.enabled,false);assert.equal(disabled.windowState.restored,true);
  assert.deepEqual(calls,[{expectedVersion:0,enabled:true},{expectedVersion:1,enabled:false}]);assert.equal(fs.readFileSync(uia.file,'utf8'),before);
  assert.equal(fs.existsSync(new UiaOffscreenStore({root:f.root}).file),false); // Only the running host commits the setting.
});
test('offscreen console requires UIA for both stopped and running services without mutating preferences, but permits recall',async t=>{
  const calls=[],f=service(t,{requestOffscreen:async value=>{calls.push(value.request);return{backend:'uia-offscreen',runtimeActive:true,version:value.request.expectedVersion+1,enabled:false,windowState:{restored:true}};}});
  await assert.rejects(f.controls.replaceUiaOffscreen({expectedVersion:0,enabled:true}),error=>error.status===409&&/先开启 UIA 模式/.test(error.message));
  fs.mkdirSync(path.join(f.root,'state'),{recursive:true});fs.writeFileSync(path.join(f.root,'state/ui-service.lock'),'fixture host');
  await assert.rejects(f.controls.replaceUiaOffscreen({expectedVersion:0,enabled:true}),error=>error.status===409&&/先开启 UIA 模式/.test(error.message));
  assert.equal(calls.length,0);const result=await f.controls.replaceUiaOffscreen({expectedVersion:2,enabled:false});assert.equal(result.enabled,false);assert.equal(calls.length,1);
  assert.equal(fs.existsSync(new UiaOffscreenStore({root:f.root}).file),false);
});
test('stopped-service offscreen disable clears the saved choice without moving an unowned window or starting a host',async t=>{
  const f=service(t,{requestOffscreen:async()=>assert.fail('offline disable must not start or contact a sender')});
  const store=new UiaOffscreenStore({root:f.root});store.replace({expectedVersion:0,enabled:true});
  const result=await f.controls.replaceUiaOffscreen({expectedVersion:1,enabled:false});
  assert.equal(result.enabled,false);assert.equal(result.version,2);assert.equal(result.runtimeActive,false);assert.equal(result.windowState.windowMoved,false);assert.equal(result.windowState.reason,'OFFSCREEN_NO_MANAGED_WINDOW');assert.equal(store.get().enabled,false);
  assert.equal(fs.existsSync(path.join(f.root,'state/ui-offscreen')),false);assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);assert.equal(new UiaModeStore({root:f.root}).get().enabled,false);
});
test('UIA and offscreen can be set before first startup, and switching back to OCR clears the offscreen preference',async t=>{
  const f=service(t,{requestOffscreen:async()=>assert.fail('must stay offline')});
  await f.controls.replaceUiaMode({expectedVersion:0,enabled:true});
  const enabled=await f.controls.replaceUiaOffscreen({expectedVersion:0,enabled:true});
  assert.equal(enabled.enabled,true);assert.equal(enabled.runtimeActive,false);
  assert.equal(enabled.windowState.reason,'OFFSCREEN_ON_START');
  assert.equal(enabled.windowState.windowMoved,false);
  await f.controls.replaceUiaMode({expectedVersion:1,enabled:false});
  assert.equal(new UiaOffscreenStore({root:f.root}).get().enabled,false);
  assert.equal(new UiaModeStore({root:f.root}).get().enabled,false);
  assert.equal(fs.existsSync(path.join(f.root,'state/ui-service.lock')),false);
});
test('offline recall validates the original revision before moving and commits only after recovery',async t=>{
  let store,calls=0,failed=true;
  const f=service(t,{moveStoppedWindow:async({validate,apply,enabled})=>{
    validate();calls++;assert.equal(enabled,false);assert.equal(store.get().enabled,true);
    if(failed)throw fail('OFFSCREEN_RESTORE_UNCONFIRMED');
    return apply({state:'ownership-lost',released:true,restored:false});
  }});
  store=new UiaOffscreenStore({root:f.root});store.replace({expectedVersion:0,enabled:true});
  for(const req of [{expectedVersion:0,enabled:false},{expectedVersion:1,enabled:false,extra:true},{expectedVersion:1,enabled:'false'}])
    await assert.rejects(f.controls.replaceUiaOffscreen(req),{status:409});
  assert.equal(calls,0);
  await assert.rejects(f.controls.replaceUiaOffscreen({expectedVersion:1,enabled:false}),{status:409});
  assert.equal(store.get().enabled,true);
  failed=false;const result=await f.controls.replaceUiaOffscreen({expectedVersion:1,enabled:false});
  assert.equal(result.enabled,false);assert.equal(result.windowState.state,'ownership-lost');assert.equal(calls,2);
});
test('offscreen failure messages explain required action without exposing native details',()=>{
  for(const code of ['UIA_OFFSCREEN_PENDING_DELIVERY','UIA_OFFSCREEN_BUSY','UIA_OFFSCREEN_SWITCH_UNCONFIRMED','OFFSCREEN_RESTORE_UNCONFIRMED']){
    const error=botControlsError(fail(code));assert.equal(error.status,409);assert.equal(error.message.includes('private detail'),false);
  }
  assert.match(botControlsError(fail('UIA_OFFSCREEN_PENDING_DELIVERY')).message,/发送队列/);
});
test('bounded error mapping never exposes arbitrary model or reader exception text',()=>{for(const code of ['VOICE_SERVICE_FAILED','READER_TARGET_PROTOCOL_INVALID','UI_REPLY_SETTINGS_INVALID','unexpected']){const error=botControlsError(fail(code));assert.equal(error.message.includes('private detail'),false);assert.ok([400,409,500,503].includes(error.status));}});

test('mode switch pending refusal explains queue recovery and preserves the saved unchecked choice',async t=>{
  const mapped=botControlsError(fail('UIA_MODE_PENDING_DELIVERY'));assert.equal(mapped.status,409);assert.match(mapped.message,/发送队列/);assert.match(mapped.message,/尚未输入的排队消息会保留/);assert.doesNotMatch(mapped.message,/组件|private detail/);
  const f=uiFixture(t);f.snapshot.interaction.uiaMode={version:0,enabled:false,canEnable:true};f.handlers.set('/api/bot-controls/uia-mode',()=>{throw mapped;});
  await f.interaction();const checkbox=f.element('bot-uia-mode');checkbox.checked=true;f.dispatch('change',checkbox);await flush();
  assert.equal(checkbox.checked,false);assert.equal(f.toasts.at(-1),mapped.message);assert.equal(f.calls.filter(c=>c.route==='/api/bot-controls/uia-mode').length,1);
  assert.equal(f.calls.some(c=>c.route==='/api/jobs'||(c.route==='/api/bot-controls/interaction'&&c.body!==undefined)),false);
});

test('reply preferences persist revisions, reject corrupt/oversized state, and never repair by overwriting',t=>{const root=folder(t),store=new ReplyPreferences({root});assert.deepEqual(store.get(),{version:0,mode:'text'});assert.deepEqual(store.replace({expectedVersion:0,mode:'voice'}),{version:1,mode:'voice'});assert.equal(new ReplyPreferences({root}).get().mode,'voice');const file=store.file;
  for(const raw of ['{','null','[]','{"version":0,"mode":"text"}','{"version":1,"mode":"file"}','{"version":1,"mode":"text","extra":true}',' '.repeat(1025)]){fs.writeFileSync(file,raw);assert.throws(()=>store.get(),{code:'UI_REPLY_SETTINGS_INVALID'});assert.throws(()=>store.replace({expectedVersion:1,mode:'text'}),{code:'UI_REPLY_SETTINGS_INVALID'});assert.equal(fs.readFileSync(file,'utf8'),raw);assert.equal(fs.existsSync(file+'.lock'),false);}
  assert.throws(()=>store.replace({expectedVersion:Number.MAX_SAFE_INTEGER,mode:'text'}),{code:'UI_REPLY_SETTINGS_INVALID'});
});
test('busy reply preferences keep the existing file unchanged',t=>{const root=folder(t),store=new ReplyPreferences({root});store.replace({expectedVersion:0,mode:'text'});fs.writeFileSync(store.file+'.lock','another-owner');assert.throws(()=>store.replace({expectedVersion:1,mode:'voice'}),{code:'UI_REPLY_SETTINGS_BUSY'});assert.equal(store.get().mode,'text');assert.equal(fs.readFileSync(store.file+'.lock','utf8'),'another-owner');});

async function serverFixture(t,{localAsr,fetchImpl=async()=>{throw Error('unexpected external request');}}={}){const root=folder(t);for(const name of ['config','roles'])fs.mkdirSync(path.join(root,name));const config=JSON.parse(fs.readFileSync(path.join(projectRoot,'config/wechatagent.example.json'),'utf8'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'fixture');const calls=[];
  const botControls=Object.fromEntries(['snapshot','contacts','voiceFiles','replaceTargets','saveVoice','selectVoice','replaceInteraction','replaceReply','importReplyMedia','saveReplyMedia','replaceUiaMode','replaceUiaOffscreen'].map(method=>[method,async body=>{calls.push({method,body});return{method,fixture:true};}]));
  const app=createConsole({root,port:0,botControls,localAsr,runner:async()=>{throw Error('unexpected runner');},fetchImpl,processProbe:async()=>[]});const address=await app.start(),base='http://127.0.0.1:'+address.port,token=(await fetch(base+'/api/info').then(r=>r.json())).token;
  t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));});
  return{base,token,calls,request:async(route,{body,headers={},authenticated=true}={})=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(authenticated?{'X-Console-Token':token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}};
}
test('speech provider console saves ASR independently and redacts the credential on all responses',async t=>{
  const f=await serverFixture(t),route='/api/bot-controls/speech-providers';
  const initial=(await f.request('/api/bot-controls')).body.speechProviders;
  assert.equal(initial.asr.mode,'local');
  assert.equal(initial.tts.mode,'local');
  const request={expectedVersion:initial.version,
    asr:{mode:'cloud',endpoint:'https://speech.example.test/asr',model:'fixture-model',apiKey:process.platform==='win32'?'synthetic-test-key':null},
    tts:{mode:'local',model:'',voice:'',endpoint:'',apiKey:null}};
  const saved=await f.request(route,{body:request});
  assert.equal(saved.status,200);
  assert.equal(saved.body.asr.mode,'cloud');
  assert.equal(saved.body.tts.mode,'local');
  assert.equal(saved.body.asr.hasApiKey,process.platform==='win32');
  assert.deepEqual((await f.request('/api/bot-controls')).body.speechProviders,saved.body);
  assert.ok(!JSON.stringify(saved.body).includes('synthetic-test-key'));
  assert.equal((await f.request(route,{body:request})).status,409);
  if(saved.body.asr.hasApiKey){
    request.expectedVersion=saved.body.version;
    request.asr.endpoint='https://elsewhere.example.test/asr';
    request.asr.apiKey=null;
    assert.equal((await f.request(route,{body:request})).status,400);
    assert.deepEqual((await f.request('/api/bot-controls')).body.speechProviders,saved.body);
  }
});
test('console probes only saved cloud configuration with a fixed sample and a playable TTS preview',async t=>{
  const sample=fs.readFileSync(path.join(import.meta.dirname,'fixtures','speech-service-test.wav'));
  const f=await serverFixture(t,{fetchImpl:async(url,options)=>{
    if(url.endsWith('/asr')){
      const file=options.body.get('file');assert.deepEqual(Buffer.from(await file.arrayBuffer()),sample);
      return Response.json({text:'这是一段语音识别测试'});
    }
    assert.ok(url.endsWith('/tts'));
    assert.equal(JSON.parse(options.body).input,'这是微信语音合成测试。');
    return new Response(sample);
  }});
  const route='/api/bot-controls/speech-providers';
  const saved=await f.request(route,{body:{expectedVersion:0,
    asr:{mode:'cloud',model:'a',endpoint:'https://speech.example.test/asr',apiKey:null},
    tts:{mode:'cloud',model:'b',voice:'v',endpoint:'https://speech.example.test/tts',apiKey:null}}});
  assert.equal(saved.status,200);
  const check=(kind,version)=>f.request(route+'/test',{body:{kind,expectedVersion:version}});
  assert.equal((await check('asr',0)).status,409);
  assert.equal((await check('asr',1)).body.matched,true);
  const result=await check('tts',1);assert.equal(result.status,200);
  assert.equal(Buffer.from(result.body.wav,'base64').toString('ascii',0,4),'RIFF');
});
test('local ASR stays unloaded through save, loads only the saved selection and can be released',async t=>{
  let loaded=false,uses=0;
  const status=()=>({loaded,profileId:loaded?'default':null,instanceId:'internal-id'});
  const f=await serverFixture(t,{localAsr:{
    localAsrStatus:status,
    useLocalAsr:({id,expectedVersion})=>{assert.equal(expectedVersion,1);assert.equal(id,'default');uses++;loaded=true;return status();},
    stopLocalAsr:()=>{loaded=false;}
  }});
  const save='/api/bot-controls/speech-providers',use='/api/bot-controls/asr/use',stop='/api/bot-controls/asr/stop';
  const settings={expectedVersion:0,asr:{mode:'local',model:'',endpoint:'',apiKey:null},tts:{mode:'local',model:'',endpoint:'',voice:'',apiKey:null}};
  const body={id:'default',expectedVersion:1},idle={loaded:false,profileId:null};
  assert.deepEqual((await f.request(save,{body:settings})).body.localAsrRuntime,idle);
  assert.equal((await f.request(use,{authenticated:false,body})).status,401);
  assert.equal((await f.request(use,{body:{...body,expectedVersion:0}})).status,409);
  assert.equal((await f.request(use,{body:{...body,id:'default-zh'}})).status,409);
  assert.equal((await f.request(use,{body:{...body,directory:'arbitrary'}})).status,400);
  assert.equal(uses,0);
  assert.deepEqual((await f.request(use,{body})).body,{loaded:true,profileId:'default'});
  assert.equal((await f.request('/api/bot-controls')).body.speechProviders.localAsrRuntime.loaded,true);
  assert.deepEqual((await f.request(stop,{body})).body,idle);
  const cloud={...settings,expectedVersion:1,asr:{...settings.asr,mode:'cloud',model:'fixture',endpoint:'https://example.test/asr'}};
  assert.equal((await f.request(save,{body:cloud})).status,200);
  assert.equal((await f.request(use,{body:{...body,expectedVersion:2}})).status,409);
  assert.equal(uses,1);
});
test('all bot API routes use injected local service and require host/origin/token checks',async t=>{const f=await serverFixture(t);
  for(const [route,method,body]of [['','snapshot'],['/contacts?accountRef=fixture&keyword=test','contacts'],['/voice/files','voiceFiles'],['/targets','replaceTargets',{targetWxids:[]}],['/voice/save','saveVoice',{name:'fixture'}],['/voice/select','selectVoice',{id:'fixture'}],['/interaction','replaceInteraction',{pauseOnHumanActivity:true}],['/reply','replaceReply',{mode:'voice'}],['/media/import','importReplyMedia',{directory:'fixture'}],['/media/save','saveReplyMedia',{items:[]}]]){
    assert.equal((await f.request('/api/bot-controls'+route,{body})).body.method,method);
  }
  assert.equal((await f.request('/api/bot-controls/uia-mode',{body:{expectedVersion:1,enabled:true}})).body.method,'replaceUiaMode');
  assert.equal((await f.request('/api/bot-controls/uia-mode',{body:{expectedVersion:1,enabled:true},authenticated:false})).status,401);
  assert.equal((await f.request('/api/bot-controls/uia-offscreen',{body:{expectedVersion:1,enabled:true}})).body.method,'replaceUiaOffscreen');
  assert.equal((await f.request('/api/bot-controls/uia-offscreen',{body:{expectedVersion:1,enabled:false},authenticated:false})).status,401);
  assert.equal((await f.request('/api/bot-controls/uia-offscreen',{body:{expectedVersion:1,enabled:true},headers:{Origin:'https://other.example'}})).status,403);
  const before=f.calls.length;
  assert.equal((await f.request('/api/bot-controls',{authenticated:false})).status,401);
  assert.equal((await f.request('/api/bot-controls/reply',{body:{mode:'voice'},authenticated:false})).status,401);
  assert.equal((await f.request('/api/bot-controls',{headers:{Origin:'https://other.example'}})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{const request=http.request(f.base+'/api/bot-controls',{headers:{Host:'localhost:123','X-Console-Token':f.token}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.once('error',reject);request.end();});
  assert.equal(wrongHost,403);
  assert.equal(f.calls.length,before);
  for(const route of ['/bot-controls.js','/delivery-queue.js','/bot-controls.css'])assert.equal((await fetch(f.base+route)).status,200);
});

function uiFixture(t,targets=[]){const original=globalThis.document,elements=new Map(),toasts=[],calls=[],handlers=new Map(),snapshot={notice:'fixture',speechProviders:{version:0,asr:{mode:'local',model:'',endpoint:'',hasApiKey:false},tts:{mode:'local',model:'',endpoint:'',voice:'',hasApiKey:false}},targets:{version:3,accountRef:hex('a'),targets},voice:{version:4,selectedId:'dania',status:'pending',statusText:'待下次合成',profiles:[{id:'dania',name:'达妮娅',config:{gptWeights:'a.ckpt',sovitsWeights:'a.pth',refAudio:'a.wav',promptText:'原文',promptLang:'zh',textLang:'zh',speed:1}}]},interaction:{schemaVersion:3,version:0,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste',canPasteText:true,canDisablePause:false,canUseFocusHandoff:true,focusHandoffVerified:false,focusHandoffProductionReady:false,statusText:'OCR 快速链路'},reply:{version:1,mode:'text'}};
  const element=id=>{if(!elements.has(id))elements.set(id,{id,isConnected:true,disabled:false,dataset:{},listeners:{},querySelector(selector){return element(selector.slice(1));},addEventListener(event,fn){(this.listeners[event]??=[]).push(fn);},closest(selector){return selector==='button'?this:elements.get('bot-controls');},insertAdjacentHTML(where,text){this.innerHTML=(this.innerHTML??'')+text;}});return elements.get(id);};
  globalThis.document={querySelector:selector=>element(selector.slice(1)),querySelectorAll:()=>[]};t.after(()=>{globalThis.document=original;});
  const api=async(route,body)=>{calls.push({route,body});if(body===undefined&&handlers.has('GET '+route))return handlers.get('GET '+route)();if(route==='/api/bot-controls/interaction'&&body===undefined)return structuredClone(snapshot.interaction);if(handlers.has(route))return handlers.get(route)(body);if(route==='/api/bot-controls/speech')return structuredClone({voice:snapshot.voice,speechProviders:snapshot.speechProviders});if(route==='/api/bot-controls')return structuredClone(snapshot);if(route==='/api/ui-runtime-controls'&&body===undefined)return{revision:hex('e'),enabled:false,canEnable:true,blockers:[],voice:{configured:false}};if(route==='/api/bot-controls/targets')return{...snapshot.targets,version:4,targets:body.targetWxids.map(wxid=>({wxid,label:wxid,alias:''}))};if(route==='/api/bot-controls/reply')return{version:2,mode:body.mode};throw Error('unexpected UI API');};
  const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const ui=createBotControlsUI({api,escapeHtml:esc,header:(title,subtitle='')=>`<h2>${title}</h2><p>${subtitle}</p>`,toast:value=>toasts.push(value)});
  const dispatch=(event,target)=>{for(const id of ['bot-interaction-card','bot-speech-controls','bot-maintenance-controls'])for(const listener of element(id).listeners[event]??[])listener({target,preventDefault(){}});};
  const replaceElement=id=>{element(id).isConnected=false;elements.delete(id);return element(id);};
  async function interaction() {await ui.mountInteraction();return element('bot-interaction-card').innerHTML;}
  return{ui,snapshot,element,replaceElement,dispatch,calls,toasts,handlers,interaction};
}
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

test('speech profiles share one save, with local editors before the final button',async t=>{
  const f=uiFixture(t),local=await f.ui.speechPage();
  const speech=local.slice(local.indexOf('id="speech-provider-form"'),local.indexOf('</form>',local.indexOf('id="speech-provider-form"')));
  assert.equal((speech.match(/type="submit"/g)??[]).length,1);
  assert.doesNotMatch(speech,/<form|>保存方案</);
  const asr=speech.indexOf('编辑识别方案'),tts=speech.indexOf('aria-label="语音合成"'),picker=speech.indexOf('id="bot-voice-select"');
  const details=speech.indexOf('编辑权重与参考音频'),save=speech.indexOf('保存语音服务');
  assert.ok(asr>0&&asr<tts&&tts<picker&&picker<details&&details<save);
  assert.match(local,/本地识别方案尚未加载/);
  f.snapshot.speechProviders.localAsrRuntime={loaded:true,profileId:'default'};
  Object.assign(f.snapshot.voice,{applied:true,statusText:'本地音色已加载。'});
  const loaded=await f.ui.speechPage();
  for(const html of [local,loaded]){
    assert.match(html,/<button[^>]*id="bot-asr-use"\s*>使用此方案<\/button>/);
    assert.match(html,/<button[^>]*id="bot-voice-use"\s*>使用此方案<\/button>/);
    assert.doesNotMatch(html,/>卸载<\/button>/);
  }
  assert.match(loaded,/识别模型已常驻/);
  assert.match(loaded,/本地音色已加载/);
  f.snapshot.speechProviders.tts.mode='cloud';
  const cloud=await f.ui.speechPage();
  assert.match(cloud,/data-speech-local-tts-selector[^>]*hidden/);
  assert.match(cloud,/data-speech-local-tts-editor[^>]*hidden/);
});
test('the bottom save persists a selected local voice and does not load its weights',async t=>{
  const f=uiFixture(t),alternate={...structuredClone(f.snapshot.voice.profiles[0]),id:'alternate',name:'备用'};
  f.snapshot.voice.profiles.push(alternate);
  await f.ui.speechPage();f.ui.mountSpeech();
  const select=f.element('bot-voice-select');select.value='alternate';f.dispatch('change',select);
  assert.equal(f.ui.hasDraft(),true);
  let sent;
  f.handlers.set('/api/bot-controls/speech-providers',body=>{sent=body;return {...f.snapshot.speechProviders,version:1,voice:{...f.snapshot.voice,selectedId:'alternate',version:5}};});
  f.dispatch('submit',f.element('speech-provider-form'));await flush();
  assert.deepEqual(sent.localVoice,{id:'alternate',expectedVersion:4});
  assert.equal(sent.tts.mode,'local');assert.equal(sent.asr.mode,'local');
  assert.equal(f.ui.hasDraft(),false);assert.equal(f.calls.some(c=>c.route==='/api/bot-controls/voice/select'),false);
});

test('voice UI displays loading while the user applies a local profile',async t=>{
  const f=uiFixture(t);let finish;f.handlers.set('/api/bot-controls/voice/select',()=>new Promise(resolve=>{finish=resolve;}));
  const html=await f.ui.speechPage();f.ui.mountSpeech();assert.match(html,/for="bot-voice-select">机器人语音<\/label>/);
  f.element('bot-voice-select').value='dania';f.dispatch('click',f.element('bot-voice-use'));await flush();
  assert.match(f.element('bot-voice-status').textContent,/正在加载/);assert.equal(f.element('bot-speech-controls').inert,true);
  assert.equal(f.element('bot-voice-use').ariaBusy,'true');
  assert.notEqual(f.element('bot-runtime-enable').ariaBusy,'true');
  finish({...f.snapshot.voice,applied:true,statusText:'所选方案已加载。'});await flush();
  assert.equal(f.element('bot-voice-status').textContent,'所选方案已加载。');assert.equal(f.element('bot-speech-controls').inert,false);
  assert.equal(f.element('bot-voice-use').ariaBusy,'false');
});
test('ASR picker loads the saved recognizer independently of voice synthesis',async t=>{
  const f=uiFixture(t);let finish;
  const use='/api/bot-controls/asr/use';
  f.handlers.set(use,()=>new Promise(resolve=>{finish=resolve;}));
  const html=await f.ui.speechPage();f.ui.mountSpeech();
  assert.match(html,/id="bot-asr-use"[^>]*>使用此方案/);
  assert.equal(f.calls.some(c=>c.route===use),false);
  f.dispatch('click',f.element('bot-asr-use'));
  assert.match(f.element('bot-asr-status').textContent,/正在加载/);
  assert.deepEqual(f.calls.at(-1),{route:use,body:{expectedVersion:0,id:'default'}});
  finish({loaded:true,profileId:'default'});await flush();
  assert.match(f.element('bot-asr-status').textContent,/已常驻/);
  assert.equal(f.element('bot-asr-use').disabled,false);
  assert.equal(f.calls.some(c=>c.route.includes('voice/select')),false);
});


test('the single sender switch replaces old shared controls and rejects forged legacy events',async t=>{
  const f=uiFixture(t);Object.assign(f.snapshot.interaction,{sendMode:'focus-handoff',uiaMode:{version:3,enabled:true,canEnable:true}});
  const html=await f.interaction();assert.match(html,/UIA 快速模式/);assert.match(html,/开启使用微信控件定位，关闭使用 OCR 识屏/);assert.doesNotMatch(html,/id="bot-focus-handoff"|共享电脑模式/);
  f.dispatch('change',{id:'bot-focus-handoff',checked:false,dataset:{}});await flush();assert.equal(f.calls.some(call=>(call.route==='/api/bot-controls/interaction'&&call.body!==undefined)),false);
});

test('disabling UIA selects OCR directly without a second interaction update',async t=>{
  const f=uiFixture(t);f.snapshot.interaction.uiaMode={version:3,enabled:true,canEnable:false};
  f.handlers.set('/api/bot-controls/uia-mode',body=>{assert.deepEqual(body,{expectedVersion:3,enabled:false});f.snapshot.interaction.uiaMode={version:4,enabled:false,canEnable:false};f.snapshot.interaction.statusText='已选择 OCR 快速链路';return f.snapshot.interaction.uiaMode;});
  await f.interaction();const uia=f.element('bot-uia-mode');uia.checked=false;f.dispatch('change',uia);await flush();
  assert.equal(uia.checked,false);assert.match(f.element('bot-interaction-card').innerHTML,/id="bot-text-humanized"/);assert.doesNotMatch(f.element('bot-interaction-card').innerHTML,/id="bot-uia-offscreen"/);assert.doesNotMatch(f.element('bot-interaction-card').innerHTML,/id="bot-focus-handoff"/);
  assert.equal(f.calls.some(call=>(call.route==='/api/bot-controls/interaction'&&call.body!==undefined)||call.route==='/api/jobs'),false);
});

test('UIA migration and unavailable components are shown without offering a hidden native mode or allowing forged enable',async t=>{
  const f=uiFixture(t);f.snapshot.interaction.uiaMode={version:7,enabled:false,migrationRequired:true,canEnable:false,reason:'UIA_MODE_COMPONENT_MISSING'};
  const html=await f.interaction();assert.match(html,/请重新选择是否开启 UIA/);assert.match(html,/请先准备匹配的微信和本机发送组件/);assert.doesNotMatch(html,/后台内存注入模式|bot-background-injection/);
  const mode=f.element('bot-uia-mode');mode.checked=true;f.dispatch('change',mode);await flush();assert.equal(mode.checked,false);assert.equal(f.calls.some(call=>call.route==='/api/bot-controls/uia-mode'),false);
});
test('offscreen UI moves immediately through its own API and recalls without disabling UIA or resuming replies',async t=>{
  const f=uiFixture(t);Object.assign(f.snapshot.interaction,{uiaMode:{version:3,enabled:true,canEnable:true},offscreenMode:{version:0,enabled:false,canEnable:true,canChange:true}});
  const html=await f.interaction();assert.match(html,/微信离屏/);assert.match(html,/开启后移至屏外，关闭后恢复原位/);assert.match(html,/id="bot-uia-offscreen"/);assert.doesNotMatch(html,/id="bot-text-humanized"/);assert.doesNotMatch(html,/自动发送前将窗口移至屏外|关闭此模式即可召回/);
  let finish;f.handlers.set('/api/bot-controls/uia-offscreen',body=>new Promise(resolve=>{finish=()=>{const result={...f.snapshot.interaction.offscreenMode,version:body.expectedVersion+1,enabled:body.enabled,windowState:{state:body.enabled?'parked':'restored',restored:!body.enabled}};f.snapshot.interaction.offscreenMode=result;resolve(result);};}));
  const toggle=f.element('bot-uia-offscreen');toggle.checked=true;f.dispatch('change',toggle);await flush();assert.equal(f.element('bot-interaction-card').inert,true);assert.match(f.element('bot-interaction-help').textContent,/正在将微信移至屏外/);
  finish();await flush();assert.equal(toggle.checked,true);assert.equal(toggle.disabled,false);assert.equal(f.element('bot-interaction-card').inert,false);
  toggle.checked=false;f.dispatch('change',toggle);await flush();assert.match(f.element('bot-interaction-help').textContent,/正在恢复微信窗口位置/);finish();await flush();assert.equal(toggle.checked,false);
  assert.deepEqual(f.calls.filter(c=>c.route==='/api/bot-controls/uia-offscreen').map(c=>c.body),[{expectedVersion:0,enabled:true},{expectedVersion:1,enabled:false}]);
  assert.equal(f.calls.some(c=>c.route==='/api/bot-controls/uia-mode'||(c.route==='/api/bot-controls/interaction'&&c.body!==undefined)||c.route==='/api/jobs'||c.route==='/api/ui-deliveries'&&c.body),false);assert.equal(f.snapshot.interaction.uiaMode.enabled,true);assert.match(f.toasts.at(-1),/位置已恢复/);
});
test('offscreen UI rejects stale enabling outside UIA',async t=>{
  const f=uiFixture(t);Object.assign(f.snapshot.interaction,{uiaMode:{version:3,enabled:false,canEnable:false},offscreenMode:{version:4,enabled:false,canEnable:true,canChange:false}});
  const html=await f.interaction();assert.doesNotMatch(html,/id="bot-uia-offscreen"/);assert.match(html,/id="bot-text-humanized"/);
  const toggle=f.element('bot-uia-offscreen');toggle.checked=true;f.dispatch('change',toggle);await flush();assert.equal(toggle.checked,false);assert.equal(toggle.disabled,true);assert.equal(f.calls.some(c=>c.route==='/api/bot-controls/uia-offscreen'),false);
});
test('offscreen UI permits recall in UIA when components are unavailable and respects manual movement',async t=>{
  const another=uiFixture(t);Object.assign(another.snapshot.interaction,{uiaMode:{version:3,enabled:true,canEnable:false},offscreenMode:{version:4,enabled:true,canEnable:false,canChange:true}});
  const activeHtml=await another.interaction();assert.match(activeHtml,/id="bot-uia-offscreen" checked/);
  another.handlers.set('/api/bot-controls/uia-offscreen',body=>{assert.deepEqual(body,{expectedVersion:4,enabled:false});const result={version:5,enabled:false,canEnable:false,windowState:{state:'ownership-lost',restored:false}};another.snapshot.interaction.offscreenMode=result;return result;});
  const active=another.element('bot-uia-offscreen');active.checked=false;another.dispatch('change',active);await flush();assert.equal(active.checked,false);assert.equal(active.disabled,true);assert.match(another.toasts.at(-1),/保留你手动调整/);
});
test('offscreen UI preserves old selection on refusal and preserves acknowledged revision when refresh fails',async t=>{
  const f=uiFixture(t);Object.assign(f.snapshot.interaction,{uiaMode:{version:3,enabled:true,canEnable:true},offscreenMode:{version:6,enabled:false,canEnable:true}});
  await f.interaction();const toggle=f.element('bot-uia-offscreen');f.handlers.set('/api/bot-controls/uia-offscreen',()=>{throw botControlsError(fail('UIA_OFFSCREEN_PENDING_DELIVERY'));});
  toggle.checked=true;f.dispatch('change',toggle);await flush();assert.equal(toggle.checked,false);assert.match(f.toasts.at(-1),/发送队列/);
  f.handlers.set('/api/bot-controls/uia-offscreen',body=>({version:body.expectedVersion+1,enabled:body.enabled,windowState:{reason:'OFFSCREEN_ALREADY_OUTSIDE',restored:false}}));
  f.handlers.set('GET /api/bot-controls/interaction',()=>{throw Error('刷新失败');});toggle.checked=true;f.dispatch('change',toggle);await flush();assert.equal(toggle.checked,true);
  toggle.checked=false;f.dispatch('change',toggle);await flush();assert.equal(toggle.checked,false);assert.deepEqual(f.calls.filter(c=>c.route==='/api/bot-controls/uia-offscreen').at(-1).body,{expectedVersion:7,enabled:false});
});
test('overview interaction settings only read the interaction endpoint and independently preserve a voice draft',async t=>{
  const f=uiFixture(t);
  assert.match(f.ui.interactionPlaceholder(),/^<section class="card bot-control-panel"/);
  const card=await f.interaction();
  assert.match(card,/电脑使用方式/);assert.doesNotMatch(card,/语音服务|发送与设备检查/);
  assert.deepEqual(f.calls.map(c=>c.route),['/api/bot-controls/interaction']);
  await f.ui.speechPage();f.ui.mountSpeech();
  f.dispatch('input',{dataset:{voiceField:'promptText'},value:'未保存的语音内容'});
  await f.ui.mountInteraction();
  assert.match(await f.ui.speechPage(),/未保存的语音内容/);
});
test('diagnostics loads the current sending permission and robot settings omit maintenance controls',async t=>{
  const f=uiFixture(t),route='/api/ui-runtime-controls',revision=hex('e');
  f.handlers.set(route,body=>({revision,enabled:body?.enabled??false,canEnable:true,blockers:[],voice:{configured:false}}));
  const daily=await f.interaction();
  assert.doesNotMatch(daily,/bot-runtime-card|bot-reader-recovery-card|电源按钮即可启动或停止/);
  assert.equal(f.calls.some(c=>c.route===route),false);
  const html=await f.ui.maintenancePage();f.ui.mountMaintenance();
  assert.match(html,/发送与设备检查/);assert.match(html,/<section[^>]*id="bot-reader-recovery-card"/);
  assert.doesNotMatch(html,/电源按钮即可启动或停止|bot-dsh-prepare/);
  f.dispatch('click',f.element('bot-runtime-enable'));await flush();
  assert.deepEqual(f.calls.at(-1),{route,body:{expectedRevision:revision,enabled:true}});
  assert.equal(f.calls.some(c=>c.route==='/api/jobs'),false);
});
test('runtime blockers prevent enabling and are escaped while disable remains available',async t=>{
  const f=uiFixture(t),route='/api/ui-runtime-controls',revision=hex('d');
  f.handlers.set(route,body=>({revision,enabled:body?.enabled??true,canEnable:false,blockers:[{code:'fixture',message:'<b>需要配置</b>'}],voice:{configured:false}}));
  await f.ui.maintenancePage();f.ui.mountMaintenance();f.dispatch('click',f.element('bot-runtime-check'));await flush();assert.match(f.element('bot-runtime-card').outerHTML,/&lt;b&gt;需要配置/);
  f.dispatch('click',f.element('bot-runtime-enable'));await flush();assert.equal(f.calls.filter(call=>call.route===route&&call.body!==undefined).length,0);
  f.dispatch('click',f.element('bot-runtime-disable'));await flush();assert.deepEqual(f.calls.at(-1),{route,body:{expectedRevision:revision,enabled:false}});
});
test('audio routing requires an enumerated pair and preserves unsaved selection and revision on conflict',async t=>{
  const f=uiFixture(t),route='/api/ui-runtime-controls',revision=hex('c');let conflict=true;
  f.handlers.set(route,body=>{if(body&&conflict)throw Error('配置已经变化');return{revision,enabled:false,canEnable:false,blockers:[],voice:{configured:!!body?.voice}};});
  f.handlers.set(route+'/audio-devices',()=>({pairs:[{name:'线路 <one>',renderId:'render-one',captureId:'capture-one'}]}));
  await f.ui.maintenancePage();f.ui.mountMaintenance();f.dispatch('click',f.element('bot-runtime-check'));await flush();f.dispatch('click',f.element('bot-runtime-audio-list'));await flush();
  assert.match(f.element('bot-runtime-card').outerHTML,/线路 &lt;one&gt;/);f.dispatch('click',f.element('bot-runtime-audio-save'));await flush();assert.match(f.toasts.at(-1),/先选择/);
  const choice=f.element('bot-runtime-audio-select');choice.value='0';f.dispatch('change',choice);assert.equal(f.ui.hasDraft(),true);const calls=f.calls.length;assert.match(await f.ui.maintenancePage(),/value="0" selected/);assert.equal(f.calls.length,calls);
  f.dispatch('click',f.element('bot-runtime-audio-save'));await flush();assert.equal(f.ui.hasDraft(),true);assert.match(f.toasts.at(-1),/变化/);conflict=false;
  f.dispatch('click',f.element('bot-runtime-audio-save'));await flush();assert.equal(f.ui.hasDraft(),false);assert.deepEqual(f.calls.at(-1),{route,body:{expectedRevision:revision,enabled:false,voice:{renderId:'render-one',captureId:'capture-one'}}});
});
test('bot UI escapes model reference text',async t=>{const f=uiFixture(t,[{wxid:'friend',label:'<script>alert(1)</script>',alias:'"x'}]);f.snapshot.voice.profiles[0].config.promptText='</textarea><img src=x>';const html=await f.ui.speechPage();assert.equal(html.includes('<script>alert'),false);assert.equal(html.includes('</textarea><img'),false);assert(html.includes("&lt;/textarea&gt;&lt;img"));assert.doesNotMatch(html,/id="bot-uia-mode"/);assert.doesNotMatch(html,/<h2>回复方式<\/h2>|id="bot-reply-mode"|后台内存注入模式/);});

test('single UIA switch sends only its mode revision and leaves OCR keyboard behavior derived',async t=>{
  const f=uiFixture(t),route='/api/bot-controls/uia-mode';f.snapshot.interaction.uiaMode={version:0,enabled:false,canEnable:true};
  f.handlers.set(route,body=>{f.snapshot.interaction.uiaMode={version:body.expectedVersion+1,enabled:body.enabled,canEnable:true};return f.snapshot.interaction.uiaMode;});
  const html=await f.interaction();assert.match(html,/id="bot-text-humanized"/);assert.doesNotMatch(html,/id="bot-focus-handoff"|id="bot-text-paste"/);
  const mode=f.element('bot-uia-mode');mode.checked=true;f.dispatch('change',mode);await flush();
  assert.deepEqual(f.calls.find(call=>call.route===route),{route,body:{expectedVersion:0,enabled:true}});
  mode.checked=false;f.dispatch('change',mode);await flush();assert.deepEqual(f.calls.filter(call=>call.route===route).at(-1),{route,body:{expectedVersion:1,enabled:false}});
  assert.equal(f.calls.some(call=>(call.route==='/api/bot-controls/interaction'&&call.body!==undefined)||call.route==='/api/jobs'||call.route==='/api/ui-runtime-controls'),false);
});

test('failed or conflicting UIA saves restore the previous switch and preserve its revision',async t=>{
  const f=uiFixture(t),route='/api/bot-controls/uia-mode';f.snapshot.interaction.uiaMode={version:0,enabled:false,canEnable:true};f.handlers.set(route,()=>{throw Error('设置已变化，请刷新。');});
  await f.interaction();const mode=f.element('bot-uia-mode');mode.checked=true;f.dispatch('change',mode);await flush();
  assert.equal(mode.checked,false);assert.match(f.toasts.at(-1),/刷新/);assert.equal(f.ui.hasDraft(),false);
  mode.checked=true;f.dispatch('change',mode);await flush();assert.deepEqual(f.calls.filter(call=>call.route===route).map(call=>call.body.expectedVersion),[0,0]);assert.equal(mode.checked,false);
});

test('removed handoff and activity switches cannot write settings via forged change events',async t=>{
  const f=uiFixture(t),html=await f.interaction();assert.doesNotMatch(html,/id="bot-focus-handoff"|id="bot-pause-on-input"/);
  f.dispatch('change',{id:'bot-focus-handoff',checked:true,dataset:{}});f.dispatch('change',{id:'bot-pause-on-input',checked:false,dataset:{}});await flush();
  assert.equal(f.calls.some(call=>(call.route==='/api/bot-controls/interaction'&&call.body!==undefined)),false);
});

test('UIA switch in flight serializes settings and survives navigation without stale painting',async t=>{
  const f=uiFixture(t),route='/api/bot-controls/uia-mode';let finish;f.snapshot.interaction.uiaMode={version:0,enabled:false,canEnable:true};
  f.handlers.set(route,()=>new Promise(done=>{finish=()=>{f.snapshot.interaction.uiaMode={version:1,enabled:true,canEnable:true};f.snapshot.interaction.statusText='完成后的设置';done(f.snapshot.interaction.uiaMode);};}));await f.interaction();
  const mode=f.element('bot-uia-mode');mode.checked=true;f.dispatch('change',mode);assert.equal(f.ui.hasDraft(),true);
  mode.checked=false;f.dispatch('change',mode);assert.equal(f.calls.filter(call=>call.route===route).length,1);
  const replacement=f.replaceElement('bot-interaction-card');f.replaceElement('bot-interaction-help');const reopened=f.ui.mountInteraction();finish();await reopened;await flush();
  assert.equal(f.element('bot-interaction-help').textContent,undefined);assert.match(replacement.innerHTML,/id="bot-uia-mode" checked/);assert.match(replacement.innerHTML,/id="bot-uia-offscreen"/);assert.doesNotMatch(replacement.innerHTML,/id="bot-text-humanized"/);assert.equal(f.ui.hasDraft(),false);
});

test('obsolete independent paste change events cannot write settings',async t=>{
  const f=uiFixture(t);const html=await f.interaction();assert.equal(html.includes('bot-text-paste'),false);
  f.dispatch('change',{id:'bot-text-paste',checked:true,dataset:{}});await flush();
  assert.equal(f.calls.some(call=>(call.route==='/api/bot-controls/interaction'&&call.body!==undefined)),false);
});

test('legacy paste requests keep fast handoff and reject invalid preferences',async t=>{
  const f=service(t);const initial=(await f.controls.snapshot()).interaction;assert.equal(initial.textEntryMode,'paste');
  const old=await f.controls.replaceInteraction({expectedVersion:0,pauseOnHumanActivity:true,textEntryMode:'paste'});assert.equal(old.textEntryMode,'paste');
  const next=await f.controls.replaceInteraction({expectedVersion:1,pauseOnHumanActivity:true,sendMode:'focus-handoff'});assert.equal(next.textEntryMode,'paste');
  await assert.rejects(f.controls.replaceInteraction({expectedVersion:2,pauseOnHumanActivity:true,textEntryMode:'unsafe'}),{status:400});
});

test('OCR humanized preference persists separately from the active UIA text behavior',async t=>{
  const f=service(t),saved=await f.controls.replaceInteraction({expectedVersion:0,pauseOnHumanActivity:true,textEntryMode:'humanized'});
  assert.equal(saved.textEntryMode,'humanized');assert.equal(saved.ocrTextEntryMode,'humanized');assert.match(saved.statusText,/文字正文逐字输入/);
  const uia=new UiaModeStore({root:f.root});fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:2,backend:'uia',version:4,enabled:true}));
  const active=(await f.controls.snapshot()).interaction;assert.equal(active.textEntryMode,'paste');assert.equal(active.ocrTextEntryMode,'humanized');
  await assert.rejects(f.controls.replaceInteraction({expectedVersion:1,pauseOnHumanActivity:true,textEntryMode:'paste'}),{status:409});
  await f.controls.replaceUiaMode({expectedVersion:4,enabled:false});assert.equal((await f.controls.snapshot()).interaction.textEntryMode,'humanized');
});

test('OCR typing switch saves only the preference and resets after conflict',async t=>{
  const f=uiFixture(t),route='/api/bot-controls/interaction';f.snapshot.interaction.ocrTextEntryMode='paste';
  f.handlers.set(route,body=>{assert.deepEqual(body,{expectedVersion:0,pauseOnHumanActivity:true,textEntryMode:'humanized'});return{...f.snapshot.interaction,version:1,textEntryMode:'humanized',ocrTextEntryMode:'humanized'};});
  const html=await f.interaction();assert.match(html,/文字逐字输入/);assert.match(html,/id="bot-text-humanized"\s+aria-labelledby/);
  const toggle=f.element('bot-text-humanized');toggle.checked=true;f.dispatch('change',toggle);await flush();assert.equal(toggle.checked,true);assert.equal(f.ui.hasDraft(),false);
  f.handlers.set(route,()=>{throw Error('版本冲突');});toggle.checked=false;f.dispatch('change',toggle);await flush();assert.equal(toggle.checked,true);assert.match(f.toasts.at(-1),/版本冲突/);
  assert.equal(f.calls.some(call=>call.route==='/api/jobs'||call.route==='/api/bot-controls/uia-mode'),false);
});

test('UIA hides the OCR typing switch without erasing its saved selection',async t=>{
  const f=uiFixture(t);Object.assign(f.snapshot.interaction,{textEntryMode:'paste',ocrTextEntryMode:'humanized',uiaMode:{version:2,enabled:true,canEnable:true}});
  const html=await f.interaction();assert.doesNotMatch(html,/id="bot-text-humanized"/);assert.match(html,/id="bot-uia-offscreen"/);
  const toggle=f.element('bot-text-humanized');toggle.checked=false;f.dispatch('change',toggle);await flush();assert.equal(toggle.checked,true);assert.equal(toggle.disabled,true);assert.equal(f.calls.some(call=>(call.route==='/api/bot-controls/interaction'&&call.body!==undefined)),false);
});

test('shared settings expose only UI behavior and never consult a removed direct-send provider',async t=>{
  let calls=0;const f=service(t,{hookTextStatus:async()=>{calls++;throw Error('obsolete provider');}});
  const ready=await f.controls.replaceInteraction({expectedVersion:0,pauseOnHumanActivity:true,sendMode:'focus-handoff'});
  assert.equal(calls,0);assert.equal(ready.hookTextAvailable,undefined);assert.equal(ready.hookTextStatusText,undefined);assert.match(ready.statusText,/文字和语音均通过微信界面/);assert.doesNotMatch(ready.statusText,/Hook|注入|直发/);
});
test('unsaved voice edits survive page navigation and cannot silently select another profile',async t=>{const f=uiFixture(t);await f.ui.speechPage();f.ui.mountSpeech();f.dispatch('input',{dataset:{voiceField:'promptText'},value:'未保存的参考词'});assert.equal(f.ui.hasDraft(),true);const html=await f.ui.speechPage();assert.match(html,/未保存的参考词/);const select=f.element('bot-voice-select');select.value='other';f.dispatch('change',select);assert.equal(select.value,'dania');assert.match(f.toasts.at(-1),/先保存/);assert.equal(f.calls.filter(call=>call.route.includes('voice/select')).length,0);});
test('automatic reply UI removes the redundant section and ignores obsolete forged controls',async t=>{
  const f=uiFixture(t);f.snapshot.reply={mode:'automatic'};const html=await f.ui.speechPage();f.ui.mountSpeech();
  assert.match(html,/for="bot-voice-select">机器人语音<\/label>/);assert.doesNotMatch(html,/<h2>回复方式<\/h2>|id="bot-reply-(mode|save)"/);
  const selector=f.element('bot-reply-mode');selector.value='voice';f.dispatch('change',selector);f.dispatch('click',f.element('bot-reply-save'));await flush();
  assert.equal(f.ui.hasDraft(),false);assert.equal(f.calls.some(call=>call.route==='/api/bot-controls/reply'),false);
});

test('obsolete corrupt reply preferences do not affect automatic output or connection controls',async t=>{
  const f=service(t),legacy=new ReplyPreferences({root:f.root});fs.mkdirSync(path.dirname(legacy.file),{recursive:true});fs.writeFileSync(legacy.file,'{corrupt legacy');
  assert.deepEqual((await f.controls.snapshot()).reply,{mode:'automatic'});assert.equal(fs.readFileSync(legacy.file,'utf8'),'{corrupt legacy');
  const g=uiFixture(t);g.snapshot.reply={error:'<b>old preferences</b>'};const html=await g.ui.speechPage();assert.match(html,/机器人语音/);assert.doesNotMatch(html,/old preferences|<h2>回复方式<\/h2>|id="bot-reply-save"/);
  assert.doesNotMatch(html,/bot-voice-select.*bot-uia-mode/s);
});

test('offline catch-up is automatic and checking progress cannot reset the read cursor',async t=>{
  const f=uiFixture(t),route='/api/ui-reader-recovery';
  f.handlers.set(route,()=>({canRecover:false,gapDetected:true,backfillActive:true,backfillProgress:{completedChats:1,totalChats:3},message:'<script>fixture</script>'}));
  const html=await f.ui.maintenancePage();f.ui.mountMaintenance();
  assert.match(html,/读取记录修复/);assert.doesNotMatch(html,/补读离线消息<\/h2>/);assert.doesNotMatch(html,/重建读取位置/);
  assert.doesNotMatch(html,/电源按钮即可启动或停止机器人/);
  f.dispatch('click',f.element('bot-recovery-check'));await flush();
  const status=f.element('bot-recovery-state').innerHTML;
  assert.match(status,/&lt;script&gt;/);assert.match(status,/1 \/ 3 个聊天/);assert.doesNotMatch(status,/bot-recovery-apply/);
  f.element('bot-recovery-ack').checked=true;f.dispatch('click',f.element('bot-recovery-apply'));await flush();
  assert.equal(f.calls.some(call=>call.route===route&&call.body!==undefined),false);
});
test('unavailable recovery never sends a recovery mutation even when a checkbox is forged',async t=>{
  const f=uiFixture(t),route='/api/ui-reader-recovery';f.handlers.set(route,()=>({canRecover:false,message:'请先停止服务'}));await f.ui.maintenancePage();f.ui.mountMaintenance();f.dispatch('click',f.element('bot-recovery-check'));await flush();
  assert.equal(f.element('bot-recovery-state').innerHTML.includes('bot-recovery-apply'),false);f.element('bot-recovery-ack').checked=true;f.dispatch('click',f.element('bot-recovery-apply'));await flush();assert.equal(f.calls.filter(call=>call.route===route&&call.body!==undefined).length,0);
});
test('recovery version conflict retains the pending action and requires a fresh preview before a changed revision is used',async t=>{
  const f=uiFixture(t),route='/api/ui-reader-recovery';let revision=hex('a'),reject=true;f.handlers.set(route,body=>{if(body===undefined)return{incompleteRecovery:true,canRecover:true,revision,pendingCount:1,message:'需要恢复'};if(reject)throw Object.assign(new Error('恢复记录已变化，请重新载入后确认。'),{status:409});return{interruptedRecoveryRestored:true,needsRecovery:true};});
  await f.ui.maintenancePage();f.ui.mountMaintenance();f.dispatch('click',f.element('bot-recovery-check'));await flush();f.element('bot-recovery-ack').checked=true;f.dispatch('click',f.element('bot-recovery-apply'));await flush();assert.match(f.toasts.at(-1),/记录已变化/);assert.equal(f.calls.filter(call=>call.route===route&&call.body!==undefined).length,1);assert.equal(f.ui.hasDraft(),false);
  revision=hex('b');reject=false;f.dispatch('click',f.element('bot-recovery-check'));await flush();f.element('bot-recovery-ack').checked=true;f.dispatch('click',f.element('bot-recovery-apply'));await flush();
  assert.deepEqual(f.calls.filter(call=>call.route===route&&call.body!==undefined).map(call=>call.body),[{expectedRevision:hex('a'),acknowledgeRollback:true},{expectedRevision:hex('b'),acknowledgeRollback:true}]);assert.match(f.element('bot-recovery-state').textContent,/中断前的记录.*重新检查/);
});
test('a recovery preview arriving after navigation cannot paint the replacement page or submit recovery',async t=>{
  const f=uiFixture(t),route='/api/ui-reader-recovery';let resolve;f.handlers.set(route,()=>new Promise(done=>{resolve=done;}));await f.ui.maintenancePage();f.ui.mountMaintenance();f.dispatch('click',f.element('bot-recovery-check'));assert.equal(f.ui.hasDraft(),true);
  const replacement=f.replaceElement('bot-maintenance-controls');f.replaceElement('bot-recovery-state');resolve({canRecover:true,revision:hex('a'),message:'stale response',pendingCount:9});await flush();
  assert.equal(f.element('bot-recovery-state').innerHTML,undefined);assert.equal(replacement.outerHTML,undefined);assert.equal(f.ui.hasDraft(),false);assert.equal(f.calls.filter(call=>call.route===route&&call.body!==undefined).length,0);
});

test('overview shows each foreground span in maintenance without a second status request',async t=>{
  const f=uiFixture(t);
  const panel=f.ui.foregroundTimingPlaceholder();
  assert.match(panel,/<h3[^>]*>最近一次连续前台占用<\/h3>/);
  assert.doesNotMatch(panel,/<details|<summary/);
  assert.doesNotMatch(await f.interaction(),/最近一次连续前台占用|查看占用详情/);
  const records=f.element('bot-foreground-timing-records');
  assert.match(records.innerHTML,/暂无前台占用记录/);
  assert.deepEqual(f.calls.map(c=>c.route),['/api/bot-controls/interaction']);

  f.snapshot.interaction.foregroundTiming={available:true,measurements:[{operation:'voice',complete:true,includesContactNavigation:true,maxContinuousForegroundMs:9800,intervals:[{phase:'contact-navigation',durationMs:9800,complete:true},{phase:'record-start',durationMs:2300,complete:true},{phase:'record-submit',durationMs:390,complete:true}]}]};
  await f.ui.mountInteraction();
  assert.match(records.innerHTML,/最长一次 9\.800 秒/);
  assert.match(records.innerHTML,/切换联系人 · 9\.800 秒/);
  assert.match(records.innerHTML,/发送语音 · 0\.390 秒/);
  assert.match(records.innerHTML,/含联系人切换/);
  assert.doesNotMatch(records.innerHTML,/12\.490 秒|<details/);
});

test('late overview timing reads never repaint a replacement panel',async t=>{
  const f=uiFixture(t);
  let rejectOld;
  f.handlers.set('GET /api/bot-controls/interaction',()=>new Promise((_,reject)=>{rejectOld=reject;}));
  const old=f.ui.mountInteraction();await flush();
  f.replaceElement('bot-interaction-card');
  const records=f.replaceElement('bot-foreground-timing-records');
  f.handlers.delete('GET /api/bot-controls/interaction');
  await f.ui.mountInteraction();
  const displayed=records.innerHTML;
  rejectOld(new Error('旧状态请求失败'));await old;
  assert.match(displayed,/暂无前台占用记录/);
  assert.equal(records.innerHTML,displayed);
});

test('preparation recovery requires a current stopped-state preview and explicit review, without enabling or starting services',async t=>{
  const f=uiFixture(t),route='/api/ui-runtime-controls/recover-preparation';
  let current={revision:hex('b'),enabled:false,canEnable:false,blockers:[],voice:{configured:true},preparationRecovery:{required:true,canRecover:true,revision:3,reason:'QT_BINDING_CHANGED'}};
  f.handlers.set('/api/ui-runtime-controls',()=>current);
  f.handlers.set(route,()=>({...current,revision:hex('c'),preparationRecovery:{required:false,canRecover:false},recovered:true,servicesStarted:false,inputSent:false}));
  await f.ui.maintenancePage();f.ui.mountMaintenance();f.element('bot-preparation-recovery-ack').checked=false;
  f.dispatch('click',f.element('bot-preparation-recover'));await flush();assert.equal(f.calls.some(call=>call.route===route),false);
  f.dispatch('click',f.element('bot-runtime-check'));await flush();assert.match(f.element('bot-runtime-card').outerHTML,/重启服务不会自动解除/);
  f.element('bot-preparation-recovery-ack').checked=false;f.dispatch('click',f.element('bot-preparation-recover'));await flush();assert.equal(f.calls.some(call=>call.route===route),false);
  f.element('bot-preparation-recovery-ack').checked=true;f.dispatch('click',f.element('bot-preparation-recover'));await flush();
  assert.deepEqual(f.calls.find(call=>call.route===route),{route,body:{expectedRevision:hex('b'),acknowledgeReview:true}});
  assert.match(f.toasts.at(-1),/服务尚未启动/);assert.equal(f.calls.some(call=>call.route==='/api/jobs'),false);
  assert.equal(f.calls.filter(call=>call.route==='/api/ui-runtime-controls'&&call.body!==undefined).length,0);
  f.dispatch('click',f.element('bot-preparation-recover'));await flush();assert.equal(f.calls.filter(call=>call.route===route).length,1);
  current={...current,preparationRecovery:{required:true,canRecover:false}};
  f.dispatch('click',f.element('bot-runtime-check'));await flush();f.element('bot-preparation-recovery-ack').checked=true;
  f.dispatch('click',f.element('bot-preparation-recover'));await flush();assert.equal(f.calls.filter(call=>call.route===route).length,1);
});

test('voice operator recovery requires its own preview and both acknowledgements, without submitting permission or starting a job',async t=>{
  const f=uiFixture(t),inspect='/api/ui-runtime-controls/voice-recovery',recover='/api/ui-runtime-controls/recover-voice';
  let current={available:true,required:true,canRecover:true,revision:hex('a')};
  f.handlers.set(inspect,()=>current);f.handlers.set('/api/ui-runtime-controls',()=>({revision:hex('b'),enabled:false,canEnable:true,blockers:[],voice:{configured:true}}));
  f.handlers.set(recover,()=>{current={available:true,required:false,canRecover:false,revision:hex('c')};return{recovered:true,deliveryConfirmed:false,servicesStarted:false,inputSent:false};});
  await f.ui.maintenancePage();f.ui.mountMaintenance();f.element('bot-voice-recovery-ended').checked=true;f.element('bot-voice-recovery-outcome').checked=true;
  f.dispatch('click',f.element('bot-voice-recover'));await flush();assert.equal(f.calls.some(c=>c.route===recover),false);
  f.dispatch('click',f.element('bot-voice-recovery-check'));await flush();assert.match(f.element('bot-runtime-card').outerHTML,/不会确认消息已发送/);
  for(const missing of ['bot-voice-recovery-ended','bot-voice-recovery-outcome']){f.element(missing).checked=false;f.dispatch('click',f.element('bot-voice-recover'));await flush();assert.equal(f.calls.some(c=>c.route===recover),false);f.element(missing).checked=true;}
  f.dispatch('click',f.element('bot-voice-recover'));await flush();assert.deepEqual(f.calls.find(c=>c.route===recover),{route:recover,body:{expectedRevision:hex('a'),acknowledgeRecordingEnded:true,acknowledgeMessageOutcomeReviewed:true}});
  assert.match(f.toasts.at(-1),/原语音不会重发/);assert.equal(f.calls.some(c=>c.route==='/api/jobs'||c.route==='/api/ui-runtime-controls'&&c.body!==undefined),false);
  f.dispatch('click',f.element('bot-voice-recover'));await flush();assert.equal(f.calls.filter(c=>c.route===recover).length,1);
});

test('unavailable voice recovery never offers recovery input',async t=>{
  const f=uiFixture(t);f.handlers.set('/api/ui-runtime-controls/voice-recovery',()=>({available:false,canRecover:false,reason:'VOICE_RECOVERY_STOP_SERVICES'}));
  await f.ui.maintenancePage();f.ui.mountMaintenance();f.dispatch('click',f.element('bot-voice-recovery-check'));await flush();const markup=f.element('bot-runtime-card').outerHTML;assert.match(markup,/请先停止机器人/);assert.doesNotMatch(markup,/id="bot-voice-recovery-ended"/);
  f.element('bot-voice-recovery-ended').checked=true;f.element('bot-voice-recovery-outcome').checked=true;f.dispatch('click',f.element('bot-voice-recover'));await flush();assert.equal(f.calls.some(c=>c.route==='/api/ui-runtime-controls/recover-voice'),false);
});
