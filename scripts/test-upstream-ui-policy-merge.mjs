// Offline fixtures for v0.4.1 policy changes combined with humanized UI scopes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readerAccountId} from './reader-account-state.mjs';
import {TargetSelectionStore} from './target-selection.mjs';
import {withUiSelection,verifyUiSelectionScope} from '../packages/dsh-social-bridge-plugin/ui-selection-policy.mjs';
import {assistantSenderAllowed,assistantGroupChatAllowed} from '../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {AssistantTasks} from '../packages/dsh-social-bridge-plugin/assistant-tasks.mjs';
import {createAssistantControl} from '../packages/dsh-social-bridge-plugin/assistant-control.mjs';

const wire=value=>String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0)%2147483647n+1n));
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
const group='wechat:group:456',admin='fixture_admin',member='fixture_member';
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upstream-ui-policy-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^upstream-ui-policy-/);fs.rmSync(root,{recursive:true,force:true});});
  const current={dbPath:path.join(root,'fixture-self_a1b2'),myWxid:'fixture-self_a1b2'};
  fs.mkdirSync(path.join(current.dbPath,'db_storage'),{recursive:true});
  const accountRef=readerAccountId(root,current),target='fixture-friend',key='wechat:private:'+wire(target);
  write(path.join(root,'state/weflow/WeFlow-config.json'),current);
  write(path.join(root,'state/weflow/active-account.json'),{id:accountRef,legacyId:''});
  write(path.join(root,'state/reader/connection-request.json'),{schemaVersion:1,accountRef});
  fs.mkdirSync(path.join(root,'state/reader-service'),{recursive:true});
  const store=new TargetSelectionStore({root,accountRef,resolveTargets:async ids=>ids.map(wechatId=>({wechatId,id:wire(wechatId),name:'Fixture',alias:'',ambiguous:false}))});
  await store.replace({expectedVersion:store.get().version,targetWxids:[target]});
  const scope=store.grantIncoming({account:'fixture-self',target,eventId:'fixture-event',selectionVersion:store.get().version});
  const wechat={whitelist:{private:[],groups:['456']},workModes:{[key]:'assistant',[group]:'assistant'},assistant:{administrators:[admin],adminOnlyGroups:{[group]:false}}};
  return {root,target,key,store,scope,wechat};
}

test('UI selection grants its private target but preserves the new administrator-only execution rule',async t=>{
  const f=await fixture(t);
  assert.equal(assistantSenderAllowed(f.wechat,f.key,admin),false);
  withUiSelection(f.root,f.scope,f.key,()=>{
    assert.equal(assistantSenderAllowed(f.wechat,f.key,admin),true);
    assert.equal(assistantSenderAllowed(f.wechat,f.key,member),false);
    assert.equal(assistantSenderAllowed(f.wechat,f.key,''),false);
    // An allowed legacy group cannot inherit a private incoming-message grant.
    assert.equal(assistantSenderAllowed(f.wechat,group,admin),false);
    assert.equal(assistantGroupChatAllowed(f.wechat,group,member),false);
    assert.equal(assistantGroupChatAllowed(f.wechat,group,''),false);
  });
  assert.equal(assistantSenderAllowed(f.wechat,group,admin),true);
  assert.equal(assistantSenderAllowed(f.wechat,group,member),false);
  assert.equal(assistantGroupChatAllowed(f.wechat,group,member),true);
  assert.equal(assistantGroupChatAllowed(f.wechat,group,''),true);
});

test('revoking a selection overrides a legacy allowlist and re-adding cannot resurrect the old task scope',async t=>{
  const f=await fixture(t);f.wechat.whitelist.private.push(f.key.split(':')[2]);
  await withUiSelection(f.root,f.scope,f.key,async()=>{
    await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[]});
    assert.equal(assistantSenderAllowed(f.wechat,f.key,admin),false);
    assert.equal(assistantGroupChatAllowed(f.wechat,group,member),false);
  });
  await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[f.target]});
  assert.equal(verifyUiSelectionScope(f.root,f.scope,f.key),false);
  assert.throws(()=>withUiSelection(f.root,f.scope,f.key,()=>assistantSenderAllowed(f.wechat,f.key,admin)),{code:'UI_SELECTION_SCOPE_REVOKED'});
});

test('the merged durable task queue rechecks the original scope and never exposes its token in a public view',async t=>{
  const f=await fixture(t),seen=[];let executed=0;
  const tasks=new AssistantTasks({file:path.join(f.root,'tasks.json'),concurrency:0,execute:async()=>{executed++;},allowed:(key,sender,request)=>{
    seen.push(structuredClone(request));
    try{return withUiSelection(f.root,request?.uiSelectionScope,key,()=>assistantSenderAllowed(f.wechat,key,sender));}catch{return false;}
  }});
  try{
    const request={conversationKey:f.key,assistantSender:admin,batchId:'a'.repeat(64),message:'fixture',uiSelectionScope:structuredClone(f.scope)};
    const view=tasks.submit(request);request.uiSelectionScope.token='mutated-after-submit';
    assert.equal(JSON.stringify(view).includes(f.scope.token),false);
    assert.deepEqual(tasks.get(view.id).request.uiSelectionScope,f.scope);
    await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[]});
    tasks.concurrency=1;tasks.pump();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(tasks.get(view.id).state,'cancelled');assert.equal(executed,0);
    assert.deepEqual(seen.at(-1).uiSelectionScope,f.scope);
  }finally{tasks.close();}
});

test('old UI tasks remain unavailable to control requests after a remove-and-readd even with legacy authorization',async t=>{
  const f=await fixture(t);f.wechat.whitelist.private.push(f.key.split(':')[2]);
  write(path.join(f.root,'config/wechatagent.json'),{wechat:f.wechat});
  const tasks=new AssistantTasks({file:path.join(f.root,'tasks.json'),concurrency:0,execute:async()=>({}),allowed:()=>true});
  const task=tasks.submit({conversationKey:f.key,assistantSender:admin,batchId:'b'.repeat(64),message:'fixture',uiSelectionScope:f.scope});
  const control=createAssistantControl({ctx:{on:()=>()=>{}},root:f.root,tasks,accountReady:()=>true,sessionGroups:{},mappings:{},profiles:{},pending:new Map()});
  try{
    await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[]});
    await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[f.target]});
    await assert.rejects(control('status',{conversationKey:f.key,senderWxid:admin,taskId:task.id}),{code:'UI_SELECTION_SCOPE_REVOKED'});
    await assert.rejects(control('cancel',{conversationKey:f.key,localControl:true,taskId:task.id}),{code:'UI_SELECTION_SCOPE_REVOKED'});
  }finally{control.dispose();tasks.close();}
});
