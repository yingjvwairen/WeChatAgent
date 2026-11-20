import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UiTextOutbox, validUiQuote } from './ui-text-outbox.mjs';
import { TargetSelectionStore, createSelectionGuardedDriver } from './target-selection.mjs';
import { SELECTION_SCOPE_CAPABILITY } from '../components/qq-bridge/src/core/selection-scope.js';
import {UiReaderCursor,consumeReaderStream} from './ui-reader-stream.mjs';
import {UiReplyOutbox} from './ui-reply-outbox.mjs';
import {normalizeUiIncomingContent} from './ui-incoming-content.mjs';
import {UiaModeStore} from './uia-mode.mjs';

export const UI_DELIVERY_PROTOCOL = 'durable-ui-v1';
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const wireId = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const deliveryId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const imageMarker = value => '[IMAGE:'+value+']';
const jobText = job => job?.mode==='image'?imageMarker(job.sourceImageSha256):job?.text;
const complete = job => ['confirmed','cancelled','failed','unconfirmed'].includes(job.state);
const inputUnresolved = job => !job.manualDraftCleared&&(job.nativeRecoveryRequired||job.state==='unconfirmed'||!['confirmed','submitted'].includes(job.state)&&
  (job.imageDraftPresent||job.pendingInput||job.inputPending||job.index>0));
/** After the old sender drains, untouched queued work can retain its durable
 * ID under the replacement driver. Partial input and unknown submissions
 * require recovery; changing a sender never clears or recreates that work. */
export function uiSenderJobsSwitchSafe(jobs){
  return Array.isArray(jobs)&&jobs.every(job=>object(job)&&(job.state==='confirmed'||
    job.state==='cancelled'&&!job.nativeRecoveryRequired&&(job.manualDraftCleared||!(job.index>0)&&!job.pendingInput&&!job.inputPending&&!job.imageDraftPresent&&!job.audioSha256)||
    job.state==='queued'&&job.index===0&&!job.pendingInput&&!job.inputPending&&!job.imageDraftPresent&&!job.nativeRecoveryRequired&&!job.audioSha256&&
    job.nativeState==null&&job.submittedAt===undefined&&job.deadlineAt===undefined&&!(job.segments?.length)));
}
const knownCode = value => /^(?:UI|UIA_MODE|READER|QT|DRAFT|CONTACT_IDENTITY|NATIVE_VOICE)_[A-Z0-9_]{1,70}$/.test(value ?? '');
const safeCode = error => knownCode(error?.code) ? error.code : 'UI_BACKEND_FAILED';
export const uiOneBotId = value => String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0) % 2147483647n + 1n));

function policyFor(policy) {
  if (!object(policy) || !identity(policy.accountWxid) || !Array.isArray(policy.targets) || policy.targets.length > 256) throw fault('UI_POLICY_INVALID');
  const ids = new Set(), names = new Set();
  for (const target of policy.targets) {
    if (!object(target) || !['private','group'].includes(target.kind) || !wireId(target.id) || !identity(target.wxid) ||
        (target.kind === 'group') !== target.wxid.endsWith('@chatroom') || target.wxid === policy.accountWxid ||
        ids.has(target.kind + ':' + target.id) || names.has(target.wxid)) throw fault('UI_TARGET_BINDING_INVALID');
    // Private IDs are reproducible from the complete username. Group IDs are
    // supplied by the account-scoped Reader group binding, never a display name.
    if (target.kind === 'private' && target.id !== uiOneBotId(target.wxid)) throw fault('UI_TARGET_BINDING_INVALID');
    ids.add(target.kind + ':' + target.id); names.add(target.wxid);
  }
  return structuredClone(policy);
}

function textMessage(message) {
  if (!Array.isArray(message) || !message.length || message.length > 128 || message.some(part => part?.type !== 'text' || typeof part.data?.text !== 'string')) throw fault('UI_TEXT_ONLY');
  const text = message.map(part => part.data.text).join('');
  if (!text.isWellFormed() || !text.trim() || text.length > 4000 || Buffer.byteLength(text) > 16000 || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text)) throw fault('UI_TEXT_INVALID');
  return text;
}
function imageMessage(message){
  if(!Array.isArray(message)||!message.some(part=>part?.type==='wechat_image'))return null;
  const part=message[0];
  if(message.length!==1||!object(part)||Object.keys(part).some(key=>!['type','data'].includes(key))||!object(part.data)||
    Object.keys(part.data).length!==1||!deliveryId(part.data.id))throw fault('UI_IMAGE_MESSAGE_INVALID');
  return part.data.id;
}

