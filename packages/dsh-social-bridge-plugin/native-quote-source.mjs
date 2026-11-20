const labels=Object.freeze({text:'文字',voice:'语音',video:'视频',image:'图片',sticker:'表情',link:'链接',file:'文件',record:'合并转发聊天记录',quote:'引用回复',card:'卡片'});

export function knownQuoteKind(value) {
  return typeof value==='string' && Object.hasOwn(labels,value);
}

export function nativeQuoteKind(row) {
  if(row.contextOnly || row.interaction || row.outgoing || row.platform!=='wechat')return null;
  if(knownQuoteKind(row.quoteKind))return row.quoteKind;
  // Older buffers and archives can identify many formats from their original envelope.
  if(row.forwardedRecord)return 'record';
  if(row.quoteReply)return 'quote';
  if(row.files?.length)return 'file';
  if(row.media?.length)return row.media[0].kind==='audio'?'voice':'video';
  if(row.images?.length)return row.images[0].kind==='sticker'?'sticker':'image';
  return row.text?.trim()?'text':null;
}

export function nativeQuoteLabel(kind){return labels[kind];}
