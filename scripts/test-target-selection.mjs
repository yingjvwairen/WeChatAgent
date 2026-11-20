import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { TargetSelectionStore, createSelectionGuardedDriver } from './target-selection.mjs';
import { UiOneBotBackend, createReceiptUiDriver, uiOneBotId } from './ui-onebot.mjs';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { SocialEngine, isDirectMention } from '../components/qq-bridge/src/core/social-engine.js';
import { MessageBuffer,createOfflineIntake } from '../components/qq-bridge/src/core/message-buffer.js';
import { DshConnectionGuard } from '../components/qq-bridge/src/core/dsh-connection.js';
import { HistoryStore } from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import { scopeHistory } from '../packages/dsh-social-bridge-plugin/work-modes.mjs';
import { selectionScopeFields } from '../components/qq-bridge/src/core/selection-scope.js';

test('optional paste keeps target selection revocation active throughout native preparation',async()=>{
  let allowed=true,upstream=true,calls=0,check;
  const driver=createSelectionGuardedDriver({store:{authorizeDelivery:()=>allowed},driver:{pasteText:async(_job,guard)=>{calls++;check=guard.canInput;return{performed:true};}}});
  await driver.pasteText({id:'fixture'},{text:'测试',canInput:()=>upstream});assert.equal(check(),true);
  upstream=false;assert.equal(check(),false);upstream=true;allowed=false;assert.equal(check(),false);
  assert.equal((await driver.pasteText({id:'fixture'},{})).attempted,false);assert.equal(calls,1);
  const unavailable=createSelectionGuardedDriver({store:{authorizeDelivery:()=>true},driver:{}});assert.equal(unavailable.pasteText,undefined);
});