/** A durable protocol boundary. Queue admission never claims a live UI match. */
export class UiOneBotBackend {
  constructor({ directory, policy, policyProvider, selectionStore, currentPlan, currentVoicePlan, driver, settings, now,voiceOutbox,fileOutbox,modeFor,beforeVoice,imageOutbox,mediaCatalog,resolveQuote,richQuotes=false,allowUiaBackgroundText=false } = {}) {
    this.policy = policyFor(policy);
    if (typeof directory !== 'string' || !directory || policyProvider !== undefined && typeof policyProvider !== 'function' || !driver) throw fault('UI_BACKEND_CONFIG_INVALID');
    this.policyProvider = policyProvider ?? (() => this.policy);
    if (selectionStore !== undefined && (!selectionStore || !['get','grantIncoming','admitDelivery','authorizeDelivery'].every(key => typeof selectionStore[key] === 'function')))
      throw fault('UI_TARGET_SELECTION_STORE_REQUIRED');
    this.selectionStore = selectionStore;
    this.resolveQuote = resolveQuote;
    this.richQuotes = typeof resolveQuote === 'function' && richQuotes === true;
    if (currentPlan !== undefined && typeof currentPlan !== 'function' || currentVoicePlan !== undefined && typeof currentVoicePlan !== 'function') throw fault('UI_INTERACTION_PLAN_INVALID');
    this.currentPlan = currentPlan;
    this.currentVoicePlan = currentVoicePlan;
    if(typeof allowUiaBackgroundText!=='boolean')throw fault('UI_BACKEND_CONFIG_INVALID');
    if(imageOutbox&&(['get','list','enqueue','tick','control','cancel','stop','drain'].some(name=>typeof imageOutbox[name]!=='function')||
      !mediaCatalog||['list','resolve'].some(name=>typeof mediaCatalog[name]!=='function')))throw fault('UI_BACKEND_CONFIG_INVALID');
    this.imageOutbox=imageOutbox;this.fileOutbox=fileOutbox;this.mediaCatalog=mediaCatalog;
    if (selectionStore) driver = createSelectionGuardedDriver({ store: selectionStore, driver });
    this.selfId = uiOneBotId(this.policy.accountWxid);
    this.lastObservation = null;
    this.lastError = null;
    this.stopped = false;
    this.driver = driver;
    this.seen = new Map();
    const permitted = job => {
      try { return !this.stopped && this.inputPlanAllowed() && this.currentPolicy().targets.some(target => target.wxid === job.target) && job.account === this.policy.accountWxid; }
      catch { return false; }
    };
    const guarded = {
      observe: async job => {
        if (!permitted(job)) {
          this.lastObservation = { ready: false, reason: 'UI_TARGET_NOT_ALLOWED' };
          return this.lastObservation;
        }
        const result = await driver.observe(job);
        this.lastError = null;
        this.lastObservation = { ready: result?.ready === true, reason: result?.ready === true ? null : knownCode(result?.reason) ? result.reason : 'UI_NOT_READY' };
        return result;
      },
      typeGrapheme: (job, guard) => permitted(job) ? driver.typeGrapheme(job, { ...guard, canInput: () => {
        if (!permitted(job) || this.outbox.control().paused) return false;
        const live = this.outbox.get(job.id);
        return live?.revision === job.revision && live.state === 'typing' && !live.manualPause;
      } }) : { performed: false, attempted: false, reason: 'UI_TARGET_NOT_ALLOWED' },
      ...(typeof driver.pasteText==='function'?{pasteText:(job,guard)=>permitted(job)?driver.pasteText(job,{...guard,canInput:()=>{
        if(!permitted(job)||this.outbox.control().paused)return false;
        const live=this.outbox.get(job.id);return live?.revision===job.revision&&live.state==='typing'&&!live.manualPause;
      }}):{performed:false,attempted:false,reason:'UI_TARGET_NOT_ALLOWED'}}:{}),
      submit: (job, guard) => permitted(job) ? driver.submit(job, { ...guard,
        // Receipt preparation is asynchronous. Recheck authorization and local
        // controls immediately after it finishes, before native input begins.
        canSubmit: () => {
          if (!permitted(job) || this.outbox.control().paused) return false;
          const live = this.outbox.get(job.id);
          return live?.revision === job.revision && live.state === 'submitting' && !live.manualPause;
        },
      }) : { performed: false, attempted: false, reason: 'UI_TARGET_NOT_ALLOWED' },
      receipt: async (job, options) => {
        const result = await driver.receipt(job, options);
        const receipt = result?.receipt;
        if (result?.confirmed === true && (!object(receipt) || receipt.type !== 'wechat-database-text-v1' || receipt.deliveryId !== job.id ||
            receipt.account !== job.account || receipt.target !== job.target || receipt.textSha256 !== hash(job.text) || receipt.quoteEventId !== job.quote?.id)) return { confirmed: false };
        return result;
      },
      ...(typeof driver.releaseTextFocus==='function'?{releaseTextFocus:()=>driver.releaseTextFocus()}:{}),
    };
    this.outbox = new UiTextOutbox({ directory: path.join(path.resolve(directory), hash(this.policy.accountWxid)), driver: guarded, settings, now,
      executionMode:'foreground',allowUiaBackgroundText,textEntryModeFor: () => this.currentPlan?.().textEntryMode ?? 'humanized' });
    if(voiceOutbox||modeFor||typeof driver.prepare==='function')this.outbox=new UiReplyOutbox({directory:path.join(path.resolve(directory),hash(this.policy.accountWxid),'routes'),textOutbox:this.outbox,voiceOutbox,modeFor,now,beforeVoice,
      authorize:job=>permitted(job)&&(!selectionStore||selectionStore.authorizeDelivery(job)),
      prepare:async (job,options)=>{
        // Voice owns its final preparation and foreground lease. Do not navigate
        // once here before the handoff transport captures the user's window.
        if (job.quote) {
          if (!this.resolveQuote) return {ready:false, attempted:false, quoteDraftUntouched:true, reason:'UI_QUOTE_TARGET_UNAVAILABLE'};
          try {
            const source = await this.resolveQuote(job.target, job.quote.id, {...options,timestamp:job.quote.timestamp});
            if (!validUiQuote(source, job.target) || source.kind && !this.richQuotes ||
                source.kind !== job.quote.kind || source.id !== job.quote.id || source.text !== job.quote.text ||
                source.sender !== job.quote.sender || source.timestamp !== job.quote.timestamp) throw fault('UI_QUOTE_TARGET_CHANGED');
            // The source ID is immutable. New incoming rows can change which
            // neighbouring bubbles the Reader uses to locate that same message.
            job = {...job, quote:source};
          } catch { return {ready:false, attempted:false, quoteDraftUntouched:true, reason:'UI_QUOTE_TARGET_UNAVAILABLE'}; }
        }
        let voicePlan;
        try{voicePlan=job.mode==='voice'?this.currentVoicePlan?.():null;}catch{voicePlan={allowed:false};}
        const handoff=voicePlan?.allowed===true&&voicePlan.executionMode==='focus-handoff'&&voicePlan.requiresForeground===true&&voicePlan.requiresActivityGuard===true&&voicePlan.activityGuardScope==='handoff-only';
        const voiceAllowed=job.mode!=='voice'||!this.currentVoicePlan||handoff;
        let result=options?.signal?.aborted||!permitted(job)||selectionStore&&!selectionStore.authorizeDelivery(job)
          ?{ready:false,reason:'UI_TARGET_NOT_ALLOWED'}:!voiceAllowed?{ready:false,reason:'UI_INTERACTION_PLAN_BLOCKED'}:handoff
            ?await driver.prepareVoiceHandoff?.(job,options)??{ready:false,reason:'UI_FOCUS_HANDOFF_UNAVAILABLE'}
            :await driver.prepare?.(job,{...options,textEntryMode:this.currentPlan?.().textEntryMode??'humanized',...(job.mode!=='voice'?{interactionPlan:this.currentPlan?.()}: {})})??{ready:true};
        if(result.ready===true&&(options?.signal?.aborted||!permitted(job)||selectionStore&&!selectionStore.authorizeDelivery(job)))result={ready:false,reason:'UI_TARGET_NOT_ALLOWED'};
        if(result.ready===false){this.lastObservation={ready:false,reason:knownCode(result.reason)?result.reason:'UI_NOT_READY'};if(job.mode!=='voice')await driver.releaseTextFocus?.();}
        return result;
      }});
    this.nativeVoiceAvailable=!!voiceOutbox;
    this.nativeImageAvailable=!!imageOutbox;
  }
  allJobs(){return [...this.outbox.list(),...(this.imageOutbox?.list()??[])];}
  senderSwitchSafe(){return !this.fileOutbox?.hasHold()&&uiSenderJobsSwitchSafe(this.allJobs());}
  getJob(id){const text=this.outbox.get(id),image=this.imageOutbox?.get(id);if(text&&image)throw fault('UI_DELIVERY_ID_CONFLICT');return text??image??null;}
  currentPolicy() {
    const current = policyFor(this.policyProvider());
    if (current.accountWxid !== this.policy.accountWxid) throw fault('UI_ACCOUNT_CHANGED');
    return this.selectionStore ? policyFor({ ...current, targets: this.selectionStore.get().targets.map(item => ({ kind: item.wxid.endsWith('@chatroom') ? 'group' : 'private', id: item.id, wxid: item.wxid, name: item.label })) }) : current;
  }
  target(kind, id) {
    if (!['private','group'].includes(kind) || !wireId(String(id))) throw fault('UI_TARGET_INVALID');
    const target = this.currentPolicy().targets.find(item => item.kind === kind && item.id === String(id));
    if (!target) throw fault('UI_TARGET_NOT_ALLOWED');
    return target;
  }
  inputPlanAllowed() {
    if (!this.currentPlan) return true;
    try {
      const plan = this.currentPlan();
      // This backend owns a foreground driver. An unavailable background mode
      // never falls back to it, even if a future planner supports other drivers.
      return plan?.allowed === true && plan.executionMode === 'foreground' && plan.requiresForeground === true && plan.requiresActivityGuard === true;
    } catch { return false; }
  }
  meta() {
    return { time: Math.floor(Date.now() / 1000), self_id: Number(this.selfId), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect',
      wechatagent_capabilities: [UI_DELIVERY_PROTOCOL, ...(this.resolveQuote ? ['native-quote-reply-v1'] : []), ...(this.richQuotes ? ['native-rich-quote-reply-v1'] : []), ...(this.selectionStore ? [SELECTION_SCOPE_CAPABILITY] : []),...(this.nativeVoiceAvailable?['native-voice-output-v1']:[]),...(this.nativeImageAvailable?['native-image-output-v1','native-gif-output-v1']:[])], wechatagent_input_ready: false };
  }
  status() {
    const jobs = this.allJobs();
    const control = this.outbox.control(),paused = control.paused;
    const planAllowed = this.inputPlanAllowed();
    const recovery=this.imageOutbox&&jobs.find(job=>inputUnresolved(job)&&complete(job));
    const ready = this.lastObservation?.ready === true && !this.stopped && !paused && planAllowed&&!recovery;
    return { backend: 'wechat-ui', delivery_protocol: UI_DELIVERY_PROTOCOL, ready,
      reason: ready ? null : this.stopped ? 'UI_BACKEND_STOPPED' : control.preparation?.recoveryRequired ? control.preparation.reason : paused ? 'UI_USER_PAUSED' : !planAllowed ? 'UI_INTERACTION_PLAN_BLOCKED' : recovery ? recovery.mode==='image'?'UI_IMAGE_DRAFT_OR_SUBMISSION_UNCONFIRMED':'UI_TEXT_RECOVERY_REQUIRED' : control.preparation?.reason ?? this.lastError ?? this.lastObservation?.reason ?? 'UI_NOT_OBSERVED', stopped: this.stopped,
      queue: jobs.reduce((counts, job) => { counts[job.state] = (counts[job.state] ?? 0) + 1; return counts; }, {}),
      nativeVoiceAvailable: this.nativeVoiceAvailable, nativeImageAvailable:this.nativeImageAvailable, codexRequired: false };
  }
  result(job, target, id) {
    if (job && (job.account !== this.policy.accountWxid || job.target !== target.wxid || job.id !== id)) throw fault('UI_DELIVERY_BINDING_MISMATCH');
    return { delivery_protocol: UI_DELIVERY_PROTOCOL, delivery_id: id, kind: target.kind, target: target.id, self_id: this.selfId,
      // Keep the bridge polling this exact ID while the native voice receipt
      // remains recoverable. A terminal unconfirmed response would discard the
      // pending reply before a late receipt can update its conversation state.
      state: job?.nativeRecoveryRequired ? 'submitted' : job?.state ?? 'not_found', ...(job?.reason ? { reason: job.reason } : {}),
      ...(job?.mode==='voice'&&job.state==='cancelled'&&!job.nativeRecoveryRequired&&job.voiceFallbackEligible===true
        ?{voice_not_submitted:{deliveryId:id,textSha256:hash(job.text),submittedSegments:0}}:{}),
      ...(job?.state === 'confirmed' ? { receipt: { type: 'wechat-ui-delivery-v1', deliveryId: id, selfId: this.selfId,
        kind: target.kind, target: target.id, textSha256: hash(jobText(job)), evidence: job.receipt } } : {}), retry_after_ms: 1000 };
  }
  async action(request) {
    const echo = typeof request?.echo === 'string' && request.echo.length <= 128 ? request.echo : undefined;
    let mutationStarted = false, definitelyNewSend = false;
    try {
      if (!object(request) || !object(request.params ?? {})) throw fault('UI_REQUEST_INVALID');
      if (this.stopped) throw fault('UI_BACKEND_STOPPED');
      this.currentPolicy();
      const params = request.params ?? {};
      let data;
      if (request.action === 'get_status') data = this.status();
      else if (request.action === 'get_login_info') data = { user_id: Number(this.selfId), nickname: 'WeChatAgent', account_verified: false };
      else if (request.action === 'get_sticker_list') {
        if(!this.nativeImageAvailable)data={enabled:false,stickers:[]};
        else{
          this.target(params.kind,params.target);
          data={enabled:this.mediaCatalog.snapshot?.().enabled!==false,stickers:this.mediaCatalog.list({query:params.query??'',limit:20,includeGif:true})};
        }
      }
      else if (['send_private_msg','send_group_msg','get_wechatagent_delivery'].includes(request.action)) {
        if (params.wechatagent_delivery_protocol !== UI_DELIVERY_PROTOCOL || !deliveryId(params.wechatagent_delivery_id)) throw fault('UI_DELIVERY_PROTOCOL_REQUIRED');
        if (String(params.self_id) !== this.selfId) throw fault('UI_ACCOUNT_MISMATCH');
        const query = request.action === 'get_wechatagent_delivery';
        const kind = query ? params.kind : request.action === 'send_group_msg' ? 'group' : 'private';
        const id = params.wechatagent_delivery_id;
        let job = this.getJob(id);
        definitelyNewSend = !query && job === null;
        let target;
        if(query&&this.selectionStore&&job){
          // Revocation forbids new input, not reading an already submitted
          // operation's result. This path never creates a replacement grant.
          if(kind!==(job.target.endsWith('@chatroom')?'group':'private')||String(params.target)!==uiOneBotId(job.target)||job.account!==this.policy.accountWxid)throw fault('UI_DELIVERY_BINDING_MISMATCH');
          target={kind,id:uiOneBotId(job.target),wxid:job.target};
        }else target=this.target(kind, query ? params.target : params[kind === 'group' ? 'group_id' : 'user_id']);
        if (!query) {
          if (!this.inputPlanAllowed()) throw fault('UI_INTERACTION_PLAN_BLOCKED');
          if (params.wechatagent_source !== undefined || params.wechatagent_context_id !== undefined) throw fault('UI_PROACTIVE_UNAVAILABLE');
          const message = params.message;
          const quoted = Array.isArray(message) && message[0]?.type === 'reply';
          let quote;
          if (quoted) {
            const quoteId = message[0].data?.id;
            const stamp = message[0].data?.time;
            if (stamp !== undefined && (!Number.isSafeInteger(stamp) || stamp <= 0)) throw fault('UI_QUOTE_TARGET_INVALID');
            if (!this.resolveQuote || !deliveryId(quoteId) || params.wechatagent_reply_mode && params.wechatagent_reply_mode !== 'text') throw fault('UI_QUOTE_UNAVAILABLE');
            if (job && job.quote?.id !== quoteId) throw fault('UI_DELIVERY_ID_CONFLICT');
            try { quote = job?.quote ?? await this.resolveQuote(target.wxid, quoteId, {timestamp:stamp}); }
            catch { throw fault('UI_QUOTE_TARGET_UNAVAILABLE'); }
            if (quote?.id !== quoteId || !validUiQuote(quote, target.wxid)) throw fault('UI_QUOTE_TARGET_INVALID');
            if (quote.kind && !this.richQuotes && !job) throw fault('UI_QUOTE_UNAVAILABLE');
          }
          const imageId=quoted?null:imageMessage(message),text=imageId?imageMarker(imageId):textMessage(quoted?message.slice(1):message);
          if (quoted) { job=this.getJob(id); definitelyNewSend=job===null; }
          const replyMode=imageId?'image':params.wechatagent_reply_mode??'text';
          if(imageId&&params.wechatagent_reply_mode!==undefined||!['text','voice','image'].includes(replyMode)||!imageId&&replyMode==='image')throw fault('UI_REPLY_MODE_INVALID');
          if(replyMode==='voice'&&!this.nativeVoiceAvailable)throw fault('UI_NATIVE_VOICE_UNAVAILABLE');
          if(replyMode==='image'&&!this.nativeImageAvailable)throw fault('UI_NATIVE_IMAGE_UNAVAILABLE');
          if (job && (job.account !== this.policy.accountWxid || job.target !== target.wxid || jobText(job) !== text || job.quote?.id !== quote?.id || (job.mode??'text')!==replyMode)) throw fault('UI_DELIVERY_ID_CONFLICT');
          let image;
          if(imageId){
            try{image=job?.image??this.mediaCatalog.resolve(imageId);}catch{throw fault('UI_IMAGE_MATERIAL_UNAVAILABLE');}
            if(image.sha256!==imageId)throw fault('UI_IMAGE_MATERIAL_UNAVAILABLE');
          }
          // Scope grants cannot operate the UI. Persisting the outbox below is
          // the first step which may admit an actual submission.
          this.selectionStore?.admitDelivery({ id, account: this.policy.accountWxid, target: target.wxid, text }, { selectionScope: params.wechatagent_selection_scope });
          mutationStarted = true;
          job = imageId?this.imageOutbox.enqueue({deliveryId:id,account:this.policy.accountWxid,target:target.wxid,image,selectionScope:params.wechatagent_selection_scope})
            :this.outbox.enqueue({ deliveryId: id, account: this.policy.accountWxid, target: target.wxid, text,replyMode,...(quote ? {quote} : {}),selectionScope:params.wechatagent_selection_scope });
        }
        data = this.result(job, target, id);
      } else throw fault('UI_ACTION_UNSUPPORTED');
      return { status: 'ok', retcode: 0, data, ...(echo === undefined ? {} : { echo }) };
    } catch (error) {
      const code = safeCode(error);
      this.lastError = code;
      return { status: 'failed', retcode: 1407, message: code, data: !mutationStarted && definitelyNewSend ? { attempted: false, rejected: true } : { attempted: true, uncertain: true }, ...(echo === undefined ? {} : { echo }) };
    }
  }
  // Reader-bound media retains its type; unsupported messages are not guessed.
  incoming(payload, { replay = false } = {}) {
    if (this.stopped || payload?.event !== 'message.new' || payload.isSend === true || !identity(payload.sessionId) ||
        !identity(payload.talkerId) || payload.talkerId.endsWith('@chatroom') || payload.talkerId === this.policy.accountWxid || !['string','number'].includes(typeof payload.rawid)) return null;
    const group = payload.sessionId.endsWith('@chatroom');
    const system = payload.talkerId === 'wechat-system';
    if (system && payload.other?.contextOnly !== true) return null;
    const target = this.currentPolicy().targets.find(item => item.wxid === payload.sessionId && item.kind === (group ? 'group' : 'private'));
    if (!target || !group && payload.talkerId !== payload.sessionId && !system ||
        payload.conversationId !== undefined && String(payload.conversationId) !== target.id || !replay && this.seen.has(String(payload.rawid))) return null;
    const key = String(payload.rawid); if (!key || key.length > 256) return null;
    const normalized = normalizeUiIncomingContent(payload, { accountWxid: this.policy.accountWxid, group });
    if (!normalized) return null;
    let selectionScope;
    if (this.selectionStore) {
      try { selectionScope = this.selectionStore.grantIncoming({ account: this.policy.accountWxid, target: target.wxid, eventId: key, selectionVersion: payload.selectionVersion }); }
      catch { return null; }
    }
    const userId = Number(uiOneBotId(payload.talkerId));
    this.seen.set(key, true); while (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
    return { time: payload.timestamp, self_id: Number(this.selfId), post_type: 'message', message_type: target.kind, sub_type: group ? 'normal' : 'friend',
      message_id: payload.rawid, user_id: system&&!group?Number(target.id):userId, message: normalized.segments, raw_message: normalized.content,
      sender: { user_id: userId, nickname: system?'微信系统':String(userId) }, wechatagent: { senderWxid: payload.talkerId, ...(group && !system ? {memberId: hash('wechat-member:'+payload.talkerId)} : {}), ...normalized.metadata, ...(selectionScope ? { selectionScope } : {}) },
      ...(group ? { group_id: Number(target.id), ...(typeof target.name === 'string' && target.name ? {group_name: target.name} : {}) } : {}) };
  }
  tick(){if(this.activeTick)return this.activeTick;this.activeTick=Promise.resolve().then(()=>this.#tickOne()).finally(()=>{this.activeTick=null;});return this.activeTick;}
  async #tickOne() {
    if(this.stopped)return null;
    if (this.selectionStore) {
      for (const job of this.allJobs()) {
        // Never relabel an attempted submission as cancelled. Its receipt path
        // remains read-only; unsubmitted revoked jobs cannot block the queue.
        if (!['submitting','submitted','confirmed','unconfirmed','cancelled','failed'].includes(job.state) && !this.selectionStore.authorizeDelivery({...job,text:jobText(job)}))
          (job.mode==='image'?this.imageOutbox:this.outbox).cancel(job.id);
      }
    }
    const file=this.fileOutbox?.next();
    if(file && ['submitting','submitted'].includes(file.state))return this.fileOutbox.tick(file);
    if(this.fileOutbox?.hasHold())return {blocked:true,reason:'UI_FILE_DRAFT_UNCONFIRMED'};
    if(file && !this.outbox.control().paused && this.allJobs().every(job=>
      !inputUnresolved(job) && (complete(job)||job.createdAt>file.createdAt)))
      return this.fileOutbox.tick(file);
    if(!this.imageOutbox)return this.outbox.tick();
    const text=this.outbox.list(),images=this.imageOutbox.list();
    // These branches only recover an existing submission. They never borrow
    // focus, even when another queue has a partial draft or the user paused.
    if(text.some(job=>job.nativeRecoveryRequired||['submitting','submitted'].includes(job.state))){
      if(!(this.outbox instanceof UiReplyOutbox)&&!['submitting','submitted'].includes(text.find(job=>!complete(job))?.state))return{blocked:true,reason:'UI_TEXT_RECOVERY_REQUIRED'};
      return this.outbox.tick();
    }
    if(images.some(job=>['submitting','submitted'].includes(job.state))){
      if(!['submitting','submitted'].includes(images.find(job=>!complete(job))?.state))return{blocked:true,reason:'UI_IMAGE_DRAFT_OR_SUBMISSION_UNCONFIRMED'};
      return this.imageOutbox.tick();
    }
    const textHold=text.find(inputUnresolved),imageHold=images.find(inputUnresolved);
    if(textHold&&imageHold)return{blocked:true,reason:'UI_CROSS_MEDIA_RECOVERY_REQUIRED'};
    if(textHold){
      if(complete(textHold))return{blocked:true,reason:'UI_TEXT_RECOVERY_REQUIRED'};
      return this.outbox.tick();
    }
    if(imageHold){
      if(complete(imageHold)||this.outbox.control().paused)return{blocked:true,reason:'UI_IMAGE_DRAFT_OR_SUBMISSION_UNCONFIRMED'};
      return this.imageOutbox.tick();
    }
    const textHead=text.find(job=>!complete(job)),imageHead=images.find(job=>!complete(job));
    if(imageHead&&(!textHead||imageHead.createdAt<textHead.createdAt)){
      if(this.outbox.control().paused)return null;
      return this.imageOutbox.tick();
    }
    return this.outbox.tick();
  }
  stop() { if(this.stopped)return;this.stopped = true;this.outbox.stop();this.imageOutbox?.stop();this.closing=Promise.resolve().then(()=>this.driver.close?.());this.closing.catch(()=>{}); }
  async shutdown(){this.stop();const results=await Promise.allSettled([this.outbox.active??this.outbox.activeTick,this.outbox.drain?.(),this.closing,this.imageOutbox?.drain(),this.activeTick]);
    const uncertain=results.find(result=>result.status==='rejected'&&/CLEANUP_UNCONFIRMED|STOP_UNCONFIRMED|RECORDING_POSSIBLE/.test(result.reason?.code??''));if(uncertain)throw uncertain.reason;
    if(results[2].status==='rejected')throw fault('UI_NATIVE_CLEANUP_UNCONFIRMED');}
}

/** One loopback reverse-WS connection. Disconnect stops input; restart resumes
 * the same persistent outbox, never recreates a delivery with another ID. */
export class UiOneBotConnection {
  constructor({ backend, url, WebSocketImpl = WebSocket } = {}) {
    const address = new URL(url);
    if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || address.username || address.password || address.search || address.hash || !backend) throw fault('UI_ONEBOT_LOOPBACK_REQUIRED');
    Object.assign(this, { backend, url: address.href, WebSocketImpl, socket: null, timer: null, active: false, connected: false });
    this.intake = new Map();
  }
  async start() {
    if (this.socket) throw fault('UI_ONEBOT_ALREADY_STARTED');
    const socket = this.socket = new this.WebSocketImpl(this.url);
    socket.addEventListener('message', async event => {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 65536) { this.stop(); return; }
      let request; try { request = JSON.parse(event.data); } catch { this.stop(); return; }
      if(request.action==='ack_wechatagent_intake'){
        const item=this.intake.get(request.params?.cursor),valid=item&&request.params?.token===item.token&&request.params?.eventId===item.eventId&&String(request.params?.self_id)===this.backend.selfId;
        if(valid){clearTimeout(item.timer);this.intake.delete(request.params.cursor);item.resolve();}
        if(socket.readyState===1)socket.send(JSON.stringify({status:valid?'ok':'failed',retcode:valid?0:100,message:valid?'ok':'UI_INTAKE_ACK_INVALID',data:{acknowledged:!!valid},echo:request.echo}));
        return;
      }
      const response = await this.backend.action(request);
      if (socket.readyState === 1) socket.send(JSON.stringify(response));
    });
    socket.addEventListener('close', () => { this.connected = false; clearInterval(this.timer); this.backend.stop(); this.onDisconnect?.(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(fault('UI_ONEBOT_CONNECT_TIMEOUT')); }, 5000);
      const failed = () => { clearTimeout(timer); reject(fault('UI_ONEBOT_CONNECT_FAILED')); };
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', failed, { once: true });
      socket.addEventListener('open', () => { clearTimeout(timer); this.connected = true; socket.send(JSON.stringify(this.backend.meta())); resolve(); }, { once: true });
    });
    this.timer = setInterval(async () => {
      if (this.active || !this.connected) return;
      this.active = true;
      try { await this.backend.tick(); } catch (error) { this.failure ??= error;this.backend.lastError = safeCode(error); this.stop(); }
      finally { this.active = false; }
    }, 50);
  }
  sendIncoming(payload) {
    if (!this.connected || this.socket?.readyState !== 1) return false;
    const event = this.backend.incoming(payload);
    if (!event) return false;
    this.socket.send(JSON.stringify(event)); return true;
  }
  sendIncomingDurable(payload,cursor){
    if(!this.connected||this.socket?.readyState!==1)return Promise.reject(fault('UI_ONEBOT_DISCONNECTED'));
    const event=this.backend.incoming(payload,{replay:true});
    // Filtered messages were observed, but never create a model task.
    if(!event)return Promise.resolve();
    if(this.intake.has(cursor))return Promise.reject(fault('UI_INTAKE_BUSY'));
    const token=crypto.randomBytes(32).toString('hex');
    event.wechatagent.intake={version:1,cursor,token};
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.intake.delete(cursor);reject(fault('UI_INTAKE_ACK_TIMEOUT'));},15000);
      this.intake.set(cursor,{token,eventId:String(event.message_id),resolve,reject,timer});
      try{this.socket.send(JSON.stringify(event));}catch(error){clearTimeout(timer);this.intake.delete(cursor);reject(error);}
    });
  }
  stop() { clearInterval(this.timer); this.connected = false;for(const item of this.intake.values()){clearTimeout(item.timer);item.reject(fault('UI_ONEBOT_DISCONNECTED'));}this.intake.clear();this.backend.stop();this.socket?.close(); }
}

