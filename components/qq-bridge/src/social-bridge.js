import {pluginEnabled} from '../../../packages/plugin-api/catalog.mjs';
import {replyMessageLimit} from '../../../packages/dsh-social-bridge-plugin/reply-layout-policy.mjs';
import {AssistantFeedback} from '../../../packages/dsh-social-bridge-plugin/assistant-feedback.mjs';
import {createAssistantNoticeDelivery} from './core/assistant-notice-delivery.js';
import fs from 'node:fs';
import path from 'node:path';
import { WechatOneBotAdapter } from './adapters/wechat/wechat-onebot-adapter.js';
import { MessageBuffer,createOfflineIntake } from './core/message-buffer.js';
import {DshConnectionGuard} from './core/dsh-connection.js';
import { SocialEngine,assistantChatRequest } from './core/social-engine.js';
import { DshPluginClient } from './dsh/plugin-client.js';
import { buildConversationKey } from './core/conversation-key.js';
import { selectRoleText } from './role-card.js';
import { socialPersona } from './core/social-persona.js';
import { stickerPolicy } from './core/sticker-policy.js';
import { searchPolicy } from '../../../packages/dsh-social-bridge-plugin/search-policy.mjs';
import {ProactiveEngine} from './core/proactive-engine.js';
import { ContextMaintenance } from './core/context-maintenance.js';
import {UiAsyncOrigins} from './core/ui-async-origins.js';
import {selectionScopeFields} from './core/selection-scope.js';
import {withUiSelection,selectedWechat} from '../../../packages/dsh-social-bridge-plugin/ui-selection-policy.mjs';
import {HistoryStore} from '../../../packages/dsh-social-bridge-plugin/history-store.mjs';
import {historyScopeKey,scopeHistory} from '../../../packages/dsh-social-bridge-plugin/work-modes.mjs';
import {activeReaderAccount} from '../../../scripts/reader-account-state.mjs';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.resolve(process.argv[2] ?? path.join(root, 'config.social.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const wechat = config.platforms?.wechat ?? config.wechat ?? {};
if (wechat.enabled !== true) throw new Error('wechat.enabled must be true in config.social.json');
const allowedGroups = new Set((wechat.whitelist?.groups ?? []).map(String));
const allowedPrivate = new Set((wechat.whitelist?.private ?? []).map(String));
const sendPrivateTest = process.argv.slice(3).includes('--test-private');
if (sendPrivateTest && (allowedGroups.size !== 0 || allowedPrivate.size !== 1)) {
  throw new Error('private test requires exactly one allowed friend and an empty group whitelist');
}
if (allowedGroups.size + allowedPrivate.size === 0) console.warn('[Social] Hook whitelist is empty; UI inputs require a current local selection grant');
const log = (line) => console.log(new Date().toISOString(), line);
const historyRoot=path.resolve(config.project_root??(config.search_policy_file?path.dirname(path.dirname(config.search_policy_file)):path.resolve(root,'../..')));
const historyAccount=activeReaderAccount(historyRoot);
const baseHistoryStore=new HistoryStore(historyRoot,historyAccount.id||historyAccount.legacyId);
const historyStore=scopeHistory(baseHistoryStore,(_key,row)=>row?.work_mode??'social');
const historyArchive={hasIncoming:(...args)=>historyStore.hasIncoming(...args),backfill:(...args)=>historyStore.backfill(...args),append:(...args)=>{
  if(activeReaderAccount(historyRoot).id!==historyAccount.id)throw Error('ACCOUNT_SWITCH_REQUIRES_BRIDGE_RESTART');
  return historyStore.append(...args);
}};
const buffer = new MessageBuffer(path.resolve(root, config.message_buffer?.path ?? 'state/social-messages.json'),
  { maxPerChat: config.message_buffer?.max_messages_per_chat ?? 300,archive:historyArchive });
const projectRoot=path.resolve(config.project_root??(config.search_policy_file?path.dirname(path.dirname(config.search_policy_file)):path.resolve(root,'../..')));
const uiOrigins=new UiAsyncOrigins({root:projectRoot});
// Import prior scoped work before any asynchronous sender can resume.
for(const row of [...buffer.chats.values()].flat().concat([...buffer.pendingReplies.values(),...buffer.mediaReplies.values()].map(item=>item.message))){
  if(row?.ui_selection_required!==undefined||row?.ui_reply_scope!==undefined){selectionScopeFields(row);uiOrigins.remember(row.self_id);}
}
const scopedMessage=(message,operation)=>withUiSelection(projectRoot,selectionScopeFields(message).ui_reply_scope,buildConversationKey(message.platform,message.kind,message.conversation_id),operation);
const asyncReady=()=>{try{if(!adapter.stats.connected||!adapter.selfId||adapter.uiOriginBlocked)return false;uiOrigins.assertAsyncAllowed(adapter.selfId);return true;}catch{return false;}};
const plugin = new DshPluginClient({...config.dsh_plugin,feedback:new AssistantFeedback({root:projectRoot})}, log);
import {assistantSenderAllowed,assistantGroupChatAllowed,verifiedAssistantSender} from '../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {conversationMode,conversationWorkMode} from '../../../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
const workModeFor=key=>conversationWorkMode(config.search_policy_file?JSON.parse(fs.readFileSync(config.search_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat,key);
const modeFor=key=>conversationMode(config.search_policy_file?JSON.parse(fs.readFileSync(config.search_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat,key);
const searchPolicyFor=key=>searchPolicy(config.search_policy_file?JSON.parse(fs.readFileSync(config.search_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat,key);
const searchStateFor=async message=>{
  const key=buildConversationKey(message.platform,message.kind,message.conversation_id);
  if(!searchPolicyFor(key).enabled)return null;
  return await plugin.modelSearchReady()?{status:'model'}:{status:'unavailable',message:'联网搜索已开启，但 DSH 网页搜索拓展未就绪，请在本机完整退出 DSH 后重新启动。'};
};
const adapter = new WechatOneBotAdapter({ server: { host: '127.0.0.1', ...(wechat.onebot?.server ?? {}),
  token: process.env.SOCIAL_ONEBOT_TOKEN ?? '' },onUiAccount:account=>uiOrigins.remember(account),acceptUiMessage:message=>acceptMessage(message,true) }, log);
const personaFor = (key) => socialPersona(config, key, (roleName) => {
  if (!/^[^\\/\0.][^\\/\0]{0,60}$/.test(roleName) || roleName.includes('..')) throw new Error('invalid role name');
  return selectRoleText(fs.readFileSync(path.join(root, 'roles', `${roleName}.md`), 'utf8'), 'v2');
});
const connection=new DshConnectionGuard({buffer,probe:()=>plugin.connectionHealth({projectRoot:historyRoot,accountScope:historyAccount.id}),log});
const engine = new SocialEngine({ buffer,connection, roleFor: key => personaFor(key).persona,
  personaNameFor: key => personaFor(key).personaName,workModeFor,withMessageScope:scopedMessage,assistantControl:(key,action,message,command)=>scopedMessage(message,()=>plugin.assistantTask(key,action,{...command,senderWxid:verifiedAssistantSender(message),uiSelectionScope:selectionScopeFields(message).ui_reply_scope})),assistantAccess:(key,message)=>{try{return scopedMessage(message,()=>assistantSenderAllowed((config.search_policy_file?JSON.parse(fs.readFileSync(config.search_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat),key,verifiedAssistantSender(message)));}catch{return false;}},
  wakeWords: wechat.wake_words ?? [],
  mode: wechat.wake_mode ?? 'hybrid',modeFor, batchMs: config.social?.batch_ms ?? 3000,
  minIntervalMs: config.social?.min_interval_ms ?? 15000,
  privateMinIntervalMs: config.social?.private_min_interval_ms ?? 1000,
  maxPerMinute: config.social?.max_per_minute ?? 3,
  maxPerTenMinutes: config.social?.max_per_ten_minutes ?? 10,
  decide: (key, prompt, metadata) => withUiSelection(projectRoot,metadata.localReplyBinding?.ui_reply_scope,key,()=>plugin.followup(key, prompt, metadata)),
  modelSearchReady:()=>plugin.modelSearchReady(),
  searchFor:searchStateFor,
  searchPolicyFor:message=>searchPolicyFor(buildConversationKey(message.platform,message.kind,message.conversation_id)),
  stickerChoicesFor: message=>adapter.stickerChoices({kind:message.kind,target:message.conversation_id,query:message.text}),
  replyFormatFor:()=>adapter.outputCapabilities,
  notebookEnabledFor:key=>pluginEnabled(projectRoot,'fish-notebook',key),
  maxTextPartsFor:()=>replyMessageLimit(JSON.parse(fs.readFileSync(path.join(projectRoot,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'' )).wechat),
  stickerPolicyFor: message=>stickerPolicy(config.sticker_policy_file?JSON.parse(fs.readFileSync(config.sticker_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat,buildConversationKey(message.platform,message.kind,message.conversation_id)),
  stickerLabelsFor: (message,ids)=>adapter.stickerLabels({kind:message.kind,target:message.conversation_id,ids}),
  saveStickerLabels: (message,labels)=>adapter.saveStickerLabels({kind:message.kind,target:message.conversation_id,labels}),
  sendSticker: (message,id,options)=>adapter.sendSticker({kind:message.kind,target:message.conversation_id,selfId:message.self_id,id,...options,
    selectionRequired:message.ui_selection_required,selectionScope:message.ui_reply_scope }),
  send: (message, text, options) => adapter.sendText({ kind: message.kind, target: message.conversation_id, text,selfId:message.self_id,...options,
    selectionRequired:message.ui_selection_required,selectionScope:message.ui_reply_scope }), log });
const memberSettings=()=>config.search_policy_file?JSON.parse(fs.readFileSync(config.search_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat;
const memberHistory=scopeHistory(baseHistoryStore,()=> 'assistant-chat',{fixedMode:'assistant-chat'});
const memberArchive={hasIncoming:(...args)=>memberHistory.hasIncoming(...args),backfill:(...args)=>memberHistory.backfill(...args),append:(...args)=>{
  if(activeReaderAccount(historyRoot).id!==historyAccount.id)throw Error('ACCOUNT_SWITCH_REQUIRES_BRIDGE_RESTART');
  return memberHistory.append(...args);
}};
const memberBuffer=new MessageBuffer(path.join(historyRoot,'state/accounts',historyAccount.id||historyAccount.legacyId||'legacy','assistant-group-chat.json'),{maxPerChat:buffer.maxPerChat,archive:memberArchive});
const memberConnection=new DshConnectionGuard({buffer:memberBuffer,probe:()=>plugin.connectionHealth({projectRoot:historyRoot,accountScope:historyAccount.id}),log});
const memberEngine=engine.createGroupChat({buffer:memberBuffer,connection:memberConnection,assistantAccess:(key,message)=>conversationWorkMode(memberSettings(),key)==='assistant'&&assistantGroupChatAllowed(memberSettings(),key,verifiedAssistantSender(message))});
const proactive=new ProactiveEngine({stateFile:path.resolve(config.proactive_state_file??path.join(root,'state/proactive/state.json')),
  buffer,social:engine,settingsFor:()=>{const value=config.proactive_policy_file?JSON.parse(fs.readFileSync(config.proactive_policy_file,'utf8').replace(/^\uFEFF/,'')):{wechat};return {...value,wechat:selectedWechat(projectRoot,value.wechat)};},
  personaFor,decide:(key,prompt,metadata)=>{uiOrigins.assertAsyncAllowed(adapter.selfId);return plugin.followup(key,prompt,metadata);},
  searchFor:searchStateFor,
  send:(message,text,options)=>{uiOrigins.assertAsyncAllowed(message.self_id,message);uiOrigins.assertAsyncAllowed(adapter.selfId);return adapter.sendText({kind:message.kind,target:message.conversation_id,text,selfId:message.self_id,...options,
    selectionRequired:message.ui_selection_required,selectionScope:message.ui_reply_scope});},
  isReady:()=>connection.ready&&asyncReady(),selfIdFor:()=>adapter.selfId,log});
const contextMaintenance = new ContextMaintenance({ buffer, social: engine,
  settingsFor: () => {const value=config.context_policy_file ? JSON.parse(fs.readFileSync(config.context_policy_file, 'utf8').replace(/^\uFEFF/, '')) : {wechat};return {...value,wechat:selectedWechat(projectRoot,value.wechat)};},
  maintain: (key, version) => plugin.maintainContext(key, version),
  proactivePending: key => !!proactive.state.chats[key]?.job,
  isReady: () => connection.ready && adapter.stats.connected && !!adapter.selfId, log });

function chatLane(key,message){
  const mode=engine.workModeFor(key);
  return mode==='assistant'&&message.kind==='group'&&(!engine.assistantAllowed(key,message)||assistantChatRequest(message,wechat.wake_words??[]))?'assistant-chat':mode;
}
function candidateLane(message){
  try{return scopedMessage(message,()=>{
    const key=buildConversationKey(message.platform,message.kind,message.conversation_id);
    const lane=chatLane(key,message),recipient=lane==='assistant-chat'?memberEngine:engine;
    return recipient.offlineEligible(key,message)?lane:null;
  });}catch(error){if(error.code==='UI_SELECTION_SCOPE_REVOKED')return null;throw error;}
}
const foldOffline=createOfflineIntake(buffer,candidateLane,(message,replay,lane)=>acceptSingle({...message,offline_replay:replay},true,lane));
async function acceptMessage(message,durable=false){
  if(!message.offline_batch)return acceptSingle(message,durable);
  if(!durable)return false;
  try{return await scopedMessage(message,()=>foldOffline(message));}
  catch(error){log('[Social] offline intake error='+ (error.code??'UNAVAILABLE'));return error.code==='UI_SELECTION_SCOPE_REVOKED';}
}
async function acceptSingle(message,durable=false,expectedLane) {
  try {
    const list = message.kind === 'group' ? allowedGroups : allowedPrivate;
    const binding=selectionScopeFields(message);
    if (!binding.ui_selection_required&&!list.has(String(message.conversation_id))) {
      log(`[WeChat] denied ${message.kind}:${message.conversation_id}`); return true;
    }
    return await scopedMessage(message,async()=>{
      if(binding.ui_selection_required)uiOrigins.remember(message.self_id);
      const key=buildConversationKey(message.platform,message.kind,message.conversation_id);
      const lane=chatLane(key,message);
      if(expectedLane&&expectedLane!==lane)return true;
      log('[WeChat] accepted '+key);
      if(buffer.findIncoming(message))return !durable||buffer.persistedIncoming(message);
      if(memberBuffer.findIncoming(message))return !durable||memberBuffer.persistedIncoming(message);
      // The bounded recent buffers need not still contain a replayed event.
      // The account-scoped archive retains its original, stable WeChat ID
      // even across mode changes; checking existence never exposes its text.
      const archivedReplay=()=>binding.ui_selection_required&&['social','assistant','assistant-chat'].some(mode=>
        baseHistoryStore.hasIncoming(historyScopeKey(key,mode),message,{replayOnly:message.offline_replay===undefined}));
      if(archivedReplay())return true;
      if(message.kind==='group'&&engine.workModeFor(key)==='assistant'&&engine.assistantAllowed(key,message)&&memberHistory.hasIncoming(key,message))return !durable;
      if(lane==='assistant-chat'){
        if(message.offline_replay&&!message.contextOnly&&!memberEngine.assistantAllowed(key,message))return true;
        if(!message.contextOnly&&message.offline_replay!=='context')await memberConnection.check({force:true});
        memberEngine.receive({...message,assistant_chat_only:true});
        return !durable||memberBuffer.persistedIncoming(message)||archivedReplay();
      }
      if(message.offline_replay&&!message.contextOnly&&engine.workModeFor(key)==='assistant'&&!engine.assistantAllowed(key,message))return true;
      if(!message.contextOnly&&message.offline_replay!=='context')await connection.check({force:true});
      engine.receive(message);
      return !durable||buffer.persistedIncoming(message)||archivedReplay();
    });
  } catch (error) { log('[Social] inbound error='+(error?.code??'UNAVAILABLE'));return error.code==='UI_SELECTION_SCOPE_REVOKED'; }
}
for(const messages of [buffer,memberBuffer]){
  for(const key of messages.keys())messages.foldLegacyOffline(key,row=>{
    const lane=candidateLane(row);
    return lane!==null&&(messages===memberBuffer?lane==='assistant-chat':lane===(row.work_mode??'social'));
  });
}
adapter.onMessage((message) => acceptMessage(message));
adapter.on('open', () => log('[WeChat] OneBot adapter connected'));
adapter.on('close', () => log('[WeChat] OneBot adapter disconnected'));
adapter.on('error', (error) => log(`[WeChat] adapter error=${error?.message ?? error}`));
if (sendPrivateTest) adapter.once('open', () => {
  const target = [...allowedPrivate][0];
  void adapter.sendText({ kind: 'private', target,
    text: '这是蓝色大肥鱼的 AI 接入测试。收到后请回复“测试”，我会尝试自动回应。' })
    .then(result => log(result?.confirmed===true?'[WeChat] private test confirmed by server receipt':'[WeChat] private test is not yet confirmed'))
    .catch((error) => log(`[WeChat] private test failed=${error?.message ?? error}`));
});
await Promise.all([connection.check({force:true}),memberConnection.check({force:true})]);connection.start();memberConnection.start();
await adapter.start();
log(`[Social] reverse OneBot listening on 127.0.0.1:${wechat.onebot?.server?.port ?? 11229}${wechat.onebot?.server?.path ?? '/ws'}`);
const replayTimer = setInterval(() => {
  for (const key of buffer.keys()) engine.replay(key);
  for (const key of memberBuffer.keys()) memberEngine.replay(key);
}, 30000);
const noticeDelivery=createAssistantNoticeDelivery({adapter,plugin,settingsFor:()=>selectedWechat(projectRoot,config.search_policy_file?JSON.parse(fs.readFileSync(config.search_policy_file,'utf8').replace(/^\uFEFF/,'' )).wechat:wechat),isReady:()=>connection.ready&&asyncReady(),log});
const assistantNoticeTimer=setInterval(()=>void noticeDelivery.tick(),5000);
const proactiveTimer=setInterval(()=>void proactive.tick(),60000);void proactive.tick();
const contextTimer = setInterval(() => void contextMaintenance.tick(), 30000); void contextMaintenance.tick();
const stop = async () => { clearInterval(contextTimer);contextMaintenance.stop();clearInterval(proactiveTimer);noticeDelivery.stop();clearInterval(replayTimer);clearInterval(assistantNoticeTimer); connection.stop();memberConnection.stop();engine.stop();memberEngine.stop(); await adapter.stop(); historyStore.close(); process.exit(0); };
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
