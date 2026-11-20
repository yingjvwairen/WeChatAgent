import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseSocialDecision,resolveSocialDecision} from '../components/qq-bridge/src/core/decision-format.js';
import {MessageBuffer,replyDeliveryParts} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {WechatOneBotAdapter,DURABLE_UI_PROTOCOL} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';

test('quote choices bind the selection to a single literal text reply',()=>{
  const id='a'.repeat(64),opts={quoteRefs:{Q1:id}};
  assert.deepEqual(parseSocialDecision('RESPOND: [QUOTE:Q1] 见面再聊',{},opts),
    {decision:'RESPOND',text:'见面再聊',quoteEventId:id});
  for(const raw of ['[QUOTE:Q9] 越界','[QUOTE:Q1]','[QUOTE:Q1] [VOICE] 语音','[QUOTE:Q1] [STICKER:S2]','[QUOTE:Q2] 文本'])
    assert.equal(parseSocialDecision('RESPOND: '+raw,{},opts).decision,'INVALID');
  assert.equal(parseSocialDecision('RESPOND: [QUOTE:Q1] 文本').decision,'INVALID');
  const archive={quoteRefs:{H917:{id,timestamp:1700000000}}};
  const chosen=parseSocialDecision('RESPOND: [QUOTE:H917] 正文',{},archive);
  assert.deepEqual(chosen,{decision:'RESPOND',text:'正文',quoteEventId:id,quoteEventTime:1700000000});
  assert.equal(replyDeliveryParts(chosen,'b'.repeat(64))[0].quoteEventTime,1700000000);
  assert.equal(parseSocialDecision('RESPOND: [QUOTE:H918] 正文',{},archive).decision,'INVALID');
});

test('the model can distinguish consecutive attachments and context-only events never create a turn',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rich-quote-'));
  const digest=s=>createHash('sha256').update(s).digest(), wire=s=>String(digest(s).readBigUInt64BE(0)%2147483647n+1n);
  const account='fixture-self',target='fixture-friend',recipient=wire(target),key='wechat:private:'+recipient;
  const buffer=new MessageBuffer(path.join(root,'buffer.json'));
  let requests=0,output;
  const engine=new SocialEngine({buffer,batchMs:5,privateMinIntervalMs:0,replyFormatFor:()=>({quoteReply:true,richQuoteReply:true}),stickerPolicyFor:()=>({enabled:false}),
    decide:async(_key,prompt,metadata)=>{
      requests++;
      output={prompt,metadata};return 'SILENT';
    },send:async()=>assert.fail('silent')});
  t.after(()=>{engine.stop();fs.rmSync(root,{recursive:true,force:true});});
  const msg=(sequence,text,extra={})=>{
    const id=digest(String(sequence)).toString('hex');
    return {platform:'wechat',kind:'private',conversation_id:recipient,self_id:wire(account),sender_id:recipient,sender_name:'好友',
      message_id:id,ui_selection_required:true,ui_reply_scope:{version:1,accountRef:'a'.repeat(64),account,target,eventId:id,selectionVersion:1,grantId:'b'.repeat(64),token:'c'.repeat(64)},timestamp:1700000000,text,...extra};
  };
  engine.receive(msg(0,'撤回提醒',{contextOnly:true}));
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(requests,0);assert.equal(buffer.unread(key).length,0);
  for(const i of [1,2])buffer.append(msg(i,'[图片]',{work_mode:'social',images:[{id:digest('img'+i).toString('hex')}]}));
  engine.receive(msg(3,'[语音]',{media:[{id:'c'.repeat(64),kind:'audio'}]}));
  for(let i=0;i<100&&!requests;i++)await new Promise(resolve=>setTimeout(resolve,10));
  const {prompt,metadata}=output;
  const candidates=JSON.parse(prompt.match(/<quote_candidates>(.*?)<\/quote_candidates>/s)[1]);
  assert.deepEqual(candidates.map(c=>[c.ref,c.type,c.images,c.media]),[
    ['Q1','图片',['I1'],undefined],['Q2','图片',['I2'],undefined],['Q3','语音',undefined,['M1']]
  ]);
  assert(metadata.allowRichHistoryQuote);assert(prompt.includes('撤回提醒'));assert(!candidates.some(c=>c.text.includes('撤回提醒')));
});

