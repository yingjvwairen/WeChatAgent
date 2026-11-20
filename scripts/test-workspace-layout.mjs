import {createDeliveryQueueUI} from '../public/console/delivery-queue.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {consoleRoute,routeKey,MAIN_PAGES,featureLocation,filterChats,effectiveChatFeature,REPLY_RHYTHM_FIELDS,displaySettingValue,readSettingInput} from '../public/console/layout-model.mjs';
test('reply rhythm preserves interval units and contains no reply probability',()=>{
  const fields = Object.fromEntries(REPLY_RHYTHM_FIELDS.map(([,key,options]) => [key, options]));
  const readNumber = (options, value) => readSettingInput({type:'number',dataset:{transform:options.transform},value:String(value)});
  for (const key of ['social.batch_ms','social.private_min_interval_ms','social.min_interval_ms']) {
    const options = fields[key];
    assert.equal(displaySettingValue(15000,options),15);
    for(const milliseconds of [0,15001,options.max*1000]){
      const shown=displaySettingValue(milliseconds,options);
      assert.ok(shown>=options.min&&shown<=options.max);
      assert.equal(options.step,.001);
      assert.equal(readNumber(options,shown),milliseconds);
    }
  }
  assert.equal(Object.hasOwn(fields,'wechat.groupReplyProbability'),false);
});
import {capabilityPanel,createWorkspaceLayout} from '../public/console/workspace-layout.js';
import {selectedChatRows} from '../public/console/chat-targets.mjs';
test('capability tabs keep the same content container and update the current link',()=>{
 const panel = {};
 const links = ['catalog','network','speech','dsh'].map(section=>({
   hash:'#extensions/'+section, current:null,
   setAttribute(name,value){assert.equal(name,'aria-current');this.current=value;},
   removeAttribute(name){assert.equal(name,'aria-current');this.current=null;}
 }));
 const container = {
   innerHTML:'',
   querySelector(){return this.innerHTML ? panel : null;},
   querySelectorAll(){return links;}
 };
 assert.equal(capabilityPanel(container,'network',String),panel);
 const shell = container.innerHTML;
 assert.match(shell,/href="#extensions\/network" aria-current="page"/);
 assert.equal(capabilityPanel(container,'speech',String),panel);
 assert.equal(container.innerHTML,shell);
 assert.deepEqual(links.filter(link=>link.current==='page').map(link=>link.hash),['#extensions/speech']);
});
const key='wechat:private:123',group='wechat:group:456';
const config=()=>({wechat:{whitelist:{private:['123'],groups:['456']},workModes:{[key]:'assistant'},search:{enabled:false,chats:{[key]:true}},stickers:{enabled:true,chats:{}},proactive:{enabled:false,chats:{[group]:true}},context:{enabled:true,maxTokens:100000,chats:{[group]:0}},assistant:{fileTransferChats:{[key]:true}},dshAccess:{chats:{[key]:{mode:'native',preset:'standard',skills:['saved'],tools:['read'],remoteApproval:true}}}},persona:{default:'默认人格',chats:{[key]:'助手人格'}}});
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture({offline=false,tab='summary'}={}){
 const original=config(),state={config:original,draft:structuredClone(original),names:new Map([[key,'同名 <好友>'],[group,'同名 <好友>']]),chatKind:'all',chatDetailTab:tab,selectedChat:key},requests=[];
 const targets={accountRef:'a'.repeat(64),version:1,targets:[{wxid:'fixture-friend',id:'123',label:'同名 <好友>',alias:''},{wxid:'fixture-room@chatroom',id:'456',label:'同名 <好友>',alias:''}]};
 const api=async(route,body)=>{requests.push({route,body});if(route==='/api/chat-targets')return targets;if(offline)throw Error('offline fixture');if(route==='/api/sessions')return {sessions:[{conversationKey:key,sessionId:'native-123',workMode:'assistant',contextTokens:5200,running:false},{conversationKey:group,sessionId:'native-456',contextTokens:8100}]};if(route==='/api/session-groups')return {available:true,groups:[],assignments:{}};if(route==='/api/assistant-task/list')return {tasks:[{id:'T0123456789abcdef',state:'waiting_approval',stage:'等待审批',createdAt:100000}]};throw Error('Unexpected request '+route);};
 const ui=createWorkspaceLayout({api,state,deliveryQueue:createDeliveryQueueUI({api,escapeHtml:esc,toast(){}}),escapeHtml:esc,icon:()=>'',header:(title,help='')=>'<h2>'+esc(title)+'</h2><p>'+esc(help)+'</p>',field:()=>'',toggle:()=>'',empty:(title,help,actions)=>'<h2>'+esc(title)+'</h2><p>'+esc(help)+'</p>'+(actions??''),sessionGroupUI:{prepare(){},visible:()=>true,toolbar:()=>'',control:()=>''},sessionUsage:()=>'<div>Fixture usage</div>',getCards:()=>({participation:'PARTICIPATION',rhythm:'RHYTHM',proactive:'PROACTIVE',admins:'ADMINS',search:'SEARCH',reader:'READER',media:'MEDIA'}),contextSettingsCard:()=> 'CONTEXT',feedbackCard:()=> 'FEEDBACK',connectionsPage:()=> 'CONNECTIONS',logsPage:async()=> 'LOGS',toolsPage:()=> 'TOOLS',dshPage:async()=> 'DSH',stickerPage:async()=> 'STICKERS',speechPage:async()=> 'SPEECH_SETTINGS',botMaintenancePage:async()=> 'LOCAL_MAINTENANCE'});
 return {state,ui,requests,targets};
}
test('main entries preserve legacy links and isolate memory subpage routes',()=>{
 assert.deepEqual(MAIN_PAGES,['overview','chats','roles','extensions','stickers','memory','settings']);
 assert.deepEqual(consoleRoute('#sessions'),{page:'chats',detail:'usage'});assert.deepEqual(consoleRoute('#behavior'),{page:'settings',section:'chat'});assert.equal(routeKey(consoleRoute('#connections')),'settings/connections');assert.equal(routeKey(consoleRoute('#tools')),'settings/diagnostics');assert.equal(routeKey(consoleRoute('#logs')),'settings/logs');
 assert.equal(routeKey(consoleRoute('#settings/assistant')),'settings/assistant');assert.equal(routeKey(consoleRoute('#stickers/sources')),'stickers/sources');assert.equal(routeKey(consoleRoute('#extensions/network')),'extensions/network');assert.deepEqual(consoleRoute('#settings'),{page:'settings',section:'chat'});assert.equal(consoleRoute('#settings/bot/reader-recovery').section,'diagnostics');assert.equal(consoleRoute('#settings/diagnostics/reader-recovery').section,'diagnostics');assert.equal(consoleRoute('#settings/unknown').section,'chat');assert.deepEqual(consoleRoute('#settings/bot'),{page:'overview'});assert.equal(routeKey(consoleRoute('#extensions/speech')),'extensions/speech');assert.equal(consoleRoute('#not-a-page').page,'overview');
 const html=fs.readFileSync('public/console/index.html','utf8'),entries=[...html.matchAll(/data-page="([^"]+)"/g)].map(match=>match[1]).filter(id=>id!=='setup');assert.deepEqual(entries,MAIN_PAGES);
});
test('feature links lead to one canonical configuration without changing permission policy',()=>{
 assert.equal(featureLocation('native-speech'),'#extensions/speech');assert.equal(featureLocation('native-search'),'#extensions/network');assert.equal(featureLocation('native-web-reader'),'#extensions/network');assert.equal(featureLocation('dsh-meme'),'#stickers/sources');assert.equal(featureLocation('native-stickers'),'#stickers/sending');assert.equal(featureLocation('native-proactive'),'#settings/chat');assert.equal(featureLocation('native-context'),'#settings/context');assert.equal(featureLocation('native-member-memory'),null);assert.equal(featureLocation('third-party'),null);
});
test('displayed effective state preserves default overrides and master-switch semantics',()=>{
 const c=config(),before=JSON.stringify(c);assert.deepEqual(effectiveChatFeature(c,key,'search'),{enabled:true,source:'本聊天单独设置'});assert.deepEqual(effectiveChatFeature(c,group,'search'),{enabled:false,source:'继承账号默认'});assert.deepEqual(effectiveChatFeature(c,group,'proactive'),{enabled:false,source:'总开关关闭'});assert.deepEqual(effectiveChatFeature(c,group,'context'),{enabled:false,source:'本聊天关闭'});assert.equal(effectiveChatFeature(c,key,'stickers').enabled,true);assert.equal(JSON.stringify(c),before);
});
test('one chat list retains identities across same names, modes, sessions and filters',()=>{
 const c=config(),sessions=[{conversationKey:key,sessionId:'first'},{conversationKey:group,sessionId:'second'}],rows=selectedChatRows(c,{targets:[{wxid:'peer',id:'123',label:'同名'},{wxid:'room@chatroom',id:'456',label:'同名'}]},sessions);assert.equal(rows.length,2);assert.equal(rows[0].session.sessionId,'first');assert.equal(rows[1].session.sessionId,'second');assert.equal(filterChats(rows,{kind:'groups'})[0].key,group);assert.equal(filterChats(rows,{mode:'assistant'})[0].key,key);assert.equal(filterChats(rows,{query:'456'})[0].key,group);assert.equal(filterChats(rows,{query:'默认人格'})[0].key,group);assert.equal(filterChats(rows,{query:'同名'}).length,2);
});
test('merged chat rendering is read-only, escaped and retains one settings entry for the selected chat',async()=>{
 const f=fixture(),before=JSON.stringify(f.state.draft),html=await f.ui.chatsPage();assert.match(html,/同名 &lt;好友&gt;/);assert(!html.includes('同名 <好友>'));assert.equal([...html.matchAll(/data-chat-settings=/g)].length,1);assert.equal([...html.matchAll(/data-chat-select=/g)].length,2);assert(!html.includes('data-dsh-chat'));assert.match(html,/本聊天单独设置/);assert.equal(JSON.stringify(f.state.draft),before);assert(f.requests.every(item=>item.body===undefined));
});
test('offline DSH leaves contact settings available and never invents a session',async()=>{
 const f=fixture({offline:true}),before=JSON.stringify(f.state.config),html=await f.ui.chatsPage();assert.equal([...html.matchAll(/data-chat-select=/g)].length,2);assert.match(html,/会话服务暂不可用/);assert.match(html,/初始化此聊天/);assert(!html.includes('native-123'));assert.equal(JSON.stringify(f.state.config),before);
});

