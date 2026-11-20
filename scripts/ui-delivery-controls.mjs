import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {checkLocalReader} from './reader-local-setup.mjs';
import {activeReaderAccount} from './reader-account-state.mjs';
import {validateQtConfig} from './qt-visual-driver.mjs';
import {UiTextOutbox} from './ui-text-outbox.mjs';
import {UiReplyOutbox,isOriginalClipboardRefusal} from './ui-reply-outbox.mjs';
import {FileTransfers} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import {UiImageOutbox} from './ui-image-outbox.mjs';
import {NativeVoiceOutbox} from './native-voice-outbox.mjs';
import {nativeInputHelpersStopped} from './ui-runtime-controls.mjs';
import {validateTargetSelection} from './target-selection.mjs';
import {deliveryNoLinks,readArchivedDelivery} from './delivery-archive.mjs';
import {ReplyMediaCatalog} from './reply-media-catalog.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fault=code=>Object.assign(new Error(code),{code});
const deny=()=>{throw fault('UI_QUEUE_CONTROL_ONLY');};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function read(file){
  for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_QUEUE_LINK_REFUSED');if(path.dirname(at)===at)break;}
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>1024*1024)throw fault('UI_QUEUE_STATE_INVALID');return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
function currentAccount(root){
  const binding=checkLocalReader({root}),active=activeReaderAccount(root),project=read(path.join(root,'config/wechatagent.json'));
  const settings=read(project.ui?.bridgeConfig??path.join(root,'state/ui-bridge/config.json')),host=validateQtConfig(read(settings.hostConfig));
  if(!binding.cached||project.runtime?.sender!=='wechat-ui'||active.id!==binding.account.accountRef||host.accountRef!==binding.account.accountRef||
    host.account!==binding.account.myWxid.trim().replace(/_[A-Za-z0-9]{4}$/u,''))throw fault('UI_QUEUE_ACCOUNT_UNAVAILABLE');
  return{account:host.account,accountRef:binding.account.accountRef};
}
const submitted=job=>['submitting','submitted','unconfirmed'].includes(job.state)||job.nativeRecoveryRequired;
const unfinished=job=>!['confirmed','cancelled','failed','unconfirmed'].includes(job.state);
const recentLimit=50;
function selectedTarget(root,accountRef,conversationKey){
  const roster=validateTargetSelection(read(path.join(root,'state/reader-service/selection.json')),accountRef);
  const target=roster.targets.find(row=>conversationKey==='wechat:'+(row.wxid.endsWith('@chatroom')?'group:':'private:')+row.id);
  if(!target)throw fault('UI_QUEUE_CHAT_NOT_SELECTED');
  return target.wxid;
}

