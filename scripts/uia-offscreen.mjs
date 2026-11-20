import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {QtActionsClient} from './qt-visual-driver.mjs';
import {inspectedQtLayoutIdentity} from './qt-layout-profiles.mjs';

const fault=code=>Object.assign(new Error(code),{code});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const decimal=value=>typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const rect=value=>object(value)&&Object.keys(value).length===4&&['left','top','right','bottom'].every(key=>Number.isSafeInteger(value[key]))&&value.right>value.left&&value.bottom>value.top;
const states=new Set(['parked','restored','visible','deferred','ownership-lost']);
const noMoveRefusals=new WeakSet();
// One-use, in-process evidence from the exact explicit parking operation.
// Matching error codes or caller-supplied properties are not this evidence.
export function consumeOffscreenNoMoveRefusal(error){if(!object(error)||!noMoveRefusals.has(error))return false;noMoveRefusals.delete(error);return true;}
function active(signal){if(signal?.aborted)throw fault('UIA_MODE_ABORTED');}
function noLinks(file){for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UIA_OFFSCREEN_LINK_REJECTED');if(at===path.dirname(at))return;}}
function binding(value){return object(value)&&decimal(value.hwnd)&&Number.isInteger(value.pid)&&value.pid>0&&value.pid<=2147483647&&decimal(value.processCreatedFileTimeUtc);}
function checkedResult(value,action){
  if(!object(value)||value.version!==1||value.action!==action||!states.has(value.state)||!['parked','restored','released','parkEligible','windowMoved','foregroundChanged'].every(key=>typeof value[key]==='boolean')||value.inputSent!==false||value.clipboardAccessed!==false||value.foregroundChanged!==false||!(value.reason===null||/^OFFSCREEN_[A-Z0-9_]{1,80}$/.test(value.reason??''))||!(value.journalPath===null||typeof value.journalPath==='string')||value.parked!==(value.state==='parked')||value.parked&&value.released||value.binding!==null&&(!binding(value.binding)||!rect(value.binding.clientRect)||!rect(value.binding.captureRect)||!Number.isInteger(value.binding.dpi)))throw fault('UIA_OFFSCREEN_PROTOCOL_INVALID');
  return structuredClone(value);
}

/** This worker owns a reversible window move. A timeout closes its input and
 * waits for cleanup; it must never use the read-only worker's kill-on-error. */
export class UiaOffscreenClient {
  constructor({root,spawnImpl=spawn,startTimeoutMs=5000,requestTimeoutMs=5000,closeTimeoutMs=5000}={}){
    if(typeof root!=='string'||!path.isAbsolute(root)||typeof spawnImpl!=='function'||![startTimeoutMs,requestTimeoutMs,closeTimeoutMs].every(value=>Number.isInteger(value)&&value>=10&&value<=15000))throw fault('UIA_OFFSCREEN_CONFIG_INVALID');
    Object.assign(this,{root:path.resolve(root),spawnImpl,startTimeoutMs,requestTimeoutMs,closeTimeoutMs});this.sequence=0;this.buffer='';this.closing=false;
  }
  fail(code){this.failure??=fault(code);this.rejectReady?.(this.failure);this.pending?.reject(this.failure);this.pending=null;try{this.child?.stdin.end();}catch{}}
  line(line){
    let packet;try{packet=JSON.parse(line);}catch{this.fail('UIA_OFFSCREEN_PROTOCOL_INVALID');return;}
    if(!this.ready){if(object(packet)&&packet.ok===false&&packet.id===null&&/^OFFSCREEN_[A-Z0-9_]{1,80}$/.test(packet.error?.code??'')){this.fail(packet.error.code);return;}if(!object(packet)||packet.version!==1||packet.ready!==true||packet.backend!=='uia-offscreen'||packet.inputSent!==false||packet.clipboardAccessed!==false){this.fail('UIA_OFFSCREEN_PROTOCOL_INVALID');return;}this.ready=true;this.resolveReady();return;}
    const pending=this.pending;
    if(!pending||!object(packet)||packet.id!==pending.id||typeof packet.ok!=='boolean'){this.fail('UIA_OFFSCREEN_PROTOCOL_INVALID');return;}
    this.pending=null;
    if(!packet.ok){const code=packet.error?.code;pending.reject(fault(/^OFFSCREEN_[A-Z0-9_]{1,80}$/.test(code??'')?code:'UIA_OFFSCREEN_PROTOCOL_INVALID'));return;}
    try{const result=checkedResult(packet.result,pending.action);this.lastState=result;pending.resolve(result);}catch(error){pending.reject(error);this.fail(error.code);}
  }
  async bounded(promise,signal,timeoutMs){
    active(signal);const abort=()=>this.fail('UIA_MODE_ABORTED'),timer=setTimeout(()=>this.fail('UIA_OFFSCREEN_TIMEOUT'),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
    try{const result=await promise;active(signal);if(this.failure)throw this.failure;return result;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async start({signal}={}){
    active(signal);if(this.closing)throw fault('UIA_OFFSCREEN_CLOSED');if(this.failure)throw this.failure;
    if(!this.child){
      const executable=path.join(this.root,'state/ui-host/WechatUiaOffscreenHost.exe');noLinks(executable);
      this.readyPromise=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});this.readyPromise.catch(()=>{});this.exitPromise=new Promise(resolve=>{this.resolveExit=resolve;});
      try{this.child=this.spawnImpl(executable,['--host','--root',this.root,'--parent-pid',String(process.pid)],{cwd:this.root,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});}
      catch{this.exitResult={code:null};this.resolveExit(this.exitResult);this.fail('UIA_OFFSCREEN_START_FAILED');throw this.failure;}
      this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>{if(this.failure)return;this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>131072){this.fail('UIA_OFFSCREEN_PROTOCOL_INVALID');return;}for(;;){const end=this.buffer.indexOf('\n');if(end<0)break;const line=this.buffer.slice(0,end).replace(/\r$/,'');this.buffer=this.buffer.slice(end+1);this.line(line);if(this.failure)return;}});
      this.child.stderr.on('data',()=>this.fail('UIA_OFFSCREEN_PROTOCOL_INVALID'));this.child.stdin.on('error',()=>this.fail('UIA_OFFSCREEN_PIPE_FAILED'));this.child.once('error',()=>this.fail('UIA_OFFSCREEN_START_FAILED'));
      this.child.once('close',(code,signal)=>{this.exitResult={code,signal};this.resolveExit(this.exitResult);if(!this.closing)this.fail('UIA_OFFSCREEN_EXITED');});
    }
    try{await this.bounded(this.readyPromise,signal,this.startTimeoutMs);return {ready:true};}catch(error){await this.close().catch(()=>{});throw error;}
  }
  async request(action,values={}, {signal}={}){
    if(!['inspect','park','park-explicit','restore','handoff-offline'].includes(action)||!object(values)||Object.keys(values).some(key=>key!=='binding'))throw fault('UIA_OFFSCREEN_REQUEST_INVALID');await this.start({signal});return this.send(action,values,signal);
  }
  async send(action,values,signal){
    if(this.pending)throw fault('UIA_OFFSCREEN_BUSY');if(this.failure)throw this.failure;active(signal);const id=String(++this.sequence),line=JSON.stringify({id,action,...values})+'\n';if(Buffer.byteLength(line)>16384)throw fault('UIA_OFFSCREEN_REQUEST_INVALID');
    const response=new Promise((resolve,reject)=>{this.pending={id,action,resolve,reject};});response.catch(()=>{});try{this.child.stdin.write(line);}catch{this.fail('UIA_OFFSCREEN_PIPE_FAILED');}
    return this.bounded(response,signal,this.requestTimeoutMs);
  }
  close(){return this.closePromise??=(async()=>{
    this.closing=true;if(!this.child)return {processStopped:true,released:true};let cleanup;
    if(this.pending)this.fail('UIA_OFFSCREEN_CLOSED');
    if(this.ready&&!this.failure&&!this.pending&&!this.exitResult)try{cleanup=await this.send('stop',{});}catch{}
    try{this.child.stdin.end();}catch{}
    let timer;try{const exit=await Promise.race([this.exitPromise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),this.closeTimeoutMs);})]);if(!exit||exit.code!==0||cleanup&&cleanup.released!==true)throw fault('UIA_OFFSCREEN_CLEANUP_UNCONFIRMED');return{processStopped:true,released:true,...(cleanup?{state:cleanup}:{})};}finally{clearTimeout(timer);}
  })();}
}

