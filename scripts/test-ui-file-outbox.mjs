import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FileTransfers} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import {UiFileOutbox} from './ui-file-outbox.mjs';

async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uia-file-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'config'));
  const key='wechat:private:123',account='owner',target='friend',scope={account,target};
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({wechat:{workModes:{[key]:'assistant'},
    whitelist:{private:['123']},assistant:{administrators:[target],fileTransferChats:{[key]:true}}}}));
  fs.writeFileSync(path.join(root,'报告.pdf'),'%PDF-1.7\nfixture payload\n%%EOF');
  const store=new FileTransfers(root);
  await store.queue({key,sender:target,batchId:'a'.repeat(64),cwd:root,file:'报告.pdf',selectionScope:scope,signal:new AbortController().signal});
  const state={allowed:true,paused:false,body:null,pastes:0,submits:0,rows:[],releases:0};
  const driver={
    async observe(job){return{ready:true,draft:state.body?'attachment':'',editorToken:'editor',activityRevision:1,...(state.body?{appliedImageId:job.id}:{})};},
    async pasteImage(job,guard){assert.equal(guard.canInput(),true);assert.equal(fs.readFileSync(job.image.path,'utf8'),'%PDF-1.7\nfixture payload\n%%EOF');state.body=job;state.pastes++;return{performed:true,attempted:true};},
    async submitImage(job,guard){assert.equal(guard.canSubmit(),true);assert.equal(job.id,state.body.id);state.submits++;if(state.refuse)return{performed:false,attempted:false};if(state.drop)throw Error('lost response');return{performed:true,attempted:true};},
    async releaseTextFocus(){state.releases++;}
  };
  const options={root,account,store,driver,selectionStore:{accountRef:store.account(),authorizeReplyScope:s=>s.account===account&&s.target===target},
    checkAccess:()=>state.allowed,control:()=>({paused:state.paused}),signal:new AbortController().signal,inputAllowed:()=>true,
    prepare:async()=>({ready:true}),rows:async()=>state.rows};
  const file=store.list()[0],receipt={sourceShard:'b'.repeat(64),localId:'22',serverId:'532',createTime:Math.floor(Date.now()/1000),
    isSend:1,senderUsername:account,localType:49,fileKind:'appmsg-6',fileName:file.name,fileSize:file.size,fileMd5:file.md5};
  return {state,store,receipt,outbox:new UiFileOutbox(options),options,id:file.id};
}
test('staged PDF holds until a unique fresh file receipt; lost submit response and restart never paste again',async t=>{
  const {state,store,receipt,outbox,options,id}=await fixture(t);
  state.rows=[{...receipt,localId:'1'}];state.drop=true;
  await outbox.tick(outbox.next());assert.equal(store.read(id).fileDraftPossible,true);assert.equal(state.releases,1);
  const restarted=new UiFileOutbox(options);
  state.rows.push({...receipt,isSend:0},{...receipt,fileSize:1},{...receipt,fileMd5:'a'.repeat(32)});
  await restarted.tick(restarted.next());assert.notEqual(store.read(id).state,'confirmed');
  state.rows.push(receipt);await restarted.tick(restarted.next());
  assert.equal(store.read(id).state,'confirmed');assert.equal(store.read(id).receipt.serverId,'532');
  assert.equal(restarted.hasHold(),false);assert.equal(state.pastes,1);assert.equal(state.submits,1);
});
test('pause, scope revocation and staged file mutation stop input',async t=>{
  const f=await fixture(t);f.state.paused=true;await f.outbox.tick(f.outbox.next());assert.equal(f.store.read(f.id).state,'queued');
  f.state.paused=false;f.state.allowed=false;await f.outbox.tick(f.outbox.next());assert.equal(f.store.read(f.id).state,'cancelled');
  const g=await fixture(t);const file=g.store.staged(g.outbox.next());const bytes=fs.readFileSync(file);bytes[0]^=1;fs.writeFileSync(file,bytes);
  await g.outbox.tick(g.outbox.next());assert.equal(g.store.read(g.id).error,'FILE_STAGED_INVALID');assert.equal(f.state.pastes+g.state.pastes,0);
});
test('explicit submit refusal preserves draft hold without polling unrelated receipts',async t=>{
  const f=await fixture(t);f.state.refuse=true;await f.outbox.tick(f.outbox.next());
  assert.equal(f.store.read(f.id).error,'UI_FILE_SUBMIT_REFUSED');assert.equal(f.store.read(f.id).fileDraftPossible,true);
  assert.equal(f.outbox.next(),null);assert.equal(f.outbox.hasHold(),true);
});
test('ambiguous receipts cannot confirm',async t=>{
  const f=await fixture(t);await f.outbox.tick(f.outbox.next());
  f.state.rows=[f.receipt,{...f.receipt,localId:'23',serverId:'543'}];await f.outbox.tick(f.outbox.next());
  assert.equal(f.store.read(f.id).state,'unconfirmed');assert.equal(f.outbox.hasHold(),true);assert.equal(f.state.submits,1);
});
test('interrupted paste cannot consume a receipt or release a draft hold on restart',async t=>{
  const f=await fixture(t);f.options.driver.pasteImage=async()=>{throw Error('lost paste response');};
  await f.outbox.tick(f.outbox.next());f.state.rows=[f.receipt];
  const restarted=new UiFileOutbox(f.options);await restarted.tick(restarted.next());
  assert.equal(f.store.read(f.id).state,'failed');assert.equal(restarted.hasHold(),true);
  assert.equal(f.store.read(f.id).receipt,undefined);assert.equal(f.state.submits,0);
});
