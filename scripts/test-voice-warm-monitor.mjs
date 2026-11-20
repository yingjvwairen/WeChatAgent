import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {warmVoiceMonitor,isVoiceWarmMonitor} from './voice-warm-monitor.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{reply=true,mutateReady,autoClose=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-warm-test-'));
  fs.mkdirSync(path.join(root,'state/ui-host'),{recursive:true});fs.writeFileSync(path.join(root,'state/ui-host/WechatVoicePreview.exe'),'fixture');
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^voice-warm-test-/);fs.rmSync(root,{recursive:true});});
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  let buffer='',init,stopped=false,kills=0;const requests=[];
  const finish=(code=0,signal=null)=>{if(stopped)return;stopped=true;child.emit('close',code,signal);};
  child.kill=()=>{kills++;if(autoClose)finish(null,'SIGTERM');};
  child.stdin.on('data',chunk=>{buffer+=chunk.toString();for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line==='cancel'){requests.push('cancel');continue;}
    const request=JSON.parse(line);requests.push(request);
    if(request.action==='warmVoiceMonitor'){
      init=request;const response={ok:true,phase:'ready',protocol:'voice-warm-v1',nonce:request.nonce,monitorId:'b'.repeat(32),readOnly:true,inputSent:false,mutexHeld:false,maximumWarmupMs:60000};mutateReady?.(response);
      if(reply)queueMicrotask(()=>child.stdout.write(JSON.stringify(response)+'\n'));
    }
  }});
  child.stdin.on('finish',()=>{if(autoClose)queueMicrotask(()=>finish(0));});
  return {root,child,requests,finish,kills:()=>kills,nonce:()=>init?.nonce,send:packet=>child.stdout.write(JSON.stringify(packet)+'\n'),
    spawnImpl(executable,args,options){assert.equal(executable,path.join(root,'state/ui-host/WechatVoicePreview.exe'));assert.deepEqual(args,['--private-warm']);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);return child;}};
}
const request=()=>({action:'timedVoicePreview',focusHandoff:{version:1,returnWindow:{hwnd:'20',pid:3,processCreatedFileTimeUtc:'45'}},waveFile:'fixture.wav'});
const rejection=f=>({ok:false,phase:'rejected',protocol:'voice-warm-v1',nonce:f.nonce(),monitorId:'b'.repeat(32),reason:'DRAFT_UI_MUTEX_BUSY',executionStarted:false,inputSent:false,recordingStarted:false,focusOwnershipTransferred:false});

test('warming sends only a nonce-bound read-only handshake; handle exposes no capability and is root-bound',async t=>{
  const f=fixture(t),warm=await warmVoiceMonitor(f);
  assert.equal(f.requests.length,1);assert.deepEqual(Object.keys(f.requests[0]).sort(),['action','nonce','version']);assert.equal(f.requests[0].action,'warmVoiceMonitor');
  assert.equal(isVoiceWarmMonitor(warm,f.root),true);assert.equal(isVoiceWarmMonitor({...warm},f.root),false);assert.equal(isVoiceWarmMonitor(warm,path.dirname(f.root)),false);
  assert.equal(JSON.stringify(warm).includes(f.nonce()),false);assert.equal(JSON.stringify(warm).includes('b'.repeat(32)),false);
  assert.deepEqual(await warm.close(),{processStopped:true,executionCommitted:false});assert.equal(f.requests.length,1);
});

test('exact ready binding refuses altered nonce, flags, shape and monitor identity without commit',async t=>{
  for(const mutateReady of [v=>{v.nonce='c'.repeat(64);},v=>{v.readOnly=false;},v=>{v.inputSent=true;},v=>{v.mutexHeld=true;},v=>{v.extra=true;},v=>{v.monitorId='short';}]){
    const f=fixture(t,{mutateReady});await assert.rejects(warmVoiceMonitor(f),{code:'VOICE_WARMUP_PROTOCOL_INVALID',nativeStarted:false,recordingPossible:false,submitAttempted:false});assert.equal(f.requests.length,1);
  }
});

test('execution commits once with exact binding and does not resolve on output before process exit',async t=>{
  const f=fixture(t),warm=await warmVoiceMonitor(f);let committed=0,resolved=false;
  const run=warm.execute(request(),{onCommit:()=>{committed++;}}).then(result=>{resolved=true;return result;});
  assert.equal(committed,1);assert.deepEqual(f.requests[1],{action:'executeWarmVoice',version:1,nonce:f.nonce(),monitorId:'b'.repeat(32),mode:'private-once',request:request()});
  await assert.rejects(warm.execute(request()),{code:'VOICE_WARMUP_NOT_READY'});
  f.send({ok:true,fixture:true});await tick();assert.equal(resolved,false);f.finish(0);
  assert.deepEqual(await run,{raw:{ok:true,fixture:true},exitCode:0,cancelling:false});assert.deepEqual(await warm.drain(),{processStopped:true,executionCommitted:true});
});