export function createUiaOffscreenManager({root,createHost=options=>new UiaOffscreenClient(options),createInspector=options=>new QtActionsClient(options)}={}){
  let host,inspector,inspectorConfig,closed=false,closePromise,lastState,suppressPark=false;
  const ensureActive=signal=>{active(signal);if(closed)throw fault('UIA_OFFSCREEN_CLOSED');};
  return {
    async setEnabled({enabled,config,signal}={}){
      ensureActive(signal);if(typeof enabled!=='boolean')throw fault('UIA_OFFSCREEN_SETTINGS_INVALID');
      if(!enabled){
        if(!host)return{version:1,action:'restore',state:'restored',parked:false,restored:true,released:true,windowMoved:false,inputSent:false,foregroundChanged:false};
        const state=await host.request('restore',{}, {signal});ensureActive(signal);
        if(state.released!==true||!['restored','ownership-lost'].includes(state.state))throw fault('UIA_OFFSCREEN_CLEANUP_UNCONFIRMED');lastState=state;return structuredClone(state);
      }
      // The service has drained the input host before explicit toggles. Unlike
      // automatic preparation, this intent does not wait for another message
      // or an idle period after the user's click.
      if(inspector&&!isDeepStrictEqual(config,inspectorConfig)){await inspector.close();inspector=undefined;}
      inspector??=createInspector({root,config,enableInput:false});inspectorConfig=structuredClone(config);
      const inspection=await inspector.request('inspectLayout');ensureActive(signal);inspectedQtLayoutIdentity(config,inspection);
      if(!binding(inspection.binding)||inspection.readOnly!==true||inspection.inputSent!==false||inspection.clipboardAccessed!==false||inspection.focusChanged!==false||inspection.executableVersion!==config.executableVersion||inspection.executableSha256!==config.executableSha256)throw fault('UIA_OFFSCREEN_BINDING_CHANGED');
      const expected={version:1,hwnd:inspection.binding.hwnd,pid:inspection.binding.pid,processCreatedFileTimeUtc:inspection.binding.processCreatedFileTimeUtc,executable:config.executable};
      host??=createHost({root});const state=await host.request('park-explicit',{binding:expected},{signal});ensureActive(signal);
      if(!binding(state.binding)||!['hwnd','pid','processCreatedFileTimeUtc'].every(key=>state.binding[key]===expected[key]))throw fault('UIA_OFFSCREEN_BINDING_CHANGED');
      if(state.state==='deferred'&&state.released===true&&state.parked===false&&state.windowMoved===false&&state.inputSent===false&&state.clipboardAccessed===false&&state.foregroundChanged===false&&
        ['OFFSCREEN_KEYS_HELD','OFFSCREEN_USER_ACTIVITY_CHANGED'].includes(state.reason)&&state.binding.dpi===inspection.binding.dpi&&isDeepStrictEqual(state.binding.clientRect,inspection.binding.clientRect)&&isDeepStrictEqual(state.binding.captureRect,inspection.binding.captureRect)){
        lastState=state;const error=fault(state.reason);noMoveRefusals.add(error);throw error;
      }
      if(!state.parked&&!(state.state==='deferred'&&state.reason==='OFFSCREEN_ALREADY_OUTSIDE'&&state.released===true))throw fault('UIA_OFFSCREEN_MOVE_UNCONFIRMED');
      lastState=state;suppressPark=false;return structuredClone(state);
    },
    async prepareWindow({config,signal,releaseInput}){
      ensureActive(signal);if(typeof releaseInput!=='function')throw fault('UIA_OFFSCREEN_RELEASE_REQUIRED');if(suppressPark)return;
      let inputReleased=false;const release=async()=>{if(!inputReleased){await releaseInput();inputReleased=true;}ensureActive(signal);};
      if(inspector&&!isDeepStrictEqual(config,inspectorConfig)){await inspector.close();inspector=undefined;}
      inspector??=createInspector({root,config,enableInput:false});inspectorConfig=structuredClone(config);
      const inspection=await inspector.request('inspectLayout');ensureActive(signal);inspectedQtLayoutIdentity(config,inspection);
      if(!binding(inspection.binding)||inspection.readOnly!==true||inspection.inputSent!==false||inspection.clipboardAccessed!==false||inspection.focusChanged!==false||inspection.executableVersion!==config.executableVersion||inspection.executableSha256!==config.executableSha256)throw fault('UIA_OFFSCREEN_BINDING_CHANGED');
      const expected={version:1,hwnd:inspection.binding.hwnd,pid:inspection.binding.pid,processCreatedFileTimeUtc:inspection.binding.processCreatedFileTimeUtc,executable:config.executable};
      const checkState=state=>{if(state.state!=='ownership-lost'&&(!binding(state.binding)||!['hwnd','pid','processCreatedFileTimeUtc'].every(key=>state.binding[key]===expected[key])))throw fault('UIA_OFFSCREEN_BINDING_CHANGED');return state;};
      host??=createHost({root});let state=checkState(await host.request('inspect',{binding:expected},{signal}));ensureActive(signal);lastState=state;
      if(state.state==='ownership-lost'){suppressPark=true;return;}
      if(state.state==='deferred'&&state.reason==='OFFSCREEN_RECOVERY_REQUIRED'){
        await release();state=await host.request('restore',{}, {signal});ensureActive(signal);lastState=state;
        if(state.state==='ownership-lost'){suppressPark=true;return;}
        if(state.released!==true||state.restored!==true)throw fault('UIA_OFFSCREEN_CLEANUP_UNCONFIRMED');
        state=checkState(await host.request('inspect',{binding:expected},{signal}));ensureActive(signal);lastState=state;
      }
      if(state.parked||!state.parkEligible)return;
      // Qt input helpers own the shared input mutex for their entire lifetime.
      // Only an unoccupied preparation boundary may release/rebuild that helper.
      await release();state=checkState(await host.request('park',{binding:expected},{signal}));ensureActive(signal);lastState=state;
      if(state.state==='ownership-lost')suppressPark=true;
    },
    getState(){return lastState?structuredClone(lastState):null;},
    async handoffOffline(){
      if(!lastState?.parked||!host)throw fault('UIA_OFFSCREEN_HANDOFF_UNAVAILABLE');
      const result=await host.request('handoff-offline');
      if(!result.parked||!isDeepStrictEqual(lastState.binding,result.binding))throw fault('UIA_OFFSCREEN_HANDOFF_UNCONFIRMED');
    },
    close(){return closePromise??=(async()=>{closed=true;const results=await Promise.allSettled([inspector?.close(),host?.close()]);for(const result of results)if(result.status==='rejected')throw result.reason;const state=results[1]?.value?.state;if(state)lastState=state;return{processStopped:true,released:true,...(lastState?{state:structuredClone(lastState)}:{})};})();},
  };
}

