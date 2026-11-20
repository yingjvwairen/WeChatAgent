import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createConsole} from './console-server.mjs';
import {TargetSelectionStore} from './target-selection.mjs';
import {readerAccountId} from './reader-account-state.mjs';
import {selectedWechat} from '../packages/dsh-social-bridge-plugin/ui-selection-policy.mjs';
import {readWorkMode} from '../packages/dsh-social-bridge-plugin/work-modes.mjs';
import {readDshAccess} from '../packages/dsh-social-bridge-plugin/dsh-access.mjs';
import {readHistoryPolicy} from '../packages/dsh-social-bridge-plugin/history-policy.mjs';
import {localSearchPolicy} from '../packages/dsh-social-bridge-plugin/model-search.mjs';
import {PolicySnapshots} from '../packages/extension-runtime/snapshots.mjs';
import {allowedChat} from '../packages/extension-runtime/catalog.mjs';
import {chatSettingsSnapshot} from '../public/console/conversation-settings.mjs';

const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
const wire=value=>String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0)%2147483647n+1n));
async function fixture(t,{mixed=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-chat-management-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  fs.mkdirSync(path.join(root,'fixture-account/db_storage'),{recursive:true});
  const account={dbPath:path.join(root,'fixture-account/db_storage'),myWxid:'fixture-self'};
  const accountRef=readerAccountId(root,account);
  write(path.join(root,'state/weflow/WeFlow-config.json'),account);
  write(path.join(root,'state/weflow/active-account.json'),{id:accountRef});
  write(path.join(root,'state/reader/connection-request.json'),{schemaVersion:1,accountRef});
  fs.mkdirSync(path.join(root,'state/reader-service'),{recursive:true});
  const contact={wechatId:'fixture-group@chatroom',id:wire('fixture-group@chatroom'),name:'测试群',alias:'',ambiguous:false,kind:'group',groupName:'测试群',uniqueSearchName:true};
  const contacts=[contact,...(mixed?['fixture-friend-a','fixture-friend-b'].map(wechatId=>({wechatId,id:wire(wechatId),name:wechatId,alias:'',ambiguous:false,kind:'private'})):[])];
  const store=new TargetSelectionStore({root,accountRef,resolveTargets:async targetWxids=>contacts.filter(row=>targetWxids.includes(row.wechatId))});
  await store.replace({expectedVersion:store.get().version,targetWxids:contacts.map(row=>row.wechatId)});
  config.wechat.whitelist={private:[],groups:[]};
  write(path.join(root,'config/wechatagent.json'),config);
  fs.mkdirSync(path.join(root,'roles'),{recursive:true});
  fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'测试人格');
  const key='wechat:group:'+contact.id;
  const view=()=>{const saved=store.get();return {accountRef,version:saved.version,targets:saved.targets.map(({grantId,...row})=>row)};};
  return{root,config,store,key,contact,contacts,view};
}

test('selected chats govern policy without creating a second persisted allowlist',async t=>{
  const f=await fixture(t);
  f.config.wechat.workModes={[f.key]:'assistant'};
  f.config.wechat.dshAccess={chats:{[f.key]:{skills:['fixture-skill'],tools:['read_file']}}};
  f.config.wechat.search={enabled:true};
  write(path.join(f.root,'config/wechatagent.json'),f.config);
  assert.deepEqual(selectedWechat(f.root,f.config.wechat).whitelist,{private:[],groups:[f.contact.id]});
  assert.equal(readWorkMode(f.root,f.key),'assistant');
  assert.deepEqual(readDshAccess(f.root,f.key).tools,['read_file']);
  assert.equal(readHistoryPolicy(f.root,f.key).enabled,true);
  assert.equal(localSearchPolicy(f.root,f.key).enabled,true);
  assert.equal(allowedChat(f.root,f.key),true);
  const policy=new PolicySnapshots(f.root);policy.refresh();assert.equal(policy.permits(f.key),true);
  const epoch=policy.epoch;
  await f.store.replace({expectedVersion:f.store.get().version,targetWxids:[]});
  assert.equal(readWorkMode(f.root,f.key),'social');
  assert.deepEqual(readDshAccess(f.root,f.key).tools,[]);
  assert.equal(readHistoryPolicy(f.root,f.key).enabled,false);
  assert.equal(localSearchPolicy(f.root,f.key),null);
  assert.equal(allowedChat(f.root,f.key),false);
  policy.refresh();assert.equal(policy.permits(f.key),false);assert(policy.epoch>epoch);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json'))).wechat.whitelist,{private:[],groups:[]});
});

