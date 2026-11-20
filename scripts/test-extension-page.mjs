import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createExtensionUI} from '../public/console/extensions.js';
import {applyBuiltinUpdate,builtinCatalog} from './extension-status.mjs';

function fixture(t,{memeStatus=async()=>({available:true}),dshCatalog=async()=>({skills:[],tools:[]})}={}) {
  const documentBefore=globalThis.document;
  globalThis.document={addEventListener(){}};
  t.after(()=>{if(documentBefore===undefined)delete globalThis.document;else globalThis.document=documentBefore;});
  const config={wechat:{whitelist:{private:['123'],groups:['456']},search:{enabled:true},memeLibrary:{enabled:true}}};
  const original=JSON.stringify(config),catalog=builtinCatalog(config,'fixture-revision',true),requests=[];
  const selection={accountRef:'a'.repeat(64),version:2,targets:[{wxid:'new-selected',id:'789',label:'新好友'}]};
  const ui=createExtensionUI({
    api:async route=>{requests.push(route);if(route==='/api/extensions')return catalog;if(route==='/api/chat-targets')return selection;if(route==='/api/meme-library-status')return memeStatus();if(route==='/api/dsh-catalog')return dshCatalog();throw Error('Unexpected request: '+route);},
    modal(){},closeModal(){},confirmAction(){},escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    icon:()=>'',state:{config,names:new Map()},renderPage(){},toast(){},
  });
  t.after(()=>assert.equal(JSON.stringify(config),original,'rendering must not reset feature settings'));
  return {ui,catalog,requests};
}

