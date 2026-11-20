import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const fault=code=>Object.assign(new Error(code),{code});
function noLinks(file){for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('UI_REPLY_SETTINGS_LINK_REJECTED');if(path.dirname(at)===at)return;}}
export class ReplyPreferences {
  constructor({root}={}){if(!path.isAbsolute(root??''))throw fault('UI_REPLY_SETTINGS_INVALID');this.file=path.join(root,'state/runtime/reply-preferences.json');}
  get(){noLinks(this.file);if(!fs.existsSync(this.file))return {version:0,mode:'text'};const info=fs.statSync(this.file);if(!info.isFile()||info.size>1024)throw fault('UI_REPLY_SETTINGS_INVALID');let value;try{value=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{throw fault('UI_REPLY_SETTINGS_INVALID');}if(!value||typeof value!=='object'||Array.isArray(value)||!Number.isSafeInteger(value.version)||value.version<1||!['text','voice'].includes(value.mode)||Object.keys(value).length!==2)throw fault('UI_REPLY_SETTINGS_INVALID');return value;}
  replace({expectedVersion,mode}={}){if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=Number.MAX_SAFE_INTEGER||!['text','voice'].includes(mode))throw fault('UI_REPLY_SETTINGS_INVALID');noLinks(this.file);fs.mkdirSync(path.dirname(this.file),{recursive:true});const lock=this.file+'.lock',temp=this.file+'.'+crypto.randomUUID()+'.tmp';noLinks(lock);let fd;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fault('UI_REPLY_SETTINGS_BUSY');throw error;}
    try{if(this.get().version!==expectedVersion)throw fault('UI_REPLY_SETTINGS_VERSION_CONFLICT');const next={version:expectedVersion+1,mode},out=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(out,JSON.stringify(next));fs.fsyncSync(out);}finally{fs.closeSync(out);}fs.renameSync(temp,this.file);return next;}
    finally{fs.closeSync(fd);fs.unlinkSync(lock);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
}