// The sender keeps immutable receipts under hash prefixes. Index only their
// IDs and dates, and revisit a prefix when archiving changes its directory.
function recentArchiveIds(directory,cache,account,target) {
  deliveryNoLinks(directory);
  if(!fs.existsSync(directory))return [];
  const matches=[];
  for(const prefix of fs.readdirSync(directory)){
    if(!/^[0-9a-f]{2}$/.test(prefix))continue;
    const folder=path.join(directory,prefix);
    deliveryNoLinks(folder);
    const stat=fs.statSync(folder,{bigint:true});
    const stamp=String(stat.ino)+'/'+stat.mtimeNs+'/'+stat.ctimeNs;
    let entry=cache.get(folder);
    if(entry?.stamp!==stamp){
      const grouped=new Map();
      for(const file of fs.readdirSync(folder)){
        const id=file.slice(0,-5);
        if(!digest(id)||file!==id+'.json'||!id.startsWith(prefix))continue;
        const record=readArchivedDelivery(directory,id,96*1024);
        if(!record||record.id!==id||record.account!==account||typeof record.target!=='string'||!Number.isSafeInteger(record.createdAt))throw fault('UI_QUEUE_STATE_INVALID');
        if(!grouped.has(record.target))grouped.set(record.target,[]);
        grouped.get(record.target).push({id,createdAt:record.createdAt});
      }
      for(const [key,rows] of grouped)grouped.set(key,rows.sort(byNewest).slice(0,recentLimit));
      entry={stamp,grouped};cache.set(folder,entry);
    }
    matches.push(...(entry.grouped.get(target)??[]));
  }
  return matches.sort(byNewest).slice(0,recentLimit);
}
function byNewest(a,b){return b.createdAt-a.createdAt||a.id.localeCompare(b.id);}
function previewFor(job,mediaNames) {
  if(job.uiaFile)return path.win32.basename(job.name||'文件');
  if(job.mode==='image'){
    const name=mediaNames.get(job.sourceImageSha256)||job.image?.fileName;
    if(name)return name;
    const format=path.extname(job.image?.path??'').slice(1).toUpperCase();
    return [format||'图片',job.image?.bytes && Math.ceil(job.image.bytes/1024)+' KB'].filter(Boolean).join(' · ');
  }
  return job.text??'';
}
function view(job){
  if(job.uiaFile===true)return {id:job.id,version:hash(JSON.stringify(job)),kind:'file',target:job.target??job.selectionScope.target,state:job.state,createdAt:job.createdAt,requiresRecovery:job.fileDraftPossible===true,canRecoverFileDraft:job.fileDraftPossible===true};
  const kind=job.mode==='image'?'image':job.mode==='voice'?'voice':'text';
  const imageHeld=kind==='image'&&!job.manualDraftCleared&&(job.imageDraftPresent||job.inputPending||job.index>0);
  const uncertain=submitted(job)||job.pendingInput||job.inputPending||job.state==='conflict';
  // This only releases the queue pause. The running native instance must still
  // prove the same applied image before its dedicated no-search resume path.
  const appliedImageReady=kind==='image'&&job.imageDraftPresent===true&&job.index===('[IMAGE:'+job.sourceImageSha256+']').length&&!job.inputPending&&job.submittedAt===undefined;
  const version=hash(JSON.stringify(job));
  return{id:job.id,version,kind,target:job.target,state:job.state,manualPause:job.manualPause===true,createdAt:job.createdAt,updatedAt:job.updatedAt??job.createdAt,
    ...(job.state==='cancelled'&&job.reason==='UI_QUOTE_TARGET_UNAVAILABLE'?{quoteUnavailable:true}:{}),
    requiresRecovery:job.state!=='confirmed'&&Boolean(uncertain||imageHeld),canPause:unfinished(job)&&!submitted(job)&&!job.manualPause,
    canResume:unfinished(job)&&job.manualPause===true&&!uncertain&&(!imageHeld||appliedImageReady),canCancel:unfinished(job)&&!submitted(job),
    canRecoverImageDraft:kind==='image'&&imageHeld&&!['submitting','submitted','confirmed','unconfirmed','failed'].includes(job.state)&&job.submittedAt===undefined&&job.deadlineAt===undefined};
}
/** Local control objects have no input, synthesis or receipt implementation.
 * Only existing current-account records can be inspected or paused/cancelled. */
