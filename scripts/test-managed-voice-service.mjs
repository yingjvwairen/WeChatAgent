import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManagedVoiceService } from './managed-voice-service.mjs';
import { voiceServiceFiles } from './dania-server.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const request={id:'other',expectedVersion:1};
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-managed-voice-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const events=[];let up=false,applied=false;
  const handle={alive:true,stop:async()=>{events.push('stop');handle.alive=false;}};
  const options={root,loadConfig:()=>{events.push('config');return{baseUrl:'http://127.0.0.1:9880'};},probe:async()=>({available:up,compatible:true}),
    start:async options=>{assert.equal(options.applySelectedAtStart,false);events.push('start');up=true;return handle;},
    createProfiles:()=>({snapshot:async()=>({version:1,applied,profiles:[{id:'other'}]}),
      select:async ({id})=>{assert.equal(id,'other');applied=true;events.push('profile');return{applied:true,selectedId:id};}}),
    createClient:()=>({synthesize:async()=>{if(!applied)throw Object.assign(Error(),{code:'VOICE_MODEL_NOT_APPLIED'});events.push('synthesize');return{fixture:true};}}),timeoutMs:20,pollMs:1};
  return{root,events,handle,options,setUp:value=>up=value};
}
test('construction and text-only shutdown need no model configuration or child',async t=>{
  const f=fixture(t),service=createManagedVoiceService(f.options);assert.deepEqual(f.events,[]);
  await service.close();assert.deepEqual(f.events,[]);await assert.rejects(service.ensureReady(),{code:'VOICE_SERVICE_ABORTED'});
});
test('local startup and weight changes require an explicit profile selection',async t=>{
  const f=fixture(t),service=createManagedVoiceService(f.options);
  await assert.rejects(service.ensureReady(),{code:'VOICE_SERVICE_PROFILE_NOT_APPLIED'});
  await assert.rejects(service.synthesize('text'),{code:'VOICE_MODEL_NOT_APPLIED'});
  assert.deepEqual(f.events,[]);
  await service.useProfile(request);await service.ensureReady();await service.synthesize('synthetic fixture');
  assert.equal(f.events.filter(x=>x==='start').length,1);assert.deepEqual(f.events.slice(-2),['profile','synthesize']);
  await Promise.all([service.close(),service.close()]);assert.equal(f.events.filter(x=>x==='stop').length,1);
});
test('two explicit requests share startup; an existing endpoint is never stopped',async t=>{
  const f=fixture(t),service=createManagedVoiceService(f.options);
  await Promise.all([service.useProfile(request),service.useProfile(request)]);
  assert.equal(f.events.filter(x=>x==='start').length,1);
  const borrower=createManagedVoiceService(f.options);await borrower.useProfile(request);await borrower.close();
  assert(!f.events.includes('stop'));await service.close();
});
test('invalid or stale selections and incompatible services cannot start a child',async t=>{
  const f=fixture(t),service=createManagedVoiceService({...f.options,probe:async()=>({available:true,compatible:false})});
  await assert.rejects(service.useProfile({...request,expectedVersion:9}),{code:'VOICE_PROFILE_VERSION_CONFLICT'});
  await assert.rejects(service.useProfile({...request,id:'missing'}),{code:'VOICE_PROFILE_NOT_FOUND'});
  await assert.rejects(service.useProfile(request),{code:'VOICE_SERVICE_INCOMPATIBLE'});
  await service.close();assert(!f.events.includes('start'));
});
test('failed startup can be retried only by explicit selection',async t=>{
  const f=fixture(t);let attempts=0;
  const service=createManagedVoiceService({...f.options,start:async options=>{if(++attempts===1)throw Object.assign(Error(),{code:'VOICE_SERVICE_START_FAILED'});return f.options.start(options);}});
  await assert.rejects(service.useProfile(request),{code:'VOICE_SERVICE_START_FAILED'});
  await assert.rejects(service.synthesize('synthetic fixture'),{code:'VOICE_MODEL_NOT_APPLIED'});
  assert.equal(attempts,1);await service.useProfile(request);assert.equal(attempts,2);await service.close();
});
test('close requests synthesis cancellation but waits for its cleanup before stopping owned model',async t=>{
  const f=fixture(t);let finish;
  const service=createManagedVoiceService({...f.options,createClient:()=>({synthesize:async(_text,{signal})=>{
    f.events.push('synthesis-start');await new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>f.events.push('synthesis-cancel'),{once:true});});f.events.push('synthesis-drained');
  }})});
  await service.useProfile(request);const work=service.synthesize('synthetic fixture');await tick();const closing=service.close();await tick();
  assert(f.events.includes('synthesis-cancel'));assert.equal(f.events.includes('stop'),false);finish();await work;await closing;
  assert(f.events.indexOf('stop')>f.events.indexOf('synthesis-drained'));
});
test('racing launcher is waited for without deleting its lease or claiming ownership',async t=>{
  const f=fixture(t),files=voiceServiceFiles(f.root);fs.mkdirSync(files.directory,{recursive:true});fs.writeFileSync(files.lock,JSON.stringify({serviceEpoch:'other'}));
  let probes=0;
  const service=createManagedVoiceService({...f.options,start:async()=>{throw Object.assign(Error(),{code:'VOICE_SERVICE_BUSY'});},probe:async()=>{
    if(++probes<3)return{available:false};fs.writeFileSync(files.state,JSON.stringify({status:'ready',serviceEpoch:'other'}));return{available:true,compatible:true,serviceEpoch:'other'};
  }});
  assert.equal((await service.useProfile(request)).applied,true);await service.close();assert.equal(fs.existsSync(files.lock),true);assert.equal(f.events.includes('stop'),false);
});
test('unconfirmed startup cleanup remains visible when the robot closes',async t=>{
  const f=fixture(t);let reject;
  const service=createManagedVoiceService({...f.options,start:({signal})=>new Promise((_resolve,r)=>{reject=r;signal.addEventListener('abort',()=>r(Object.assign(Error(),{code:'VOICE_SERVICE_CLEANUP_UNCONFIRMED'})),{once:true});})});
  const work=service.useProfile(request);await tick();assert.equal(typeof reject,'function');const closing=service.close();
  await assert.rejects(work);await assert.rejects(closing,{code:'VOICE_SERVICE_CLEANUP_UNCONFIRMED'});
});
