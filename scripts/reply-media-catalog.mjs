import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {inspectReplyImage,REPLY_IMAGE_MAX_BYTES} from './reply-image-format.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fault=code=>Object.assign(new Error(code),{code});
const label=(value,max)=>typeof value==='string'&&Boolean(value.trim())&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
function noLinks(file){for(let at=path.resolve(file);;at=path.dirname(at)){if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw fault('REPLY_MEDIA_LINK_REFUSED');if(path.dirname(at)===at)return;}}
function localFile(file){if(!path.isAbsolute(file??'')||/^[/\\]{2}/.test(file))throw fault('REPLY_MEDIA_PATH_INVALID');noLinks(file);return path.resolve(file);}
function imageFile(file){
  file=localFile(file);const stat=fs.statSync(file,{throwIfNoEntry:false});
  if(!stat?.isFile()||stat.size<4||stat.size>REPLY_IMAGE_MAX_BYTES)throw fault('REPLY_MEDIA_FILE_INVALID');
  const bytes=fs.readFileSync(file);if(bytes.length!==stat.size)throw fault('REPLY_MEDIA_FILE_CHANGED');
  let format;try{format=inspectReplyImage(bytes);}catch(error){throw fault(error.code.replace(/^REPLY_IMAGE_/,'REPLY_MEDIA_'));}
  return{path:file,sha256:hash(bytes),md5:crypto.createHash('md5').update(bytes).digest('hex'),bytes:bytes.length,mimeType:format.mimeType,
    ...(format.extension==='gif'?{format:'gif',frameCount:format.frameCount,animated:format.animated}: {})};
}
function normalizeItem(item,{verify=false}={}){
  if(!object(item)||Object.keys(item).some(key=>!['id','sha256','name','path','kind','tags'].includes(key))||!digest(item.id)||item.sha256!==undefined&&item.sha256!==item.id||
    !label(item.name,120)||!['image','sticker'].includes(item.kind)||!Array.isArray(item.tags)||item.tags.length>6||item.tags.some(tag=>!label(tag,16)))throw fault('REPLY_MEDIA_ITEM_INVALID');
  const file=localFile(item.path);if(verify&&imageFile(file).sha256!==item.id)throw fault('REPLY_MEDIA_FILE_CHANGED');
  return{id:item.id,sha256:item.id,name:item.name.trim(),path:file,kind:item.kind,tags:[...new Set(item.tags.map(tag=>tag.trim()))]};
}

/** Explicit local assets. Only list() crosses into model candidate context;
 * original local paths exist solely in the authenticated console and sender. */