test('a selected historical quote survives model choice, journal and adapter; plain receipts cannot confirm it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'automatic-quote-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const digest=s=>createHash('sha256').update(s).digest(), wire=s=>String(digest(s).readBigUInt64BE(0)%2147483647n+1n);
  const account='fixture-self',target='fixture-friend',selfId=wire(account),recipient=wire(target);
  const grant='c'.repeat(64),scope=(eventId,grantId=grant)=>({version:1,accountRef:'b'.repeat(64),account,target,eventId,selectionVersion:1,grantId,token:'d'.repeat(64)});
  const msg=(text,grantId=grant)=>{
    const id=digest(text).toString('hex');
    return {platform:'wechat',kind:'private',conversation_id:recipient,self_id:selfId,sender_id:recipient,sender_name:'好友',message_id:id,
      ui_selection_required:true,ui_reply_scope:scope(id,grantId),text,timestamp:Math.floor(Date.now()/1000)};
  };
  const old=msg('之前的原话'),newest=msg('还记得那句吗'),otherGrant=msg('已撤回授权的旧会话','f'.repeat(64));
  const adapter=new WechatOneBotAdapter(),calls=[],optionsSeen=[];
  const advertise=()=>adapter.server.emit('event',{post_type:'meta_event',self_id:selfId,wechatagent_capabilities:[DURABLE_UI_PROTOCOL,'wechat-selection-scope-v1','native-quote-reply-v1']});
  advertise();
  assert.equal(adapter.getStatus().capabilities.quoteReply,true);
  let evidence={},savedRequest;
  adapter.server.action=async(action,params)=>{
    calls.push({action,params});
    const id=params.wechatagent_delivery_id;
    return {data:{delivery_protocol:DURABLE_UI_PROTOCOL,delivery_id:id,kind:'private',target:recipient,self_id:selfId,state:'confirmed',
      receipt:{type:'wechat-ui-delivery-v1',deliveryId:id,selfId,kind:'private',target:recipient,textSha256:digest('记得').toString('hex'),evidence:{messageId:'receipt',...evidence}}}};
  };
  const file=path.join(root,'messages.json'),buffer=new MessageBuffer(file),key='wechat:private:'+recipient;
  const engine=new SocialEngine({buffer,batchMs:1,privateMinIntervalMs:0,replyFormatFor:()=>adapter.outputCapabilities,stickerPolicyFor:()=>({enabled:false}),
    decide:async(_key,prompt)=>{
      assert.match(prompt,/"ref":"Q1","sender":"好友","text":"之前的原话"/);
      assert.doesNotMatch(prompt,/已撤回授权的旧会话/);
      savedRequest=new MessageBuffer(file).pendingRequests.get(key);
      return 'RESPOND: [QUOTE:Q1] 记得';
    },
    send:async(message,text,options)=>{
      optionsSeen.push({kind:message.kind,target:recipient,text,...options,selfId,selectionRequired:true,selectionScope:message.ui_reply_scope});
      assert.equal(new MessageBuffer(file).pendingReplies.get(key).parts[0].quoteEventId,old.message_id);
      return adapter.sendText(optionsSeen.at(-1));
    }});
  t.after(()=>engine.stop());
  for(const item of [otherGrant,old])buffer.append({...item,offline_replay:'context'});
  engine.receive(newest);
  for(let i=0;i<200&&!calls.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls.length,1);assert.equal(savedRequest.quoteRefs.Q1,old.message_id);
  assert.deepEqual(calls[0].params.message,[{type:'reply',data:{id:old.message_id}},{type:'text',data:{text:'记得'}}]);
  assert.equal(calls[0].params.wechatagent_selection_scope.eventId,newest.message_id);
  const options=optionsSeen[0];
  assert.equal((await adapter.sendText({...options,receiptOnly:true})).confirmed,false);
  evidence={quoteEventId:old.message_id};
  assert.equal((await adapter.sendText({...options,receiptOnly:true})).confirmed,true);
  await assert.rejects(adapter.sendText({...options,quoteEventId:newest.message_id}),{code:'UI_DELIVERY_ID_CONFLICT'});
  await adapter.sendReply({...options,deliveryId:'a'.repeat(64),quoteEventTime:1700000000});
  assert.deepEqual(calls.at(-1).params.message[0],{type:'reply',data:{id:old.message_id,time:1700000000}});
  adapter.server.emit('close');assert.equal(adapter.getStatus().capabilities.quoteReply,false);
  await assert.rejects(adapter.sendText(options),{code:'UI_NATIVE_QUOTE_UNAVAILABLE'});
});