/** A killed process tree cannot run its finally block. Recover its durable
 * window lease before any sender starts, including when UIA is now disabled
 * or the reply queue is paused. No journal or a terminal journal is read-only. */
export async function recoverUiaOffscreenWindow({root,signal,createClient=options=>new UiaOffscreenClient(options)}={}){
  if(typeof root!=='string'||!path.isAbsolute(root)||typeof createClient!=='function')throw fault('UIA_OFFSCREEN_CONFIG_INVALID');active(signal);
  const journal=path.join(root,'state/ui-offscreen/active.jsonl');noLinks(journal);const stat=fs.statSync(journal,{throwIfNoEntry:false});if(!stat)return{needed:false,recovered:false};
  if(!stat.isFile()||stat.size<1||stat.size>262144)throw fault('UIA_OFFSCREEN_JOURNAL_INVALID');
  const bytes=fs.readFileSync(journal),complete=bytes.lastIndexOf(10);if(complete<0)throw fault('UIA_OFFSCREEN_JOURNAL_INVALID');
  let rows;try{rows=bytes.subarray(0,complete).toString('utf8').trimEnd().split(/\r?\n/).map(line=>JSON.parse(line));}catch{throw fault('UIA_OFFSCREEN_JOURNAL_INVALID');}
  if(!rows.length||rows[0]?.version!==1||rows[0]?.kind!=='uia-offscreen-host-v1'||rows.some(row=>!object(row)||typeof row.phase!=='string'))throw fault('UIA_OFFSCREEN_JOURNAL_INVALID');
  if(['restored','ownership-lost'].includes(rows.at(-1).phase))return{needed:false,recovered:false};
  active(signal);const client=createClient({root});let result;
  try{result=await client.request('restore',{}, {signal});if(result.released!==true||!['restored','ownership-lost'].includes(result.state))throw fault('UIA_OFFSCREEN_CLEANUP_UNCONFIRMED');}
  finally{const closed=await client.close();if(closed.processStopped!==true||closed.released!==true)throw fault('UIA_OFFSCREEN_CLEANUP_UNCONFIRMED');}
  return{needed:true,recovered:true,state:result};
}