export function createUiDeliveryControls({root=path.resolve(import.meta.dirname,'..'),accountProvider=()=>currentAccount(root),helpersStopped=()=>nativeInputHelpersStopped()}={}){
  const archiveCache=new Map();
  function targetFor(account,scope){
    if(scope.accountRef!==account.accountRef)throw fault('UI_QUEUE_ACCOUNT_MISMATCH');
    return selectedTarget(root,account.accountRef,scope.conversationKey);
  }
  const context=()=>{
    const account=accountProvider();if(!account||!digest(account.accountRef)||typeof account.account!=='string'||!account.account||account.account.length>256)throw fault('UI_QUEUE_ACCOUNT_UNAVAILABLE');
    const directory=path.join(root,'state/ui-text-deliveries',hash(account.account));
    const text=new UiTextOutbox({directory,driver:{observe:deny,typeGrapheme:deny,submit:deny,receipt:deny}});
    const voice=new NativeVoiceOutbox({root,transport:{sendSegment:deny,querySegment:deny},authorizeScope:()=>false});
    const replies=new UiReplyOutbox({directory:path.join(directory,'routes'),textOutbox:text,voiceOutbox:voice});
    const images=new UiImageOutbox({directory:path.join(root,'state/ui-image-deliveries',hash(account.account)),driver:{prepare:deny,observe:deny,pasteImage:deny,submitImage:deny},
      receipts:{prepare:deny,submitted:deny,query:deny},authorizeScope:()=>false});
    const files=new FileTransfers(root);
    const jobs=[...replies.list(),...images.list(),...files.list().filter(j=>j.uiaFile&&j.accountScope===account.accountRef&&j.selectionScope?.account===account.account).map(j=>({...j,account:account.account}))];
    if(jobs.some(job=>job.account!==account.account)||new Set(jobs.map(job=>job.id)).size!==jobs.length)throw fault('UI_QUEUE_ACCOUNT_MISMATCH');
    return{account,replies,text,images,files,jobs};
  };
  return{
    snapshot(scope){
      const {account,replies,text,images,jobs}=context();
      const {paused,preparation}=replies.control();
      const result={accountRef:account.accountRef,paused,jobs:[]};
      if(!scope)result.jobs=jobs.map(view).sort(byNewest);
      else{
        const target=targetFor(account,scope);
        result.conversationKey=scope.conversationKey;
        const rows=jobs.filter(job=>(job.target??job.selectionScope?.target)===target);
        const active=new Set(rows.map(row=>row.id));
        const history=new Map();
        for(const [owner,directory] of [[replies,replies.archiveDirectory],[text,text.archiveDirectory],[images,images.queue.archiveDirectory]]){
          for(const record of recentArchiveIds(directory,archiveCache,account.account,target)){
            if(!active.has(record.id)&&!history.has(record.id))history.set(record.id,{...record,owner});
          }
        }
        for(const {id,owner} of [...history.values()].sort(byNewest).slice(0,recentLimit)){
          const row=owner.get(id);
          if(row?.target!==target||row.account!==account.account||!['confirmed','cancelled'].includes(row.state))throw fault('UI_QUEUE_STATE_INVALID');
          rows.push(row);
        }
        const mediaNames=new Map();
        if(rows.some(row=>row.mode==='image')){
          try{for(const item of new ReplyMediaCatalog({root}).snapshot().items)mediaNames.set(item.id,item.name);}
          catch{/* A missing asset label must not hide the delivery or its controls. */}
        }
        let finished=0;
        result.jobs=rows.sort(byNewest).map(row=>({...view(row),preview:previewFor(row,mediaNames),archived:!active.has(row.id)}))
          .filter(row=>!['confirmed','cancelled','failed'].includes(row.state)||row.requiresRecovery||++finished<=recentLimit);
        if(targetFor(accountProvider(),scope)!==target)throw fault('UI_QUEUE_CHAT_MISMATCH');
      }
      if(isOriginalClipboardRefusal(preparation?.reason)){
        if(preparation.kind==='activity')result.clipboardState='waiting';
        if(preparation.kind==='manual')result.clipboardState='review';
      }
      return result;
    },
    change(body){
      if(!body||Object.keys(body).some(key=>!['accountRef','conversationKey','id','version','operation'].includes(key))||!digest(body.accountRef)||!digest(body.id)||!digest(body.version)||!['pause','resume','cancel'].includes(body.operation))throw fault('UI_QUEUE_REQUEST_INVALID');
      const {account,replies,images,jobs}=context();if(body.accountRef!==account.accountRef)throw fault('UI_QUEUE_ACCOUNT_MISMATCH');
      const job=jobs.find(job=>job.id===body.id);if(!job)throw fault('UI_QUEUE_NOT_FOUND');const current=view(job);
      if(Object.hasOwn(body,'conversationKey')&&targetFor(account,body)!==current.target)throw fault('UI_QUEUE_CHAT_MISMATCH');
      if(body.version!==current.version)throw fault('UI_QUEUE_VERSION_CONFLICT');
      if(!current['can'+body.operation[0].toUpperCase()+body.operation.slice(1)])throw fault('UI_QUEUE_RECOVERY_REQUIRED');
      const latest=accountProvider();if(latest.account!==account.account||latest.accountRef!==account.accountRef)throw fault('UI_QUEUE_ACCOUNT_MISMATCH');
      const result=(job.mode==='image'?images:replies)[body.operation](body.id);
      return{accountRef:account.accountRef,job:view(result)};
    },
    async recoverImage(body){
      if(!body||Object.keys(body).some(key=>!['accountRef','conversationKey','id','version','operation','acknowledgedCleared'].includes(key))||!['recover-image','recover-file'].includes(body.operation)||
        !digest(body.accountRef)||!digest(body.id)||!digest(body.version)||body.acknowledgedCleared!==true)throw fault('UI_QUEUE_REQUEST_INVALID');
      // Validate the account and owned directory chain before reserving the
      // service lease; repeat both after asynchronous helper inspection.
      if(context().account.accountRef!==body.accountRef)throw fault('UI_QUEUE_ACCOUNT_MISMATCH');
      const lease=path.join(root,'state/ui-service.lock'),owner=crypto.randomUUID();
      const stopped=()=>!['state/reader-service/service.lock','state/native-voice-outbox/worker.lock','state/native-voice-attempts/active.json',
        'state/voice-preview/timed/active.json','state/ui-voice-submit-previews/active.json'].some(relative=>fs.existsSync(path.join(root,relative)));
      if(!stopped())throw fault('UI_QUEUE_STOP_REQUIRED');
      try{fs.writeFileSync(lease,JSON.stringify({runtimeControlsLease:owner,pid:process.pid}),{flag:'wx',mode:0o600});}catch{throw fault('UI_QUEUE_STOP_REQUIRED');}
      try{
        if(await helpersStopped()!==true||!stopped())throw fault('UI_QUEUE_STOP_REQUIRED');
        const {account,images,jobs}=context();if(account.accountRef!==body.accountRef)throw fault('UI_QUEUE_ACCOUNT_MISMATCH');
        const job=jobs.find(job=>job.id===body.id),current=job&&view(job);if(!current||current.version!==body.version)throw fault('UI_QUEUE_VERSION_CONFLICT');
        if(Object.hasOwn(body,'conversationKey')&&targetFor(account,body)!==current.target)throw fault('UI_QUEUE_CHAT_MISMATCH');
        if(body.operation==='recover-file'){
          if(!current.canRecoverFileDraft)throw fault('UI_QUEUE_RECOVERY_REQUIRED');
          const files=new FileTransfers(root),record=files.read(job.id);
          if(record.accountScope!==account.accountRef||record.fileDraftPossible!==true)throw fault('UI_QUEUE_ACCOUNT_MISMATCH');
          Object.assign(record,{state:'unconfirmed',fileDraftPossible:false,manualDraftCleared:true,error:'UI_FILE_OPERATOR_REVIEWED'});
          files.write(record);return {accountRef:account.accountRef,job:view(record)};
        }
        if(!current.canRecoverImageDraft)throw fault('UI_QUEUE_RECOVERY_REQUIRED');
        const result=images.acknowledgeClearedDraft(job.id,{expectedRevision:job.revision,acknowledgedCleared:true,assertStopped:()=>stopped()&&
          read(lease).runtimeControlsLease===owner&&accountProvider().account===account.account&&accountProvider().accountRef===account.accountRef});
        return{accountRef:account.accountRef,job:view(result)};
      }finally{if(read(lease).runtimeControlsLease===owner)fs.unlinkSync(lease);}
    },
  };
}
