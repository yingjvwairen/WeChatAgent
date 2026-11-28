import { validChatKey, allowedConversation } from '../wechat-identity.mjs';
import crypto from 'node:crypto';

export const CONTEXT_DEFAULTS = Object.freeze({ enabled: false, maxTokens: 100000, idleSeconds: 60 });
const validLimit = value => Number.isSafeInteger(value) && value >= 4000 && value <= 2000000;

export function validateContextSettings(settings) {
  if (settings === undefined) return;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('context settings invalid');
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') throw Error('context enabled invalid');
  if (settings.maxTokens !== undefined && !validLimit(settings.maxTokens))
    throw Error('context maxTokens must be 4000–2000000');
  if (
    settings.idleSeconds !== undefined &&
    (!Number.isSafeInteger(settings.idleSeconds) || settings.idleSeconds < 15 || settings.idleSeconds > 3600)
  )
    throw Error('context idleSeconds must be 15–3600');
  if (
    settings.chats !== undefined &&
    (!settings.chats ||
      typeof settings.chats !== 'object' ||
      Array.isArray(settings.chats) ||
      Object.entries(settings.chats).some(([key, value]) => !validChatKey(key) || (value !== 0 && !validLimit(value))))
  )
    throw Error('context chat override invalid');
}

export function contextPolicy(wechat, key) {
  const settings = wechat.context ?? {};
  validateContextSettings(settings);
  const limit = settings.chats?.[key] ?? settings.maxTokens ?? CONTEXT_DEFAULTS.maxTokens;
  const allowed = allowedConversation(wechat, key);
  return {
    enabled: !!allowed && settings.enabled === true && limit !== 0,
    maxTokens: limit,
    idleSeconds: settings.idleSeconds ?? CONTEXT_DEFAULTS.idleSeconds,
  };
}

export const contextBufferVersion = rows => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
export function contextRowsIdle(rows, idleSeconds, now = Date.now()) {
  if (!Array.isArray(rows) || rows.some(row => !row.outgoing && !row.processed)) return false;
  if (rows.at(-1)?.delivery_status === 'unconfirmed') return false;
  const last = Math.max(0, ...rows.map(row => Number(row.timestamp) * 1000));
  return Number.isFinite(last) && now - last >= idleSeconds * 1000;
}
