import { isDeepStrictEqual } from 'node:util';
import {
  validChatKey,
  parseChatKey,
  validUserId,
  allowedConversation,
  conversationGrant,
} from '../wechat-identity.mjs';

export const ASSISTANT_ACCESS = Symbol.for('wechatagent.assistant-access.v1');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validAdministrators = value =>
  Array.isArray(value) && value.length <= 50 && value.every(validUserId) && new Set(value).size === value.length;
const validReplayAuthorization = value =>
  plain(value) &&
  Object.keys(value).length === 3 &&
  Number.isSafeInteger(value.since) &&
  value.since > 0 &&
  validAdministrators(value.administrators) &&
  plain(value.chats) &&
  Object.entries(value.chats).every(
    ([key, grant]) => validChatKey(key) && typeof grant === 'string' && grant.length > 0 && grant.length <= 64,
  );

export function validateAssistantSettings(wechat) {
  const value = wechat?.assistant;
  if (value === undefined) return;
  if (
    !plain(value) ||
    Object.keys(value).some(
      key =>
        !['administrators', 'adminOnlyGroups', 'fileTransferChats', 'replayOffline', 'replayAuthorization'].includes(
          key,
        ),
    ) ||
    (value.replayOffline !== undefined && typeof value.replayOffline !== 'boolean') ||
    (value.administrators !== undefined && !validAdministrators(value.administrators)) ||
    (value.replayAuthorization !== undefined && !validReplayAuthorization(value.replayAuthorization)) ||
    (value.fileTransferChats !== undefined &&
      (!plain(value.fileTransferChats) ||
        Object.entries(value.fileTransferChats).some(([key, on]) => !validChatKey(key) || typeof on !== 'boolean'))) ||
    (value.adminOnlyGroups !== undefined &&
      (!plain(value.adminOnlyGroups) ||
        Object.entries(value.adminOnlyGroups).some(
          ([key, on]) => parseChatKey(key)?.kind !== 'group' || typeof on !== 'boolean',
        )))
  )
    throw Error('助手模式管理员设置无效：请使用真实微信 ID，最多 50 位；群管理员模式必须为开关值。');
}

// The console stamps the earliest eligible second after saving the policy.
// Retain it across unrelated saves, including a change in administrator order.
export function reconcileAssistantReplay(previous, next, now = Date.now()) {
  const assistant = next.assistant;
  if (!assistant) return;
  if (assistant.replayOffline !== true) {
    delete assistant.replayAuthorization;
    return;
  }
  const administrators = [...(assistant.administrators ?? [])].sort();
  const chats = Object.fromEntries(
    Object.entries(next.workModes ?? {})
      .filter(([key, mode]) => mode === 'assistant' && allowedConversation(next, key))
      .map(([key]) => [key, conversationGrant(next, key)]),
  );
  const old = previous.assistant?.replayAuthorization;
  const oldSince = validReplayAuthorization(old) ? old.since : 0;
  const unchanged =
    previous.assistant?.replayOffline === true &&
    oldSince > 0 &&
    isDeepStrictEqual(old.administrators, administrators) &&
    isDeepStrictEqual(old.chats, chats);
  const since = unchanged ? oldSince : Math.max(Math.floor(now / 1000) + 1, oldSince);
  assistant.replayAuthorization = { since, administrators, chats };
}

export function assistantReplayAllowed(wechat, key, timestamp) {
  const assistant = wechat?.assistant;
  const authorization = assistant?.replayAuthorization;
  const grant = conversationGrant(wechat, key);
  return (
    assistant?.replayOffline === true &&
    wechat.workModes?.[key] === 'assistant' &&
    validReplayAuthorization(authorization) &&
    !!grant &&
    authorization.chats[key] === grant &&
    Number.isSafeInteger(timestamp) &&
    timestamp >= authorization.since &&
    isDeepStrictEqual(authorization.administrators, [...(assistant.administrators ?? [])].sort())
  );
}

// Kept for old settings/readers. Legacy false values never grant execution.
export const assistantAdminOnly = () => true;
export const assistantAdministrator = (wechat, wxid) =>
  validUserId(wxid) && (wechat?.assistant?.administrators ?? []).includes(wxid);
export function assistantSenderAllowed(wechat, key, wxid) {
  validateAssistantSettings(wechat);
  const chat = parseChatKey(key);
  return (
    allowedConversation(wechat, key) &&
    (chat.kind === 'group' || chat.id === wxid) &&
    assistantAdministrator(wechat, wxid)
  );
}
export const assistantDeliveryAllowed = (wechat, key, wxid) =>
  wechat?.workModes?.[key] === 'assistant' && assistantSenderAllowed(wechat, key, wxid);

// A missing trusted identity may chat in an allowed group, but can never work.
export function assistantGroupChatAllowed(wechat, key, wxid = '') {
  validateAssistantSettings(wechat);
  return parseChatKey(key)?.kind === 'group' && allowedConversation(wechat, key) && (wxid === '' || validUserId(wxid));
}
// The authenticated reader supplies this identity. Never derive it from text,
// a nickname, a quoted author or the model's claimed identity.
export function verifiedAssistantSender(message) {
  const wxid = message?.sender_wxid;
  if (message?.platform !== 'wechat' || !validUserId(wxid)) return '';
  return message.sender_id === wxid &&
    (message.kind === 'group' || (message.kind === 'private' && message.conversation_id === wxid))
    ? wxid
    : '';
}
export function assistantControlAllowed(wechat, key, sender, owner, { running = false } = {}) {
  return (
    assistantSenderAllowed(wechat, key, sender) &&
    (!running || assistantAdministrator(wechat, sender) || (validUserId(owner) && owner === sender))
  );
}
