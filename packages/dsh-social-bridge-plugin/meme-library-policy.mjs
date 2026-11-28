import { allowedConversation, validChatKey } from '../wechat-identity.mjs';
export const MEME_LIBRARY_POLICY = Symbol.for('wechatagent.meme-library.v1');
export function memeLibraryPolicy(wechat, key) {
  const settings = wechat?.memeLibrary ?? {},
    allowed = allowedConversation(wechat, key);
  return {
    enabled:
      allowed &&
      (settings.chats?.[key] ?? settings.enabled ?? false) === true &&
      (wechat.stickers?.chats?.[key] ?? wechat.stickers?.enabled ?? true) === true,
    allowImport: settings.allowImport === true,
  };
}
export function validateMemeLibrarySettings(settings) {
  if (settings === undefined) return;
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some(key => !['enabled', 'allowImport', 'chats'].includes(key))
  )
    throw Error('Invalid meme library settings');
  for (const key of ['enabled', 'allowImport'])
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw Error('Invalid meme library switch');
  if (
    settings.chats !== undefined &&
    (!settings.chats ||
      typeof settings.chats !== 'object' ||
      Array.isArray(settings.chats) ||
      Object.entries(settings.chats).some(([key, value]) => !validChatKey(key) || typeof value !== 'boolean'))
  )
    throw Error('Invalid meme library chat settings');
}
