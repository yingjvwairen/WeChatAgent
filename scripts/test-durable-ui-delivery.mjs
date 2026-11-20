import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {WechatOneBotAdapter,DURABLE_UI_PROTOCOL} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer,replyDeliveryParts} from '../components/qq-bridge/src/core/message-buffer.js';
import {ProactiveEngine} from '../components/qq-bridge/src/core/proactive-engine.js';
import {PROACTIVE_DEFAULTS} from '../components/qq-bridge/src/core/proactive-policy.js';
import {SELECTION_SCOPE_CAPABILITY} from '../components/qq-bridge/src/core/selection-scope.js';
import {MediaOutbox} from '../components/qq-bridge/src/core/media-outbox.js';

const id='a'.repeat(64),key='wechat:private:123';
const request={kind:'private',target:'123',text:'测试文字',selfId:'99',deliveryId:id};
const message=(messageId='first')=>({platform:'wechat',kind:'private',conversation_id:'123',self_id:'99',sender_id:'123',message_id:messageId,text:'你好',timestamp:Date.now()/1000});
const wireReceipt=(deliveryId,text='测试文字')=>({type:'wechat-ui-delivery-v1',deliveryId,selfId:'99',kind:'private',target:'123',
  textSha256:crypto.createHash('sha256').update(text).digest('hex'),evidence:{messageId:'verified-fixture-receipt'}});
const response=(deliveryId,state,extra={})=>({status:'ok',retcode:0,data:{delivery_protocol:DURABLE_UI_PROTOCOL,delivery_id:deliveryId,kind:'private',target:'123',self_id:'99',state,...(state==='confirmed'?{receipt:wireReceipt(deliveryId)}:{}),...extra}});
const advertise=adapter=>adapter.server.emit('event',{post_type:'meta_event',meta_event_type:'lifecycle',self_id:99,wechatagent_capabilities:[DURABLE_UI_PROTOCOL]});
const adapterFixture=()=>{const adapter=new WechatOneBotAdapter();advertise(adapter);return adapter;};
async function until(check){for(let i=0;i<500;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('durable delivery fixture timeout');}
function temporary(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'durable-ui-delivery-test-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^durable-ui-delivery-test-/);fs.rmSync(directory,{recursive:true,force:true});});
  return directory;
}
function socialFixture(t,{send,decide=async()=> 'RESPOND: 测试文字',file}={}){
  const directory=file?path.dirname(file):temporary(t);file??=path.join(directory,'messages.json');
  const buffer=new MessageBuffer(file),engine=new SocialEngine({buffer,batchMs:1,privateMinIntervalMs:0,minIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:1000,
    deliveryRetry:{receiptDelayMs:5,busyDelayMs:5},stickerPolicyFor:()=>({enabled:false}),decide,send});
  t.after(()=>engine.stop());return {directory,file,buffer,engine};
}

test('legacy Hook replies require the existing server receipt and expose explicit confirmation',async()=>{
  const adapter=new WechatOneBotAdapter(),calls=[];
  adapter.server.action=async(action,params)=>{calls.push({action,params});return {data:{receipt:'wechat-server-id'}};};
  assert.equal((await adapter.sendText(request)).confirmed,true);
  assert.equal(calls[0].action,'send_private_msg');assert.equal(calls[0].params.wechatagent_delivery_protocol,undefined);
  adapter.server.action=async()=>({data:{accepted:true}});
  const missing=await adapter.sendText(request);assert.equal(missing.confirmed,false);assert.equal(missing.delivered,'unconfirmed');
  const count=calls.length;await adapter.sendText({...request,receiptOnly:true});assert.equal(calls.length,count);
});

test('selection-scoped replies bind immutable event grants and never downgrade to a legacy sender',async()=>{
  const adapter=new WechatOneBotAdapter(), calls=[];
  const wire=value=>String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0)%2147483647n+1n));
  const scope={version:1,accountRef:'b'.repeat(64),account:'fixture-self',target:'fixture-friend',eventId:'event-original',selectionVersion:1,grantId:'c'.repeat(64),token:'d'.repeat(64)};
  const scoped={...request,selfId:wire(scope.account),target:wire(scope.target),selectionRequired:true,selectionScope:scope};
  adapter.server.emit('event',{post_type:'meta_event',self_id:Number(scoped.selfId),wechatagent_capabilities:[DURABLE_UI_PROTOCOL,SELECTION_SCOPE_CAPABILITY]});
  adapter.server.action=async(action,params)=>{calls.push({action,params});return {data:{delivery_protocol:DURABLE_UI_PROTOCOL,delivery_id:id,kind:'private',target:scoped.target,self_id:scoped.selfId,state:'queued'}};};
  await assert.rejects(adapter.sendText({...scoped,selectionScope:undefined}),{code:'UI_SELECTION_SCOPE_REQUIRED'});
  assert.equal((await adapter.sendText(scoped)).pending,true);
  assert.deepEqual(calls[0].params.wechatagent_selection_scope,scope);
  await assert.rejects(adapter.sendText({...scoped,selectionScope:{...scope,token:'e'.repeat(64)}}),{code:'UI_DELIVERY_ID_CONFLICT'});
  adapter.server.emit('close');
  const waiting=await adapter.sendText({...scoped,receiptOnly:true});assert.equal(waiting.pending,true);assert.equal(calls.length,1);
  const restored=new WechatOneBotAdapter();restored.server.action=async()=>{throw Error('must not query before capabilities');};
  assert.equal((await restored.sendText({...scoped,receiptOnly:true})).pending,true);
  adapter.server.emit('event',{post_type:'meta_event',self_id:Number(scoped.selfId),wechatagent_capabilities:[]});
  await assert.rejects(adapter.sendText({...scoped,deliveryId:'f'.repeat(64)}),{code:'UI_SELECTION_PROTOCOL_UNAVAILABLE'});
  assert.equal(calls.length,1);
});

