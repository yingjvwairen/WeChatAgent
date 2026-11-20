import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UiReplyOutbox,inspectPreparationControl,recoverPreparationControl} from './ui-reply-outbox.mjs';
import {UiTextOutbox} from './ui-text-outbox.mjs';
import {ReplyPreferences} from './reply-preferences.mjs';
import {NativeVoiceOutbox} from './native-voice-outbox.mjs';
const id=n=>String(n).repeat(64),request=n=>({deliveryId:id(n),account:'self',target:'friend',text:'fixture',selectionScope:{fixture:true}});
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ui-replies-'));t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('ui-replies-'));fs.rmSync(directory,{recursive:true,force:true});});const state={mode:'voice',allowed:true,prepare:true,voiceResult:'confirmed',sent:0,textInputs:0},jobs=new Map();
 const textOutbox=new UiTextOutbox({directory:path.join(directory,'text'),driver:{observe:async()=>({ready:false}),typeGrapheme:async()=>state.textInputs++,submit:async()=>state.textInputs++,receipt:async()=>({confirmed:false})}});
 const voiceOutbox={get:key=>jobs.get(key)??null,run:async r=>{state.sent++;const job={id:r.deliveryId,state:state.voiceResult,voiceId:'c'.repeat(64),segments:[{receipt:{serverId:'101'}}]};jobs.set(r.deliveryId,job);return job;},close(){}};
 const create=()=>new UiReplyOutbox({directory:path.join(directory,'routes'),textOutbox,voiceOutbox,modeFor:()=>state.mode,authorize:()=>state.allowed,prepare:async()=>({ready:state.prepare})});return {directory,state,jobs,textOutbox,voiceOutbox,create,outbox:create()};}
test('admitted reply mode survives settings change and restart without fallback',async t=>{const f=fixture(t);f.outbox.enqueue(request(1));f.state.mode='text';const restored=f.create();assert.equal(restored.get(id(1)).mode,'voice');await restored.tick();assert.equal(restored.get(id(1)).state,'confirmed');assert.equal(f.state.sent,1);assert.equal(f.textOutbox.list().length,0);restored.enqueue(request(1));await restored.tick();assert.equal(f.state.sent,1);assert.throws(()=>restored.enqueue({...request(1),text:'changed'}),{code:'UI_DELIVERY_ID_CONFLICT'});});
test('unknown voice blocks later text and cannot become a second voice submission',async t=>{const f=fixture(t);f.state.voiceResult='unknown';f.outbox.enqueue(request(1));await f.outbox.tick();f.state.mode='text';f.outbox.enqueue(request(2));assert.equal((await f.outbox.tick()).blocked,true);assert.equal(f.state.sent,1);assert.equal(f.state.textInputs,0);assert.equal(f.outbox.get(id(1)).state,'unconfirmed');});
test('revocation and preparation refusal prevent voice; ordinary resume cannot clear the durable preparation fault',async t=>{const f=fixture(t);f.outbox.enqueue(request(1));f.state.prepare=false;await f.outbox.tick();assert.equal(f.state.sent,0);f.state.allowed=false;await f.outbox.tick();assert.equal(f.outbox.get(id(1)).state,'cancelled');f.outbox.enqueue(request(2));f.state.allowed=true;f.state.prepare=true;f.outbox.pause();await f.outbox.tick();assert.equal(f.state.sent,0);f.outbox.resume();await f.outbox.tick();assert.equal(f.state.sent,0);const directory=f.outbox.directory;recoverPreparationControl(directory,{expectedRevision:inspectPreparationControl(directory).revision,assertStopped:()=>true});await f.outbox.tick();assert.equal(f.state.sent,1);});
test('text route resumes an interrupted admission without changing format',async t=>{const f=fixture(t);f.state.mode='text';const original=f.textOutbox.enqueue.bind(f.textOutbox);f.textOutbox.enqueue=()=>{throw Error('fixture interrupted admission');};assert.throws(()=>f.outbox.enqueue(request(1)));f.textOutbox.enqueue=original;f.state.mode='voice';await f.outbox.tick();assert.equal(f.outbox.get(id(1)).mode,undefined);assert.equal(f.textOutbox.list().length,1);assert.equal(f.state.sent,0);});
test('reply preference changes use revisions and default to text without starting anything',t=>{const f=fixture(t),store=new ReplyPreferences({root:f.directory});assert.deepEqual(store.get(),{version:0,mode:'text'});assert.equal(store.replace({expectedVersion:0,mode:'voice'}).mode,'voice');assert.equal(new ReplyPreferences({root:f.directory}).get().mode,'voice');assert.throws(()=>store.replace({expectedVersion:0,mode:'text'}),{code:'UI_REPLY_SETTINGS_VERSION_CONFLICT'});assert.throws(()=>store.replace({expectedVersion:1,mode:'file'}),{code:'UI_REPLY_SETTINGS_INVALID'});});
test('completed reply routes archive beyond 256 deliveries and keep the original mode and receipt',async t=>{
  const f=fixture(t);
  for(let index=1;index<=260;index++){f.outbox.enqueue({...request(1),deliveryId:index.toString(16).padStart(64,'0')});await f.outbox.tick();}
  assert.equal(f.outbox.prune().archived,1);assert.equal(f.outbox.list().length,0);assert.equal(f.state.sent,260);
  f.state.mode='text';const restored=f.create(),old={...request(1),deliveryId:'1'.padStart(64,'0')};
  const prior=restored.enqueue(old);assert.equal(prior.mode,'voice');assert.equal(prior.state,'confirmed');assert.equal(prior.receipt.type,'wechat-native-voice-job-v1');
  await restored.tick();restored.pause(old.deliveryId);restored.resume(old.deliveryId);assert.equal(restored.list().length,0);assert.equal(f.state.sent,260);
  assert.throws(()=>restored.enqueue({...old,text:'different'}),{code:'UI_DELIVERY_ID_CONFLICT'});
});
test('unknown voice route is retained during pruning and continues blocking input',async t=>{const f=fixture(t);f.state.voiceResult='unknown';f.outbox.enqueue(request(1));await f.outbox.tick();assert.equal(f.outbox.prune().archived,0);f.state.mode='text';f.outbox.enqueue(request(2));assert.equal((await f.outbox.tick()).blocked,true);assert.equal(f.state.textInputs,0);});

