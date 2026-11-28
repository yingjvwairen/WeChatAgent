import { featurePlugins } from '../../../packages/plugin-api/catalog.mjs';
import { writeVoiceAttempt } from '../../../packages/plugin-api/voice-status.mjs';
import { VoiceIngress } from './core/voice-ingress.js';
import { replyMessageLimit } from '../../../packages/dsh-social-bridge-plugin/reply-layout-policy.mjs';
import { AssistantFeedback } from '../../../packages/dsh-social-bridge-plugin/assistant-feedback.mjs';
import { createAssistantNoticeDelivery } from './core/assistant-notice-delivery.js';
import fs from 'node:fs';
import path from 'node:path';
import { WechatOneBotAdapter } from './adapters/wechat/wechat-onebot-adapter.js';
import { MessageBuffer } from './core/message-buffer.js';
import { DshConnectionGuard, acceptsReaderMessage } from './core/dsh-connection.js';
import { SocialEngine, assistantChatRequest } from './core/social-engine.js';
import { DshPluginClient } from './dsh/plugin-client.js';
import { buildConversationKey } from './core/conversation-key.js';
import { selectRoleText } from './role-card.js';
import { socialPersona } from './core/social-persona.js';
import { stickerPolicy } from './core/sticker-policy.js';
import { searchPolicy } from '../../../packages/dsh-social-bridge-plugin/search-policy.mjs';
import { ProactiveEngine } from './core/proactive-engine.js';
import { ContextMaintenance } from './core/context-maintenance.js';
import { HistoryStore } from '../../../packages/dsh-social-bridge-plugin/history-store.mjs';
import { scopeHistory } from '../../../packages/dsh-social-bridge-plugin/work-modes.mjs';
import { activeReaderAccount } from '../../../scripts/reader-account-state.mjs';
import { ReplyDeliveryControls } from '../../../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.resolve(process.argv[2] ?? path.join(root, 'config.social.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const wechat = config.platforms?.wechat ?? config.wechat ?? {};
if (wechat.enabled !== true) throw new Error('wechat.enabled must be true in config.social.json');
const allowedGroups = new Set(wechat.whitelist?.groups ?? []);
const allowedPrivate = new Set(wechat.whitelist?.private ?? []);
const sendPrivateTest = process.argv.slice(3).includes('--test-private');
if (sendPrivateTest && (allowedGroups.size !== 0 || allowedPrivate.size !== 1)) {
  throw new Error('private test requires exactly one allowed friend and an empty group whitelist');
}
if (allowedGroups.size + allowedPrivate.size === 0)
  console.warn('[Social] WeChat whitelist is empty; all messages will be denied');
const log = line => console.log(new Date().toISOString(), line);
const historyRoot = path.resolve(
  config.project_root ??
    (config.search_policy_file ? path.dirname(path.dirname(config.search_policy_file)) : path.resolve(root, '../..')),
);
const historyAccount = activeReaderAccount(historyRoot);
const baseHistoryStore = new HistoryStore(historyRoot, historyAccount.id || historyAccount.legacyId);
const historyStore = scopeHistory(baseHistoryStore, (_key, row) => row?.work_mode ?? 'social');
const historyArchive = {
  backfill: (...args) => historyStore.backfill(...args),
  append: (...args) => {
    if (activeReaderAccount(historyRoot).id !== historyAccount.id)
      throw Error('ACCOUNT_SWITCH_REQUIRES_BRIDGE_RESTART');
    return historyStore.append(...args);
  },
};
const buffer = new MessageBuffer(path.resolve(root, config.message_buffer?.path ?? 'state/social-messages.json'), {
  maxPerChat: config.message_buffer?.max_messages_per_chat ?? 300,
  archive: historyArchive,
});
const plugin = new DshPluginClient(
  {
    ...config.dsh_plugin,
    feedback: new AssistantFeedback({
      root: path.resolve(
        config.project_root ??
          (config.search_policy_file
            ? path.dirname(path.dirname(config.search_policy_file))
            : path.resolve(root, '../..')),
      ),
    }),
  },
  log,
);
import {
  assistantSenderAllowed,
  assistantGroupChatAllowed,
  verifiedAssistantSender,
} from '../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {
  conversationGrant,
  conversationMode,
  conversationWorkMode,
} from '../../../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
const currentWechat = () =>
  config.search_policy_file
    ? JSON.parse(fs.readFileSync(config.search_policy_file, 'utf8').replace(/^\uFEFF/, '')).wechat
    : wechat;
