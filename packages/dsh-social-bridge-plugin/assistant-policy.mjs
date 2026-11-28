import { validChatKey, parseChatKey, validUserId, allowedConversation } from '../wechat-identity.mjs';

export const ASSISTANT_ACCESS = Symbol.for('wechatagent.assistant-access.v1');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateAssistantSettings(wechat) {
  const value = wechat?.assistant;
  if (value === undefined) return;
  if (
    !plain(value) ||
    Object.keys(value).some(
      key => !['administrators', 'adminOnlyGroups', 'fileTransferChats', 'replayOffline'].includes(key),
    ) ||
    (value.replayOffline !== undefined && typeof value.replayOffline !== 'boolean') ||
    (value.administrators !== undefined &&
      (!Array.isArray(value.administrators) ||
        value.administrators.length > 50 ||
        !value.administrators.every(validUserId) ||
        new Set(value.administrators).size !== value.administrators.length)) ||
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
