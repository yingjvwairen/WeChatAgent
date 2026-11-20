import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {TargetSelectionStore} from './target-selection.mjs';
import {UiOneBotBackend,uiOneBotId} from './ui-onebot.mjs';
import {UiReplyOutbox} from './ui-reply-outbox.mjs';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function until(predicate,work=async()=>{}) {
  const deadline=Date.now()+5000;
  while(!predicate()){assert.ok(Date.now()<deadline,'offline integration timed out');await work();await delay(5);}
}
async function fixture(t,{output='RESPOND: [VOICE] 你好，这是自动语音。',voiceResult='confirmed',coldStart}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automatic-output-integration-'));
  const account='fixture-self',target='fixture-friend',accountRef='a'.repeat(64),events=[],calls=[],jobs=new Map();
  fs.mkdirSync(path.join(root,'state/reader-service'),{recursive:true});
  const selection=new TargetSelectionStore({root,accountRef,resolveTargets:async names=>names.map(wechatId=>({wechatId,id:uiOneBotId(wechatId),name:'Fixture friend',alias:'',ambiguous:false}))});
  await selection.replace({expectedVersion:1,targetWxids:[target]});
  const state={draft:'',voiceRuns:0,starts:0,modelCalls:0};
  const voiceOutbox={get:id=>jobs.get(id)??null,run:async(request,options)=>{
    state.voiceRuns++;events.push(options.queryOnly?'voice-query':'voice-send');
    if(options.queryOnly)return jobs.get(request.deliveryId);
    assert.equal(selection.authorizeDelivery({id:request.deliveryId,...request}),true);
    const job={id:request.deliveryId,state:voiceResult,voiceId:'b'.repeat(64),segments:[{state:voiceResult,receipt:{serverId:'fixture-voice-row'}}]};
    jobs.set(request.deliveryId,job);return job;
  },close(){},async drain(){}};
  const driver={prepare:async job=>{events.push('focus:'+job.mode);return{ready:true};},
    observe:async()=>({ready:true,account,target,foreground:true,idleMs:10000,draft:state.draft,editorToken:'fixture-editor',activityRevision:1}),
    typeGrapheme:async(_job,guard)=>{events.push('text-type');state.draft+=guard.text;return{performed:true};},
    pasteText:async(_job,guard)=>{events.push('text-paste');state.draft+=guard.text;return{performed:true};},
    submit:async()=>{events.push('text-submit');state.draft='';return{performed:true};},
    receipt:async job=>({confirmed:true,receipt:{type:'wechat-database-text-v1',deliveryId:job.id,account,target,textSha256:hash(job.text),serverId:'fixture-text-row'}}),
    close(){}};
  const backendOptions={directory:path.join(root,'outbox'),policy:{accountWxid:account,targets:[]},selectionStore:selection,driver,voiceOutbox,
    currentPlan:()=>({allowed:true,executionMode:'foreground',requiresForeground:true,requiresActivityGuard:true,textEntryMode:'paste'}),
    modeFor:request=>request.replyMode??'text',beforeVoice:async signal=>{state.starts++;events.push('cold-start');await coldStart?.(signal);events.push('model-ready');},
    settings:{idleMs:10,intervalMs:0,punctuationPauseMs:0}};
  let backend=new UiOneBotBackend(backendOptions);
  assert.ok(backend.outbox instanceof UiReplyOutbox);
  const adapter=new WechatOneBotAdapter();adapter.server.emit('event',backend.meta());
  adapter.server.action=async(action,params)=>{calls.push({action,params:structuredClone(params)});const result=await backend.action({action,params});
    if(result.status!=='ok')throw Object.assign(new Error(result.message),{code:result.message,data:result.data});return result;};
  const buffer=new MessageBuffer(path.join(root,'messages.json'));
  const engine=new SocialEngine({buffer,batchMs:1,privateMinIntervalMs:0,minIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,
    deliveryRetry:{receiptDelayMs:5,maxReceiptChecks:8},replyFormatFor:()=>adapter.outputCapabilities,stickerPolicyFor:()=>({enabled:false}),
    decide:async(_key,prompt)=>{state.modelCalls++;assert.match(prompt,/\[VOICE\]/);return output;},
    send:(message,text,options)=>adapter.sendText({...options,kind:message.kind,target:message.conversation_id,selfId:message.self_id,text,
      selectionRequired:message.ui_selection_required,selectionScope:message.ui_reply_scope})});
  adapter.onMessage(message=>engine.receive(message));
  t.after(async()=>{engine.stop();backend.stop();await backend.shutdown();
    const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved),/^automatic-output-integration-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const incoming=backend.incoming({event:'message.new',type:1,isSend:false,sessionId:target,talkerId:target,content:'fixture question',rawid:'fixture-event',timestamp:Date.now()/1000,selectionVersion:selection.get().version});
  assert.ok(incoming.wechatagent.selectionScope);adapter.server.emit('event',incoming);
  await until(()=>backend.outbox.list().length===1);
  const sendCall=()=>calls.find(call=>call.action==='send_private_msg');
  return {root,state,events,calls,jobs,selection,buffer,engine,adapter,sendCall,get backend(){return backend;},
    restart(){backend.stop();backend=new UiOneBotBackend(backendOptions);adapter.server.emit('event',backend.meta());return backend;}};
}

test('model voice choice crosses the actual selected-target adapter and persistent queue, with cold start before focus',async t=>{
  let release;const f=await fixture(t,{coldStart:()=>new Promise(resolve=>{release=resolve;})});
  const id=f.sendCall().params.wechatagent_delivery_id;
  assert.equal(f.sendCall().params.wechatagent_reply_mode,'voice');assert.equal(f.backend.outbox.get(id).mode,'voice');
  assert.equal(f.state.modelCalls,1);assert.equal(f.state.starts,0);assert.deepEqual(f.events,[]);
  const running=f.backend.tick();await until(()=>!!release);assert.deepEqual(f.events,['cold-start']);assert.equal(f.state.voiceRuns,0);
  release();await running;
  assert.deepEqual(f.events,['cold-start','model-ready','focus:voice','voice-send']);
  assert.equal(f.backend.outbox.get(id).state,'confirmed');assert.equal(f.backend.outbox.textOutbox.list().length,0);
  await until(()=>f.buffer.pendingReplies.size===0);assert.equal(f.state.modelCalls,1);
  const disk=new MessageBuffer(path.join(f.root,'messages.json'));assert.equal(disk.pendingReplies.size,0);
  assert.equal(f.calls.filter(item=>item.action==='send_private_msg').length,1);
});

test('ordinary replies and URL replies remain text without starting a voice model',async t=>{
  for(const text of ['你好，这是文字回复。','请看 https://example.org/guide?ref=fixture'])await t.test(text.includes('https:')?'link':'plain',async sub=>{
    const f=await fixture(sub,{output:'RESPOND: '+text}),id=f.sendCall().params.wechatagent_delivery_id;
    assert.equal(f.sendCall().params.wechatagent_reply_mode,undefined);assert.equal(f.backend.outbox.get(id).text,text);
    await until(()=>f.backend.outbox.get(id).state==='confirmed',()=>f.backend.tick());
    await until(()=>f.buffer.pendingReplies.size===0);
    assert.equal(f.state.starts,0);assert.equal(f.state.voiceRuns,0);assert.equal(f.events.filter(value=>value==='text-submit').length,1);
    assert.equal(f.calls.filter(item=>item.action==='send_private_msg').length,1);
  });
});

test('unknown voice is only queried after restart and its delivery identity cannot change into text',async t=>{
  const f=await fixture(t,{voiceResult:'unknown'}),call=f.sendCall(),id=call.params.wechatagent_delivery_id;
  await f.backend.tick();assert.equal(f.backend.outbox.get(id).state,'unconfirmed');
  assert.equal(f.state.voiceRuns,1);assert.equal(f.events.filter(value=>value==='voice-send').length,1);
  f.engine.stop();f.restart();
  const conflict=await f.backend.action({action:call.action,params:{...call.params,wechatagent_reply_mode:'text'}});
  assert.equal(conflict.message,'UI_DELIVERY_ID_CONFLICT');
  const same=await f.backend.action(call);assert.equal(same.data.state,'submitted');
  for(let count=0;count<3;count++)await f.backend.tick();
  assert.equal(f.events.filter(value=>value==='voice-send').length,1);assert.equal(f.events.filter(value=>value==='focus:voice').length,1);
  assert.equal(f.state.starts,1);assert.equal(f.backend.outbox.get(id).mode,'voice');assert.equal(f.backend.outbox.textOutbox.list().length,0);
  assert.equal(f.events.some(value=>value==='text-submit'||value==='text-paste'),false);
});

test('cold-start refusal yields one bound fallback text after a sender restart',async t=>{
  const f=await fixture(t,{coldStart:async()=>{throw Object.assign(new Error('fixture startup'),{code:'VOICE_SERVICE_START_FAILED'});}});
  const id=f.sendCall().params.wechatagent_delivery_id;await f.backend.tick();
  assert.equal(f.backend.stopped,false);assert.equal(f.backend.outbox.get(id).state,'cancelled');
  assert.deepEqual(f.events,['cold-start']);assert.equal(f.state.voiceRuns,0);assert.equal(f.backend.outbox.textOutbox.list().length,0);
  f.restart();
  await until(()=>f.calls.filter(call=>call.action==='send_private_msg').length===2);
  const journal=new MessageBuffer(path.join(f.root,'messages.json'));
  const [pending]=journal.pendingReplies.values();
  assert.equal(pending.parts[0].fallbackFrom,id);
  assert.equal(pending.parts[0].deliveryId,hash(id+'\0voice-fallback-text-v1'));
  await until(()=>f.buffer.pendingReplies.size===0,()=>f.backend.tick());
  const submissions=f.calls.filter(call=>call.action==='send_private_msg');
  assert.equal(submissions.length,2);assert.equal(f.events.filter(x=>x==='text-submit').length,1);
  const fallback=submissions[1].params;
  assert.equal(fallback.wechatagent_delivery_id,hash(id+'\0voice-fallback-text-v1'));
  assert.equal(fallback.wechatagent_reply_mode,undefined);
  assert.deepEqual(fallback.wechatagent_selection_scope,submissions[0].params.wechatagent_selection_scope);
  assert.equal(f.backend.outbox.get(fallback.wechatagent_delivery_id).state,'confirmed');
  assert.equal(f.state.voiceRuns,0);assert.equal(f.state.modelCalls,1);
});