export class ReplyMediaCatalog {
  constructor({root=path.resolve(import.meta.dirname,'..'),configPath=path.join(root,'state/reply-media/config.json')}={}){
    this.root=path.resolve(root);this.file=localFile(configPath);
  }
  #read(){
    noLinks(this.file);const stat=fs.statSync(this.file,{throwIfNoEntry:false});
    if(!stat)return{version:1,enabled:true,items:[],revision:hash('missing')};
    if(!stat.isFile()||stat.size>1024*1024)throw fault('REPLY_MEDIA_CONFIG_INVALID');
    const bytes=fs.readFileSync(this.file);let value;try{value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{throw fault('REPLY_MEDIA_CONFIG_INVALID');}
    if(!object(value)||Object.keys(value).some(key=>!['version','enabled','items'].includes(key))||value.version!==1||value.enabled!==undefined&&typeof value.enabled!=='boolean'||!Array.isArray(value.items)||value.items.length>1000)throw fault('REPLY_MEDIA_CONFIG_INVALID');
    const items=value.items.map(item=>normalizeItem(item));if(new Set(items.map(item=>item.id)).size!==items.length)throw fault('REPLY_MEDIA_CONFIG_INVALID');
    // Retain the response field for older consoles. Imported assets are always
    // available; only removing an item removes it from model candidates.
    return{version:1,enabled:true,items,revision:hash(bytes)};
  }
  snapshot(){return structuredClone(this.#read());}
  #write(previous,{items}){
    if(!Array.isArray(items)||items.length>1000)throw fault('REPLY_MEDIA_CONFIG_INVALID');
    const normalized=items.map(item=>normalizeItem(item,{verify:true}));if(new Set(normalized.map(item=>item.id)).size!==normalized.length)throw fault('REPLY_MEDIA_CONFIG_INVALID');
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const lock=this.file+'.lock',owner=crypto.randomUUID();noLinks(lock);
    try{fs.writeFileSync(lock,owner,{flag:'wx',mode:0o600});}catch{throw fault('REPLY_MEDIA_BUSY');}
    const temporary=this.file+'.'+owner+'.tmp';
    try{
      if(this.#read().revision!==previous.revision)throw fault('REPLY_MEDIA_REVISION_CONFLICT');
      // Running senders from before this change still require the boolean field.
      const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({version:1,enabled:true,items:normalized},null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      noLinks(this.file);fs.renameSync(temporary,this.file);return this.snapshot();
    }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);noLinks(lock);if(fs.readFileSync(lock,'utf8')===owner)fs.unlinkSync(lock);}
  }
  replace({expectedRevision,enabled,items}={}){
    if(enabled!==undefined&&typeof enabled!=='boolean')throw fault('REPLY_MEDIA_CONFIG_INVALID');
    const previous=this.#read();if(expectedRevision!==previous.revision)throw fault('REPLY_MEDIA_REVISION_CONFLICT');return this.#write(previous,{items});
  }
  list({query='',limit=20,includeGif=false}={}){
    if(typeof query!=='string'||query.length>500||!Number.isInteger(limit)||limit<1||limit>100||typeof includeGif!=='boolean')throw fault('REPLY_MEDIA_QUERY_INVALID');
    const snapshot=this.#read();
    const term=query.trim().toLocaleLowerCase(),score=item=>[item.name,...item.tags].filter(value=>term.includes(value.toLocaleLowerCase())||value.toLocaleLowerCase().includes(term)).length;
    const ordered=[...snapshot.items].sort((a,b)=>(term?score(b)-score(a):0)||a.name.localeCompare(b.name));
    const results=[];
    for(const item of ordered){
      let asset;try{asset=imageFile(item.path);if(asset.sha256!==item.id||asset.format==='gif'&&!includeGif)continue;}catch{continue;}
      results.push({id:item.id,kind:item.kind,description:item.name,tags:[...item.tags],source:'local-reply-media',...(asset.format==='gif'?{format:'gif',mimeType:asset.mimeType,animated:asset.animated}:{})});if(results.length>=limit)break;
    }
    return results;
  }
  resolve(id){
    if(!digest(id))throw fault('REPLY_MEDIA_ID_INVALID');const snapshot=this.#read();
    const item=snapshot.items.find(row=>row.id===id);if(!item)throw fault('REPLY_MEDIA_NOT_FOUND');
    const asset=imageFile(item.path);if(asset.sha256!==item.id)throw fault('REPLY_MEDIA_FILE_CHANGED');return{...structuredClone(item),...asset};
  }
  importDirectory({directory,kind='image',expectedRevision}={}){
    directory=localFile(directory);if(!fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory()||!['image','sticker'].includes(kind))throw fault('REPLY_MEDIA_IMPORT_INVALID');
    const previous=this.#read();if(expectedRevision!==previous.revision)throw fault('REPLY_MEDIA_REVISION_CONFLICT');
    const names=fs.readdirSync(directory,{withFileTypes:true});if(names.length>10000)throw fault('REPLY_MEDIA_IMPORT_LIMIT');
    const items=[...previous.items],known=new Set(items.map(item=>item.id));let added=0,skipped=0,skippedUnsupportedGif=0;
    for(const entry of names.sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.isSymbolicLink()||!entry.isFile()){skipped++;continue;}
      const extension=path.extname(entry.name).toLowerCase();
      if(!['.png','.jpg','.jpeg','.gif'].includes(extension)){skipped++;continue;}
      let asset;try{asset=imageFile(path.join(directory,entry.name));}catch{skipped++;continue;}
      if(known.has(asset.sha256)){skipped++;continue;}if(items.length>=1000)throw fault('REPLY_MEDIA_IMPORT_LIMIT');
      const name=path.basename(entry.name,extension).slice(0,120);if(!label(name,120)){skipped++;continue;}
      items.push({id:asset.sha256,sha256:asset.sha256,name,path:asset.path,kind,tags:[]});known.add(asset.sha256);added++;
    }
    const snapshot=added?this.#write(previous,{items}):previous;
    return{...structuredClone(snapshot),added,skipped,skippedUnsupportedGif};
  }
}
