import fs from 'node:fs';
import {validUiQuote} from './ui-text-outbox.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveDelivery, readArchivedDelivery, boundedDeliveryNames, deliverySequence } from './delivery-archive.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fault=code=>Object.assign(new Error(code),{code});
const routeLimit=96*1024;
const terminal=new Set(['confirmed','unconfirmed','cancelled','failed']);
const id=value=>/^[a-f0-9]{64}$/.test(value??'');
const reasonCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{2,79}$/.test(value);
const activityReasons=new Set(['UI_USER_ACTIVE','QT_USER_ACTIVE','QT_ACTIVITY_WARMUP','UI_QT_HUMAN_ACTIVITY_CHANGED','QT_HUMAN_ACTIVITY_CHANGED','DRAFT_HUMAN_ACTIVITY_CHANGED','DRAFT_KEYS_HELD','UI_KEYS_HELD']);
const layoutVisibilityWait='UI_QT_LAYOUT_WINDOW_OBSCURED';
const focusAcquisitionRefusals=new Set(['QT_FOCUS_ACQUIRE_UNCONFIRMED','DRAFT_FOCUS_PIXELS_UNVERIFIED','QT_UIA_CAPTION_OBSCURED']);
const auxiliaryFocusWait='QT_FOCUS_WECHAT_AUXILIARY_ACTIVE';
const preparationRefusals=new Set([...activityReasons,layoutVisibilityWait,'UI_QT_LAYOUT_FOCUS_OCCLUDED','UI_QT_LAYOUT_VISIBILITY_BLOCKED',auxiliaryFocusWait,...focusAcquisitionRefusals]);
const originalClipboardRefusals=new Set(['DRAFT_CLIPBOARD_COMPLEX_FORMAT','DRAFT_CLIPBOARD_DATA_TOO_LARGE','DRAFT_CLIPBOARD_FORMAT_INVALID','DRAFT_CLIPBOARD_DATA_UNAVAILABLE']);
export const isOriginalClipboardRefusal=code=>originalClipboardRefusals.has(code);
const returnCaptionRefusals=new Set(['QT_RETURN_CAPTION_UNAVAILABLE','QT_RETURN_CAPTION_WARMUP']);

function returnCaptionCanWait(reason,result,job){
  return returnCaptionRefusals.has(reason)&&(result.code===undefined||result.code===reason)&&result.focusPreflightClean===true&&
    result.attempted===false&&result.inputSent!==true&&result.clipboardRestored!==false&&!result.controlsCleanupFailed&&result.popupCleanup?.closed!==false&&
    ['queued','waiting','paused'].includes(job.state)&&job.index===0&&!job.pendingInput&&!job.inputPending&&
    job.submittedAt==null&&!job.imageDraftPresent&&!job.fileDraftPossible&&!job.nativeRecoveryRequired;
}