const workModeFor = key => conversationWorkMode(currentWechat(), key);
const modeFor = key => conversationMode(currentWechat(), key);
const searchPolicyFor = key => searchPolicy(currentWechat(), key);
const searchStateFor = async message => {
  const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
  if (!searchPolicyFor(key).enabled) return null;
  return (await plugin.modelSearchReady())
    ? { status: 'model' }
    : {
        status: 'unavailable',
        message: '联网搜索已开启，但 DSH 网页搜索拓展未就绪，请在本机完整退出 DSH 后重新启动。',
      };
};
const adapter = new WechatOneBotAdapter(
  { server: { host: '127.0.0.1', ...(wechat.onebot?.server ?? {}), token: process.env.SOCIAL_ONEBOT_TOKEN ?? '' } },
  log,
);
const personaFor = key =>
  socialPersona(config, key, roleName => {
    if (!/^[^\\/\0.][^\\/\0]{0,60}$/.test(roleName) || roleName.includes('..')) throw new Error('invalid role name');
    return selectRoleText(fs.readFileSync(path.join(root, 'roles', `${roleName}.md`), 'utf8'), 'v2');
  });
const connection = new DshConnectionGuard({
  buffer,
  probe: () => plugin.connectionHealth({ projectRoot: historyRoot, accountScope: historyAccount.id }),
  log,
});
const deliveryTarget = message => ({
  kind: message.kind,
  target: message.conversation_id,
  rosterGrant: message.readerGrant,
});
const engine = new SocialEngine({
  buffer,
  connection,
  roleFor: key => personaFor(key).persona,
  deliveryControls: new ReplyDeliveryControls(historyRoot, historyAccount.id || historyAccount.legacyId || 'legacy'),
  personaNameFor: key => personaFor(key).personaName,
  workModeFor,
  assistantControl: (key, action, message, command) =>
    plugin.assistantTask(key, action, {
      ...command,
      senderWxid: verifiedAssistantSender(message),
      rosterGrant: message.readerGrant,
    }),
  assistantAccess: (key, message) => {
    const wechat = currentWechat();
    return (
      (message.readerGrant === undefined || conversationGrant(wechat, key) === message.readerGrant) &&
      assistantSenderAllowed(wechat, key, verifiedAssistantSender(message))
    );
  },
  wakeWords: wechat.wake_words ?? [],
  mode: wechat.wake_mode ?? 'hybrid',
  modeFor,
  batchMs: config.social?.batch_ms ?? 3000,
  minIntervalMs: config.social?.min_interval_ms ?? 15000,
  privateMinIntervalMs: config.social?.private_min_interval_ms ?? 1000,
  maxPerMinute: config.social?.max_per_minute ?? 3,
  maxPerTenMinutes: config.social?.max_per_ten_minutes ?? 10,
  decide: (key, prompt, metadata) => plugin.followup(key, prompt, metadata),
  modelSearchReady: () => plugin.modelSearchReady(),
  searchFor: searchStateFor,
  searchPolicyFor: message =>
    searchPolicyFor(buildConversationKey(message.platform, message.kind, message.conversation_id)),
  stickerChoicesFor: message =>
    adapter.stickerChoices({ kind: message.kind, target: message.conversation_id, query: message.text }),
  notebookEnabledFor: key => featurePlugins(historyRoot, 'diary-question-v1', key).length > 0,
  maxTextPartsFor: () =>
    replyMessageLimit(
      JSON.parse(fs.readFileSync(path.join(historyRoot, 'config/wechatagent.json'), 'utf8').replace(/^\uFEFF/, ''))
        .wechat,
    ),
  stickerPolicyFor: message =>
    stickerPolicy(
      config.sticker_policy_file
        ? JSON.parse(fs.readFileSync(config.sticker_policy_file, 'utf8').replace(/^\uFEFF/, '')).wechat
        : wechat,
      buildConversationKey(message.platform, message.kind, message.conversation_id),
    ),
  stickerLabelsFor: (message, ids) =>
    adapter.stickerLabels({ kind: message.kind, target: message.conversation_id, ids }),
  saveStickerLabels: (message, labels) =>
    adapter.saveStickerLabels({ kind: message.kind, target: message.conversation_id, labels }),
  sendSticker: (message, id, options) => adapter.sendSticker({ ...deliveryTarget(message), id, ...options }),
  inspectReceipt: (message, part) => adapter.inspectReplyReceipt(message, part),
  sendVoice: (message, text, options) =>
    adapter.sendVoiceText({
      ...deliveryTarget(message),
      text,
      deliveryId: options?.deliveryId,
      receiptOnly: options?.receiptOnly,
    }),
  voiceReplyFor: message => adapter.voiceCapability(deliveryTarget(message)).then(result => result.voice === true),
  send: (message, text, options) =>
    adapter.sendText({
      ...deliveryTarget(message),
      text,
      ...options,
    }),
  log,
});
const memberSettings = currentWechat;
const memberHistory = scopeHistory(baseHistoryStore, () => 'assistant-chat', { fixedMode: 'assistant-chat' });
const memberArchive = {
  backfill: (...args) => memberHistory.backfill(...args),
  append: (...args) => {
    if (activeReaderAccount(historyRoot).id !== historyAccount.id)
      throw Error('ACCOUNT_SWITCH_REQUIRES_BRIDGE_RESTART');
    return memberHistory.append(...args);
  },
};
const memberBuffer = new MessageBuffer(
  path.join(
    historyRoot,
    'state/accounts',
    historyAccount.id || historyAccount.legacyId || 'legacy',
    'assistant-group-chat.json',
  ),
  { maxPerChat: buffer.maxPerChat, archive: memberArchive },
);
const memberConnection = new DshConnectionGuard({
  buffer: memberBuffer,
  probe: () => plugin.connectionHealth({ projectRoot: historyRoot, accountScope: historyAccount.id }),
  log,
});
const memberEngine = engine.createGroupChat({
  buffer: memberBuffer,
  connection: memberConnection,
  assistantAccess: (key, message) =>
    conversationWorkMode(memberSettings(), key) === 'assistant' &&
    assistantGroupChatAllowed(memberSettings(), key, verifiedAssistantSender(message)),
});
const proactive = new ProactiveEngine({
  stateFile: path.resolve(config.proactive_state_file ?? path.join(root, 'state/proactive/state.json')),
  buffer,
  social: engine,
  settingsFor: () =>
    config.proactive_policy_file
      ? JSON.parse(fs.readFileSync(config.proactive_policy_file, 'utf8').replace(/^\uFEFF/, ''))
      : { wechat },
  personaFor,
  decide: (key, prompt, metadata) => plugin.followup(key, prompt, metadata),
  searchFor: searchStateFor,
  send: (message, text, options) =>
    adapter.sendText({
      ...deliveryTarget(message),
      text,
      ...options,
    }),
  isReady: () => connection.ready && adapter.stats.connected && !!adapter.selfId,
  selfIdFor: () => adapter.selfId,
  log,
});
const contextMaintenance = new ContextMaintenance({
  buffer,
  social: engine,
  settingsFor: () =>
    config.context_policy_file
      ? JSON.parse(fs.readFileSync(config.context_policy_file, 'utf8').replace(/^\uFEFF/, ''))
      : { wechat },
  maintain: (key, version) => plugin.maintainContext(key, version),
  proactivePending: key => !!proactive.state.chats[key]?.job,
  isReady: () => connection.ready && adapter.stats.connected && !!adapter.selfId,
  log,
});