export function readUiBridgeConfig(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw fault('UI_CONFIG_FILE_REQUIRED');
  if (fs.statSync(file).size > 65536) throw fault('UI_CONFIG_INVALID');
  return validateUiBridgeConfig(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
}
export function validateUiBridgeConfig(config) {
  if(!object(config)||config.driver!==undefined&&!['uia','qt-visual'].includes(config.driver))throw fault('UI_CONFIG_INVALID');
  if (config.version !== 1 || !identity(config.accountDirectory) || typeof config.hostConfig !== 'string' || !path.isAbsolute(config.hostConfig) ||
      !object(config.reader) || typeof config.reader.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.reader.token) ||
      typeof config.enableInput !== 'boolean' || typeof config.allowSubmit !== 'boolean' || config.allowSubmit && !config.enableInput ||
      (config.allowClipboardReplacement !== undefined && typeof config.allowClipboardReplacement !== 'boolean')) throw fault('UI_CONFIG_INVALID');
  policyFor(config);
  for (const [value, protocol] of [[config.onebotUrl, 'ws:'], [config.reader.baseUrl, 'http:']]) {
    const url = new URL(value);
    if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw fault('UI_LOOPBACK_REQUIRED');
  }
  if (!fs.statSync(config.hostConfig, { throwIfNoEntry: false })?.isFile()) throw fault('UI_BINDING_REQUIRED');
  if (config.selectionFile !== undefined && (typeof config.selectionFile !== 'string' || !path.isAbsolute(config.selectionFile) || !fs.statSync(config.selectionFile, { throwIfNoEntry: false })?.isFile())) throw fault('UI_TARGET_SELECTION_FILE_REQUIRED');
  return { ...config, allowClipboardReplacement: config.allowClipboardReplacement === true };
}

