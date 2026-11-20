import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KEY_COMPONENT_SHA256 } from './reader-local-setup.mjs';
const rootDefault=path.resolve(import.meta.dirname,'..');
const fault=code=>Object.assign(new Error(code),{code});
const relative='components/weflow-cli/resources/key/win32/x64/wx_key.dll';
function local(file){if(typeof file!=='string'||!path.isAbsolute(file)||/^[\\/]{2}/.test(file)||/[\0\r\n]/.test(file))throw fault('READER_COMPONENT_LOCAL_PATH_REQUIRED');for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('READER_COMPONENT_LINK_REFUSED');if(path.dirname(at)===at)return path.resolve(file);}}
function bytes(file){local(file);const stat=fs.statSync(file,{throwIfNoEntry:false});if(!stat?.isFile()||stat.size<1||stat.size>1024*1024)throw fault('READER_COMPONENT_SOURCE_REQUIRED');const data=fs.readFileSync(file);if(crypto.createHash('sha256').update(data).digest('hex')!==KEY_COMPONENT_SHA256)throw fault('READER_COMPONENT_HASH_MISMATCH');return data;}
export function readerComponentStatus({root=rootDefault}={}){try{bytes(path.join(root,relative));return{ready:true,hashVerified:true,loaded:false};}catch(error){return{ready:false,hashVerified:false,loaded:false,code:error.code?.startsWith('READER_COMPONENT_')?error.code:'READER_COMPONENT_UNAVAILABLE'};}}
/** Imports one explicitly selected, pinned component. Never loads the DLL,
 * scans processes, reads account data, downloads, or replaces an existing file. */
export function importReaderComponent({root=rootDefault,source}={}){
  root=local(root);source=local(source);let candidates;
  if(fs.statSync(source,{throwIfNoEntry:false})?.isDirectory())candidates=['wx_key.dll','resources/key/win32/x64/wx_key.dll','resources/app.asar.unpacked/resources/key/win32/x64/wx_key.dll'].map(name=>path.join(source,name)).filter(file=>fs.existsSync(file));
  else candidates=[source];
  if(candidates.length!==1||path.basename(candidates[0]).toLowerCase()!=='wx_key.dll')throw fault('READER_COMPONENT_SOURCE_REQUIRED');
  const data=bytes(candidates[0]),target=local(path.join(root,relative));
  if(fs.existsSync(target)){bytes(target);return{imported:false,alreadyPresent:true,hashVerified:true,loaded:false,processAttached:false};}
  for(const name of ['state/ui-service.lock','state/reader/service.lock','state/reader/connection.lock','state/reader-service/service.lock'])if(fs.existsSync(local(path.join(root,name))))throw fault('READER_COMPONENT_STOP_SERVICES');
  fs.mkdirSync(path.dirname(target),{recursive:true});const temporary=target+'.'+crypto.randomUUID()+'.tmp';
  try{const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}local(target);fs.linkSync(temporary,target);}
  catch(error){if(error.code==='EEXIST')throw fault('READER_COMPONENT_DESTINATION_CHANGED');throw error;}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return{imported:true,alreadyPresent:false,hashVerified:true,loaded:false,processAttached:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--source')throw fault('READER_COMPONENT_SOURCE_REQUIRED');console.log(JSON.stringify(importReaderComponent({source:args[1]})));}
  catch(error){console.error(error.code?.startsWith('READER_COMPONENT_')?error.code:'READER_COMPONENT_IMPORT_FAILED');process.exitCode=1;}
}
