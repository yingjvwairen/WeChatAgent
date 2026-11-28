import { parseChatKey, validUserId, allowedConversation } from '../wechat-identity.mjs';

export const ASSISTANT_ACCESS = Symbol.for('wechatagent.assistant-access.v1');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validAdministrators = value =>
  Array.isArray(value) && value.length <= 50 && value.every(validUserId) && new Set(value).size === value.length;
export function validateAssistantSettings(wechat) {
  const value = wechat?.assistant;
  if (value === undefined) return;
  if (
    !plain(value) ||
    // Accept retired options when reading old account data.
    Object.keys(value).some(
      key =>
        !['administrators', 'adminOnlyGroups', 'fileTransferChats', 'replayOffline', 'replayAuthorization'].includes(
          key,
        ),
    ) ||
    (value.administrators !== undefined && !validAdministrators(value.administrators)) ||
    (value.adminOnlyGroups !== undefined &&
      (!plain(value.adminOnlyGroups) ||
        Object.entries(value.adminOnlyGroups).some(
          ([key, on]) => parseChatKey(key)?.kind !== 'group' || typeof on !== 'boolean',
        )))
  )
    throw Error('助手模式管理员设置无效：请使用真实微信 ID，最多 50 位；群管理员模式必须为开关值。');
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
export function scheduledAssistantChatAllowed(wechat, key) {
  const chat = parseChatKey(key);
  return (
    !!chat &&
    wechat?.workModes?.[key] === 'assistant' &&
    wechat.proactive?.enabled === true &&
    wechat.proactive.assistantChats?.[key] === true &&
    (chat.kind === 'group' ? assistantGroupChatAllowed(wechat, key) : assistantSenderAllowed(wechat, key, chat.id))
  );
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
