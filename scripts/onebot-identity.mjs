import crypto from 'node:crypto';

export const onebotId = value => Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);
export const conversationId = (wxid, name, mappedId) => {
  if(mappedId!==undefined){
    if(!/^[1-9]\d*$/.test(String(mappedId))||!Number.isSafeInteger(Number(mappedId)))throw new Error('INVALID_CONVERSATION_ID');
    return Number(mappedId);
  }
  return onebotId(wxid.includes('@chatroom') ? (name || wxid).replace(/\s*\(\d+\)\s*$/, '').trim() : wxid);
};
