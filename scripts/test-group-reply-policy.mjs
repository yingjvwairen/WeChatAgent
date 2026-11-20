import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer,replyDeliveryParts} from '../components/qq-bridge/src/core/message-buffer.js';
const group='wechat:group:123';
const message=(id,extra={})=>({platform:'wechat',kind:'group',conversation_id:'123',self_id:'99',sender_id:'42',message_id:id,text:'fixture',timestamp:Date.now()/1000,...extra});
const atMessage=id=>message(id,{segments:[{type:'at',data:{qq:'99'}},{type:'text',data:{text:' fixture'}}]});
async function until(check){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('Group policy fixture timeout');await new Promise(resolve=>setTimeout(resolve,5));}}
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'group-reply-policy-')),file=path.join(root,'messages.json'),engines=[],calls=[],sent=[];
  const make=extra=>{const buffer=new MessageBuffer(file),engine=new SocialEngine({buffer,batchMs:1,minIntervalMs:0,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:1000,
    stickerPolicyFor:()=>({enabled:false}),decide:async(key,prompt,metadata)=>{calls.push({key,prompt,metadata});return 'RESPOND: fixture reply';},
    send:async(_row,text,options)=>{sent.push({text,options});return {confirmed:true};},...options,...extra});engines.push(engine);return {engine,buffer};};
  t.after(()=>{for(const engine of engines)engine.stop();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('group-reply-policy-'));fs.rmSync(root,{recursive:true,force:true});});
  return {file,calls,sent,make,...make()};
}


test('natural group participation sends every new eligible batch to the model',async t=>{
  const f=fixture(t);
  for(let index=0;index<8;index++){
    f.engine.receive(message('natural-'+index));
    await until(()=>f.sent.length===index+1);
  }
  assert.equal(f.calls.length,8);
  assert(f.buffer.recent(group).every(row=>row.processed&&!row.reply_skip_reason));
});

test('natural participation can still choose silence and never replays a completed message',async t=>{
  const f=fixture(t,{decide:async()=>{f.calls.push({silent:true});return 'SILENT';}});
  const input=message('silent');
  f.engine.receive(input);await until(()=>f.buffer.recent(group)[0]?.processed);
  assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
  f.engine.stop();const restored=f.make();restored.engine.receive(input);restored.engine.replay(group);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.calls.length,1);
});

test('mention-only groups retain ordinary context until a real mention arrives',async t=>{
  const f=fixture(t,{mode:'mention'});
  f.engine.receive(message('ordinary'));
  f.engine.receive(message('other-at',{segments:[{type:'at',data:{qq:'77'}}]}));
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.calls.length,0);
  f.engine.receive(atMessage('actual-at'));await until(()=>f.sent.length===1);
  assert.equal(f.calls.length,1);assert.equal(f.buffer.unread(group).length,0);
});

test('private and authorized assistant conversations use their original admission rules',async t=>{
  const privateChat=fixture(t,{mode:'mention'});
  privateChat.engine.receive(message('private',{kind:'private'}));await until(()=>privateChat.sent.length===1);
  const assistant=fixture(t,{workModeFor:()=> 'assistant',assistantAccess:()=>true,mode:'hybrid',assistantBatchMs:1});
  assistant.engine.receive(message('assistant'));await until(()=>assistant.sent.length===1);
  assert.equal(assistant.calls.length,1);
});

test('admitted model work resumes once after restart',async t=>{
  const f=fixture(t,{decide:async()=>{throw Object.assign(Error('fixture offline'),{admitted:false});}});
  f.engine.receive(message('pending-model'));await until(()=>f.buffer.pendingRequests.size===1&&!f.engine.running.has(group));f.engine.stop();
  const restored=f.make({decide:async()=>{f.calls.push({replayed:true});return 'RESPOND: fixture reply';}});
  restored.engine.replay(group);await until(()=>f.sent.length===1);
  assert.equal(f.calls.length,1);assert.equal(restored.buffer.pendingRequests.size,0);
});

test('a submitted durable reply is queried without another model decision',async t=>{
  const f=fixture(t),row=f.buffer.append(message('pending-delivery')),id='a'.repeat(64),result={decision:'RESPOND',text:'fixture reply'},parts=replyDeliveryParts(result,id);
  Object.assign(parts[0],{state:'submitted',deliveryProtocol:'durable-ui-v1'});
  f.buffer.rememberReply(group,{result,parts,message:row,throughId:row.id,deliveryId:id,sending:true});f.engine.stop();
  const restored=f.make();restored.engine.replay(group);await until(()=>f.sent.length===1);
  assert.equal(f.calls.length,0);assert.equal(f.sent[0].options.receiptOnly,true);assert.equal(f.sent[0].options.deliveryId,id);
});

test('previously completed skipped messages remain completed after upgrading',async t=>{
  const f=fixture(t),input=message('legacy-skipped'),row=f.buffer.append(input);
  row.reply_skip_reason='group_reply_probability';
  f.buffer.markProcessed(group,row.id);f.engine.stop();
  const restored=f.make();restored.engine.receive(input);restored.engine.replay(group);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.calls.length,0);assert.equal(restored.buffer.recent(group).length,1);
});
