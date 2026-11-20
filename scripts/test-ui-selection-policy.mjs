// Offline regression cases only. This file does not start a Reader or UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readerAccountId} from './reader-account-state.mjs';
import {TargetSelectionStore} from './target-selection.mjs';
import {withUiSelection,verifyUiSelectionScope,assertUiSelectionCurrent} from '../packages/dsh-social-bridge-plugin/ui-selection-policy.mjs';
import {allowedConversation} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import {UiAsyncOrigins} from '../components/qq-bridge/src/core/ui-async-origins.js';
import {WechatOneBotAdapter,DURABLE_UI_PROTOCOL} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import {DshPluginClient} from '../components/qq-bridge/src/dsh/plugin-client.js';

const wire=value=>String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0)%2147483647n+1n));
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
async function fixture(t,group=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-selection-policy-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^ui-selection-policy-/);fs.rmSync(root,{recursive:true,force:true});});
  const current={dbPath:path.join(root,'fixture-self_a1b2'),myWxid:'fixture-self_a1b2'};
  fs.mkdirSync(path.join(current.dbPath,'db_storage'),{recursive:true});
  const accountRef=readerAccountId(root,current),target=group?'fixture-room@chatroom':'fixture-friend',key='wechat:'+(group?'group':'private')+':'+wire(target);
  write(path.join(root,'state/weflow/WeFlow-config.json'),current);
  write(path.join(root,'state/weflow/active-account.json'),{id:accountRef,legacyId:''});
  write(path.join(root,'state/reader/connection-request.json'),{schemaVersion:1,accountRef});
  fs.mkdirSync(path.join(root,'state/reader-service'),{recursive:true});
  const store=new TargetSelectionStore({root,accountRef,resolveTargets:async ids=>ids.map(wechatId=>({wechatId,id:wire(wechatId),name:'Fixture',alias:'',ambiguous:false,...(group?{kind:'group',groupName:'Fixture',uniqueSearchName:true}:{})}))});
  await store.replace({expectedVersion:store.get().version,targetWxids:[target]});
  const scope=store.grantIncoming({account:'fixture-self',target,eventId:'fixture-event',selectionVersion:store.get().version});
  return {root,current,accountRef,target,key,store,scope};
}
test('group grants authorize only the selected room and remain distinct from private and other rooms',async t=>{
  const f=await fixture(t,true),legacy={whitelist:{private:[],groups:[]}};
  assert.equal(verifyUiSelectionScope(f.root,f.scope,f.key),true);
  assert.equal(verifyUiSelectionScope(f.root,f.scope,'wechat:private:'+wire(f.target)),false);
  await withUiSelection(f.root,f.scope,f.key,async()=>{
    assert.equal(allowedConversation(legacy,f.key),true);
    assert.equal(allowedConversation(legacy,'wechat:group:'+wire('other@chatroom')),false);
    await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[]});
    assert.equal(allowedConversation(legacy,f.key),false);
  });
});
test('exact persisted scope adds only its selected stable identity; no context preserves Hook policy',async t=>{
  const f=await fixture(t),legacy={whitelist:{private:['123'],groups:[]}};
  assert.equal(allowedConversation(legacy,f.key),false);
  assert.equal(verifyUiSelectionScope(f.root,f.scope,f.key),true);
  await withUiSelection(f.root,f.scope,f.key,async()=>{
    assert.equal(allowedConversation(legacy,f.key),true);
    assert.equal(allowedConversation(legacy,'wechat:private:123'),false);
    assert.equal(withUiSelection(f.root,undefined,'wechat:private:123',()=>allowedConversation(legacy,'wechat:private:123')),true);
    await Promise.resolve();assertUiSelectionCurrent();
  });
  assert.equal(allowedConversation(legacy,f.key),false);
  assert.equal(verifyUiSelectionScope(f.root,{...f.scope,account:'another-self'},f.key),false);
  assert.equal(verifyUiSelectionScope(f.root,f.scope,'wechat:private:123'),false);
});
test('removal overrides stale legacy whitelist, re-add cannot renew old request, and reads never initialize',async t=>{
  const f=await fixture(t),legacy={whitelist:{private:[f.key.split(':')[2]],groups:[]}};
  await withUiSelection(f.root,f.scope,f.key,async()=>{
    await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[]});
    assert.equal(allowedConversation(legacy,f.key),false);
    assert.throws(assertUiSelectionCurrent,{code:'UI_SELECTION_SCOPE_REVOKED'});
  });
  await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[f.target]});
  assert.equal(verifyUiSelectionScope(f.root,f.scope,f.key),false);
  fs.unlinkSync(f.store.file);
  assert.equal(verifyUiSelectionScope(f.root,f.scope,f.key),false);
  assert.equal(fs.existsSync(f.store.file),false);
});
test('missing activation, changed account and stale marker with different configured directory all fail closed',async t=>{
  const f=await fixture(t),active=path.join(f.root,'state/weflow/active-account.json');
  fs.unlinkSync(active);assert.equal(verifyUiSelectionScope(f.root,f.scope,f.key),false);
  write(active,{id:'b'.repeat(64)});assert.equal(verifyUiSelectionScope(f.root,f.scope,f.key),false);
  write(active,{id:f.accountRef});
  const changed={dbPath:path.join(f.root,'another-self_a1b2'),myWxid:'another-self_a1b2'};
  fs.mkdirSync(path.join(changed.dbPath,'db_storage'),{recursive:true});
  write(path.join(f.root,'state/weflow/WeFlow-config.json'),changed);
  assert.equal(verifyUiSelectionScope(f.root,f.scope,f.key),false);
});
test('UI account barrier survives restart and Hook capability change; persistence failures block delivery',async t=>{
  const f=await fixture(t),origins=new UiAsyncOrigins({root:f.root});
  origins.assertAsyncAllowed('99');origins.remember('99');
  const restarted=new UiAsyncOrigins({root:f.root});
  assert.throws(()=>restarted.assertAsyncAllowed('99'),{code:'UI_ASYNC_UNSUPPORTED'});
  restarted.assertAsyncAllowed('100');
  const adapter=new WechatOneBotAdapter({onUiAccount:account=>restarted.remember(account)});
  adapter.server.emit('event',{post_type:'meta_event',self_id:99,wechatagent_capabilities:[DURABLE_UI_PROTOCOL]});
  adapter.server.emit('event',{post_type:'meta_event',self_id:99,wechatagent_capabilities:[]});
  assert.throws(()=>restarted.assertAsyncAllowed(adapter.selfId),{code:'UI_ASYNC_UNSUPPORTED'});
  const broken=new WechatOneBotAdapter({onUiAccount:()=>{throw Error('fixture durable failure');}});let calls=0;broken.server.call=async()=>{calls++;};
  broken.server.emit('event',{post_type:'meta_event',self_id:100,wechatagent_capabilities:[DURABLE_UI_PROTOCOL]});
  broken.server.emit('event',{post_type:'meta_event',self_id:100,wechatagent_capabilities:[]});
  await assert.rejects(broken.sendText({kind:'private',target:'123',text:'fixture'}),{code:'UI_ASYNC_ORIGIN_UNAVAILABLE'});
  assert.equal(calls,0);
});
test('DSH RPC carries scope privately, without placing it in message or local binding payload',async t=>{
  const f=await fixture(t),prior=globalThis.fetch;let body;
  globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({text:'RESPOND: fixture'}),{status:200});};
  t.after(()=>{globalThis.fetch=prior;});
  const client=new DshPluginClient({token:'offline-fixture'});
  const prompt='Untrusted fixture chat';
  await client.followup(f.key,prompt,{workMode:'social',localReplyBinding:{ui_selection_required:true,ui_reply_scope:f.scope}});
  assert.equal(body.message,prompt);assert.deepEqual(body.uiSelectionScope,f.scope);assert.equal(body.localReplyBinding,undefined);
  assert.equal(body.message.includes(f.scope.token),false);
});
