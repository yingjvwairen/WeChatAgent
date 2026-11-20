import crypto from 'node:crypto';
import { BaseAdapter } from '../base-adapter.js';
import { ReverseOneBotServer } from '../../onebot/reverse-ws-server.js';
import { normalizeOneBotEvent } from '../../onebot/normalize.js';
import { SELECTION_SCOPE_CAPABILITY, selectionScopeFields } from '../../core/selection-scope.js';

export const DURABLE_UI_PROTOCOL = 'durable-ui-v1';
const noOutputCapabilities=()=>({voice:false,image:false,gif:false,quoteReply:false,richQuoteReply:false});
const durablePending = new Set(['queued','waiting','typing','paused','conflict','submitting','submitted']);
const durableTerminal = new Set(['confirmed','unconfirmed','uncertain','cancelled','failed','not_found']);
const durableId = value => /^[a-f0-9]{64}$/.test(value ?? '');
const fail = code => Object.assign(new Error(code), { code, attempted:false });
const validReceipt = (value,{deliveryId,account,kind,target,content,replyMode,quoteEventId}) => {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.type!=='wechat-ui-delivery-v1'||value.deliveryId!==deliveryId||
      value.selfId!==account||value.kind!==kind||value.target!==target||value.textSha256!==crypto.createHash('sha256').update(content).digest('hex')||
      !value.evidence||typeof value.evidence!=='object'||Array.isArray(value.evidence)||Object.keys(value.evidence).length===0)return false;
  if(value.evidence.quoteEventId!==quoteEventId)return false;
  if(replyMode==='image'){
    const evidence=value.evidence;
    const image=evidence.type==='wechat-database-image-v1';
    const gif=evidence.type==='wechat-database-gif-v1'&&typeof evidence.sourceImageMd5==='string'&&/^[a-f0-9]{32}$/.test(evidence.sourceImageMd5)&&
      evidence.gifContentMd5Matched===true&&[47,49,8*2**32+49].includes(evidence.localType);
    if((!image&&!gif)||evidence.deliveryId!==deliveryId||evidence.sourceImageSha256!==content.slice(7,-1)||evidence.nativeImageRowConfirmed!==true||evidence.imageContentVerified!==false)return false;
  }
  try{return Buffer.byteLength(JSON.stringify(value))<=8192;}catch{return false;}
};

