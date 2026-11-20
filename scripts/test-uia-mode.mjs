import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UiaModeStore,inspectUiaMode,requestUiaSenderMode} from './uia-mode.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'uia-mode-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^uia-mode-/);fs.rmSync(root,{recursive:true,force:true});});return root;}
const helpers=['WechatAccessibilityGate','WechatBackgroundControls','WechatQtActions','WechatVoicePreview','WechatUiaOffscreenHost','WechatOffscreenFocus'];
function artifacts(root){fs.mkdirSync(path.join(root,'state/ui-runtime'),{recursive:true});fs.writeFileSync(path.join(root,'state/ui-runtime/qt-visual.json'),JSON.stringify({executableVersion:'4.1.15.56',account:'PRIVATE_ACCOUNT',executable:'PRIVATE_PATH'}));fs.mkdirSync(path.join(root,'state/ui-host'),{recursive:true});for(const name of helpers)fs.writeFileSync(path.join(root,'state/ui-host',name+'.exe'),'offline fixture only');}
function state(root,value){const file=path.join(root,'state/runtime/background-injection.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));return file;}

test('UIA mode defaults disabled without reading processes, writing files or claiming background sending',t=>{
  const root=fixture(t),store=new UiaModeStore({root});assert.deepEqual(store.get(),{schemaVersion:2,backend:'uia',version:0,enabled:false,migrationRequired:false});
  const status=inspectUiaMode({root});assert.equal(status.canEnable,false);assert.equal(status.reason,'UIA_MODE_CLIENT_VERSION_REQUIRED');assert.equal(status.runtimeVerified,false);assert.equal(status.fullyBackgroundReady,false);assert.equal(status.requiresForeground,true);assert.equal(status.restoresForeground,true);assert.equal(status.requiresActivityGuard,true);assert.deepEqual(fs.readdirSync(root),[]);
});

test('all UIA, image/text and voice components are required while availability is separate from runtime verification',t=>{
  const root=fixture(t);artifacts(root);
  const ready=inspectUiaMode({root});assert.equal(ready.canEnable,true);assert.equal(ready.componentsAvailable,true);assert.equal(ready.runtimeVerified,false);assert.equal(ready.fullyBackgroundReady,false);assert.deepEqual(ready.supportedOperations,{sendText:true,sendImage:true,sendNativeVoice:true});assert.doesNotMatch(JSON.stringify(ready),/PRIVATE_/);
  for(const helper of helpers){const file=path.join(root,'state/ui-host',helper+'.exe'),original=fs.readFileSync(file);fs.unlinkSync(file);
    const missing=inspectUiaMode({root});assert.equal(missing.canEnable,false);assert.deepEqual(missing.missingComponents,[helper]);assert.equal(missing.reason,'UIA_MODE_COMPONENT_MISSING');fs.writeFileSync(file,original);
  }
  for(const operation of ['sendText','sendImage','sendNativeVoice'])assert.equal(inspectUiaMode({root,operation}).canEnable,true);
});

test('wrong versions and empty components cannot enable UIA',t=>{
  const root=fixture(t);artifacts(root);assert.equal(inspectUiaMode({root,clientVersion:'4.1.10.27'}).reason,'UIA_MODE_VERSION_UNSUPPORTED');assert.equal(inspectUiaMode({root,clientVersion:'4.1.15.57'}).canEnable,false);
  assert.throws(()=>inspectUiaMode({root,operation:'inject'}),{code:'UIA_MODE_OPERATION_INVALID'});
  fs.writeFileSync(path.join(root,'state/ui-host/WechatVoicePreview.exe'),'');assert.equal(inspectUiaMode({root}).canEnable,false);artifacts(root);
});

test('legacy enabled and disabled settings keep revision but cannot authorize UIA or migrate on read',t=>{
  for(const enabled of [true,false]){const root=fixture(t);artifacts(root);const original={schemaVersion:1,version:7,enabled},file=state(root,original),store=new UiaModeStore({root});
    assert.deepEqual(store.get(),{schemaVersion:2,backend:'uia',version:7,enabled:false,migrationRequired:true});assert.deepEqual(JSON.parse(fs.readFileSync(file)),original);
    assert.throws(()=>store.replace({expectedVersion:6,enabled:true}),{code:'UIA_MODE_VERSION_CONFLICT'});
    const saved=store.replace({expectedVersion:7,enabled:true});assert.equal(saved.enabled,true);assert.equal(saved.migrationRequired,false);assert.equal(saved.version,8);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.file)),{schemaVersion:2,backend:'uia',version:8,enabled:true});
  }
});