test('known rejection requires authenticated exact packet and actual exit1',async t=>{
  const f=fixture(t),warm=await warmVoiceMonitor(f),run=warm.execute(request());let settled=false;run.catch(()=>{settled=true;});
  f.send(rejection(f));await tick();assert.equal(settled,false);f.finish(1);
  await assert.rejects(run,{code:'DRAFT_UI_MUTEX_BUSY',warmExecutionStarted:false,nativeStarted:false,recordingPossible:false,submitAttempted:false});
});

test('oversized native line is refused before commit despite a valid warm lease',async t=>{
  const f=fixture(t),warm=await warmVoiceMonitor(f);
  await assert.rejects(warm.execute({...request(),padding:'a'.repeat(65536)}),{code:'VOICE_WARMUP_REQUEST_INVALID',nativeStarted:false});
  assert.equal(f.requests.length,1);await warm.close();
});

test('changed rejection nonce, ownership flag, extra fields, exit or cancellation cannot prove non-execution',async t=>{
  for(const scenario of ['nonce','flag','extra','exit','cancel']){
    const f=fixture(t,{autoClose:false}),warm=await warmVoiceMonitor(f),controller=new AbortController(),run=warm.execute(request(),{signal:controller.signal}),packet=rejection(f);
    if(scenario==='nonce')packet.nonce='c'.repeat(64);if(scenario==='flag')packet.inputSent=true;if(scenario==='extra')packet.extra=true;if(scenario==='cancel')controller.abort();
    f.send(packet);f.finish(scenario==='exit'?0:1);
    await assert.rejects(run,error=>error.recordingPossible===true&&error.submitAttempted===null&&error.nativeStarted!==false);
  }
});

test('aborting an unused monitor closes without commit and drain waits actual stop',async t=>{
  const f=fixture(t,{autoClose:false}),controller=new AbortController(),warm=await warmVoiceMonitor({...f,signal:controller.signal});let drained=false;
  controller.abort();const done=warm.drain().then(()=>{drained=true;});await tick();assert.equal(drained,false);assert.equal(f.requests.length,1);
  await assert.rejects(warm.execute(request()),{nativeStarted:false,recordingPossible:false});f.finish(0);await done;assert.equal(drained,true);
});

test('cancelled committed execution never gains pre-execution proof from a broken channel',async t=>{
  const f=fixture(t,{autoClose:false}),controller=new AbortController(),warm=await warmVoiceMonitor(f),run=warm.execute(request(),{signal:controller.signal});
  controller.abort();assert.equal(f.requests.at(-1),'cancel');f.finish(1);
  await assert.rejects(run,error=>error.recordingPossible===true&&error.nativeStarted!==false);
});

test('duplicate post-commit packet remains uncertain even when first packet claims a stopped recording',async t=>{
  const f=fixture(t,{autoClose:false}),warm=await warmVoiceMonitor(f),run=warm.execute(request());
  f.send({ok:false,recordingPossible:false});f.send({ok:false,recordingPossible:false});f.finish(1);
  await assert.rejects(run,{code:'VOICE_WARMUP_PROTOCOL_INVALID',recordingPossible:true,submitAttempted:null});
});

test('startup timeout remains read-only and cannot resolve until process stops',async t=>{
  const f=fixture(t,{reply:false,autoClose:false});let settled=false;
  const run=warmVoiceMonitor({...f,readyTimeoutMs:100});run.catch(()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,130));
  assert.equal(settled,false);assert.equal(f.requests.length,1);f.finish(0);await assert.rejects(run,{code:'VOICE_WARMUP_READY_TIMEOUT',nativeStarted:false});
});

test('aborted or missing-binary startup never spawns a helper',async t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();await assert.rejects(warmVoiceMonitor({...f,signal:controller.signal}),{code:'VOICE_CANCELLED_BEFORE_START'});assert.equal(f.requests.length,0);
  fs.unlinkSync(path.join(f.root,'state/ui-host/WechatVoicePreview.exe'));await assert.rejects(warmVoiceMonitor(f),{code:'VOICE_COMPONENT_MISSING'});assert.equal(f.requests.length,0);
});
