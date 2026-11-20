import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatTargetsUI,selectedChatRows} from '../public/console/chat-targets.mjs';
import {createPluginUI} from '../public/console/plugins.js';

const selected=()=>({accountRef:'a'.repeat(64),version:4,targets:[{wxid:'fixture-one',id:'123',label:'旧好友',alias:'one'}]});
const incoming={wechatId:'fixture-two',id:'456',name:'同名 <好友>',kind:'private',alias:'two',ambiguous:false,uniqueSearchName:false};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(handler) {
  const elements=new Map(),calls=[],toasts=[];
  const get=selector=>{
    if(!elements.has(selector))elements.set(selector,{isConnected:true,value:'',disabled:false,innerHTML:'',listeners:{},
      addEventListener(type,fn){this.listeners[type]=fn;},querySelector:()=>get('searchButton')});
    return elements.get(selector);
  };
  const config={wechat:{whitelist:{private:['999'],groups:[]}},persona:{default:'默认',chats:{}}};
  const state={config,draft:structuredClone(config),chatTargets:selected(),names:new Map()};
  let modalBody,modalOptions,confirmation,renders=0;
  const api=async(route,body)=>{
    calls.push({route,body});
    if(handler){const handled=await handler(route,body);if(handled!==undefined)return handled;}
    if(route==='/api/chat-targets'&&body===undefined)return selected();
    if(route.startsWith('/api/bot-controls/contacts?'))return {contacts:[incoming]};
    if(route==='/api/chat-targets')return {accountRef:body.accountRef,version:body.expectedVersion+1,targets:body.targetWxids.map(wxid=>wxid===incoming.wechatId?{wxid,id:incoming.id,label:incoming.name,alias:incoming.alias}:selected().targets[0])};
    throw Error('Unexpected route');
  };
  const ui=createChatTargetsUI({api,state,modal:(_title,body,options)=>{modalBody=body;modalOptions=options;},closeModal:()=>modalOptions?.onClose?.(),
    confirmAction:(_title,_description,_label,fn)=>{confirmation=fn;},escapeHtml:v=>String(v??'').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    renderPage:async()=>{renders++;},updateDraftUI(){},toast:msg=>toasts.push(msg),query:get});
  const choose=(wxid,checked=true)=>get('#chat-target-results').listeners.change({target:{dataset:{chatTarget:wxid},checked,disabled:false}});
  return {ui,state,calls,toasts,get,choose,confirm:()=>confirmation(),html:()=>modalBody,close:()=>modalOptions.onClose(),renders:()=>renders};
}

test('picker saves stable current-account identities without rewriting unrelated settings drafts',async()=>{
  const f=fixture();f.state.draft.persona.default='未保存的人格';
  const before=JSON.stringify(f.state.draft);
  await f.ui.add('private');
  assert.doesNotMatch(f.html(),/manual-ids|数字 ID/);
  assert.match(f.get('#chat-target-results').innerHTML,/同名 &lt;好友>/);
  f.choose(incoming.wechatId);
  await f.get('#chat-target-save').listeners.click();
  assert.deepEqual(f.calls.find(c=>c.body).body,{accountRef:'a'.repeat(64),expectedVersion:4,targetWxids:['fixture-one','fixture-two']});
  assert.equal(JSON.stringify(f.state.draft),before);
  const rows=selectedChatRows(f.state.draft,f.state.chatTargets);
  assert.deepEqual(rows.map(r=>r.key),['wechat:private:123','wechat:private:456']);
  assert.equal(rows[1].persona,'未保存的人格');
  assert.equal(rows[1].session,null);
  assert.equal(f.renders(),1);
});

test('a concurrent selection change needs another explicit save and retains the new server choices',async()=>{
  let attempts=0,refreshes=0;
  const f=fixture((route,body)=>{
    if(route==='/api/chat-targets'&&body){
      if(++attempts===1)throw Object.assign(Error('名单已变化'),{status:409});
    }else if(route==='/api/chat-targets'&&++refreshes>1){
      return {...selected(),version:5,targets:[...selected().targets,{wxid:'another-window',id:'789',label:'另一个窗口添加',alias:''}]};
    }
  });
  await f.ui.add('private');f.choose(incoming.wechatId);
  await f.get('#chat-target-save').listeners.click();
  assert.equal(attempts,1);assert.match(f.get('#chat-target-error').textContent,/核对后再保存/);
  assert.equal(f.get('#chat-target-save').disabled,false);
  await f.get('#chat-target-save').listeners.click();
  assert.deepEqual(f.calls.filter(c=>c.body).at(-1).body.targetWxids,['fixture-one','another-window','fixture-two']);
  assert.equal(f.calls.filter(c=>c.body).at(-1).body.expectedVersion,5);
});