test('read-only voice handoff preflight cannot bypass the selected target or cancellation signal',async()=>{
  let allowed=true,calls=0;const driver=createSelectionGuardedDriver({store:{authorizeDelivery:()=>allowed},driver:{prepareVoiceHandoff:async()=>{calls++;return{ready:true};}}});
  assert.equal((await driver.prepareVoiceHandoff({},{})).ready,true);allowed=false;assert.equal((await driver.prepareVoiceHandoff({},{})).ready,false);
  allowed=true;assert.equal((await driver.prepareVoiceHandoff({},{signal:AbortSignal.abort()})).ready,false);assert.equal(calls,1);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-selection-fixture-'));
  const directory = path.join(root, 'state/reader-service'); fs.mkdirSync(directory, { recursive: true });
  const accountRef = 'a'.repeat(64), original = { version: 1, accountRef, targetWxid: 'fixture-first', targetId: uiOneBotId('fixture-first'),
    displayName: 'First choice', alias: 'fixture-alias', autoSend: false, onScreenVerified: false };
  fs.writeFileSync(path.join(directory, 'target.json'), JSON.stringify(original));
  const resolveTargets = async targets => targets.map(wechatId => ({ wechatId, id: uiOneBotId(wechatId), name: 'Same display name', alias: '', ambiguous: false }));
  const store = new TargetSelectionStore({ root, accountRef, resolveTargets });
  const job = (target = 'fixture-first', digit = '1') => ({ id: digit.repeat(64), account: 'fixture-self', target, text: 'fixture reply' });
  const scope = job => store.grantIncoming({ account: job.account, target: job.target, eventId: 'event-' + job.id, selectionVersion: store.get().version });
  t.after(() => {
    const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^target-selection-fixture-/); fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, directory, store, job, scope, accountRef, original, resolveTargets };
}
test('first-choice import preserves legacy binding and never enables automatic replies', t => {
  const f = fixture(t), selection = f.store.get();
  assert.equal(selection.version, 1); assert.equal(selection.targets[0].wxid, f.original.targetWxid);
  assert.equal(selection.automaticReplies, false); assert.deepEqual(f.store.get(), selection);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'target.json'), 'utf8')), f.original);
});
test('existing selection and authorization stay readable during a real write lock while mutations remain exclusive', async t => {
  const f=fixture(t),selection=f.store.get(),job=f.job(),scope=f.scope(job);f.store.admitDelivery(job,{selectionScope:scope});
  const file=path.join(f.directory,'selection.lock'),owner='fixture-writer',fd=fs.openSync(file,'wx');fs.writeFileSync(fd,owner);
  const before=fs.readFileSync(f.store.file);
  try {
    const other=new TargetSelectionStore({root:f.root,accountRef:f.accountRef,resolveTargets:f.resolveTargets});
    assert.deepEqual(other.get(),selection);assert.equal(other.authorizeDelivery(job),true);assert.equal(other.authorizeReplyScope(scope),true);
    await assert.rejects(other.replace({expectedVersion:selection.version,targetWxids:[]}),{code:'UI_TARGET_SELECTION_BUSY'});
    assert.throws(()=>other.grantIncoming({account:job.account,target:job.target,eventId:'another-event',selectionVersion:selection.version}),{code:'UI_TARGET_SELECTION_BUSY'});
    assert.throws(()=>other.admitDelivery({...job,id:'2'.repeat(64)},{selectionScope:scope}),{code:'UI_TARGET_SELECTION_BUSY'});
    assert.deepEqual(fs.readFileSync(f.store.file),before);assert.equal(fs.readFileSync(file,'utf8'),owner);
  } finally {fs.closeSync(fd);fs.unlinkSync(file);}
  assert.equal((await f.store.replace({expectedVersion:selection.version,targetWxids:[]})).version,selection.version+1);
});
test('missing selection cannot initialize through another writer lock and retries after release without nested locks', t => {
  const f=fixture(t),file=path.join(f.directory,'selection.lock'),fd=fs.openSync(file,'wx');fs.writeFileSync(fd,'initializing');
  try {
    assert.throws(()=>f.store.get(),{code:'UI_TARGET_SELECTION_BUSY'});assert.equal(fs.existsSync(f.store.file),false);
    assert.equal(fs.readFileSync(file,'utf8'),'initializing');
  } finally {fs.closeSync(fd);fs.unlinkSync(file);}
  const first=f.store.get();assert.equal(first.version,1);assert.equal(first.targets[0].wxid,f.original.targetWxid);
  assert.equal(fs.existsSync(file),false);assert.deepEqual(f.store.get(),first);
});
test('concurrent independent initialization publishes one stable grant and every retry reads the same complete snapshot', async t => {
  const f=fixture(t),children=[],moduleUrl=pathToFileURL(path.join(import.meta.dirname,'target-selection.mjs')).href;
  const source=`import {TargetSelectionStore} from ${JSON.stringify(moduleUrl)};
    const store=new TargetSelectionStore({root:process.argv[1],accountRef:process.argv[2]});
    process.send({ready:true});process.once('message',()=>{try{process.send({selection:store.get()});}catch(error){process.send({code:error.code});}process.disconnect();});`;
  const outcomes=[];
  try {
    for(let index=0;index<4;index++){
      const child=spawn(process.execPath,['--input-type=module','--eval',source,f.root,f.accountRef],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
      children.push(child);const [ready]=await once(child,'message');assert.equal(ready.ready,true);
    }
    const results=children.map(async child=>{const message=once(child,'message'),closed=once(child,'close');child.send({start:true});const [result]=await message;const [code]=await closed;assert.equal(code,0);return result;});
    outcomes.push(...await Promise.all(results));
  } finally {for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();}
  const successes=outcomes.filter(value=>value.selection);assert(successes.length>=1);
  assert(outcomes.every(value=>value.selection||value.code==='UI_TARGET_SELECTION_BUSY'));
  const published=f.store.get();for(const result of successes)assert.deepEqual(result.selection,published);
  assert.equal(published.version,1);assert.equal(published.targets.length,1);assert.equal(fs.existsSync(path.join(f.directory,'selection.lock')),false);
  assert.deepEqual(new TargetSelectionStore({root:f.root,accountRef:f.accountRef}).get(),published);
});
test('multiple stable IDs and empty selection use versioned compare-and-swap', async t => {
  const f = fixture(t), first = f.store.get();
  const second = await f.store.replace({ expectedVersion: first.version, targetWxids: ['fixture-first', 'fixture-second'] });
  assert.equal(second.version, 2); assert.equal(second.targets.length, 2);
  assert.equal(second.targets[0].label, second.targets[1].label);
  assert.equal(second.targets[0].grantId, first.targets[0].grantId);
  await assert.rejects(f.store.replace({ expectedVersion: 1, targetWxids: [] }), { code: 'UI_TARGET_SELECTION_VERSION_CONFLICT' });
  const empty = await f.store.replace({ expectedVersion: 2, targetWxids: [] }); assert.deepEqual(empty.targets, []);
});
test('selected group binds room identity, member identity and mentions without granting a private route', async t => {
  const f=fixture(t),room='fixture-room@chatroom';
  f.store.resolveTargets=async ids=>ids.map(wechatId=>({wechatId,id:uiOneBotId(wechatId),name:'研发组',alias:'',ambiguous:false,kind:'group',groupName:'研发组',uniqueSearchName:true}));
  const selected=await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[room]});
  const driver={observe:async()=>({ready:false}),receipt:async()=>({confirmed:false}),close(){}};
  const backend=new UiOneBotBackend({directory:path.join(f.root,'group-outbox'),policy:{accountWxid:'fixture-self',targets:[]},selectionStore:f.store,driver});
  t.after(()=>backend.stop());
  const payload={event:'message.new',type:1,isSend:false,sessionId:room,talkerId:'fixture-member',conversationId:uiOneBotId(room),content:'群消息',mentionsSelf:true,rawid:'group-event',timestamp:Date.now()/1000,selectionVersion:selected.version};
  const event=backend.incoming(payload);
  assert.equal(event.message_type,'group');assert.equal(String(event.group_id),uiOneBotId(room));assert.equal(event.group_name,'研发组');assert.equal(event.wechatagent.senderWxid,'fixture-member');
  assert.deepEqual(event.message.find(item=>item.type==='at'),{type:'at',data:{qq:uiOneBotId('fixture-self')}});
  const normalized={platform:'wechat',kind:'group',self_id:uiOneBotId('fixture-self'),conversation_id:uiOneBotId(room),ui_selection_required:true,ui_reply_scope:event.wechatagent.selectionScope};
  assert.equal(selectionScopeFields(normalized).ui_reply_scope.target,room);
  assert.throws(()=>selectionScopeFields({...normalized,kind:'private'}),{code:'UI_SELECTION_SCOPE_REQUIRED'});
  const params={wechatagent_delivery_protocol:'durable-ui-v1',wechatagent_delivery_id:'e'.repeat(64),self_id:uiOneBotId('fixture-self'),group_id:uiOneBotId(room),wechatagent_selection_scope:event.wechatagent.selectionScope,message:[{type:'text',data:{text:'群回复'}}]};
  assert.equal((await backend.action({action:'send_group_msg',params})).status,'ok');
  assert.equal((await backend.action({action:'send_private_msg',params:{...params,user_id:params.group_id}})).status,'failed');
  await f.store.replace({expectedVersion:selected.version,targetWxids:[]});
  assert.equal(f.store.authorizeReplyScope(event.wechatagent.selectionScope),false);
  const query=await backend.action({action:'get_wechatagent_delivery',params:{...params,kind:'group',target:uiOneBotId(room)}});
  assert.equal(query.status,'ok');assert.equal(query.data.kind,'group');
  assert.equal(backend.incoming({...payload,rawid:'late'}),null);
});
test('a real @all in a selected mention-only group wakes once, even at zero reply probability', async t=>{
  const f=fixture(t),room='fixture-room@chatroom',roomId=uiOneBotId(room);
  f.store.resolveTargets=async()=>[{wechatId:room,id:roomId,name:'项目组',alias:'',ambiguous:false,kind:'group',groupName:'项目组',uniqueSearchName:true}];
  const selected=await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[room]});
  const backend=new UiOneBotBackend({directory:path.join(f.root,'outbox'),policy:{accountWxid:'fixture-self',targets:[]},selectionStore:f.store,driver:{observe:async()=>({ready:false}),close(){}}});
  const adapter=new WechatOneBotAdapter(), buffer=new MessageBuffer(path.join(f.root,'messages.json'));
  let decisions=0, sent=0;
  const engine=new SocialEngine({
    buffer,mode:'mention',batchMs:1,wakeWords:['小助手'],
    stickerPolicyFor:()=>({enabled:false}),
    decide:async()=>{decisions++;return 'RESPOND: 收到。';},
    send:async(message)=>{
      assert.equal(message.conversation_id,roomId);
      assert.equal(f.store.authorizeReplyScope(message.ui_reply_scope),true);
      sent++;return {confirmed:true};
    }
  });
  t.after(()=>{engine.stop();backend.stop();});
  adapter.server.emit('event',backend.meta());
  adapter.on('message',message=>engine.receive(message));
  const payload={event:'message.new',type:1,isSend:false,sessionId:room,talkerId:'fixture-member',conversationId:roomId,
    content:'@所有人 周五开会',timestamp:Date.now()/1000,selectionVersion:selected.version,mentionsSelf:false};
  const plain=backend.incoming({...payload,rawid:'plain'});
  assert.equal(plain.message.some(s=>s.type==='at'),false);
  adapter.server.emit('event',plain);
  assert.equal(buffer.recent('wechat:group:'+roomId)[0].direct_mention,false);
  const broadcast=backend.incoming({...payload,rawid:'broadcast',mentionsAll:true});
  assert.deepEqual(broadcast.message.filter(s=>s.type==='at'),[{type:'at',data:{qq:'all'}}]);
  adapter.server.emit('event',broadcast);
  adapter.server.emit('event',broadcast);
  for(let i=0;sent===0&&i<400;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(sent,1);assert.equal(decisions,1);
  assert.equal(buffer.recent('wechat:group:'+roomId).filter(row=>row.message_id==='broadcast'&&row.direct_mention).length,1);
  assert.equal(backend.incoming({...payload,sessionId:'unselected@chatroom',mentionsAll:true,rawid:'elsewhere'}),null);
});