/** Share one real config read only inside a synchronous authorization call.
 * Returning (including returning a promise) ends the scope immediately. Native
 * guards after any await therefore perform a new read; no permission result,
 * selection, control state, or write-ahead intent is cached here. */
export function createSynchronousUiConfigScope(readConfig) {
  if (typeof readConfig !== 'function') throw fault('UI_CONFIG_READER_INVALID');
  let active;
  return {
    read: () => {
      if (!active) return readConfig();
      if (!active.loaded) { active.value = readConfig(); active.loaded = true; }
      return structuredClone(active.value);
    },
    run: check => {
      const prior = active; active ??= { loaded: false };
      try { return check(); } finally { active = prior; }
    },
  };
}

/** A standalone bridge uses the same saved mode as the service. Pin the exact
 * revision for this driver; changing mode requires draining and rebuilding it. */
export function createUiBridgeModeGuard({root,uiaMode,driver}={}) {
  if(uiaMode!==undefined&&typeof uiaMode!=='boolean')throw fault('UI_BACKEND_CONFIG_INVALID');
  const store=new UiaModeStore({root}),selected=store.get();
  if(uiaMode!==undefined&&uiaMode!==selected.enabled)throw fault('UIA_MODE_STATE_CHANGED');
  // Both current modes use the shared Qt executor. The retired WindowsUiDriver
  // cannot provide focus handoff and must not reappear through a legacy config.
  if(driver!=='qt-visual')throw fault('UIA_MODE_DRIVER_REQUIRED');
  return {enabled:selected.enabled,version:selected.version,assertCurrent(){
    const current=store.get();
    if(current.version!==selected.version||current.enabled!==selected.enabled)throw fault('UIA_MODE_STATE_CHANGED');
    return true;
  }};
}

