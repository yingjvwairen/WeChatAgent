import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {LocalOcrPool} from './local-ocr-client.mjs';

function fixture(options={}) {
  const children=[], requests=[];
  const spawnImpl=(executable,args,settings)=>{
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kills:0,ref(){},unref(){}});
    child.kill=()=>{child.kills++;queueMicrotask(()=>child.emit('exit',0));return true;};
    children.push(child);let buffer='';
    child.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;requests.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
    child.reply=packet=>child.stdout.write(JSON.stringify(packet)+'\n');
    queueMicrotask(()=>child.reply({version:1,ready:true,model:args.at(-1),runtime:'rapidocr-3.10.0/onnxruntime-1.31.0',modelsVerified:'pinned-sha256-v1',networkDisabled:true}));
    assert.equal(settings.windowsHide,true);assert.equal(settings.shell,false);
    assert.deepEqual(settings.stdio,['pipe','pipe','pipe']);assert.ok(args.includes('--worker'));assert.ok(args.includes('-I'));
    return child;
  };
  const pool=new LocalOcrPool({python:process.execPath,script:import.meta.filename,spawnImpl,...options});
  const request=(overrides={})=>pool.recognize({file:import.meta.filename,imageSha256:'a'.repeat(64),...overrides});
  return {pool,children,requests,request};
}

test('same fixed model reuses its process, sends bounded private requests and demultiplexes exact IDs',async t=>{
  const f=fixture();t.after(()=>f.pool.close());await f.pool.warm();
  const first=f.request();await delay(1);
  assert.equal(f.children.length,1);assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].imageSha256,'a'.repeat(64));assert.equal(f.requests[0].image,import.meta.filename);
  f.children[0].reply({version:1,id:f.requests[0].id,ok:true,result:{marker:1}});assert.deepEqual(await first,{marker:1});
  const second=f.request();await delay(1);assert.equal(f.children.length,1);
  f.children[0].reply({version:1,id:f.requests[1].id,ok:true,result:{marker:2}});assert.deepEqual(await second,{marker:2});
  f.pool.close();assert.equal(f.children[0].kills,1);
});

test('timeout kills the model process, rejects all pending requests and does not replay them',async t=>{
  const f=fixture();t.after(()=>f.pool.close());
  const first=f.request({timeoutMs:100}),second=f.request({timeoutMs:1000});
  await Promise.all([assert.rejects(first,{code:'VISUAL_PROBE_TIMEOUT'}),assert.rejects(second,{code:'VISUAL_PROBE_TIMEOUT'})]);
  assert.equal(f.children.length,1);assert.equal(f.children[0].kills,1);assert.equal(f.requests.length,2);
  await f.pool.warm();assert.equal(f.children.length,2);assert.equal(f.requests.length,2);
});

test('cancellation kills active inference, removes the process and retains no automatic retry',async t=>{
  const f=fixture();t.after(()=>f.pool.close());const abort=new AbortController();
  const active=f.request({signal:abort.signal});const rejected=assert.rejects(active,{code:'VISUAL_CANCELLED'});
  await delay(1);abort.abort();await rejected;
  assert.equal(f.children[0].kills,1);assert.equal(f.pool.workers.size,0);
  await assert.rejects(f.request({signal:abort.signal}),{code:'VISUAL_CANCELLED'});assert.equal(f.children.length,1);
});

test('unrequested response identity and oversized protocol output stop every pending read',async t=>{
  for(const oversized of [false,true]){
    const f=fixture();t.after(()=>f.pool.close());const active=f.request();const rejected=assert.rejects(active,{code:'VISUAL_WORKER_PROTOCOL_INVALID'});
    await delay(1);
    if(oversized)f.children[0].stdout.write('x'.repeat(1024*1024+1));
    else f.children[0].reply({version:1,id:'b'.repeat(32),ok:true,result:{}});
    await rejected;assert.equal(f.children[0].kills,1);
  }
});

test('idle release and owner exit close child processes without reading or writing a desktop',async()=>{
  const f=fixture({idleMs:15});await f.pool.warm();await delay(30);
  assert.equal(f.children[0].kills,1);assert.equal(f.pool.workers.size,0);
  await f.pool.warm({model:'medium'});assert.equal(f.children.length,2);
  f.pool.onExit();assert.equal(f.children[1].kills,1);assert.equal(f.pool.closed,true);
});

test('warmup cancellation is bounded and never leaves a ready worker',async t=>{
  const f=fixture();t.after(()=>f.pool.close());const controller=new AbortController();
  controller.abort();await assert.rejects(f.pool.warm({signal:controller.signal}),{code:'VISUAL_CANCELLED'});
  assert.equal(f.children.length,0);
});

test('preprocessing accepts only a fixed transform and binds the private response to the exact request',async t=>{
  const f=fixture();t.after(()=>f.pool.close());
  for(const preprocess of [null,'gray','gray-gamma-1.5',{gamma:1.6},true])await assert.rejects(f.request({preprocess}),{code:'VISUAL_PREPROCESS_INVALID'});
  assert.equal(f.children.length,0);
  const first=f.request({preprocess:'gray-gamma-1.6'});await delay(1);
  assert.equal(f.requests[0].preprocess,'gray-gamma-1.6');
  f.children[0].reply({version:1,id:f.requests[0].id,ok:true,result:{preprocess:'gray-gamma-1.6',marker:1}});
  assert.deepEqual(await first,{preprocess:'gray-gamma-1.6',marker:1});
  const second=f.request({preprocess:'gray-gamma-1.6'}),rejected=assert.rejects(second,{code:'VISUAL_PREPROCESS_RESULT_MISMATCH'});await delay(1);
  f.children[0].reply({version:1,id:f.requests[1].id,ok:true,result:{marker:2}});await rejected;assert.equal(f.children[0].kills,1);
});