test('offline Reader messages use each chat policy and retain explicit context-only history',async t=>{
  const f=fixture(t),room='room@chatroom',peer='fixture-first';
  f.store.resolveTargets=async names=>names.map(wechatId=>({wechatId,id:uiOneBotId(wechatId),name:'fixture',alias:'',ambiguous:false,
    ...(wechatId===room?{kind:'group',groupName:'fixture',uniqueSearchName:true}:{})}));
  const selection=await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[room,peer]});
  const backend=new UiOneBotBackend({directory:path.join(f.root,'outbox'),policy:{accountWxid:'fixture-self',targets:[]},selectionStore:f.store,driver:{observe:async()=>({ready:false}),close(){}}});
  const store=new HistoryStore(f.root,f.accountRef),history=scopeHistory(store,(_key,row)=>row?.work_mode??'social');
  const file=path.join(f.root,'messages.json'),buffer=new MessageBuffer(file,{archive:history});
  const connection=new DshConnectionGuard({buffer,probe:async()=>({ready:true,instanceId:'fixture'})});
  let mode='hybrid',workMode='social';
  const engine=new SocialEngine({buffer,connection,wakeWords:['小助手'],modeFor:()=>mode,workModeFor:()=>workMode,assistantAccess:()=>true,assistantBatchMs:1,
    minIntervalMs:0,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,batchMs:1,
    decide:async(_key,prompt)=>{prompts.push(prompt);decisions++;return 'RESPOND: 回复';},send:async()=>{sent++;return{confirmed:true};}});
  const prompts=[];
  let decisions=0,sent=0,acks=0,ordinal=0;
  const deliver=(message,replay=message.offline_replay)=>{
    message={...message,offline_replay:replay};
    assert(f.store.authorizeReplyScope(message.ui_reply_scope));engine.receive(message);return buffer.persistedIncoming(message);
  };
  const fold=createOfflineIntake(buffer,msg=>engine.offlineEligible('wechat:'+msg.kind+':'+msg.conversation_id,msg)?workMode:null,deliver);
  const adapter=new WechatOneBotAdapter({acceptUiMessage:message=>message.offline_batch?fold(message):deliver(message)});
  adapter.server.action=async action=>{assert.equal(action,'ack_wechatagent_intake');acks++;};
  adapter.server.emit('event',backend.meta());
  const key='wechat:group:'+uiOneBotId(room),timestamp=Math.floor(Date.now()/1000)-10800;
  try{
    await connection.check();
    const until=async predicate=>{const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw Error('offline intake timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
    const emit=async(id,content,{target=room,...extra}={})=>{
      const event=backend.incoming({event:'message.new',type:1,isSend:false,sessionId:target,talkerId:target===peer?peer:'fixture-member',conversationId:uiOneBotId(target),rawid:id,timestamp,selectionVersion:selection.version,offlineReplay:'reply',content,...extra},{replay:true});
      assert.ok(event);assert.equal(event.time,extra.timestamp??timestamp);
      event.wechatagent.intake={version:1,cursor:'a'.repeat(32)+':'+(++ordinal),token:'1'.repeat(64)};
      const next=acks+1;adapter.server.emit('event',event);await until(()=>acks===next);
    };
    await emit('old-chat','手打 @所有人，会议3点',{offlineReplay:'context'});
    await emit('old-control','取消任务',{offlineReplay:'context',mentionsSelf:true});
    await emit('later-context','稍后的事情',{timestamp:timestamp+1,offlineReplay:'context'});
    assert.equal(buffer.unread(key).length,0);
    for(const row of buffer.recent(key)){assert.equal(row.offline_replay,'context');assert.equal(row.processed,true);assert.equal(row.direct_mention,false);}
    const restored=new MessageBuffer(file,{archive:history});
    assert.equal(restored.unread(key).length,0);
    assert.equal(store.windowRows(key,{recentMessages:5})[0].offline_replay,'context');
    engine.replay(key);await new Promise(resolve=>setTimeout(resolve,15));assert.equal(sent,0);assert.equal(decisions,0);
    mode='mention';
    for(const [index,trigger] of [['self',{mentionsSelf:true}],['all',{mentionsAll:true}],['wake',{}],['dm',{target:peer}]].entries()){
      const [id,extra]=trigger;await emit(id,id==='wake'?'请小助手看下':'这是一条消息',extra);
      await until(()=>sent===index+1);
    }
    assert.equal(decisions,4);await emit('wake','请小助手看下');assert.equal(decisions,4);
    assert.match(prompts[2],/<offline_chat_history>.*会议3点.*<\/offline_chat_history>/);
    assert.doesNotMatch(prompts[2].split('<untrusted_chat>')[1],/会议3点/);
    assert.doesNotMatch(prompts[2],/稍后的事情/);
    assert.doesNotMatch(prompts[3],/会议3点/);
    mode='hybrid';
    await emit('ordinary-group','这是一条普通群消息');
    await until(()=>sent===5);
    assert.equal(buffer.recent(key).find(row=>row.message_id==='ordinary-group').direct_mention,false);
    assert.equal(buffer.recent(key).find(row=>row.message_id==='ordinary-group').offline_replay,'reply');
    await emit('ordinary-group','这是一条普通群消息');assert.equal(decisions,5);
    mode='mention';
    await emit('mention-only','只等有人叫它');
    engine.replay(key);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(decisions,5);
    await emit('mention-after-ordinary','小助手，接着说');
    await until(()=>sent===6);
    assert.match(prompts[5],/只等有人叫它/);
    workMode='assistant';await emit('assistant-context','管理员的背景资料',{offlineReplay:'context'});
    await emit('assistant-wake','小助手，继续');await until(()=>sent===7);
    assert.match(prompts[6],/管理员的背景资料/);assert.doesNotMatch(prompts[6],/会议3点/);
    assert.equal(store.windowRows(key+':assistant',{recentMessages:5})[0].text,'管理员的背景资料');
    assert(!store.windowRows(key,{recentMessages:30}).some(row=>row.text==='管理员的背景资料'));
    mode='hybrid';
    await emit('assistant-ordinary','处理这项工作');await until(()=>sent===8);
    workMode='social';mode='hybrid';
    const batch={id:'a'.repeat(64),last:false};
    // Space events beyond the normal chat debounce to cover a slow Reader.
    for(let n=0;n<34;n++)await emit('history-'+n,'闲聊 '+n,{offlineBatch:batch});
    assert.equal(sent,8);assert.equal(decisions,8);
    const held=new MessageBuffer(file);
    assert.equal(held.offlineCandidate.message.message_id,'history-33');
    await emit('history-end','最后的近况',{offlineBatch:{...batch,last:true}});
    await until(()=>sent===9);
    assert.equal(decisions,9);assert.match(prompts[8],/你刚回到聊天/);
    assert.match(prompts[8].split('<untrusted_chat>')[1],/最后的近况/);
    assert.match(prompts[8].split('<untrusted_chat>')[0],/闲聊 33/);
    assert.equal(new MessageBuffer(file).offlineCandidate,null);
    mode='mention';
    const other={id:'b'.repeat(64),last:false};
    await emit('earlier-at','一条被点名的问题',{offlineBatch:other,mentionsAll:true});
    await emit('unrelated-final','围观者的闲聊',{offlineBatch:{...other,last:true},timestamp:timestamp+2});
    await until(()=>sent===10);assert.equal(decisions,10);
    assert.match(prompts[9].split('<untrusted_chat>')[1],/一条被点名的问题/);
    assert.doesNotMatch(prompts[9].split('<untrusted_chat>')[1],/围观者的闲聊/);
    assert.match(prompts[9].split('<untrusted_chat>')[0],/围观者的闲聊/);
    await emit('unrelated-final','围观者的闲聊',{offlineBatch:{...other,last:true},timestamp:timestamp+2});
    assert.equal(decisions,10);
    let silentTurns=0;
    engine.decide=async()=>{silentTurns++;return 'SILENT';};
    const dmBatch={id:'d'.repeat(64),last:false};
    await emit('old-private','之前想问',{target:peer,offlineBatch:dmBatch});
    await emit('old-private-done','已经解决啦',{target:peer,offlineBatch:{...dmBatch,last:true}});
    await until(()=>silentTurns===1&&buffer.unread('wechat:private:'+uiOneBotId(peer)).length===0);
    assert.equal(sent,10);
    const denied=backend.incoming({event:'message.new',type:1,isSend:false,sessionId:room,talkerId:'fixture-member',
      conversationId:uiOneBotId(room),rawid:'malformed',timestamp,selectionVersion:selection.version,offlineReplay:'other',content:'小助手'});
    assert.equal(denied,null);
  }finally{engine.stop();connection.stop();backend.stop();store.close();}
});