test('scoped stickers and receipt cleanup never reach Hook after reconnect or media restart',async t=>{
  const adapter=new WechatOneBotAdapter();let calls=0;
  adapter.server.action=async()=>{calls++;return {data:{receipt:'wechat-server-id',media_type:'wechat-sticker'}};};
  const wire=value=>String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0)%2147483647n+1n));
  const scope={version:1,accountRef:'b'.repeat(64),account:'fixture-self',target:'fixture-friend',eventId:'event-sticker',selectionVersion:1,grantId:'c'.repeat(64),token:'d'.repeat(64)};
  const sticker={kind:'private',target:wire(scope.target),id:'e'.repeat(64),deliveryId:id,selectionRequired:true,selectionScope:scope};
  advertise(adapter);adapter.server.emit('close');
  adapter.server.emit('event',{post_type:'meta_event',self_id:Number(wire(scope.account)),wechatagent_capabilities:[]});
  for(const options of [{},{receiptOnly:true},{receiptOnly:true,abandon:true},{selectionScope:undefined},{selectionRequired:undefined}])
    await assert.rejects(adapter.sendSticker({...sticker,...options}),{code:'UI_STICKER_UNSUPPORTED'});
  assert.equal(calls,0);
  const directory=temporary(t),file=path.join(directory,'scoped-media.json'),buffer=new MessageBuffer(file);
  const message={platform:'wechat',kind:'private',conversation_id:wire(scope.target),self_id:wire(scope.account),ui_selection_required:true,ui_reply_scope:scope};
  const mediaKey='wechat:private:'+message.conversation_id,now=Date.now();
  buffer.mediaReplies.set(id,{key:mediaKey,message,part:{deliveryId:id,stickerId:sticker.id,state:'queued'},createdAt:now,expiresAt:now+10000});buffer.saveMedia();
  const restored=new MessageBuffer(file);
  assert.deepEqual(restored.mediaReplies.get(id).message.ui_reply_scope,scope);
  const outbox=new MediaOutbox({buffer:restored,policy:()=>({enabled:true}),quota:()=>0,noteOutgoing(){},log(){},
    retry:{mediaCallTimeoutMs:1000,receiptDelayMs:5,maxReceiptChecks:2,maxBusyRetries:2,busyDelayMs:5},
    send:(source,stickerId,options)=>adapter.sendSticker({...options,kind:source.kind,target:source.conversation_id,id:stickerId,
      selectionRequired:source.ui_selection_required,selectionScope:source.ui_reply_scope})});
  t.after(()=>outbox.stop());await until(()=>restored.mediaReplies.size===0);assert.equal(calls,0);
  await adapter.sendSticker({kind:'private',target:'123',id:'e'.repeat(64),deliveryId:'f'.repeat(64)});
  assert.equal(calls,1);
});