function nativeFixture(t,options={}){
  const f=fixture(t),wave=()=>{const b=Buffer.alloc(3244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;};
  const scope={version:1,accountRef:'a'.repeat(64),account:'self',target:'friend',eventId:'fixture-event',selectionVersion:1,grantId:'b'.repeat(64),token:'c'.repeat(64)};
  f.request={...request(1),selectionScope:scope};f.state.prepares=0;f.state.syntheses=0;f.state.queries=0;
  f.confirmed=job=>({confirmed:true,recordingPossible:false,stopBarrier:false,routeSafe:true,routeMode:'unchanged',receipt:{type:'wechat-database-voice-v1',deliveryId:job.id,account:job.account,target:job.target,nativeVoiceRowConfirmed:true,audioContentVerified:false,timbreVerified:false,sourceShard:'d'.repeat(64),localId:'1',serverId:'500',durationMs:Math.ceil(job.durationMs)}});
  f.transport={sendSegment:async job=>{f.state.sent++;return f.confirmed(job);},querySegment:async job=>{f.state.queries++;assert.equal(job.audio,undefined);return f.confirmed(job);}};
  f.voiceOutbox=new NativeVoiceOutbox({root:f.directory,transport:f.transport,authorizeScope:()=>f.state.allowed,operationTimeoutMs:1000,
    synthesizer:{synthesize:async()=>{f.state.syntheses++;return{voiceId:'e'.repeat(64),modelVerification:'api-acknowledged',segments:[1,2,3].map(()=>({audio:wave(),voiceId:'e'.repeat(64),modelVerification:'api-acknowledged'}))};}},...options});
  f.make=prepare=>new UiReplyOutbox({directory:path.join(f.directory,'routes'),textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=>f.state.mode,authorize:()=>f.state.allowed,prepare:prepare??(async()=>{f.state.prepares++;return{ready:true};})});
  f.outbox=f.make();return f;
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
test('failed synthesis persists a terminal zero-submission decision across restart and pruning', async t=>{
  const f=nativeFixture(t,{synthesizer:{synthesize:async()=>{throw Error('unavailable');}}});
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  assert.equal(f.state.sent,0);
  assert.equal(f.make().get(f.request.deliveryId).voiceFallbackEligible,true);
  f.outbox.prune();
  const restored=f.make().get(f.request.deliveryId);
  assert.equal(restored.state,'cancelled');assert.equal(restored.voiceFallbackEligible,true);
});
test('audio preflight refusal permits fallback only when no segment has been submitted and recording cleanup is certain', async t=>{
  for(const variant of ['first','partial','uncertain','interrupted']){
    const f=nativeFixture(t);let count=0;
    f.transport.sendSegment=async job=>{
      if(variant==='partial'&&count++===0)return f.confirmed(job);
      return {confirmed:false,attempted:variant==='uncertain',recordingPossible:variant==='uncertain',stopBarrier:variant==='uncertain',routeSafe:true,routeMode:'unchanged',
        reason:variant==='interrupted'?'NATIVE_VOICE_ABORTED':'AUDIO_DEFAULT_CAPTURE_NOT_CABLE'};
    };
    f.outbox.enqueue(f.request);await f.outbox.tick();
    assert.equal(f.make().get(f.request.deliveryId).voiceFallbackEligible===true,variant==='first',variant);
  }
});
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
test('cancelled voice retry backoff does not borrow focus and resumes at its deadline',async t=>{
  const f=fixture(t);let now=1000,prepares=0;f.outbox.now=()=>now;f.outbox.prepare=async()=>{prepares++;return{ready:true};};
  f.outbox.enqueue(request(1));f.jobs.set(id(1),{id:id(1),state:'sending',voiceId:'c'.repeat(64),segments:[{state:'confirmed',receipt:{serverId:'100'}},{state:'retry-wait',nextAttemptAt:2000}]});
  for(now of [1000,1500,1999]){await f.outbox.tick();assert.equal(prepares,0);assert.equal(f.state.sent,0);}
  now=2000;await f.outbox.tick();assert.equal(prepares,1);assert.equal(f.state.sent,1);
});

test('explicit paste submits in its original prepared tick without another navigation or character delay',async t=>{
  const f=fixture(t);let now=1000,prepares=0,pastes=0,submits=0,draft='';
  const driver={observe:async()=>({ready:true,account:'self',target:'friend',foreground:true,idleMs:1000,draft,editorToken:'fixture',activityRevision:'revision'}),
    typeGrapheme:async()=>assert.fail('paste route'),pasteText:async(_job,guard)=>{pastes++;draft+=guard.text;return{performed:true,attempted:true};},
    submit:async()=>{submits++;return{performed:true,attempted:true};},receipt:async()=>({confirmed:true,receipt:{fixture:true}})};
  const text=new UiTextOutbox({directory:path.join(f.directory,'paced-text'),driver,settings:{idleMs:1000,intervalMs:120},now:()=>now,textEntryModeFor:()=> 'paste'});
  const box=new UiReplyOutbox({directory:path.join(f.directory,'paced-routes'),textOutbox:text,modeFor:()=> 'text',authorize:()=>true,now:()=>now,prepare:async()=>{prepares++;return{ready:true};}});
  box.enqueue(request(1));await box.tick();assert.equal(pastes,1);assert.equal(prepares,1);assert.equal(submits,1);assert.equal(box.get(id(1)).state,'submitted');
  await box.tick();assert.equal(box.get(id(1)).state,'confirmed');assert.equal(prepares,1);assert.equal(submits,1);assert.equal(now,1000);
});

test('held conflicts and future unstarted text jobs never navigate or borrow focus',async t=>{
  for(const state of ['queued','waiting','conflict']){
    const f=fixture(t);f.state.mode='text';let now=Date.now(),prepares=0;f.outbox.now=()=>now;f.outbox.prepare=async()=>{prepares++;return{ready:true};};
    f.outbox.enqueue(request(1));const job=f.textOutbox.get(id(1));Object.assign(job,{state,nextActionAt:state==='conflict'?now:now+200});
    fs.writeFileSync(path.join(f.directory,'text/jobs',id(1)+'.json'),JSON.stringify(job));
    for(let n=0;n<4;n++){await f.outbox.tick();assert.equal(prepares,0);now+=50;}
    if(state!=='conflict'){await f.outbox.tick();assert.equal(prepares,1);}
    else{now+=5000;await f.outbox.tick();assert.equal(prepares,0);}
    assert.equal(f.state.textInputs,0);
  }
});
test('voice retry backoff cannot prevent revocation from reaching the cancellation worker',async t=>{
  const f=fixture(t);f.outbox.now=()=>1000;let prepares=0;f.outbox.prepare=async()=>{prepares++;return{ready:true};};f.outbox.enqueue(request(1));
  f.jobs.set(id(1),{id:id(1),state:'sending',segments:[{state:'retry-wait',nextAttemptAt:2000}]});f.state.allowed=false;
  let cancelled=0;f.voiceOutbox.run=async()=>{cancelled++;f.jobs.set(id(1),{id:id(1),state:'cancelled',segments:[{state:'cancelled'}]});};
  await f.outbox.tick();assert.equal(prepares,0);assert.equal(f.state.sent,0);assert.equal(cancelled,1);assert.equal(f.outbox.get(id(1)).state,'cancelled');
});
test('mixed outbox queries unknown voice while paused or revoked without preparing or sending later chunks',async t=>{
  const f=nativeFixture(t);f.transport.sendSegment=async()=>{f.state.sent++;return{recordingPossible:true};};f.outbox.enqueue(f.request);await f.outbox.tick();assert.equal(f.state.sent,1);
  f.state.mode='text';f.outbox.enqueue({...f.request,deliveryId:id(2)});f.state.allowed=false;f.outbox.pause();
  const result=await f.outbox.tick();assert.equal(result.nativeState,'sending');assert.equal(f.state.queries,1);assert.equal(f.state.sent,1);assert.equal(f.state.prepares,1);assert.equal(f.state.textInputs,0);
  assert.deepEqual(f.voiceOutbox.get(id(1)).segments.map(part=>part.state),['confirmed','prepared','prepared']);
  assert.equal(await f.outbox.tick(),null);assert.equal(f.state.sent,1);f.outbox.resume();await f.outbox.tick();assert.equal(f.voiceOutbox.get(id(1)).state,'cancelled');assert.equal(f.state.sent,1);
});
test('unconfirmed voice is queried on every recovery tick and continues blocking all later desktop input',async t=>{
  const f=nativeFixture(t);f.transport.sendSegment=async()=>{f.state.sent++;return{recordingPossible:true};};f.transport.querySegment=async()=>{f.state.queries++;return{attempted:false,recordingPossible:false,stopBarrier:false,routeSafe:true,routeMode:'unchanged'};};
  f.outbox.enqueue(f.request);await f.outbox.tick();f.state.mode='text';f.outbox.enqueue({...f.request,deliveryId:id(2)});
  for(let index=0;index<2;index++)assert.equal((await f.outbox.tick()).blocked,true);
  assert.equal(f.state.queries,2);assert.equal(f.state.sent,1);assert.equal(f.state.prepares,1);assert.equal(f.state.textInputs,0);assert.equal(f.outbox.get(id(1)).state,'unconfirmed');
});
test('global and per-job pause abort the current native submit gate and drain waits for recording cleanup',async t=>{
  for(const perJob of [false,true]){
    const f=nativeFixture(t),entered=deferred(),cleanup=deferred();let options,drained=false;
    f.transport.sendSegment=async(job,value)=>{f.state.sent++;options=value;entered.resolve();await cleanup.promise;assert.equal(value.canSubmit(),false);return{attempted:false,recordingPossible:false,stopBarrier:false,routeSafe:true,routeMode:'unchanged'};};
    f.outbox.enqueue(f.request);const running=f.outbox.tick();await entered.promise;f.outbox.pause(perJob?id(1):undefined);
    assert.equal(options.signal.aborted,true);assert.equal(options.canSubmit(),false);const draining=f.outbox.drain().then(()=>{drained=true;});await turn();assert.equal(drained,false);
    cleanup.resolve();await running;await draining;assert.equal(drained,true);assert.equal(f.state.sent,1);assert.equal(f.voiceOutbox.get(id(1)).state,'cancelled');
  }
});
test('pause during preparation is forwarded to its signal and prevents synthesis after preparation exits',async t=>{
  const f=nativeFixture(t),entered=deferred(),cleanup=deferred();let signal;
  f.outbox=f.make(async(job,options)=>{signal=options.signal;entered.resolve();await cleanup.promise;return{ready:true};});
  f.outbox.enqueue(f.request);const running=f.outbox.tick();await entered.promise;f.outbox.pause(id(1));assert.equal(signal.aborted,true);cleanup.resolve();await running;await f.outbox.drain();assert.equal(f.state.syntheses,0);assert.equal(f.state.sent,0);assert.equal(f.outbox.get(id(1)).manualPause,true);
});
test('cancelling active voice preserves its unknown recording and cancels only the later unstarted segments',async t=>{
  const f=nativeFixture(t),entered=deferred(),cleanup=deferred();let signal;
  f.transport.sendSegment=async(job,options)=>{f.state.sent++;signal=options.signal;entered.resolve();await cleanup.promise;return{recordingPossible:true};};
  f.outbox.enqueue(f.request);const running=f.outbox.tick();await entered.promise;const requested=f.outbox.cancel(id(1));assert.equal(requested.cancelRequested,true);assert.notEqual(requested.state,'cancelled');assert.equal(signal.aborted,true);
  cleanup.resolve();await running;await f.outbox.drain();assert.equal(f.outbox.get(id(1)).state,'unconfirmed');assert.equal(f.outbox.prune().archived,0);
  await f.outbox.tick();assert.equal(f.outbox.get(id(1)).state,'cancelled');assert.deepEqual(f.voiceOutbox.get(id(1)).segments.map(part=>part.state),['confirmed','cancelled','cancelled']);assert.equal(f.state.sent,1);assert.equal(f.state.queries,1);assert.equal(f.state.prepares,1);
});
test('pause timeout keeps the native cleanup barrier until the ignored cancellation actually finishes',async t=>{
  const f=nativeFixture(t,{operationTimeoutMs:20}),entered=deferred(),cleanup=deferred();let drained=false;
  f.transport.sendSegment=async job=>{f.state.sent++;entered.resolve();await cleanup.promise;return f.confirmed(job);};
  f.outbox.enqueue(f.request);const running=f.outbox.tick();await entered.promise;f.outbox.pause();const draining=f.outbox.drain().then(()=>{drained=true;});await running;assert.equal(f.outbox.get(id(1)).state,'unconfirmed');assert.equal(drained,false);
  assert.equal(fs.existsSync(path.join(f.directory,'state/native-voice-outbox/worker.lock')),true);assert.equal((await f.outbox.tick()).blocked,true);assert.equal(f.state.queries,0);assert.equal(drained,false);
  cleanup.resolve();await draining;assert.equal(drained,true);assert.equal(f.state.sent,1);assert.equal(f.outbox.get(id(1)).state,'unconfirmed');await f.outbox.tick();assert.equal(f.state.queries,1);assert.equal(f.state.sent,1);
});
test('text preparation also receives cancellation before its desktop navigation can continue',async t=>{
  const f=nativeFixture(t),entered=deferred(),cleanup=deferred();let signal;f.state.mode='text';
  f.outbox=f.make(async(job,options)=>{signal=options.signal;entered.resolve();await cleanup.promise;return{ready:true};});
  f.outbox.enqueue(f.request);const running=f.outbox.tick();await entered.promise;f.outbox.pause(id(1));assert.equal(signal.aborted,true);cleanup.resolve();await running;assert.equal(f.state.textInputs,0);assert.equal(f.state.syntheses,0);
});
test('drain waits for native shutdown even when the currently awaited operation rejects',async t=>{
  const f=fixture(t),entered=deferred(),failure=deferred(),cleanup=deferred();let drained=false;
  f.voiceOutbox.drain=()=>cleanup.promise;f.outbox=new UiReplyOutbox({directory:path.join(f.directory,'routes'),textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=> 'voice',authorize:()=>true,prepare:async()=>{entered.resolve();await failure.promise;throw Error('fixture preparation failed');}});
  f.outbox.enqueue(request(1));const running=f.outbox.tick();await entered.promise;const rejected=assert.rejects(running,/fixture preparation failed/);
  const draining=f.outbox.drain().finally(()=>{drained=true;});const drainRejected=assert.rejects(draining,/fixture preparation failed/);failure.resolve();await rejected;await turn();assert.equal(drained,false);cleanup.resolve();await drainRejected;assert.equal(drained,true);
});
test('a configured native voice outbox cannot prevent text mode from starting without model setup',async t=>{
  const f=fixture(t),folder=path.join(f.directory,'state/dania-voice');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'config.json'),'{ incomplete model setup');
  const voiceOutbox=new NativeVoiceOutbox({root:f.directory,transport:{sendSegment:async()=>{throw Error('unexpected recording');},querySegment:async()=>{throw Error('unexpected query');}},authorizeScope:()=>true});
  const outbox=new UiReplyOutbox({directory:path.join(f.directory,'routes'),textOutbox:f.textOutbox,voiceOutbox,modeFor:()=> 'text',authorize:()=>true});outbox.enqueue(request(1));await outbox.tick();
  assert.equal(f.textOutbox.list().length,1);assert.equal(f.state.textInputs,0);assert.equal(voiceOutbox.synthesizer,undefined);assert.equal(fs.readFileSync(path.join(folder,'config.json'),'utf8'),'{ incomplete model setup');
});

