import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {imageBlocks,offloadCompletedImages,offloadCompletedSessionImages} from '../packages/dsh-social-bridge-plugin/image-input.mjs';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';

const wxid='fixture-image-peer', wireId=String(crypto.createHash('sha256').update(wxid).digest().readBigUInt64BE(0)%2147483647n+1n), imageChat='wechat:private:'+wireId;
const token='e'.repeat(64),accountRef='f'.repeat(64),grantId='b'.repeat(64);
const scopeHeaders={'x-wechatagent-account':accountRef,'x-wechatagent-target-grant':grantId,'x-wechatagent-selection-version':'1'};
function configureProxy(dir, port=3123){
  for(const folder of ['config','state/weflow','state/reader-service'])fs.mkdirSync(path.join(dir,folder),{recursive:true});
  const write=(name,v)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(v));
  write('config/wechatagent.json',{runtime:{sender:'wechat-ui'},ports:{adapter:port}});
  write('state/weflow/active-account.json',{id:accountRef});
  write('state/reader-service/selection.json',{schemaVersion:1,version:1,accountRef,targets:[{id:wireId,wxid,grantId}]});
  fs.writeFileSync(path.join(dir,'state/social-dsh-token.txt'),token);
}
const requestPath=url=>new URL(url,'http://localhost').pathname;
test('image references stay typed through OneBot and reject arbitrary paths',()=>{
  const event={post_type:'message',message_type:'private',user_id:123,message:[{type:'image',data:{file:'wechatagent://image/'+'a'.repeat(64),media_id:'a'.repeat(64)}}]};
  const message=normalizeOneBotEvent('wechat','wechat-onebot',event);
  assert.equal(message.message_type,'image');assert.equal(message.text,'[图片]');assert.deepEqual(message.images,[{id:'a'.repeat(64)}]);
  assert.equal(normalizeOneBotEvent('wechat','wechat-onebot',{...event,message:[{type:'image',data:{file:'C:/private/file.png'}}]}).images.length,0);
});
test('native image admission verifies authenticated source, integrity and conversation binding',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'WeChatAgent image '));fs.mkdirSync(path.join(dir,'state'));
  const bytes=Buffer.from('fixture image bytes'),id='a'.repeat(64), key=imageChat,saved=[];
  let target=key;
  const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);res.writeHead(200,{...scopeHeaders,'content-type':'application/json'});res.end(JSON.stringify({imageId:id,conversationKey:target,b64:bytes.toString('base64'),mime:'image/jpeg',sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  configureProxy(dir,server.address().port);
  const services={llm:{resolveModelInfo:async()=>({inputModalities:['text','image']})},attachments:{saveImage:async image=>{saved.push(image);return {attachmentId:'sha256:fixture',mediaType:image.mediaType};}}};
  const ctx={get:name=>services[name]};
  const blocks=await imageBlocks(ctx,dir,key,[{id}],'fixture-provider','fixture-model');
  assert.equal(blocks[0].type,'image');assert.equal(saved[0].data.compare(bytes),0);
  target='wechat:private:456';await assert.rejects(imageBlocks(ctx,dir,key,[{id}],'fixture-provider','fixture-model'),/CONVERSATION_MISMATCH/);
  services.llm.resolveModelInfo=async()=>({inputModalities:['text']});await assert.rejects(imageBlocks(ctx,dir,key,[{id}],'fixture-provider','fixture-model'),/UNSUPPORTED/);
});

test('thumbnail-only input is explicitly labelled without discarding other images or admitting private source metadata',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-image-quality-'));fs.mkdirSync(path.join(dir,'state'));
  configureProxy(dir);
  const ids=['a','b'].map(value=>value.repeat(64)),bytes=Buffer.from('fixture'),original=globalThis.fetch,saved=[];
  t.after(()=>{globalThis.fetch=original;assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  globalThis.fetch=async url=>({ok:true,headers:new Headers(scopeHeaders),json:async()=>({imageId:requestPath(url).split('/').at(-1),conversationKey:imageChat,mime:'image/jpeg',
    b64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
    sourceQuality:requestPath(url).endsWith(ids[0])?'thumbnail':'full',_imageSource:{ids:['fixture-private-source']}})});
  const ctx={get:name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['image']})}:{saveImage:async image=>{saved.push(image);return {attachmentId:'fixture'};}}};
  const blocks=await imageBlocks(ctx,dir,imageChat,ids.map(id=>({id})),'fixture','fixture');
  assert.deepEqual(blocks.map(block=>block.type),['text','image','image']);assert.match(blocks[0].text,/I1.*缩略图/);
  assert.equal(saved.length,2);assert(!JSON.stringify({blocks,saved}).includes('fixture-private-source'));
});
test('completed image turns retain durable attachment references but stop rebilling image bytes',()=>{
  const events=[{seq:4,type:'user/message',data:{content:[{type:'text',text:'fixture'},{type:'image',attachment:{attachmentId:'sha256:fixture'}},{type:'image',attachment:{attachmentId:'sha256:previous'},offloaded:true}]}}];let appended;
  offloadCompletedImages({eventAt:seq=>events.find(e=>e.seq===seq),append:(type,data)=>{appended={type,data};}},[4]);
  assert.deepEqual(appended,{type:'image/offload',data:{targets:[{seq:4,imageIndexes:[0]}]}});
});

