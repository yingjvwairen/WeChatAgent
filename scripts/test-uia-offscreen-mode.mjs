import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UiaOffscreenStore,requestUiaOffscreenMode} from './uia-offscreen-mode.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'uia-offscreen-mode-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,store:new UiaOffscreenStore({root})};}
test('offscreen defaults off independently and stale updates cannot change its selection',t=>{
  const {root,store}=fixture(t);assert.deepEqual(store.get(),{schemaVersion:1,version:0,enabled:false});assert.equal(fs.existsSync(store.file),false);
  fs.mkdirSync(path.join(root,'state/runtime'),{recursive:true});fs.writeFileSync(path.join(root,'state/runtime/uia-mode.json'),JSON.stringify({schemaVersion:2,backend:'uia',version:4,enabled:true}));
  assert.equal(store.get().enabled,false);assert.deepEqual(store.replace({expectedVersion:0,enabled:true}),{schemaVersion:1,version:1,enabled:true});
  assert.throws(()=>store.replace({expectedVersion:0,enabled:false}),{code:'UIA_OFFSCREEN_VERSION_CONFLICT'});assert.equal(store.get().enabled,true);
  assert.equal(store.replace({expectedVersion:1,enabled:false}).version,2);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state/runtime/uia-mode.json'))).version,4);
});
test('malformed state, extra request properties and a locked update cannot be accepted',t=>{
  const {store}=fixture(t);assert.throws(()=>store.replace({expectedVersion:0,enabled:true,backend:'uia'}),{code:'UIA_OFFSCREEN_SETTINGS_INVALID'});
  store.replace({expectedVersion:0,enabled:false});fs.writeFileSync(store.file+'.lock','held');assert.throws(()=>store.replace({expectedVersion:1,enabled:true}),{code:'UIA_OFFSCREEN_BUSY'});fs.unlinkSync(store.file+'.lock');
  fs.writeFileSync(store.file,JSON.stringify({schemaVersion:1,version:2,enabled:true,extra:1}));assert.throws(()=>store.get(),{code:'UIA_OFFSCREEN_STATE_INVALID'});
});
test('offscreen switch requires an authenticated live service acknowledgment and never saves locally',async t=>{
  const {root,store}=fixture(t);fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.mkdirSync(path.join(root,'state'),{recursive:true});fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({ports:{adapter:25003}}));fs.writeFileSync(path.join(root,'state/social-dsh-token.txt'),'a'.repeat(64));
  const request={expectedVersion:0,enabled:true},response={schemaVersion:1,backend:'uia-offscreen',version:1,enabled:true,runtimeActive:true,windowState:{state:'parked',parked:true,released:false}};
  const fetchImpl=async(url,options)=>{assert.equal(url,'http://127.0.0.1:25003/sender-offscreen');assert.equal(options.headers.Authorization,'Bearer '+'a'.repeat(64));assert.deepEqual(JSON.parse(options.body),{...request,backend:'uia-offscreen'});return{ok:true,text:async()=>JSON.stringify(response)};};
  assert.deepEqual(await requestUiaOffscreenMode({root,request,fetchImpl}),response);assert.equal(store.get().version,0);
  for(const change of [v=>delete v.windowState,v=>v.windowState={},v=>v.windowState.parked=false,v=>v.windowState.released=true,v=>v.backend='uia',v=>v.runtimeActive=false,v=>v.version=2]){const value=structuredClone(response);change(value);await assert.rejects(requestUiaOffscreenMode({root,request,fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify(value)})}),{code:'UIA_OFFSCREEN_SWITCH_UNCONFIRMED'});}
  await assert.rejects(requestUiaOffscreenMode({root,request,fetchImpl:async()=>({ok:false,text:async()=>JSON.stringify({error:'UIA_OFFSCREEN_PENDING_DELIVERY'})})}),{code:'UIA_OFFSCREEN_PENDING_DELIVERY'});
});
