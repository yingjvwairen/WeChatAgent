import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UiImageReaderReceipts } from './ui-image-reader-receipts.mjs';

function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'image-receipts-fixture-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  let at=1700000000000;
  const state={rows:[],calls:0,patch:()=>{},delay:0,fail:false,queries:[]};
  const fetchImpl=async(input,init)=>{
    assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer fixture-token');
    const url=new URL(input);assert.equal(url.pathname,'/api/v1/image-receipts');assert.equal(url.hostname,'127.0.0.1');state.calls++;state.queries.push(url.search);
    if(state.delay)await new Promise(resolve=>setTimeout(resolve,state.delay));if(state.fail)throw Error('private service failure');
    const data={success:true,imageReceiptVersion:url.searchParams.get('kind')==='gif'?2:1,receiptBindingVersion:1,backend:'weflow-cli-nt',ownWxid:'fixture-self',accountDirectory:'fixture-account',messages:state.rows,
      scope:{version:1,complete:true,accountWxid:'fixture-self',accountDirectory:'fixture-account',talker:url.searchParams.get('talker'),fromTime:Number(url.searchParams.get('from_time')),throughTime:Math.floor(at/1000)}};
    state.patch(data);return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  };
  const config={directory,baseUrl:'http://127.0.0.1:19999',
    token:'fixture-token',accountWxid:'fixture-self',accountDirectory:'fixture-account',allowedTargets:['fixture-friend','fixture-room@chatroom'],fetchImpl,now:()=>at,...options};
  const reader=new UiImageReaderReceipts(config);
  const job={id:'a'.repeat(64),account:'fixture-self',target:'fixture-friend',sourceImageSha256:'b'.repeat(64),deadlineAt:at+20000};
  const row=(patch={})=>({sourceShard:'c'.repeat(64),localId:'10',serverId:'500',localType:3,createTime:Math.floor(at/1000),senderUsername:'fixture-self',isSend:1,...patch});
  return{directory,config,reader,job,row,state,now:()=>at,advance:ms=>at+=ms};
}
async function prepare(f){const prepared=await f.reader.prepare(f.job);assert.equal(prepared.submissionAllowed,true);f.reader.submitted(f.job,f.now());return prepared;}

