import { featurePlugins } from '../../../packages/plugin-api/catalog.mjs';
import { writeVoiceAttempt } from '../../../packages/plugin-api/voice-status.mjs';
import { VoiceIngress } from './core/voice-ingress.js';
import { boundedTask } from '../../../packages/dsh-social-bridge-plugin/deadline.mjs';
import { validReaderOrder } from '../../../packages/wechat-identity.mjs';
import { replyMessageLimit } from '../../../packages/dsh-social-bridge-plugin/reply-layout-policy.mjs';
import { AssistantFeedback } from '../../../packages/dsh-social-bridge-plugin/assistant-feedback.mjs';
import { createAssistantNoticeDelivery } from './core/assistant-notice-delivery.js';
import fs from 'node:fs';
import path from 'node:path';
import { WechatOneBotAdapter } from './adapters/wechat/wechat-onebot-adapter.js';
import { MessageBuffer } from './core/message-buffer.js';
import { DshConnectionGuard } from './core/dsh-connection.js';
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
import { historyScopeKey, scopeHistory } from '../../../packages/dsh-social-bridge-plugin/work-modes.mjs';
import { activeReaderAccount, assistantChatBufferFile } from '../../../scripts/reader-account-state.mjs';
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
const readerAccountIsCurrent = () => {
  const live = activeReaderAccount(historyRoot);
  return live.id === historyAccount.id && (live.id !== '' || live.legacyId === historyAccount.legacyId);
};
const baseHistoryStore = new HistoryStore(historyRoot, historyAccount.id || historyAccount.legacyId);
const historyStore = scopeHistory(baseHistoryStore, (_key, row) => row?.work_mode ?? 'social');
const historyArchive = {
  backfill: (...args) => historyStore.backfill(...args),
  append: (...args) => {
    if (!readerAccountIsCurrent()) throw Error('ACCOUNT_SWITCH_REQUIRES_BRIDGE_RESTART');
    return historyStore.append(...args);
  },
};
const buffer = new MessageBuffer(path.resolve(root, config.message_buffer?.path ?? 'state/social-messages.json'), {
  maxPerChat: config.message_buffer?.max_messages_per_chat ?? 300,
  archive: historyArchive,
  readerAccount: historyAccount.id,
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
  naturalGroupWakeEpoch,
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
const deliveryControls = new ReplyDeliveryControls(
  historyRoot,
  historyAccount.id || historyAccount.legacyId || 'legacy',
);
const engine = new SocialEngine({
  buffer,
  connection,
  roleFor: key => personaFor(key).persona,
  deliveryControls,
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
  naturalGroupEpochFor: key => naturalGroupWakeEpoch(currentWechat(), key),
  batchMs: config.social?.batch_ms ?? 3000,
  minIntervalMs: config.social?.min_interval_ms ?? 15000,
  privateMinIntervalMs: config.social?.private_min_interval_ms ?? 1000,
  maxPerMinute: config.social?.max_per_minute ?? 3,
  maxPerTenMinutes: config.social?.max_per_ten_minutes ?? 10,
  decide: (...args) => plugin.followup(...args),
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
  prepareVoiceRows: (...args) => voiceIngress.prepareRows(...args),
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
    if (!readerAccountIsCurrent()) throw Error('ACCOUNT_SWITCH_REQUIRES_BRIDGE_RESTART');
    return memberHistory.append(...args);
  },
};
const memberBuffer = new MessageBuffer(assistantChatBufferFile(historyRoot, historyAccount), {
  maxPerChat: buffer.maxPerChat,
  archive: memberArchive,
  readerAccount: historyAccount.id,
});
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
const proactiveState = path.resolve(config.proactive_state_file ?? path.join(root, 'state/proactive/state.json'));
const proactiveOptions = {
  settingsFor: () =>
    config.proactive_policy_file
      ? JSON.parse(fs.readFileSync(config.proactive_policy_file, 'utf8').replace(/^\uFEFF/, ''))
      : { wechat },
  personaFor,
  decide: (...args) => plugin.followup(...args),
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
};
const proactive = new ProactiveEngine({ ...proactiveOptions, stateFile: proactiveState, buffer, social: engine });
const assistantProactive = new ProactiveEngine({
  ...proactiveOptions,
  stateFile: proactiveState + '.assistant-chat.json',
  buffer: memberBuffer,
  social: memberEngine,
  taskContext: { buffer, social: engine },
  isReady: () => proactiveOptions.isReady() && memberConnection.ready,
});
const contextMaintenance = new ContextMaintenance({
  buffer,
  social: engine,
  settingsFor: () =>
    config.context_policy_file
      ? JSON.parse(fs.readFileSync(config.context_policy_file, 'utf8').replace(/^\uFEFF/, ''))
      : { wechat },
  maintain: (key, version) =>
    boundedTask(signal => plugin.maintainContext(key, version, { signal, ...connection.metadata() }), {
      signal: connection.signal,
    }),
  proactivePending: key => !!(proactive.state.chats[key]?.job || assistantProactive.state.chats[key]?.job),
  isReady: () => connection.ready && adapter.stats.connected && !!adapter.selfId,
  log,
});

const voicePluginsFor = message =>
  featurePlugins(
    historyRoot,
    'voice-input-v1',
    buildConversationKey(message.platform, message.kind, message.conversation_id),
  );
const sameVoicePlugin = (first, second) => first.id === second.id && first.generation === second.generation;
const voiceIngress = new VoiceIngress({
  // Report the attempt against the settings generation that supplied it.
  generationFor: voicePluginsFor,
  onResult: (message, result, plugins) => {
    const current = voicePluginsFor(message);
    for (const item of plugins)
      if ((!result.plugin || result.plugin === item.id) && current.some(plugin => sameVoicePlugin(plugin, item)))
        writeVoiceAttempt(historyRoot, item.id, result, item.generation);
  },
  recognize: (message, options) =>
    plugin.recognizeVoice(
      buildConversationKey(message.platform, message.kind, message.conversation_id),
      message.voice,
      verifiedAssistantSender(message),
      { ...options, rosterGrant: message.readerGrant },
    ),
  canRecognize(message, providers = []) {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    if (!readerAccountIsCurrent() || conversationGrant(currentWechat(), key) !== message.readerGrant) return false;
    const current = voicePluginsFor(message);
    return current.length > 0 && providers.every(provider => current.some(plugin => sameVoicePlugin(plugin, provider)));
  },
  log,
});
function hasReceivedInput(key, message) {
  return (
    buffer.confirmBuffered(message) ||
    memberBuffer.confirmBuffered(message) ||
    ['social', 'assistant', 'assistant-chat'].some(mode =>
      baseHistoryStore.hasIncoming(historyScopeKey(key, mode), message),
    )
  );
}
adapter.onMessage(message => {
  void routeIncoming(message);
});
adapter.acceptPersisted = async (message, intake) => {
  const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
  if (!readerAccountIsCurrent()) return false;
  if (historyAccount.id && intake.account !== historyAccount.id) return false;
  const live = currentWechat();
  if (conversationGrant(live, key) !== intake.grant) return true;
  if (hasReceivedInput(key, message)) return true;
  if (intake.offlineReplay !== undefined && !['context', 'reply'].includes(intake.offlineReplay)) return false;
  const scoped = {
    ...message,
    readerReplay: intake.offlineReplay,
    readerGrant: intake.grant,
    readerRole: intake.readerRole,
    ...(validReaderOrder(intake.order) ? { readerOrder: intake.order } : {}),
  };
  if (!applyReplayPolicy(scoped, key, live)) return true;
  return (await routeIncoming(scoped)) === true;
};
function applyReplayPolicy(message, key, live) {
  if (!message.readerReplay) return true;
  const assistant = conversationWorkMode(live, key) === 'assistant';
  const currentRole = assistant
    ? assistantSenderAllowed(live, key, verifiedAssistantSender(message))
      ? 'assistant-admin'
      : 'assistant-member'
    : 'social';
  // Never move an event recorded in one role into another role's history.
  if (message.readerRole && message.readerRole !== currentRole) return false;
  if (assistant) message.readerReplay = 'context';
  return true;
}

async function routeIncoming(message) {
  try {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    if (!readerAccountIsCurrent()) return false;
    let live = currentWechat();
    const grant = conversationGrant(live, key);
    if (!grant || (message.readerGrant !== undefined && message.readerGrant !== grant)) {
      log('[WeChat] denied ' + key);
      return true;
    }
    message = { ...message, readerGrant: grant };
    log('[WeChat] accepted ' + key);
    const memberLaneFor = settings =>
      message.kind === 'group' &&
      conversationWorkMode(settings, key) === 'assistant' &&
      (!assistantSenderAllowed(settings, key, verifiedAssistantSender(message)) ||
        assistantChatRequest(message, wechat.wake_words ?? []));
    let memberLane;
    for (let attempt = 0; attempt < 2; attempt++) {
      memberLane = memberLaneFor(live);
      await (memberLane ? memberConnection : connection).check({ force: true });
      if (!readerAccountIsCurrent()) {
        log('[WeChat] account_changed_before_intake ' + key);
        return false;
      }
      live = currentWechat();
      if (conversationGrant(live, key) !== grant) return true;
      if (memberLane === memberLaneFor(live)) break;
    }
    // Let durable intake retry if the role changed again during the second probe.
    if (memberLane !== memberLaneFor(live)) return false;
    if (hasReceivedInput(key, message)) {
      log('[WeChat] ' + key + ' duplicate_routed_input_ignored');
      return true;
    }
    if (!applyReplayPolicy(message, key, live)) return true;
    // Queue the reply or start the local command before writing the archive.
    // If the archive write fails, intake retries it without rerunning the command.
    if (memberLane) memberEngine.receive({ ...message, assistant_chat_only: true }, { deferArchive: true });
    else engine.receive(message, { deferArchive: true });
    if ((memberLane ? memberBuffer : buffer).confirmBuffered(message)) return true;
    if (message.kind === 'private' && engine.workModeFor(key) === 'assistant' && !engine.assistantAllowed(key, message))
      return true;
    return false;
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
const archiveRecovery = new AbortController();
const replayTimer = setInterval(() => {
  for (const store of [buffer, memberBuffer])
    void store
      .retryPendingArchives({ signal: archiveRecovery.signal, isCurrent: readerAccountIsCurrent })
      .then(failures => {
        if (failures) log('[Social] archive_retry_pending count=' + failures);
      })
      .catch(error => log('[Social] archive_retry_failed code=' + (error?.code ?? 'STATE_UNAVAILABLE')));
  for (const key of buffer.keys()) engine.replay(key);
  for (const key of memberBuffer.keys()) memberEngine.replay(key);
}, 30000);
const noticeDelivery = createAssistantNoticeDelivery({
  adapter,
  plugin,
  deliveryControls,
  settingsFor: () => currentWechat(),
  isReady: () => connection.ready,
  log,
});
const assistantNoticeTimer = setInterval(() => void noticeDelivery.tick(), 5000);
const tickProactive = () => {
  void proactive.tick();
  void assistantProactive.tick();
};
const proactiveTimer = setInterval(tickProactive, 60000);
tickProactive();
const contextTimer = setInterval(() => void contextMaintenance.tick(), 30000);
void contextMaintenance.tick();
const stop = async () => {
  archiveRecovery.abort();
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