test('an unavailable or different-account selection never falls back to a stale allowlist',async t=>{
  const f=await fixture(t);
  const legacy={...f.config.wechat,whitelist:{private:[],groups:[f.contact.id]}};
  write(path.join(f.root,'state/weflow/active-account.json'),{id:'f'.repeat(64)});
  assert.deepEqual(selectedWechat(f.root,legacy).whitelist,{private:[],groups:[]});
  write(path.join(f.root,'state/weflow/active-account.json'),{id:f.view().accountRef});
  fs.writeFileSync(path.join(f.root,'state/reader-service/selection.json'),'{');
  assert.deepEqual(selectedWechat(f.root,legacy).whitelist,{private:[],groups:[]});
});

test('chat APIs use the selected roster and per-chat settings survive console restart',async t=>{
  const f=await fixture(t),calls=[];
  const botControls={targets:async()=>f.view(),snapshot:async()=>({targets:f.view()}),replaceTargets:async body=>{
    calls.push(body);
    assert.equal(body.accountRef,f.view().accountRef);
    const saved=await f.store.replace(body);return {...f.view(),version:saved.version};
  }};
  async function serve(){
    const app=createConsole({root:f.root,port:0,botControls,fetchImpl:async()=>{throw Error('DSH fixture offline');}});
    const {port}=await app.start(),base='http://127.0.0.1:'+port;
    const {token}=await fetch(base+'/api/info').then(r=>r.json());
    const request=async(route,body)=>{
      const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':token,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
      return{status:response.status,value:await response.json()};
    };
    const close=async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));};
    t.after(close);return {request,close};
  }
  const first=await serve();
  const initial=await first.request('/api/chats');
  assert.equal(initial.value.chats[0].key,f.key);
  assert.equal(initial.value.chats[0].name,'测试群');
  assert.deepEqual(initial.value.targets,f.view());
  assert.doesNotMatch(JSON.stringify(initial.value),/grantId/);
  const before=(await first.request('/api/config')).value;
  const settings=chatSettingsSnapshot(before.config,f.key);
  settings.settings.workMode='assistant';settings.access={skills:['fixture-skill'],tools:['read_file']};
  const saved=await first.request('/api/chat-settings',{revision:before.revision,key:f.key,...settings});
  assert.equal(saved.status,200,JSON.stringify(saved.value));
  assert.equal(saved.value.workModeChanged,true);
  assert.deepEqual(saved.value.config.wechat.whitelist,{private:[],groups:[]});
  assert.equal(readWorkMode(f.root,f.key),'assistant');
  await first.close();
  const second=await serve();
  assert.equal((await second.request('/api/config')).value.config.wechat.workModes[f.key],'assistant');
  const roster=(await second.request('/api/chat-targets')).value;
  assert.equal(roster.targets.length,1);
  assert.equal((await second.request('/api/chat-targets',{accountRef:roster.accountRef,expectedVersion:roster.version,targetWxids:[]})).status,200);
  assert.equal((await second.request('/api/chat-targets')).value.targets.length,0);
  const revision=(await second.request('/api/config')).value.revision;
  assert.equal((await second.request('/api/chat-settings',{revision,key:f.key,...settings})).status,400);
  assert.equal(calls.length,1);
});

