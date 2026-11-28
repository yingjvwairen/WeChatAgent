import { validFileReference } from '../../../../packages/wechat-file-reference.mjs';
import { validChatId, validUserId } from '../../../../packages/wechat-identity.mjs';
import crypto from 'node:crypto';
import { verifiedAssistantSender } from '../../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import { normalizeForwardedRecord, normalizeQuoteReply } from '../core/wechat-events.js';

// Only native OneBot at-segments carry mention identity.
export function oneBotMentionTarget(segments, selfId) {
  let broadcast = false;
  const account = String(selfId ?? '');
  for (const segment of segments ?? []) {
    if (segment?.type !== 'at') continue;
    const target = String(segment.data?.qq ?? segment.data?.id ?? '');
    if (account && target === account) return 'self';
    if (target === 'all') broadcast = true;
  }
  return broadcast ? 'all' : null;
}

export function normalizeOneBotEvent(platform, adapter, event) {
  if (!event || (event.post_type !== 'message' && event.post_type !== undefined)) return null;
  const kind = event.message_type;
  if (kind !== 'private' && kind !== 'group') return null;
  const target = kind === 'group' ? event.group_id : event.user_id;
  const actor = event.sender?.user_id ?? event.user_id;
  if (
    platform === 'wechat' &&
    (!validChatId(kind, target) ||
      !validUserId(actor) ||
      !validUserId(event.self_id) ||
      (kind === 'group' && actor !== event.user_id) ||
      (kind === 'private' &&
        actor !== target &&
        !(event.wechatagent?.contextOnly === true && actor === 'wechat-system')))
  )
    return null;
  const conversationId = String(target ?? ''),
    senderId = String(actor ?? '');
  if (!conversationId || !senderId) return null;
  const segments =
    typeof event.message === 'string'
      ? [{ type: 'text', data: { text: event.message } }]
      : Array.isArray(event.message)
        ? event.message
        : [];
  const text = segments
    .filter(segment => segment?.type === 'text')
    .map(segment => String(segment.data?.text ?? ''))
    .join('')
    .trim();
  const types = [...new Set(segments.map(segment => segment?.type).filter(Boolean))];
  const voice =
    platform === 'wechat'
      ? segments.find(segment => {
          const data = segment?.data;
          if (
            segment?.type !== 'record' ||
            data?.forwardIndex !== undefined ||
            !/^[a-f0-9]{64}$/.test(data?.voice_id ?? '') ||
            data.file !== 'wechatagent://voice/' + data.voice_id
          )
            return false;
          const video = ['video-audio', 'quoted-video-audio'].includes(data.source);
          if (data.duration === undefined) return true;
          return Number.isFinite(data.duration) && data.duration > 0 && data.duration <= (video ? 300 : 60);
        })
      : null;
  const quoteReply = platform === 'wechat' ? normalizeQuoteReply(event.wechatagent?.quoteReply) : null;
  const forwardedRecord = platform === 'wechat' ? normalizeForwardedRecord(event.wechatagent?.forwardedRecord) : null;
  const images = segments
    .filter(
      segment =>
        segment?.type === 'image' &&
        /^[a-f0-9]{64}$/.test(segment.data?.media_id ?? '') &&
        segment.data?.file === 'wechatagent://image/' + segment.data.media_id &&
        (segment.data.forwardItem === undefined ||
          (Number.isInteger(segment.data.forwardItem) && forwardedRecord?.items[segment.data.forwardItem - 1])),
    )
    .map(segment => ({
      id: segment.data.media_id,
      ...(platform === 'wechat' && segment.data.media_kind === 'sticker' ? { kind: 'sticker' } : {}),
      ...(quoteReply && segment.data.media_quoted === true ? { quoted: true } : {}),
      ...(segment.data.forwardItem !== undefined ? { forwardItem: segment.data.forwardItem } : {}),
    }));
  const files =
    platform === 'wechat'
      ? segments
          .filter(segment => segment?.type === 'file' && validFileReference(segment.data))
          .slice(0, 3)
          .map(segment => ({ id: segment.data.id, name: segment.data.name, size: segment.data.size }))
      : [];
  const messageType =
    types.length === 0 || types.every(type => type === 'text' || type === 'at')
      ? 'text'
      : types.find(type => type !== 'text' && type !== 'at');
  const unavailableFile = platform === 'wechat' && messageType === 'file' && files.length === 0;
  const mentionTarget = platform === 'wechat' && kind === 'group' ? oneBotMentionTarget(segments, event.self_id) : null;
  const timestamp = Number(event.time ?? Date.now() / 1000);
  const forwardedVoices = forwardedRecord
    ? segments
        .filter(
          ({ type, data }) =>
            type === 'record' &&
            Number.isInteger(data?.forwardIndex) &&
            ['1', '3', '4'].includes(forwardedRecord.items[data.forwardIndex]?.kind) &&
            /^[a-f0-9]{64}$/.test(data.voice_id ?? '') &&
            data.file === 'wechatagent://voice/' + data.voice_id,
        )
        .slice(0, 4)
        .map(({ data }) => ({ id: data.voice_id, index: data.forwardIndex }))
    : [];
  // A peer may omit message_id. A stable fingerprint only deduplicates a short receive window.
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify([platform, kind, conversationId, senderId, text, timestamp]))
    .digest('hex')
    .slice(0, 24);
  return {
    platform,
    adapter,
    kind,
    conversation_id: conversationId,
    sender_id: senderId,
    ...(mentionTarget ? { mentionTarget } : {}),
    ...(verifiedAssistantSender({
      platform,
      kind,
      conversation_id: conversationId,
      sender_id: senderId,
      sender_wxid: event.wechatagent?.senderWxid,
    })
      ? { sender_wxid: event.wechatagent.senderWxid }
      : {}),
    conversation_name: String(
      kind === 'group' ? (event.group_name ?? conversationId) : (event.sender?.nickname ?? conversationId),
    ),
    sender_name: String(event.sender?.card ?? event.sender?.nickname ?? senderId),
    ...(platform === 'wechat' && kind === 'group' && /^[a-f0-9]{64}$/.test(event.wechatagent?.memberId ?? '')
      ? { sender_key: event.wechatagent.memberId }
      : {}),
    self_id: String(event.self_id ?? ''),
    message_id: String(event.message_id ?? `local-${fingerprint}`),
    message_type: forwardedVoices.length || unavailableFile ? 'text' : (messageType ?? 'unknown'),
    text: text || (images.length ? '[图片]' : ''),
    images,
    files,
    timestamp,
    segments,
    raw: event,
    ...(voice ? { voice: { id: voice.data.voice_id, durationSeconds: voice.data.duration } } : {}),
    ...(voice?.data.source === 'video-audio' ? { voiceSource: 'video' } : {}),
    ...(platform === 'wechat' && event.wechatagent?.contextOnly === true ? { contextOnly: true } : {}),
    ...(platform === 'wechat' && (event.wechatagent?.attachmentUnavailable === true || unavailableFile)
      ? { attachmentUnavailable: true }
      : {}),
    ...(platform === 'wechat' &&
    ['text', 'voice', 'video', 'image', 'sticker', 'link', 'file', 'record', 'quote', 'card'].includes(
      event.wechatagent?.quoteKind,
    )
      ? { quoteKind: event.wechatagent.quoteKind }
      : {}),
    ...(platform === 'wechat' && event.wechatagent?.interaction === 'pat' ? { interaction: 'pat' } : {}),
    ...(forwardedRecord ? { forwardedRecord } : {}),
    ...(forwardedVoices.length ? { forwardedVoices } : {}),
    ...(quoteReply ? { quoteReply } : {}),
  };
}
