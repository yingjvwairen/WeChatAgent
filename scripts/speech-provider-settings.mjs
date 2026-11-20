import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const capabilities = ['asr', 'tts'];
const defaults = () => ({
  version: 0,
  asr: {mode:'local', endpoint:'', model:'', protectedKey:''},
  tts: {mode:'local', endpoint:'', model:'', voice:'', protectedKey:''},
});
const fail = (message, status=400) => Object.assign(new Error(message), {code:'SPEECH_PROVIDER_SETTINGS_INVALID',status});
const exact = (obj, fields) => obj && typeof obj==='object' && !Array.isArray(obj) &&
  Object.keys(obj).length===fields.length && fields.every(field=>Object.hasOwn(obj,field));

function safePath(file) {
  for(let at=file;;at=path.dirname(at)){
    if(fs.lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink()) throw fail('语音设置目录不能是链接。');
    if(at===path.dirname(at))return file;
  }
}
function settingsFile(root) {
  if(!path.isAbsolute(root))throw fail('本机项目路径无效。');
  return safePath(path.join(root,'state','runtime','speech-providers.json'));
}
function credential(operation, value) {
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(import.meta.dirname,'console-native.ps1'),'-Kind',operation],
    {input:value,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:65536});
  if(result.status!==0 || !result.stdout)throw fail('无法使用当前 Windows 账户读写语音服务密钥。',503);
  return result.stdout;
}
function checkedString(value, limit) {
  if(typeof value!=='string'||value.length>limit||/[\x00-\x1f\x7f]/u.test(value))throw fail('语音设置包含无效字符或字段过长。');
  return value.trim();
}
function endpointOf(value) {
  const supplied=checkedString(value,2048);
  if(!supplied)return '';
  let url;
  try{url=new URL(supplied);}catch{throw fail('请填写完整的语音接口地址。');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback)||url.username||url.password||url.hash||url.search)
    throw fail('请使用 HTTPS 接口地址，本机服务也可使用 HTTP。密钥请填入密钥栏。');
  return url.href;
}
function checkedRow(kind, row, secretField) {
  const fields=['mode','endpoint','model',secretField,...(kind==='tts'?['voice']:[])];
  const named=kind==='asr'&&Object.hasOwn(row??{},'localProfileId');
  if(kind==='asr'&&Object.hasOwn(row??{},'localModelDirectory'))fields.push('localModelDirectory');
  if(named)fields.push('localProfileId','localProfiles');
  if(!exact(row,fields)||!['local','cloud'].includes(row.mode))throw fail('语音服务设置无效。');
  const endpoint=endpointOf(row.endpoint),model=checkedString(row.model,256);
  const voice=kind==='tts'?checkedString(row.voice,256):undefined;
  if(row.mode==='cloud'&&(!endpoint||!model||kind==='tts'&&!voice))throw fail('云端模式需要完整的接口地址、模型和合成音色。');
  if(kind==='tts')return {mode:row.mode,endpoint,model,voice};
  const result={mode:row.mode,endpoint,model,localModelDirectory:checkedModelPath(row.localModelDirectory??'')};
  if(named){
    if(typeof row.localProfileId!=='string'||!(row.localProfileId==='default'||row.localProfileId==='default-zh'||/^installed-[0-9a-f]{32}$/.test(row.localProfileId)||customAsrId.test(row.localProfileId)))
      throw fail('请选择有效的本地识别方案。');
    result.localProfileId=row.localProfileId;
    result.localProfiles=checkedAsrProfiles(row.localProfiles);
  }
  return result;
}
const customAsrId=/^asr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Whisper multilingual tokenizer languages, including Cantonese for large-v3.
const languages=new Set('af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh yue'.split(' '));