test('built-in extension saves use the current account roster and preserve inheritance without writing a second list',async t=>{
  const f=await fixture(t,{mixed:true}),configFile=path.join(f.root,'config/wechatagent.json');
  const firstFriend='wechat:private:'+f.contacts[1].id,secondFriend='wechat:private:'+f.contacts[2].id;
  f.config.wechat.memeLibrary={enabled:false,allowImport:false,chats:{[f.key]:true,[firstFriend]:false,'wechat:group:999':false}};
  write(configFile,f.config);
  let currentTargets=f.view;
  const app=createConsole({root:f.root,port:0,botControls:{targets:()=>currentTargets()},fetchImpl:async()=>{throw Error('fixture offline');}});
  const {port}=await app.start(),base='http://127.0.0.1:'+port;
  t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));});
  const {token}=await fetch(base+'/api/info').then(r=>r.json());
  const request=async(route,body)=>{
    const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json()};
  };
  const catalog=(await request('/api/extensions')).value;
  const speech=catalog.extensions.find(item=>item.id==='native-speech');
  assert.equal(speech.statusLabel,'已开启');assert.equal(speech.featureState.totalCount,3);
  assert.deepEqual(new Set(speech.effectiveChats),new Set([f.key,firstFriend,secondFriend]));
  const card=catalog.extensions.find(item=>item.id==='dsh-meme');
  assert.equal(card.featureState.totalCount,3);
  assert.equal(card.featureState.effectiveCount,1);
  const before=(await request('/api/config')).value,selected=f.view();
  const body={revision:before.revision,accountRef:selected.accountRef,selectionVersion:selected.version,enabled:true,
    settings:{allowImport:true},chatSettings:{[f.key]:'inherit',[firstFriend]:true,[secondFriend]:false}};
  const saved=await request('/api/extensions/dsh-meme',body);
  assert.equal(saved.status,200,JSON.stringify(saved.value));
  assert.deepEqual(saved.value.config.wechat.memeLibrary,{enabled:true,allowImport:true,chats:{[firstFriend]:true,[secondFriend]:false,'wechat:group:999':false}});
  assert.deepEqual(saved.value.config.wechat.whitelist,{private:[],groups:[]});
  const updated=(await request('/api/extensions')).value.extensions.find(item=>item.id==='dsh-meme');
  assert.equal(updated.featureState.effectiveCount,2);assert.equal(updated.featureState.totalCount,3);
  assert.deepEqual(new Set(updated.effectiveChats),new Set([f.key,firstFriend]));
  const committed=fs.readFileSync(configFile);
  assert.equal((await request('/api/extensions/dsh-meme',body)).status,409);
  const fresh={...body,revision:saved.value.revision};
  assert.equal((await request('/api/extensions/dsh-meme',{...fresh,accountRef:'f'.repeat(64)})).status,409);
  assert.equal((await request('/api/extensions/dsh-meme',{...fresh,selectionVersion:undefined})).status,409);
  await f.store.replace({expectedVersion:selected.version,targetWxids:[f.contact.wechatId,f.contacts[1].wechatId]});
  const speechAfterRemoval=(await request('/api/extensions')).value.extensions.find(item=>item.id==='native-speech');
  assert.equal(speechAfterRemoval.featureState.totalCount,2);assert.equal(speechAfterRemoval.featureState.effectiveCount,2);
  assert.equal((await request('/api/extensions/dsh-meme',fresh)).status,409);
  assert.equal((await request('/api/extensions/dsh-meme',{...fresh,selectionVersion:f.view().version})).status,400);
  assert.equal((await request('/api/extensions/native-member-memory',{...fresh,selectionVersion:f.view().version,chatSettings:{[firstFriend]:true}})).status,400);
  currentTargets=()=>({...f.view(),accountRef:'f'.repeat(64)});
  assert.equal((await request('/api/extensions/native-web-reader',{...fresh,selectionVersion:f.view().version,chatSettings:{}})).status,409);
  assert.deepEqual(fs.readFileSync(configFile),committed);
});