test('cold voice service is ready before any focus preparation and is skipped for receipt recovery',async t=>{
  const f=fixture(t),events=[];f.outbox.beforeVoice=async()=>{events.push('voice-ready');};
  f.outbox.prepare=async()=>{events.push('focus');return{ready:true};};f.outbox.enqueue(request(1));await f.outbox.tick();
  assert.deepEqual(events,['voice-ready','focus']);assert.equal(f.state.sent,1);
  f.outbox.enqueue(request(2));f.jobs.set(id(2),{id:id(2),state:'unknown',segments:[{state:'unknown'}]});
  f.outbox.beforeVoice=async()=>assert.fail('receipt recovery cannot load models');f.voiceOutbox.query=async()=>{};
  await f.outbox.tick();assert.equal(f.state.sent,1);
});

test('failed model startup cancels only its unstarted voice and later text remains available after restart',async t=>{
  const f=fixture(t);let voiceStarts=0,prepares=0;
  f.outbox.beforeVoice=async()=>{voiceStarts++;throw Object.assign(Error(),{code:'VOICE_SERVICE_START_FAILED'});};
  f.outbox.prepare=async()=>{prepares++;return{ready:true};};f.outbox.enqueue(request(1));await f.outbox.tick();
  assert.equal(f.outbox.get(id(1)).state,'cancelled');assert.equal(f.outbox.get(id(1)).reason,'VOICE_SERVICE_START_FAILED');
  assert.equal(prepares,0);assert.equal(f.state.sent,0);assert.equal(f.outbox.control().paused,false);
  const restored=f.create();assert.equal(restored.get(id(1)).state,'cancelled');f.state.mode='text';restored.enqueue(request(2));
  restored.prepare=async()=>{prepares++;return{ready:true};};await restored.tick();assert.equal(prepares,1);assert.equal(voiceStarts,1);assert.equal(f.textOutbox.list().length,1);
});

test('permission is rechecked after cold startup and cancellation during startup cannot borrow focus',async t=>{
  for(const interruption of ['revoke','pause']){
    const f=fixture(t),entered=deferred(),release=deferred();let prepares=0;
    f.outbox.beforeVoice=async()=>{entered.resolve();await release.promise;};f.outbox.prepare=async()=>{prepares++;return{ready:true};};
    f.outbox.enqueue(request(1));const run=f.outbox.tick();await entered.promise;
    if(interruption==='revoke')f.state.allowed=false;else f.outbox.pause();release.resolve();await run;
    assert.equal(prepares,0);if(interruption==='pause')assert.equal(f.state.sent,0);
  }
});

test('startup cleanup uncertainty and unknown errors remain fatal even when cancelled',async t=>{
  for(const code of ['VOICE_SERVICE_CLEANUP_UNCONFIRMED','VOICE_MODEL_STATE_UNKNOWN','UNEXPECTED_FIXTURE']){
    const f=fixture(t);f.outbox.beforeVoice=async()=>{if(code==='VOICE_SERVICE_CLEANUP_UNCONFIRMED')f.outbox.pause();throw Object.assign(Error(),{code});};
    f.outbox.enqueue(request(1));await assert.rejects(f.outbox.tick(),{code});
    assert.equal(f.outbox.get(id(1)).state,'queued');assert.equal(f.state.sent,0);
  }
});

