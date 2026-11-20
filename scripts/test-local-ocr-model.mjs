import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {LOCAL_OCR_MODEL,verifyOcrModel,downloadPinnedOcrModel,prepareLocalOcrModel} from './prepare-local-ocr-model.mjs';

const payload=Buffer.from('fixed fixture model');
const artifact={file:'model.onnx',size:payload.length,sha256:crypto.createHash('sha256').update(payload).digest('hex'),url:'https://models.example/immutable/model.onnx'};
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ocr-model-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,file:path.join(directory,artifact.file)};}
const response=(bytes=payload,headers={})=>new Response(bytes,{status:200,headers});
const leaves=directory=>fs.readdirSync(directory);

test('medium model is pinned to an immutable official revision, exact size and runtime hash',()=>{
  assert.equal(LOCAL_OCR_MODEL.size,76629984);
  assert.match(LOCAL_OCR_MODEL.revision,/^[a-f0-9]{40}$/);
  assert.equal(LOCAL_OCR_MODEL.url,`https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/${LOCAL_OCR_MODEL.revision}/onnx/PP-OCRv6/rec/${LOCAL_OCR_MODEL.file}`);
  assert.equal(LOCAL_OCR_MODEL.sha256,'eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b');
  const runtime=fs.readFileSync(new URL('./local-ocr.py',import.meta.url),'utf8');
  assert.ok(runtime.includes(`"${LOCAL_OCR_MODEL.file}": "${LOCAL_OCR_MODEL.sha256}"`));
  const prepare=fs.readFileSync(new URL('./prepare-ui-components.ps1',import.meta.url),'utf8');
  assert.match(prepare,/prepare-local-ocr-model\.mjs'\) --download/);
  assert.match(prepare,/if \(\$LASTEXITCODE -ne 0\) \{ throw 'UI_OCR_MODEL_PREPARE_FAILED' \}/);
});

test('offline check rejects missing model without downloading or creating state',async t=>{
  const {directory}=fixture(t);
  await assert.rejects(prepareLocalOcrModel({projectRoot:directory,fetchImpl:()=>{throw Error('network must not run');}}),{code:'OCR_MODEL_UNVERIFIED'});
  assert.deepEqual(leaves(directory),[]);
});

test('verification requires exact size and hash and rejects nonfiles',async t=>{
  const {file}=fixture(t);assert.equal(await verifyOcrModel(file,artifact),false);
  fs.writeFileSync(file,payload);assert.equal(await verifyOcrModel(file,artifact),true);
  fs.writeFileSync(file,Buffer.alloc(payload.length));assert.equal(await verifyOcrModel(file,artifact),false);
  fs.writeFileSync(file,payload.subarray(1));assert.equal(await verifyOcrModel(file,artifact),false);
  fs.unlinkSync(file);fs.mkdirSync(file);await assert.rejects(verifyOcrModel(file,artifact),{code:'OCR_MODEL_PATH_INVALID'});
});

test('verified download is published only after exact bytes and hash pass',async t=>{
  const {directory,file}=fixture(t);fs.writeFileSync(file,'old model');
  await downloadPinnedOcrModel(file,artifact,{fetchImpl:async(url,options)=>{
    assert.equal(url,artifact.url);assert.equal(options.redirect,'manual');assert.equal(options.headers['accept-encoding'],'identity');
    assert.equal(fs.readFileSync(file,'utf8'),'old model');return response(payload,{'content-length':String(payload.length)});
  }});
  assert.equal(await verifyOcrModel(file,artifact),true);assert.deepEqual(leaves(directory),[artifact.file]);
});

test('truncated, oversized, header mismatch and corrupt downloads preserve existing file',async t=>{
  for(const [body,headers,code] of [
    [payload.subarray(1),{},'OCR_MODEL_SIZE_MISMATCH'],
    [Buffer.concat([payload,Buffer.from('x')]),{},'OCR_MODEL_SIZE_MISMATCH'],
    [payload,{'content-length':'1'},'OCR_MODEL_SIZE_MISMATCH'],
    [Buffer.alloc(payload.length),{},'OCR_MODEL_HASH_MISMATCH'],
  ]){
    const {directory,file}=fixture(t);fs.writeFileSync(file,'old model');
    await assert.rejects(downloadPinnedOcrModel(file,artifact,{fetchImpl:async()=>response(body,headers)}),{code});
    assert.equal(fs.readFileSync(file,'utf8'),'old model');assert.deepEqual(leaves(directory),[artifact.file]);
  }
});

test('stream byte limit stops unknown-length download and deletes its partial file',async t=>{
  const {directory,file}=fixture(t);let cancelled=false;
  const body=new ReadableStream({start(controller){controller.enqueue(payload);controller.enqueue(Buffer.from('extra'));},cancel(){cancelled=true;}});
  await assert.rejects(downloadPinnedOcrModel(file,artifact,{fetchImpl:async()=>new Response(body)}),{code:'OCR_MODEL_SIZE_MISMATCH'});
  assert.equal(cancelled,true);assert.deepEqual(leaves(directory),[]);
});

test('redirects require HTTPS without credentials and have a fixed hop limit',async t=>{
  const withCredentials=new URL('https://models.example/file');withCredentials.username='fixture';withCredentials.password='fixture';
  for(const location of ['http://models.example/file',withCredentials.href]){
    const {directory,file}=fixture(t);let calls=0;
    await assert.rejects(downloadPinnedOcrModel(file,artifact,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}}),{code:'OCR_MODEL_HTTPS_REQUIRED'});
    assert.equal(calls,1);assert.deepEqual(leaves(directory),[]);
  }
  const {file}=fixture(t);let calls=0;
  await assert.rejects(downloadPinnedOcrModel(file,artifact,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'/again'}});}}),{code:'OCR_MODEL_REDIRECT_INVALID'});
  assert.equal(calls,5);
});

test('secure relative redirect succeeds without relaxing verification',async t=>{
  const {file}=fixture(t);let calls=0;
  await downloadPinnedOcrModel(file,artifact,{fetchImpl:async url=>{
    if(calls++===0)return new Response(null,{status:302,headers:{location:'/storage/model'}});
    assert.equal(url,'https://models.example/storage/model');return response();
  }});
  assert.equal(await verifyOcrModel(file,artifact),true);
});

test('HTTP error and timeout fail closed without partial artifacts',async t=>{
  const {directory,file}=fixture(t);
  await assert.rejects(downloadPinnedOcrModel(file,artifact,{fetchImpl:async()=>new Response(null,{status:404})}),{code:'OCR_MODEL_DOWNLOAD_FAILED'});
  await assert.rejects(downloadPinnedOcrModel(file,artifact,{timeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}),{code:'OCR_MODEL_DOWNLOAD_TIMEOUT'});
  assert.deepEqual(leaves(directory),[]);
});

test('junction ancestor is refused before any file access or network download',async t=>{
  const {directory}=fixture(t),outside=fixture(t).directory,link=path.join(directory,'linked');
  fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(verifyOcrModel(path.join(link,'model.onnx'),artifact),{code:'OCR_MODEL_LINK_REFUSED'});
  await assert.rejects(downloadPinnedOcrModel(path.join(link,'model.onnx'),artifact,{fetchImpl:()=>{throw Error('network must not run');}}),{code:'OCR_MODEL_LINK_REFUSED'});
  assert.deepEqual(leaves(outside),[]);
});
