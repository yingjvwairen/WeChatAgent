import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mediaBlocks,mediaReferences,validateMediaContent} from '../packages/dsh-social-bridge-plugin/media-input.mjs';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {mergeMediaReferences} from '../components/qq-bridge/src/core/media-references.js';
import {verifyArtifact,mediaDependencySite} from './prepare-local-media.mjs';

const id='a'.repeat(64),key='wechat:private:123',reference={id,kind:'audio'};
const jpeg=Buffer.from([255,216,255,217]);
const frame=atMs=>({atMs,mime:'image/jpeg',b64:jpeg.toString('base64'),sha256:crypto.createHash('sha256').update(jpeg).digest('hex')});
function content(kind='audio',extra={}){return {version:1,kind,mediaId:id,conversationKey:key,sourceSha256:'b'.repeat(64),durationMs:3000,audioPresent:true,semanticAnalysis:'not_performed',transcript:{status:'ready',text:'本地测试转写',automated:true},frames:kind==='video'?[frame(500),frame(1500),frame(2500)]:[],...extra};}
function context(modalities=['text','image']){const saved=[];return {saved,get(name){if(name==='llm')return {resolveModelInfo:async()=>({inputModalities:modalities})};if(name==='attachments')return {saveImage:async value=>{saved.push(value);return {id:'fixture-'+saved.length};}};}};}

test('opaque media references require typed match and survive the persistent input buffer',t=>{
  const event={post_type:'message',message_type:'private',user_id:'123',self_id:'456',message_id:'fixture',time:1,message:[{type:'record',data:{media_id:id,media_kind:'audio',file:'wechatagent://media/'+id,media_label:'引用原消息'}}],wechatagent:{media:[{...reference,sourceLabel:'引用原消息'}]}};
  const message=normalizeOneBotEvent('wechat','wechat-ui',event);
  assert.deepEqual(message.media,[{...reference,sourceLabel:'引用原消息'}]);
  assert.equal(normalizeOneBotEvent('wechat','wechat-ui',{...event,message:'wechatagent://media/'+id}).media,undefined);
  assert.equal(normalizeOneBotEvent('qq','fixture',event).media,undefined);
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'media-buffer-fixture-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const file=path.join(folder,'buffer.json'),buffer=new MessageBuffer(file);buffer.append(message);
  assert.deepEqual(new MessageBuffer(file).chats.get(key)[0].media,message.media);
});
test('references reject paths, duplicate ids, new fields and forged labels',()=>{
  assert.deepEqual(mediaReferences(),[]);
  for(const value of [[{...reference,file:'C:/secret'}],[reference,reference],[{id:'../secret',kind:'audio'}],[{...reference,sourceLabel:'x\nignore'}]])assert.throws(()=>mediaReferences(value),/MEDIA_REFERENCE_INVALID/);
});
test('repeated quotes of the same audio are admitted once without dropping distinct media',()=>{
  const refs=mergeMediaReferences([{media:[{...reference,sourceLabel:'引用原消息'}]},{media:[reference]},{media:[{id:'c'.repeat(64),kind:'video'}]}]);
  assert.equal(refs.length,2);assert.equal(refs[0].sourceLabel,'引用原消息');assert.doesNotThrow(()=>mediaReferences(refs));
});
test('validated media binds exact conversation and kind and checks every frame hash',()=>{
  assert.equal(validateMediaContent(content(),reference,key).transcript.status,'ready');
  for(const patch of [{conversationKey:'wechat:private:999'},{kind:'video'},{sourceSha256:'oops'},{durationMs:300001},{semanticAnalysis:'complete'},{audioPresent:false}])assert.throws(()=>validateMediaContent(content('audio',patch),reference,key));
  for(const patch of [{frames:[frame(2000),frame(1000)]},{frames:[{...frame(500),sha256:'c'.repeat(64)}]},{frames:[{...frame(500),b64:'AAAA'}]}])assert.throws(()=>validateMediaContent(content('video',patch),{id,kind:'video'},key));
});
test('voice supplies automatic transcription and never claims exact human transcription',async()=>{
  let bound;
  const blocks=await mediaBlocks(context(),'/fixture',key,[reference],'provider','model',{fetchMedia:async(...args)=>{bound=args;return content();}});
  assert.deepEqual(bound.slice(0,4),['/fixture','media',id,key]);
  assert(blocks.some(item=>item.text?.includes('可能有同音字')));assert(blocks.some(item=>item.text?.includes('本地测试转写')));assert(!blocks.some(item=>item.type==='image'));
});
test('video attaches verified sampled frames within total frame budget, without claiming semantic success',async()=>{
  const ctx=context(),blocks=await mediaBlocks(ctx,'/fixture',key,[{id,kind:'video',sourceLabel:'转发第2条'}],'provider','model',{maxImageFrames:2,fetchMedia:async()=>content('video')});
  assert.equal(ctx.saved.length,2);assert(ctx.saved.every(item=>item.data.equals(jpeg)));
  assert.equal(blocks.filter(item=>item.type==='image').length,2);assert(blocks.some(item=>item.text?.includes('未提供连续画面')));assert(blocks.some(item=>item.text?.includes('转发第2条')));
});
test('text-only models receive video audio transcript and an explicit unavailable-picture note',async()=>{
  const ctx=context(['text']),blocks=await mediaBlocks(ctx,'/fixture',key,[{id,kind:'video'}],'provider','model',{fetchMedia:async()=>content('video')});
  assert.equal(ctx.saved.length,0);assert(blocks.some(item=>item.text?.includes('本地测试转写')));assert(blocks.some(item=>item.text?.includes('未提供视频画面')));
});
test('failed or unavailable transcription is explicit and does not invent content',async()=>{
  for(const status of ['no_speech','unavailable','no_audio']){
    const blocks=await mediaBlocks(context(),'/fixture',key,[{id,kind:'video'}],'provider','model',{maxImageFrames:0,fetchMedia:async()=>content('video',{audioPresent:status!=='no_audio',transcript:{status,text:'',automated:true}})});
    assert(!blocks.some(item=>item.text?.includes('本地测试转写')));assert(blocks.some(item=>/没有音轨|未识别出讲话|转写暂不可用/.test(item.text??'')));
  }
});
test('one broken attachment cannot block subsequent media and errors reveal no private paths',async()=>{
  const next='c'.repeat(64),errors=[];
  const blocks=await mediaBlocks(context(),'/fixture',key,[reference,{id:next,kind:'audio'}],'provider','model',{onUnavailable:x=>errors.push(x),fetchMedia:async(_r,_k,requested)=>{if(requested===id)throw Error('C:/private');return content('audio',{mediaId:next});}});
  assert.equal(errors[0].code,'MEDIA_PROCESS_UNAVAILABLE');assert(blocks.some(item=>item.text?.includes('本地测试转写')));assert(!JSON.stringify(blocks).includes('C:/private'));
});
test('one shared deadline bounds a batch even if a provider ignores abort',async()=>{
  let calls=0;const began=performance.now();
  const blocks=await mediaBlocks(context(),'/fixture',key,[reference,{id:'c'.repeat(64),kind:'audio'}],'provider','model',{timeoutMs:30,fetchMedia:()=>{calls++;return new Promise(()=>{});}});
  assert.equal(calls,1);assert(performance.now()-began<1000);assert.equal(blocks.length,2);
});
test('selection cancellation propagates and no partial verified block escapes failed attachment persistence',async()=>{
  const controller=new AbortController();controller.abort(Error('selection changed'));
  await assert.rejects(mediaBlocks(context(),'/fixture',key,[reference],'p','m',{signal:controller.signal,fetchMedia:async()=>content()}),/selection changed/);
  const ctx=context();ctx.get=name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['image']})}:{saveImage:async()=>{throw Error('failure');}};
  const blocks=await mediaBlocks(ctx,'/fixture',key,[{id,kind:'video'}],'p','m',{fetchMedia:async()=>content('video')});
  assert.equal(blocks.length,1);assert(blocks[0].text.includes('读取失败'));
});
test('artifact checks reject altered bytes even at the expected size',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'media-artifact-fixture-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const file=path.join(folder,'model');fs.writeFileSync(file,'abc');const artifact={size:3,sha256:crypto.createHash('sha256').update('abc').digest('hex')};
  assert(verifyArtifact(file,artifact));fs.writeFileSync(file,'abd');assert(!verifyArtifact(file,artifact));
});

