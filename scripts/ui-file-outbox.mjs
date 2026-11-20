import {createHash} from 'node:crypto';
import {FileTransfers} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import {withUiSelection} from '../packages/dsh-social-bridge-plugin/ui-selection-policy.mjs';

const fault=code=>Object.assign(Error(code),{code});
const rowId=row=>createHash('sha256').update(JSON.stringify([row.sourceShard,row.localId])).digest('hex');
const code=error=>/^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code)?error.code:'UI_FILE_DELIVERY_FAILED';
const digits=value=>typeof value==='string'&&/^-?\d{1,20}$/.test(value);
const matches=(row,job)=>row.senderUsername===job.account&&row.isSend===1&&
  [49,25769803825].includes(row.localType)&&row.fileKind==='appmsg-6'&&row.fileName===job.name&&
  row.fileSize===job.size&&(!row.fileMd5||row.fileMd5===job.md5);

export async function readUiFileReceipts(reader,job,signal){
  const url=new URL('/api/v1/file-receipts',reader.baseUrl);
  url.searchParams.set('talker',job.target);
  url.searchParams.set('from_time',String(job.fromTime));
  const response=await fetch(url,{headers:{Authorization:'Bearer '+reader.token},redirect:'error',
    signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
  if(!response.ok)throw fault('UI_FILE_RECEIPT_UNAVAILABLE');
  const value=await response.json(),scope=value.scope;
  if(value.success!==true||value.fileReceiptVersion!==1||scope?.complete!==true||scope.version!==1||
      scope.talker!==job.target||scope.accountDirectory!==reader.accountDirectory||scope.accountWxid!==job.account||
      scope.fromTime!==job.fromTime||!Number.isSafeInteger(scope.throughTime)||scope.throughTime<job.fromTime||
      !Array.isArray(value.messages)||value.messages.length>500||!value.messages.every(row=>digits(row.localId)&&
        digits(row.serverId)&&/^[a-f0-9]{64}$/.test(row.sourceShard)))throw fault('UI_FILE_RECEIPT_SCOPE_INVALID');
  return value.messages;
}

// FileTransfers owns assistant admission and staging. This consumer runs from
// the same awaited UI tick as the text/image/voice queues, never on a separate timer.
export class UiFileOutbox{
  constructor({root,account,selectionStore,driver,inputAllowed,prepare,control,rows,signal,canSend=true,
    store=new FileTransfers(root),checkAccess=(job)=>withUiSelection(root,job.selectionScope,job.key,()=>store.allowed(job.key,job.sender))}){
    Object.assign(this,{account,selectionStore,driver,inputAllowed,prepare,control,rows,signal,store,checkAccess,canSend});
  }
  list(){return this.store.list().filter(job=>job.uiaFile===true&&job.accountScope===this.selectionStore.accountRef);}
  hasHold(){return this.list().some(job=>job.fileDraftPossible===true);}
  next(){
    const jobs=this.list().sort((a,b)=>a.createdAt-b.createdAt);
    return jobs.find(j=>j.state==='submitting'||j.state==='submitted')??(this.canSend?jobs.find(j=>j.state==='queued'):null)??null;
  }
  allowed(job){
    if(this.signal.aborted||Date.now()>=job.deadlineAt||this.control().paused||!this.inputAllowed(true,job)||this.store.account()!==job.accountScope)return false;
    return this.checkAccess(job)&&this.selectionStore.authorizeReplyScope(job.selectionScope)&&
      job.target===job.selectionScope.target&&job.account===job.selectionScope.account;
  }
  save(job,change){Object.assign(job,change);this.store.write(job);}
  async tick(job){
    if(!job||this.signal.aborted)return;
    if(job.state==='submitting'||job.state==='submitted')return this.query(job);
    if(this.control().paused)return;
    if(Date.now()>job.deadlineAt){this.save(job,{state:'expired'});return;}
    const scope=job.selectionScope;
    job.account=this.account;job.target=scope?.target;
    if(!scope||!this.allowed(job)){this.save(job,{state:'cancelled',error:'FILE_ACCESS_CHANGED'});return;}
    let attempted=false;
    try{
      const file=this.store.staged(job),proof=await this.store.hash(file,this.signal);
      if(proof.sha256!==job.sha256||proof.md5!==job.md5||proof.size!==job.size)throw fault('FILE_STAGED_INVALID');
      const attachment={...job,mode:'file',text:'[FILE:'+job.sha256+']',index:0,image:{format:'file',path:file,sha256:job.sha256}};
      if(!this.allowed(job))return;
      const prepared=await this.prepare(attachment);
      if(!prepared.ready)return;
      const view=await this.driver.observe(attachment);
      if(!view.ready||view.draft!==''||!this.allowed(job))return;
      const guard={signal:this.signal,editorToken:view.editorToken,activityRevision:view.activityRevision};
      this.save(job,{state:'submitting',fileDraftPossible:true,filePhase:'paste-intent'});
      attempted=true;
      const pasted=await this.driver.pasteImage(attachment,{...guard,canInput:()=>this.allowed(job)});
      if(!pasted.performed){
        if(pasted.attempted===false)this.save(job,{state:'failed',fileDraftPossible:false,error:pasted.reason??'UI_FILE_PASTE_REFUSED'});
        return;
      }
      const after=await this.driver.observe(attachment);
      if(!after.ready||after.appliedImageId!==job.id||!this.allowed(job))throw fault('UI_FILE_DRAFT_UNCONFIRMED');
      // Navigation and clipboard consumption are complete. Take the baseline
      // here so a previous identical file cannot confirm this submission.
      job.fromTime=Math.max(0,Math.floor(Date.now()/1000)-5);
      const baseline=(await this.rows(job,this.signal)).filter(r=>matches(r,job)).map(rowId);
      if(baseline.length>64)throw fault('UI_FILE_RECEIPT_BASELINE_TOO_LARGE');
      if(!this.allowed(job))throw fault('UI_FILE_SUBMIT_REFUSED');
      this.save(job,{baseline,filePhase:'submit-intent'});
      const submitted=await this.driver.submitImage(attachment,{signal:this.signal,editorToken:after.editorToken,
        activityRevision:after.activityRevision,canSubmit:()=>this.allowed(job)});
      if(submitted?.attempted===false){this.save(job,{state:'failed',filePhase:'submit-refused',error:'UI_FILE_SUBMIT_REFUSED'});return;}
      if(submitted?.performed!==true||submitted.attempted!==true)throw fault('UI_FILE_SUBMIT_UNCONFIRMED');
      this.save(job,{state:'submitted'});
    }catch(error){
      this.save(job,{state:attempted?'submitting':'failed',error:code(error)});
    }finally{await this.driver.releaseTextFocus();}
  }
  async query(job){
    if(job.filePhase!=='submit-intent'){this.save(job,{state:'failed',error:'UI_FILE_INTERRUPTED_DRAFT'});return;}
    if(Date.now()>=job.deadlineAt){this.save(job,{state:'unconfirmed',error:'FILE_DELIVERY_TIMEOUT'});return;}
    if(!Array.isArray(job.baseline)||!Number.isSafeInteger(job.fromTime)){
      this.save(job,{state:'unconfirmed',error:'FILE_RECEIPT_STATE_INVALID'});return;
    }
    let rows;
    try{rows=await this.rows(job,this.signal);}catch{return;}
    const newRows=rows.filter(row=>matches(row,job)&&!job.baseline.includes(rowId(row)));
    if(newRows.length>1){this.save(job,{state:'unconfirmed',error:'FILE_RECEIPT_AMBIGUOUS'});return;}
    const row=newRows[0];
    if(row&&/^\d+$/.test(row.serverId)&&BigInt(row.serverId)>0n){
      this.save(job,{state:'confirmed',fileDraftPossible:false,receipt:{type:'wechat-file',messageId:row.localId,
        serverId:row.serverId,sourceShard:row.sourceShard,serverConfirmed:true}});
    }
  }
}
