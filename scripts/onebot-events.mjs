import { validFileReference } from '../packages/wechat-file-reference.mjs';
import crypto from 'node:crypto';
import { validChatId, validUserId } from '../packages/wechat-identity.mjs';
import {
  PAT_TYPE,
  FORWARD_TYPE,
  QUOTE_TYPE,
  annotateForwardedItem,
  normalizeForwardedRecord,
  normalizeQuoteReply,
} from '../components/qq-bridge/src/core/wechat-events.js';

function validVoiceReference(voice, durationLimit) {
  if (!/^[a-f0-9]{64}$/.test(voice?.id ?? '')) return false;
  if (voice.durationSeconds === undefined) return true;
  return (
    Number.isFinite(voice.durationSeconds) &&
    voice.durationSeconds > 0 &&
    voice.durationSeconds <= (durationLimit ?? 60)
  );
}

function describeVideo(label, playback) {
  const seconds = playback?.durationSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) return null;
  const audio = playback.audioPresent === false ? '没有音轨。' : '';
  return `[${label}，时长 ${seconds.toFixed(2)} 秒。${audio}附图仅代表采样时刻。]`;
}

export function readerEvent(payload, { ownWxid, allowed }) {
  if (
    payload?.event !== 'message.new' ||
    ![1, 3, 34, 43, 62, 47, PAT_TYPE, 49, FORWARD_TYPE, QUOTE_TYPE, 25769803825].includes(payload.type) ||
    typeof payload.content !== 'string' ||
    !payload.content.trim() ||
    !payload.sessionId ||
    !payload.talkerId ||
    payload.isSend ||
    payload.talkerId === ownWxid
  )
    return null;
  let forwardedRecord = [49, FORWARD_TYPE].includes(payload.type)
    ? normalizeForwardedRecord(payload.forwardedRecord)
    : null;
  const quoteReply = [49, QUOTE_TYPE].includes(payload.type) ? normalizeQuoteReply(payload.quoteReply) : null;
  if (
    [49, FORWARD_TYPE, QUOTE_TYPE].includes(payload.type) &&
    ((!forwardedRecord && !quoteReply) || (forwardedRecord && quoteReply))
  )
    return null;
  if ([3, 47].includes(payload.type) && !/^[a-f0-9]{64}$/.test(payload.image?.id ?? '')) return null;
  if (payload.type === 34 && !validVoiceReference(payload.voice)) return null;
  const file = payload.type === 25769803825;
  const availableFile = file && validFileReference(payload.file);
  if (
    payload.type === PAT_TYPE &&
    (!ownWxid ||
      payload.pat?.target !== ownWxid ||
      payload.pat?.actor !== payload.talkerId ||
      payload.pat.actor === ownWxid)
  )
    return null;
  if (!validUserId(ownWxid) || !validUserId(payload.talkerId) || typeof payload.sessionId !== 'string') return null;
  const group = payload.sessionId.endsWith('@chatroom'),
    kind = group ? 'group' : 'private';
  const target = payload.sessionId;
  if (!validChatId(kind, target) || !allowed(kind, target)) return null;
  if (
    !group &&
    payload.talkerId !== payload.sessionId &&
    !(payload.contextOnly === true && payload.talkerId === 'wechat-system')
  )
    return null;
  const userId = group ? payload.talkerId : target;
  if (quoteReply) {
    const ref = quoteReply.reference;
    const sameChat = group ? ref.conversationId === payload.sessionId : !ref.conversationId;
    ref.senderRelation =
      sameChat && ref.senderId && ownWxid ? (ref.senderId === ownWxid ? 'self' : 'other') : 'unknown';
  }
  const content = quoteReply
    ? quoteReply.reply || '[引用回复，正文为空]'
    : (describeVideo('视频', payload.videoPlayback) ?? payload.content);
  const segments = [{ type: 'text', data: { text: content } }];
  if (forwardedRecord && payload.forwardAttachments) {
    const { images, voices, videos } = payload.forwardAttachments;
    const valid = (ref, kinds) =>
      Number.isInteger(ref?.index) &&
      kinds.includes(forwardedRecord.items[ref.index]?.kind) &&
      /^[a-f0-9]{64}$/.test(ref.id);
    if (
      !Array.isArray(images) ||
      !Array.isArray(voices) ||
      images.length > 4 ||
      voices.length > 4 ||
      !images.every(ref => valid(ref, ['1', '2', '4', '37'])) ||
      !voices.every(ref => valid(ref, ['1', '3', '4']))
    )
      return null;
    for (const ref of images) {
      segments.push({
        type: 'image',
        data: { file: 'wechatagent://image/' + ref.id, media_id: ref.id, forwardItem: ref.index + 1 },
      });
      if (forwardedRecord.items[ref.index].kind !== '1')
        forwardedRecord = annotateForwardedItem(
          forwardedRecord,
          ref.index,
          describeVideo('转发中的视频', videos?.[ref.index]) ?? '[历史附件，画面按本条序号提供，缺失时不可见]',
        );
    }
    for (const [index, item] of forwardedRecord.items.entries()) {
      const description = item.kind === '1' && describeVideo('被引用的历史视频', videos?.[index]);
      if (description) forwardedRecord = annotateForwardedItem(forwardedRecord, index, description);
    }
    for (const ref of voices.filter(ref => videos?.[ref.index]?.audioPresent !== false))
      segments.push({
        type: 'record',
        data: { file: 'wechatagent://voice/' + ref.id, voice_id: ref.id, forwardIndex: ref.index },
      });
  }
  if ([43, 62].includes(payload.type)) {
    if (payload.image) {
      const { id } = payload.image;
      if (!/^[a-f0-9]{64}$/.test(id ?? '')) return null;
      segments.push({ type: 'image', data: { file: 'wechatagent://image/' + id, media_id: id } });
    } else if (payload.attachmentUnavailable !== true) return null;
    const voice = payload.voice;
    if (payload.videoPlayback?.audioPresent !== false && validVoiceReference(voice, 300)) {
      segments.push({
        type: 'record',
        data: {
          file: 'wechatagent://voice/' + voice.id,
          voice_id: voice.id,
          duration: voice.durationSeconds,
          source: 'video-audio',
        },
      });
    }
  }
  if (payload.type === 34)
    segments.push({
      type: 'record',
      data: {
        file: 'wechatagent://voice/' + payload.voice.id,
        voice_id: payload.voice.id,
        duration: payload.voice.durationSeconds,
      },
    });
  if (availableFile)
    segments.push({ type: 'file', data: { id: payload.file.id, name: payload.file.name, size: payload.file.size } });
  if ([3, 47].includes(payload.type))
    segments.push({
      type: 'image',
      data: {
        file: 'wechatagent://image/' + payload.image.id,
        media_id: payload.image.id,
        ...(payload.type === 47 ? { media_kind: 'sticker' } : {}),
      },
    });
  const attachment = payload.quotedMedia;
  if (
    quoteReply &&
    ['43', '62'].includes(quoteReply.reference.kind) &&
    attachment?.kind === 'video' &&
    /^[a-f0-9]{64}$/.test(attachment.id ?? '')
  ) {
    const { id } = attachment;
    segments.push({ type: 'image', data: { file: 'wechatagent://image/' + id, media_id: id, media_quoted: true } });
    quoteReply.reference.text =
      describeVideo('被引用的历史视频', attachment.playback) ?? '[被引用历史视频，附图为原视频的采样时刻]';
    quoteReply.reference.unavailable = false;
    const voice = attachment.voice;
    if (attachment.playback?.audioPresent !== false && validVoiceReference(voice, 300)) {
      segments.push({
        type: 'record',
        data: {
          file: 'wechatagent://voice/' + voice.id,
          voice_id: voice.id,
          duration: voice.durationSeconds,
          source: 'quoted-video-audio',
        },
      });
    }
  }
  if (quoteReply && /^[a-f0-9]{64}$/.test(attachment?.id ?? '')) {
    const ref = quoteReply.reference;
    if ((ref.kind === '3' && attachment.kind === 'image') || (ref.kind === '47' && attachment.kind === 'sticker')) {
      segments.push({
        type: 'image',
        data: { file: 'wechatagent://image/' + attachment.id, media_id: attachment.id, media_quoted: true },
      });
      ref.text = '[被引用历史消息的附图，来源为被引用人]';
      ref.unavailable = false;
    } else if (ref.kind === '34' && attachment.kind === 'voice' && validVoiceReference(attachment)) {
      segments.push({
        type: 'record',
        data: {
          file: 'wechatagent://voice/' + attachment.id,
          voice_id: attachment.id,
          duration: attachment.durationSeconds,
        },
      });
    }
  }
  if (group) {
    if (payload.mentionsSelf === true) segments.unshift({ type: 'at', data: { id: ownWxid } });
    if (payload.mentionsAll === true) segments.unshift({ type: 'at', data: { id: 'all' } });
  }
  const quoteKind = file
    ? 'file'
    : [43, 62].includes(payload.type)
      ? 'video'
      : payload.type === 34
        ? 'voice'
        : payload.quoteKind;
  return {
    time: payload.timestamp || Math.floor(Date.now() / 1000),
    self_id: ownWxid,
    post_type: 'message',
    message_type: kind,
    sub_type: group ? 'normal' : 'friend',
    message_id: payload.rawid,
    user_id: userId,
    message: segments,
    raw_message: content,
    sender: { user_id: payload.talkerId, nickname: payload.sourceName || payload.senderName || userId },
    wechatagent: {
      senderWxid: payload.talkerId,
      ...(payload.contextOnly === true ? { contextOnly: true } : {}),
      ...(payload.attachmentUnavailable === true || (file && !availableFile) ? { attachmentUnavailable: true } : {}),
      ...(['text', 'voice', 'video', 'image', 'sticker', 'link', 'file', 'record', 'quote', 'card'].includes(quoteKind)
        ? { quoteKind }
        : {}),
      ...(group
        ? {
            memberId: crypto
              .createHash('sha256')
              .update('wechat-member:' + payload.talkerId)
              .digest('hex'),
          }
        : {}),
      ...(payload.type === PAT_TYPE
        ? { interaction: 'pat' }
        : forwardedRecord
          ? { forwardedRecord }
          : quoteReply
            ? { quoteReply }
            : {}),
    },
    ...(group ? { group_id: target, group_name: payload.groupName || target } : {}),
  };
}