test('memory shortcuts keep the selected saved chat and do not expose unsaved group drafts',async()=>{
 const f=fixture();f.state.selectedChat=group;let html=await f.ui.chatsPage();assert(html.includes('data-memory-open="'+group+'"'));assert(html.includes('data-memory-section="members"'));
 f.state.draft.wechat.whitelist.groups.push('789');f.state.selectedChat='wechat:group:789';html=await f.ui.chatsPage();assert(!html.includes('data-chat-select="wechat:group:789"'));
 f.state.selectedChat=key;f.state.chatDetailTab='usage';html=await f.ui.chatsPage();assert(html.includes('data-memory-open="'+key+'"'));assert(html.includes('data-memory-section="summaries"'));
});
test('task controls bind the actual task ID and file scope without running or cancelling work',async()=>{
 const f=fixture({tab:'tasks'}),before=JSON.stringify(f.state.draft),html=await f.ui.chatsPage();assert.match(html,/data-assistant-task-id="T0123456789abcdef"/);assert.match(html,/data-assistant-cancel="wechat:private:123"/);assert.match(html,/50 MB/);assert.equal(JSON.stringify(f.state.draft),before);assert.deepEqual(f.requests.filter(item=>item.body!==undefined),[{route:'/api/assistant-task/list',body:{key}}]);
 f.state.selectedChat=group;const social=await f.ui.chatsPage();assert.match(social,/聊天模式不执行助手任务/);assert(!social.includes('data-assistant-cancel='));
});
test('settings and network sections render only their own controls while drafts and native grants survive',async()=>{
 const f=fixture(),before=JSON.stringify(f.state.draft);f.state.settingsSection='assistant';const assistant=await f.ui.settingsPage();assert.match(assistant,/ADMINSFEEDBACK/);assert(!assistant.includes('PARTICIPATION'));f.state.settingsSection='context';const context=await f.ui.settingsPage();assert.match(context,/CONTEXT/);assert(!context.includes('ADMINS'));const network=f.ui.networkPage();assert.match(network,/SEARCHREADER/);assert(!network.includes('MEDIA'));assert.equal(JSON.stringify(f.state.draft),before);assert.equal(f.state.draft.wechat.dshAccess.chats[key].preset,'standard');assert.deepEqual(f.state.draft.wechat.dshAccess.chats[key].tools,['read']);
});
test('speech capability, chat defaults and diagnostics have distinct destinations',async()=>{
 const f=fixture(),before=JSON.stringify(f.state.draft);
 const defaults=await f.ui.settingsPage();
 assert.match(defaults,/PARTICIPATION/);assert.doesNotMatch(defaults,/LOCAL_MAINTENANCE|SPEECH_SETTINGS|href="#settings\/bot"/);
 f.state.capabilitySection='speech';assert.equal(await f.ui.capabilityPage(),'SPEECH_SETTINGS');
 f.state.settingsSection='diagnostics';
 const diagnostics=await f.ui.settingsPage();
 assert.match(diagnostics,/LOCAL_MAINTENANCE/);assert.doesNotMatch(diagnostics,/SPEECH_SETTINGS/);
 assert.match(diagnostics,/data-action="prepare">准备 DSH 连接配置/);
 assert.equal(JSON.stringify(f.state.draft),before);
});
test('sticker collection, sources and sending retain separate original settings scopes',async()=>{
 const f=fixture(),before=JSON.stringify(f.state.draft);f.state.stickerSection='sources';const sources=await f.ui.stickersPage();assert.match(sources,/data-extension-details="dsh-meme"/);assert.match(sources,/MEDIA/);f.state.stickerSection='library';assert.match(await f.ui.stickersPage(),/STICKERS/);assert.equal(JSON.stringify(f.state.draft),before);
});