test('automatic voice is an explicit capability-bound model choice and links remain text',()=>{
  const raw='RESPOND: [VOICE] 你好，今天过得怎么样？';
  assert.deepEqual(parseSocialDecision(raw),{decision:'RESPOND',text:'你好，今天过得怎么样？'});
  assert.deepEqual(parseSocialDecision(raw,{}, {allowVoice:true}),{decision:'RESPOND',text:'你好，今天过得怎么样？',replyMode:'voice'});
  for(const body of ['[VOICE]','[VOICE] [STICKER:S1]','[VOICE] 你好 [VOICE]','[VOICE] [IMAGE:I1]'])assert.equal(parseSocialDecision('RESPOND: '+body,{}, {allowVoice:true}).decision,'INVALID');
  assert.deepEqual(parseSocialDecision('RESPOND: 请看 https://example.org/page',{}, {allowVoice:true}),{decision:'RESPOND',text:'请看 https://example.org/page'});
  assert.equal(replyDeliveryParts(parseSocialDecision(raw,{}, {allowVoice:true}),'a'.repeat(64))[0].replyMode,'voice');
  for(const prefix of ['RESPOND: [VOICE]','RESPOND_VOICE:']){
    for(const text of ['链接 https://example.org/path','使用 `npm start`','示例\n~~~js\nx()\n~~~','长'.repeat(401)]){
      const answer=parseSocialDecision(prefix+' '+text,{}, {allowVoice:true});
      assert.equal(answer.text,text);assert.equal(answer.replyMode,undefined);
    }
    assert.equal(parseSocialDecision(prefix+' 你好',{}, {allowVoice:true}).replyMode,'voice');
    for(const body of ['[IMAGE:x]','[STICKER:S1]','你好\nRESPOND_VOICE: 不应发送'])assert.equal(parseSocialDecision(prefix+' '+body,{}, {allowVoice:true}).decision,'INVALID');
  }
});

test('format repair retains the available voice output contract',async()=>{
  let prompt;
  const result=await resolveSocialDecision({rawOutput:'unmarked invalid output',key:'fixture',metadata:{},allowVoice:true,
    decide:async(_key,value)=>{prompt=value;return 'RESPOND: [VOICE] 修正后的问候';}});
  assert.match(prompt,/\[VOICE\]/);assert.equal(result.result.replyMode,'voice');
});

test('voice route survives the social queue without changing into ordinary text',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'automatic-reply-'));
  t.after(()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^automatic-reply-/);fs.rmSync(dir,{recursive:true,force:true});});
  const file=path.join(dir,'messages.json'),buffer=new MessageBuffer(file),sent=[];
  const engine=new SocialEngine({buffer,batchMs:1,privateMinIntervalMs:0,minIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,
    replyFormatFor:()=>({voice:true}),stickerPolicyFor:()=>({enabled:false}),decide:async(_key,prompt)=>{assert.match(prompt,/\[VOICE\]/);return 'RESPOND: [VOICE] 这是一条语音回复';},
    send:async(_message,text,options)=>{sent.push({text,options});return {confirmed:true,delivered:'database-confirmed'};}});
  t.after(()=>engine.stop());
  engine.receive({platform:'wechat',kind:'private',conversation_id:'123',self_id:'99',sender_id:'123',message_id:'fixture-voice',text:'请说句话',timestamp:Date.now()/1000});
  for(let i=0;i<200&&!sent.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(sent.length,1);assert.equal(sent[0].text,'这是一条语音回复');assert.equal(sent[0].options.replyMode,'voice');
});

test('durable adapter transmits and deduplicates the chosen output mode; disconnect revokes voice availability',async()=>{
  const adapter=new WechatOneBotAdapter(),calls=[];
  const request={kind:'private',target:'123',selfId:'99',text:'这是一条语音',replyMode:'voice',deliveryId:'b'.repeat(64)};
  await assert.rejects(adapter.sendText(request),{code:'UI_NATIVE_VOICE_UNAVAILABLE'});
  adapter.server.emit('event',{post_type:'meta_event',self_id:99,wechatagent_capabilities:[DURABLE_UI_PROTOCOL,'native-voice-output-v1']});
  adapter.server.action=async(action,params)=>{calls.push({action,params});return {data:{delivery_protocol:DURABLE_UI_PROTOCOL,delivery_id:request.deliveryId,kind:'private',target:'123',self_id:'99',state:'queued'}};};
  assert.equal((await adapter.sendText(request)).pending,true);assert.equal(calls[0].params.wechatagent_reply_mode,'voice');
  await assert.rejects(adapter.sendText({...request,replyMode:'text'}),{code:'UI_DELIVERY_ID_CONFLICT'});
  await adapter.sendText({...request,receiptOnly:true});assert.equal(calls[1].action,'get_wechatagent_delivery');
  adapter.server.emit('close');assert.equal(adapter.outputCapabilities.voice,false);
  assert.equal((await adapter.sendText({...request,receiptOnly:true})).pending,true);assert.equal(calls.length,2);
});