function assertCards(html,catalog) {
  assert.equal(typeof html,'string');
  assert(!html.includes('[object Promise]'),'the page must contain rendered markup');
  assert.match(html,/data-extension="native-search"/);assert(!html.includes('开关与聊天范围'));assert.equal([...html.matchAll(/extension-card-action /g)].length,catalog.extensions.length);
  assert.equal([...html.matchAll(/data-extension-card="/g)].length,catalog.extensions.length);
  for(const item of catalog.extensions)assert(html.includes('data-extension-card="'+item.id+'"'),'missing card: '+item.id);
  assert.match(html,/id="extension-search"/);assert.match(html,/id="extension-status-filter"/);
}

test('extension page waits for delayed status and renders every capability card with canonical settings links',async t=>{
  let release;const delayed=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{memeStatus:()=>delayed});let settled=false;
  const pending=f.ui.page().then(html=>{settled=true;return html;});
  try{await nextTurn();assert.equal(settled,false,'a slow status response must not turn the catalog into Promise text');}
  finally{release({available:true});}
  const html=await pending;assertCards(html,f.catalog);assert.match(html,/DSH 技能与工具/);assert.match(html,/0 \/ 1 个聊天已分配能力/);
});

test('unavailable DSH and meme services keep built-in extension cards and settings visible',async t=>{
  const unavailable=async()=>{throw Error('offline fixture');};
  const f=fixture(t,{memeStatus:unavailable,dshCatalog:unavailable});
  const html=await f.ui.page();assertCards(html,f.catalog);assert.match(html,/DSH 未连接/);
  assert.equal(f.requests.length,4);
});

test('reopening the extension page still renders the complete catalog',async t=>{
  const f=fixture(t);
  assertCards(await f.ui.page(),f.catalog);assertCards(await f.ui.page(),f.catalog);
});

test('speech card uses the shared chat status, filters by selected chats and opens the speech tab',async t=>{
  const oldDocument=globalThis.document,oldWindow=globalThis.window,listeners=[],changes=[],grid={},countLabel={};
  globalThis.document={
    addEventListener(type,fn){if(type==='click')listeners.push(fn);if(type==='change')changes.push(fn);},
    querySelector:selector=>selector==='#extension-grid'?grid:countLabel,querySelectorAll:()=>[],
  };
  globalThis.window={location:{hash:'#extensions/catalog'}};
  t.after(()=>{globalThis.document=oldDocument;globalThis.window=oldWindow;});
  const noChats=builtinCatalog({wechat:{whitelist:{private:[],groups:[]}}},'empty').extensions.find(item=>item.id==='native-speech');
  assert.equal(noChats.statusLabel,'未选择聊天');assert.equal(noChats.featureState.effectiveCount,0);assert.equal(noChats.featureState.totalCount,0);
  const config={wechat:{whitelist:{private:[],groups:['456']}}};
  const catalog=builtinCatalog(config,'fixture',false,{asr:{mode:'local',localModelDirectory:'private-folder'},tts:{mode:'cloud',endpoint:'private-service',apiKey:'private-key'}});
  const requests=[];
  const ui=createExtensionUI({api:async route=>{
    requests.push(route);
    if(route==='/api/extensions')return catalog;
    if(route==='/api/chat-targets')return {targets:[]};
    if(route==='/api/dsh-catalog')return {skills:[],tools:[]};
    if(route==='/api/meme-library-status')return {available:false};
    throw Error('unexpected '+route);
  },modal:()=>assert.fail('speech must use its own form'),closeModal(){},confirmAction(){},escapeHtml:String,icon:()=>'',state:{config,names:new Map()},renderPage(){},toast(){}});
  const html=await ui.page(),card=html.match(/<article[^>]*data-extension-card="native-speech"[\s\S]*?<\/article>/)[0];
  assert.match(card,/WeChatAgent · 内置能力/);
  assert.match(card,/<span class="status-tag ok">已开启<\/span><span>1 \/ 1 个聊天开启<\/span>/);
  assert.equal((card.match(/class="status-tag/g)??[]).length,1);
  assert.match(card,/class="extension-source-link"[^>]*aria-label="查看 语音服务 项目"/);
  assert.doesNotMatch(card,/本地识别 · 云端合成|待生效|已关闭/);
  assert.doesNotMatch(JSON.stringify(catalog),/private-folder|private-service|private-key/);
  assert.throws(()=>applyBuiltinUpdate(config,'native-speech',{enabled:false}),/无效/);
  for(const [value,visible] of [['enabled',true],['disabled',false]]){
    for(const change of changes)change({target:{id:'extension-status-filter',value}});
    assert.equal(grid.innerHTML.includes('data-extension-card="native-speech"'),visible);
  }
  const count=requests.length;
  for(const dataset of [{extension:'native-speech'},{extensionDetails:'native-speech'}]){
    globalThis.window.location.hash='#extensions/catalog';
    const button={dataset,hasAttribute:()=>false},event={target:{closest:selector=>selector==='button'?button:null}};
    for(const fn of listeners)fn(event);
    await nextTurn();
    assert.equal(globalThis.window.location.hash,'#extensions/speech');
  }
  assert.equal(requests.length,count);
});

test('meme dialog submits its displayed account and roster version while preserving failed edits',async t=>{
  const oldDocument=globalThis.document,listeners=[];
  const nodes=new Map(),events=new Map(),toasts=[],calls=[];
  const keys=['wechat:private:123','wechat:private:789','wechat:group:456'];
  const inputs=keys.map((key,index)=>({dataset:{featureChat:key},tagName:'SELECT',value:['inherit','on','off'][index]}));
  const badges=keys.map(key=>({dataset:{featureEffective:key}}));
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{checked:selector==='#extension-enabled'||selector==='#meme-allow-import',addEventListener(){}});
    return nodes.get(selector);
  };
  const form={querySelector:node,querySelectorAll:selector=>selector==='[data-feature-chat]'?inputs:selector==='[data-feature-effective]'?badges:[],addEventListener:(name,callback)=>events.set(name,callback)};
  globalThis.document={addEventListener:(name,callback)=>{if(name==='click')listeners.push(callback);},querySelector:selector=>selector==='#extension-form'?form:node(selector)};
  t.after(()=>{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;});
  const config={wechat:{whitelist:{private:[],groups:[]},memeLibrary:{enabled:true,allowImport:false}}};
  const selection={accountRef:'a'.repeat(64),version:7,targets:[{wxid:'friend-a',id:'123',label:'好友A'},{wxid:'friend-b',id:'789',label:'好友B'},{wxid:'room@chatroom',id:'456',label:'群聊'}]};
  let html='',closed=0,failed=true;
  const api=async(route,body)=>{
    calls.push({route,body});
    if(route==='/api/extensions')return builtinCatalog(config,'old-catalog-version');
    if(route==='/api/config')return{revision:'saved-project-version',config};
    if(route==='/api/chat-targets')return selection;
    if(route==='/api/extensions/dsh-meme'){
      if(failed)throw Error('fixture save unavailable');
      return {revision:'next-version',config};
    }
    throw Error('Unexpected request '+route);
  };
  createExtensionUI({api,state:{config,names:new Map()},modal:(_title,value)=>{html=value;},closeModal:()=>{closed++;},confirmAction(){},escapeHtml:value=>String(value??''),icon:()=>'',renderPage:async()=>{},toast:value=>toasts.push(value)});
  const button={dataset:{extensionDetails:'dsh-meme'},hasAttribute:()=>false},event={target:{closest:selector=>selector==='button'?button:null}};
  for(const callback of listeners)callback(event);
  for(let attempt=0;attempt<8&&!events.has('submit');attempt++)await nextTurn();
  assert.match(html,/好友A/);assert.match(html,/好友B/);assert.match(html,/群聊/);
  const submitter={disabled:false};
  await events.get('submit')({preventDefault(){},submitter});
  assert.equal(closed,0);assert.equal(submitter.disabled,false);
  assert.equal(node('#extension-error').hidden,false);
  assert.equal(node('#extension-error').textContent,'fixture save unavailable');
  assert.deepEqual(inputs.map(input=>input.value),['inherit','on','off']);
  const expected={revision:'saved-project-version',accountRef:selection.accountRef,selectionVersion:7,enabled:true,
    chatSettings:{[keys[0]]:'inherit',[keys[1]]:true,[keys[2]]:false},settings:{allowImport:true}};
  assert.deepEqual(calls.at(-1),{route:'/api/extensions/dsh-meme',body:expected});
  failed=false;await events.get('submit')({preventDefault(){},submitter});
  assert.equal(closed,1);assert.match(toasts.at(-1),/已保存/);
});
