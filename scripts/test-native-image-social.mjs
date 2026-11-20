import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {MediaOutbox} from '../components/qq-bridge/src/core/media-outbox.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {WechatOneBotAdapter,DURABLE_UI_PROTOCOL} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';

const key='wechat:private:123',id='a'.repeat(64),deliveryId='b'.repeat(64);
const message={platform:'wechat',kind:'private',conversation_id:'123',self_id:'99',sender_id:'123',message_id:'fixture-image',text:'发张问候图片',timestamp:Date.now()/1000};
const pending=(state='paused')=>({protocol:'durable-ui-v1',deliveryId,pending:true,confirmed:false,state,retryAfterMs:250});
const confirmed=()=>({protocol:'durable-ui-v1',deliveryId,pending:false,confirmed:true,state:'confirmed'});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-image-social-')),file=path.join(root,'messages.json'),boxes=[];
  t.after(()=>{for(const box of boxes)box.stop();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^native-image-social-/);fs.rmSync(root,{recursive:true,force:true});});
  function make(send,buffer=new MessageBuffer(file)){
    const box=new MediaOutbox({buffer,send,policy:()=>({enabled:true}),quota:()=>0,noteOutgoing(){},log(){},
      retry:{mediaDeadlineMs:5000,mediaCallTimeoutMs:50,maxReceiptChecks:2,maxBusyRetries:2,busyDelayMs:5,receiptDelayMs:5}});
    for(const timer of box.timers.values())clearTimeout(timer);box.timers.clear();box.wake=()=>{};boxes.push(box);return box;
  }
  const add=(box,part={})=>box.enqueue(key,{message},{deliveryId,stickerId:id,state:'queued',deliveryProtocol:'durable-ui-v1',mediaKind:'image',...part});
  let sequence=0;return {root,file,make,add,fresh:()=>new MessageBuffer(path.join(root,'additional-'+(++sequence)+'.json'))};
}
test('durable image pending persists before RPC and survives old Hook retry/deadline budgets',async t=>{
  const f=fixture(t),calls=[];const box=f.make(async(_message,_id,options)=>{
    calls.push(options);const disk=new MessageBuffer(f.file).mediaReplies.get(deliveryId);
    assert.equal(disk.part.deliveryProtocol,'durable-ui-v1');assert.equal(disk.part.state,'sending');return pending();
  });f.add(box);
  await box.run(key);assert.equal(calls[0].receiptOnly,undefined);assert.equal(box.buffer.recent(key).length,0);
  const item=box.buffer.mediaReplies.get(deliveryId);item.createdAt=Date.now()-10000;item.expiresAt=Date.now()-5000;box.buffer.saveMedia();box.stop();
  const restored=f.make(async(_message,_id,options)=>{calls.push(options);return pending();});
  for(let i=0;i<12;i++)await restored.run(key);
  assert.equal(restored.buffer.mediaReplies.size,1);assert.equal(restored.buffer.mediaReplies.get(deliveryId).part.receiptChecks,undefined);
  assert(calls.slice(1).every(call=>call.receiptOnly===true&&call.deliveryProtocol==='durable-ui-v1'));
  assert.equal(new MessageBuffer(f.file).mediaReplies.size,1);assert.equal(restored.buffer.recent(key).length,0);
});
test('only an explicitly bound durable confirmation records a sent image',async t=>{
  const f=fixture(t);let count=0;const box=f.make(async()=>++count===1?pending('submitted'):confirmed());f.add(box);
  await box.run(key);assert.equal(box.buffer.recent(key).length,0);await box.run(key);
  assert.equal(box.buffer.mediaReplies.size,0);const row=box.buffer.recent(key).find(row=>row.outgoing);
  assert.equal(row.delivery_status,'confirmed');assert.equal(row.text,'[已发送图片/表情配图]');assert.equal(count,2);
});
test('GIF uses the existing media lane and restores receipt-only through the real adapter',async t=>{
  const f=fixture(t),calls=[],adapter=new WechatOneBotAdapter();
  adapter.server.emit('event',{post_type:'meta_event',self_id:99,wechatagent_capabilities:[DURABLE_UI_PROTOCOL,'native-image-output-v1','native-gif-output-v1']});
  adapter.server.action=async(action,params)=>{calls.push({action,params});return {data:{delivery_protocol:DURABLE_UI_PROTOCOL,delivery_id:deliveryId,kind:'private',target:'123',self_id:'99',state:'submitted'}};};
  const send=(current)=>async(source,imageId,options)=>current.sendSticker({kind:source.kind,target:source.conversation_id,selfId:source.self_id,id:imageId,...options});
  const box=f.make(send(adapter));f.add(box);await box.run(key);assert.equal(box.buffer.mediaReplies.get(deliveryId).part.state,'submitted');box.stop();
  const restoredAdapter=new WechatOneBotAdapter();restoredAdapter.server.emit('event',{post_type:'meta_event',self_id:99,wechatagent_capabilities:[DURABLE_UI_PROTOCOL]});
  restoredAdapter.server.action=async(action,params)=>{calls.push({action,params});return {data:{delivery_protocol:DURABLE_UI_PROTOCOL,delivery_id:deliveryId,kind:'private',target:'123',self_id:'99',state:'confirmed',
    receipt:{type:'wechat-ui-delivery-v1',deliveryId,selfId:'99',kind:'private',target:'123',textSha256:crypto.createHash('sha256').update('[IMAGE:'+id+']').digest('hex'),
      evidence:{type:'wechat-database-gif-v1',deliveryId,sourceImageSha256:id,sourceImageMd5:'c'.repeat(32),gifContentMd5Matched:true,localType:47,nativeImageRowConfirmed:true,imageContentVerified:false}}}};};
  const restored=f.make(send(restoredAdapter));await restored.run(key);
  assert.deepEqual(calls.map(call=>call.action),['send_private_msg','get_wechatagent_delivery']);assert.equal(restored.buffer.mediaReplies.size,0);
  assert.equal(restored.buffer.recent(key)[0].delivery_status,'confirmed');assert.equal(restored.buffer.recent(key)[0].sticker_id,id);
});
test('terminal unknown image is recorded honestly and never resubmitted',async t=>{
  const f=fixture(t),calls=[];const box=f.make(async(_message,_id,options)=>{calls.push(options);return {...pending(),pending:false,state:'unconfirmed'};});f.add(box);
  await box.run(key);assert.equal(box.buffer.mediaReplies.size,0);assert.equal(box.buffer.recent(key)[0].delivery_status,'unconfirmed');
  assert.match(box.buffer.recent(key)[0].text,/送达未确认/);assert(calls.slice(1).every(call=>call.receiptOnly&&call.abandon&&call.deliveryProtocol==='durable-ui-v1'));
  await box.run(key);assert.equal(calls.filter(call=>!call.receiptOnly).length,1);
});
test('malformed, wrong-ID and empty media results never masquerade as delivered',async t=>{
  const f=fixture(t);
  for(const result of [undefined,{}, {...confirmed(),deliveryId:'c'.repeat(64)}, {...confirmed(),confirmed:false}, {...confirmed(),pending:true}]){
    const buffer=f.fresh(),box=f.make(async()=>result,buffer);f.add(box);await box.run(key);
    assert.equal(buffer.recent(key).some(row=>row.delivery_status==='confirmed'),false);
  }
});
test('lost image RPC retains durable query-only state and cancellation before input produces no outgoing row',async t=>{
  const f=fixture(t);let calls=0;const box=f.make(async(_message,_id,options)=>{calls++;if(calls===1)throw Error('fixture disconnected');assert.equal(options.receiptOnly,true);return confirmed();});f.add(box);
  await box.run(key);assert.equal(box.buffer.mediaReplies.get(deliveryId).part.state,'submitted');await box.run(key);assert.equal(calls,2);
  const rejected=f.make(async()=>({...pending(),pending:false,state:'failed'}),f.fresh());f.add(rejected);await rejected.run(key);assert.equal(rejected.buffer.mediaReplies.size,0);assert.equal(rejected.buffer.recent(key).length,0);
});
test('DSH disconnect preserves admitted image receipt checks but cancels unsubmitted images',async t=>{
  const f=fixture(t),box=f.make(async()=>pending());f.add(box);await box.run(key);box.cancelOffline();assert.equal(box.buffer.mediaReplies.size,1);
  const queued=f.make(async()=>assert.fail('no send after disconnect'),f.fresh());f.add(queued);queued.cancelOffline();assert.equal(queued.buffer.mediaReplies.size,0);
});
test('legacy Hook sticker receipt stays supported while empty legacy responses are unconfirmed',async t=>{
  const f=fixture(t),box=f.make(async()=>({data:{receipt:'wechat-server-id',media_type:'wechat-sticker'}}));f.add(box,{deliveryProtocol:undefined,mediaKind:undefined});await box.run(key);
  assert.equal(box.buffer.recent(key)[0].delivery_status,'confirmed');assert.match(box.buffer.recent(key)[0].text,/原生表情/);
  const empty=f.make(async()=>undefined,f.fresh());f.add(empty,{deliveryProtocol:undefined,mediaKind:undefined});await empty.run(key);assert.equal(empty.buffer.recent(key)[0].delivery_status,'unconfirmed');
});
test('explicit local candidates remain available with learned label cache disabled and use the durable image lane',async t=>{
  const f=fixture(t),buffer=new MessageBuffer(f.file),calls=[];let modelCalls=0;
  const engine=new SocialEngine({buffer,batchMs:1,privateMinIntervalMs:0,minIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,
    stickerPolicyFor:()=>({enabled:true,labelCache:false}),stickerChoicesFor:async()=>[
      {id,description:'问候配图',tags:['问候'],kind:'image',source:'local-reply-media'},
      {id:'c'.repeat(64),description:'不应再用的缓存',tags:['旧缓存']}],
    decide:async(_key,prompt,meta)=>{modelCalls++;assert.match(prompt,/图片\/表情配图/);assert.match(prompt,/问候配图/);assert.doesNotMatch(prompt,/不应再用的缓存/);assert.deepEqual(meta.images,[]);return 'RESPOND: [STICKER:S1]';},
    send:async()=>assert.fail('image should not become text'),sendSticker:async(source,imageId,options)=>{
      calls.push(options);assert.equal(source.self_id,'99');assert.equal(imageId,id);assert.equal(options.deliveryProtocol,'durable-ui-v1');
      const saved=[...new MessageBuffer(f.file).mediaReplies.values()][0];assert.equal(saved.part.deliveryProtocol,'durable-ui-v1');assert.equal(saved.part.mediaKind,'image');
      return {protocol:'durable-ui-v1',deliveryId:options.deliveryId,state:'confirmed',confirmed:true,pending:false};
    }});t.after(()=>engine.stop());engine.receive({...message});
  for(let i=0;i<400&&(!calls.length||buffer.mediaReplies.size);i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls.length,1);assert.equal(modelCalls,1);assert.equal(buffer.mediaReplies.size,0);assert.equal(buffer.recent(key).find(row=>row.outgoing).text,'[已发送图片/表情配图]');
});