/** Compose native input with persistent Reader preparation. A known refusal
 * must be durably recorded before the outbox is allowed to resume the job. */
export function createReceiptUiDriver({ native, receipts, inputAllowed = () => false, authorizationScope = check => check(), onQuoteConfirmed } = {}) {
  if (!native || !receipts || typeof inputAllowed !== 'function' || typeof authorizationScope !== 'function') throw fault('UI_DRIVER_CONFIG_INVALID');
  let closed = false;
  const refusal = reason => ({ performed: false, attempted: false, reason });
  const inputRefusal = (submit, job, canSubmit) => authorizationScope(() => {
    if (closed) return refusal('UI_BACKEND_STOPPED');
    try {
      if (canSubmit !== undefined && (typeof canSubmit !== 'function' || canSubmit() !== true)) return refusal(submit?'UI_SUBMISSION_REVOKED':'UI_INPUT_REVOKED');
      if (inputAllowed(submit, job) !== true) return refusal(submit ? 'UI_SUBMIT_DISABLED' : 'UI_INPUT_DISABLED');
    } catch (error) {
      // Only failures of this pre-input check are definite refusals. Never
      // reinterpret a failure from native.submit as proof that input was absent.
      return refusal(/^(?:UI|UIA_MODE)_[A-Z0-9_]{1,70}$/.test(error?.code ?? '') ? error.code : 'UI_INPUT_GUARD_FAILED');
    }
    return null;
  });
  return {
    observe: job => {
      const refused = inputRefusal(false, job);
      return refused ? { ready: false, reason: refused.reason } : native.observe(job);
    },
    ...(typeof native.prepare==='function'?{prepare:(job,options)=>{
      const refused=inputRefusal(false,job);
      return options?.signal?.aborted||refused?{ready:false,reason:refused?.reason??'UI_BACKEND_STOPPED'}:native.prepare(job,options);
    }}:{}),
    ...(typeof native.releaseTextFocus==='function'?{releaseTextFocus:()=>native.releaseTextFocus()}:{}),
    ...(typeof native.prepareVoiceHandoff==='function'?{prepareVoiceHandoff:(job,options)=>{
      const refused=inputRefusal(false,job);
      return options?.signal?.aborted||refused?{ready:false,reason:refused?.reason??'UI_BACKEND_STOPPED'}:native.prepareVoiceHandoff(job,options);
    }}:{}),
    typeGrapheme: (job, guard) => {
      const { canInput, ...nativeGuard } = guard ?? {};
      return inputRefusal(false, job, canInput) ?? native.typeGrapheme(job, nativeGuard, { canInput: () => !inputRefusal(false, job, canInput) });
    },
    ...(typeof native.pasteText==='function'?{pasteText:(job,guard)=>{
      const {canInput,...nativeGuard}=guard??{};
      return inputRefusal(false,job,canInput)??native.pasteText(job,nativeGuard,{canInput:()=>!inputRefusal(false,job,canInput)});
    }}:{}),
    submit: async (job, guard) => {
      const { canSubmit,...nativeGuard } = guard ?? {};
      const refused = inputRefusal(true, job, canSubmit);
      if (refused) return refused;
      let prepared,result;
      if(native.textSubmitPreparationPolicy==='receipt-barrier-v1'){
        // Keep the baseline after paste, at this exact submission intention.
        // Only the native driver's read-only checks may overlap its creation;
        // its final input must await this local (never serialized) barrier.
        const preparation=Promise.resolve().then(()=>receipts.prepare(job,{signal:guard?.signal}));
        const settled=preparation.then(value=>({ok:true,value}),error=>({ok:false,error}));
        let barrierCalls=0,barrierGranted=false,nativeFinished=false,nativeFailed=false,nativeError;
        const beforeSubmit=()=>{
          const pending=(async()=>{
            if(++barrierCalls!==1)throw fault('UI_RECEIPT_BARRIER_REUSED');
            const outcome=await settled;if(!outcome.ok)throw outcome.error;
            if(outcome.value?.submissionAllowed!==true)throw fault('UI_RECEIPT_ATTEMPT_ALREADY_PREPARED');
            if(nativeFinished)throw fault('UI_RECEIPT_BARRIER_UNCONFIRMED');
            if(guard?.signal?.aborted)throw fault('UI_RECEIPT_ABORTED');
            barrierGranted=true;return {ready:true,proof:'receipt-baseline-persisted-v1'};
          })();
          // An invalid capability implementation cannot leave a detached
          // rejection if it fails to await its own mandatory barrier.
          pending.catch(()=>{});return pending;
        };
        try{result=await native.submit(job,nativeGuard,{canSubmit:()=>!inputRefusal(true,job,canSubmit),beforeSubmit});}
        catch(error){nativeFailed=true;nativeError=error;}
        finally{nativeFinished=true;}
        // Even an early native refusal/exception joins baseline preparation.
        // Exceptions keep the durable reservation; they never prove no input.
        const outcome=await settled;
        if(nativeFailed)throw nativeError;
        if(!outcome.ok)throw outcome.error;
        prepared=outcome.value;
        if(prepared?.submissionAllowed!==true)throw fault('UI_RECEIPT_ATTEMPT_ALREADY_PREPARED');
        if(!(result?.performed===false&&result?.attempted===false)&&(!barrierGranted||barrierCalls!==1))throw fault('UI_RECEIPT_BARRIER_UNCONFIRMED');
      }else{
        prepared = await receipts.prepare(job);
        if (prepared.submissionAllowed !== true) throw fault('UI_RECEIPT_ATTEMPT_ALREADY_PREPARED');
        result = inputRefusal(true, job, canSubmit) ?? await native.submit(job, nativeGuard,{canSubmit:()=>!inputRefusal(true,job,canSubmit)});
      }
      if (result?.performed === false && result?.attempted === false) {
        const discarded = await receipts.markNotSubmitted(job, { preparationToken: prepared.preparationToken, nativeResult: result });
        if (discarded.notSubmitted !== true) throw fault('UI_RECEIPT_REFUSAL_UNCONFIRMED');
      }
      return result;
    },
    receipt: async (job, options) => {
      const result = await receipts.query(job, options);
      if (job.quote && result.confirmed === true && result.receipt?.quoteEventId === job.quote.id)
        await onQuoteConfirmed?.(job);
      return result;
    },
    close: () => { if (closed) return; closed = true; return native.close(); },
  };
}