test('durable text submits once and queries queued/waiting/typing until a bound receipt confirms delivery',async()=>{
  const adapter=adapterFixture(),calls=[],states=['queued','waiting','typing','confirmed'];
  adapter.server.action=async(action,params)=>{calls.push({action,params});return response(id,states.shift());};
  for(let i=0;i<3;i++){const result=await adapter.sendText(request);assert.equal(result.pending,true);assert.equal(result.confirmed,false);assert.equal(result.delivered,'unconfirmed');assert.equal(adapter.stats.sends,0);}
  const confirmed=await adapter.sendText(request);assert.equal(confirmed.confirmed,true);assert.equal(adapter.stats.sends,1);
  assert.deepEqual(calls.map(item=>item.action),['send_private_msg','get_wechatagent_delivery','get_wechatagent_delivery','get_wechatagent_delivery']);
  assert.equal(calls[0].params.self_id,'99');assert.equal(calls[0].params.wechatagent_delivery_protocol,DURABLE_UI_PROTOCOL);
  assert.deepEqual(calls[1].params,{wechatagent_delivery_protocol:DURABLE_UI_PROTOCOL,wechatagent_delivery_id:id,self_id:'99',kind:'private',target:'123'});
  assert.equal((await adapter.sendText(request)).confirmed,true);assert.equal(calls.length,4);assert.equal(adapter.stats.sends,1);
  await assert.rejects(adapter.sendText({...request,text:'另一条文字'}),{code:'UI_DELIVERY_ID_CONFLICT'});
});

test('queued, paused, conflict and submitted states never masquerade as a delivered receipt',async()=>{
  for(const state of ['queued','waiting','typing','paused','conflict','submitting','submitted']){
    const adapter=adapterFixture();adapter.server.action=async()=>response(id,state);
    const result=await adapter.sendText(request);assert.equal(result.pending,true,state);assert.equal(result.confirmed,false,state);assert.equal(result.delivered,'unconfirmed',state);
  }
});

test('wrong identity, wrong operation and a receipt-less confirmation all fail closed',async()=>{
  for(const extra of [{self_id:'98'},{target:'124'},{kind:'group'},{delivery_id:'b'.repeat(64)},{delivery_protocol:'other'},{receipt:null},{receipt:{}},{state:'delivered'}]){
    const adapter=adapterFixture();adapter.server.action=async()=>response(id,'confirmed',extra);
    const result=await adapter.sendText(request);assert.equal(result.confirmed,false);assert.equal(result.state,'uncertain');assert.equal(adapter.stats.sends,0);
  }
});

test('wire receipt bindings include exact untrimmed text and cannot substitute another receipt',async()=>{
  const content='  测试文字\n';
  const adapter=adapterFixture();adapter.server.action=async(_action,params)=>{assert.equal(params.message[0].data.text,content);return response(id,'confirmed',{receipt:wireReceipt(id,content)});};
  assert.equal((await adapter.sendText({...request,text:content})).confirmed,true);
  for(const extra of [{deliveryId:'b'.repeat(64)},{selfId:'98'},{kind:'group'},{target:'124'},{textSha256:'c'.repeat(64)},{evidence:{}},{type:'other'}]){
    const candidate=adapterFixture();candidate.server.action=async()=>response(id,'confirmed',{receipt:{...wireReceipt(id),...extra}});
    assert.equal((await candidate.sendText(request)).confirmed,false);
  }
});

test('a lost submit acknowledgement only queries on the next call, including explicit recovery after restart',async()=>{
  const adapter=adapterFixture(),calls=[];
  adapter.server.action=async(action)=>{calls.push(action);if(calls.length===1)throw Error('OneBot disconnected');return response(id,'confirmed');};
  const unknown=await adapter.sendText(request);assert.equal(unknown.pending,true);assert.equal(unknown.confirmed,false);
  assert.equal((await adapter.sendText(request)).confirmed,true);assert.deepEqual(calls,['send_private_msg','get_wechatagent_delivery']);
  const restored=adapterFixture();restored.server.action=async(action)=>{assert.equal(action,'get_wechatagent_delivery');return response(id,'confirmed');};
  assert.equal((await restored.sendText({...request,receiptOnly:true})).confirmed,true);
});

