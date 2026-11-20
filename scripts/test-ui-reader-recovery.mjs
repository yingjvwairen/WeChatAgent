import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {previewUiReaderRecovery,recoverUiReader} from './ui-reader-recovery.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
function fixture(t,{group=false}={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-reader-recovery-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const account='fixture-self',accountRef='a'.repeat(64),target=group?'fixture-room@chatroom':'fixture-friend',id=String(Number(crypto.createHash('sha256').update(target).digest().readBigUInt64BE(0)%2147483647n+1n)),epoch='e'.repeat(32);
 const selection={schemaVersion:1,accountRef,version:1,updatedAt:1000,automaticReplies:false,targets:[{wxid:target,id,label:'fixture',alias:'',grantId:'b'.repeat(64)}]};
 const payload=n=>({event:'message.new',type:1,isSend:false,sessionId:target,talkerId:group?'fixture-member':target,conversationId:id,content:'fixture '+n,rawid:hash(target+'\0'+String(n)),timestamp:1000,serverId:String(n),...(group?{mentionsSelf:n%2===0,...(n===3?{mentionsAll:true}:{})}:{})});
 const journal={version:1,scope:hash(accountRef+'\0'+JSON.stringify([target])),epoch,next:4,seen:{},events:[1,2,3].map(n=>({seq:n,payload:payload(n)})),baselineReady:true,baselineRows:[],lastScanAt:1000};
 const cursor={version:1,account,selectionVersion:1,cursor:epoch+':1',pending:{cursor:epoch+':2',payload:{...payload(2),selectionVersion:1}}};
 const journalFile=path.join(root,'state/reader-service/events-selection-1.json'),cursorFile=path.join(root,'state/ui-reader-cursors',hash(account+'\0'+1)+'.json');
 write(path.join(root,'state/reader-service/selection.json'),selection);write(journalFile,journal);write(cursorFile,cursor);
 return{root,account,accountRef,selection,journal,cursor,journalFile,cursorFile,payload,check:()=>({account:{accountRef,myWxid:account}}),now:()=>2000};
}

test('preview preserves BOM bytes, pending messages and the old cursor',t=>{
 for(const kind of ['runtime','journal','cursor']){
  const f=fixture(t),runtimeFile=path.join(f.root,'state/runtime.json');write(runtimeFile,{});
  const before=previewUiReaderRecovery(f),file=kind==='runtime'?runtimeFile:kind==='journal'?f.journalFile:f.cursorFile;
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),fs.readFileSync(file)]);fs.writeFileSync(file,bytes);
  const preview=previewUiReaderRecovery(f);assert.equal(preview.canRecover,false);assert.equal(preview.pendingCount,2);assert.equal(preview.hasStagedMessage,true);
  if(kind==='runtime')assert.equal(preview.revision,before.revision);else assert.notEqual(preview.revision,before.revision);
  const journal=fs.readFileSync(f.journalFile),cursor=fs.readFileSync(f.cursorFile);
  assert.throws(()=>recoverUiReader({...f,expectedRevision:preview.revision,acknowledgeGap:true}),{code:'UI_RECOVERY_AUTOMATIC'});
  assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(fs.readFileSync(f.journalFile),journal);assert.deepEqual(fs.readFileSync(f.cursorFile),cursor);
  assert.equal(fs.existsSync(path.join(f.root,'state/reader-service/recoveries')),false);
 }
});

test('preview distinguishes first start, pending catch-up, current polling and saved progress',t=>{
 const f=fixture(t);fs.unlinkSync(f.journalFile);fs.unlinkSync(f.cursorFile);
 const first=previewUiReaderRecovery(f);assert.equal(first.firstRun,true);assert.equal(first.available,true);assert.equal(first.backfillActive,false);assert.equal(first.lastScanAt,null);
 write(f.journalFile,{...f.journal,baselineReady:false,events:[],next:1});assert.equal(previewUiReaderRecovery(f).firstRun,true);
 write(f.journalFile,f.journal);assert.equal(previewUiReaderRecovery(f).gapDetected,true);
 write(path.join(f.root,'state/runtime.json'),{adapter:{pid:process.pid}});
 const current=previewUiReaderRecovery({...f,now:()=>1020});assert.equal(current.gapDetected,false);assert.equal(current.firstRun,false);assert.equal(current.backfillActive,false);
 const plan={from:900,through:1800,targetIndex:0,after:[1500,'c'.repeat(64),123]};
 write(f.journalFile,{...f.journal,backfill:plan,offlineThrough:1800});
 const active=previewUiReaderRecovery(f);assert.equal(active.backfillActive,true);assert.equal(active.busy,true);assert.equal(active.canRecover,false);
 assert.deepEqual(active.backfillProgress,{from:900,through:1800,completedChats:0,totalChats:1});
 const tail={...f.payload(20),offlineReplay:'reply'};
 write(f.journalFile,{...f.journal,seen:{[tail.rawid]:tail.timestamp},backfill:{...plan,tail},offlineThrough:1800});
 const held=previewUiReaderRecovery(f);assert.equal(held.pendingCount,active.pendingCount+1);
 assert.equal(JSON.stringify(held).includes(tail.content),false);
 const finished={...f.journal,lastScanAt:1800,offlineThrough:1800};write(f.journalFile,finished);assert.equal(previewUiReaderRecovery(f).gapDetected,false);
 write(f.journalFile,{...finished,backfill:{...plan,from:1700,through:1820,after:null}});assert.equal(previewUiReaderRecovery(f).backfillActive,false);
});