/** Image receipts and durable paste intent are owned by UiImageOutbox. This
 * boundary keeps current runtime permission checks outside native request data. */
export function createImageUiDriver({native,inputAllowed=()=>false,authorizeDelivery=()=>false,currentPlan,control=()=>({paused:true}),authorizationScope=check=>check(),prepareThrough=(job,options,prepare)=>prepare(job,options)}={}){
  if(!native||['prepare','observe','pasteImage','submitImage'].some(name=>typeof native[name]!=='function')||
    [inputAllowed,authorizeDelivery,currentPlan,control,authorizationScope,prepareThrough].some(value=>typeof value!=='function'))throw fault('UI_IMAGE_CONFIG_INVALID');
  const allowed=(submit,job,guard)=>authorizationScope(()=>{
    try{const plan=currentPlan();return (!guard||guard()===true)&&control().paused===false&&inputAllowed(submit,job)===true&&
      plan?.allowed===true&&plan.executionMode==='foreground'&&plan.requiresForeground===true&&plan.requiresActivityGuard===true&&
      authorizeDelivery({...job,text:jobText(job)})===true;}catch{return false;}
  });
  const refusal=()=>({performed:false,attempted:false,reason:'UI_IMAGE_INPUT_REVOKED'});
  return{
    prepare:(job,options)=>options?.signal?.aborted||!allowed(false,job,options?.canInput)?{ready:false,reason:'UI_IMAGE_INPUT_REVOKED'}:
      prepareThrough(job,options,(current,phase)=>phase.signal?.aborted||!allowed(false,current,options?.canInput)?{ready:false,reason:'UI_IMAGE_INPUT_REVOKED'}:
        native.prepare(current,{...options,...phase,textEntryMode:'paste',interactionPlan:currentPlan(),canInput:()=>allowed(false,current,options?.canInput)})),
    observe:job=>allowed(false,job)?native.observe(job):{ready:false,reason:'UI_IMAGE_INPUT_REVOKED'},
    ...(typeof native.resumeImage==='function'?{resumeImage:(job,options)=>{
      if(options?.signal?.aborted||!allowed(false,job,options?.canInput))return{ready:false,reason:'UI_IMAGE_INPUT_REVOKED'};
      if(typeof native.canResumeImage!=='function'||native.canResumeImage(job)!==true)return{ready:false,reason:'UI_QT_IMAGE_RESUME_UNAVAILABLE'};
      return prepareThrough(job,options,(current,phase)=>phase.signal?.aborted||!allowed(false,current,options?.canInput)?{ready:false,reason:'UI_IMAGE_INPUT_REVOKED'}:
        native.resumeImage(current,{...options,...phase,canInput:()=>allowed(false,current,options?.canInput)}));
    }}:{}),
    pasteImage:(job,guard)=>{
      const {canInput,canSubmit,...nativeGuard}=guard??{};
      return allowed(false,job,canInput)?native.pasteImage(job,nativeGuard,{canInput:()=>allowed(false,job,canInput)}):refusal();
    },
    submitImage:(job,guard)=>{
      const {canInput,canSubmit,...nativeGuard}=guard??{};
      return allowed(true,job,canSubmit)?native.submitImage(job,nativeGuard,{canSubmit:()=>allowed(true,job,canSubmit)}):refusal();
    },
    releaseTextFocus:()=>native.releaseTextFocus?.(),
  };
}