test('reconnection or missing capability never downgrades a pending job into another legacy send',async()=>{
  const adapter=adapterFixture();let calls=0;
  adapter.server.action=async()=>{calls++;return response(id,'waiting');};await adapter.sendText(request);
  adapter.server.emit('close');const unknown=await adapter.sendText(request);assert.equal(unknown.confirmed,false);assert.equal(unknown.pending,true);assert.equal(calls,1);
  adapter.server.emit('event',{post_type:'meta_event',self_id:99,wechatagent_capabilities:[]});
  assert.equal((await adapter.sendText({...request,receiptOnly:true})).pending,true);assert.equal(calls,1);
  advertise(adapter);adapter.server.action=async action=>{calls++;assert.equal(action,'get_wechatagent_delivery');return response(id,'confirmed');};
  assert.equal((await adapter.sendText({...request,receiptOnly:true})).confirmed,true);assert.equal(calls,2);
  const restored=new WechatOneBotAdapter();restored.server.action=async()=>{throw Error('must not send');};
  assert.equal((await restored.sendText({...request,receiptOnly:true})).delivered,'unconfirmed');
});

test('persisted durable protocol preserves a read-only query before reconnect capabilities arrive',async()=>{
  const adapter=new WechatOneBotAdapter();let calls=0;
  adapter.server.action=async action=>{calls++;assert.equal(action,'get_wechatagent_delivery');return response(id,'confirmed');};
  const restored={...request,receiptOnly:true,deliveryProtocol:DURABLE_UI_PROTOCOL};
  const waiting=await adapter.sendText(restored);assert.equal(waiting.pending,true);assert.equal(waiting.protocol,DURABLE_UI_PROTOCOL);assert.equal(calls,0);
  advertise(adapter);assert.equal((await adapter.sendText(restored)).confirmed,true);assert.equal(calls,1);
});

test('durable calls require a stable ID/account and unsupported stickers do not reach the transport',async()=>{
  const adapter=adapterFixture();let calls=0;adapter.server.action=async()=>{calls++;};
  await assert.rejects(adapter.sendText({...request,deliveryId:undefined}),{code:'UI_DELIVERY_ID_REQUIRED'});
  await assert.rejects(adapter.sendText({...request,selfId:'wrong'}),{code:'UI_DELIVERY_ACCOUNT_REQUIRED'});
  await assert.rejects(adapter.sendSticker({kind:'private',target:'123',id,deliveryId:id}),{code:'UI_STICKER_UNSUPPORTED'});
  assert.equal(calls,0);
});

test('explicit pre-input rejection is terminal and unknown or not-found outcomes never imply delivery',async()=>{
  const adapter=adapterFixture();adapter.server.action=async()=>{throw Object.assign(Error('denied'),{code:'PROACTIVE_NOT_ALLOWED',data:{attempted:false,rejected:true}});};
  const rejected=await adapter.sendText(request);assert.equal(rejected.state,'failed');assert.equal(rejected.attempted,false);assert.equal(rejected.pending,false);
  for(const state of ['unconfirmed','uncertain','cancelled','failed','not_found']){
    const candidate=adapterFixture();candidate.server.action=async()=>response(id,state);
    const result=await candidate.sendText(request);assert.equal(result.confirmed,false);assert.equal(result.pending,false);assert.equal(result.delivered,'unconfirmed');
  }
});

test('a rejected read-only status query cannot prove the original delivery was never accepted',async()=>{
  const adapter=adapterFixture(),calls=[];
  adapter.server.action=async action=>{calls.push(action);if(calls.length===1)return response(id,'waiting');throw Object.assign(Error('policy removed'),{code:'UI_TARGET_NOT_ALLOWED',data:{attempted:false,rejected:true}});};
  await adapter.sendText(request);const query=await adapter.sendText(request);
  assert.equal(query.pending,true);assert.equal(query.state,'unknown');assert.equal(query.confirmed,false);
  assert.deepEqual(calls,['send_private_msg','get_wechatagent_delivery']);
});

test('SocialEngine keeps durable work pending without recording queued text as outgoing',async t=>{
  const adapter=adapterFixture(),calls=[];let state='waiting';
  adapter.server.action=async(action,params)=>{calls.push(action);return response(params.wechatagent_delivery_id,state);};
  const f=socialFixture(t,{send:(target,text,options)=>adapter.sendText({kind:target.kind,target:target.conversation_id,text,...options})});
  f.engine.receive(message());await until(()=>f.buffer.pendingReplies.get(key)?.parts?.[0].state==='submitted');
  assert.equal(f.buffer.recent(key).filter(row=>row.outgoing).length,0);assert.equal(f.buffer.unread(key).length,1);
  await until(()=>calls.length>=2);assert.equal(calls.filter(action=>action==='send_private_msg').length,1);
  state='confirmed';await until(()=>f.buffer.pendingReplies.size===0);
  const outgoing=f.buffer.recent(key).filter(row=>row.outgoing);assert.equal(outgoing.length,1);assert.equal(outgoing[0].delivery_status,'confirmed');
  assert.equal(calls.filter(action=>action==='send_private_msg').length,1);
});

