import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code, attempted: false });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
function noLinks(file) {
  for(let current=path.resolve(file);;current=path.dirname(current)) {
    if(fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())throw fail('UI_ASYNC_ORIGIN_INVALID');
    if(path.dirname(current)===current)return;
  }
}
/** Sticky account-origin barrier. Selecting Hook never clears UI-origin work.
 * Unknown asynchronous notifications for a marked account stay unsupported. */
export class UiAsyncOrigins {
  constructor({root}) { this.file=path.join(path.resolve(root),'state/reader-service/ui-async-origins.json'); }
  #key(account) { if(!identity(String(account)))throw fail('UI_ASYNC_ACCOUNT_REQUIRED');return crypto.createHash('sha256').update(String(account)).digest('hex'); }
  #read() {
    noLinks(this.file);const stat=fs.statSync(this.file,{throwIfNoEntry:false});
    if(!stat)return {version:1,accounts:[]};
    if(!stat.isFile()||stat.size>1024*1024)throw fail('UI_ASYNC_ORIGIN_INVALID');
    let data;try{data=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{throw fail('UI_ASYNC_ORIGIN_INVALID');}
    if(data?.version!==1||Object.keys(data).length!==2||!Array.isArray(data.accounts)||data.accounts.length>10000||data.accounts.some(value=>!hex(value))||new Set(data.accounts).size!==data.accounts.length)throw fail('UI_ASYNC_ORIGIN_INVALID');
    return data;
  }
  remember(account) {
    const key=this.#key(account);if(this.#read().accounts.includes(key))return;
    const directory=path.dirname(this.file);noLinks(directory);fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const lock=this.file+'.lock';noLinks(lock);let fd;
    try{fd=fs.openSync(lock,'wx',0o600);}catch{throw fail('UI_ASYNC_ORIGIN_BUSY');}
    const temp=this.file+'.'+crypto.randomUUID()+'.tmp';
    try {
      const value=this.#read();if(value.accounts.includes(key))return;
      if(value.accounts.length>=10000)throw fail('UI_ASYNC_ORIGIN_LIMIT');value.accounts.push(key);
      const output=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(output,JSON.stringify(value));fs.fsyncSync(output);}finally{fs.closeSync(output);}
      fs.renameSync(temp,this.file);
    }finally{fs.closeSync(fd);fs.unlinkSync(lock);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  isUiAccount(account) { return this.#read().accounts.includes(this.#key(account)); }
  assertAsyncAllowed(account, message) {
    if(message?.ui_selection_required!==undefined||message?.ui_reply_scope!==undefined||this.isUiAccount(account))throw fail('UI_ASYNC_UNSUPPORTED');
  }
}