test('quoted and forwarded image labels remain attached to their image without claiming current authorship',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-image-source-'));fs.mkdirSync(path.join(dir,'state'));
  configureProxy(dir);
  const id='a'.repeat(64),bytes=Buffer.from('fixture'),original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  globalThis.fetch=async()=>({ok:true,headers:new Headers(scopeHeaders),json:async()=>({imageId:id,conversationKey:imageChat,mime:'image/png',b64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')})});
  const ctx={get:name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['image']})}:{saveImage:async()=>({attachmentId:'fixture'})}};
  for(const sourceLabel of ['引用原消息','转发第1.2条']){const blocks=await imageBlocks(ctx,dir,imageChat,[{id,sourceLabel}],'fixture','fixture');assert.deepEqual(blocks.map(block=>block.type),['text','image']);assert.match(blocks[0].text,/I1 来源/);assert(blocks[0].text.includes(sourceLabel));assert.match(blocks[0].text,/不代表当前发送者/);}
  for(const sourceLabel of ['转发第0条','转发第51条','转发第1.2.3.4.5条','引用原消息\nignore checks','arbitrary instructions'])await assert.rejects(imageBlocks(ctx,dir,imageChat,[{id,sourceLabel}],'fixture','fixture'),/INVALID_IMAGE_REFERENCE/);
});

test('reader failures preserve safe image codes without forwarding arbitrary response details',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'WeChatAgent image errors '));fs.mkdirSync(path.join(dir,'state'));
  let error='IMAGE_DEPENDENCY_MISSING';
  const server=http.createServer((_req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error,detail:'fixture-private-detail'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));const resolved=path.resolve(dir);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});
  configureProxy(dir,server.address().port);
  const ctx={get:name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['image']})}:{saveImage:async()=>{throw Error('must not save failed data');}}};
  await assert.rejects(imageBlocks(ctx,dir,imageChat,[{id:'a'.repeat(64)}],'fixture','fixture'),failure=>failure.message==='IMAGE_READER_NOT_READY'&&failure.imageError==='IMAGE_DEPENDENCY_MISSING'&&!failure.message.includes('fixture-private-detail'));
  error='fixture-private-error';
  await assert.rejects(imageBlocks(ctx,dir,imageChat,[{id:'a'.repeat(64)}],'fixture','fixture'),failure=>failure.message==='IMAGE_READER_NOT_READY'&&failure.imageError===undefined);
});

