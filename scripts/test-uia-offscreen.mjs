import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {UiaOffscreenClient,createUiaOffscreenManager,recoverUiaOffscreenWindow,consumeOffscreenNoMoveRefusal,applyStoppedOffscreen,uiSettingsServiceRunning} from './uia-offscreen.mjs';
const r=(left,top,right,bottom)=>({left,top,right,bottom});
test('offline settings hold the service reservation through persistence and roll back a parked window if saving fails',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-offline-config-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const directory of ['state/ui-host','state/ui-runtime'])fs.mkdirSync(path.join(root,directory),{recursive:true});
  fs.writeFileSync(path.join(root,'state/ui-runtime/qt-visual.json'),'{}');
  for(const name of ['WechatQtActions','WechatUiaOffscreenHost'])fs.writeFileSync(path.join(root,'state/ui-host',name+'.exe'),'fixture');
  const events=[];
  const manager={setEnabled:async()=>{events.push('park');return {parked:true};},
    handoffOffline:async()=>events.push('journal'),close:async()=>events.push('close')};
  const options={root,enabled:true,validate:()=>{assert.equal(uiSettingsServiceRunning(root),true);events.push('checked');},
    createManager:()=>manager,recover:async()=>events.push('restore')};
  await assert.rejects(applyStoppedOffscreen({...options,apply:()=>{events.push('write');throw Error('disk full');}}),/disk full/);
  assert.deepEqual(events,['checked','park','journal','write','close','restore']);
  assert.equal(uiSettingsServiceRunning(root),false);
  events.length=0;
  await assert.rejects(applyStoppedOffscreen({...options,validate:()=>{throw Error('stale revision');},apply:()=>assert.fail()}),/stale revision/);
  assert.deepEqual(events,[]);
});
const bound={hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',dpi:96,clientRect:r(0,0,800,600),captureRect:r(0,0,800,600)};
function report(action,state='visible',extra={}){return{version:1,action,state,parked:state==='parked',restored:state==='restored',released:state!=='parked',parkEligible:state==='visible',windowMoved:action==='park',inputSent:false,clipboardAccessed:false,foregroundChanged:false,reason:null,binding:bound,journalPath:null,...extra};}
function fixture(t,{ready=true,respond=true,exitOnEnd=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uia-offscreen-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state={packets:[],children:[],respond,exitOnEnd};
  const spawnImpl=(executable,args,options)=>{
    assert.equal(path.basename(executable),'WechatUiaOffscreenHost.exe');assert.deepEqual(args,['--host','--root',root,'--parent-pid',String(process.pid)]);assert.equal(options.windowsHide,true);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=0;child.exit=(code=0)=>{if(child.exited)return;child.exited=true;child.emit('close',code,null);};child.reply=packet=>child.stdout.write(JSON.stringify(packet)+'\n');
    child.stdin=new Writable({write(chunk,_encoding,callback){const packet=JSON.parse(chunk.toString());state.packets.push(packet);queueMicrotask(()=>{if(typeof state.respond==='function')state.respond(packet,child);else if(state.respond)child.reply({id:packet.id,ok:true,result:report(packet.action,packet.action==='park'?'parked':packet.action==='stop'?'restored':'visible')});});callback();},final(callback){child.ended=true;callback();if(state.exitOnEnd)queueMicrotask(()=>child.exit());}});
    child.kill=()=>{child.kills++;assert.fail('stateful offscreen worker must not be killed');};state.children.push(child);if(ready)queueMicrotask(()=>child.reply({version:1,ready:true,backend:'uia-offscreen',inputSent:false,clipboardAccessed:false}));return child;
  };
  const client=new UiaOffscreenClient({root,spawnImpl,startTimeoutMs:30,requestTimeoutMs:30,closeTimeoutMs:30});t.after(()=>client.close().catch(()=>{}));return{root,state,client};
}
test('offscreen host starts without moving, reuses one process and acknowledges restoration before close',async t=>{
  const f=fixture(t);await f.client.start();assert.equal(f.state.packets.length,0);assert.equal((await f.client.request('inspect',{binding:bound})).parked,false);assert.equal((await f.client.request('park',{binding:bound})).parked,true);const result=await f.client.close();assert.equal(result.released,true);assert.equal(result.state.restored,true);assert.equal(f.state.children.length,1);assert.deepEqual(f.state.packets.map(v=>v.action),['inspect','park','stop']);assert.equal(f.state.children[0].kills,0);
});
for(const phase of ['startup','request'])test(`${phase} timeout closes stdin for native recovery without terminating the moving worker`,async t=>{
  const f=fixture(t,{ready:phase!=='startup',respond:false});await assert.rejects(phase==='startup'?f.client.start():f.client.request('park',{binding:bound}),{code:'UIA_OFFSCREEN_TIMEOUT'});assert.equal((await f.client.close()).processStopped,true);assert.equal(f.state.children[0].ended,true);assert.equal(f.state.children[0].kills,0);
});
test('failed restoration or absent process exit cannot become a successful cleanup',async t=>{
  const f=fixture(t,{exitOnEnd:false});await f.client.start();await assert.rejects(f.client.close(),{code:'UIA_OFFSCREEN_CLEANUP_UNCONFIRMED'});assert.equal(f.state.children[0].kills,0);f.state.children[0].exit();
});
test('foreground changes and mismatched replies fail closed without leaking or replaying input',async t=>{
  const f=fixture(t);f.state.respond=(packet,child)=>child.reply({id:packet.id,ok:true,result:report(packet.action,'parked',{foregroundChanged:true})});await assert.rejects(f.client.request('park',{binding:bound}),{code:'UIA_OFFSCREEN_PROTOCOL_INVALID'});await f.client.close();assert.equal(f.state.packets.length,1);assert.equal(f.state.children[0].kills,0);
});
test('an existing offscreen owner refuses startup with its bounded native code and no input commands',async t=>{
  const f=fixture(t,{ready:false});const operation=f.client.start(),rejected=assert.rejects(operation,{code:'OFFSCREEN_HOST_ALREADY_RUNNING'});f.state.children[0].reply({id:null,ok:false,error:{code:'OFFSCREEN_HOST_ALREADY_RUNNING'}});await rejected;assert.deepEqual(f.state.packets,[]);assert.equal(f.state.children[0].kills,0);
});
test('abort or close while a request is pending lets EOF cleanup finish and never repeats park',async t=>{
  for(const abort of [true,false]){const f=fixture(t,{respond:false}),controller=new AbortController();const pending=f.client.request('park',{binding:bound},{signal:controller.signal});const rejected=assert.rejects(pending,{code:abort?'UIA_MODE_ABORTED':'UIA_OFFSCREEN_CLOSED'});await new Promise(resolve=>setImmediate(resolve));if(abort)controller.abort();await f.client.close();await rejected;assert.equal(f.state.packets.length,1);assert.equal(f.state.children[0].kills,0);}
});
function config(){return{version:1,backend:'qt-visual',account:'wxid_fixture',accountRef:'a'.repeat(64),accountAlias:'fixture',executable:path.resolve('Weixin.exe'),executableVersion:'4.1.15.56',executableSha256:'b'.repeat(64),hwnd:'auto',idleMs:1000,ocrBackend:'rapidocr',layout:{width:800,height:600,dpi:96,header:r(300,10,600,40),search:r(60,10,250,50),firstResult:r(60,80,250,120),profileOpen:r(700,10,760,50),profileAlias:r(300,80,600,120),selfOpen:r(10,20,40,60),selfAlias:r(50,80,290,120),editor:r(300,450,780,540),send:r(700,550,780,590),emptyEditorSha256:'c'.repeat(64)},selfCloseKey:'Escape',profileCloseKey:'Escape'};}
function managerFixture(){const base=config(),events=[],state={next:'visible',eligible:true,inspections:0};const manager=createUiaOffscreenManager({root:path.resolve('.'),createInspector:options=>{assert.equal(options.enableInput,false);return{request:async()=>{state.inspections++;events.push('inspect-layout');return{version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:base.executableVersion,executableSha256:state.badHash?'c'.repeat(64):base.executableSha256,binding:bound};},close:async()=>{events.push('inspector-close');}};},createHost:()=>({request:async action=>{events.push(action);if(action==='park')state.next='parked';return report(action,state.next,{parkEligible:state.eligible,...(state.badProcess?{binding:{...bound,pid:43}}:{})});},close:async()=>{events.push('host-close');return{processStopped:true,released:true,state:report('stop','restored')};}})});return{manager,base,events,state,prepare:()=>manager.prepareWindow({config:base,releaseInput:async()=>events.push('release-input')})};}
test('park releases idle input helper first; subsequent sends retain it while offscreen',async()=>{
  const f=managerFixture();await f.prepare();assert.deepEqual(f.events,['inspect-layout','inspect','release-input','park']);f.events.length=0;await f.prepare();assert.deepEqual(f.events,['inspect-layout','inspect']);assert.equal(f.manager.getState().parked,true);assert.equal((await f.manager.close()).state.restored,true);
});
test('user foreground/activity deferral and manual recall do not close or repark the input helper',async()=>{
  const f=managerFixture();f.state.eligible=false;await f.prepare();assert.deepEqual(f.events,['inspect-layout','inspect']);f.events.length=0;f.state.next='ownership-lost';f.state.eligible=true;await f.prepare();assert.deepEqual(f.events,['inspect-layout','inspect']);f.events.length=0;await f.prepare();assert.deepEqual(f.events,[]);await f.manager.close();
});
test('a changed executable or process report never authorizes a move',async()=>{
  for(const kind of ['badHash','badProcess']){const f=managerFixture();f.state[kind]=true;await assert.rejects(f.prepare(),{code:'UIA_OFFSCREEN_BINDING_CHANGED'});assert.equal(f.events.includes('release-input'),false);assert.equal(f.events.includes('park'),false);await f.manager.close();}
  const g=managerFixture();const controller=new AbortController();controller.abort();await assert.rejects(g.manager.prepareWindow({config:g.base,signal:controller.signal,releaseInput:async()=>assert.fail()}),{code:'UIA_MODE_ABORTED'});assert.deepEqual(g.events,[]);await g.manager.close();
});
test('restart recovery releases the input mutex before restoring an old lease and obtains new geometry before parking',async()=>{
  const base=config(),events=[],responses=[report('inspect','deferred',{released:false,parkEligible:false,reason:'OFFSCREEN_RECOVERY_REQUIRED'}),report('restore','restored',{binding:{...bound,pid:41,processCreatedFileTimeUtc:'11111'}}),report('inspect','visible'),report('park','parked')];
  const manager=createUiaOffscreenManager({root:path.resolve('.'),createInspector:()=>({request:async()=>({version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:base.executableVersion,executableSha256:base.executableSha256,binding:bound}),close:async()=>{}}),createHost:()=>({request:async action=>{events.push(action);const next=responses.shift();assert.equal(next.action,action);return next;},close:async()=>({processStopped:true,released:true})})});
  await manager.prepareWindow({config:base,releaseInput:async()=>events.push('release-input')});assert.deepEqual(events,['inspect','release-input','restore','inspect','park']);assert.equal(responses.length,0);assert.equal(manager.getState().parked,true);await manager.close();
});
test('unconfirmed recovery never parks a replacement window',async()=>{
  const base=config(),events=[];const manager=createUiaOffscreenManager({root:path.resolve('.'),createInspector:()=>({request:async()=>({version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:base.executableVersion,executableSha256:base.executableSha256,binding:bound}),close:async()=>{}}),createHost:()=>({request:async action=>{events.push(action);return report(action,'deferred',{released:false,parkEligible:false,reason:'OFFSCREEN_RECOVERY_REQUIRED'});},close:async()=>({processStopped:true,released:true})})});
  await assert.rejects(manager.prepareWindow({config:base,releaseInput:async()=>events.push('release-input')}),{code:'UIA_OFFSCREEN_CLEANUP_UNCONFIRMED'});assert.deepEqual(events,['inspect','release-input','restore']);await manager.close();
});
test('startup recovery spawns nothing for absent or terminal journals and restores a torn unfinished lease exactly once',async t=>{
  const f=fixture(t),journal=path.join(f.root,'state/ui-offscreen/active.jsonl'),events=[];let result=report('restore','restored');
  const recover=()=>recoverUiaOffscreenWindow({root:f.root,createClient:()=>({request:async(action,values)=>{events.push(action);assert.deepEqual(values,{});return result;},close:async()=>{events.push('close');return{processStopped:true,released:true};}})});
  assert.deepEqual(await recover(),{needed:false,recovered:false});assert.deepEqual(events,[]);fs.mkdirSync(path.dirname(journal),{recursive:true});
  const initial=JSON.stringify({version:1,kind:'uia-offscreen-host-v1',phase:'prepared'})+'\n';
  for(const phase of ['restored','ownership-lost']){fs.writeFileSync(journal,initial+JSON.stringify({phase})+'\n');assert.equal((await recover()).needed,false);assert.deepEqual(events,[]);}
  fs.writeFileSync(journal,initial+JSON.stringify({phase:'moved'})+'\n{"phase":"restor');assert.equal((await recover()).recovered,true);assert.deepEqual(events,['restore','close']);
  events.length=0;result=report('restore','deferred',{released:false});await assert.rejects(recover(),{code:'UIA_OFFSCREEN_CLEANUP_UNCONFIRMED'});assert.deepEqual(events,['restore','close']);
});
test('explicit toggle immediately parks even when automatic eligibility is false and restores without moving again',async()=>{
  const f=managerFixture();f.state.eligible=false;f.state.next='parked';
  const result=await f.manager.setEnabled({enabled:true,config:f.base});assert.equal(result.parked,true);assert.deepEqual(f.events,['inspect-layout','park-explicit']);
  f.events.length=0;f.state.next='restored';assert.equal((await f.manager.setEnabled({enabled:false})).restored,true);assert.deepEqual(f.events,['restore']);await f.manager.close();
});
test('an explicit toggle accepts a manually offscreen window without claiming its placement',async()=>{
  const base=config(),events=[];
  const manager=createUiaOffscreenManager({root:path.resolve('.'),createInspector:()=>({request:async()=>({version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:base.executableVersion,executableSha256:base.executableSha256,binding:bound}),close:async()=>{}}),createHost:()=>({request:async action=>{events.push(action);return action==='park-explicit'?report(action,'deferred',{reason:'OFFSCREEN_ALREADY_OUTSIDE',parkEligible:false,windowMoved:false}):report(action,'restored',{windowMoved:false});},close:async()=>({processStopped:true,released:true})})});
  const on=await manager.setEnabled({enabled:true,config:base});assert.equal(on.reason,'OFFSCREEN_ALREADY_OUTSIDE');assert.equal(on.parked,false);assert.equal(on.released,true);
  const off=await manager.setEnabled({enabled:false});assert.equal(off.windowMoved,false);assert.deepEqual(events,['park-explicit','restore']);await manager.close();
});
test('only an exact unchanged no-move refusal grants one-use restart evidence',async()=>{
  for(const change of [null,v=>v.windowMoved=true,v=>v.released=false,v=>v.inputSent=true,v=>v.foregroundChanged=true,v=>v.binding={...bound,dpi:120},v=>v.binding={...bound,captureRect:r(1,0,801,600)},v=>v.reason='OFFSCREEN_MOVE_FAILED']){
    const base=config(),refusal=report('park-explicit','deferred',{reason:'OFFSCREEN_KEYS_HELD',windowMoved:false,parkEligible:false});change?.(refusal);
    const manager=createUiaOffscreenManager({root:path.resolve('.'),createInspector:()=>({request:async()=>({version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:base.executableVersion,executableSha256:base.executableSha256,binding:bound}),close:async()=>{}}),createHost:()=>({request:async()=>refusal,close:async()=>({processStopped:true,released:true})})});
    let error;try{await manager.setEnabled({enabled:true,config:base});assert.fail('refusal required');}catch(value){error=value;}
    assert.equal(consumeOffscreenNoMoveRefusal(error),change===null);assert.equal(consumeOffscreenNoMoveRefusal(error),false);await manager.close();
  }
  assert.equal(consumeOffscreenNoMoveRefusal(Object.assign(Error(),{code:'OFFSCREEN_KEYS_HELD',windowMoved:false,inputSent:false,released:true})),false);
});
