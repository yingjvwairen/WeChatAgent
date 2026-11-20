import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UiReaderCursor,consumeReaderStream} from './ui-reader-stream.mjs';
import {UiOneBotConnection,UiOneBotBackend,uiOneBotId} from './ui-onebot.mjs';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
const epoch='a'.repeat(32),id=n=>epoch+':'+n;
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ui-stream-'));t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('ui-stream-'));fs.rmSync(directory,{recursive:true,force:true});});return {directory,journal:new UiReaderCursor({directory,account:'fixture',selectionVersion:1,initialCursor:id(0)})};}
const event={event:'message.new',type:1,isSend:false,sessionId:'filehelper',talkerId:'filehelper',content:'你好，世界',rawid:'fixture-message',timestamp:1};
function response(text){const bytes=Buffer.from(text),chunks=[...bytes].map(byte=>new Uint8Array([byte]));return new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}}),{headers:{'content-type':'text/event-stream'}});}
const frame=(n,payload=event)=>`id: ${id(n)}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
test('complete SSE records preserve UTF-8 and acknowledge only after durable consumer returns',async t=>{
  const f=fixture(t),seen=[];await consumeReaderStream({response:response(':ping\n\n'+frame(1)),journal:f.journal,dispatch:async(payload,cursor)=>{assert.equal(f.journal.read().cursor,id(0));assert.equal(f.journal.read().pending.cursor,cursor);seen.push(payload);}});
  assert.deepEqual(seen,[event]);assert.equal(f.journal.read().cursor,id(1));assert.equal(f.journal.read().pending,null);
});
test('failed intake retains pending record across restart and replays same id exactly once per attempt',async t=>{
  const f=fixture(t);await assert.rejects(consumeReaderStream({response:response(frame(1)),journal:f.journal,dispatch:async()=>{throw Error('fixture storage failure');}}));
  const restored=new UiReaderCursor({directory:f.directory,account:'fixture',selectionVersion:1,initialCursor:id(5)}),seen=[];
  await consumeReaderStream({response:response(frame(1)+frame(2,{...event,rawid:'second'})),journal:restored,dispatch:async(payload,cursor)=>seen.push(cursor)});
  assert.deepEqual(seen,[id(1),id(2)]);assert.equal(restored.read().cursor,id(2));
});
test('selection versions isolate cursors and expired/gapped or incomplete frames never advance',async t=>{
  const f=fixture(t);await assert.rejects(consumeReaderStream({response:response(frame(2)),journal:f.journal,dispatch:async()=>assert.fail('dispatch')}),{code:'UI_STREAM_CURSOR_GAP'});
  await assert.rejects(consumeReaderStream({response:response(frame(1).slice(0,-2)),journal:f.journal,dispatch:async()=>assert.fail('dispatch')}),{code:'UI_STREAM_TRUNCATED'});
  const other=new UiReaderCursor({directory:f.directory,account:'fixture',selectionVersion:2,initialCursor:'b'.repeat(32)+':0'});assert.notEqual(other.file,f.journal.file);assert.equal(f.journal.read().cursor,id(0));
});
test('abort interrupts a silent Reader without committing a cursor',async t=>{
  const f=fixture(t),controller=new AbortController();
  const work=consumeReaderStream({response:new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream'}}),journal:f.journal,dispatch:async()=>{},signal:controller.signal});
  controller.abort();await assert.rejects(work,{code:'UI_STREAM_CANCELLED'});assert.equal(f.journal.read().cursor,id(0));
});
test('real loopback WebSocket confirms intake only after callback persistence, retries keep raw id',async t=>{
  const f=fixture(t),accepted=[];let release;
  const wait=new Promise(resolve=>release=resolve);
  const adapter=new WechatOneBotAdapter({server:{host:'127.0.0.1',port:0,path:'/ws',timeoutMs:1000},acceptUiMessage:async message=>{accepted.push(message.message_id);await wait;return true;}});adapter.on('error',()=>{});await adapter.start();
  const backend=new UiOneBotBackend({directory:path.join(f.directory,'outbox'),policy:{accountWxid:'fixture',targets:[{kind:'private',id:uiOneBotId('filehelper'),wxid:'filehelper'}]},driver:{observe:async()=>({ready:false}),typeGrapheme:async()=>{},submit:async()=>{},receipt:async()=>({confirmed:false}),close(){}}});
  const connection=new UiOneBotConnection({backend,url:`ws://127.0.0.1:${adapter.server.server.address().port}/ws`});t.after(async()=>{connection.stop();await adapter.stop();});await connection.start();
  let done=false;const pending=connection.sendIncomingDurable(event,id(1)).then(()=>done=true);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(done,false);release();await pending;
  await connection.sendIncomingDurable(event,id(1));assert.deepEqual(accepted,['fixture-message','fixture-message']);
});