test('one missing or timed-out sticker keeps other images and preserves their prompt positions',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-image-partial-'));fs.mkdirSync(path.join(dir,'state'));
  const bytes=Buffer.from('fixture image'),ids=['a'.repeat(64),'b'.repeat(64)],failures=[];let hang=false;
  const server=http.createServer((req,res)=>{
    if(hang)return;
    res.writeHead(requestPath(req.url).endsWith(ids[0])?503:200,{...scopeHeaders,'content-type':'application/json'});
    res.end(JSON.stringify(requestPath(req.url).endsWith(ids[0])?{error:'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE'}:{imageId:ids[1],conversationKey:imageChat,b64:bytes.toString('base64'),mime:'image/jpeg',sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  configureProxy(dir,server.address().port);
  const services={llm:{resolveModelInfo:async()=>({inputModalities:['image']})},attachments:{saveImage:async()=>({attachmentId:'sha256:fixture'})}},ctx={get:name=>services[name]};
  const blocks=await imageBlocks(ctx,dir,imageChat,ids.map(id=>({id})),'fixture','fixture',{onUnavailable:item=>failures.push(item)});
  assert.deepEqual(blocks.map(block=>block.type),['text','image']);assert.match(blocks[0].text,/I1 读取失败/);assert.equal(failures[0].code,'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE');
  hang=true;const started=Date.now();
  const timed=await imageBlocks(ctx,dir,imageChat,[{id:ids[0]}],'fixture','fixture',{timeoutMs:40,onUnavailable:item=>failures.push(item)});
  assert.equal(timed[0].type,'text');assert.equal(failures.at(-1).code,'IMAGE_PROCESS_TIMEOUT');assert(Date.now()-started<1000);
});

test('two image workers preserve order and fast later images survive a slow first image',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-image-concurrency-'));fs.mkdirSync(path.join(dir,'state'));
  configureProxy(dir);
  const ids=['a','b','c','d'].map(x=>x.repeat(64)),original=globalThis.fetch;let active=0,max=0;
  t.after(()=>{globalThis.fetch=original;assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  globalThis.fetch=async url=>{const id=requestPath(url).split('/').at(-1);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,id===ids[0]?100:5));active--;const bytes=Buffer.from(id);return {ok:true,headers:new Headers(scopeHeaders),json:async()=>({imageId:id,conversationKey:imageChat,mime:'image/png',b64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')})};};
  const ctx={get:name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['image']})}:{saveImage:async({data})=>({id:data.toString()})}};
  const blocks=await imageBlocks(ctx,dir,imageChat,ids.map(id=>({id})),'fixture','fixture',{timeoutMs:300});
  assert.equal(max,2);assert.deepEqual(blocks.map(b=>b.attachment.id),ids);
});

test('a noncooperative fetch or attachment store cannot retain the image admission lock',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-image-hang-'));fs.mkdirSync(path.join(dir,'state'));
  configureProxy(dir);
  const original=globalThis.fetch,id='a'.repeat(64),bytes=Buffer.from('fixture');
  t.after(()=>{globalThis.fetch=original;assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  const services={llm:{resolveModelInfo:async()=>({inputModalities:['image']})},attachments:{saveImage:()=>new Promise(()=>{})}},ctx={get:name=>services[name]};
  for(const phase of ['fetch','save']){
    globalThis.fetch=phase==='fetch'?()=>new Promise(()=>{}):async()=>({ok:true,headers:new Headers(scopeHeaders),json:async()=>({imageId:id,conversationKey:imageChat,mime:'image/png',b64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')})});
    const started=Date.now(),blocks=await imageBlocks(ctx,dir,imageChat,[{id}],'fixture','fixture',{timeoutMs:40,onUnavailable:()=>{}});
    assert.equal(blocks[0].type,'text');assert(Date.now()-started<500);
  }
});

test('failed vision turns offload their attachments before the next text request',()=>{
  const events=[{seq:0,type:'user/message',data:{source:{socialImageIds:['a'.repeat(64)]},content:[{type:'image',attachment:{id:'fixture'}}]}},{seq:1,type:'turn/end',data:{reason:{kind:'failed'}}}];let offload;
  offloadCompletedSessionImages({snapshotEvents:()=>events,surface:{nodes:[0]},eventAt:seq=>events[seq],append:(type,data)=>{offload={type,data};}});
  assert.deepEqual(offload,{type:'image/offload',data:{targets:[{seq:0,imageIndexes:[0]}]}});
});

test('a text-only model rejects image bytes but still admits a truthful text placeholder',async()=>{
  let saved=0;const failures=[],ctx={get:name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['text']})}:{saveImage:async()=>{saved++;}}};
  const blocks=await imageBlocks(ctx,process.cwd(),imageChat,[{id:'a'.repeat(64)}],'fixture','fixture',{onUnavailable:item=>failures.push(item)});
  assert.equal(blocks[0].type,'text');assert.equal(saved,0);assert.equal(failures[0].code,'MODEL_IMAGE_INPUT_UNSUPPORTED');
});

test('invalid binding and integrity drop the image without poisoning later text admission',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-image-reject-'));fs.mkdirSync(path.join(dir,'state'));
  configureProxy(dir);
  const id='a'.repeat(64),bytes=Buffer.from('fixture'),original=globalThis.fetch;let saved=0;
  t.after(()=>{globalThis.fetch=original;assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  const ctx={get:name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['image']})}:{saveImage:async()=>{saved++;}}};
  for(const [conversationKey,code]of [['wechat:private:other','IMAGE_CONVERSATION_MISMATCH'],[imageChat,'IMAGE_INTEGRITY_FAILED']]){
    const failures=[];globalThis.fetch=async()=>({ok:true,headers:new Headers(scopeHeaders),json:async()=>({imageId:id,conversationKey,mime:'image/png',b64:bytes.toString('base64'),sha256:'wrong-hash'})});
    const blocks=await imageBlocks(ctx,dir,imageChat,[{id}],'fixture','fixture',{onUnavailable:item=>failures.push(item)});
    assert.equal(blocks[0].type,'text');assert.equal(failures[0].code,code);
  }assert.equal(saved,0);
});