test('image baseline and submit intent confirm one new row with explicit pixel-verification limits',async t=>{
  const f=fixture(t),prepared=await prepare(f);assert.match(prepared.preparationToken,/^[a-f0-9-]{36}$/);assert.equal(f.state.calls,1);
  f.state.rows=[f.row()];const result=await f.reader.query(f.job);assert.equal(f.state.calls,2);assert.equal(result.confirmed,true);
  assert.equal(result.receipt.type,'wechat-database-image-v1');assert.equal(result.receipt.sourceImageSha256,f.job.sourceImageSha256);
  assert.equal(result.receipt.nativeImageRowConfirmed,true);assert.equal(result.receipt.imageContentVerified,false);assert.equal(result.receipt.localType,3);
  const next=new UiImageReaderReceipts({...f.config,token:'new-session-token'});assert.deepEqual(await next.query(f.job),result);
  assert.equal((await next.prepare(f.job)).submissionAllowed,false);
  const saved=fs.readFileSync(path.join(f.reader.directory,f.job.id+'.json'),'utf8');assert.equal(saved.includes('fixture-token'),false);assert.equal(saved.includes('http:'),false);
});
test('missing submit marker or missing baseline never permits inference or a second preparation',async t=>{
  const f=fixture(t);assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_BASELINE_MISSING');
  assert.throws(()=>f.reader.submitted(f.job,f.now()),{code:'UI_IMAGE_RECEIPT_BASELINE_MISSING'});
  await f.reader.prepare(f.job);f.state.rows=[f.row()];assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_SUBMIT_TIME_MISSING');
  assert.equal((await new UiImageReaderReceipts(f.config).prepare(f.job)).submissionAllowed,false);
});
test('existing same-shard rows and existing server IDs remain excluded even when other identities change',async t=>{
  for(const patch of [{serverId:'501'},{localId:'11'},{sourceShard:'d'.repeat(64)}]){
    const f=fixture(t);f.state.rows=[f.row()];await prepare(f);f.state.rows=[f.row(patch)];assert.equal((await f.reader.query(f.job)).confirmed,false);
  }
});
test('a pending server ID can be confirmed later without reprepare or another input',async t=>{
  const f=fixture(t);await prepare(f);f.state.rows=[f.row({serverId:'0'})];assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_PENDING');
  f.advance(5000);f.state.rows=[f.row({createTime:1700000000})];assert.equal((await f.reader.query(f.job)).confirmed,true);assert.equal((await f.reader.prepare(f.job)).submissionAllowed,false);
});
test('DB visibility may lag the submit deadline but row createTime must remain inside it',async t=>{
  const f=fixture(t);await prepare(f);assert.equal((await f.reader.query(f.job)).confirmed,false);f.advance(25000);
  f.state.rows=[f.row({createTime:1700000001})];assert.equal((await f.reader.query(f.job)).confirmed,true);
  const later=fixture(t);await prepare(later);later.advance(25000);later.state.rows=[later.row()];assert.equal((await later.reader.query(later.job)).confirmed,false);
});
test('multiple new images stay durably ambiguous even if a later query no longer sees the competing row',async t=>{
  const f=fixture(t);await prepare(f);f.state.rows=[f.row(),f.row({localId:'11',serverId:'0'})];assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_AMBIGUOUS');
  const calls=f.state.calls;f.state.rows=[f.row()];const next=new UiImageReaderReceipts(f.config);assert.equal((await next.query(f.job)).reason,'UI_IMAGE_RECEIPT_AMBIGUOUS');assert.equal(f.state.calls,calls);
  assert.equal((await next.prepare(f.job)).submissionAllowed,false);
});
test('incoming, prefix-spoof and pre-submit image rows cannot confirm our send',async t=>{
  for(const patch of [{senderUsername:'fixture-self-extra'},{isSend:0},{createTime:1699999999}]){
    const f=fixture(t);await prepare(f);f.state.rows=[f.row(patch)];assert.equal((await f.reader.query(f.job)).confirmed,false);
  }
  const f=fixture(t);await f.reader.prepare(f.job);f.advance(2000);f.reader.submitted(f.job,f.now());f.state.rows=[f.row({createTime:1700000001})];assert.equal((await f.reader.query(f.job)).confirmed,false);
});
test('image endpoint rejects text, GIF, XML extensions, malformed identities and duplicated rows',async t=>{
  for(const patch of [{localType:1},{localType:47},{fullText:'private CDN credential'},{serverId:'-1'},{localId:10},{isSend:true}]){
    const f=fixture(t);await prepare(f);f.state.rows=[f.row(patch)];assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_ROW_INVALID');
  }
  const f=fixture(t);await prepare(f);f.state.rows=[f.row(),f.row()];assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_ROW_INVALID');
});
test('every response binds exact account, selected target, protocol and complete window',async t=>{
  for(const mutate of [data=>data.ownWxid='other',data=>data.accountDirectory='other',data=>delete data.receiptBindingVersion,data=>data.imageReceiptVersion=2,
    data=>data.scope.complete=false,data=>data.scope.talker='other',data=>data.scope.accountWxid='other',data=>data.scope.accountDirectory='other',data=>data.scope.fromTime++,data=>data.scope.throughTime+=5]){
    const f=fixture(t);await prepare(f);f.state.rows=[f.row()];f.state.patch=mutate;assert.equal((await f.reader.query(f.job)).confirmed,false);assert.equal((await f.reader.prepare(f.job)).submissionAllowed,false);
  }
});
test('group and private targets require an explicit local allowed set and intent hash never changes',async t=>{
  const f=fixture(t);f.job.target='fixture-room@chatroom';await prepare(f);f.state.rows=[f.row()];assert.equal((await f.reader.query(f.job)).confirmed,true);
  for(const patch of [{target:'unselected'},{account:'other'},{sourceImageSha256:'not-a-hash'}])await assert.rejects(f.reader.prepare({...f.job,...patch}),{code:'UI_IMAGE_RECEIPT_JOB_INVALID'});
  for(const patch of [{sourceImageSha256:'e'.repeat(64)},{deadlineAt:f.job.deadlineAt+1},{target:'fixture-friend'}])await assert.rejects(f.reader.prepare({...f.job,...patch}),{code:'UI_IMAGE_RECEIPT_BINDING_MISMATCH'});
  for(const allowedTargets of [[],['fixture-self'],['friend','friend']])assert.throws(()=>new UiImageReaderReceipts({...f.config,allowedTargets}),{code:'UI_IMAGE_RECEIPT_CONFIG_INVALID'});
});
test('submission marker is idempotent only at the same time and cannot be moved to match a later image',async t=>{
  const f=fixture(t);await f.reader.prepare(f.job);
  for(const at of [f.now()-1,f.now()+2,f.job.deadlineAt+1])assert.throws(()=>f.reader.submitted(f.job,at),{code:'UI_IMAGE_RECEIPT_SUBMISSION_TIME_INVALID'});
  f.reader.submitted(f.job,f.now());assert.equal(f.reader.submitted(f.job,f.now()).reused,true);f.advance(1000);
  assert.throws(()=>f.reader.submitted(f.job,f.now()),{code:'UI_IMAGE_RECEIPT_BINDING_MISMATCH'});
});
test('query expiry remains unknown across restart and does not allow retry',async t=>{
  const f=fixture(t);await prepare(f);f.advance(301000);assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_QUERY_EXPIRED');
  const next=new UiImageReaderReceipts(f.config);assert.equal((await next.query(f.job)).reason,'UI_IMAGE_RECEIPT_QUERY_EXPIRED');assert.equal((await next.prepare(f.job)).submissionAllowed,false);
});
test('timed out and aborted preparations cannot persist a late baseline; HTTP errors do not confirm',async t=>{
  const f=fixture(t,{timeoutMs:10});f.state.delay=30;await assert.rejects(f.reader.prepare(f.job),{code:'UI_IMAGE_RECEIPT_TIMEOUT'});
  await new Promise(resolve=>setTimeout(resolve,50));assert.deepEqual(fs.readdirSync(f.reader.directory),[]);
  f.state.delay=0;const controller=new AbortController();controller.abort();await assert.rejects(f.reader.prepare(f.job,{signal:controller.signal}),{code:'UI_IMAGE_RECEIPT_ABORTED'});
  await prepare(f);f.state.fail=true;assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_UNAVAILABLE');assert.equal((await f.reader.prepare(f.job)).submissionAllowed,false);
});
test('receipt storage validation rejects invented pixel equality and changed preparation metadata',async t=>{
  const f=fixture(t);await prepare(f);f.state.rows=[f.row()];await f.reader.query(f.job);
  const file=path.join(f.reader.directory,f.job.id+'.json'),value=JSON.parse(fs.readFileSync(file));value.receipt.imageContentVerified=true;fs.writeFileSync(file,JSON.stringify(value));
  assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_STATE_INVALID');
});
test('GIFs confirm only native sticker MD5 and preserve their evidence across restart',async t=>{
  for(const localType of [47,49,8*2**32+49]){
    const f=fixture(t);Object.assign(f.job,{imageFormat:'gif',sourceImageMd5:'d'.repeat(32)});await prepare(f);
    assert.match(f.state.queries[0],/&kind=gif$/);
    f.state.rows=[f.row({localType,contentMd5:f.job.sourceImageMd5})];
    const result=await f.reader.query(f.job);assert.equal(result.confirmed,true);
    assert.equal(result.receipt.type,'wechat-database-gif-v1');assert.equal(result.receipt.localType,localType);
    assert.equal(result.receipt.sourceImageMd5,f.job.sourceImageMd5);assert.equal(result.receipt.gifContentMd5Matched,true);
    assert.equal(result.receipt.imageContentVerified,false);assert.equal(result.receipt.nativeImageRowConfirmed,true);
    assert.deepEqual(await new UiImageReaderReceipts(f.config).query(f.job),result);
  }
});
test('GIFs reject flattened images, file attachments, missing hashes, XML and mismatched protocol',async t=>{
  for(const patch of [{localType:3},{localType:6*2**32+49},{contentMd5:undefined},{contentMd5:'D'.repeat(32)},{contentMd5:'bad'},{contentMd5:3},{fullText:'private fixture XML'}]){
    const f=fixture(t);Object.assign(f.job,{imageFormat:'gif',sourceImageMd5:'d'.repeat(32)});await prepare(f);
    f.state.rows=[f.row({localType:47,contentMd5:f.job.sourceImageMd5,...patch})];assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_ROW_INVALID');
  }
  const f=fixture(t);Object.assign(f.job,{imageFormat:'gif',sourceImageMd5:'d'.repeat(32)});await prepare(f);
  f.state.patch=data=>data.imageReceiptVersion=1;assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_ACCOUNT_MISMATCH');
});
test('only matching GIF content participates in confirmation or duplicate ambiguity',async t=>{
  const f=fixture(t);Object.assign(f.job,{imageFormat:'gif',sourceImageMd5:'d'.repeat(32)});await prepare(f);
  f.state.rows=[f.row({localType:47,contentMd5:'e'.repeat(32)})];assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_PENDING');
  f.state.rows.push(f.row({localType:47,contentMd5:f.job.sourceImageMd5,localId:'11',serverId:'501'}));assert.equal((await f.reader.query(f.job)).confirmed,true);
  const duplicate=fixture(t);Object.assign(duplicate.job,{imageFormat:'gif',sourceImageMd5:'d'.repeat(32)});await prepare(duplicate);
  duplicate.state.rows=[duplicate.row({localType:47,contentMd5:duplicate.job.sourceImageMd5}),duplicate.row({localType:49,contentMd5:duplicate.job.sourceImageMd5,localId:'11',serverId:'501'})];
  assert.equal((await duplicate.reader.query(duplicate.job)).reason,'UI_IMAGE_RECEIPT_AMBIGUOUS');
});
test('GIF intent cannot change MD5 or downgrade into an ordinary image after preparation',async t=>{
  const f=fixture(t);Object.assign(f.job,{imageFormat:'gif',sourceImageMd5:'d'.repeat(32)});await prepare(f);
  assert.equal((await f.reader.query({...f.job,sourceImageMd5:'e'.repeat(32)})).reason,'UI_IMAGE_RECEIPT_BINDING_MISMATCH');
  const {imageFormat,sourceImageMd5,...staticJob}=f.job;assert.equal((await f.reader.query(staticJob)).reason,'UI_IMAGE_RECEIPT_BINDING_MISMATCH');
  for(const patch of [{imageFormat:'gif',sourceImageMd5:undefined},{imageFormat:undefined,sourceImageMd5:'d'.repeat(32)},{imageFormat:'png'}]){
    await assert.rejects(f.reader.prepare({...f.job,...patch}),{code:'UI_IMAGE_RECEIPT_JOB_INVALID'});
  }
  f.state.rows=[f.row({localType:47,contentMd5:f.job.sourceImageMd5})];await f.reader.query(f.job);
  const file=path.join(f.reader.directory,f.job.id+'.json'),value=JSON.parse(fs.readFileSync(file));value.receipt.sourceImageMd5='e'.repeat(32);fs.writeFileSync(file,JSON.stringify(value));
  assert.equal((await f.reader.query(f.job)).reason,'UI_IMAGE_RECEIPT_STATE_INVALID');
});
test('image SQL and restricted HTTP fixtures execute with no live account',t=>{
  const python=path.resolve(import.meta.dirname,'../state/reader/venv/Scripts/python.exe');if(!fs.existsSync(python)){t.skip('Reader Python unavailable');return;}
  const result=spawnSync(python,['-I','-B',path.join(import.meta.dirname,'test-image-reader-receipts.py')],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stdout+result.stderr);
});
