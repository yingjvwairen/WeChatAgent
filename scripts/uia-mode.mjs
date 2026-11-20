import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fault=(code,status=409)=>Object.assign(Error(code),{code,status});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clientVersion='4.1.15.56';
const components=['WechatAccessibilityGate','WechatBackgroundControls','WechatQtActions','WechatVoicePreview','WechatUiaOffscreenHost','WechatOffscreenFocus'];
const operations=['sendText','sendImage','sendNativeVoice'];
function noLinks(file){for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UIA_MODE_LINK_REJECTED');if(path.dirname(at)===at)return;}}
function checkedRoot(root){if(typeof root!=='string'||!path.isAbsolute(root))throw fault('UIA_MODE_ROOT_INVALID',400);noLinks(root);if(!fs.statSync(root,{throwIfNoEntry:false})?.isDirectory())throw fault('UIA_MODE_ROOT_INVALID',400);return path.resolve(root);}
function readJson(file){noLinks(file);const stat=fs.statSync(file,{throwIfNoEntry:false});if(!stat)return null;if(!stat.isFile()||stat.size>65536)throw fault('UIA_MODE_STATE_INVALID');try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw fault('UIA_MODE_STATE_INVALID');}}

/** Local availability only. Actual gate, account, controls and delivery checks
 * are performed by the running UIA/Qt sender, never by opening this settings page. */
export function inspectUiaMode({root,clientVersion:version,operation='sendText'}={}){
  root=checkedRoot(root);if(!operations.includes(operation))throw fault('UIA_MODE_OPERATION_INVALID',400);
  if(version===undefined)version=readJson(path.join(root,'state/ui-runtime/qt-visual.json'))?.executableVersion;
  version=typeof version==='string'&&/^\d{1,3}(?:\.\d{1,3}){3}$/.test(version)?version:null;
  const base={schemaVersion:1,backend:'uia',clientVersion:version,supportedClientVersions:[clientVersion],operation,
    defaultEnabled:false,canEnable:false,componentsAvailable:false,runtimeVerified:false,fullyBackgroundReady:false,
    requiresForeground:true,restoresForeground:true,requiresActivityGuard:true,requiresAccountVerification:true,requiresDatabaseReceipt:true,
    requiresClientRestart:false,inputSent:false,servicesStarted:false,supportedOperations:Object.fromEntries(operations.map(key=>[key,version===clientVersion]))};
  if(!version)return{...base,reason:'UIA_MODE_CLIENT_VERSION_REQUIRED'};
  if(version!==clientVersion)return{...base,reason:'UIA_MODE_VERSION_UNSUPPORTED'};
  const missingComponents=components.filter(component=>{const file=path.join(root,'state/ui-host',component+'.exe');noLinks(file);const stat=fs.statSync(file,{throwIfNoEntry:false});return !stat?.isFile()||stat.size<1||stat.size>64*1024*1024;});
  if(missingComponents.length)return{...base,reason:'UIA_MODE_COMPONENT_MISSING',missingComponents};
  return{...base,canEnable:true,componentsAvailable:true,reason:null};
}

function snapshot(value){
  if(!object(value)||!Number.isSafeInteger(value.version)||value.version<1||typeof value.enabled!=='boolean')throw fault('UIA_MODE_STATE_INVALID');
  if(value.schemaVersion===1&&Object.keys(value).length===3)return Object.freeze({schemaVersion:2,backend:'uia',version:value.version,enabled:false,migrationRequired:true});
  if(value.schemaVersion!==2||value.backend!=='uia'||Object.keys(value).length!==4)throw fault('UIA_MODE_STATE_INVALID');
  return Object.freeze({...value,migrationRequired:false});
}
function validateRequest(value){if(!object(value)||Object.keys(value).length!==2||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<0||typeof value.enabled!=='boolean')throw fault('UIA_MODE_SETTINGS_INVALID',400);}

