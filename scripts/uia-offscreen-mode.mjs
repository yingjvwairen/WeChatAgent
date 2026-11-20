import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fault=(code,status=409)=>Object.assign(Error(code),{code,status});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function noLinks(file){for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UIA_OFFSCREEN_LINK_REJECTED');if(at===path.dirname(at))return;}}
function checkedRoot(root){if(typeof root!=='string'||!path.isAbsolute(root))throw fault('UIA_OFFSCREEN_ROOT_INVALID',400);noLinks(root);if(!fs.statSync(root,{throwIfNoEntry:false})?.isDirectory())throw fault('UIA_OFFSCREEN_ROOT_INVALID',400);return path.resolve(root);}
function read(file){noLinks(file);const stat=fs.statSync(file,{throwIfNoEntry:false});if(!stat)return null;if(!stat.isFile()||stat.size>65536)throw fault('UIA_OFFSCREEN_STATE_INVALID');try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw fault('UIA_OFFSCREEN_STATE_INVALID');}}
function snapshot(value){if(!object(value)||Object.keys(value).length!==3||value.schemaVersion!==1||!Number.isSafeInteger(value.version)||value.version<1||typeof value.enabled!=='boolean')throw fault('UIA_OFFSCREEN_STATE_INVALID');return Object.freeze({...value});}
function validateRequest(value){if(!object(value)||Object.keys(value).length!==2||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<0||typeof value.enabled!=='boolean')throw fault('UIA_OFFSCREEN_SETTINGS_INVALID',400);}
function confirmedWindow(value,enabled){return object(value)&&(enabled
  ?value.state==='parked'&&value.parked===true&&value.released===false||value.state==='deferred'&&value.reason==='OFFSCREEN_ALREADY_OUTSIDE'&&value.released===true&&value.parked===false
  :value.released===true&&(value.state==='restored'&&value.restored===true||value.state==='ownership-lost'));}

/** Selection only. The running service saves after an acknowledged move or
 * restore. A stopped console may save explicit OFF only after recovery.
 * Merely reading the settings page never changes this selection. */
export class UiaOffscreenStore{
  constructor({root}={}){this.root=checkedRoot(root);this.file=path.join(this.root,'state/runtime/uia-offscreen.json');}
  get(){const value=read(this.file);return value===null?Object.freeze({schemaVersion:1,version:0,enabled:false}):snapshot(value);}
  replace(request){
    validateRequest(request);const directory=path.dirname(this.file);noLinks(directory);fs.mkdirSync(directory,{recursive:true,mode:0o700});const lock=this.file+'.lock';noLinks(lock);let fd;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fault('UIA_OFFSCREEN_BUSY');throw error;}
    const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';let created=false;
    try{const current=this.get();if(current.version!==request.expectedVersion)throw fault('UIA_OFFSCREEN_VERSION_CONFLICT');if(current.version===Number.MAX_SAFE_INTEGER)throw fault('UIA_OFFSCREEN_STATE_INVALID');const next={schemaVersion:1,version:current.version+1,enabled:request.enabled};
      noLinks(this.file);const output=fs.openSync(temporary,'wx',0o600);created=true;try{fs.writeFileSync(output,JSON.stringify(next));fs.fsyncSync(output);}finally{fs.closeSync(output);}fs.renameSync(temporary,this.file);created=false;return snapshot(next);
    }finally{fs.closeSync(fd);if(created)fs.unlinkSync(temporary);fs.unlinkSync(lock);}
  }
}

export async function requestUiaOffscreenMode({root,request,fetchImpl=fetch}={}){
  root=checkedRoot(root);validateRequest(request);const config=read(path.join(root,'config/wechatagent.json')),port=config?.ports?.adapter,tokenFile=path.join(root,'state/social-dsh-token.txt');noLinks(tokenFile);let token;
  try{token=fs.readFileSync(tokenFile,'utf8').trim();}catch{throw fault('UIA_OFFSCREEN_SERVICE_REQUIRED');}
  if(!Number.isInteger(port)||port<1024||port>65535||!/^[a-f0-9]{64}$/.test(token))throw fault('UIA_OFFSCREEN_SERVICE_REQUIRED');
  let response,value;try{response=await fetchImpl(`http://127.0.0.1:${port}/sender-offscreen`,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...request,backend:'uia-offscreen'}),signal:AbortSignal.timeout(90000)});const raw=await response.text();if(Buffer.byteLength(raw)>65536)throw Error();value=JSON.parse(raw);}catch{throw fault('UIA_OFFSCREEN_SWITCH_UNCONFIRMED');}
  if(!response.ok)throw fault(/^(?:UIA_OFFSCREEN|OFFSCREEN)_[A-Z0-9_]{1,80}$/.test(value?.error??'')?value.error:'UIA_OFFSCREEN_SWITCH_UNCONFIRMED');
  if(value?.backend!=='uia-offscreen'||value.enabled!==request.enabled||value.version!==request.expectedVersion+1||value.runtimeActive!==true||!confirmedWindow(value.windowState,request.enabled))throw fault('UIA_OFFSCREEN_SWITCH_UNCONFIRMED');return value;
}