function serviceLease(root){
  const file=path.join(root,'state/ui-service.lock');
  noLinks(file);
  const stat=fs.statSync(file,{throwIfNoEntry:false});
  if(!stat)return {file,occupied:false};
  if(!stat.isFile()||stat.size>4096)return {file,occupied:true};
  const bytes=fs.readFileSync(file);
  try{
    const record=JSON.parse(bytes);
    if(Number.isSafeInteger(record.pid)&&record.pid>0){
      try{process.kill(record.pid,0);}
      catch(error){if(error.code==='ESRCH')return {file,bytes,occupied:false};}
    }
  }catch{/* A partially written or unknown lease is still occupied. */}
  return {file,occupied:true};
}
export const uiSettingsServiceRunning=root=>serviceLease(root).occupied;

export async function withStoppedUiSettings(root,apply){
  const lease=serviceLease(root);
  if(lease.occupied)throw fault('UIA_OFFSCREEN_BUSY');
  fs.mkdirSync(path.dirname(lease.file),{recursive:true});
  if(lease.bytes){
    // Serialize reclamation of this specific dead lease. A service that
    // starts during the handover competes for the same exclusive file below.
    const reclaim=lease.file+'.reclaim';
    let fd;
    try{fd=fs.openSync(reclaim,'wx',0o600);}
    catch{throw fault('UIA_OFFSCREEN_BUSY');}
    try{
      const latest=serviceLease(root);
      if(latest.occupied||!latest.bytes?.equals(lease.bytes))throw fault('UIA_OFFSCREEN_BUSY');
      fs.renameSync(lease.file,lease.file+'.exited-'+randomUUID());
    }finally{fs.closeSync(fd);fs.unlinkSync(reclaim);}
  }
  const owner=JSON.stringify({pid:process.pid,lease:randomUUID(),settings:true});
  let fd;
  try{fd=fs.openSync(lease.file,'wx',0o600);}
  catch(error){if(error.code==='EEXIST')throw fault('UIA_OFFSCREEN_BUSY');throw error;}
  try{
    fs.writeFileSync(fd,owner);
    return await apply();
  }finally{
    fs.closeSync(fd);
    if(fs.readFileSync(lease.file,'utf8')===owner)fs.unlinkSync(lease.file);
  }
}