export class WechatOneBotAdapter extends BaseAdapter {
  constructor(config = {}, log = () => {}) {
    super('wechat', { mention: true });
    this.log = log;
    this.onUiAccount = config.onUiAccount;
    this.acceptUiMessage = config.acceptUiMessage;
    this.uiOriginBlocked = false;
    this.server = new ReverseOneBotServer(config.server ?? {});
    this.recentOutgoing = new Map();
    this.recentIncoming = new Map();
    this.deliveryProtocol = null;
    this.outputCapabilities = noOutputCapabilities();
    this.selectionScopeRequired = false;
    this.durableAttempts = new Map();
    this.antiLoopTtlMs = Math.max(1000, Number(config.antiLoopTtlMs) || 60000);
    this.server.on('open', () => { this.deliveryProtocol = null; this.#setOutputCapabilities(noOutputCapabilities()); this.selectionScopeRequired = false; this.stats.connected = true; this.emit('open'); });
    this.server.on('close', () => { this.deliveryProtocol = null; this.#setOutputCapabilities(noOutputCapabilities()); this.selectionScopeRequired = false; this.stats.connected = false; this.emit('close'); });
    this.server.on('error', (error) => { this.stats.errors++; this.emit('error', error); });
    this.server.on('invalid', (kind) => { this.stats.errors++; this.log(`[WeChat] ${kind}`); });
    this.server.on('event', (event) => this.#receive(event));
  }

  #setOutputCapabilities(capabilities) {
    this.outputCapabilities=capabilities;
    this.capabilities=Object.freeze({...this.capabilities,quoteReply:capabilities.quoteReply,richQuoteReply:capabilities.richQuoteReply});
  }

  #fingerprint(kind, target, content) {
    return crypto.createHash('sha256').update(JSON.stringify([kind, String(target), String(content).trim()])).digest('hex');
  }

  #prune(now) {
    for (const cache of [this.recentOutgoing, this.recentIncoming]) {
      for (const [key, expires] of cache) if (expires <= now) cache.delete(key);
      while (cache.size > 1000) cache.delete(cache.keys().next().value);
    }
  }

  #receive(event) {
    if (event?.post_type === 'meta_event') {
      if(event.self_id)this.selfId=String(event.self_id);
      if(Array.isArray(event.wechatagent_capabilities)){
        this.deliveryProtocol=event.wechatagent_capabilities.includes(DURABLE_UI_PROTOCOL)?DURABLE_UI_PROTOCOL:null;
        this.selectionScopeRequired=this.deliveryProtocol===DURABLE_UI_PROTOCOL&&event.wechatagent_capabilities.includes(SELECTION_SCOPE_CAPABILITY);
        this.#setOutputCapabilities({quoteReply:this.selectionScopeRequired&&event.wechatagent_capabilities.includes('native-quote-reply-v1'),
          richQuoteReply:this.selectionScopeRequired&&event.wechatagent_capabilities.includes('native-rich-quote-reply-v1'),
          voice:this.deliveryProtocol===DURABLE_UI_PROTOCOL&&event.wechatagent_capabilities.includes('native-voice-output-v1'),
          image:this.deliveryProtocol===DURABLE_UI_PROTOCOL&&event.wechatagent_capabilities.includes('native-image-output-v1'),
          gif:this.deliveryProtocol===DURABLE_UI_PROTOCOL&&event.wechatagent_capabilities.includes('native-image-output-v1')&&event.wechatagent_capabilities.includes('native-gif-output-v1')});
        if(this.deliveryProtocol===DURABLE_UI_PROTOCOL){
          try{this.onUiAccount?.(this.selfId);this.uiOriginBlocked=false;}
          catch{this.uiOriginBlocked=true;this.log('[WeChat] UI origin persistence failed; delivery blocked');}
        }
      }
      this.emit('meta', event); return;
    }
    const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
    if (!message || this.uiOriginBlocked) return;
    if(this.selectionScopeRequired||event.wechatagent?.selectionScope!==undefined){
      if(this.deliveryProtocol!==DURABLE_UI_PROTOCOL||!this.selectionScopeRequired||event.wechatagent?.selectionScope?.eventId!==message.message_id)return;
      try { Object.assign(message,selectionScopeFields({...message,ui_selection_required:true,ui_reply_scope:event.wechatagent.selectionScope})); }
      catch { return; }
    }
    // Audio/video require the Reader metadata and typed URI to agree. The
    // normalizer removes unbound URLs and mismatched references before here.
    const boundAudioVideo=['record','video'].includes(message.message_type)&&message.media?.some(item=>item.kind===(message.message_type==='record'?'audio':'video'));
    if ((!['text','image','file'].includes(message.message_type)&&!boundAudioVideo)||message.message_type==='file'&&!message.files.length || message.message_type === 'image' && !message.images.length) { this.log(`[WeChat] unsupported_message_type=${message.message_type}`); return; }
    if (!message.text) return;
    const intake=event.wechatagent?.intake;
    const durableIntake=intake?.version===1&&/^[a-f0-9]{32}:(0|[1-9][0-9]{0,15})$/.test(intake.cursor??'')&&/^[a-f0-9]{64}$/.test(intake.token??'');
    if(intake!==undefined&&(!durableIntake||this.deliveryProtocol!==DURABLE_UI_PROTOCOL))return;
    if(message.offline_replay&&(!durableIntake||message.ui_selection_required!==true))return;
    const now = Date.now(); this.#prune(now);
    const key = this.#fingerprint(message.kind, message.conversation_id, message.text);
    const selfId = message.self_id;
    if(selfId)this.selfId=selfId;
    if (selfId && (message.sender_id === selfId || String(event.user_id ?? '') === selfId)) return;
    if (!durableIntake&&this.recentOutgoing.has(key)) return;
    const incomingKey = `${message.message_id}:${key}`;
    if (durableIntake) {
      // The callback acknowledges only after account-scoped durable admission.
      // Ordinary EventEmitter delivery is not a persistence receipt.
      if(typeof this.acceptUiMessage!=='function')return;
      void Promise.resolve().then(()=>this.acceptUiMessage(message)).then(accepted=>{
        if(accepted!==true)throw new Error('UI_INTAKE_NOT_PERSISTED');
        return this.server.action('ack_wechatagent_intake',{cursor:intake.cursor,token:intake.token,eventId:String(message.message_id),self_id:String(message.self_id)});
      }).catch(()=>this.log('[WeChat] durable intake awaits confirmed persistence'));
      return;
    }
    if (this.recentIncoming.has(incomingKey)) return;
    this.recentIncoming.set(incomingKey, now + this.antiLoopTtlMs);
    this.stats.messages++; this.emit('message', message);
  }

  async start() { await this.server.start(); }
  async stop() { await this.server.stop(); }
  async sendReply(request) {
    if(!request?.quoteEventId)throw fail('UI_QUOTE_TARGET_INVALID');
    return this.sendText(request);
  }
  async sendText({ kind, target, text, deliveryId, source, contextId, receiptOnly = false, selfId, selectionScope, selectionRequired, deliveryProtocol,replyMode='text',quoteEventId,quoteEventTime }) {
    if(!['text','voice'].includes(replyMode))throw fail('UI_REPLY_MODE_INVALID');
    if(!receiptOnly&&replyMode==='voice'&&!this.outputCapabilities.voice)throw fail('UI_NATIVE_VOICE_UNAVAILABLE');
    if(quoteEventTime!==undefined&&(!quoteEventId||!Number.isSafeInteger(quoteEventTime)||quoteEventTime<=0))throw fail('UI_QUOTE_TARGET_INVALID');
    if(quoteEventId!==undefined){
      if(typeof quoteEventId!=='string'||!durableId(quoteEventId)||replyMode!=='text'||!selectionScope)throw fail('UI_QUOTE_TARGET_INVALID');
      if(!receiptOnly&&!this.outputCapabilities.quoteReply)throw fail('UI_NATIVE_QUOTE_UNAVAILABLE');
    }
    if(this.uiOriginBlocked)throw fail('UI_ASYNC_ORIGIN_UNAVAILABLE');
    if (kind !== 'private' && kind !== 'group') throw new TypeError('invalid WeChat kind');
    const originalContent = String(text ?? ''),content = originalContent.trim();
    if (!content) throw new TypeError('empty WeChat message');
    const id = Number(target);
    // Only synthetic numeric IDs resolved by the WeChat I/O service are accepted.
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('WeChat target must be a synthetic integer ID');
    const account = String(selfId ?? this.selfId ?? '');
    let boundScope;
    if(selectionRequired!==undefined||selectionScope!==undefined||this.selectionScopeRequired){
      boundScope=selectionScopeFields({platform:'wechat',kind,conversation_id:String(id),self_id:account,
        ui_selection_required:selectionRequired??this.selectionScopeRequired,ui_reply_scope:selectionScope}).ui_reply_scope;
      if(!receiptOnly&&(this.deliveryProtocol!==DURABLE_UI_PROTOCOL||!this.selectionScopeRequired))throw fail('UI_SELECTION_PROTOCOL_UNAVAILABLE');
    }
    if (this.deliveryProtocol === DURABLE_UI_PROTOCOL || this.durableAttempts.has(deliveryId) || receiptOnly&&(deliveryProtocol===DURABLE_UI_PROTOCOL||boundScope)) {
      return this.#durableText({ kind, target: String(id), content:originalContent, deliveryId, source, contextId, receiptOnly, account, selectionScope:boundScope,replyMode,quoteEventId,quoteEventTime });
    }
    // Recovery never silently becomes another legacy send, even after a restart
    // or reconnect to a peer which no longer advertises durable-ui-v1.
    if(receiptOnly)return {accepted:false,confirmed:false,attempted:true,delivered:'unconfirmed',deliveryId,reason:'DELIVERY_QUERY_UNAVAILABLE'};
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = { [kind === 'group' ? 'group_id' : 'user_id']: id,
      message: [{ type: 'text', data: { text: content } }],...(deliveryId?{wechatagent_delivery_id:deliveryId}:{}),
      ...(source==='proactive'?{wechatagent_source:'proactive',wechatagent_context_id:contextId}:{}) };
    let result;
    try{result=await this.server.action(action,params);}
    catch(error){
      if(error.code!=='TEXT_DELIVERY_UNCONFIRMED'||error.data?.attempted!==true)throw error;
      this.#prune(Date.now());this.recentOutgoing.set(this.#fingerprint(kind,id,content),Date.now()+this.antiLoopTtlMs);
      this.log(`[WeChat] text_delivery_unconfirmed operation=${String(deliveryId??'').slice(0,12)}`);
      return {accepted:false,attempted:true,delivered:'unconfirmed',deliveryId};
    }
    // The I/O service acknowledges only after a new matching server receipt.
    if (result.data?.receipt !== 'wechat-server-id') return {accepted:false,confirmed:false,attempted:true,delivered:'unconfirmed',deliveryId,reason:'DELIVERY_RECEIPT_INVALID'};
    this.#prune(Date.now());
    this.recentOutgoing.set(this.#fingerprint(kind, id, content), Date.now() + this.antiLoopTtlMs);
    this.stats.sends++; return { accepted: true, confirmed:true, response: result, delivered: 'database-confirmed' };
  }
  async #durableText({kind,target,content,deliveryId,source,contextId,receiptOnly,account,selectionScope,replyMode='text',quoteEventId,quoteEventTime}){
    if(!durableId(deliveryId))throw fail('UI_DELIVERY_ID_REQUIRED');
    if(!/^[1-9][0-9]{0,15}$/.test(account)||!Number.isSafeInteger(Number(account)))throw fail('UI_DELIVERY_ACCOUNT_REQUIRED');
    let attempt=this.durableAttempts.get(deliveryId);
    const scopeKey=selectionScope?JSON.stringify(Object.keys(selectionScope).sort().map(key=>[key,selectionScope[key]])):null;
    if(attempt&&(attempt.kind!==kind||attempt.target!==target||attempt.content!==content||attempt.account!==account||attempt.scopeKey!==scopeKey||attempt.replyMode!==replyMode||attempt.quoteEventId!==quoteEventId))throw fail('UI_DELIVERY_ID_CONFLICT');
    if(attempt?.result?.confirmed)return attempt.result;
    // This in-memory barrier protects concurrent callers. The caller's durable
    // journal supplies receiptOnly after restart; the service also deduplicates ID.
    const query=receiptOnly||!!attempt;
    if(!attempt){
      if(this.durableAttempts.size>=1000){for(const [key,value] of this.durableAttempts)if(durableTerminal.has(value.result?.state)){this.durableAttempts.delete(key);if(this.durableAttempts.size<1000)break;}}
      if(this.durableAttempts.size>=1000)throw fail('UI_DELIVERY_CACHE_FULL');
      attempt={kind,target,content,account,scopeKey,replyMode,quoteEventId};this.durableAttempts.set(deliveryId,attempt);
    }
    // A disconnect or a peer without this capability cannot resolve a job
    // already admitted by the UI service. Keep its identity pending until a
    // read-only query can return a bound terminal result; never submit again.
    if(this.deliveryProtocol!==DURABLE_UI_PROTOCOL)return {accepted:false,confirmed:false,attempted:true,delivered:'unconfirmed',deliveryId,protocol:DURABLE_UI_PROTOCOL,state:'unknown',pending:true,reason:'DELIVERY_PROTOCOL_UNAVAILABLE',retryAfterMs:1500};
    const identity={wechatagent_delivery_protocol:DURABLE_UI_PROTOCOL,wechatagent_delivery_id:deliveryId,self_id:account};
    const segments=replyMode==='image'?[{type:'wechat_image',data:{id:content.slice(7,-1)}}]:[{type:'text',data:{text:content}}];
    if(quoteEventId)segments.unshift({type:'reply',data:{id:quoteEventId,...(quoteEventTime?{time:quoteEventTime}:{})}});
    let result;
    try{
      result=await this.server.action(query?'get_wechatagent_delivery':kind==='group'?'send_group_msg':'send_private_msg',query?
        {...identity,kind,target}:{...identity,[kind==='group'?'group_id':'user_id']:Number(target),message:segments,
          ...(replyMode==='voice'?{wechatagent_reply_mode:'voice'}:{}),...(selectionScope?{wechatagent_selection_scope:selectionScope}:{}),
          ...(source==='proactive'?{wechatagent_source:'proactive',wechatagent_context_id:contextId}:{})});
    }catch(error){
      if(!query&&(error.attempted===false||error.data?.rejected===true&&error.data?.attempted===false)){
        attempt.result={accepted:false,confirmed:false,attempted:false,delivered:'unconfirmed',deliveryId,protocol:DURABLE_UI_PROTOCOL,state:'failed',pending:false,reason:error.code??'DELIVERY_REJECTED'};
        return attempt.result;
      }
      // Lost acknowledgements and query errors are not permission to submit again.
      return {accepted:false,confirmed:false,attempted:true,delivered:'unconfirmed',deliveryId,protocol:DURABLE_UI_PROTOCOL,state:'unknown',pending:true,reason:error.code??'DELIVERY_RESPONSE_UNKNOWN',retryAfterMs:1500};
    }
    const data=result?.data;
    if(!data||data.delivery_protocol!==DURABLE_UI_PROTOCOL||data.delivery_id!==deliveryId||data.kind!==kind||String(data.target)!==target||String(data.self_id)!==account||
        !durablePending.has(data.state)&&!durableTerminal.has(data.state)||data.state==='confirmed'&&!validReceipt(data.receipt,{deliveryId,account,kind,target,content,replyMode,quoteEventId})){
      return {accepted:false,confirmed:false,attempted:true,delivered:'unconfirmed',deliveryId,protocol:DURABLE_UI_PROTOCOL,state:'uncertain',reason:'DELIVERY_RECEIPT_INVALID'};
    }
    const confirmed=data.state==='confirmed',pending=durablePending.has(data.state);
    const unsent=data.voice_not_submitted;
    const voiceNotSubmitted=replyMode==='voice'&&data.state==='cancelled'&&unsent?.deliveryId===deliveryId&&
      unsent.submittedSegments===0&&unsent.textSha256===crypto.createHash('sha256').update(content).digest('hex');
    const delivery={accepted:true,confirmed,attempted:!['queued','waiting','cancelled','failed','not_found'].includes(data.state),
      delivered:confirmed?'ui-confirmed':'unconfirmed',deliveryId,protocol:DURABLE_UI_PROTOCOL,state:data.state,pending,
      ...(confirmed?{receipt:structuredClone(data.receipt)}:{}),...(voiceNotSubmitted?{voiceNotSubmitted:true}:{}),
      retryAfterMs:Number.isInteger(data.retry_after_ms)?Math.max(250,Math.min(30000,data.retry_after_ms)):1500};
    attempt.result=delivery;
    if(confirmed){this.stats.sends++;this.#prune(Date.now());this.recentOutgoing.set(this.#fingerprint(kind,target,content),Date.now()+this.antiLoopTtlMs);}
    return delivery;
  }
  async stickerChoices({kind,target,query}){
    if(this.deliveryProtocol===DURABLE_UI_PROTOCOL&&!this.outputCapabilities.image)return [];
    const result=await this.server.action('get_sticker_list',{kind,target:String(target),...(typeof query==='string'&&query.trim()?{query:query.slice(0,500)}:{})});
    if(this.deliveryProtocol===DURABLE_UI_PROTOCOL)return result.data?.enabled===true&&Array.isArray(result.data.stickers)?result.data.stickers.filter(item=>
      durableId(item?.id)&&['image','sticker'].includes(item.kind)&&typeof item.description==='string'&&item.description.trim()&&item.description.length<=120&&!/[\u0000-\u001f\u007f]/u.test(item.description)&&
      (item.format==='gif'?this.outputCapabilities.gif&&typeof item.animated==='boolean':item.animated!==true&&(item.format===undefined||['png','jpeg'].includes(item.format)))&&
      Array.isArray(item.tags)&&item.tags.length<=6&&item.tags.every(tag=>typeof tag==='string'&&tag.trim()&&tag.length<=16&&!/[\u0000-\u001f\u007f]/u.test(tag)))
      .slice(0,20).map(item=>({id:item.id,kind:item.kind,description:item.description,tags:[...item.tags],source:'local-reply-media',...(item.format==='gif'?{format:'gif',animated:item.animated}:{})})):[];
    return result.data?.enabled?(result.data.stickers??[]):[];
  }
  async sendSticker({kind,target,id,deliveryId,receiptOnly=false,deferReceipt=false,deadlineAt,abandon=false,selectionRequired,selectionScope,selfId,deliveryProtocol}){
    if(this.uiOriginBlocked)throw fail('UI_ASYNC_ORIGIN_UNAVAILABLE');
    const imageAttempt=this.durableAttempts.get(deliveryId)?.replyMode==='image';
    const nativeImage=this.outputCapabilities.image||imageAttempt||deliveryProtocol===DURABLE_UI_PROTOCOL;
    if(nativeImage){
      if(!['private','group'].includes(kind)||!durableId(id)||!Number.isSafeInteger(Number(target))||Number(target)<=0)throw fail('UI_IMAGE_REQUEST_INVALID');
      const account=String(selfId??this.selfId??''),recipient=String(Number(target)),queryOnly=receiptOnly||abandon||imageAttempt;let boundScope;
      if(selectionRequired!==undefined||selectionScope!==undefined||this.selectionScopeRequired){
        boundScope=selectionScopeFields({platform:'wechat',kind,conversation_id:recipient,self_id:account,ui_selection_required:selectionRequired??this.selectionScopeRequired,ui_reply_scope:selectionScope}).ui_reply_scope;
        if(!queryOnly&&(this.deliveryProtocol!==DURABLE_UI_PROTOCOL||!this.selectionScopeRequired))throw fail('UI_SELECTION_PROTOCOL_UNAVAILABLE');
      }
      if(!queryOnly&&!this.outputCapabilities.image)throw fail('UI_NATIVE_IMAGE_UNAVAILABLE');
      // An abandon request is query-only. It cannot erase a desktop intention
      // or cause this image to fall back to the legacy Hook sticker sender.
      return this.#durableText({kind,target:recipient,content:'[IMAGE:'+id+']',deliveryId,receiptOnly:queryOnly,account,selectionScope:boundScope,replyMode:'image'});
    }
    // The origin travels with persisted media. Connection capabilities may
    // disappear/reconnect to Hook, but cannot authorize a scoped UI sticker.
    if(selectionRequired!==undefined||selectionScope!==undefined||this.selectionScopeRequired||this.deliveryProtocol===DURABLE_UI_PROTOCOL)
      throw fail('UI_STICKER_UNSUPPORTED');
    if(!['private','group'].includes(kind)||!/^[a-f0-9]{64}$/.test(id))throw new TypeError('invalid sticker target');
    let result;
    try{result=await this.server.action(kind==='group'?'send_group_msg':'send_private_msg',{
      [kind==='group'?'group_id':'user_id']:Number(target),message:[{type:'wechat_sticker',data:{id}}],...(deliveryId?{wechatagent_delivery_id:deliveryId}:{}),...(receiptOnly?{wechatagent_receipt_only:true}:{}),...(deferReceipt?{wechatagent_defer_receipt:true}:{}),...(abandon?{wechatagent_abandon_delivery:true}:{}),...(deadlineAt!==undefined?{wechatagent_deadline_at:deadlineAt}:{})});}
    catch(error){
      if(error.code!=='STICKER_DELIVERY_UNCONFIRMED'||error.data?.attempted!==true)throw error;
      this.log(`[WeChat] sticker_delivery_unconfirmed operation=${String(deliveryId??'').slice(0,12)}`);
      return {accepted:false,attempted:true,delivered:'unconfirmed',deliveryId};
    }
    if(abandon&&result.data?.released===true)return result.data;
    if(result.data?.receipt!=='wechat-server-id'||result.data?.media_type!=='wechat-sticker')throw new Error('Sticker send has no server receipt');
    this.stats.sends++;return result;
  }
  async stickerLabels({kind,target,ids}){return (await this.server.action('get_sticker_labels',{kind,target:String(target),ids})).data?.labels??[];}
  async saveStickerLabels({kind,target,labels}){return this.server.action('save_sticker_labels',{kind,target:String(target),labels});}
  async sendPrivateMessage(target, text, options = {}) { return this.sendText({ ...options, kind: 'private', target, text }); }
  async sendGroupMessage(target, text, options = {}) { return this.sendText({ ...options, kind: 'group', target, text }); }
  async reply() { throw new Error('unsupported_capability: nativeReply'); }
  getCapabilities() { return {...this.capabilities,durableDelivery:this.deliveryProtocol===DURABLE_UI_PROTOCOL?DURABLE_UI_PROTOCOL:null}; }
}