function checkedAsrProfiles(rows){
  if(!Array.isArray(rows)||rows.length>32)throw fail('最多可保存 32 个自定义识别方案。');
  const ids=new Set(),names=new Set();
  return rows.map(row=>{
    if(!exact(row,['id','name','modelDirectory','language','initialPrompt'])||typeof row.id!=='string'||!customAsrId.test(row.id)||ids.has(row.id))
      throw fail('识别方案编号无效或重复。');
    const name=checkedString(row.name,80);
    const comparable=name.normalize('NFKC').toLowerCase();
    if(!name||names.has(comparable))throw fail('请输入不重复的识别方案名称。');
    if(row.language!==''&&!languages.has(row.language))throw fail('请选择 faster-whisper 支持的识别语言。');
    if(typeof row.initialPrompt!=='string'||row.initialPrompt.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(row.initialPrompt))
      throw fail('识别提示词最多 500 个字符。');
    ids.add(row.id);names.add(comparable);
    return {id:row.id,name,modelDirectory:checkedModelPath(row.modelDirectory),language:row.language,initialPrompt:row.initialPrompt.trim().replace(/\r\n?/g,'\n')};
  });
}
function checkedModelPath(value) {
  const file=checkedString(value,1024);
  if(!file)return '';
  if(!path.isAbsolute(file)||/^[\\/]{2}/.test(file))throw fail('请选择本机的模型文件夹。');
  return path.normalize(file);
}
function usableModel(dir) {
  try {
    return ['model.bin','config.json','tokenizer.json'].every(file=>{
      const stat=fs.statSync(safePath(path.join(dir,file)),{throwIfNoEntry:false});
      return stat?.isFile()&&stat.size>0;
    });
  }catch{return false;}
}
function defaultModelDirectory(root) {
  const mediaDir=path.join(root,'state','media-processing'),models=path.join(mediaDir,'models');
  let configured=path.join(models,'faster-whisper-small');
  try{
    const file=safePath(path.join(mediaDir,'config.json'));
    if(fs.statSync(file).size<=65536)configured=checkedModelPath(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')).modelDirectory)||configured;
  }catch{/* Older or unprepared installations use the bundled Small configuration. */}
  return configured;
}
const modelLabel=p=>path.basename(p).replace(/^faster-whisper-/i,'').replace(/^./,c=>c.toUpperCase());
function installedModels(root,selected,configured=defaultModelDirectory(root)) {
  const models=path.join(root,'state/media-processing/models');
  const choices=[{directory:'',label:modelLabel(configured)+'（默认）',installed:usableModel(configured)}];
  let dirs=[];
  try{dirs=fs.readdirSync(safePath(models),{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.isSymbolicLink()).map(d=>path.join(models,d.name));}catch{}
  if(selected)dirs.push(selected);
  for(const dir of new Set(dirs.sort())){
    if(dir===configured&&dir!==selected)continue;
    const installed=usableModel(dir);
    if(installed||dir===selected)choices.push({directory:dir,label:modelLabel(dir),installed});
  }
  return choices;
}

const directoryDigest=dir=>crypto.createHash('sha256').update(process.platform==='win32'?path.normalize(dir).toLowerCase():path.normalize(dir)).digest('hex');
const installedId=dir=>dir?'installed-'+directoryDigest(dir).slice(0,32):'default';
const managedDirectory=(root,dir)=>dir&&path.relative(path.join(root,'state/media-processing/models'),path.dirname(dir))==='';

// Preserve an older explicitly chosen external folder as a named scheme even
// after another model is selected. Reading this view never modifies the file.
function legacyAsrChoice(root,dir,profiles){
  if(!dir||managedDirectory(root,dir))return installedId(dir);
  const existing=profiles.find(p=>p.modelDirectory&&path.relative(p.modelDirectory,dir)===''&&!p.language&&!p.initialPrompt);
  if(existing)return existing.id;
  const hex=directoryDigest(dir);
  const id='asr-'+[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join('-');
  const name=modelLabel(dir).slice(0,65)||'本地模型';
  let label=name;
  for(let n=2;profiles.some(p=>p.name.toLowerCase()===label.toLowerCase());n++)label=name+' ('+n+')';
  const currentId=profiles.some(p=>p.id===id)?'asr-'+crypto.randomUUID():id;
  profiles.push({id:currentId,name:label,modelDirectory:dir,language:'',initialPrompt:''});
  return currentId;
}
function asrSelection(root,row){
  const profiles=structuredClone(row.localProfiles??[]);
  const id=row.localProfileId??legacyAsrChoice(root,row.localModelDirectory??'',profiles);
  return {id,profiles};
}
function asrOptions(root,models,profiles,configured){
  const builtins=models.filter(m=>!m.directory||managedDirectory(root,m.directory)).map(m=>({
    id:installedId(m.directory),name:m.label,modelDirectory:m.directory,language:'',initialPrompt:'',builtin:true,installed:m.installed,
    resolvedModelDirectory:m.directory||configured,
  }));
  const normal=builtins[0];
  builtins.splice(1,0,{...normal,id:'default-zh',name:modelLabel(configured)+' · 中文',language:'zh'});
  return builtins.concat(profiles.map(p=>({...p,builtin:false,installed:usableModel(p.modelDirectory||configured),resolvedModelDirectory:p.modelDirectory||configured})));
}
function configureAsr(root,fields,raw,previous){
  const prior=asrSelection(root,previous);
  const profiles=fields.localProfiles??prior.profiles;
  let id=fields.localProfileId??prior.id;
  if(!fields.localProfileId&&Object.hasOwn(raw,'localModelDirectory')&&fields.localModelDirectory!==(previous.localModelDirectory??''))
    id=legacyAsrChoice(root,fields.localModelDirectory,profiles);
  const choices=installedModels(root,raw.localProfileId?previous.localModelDirectory:fields.localModelDirectory||previous.localModelDirectory);
  const preset=choices.find(m=>installedId(m.directory)===(id==='default-zh'?'default':id)&&(!m.directory||managedDirectory(root,m.directory)));
  const custom=profiles.find(p=>p.id===id);
  if(!preset&&!custom)throw fail('所选识别方案已不存在，请刷新后重试。');
  const directory=custom?custom.modelDirectory:preset.directory;
  const needsAssets=p=>p.modelDirectory&&!prior.profiles.some(old=>old.id===p.id&&old.modelDirectory===p.modelDirectory);
  if(profiles.length>32)throw fail('最多可保存 32 个自定义识别方案。');
  if(profiles.some(p=>needsAssets(p)&&!usableModel(p.modelDirectory))||
    (directory&&id!==prior.id&&!usableModel(directory)))
    throw fail('请选择完整的 faster-whisper 模型目录，需包含 model.bin、config.json 和 tokenizer.json。');
  Object.assign(fields,{localProfileId:id,localProfiles:profiles,localModelDirectory:directory});
}
function readStored(file) {
  const stat=fs.statSync(file,{throwIfNoEntry:false});
  if(!stat)return defaults();
  if(!stat.isFile()||stat.size>65536)throw fail('语音设置文件无效。',409);
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  const fields=['version','asr','tts'];
  if(data?.voiceProfileSlot===0||data?.voiceProfileSlot===1)fields.push('voiceProfileSlot');
  if(!exact(data,fields)||!Number.isSafeInteger(data.version)||data.version<1)throw fail('语音设置版本无效。',409);
  for(const kind of capabilities){
    const row=checkedRow(kind,data[kind],'protectedKey');
    if(kind==='asr'&&row.localProfileId){
      const id=row.localProfileId,dir=row.localModelDirectory;
      const pathMatches=customAsrId.test(id)?row.localProfiles.find(p=>p.id===id)?.modelDirectory===dir
        :id.startsWith('installed-')?id===installedId(dir):dir==='';
      if(!pathMatches)throw fail('语音识别方案记录不一致。',409);
    }
    if(typeof data[kind].protectedKey!=='string'||data[kind].protectedKey&&!/^userdpapi:[A-Za-z0-9+/]+={0,2}$/.test(data[kind].protectedKey))throw fail('语音服务密钥记录无效。',409);
  }
  return data;
}
function view(root,data,includeLocalModels) {
  const result={version:data.version};
  for(const kind of capabilities){
    const {protectedKey,...fields}=data[kind];
    result[kind]={...fields,hasApiKey:!!protectedKey};
  }
  if(includeLocalModels){
    const configured=defaultModelDirectory(root),{id,profiles}=asrSelection(root,data.asr);
    result.localAsrModels=installedModels(root,data.asr.localModelDirectory,configured);
    result.localAsrProfiles=asrOptions(root,result.localAsrModels,profiles,configured);
    Object.assign(result.asr,{localProfileId:id,localProfiles:profiles});
  }
  return result;
}
export function readSpeechProviderView({root,includeLocalModels=false}) {return view(root,readStored(settingsFile(root)),includeLocalModels);}

// Older installations store their catalog in slot 0. During a combined
// save the other slot is written first. The final atomic provider-file
// rename publishes both the provider settings and the selected voice.
export function voiceProfileCatalogFile(root,directory,slot) {
  // A diagnostic preview can supply its own config directory. Its profiles
  // are separate from the catalog used by this project's sender.
  if(path.relative(path.join(root,'state','dania-voice'),directory)!==''){
    if(slot!==undefined)throw fail('此语音配置目录不能同时保存项目语音服务设置。',409);
    return safePath(path.join(directory,'voice-profiles.json'));
  }
  const reading=slot===undefined;
  const committed=reading?readStored(settingsFile(root)).voiceProfileSlot:undefined;
  slot??=committed??0;
  if(slot!==0&&slot!==1)throw fail('本地音色目录无效。',409);
  const file=safePath(path.join(directory,slot===0?'voice-profiles.json':'voice-profiles.1.json'));
  if(committed!==undefined&&!fs.existsSync(file))throw fail('已保存的本地音色配置不可读。',409);
  return file;
}

// Decryption stays inside the sender/reader process, never in a console response.
const cachedKeys=new Map();
export function readSpeechProviders({root,capability}) {
  const data=readStored(settingsFile(root));
  delete data.voiceProfileSlot;
  for(const kind of capabilities){
    const {protectedKey,...fields}=data[kind];
    let apiKey='';
    const slot=path.join(root,kind);
    if(fields.mode!=='cloud'||!protectedKey)cachedKeys.delete(slot);
    else if(!capability||capability===kind){
      const cached=cachedKeys.get(slot);
      if(cached?.ciphertext===protectedKey)apiKey=cached.clear;
      else{apiKey=credential('unprotect',protectedKey);cachedKeys.set(slot,{ciphertext:protectedKey,clear:apiKey});}
    }
    data[kind]={...fields,apiKey};
  }
  return data;
}
export function saveSpeechProviders({root}, request, stageLocalVoice) {
  if(!exact(request,['expectedVersion','asr','tts'])||!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<0)
    throw fail('语音服务设置无效。');
  const file=settingsFile(root);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const lock=safePath(file+'.lock');
  let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fail('语音设置正在保存，请稍后重试。',409);throw error;}
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try{
    const current=readStored(file);
    if(current.version!==request.expectedVersion)throw fail('语音设置已变更，请刷新后再保存。',409);
    if(current.version===Number.MAX_SAFE_INTEGER)throw fail('语音设置版本无效。',409);
    const next={version:current.version+1};
    if(current.voiceProfileSlot!==undefined)next.voiceProfileSlot=current.voiceProfileSlot;
    for(const kind of capabilities){
      const row=request[kind],fields=checkedRow(kind,row,'apiKey'),previous=current[kind];
      if(kind==='asr')configureAsr(root,fields,row,previous);
      // null keeps a credential. An explicit empty string clears it. Never carry
      // a saved key to another endpoint unless the operator supplied it again.
      const keep=row.apiKey===null;
      if(keep&&previous.protectedKey&&fields.endpoint!==previous.endpoint)throw fail('更换接口地址时，请重新填写或清除原密钥。');
      const key=keep?'':checkedString(row.apiKey,4096);
      const protectedKey=keep?previous.protectedKey:key?credential('protect',key):'';
      next[kind]={...fields,protectedKey};
    }
    if(Buffer.byteLength(JSON.stringify(next))>65500)throw fail('语音服务设置过大，请缩短识别提示词或减少方案。');
    if(stageLocalVoice){
      next.voiceProfileSlot=1-(current.voiceProfileSlot??0);
      stageLocalVoice(next.voiceProfileSlot);
    }
    const result=view(root,next,true);
    const out=fs.openSync(tmp,'wx',0o600);
    try{fs.writeFileSync(out,JSON.stringify(next));fs.fsyncSync(out);}finally{fs.closeSync(out);}
    fs.renameSync(tmp,file);
    return result;
  }finally{
    try{fs.rmSync(tmp,{force:true});}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
  }
}