for(const group of [false,true])test((group?'group':'private')+' preview preserves offline labels, media, quotes and forwards',t=>{
 const f=fixture(t,{group}),reference={senderId:'fixture-member',senderName:'成员',conversationId:group?f.selection.targets[0].wxid:'',messageId:'42',time:'',kind:'3',text:'[图片]',unavailable:true,truncated:false};
 const changes=[{type:3,image:{id:'c'.repeat(64)}},{type:47,image:{id:'d'.repeat(64)}},{type:34,media:[{id:'e'.repeat(64),kind:'audio'}]},{type:43,media:[{id:'f'.repeat(64),kind:'video'}]},
  {type:57*2**32+49,quoteReply:{version:1,reply:'引用正文',truncated:false,reference},images:[{id:'1'.repeat(64),sourceLabel:'引用原消息'}]},
  {type:19*2**32+49,forwardedRecord:{version:1,title:'转发记录',items:[{sender:'成员',time:'',text:'历史内容',kind:'1',depth:0}],truncated:false,unavailable:false},media:[{id:'2'.repeat(64),kind:'audio',sourceLabel:'转发第1条'}]}];
 const events=[{seq:1,payload:f.payload(1)},...changes.map((change,i)=>({seq:i+2,payload:{...f.payload(i+2),...change,offlineReplay:i%2?'reply':'context'}}))];
 write(f.journalFile,{...f.journal,events,next:events.length+1});write(f.cursorFile,{...f.cursor,pending:{cursor:f.journal.epoch+':2',payload:{...events[1].payload,selectionVersion:1}}});
 const bytes=fs.readFileSync(f.journalFile),preview=previewUiReaderRecovery(f);assert.equal(preview.pendingCount,changes.length);
 assert.throws(()=>recoverUiReader({...f,expectedRevision:preview.revision,acknowledgeGap:true}),{code:'UI_RECOVERY_AUTOMATIC'});assert.deepEqual(fs.readFileSync(f.journalFile),bytes);
});

test('progress and payload fields are validated and private metadata stays out of the view',t=>{
 const f=fixture(t,{group:true}),plan={from:900,through:1800,targetIndex:0,after:null};
 for(const change of [{offlineThrough:-1},{offlineThrough:'1800'},{backfill:null},{backfill:{...plan,from:1001}},{backfill:{...plan,through:999}},{backfill:{...plan,targetIndex:1}},{backfill:{...plan,after:[1801,'c'.repeat(64),1]}},{backfill:{...plan,after:[1001,'secret',1]}},{backfill:{...plan,after:[1001,'c'.repeat(64),0]}}]){
  write(f.journalFile,{...f.journal,...change});assert.throws(()=>previewUiReaderRecovery(f),{code:'UI_RECOVERY_STATE_INVALID'});
 }
 for(const bad of [{talkerId:f.selection.targets[0].wxid},{talkerId:f.account},{mentionsSelf:'true'},{mentionsAll:'true'},{mentionsAll:false},{conversationId:'123'},{type:3,image:{id:'c'.repeat(64),file:'private-path'}},{serverId:'18446744073709551616'},{offlineReplay:'all'}]){
  write(f.journalFile,{...f.journal,events:[{seq:1,payload:{...f.payload(1),...bad}}],next:2});assert.throws(()=>previewUiReaderRecovery(f),{code:'UI_RECOVERY_STATE_INVALID'});
 }
 write(f.journalFile,f.journal);const view=JSON.stringify(previewUiReaderRecovery(f));
 for(const value of [f.account,f.selection.targets[0].wxid,f.payload(2).content])assert.equal(view.includes(value),false);
});