function clipboardPreparationCanWait(reason,result,job){
  // A clipboard readback or failed restoration can return the same native
  // code. Only the driver can attest that this was the original snapshot.
  return isOriginalClipboardRefusal(reason)&&(result.code===undefined||result.code===reason)&&result.clipboardPreparationClean===true&&
    result.attempted!==true&&result.inputSent!==true&&result.clipboardRestored!==false&&!result.controlsCleanupFailed&&result.popupCleanup?.closed!==false&&
    ['queued','waiting','paused'].includes(job.state)&&job.index===0&&!job.pendingInput&&!job.inputPending&&
    job.submittedAt==null&&!job.imageDraftPresent&&!job.fileDraftPossible&&!job.nativeRecoveryRequired;
}
const voiceStartupFailures=new Set(['START_FAILED','START_TIMEOUT','UNAVAILABLE','INCOMPATIBLE','CONFIG_CHANGED','PORT_IN_USE','LOCAL_IPV4_REQUIRED','LOCAL_PATH_REQUIRED','PYTHON_INVALID','INSTALL_INCOMPLETE','INSTALL_OUTSIDE_ROOT','LINK_REFUSED','PROFILE_NOT_APPLIED'].map(reason=>'VOICE_SERVICE_'+reason));
function navigationRefusalCanPause(value){
  const evidence=value?.navigationRefusal;
  return value?.code==='UI_QT_SEARCH_TRANSITION_UNCONFIRMED'&&value.clipboardRestored!==false&&value.popupCleanup?.closed!==false&&
    evidence?.version===1&&evidence.messageInputAttempted===false&&['restored','not-borrowed'].includes(evidence.focus);
}
function uiaPreparationRefusalCanPause(value,job){
  const evidence=value?.uiaPreparationRefusal,keys=['version','stage','operation','focus','messageInputAttempted','draftPresent','cleanupConfirmed'];
  return /^UIA_MODE_[A-Z0-9_]{1,70}$/.test(value?.code??'')&&!/CLEANUP_UNCONFIRMED|STOP_UNCONFIRMED|RECORDING_POSSIBLE/.test(value.code)&&value.attempted===false&&value.inputSent!==true&&!value.controlsCleanupFailed&&value.clipboardRestored!==false&&value.popupCleanup?.closed!==false&&
    job?.index===0&&!job.pendingInput&&!job.inputPending&&!job.imageDraftPresent&&!job.nativeRecoveryRequired&&!['submitting','submitted','unconfirmed'].includes(job.state)&&
    evidence&&Object.keys(evidence).length===keys.length&&Object.keys(evidence).every(key=>keys.includes(key))&&evidence.version===1&&evidence.stage==='control-preparation'&&['prepare','navigation-ready','navigation-continuation'].includes(evidence.operation)&&
    ['restored','not-borrowed'].includes(evidence.focus)&&evidence.messageInputAttempted===false&&evidence.draftPresent===false&&evidence.cleanupConfirmed===true;
}
function accountPreflightRefusalCanPause(value){
  const evidence=value?.accountPreflightRefusal,keys=['version','stage','focusBorrowed','voiceLeasePresent','messageInputAttempted','cleanupRequired'];
  return /^(?:UI_ACCOUNT_[A-Z_]+|UI_QT_ACCOUNT_UNVERIFIED)$/.test(value?.code??'')&&value.code!=='UI_ACCOUNT_PROBE_ABORTED'&&value.attempted!==true&&value.inputSent!==true&&value.clipboardRestored!==false&&value.popupCleanup?.closed!==false&&
    evidence&&Object.keys(evidence).length===keys.length&&Object.keys(evidence).every(key=>keys.includes(key))&&evidence.version===1&&evidence.stage==='background-account'&&evidence.focusBorrowed===false&&evidence.voiceLeasePresent===false&&evidence.messageInputAttempted===false&&evidence.cleanupRequired===false;
}
function focusRefusalCanWait(value){
  if(!focusAcquisitionRefusals.has(value?.code)||value.attempted!==false||value.inputSent===true||value.clipboardRestored===false||value.controlsCleanupFailed||value.popupCleanup?.closed===false)return false;
  const confirmation=value.focusConfirmation;
  if(confirmation?.confirmed!==false||confirmation.reason==='foreground-changed'||confirmation.activation?.foregroundAfter==='other'||confirmation.activation?.calibratedClickAttempted===true)return false;
  const outcome=value.focusRestoreOutcome;
  if(outcome?.version!==1||outcome.identitiesUnchanged!==true||outcome.activityUnchanged!==true||outcome.keysReleased!==true)return false;
  if(outcome.reason==='restored'&&outcome.restored===true&&outcome.skipped===false&&outcome.foregroundOwnedByWechat===true)return true;
  if(value.code!=='QT_FOCUS_ACQUIRE_UNCONFIRMED')return outcome.reason==='foreground-not-wechat'&&outcome.restored===false&&outcome.skipped===true&&outcome.foregroundOwnedByWechat===false&&
    confirmation?.accepted===false&&confirmation.confirmed===false&&confirmation.activation?.foregroundAfter==='source'&&confirmation.activation.calibratedClickAttempted===false&&
    confirmation.activation.raiseCleanup?.confirmed===true&&confirmation.activation.raiseCleanup.reason==='source-order-restored';
  return outcome.reason==='foreground-not-wechat'&&outcome.restored===false&&outcome.skipped===true&&outcome.foregroundOwnedByWechat===false&&
    confirmation?.accepted===false&&confirmation.confirmed===false&&confirmation.reason==='request-rejected'&&confirmation.activation?.foregroundAfter==='source';
}
function noLinks(file){for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_REPLY_LINK_REJECTED');if(path.dirname(at)===at)return;}}
function atomic(file,value){noLinks(file);const tmp=file+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
const emptyPreparation=()=>({version:1,revision:0,kind:'clear',reason:null,deliveryId:null,attempts:0,nextAttemptAt:0,updatedAt:0});
function preparationPath(directory){if(!path.isAbsolute(directory??''))throw fault('UI_PREPARATION_STATE_INVALID');noLinks(directory);return path.join(directory,'preparation-control.json');}
function readPreparation(directory){const file=preparationPath(directory);noLinks(file);if(!fs.existsSync(file))return emptyPreparation();let value;
  try{if(fs.statSync(file).size>2048)throw Error();value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fault('UI_PREPARATION_STATE_INVALID');}
  const legacyNavigationWait=value?.kind==='activity'&&value.reason==='UI_QT_SEARCH_TRANSITION_UNCONFIRMED';
  const fields=Object.keys(emptyPreparation());if(!value||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||!['clear','activity','manual'].includes(value.kind)||!Number.isSafeInteger(value.attempts)||value.attempts<0||value.attempts>31||!Number.isSafeInteger(value.nextAttemptAt)||value.nextAttemptAt<0||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0||
    (value.kind==='clear'?(value.reason!==null||value.deliveryId!==null||value.attempts!==0||value.nextAttemptAt!==0):(!reasonCode(value.reason)||!id(value.deliveryId)||value.attempts<1||value.kind==='activity'&&(!preparationRefusals.has(value.reason)&&!isOriginalClipboardRefusal(value.reason)&&!returnCaptionRefusals.has(value.reason)&&!legacyNavigationWait||value.nextAttemptAt<=value.updatedAt||value.nextAttemptAt-value.updatedAt>15000)||value.kind==='manual'&&value.nextAttemptAt!==0)))throw fault('UI_PREPARATION_STATE_INVALID');
  if(legacyNavigationWait){
    if(value.nextAttemptAt-value.updatedAt!==Math.min(15000,1000*2**Math.min(value.attempts-1,4)))throw fault('UI_PREPARATION_STATE_INVALID');
    // A short-lived older policy persisted automatic navigation retries. Read
    // that valid record as paused under the current policy without overwriting
    // its evidence or revision; only explicit stopped-service recovery clears it.
    return {...value,kind:'manual',nextAttemptAt:0};
  }
  // Older releases kept retrying a blocked acquisition, including across a
  // restart. Do not reissue it after its one clean retry has already elapsed.
  if(value.kind==='activity'&&focusAcquisitionRefusals.has(value.reason)&&value.attempts>=2)return {...value,kind:'manual',nextAttemptAt:0};
  return value;
}
const preparationView=value=>({version:1,revision:value.revision,recoveryRequired:value.kind==='manual',reason:value.reason,kind:value.kind,nextAttemptAt:value.nextAttemptAt});
function changePreparation(directory,change){const file=preparationPath(directory),lock=path.join(directory,'preparation-control.lock'),owner=crypto.randomUUID();noLinks(lock);try{fs.writeFileSync(lock,owner,{flag:'wx',mode:0o600});}catch{throw fault('UI_PREPARATION_CONTROL_BUSY');}
  try{const previous=readPreparation(directory),next=change(previous);if(next===previous)return previous;if(previous.revision>=Number.MAX_SAFE_INTEGER)throw fault('UI_PREPARATION_STATE_INVALID');next.revision=previous.revision+1;atomic(file,next);return next;}finally{noLinks(lock);if(fs.readFileSync(lock,'utf8')===owner)fs.unlinkSync(lock);}
}
/** Safe local-console view. Contains no target identifiers or message text. */
export function inspectPreparationControl(directory){return preparationView(readPreparation(directory));}
/** The local caller must hold its service-stop lease throughout this call.
 * This is not a OneBot action and never starts a service or changes a delivery. */
export function recoverPreparationControl(directory,{expectedRevision,assertStopped,onReviewed}={}){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fault('UI_PREPARATION_VERSION_CONFLICT');
  if(typeof assertStopped!=='function'||assertStopped()!==true)throw fault('UI_PREPARATION_SERVICE_ACTIVE');
  return preparationView(changePreparation(directory,previous=>{if(assertStopped()!==true)throw fault('UI_PREPARATION_SERVICE_ACTIVE');if(previous.revision!==expectedRevision)throw fault('UI_PREPARATION_VERSION_CONFLICT');if(previous.kind==='manual')onReviewed?.(previous);return previous.kind==='clear'?previous:{...emptyPreparation(),updatedAt:Date.now()};}));
}

/** Select output once at admission. A later UI mode change cannot turn an
 * uncertain voice into a new text send, or bypass an older unfinished draft. */
export class UiReplyOutbox {
  constructor({directory,textOutbox,voiceOutbox,modeFor=()=> 'text',prepare=async()=>{},beforeVoice=async()=>{},authorize=()=>false,now=Date.now}={}){
    if(!path.isAbsolute(directory??'')||!textOutbox||typeof modeFor!=='function'||typeof prepare!=='function'||typeof beforeVoice!=='function'||typeof authorize!=='function'||typeof now!=='function')throw fault('UI_REPLY_CONFIG_INVALID');
    noLinks(directory);fs.mkdirSync(directory,{recursive:true,mode:0o700});Object.assign(this,{directory,textOutbox,voiceOutbox,modeFor,prepare,beforeVoice,authorize,now});this.archiveDirectory=path.join(directory,'archive');this.stopped=false;this.active=null;this.controller=new AbortController();readPreparation(directory);
  }
  #file(key){if(!id(key))throw fault('UI_DELIVERY_ID_INVALID');return path.join(this.directory,key+'.json');}
  #read(key){const file=this.#file(key);noLinks(file);let value;if(!fs.existsSync(file))value=readArchivedDelivery(this.archiveDirectory,key,routeLimit);else{if(fs.statSync(file).size>routeLimit)throw fault('UI_REPLY_STATE_INVALID');value=JSON.parse(fs.readFileSync(file,'utf8'));}if(!value)return null;
    if(value.quote!==undefined&&(value.mode!=='text'||!validUiQuote(value.quote,value.target)))throw fault('UI_REPLY_STATE_INVALID');
    if(value.version!==1||value.id!==key||!['text','voice'].includes(value.mode)||typeof value.text!=='string'||!Number.isSafeInteger(value.sequence)||value.sequence<1||value.archivedResult&&(!['confirmed','cancelled'].includes(value.archivedResult.state)||value.archivedResult.id!==key))throw fault('UI_REPLY_STATE_INVALID');return value;}
  #transaction(action){const file=path.join(this.directory,'admission.lock'),owner=crypto.randomUUID();noLinks(file);try{fs.writeFileSync(file,owner,{flag:'wx',mode:0o600});}catch{throw fault('UI_REPLY_BUSY_OR_RECOVERY_REQUIRED');}try{return action();}finally{noLinks(file);if(fs.readFileSync(file,'utf8')===owner)fs.unlinkSync(file);}}
  #routes(){const names=boundedDeliveryNames(this.directory);if(names.length>256)throw fault('UI_REPLY_STORAGE_LIMIT');return names.map(name=>this.#read(name.slice(0,-5))).sort((a,b)=>a.sequence-b.sequence);}
  #prune(){const routes=boundedDeliveryNames(this.directory).map(name=>this.#read(name.slice(0,-5)));let count=0;deliverySequence(this.directory,Math.max(0,...routes.map(route=>route.sequence)));
    for(const route of routes){const result=this.get(route.id),native=route.mode==='voice'?this.voiceOutbox?.get(route.id):null;
      const safe=result?.state==='confirmed'||result?.state==='cancelled'&&(route.mode==='text'?result.index===0&&!result.pendingInput:!native||native.state==='cancelled'&&!native.segments?.some(part=>['record-intent','submitted','unknown'].includes(part.state)));
      if(!safe)continue;
      // The route already holds the full quote and its neighbouring rows.
      const archivedResult={...result};if(route.quote)delete archivedResult.quote;
      archiveDelivery(this.archiveDirectory,route.id,{...route,state:result.state,archivedResult},routeLimit);noLinks(this.#file(route.id));fs.unlinkSync(this.#file(route.id));count++;}
    return{archived:count};}
  prune(){return this.#transaction(()=>this.#prune());}
  enqueue(request){return this.#transaction(()=>{this.#prune();if(request.replyMode!==undefined&&!['text','voice'].includes(request.replyMode))throw fault('UI_REPLY_MODE_INVALID');let route=this.#read(request.deliveryId);if(route){if(route.account!==request.account||route.target!==request.target||route.text!==request.text||route.quote?.id!==request.quote?.id||request.replyMode!==undefined&&route.mode!==request.replyMode)throw fault('UI_DELIVERY_ID_CONFLICT');return this.get(route.id);}
    // Legacy text work already on disk retains its identity and route.
    const legacy=this.textOutbox.get(request.deliveryId);
    if(legacy&&(request.replyMode==='voice'||legacy.quote?.id!==request.quote?.id))throw fault('UI_DELIVERY_ID_CONFLICT');
    const mode=legacy?'text':request.replyMode??this.modeFor(request);if(!['text','voice'].includes(mode))throw fault('UI_REPLY_MODE_INVALID');if(mode==='voice'&&!this.voiceOutbox)throw fault('UI_NATIVE_VOICE_UNAVAILABLE');
    if(request.quote!==undefined&&(mode!=='text'||!validUiQuote(request.quote,request.target)))throw fault('UI_QUOTE_TARGET_INVALID');
    const routes=this.#routes();if(routes.length>=256)throw fault('UI_REPLY_STORAGE_LIMIT');
    const sequence=deliverySequence(this.directory,routes.at(-1)?.sequence??0)+1;deliverySequence(this.directory,sequence);
    route={version:1,id:request.deliveryId,account:request.account,target:request.target,text:request.text,mode,sequence,createdAt:Date.now(),state:'queued',selectionScope:request.selectionScope??null};
    if(request.quote)route.quote=structuredClone(request.quote);
    atomic(this.#file(route.id),route);if(mode==='text')this.textOutbox.enqueue(request);return this.get(route.id);
  });}
  get(key){const route=this.#read(key);if(!route)return this.textOutbox.get(key);if(route.archivedResult)return structuredClone({...route.archivedResult,...(route.quote?{quote:route.quote}:{})});if(route.mode==='text')return this.textOutbox.get(key)??{...route,index:0};
    const native=this.voiceOutbox?.get(key),state=route.state==='cancelled'?'cancelled':native?.state==='confirmed'?'confirmed':native?.state==='unknown'?'unconfirmed':native?.state==='cancelled'?'cancelled':native?'submitting':'queued';
    const evidence=state==='confirmed'?{type:'wechat-native-voice-job-v1',deliveryId:key,account:route.account,target:route.target,textSha256:hash(route.text),voiceId:native.voiceId,segmentCount:native.segments.length,
      receiptsSha256:hash(JSON.stringify(native.segments.map(part=>part.receipt))),nativeVoiceRowConfirmed:true,audioContentVerified:false}:undefined;
    return {...route,state,reason:native?.reason??route.reason,index:0,...(evidence?{receipt:evidence}:{}),nativeState:native?.state??null,
      nativeRecoveryRequired:native?.state==='unknown'||Boolean(native?.segments?.some(part=>['record-intent','submitted','unknown'].includes(part.state)))};
  }
  list(){const routes=this.#routes(),known=new Set(routes.map(route=>route.id));return [...this.textOutbox.list().filter(job=>!known.has(job.id)),...routes.map(route=>this.get(route.id))];}
  control(){const control=this.textOutbox.control(),preparation=inspectPreparationControl(this.directory);return preparation.kind==='clear'?control:{...control,paused:control.paused||preparation.recoveryRequired,reason:preparation.reason,preparation};}
  #time(){const value=this.now();if(!Number.isSafeInteger(value)||value<0)throw fault('UI_PREPARATION_STATE_INVALID');return value;}
  #deferPreparation(job,result){const reason=reasonCode(result?.reason??result?.code)?result.reason??result.code:'UI_PREPARATION_UNVERIFIED',at=this.#time();
    // Waiting never mutates a partial draft or clears an input intention. The
    // existing driver must verify that exact draft before any resumed input.
    const safeWait=clipboardPreparationCanWait(reason,result,job)||returnCaptionCanWait(reason,result,job);
    const canWait=activityReasons.has(reason)&&result?.attempted!==true||[layoutVisibilityWait,auxiliaryFocusWait].includes(reason)&&result?.attempted===false||focusRefusalCanWait(result)||safeWait;
    changePreparation(this.directory,previous=>{
      if(previous.kind==='manual')return previous;
      const acquiring=focusAcquisitionRefusals.has(reason);
      const repeated=previous.deliveryId===job.id&&focusAcquisitionRefusals.has(previous.reason);
      const attempts=acquiring&&!repeated?1:Math.min(31,previous.attempts+1);
      const retry=canWait&&(!acquiring||attempts<2);
      return {version:1,revision:0,kind:retry?'activity':'manual',reason,deliveryId:job.id,attempts,nextAttemptAt:retry?at+Math.min(15000,1000*2**Math.min(attempts-1,4)):0,updatedAt:at};
    });
    return safeWait;
  }
  #rejectUntouchedQuote(job, result) {
    if (!job.quote || result?.quoteDraftUntouched !== true || result.attempted !== false || result.inputSent === true ||
        result.controlsCleanupFailed || result.popupCleanup?.closed === false || result.clipboardRestored === false ||
        (result.code ?? result.reason) !== 'UI_QUOTE_TARGET_UNAVAILABLE') return false;
    const current = this.textOutbox.get(job.id) ?? this.textOutbox.enqueue({deliveryId:job.id, ...job});
    if (!['queued','waiting'].includes(current.state) || current.index || current.pendingInput) return false;
    this.textOutbox.rejectUnstartedQuote(job.id);
    changePreparation(this.directory,previous=>previous.kind==='activity'&&previous.deliveryId===job.id?{...emptyPreparation(),updatedAt:this.#time()}:previous);
    return true;
  }
  async #prepare(job,options,prepare=this.prepare){try{const result=await prepare(job,options);if(options.signal.aborted)return false;
      if(result?.ready===false){if(this.#rejectUntouchedQuote(job,result))return false;this.#deferPreparation(job,result);return false;}
      changePreparation(this.directory,previous=>previous.kind==='activity'?{...emptyPreparation(),updatedAt:this.#time()}:previous);return true;
    }catch(error){if(!options.signal.aborted){
      if(this.#rejectUntouchedQuote(job,error))return false;
      const safeWait=this.#deferPreparation(job,error);
      // These native preparation refusals have no delivery to recover. Keep
      // their persisted pause/backoff while the Reader and OneBot stay alive.
      // Unknown errors and cleanup failures still reach the service boundary.
      // Search may already have pasted a query and pressed Return. A proved
      // focus cleanup permits a durable pause, never automatic navigation retry.
      // Account refusals qualify only with this attempt's pre-focus/no-input
      // proof. Persist a manual lock; ordinary resume cannot retry the probe.
      const focusChangedBeforeInput=['QT_FOCUS_TARGET_CHANGED','DRAFT_FOCUS_SOURCE_CHANGED','QT_FOCUS_TARGET_AMBIGUOUS'].includes(error?.code)&&error.attempted===false&&error.inputSent!==true&&error.clipboardRestored!==false&&!error.controlsCleanupFailed&&error.popupCleanup?.closed!==false;
      if(safeWait||focusChangedBeforeInput||preparationRefusals.has(error?.code)||navigationRefusalCanPause(error)||accountPreflightRefusalCanPause(error)||uiaPreparationRefusalCanPause(error,job))return false;
    }throw error;}}
  async prepareExternal(job,{signal,prepare}={}){
    if(typeof prepare!=='function'||!id(job?.id))throw fault('UI_PREPARATION_STATE_INVALID');
    if(this.activeOperation)throw fault('UI_PREPARATION_BUSY');
    const preparation=readPreparation(this.directory);
    if(this.stopped||signal?.aborted||this.control().paused||preparation.kind==='activity'&&this.#time()<preparation.nextAttemptAt)
      return{ready:false,reason:preparation.reason??'UI_USER_PAUSED'};
    // A second media queue shares exactly the same preparation hold and the
    // global pause cancellation, while retaining its own durable input intent.
    const operation={id:job.id,controller:new AbortController()};this.activeOperation=operation;
    const combined=AbortSignal.any([this.controller.signal,operation.controller.signal,...(signal?[signal]:[])]);
    try{
      const ready=await this.#prepare(job,{signal:combined},prepare);
      return{ready:ready&&!combined.aborted&&!this.control().paused,reason:readPreparation(this.directory).reason??(combined.aborted?'UI_USER_PAUSED':undefined)};
    }catch(error){
      if(!combined.aborted||/CLEANUP_UNCONFIRMED|STOP_UNCONFIRMED|RECORDING_POSSIBLE|FOCUS_RETURN_UNCONFIRMED/.test(error?.code??''))throw error;
      return{ready:false,reason:'UI_USER_PAUSED'};
    }finally{if(this.activeOperation===operation)this.activeOperation=null;}
  }
  #abortActive(key){if(key===undefined||this.activeOperation?.id===key)this.activeOperation?.controller.abort();}
  pause(key){if(key===undefined){const result=this.textOutbox.pause();this.#abortActive();return result;}return this.#transaction(()=>{const route=this.#read(key);if(route?.archivedResult)return this.get(key);if(!route||route.mode==='text'){const result=this.textOutbox.pause(key);this.#abortActive(key);return result;}route.manualPause=true;atomic(this.#file(key),route);this.#abortActive(key);return this.get(key);});}
  resume(key){if(key===undefined){this.textOutbox.resume();changePreparation(this.directory,previous=>previous.kind==='activity'?{...emptyPreparation(),updatedAt:this.#time()}:previous);return this.control();}return this.#transaction(()=>{const route=this.#read(key);if(route?.archivedResult)return this.get(key);if(!route||route.mode==='text')return this.textOutbox.resume(key);route.manualPause=false;atomic(this.#file(key),route);return this.get(key);});}
  cancel(key){return this.#transaction(()=>{const route=this.#read(key);if(route?.archivedResult)return this.get(key);if(!route||route.mode==='text'){const result=this.textOutbox.cancel(key);this.#abortActive(key);return result;}const native=this.voiceOutbox?.get(key);if(['confirmed','cancelled'].includes(native?.state))return this.get(key);if(native){route.cancelRequested=true;route.manualPause=true;}else route.state='cancelled';atomic(this.#file(key),route);this.#abortActive(key);return this.get(key);});}
  tick(){if(this.active)return this.active;this.active=this.#tick().finally(()=>{this.active=null;});return this.active;}
  #request(job){return {deliveryId:job.id,account:job.account,target:job.target,text:job.text,selectionScope:job.selectionScope};}
  #cancelUnsentVoice(job,reason) {
    return this.#transaction(()=>{
      const route=this.#read(job.id);
      if(route.state!=='queued'||route.manualPause||route.cancelRequested||!this.authorize(job))return this.get(job.id);
      route.state='cancelled';
      route.reason=reason;
      route.voiceFallbackEligible=true;
      atomic(this.#file(job.id),route);
      return this.get(job.id);
    });
  }
  async #voice(job,{queryOnly=false,cancelPending=false}={}){
    const operation={id:job.id,controller:new AbortController()};this.activeOperation=operation;
    const signal=AbortSignal.any([this.controller.signal,operation.controller.signal]);
    try{
      if(queryOnly){
        if(typeof this.voiceOutbox.query!=='function')return {blocked:true,reason:'UI_NATIVE_VOICE_RECOVERY_REQUIRED'};
        try{await this.voiceOutbox.query(this.#request(job),{signal,cancelPending});}
        catch(error){
          // A timed-out recording may still be stopping under the native lock.
          // Keep its barrier and wait; this is neither permission to retry nor
          // a reason to tear down the bridge before cleanup finishes.
          if(['NATIVE_VOICE_BUSY','NATIVE_VOICE_BUSY_OR_RECOVERY_REQUIRED'].includes(error.code))return {blocked:true,reason:'UI_NATIVE_VOICE_RECOVERY_REQUIRED',job:this.get(job.id)};
          throw error;
        }
        const updated=this.get(job.id);return updated.nativeRecoveryRequired?{blocked:true,reason:'UI_NATIVE_VOICE_RECOVERY_REQUIRED',job:updated}:updated;
      }
      if(!this.authorize(job)&&!this.voiceOutbox.get(job.id)){this.cancel(job.id);return this.get(job.id);}
      // A cancelled recording waits before its new attempt. Respect that wait
      // before navigating or borrowing focus, not only inside the voice worker.
      const nextVoicePart=this.voiceOutbox.get(job.id)?.segments?.find(part=>!['confirmed','cancelled'].includes(part.state));
      if(this.authorize(job)&&nextVoicePart?.state==='retry-wait'&&Number.isSafeInteger(nextVoicePart.nextAttemptAt)&&this.#time()<nextVoicePart.nextAttemptAt)return this.get(job.id);
      if(this.authorize(job)&&!this.voiceOutbox.get(job.id)){
        // Check readiness before borrowing focus. Only failures in this
        // no-input phase can cancel this voice locally.
        try{await this.beforeVoice(signal);}
        catch(error){
          if(error?.code==='VOICE_SERVICE_CLEANUP_UNCONFIRMED')throw error;
          if(signal.aborted)return this.get(job.id);
          if(!voiceStartupFailures.has(error?.code)||this.voiceOutbox.get(job.id))throw error;
          return this.#cancelUnsentVoice(job,error.code);
        }
        const current=this.get(job.id);
        if(signal.aborted||this.stopped||this.control().paused||current.manualPause||current.cancelRequested||current.state==='cancelled')return current;
      }
      if(this.authorize(job)&&!await this.#prepare(job,{signal}))return this.get(job.id);
      const current=this.get(job.id);
      if(signal.aborted||this.stopped||this.control().paused||current.manualPause||current.cancelRequested||current.state==='cancelled')return current;
      let native;
      try{native=await this.voiceOutbox.run(this.#request(job),{signal});}
      catch(error){
        if(!signal.aborted&&this.voiceOutbox.synthesisFailedBeforeRecording?.(error,job.id)===true&&!this.voiceOutbox.get(job.id))return this.#cancelUnsentVoice(job,'NATIVE_VOICE_SYNTHESIS_FAILED');
        throw error;
      }
      if(!signal.aborted&&native?.state==='cancelled'&&native.segments?.[0]?.audioRefusedBeforeRecording===true&&native.segments[0].state==='cancelled'&&native.segments.slice(1).every(part=>part.state==='prepared')&&native.segments.every(part=>!part.receipt&&!part.cancelledAttempts))return this.#cancelUnsentVoice(job,native.segments[0].reason);
      return this.get(job.id);
    }catch(error){if(error?.code==='VOICE_SERVICE_CLEANUP_UNCONFIRMED')throw error;if(signal.aborted)return this.get(job.id);throw error;}
    finally{if(this.activeOperation===operation)this.activeOperation=null;}
  }
  async #text(job,{queryOnly=false}={}){
    const operation={id:job.id,controller:new AbortController()};this.activeOperation=operation;
    const signal=AbortSignal.any([this.controller.signal,operation.controller.signal]);
    try{
      if(queryOnly){const head=this.textOutbox.list().find(item=>!terminal.has(item.state));if(head?.id!==job.id||!['submitting','submitted'].includes(head.state))return {blocked:true,reason:'UI_TEXT_RECOVERY_REQUIRED'};return await this.textOutbox.tick();}
      // The text queue owns input pacing and holds. Do not borrow focus only
      // to have its next step return without an action.
      const pending=this.textOutbox.get(job.id);
      if(pending&&(pending.state==='conflict'||pending.manualPause||this.#time()<pending.nextActionAt))return pending;
      if(!await this.#prepare(job,{signal}))return this.get(job.id);
      if(signal.aborted||this.stopped||this.control().paused)return this.get(job.id);
      // A process could have exited between route admission and text enqueue.
      if(!this.textOutbox.get(job.id))this.textOutbox.enqueue({deliveryId:job.id,account:job.account,target:job.target,text:job.text,quote:job.quote});
      return await this.textOutbox.tick();
    }catch(error){if(signal.aborted)return this.get(job.id);throw error;}
    finally{try{const current=this.get(job.id);if(signal.aborted||this.stopped||this.control().paused||current?.manualPause||current?.state!=='typing')await this.textOutbox.releaseFocus?.();}finally{if(this.activeOperation===operation)this.activeOperation=null;}}
  }
  async #tick(){if(this.stopped)return null;
    const jobs=this.list(),recovery=jobs.find(job=>job.nativeRecoveryRequired);
    // Receipt recovery is allowed even after a grant was revoked or sending
    // was paused. Never navigate, prepare or record as part of this branch.
    if(recovery)return this.#voice(recovery,{queryOnly:true,cancelPending:Boolean(recovery.cancelRequested)});
    const cancellation=jobs.find(job=>job.mode==='voice'&&job.cancelRequested&&!terminal.has(job.state));
    if(cancellation)return this.#voice(cancellation,{queryOnly:true,cancelPending:true});
    const textRecovery=jobs.find(job=>job.mode!=='voice'&&['submitting','submitted'].includes(job.state));
    if(textRecovery)return this.#text(textRecovery,{queryOnly:true});
    // Revocation is a no-input queue operation, even when navigation is held.
    const revoked=jobs.find(job=>job.mode==='voice'&&!terminal.has(job.state)&&!this.authorize(job)&&!this.voiceOutbox?.get(job.id));
    if(revoked){this.cancel(revoked.id);return this.get(revoked.id);}
    if(this.control().paused)return null;
    const preparation=readPreparation(this.directory);if(preparation.kind==='activity'&&this.#time()<preparation.nextAttemptAt)return null;
    const job=jobs.find(item=>!terminal.has(item.state));if(!job||job.manualPause)return job??null;
    if(job.mode==='voice')return this.#voice(job);
    return this.#text(job);
  }
  stop(){this.stopped=true;this.controller.abort();this.#abortActive();this.textOutbox.stop();this.voiceOutbox?.close();}
  async drain(){try{await this.active;}finally{await Promise.all([this.voiceOutbox?.drain?.(),this.textOutbox.drain?.()]);}}
}