test('explicit disable can migrate old settings without components and never alters interaction preferences',t=>{
  const root=fixture(t),file=state(root,{schemaVersion:1,version:4,enabled:true}),policy=path.join(root,'state/runtime/interaction-policy.json');fs.writeFileSync(policy,'prior preferences');
  const saved=new UiaModeStore({root}).replace({expectedVersion:4,enabled:false});assert.equal(saved.enabled,false);assert.equal(saved.version,5);assert.equal(saved.migrationRequired,false);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state/runtime/uia-mode.json'))).backend,'uia');assert.equal(fs.readFileSync(policy,'utf8'),'prior preferences');
});

test('invalid state and foreign backend claims cannot silently authorize or overwrite preferences',t=>{
  for(const value of [{},{schemaVersion:2,backend:'background-injection',version:1,enabled:true},{schemaVersion:2,backend:'uia',version:1,enabled:true,extra:true},{schemaVersion:1,version:1,enabled:'true'}]){
    const root=fixture(t),file=state(root,value),store=new UiaModeStore({root});assert.throws(()=>store.get(),{code:'UIA_MODE_STATE_INVALID'});assert.throws(()=>store.replace({expectedVersion:1,enabled:false}),{code:'UIA_MODE_STATE_INVALID'});assert.deepEqual(JSON.parse(fs.readFileSync(file)),value);
  }
  const root=fixture(t);const store=new UiaModeStore({root,inspect:()=>({backend:'background-injection',canEnable:true,componentsAvailable:true,clientVersion:'4.1.15.56'})});assert.throws(()=>store.replace({expectedVersion:0,enabled:true}),{code:'UIA_MODE_UNAVAILABLE'});assert.equal(fs.existsSync(store.file),false);
});

test('UIA settings reject stale writes, unknown fields and another writer without changing saved state',t=>{
  const root=fixture(t);artifacts(root);const store=new UiaModeStore({root});store.replace({expectedVersion:0,enabled:true});assert.throws(()=>store.replace({expectedVersion:0,enabled:false}),{code:'UIA_MODE_VERSION_CONFLICT'});
  assert.throws(()=>store.replace({expectedVersion:1,enabled:false,backend:'uia'}),{code:'UIA_MODE_SETTINGS_INVALID'});fs.writeFileSync(store.file+'.lock','busy');assert.throws(()=>store.replace({expectedVersion:1,enabled:false}),{code:'UIA_MODE_BUSY'});assert.equal(store.get().enabled,true);
});

test('mode switch explicitly identifies UIA so an old host cannot interpret it as native injection',async t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'state'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({ports:{adapter:23009}}));fs.writeFileSync(path.join(root,'state/social-dsh-token.txt'),'c'.repeat(64));
  const request={expectedVersion:4,enabled:true},response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  const saved=await requestUiaSenderMode({root,request,fetchImpl:async(url,options)=>{assert.equal(url,'http://127.0.0.1:23009/sender-mode');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{...request,backend:'uia'});return response({backend:'uia',version:5,enabled:true,runtimeActive:true});}});assert.equal(saved.enabled,true);
  for(const value of [{version:5,enabled:true,runtimeActive:true},{backend:'background-injection',version:5,enabled:true,runtimeActive:true},{backend:'uia',version:4,enabled:true,runtimeActive:true},{backend:'uia',version:5,enabled:true}])await assert.rejects(requestUiaSenderMode({root,request,fetchImpl:async()=>response(value)}),{code:'UIA_MODE_SWITCH_UNCONFIRMED'});
  assert.equal(fs.existsSync(path.join(root,'state/runtime/background-injection.json')),false);
});