const voicePluginsFor = message =>
  featurePlugins(
    historyRoot,
    'voice-input-v1',
    buildConversationKey(message.platform, message.kind, message.conversation_id),
  );
const voiceIngress = new VoiceIngress({
  // Settings generations in effect when the voice arrived. The status goes to the
  // plugin DSH reports as the handler, else to every candidate (e.g. a conflict).
  generationFor: voicePluginsFor,
  onResult: (_message, result, plugins) => {
    for (const item of plugins)
      if (!result.plugin || result.plugin === item.id) writeVoiceAttempt(historyRoot, item.id, result, item.generation);
  },
  recognize: (message, options) =>
    plugin.recognizeVoice(
      buildConversationKey(message.platform, message.kind, message.conversation_id),
      message.voice,
      verifiedAssistantSender(message),
      options,
    ),
  async canRecognize(message) {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    if (activeReaderAccount(historyRoot).id !== historyAccount.id || !voicePluginsFor(message).length) return false;
    if (!(await connection.check({ force: true })) || !acceptsReaderMessage(connection, message)) return false;
    return (
      engine.workModeFor(key) !== 'assistant' ||
      engine.assistantAllowed(key, message) ||
      (message.kind === 'group' && memberEngine.assistantAllowed(key, message))
    );
  },
  deliver: routeIncoming,
  log,
});
adapter.onMessage(message => {
  void voiceIngress.push(message).catch(() => log('[Voice] inbound_failed'));
});
adapter.acceptPersisted = async (message, intake) => {
  const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
  const current = activeReaderAccount(historyRoot);
  if ((current.id || current.legacyId) !== (historyAccount.id || historyAccount.legacyId)) return false;
  if (current.id && intake.account !== current.id) return false;
  if (conversationGrant(currentWechat(), key) !== intake.grant) return true;
  // A restarted reader may offer an already persisted voice. Check source ID
  // before contacting an ASR provider or scheduling another model request.
  const mode = engine.workModeFor(key);
  if (historyStore.hasIncoming(key, { ...message, work_mode: mode }) || memberHistory.hasIncoming(key, message))
    return true;
  if (buffer.confirmBuffered(message) || memberBuffer.confirmBuffered(message)) return true;
  if (intake.offlineReplay !== undefined && !['context', 'reply'].includes(intake.offlineReplay)) return false;
  const scoped = {
    ...message,
    readerReplay: intake.offlineReplay,
    readerGrant: intake.grant,
    readerRole: intake.readerRole,
    ...(/^\d{20}-\d{20}-[a-f0-9]{64}$/.test(intake.order ?? '') ? { readerOrder: intake.order } : {}),
  };
  if (!applyReplayPolicy(scoped, key)) return true;
  if (scoped.readerReplay === 'context') return (await routeIncoming(scoped)) === true;
  return (await voiceIngress.push(scoped)) === true;
};
function applyReplayPolicy(message, key) {
  if (!message.readerReplay) return true;
  const live = currentWechat();
  const assistant = conversationWorkMode(live, key) === 'assistant';
  const currentRole = assistant
    ? engine.assistantAllowed(key, message)
      ? 'assistant-admin'
      : 'assistant-member'
    : 'social';
  // Never move an event recorded in one role into another role's history.
  if (message.readerRole && message.readerRole !== currentRole) return false;
  if (assistant && (!live.assistant?.replayOffline || !message.readerRole)) message.readerReplay = 'context';
  return true;
}