test('SocialEngine retains the original durable reply across disconnect and a restart before peer negotiation',async t=>{
  const calls=[],adapter=adapterFixture();let decisions=0,queries=0,deliveryId;
  adapter.server.action=async(action,params)=>{calls.push(action);deliveryId=params.wechatagent_delivery_id;return response(deliveryId,'queued');};
  const sendWith=peer=>(target,text,options)=>{if(options.receiptOnly)queries++;return peer.sendText({kind:target.kind,target:target.conversation_id,text,...options});};
  const decide=async()=>{decisions++;return 'RESPOND: 测试文字';};
  const first=socialFixture(t,{send:sendWith(adapter),decide});first.engine.receive(message());
  await until(()=>first.buffer.pendingReplies.get(key)?.parts?.[0].state==='submitted');
  adapter.server.emit('close');await until(()=>queries>=2&&!first.engine.running.has(key));
  assert.equal(first.buffer.pendingReplies.get(key)?.parts[0].deliveryId,deliveryId);assert.equal(first.buffer.unread(key).length,1);
  assert.equal(first.buffer.recent(key).filter(row=>row.outgoing).length,0);first.engine.stop();
  const restoredAdapter=new WechatOneBotAdapter();
  restoredAdapter.server.action=async(action,params)=>{calls.push(action);assert.equal(action,'get_wechatagent_delivery');assert.equal(params.wechatagent_delivery_id,deliveryId);return response(deliveryId,'confirmed');};
  const before=queries,restored=socialFixture(t,{file:first.file,send:sendWith(restoredAdapter),decide});restored.engine.replay(key);
  await until(()=>queries>before&&!restored.engine.running.has(key));
  assert.equal(restored.buffer.pendingReplies.get(key)?.parts[0].state,'submitted');assert.equal(restored.buffer.unread(key).length,1);
  assert.equal(restored.buffer.recent(key).some(row=>row.outgoing),false);assert.equal(calls.length,1);
  advertise(restoredAdapter);await until(()=>restored.buffer.pendingReplies.size===0);
  assert.equal(decisions,1);assert.equal(calls.filter(action=>action==='send_private_msg').length,1);
  const outgoing=restored.buffer.recent(key).filter(row=>row.outgoing);assert.equal(outgoing.length,1);assert.equal(outgoing[0].delivery_id,deliveryId);assert.equal(outgoing[0].delivery_status,'confirmed');
});

test('SocialEngine restart resumes a persisted sending intention through query only',async t=>{
  const directory=temporary(t),file=path.join(directory,'messages.json'),buffer=new MessageBuffer(file),msg=message();
  const row=buffer.append(msg),result={decision:'RESPOND',text:'测试文字'},parts=replyDeliveryParts(result,id);parts[0].state='sending';
  buffer.rememberReply(key,{result,parts,message:msg,throughId:row.id,deliveryId:id,sending:true});
  const calls=[],f=socialFixture(t,{file,send:async(_target,_text,options)=>{calls.push(options);return {confirmed:true};}});
  f.engine.replay(key);await until(()=>f.buffer.pendingReplies.size===0);
  assert.equal(calls.length,1);assert.equal(calls[0].receiptOnly,true);assert.equal(calls[0].deliveryId,id);
});

test('an ambiguous SocialEngine error is followed by a read-only query, never another submit',async t=>{
  const calls=[],f=socialFixture(t,{send:async(_target,_text,options)=>{
    calls.push(options);if(calls.length===1)throw Error('lost transport response');return {confirmed:false,delivered:'unconfirmed'};
  }});
  f.engine.receive(message());await until(()=>f.buffer.pendingReplies.size===0&&calls.length===2);
  assert.deepEqual(calls.map(call=>call.receiptOnly),[false,true]);
  assert.equal(f.buffer.recent(key).find(row=>row.outgoing).delivery_status,'unconfirmed');
});

test('bare accepted results cannot confirm a reply or unlock a second message',async t=>{
  const calls=[],f=socialFixture(t,{decide:async()=> 'RESPOND: 第一条\n\n第二条',send:async(_target,text)=>{calls.push(text);return {accepted:true,state:'queued'};}});
  f.engine.receive(message());await until(()=>f.buffer.pendingReplies.size===0&&calls.length>0);
  assert.deepEqual(calls,['第一条']);assert.equal(f.buffer.recent(key).find(row=>row.outgoing).delivery_status,'unconfirmed');
});

