import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const md5=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const gifTypes=new Set([47,49,8*2**32+49]);
const receiptType=binding=>binding.imageFormat==='gif'?'wechat-database-gif-v1':'wechat-database-image-v1';
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u0020\u007f]/u.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const decimal=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const fault=code=>Object.assign(new Error(code),{code});
const safeCode=error=>/^UI_IMAGE_RECEIPT_[A-Z_]{1,64}$/.test(error?.code??'')?error.code:'UI_IMAGE_RECEIPT_UNAVAILABLE';
function noLinks(file){for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_IMAGE_RECEIPT_LINK_REFUSED');if(path.dirname(at)===at)return;}}
function atomic(file,value){
  noLinks(file);const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try{const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}noLinks(file);fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

/** A unique new outgoing type-3 row is static-image submission evidence only.
 * GIFs require a native sticker row with the exact source file MD5. Neither
 * receipt kind compares decoded image pixels.
 * prepare is single-use. Persist submitted(job, at) immediately before native
 * submit; a crash or uncertainty never permits preparing the same ID again. */
export class UiImageReaderReceipts {
  constructor({directory,baseUrl,token,accountWxid,accountDirectory,allowedTargets,fetchImpl=fetch,timeoutMs=1500,now=Date.now}={}){
    let url;try{url=new URL(baseUrl);}catch{throw fault('UI_IMAGE_RECEIPT_CONFIG_INVALID');}
    if(!path.isAbsolute(directory??'')||!safeId(accountWxid)||!safeId(accountDirectory)||/[\\/]/u.test(accountDirectory)||['.','..'].includes(accountDirectory)||
      !safeId(token)||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
      !Array.isArray(allowedTargets)||allowedTargets.length<1||allowedTargets.length>32||new Set(allowedTargets).size!==allowedTargets.length||allowedTargets.some(target=>!safeId(target)||target===accountWxid)||
      typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>10000)throw fault('UI_IMAGE_RECEIPT_CONFIG_INVALID');
    Object.assign(this,{baseUrl:url.origin,token,accountWxid,accountDirectory,fetchImpl,timeoutMs,now});this.allowedTargets=new Set(allowedTargets);
    this.directory=path.join(directory,'image-'+hash(JSON.stringify([accountWxid,accountDirectory])));noLinks(this.directory);fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
  }
  #time(){const at=this.now();if(!integer(at))throw fault('UI_IMAGE_RECEIPT_CLOCK_INVALID');return at;}
  #job(job){
    if(!object(job)||!digest(job.id)||job.account!==this.accountWxid||!this.allowedTargets.has(job.target)||!digest(job.sourceImageSha256)||!integer(job.deadlineAt))throw fault('UI_IMAGE_RECEIPT_JOB_INVALID');
    if(job.imageFormat!==undefined&&job.imageFormat!=='gif'||job.imageFormat==='gif'&&!md5(job.sourceImageMd5)||job.imageFormat===undefined&&job.sourceImageMd5!==undefined)throw fault('UI_IMAGE_RECEIPT_JOB_INVALID');
    return{version:1,id:job.id,account:job.account,accountDirectory:this.accountDirectory,target:job.target,sourceImageSha256:job.sourceImageSha256,deadlineAt:job.deadlineAt,
      ...(job.imageFormat==='gif'?{imageFormat:'gif',sourceImageMd5:job.sourceImageMd5}:{})};
  }
  #file(binding){return path.join(this.directory,binding.id+'.json');}
  #read(binding){
    const file=this.#file(binding);noLinks(file);const stat=fs.statSync(file,{throwIfNoEntry:false});if(!stat)return null;
    if(!stat.isFile()||stat.size>128*1024)throw fault('UI_IMAGE_RECEIPT_STATE_INVALID');
    let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fault('UI_IMAGE_RECEIPT_STATE_INVALID');}
    if(!object(value)||Object.keys(binding).some(key=>value[key]!==binding[key])||value.imageFormat!==binding.imageFormat||value.sourceImageMd5!==binding.sourceImageMd5)throw fault('UI_IMAGE_RECEIPT_BINDING_MISMATCH');
    if(!['prepared','submitted','confirmed','unknown'].includes(value.state)||!integer(value.baselineAt)||!integer(value.preparedAt)||value.preparedAt<value.baselineAt||
      value.deadlineAt<=value.preparedAt||value.deadlineAt-value.baselineAt>300000||value.fromTime!==Math.max(0,Math.floor(value.baselineAt/1000)-1)||!uuid(value.preparationToken)||
      !Array.isArray(value.baselineRows)||value.baselineRows.length>500||value.baselineRows.some(item=>!digest(item))||
      !Array.isArray(value.baselineServerIds)||value.baselineServerIds.length>500||value.baselineServerIds.some(item=>!decimal(item))||
      value.state!=='prepared'&&(!integer(value.submittedAt)||value.submittedAt<value.preparedAt||value.submittedAt>value.deadlineAt)||
      value.state==='unknown'&&!['UI_IMAGE_RECEIPT_AMBIGUOUS','UI_IMAGE_RECEIPT_QUERY_EXPIRED'].includes(value.reason))throw fault('UI_IMAGE_RECEIPT_STATE_INVALID');
    if(value.state==='confirmed'){
      const r=value.receipt;
      if(!object(r)||r.type!==receiptType(binding)||r.deliveryId!==binding.id||r.account!==binding.account||r.accountDirectory!==binding.accountDirectory||r.target!==binding.target||r.sourceImageSha256!==binding.sourceImageSha256||
        r.nativeImageRowConfirmed!==true||r.imageContentVerified!==false||!digest(r.sourceShard)||!decimal(r.localId)||!decimal(r.serverId)||
        (binding.imageFormat==='gif'? !gifTypes.has(r.localType)||r.sourceImageMd5!==binding.sourceImageMd5||r.gifContentMd5Matched!==true:r.localType!==3)||!integer(r.createTime)||
        r.createTime<Math.floor(value.submittedAt/1000)||r.createTime>Math.floor(value.deadlineAt/1000)||!integer(r.observedAt))throw fault('UI_IMAGE_RECEIPT_STATE_INVALID');
    }
    return value;
  }
  #lock(binding){
    const file=this.#file(binding)+'.lock';noLinks(file);let fd;try{fd=fs.openSync(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fault('UI_IMAGE_RECEIPT_BUSY');throw error;}
    const owner=crypto.randomUUID();try{fs.writeFileSync(fd,owner);}finally{fs.closeSync(fd);}
    return()=>{noLinks(file);if(fs.readFileSync(file,'utf8')===owner)fs.unlinkSync(file);};
  }
  async #bounded(action,signal){
    const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const active=()=>{if(combined.aborted)throw fault(signal?.aborted?'UI_IMAGE_RECEIPT_ABORTED':'UI_IMAGE_RECEIPT_TIMEOUT');};let timer,abort;
    try{active();return await Promise.race([Promise.resolve().then(()=>action(combined,active)),new Promise((_,reject)=>{
      abort=()=>reject(fault(signal?.aborted?'UI_IMAGE_RECEIPT_ABORTED':'UI_IMAGE_RECEIPT_TIMEOUT'));combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    })]);}finally{clearTimeout(timer);if(abort)combined.removeEventListener('abort',abort);controller.abort();}
  }
  async #rows(binding,fromTime,signal,active){
    const gif=binding.imageFormat==='gif';
    active();const response=await this.fetchImpl(this.baseUrl+'/api/v1/image-receipts?talker='+encodeURIComponent(binding.target)+'&from_time='+fromTime+(gif?'&kind=gif':''),{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+this.token},signal});active();
    if(!response.ok||!response.body||!/application\/json/i.test(response.headers.get('content-type')??'')){response.body?.cancel().catch(()=>{});throw fault('UI_IMAGE_RECEIPT_HTTP_FAILED');}
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{for(;;){active();const value=await reader.read();active();if(value.done)break;bytes+=value.value.byteLength;if(bytes>512*1024)throw fault('UI_IMAGE_RECEIPT_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value.value));}}
    finally{try{await reader.cancel();}catch{}}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('UI_IMAGE_RECEIPT_PROTOCOL_INVALID');}
    if(!object(data)||data.success!==true||data.imageReceiptVersion!==(gif?2:1)||data.receiptBindingVersion!==1||data.backend!=='weflow-cli-nt'||data.ownWxid!==binding.account||data.accountDirectory!==binding.accountDirectory)throw fault('UI_IMAGE_RECEIPT_ACCOUNT_MISMATCH');
    const scope=data.scope;
    if(!object(scope)||scope.version!==1||scope.complete!==true||scope.accountWxid!==binding.account||scope.accountDirectory!==binding.accountDirectory||scope.talker!==binding.target||scope.fromTime!==fromTime||
      !integer(scope.throughTime)||scope.throughTime<fromTime||scope.throughTime>Math.floor(this.#time()/1000)+1||!Array.isArray(data.messages)||data.messages.length>500)throw fault('UI_IMAGE_RECEIPT_SCOPE_INVALID');
    const fields=['sourceShard','localId','serverId','localType','createTime','senderUsername','isSend',...(gif?['contentMd5']:[])];
    const rows=data.messages.map(row=>{
      if(!object(row)||Object.keys(row).length!==fields.length||Object.keys(row).some(key=>!fields.includes(key))||!digest(row.sourceShard)||!decimal(row.localId)||
        typeof row.serverId!=='string'||row.serverId!=='0'&&!decimal(row.serverId)||(gif?!gifTypes.has(row.localType)||!md5(row.contentMd5):row.localType!==3)||!integer(row.createTime)||row.createTime<fromTime||row.createTime>scope.throughTime||
        typeof row.senderUsername!=='string'||row.senderUsername.length>256||![0,1].includes(row.isSend))throw fault('UI_IMAGE_RECEIPT_ROW_INVALID');
      return{...row,key:hash(JSON.stringify([row.sourceShard,row.localId]))};
    });
    if(new Set(rows.map(row=>row.key)).size!==rows.length)throw fault('UI_IMAGE_RECEIPT_ROW_INVALID');active();return rows;
  }
  async prepare(job,{signal}={}){
    const binding=this.#job(job),unlock=this.#lock(binding);
    try{
      if(this.#read(binding))return{prepared:true,submissionAllowed:false,reason:'UI_IMAGE_RECEIPT_ALREADY_PREPARED'};
      return await this.#bounded(async(combined,active)=>{
        const baselineAt=this.#time();if(binding.deadlineAt<=baselineAt||binding.deadlineAt-baselineAt>300000)throw fault('UI_IMAGE_RECEIPT_PREPARATION_EXPIRED');
        const fromTime=Math.max(0,Math.floor(baselineAt/1000)-1),rows=await this.#rows(binding,fromTime,combined,active),preparedAt=this.#time();
        active();if(preparedAt>=binding.deadlineAt)throw fault('UI_IMAGE_RECEIPT_PREPARATION_EXPIRED');
        const preparationToken=crypto.randomUUID();atomic(this.#file(binding),{...binding,state:'prepared',baselineAt,preparedAt,fromTime,preparationToken,
          baselineRows:rows.map(row=>row.key),baselineServerIds:[...new Set(rows.map(row=>row.serverId).filter(decimal))]});
        return{prepared:true,submissionAllowed:true,preparationToken};
      },signal);
    }finally{unlock();}
  }
  submitted(job,at=this.#time()){
    const binding=this.#job(job),unlock=this.#lock(binding);
    try{
      const record=this.#read(binding);if(!record)throw fault('UI_IMAGE_RECEIPT_BASELINE_MISSING');
      if(!integer(at)||at<record.preparedAt||at>binding.deadlineAt||at>this.#time()+1)throw fault('UI_IMAGE_RECEIPT_SUBMISSION_TIME_INVALID');
      if(record.state!=='prepared'){if(record.submittedAt!==at)throw fault('UI_IMAGE_RECEIPT_BINDING_MISMATCH');return{submitted:true,reused:true};}
      atomic(this.#file(binding),{...record,state:'submitted',submittedAt:at});return{submitted:true,reused:false};
    }finally{unlock();}
  }
  #unknown(binding,record,reason){
    const unlock=this.#lock(binding);try{
      const current=this.#read(binding);if(current.preparationToken!==record.preparationToken)throw fault('UI_IMAGE_RECEIPT_BINDING_MISMATCH');
      if(current.state==='confirmed')return{confirmed:true,receipt:structuredClone(current.receipt)};
      atomic(this.#file(binding),{...current,state:'unknown',reason});return{confirmed:false,reason};
    }finally{unlock();}
  }
  async query(job,{signal}={}){
    try{
      const binding=this.#job(job),record=this.#read(binding);
      if(!record)return{confirmed:false,reason:'UI_IMAGE_RECEIPT_BASELINE_MISSING'};
      if(record.state==='confirmed')return{confirmed:true,receipt:structuredClone(record.receipt)};
      if(record.state==='unknown')return{confirmed:false,reason:record.reason};
      if(record.state==='prepared')return{confirmed:false,reason:'UI_IMAGE_RECEIPT_SUBMIT_TIME_MISSING'};
      return await this.#bounded(async(combined,active)=>{
        if(Math.floor(this.#time()/1000)-record.fromTime>300)return this.#unknown(binding,record,'UI_IMAGE_RECEIPT_QUERY_EXPIRED');
        const rows=await this.#rows(binding,record.fromTime,combined,active);
        const matches=rows.filter(row=>row.senderUsername===binding.account&&row.isSend===1&&row.createTime>=Math.floor(record.submittedAt/1000)&&row.createTime<=Math.floor(binding.deadlineAt/1000)&&
          !record.baselineRows.includes(row.key)&&!record.baselineServerIds.includes(row.serverId)&&(binding.imageFormat!=='gif'||row.contentMd5===binding.sourceImageMd5));
        if(matches.length>1)return this.#unknown(binding,record,'UI_IMAGE_RECEIPT_AMBIGUOUS');
        if(matches.length!==1||!decimal(matches[0].serverId))return{confirmed:false,reason:'UI_IMAGE_RECEIPT_PENDING'};
        active();const unlock=this.#lock(binding);try{
          const current=this.#read(binding);if(current.preparationToken!==record.preparationToken||current.submittedAt!==record.submittedAt)throw fault('UI_IMAGE_RECEIPT_BINDING_MISMATCH');
          if(current.state==='confirmed')return{confirmed:true,receipt:structuredClone(current.receipt)};
          if(current.state==='unknown')return{confirmed:false,reason:current.reason};
          const row=matches[0],receipt={type:receiptType(binding),deliveryId:binding.id,account:binding.account,accountDirectory:binding.accountDirectory,target:binding.target,
            sourceImageSha256:binding.sourceImageSha256,sourceShard:row.sourceShard,localId:row.localId,serverId:row.serverId,localType:row.localType,createTime:row.createTime,observedAt:this.#time(),nativeImageRowConfirmed:true,imageContentVerified:false,
            ...(binding.imageFormat==='gif'?{sourceImageMd5:binding.sourceImageMd5,gifContentMd5Matched:true}:{})};
          atomic(this.#file(binding),{...current,state:'confirmed',receipt});return{confirmed:true,receipt};
        }finally{unlock();}
      },signal);
    }catch(error){return{confirmed:false,reason:safeCode(error)};}
  }
}