test('selected chats remain visible before any DSH session and ignore a different legacy whitelist',async()=>{
 const f=fixture({offline:true});f.state.config.wechat.whitelist={private:[],groups:[]};f.state.draft.wechat.whitelist={private:['999'],groups:[]};
 f.targets.targets.push({wxid:'third-friend',id:'789',label:'第三位好友',alias:''});
 const before=JSON.stringify(f.state.draft),html=await f.ui.chatsPage();
 assert.equal([...html.matchAll(/data-chat-select=/g)].length,3);
 assert.match(html,/全部 · 3/);assert.match(html,/好友 · 2/);assert.match(html,/群聊 · 1/);
 assert.match(html,/第三位好友/);assert.doesNotMatch(html,/wechat:private:999|保存设置并重启/);
 assert.equal(JSON.stringify(f.state.draft),before);
});

test('delivery tab uses the selected receiver even without a DSH session or with equal display names',async()=>{
 const f=fixture({offline:true,tab:'queue'});
 let html=await f.ui.chatsPage();
 assert.match(html,/data-chat-detail-tab="queue" aria-pressed="true">发送队列/);
 assert.match(html,/id="chat-delivery-queue"[^>]+data-key="wechat:private:123" data-target="fixture-friend"/);
 f.state.selectedChat=group;html=await f.ui.chatsPage();
 assert.match(html,/data-key="wechat:group:456" data-target="fixture-room@chatroom"/);
 assert.doesNotMatch(html,/data-key="wechat:private:123" data-target="fixture-friend"/);
});
