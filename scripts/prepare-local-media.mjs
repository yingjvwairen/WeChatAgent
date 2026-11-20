import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readSpeechProviderView} from './speech-provider-settings.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const LOCAL_MEDIA_ARTIFACTS=Object.freeze({
  revision:'536b0662742c02347bc0e980a01041f333bce120',repository:'Systran/faster-whisper-small',
  model:[
    {file:'config.json',size:2370,gitBlob:'e5047537059bd8f182d9ca64c470201585015187'},
    {file:'tokenizer.json',size:2203239,gitBlob:'7818adb6de9fa3064d3ff81226fdd675be1f6344'},
    {file:'vocabulary.txt',size:459861,gitBlob:'c9074644d9d1205686f16d411564729461324b75'},
    {file:'model.bin',size:483546902,sha256:'3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'},
  ],
  wheels:[
    {file:'av-15.1.0-cp312-cp312-win_amd64.whl',sha256:'d5921aa45f4c1f8c1a8d8185eb347e02aa4c3071278a2e2dd56368d54433d643',url:'https://files.pythonhosted.org/packages/15/74/6f8e38a3b0aea5f28e72813672ff45b64615f2c69e6a4a558718c95edb9f/av-15.1.0-cp312-cp312-win_amd64.whl'},
    {file:'faster_whisper-1.2.1-py3-none-any.whl',sha256:'79a66ad50688c0b794dd501dc340a736992a6342f7f95e5811be60b5224a26a7',url:'https://files.pythonhosted.org/packages/05/99/49ee85903dee060d9f08297b4a342e5e0bcfca2f027a07b4ee0a38ab13f9/faster_whisper-1.2.1-py3-none-any.whl'},
    {file:'silk_python-0.2.8-cp312-cp312-win_amd64.whl',sha256:'b9bb030589150e0d91f8148971eebf6f9211e6839af64dd39b26b9802be242b0',url:'https://files.pythonhosted.org/packages/58/56/67d9a94be90df5d0d80e1bbc6da0fc142e01777fb7c1e7c2c27047a90ee0/silk_python-0.2.8-cp312-cp312-win_amd64.whl'},
  ],
});
const ffmpegWheel={file:'imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl',sha256:'02fa47c83703c37df6bfe4896aab339013f62bf02c5ebf2dce6da56af04ffc0a',url:'https://files.pythonhosted.org/packages/2c/c6/fa760e12a2483469e2bf5058c5faff664acf66cadb4df2ad6205b016a73d/imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl'};
const extraModels={
  tiny:{revision:'d90ca5fe260221311c53c58e660288d3deb8d356',configBytes:2249,configBlob:'3baa18e2b321a2f489614607852a729fcd516480',size:75538270,sha256:'dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1'},
  base:{revision:'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66',configBytes:2309,configBlob:'867cf1a0fece1394e01d55e287ba2f09a577c046',size:145217532,sha256:'d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9'},
};
function modelArtifacts(name) {
  if(name==='small')return LOCAL_MEDIA_ARTIFACTS;
  if(!Object.hasOwn(extraModels,name))throw Error('MEDIA_MODEL_UNSUPPORTED');
  const {revision,configBytes,configBlob,size,sha256}=extraModels[name];
  return {revision,repository:'Systran/faster-whisper-'+name,model:[
    {file:'config.json',size:configBytes,gitBlob:configBlob},
    ...LOCAL_MEDIA_ARTIFACTS.model.filter(f=>['vocabulary.txt','tokenizer.json'].includes(f.file)),
    {file:'model.bin',size,sha256},
  ]};
}
function run(exe,args){const value=spawnSync(exe,args,{cwd:root,windowsHide:true,shell:false,encoding:'utf8',timeout:660000,maxBuffer:1024*1024});if(value.status!==0)throw Error('MEDIA_PREPARE_COMMAND_FAILED');return value.stdout;}
export function verifyArtifact(file,artifact){if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile())return false;const data=fs.readFileSync(file);if(artifact.size!==undefined&&data.length!==artifact.size)return false;return artifact.sha256?crypto.createHash('sha256').update(data).digest('hex')===artifact.sha256:crypto.createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex')===artifact.gitBlob;}
export function mediaDependencySite(projectRoot,{runPython=run}={}){
  const configFile=path.join(projectRoot,'state/dania-voice/config.json');
  let site=path.join(projectRoot,'state/dania-voice/venv/Lib/site-packages');
  if(fs.existsSync(configFile)){
    if(fs.statSync(configFile).size>65536)throw Error('MEDIA_SHARED_DEPENDENCIES_REQUIRED');
    const config=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
    if(config.pythonPath!==undefined){
      if(typeof config.pythonPath!=='string'||!path.isAbsolute(config.pythonPath)||/^[\\/]{2}/.test(config.pythonPath)||!fs.statSync(config.pythonPath,{throwIfNoEntry:false})?.isFile())throw Error('MEDIA_SHARED_DEPENDENCIES_REQUIRED');
      const detected=JSON.parse(runPython(config.pythonPath,['-I','-c',"import sys,sysconfig,json;assert sys.version_info[:2]==(3,12);print(json.dumps({'site':sysconfig.get_paths()['purelib']}))"]));
      site=detected.site;
    }
  }
  if(typeof site!=='string'||!path.isAbsolute(site)||/^[\\/]{2}/.test(site)||/[\0\r\n]/.test(site)||!fs.statSync(site,{throwIfNoEntry:false})?.isDirectory())throw Error('MEDIA_SHARED_DEPENDENCIES_REQUIRED');
  return site;
}
export function prepareLocalMedia({projectRoot=root,download=false,modelName}={}){
  const selected=readSpeechProviderView({root:projectRoot}).asr;
  const cloud=!modelName&&selected.mode==='cloud';
  const directory=path.join(projectRoot,'state/media-processing'),models=path.join(directory,'models');
  const configFile=path.join(directory,'config.json');
  const previousDirectory=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,'')).modelDirectory:null;
  if(modelName!==undefined&&!['tiny','base','small'].includes(modelName))throw Error('MEDIA_MODEL_UNSUPPORTED');
  const modelDirectory=modelName?path.join(models,'faster-whisper-'+modelName):
    (!cloud&&selected.localModelDirectory)||previousDirectory||path.join(models,'faster-whisper-small');
  if(!path.isAbsolute(modelDirectory)||/^[\\/]{2}/.test(modelDirectory))throw Error('MEDIA_MODEL_UNSUPPORTED');
  const preset=['tiny','base','small'].find(name=>path.relative(modelDirectory,path.join(models,'faster-whisper-'+name))==='');
  const catalog=preset?modelArtifacts(preset):{model:[]};
  if(!preset&&!cloud&&!['model.bin','config.json','tokenizer.json'].every(name=>{
    const stat=fs.lstatSync(path.join(modelDirectory,name),{throwIfNoEntry:false});
    return stat?.isFile()&&stat.size>0;
  }))throw Error('MEDIA_ASR_MODEL_UNAVAILABLE');
  const runtime=JSON.parse(fs.readFileSync(path.join(projectRoot,'state/ui-runtime.json'),'utf8').replace(/^\uFEFF/,''));
  const python=path.join(directory,'venv/Scripts/python.exe'),dependencySite=cloud?null:mediaDependencySite(projectRoot);
  if(!fs.existsSync(python)){if(!download)throw Error('MEDIA_RUNTIME_REQUIRED');run(runtime.pythonBase,['-m','venv',path.join(directory,'venv')]);}
  if(preset&&!cloud)fs.mkdirSync(modelDirectory,{recursive:true});
  const artifacts=cloud?[...LOCAL_MEDIA_ARTIFACTS.wheels.filter(artifact=>!artifact.file.startsWith('faster_whisper-')),ffmpegWheel]:[...LOCAL_MEDIA_ARTIFACTS.wheels,...catalog.model];
  for(const artifact of artifacts){
    const file=path.join(artifact.url?directory:modelDirectory,artifact.file);
    if(!verifyArtifact(file,artifact)){
      if(!download)throw Error('MEDIA_ARTIFACT_UNVERIFIED');
      const partial=file+'.partial',url=artifact.url??`https://huggingface.co/${catalog.repository}/resolve/${catalog.revision}/${artifact.file}`;
      try{run('curl.exe',['--fail','--location','--retry','2','--connect-timeout','10','--max-time','600','--silent','--show-error',url,'--output',partial]);}
      catch(error){if(artifact.url)throw error;run('curl.exe',['--fail','--location','--retry','2','--connect-timeout','10','--max-time','600','--silent','--show-error',url.replace('https://huggingface.co/','https://hf-mirror.com/'),'--output',partial]);}
      if(!verifyArtifact(partial,artifact))throw Error('MEDIA_ARTIFACT_HASH_MISMATCH');fs.renameSync(partial,file);
    }
    if(artifact.url&&download)run(python,['-m','pip','install','--no-index','--no-deps','--ignore-installed',file]);
  }
  if(dependencySite)fs.writeFileSync(path.join(directory,'venv/Lib/site-packages/local-dania-dependencies.pth'),dependencySite+'\n');
  const packages=cloud?['silk-python','av','imageio-ffmpeg']:['faster-whisper','silk-python','ctranslate2','av','tokenizers','huggingface-hub','onnxruntime'];
  const detected=JSON.parse(run(python,['-I','-c',`import sys,json,importlib.metadata as m,imageio_ffmpeg,pysilk,av${cloud?'':',faster_whisper'};assert sys.version_info[:2]==(3,12);print(json.dumps({'ffmpeg':imageio_ffmpeg.get_ffmpeg_exe(),'dependencies':{n:m.version(n) for n in ${JSON.stringify(packages)}}}))`]));
  if(!cloud&&detected.dependencies['faster-whisper']!=='1.2.1'||detected.dependencies['silk-python']!=='0.2.8'||detected.dependencies.av!=='15.1.0')throw Error('MEDIA_DEPENDENCY_VERSION_MISMATCH');
  const config={version:1,python,modelDirectory:previousDirectory??modelDirectory,ffmpeg:detected.ffmpeg};
  fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(config,null,2));
  const manifest=cloud?{mode:'cloud',wheels:artifacts}:{...catalog,wheels:LOCAL_MEDIA_ARTIFACTS.wheels};
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({version:1,...manifest,dependencies:detected.dependencies,dependencySite,verifiedAt:new Date().toISOString()},null,2));
  return cloud?{ready:true,localOnly:false,mode:'cloud',modelBytes:0}:{ready:true,localOnly:true,model:path.basename(modelDirectory),modelBytes:fs.statSync(path.join(modelDirectory,'model.bin')).size};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const at=process.argv.indexOf('--model');if(at!==-1&&!process.argv[at+1])throw Error('MEDIA_MODEL_UNSUPPORTED');console.log(JSON.stringify(prepareLocalMedia({download:process.argv.includes('--download'),modelName:at===-1?undefined:process.argv[at+1]})));}
  catch(error){console.log(JSON.stringify({ready:false,code:/^MEDIA_[A-Z_]+$/.test(error.message)?error.message:'MEDIA_PREPARE_FAILED'}));process.exitCode=1;}
}