async function main(args) {
  if (!args.length || args.length === 1 && args[0] === '--help') {
    console.log('DSH 界面发送桥接（需要本地Reader与真实界面绑定）\n  --config <绝对配置路径> [--check]\n默认配置必须显式禁用输入；检查不启动微信操作。'); return;
  }
  if (args[0] !== '--config' || !args[1] || args.length > 3 || args[2] !== undefined && args[2] !== '--check') throw fault('UI_ARGUMENTS_INVALID');
  const file = path.resolve(args[1]), config = readUiBridgeConfig(file);
  if (args[2] === '--check') {
    console.log(JSON.stringify({ configValid: true, deliveryProtocol: UI_DELIVERY_PROTOCOL, codexRequired: false, liveUiVerified: false, readerVerified: false, ready: false, inputSent: false })); return;
  }
  await runUiBridge({config,readConfig:()=>readUiBridgeConfig(file)});
}

export async function runUiBridge({root=path.resolve(import.meta.dirname,'..'),config,readConfig=()=>config,signal,onState=()=>{},onSenderSwitchCheck=()=>{},voiceService,uiaMode}={}) {
  config=validateUiBridgeConfig(config);
  if(signal?.aborted)throw fault('UI_BACKEND_STOPPED');
  const mode=createUiBridgeModeGuard({root,uiaMode,driver:config.driver});
  if (process.env.SOCIAL_ONEBOT_TOKEN) throw fault('UI_ONEBOT_TOKEN_TRANSPORT_UNSUPPORTED');
  const { UiReaderReceipts } = await import('./ui-reader-receipts.mjs');
  const { InteractionPolicyStore } = await import('./runtime-interaction-policy.mjs');
  const interaction = new InteractionPolicyStore({ root });
  const receipts = new UiReaderReceipts({ directory: path.join(root, 'state/ui-receipts', hash(config.accountWxid)), ...config.reader,
    accountWxid: config.accountWxid, accountDirectory: config.accountDirectory });
  const initialBinding=await receipts.checkBinding({signal});
  let selectionStore;
  if (config.selectionFile !== undefined) {
    const { checkLocalReader } = await import('./reader-local-setup.mjs');
    const binding = checkLocalReader({ root });
    if (binding.account.myWxid !== config.accountDirectory) throw fault('UI_TARGET_SELECTION_ACCOUNT_MISMATCH');
    selectionStore = new TargetSelectionStore({ root, accountRef: binding.account.accountRef });
    if (path.resolve(config.selectionFile) !== selectionStore.file) throw fault('UI_TARGET_SELECTION_FILE_REQUIRED');
    selectionStore.get();
  }
  mode.assertCurrent();
  // Window parking is an explicit service-owned switch. UIA works equally on
  // visible and manually offscreen windows without taking their placement.
  const uia=mode.enabled?(await import('./uia-mode-runtime.mjs')).createUiaControlProvider({root,configFile:config.hostConfig}):null;
  const native = (await import('./qt-layout-profiles.mjs')).createLayoutAwareQtDriver({root,configFile:config.hostConfig,requiredIdleMs:config.settings?.idleMs,enableInput:config.enableInput,allowSubmit:config.allowSubmit,allowClipboardReplacement:config.allowClipboardReplacement,receipt:(job,options)=>receipts.query(job,options),
      ...(uia?{prepareWindow:uia.prepareWindow,resolveControls:uia.resolveControls,verifyControls:uia.verifyControls,controlVerificationPolicy:uia.controlVerificationPolicy,navigationPolicy:uia.navigationPolicy}:{}),
      resolveUnknownLayout:request=>import('./qt-auto-layout.mjs').then(module=>module.resolveQtAutoLayout(request))});
  let voiceOutbox,imageOutbox,backend,connection,runFailure;
  const controller = new AbortController();
  const stop = () => { controller.abort();connection?.stop(); };
  signal?.addEventListener('abort',stop,{once:true});
  for (const name of ['SIGINT','SIGTERM']) process.once(name, stop);
  try {
  const authorization = createSynchronousUiConfigScope(readConfig);
  const inputAllowed = (submit = false, job) => {
    mode.assertCurrent();
    const latest = validateUiBridgeConfig(authorization.read());
    if (latest.accountWxid !== config.accountWxid || latest.accountDirectory !== config.accountDirectory || latest.hostConfig !== config.hostConfig ||
        latest.reader.baseUrl !== config.reader.baseUrl || latest.reader.token !== config.reader.token || latest.selectionFile !== config.selectionFile || latest.driver!==config.driver ||
        (config.allowClipboardReplacement && !latest.allowClipboardReplacement)) throw fault('UI_CONNECTION_CONFIG_CHANGED');
    const targets = selectionStore ? selectionStore.get().targets : latest.targets;
    return job?.account === latest.accountWxid && targets.some(target => target.wxid === job.target) &&
      config.enableInput && latest.enableInput && (!submit || config.allowSubmit && latest.allowSubmit);
  };
  const driver = createReceiptUiDriver({ native, receipts, inputAllowed, authorizationScope: authorization.run,
    onQuoteConfirmed: async job => {
      if (!selectionStore) return;
      const {confirmQuoteDraftSent} = await import('./qt-visual-driver.mjs');
      confirmQuoteDraftSent(root,selectionStore.accountRef,job.target,job.id);
    } });
  if(config.driver==='qt-visual'&&config.voice&&selectionStore){
    const {NativeVoiceTransport}=await import('./native-voice-transport.mjs'),{NativeVoiceOutbox}=await import('./native-voice-outbox.mjs');
    const transport=new NativeVoiceTransport({root,driver:native,renderId:config.voice.renderId,captureId:config.voice.captureId,
      currentPlan:()=>interaction.currentPlan('sendNativeVoice'),
      receiptContext:()=>({...config.reader,accountWxid:config.accountWxid,accountDirectory:config.accountDirectory,accountRef:selectionStore.accountRef})});
    voiceOutbox=new NativeVoiceOutbox({root,transport,synthesizer:voiceService,operationTimeoutMs:60000,authorizeScope:scope=>inputAllowed(true,{account:scope.account,target:scope.target})&&interaction.currentPlan('sendNativeVoice').allowed&&selectionStore.authorizeReplyScope(scope)});
  }
  let mediaCatalog;
  if(config.driver==='qt-visual'&&selectionStore?.get().targets.length&&['prepare','observe','pasteImage','submitImage'].every(name=>typeof native[name]==='function')){
    const [{UiImageOutbox},{UiImageReaderReceipts},{ReplyMediaCatalog}]=await Promise.all([import('./ui-image-outbox.mjs'),import('./ui-image-reader-receipts.mjs'),import('./reply-media-catalog.mjs')]);
    mediaCatalog=new ReplyMediaCatalog({root});
    const imageReceipts=new UiImageReaderReceipts({directory:path.join(root,'state/ui-image-receipts',hash(config.accountWxid)),...config.reader,
      accountWxid:config.accountWxid,accountDirectory:config.accountDirectory,allowedTargets:selectionStore.get().targets.map(target=>target.wxid)});
    const imageDriver=createImageUiDriver({native,inputAllowed,authorizationScope:authorization.run,authorizeDelivery:job=>selectionStore.authorizeDelivery(job),
      currentPlan:()=>interaction.currentPlan('sendText'),control:()=>backend?.outbox.control()??{paused:true},
      prepareThrough:(job,options,prepare)=>backend.outbox.prepareExternal(job,{...options,prepare})});
    imageOutbox=new UiImageOutbox({directory:path.join(root,'state/ui-image-deliveries',hash(config.accountWxid)),driver:imageDriver,receipts:imageReceipts,
      settings:{...config.settings,idleMs:native.config.idleMs},authorizeScope:scope=>!backend?.stopped&&backend?.outbox.control().paused===false&&
        inputAllowed(false,{account:scope.account,target:scope.target})&&interaction.currentPlan('sendText').allowed&&selectionStore.authorizeReplyScope(scope)});
  }
  let fileOutbox;
  if(selectionStore){
    const {UiFileOutbox,readUiFileReceipts}=await import('./ui-file-outbox.mjs');
    fileOutbox=new UiFileOutbox({root,account:config.accountWxid,canSend:!!uia&&config.enableInput===true&&config.allowSubmit===true,selectionStore,driver:native,inputAllowed,
      control:()=>backend.outbox.control(),signal:controller.signal,
      prepare:job=>backend.outbox.prepareExternal(job,{signal:controller.signal,prepare:(_job,options)=>native.prepare(job,{
        ...options,textEntryMode:'paste',interactionPlan:interaction.currentPlan('sendText')})}),
      rows:(job,signal)=>readUiFileReceipts({...config.reader,accountDirectory:config.accountDirectory},job,signal)});
  }
  backend = new UiOneBotBackend({ directory: path.join(root, 'state/ui-text-deliveries'), policy: config,
    allowUiaBackgroundText:mode.enabled,
    policyProvider: () => validateUiBridgeConfig(authorization.read()), selectionStore,
    richQuotes: native.nativeRichQuoteAvailable === true && initialBinding.richQuoteTargetVersion === 1,
    resolveQuote: native.nativeQuoteAvailable === true && initialBinding.quoteTargetVersion === 1
      ? (target,id,options)=>receipts.resolveQuote(target,id,options) : undefined,
    currentPlan: () => interaction.currentPlan('sendText'), currentVoicePlan: () => interaction.currentPlan('sendNativeVoice'), driver,
    // Qt checks this threshold before taking focus. The generic outbox's 10s
    // default must not reject an already prepared 1s Qt interaction.
    settings:config.driver==='qt-visual'?{...config.settings,idleMs:native.config.idleMs}:config.settings,
    voiceOutbox,imageOutbox,fileOutbox,mediaCatalog,modeFor:request=>request.replyMode??'text',beforeVoice:voiceService?signal=>voiceService.ensureReady({signal}):undefined });
  onSenderSwitchCheck(()=>backend.senderSwitchSafe());
  connection = new UiOneBotConnection({ backend, url: config.onebotUrl });
  connection.onDisconnect = () => controller.abort();
    if(signal?.aborted)throw fault('UI_BRIDGE_ABORTED');
    await connection.start();
    onState({ob_connected:true,reader_connected:false});
    await receipts.checkBinding({ signal: controller.signal });
    const journal=new UiReaderCursor({directory:path.join(root,'state/ui-reader-cursors'),account:config.accountWxid,
      selectionVersion:config.selectionVersion??initialBinding.selectionVersion??0,initialCursor:config.reader.initialCursor??initialBinding.cursor});
    let streamWatchdog = setTimeout(() => controller.abort(), 5000);
    let response;
    try {
      response = await fetch(config.reader.baseUrl.replace(/\/$/, '') + '/api/v1/push/messages', {
        headers: { Authorization: 'Bearer ' + config.reader.token,'Last-Event-ID':journal.read().cursor }, redirect: 'error', signal: controller.signal,
      });
    } finally { clearTimeout(streamWatchdog); }
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw fault('UI_READER_STREAM_UNAVAILABLE');
    onState({ob_connected:true,reader_connected:true,file_send:fileOutbox?.canSend===true,fileTransfer:fileOutbox?.canSend?'durable-outbox-v1':null});
    await consumeReaderStream({response,journal,signal:controller.signal,
      checkBinding:()=>receipts.checkBinding({signal:controller.signal}),dispatch:(payload,cursor)=>connection.sendIncomingDurable(payload,cursor)});
  } catch(error) { runFailure=connection?.failure??error; } finally {
    stop();
    try{
      if(backend)await backend.shutdown();
      else{
        voiceOutbox?.close();
        imageOutbox?.stop();
        const results=await Promise.allSettled([voiceOutbox?.drain?.(),imageOutbox?.drain(),native.close()]);
        const failed=results.find(result=>result.status==='rejected');if(failed)throw fault('UI_NATIVE_CLEANUP_UNCONFIRMED');
      }
    }finally{
      // Finish or abort every delivery before releasing its read-only UIA worker.
      try{await uia?.close();}
      finally{onState({ob_connected:false,reader_connected:false});signal?.removeEventListener('abort',stop);for (const name of ['SIGINT','SIGTERM']) process.removeListener(name, stop);}
    }
  }
  const senderSwitchSafe=!!backend&&backend.senderSwitchSafe();
  if(runFailure&&!signal?.aborted)throw Object.assign(runFailure,{senderSwitchSafe});
  return {stopped:true,senderSwitchSafe};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
}