async function routeIncoming(message) {
  try {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    const grant = conversationGrant(currentWechat(), key);
    if (!grant || (message.readerGrant !== undefined && message.readerGrant !== grant)) {
      log('[WeChat] denied ' + key);
      return true;
    }
    message = { ...message, readerGrant: grant };
    log('[WeChat] accepted ' + key);
    if (
      buffer.findIncoming(message) ||
      memberBuffer.findIncoming(message) ||
      (message.kind === 'group' &&
        engine.workModeFor(key) === 'assistant' &&
        engine.assistantAllowed(key, message) &&
        memberHistory.hasIncoming(key, message))
    ) {
      log('[WeChat] ' + key + ' duplicate_routed_input_ignored');
      return true;
    }
    const memberLane =
      message.kind === 'group' &&
      engine.workModeFor(key) === 'assistant' &&
      (!engine.assistantAllowed(key, message) || assistantChatRequest(message, wechat.wake_words ?? []));
    await (memberLane ? memberConnection : connection).check({ force: true });
    const live = currentWechat();
    if (conversationGrant(live, key) !== grant) return true;
    if (!applyReplayPolicy(message, key)) return true;
    if (memberLane) memberEngine.receive({ ...message, assistant_chat_only: true });
    else engine.receive(message);
    if (
      (message.files?.length && engine.workModeFor(key) !== 'assistant') ||
      (message.kind === 'private' && engine.workModeFor(key) === 'assistant' && !engine.assistantAllowed(key, message))
    )
      return true;
    return Boolean(buffer.findIncoming(message) || memberBuffer.findIncoming(message));
  } catch (error) {
    log(`[Social] inbound error=${error?.message ?? error}`);
  }
}
adapter.on('open', () => log('[WeChat] OneBot adapter connected'));
adapter.on('close', () => log('[WeChat] OneBot adapter disconnected'));
adapter.on('error', error => log(`[WeChat] adapter error=${error?.message ?? error}`));
if (sendPrivateTest)
  adapter.once('open', () => {
    const target = [...allowedPrivate][0];
    void adapter
      .sendText({
        kind: 'private',
        target,
        text: '这是蓝色大肥鱼的 AI 接入测试。收到后请回复“测试”，我会尝试自动回应。',
      })
      .then(result => {
        if (result.confirmed) log('[WeChat] private test confirmed by server receipt');
        else if (result.pending) log('[WeChat] private test queued, awaiting server receipt');
        else log('[WeChat] private test delivery unconfirmed');
      })
      .catch(error => log(`[WeChat] private test failed=${error?.message ?? error}`));
  });
