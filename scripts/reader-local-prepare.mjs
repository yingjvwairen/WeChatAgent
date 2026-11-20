import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runReaderSetup } from './reader-setup.mjs';
import { prepareLocalReaderRequest, checkLocalReader, connectLocalReader, activateLocalReaderAccount } from './reader-local-setup.mjs';

const execute = promisify(execFile), projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function noLinks(file) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink()) throw fault('READER_LOCAL_LINK_REJECTED');
    if (current === path.dirname(current)) return path.resolve(file);
  }
}
function local(value) {
  if(typeof value!=='string'||!path.isAbsolute(value)||/^[\\/]{2}/u.test(value)||/[\0\r\n]/u.test(value))throw fault('READER_LOCAL_PATH_REQUIRED');
  return noLinks(value);
}
function json(file) { noLinks(file);const stat=fs.statSync(file);if(!stat.isFile()||stat.size>65536)throw fault('READER_LOCAL_JSON_INVALID');return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
function atomic(file,value) {
  noLinks(file);const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

/** First installation for an explicitly selected local database directory.
 * Discovery reads directory names only; database/key capture starts separately. */
export async function prepareLocalReaderEnvironment({root=projectRoot,dbPath,myWxid,wechatExecutable,
  executeImpl=execute,setup=runReaderSetup,check=checkLocalReader,onProgress=()=>{}}={}) {
  dbPath=local(dbPath);wechatExecutable=local(wechatExecutable);
  if(typeof myWxid!=='string'||!myWxid||myWxid.length>256||/[\0\r\n\\/]/u.test(myWxid)||path.basename(wechatExecutable).toLowerCase()!=='weixin.exe')throw fault('READER_LOCAL_PREPARE_ARGUMENTS_INVALID');
  const directory=noLinks(path.join(root,'state/reader'));fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const requestFile=path.join(directory,'connection-request.json');
  if(fs.existsSync(requestFile)){
    const existing=check({root});
    if(existing.account.myWxid!==myWxid||path.resolve(existing.account.dbPath).toLowerCase()!==dbPath.toLowerCase()||path.resolve(existing.request.wechatExecutable).toLowerCase()!==wechatExecutable.toLowerCase())throw fault('READER_LOCAL_PREPARED_ACCOUNT_MISMATCH');
    return{prepared:true,reused:true,processAttached:false,credentialsWritten:false};
  }
  const runtime=json(path.join(root,'state/ui-runtime.json')),pythonBase=local(runtime.pythonBase);
  if(runtime.schemaVersion!==1||!fs.statSync(pythonBase).isFile())throw fault('READER_LOCAL_RUNTIME_NOT_VERIFIED');
  const lock=noLinks(path.join(directory,'preparation.lock'));let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch{throw fault('READER_LOCAL_PREPARATION_BUSY');}
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^CODEX/i.test(key)&&!['PYTHONHOME','PYTHONPATH','NODE_OPTIONS','NODE_PATH'].includes(key.toUpperCase())));
  const run=async(exe,args)=>{
    try{return await executeImpl(exe,args,{cwd:root,env,windowsHide:true,shell:false,encoding:'utf8',timeout:600000,maxBuffer:1024*1024});}
    catch{throw fault('READER_LOCAL_PREPARE_RUNTIME_FAILED');}
  };
  try{
    const discovered=await setup({root,python:pythonBase,request:{operation:'discover',dbPath}});
    const matches=discovered?.ok===true&&Array.isArray(discovered.accounts)?discovered.accounts.filter(a=>a.myWxid===myWxid&&a.ready===true&&path.resolve(a.dbPath).toLowerCase()===dbPath.toLowerCase()):[];
    if(matches.length!==1)throw fault('READER_LOCAL_DISCOVERY_NOT_UNIQUE');
    const account=matches[0];local(account.dbPath);
    const venv=path.join(directory,'venv'),python=path.join(venv,'Scripts/python.exe');noLinks(python);
    if(!fs.existsSync(python)){
      onProgress('正在准备项目独立的读取环境。');
      await run(pythonBase,['-I','-m','venv',venv]);
      onProgress('正在安装读取组件依赖。');
      await run(python,['-I','-m','pip','install','--disable-pip-version-check','-r',path.join(root,'scripts/reader-requirements.txt')]);
    }
    const probe='import sys,json,sqlcipher3,cryptography,zstandard,Crypto,PIL,imageio_ffmpeg; c=sqlcipher3.connect(":memory:"); c.execute("select 1").fetchone(); c.close(); print(json.dumps({"schemaVersion":1,"isolated":sys.flags.isolated==1,"memoryDatabaseCheck":True,"pythonVersion":list(sys.version_info[:3]),"prefix":sys.prefix}))';
    let result;
    try{result=await run(python,['-I','-c',probe]);}
    catch{
      // A cancelled first installation can leave the interpreter with missing
      // packages. Reinstall the pinned requirements, then verify again.
      onProgress('正在补齐读取组件依赖。');
      await run(python,['-I','-m','pip','install','--disable-pip-version-check','-r',path.join(root,'scripts/reader-requirements.txt')]);
      result=await run(python,['-I','-c',probe]);
    }
    let report;
    try{report=JSON.parse(result.stdout);}catch{throw fault('READER_LOCAL_RUNTIME_NOT_VERIFIED');}
    if(report.schemaVersion!==1||report.isolated!==true||report.memoryDatabaseCheck!==true||report.pythonVersion?.[0]!==3||report.pythonVersion?.[1]!==12||path.resolve(report.prefix).toLowerCase()!==path.resolve(venv).toLowerCase())throw fault('READER_LOCAL_RUNTIME_NOT_VERIFIED');
    report.requirementsSha256=hash(fs.readFileSync(path.join(root,'scripts/reader-requirements.txt')));
    atomic(path.join(directory,'runtime-check.json'),report);
    const discoveryName='discovery-'+crypto.randomUUID()+'.json';
    atomic(path.join(directory,discoveryName),{schemaVersion:1,readOnlyDiscovery:true,databaseContentRead:false,processAttached:false,dataRoot:path.dirname(account.dbPath),accounts:[account]});
    prepareLocalReaderRequest({root,discoveryName,wechatExecutable});
    check({root});
    return{prepared:true,reused:false,processAttached:false,credentialsWritten:false};
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  Promise.resolve().then(async()=>{
    const args=process.argv.slice(2);if(![6,7].includes(args.length)||args[0]!=='--db-path'||args[2]!=='--account'||args[4]!=='--wechat'||args[6]!==undefined&&args[6]!=='--connect')throw fault('READER_LOCAL_PREPARE_ARGUMENTS_INVALID');
    const result=await prepareLocalReaderEnvironment({dbPath:args[1],myWxid:args[3],wechatExecutable:args[5],onProgress:message=>console.error(message)});
    if(args[6]){
      await connectLocalReader({onProgress:({code})=>{if(code==='READER_LOCAL_COMPONENT_ATTACHED')console.error('读取组件已就绪，请在微信退出账号并重新登录同一账号；最多等待约 3 分钟。');}});
      console.log(JSON.stringify({...result,...activateLocalReaderAccount()}));
    }else console.log(JSON.stringify(result));
  }).catch(error=>{console.error(/^READER_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'READER_LOCAL_PREPARE_FAILED');process.exitCode=1;});
}
