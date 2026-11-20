import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkLocalReader } from './reader-local-setup.mjs';
import { validateTargetSelection } from './target-selection.mjs';

const fault=code=>Object.assign(new Error(code),{code});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const projectRoot=path.resolve(import.meta.dirname,'..');
const cursor=value=>typeof value==='string'&&/^[a-f0-9]{32}:(0|[1-9][0-9]{0,15})$/.test(value)&&Number.isSafeInteger(Number(value.split(':')[1]));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const bounded=(value,max,bytes=max*4)=>typeof value==='string'&&value.isWellFormed()&&!value.includes('\0')&&[...value].length<=max&&Buffer.byteLength(value)<=bytes;
const username=value=>bounded(value,256)&&value.length>0&&!/[\u0000-\u0020\u007f]/u.test(value);
const refId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Mirrors reader-target-service.py valid_public_payload. Recovery preserves
 * the public references verbatim; it never rehydrates XML, URLs or file paths. */
function validPublicPayload(p){
  if(!object(p)||!username(p.sessionId)||!username(p.talkerId)||p.talkerId.endsWith('@chatroom')||p.event!=='message.new'||p.isSend!==false||!Number.isSafeInteger(p.timestamp)||p.timestamp<1)return false;
  const group=p.sessionId.endsWith('@chatroom'),base=['event','type','isSend','sessionId','talkerId','conversationId','content','rawid','timestamp','serverId'];
  if(Object.hasOwn(p,'offlineReplay')){
    if(!['context','reply'].includes(p.offlineReplay))return false;
    base.push('offlineReplay');
  }
  if(Object.hasOwn(p,'offlineBatch')){
    if(p.offlineReplay!=='reply'||!fields(p.offlineBatch,['id','last'])||!refId(p.offlineBatch.id)||typeof p.offlineBatch.last!=='boolean')return false;
    base.push('offlineBatch');
  }
  if(group){
    if(typeof p.mentionsSelf!=='boolean')return false;
    base.push('mentionsSelf');
    if(Object.hasOwn(p,'mentionsAll')){
      if(p.mentionsAll!==true)return false;
      base.push('mentionsAll');
    }
  }else if(p.talkerId!==p.sessionId)return false;
  if(typeof p.serverId!=='string'||!/^[1-9][0-9]{0,19}$/.test(p.serverId)||BigInt(p.serverId)>18446744073709551615n||p.rawid!==hash(p.sessionId+'\0'+p.serverId))return false;
  if(p.type===1)return fields(p,base)&&bounded(p.content,16000,16000)&&!!p.content.trim();
  if(!bounded(p.content,4200))return false;
  if([3,47].includes(p.type))return fields(p,[...base,'image'])&&fields(p.image,['id'])&&refId(p.image.id);
  if([34,43,62].includes(p.type))return fields(p,[...base,'media'])&&Array.isArray(p.media)&&p.media.length===1&&fields(p.media[0],['id','kind'])&&refId(p.media[0].id)&&p.media[0].kind===(p.type===34?'audio':'video');
  if(![49,19*2**32+49,57*2**32+49].includes(p.type))return false;
  for(const name of ['images','media'])if(Object.hasOwn(p,name)){
    const values=p[name];base.push(name);
    if(!Array.isArray(values)||values.length<1||values.length>(name==='images'?4:2)||values.some(v=>!object(v)||!Object.hasOwn(v,'sourceLabel')||!refId(v.id)||!bounded(v.sourceLabel,80)||Object.keys(v).some(k=>!['id','kind','sourceLabel'].includes(k))||(name==='images'?![undefined,'sticker'].includes(v.kind):!['audio','video'].includes(v.kind))))return false;
  }
  const q=p.quoteReply,r=p.forwardedRecord;
  if(object(q)&&r===undefined&&p.type!==19*2**32+49){
    if(!fields(p,[...base,'quoteReply'])||!fields(q,['version','reply','truncated','reference'])||q.version!==1||typeof q.truncated!=='boolean'||!bounded(q.reply,4000))return false;
    const limits={senderId:128,senderName:80,conversationId:128,messageId:32,time:64,kind:16,text:1600};
    return fields(q.reference,[...Object.keys(limits),'unavailable','truncated'])&&Object.entries(limits).every(([k,n])=>bounded(q.reference[k],n))&&['unavailable','truncated'].every(k=>typeof q.reference[k]==='boolean')&&(!q.reference.kind||/^[0-9]{1,16}$/.test(q.reference.kind));
  }
  if(object(r)&&q===undefined&&p.type!==57*2**32+49){
    if(!fields(p,[...base,'forwardedRecord'])||!fields(r,['version','title','items','truncated','unavailable'])||r.version!==1||!bounded(r.title,200)||typeof r.truncated!=='boolean'||typeof r.unavailable!=='boolean'||!Array.isArray(r.items)||r.items.length>50)return false;
    let total=[...r.title].length;
    for(const v of r.items){if(!fields(v,['sender','time','text','kind','depth'])||!Object.entries({sender:80,time:64,text:801,kind:8}).every(([k,n])=>bounded(v[k],n))||!Number.isInteger(v.depth)||v.depth<0||v.depth>3)return false;total+=[...v.sender].length+[...v.time].length+[...v.text].length+12;}
    return total<=6400;
  }
  return false;
}
function noLinks(file){for(let current=path.resolve(file);;current=path.dirname(current)){if(fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_RECOVERY_LINK_REFUSED');if(path.dirname(current)===current)return path.resolve(file);}}
function read(file,max=9*1024*1024){noLinks(file);const stat=fs.statSync(file,{throwIfNoEntry:false});if(!stat)return null;if(!stat.isFile()||stat.size>max)throw fault('UI_RECOVERY_STATE_INVALID');const bytes=fs.readFileSync(file);try{return {bytes,value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''))};}catch{throw fault('UI_RECOVERY_STATE_INVALID');}}
function atomic(file,value){noLinks(file);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,Buffer.isBuffer(value)?value:JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
function pendingTransaction(root){const file=path.join(root,'state/reader-service/recovery-transaction.json'),record=read(file,4096);if(!record)return null;const v=record.value;if(v.version!==1||!/^([a-f0-9]{8}-){1}([a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.recoveryId??'')||!/^[a-f0-9]{64}$/.test(v.accountRef??'')||!Number.isSafeInteger(v.selectionVersion)||v.selectionVersion<1||typeof v.hadCursor!=='boolean')throw fault('UI_RECOVERY_STATE_INVALID');return{file,...record};}
function staleRecoveryLock(file){const record=read(file,4096);if(!record||record.value.recovery!==true||!Number.isInteger(record.value.pid)||record.value.pid<1||record.value.pid===process.pid)return null;try{process.kill(record.value.pid,0);return null;}catch(error){return error.code==='ESRCH'?record:null;}}
function claim(file){noLinks(file);const stale=staleRecoveryLock(file);if(stale&&fs.readFileSync(file).equals(stale.bytes))fs.unlinkSync(file);return fs.openSync(file,'wx',0o600);}
function busy(root){const managed=read(path.join(root,'state/runtime.json'),65536)?.value??{};return ['state/ui-service.lock','state/reader-service/service.lock','state/reader-service/selection.lock'].some(relative=>{const file=noLinks(path.join(root,relative));return fs.existsSync(file)&&!staleRecoveryLock(file);})||!!managed.adapter||!!managed.reader;}
function snapshot({root,check,now,restoring}){
  const binding=check({root}),account=binding.account.myWxid.trim().replace(/_[A-Za-z0-9]{4}$/u,'');
  const selectionFile=path.join(root,'state/reader-service/selection.json'),selected=restoring?.selected??read(selectionFile,131072);
  if(!selected)throw fault('UI_RECOVERY_SELECTION_REQUIRED');
  const selection=validateTargetSelection(selected.value,binding.account.accountRef),targets=selection.targets.map(value=>value.wxid);
  const journalFile=path.join(root,'state/reader-service',`events-selection-${selection.version}.json`),journal=restoring?restoring.journal:read(journalFile);
  const cursorFile=path.join(root,'state/ui-reader-cursors',hash(account+'\0'+selection.version)+'.json'),saved=restoring?restoring.saved:read(cursorFile,131072);
  const base={root,binding,account,selection,selectionFile,journalFile,cursorFile,journal,saved,busy:busy(root)};
  if(!journal)return {...base,available:true,firstRun:true,gapDetected:false,backfillActive:false,pending:[],revision:hash(selected.bytes)};
  const j=journal.value;
  if(j.version!==1||j.scope!==hash(binding.account.accountRef+'\0'+JSON.stringify(targets))||!/^[a-f0-9]{32}$/.test(j.epoch??'')||!Number.isSafeInteger(j.next)||j.next<1||
      typeof j.baselineReady!=='boolean'||!Number.isSafeInteger(j.lastScanAt)||j.lastScanAt<1||!Array.isArray(j.events)||j.events.length>1000||!Array.isArray(j.baselineRows)||!j.seen||typeof j.seen!=='object')throw fault('UI_RECOVERY_STATE_INVALID');
  if(Object.hasOwn(j,'offlineThrough')&&(!Number.isSafeInteger(j.offlineThrough)||j.offlineThrough<0))throw fault('UI_RECOVERY_STATE_INVALID');
  const plan=j.backfill;
  if(Object.hasOwn(j,'backfill')&&(!fields(plan,Object.hasOwn(plan??{},'tail')?['from','through','targetIndex','after','tail']:['from','through','targetIndex','after'])||
      !['from','through','targetIndex'].every(k=>Number.isSafeInteger(plan[k]))||
      plan.from<0||plan.from>j.lastScanAt||plan.through<j.lastScanAt||plan.targetIndex<0||plan.targetIndex>=targets.length||
      plan.after!==null&&(!Array.isArray(plan.after)||plan.after.length!==3||!Number.isSafeInteger(plan.after[0])||
      !refId(plan.after[1])||!Number.isSafeInteger(plan.after[2])||plan.after[2]<1||plan.after[0]<plan.from||plan.after[0]>plan.through)))
    throw fault('UI_RECOVERY_STATE_INVALID');
  const normalize=payload=>{
    const p={...payload};delete p.selectionVersion;
    const target=selection.targets.find(value=>value.wxid===p.sessionId);
    if(!target||!validPublicPayload(p)||p.talkerId===account||p.conversationId!==target.id)throw fault('UI_RECOVERY_STATE_INVALID');
    return p;
  };
  if(plan&&Object.hasOwn(plan,'tail')){
    const tail=normalize(plan.tail);
    if(!plan.after||tail.offlineReplay!=='reply'||tail.offlineBatch!==undefined||tail.sessionId!==targets[plan.targetIndex]||
        tail.timestamp<plan.from||tail.timestamp>plan.after[0]||j.seen[tail.rawid]!==tail.timestamp)
      throw fault('UI_RECOVERY_STATE_INVALID');
  }
  let last=j.next-j.events.length-1;
  if(last<0)throw fault('UI_RECOVERY_STATE_INVALID');
  for(const event of j.events){if(event.seq!==++last)throw fault('UI_RECOVERY_STATE_INVALID');normalize(event.payload);}
  if(last!==j.next-1)throw fault('UI_RECOVERY_STATE_INVALID');
  let acknowledged=j.events[0]?.seq-1??j.next-1,staged;
  if(saved){const c=saved.value;if(c.version!==1||c.account!==account||c.selectionVersion!==selection.version||!cursor(c.cursor)||c.cursor.split(':')[0]!==j.epoch)throw fault('UI_RECOVERY_CURSOR_MISMATCH');
    acknowledged=Number(c.cursor.split(':')[1]);if(acknowledged>=j.next)throw fault('UI_RECOVERY_CURSOR_MISMATCH');
    if(c.pending!==null){if(!c.pending||!cursor(c.pending.cursor)||c.pending.cursor!==j.epoch+':'+(acknowledged+1))throw fault('UI_RECOVERY_CURSOR_MISMATCH');staged=normalize(c.pending.payload);}
  }
  const pending=[],seen=new Map();
  for(const value of [...(staged?[staged]:[]),...j.events.filter(event=>event.seq>acknowledged).map(event=>normalize(event.payload))]){
    if(seen.has(value.rawid)){if(JSON.stringify(seen.get(value.rawid))!==JSON.stringify(value))throw fault('UI_RECOVERY_PENDING_CONFLICT');continue;}
    seen.set(value.rawid,value);pending.push(value);
  }
  if(pending.length>1000)throw fault('UI_RECOVERY_TOO_MANY_PENDING');
  const backfillActive=!!plan&&plan.through<=(j.offlineThrough??0)&&j.lastScanAt<plan.through;
  const gapDetected=j.baselineReady&&(backfillActive||(j.offlineThrough??0)>j.lastScanAt||now()-j.lastScanAt>290||now()<j.lastScanAt||!base.busy&&now()>j.lastScanAt);
  return {...base,available:true,firstRun:!j.baselineReady,gapDetected,backfillActive,
    ...(backfillActive&&{backfillProgress:{completedChats:plan.targetIndex,totalChats:targets.length,from:plan.from,through:plan.through}}),pending,staged,
    truncated:acknowledged<(j.events[0]?.seq-1??j.next-1),revision:hash(Buffer.concat([selected.bytes,journal.bytes,saved?.bytes??Buffer.alloc(0)]))};
}
export function previewUiReaderRecovery({root=projectRoot,check=checkLocalReader,now=()=>Math.floor(Date.now()/1000)}={}){
  const transaction=pendingTransaction(root);
  if(transaction){
    const active=busy(root);
    return{available:true,firstRun:false,gapDetected:true,backfillActive:false,incompleteRecovery:true,busy:active,canRecover:!active,revision:hash(transaction.bytes),pendingCount:null,hasStagedMessage:true,retainedHistoryIncomplete:false,lastScanAt:null,
      message:'旧版读取恢复曾被中断。停止服务后可还原原读取记录，随后启动服务自动补读。'};
  }
  const data=snapshot({root,check,now});
  const message=data.firstRun?'首次启动会建立当前聊天的读取位置。':
    data.backfillActive?(data.busy?'正在按已保存的位置补读离线消息。':'已保存补读进度，启动服务后继续。'):
    !data.busy?'读取服务已停止，启动后将从上次位置自动补读。':
    data.gapDetected?'正在等待读取服务接续检查离线消息。':'消息读取正常，服务会自动接续读取。';
  return {available:data.available,firstRun:data.firstRun,gapDetected:data.gapDetected,backfillActive:data.backfillActive,incompleteRecovery:false,busy:data.busy,revision:data.revision,
    ...(data.backfillProgress&&{backfillProgress:data.backfillProgress}),
    pendingCount:data.pending.length+(data.journal?.value.backfill?.tail?1:0),hasStagedMessage:!!data.staged,retainedHistoryIncomplete:!!data.truncated,
    lastScanAt:data.journal?.value.lastScanAt??null,canRecover:false,message};
}
export function recoverUiReader({root=projectRoot,check=checkLocalReader,now=()=>Math.floor(Date.now()/1000),expectedRevision,acknowledgeGap,acknowledgeRollback}={}){
  if(acknowledgeGap!==true&&acknowledgeRollback!==true||!/^[a-f0-9]{64}$/.test(expectedRevision??''))throw fault('UI_RECOVERY_CONFIRMATION_REQUIRED');
  const interrupted=pendingTransaction(root);
  if(interrupted){
    if(hash(interrupted.bytes)!==expectedRevision)throw fault('UI_RECOVERY_VERSION_CONFLICT');if(busy(root))throw fault('UI_RECOVERY_STOP_SERVICES_FIRST');
    const binding=check({root}),v=interrupted.value;if(binding.account.accountRef!==v.accountRef)throw fault('UI_RECOVERY_ACCOUNT_MISMATCH');
    const archive=noLinks(path.join(root,'state/reader-service/recoveries',v.recoveryId)),backup=read(path.join(archive,'journal.json')),saved=v.hadCursor?read(path.join(archive,'cursor.json'),131072):null;
    if(!backup||v.hadCursor&&!saved)throw fault('UI_RECOVERY_BACKUP_MISSING');
    const selected=read(path.join(archive,'selection.json'),131072)??read(path.join(root,'state/reader-service/selection.json'),131072);
    if(!selected||selected.value.version!==v.selectionVersion)throw fault('UI_RECOVERY_STATE_INVALID');
    snapshot({root,check,now,restoring:{selected,journal:backup,saved}});
    const locks=[path.join(root,'state/ui-service.lock'),path.join(root,'state/reader-service/selection.lock')],owned=[];
    try{
      for(const file of locks){const fd=claim(file);owned.push({file,fd});fs.writeFileSync(fd,JSON.stringify({pid:process.pid,recovery:true}));}
      if(fs.existsSync(noLinks(path.join(root,'state/reader-service/service.lock'))))throw fault('UI_RECOVERY_STOP_SERVICES_FIRST');
      if(hash(pendingTransaction(root)?.bytes??Buffer.alloc(0))!==expectedRevision)throw fault('UI_RECOVERY_VERSION_CONFLICT');
      const account=binding.account.myWxid.trim().replace(/_[A-Za-z0-9]{4}$/u,''),cursorFile=noLinks(path.join(root,'state/ui-reader-cursors',hash(account+'\0'+v.selectionVersion)+'.json'));
      atomic(path.join(root,'state/reader-service',`events-selection-${v.selectionVersion}.json`),backup.bytes);
      if(saved)atomic(cursorFile,saved.bytes);else if(fs.existsSync(cursorFile))fs.unlinkSync(cursorFile);
      const manifest=read(path.join(archive,'manifest.json'),4096)?.value??{};atomic(path.join(archive,'manifest.json'),{...manifest,status:'rolled-back'});fs.unlinkSync(interrupted.file);
      return{recovered:false,interruptedRecoveryRestored:true,needsRecovery:false,servicesStarted:false,inputSent:false};
    }finally{for(const {file,fd}of owned.reverse()){fs.closeSync(fd);fs.unlinkSync(file);}}
  }
  throw fault('UI_RECOVERY_AUTOMATIC');
}