function priorModeFile(root){return path.join(root,'state/runtime/background-injection.json');}
export function migrateUiaModeSettings(root){
  const previous=priorModeFile(root),file=path.join(root,'state/runtime/uia-mode.json');
  noLinks(previous);noLinks(file);
  if(fs.existsSync(file)||!fs.existsSync(previous))return;
  const value=readJson(previous);
  if(value===null)return;
  snapshot(value);
  try{fs.renameSync(previous,file);}
  catch(error){if(error.code!=='ENOENT'||!fs.existsSync(file))throw error;}
}

export class UiaModeStore{
  constructor({root,inspect}={}){this.root=checkedRoot(root);this.file=path.join(this.root,'state/runtime/uia-mode.json');this.inspect=inspect??(()=>inspectUiaMode({root:this.root}));if(typeof this.inspect!=='function')throw fault('UIA_MODE_INSPECTOR_INVALID',400);}
  get(){const value=readJson(this.file)??readJson(priorModeFile(this.root));return value===null?Object.freeze({schemaVersion:2,backend:'uia',version:0,enabled:false,migrationRequired:false}):snapshot(value);}
  replace(value,{deferVerification=false}={}){
    validateRequest(value);
    migrateUiaModeSettings(this.root);
    if(value.enabled&&!deferVerification){const status=this.inspect();if(status?.backend!=='uia'||status.canEnable!==true||status.componentsAvailable!==true||status.clientVersion!==clientVersion)throw fault(/^UIA_MODE_[A-Z_]+$/.test(status?.reason??'')?status.reason:'UIA_MODE_UNAVAILABLE');}
    const folder=path.dirname(this.file);noLinks(folder);fs.mkdirSync(folder,{recursive:true,mode:0o700});const lock=this.file+'.lock';noLinks(lock);let fd;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fault('UIA_MODE_BUSY');throw error;}
    const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';let created=false;
    try{const current=this.get();if(current.version!==value.expectedVersion)throw fault('UIA_MODE_VERSION_CONFLICT');if(current.version===Number.MAX_SAFE_INTEGER)throw fault('UIA_MODE_STATE_INVALID');
      const next={schemaVersion:2,backend:'uia',version:current.version+1,enabled:value.enabled};noLinks(this.file);const out=fs.openSync(temporary,'wx',0o600);created=true;
      try{fs.writeFileSync(out,JSON.stringify(next));fs.fsyncSync(out);}finally{fs.closeSync(out);}fs.renameSync(temporary,this.file);created=false;return snapshot(next);
    }finally{fs.closeSync(fd);if(created)fs.unlinkSync(temporary);fs.unlinkSync(lock);}
  }
}

/** The explicit backend discriminant makes old hosts reject this request
 * before draining a sender or loading a native-injection candidate. */
export async function requestUiaSenderMode({root,request,fetchImpl=fetch}={}){
  root=checkedRoot(root);validateRequest(request);const config=readJson(path.join(root,'config/wechatagent.json')),port=config?.ports?.adapter;
  const tokenFile=path.join(root,'state/social-dsh-token.txt');noLinks(tokenFile);let token;
  try{token=fs.readFileSync(tokenFile,'utf8').trim();}catch{throw fault('UIA_MODE_SERVICE_REQUIRED');}
  if(!Number.isInteger(port)||port<1024||port>65535||!/^[a-f0-9]{64}$/.test(token))throw fault('UIA_MODE_SERVICE_REQUIRED');
  let response,value;
  try{response=await fetchImpl(`http://127.0.0.1:${port}/sender-mode`,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...request,backend:'uia'}),signal:AbortSignal.timeout(90000)});
    const raw=await response.text();if(Buffer.byteLength(raw)>65536)throw Error();value=JSON.parse(raw);
  }catch{throw fault('UIA_MODE_SWITCH_UNCONFIRMED');}
  if(!response.ok)throw fault(/^UIA_MODE_[A-Z_]{1,70}$/.test(value?.error??'')?value.error:'UIA_MODE_SWITCH_UNCONFIRMED');
  if(value?.backend!=='uia'||value.enabled!==request.enabled||value.version!==request.expectedVersion+1||value.runtimeActive!==true)throw fault('UIA_MODE_SWITCH_UNCONFIRMED');
  return value;
}
