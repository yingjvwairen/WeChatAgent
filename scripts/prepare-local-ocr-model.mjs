import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// RapidOCR 3.10.0 default_models.yaml supplies the SHA; its v3.10.0 tag
// resolves to this immutable ModelScope repository revision.
export const LOCAL_OCR_MODEL=Object.freeze({
  file:'PP-OCRv6_rec_medium.onnx',size:76629984,
  sha256:'eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b',
  revision:'d298462ac20a2e994f433151b5fe6cc1180e9a09',
  url:'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/d298462ac20a2e994f433151b5fe6cc1180e9a09/onnx/PP-OCRv6/rec/PP-OCRv6_rec_medium.onnx',
});
const fault=code=>Object.assign(new Error(code),{code});

function localPath(file){
  if(!path.isAbsolute(file)||/^[\\/]{2}/.test(file)||/[\0\r\n]/.test(file))throw fault('OCR_MODEL_PATH_INVALID');
  for(let current=path.resolve(file);;current=path.dirname(current)){
    const stat=fs.lstatSync(current,{throwIfNoEntry:false});
    if(stat?.isSymbolicLink())throw fault('OCR_MODEL_LINK_REFUSED');
    if(current===path.dirname(current))break;
  }
  return path.resolve(file);
}

export async function verifyOcrModel(file,artifact=LOCAL_OCR_MODEL){
  localPath(file);
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!stat)return false;
  if(!stat.isFile())throw fault('OCR_MODEL_PATH_INVALID');
  if(stat.size!==artifact.size)return false;
  const digest=crypto.createHash('sha256');let bytes=0;
  for await(const chunk of fs.createReadStream(file)){
    bytes+=chunk.length;if(bytes>artifact.size)return false;
    digest.update(chunk);
  }
  return bytes===artifact.size&&digest.digest('hex')===artifact.sha256;
}

// Kept independent for offline tests of the bounded downloader. The deployment
// entry point below always supplies LOCAL_OCR_MODEL, never external metadata.
export async function downloadPinnedOcrModel(file,artifact,{fetchImpl=fetch,timeoutMs=600000}={}){
  localPath(file);
  const temporary=file+'.'+crypto.randomBytes(12).toString('hex')+'.partial';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  let handle;
  try{
    let url=new URL(artifact.url),response;
    for(let redirects=0;;redirects++){
      if(url.protocol!=='https:'||url.username||url.password)throw fault('OCR_MODEL_HTTPS_REQUIRED');
      response=await fetchImpl(url.href,{redirect:'manual',signal:controller.signal,headers:{'accept-encoding':'identity'}});
      if([301,302,303,307,308].includes(response.status)){
        await response.body?.cancel();
        const location=response.headers.get('location');
        if(!location||redirects>=4)throw fault('OCR_MODEL_REDIRECT_INVALID');
        url=new URL(location,url);continue;
      }
      if(response.status!==200||!response.body)throw fault('OCR_MODEL_DOWNLOAD_FAILED');
      break;
    }
    const length=response.headers.get('content-length');
    if(length!==null&&length!==String(artifact.size)){
      await response.body.cancel();throw fault('OCR_MODEL_SIZE_MISMATCH');
    }
    localPath(file);localPath(temporary);
    handle=await fs.promises.open(temporary,'wx',0o600);
    let bytes=0;const digest=crypto.createHash('sha256');
    for await(const chunk of response.body){
      bytes+=chunk.length;
      if(bytes>artifact.size)throw fault('OCR_MODEL_SIZE_MISMATCH');
      digest.update(chunk);await handle.writeFile(chunk);
    }
    if(bytes!==artifact.size)throw fault('OCR_MODEL_SIZE_MISMATCH');
    if(digest.digest('hex')!==artifact.sha256)throw fault('OCR_MODEL_HASH_MISMATCH');
    await handle.sync();await handle.close();handle=undefined;
    if(!await verifyOcrModel(temporary,artifact))throw fault('OCR_MODEL_HASH_MISMATCH');
    localPath(file);await fs.promises.rename(temporary,file);
  }catch(error){
    if(error.code?.startsWith('OCR_MODEL_'))throw error;
    throw fault(controller.signal.aborted?'OCR_MODEL_DOWNLOAD_TIMEOUT':'OCR_MODEL_DOWNLOAD_FAILED');
  }finally{
    clearTimeout(timer);controller.abort();
    await handle?.close().catch(()=>{});
    await fs.promises.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}

export async function prepareLocalOcrModel({projectRoot=root,download=false,fetchImpl=fetch}={}){
  const directory=localPath(path.join(localPath(projectRoot),'state/ocr/models'));
  const file=path.join(directory,LOCAL_OCR_MODEL.file);
  let downloaded=false;
  if(!await verifyOcrModel(file)){
    if(!download)throw fault('OCR_MODEL_UNVERIFIED');
    fs.mkdirSync(directory,{recursive:true});localPath(directory);
    await downloadPinnedOcrModel(file,LOCAL_OCR_MODEL,{fetchImpl});downloaded=true;
  }
  return {ready:true,model:'PP-OCRv6-medium',bytes:LOCAL_OCR_MODEL.size,sha256:LOCAL_OCR_MODEL.sha256,downloaded};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.slice(2).some(arg=>!['--download','--check'].includes(arg))||process.argv.includes('--download')&&process.argv.includes('--check'))throw fault('OCR_MODEL_OPTIONS_INVALID');
    console.log(JSON.stringify(await prepareLocalOcrModel({download:process.argv.includes('--download')})));
  }catch(error){console.log(JSON.stringify({ready:false,code:/^OCR_MODEL_[A-Z_]+$/.test(error.code)?error.code:'OCR_MODEL_PREPARE_FAILED'}));process.exitCode=1;}
}