test('window and identity preparation failures persist across ticks and restart until local explicit recovery',async t=>{
  for(const reason of ['QT_WINDOW_OBSCURED','QT_BINDING_CHANGED','UI_QT_ACCOUNT_UNVERIFIED','UI_QT_LAYOUT_PROFILE_REQUIRED',undefined]){
    const f=fixture(t),directory=path.join(f.directory,'routes');let prepares=0,ready=false;
    const make=()=>new UiReplyOutbox({directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=> 'voice',authorize:()=>true,prepare:async()=>{prepares++;return ready?{ready:true}:{ready:false,reason};}});
    let box=make();box.enqueue(request(1));await box.tick();for(let i=0;i<30;i++)await box.tick();assert.equal(prepares,1);assert.equal(f.state.sent,0);assert.equal(box.get(id(1)).state,'queued');assert.equal(box.control().paused,true);
    box=make();await box.tick();assert.equal(prepares,1);const view=inspectPreparationControl(directory);assert.equal(view.recoveryRequired,true);assert.equal(view.reason,reason??'UI_PREPARATION_UNVERIFIED');assert.equal(JSON.stringify(view).includes(id(1)),false);
    assert.throws(()=>recoverPreparationControl(directory,{expectedRevision:view.revision,assertStopped:()=>false}),{code:'UI_PREPARATION_SERVICE_ACTIVE'});
    assert.throws(()=>recoverPreparationControl(directory,{expectedRevision:view.revision+1,assertStopped:()=>true}),{code:'UI_PREPARATION_VERSION_CONFLICT'});
    const cleared=recoverPreparationControl(directory,{expectedRevision:view.revision,assertStopped:()=>true});assert.equal(cleared.recoveryRequired,false);assert.equal(cleared.revision,view.revision+1);assert.equal(box.get(id(1)).state,'queued');assert.equal(f.state.sent,0);
    ready=true;await box.tick();assert.equal(prepares,2);assert.equal(f.state.sent,1);
    assert.throws(()=>recoverPreparationControl(directory,{expectedRevision:view.revision,assertStopped:()=>true}),{code:'UI_PREPARATION_VERSION_CONFLICT'});
  }
});

test('human activity uses bounded persisted backoff instead of repeating preparation every tick',async t=>{
  const f=fixture(t),directory=path.join(f.directory,'routes');let at=10000,prepares=0,ready=false;
  const make=()=>new UiReplyOutbox({directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=> 'voice',authorize:()=>true,now:()=>at,prepare:async()=>{prepares++;return {ready,reason:'QT_USER_ACTIVE'};}});
  let box=make();box.enqueue(request(1));
  for(const delay of [1000,2000,4000,8000,15000,15000]){await box.tick();const count=prepares,view=inspectPreparationControl(directory);assert.equal(view.kind,'activity');assert.equal(view.recoveryRequired,false);assert.equal(box.control().paused,false);assert.equal(view.nextAttemptAt,at+delay);box=make();for(let i=0;i<10;i++)await box.tick();assert.equal(prepares,count);at+=delay-1;await box.tick();assert.equal(prepares,count);at++;}
  ready=true;await box.tick();assert.equal(f.state.sent,1);assert.equal(inspectPreparationControl(directory).kind,'clear');
});

test('a return-caption preflight refusal waits across restart without pausing the Reader-facing queue',async t=>{
  for(const code of ['QT_RETURN_CAPTION_UNAVAILABLE','QT_RETURN_CAPTION_WARMUP']){
    const f=fixture(t),directory=path.join(f.directory,'routes');
    let now=Date.now()+1000,available=false,attempts=0;
    const prepare=async()=>{
      attempts++;
      if(available)return{ready:true};
      const result={ready:false,reason:code,attempted:false,focusPreflightClean:true};
      if(attempts===1)throw Object.assign(Error('fixture'),{code,...result});
      return result;
    };
    const make=()=>new UiReplyOutbox({directory,textOutbox:f.textOutbox,modeFor:()=> 'text',authorize:()=>true,now:()=>now,prepare});
    let box=make();box.enqueue(request(1));
    for(const delay of [1000,2000,4000,8000,15000]){
      await box.tick();
      const count=attempts,view=inspectPreparationControl(directory);
      assert.equal(box.control().paused,false);assert.equal(view.kind,'activity');assert.equal(view.recoveryRequired,false);
      assert.equal(view.nextAttemptAt,now+delay);
      assert.equal(box.get(id(1)).index,0);assert.equal(box.get(id(1)).pendingInput,undefined);
      box=make();await box.tick();assert.equal(attempts,count);
      now+=delay-1;await box.tick();assert.equal(attempts,count);now++;
    }
    available=true;await box.tick();
    assert.equal(inspectPreparationControl(directory).kind,'clear');
    assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);
  }
});

test('caption codes without pre-focus proof or after possible input still require recovery',async t=>{
  const code='QT_RETURN_CAPTION_UNAVAILABLE',clean={code,attempted:false,focusPreflightClean:true};
  const queued={id:id(1),state:'queued',index:0};
  const cases=[
    [{code,attempted:false},queued],[{...clean,attempted:true},queued],
    [{...clean,clipboardRestored:false},queued],[{...clean,controlsCleanupFailed:true},queued],
    [{...clean,popupCleanup:{closed:false}},queued],[{...clean,code:'QT_RETURN_CAPTION_INPUT_UNCERTAIN'},queued],
    [clean,{...queued,index:1}],[clean,{...queued,pendingInput:{index:0}}],
    [clean,{...queued,state:'submitting'}],[clean,{...queued,nativeRecoveryRequired:true}],
  ];
  for(const [properties,job] of cases){
    const f=fixture(t),error=Object.assign(Error('fixture'),properties);
    await assert.rejects(f.outbox.prepareExternal(job,{prepare:async()=>{throw error;}}),value=>value===error);
    const reopened=f.create();
    assert.equal(reopened.control().paused,true);
    assert.equal(reopened.control().preparation.kind,'manual');
    await reopened.prepareExternal(job,{prepare:()=>assert.fail('unconfirmed operation cannot retry')});
  }
});

test('read-only hidden-layout waits keep text and voice queues alive, back off across restart and resume when visible',async t=>{
  for(const mode of ['text','voice'])for(const thrown of [false,true]){
    const f=fixture(t),directory=path.join(f.directory,'routes');let at=Date.now()+1000,prepares=0,hidden=true;
    const make=()=>new UiReplyOutbox({directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=>mode,authorize:()=>true,now:()=>at,prepare:async()=>{
      prepares++;if(!hidden)return{ready:true};
      const result={ready:false,reason:'UI_QT_LAYOUT_WINDOW_OBSCURED',attempted:false};
      if(thrown)throw Object.assign(Error('private obscured frame detail'),{code:result.reason,attempted:false,waitable:true});
      return result;
    }});
    let box=make();box.enqueue(request(1));
    for(const delay of [1000,2000,4000,8000,15000,15000]){
      await box.tick();const count=prepares,view=inspectPreparationControl(directory);
      assert.equal(view.kind,'activity');assert.equal(view.reason,'UI_QT_LAYOUT_WINDOW_OBSCURED');assert.equal(view.recoveryRequired,false);
      assert.equal(box.stopped,false);assert.equal(box.control().paused,false);assert.equal(box.get(id(1)).state,'queued');
      assert.equal(view.nextAttemptAt,at+delay);box=make();for(let i=0;i<8;i++)await box.tick();assert.equal(prepares,count);
      at+=delay-1;await box.tick();assert.equal(prepares,count);at++;
    }
    assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);hidden=false;await box.tick();
    assert.equal(inspectPreparationControl(directory).kind,'clear');assert.equal(box.stopped,false);assert.equal(box.control().paused,false);
    assert.equal(f.state.sent,mode==='voice'?1:0);
    assert.equal(fs.readFileSync(path.join(directory,'preparation-control.json'),'utf8').includes('private'),false);
  }
});

