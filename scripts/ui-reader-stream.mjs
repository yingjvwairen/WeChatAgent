import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fault=code=>Object.assign(new Error(code),{code});
const cursor=value=>typeof value==='string'&&/^[a-f0-9]{32}:(0|[1-9][0-9]{0,15})$/.test(value)&&Number.isSafeInteger(Number(value.split(':')[1]));
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function noLinks(file){for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_STREAM_LINK_REJECTED');if(path.dirname(at)===at)return;}}

/** One durable pending frame. Advance only after the bridge persisted intake.
 * Reconnect uses the prior cursor and delivers the pending frame idempotently. */
export class UiReaderCursor {
  constructor({directory,account,selectionVersion=0,initialCursor}={}){
    if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof account!=='string'||!account||!Number.isSafeInteger(selectionVersion)||selectionVersion<0||!cursor(initialCursor))throw fault('UI_STREAM_CONFIG_INVALID');
    noLinks(directory);fs.mkdirSync(directory,{recursive:true,mode:0o700});
    this.file=path.join(directory,crypto.createHash('sha256').update(account+'\0'+selectionVersion).digest('hex')+'.json');
    this.account=account;this.selectionVersion=selectionVersion;
    noLinks(this.file);
    if(!fs.existsSync(this.file))this.write({version:1,account,selectionVersion,cursor:initialCursor,pending:null});
    this.read();
  }
  read(){noLinks(this.file);if(fs.statSync(this.file).size>131072)throw fault('UI_STREAM_STATE_INVALID');let value;try{value=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{throw fault('UI_STREAM_STATE_INVALID');}
    if(!object(value)||value.version!==1||value.account!==this.account||value.selectionVersion!==this.selectionVersion||!cursor(value.cursor)||value.pending!==null&&(!object(value.pending)||!cursor(value.pending.cursor)||!object(value.pending.payload)))throw fault('UI_STREAM_STATE_INVALID');return value;}
  write(value){noLinks(this.file);const temp=this.file+'.'+crypto.randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(temp,this.file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
  stage(id,payload){if(!cursor(id)||!object(payload)||Buffer.byteLength(JSON.stringify(payload))>65536)throw fault('UI_STREAM_EVENT_INVALID');const state=this.read();
    if(state.pending){if(state.pending.cursor!==id||JSON.stringify(state.pending.payload)!==JSON.stringify(payload))throw fault('UI_STREAM_PENDING_CONFLICT');return state.pending;}
    const [epoch,seq]=id.split(':'),[oldEpoch,oldSeq]=state.cursor.split(':');
    if(epoch!==oldEpoch||Number(seq)!==Number(oldSeq)+1)throw fault('UI_STREAM_CURSOR_GAP');
    state.pending={cursor:id,payload};this.write(state);return state.pending;}
  acknowledge(id){const state=this.read();if(!state.pending||state.pending.cursor!==id)throw fault('UI_STREAM_ACK_MISMATCH');state.cursor=id;state.pending=null;this.write(state);}
}

/** SSE parser preserves IDs and dispatches only complete records, including
 * arbitrary UTF-8/chunk boundaries. It never treats socket send as intake. */
export async function consumeReaderStream({response,journal,dispatch,signal,checkBinding=async()=>{},idleTimeoutMs=35000}={}){
  const cancelled=()=>{if(signal?.aborted)throw fault('UI_STREAM_CANCELLED');};
  cancelled();
  if(!response?.ok||!response.headers.get('content-type')?.includes('text/event-stream')||!response.body)throw fault('UI_READER_STREAM_UNAVAILABLE');
  const pending=journal.read().pending;
  if(pending){await checkBinding();cancelled();await dispatch(pending.payload,pending.cursor);journal.acknowledge(pending.cursor);}
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',id='',data=[],timer;
  try{
    for(;;){cancelled();let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(fault('UI_STREAM_CANCELLED'));signal?.addEventListener('abort',rejectAbort,{once:true});});
      let chunk;try{chunk=await Promise.race([reader.read(),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('UI_STREAM_IDLE_TIMEOUT')),idleTimeoutMs);})]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',rejectAbort);}
      cancelled();if(chunk.done){decoder.decode();if(buffer||data.length)throw fault('UI_STREAM_TRUNCATED');return;}
      buffer+=decoder.decode(chunk.value,{stream:true});if(Buffer.byteLength(buffer)>131072)throw fault('UI_READER_EVENT_TOO_LARGE');
      let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);
        if(line===''){
          if(data.length){let payload;try{payload=JSON.parse(data.join('\n'));}catch{throw fault('UI_STREAM_EVENT_INVALID');}
            // A pending frame was replayed before opening this stream. The
            // Reader may send it once more from the previous committed cursor.
            if(id!==journal.read().cursor){journal.stage(id,payload);await checkBinding();cancelled();await dispatch(payload,id);journal.acknowledge(id);}
          }id='';data=[];
        }else if(line.startsWith('id:'))id=line.slice(3).replace(/^ /,'');
        else if(line.startsWith('data:')){data.push(line.slice(5).replace(/^ /,''));if(data.join('\n').length>65536)throw fault('UI_READER_EVENT_TOO_LARGE');}
      }
    }
  }finally{clearTimeout(timer);try{await reader.cancel();}catch{}reader.releaseLock();}
}