test('an old page cannot reset or rotate a healthy or offline journal',t=>{
 const f=fixture(t),preview=previewUiReaderRecovery(f),journal=fs.readFileSync(f.journalFile),cursor=fs.readFileSync(f.cursorFile);
 assert.throws(()=>recoverUiReader({...f,expectedRevision:preview.revision}),{code:'UI_RECOVERY_CONFIRMATION_REQUIRED'});
 for(const now of [()=>1000,()=>2000])for(const running of [false,true]){
  write(path.join(f.root,'state/runtime.json'),running?{adapter:{pid:process.pid}}:{});
  assert.throws(()=>recoverUiReader({...f,now,expectedRevision:preview.revision,acknowledgeGap:true}),{code:'UI_RECOVERY_AUTOMATIC'});
  assert.deepEqual(fs.readFileSync(f.journalFile),journal);assert.deepEqual(fs.readFileSync(f.cursorFile),cursor);
 }
});

test('an interrupted old transaction restores original bytes for automatic catch-up',t=>{
 for(const legacy of [false,true]){
  const f=fixture(t),recoveryId=crypto.randomUUID(),archive=path.join(f.root,'state/reader-service/recoveries',recoveryId);
  const journalBytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),fs.readFileSync(f.journalFile)]);
  write(path.join(archive,'journal.json'),f.journal);fs.writeFileSync(path.join(archive,'journal.json'),journalBytes);
  write(path.join(archive,'cursor.json'),f.cursor);write(path.join(archive,'manifest.json'),{status:'prepared'});
  write(path.join(f.root,'state/reader-service/recovery-transaction.json'),{version:1,recoveryId,accountRef:f.accountRef,selectionVersion:1,hadCursor:true});
  write(f.journalFile,{...f.journal,epoch:'f'.repeat(32)});
  const preview=previewUiReaderRecovery(f);assert.equal(preview.incompleteRecovery,true);assert.equal(preview.canRecover,true);
  const request={...f,expectedRevision:preview.revision,...(legacy?{acknowledgeGap:true}:{acknowledgeRollback:true})};
  assert.throws(()=>recoverUiReader({...request,expectedRevision:'b'.repeat(64)}),{code:'UI_RECOVERY_VERSION_CONFLICT'});
  write(path.join(f.root,'state/runtime.json'),{adapter:{pid:process.pid}});assert.equal(previewUiReaderRecovery(f).canRecover,false);
  assert.throws(()=>recoverUiReader(request),{code:'UI_RECOVERY_STOP_SERVICES_FIRST'});write(path.join(f.root,'state/runtime.json'),{});
  const result=recoverUiReader(request);assert.equal(result.interruptedRecoveryRestored,true);assert.equal(result.needsRecovery,false);assert.equal(result.inputSent,false);
  assert.deepEqual(fs.readFileSync(f.journalFile),journalBytes);assert.deepEqual(JSON.parse(fs.readFileSync(f.cursorFile)),f.cursor);
  const restored=previewUiReaderRecovery(f);assert.equal(restored.gapDetected,true);assert.equal(restored.canRecover,false);
 }
});

test('rollback rejects damaged backups and respects the original absence of a cursor',t=>{
 const f=fixture(t),recoveryId=crypto.randomUUID(),archive=path.join(f.root,'state/reader-service/recoveries',recoveryId);
 const transaction=path.join(f.root,'state/reader-service/recovery-transaction.json');
 write(path.join(archive,'journal.json'),{...f.journal,scope:'b'.repeat(64)});
 write(path.join(archive,'cursor.json'),f.cursor);
 write(transaction,{version:1,recoveryId,accountRef:f.accountRef,selectionVersion:1,hadCursor:false});
 const preview=previewUiReaderRecovery(f),journal=fs.readFileSync(f.journalFile),cursor=fs.readFileSync(f.cursorFile);
 const request={...f,expectedRevision:preview.revision,acknowledgeRollback:true};
 assert.throws(()=>recoverUiReader(request),{code:'UI_RECOVERY_STATE_INVALID'});
 assert.deepEqual(fs.readFileSync(f.journalFile),journal);assert.deepEqual(fs.readFileSync(f.cursorFile),cursor);
 assert.equal(fs.existsSync(transaction),true);
 write(path.join(archive,'journal.json'),f.journal);
 const result=recoverUiReader(request);
 assert.equal(result.interruptedRecoveryRestored,true);assert.equal(fs.existsSync(f.cursorFile),false);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)),f.journal);
});
