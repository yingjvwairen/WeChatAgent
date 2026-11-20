import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeUiIncomingContent } from './ui-incoming-content.mjs';
import { UiOneBotBackend, uiOneBotId } from './ui-onebot.mjs';
import { normalizeOneBotEvent } from '../components/qq-bridge/src/onebot/normalize.js';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { FORWARD_TYPE, QUOTE_TYPE, quoteReplyText, forwardedRecordText } from '../components/qq-bridge/src/core/wechat-events.js';

const id = 'a'.repeat(64);
const quote = { version:1, reply:'这是新回复', truncated:false, reference:{senderId:'fixture-self',senderName:'历史作者',conversationId:'',messageId:'42',time:'',kind:'1',text:'这是历史引用',unavailable:false,truncated:false} };
const record = {version:1,title:'记录',items:[{sender:'历史作者',time:'',text:'旧发言',kind:'1',depth:0},{sender:'历史作者',time:'',text:'[图片，未提供图片内容]',kind:'2',depth:0}],truncated:false,unavailable:false};
const payload = extra => ({ event:'message.new',sessionId:'filehelper',talkerId:'filehelper',conversationId:uiOneBotId('filehelper'),isSend:false,rawid:'fixture-event',timestamp:1,...extra });

test('link, file and named cards retain their descriptions without generating downloadable file references',t=>{
  const backend=fixture(t);
  for(const [kind,row,label] of [
    ['link',{type:5*2**32+49,link:{title:'行程',url:'https://example.org/schedule'}},'行程'],
    ['file',{type:6*2**32+49,file:{name:'旅行表.pdf',size:2345}},'旅行表.pdf'],
    ['card',{type:48,card:{label:'位置',title:'东门',summary:'滨海路'}},'滨海路'],
    ['image',{type:3,attachmentUnavailable:true},'附件内容不可用'],
    ['voice',{type:34,attachmentUnavailable:true},'附件内容不可用']
  ]){
    const event=backend.incoming(payload({...row,rawid:kind}));
    const msg=normalizeOneBotEvent('wechat','ui',event);
    assert.equal(msg.quoteKind,kind);
    assert(msg.text.includes(label));assert.equal(msg.files.length,0);
  }
  assert.equal(backend.incoming(payload({type:49,link:{title:'bad',url:'file:///fixture'}})),null);
  const rawid='e'.repeat(64),file={id:rawid,name:'readme.txt',size:10};
  const bound=backend.incoming(payload({type:6*2**32+49,rawid,file}));
  assert.deepEqual(normalizeOneBotEvent('wechat','ui',bound).files,[file]);
  assert.deepEqual(normalizeUiIncomingContent({type:49,rawid:'d'.repeat(64),file},{}).segments.map(s=>s.type),['text']);
  assert.equal(normalizeUiIncomingContent({type:49,file:{name:'未知大小.pdf'}},{}).content,'[文件] 未知大小.pdf');
});

test('notices in a private chat keep its conversation id and never impersonate the contact',t=>{
  const backend=fixture(t),system='wechat-system';
  const row={type:10000,talkerId:system,other:{label:'微信通知',summary:'撤回了一条消息',contextOnly:true}};
  const msg=normalizeOneBotEvent('wechat','ui',backend.incoming(payload(row)));
  assert.equal(msg.contextOnly,true);
  assert.equal(msg.conversation_id,uiOneBotId('filehelper'));
  assert.equal(msg.sender_id,uiOneBotId(system));assert.equal(msg.sender_name,'微信系统');
  assert.equal(backend.incoming(payload({...row,rawid:'bad',other:{...row.other,contextOnly:false}})),null);
  assert.equal(backend.incoming(payload({type:1,talkerId:system,rawid:'plain',content:'hello'})),null);
});