test('offline pages cannot evict waiting replies from the recent buffer, including after restart',t=>{
  const f=fixture(t),file=path.join(f.root,'small-buffer.json');
  const buffer=new MessageBuffer(file,{maxPerChat:10}),key='wechat:private:12';
  const input=(n,mode)=>({platform:'wechat',kind:'private',conversation_id:'12',self_id:'1',sender_id:'12',message_id:String(n),text:'row '+n,timestamp:n,offline_replay:mode});
  for(let n=1;n<=17;n++)buffer.append(input(n,'reply'));
  for(let n=18;n<=38;n++)buffer.append(input(n,'context'));
  const restored=new MessageBuffer(file,{maxPerChat:10});
  assert.deepEqual(restored.unread(key,100).map(row=>row.message_id),Array.from({length:17},(_,i)=>String(i+1)));
  restored.markProcessed(key,restored.unread(key,100).at(-1).id);
  assert.equal(restored.unread(key,100).length,0);
  assert.ok(new MessageBuffer(file,{maxPerChat:10}).chats.get(key).length<=10);
});

test('the catch-up candidate survives a restart and its own work channel is rechecked at release',async t=>{
  const f=fixture(t),file=path.join(f.root,'chat.json'),account='fixture-self';
  const selected=await f.store.replace({expectedVersion:f.store.get().version,targetWxids:['fixture-first']});
  const peer=selected.targets[0].wxid;
  const backend=new UiOneBotBackend({directory:path.join(f.root,'outbox'),policy:{accountWxid:account,targets:[]},selectionStore:f.store,driver:{observe:async()=>({ready:false}),close(){}}});
  const batch={id:'c'.repeat(64),last:false};
  const events=[];
  const adapter=new WechatOneBotAdapter({acceptUiMessage:async msg=>{events.push(msg);return true;}});
  adapter.server.action=async()=>{};adapter.server.emit('event',backend.meta());
  for(const [id,last] of [['before-restart',false],['after-restart',true]]){
    const wire=backend.incoming({event:'message.new',type:1,isSend:false,sessionId:peer,talkerId:peer,
      conversationId:uiOneBotId(peer),rawid:id,timestamp:12345,selectionVersion:selected.version,
      offlineReplay:'reply',offlineBatch:{...batch,last},content:'消息 '+id},{replay:true});
    wire.wechatagent.intake={version:1,cursor:'a'.repeat(32)+':1',token:'1'.repeat(64)};
    adapter.server.emit('event',wire);await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(events.length,2);
  const lane=m=>m.message_id==='before-restart'?'assistant':null,delivered=[];
  const deliver=async(m,mode,expectedLane)=>{delivered.push([m.message_id,mode,expectedLane]);return true;};
  await createOfflineIntake(new MessageBuffer(file),lane,deliver)(events[0]);
  assert.equal(delivered.length,0);
  const reopened=new MessageBuffer(file);
  assert.equal(reopened.offlineCandidate.message.raw,undefined);
  await createOfflineIntake(reopened,()=>null,deliver)(events[1]);
  assert.deepEqual(delivered,[['after-restart','context',undefined],['before-restart','context','assistant']]);
  assert.equal(new MessageBuffer(file).offlineCandidate,null);backend.stop();
});

test('upgrading old offline rows coalesces untouched work and preserves an admitted batch and live input',t=>{
  const f=fixture(t),file=path.join(f.root,'legacy.json'),buf=new MessageBuffer(file);
  const key='wechat:group:123',base={platform:'wechat',kind:'group',conversation_id:'123',sender_id:'45',work_mode:'social'};
  const add=(text,extra={})=>buf.append({...base,text,message_id:text,offline_replay:'reply',...extra});
  const claimed=add('admitted'),obsolete=add('before reconnect'),live=add('live',{offline_replay:undefined});
  const background=add('aside'),anchor=add('wake',{direct_mention:true}),last=add('more chatter');
  buf.pendingRequests.set(key,{rowIds:[claimed.id],throughId:claimed.id});
  buf.foldLegacyOffline(key,r=>r.direct_mention);
  assert.equal(claimed.processed,false);assert.equal(claimed.offline_batch_id,undefined);
  for(const r of [obsolete,background,last])assert.equal(r.offline_replay,'context');
  assert.equal(live.processed,false);assert.equal(live.offline_batch_id,undefined);
  assert.deepEqual(buf.unread(key).map(r=>r.text),['admitted','live','wake']);
  assert.equal(anchor.offline_batch_id,last.offline_batch_id);
  assert.notEqual(anchor.offline_batch_id,obsolete.offline_batch_id);
  buf.pendingRequests.clear();buf.saveMedia();
  const again=new MessageBuffer(file);again.foldLegacyOffline(key,r=>r.direct_mention);
  assert.equal(again.recent(key).find(r=>r.id===anchor.id).processed,false);
});

test('only a top-level at segment marks the whole WeChat group as addressed',()=>{
  const base={platform:'wechat',kind:'group',self_id:'123',text:'引用了一句 @所有人'};
  assert.equal(isDirectMention({...base,segments:[{type:'text',data:{text:'[CQ:at,qq=all]'}}]}),false);
  assert.equal(isDirectMention({...base,segments:[{type:'forward',data:{message:[{type:'at',data:{qq:'all'}}]}}]}),false);
  assert.equal(isDirectMention({...base,segments:[{type:'at',data:{qq:'456'}}]}),false);
  assert.equal(isDirectMention({...base,kind:'private',segments:[{type:'at',data:{qq:'all'}}]}),false);
  assert.equal(isDirectMention({...base,segments:[{type:'at',data:{qq:'123'}}]}),true);
});

test('group selection rejects unverified or duplicate names before writing a grant', async t=>{
  const f=fixture(t),room='fixture-room@chatroom',before=f.store.get();
  await assert.rejects(f.store.replace({expectedVersion:before.version,targetWxids:[room]}),{code:'UI_TARGET_SELECTION_CONTACT_UNVERIFIED'});
  f.store.resolveTargets=async()=>[{wechatId:room,id:uiOneBotId(room),name:'同名群',alias:'',ambiguous:true,kind:'group',groupName:'同名群',uniqueSearchName:false}];
  await assert.rejects(f.store.replace({expectedVersion:before.version,targetWxids:[room]}),{code:'UI_TARGET_SELECTION_CONTACT_UNVERIFIED'});
  assert.deepEqual(f.store.get(),before);
});
test('removal revokes old deliveries permanently even after target re-selection', async t => {
  const f = fixture(t); f.store.get(); const old = f.job();
  const oldScope = f.scope(old);
  f.store.admitDelivery(old, { selectionScope: oldScope }); assert.equal(f.store.authorizeDelivery(old), true);
  await f.store.replace({ expectedVersion: 1, targetWxids: ['fixture-second'] });
  assert.equal(f.store.authorizeDelivery(old), false);
  await f.store.replace({ expectedVersion: 2, targetWxids: ['fixture-first', 'fixture-second'] });
  assert.equal(f.store.authorizeDelivery(old), false);
  assert.throws(() => f.store.admitDelivery(old, { selectionScope: oldScope }), { code: 'UI_TARGET_SELECTION_REVOKED' });
  assert.throws(() => f.scope(old), { code: 'UI_TARGET_SELECTION_REVOKED' });
  assert.throws(() => f.store.admitDelivery({ ...old, id: '5'.repeat(64) }, { selectionScope: oldScope }), { code: 'UI_TARGET_SELECTION_REVOKED' });
  const next = f.job('fixture-first', '2'); f.store.admitDelivery(next, { selectionScope: f.scope(next) }); assert.equal(f.store.authorizeDelivery(next), true);
  assert.equal(f.store.authorizeDelivery({ ...next, text: 'different' }), false);
  assert.equal(f.store.authorizeDelivery(f.job('fixture-first', '3')), false);
});
test('contact resolution and stale asynchronous updates cannot overwrite current selection', async t => {
  const f = fixture(t); f.store.get(); let finish;
  const slow = new TargetSelectionStore({ root: f.root, accountRef: f.accountRef, resolveTargets: ids => new Promise(resolve => { finish = async () => resolve(await f.resolveTargets(ids)); }) });
  const pending = slow.replace({ expectedVersion: 1, targetWxids: ['fixture-second'] });
  await f.store.replace({ expectedVersion: 1, targetWxids: [] }); await finish();
  await assert.rejects(pending, { code: 'UI_TARGET_SELECTION_VERSION_CONFLICT' });
  const invalid = new TargetSelectionStore({ root: f.root, accountRef: f.accountRef, resolveTargets: async () => [] });
  await assert.rejects(invalid.replace({ expectedVersion: 2, targetWxids: ['unknown-contact'] }), { code: 'UI_TARGET_SELECTION_CONTACT_UNVERIFIED' });
  assert.deepEqual(f.store.get().targets, []);
});
test('selection removal during asynchronous receipt preparation prevents native submit', async t => {
  const f = fixture(t), job = f.job(); f.store.get(); f.store.admitDelivery(job, { selectionScope: f.scope(job) });
  let finish, calls = 0, marked = 0;
  const native = { observe: async () => ({ ready: true }), typeGrapheme() {}, submit: async () => { calls++; return { performed: true }; }, close() {} };
  const receipts = { prepare: () => new Promise(resolve => { finish = () => resolve({ submissionAllowed: true, preparationToken: 'fixture' }); }),
    markNotSubmitted: async (_job, { nativeResult }) => { assert.equal(nativeResult.attempted, false); marked++; return { notSubmitted: true }; }, query: async () => ({ confirmed: false }) };
  const driver = createSelectionGuardedDriver({ store: f.store, driver: createReceiptUiDriver({ native, receipts, inputAllowed: () => true }) });
  const pending = driver.submit(job, { canSubmit: () => true });
  await f.store.replace({ expectedVersion: 1, targetWxids: [] }); finish();
  assert.equal((await pending).attempted, false); assert.equal(calls, 0); assert.equal(marked, 1);
  assert.equal((await driver.observe(job)).ready, false);
  assert.equal((await driver.typeGrapheme(job, {})).performed, false);
});
test('OneBot admission and existing queue enforce removed and reselected target grants', async t => {
  const f = fixture(t); f.store.get(); let input = 0;
  const driver = { observe: async () => ({ ready: false }), typeGrapheme: async () => { input++; }, submit: async () => { input++; }, receipt: async () => ({ confirmed: false }), close() {} };
  const backend = new UiOneBotBackend({ directory: path.join(f.root, 'outbox'), policy: { accountWxid: 'fixture-self', targets: [] }, selectionStore: f.store, driver });
  const request = { action: 'send_private_msg', params: { wechatagent_delivery_protocol: 'durable-ui-v1', wechatagent_delivery_id: '1'.repeat(64), self_id: uiOneBotId('fixture-self'),
    user_id: uiOneBotId('fixture-first'), wechatagent_selection_scope: f.scope(f.job()), message: [{ type: 'text', data: { text: 'fixture reply' } }] } };
  assert.equal((await backend.action(request)).status, 'ok');
  await f.store.replace({ expectedVersion: 1, targetWxids: ['fixture-second'] });
  await backend.tick(); assert.equal(backend.outbox.get('1'.repeat(64)).state, 'cancelled');
  assert.equal((await backend.action(request)).status, 'failed');
  await f.store.replace({ expectedVersion: 2, targetWxids: ['fixture-first'] });
  assert.equal((await backend.action(request)).status, 'failed'); assert.equal(input, 0);
  backend.stop();
});
test('malformed durable selection fails closed instead of granting a queued delivery', t => {
  const f = fixture(t), job = f.job(); f.store.get(); f.store.admitDelivery(job, { selectionScope: f.scope(job) });
  fs.writeFileSync(f.store.file, '{}'); assert.equal(f.store.authorizeDelivery(job), false);
  assert.throws(() => f.store.get(), { code: 'UI_TARGET_SELECTION_STATE_INVALID' });
});
test('selection admission rejects missing or replaced event scope and pending replies retain it after restart', async t => {
  const f = fixture(t), job = f.job(), scope = f.scope(job);
  assert.throws(() => f.store.admitDelivery(job), { code: 'UI_TARGET_SELECTION_SCOPE_REQUIRED' });
  assert.throws(() => f.store.admitDelivery(job, { selectionScope: { ...scope, token: 'f'.repeat(64) } }), { code: 'UI_TARGET_SELECTION_REVOKED' });
  const file = path.join(f.root, 'scope-buffer.json'), buffer = new MessageBuffer(file);
  const message = { platform: 'wechat', kind: 'private', conversation_id: uiOneBotId(job.target), self_id: uiOneBotId(job.account),
    sender_id: uiOneBotId(job.target), message_id: scope.eventId, text: 'fixture input', ui_selection_required: true, ui_reply_scope: scope };
  const row = buffer.append(message), key = 'wechat:private:' + message.conversation_id;
  buffer.rememberReply(key, { message, deliveryId: job.id, throughId: row.id, result: { decision: 'RESPOND', text: job.text } });
  const saved = new MessageBuffer(file).pendingReplies.get(key).message;
  assert.equal(saved.ui_selection_required, true); assert.deepEqual(saved.ui_reply_scope, scope);
  await f.store.replace({ expectedVersion: 1, targetWxids: [] });
  await f.store.replace({ expectedVersion: 2, targetWxids: ['fixture-first'] });
  assert.throws(() => f.store.admitDelivery({ ...job, id: '8'.repeat(64) }, { selectionScope: saved.ui_reply_scope }), { code: 'UI_TARGET_SELECTION_REVOKED' });
});
test('revoked targets still allow returning text focus without permitting new input', async () => {
  let returned=0;
  const guarded=createSelectionGuardedDriver({store:{authorizeDelivery:()=>false},driver:{releaseTextFocus:async()=>{returned++;}}});
  await guarded.releaseTextFocus();assert.equal(returned,1);
  assert.equal(guarded.observe({}).ready,false);
});

test('blocked/background interaction plans reject admission and cannot fall back to foreground input', async t => {
  const f = fixture(t); f.store.get(); let mode = 'foreground', input = 0;
  const currentPlan = () => ({ allowed: mode !== 'blocked', executionMode: mode, requiresForeground: mode === 'foreground', requiresActivityGuard: mode === 'foreground' });
  const backend = new UiOneBotBackend({ directory: path.join(f.root, 'outbox'), policy: { accountWxid: 'fixture-self', targets: [] }, selectionStore: f.store, currentPlan,
    driver: { observe: async () => ({ ready: false }), typeGrapheme: async () => { input++; }, submit: async () => { input++; }, receipt: async () => ({ confirmed: false }), close() {} } });
  const request = { action: 'send_private_msg', params: { wechatagent_delivery_protocol: 'durable-ui-v1', wechatagent_delivery_id: '4'.repeat(64), self_id: uiOneBotId('fixture-self'),
    user_id: uiOneBotId('fixture-first'), wechatagent_selection_scope: f.scope(f.job('fixture-first', '4')), message: [{ type: 'text', data: { text: 'fixture reply' } }] } };
  mode = 'blocked'; assert.equal((await backend.action(request)).message, 'UI_INTERACTION_PLAN_BLOCKED');
  mode = 'background'; assert.equal((await backend.action(request)).message, 'UI_INTERACTION_PLAN_BLOCKED');
  mode = 'foreground'; assert.equal((await backend.action(request)).status, 'ok');
  mode = 'blocked'; await backend.tick(); assert.equal(input, 0); assert.equal(backend.status().ready, false);
  backend.stop();
});

test('an in-flight model reply keeps its original event grant through persistence and cannot send after remove/re-add', async t => {
  const f = fixture(t); f.store.get(); let release, dispatches = 0, input = 0;
  const backend = new UiOneBotBackend({ directory: path.join(f.root, 'outbox'), policy: { accountWxid: 'fixture-self', targets: [] }, selectionStore: f.store,
    driver: { observe: async () => ({ ready: false }), typeGrapheme: async () => { input++; }, submit: async () => { input++; }, receipt: async () => ({ confirmed: false }), close() {} } });
  const adapter = new WechatOneBotAdapter(); adapter.server.emit('event', backend.meta());
  adapter.server.action = async (action, params) => {
    const response = await backend.action({ action, params });
    if(response.status !== 'ok') throw Object.assign(new Error(response.message), { code: response.message, data: response.data });
    return response;
  };
  const file = path.join(f.root, 'messages.json'), buffer = new MessageBuffer(file);
  const engine = new SocialEngine({ buffer, batchMs: 1, privateMinIntervalMs: 0, maxPerMinute: 100, maxPerTenMinutes: 1000,
    stickerPolicyFor: () => ({ enabled: false }), decide: async () => { dispatches++; return await new Promise(resolve => { release = resolve; }); },
    send: (message, text, options) => adapter.sendText({ ...options, kind: message.kind, target: message.conversation_id, selfId: message.self_id, text,
      selectionRequired: message.ui_selection_required, selectionScope: message.ui_reply_scope }) });
  t.after(() => { engine.stop(); backend.stop(); });
  adapter.onMessage(message => engine.receive(message));
  const event = backend.incoming({ event: 'message.new', type: 1, isSend: false, sessionId: 'fixture-first', talkerId: 'fixture-first',
    content: 'fixture question', rawid: 'event-first', timestamp: Date.now()/1000, selectionVersion: 1 });
  adapter.server.emit('event', event);
  for(let count = 0; count < 200 && !release; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(dispatches, 1);
  const restored = new MessageBuffer(file), key = 'wechat:private:' + uiOneBotId('fixture-first');
  assert.deepEqual(restored.recent(key)[0].ui_reply_scope, event.wechatagent.selectionScope);
  assert.deepEqual(restored.pendingRequests.get(key).replyBinding.ui_reply_scope, event.wechatagent.selectionScope);
  await f.store.replace({ expectedVersion: 1, targetWxids: [] });
  await f.store.replace({ expectedVersion: 2, targetWxids: ['fixture-first'] });
  release('RESPOND: fixture reply');
  for(let count = 0; count < 200 && engine.running.size; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(engine.running.size, 0); assert.equal(backend.outbox.list().length, 0); assert.equal(input, 0);
  assert.equal(backend.incoming({ event: 'message.new', type: 1, isSend: false, sessionId: 'fixture-first', talkerId: 'fixture-first', content: 'late old stream', rawid: 'late-old', selectionVersion: 1 }), null);
});
