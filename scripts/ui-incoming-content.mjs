import { FORWARD_TYPE, QUOTE_TYPE, normalizeForwardedRecord, normalizeQuoteReply, validOfflineBatch } from '../components/qq-bridge/src/core/wechat-events.js';
import crypto from 'node:crypto';

const refId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeText = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
const cleanTree = value => typeof value === 'string' ? safeText(value) : !value || typeof value !== 'object' || Object.values(value).every(cleanTree);
const sourceLabel = value => safeText(value) && value.length <= 80 && value.length > 0;
const boundedProse = (value,limit) => safeText(value) && value.length<=limit*2 && [...value].length<=limit &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const fieldText = (value,limit) => boundedProse(value,limit) && !/[\r\n\t]/u.test(value);
const appType = kind => Number.isSafeInteger(kind) && kind >= 0 && kind % 2**32 === 49;

/** Retain verified attachment references and the visible fields of received cards.
 * Raw XML and local attachment paths stay in the Reader. */
export function normalizeUiIncomingContent(payload, { accountWxid, group = false } = {}) {
  const kind = payload?.type;
  let content, segments = [], metadata = {};
  if(Object.hasOwn(payload??{},'offlineReplay')){
    if(!['context','reply'].includes(payload.offlineReplay))return null;
    metadata.offlineReplay=payload.offlineReplay;
  }
  if(Object.hasOwn(payload??{},'offlineBatch')){
    if(payload.offlineReplay!=='reply'||!validOfflineBatch(payload.offlineBatch))return null;
    metadata.offlineBatch={...payload.offlineBatch};
  }
  if (group && payload.mentionsSelf === true && typeof accountWxid === 'string' && accountWxid) {
    const selfId = String(crypto.createHash('sha256').update(accountWxid).digest().readBigUInt64BE(0) % 2147483647n + 1n);
    segments.push({ type: 'at', data: { qq: selfId } });
  }
  if (group && payload.mentionsAll === true) {
    segments.push({ type: 'at', data: { qq: 'all' } });
  }
  if (payload.other !== undefined) {
    const other=payload.other;
    if(!Number.isSafeInteger(kind)||!fieldText(other?.label,80)||!other.label.trim()||!boundedProse(other.summary,1500)||other.contextOnly!==true)return null;
    content='['+other.label+']'+(other.summary?' '+other.summary:'');
    metadata.contextOnly=true;
  } else if (payload.link !== undefined && [49,4*2**32+49,5*2**32+49].includes(kind)) {
    const link=payload.link;
    if(!boundedProse(link?.title,256)||!link.title.trim()||!fieldText(link.url,2048)||/\s/u.test(link.url))return null;
    try{const url=new URL(link.url);if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)return null;}catch{return null;}
    content='[链接] '+[link.title,link.url].filter(Boolean).join('\n');
    metadata.quoteKind='link';
  } else if (payload.file !== undefined && (kind===49 || kind===6*2**32+49)) {
    const file=payload.file;
    if(!fieldText(file?.name,180)||!file.name.trim()||/[\\/]/.test(file.name)||
       file.size!==undefined&&(!Number.isSafeInteger(file.size)||file.size<0))return null;
    content='[文件] '+file.name+(file.size===undefined?'':'（'+file.size+' 字节）');
    metadata.quoteKind='file';
    if(refId(file.id)&&file.id===payload.rawid&&Number.isSafeInteger(file.size)&&file.size<=50*1024*1024)
      segments.push({type:'file',data:{id:file.id,name:file.name,size:file.size}});
  } else if(payload.card !== undefined && ([42,48].includes(kind)||appType(kind))){
    const card=payload.card;
    if(!boundedProse(card?.title,512)||!card.title.trim()||!fieldText(card.label,40)||!card.label.trim()||
       card.summary!==undefined&&!boundedProse(card.summary,1500))return null;
    content='['+card.label+'] '+[card.title,card.summary].filter(Boolean).join('\n');
    metadata.quoteKind='card';
  } else if (kind === 1) {
    if (!safeText(payload.content) || !payload.content.trim() || payload.content.length > 16000 || Buffer.byteLength(payload.content) > 16000) return null;
    content = payload.content;
  } else if(payload.attachmentUnavailable===true && [3,47,34,43,62].includes(kind)){
    if(payload.image!==undefined||payload.media!==undefined)return null;
    const [name,type]={3:['图片','image'],47:['表情包','sticker'],34:['语音','voice'],43:['视频','video'],62:['视频','video']}[kind];
    content='['+name+'，附件内容不可用]';
    metadata.quoteKind=type;
  } else if (kind === 3 || kind === 47) {
    if (!refId(payload.image?.id)) return null;
    content = kind === 47 ? '[表情包：附件为静态画面或动画采样画面]' : '[图片]';
    segments.push({ type: 'image', data: { file: 'wechatagent://image/' + payload.image.id, media_id: payload.image.id,
      ...(kind === 47 ? { media_kind: 'sticker' } : {}) } });
  } else if (kind === 34 || kind === 43 || kind === 62) {
    const expected = kind === 34 ? 'audio' : 'video';
    if (!Array.isArray(payload.media) || payload.media.length !== 1 || !refId(payload.media[0]?.id) || payload.media[0].kind !== expected) return null;
    const { id } = payload.media[0];
    metadata.media = [{ id, kind: expected }];
    content = expected === 'audio' ? '[语音消息，等待本地转写]' : '[视频消息，等待本地解析]';
    segments.push({ type: expected === 'audio' ? 'record' : 'video', data: { file: 'wechatagent://media/' + id, media_id: id, media_kind: expected } });
  } else if ([49, FORWARD_TYPE, QUOTE_TYPE].includes(kind)) {
    const forwarded = kind !== QUOTE_TYPE && normalizeForwardedRecord(payload.forwardedRecord);
    const quote = kind !== FORWARD_TYPE && normalizeQuoteReply(payload.quoteReply);
    if (!!forwarded === !!quote || !cleanTree(forwarded || quote)) return null;
    if (forwarded) {
      metadata.forwardedRecord = forwarded;
      content = '[合并转发聊天记录] ' + forwarded.title;
    } else {
      const reference = quote.reference;
      const sameChat = group ? reference.conversationId === payload.sessionId : !reference.conversationId || reference.conversationId === payload.sessionId;
      reference.senderRelation = sameChat && reference.senderId && accountWxid
        ? reference.senderId === accountWxid ? 'self' : reference.senderId === payload.talkerId || group ? 'other' : 'unknown'
        : 'unknown';
      metadata.quoteReply = quote;
      content = quote.reply || '[引用回复，正文为空]';
    }
    if (payload.images !== undefined) {
      if (!Array.isArray(payload.images) || !payload.images.length || payload.images.length > 4 || payload.images.some(item => !refId(item?.id) || ![undefined,'sticker'].includes(item.kind) || !sourceLabel(item.sourceLabel))) return null;
      for (const item of payload.images) segments.push({type:'image',data:{file:'wechatagent://image/'+item.id,media_id:item.id,media_label:item.sourceLabel,...(item.kind==='sticker'?{media_kind:'sticker'}:{})}});
    }
    if (payload.media !== undefined) {
      if (!Array.isArray(payload.media) || !payload.media.length || payload.media.length > 2 || payload.media.some(item => !refId(item?.id) || !['audio','video'].includes(item.kind) || !sourceLabel(item.sourceLabel))) return null;
      metadata.media=payload.media.map(({id,kind,sourceLabel})=>({id,kind,sourceLabel}));
      for (const item of metadata.media) segments.push({type:item.kind==='audio'?'record':'video',data:{file:'wechatagent://media/'+item.id,media_id:item.id,media_kind:item.kind,media_label:item.sourceLabel}});
    }
  } else return null;
  return { content, segments: [{ type: 'text', data: { text: content } }, ...segments], metadata };
}