test('layout visibility can auto-resume only with explicit no-input evidence',async t=>{
  for(const attempted of [true,undefined]){
    const f=fixture(t);let prepares=0;
    f.outbox.prepare=async()=>{prepares++;return{ready:false,reason:'UI_QT_LAYOUT_WINDOW_OBSCURED',attempted};};
    f.outbox.enqueue(request(1));await f.outbox.tick();for(let i=0;i<5;i++)await f.outbox.tick();
    assert.equal(prepares,1);assert.equal(f.outbox.control().paused,true);assert.equal(f.state.sent,0);
    assert.equal(inspectPreparationControl(f.outbox.directory).recoveryRequired,true);
  }
});

test('known-return layout occlusion keeps Reader-facing ticks alive but durably pauses without repeating focus',async t=>{
  for(const mode of ['text','voice'])for(const thrown of [false,true])for(const code of ['UI_QT_LAYOUT_FOCUS_OCCLUDED','UI_QT_LAYOUT_VISIBILITY_BLOCKED']){
    const f=fixture(t),directory=path.join(f.directory,'routes');let prepares=0,at=Date.now()+1000;
    const make=()=>new UiReplyOutbox({directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=>mode,authorize:()=>true,now:()=>at,prepare:async()=>{
      prepares++;if(thrown)throw Object.assign(Error('private native visibility detail'),{code,waitable:false,focusRestored:true});
      return{ready:false,reason:code};
    }});
    let box=make();box.enqueue(request(1));await box.tick();assert.equal(box.stopped,false);assert.equal(box.get(id(1)).state,'queued');
    assert.equal(box.control().paused,true);assert.equal(inspectPreparationControl(directory).kind,'manual');
    box=make();for(let i=0;i<12;i++){at+=30000;await box.tick();}
    assert.equal(prepares,1);assert.equal(box.stopped,false);assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);
    assert.equal(fs.readFileSync(path.join(directory,'preparation-control.json'),'utf8').includes('private native'),false);
  }
});

test('preparation exceptions durably block restart and retain the original thrown cleanup contract',async t=>{
  const f=fixture(t),directory=path.join(f.directory,'routes');let prepares=0;
  const box=new UiReplyOutbox({directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=> 'voice',authorize:()=>true,prepare:async()=>{prepares++;throw Object.assign(Error('private error detail'),{code:'QT_BINDING_CHANGED'});}});
  box.enqueue(request(1));await assert.rejects(box.tick(),{code:'QT_BINDING_CHANGED'});await box.tick();assert.equal(prepares,1);
  assert.equal(inspectPreparationControl(directory).reason,'QT_BINDING_CHANGED');assert.equal(fs.readFileSync(path.join(directory,'preparation-control.json'),'utf8').includes('private error detail'),false);
});

test('proved UIA refusal stays manually paused across resume and restart without ending the Reader-facing tick',async t=>{
  for(const operation of ['prepare','navigation-ready','navigation-continuation'])for(const focus of ['restored','not-borrowed']){
    const f=fixture(t);let prepares=0;
    const make=()=>new UiReplyOutbox({directory:path.join(f.directory,'routes'),textOutbox:f.textOutbox,modeFor:()=> 'text',prepare:async()=>{prepares++;throw Object.assign(Error('private provider detail'),{code:'UIA_MODE_RESULT_UNCONFIRMED',attempted:false,uiaPreparationRefusal:{version:1,stage:'control-preparation',operation,focus,messageInputAttempted:false,draftPresent:false,cleanupConfirmed:true}});}});
    let box=make();box.enqueue(request(1));const before=box.get(id(1));await box.tick();assert.deepEqual(box.get(id(1)),before);assert.equal(box.stopped,false);
    const pause=inspectPreparationControl(box.directory);assert.equal(pause.kind,'manual');assert.equal(pause.reason,'UIA_MODE_RESULT_UNCONFIRMED');assert.equal(pause.nextAttemptAt,0);
    box.resume();await box.tick();box=make();await box.tick();await box.tick();assert.equal(prepares,1);assert.equal(box.control().paused,true);assert.equal(f.state.textInputs,0);
    assert.equal(fs.readFileSync(path.join(box.directory,'preparation-control.json'),'utf8').includes('private provider detail'),false);
  }
});

test('UIA code alone, partial input, and incomplete cleanup still throw after durable pause',async t=>{
  const clean={version:1,stage:'control-preparation',operation:'navigation-ready',focus:'restored',messageInputAttempted:false,draftPresent:false,cleanupConfirmed:true};
  const changes=[error=>delete error.uiaPreparationRefusal,error=>error.attempted=true,error=>error.inputSent=true,error=>error.controlsCleanupFailed=true,error=>error.clipboardRestored=false,error=>error.popupCleanup={closed:false},error=>error.code='UIA_MODE_VERIFIER_CLEANUP_UNCONFIRMED',error=>error.uiaPreparationRefusal.cleanupConfirmed=false,error=>error.uiaPreparationRefusal.draftPresent=true,error=>error.uiaPreparationRefusal.messageInputAttempted=true,error=>error.uiaPreparationRefusal.operation='text-input',error=>error.uiaPreparationRefusal.focus='unknown',error=>error.uiaPreparationRefusal.extra=true];
  for(const change of changes){const f=fixture(t),error=Object.assign(Error('fixture'),{code:'UIA_MODE_RESULT_UNCONFIRMED',attempted:false,uiaPreparationRefusal:{...clean}});change(error);f.outbox.prepare=async()=>{throw error;};f.state.mode='text';f.outbox.enqueue(request(1));await assert.rejects(f.outbox.tick(),value=>value===error);assert.equal(f.outbox.control().paused,true);assert.equal(f.state.textInputs,0);}
  const f=fixture(t);f.outbox.prepare=async()=>{throw Object.assign(Error('fixture'),{code:'UIA_MODE_RESULT_UNCONFIRMED',attempted:false,uiaPreparationRefusal:clean});};
  await assert.rejects(f.outbox.prepareExternal({id:id(1),index:1,state:'typing',pendingInput:{text:'partial'}},{prepare:f.outbox.prepare}),{code:'UIA_MODE_RESULT_UNCONFIRMED'});assert.equal(f.state.textInputs,0);
});

test('an original clipboard refusal before input backs off across restarts and retries the same delivery',async t=>{
  const codes=['DRAFT_CLIPBOARD_COMPLEX_FORMAT','DRAFT_CLIPBOARD_DATA_TOO_LARGE','DRAFT_CLIPBOARD_FORMAT_INVALID','DRAFT_CLIPBOARD_DATA_UNAVAILABLE'];
  for(const code of codes){
    const f=fixture(t);
    let now=Date.now()+1000,attempts=0,available=false;
    const prepare=async()=>{
      attempts++;
      if(available)return {ready:true};
      if(attempts===1)throw Object.assign(Error('fixture'),{code,clipboardPreparationClean:true});
      return {ready:false,reason:code,clipboardPreparationClean:true};
    };
    const make=()=>new UiReplyOutbox({directory:f.outbox.directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,
      modeFor:()=> 'text',authorize:()=>true,now:()=>now,prepare});
    let box=make();
    const before=box.enqueue(request(1));
    await box.tick();
    const hold=box.control();
    assert.equal(hold.paused,false);
    assert.equal(hold.preparation.kind,'activity');
    assert.equal(hold.reason,code);
    box=make();
    await box.tick();
    assert.equal(attempts,1);
    now=hold.preparation.nextAttemptAt;
    await box.tick();
    assert.equal(attempts,2);
    assert.equal(box.control().preparation.nextAttemptAt,now+2000);
    assert.deepEqual(box.get(id(1)),before);
    available=true;now+=2000;
    let resumed=0;
    f.textOutbox.tick=async()=>{resumed++;return before;};
    await box.tick();
    assert.equal(resumed,1);
    assert.equal(box.control().paused,false);
    assert.equal(inspectPreparationControl(box.directory).kind,'clear');
    assert.equal(box.list().length,1);
  }
});