await Promise.all([connection.check({ force: true }), memberConnection.check({ force: true })]);
connection.start();
memberConnection.start();
await adapter.start();
log(
  `[Social] reverse OneBot listening on 127.0.0.1:${wechat.onebot?.server?.port ?? 11229}${wechat.onebot?.server?.path ?? '/ws'}`,
);
const replayTimer = setInterval(() => {
  for (const key of buffer.keys()) engine.replay(key);
  for (const key of memberBuffer.keys()) memberEngine.replay(key);
}, 30000);
const noticeDelivery = createAssistantNoticeDelivery({
  adapter,
  plugin,
  settingsFor: () => currentWechat(),
  isReady: () => connection.ready,
  log,
});
const assistantNoticeTimer = setInterval(() => void noticeDelivery.tick(), 5000);
const proactiveTimer = setInterval(() => void proactive.tick(), 60000);
void proactive.tick();
const contextTimer = setInterval(() => void contextMaintenance.tick(), 30000);
void contextMaintenance.tick();
const stop = async () => {
  voiceIngress.stop();
  clearInterval(contextTimer);
  contextMaintenance.stop();
  clearInterval(proactiveTimer);
  noticeDelivery.stop();
  clearInterval(replayTimer);
  clearInterval(assistantNoticeTimer);
  connection.stop();
  memberConnection.stop();
  engine.stop();
  memberEngine.stop();
  await adapter.stop();
  historyStore.close();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