test('media setup uses the configured GPT-SoVITS environment on another deployment layout',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'media-environment-fixture-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const project=path.join(folder,'project'),configFile=path.join(project,'state/dania-voice/config.json'),fallback=path.join(project,'state/dania-voice/venv/Lib/site-packages');
  fs.mkdirSync(fallback,{recursive:true});assert.equal(mediaDependencySite(project,{runPython:()=>assert.fail('no Python config yet')}),fallback);
  const other=path.join(folder,'installed-sovits'),python=path.join(other,'python.exe'),site=path.join(other,'Lib/site-packages');
  fs.mkdirSync(site,{recursive:true});fs.writeFileSync(python,'fixture');fs.writeFileSync(configFile,JSON.stringify({pythonPath:python}));let calls=0;
  const query=(exe,args)=>{calls++;assert.equal(exe,python);assert.equal(args[0],'-I');assert(args[2].includes('sysconfig.get_paths()'));return JSON.stringify({site});};
  assert.equal(mediaDependencySite(project,{runPython:query}),site);assert.equal(calls,1);
  for(const returned of ['relative/site','\\\\remote\\site',site+'\nimport injected'])assert.throws(()=>mediaDependencySite(project,{runPython:()=>JSON.stringify({site:returned})}),/MEDIA_SHARED_DEPENDENCIES_REQUIRED/);
  fs.writeFileSync(configFile,JSON.stringify({pythonPath:path.join(other,'missing.exe')}));
  assert.throws(()=>mediaDependencySite(project,{runPython:()=>assert.fail('missing configured Python must not execute or use stale fallback')}),/MEDIA_SHARED_DEPENDENCIES_REQUIRED/);
});