test('an image still waiting to prepare can defer a second clipboard refusal and then resume',async t=>{
  const f=fixture(t),box=f.outbox,code='DRAFT_CLIPBOARD_COMPLEX_FORMAT';
  let at=10000,calls=0;
  box.now=()=>at;
  const job={id:id(1),state:'queued',index:0,mode:'image'};
  const prepare=async()=>{calls++;return calls<3?{ready:false,reason:code,clipboardPreparationClean:true}:{ready:true};};
  assert.equal((await box.prepareExternal(job,{prepare})).ready,false);
  // UiImageOutbox runs preparation inside the text queue's observation. Its
  // first deferred observation changes the empty job to "waiting".
  job.state='waiting';
  at=box.control().preparation.nextAttemptAt;
  assert.equal((await box.prepareExternal(job,{prepare})).ready,false);
  assert.equal(box.control().paused,false);
  at=box.control().preparation.nextAttemptAt;
  assert.equal((await box.prepareExternal(job,{prepare})).ready,true);
  assert.equal(calls,3);
});

test('a clipboard error without pre-input cleanup proof never auto-resumes even after restart',async t=>{
  const code='DRAFT_CLIPBOARD_COMPLEX_FORMAT';
  const clean={code,clipboardPreparationClean:true};
  const queued={id:id(1),state:'queued',index:0};
  const cases=[
    [{code},queued],[{...clean,attempted:true},queued],[{...clean,inputSent:true},queued],
    [{...clean,clipboardRestored:false},queued],[{...clean,popupCleanup:{closed:false}},queued],
    [clean,{...queued,index:1}],[clean,{...queued,pendingInput:{index:0}}],
    [clean,{...queued,state:'submitting'}],[clean,{...queued,fileDraftPossible:true}],
  ];
  for(const [evidence,job] of cases){
    const f=fixture(t),error=Object.assign(Error('fixture'),evidence);
    await assert.rejects(f.outbox.prepareExternal(job,{prepare:async()=>{throw error;}}),e=>e===error);
    const reopened=f.create();
    assert.equal(reopened.control().paused,true);
    assert.equal(reopened.control().preparation.kind,'manual');
    assert.equal(reopened.control().reason,code);
    await reopened.prepareExternal(job,{prepare:()=>assert.fail('uncertain preparation must stay paused')});
  }
});

test('search transition failure with confirmed cleanup keeps ticks alive and cannot repeat navigation after resume or restart',async t=>{
  for(const mode of ['text','voice'])for(const focus of ['restored','not-borrowed']){
    const f=fixture(t),directory=path.join(f.directory,'routes');let prepares=0,at=Date.now()+1000;
    const make=()=>new UiReplyOutbox({directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=>mode,authorize:()=>true,now:()=>at,prepare:async()=>{
      prepares++;throw Object.assign(Error('private search detail'),{code:'UI_QT_SEARCH_TRANSITION_UNCONFIRMED',navigationRefusal:{version:1,focus,messageInputAttempted:false}});
    }});
    let box=make();box.enqueue(request(1));const before=box.get(id(1));await box.tick();
    assert.equal(box.stopped,false);assert.deepEqual(box.get(id(1)),before);assert.equal(box.control().paused,true);
    const control=inspectPreparationControl(directory);assert.equal(control.kind,'manual');assert.equal(control.recoveryRequired,true);assert.equal(control.nextAttemptAt,0);assert.equal(control.reason,'UI_QT_SEARCH_TRANSITION_UNCONFIRMED');
    box.resume();await box.tick();box=make();for(let index=0;index<12;index++){at+=30000;await box.tick();}
    assert.equal(prepares,1);assert.equal(box.stopped,false);assert.equal(box.control().paused,true);assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);
    assert.equal(fs.readFileSync(path.join(directory,'preparation-control.json'),'utf8').includes('private search detail'),false);
  }
});

test('search failure without definite focus cleanup or with possible message input retains its thrown contract',async t=>{
  const clean={version:1,focus:'restored',messageInputAttempted:false};
  for(const extra of [{},{navigationRefusal:{...clean,version:2}},{navigationRefusal:{...clean,focus:'unknown'}},{navigationRefusal:{...clean,messageInputAttempted:true}},{navigationRefusal:{version:1,focus:'not-borrowed'}},{navigationRefusal:clean,clipboardRestored:false},{navigationRefusal:clean,popupCleanup:{closed:false}}]){
    const f=fixture(t);let prepares=0;const error=Object.assign(Error('private cleanup detail'),{code:'UI_QT_SEARCH_TRANSITION_UNCONFIRMED',...extra});
    f.outbox.prepare=async()=>{prepares++;throw error;};f.outbox.enqueue(request(1));await assert.rejects(f.outbox.tick(),value=>value===error);
    assert.equal(f.outbox.control().paused,true);assert.equal(inspectPreparationControl(f.outbox.directory).kind,'manual');await f.outbox.tick();
    assert.equal(prepares,1);assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);
  }
});

test('account errors without complete pre-focus evidence retain their thrown service boundary',async t=>{
  const clean={version:1,stage:'background-account',focusBorrowed:false,voiceLeasePresent:false,messageInputAttempted:false,cleanupRequired:false};
  for(const extra of [{},{accountPreflightRefusal:{...clean,version:2}},{accountPreflightRefusal:{...clean,stage:'after-focus'}},{accountPreflightRefusal:{...clean,focusBorrowed:true}},{accountPreflightRefusal:{...clean,voiceLeasePresent:true}},{accountPreflightRefusal:{...clean,messageInputAttempted:true}},{accountPreflightRefusal:{...clean,cleanupRequired:true}},{accountPreflightRefusal:{...clean,unexpected:true}},{accountPreflightRefusal:{version:1,stage:'background-account'}},{accountPreflightRefusal:clean,attempted:true},{accountPreflightRefusal:clean,inputSent:true},{accountPreflightRefusal:clean,clipboardRestored:false},{accountPreflightRefusal:clean,popupCleanup:{closed:false}},{accountPreflightRefusal:clean,code:'UI_INTERNAL_UNKNOWN'},{accountPreflightRefusal:clean,code:'UI_ACCOUNT_PROBE_ABORTED'}]){
    const f=fixture(t),error=Object.assign(Error('private account detail'),{code:'UI_ACCOUNT_PROBE_FAILED',...extra});let prepares=0;
    f.state.mode='text';f.outbox.prepare=async()=>{prepares++;throw error;};f.outbox.enqueue(request(1));const before=f.outbox.get(id(1));
    await assert.rejects(f.outbox.tick(),value=>value===error);assert.deepEqual(f.outbox.get(id(1)),before);assert.equal(f.outbox.control().paused,true);assert.equal(inspectPreparationControl(f.outbox.directory).kind,'manual');
    await f.outbox.tick();assert.equal(prepares,1);assert.equal(f.state.textInputs,0);
  }
});

test('legacy navigation retry records read as manual pauses without changing evidence or retrying after restart',async t=>{
  for(const mode of ['text','voice'])for(const attempts of [1,4,12,31]){
    const f=fixture(t),directory=f.outbox.directory,file=path.join(directory,'preparation-control.json');let prepares=0;
    f.state.mode=mode;f.outbox.enqueue(request(1));const before=f.outbox.get(id(1));
    const record={version:1,revision:54,kind:'activity',reason:'UI_QT_SEARCH_TRANSITION_UNCONFIRMED',deliveryId:id(1),attempts,nextAttemptAt:10000+Math.min(15000,1000*2**Math.min(attempts-1,4)),updatedAt:10000};
    const saved=JSON.stringify(record);fs.writeFileSync(file,saved);
    const view=inspectPreparationControl(directory);assert.deepEqual(view,{version:1,revision:54,recoveryRequired:true,reason:record.reason,kind:'manual',nextAttemptAt:0});
    const restarted=f.create();restarted.prepare=async()=>{prepares++;return{ready:true};};restarted.now=()=>1000000;
    restarted.resume();for(let n=0;n<4;n++)await restarted.tick();
    assert.equal(restarted.control().paused,true);assert.equal(restarted.stopped,false);assert.deepEqual(restarted.get(id(1)),before);
    assert.equal(prepares,0);assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);assert.equal(fs.readFileSync(file,'utf8'),saved);
  }
});