for(const [kind,mediaKind] of [[34,'audio'],[43,'video'],[62,'video']])test('formal adapter admits bound Reader media type '+kind+' and rejects unbound OneBot URLs',t=>{
  const backend=fixture(t),adapter=new WechatOneBotAdapter(),received=[];
  adapter.on('message',message=>received.push(message));
  const event=backend.incoming(payload({type:kind,media:[{id,kind:mediaKind}]}));
  adapter.server.emit('event',event);
  assert.equal(received.length,1);assert.deepEqual(received[0].media,[{id,kind:mediaKind}]);
  assert.equal(received[0].message_type,mediaKind==='audio'?'record':'video');
  adapter.server.emit('event',{...event,message_id:'fixture-unbound',wechatagent:{},message:[{type:'text',data:{text:'untrusted attachment'}},{type:mediaKind==='audio'?'record':'video',data:{file:'https://example.com/private-media'}}]});
  adapter.server.emit('event',{...event,message_id:'fixture-mismatch',wechatagent:{media:[{id:'b'.repeat(64),kind:mediaKind}]}});
  assert.equal(received.length,1);
  assert.equal(backend.outbox.list().length,0);
});

function fixture(t, options={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ui-media-fixture-'));
  const policy={accountWxid:'fixture-self',targets:[{kind:'private',wxid:'filehelper',id:uiOneBotId('filehelper')}]};
  const backend=new UiOneBotBackend({directory,policy,driver:{observe:async()=>({ready:false})},...options});
  t.after(async()=>{await backend.shutdown();assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});});
  return backend;
}

for (const [kind,label] of [[3,'image'],[47,'sticker']]) test(label+' passes from UI Reader to typed DSH input without raw XML or paths',t=>{
  const backend=fixture(t);
  const event=backend.incoming(payload({type:kind,content:'<private-xml/>',image:{id,path:'C:/private.png',token:'private-token'},reader_token:'private-token'}));
  const normalized=normalizeOneBotEvent('wechat','wechat-onebot',event);
  assert.deepEqual(normalized.images,[{id,...(kind===47?{kind:'sticker'}:{})}]);
  assert.equal(normalized.message_type,'image');
  for(const hidden of ['private-xml','private.png','private-token'])assert.equal(JSON.stringify(event).includes(hidden),false);
  assert.equal(backend.incoming(payload({type:kind,image:{id}})),null);
  assert.ok(backend.incoming(payload({type:kind,image:{id}}),{replay:true}));
  assert.equal(backend.outbox.list().length,0);
});

test('quote attribution is derived from bound account; reference content remains historical',t=>{
  const backend=fixture(t),event=backend.incoming(payload({type:QUOTE_TYPE,content:'<xml/>',quoteReply:{...quote,reference:{...quote.reference,senderRelation:'other',token:'secret'}}}));
  const normalized=normalizeOneBotEvent('wechat','wechat-onebot',event);
  assert.equal(normalized.quoteReply.reference.senderRelation,'self');
  assert.match(quoteReplyText(normalized.quoteReply),/历史消息/);assert.equal(normalized.text,'这是新回复');
  assert.equal(JSON.stringify(event).includes('secret'),false);
  const unrelated=normalizeUiIncomingContent(payload({type:49,quoteReply:{...quote,reference:{...quote.reference,senderId:'stranger',senderRelation:'self'}}}),{accountWxid:'fixture-self'});
  assert.equal(unrelated.metadata.quoteReply.reference.senderRelation,'unknown');
  const crossGroup=normalizeUiIncomingContent({...payload({type:49,quoteReply:{...quote,reference:{...quote.reference,conversationId:'wrong@chatroom'}}}),sessionId:'selected@chatroom'},{accountWxid:'fixture-self',group:true});
  assert.equal(crossGroup.metadata.quoteReply.reference.senderRelation,'unknown');
});

test('merged records preserve bounded history and unavailable attachment descriptions',t=>{
  const backend=fixture(t),event=backend.incoming(payload({type:FORWARD_TYPE,content:'<xml/>',forwardedRecord:{...record,sourcePath:'private'}}));
  const normalized=normalizeOneBotEvent('wechat','wechat-onebot',event);
  assert.deepEqual(normalized.forwardedRecord,record);
  const text=forwardedRecordText(normalized.forwardedRecord);
  assert.match(text,/不是当前聊天参与者的新消息/);assert.match(text,/未提供图片内容/);
  assert.equal(JSON.stringify(event).includes('sourcePath'),false);
});