function stoppedHostConfig(root){
  const read=file=>{
    noLinks(file);
    const stat=fs.statSync(file,{throwIfNoEntry:false});
    if(!stat)return null;
    if(!stat.isFile()||stat.size>1024*1024)throw fault('UIA_OFFSCREEN_CONFIG_INVALID');
    return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  };
  const project=read(path.join(root,'config/wechatagent.json'));
  const bridge=read(project?.ui?.bridgeConfig??path.join(root,'state/ui-bridge/config.json'));
  return read(bridge?.hostConfig??path.join(root,'state/ui-runtime/qt-visual.json'));
}

export async function applyStoppedOffscreen({root,enabled,validate,apply,createManager=createUiaOffscreenManager,recover=recoverUiaOffscreenWindow}){
  return withStoppedUiSettings(root,async()=>{
    await validate?.();
    if(!enabled){
      const recalled=await recover({root});
      return apply(recalled.state??{state:'restored',restored:true,released:true,windowMoved:false,inputSent:false,reason:'OFFSCREEN_NO_MANAGED_WINDOW'});
    }
    const deferred={state:'deferred',parked:false,restored:false,released:true,windowMoved:false,inputSent:false,reason:'OFFSCREEN_ON_START'};
    const config=stoppedHostConfig(root);
    if(!config||['WechatUiaOffscreenHost','WechatQtActions'].some(name=>!fs.existsSync(path.join(root,'state/ui-host',name+'.exe'))))return apply(deferred);
    const manager=createManager({root});
    let parked=false,committed=false;
    try{
      let state;
      try{state=await manager.setEnabled({enabled:true,config});}
      catch(error){
        // No target or a provably unperformed move can be saved for startup.
        if(error.code==='QT_FOCUS_TARGET_AMBIGUOUS'||consumeOffscreenNoMoveRefusal(error))return await apply(deferred);
        throw error;
      }
      parked=state.parked;
      if(parked)await manager.handoffOffline();
      const result=await apply(state);
      committed=true;
      return result;
    }finally{
      try{await manager.close();}
      finally{if(parked&&!committed)await recover({root});}
    }
  });
}