test('legacy navigation pause can be cleared only by existing stopped-service revision recovery',async t=>{
  const f=fixture(t),directory=f.outbox.directory,file=path.join(directory,'preparation-control.json');f.outbox.enqueue(request(1));
  const saved=JSON.stringify({version:1,revision:54,kind:'activity',reason:'UI_QT_SEARCH_TRANSITION_UNCONFIRMED',deliveryId:id(1),attempts:12,nextAttemptAt:25000,updatedAt:10000});fs.writeFileSync(file,saved);
  assert.throws(()=>recoverPreparationControl(directory,{expectedRevision:54,assertStopped:()=>false}),{code:'UI_PREPARATION_SERVICE_ACTIVE'});
  assert.throws(()=>recoverPreparationControl(directory,{expectedRevision:53,assertStopped:()=>true}),{code:'UI_PREPARATION_VERSION_CONFLICT'});
  assert.equal(fs.readFileSync(file,'utf8'),saved);
  const cleared=recoverPreparationControl(directory,{expectedRevision:54,assertStopped:()=>true});assert.equal(cleared.kind,'clear');assert.equal(cleared.revision,55);assert.equal(cleared.recoveryRequired,false);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).deliveryId,null);assert.equal(f.outbox.get(id(1)).state,'queued');
  await f.outbox.tick();assert.equal(f.state.sent,1);
});

test('legacy navigation compatibility rejects corrupt structure, identity, revision and backoff schedule',t=>{
  const f=fixture(t),file=path.join(f.outbox.directory,'preparation-control.json');
  const valid={version:1,revision:54,kind:'activity',reason:'UI_QT_SEARCH_TRANSITION_UNCONFIRMED',deliveryId:id(1),attempts:12,nextAttemptAt:25000,updatedAt:10000};
  for(const changed of [{extra:true},{version:2},{revision:0},{deliveryId:'invalid'},{attempts:0},{attempts:32},{nextAttemptAt:10000},{nextAttemptAt:25001},{nextAttemptAt:11000},{reason:'UNKNOWN_NAVIGATION_REASON'}]){
    fs.writeFileSync(file,JSON.stringify({...valid,...changed}));assert.throws(()=>inspectPreparationControl(f.outbox.directory),{code:'UI_PREPARATION_STATE_INVALID'});
  }
});

test('focus acquisition refusal preserves the queued reply and pauses preparation without throwing',async t=>{
  for(const mode of ['text','voice']){
    const f=fixture(t);f.state.mode=mode;let prepares=0;
    f.outbox.prepare=async()=>{prepares++;throw Object.assign(Error('private native detail'),{code:'QT_FOCUS_ACQUIRE_UNCONFIRMED'});};
    f.outbox.enqueue(request(1));const before=f.outbox.get(id(1));
    assert.equal((await f.outbox.tick()).state,'queued');
    for(let n=0;n<10;n++)await f.outbox.tick();
    assert.equal(prepares,1);assert.equal(f.outbox.stopped,false);assert.equal(f.outbox.control().paused,true);
    assert.equal(inspectPreparationControl(f.outbox.directory).reason,'QT_FOCUS_ACQUIRE_UNCONFIRMED');
    assert.deepEqual(f.outbox.get(id(1)),before);assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);
    const restarted=f.create();await restarted.tick();assert.equal(restarted.control().paused,true);assert.equal(f.state.sent,0);
    assert.equal(fs.readFileSync(path.join(f.outbox.directory,'preparation-control.json'),'utf8').includes('private native detail'),false);
  }
});

test('thrown human activity uses existing backoff while cleanup failures still reject',async t=>{
  const f=fixture(t);let at=10000,prepares=0;f.outbox.now=()=>at;
  f.outbox.prepare=async()=>{prepares++;throw Object.assign(Error('fixture'),{code:'QT_HUMAN_ACTIVITY_CHANGED',attempted:false});};
  f.outbox.enqueue(request(1));await f.outbox.tick();assert.equal(f.outbox.control().paused,false);
  assert.equal(inspectPreparationControl(f.outbox.directory).nextAttemptAt,11000);
  await f.outbox.tick();assert.equal(prepares,1);at=11000;
  f.outbox.prepare=async()=>{throw Object.assign(Error('fixture'),{code:'UI_NATIVE_CLEANUP_UNCONFIRMED'});};
  await assert.rejects(f.outbox.tick(),{code:'UI_NATIVE_CLEANUP_UNCONFIRMED'});
  assert.equal(f.outbox.control().paused,true);assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);
});

test('a definite no-input focus refusal with confirmed cleanup resumes through the existing backoff',async t=>{
  for(const restored of [true,false]){
    const f=fixture(t);let at=10000,prepares=0;f.outbox.now=()=>at;
    const outcome={version:1,reason:restored?'restored':'foreground-not-wechat',restored,skipped:!restored,foregroundOwnedByWechat:restored,identitiesUnchanged:true,activityUnchanged:true,keysReleased:true,parkRevisionUnchanged:null};
    f.outbox.prepare=async()=>{prepares++;throw Object.assign(Error('fixture'),{code:'QT_FOCUS_ACQUIRE_UNCONFIRMED',attempted:false,focusRestoreOutcome:outcome,focusConfirmation:{accepted:false,confirmed:false,reason:'request-rejected',activation:{foregroundAfter:'source'}}});};
    f.outbox.enqueue(request(1));await f.outbox.tick();const control=inspectPreparationControl(f.outbox.directory);
    assert.equal(control.kind,'activity');assert.equal(control.reason,'QT_FOCUS_ACQUIRE_UNCONFIRMED');assert.equal(control.nextAttemptAt,11000);
    assert.equal(f.outbox.control().paused,false);for(let n=0;n<10;n++)await f.outbox.tick();assert.equal(prepares,1);assert.equal(f.state.sent,0);
    const restarted=f.create();restarted.now=()=>at;restarted.prepare=async()=>{prepares++;return {ready:true};};
    at=10999;await restarted.tick();assert.equal(prepares,1);at=11000;await restarted.tick();
    assert.equal(prepares,2);assert.equal(f.state.sent,1);assert.equal(restarted.get(id(1)).state,'confirmed');assert.equal(inspectPreparationControl(restarted.directory).kind,'clear');
  }
});

test('an occluded caption retries only after no click and confirmed source-order cleanup',async t=>{
  for(const mode of ['clean','click-attempted','cleanup-missing','cleanup-failed','source-changed']){
    const f=fixture(t);let at=10000,prepares=0;f.outbox.now=()=>at;
    const activation={foregroundAfter:mode==='source-changed'?'other':'source',calibratedClickAttempted:mode==='click-attempted',
      ...(mode==='cleanup-missing'?{}:{raiseCleanup:{attempted:true,accepted:true,confirmed:mode!=='cleanup-failed',reason:mode==='cleanup-failed'?'restore-timeout':'source-order-restored'}})};
    f.outbox.prepare=async()=>{prepares++;throw Object.assign(Error('fixture'),{code:'DRAFT_FOCUS_PIXELS_UNVERIFIED',attempted:false,
      focusRestoreOutcome:{version:1,reason:'foreground-not-wechat',restored:false,skipped:true,foregroundOwnedByWechat:false,identitiesUnchanged:true,activityUnchanged:true,keysReleased:true},
      focusConfirmation:{accepted:false,confirmed:false,reason:'guard-failed',activation}});};
    f.outbox.enqueue(request(1));await f.outbox.tick();assert.equal(inspectPreparationControl(f.outbox.directory).kind,mode==='clean'?'activity':'manual');
    for(let n=0;n<10;n++)await f.outbox.tick();assert.equal(prepares,1);assert.equal(f.state.sent,0);
    at=11000;f.outbox.prepare=async()=>{prepares++;return{ready:true};};await f.outbox.tick();
    assert.equal(prepares,mode==='clean'?2:1);assert.equal(f.state.sent,mode==='clean'?1:0);
  }
});

test('a second failed focus acquisition stops retries for the same queued reply, including after restart',async t=>{
  const f=fixture(t);let at=10000,attempts=0;
  const refuse=async()=>{attempts++;throw Object.assign(Error('fixture'),{code:'QT_FOCUS_ACQUIRE_UNCONFIRMED',attempted:false,
    focusRestoreOutcome:{version:1,reason:'foreground-not-wechat',restored:false,skipped:true,foregroundOwnedByWechat:false,identitiesUnchanged:true,activityUnchanged:true,keysReleased:true},
    focusConfirmation:{reason:'request-rejected',accepted:false,confirmed:false,activation:{foregroundAfter:'source'}}});};
  f.outbox.prepare=refuse;f.outbox.now=()=>at;f.outbox.enqueue(request(1));await f.outbox.tick();
  const next=f.create();next.now=()=>at;next.prepare=refuse;at+=1000;await next.tick();
  assert.equal(inspectPreparationControl(next.directory).kind,'manual');at+=60000;
  const restarted=f.create();restarted.now=()=>at;restarted.prepare=refuse;await restarted.tick();
  assert.equal(attempts,2);assert.equal(f.state.sent,0);
  const file=path.join(next.directory,'preparation-control.json');
  const record=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...record,kind:'activity',nextAttemptAt:record.updatedAt+2000}));
  assert.equal(inspectPreparationControl(next.directory).kind,'manual');await restarted.tick();assert.equal(attempts,2);
});