test('bound quote and forward attachments remain historical and retain their type',t=>{
  const backend=fixture(t);
  const event=backend.incoming(payload({type:QUOTE_TYPE,quoteReply:quote,images:[{id,sourceLabel:'引用原消息'}],media:[{id:'b'.repeat(64),kind:'audio',sourceLabel:'引用原消息'}]}));
  assert.equal(event.message[1].data.media_label,'引用原消息');
  assert.deepEqual(event.wechatagent.media,[{id:'b'.repeat(64),kind:'audio',sourceLabel:'引用原消息'}]);
  const normalized=normalizeOneBotEvent('wechat','wechat-onebot',event);
  assert.equal(normalized.quoteReply.reference.senderRelation,'self');
  assert.equal(normalized.images[0].id,id);
  assert.equal(normalizeUiIncomingContent(payload({type:49,forwardedRecord:record,images:[{id,sourceLabel:'x'.repeat(81)}]})),null);
  assert.equal(normalizeUiIncomingContent(payload({type:49,forwardedRecord:record,media:[{id,kind:'text',sourceLabel:'转发第1条'}]})),null);
});

test('all media preserve selected-account admission and exact target checks',t=>{
  let allowed=true,calls=0;
  const store={get:()=>({targets:[{wxid:'filehelper',id:uiOneBotId('filehelper')}]}),grantIncoming:()=>{calls++;if(!allowed)throw new Error('revoked');return{fixture:true};},admitDelivery:()=>{},authorizeDelivery:()=>true};
  const backend=fixture(t,{selectionStore:store}),incoming=payload({type:3,image:{id}});
  assert.equal(backend.incoming({...incoming,sessionId:'another'}),null);
  assert.equal(backend.incoming({...incoming,talkerId:'fixture-self'}),null);
  assert.equal(backend.incoming({...incoming,conversationId:'9'}),null);
  assert.equal(backend.incoming({...incoming,isSend:true}),null);assert.equal(calls,0);
  allowed=false;assert.equal(backend.incoming(incoming),null);allowed=true;
  assert.deepEqual(backend.incoming(incoming).wechatagent.selectionScope,{fixture:true});assert.equal(calls,2);
});

test('unsupported and malformed content cannot consume an event identity or impersonate attachments',t=>{
  const backend=fixture(t);
  for(const part of [{type:3,image:{id:'../private'}},{type:3,content:'wechatagent://image/'+id},{type:47,image:{id:id.toUpperCase()}},
    {type:49,content:'<appmsg>unparsed</appmsg>'},{type:49,quoteReply:quote,forwardedRecord:record},{type:QUOTE_TYPE,quoteReply:{...quote,reply:'\ud800'}},
    {type:FORWARD_TYPE,forwardedRecord:{...record,items:Array(51).fill(record.items[0])}},{type:10000,content:'system'},
    {type:34,media:[{id,kind:'video'}]},{type:43,media:[{id,kind:'audio'}]},{type:34,media:[{id,kind:'audio'},{id,kind:'audio'}]}])assert.equal(backend.incoming(payload(part)),null);
  assert.ok(backend.incoming(payload({type:1,content:'same identity is still usable'})));
});

for(const [kind,mediaKind,segment] of [[34,'audio','record'],[43,'video','video'],[62,'video','video']])test('Reader type '+kind+' accepts only bound media references',()=>{
  const result=normalizeUiIncomingContent(payload({type:kind,media:[{id,kind:mediaKind,path:'private'}]}));
  assert.deepEqual(result.metadata.media,[{id,kind:mediaKind}]);
  assert.deepEqual(result.segments[1],{type:segment,data:{file:'wechatagent://media/'+id,media_id:id,media_kind:mediaKind}});
  assert.equal(JSON.stringify(result).includes('private'),false);
});
