import { randomUUID } from 'node:crypto';
// The wire ID and the authorization subject are the account's exact WeChat username.
export const validGroupId = id => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,200}@chatroom$/u.test(id);
export const validUserId = id =>
  typeof id === 'string' && /^[^\s:\x00-\x1f\x7f/\\<>"|?*]{1,256}$/u.test(id) && !id.endsWith('@chatroom');
export const validChatId = (kind, id) => (kind === 'group' ? validGroupId(id) : kind === 'private' && validUserId(id));

export function parseChatKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== 'wechat' || !validChatId(parts[1], parts[2])) return null;
  return { kind: parts[1], id: parts[2] };
}

export const validChatKey = key => parseChatKey(key) !== null;
export function allowedConversation(wechat, key) {
  const chat = parseChatKey(key);
  return !!chat && (wechat?.whitelist?.[chat.kind === 'group' ? 'groups' : 'private'] ?? []).includes(chat.id);
}

export function conversationGrant(wechat, key) {
  if (!allowedConversation(wechat, key)) return null;
  return wechat.rosterGrants?.[key] ?? 'legacy';
}

// Save alongside the whitelist. The caller's older settings draft cannot
// restore a withdrawn grant by copying its previous token.
export function reconcileRosterGrants(previous, next) {
  const grants = {};
  for (const [kind, list] of [
    ['private', next.whitelist.private],
    ['group', next.whitelist.groups],
  ]) {
    for (const id of list) {
      const key = `wechat:${kind}:${id}`;
      const grant = conversationGrant(previous, key);
      if (grant !== 'legacy') grants[key] = grant ?? randomUUID();
    }
  }
  if (Object.keys(grants).length) next.rosterGrants = grants;
  else delete next.rosterGrants;
}