test('an inconsistent confirmation flag on an in-progress result is not trusted by SocialEngine',async t=>{
  for(const state of ['queued','waiting','typing']){
    const f=socialFixture(t,{send:async()=>({confirmed:true,state,delivered:'database-confirmed'})});
    f.engine.receive(message(state));await until(()=>f.buffer.pendingReplies.size===0&&f.buffer.recent(key).some(row=>row.outgoing));
    assert.equal(f.buffer.recent(key).find(row=>row.outgoing).delivery_status,'unconfirmed');
  }
});

test('an old busy deadline cannot expire an accepted durable job while it waits for human activity',async t=>{
  const directory=temporary(t),file=path.join(directory,'messages.json'),buffer=new MessageBuffer(file),msg=message();
  const row=buffer.append(msg),result={decision:'RESPOND',text:'测试文字'},parts=replyDeliveryParts(result,id);
  Object.assign(parts[0],{state:'submitted',deliveryProtocol:DURABLE_UI_PROTOCOL,busyDeadline:Date.now()-100000});
  buffer.rememberReply(key,{result,parts,message:msg,throughId:row.id,deliveryId:id,sending:true});
  const calls=[],f=socialFixture(t,{file,send:async(_target,_text,options)=>{calls.push(options);return {protocol:DURABLE_UI_PROTOCOL,deliveryId:id,state:'paused',pending:true,confirmed:false,delivered:'unconfirmed'};}});
  f.engine.replay(key);await until(()=>calls.length===1&&!f.engine.running.has(key));
  assert.equal(calls[0].receiptOnly,true);assert.equal(f.buffer.pendingReplies.get(key).parts[0].state,'submitted');
  assert.equal(f.buffer.pendingReplies.get(key).parts[0].busyDeadline,undefined);assert.equal(f.buffer.recent(key).some(row=>row.outgoing),false);
});

test('stopping the engine ignores a late send result while preserving its durable intention',async t=>{
  let resolve,started=false;const f=socialFixture(t,{send:()=>{started=true;return new Promise(done=>{resolve=done;});}});
  f.engine.receive(message());await until(()=>started);f.engine.stop();resolve({confirmed:true});
  await until(()=>f.engine.running.size===0);
  assert.equal(f.buffer.pendingReplies.get(key).parts[0].state,'sending');assert.equal(f.buffer.recent(key).some(row=>row.outgoing),false);
});

test('proactive pending work survives the draft deadline and polls after restart without another submission',async t=>{
  const directory=temporary(t),buffer=new MessageBuffer(path.join(directory,'messages.json'));
  const social=new SocialEngine({buffer,decide:async()=> 'SILENT',send:async()=>{throw Error('unexpected social send');}});t.after(()=>social.stop());
  let now=Date.parse('2026-10-25T02:00:00Z'),state='waiting';const calls=[];
  const settings={wechat:{whitelist:{private:['123'],groups:[]},proactive:{...PROACTIVE_DEFAULTS,enabled:true,mode:'greeting',intervalMinutes:30,idleMinutes:5,jitterMinutes:0,chats:{[key]:true}}}};
  const make=()=>new ProactiveEngine({stateFile:path.join(directory,'proactive.json'),buffer,social,settingsFor:()=>settings,personaFor:()=>({persona:'test',personaName:'fixture'}),selfIdFor:()=> '99',now:()=>now,random:()=>0,decide:async()=> 'RESPOND: 早',send:async(_target,_text,options)=>{
    calls.push(options);return {protocol:DURABLE_UI_PROTOCOL,deliveryId:options.deliveryId,state,pending:state!=='confirmed',confirmed:state==='confirmed',delivered:state==='confirmed'?'ui-confirmed':'unconfirmed'};
  }});
  const original=make();await original.tick();now+=30*60000;await original.tick();assert.equal(calls.length,1);assert.equal(calls[0].receiptOnly,false);assert(original.state.chats[key].job);
  assert.equal(buffer.recent(key).filter(row=>row.outgoing).length,0);
  now+=11*60000;settings.wechat.proactive.enabled=false;const restored=make();state='confirmed';await restored.tick();
  assert.equal(calls.length,2);assert.equal(calls[1].receiptOnly,true);assert.equal(calls[0].deliveryId,calls[1].deliveryId);
  assert.equal(restored.state.chats[key].job,null);assert.equal(buffer.recent(key).find(row=>row.outgoing).delivery_status,'confirmed');
});