test('a third foreground window stops acquisition even with clean focus-return evidence',async t=>{
  const f=fixture(t);let attempts=0;f.outbox.prepare=async()=>{attempts++;throw Object.assign(Error('fixture'),{
    code:'QT_FOCUS_ACQUIRE_UNCONFIRMED',attempted:false,focusConfirmation:{reason:'foreground-changed',confirmed:false,activation:{foregroundAfter:'other'}},
    focusRestoreOutcome:{version:1,reason:'restored',restored:true,skipped:false,foregroundOwnedByWechat:true,identitiesUnchanged:true,activityUnchanged:true,keysReleased:true}});};
  f.outbox.enqueue(request(1));await f.outbox.tick();await f.outbox.tick();assert.equal(attempts,1);
  assert.equal(inspectPreparationControl(f.outbox.directory).kind,'manual');assert.equal(f.state.sent,0);
});

test('a WeChat auxiliary foreground waits without input and resumes once the main window is available',async t=>{
  const f=fixture(t);let at=1000;f.outbox.now=()=>at;
  f.outbox.prepare=async()=>{throw Object.assign(Error('fixture'),{code:'QT_FOCUS_WECHAT_AUXILIARY_ACTIVE',attempted:false});};
  f.outbox.enqueue(request(1));await f.outbox.tick();assert.equal(inspectPreparationControl(f.outbox.directory).kind,'activity');assert.equal(f.state.sent,0);
  f.outbox.prepare=async()=>({ready:true});at+=1000;await f.outbox.tick();assert.equal(f.state.sent,1);
});

test('focus refusal with attempted input or incomplete cleanup stays paused without retry',async t=>{
  const clean={code:'QT_FOCUS_ACQUIRE_UNCONFIRMED',attempted:false,focusRestoreOutcome:{version:1,reason:'restored',restored:true,skipped:false,foregroundOwnedByWechat:true,identitiesUnchanged:true,activityUnchanged:true,keysReleased:true,parkRevisionUnchanged:null}};
  for(const change of [{attempted:true},{attempted:undefined},{clipboardRestored:false},{popupCleanup:{closed:false}},
    {focusRestoreOutcome:undefined},{focusRestoreOutcome:{...clean.focusRestoreOutcome,keysReleased:null}},
    {focusRestoreOutcome:{...clean.focusRestoreOutcome,restored:false,skipped:true,foregroundOwnedByWechat:false,reason:'foreground-not-wechat'}}]){
    const f=fixture(t);let prepares=0;f.outbox.prepare=async()=>{prepares++;throw Object.assign(Error('fixture'),clean,change);};
    f.outbox.enqueue(request(1));await f.outbox.tick();assert.equal(inspectPreparationControl(f.outbox.directory).kind,'manual');
    for(let n=0;n<10;n++)await f.outbox.tick();assert.equal(prepares,1);assert.equal(f.state.sent,0);assert.equal(f.state.textInputs,0);
  }
});

test('manual preparation lock does not block native voice receipt recovery or allow another segment',async t=>{
  const f=nativeFixture(t);f.transport.sendSegment=async()=>{f.state.sent++;return{recordingPossible:true};};f.outbox.enqueue(f.request);await f.outbox.tick();
  // A separate no-input navigation failure establishes the same durable control.
  const directory=path.join(f.directory,'routes'),lockFile=path.join(directory,'preparation-control.json');
  fs.writeFileSync(lockFile,JSON.stringify({version:1,revision:1,kind:'manual',reason:'QT_BINDING_CHANGED',deliveryId:id(1),attempts:1,nextAttemptAt:0,updatedAt:Date.now()}));
  const before=f.state.prepares;await f.outbox.tick();assert.equal(f.state.queries,1);assert.equal(f.state.sent,1);assert.equal(f.state.prepares,before);assert.equal(f.outbox.control().paused,true);await f.outbox.tick();assert.equal(f.state.sent,1);
});

test('manual preparation lock still queries an uncertain text submission without navigation or duplicate send',async t=>{
  const f=fixture(t),directory=path.join(f.directory,'routes');f.state.mode='text';f.outbox.enqueue(request(1));let prepares=0,queries=0;
  const box=new UiReplyOutbox({directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=> 'text',authorize:()=>true,prepare:async()=>{prepares++;return{ready:false,reason:'UI_QT_ACCOUNT_UNVERIFIED'};}});await box.tick();
  const job=f.textOutbox.get(id(1)),at=Date.now();Object.assign(job,{state:'submitting',index:[...job.text].length,submittedAt:at,deadlineAt:at+10000});fs.writeFileSync(path.join(f.directory,'text/jobs',id(1)+'.json'),JSON.stringify(job));
  f.textOutbox.driver.receipt=async()=>{queries++;return{confirmed:true,receipt:{fixture:true}};};
  box.pause();await box.tick();assert.equal(queries,1);assert.equal(prepares,1);assert.equal(f.state.textInputs,0);assert.equal(box.get(id(1)).state,'confirmed');assert.equal(box.control().paused,true);await box.tick();assert.equal(queries,1);
});

test('corrupt or locked preparation state fails closed and cannot be cleared without a stopped-service check',async t=>{
  const f=fixture(t),directory=path.join(f.directory,'routes'),file=path.join(directory,'preparation-control.json');
  assert.throws(()=>recoverPreparationControl(directory,{expectedRevision:0}),{code:'UI_PREPARATION_SERVICE_ACTIVE'});
  fs.writeFileSync(file,'{"version":1,"kind":"clear"}');assert.throws(()=>inspectPreparationControl(directory),{code:'UI_PREPARATION_STATE_INVALID'});await assert.rejects(f.outbox.tick(),{code:'UI_PREPARATION_STATE_INVALID'});assert.equal(f.state.sent,0);
  fs.unlinkSync(file);fs.writeFileSync(path.join(directory,'preparation-control.lock'),'fixture-owner');assert.throws(()=>recoverPreparationControl(directory,{expectedRevision:0,assertStopped:()=>true}),{code:'UI_PREPARATION_CONTROL_BUSY'});assert.equal(fs.readFileSync(path.join(directory,'preparation-control.lock'),'utf8'),'fixture-owner');
});

test('activity after pending text preserves its exact intention for verified recovery; draft conflict requires manual recovery',async t=>{
  const f=fixture(t),directory=path.join(f.directory,'routes');let at=10000,prepares=0,reason='UI_QT_HUMAN_ACTIVITY_CHANGED';f.state.mode='text';f.outbox.enqueue(request(1));
  const file=path.join(f.directory,'text/jobs',id(1)+'.json'),job=f.textOutbox.get(id(1));Object.assign(job,{state:'paused',nextActionAt:at,pendingInput:{index:0,text:'f',editorToken:'fixture',activityRevision:1}});fs.writeFileSync(file,JSON.stringify(job));const before=fs.readFileSync(file,'utf8');
  const box=new UiReplyOutbox({directory,textOutbox:f.textOutbox,voiceOutbox:f.voiceOutbox,modeFor:()=> 'text',authorize:()=>true,now:()=>at,prepare:async current=>{prepares++;assert.deepEqual(current.pendingInput,job.pendingInput);return{ready:false,reason};}});
  await box.tick();assert.equal(inspectPreparationControl(directory).kind,'activity');for(let i=0;i<20;i++)await box.tick();assert.equal(prepares,1);assert.equal(fs.readFileSync(file,'utf8'),before);
  at+=1000;reason='UI_QT_DRAFT_CONFLICT';await box.tick();assert.equal(prepares,2);assert.equal(box.control().paused,true);assert.equal(inspectPreparationControl(directory).reason,'UI_QT_DRAFT_CONFLICT');assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(f.state.textInputs,0);
});
