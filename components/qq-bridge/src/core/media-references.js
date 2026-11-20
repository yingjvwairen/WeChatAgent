/** Only opaque, message-bound local media references may reach the model layer. */
export function normalizeMediaReferences(value){
  if(!Array.isArray(value)||value.length>4)return [];
  if(value.some(item=>!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['id','kind','sourceLabel'].includes(key))||!/^[a-f0-9]{64}$/.test(item.id??'')||!['audio','video'].includes(item.kind)||item.sourceLabel!==undefined&&(typeof item.sourceLabel!=='string'||!item.sourceLabel.trim()||item.sourceLabel.length>80||/[\0\r\n]/.test(item.sourceLabel)))||new Set(value.map(item=>item.id)).size!==value.length)return [];
  return value.map(item=>({id:item.id,kind:item.kind,...(item.sourceLabel!==undefined?{sourceLabel:item.sourceLabel}:{})}));
}

/** Repeated quotations can point to the same original attachment in one batch. */
export function mergeMediaReferences(rows){
  const unique=new Map();
  for(const row of rows)for(const item of normalizeMediaReferences(row.media))if(!unique.has(item.id))unique.set(item.id,item);
  return [...unique.values()].slice(0,4);
}
