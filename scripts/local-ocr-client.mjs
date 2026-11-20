import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

const fault = code => Object.assign(new Error(code), {code});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const code = value => /^VISUAL_[A-Z0-9_]{1,64}$/.test(value ?? '') ? value : 'VISUAL_WORKER_FAILED';
const root = path.resolve(import.meta.dirname, '..');

/** Two fixed CPU model workers at most. Private pipes only; no network server.
 * A cancellation/protocol failure kills the affected model process and rejects
 * its pending reads. Read-only requests are never transparently replayed. */
export class LocalOcrPool {
  constructor({python = path.join(root,'state/ocr/venv/Scripts/python.exe'), script = path.join(root,'scripts/local-ocr.py'),
    spawnImpl = spawn, idleMs = 15000, startupMs = 30000} = {}) {
    if (![python,script].every(file => typeof file === 'string' && path.isAbsolute(file) && !/^\\\\|^\/\//.test(file)) ||
      !Number.isInteger(idleMs) || idleMs < 10 || idleMs > 60000 || !Number.isInteger(startupMs) || startupMs < 100 || startupMs > 30000) throw fault('VISUAL_OPTIONS_INVALID');
    Object.assign(this,{python,script,spawnImpl,idleMs,startupMs}); this.workers = new Map(); this.closed = false;
    this.onExit = () => this.close(); process.once('exit',this.onExit);
  }
  #fail(entry,error) {
    if (entry.dead) return;
    entry.dead = true; clearTimeout(entry.idleTimer); clearTimeout(entry.startTimer);
    if(this.workers.get(entry.model) === entry)this.workers.delete(entry.model);
    entry.rejectReady(error);
    for(const pending of entry.pending.values()) {clearTimeout(pending.timer);pending.signal?.removeEventListener('abort',pending.abort);pending.reject(error);}
    entry.pending.clear();
    try {entry.child.stdin.destroy();} catch {}
    try {entry.child.kill();} catch {}
  }
  #refs(entry,active) {
    for(const handle of [entry.child,entry.child.stdin,entry.child.stdout,entry.child.stderr]) {
      try {handle?.[active ? 'ref' : 'unref']?.();} catch {}
    }
  }
  #idle(entry) {
    if(entry.dead || !entry.readyDone || entry.pending.size)return;
    clearTimeout(entry.idleTimer);this.#refs(entry,false);
    entry.idleTimer = setTimeout(() => this.#fail(entry,fault('VISUAL_WORKER_IDLE_CLOSED')),this.idleMs);entry.idleTimer.unref?.();
  }
  #worker(model) {
    if(this.closed)throw fault('VISUAL_WORKER_CLOSED');
    if(!['small','medium'].includes(model))throw fault('VISUAL_OPTIONS_INVALID');
    const old=this.workers.get(model);if(old&&!old.dead)return old;
    if(!fs.statSync(this.python,{throwIfNoEntry:false})?.isFile()||!fs.statSync(this.script,{throwIfNoEntry:false})?.isFile())throw fault('VISUAL_PROBE_NOT_BUILT');
    const entry={model,pending:new Map(),dead:false,readyDone:false,buffer:'',stderrBytes:0,decoder:new StringDecoder('utf8')};
    entry.ready=new Promise((resolve,reject)=>{entry.resolveReady=resolve;entry.rejectReady=reject;});entry.ready.catch(()=>{});
    const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!['PYTHONHOME','PYTHONPATH','PYTHONSTARTUP'].includes(name.toUpperCase())));
    entry.child=this.spawnImpl(this.python,['-I','-B',this.script,'--worker','--model',model],{cwd:root,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env});
    this.workers.set(model,entry);
    entry.startTimer=setTimeout(()=>this.#fail(entry,fault('VISUAL_PROBE_TIMEOUT')),this.startupMs);
    entry.child.on('error',()=>this.#fail(entry,fault('VISUAL_WORKER_FAILED')));
    entry.child.once('exit',()=>this.#fail(entry,fault('VISUAL_WORKER_EXITED')));
    entry.child.stdin.on('error',()=>this.#fail(entry,fault('VISUAL_WORKER_FAILED')));
    entry.child.stderr.on('data',chunk=>{entry.stderrBytes+=chunk.length;if(entry.stderrBytes>65536)this.#fail(entry,fault('VISUAL_WORKER_PROTOCOL_INVALID'));});
    entry.child.stdout.on('data',chunk=>{
      if(entry.dead)return;
      entry.buffer+=entry.decoder.write(chunk);
      if(Buffer.byteLength(entry.buffer)>1024*1024)return this.#fail(entry,fault('VISUAL_WORKER_PROTOCOL_INVALID'));
      for(;;){
        const end=entry.buffer.indexOf('\n');if(end<0)break;
        let packet;try{packet=JSON.parse(entry.buffer.slice(0,end));}catch{return this.#fail(entry,fault('VISUAL_WORKER_PROTOCOL_INVALID'));}
        entry.buffer=entry.buffer.slice(end+1);
        if(!entry.readyDone){
          if(packet?.ok===false)return this.#fail(entry,fault(code(packet.error)));
          if(!object(packet)||packet.version!==1||packet.ready!==true||packet.model!==model||packet.runtime!=='rapidocr-3.10.0/onnxruntime-1.31.0'||packet.modelsVerified!=='pinned-sha256-v1'||packet.networkDisabled!==true)return this.#fail(entry,fault('VISUAL_WORKER_PROTOCOL_INVALID'));
          entry.readyDone=true;clearTimeout(entry.startTimer);entry.resolveReady();this.#idle(entry);continue;
        }
        if(!object(packet)||packet.version!==1||typeof packet.ok!=='boolean'||!entry.pending.has(packet.id))return this.#fail(entry,fault('VISUAL_WORKER_PROTOCOL_INVALID'));
        if(packet.ok&&packet.result?.preprocess!==entry.pending.get(packet.id).preprocess)return this.#fail(entry,fault('VISUAL_PREPROCESS_RESULT_MISMATCH'));
        const pending=entry.pending.get(packet.id);entry.pending.delete(packet.id);clearTimeout(pending.timer);pending.signal?.removeEventListener('abort',pending.abort);
        if(packet.ok&&object(packet.result))pending.resolve(packet.result);
        else if(!packet.ok)pending.reject(fault(code(packet.error)));
        else {pending.reject(fault('VISUAL_WORKER_PROTOCOL_INVALID'));this.#fail(entry,fault('VISUAL_WORKER_PROTOCOL_INVALID'));return;}
        this.#idle(entry);
      }
    });
    return entry;
  }
  async warm({model='small',signal}={}) {
    if(signal?.aborted)throw fault('VISUAL_CANCELLED');
    const entry=this.#worker(model),abort=()=>this.#fail(entry,fault('VISUAL_CANCELLED'));
    signal?.addEventListener('abort',abort,{once:true});
    try {await entry.ready;if(signal?.aborted)throw fault('VISUAL_CANCELLED');return {ready:true,readOnly:true,inputSent:false,networkDisabled:true};}
    finally {signal?.removeEventListener('abort',abort);this.#idle(entry);}
  }
  recognize({file,imageSha256,model='small',region,preprocess,signal,timeoutMs=30000}) {
    if(preprocess!==undefined&&preprocess!=='gray-gamma-1.6')return Promise.reject(fault('VISUAL_PREPROCESS_INVALID'));
    if(typeof file!=='string'||!path.isAbsolute(file)||file.length>4096||/[\0\r\n]/.test(file)||!/^([a-f0-9]{64})$/.test(imageSha256??'')||
      !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)return Promise.reject(fault('VISUAL_OPTIONS_INVALID'));
    if(signal?.aborted)return Promise.reject(fault('VISUAL_CANCELLED'));
    let entry;try{entry=this.#worker(model);}catch(error){return Promise.reject(error);}
    if(entry.pending.size>=4)return Promise.reject(fault('VISUAL_WORKER_BUSY'));
    clearTimeout(entry.idleTimer);this.#refs(entry,true);
    const id=crypto.randomBytes(16).toString('hex');
    return new Promise((resolve,reject)=>{
      const pending={resolve,reject,signal,preprocess,abort:()=>this.#fail(entry,fault('VISUAL_CANCELLED'))};
      pending.timer=setTimeout(()=>this.#fail(entry,fault('VISUAL_PROBE_TIMEOUT')),timeoutMs);
      entry.pending.set(id,pending);signal?.addEventListener('abort',pending.abort,{once:true});
      entry.ready.then(()=>{
        if(entry.dead||!entry.pending.has(id))return;
        entry.child.stdin.write(JSON.stringify({version:1,id,image:file,imageSha256,...(region===undefined?{}:{region}),...(preprocess===undefined?{}:{preprocess})})+'\n',error=>{if(error)this.#fail(entry,fault('VISUAL_WORKER_FAILED'));});
      },()=>{});
    });
  }
  close() {
    if(this.closed)return;
    this.closed=true;process.removeListener('exit',this.onExit);
    for(const entry of this.workers.values())this.#fail(entry,fault('VISUAL_WORKER_CLOSED'));
  }
}

let shared;
export const localOcrPool=()=>shared??=(new LocalOcrPool());
export function closeLocalOcrWorkers(){shared?.close();shared=undefined;}