test('closed contact pickers ignore a late result and removing a chat preserves its saved settings',async()=>{
  let release;
  const f=fixture((route)=>route.startsWith('/api/bot-controls/contacts?')?new Promise(resolve=>{release=resolve;}):undefined);
  const opened=f.ui.add('private');await turn();f.close();release({contacts:[incoming]});await opened;
  assert.equal(f.get('#chat-target-results').innerHTML,'');
  const key='wechat:private:123';f.state.draft.persona.chats[key]='原人格';
  f.ui.remove('123','private');await f.confirm();
  assert.deepEqual(f.calls.find(c=>c.body).body.targetWxids,[]);
  assert.equal(f.state.draft.persona.chats[key],'原人格');
});

test('all-chat search includes groups and retains a visible count when selected results leave the query',async()=>{
  const group={...incoming,wechatId:'fixture-group@chatroom',id:'789',name:'群聊',kind:'group',uniqueSearchName:true};
  let searches=0;
  const f=fixture(route=>route.startsWith('/api/bot-controls/contacts?')?{contacts:++searches===1?[incoming,group]:[]}:undefined);
  await f.ui.add('all');
  assert.match(f.get('#chat-target-results').innerHTML,/fixture-group@chatroom/);
  f.choose(group.wechatId);
  f.get('#chat-target-search').listeners.submit({preventDefault(){}});
  await turn();
  assert.match(f.get('#chat-target-count').textContent,/待添加 1 个/);
  assert.doesNotMatch(f.get('#chat-target-results').innerHTML,/fixture-group@chatroom/);
  await f.get('#chat-target-save').listeners.click();
  assert(f.calls.find(c=>c.body).body.targetWxids.includes(group.wechatId));
});

test('an account switch closes the old selection instead of saving its picks to another account',async()=>{
  let reads=0,writes=0;
  const f=fixture((route,body)=>{
    if(route!=='/api/chat-targets')return;
    if(body){writes++;throw Object.assign(Error('账号已变化'),{status:409});}
    if(++reads>1)return {...selected(),accountRef:'b'.repeat(64),targets:[]};
  });
  await f.ui.add();f.choose(incoming.wechatId);
  await f.get('#chat-target-save').listeners.click();
  assert.equal(writes,1);assert.equal(f.state.chatTargets.accountRef,'b'.repeat(64));
  assert.equal(f.renders(),1);assert.match(f.toasts.at(-1),/重新打开添加聊天/);
});

test('plugin scope uses current selected chats even when the legacy whitelist and cached selection differ',async t=>{
  const previous=globalThis.document;
  const field={checked:false,addEventListener(){}};
  const form={querySelector:()=>field,querySelectorAll:()=>[],addEventListener(){}};
  globalThis.document={addEventListener(){},querySelector:()=>form};
  t.after(()=>{globalThis.document=previous;});
  const item={id:'fixture-plugin',name:'测试插件',configSchema:{},settings:{},requestedPermissions:[],permissions:[],chats:[],enabled:false};
  const state={config:{wechat:{whitelist:{private:['999'],groups:[]}}},chatTargets:{targets:[]},names:new Map()};
  const before=JSON.stringify(state.config);let html;const failures=[];
  const ui=createPluginUI({api:async route=>route==='/api/plugins'?{plugins:[item]}:selected(),
    state,modal:(_title,body)=>{html=body;},closeModal(){},confirmAction(){},renderPage(){},toast:value=>failures.push(value),icon:()=>'',escapeHtml:String});
  await ui.settings(item.id);
  assert.deepEqual(failures,[]);
  assert.match(html,/value="wechat:private:123"/);assert.match(html,/旧好友/);
  assert.doesNotMatch(html,/wechat:private:999/);
  assert.equal(JSON.stringify(state.config),before);
});
