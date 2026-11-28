import { parseChatKey, allowedConversation } from '../wechat-identity.mjs';
export const MEMBER_MEMORY_POLICY = Symbol.for('wechatagent.member-memory.v1');
export const MEMBER_TAGS = Object.freeze([
  '爱玩梗',
  '表达简短',
  '偏好详细解释',
  '表达直接',
  '语气温和',
  '喜欢提问',
  '乐于分享',
  '喜欢接话',
  '认真讨论',
]);
export function memberMemoryEnabled(wechat, key) {
  return (
    parseChatKey(key)?.kind === 'group' &&
    allowedConversation(wechat, key) &&
    (wechat.memberMemory?.chats?.[key] ?? wechat.memberMemory?.enabled ?? true) === true
  );
}
export function validateMemberMemory(settings) {
  if (settings === undefined) return;
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some(key => !['enabled', 'chats'].includes(key))
  )
    throw Error('Invalid member memory settings');
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean')
    throw Error('Invalid member memory switch');
  if (
    settings.chats !== undefined &&
    (!settings.chats ||
      typeof settings.chats !== 'object' ||
      Array.isArray(settings.chats) ||
      Object.entries(settings.chats).some(
        ([key, value]) => parseChatKey(key)?.kind !== 'group' || typeof value !== 'boolean',
      ))
  )
    throw Error('Invalid member memory chat settings');
}
