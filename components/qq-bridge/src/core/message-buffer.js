import { validFileReference } from '../../../../packages/wechat-file-reference.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import modelFields from '../../../../packages/speech-contract/local-model-fields.json' with { type: 'json' };
import { buildConversationKey } from './conversation-key.js';
import { normalizeForwardedRecord, normalizeQuoteReply } from './wechat-events.js';
import { STICKER_CANDIDATE_MAX } from './sticker-policy.js';
import { validReplyMessageLimit } from '../../../../packages/dsh-social-bridge-plugin/reply-layout-policy.mjs';
import { verifiedAssistantSender } from '../../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import { validQuoteRefs, nativeQuoteKind } from '../../../../packages/dsh-social-bridge-plugin/native-quote-source.mjs';
import { validGroupWakeEpoch } from '../../../../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import { replyDeliveryStatus, replySentAt, TERMINAL_DELIVERY_STATES } from '../../../../packages/delivery-contract.mjs';
import { validReaderOrder } from '../../../../packages/wechat-identity.mjs';

export function replyDeliveryParts(result, deliveryId) {
  // A voice reply is one part; its text fallback is derived from the same delivery.
  const parts = [];
  if (result.decision === 'RESPOND') {
    if (result.mode === 'voice') parts.push({ voiceText: result.text });
    else parts.push(...(result.textParts ?? [result.text]).map(text => ({ text })));
  }
  if (result.stickerId) parts.push({ stickerId: result.stickerId });
  return parts.map((part, index) => ({
    ...part,
    ...(index === 0 && result.quoteEventId ? { quoteEventId: result.quoteEventId } : {}),
    deliveryId:
      index === 0
        ? deliveryId
        : crypto
            .createHash('sha256')
            .update(deliveryId + (part.stickerId ? '\0sticker' : '\0text-' + (index + 1)))
            .digest('hex'),
    state: 'queued',
  }));
}

function validQuotedDecision(result) {
  if (result.quoteEventId === undefined) return true;
  if (!/^[a-f0-9]{64}$/.test(result.quoteEventId) || result.mode || result.textParts) return false;
  return result.decision === 'STICKER' ? result.text === '' : !result.stickerId;
}

function replyTextLimit(item) {
  if (item.result.mode === 'voice') return modelFields.speechLimits.maxReplyChars;
  return item.message?.work_mode === 'assistant' ? 12000 : 1200;
}
function validReplyText({ text, textParts }, limit) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (textParts === undefined) return text.length <= limit;
  if (!Array.isArray(textParts) || textParts.length < 2 || textParts.length > limit) return false;
  let length = 0;
  for (const part of textParts) {
    if (typeof part !== 'string' || !part.trim()) return false;
    length += part.length;
    if (length > limit) return false;
  }
  // The blank lines are display separators; only the parts are sent.
  return textParts.join('\n\n') === text;
}
function validReplyParts(item) {
  if (item.parts === undefined) return true;
  const expected = replyDeliveryParts(item.result, item.deliveryId);
  return (
    Array.isArray(item.parts) &&
    item.parts.length === expected.length &&
    item.parts.length <= (item.result.text?.length ?? 0) + 1 &&
    item.parts.every((part, index) => {
      const target = expected[index];
      return (
        part &&
        part.text === target.text &&
        part.stickerId === target.stickerId &&
        part.voiceText === target.voiceText &&
        part.quoteEventId === target.quoteEventId &&
        part.deliveryId === target.deliveryId &&
        (part.desktopPending === undefined || part.desktopPending === true) &&
        (part.voiceFallback === undefined || (part.voiceFallback === true && typeof part.voiceText === 'string')) &&
        (part.voiceFallbackPending === undefined ||
          (part.voiceFallbackPending === true && part.voiceFallback === true && part.desktopPending !== true)) &&
        ['queued', 'sending', 'submitted', 'confirmed', 'unconfirmed', 'failed', 'cancelled', 'expired'].includes(
          part.state,
        ) &&
        ['busyAttempts', 'receiptChecks'].every(
          name => part[name] === undefined || (Number.isSafeInteger(part[name]) && part[name] >= 0 && part[name] <= 10),
        ) &&
        ['retryAt', 'busyDeadline'].every(
          name => part[name] === undefined || (Number.isSafeInteger(part[name]) && part[name] >= 0),
        )
      );
    }) &&
    (item.deliveryNotice === undefined ||
      (typeof item.deliveryNotice === 'string' && item.deliveryNotice.length <= 1000))
  );
}
function validPendingReply(item, key) {
  return (
    item &&
    /^[a-f0-9]{64}$/.test(item.deliveryId ?? '') &&
    typeof item.throughId === 'string' &&
    ['RESPOND', 'STICKER'].includes(item.result?.decision) &&
    validQuotedDecision(item.result) &&
    (item.result.decision !== 'RESPOND' || validReplyText(item.result, replyTextLimit(item))) &&
    (item.result.decision !== 'STICKER' ||
      (item.result.textParts === undefined && /^[a-f0-9]{64}$/.test(item.result.stickerId ?? ''))) &&
    item.message &&
    (item.naturalGroupEpoch === undefined || validGroupWakeEpoch(item.naturalGroupEpoch)) &&
    (item.result.stickerId === undefined || /^[a-f0-9]{64}$/.test(item.result.stickerId)) &&
    validReplyParts(item) &&
    buildConversationKey(item.message.platform, item.message.kind, item.message.conversation_id) === key
  );
}

function validPendingRequest(item) {
  return (
    item &&
    Array.isArray(item.rowIds) &&
    item.rowIds.length > 0 &&
    item.rowIds.length <= 20 &&
    item.rowIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100) &&
    item.throughId === item.rowIds.at(-1) &&
    /^[a-f0-9]{64}$/.test(item.signature ?? '') &&
    typeof item.prompt === 'string' &&
    item.prompt.length > 0 &&
    item.prompt.length <= 18000 &&
    item.metadata &&
    /^[a-f0-9]{64}$/.test(item.metadata.batchId ?? '') &&
    JSON.stringify(item.metadata.historyExcludeIds) === JSON.stringify(item.rowIds) &&
    (item.metadata.replyMaxMessages === undefined || validReplyMessageLimit(item.metadata.replyMaxMessages)) &&
    (item.quoteRefs === undefined || validQuoteRefs(item.quoteRefs)) &&
    [
      [item.stickerRefs, STICKER_CANDIDATE_MAX],
      [item.annotationRefs, 4],
    ].every(
      ([refs, limit]) =>
        refs &&
        typeof refs === 'object' &&
        !Array.isArray(refs) &&
        Object.keys(refs).length <= limit &&
        Object.values(refs).every(id => /^[a-f0-9]{64}$/.test(id)),
    ) &&
    Array.isArray(item.stickerChoices) &&
    item.stickerChoices.length <= STICKER_CANDIDATE_MAX &&
    JSON.stringify(item).length <= 100000
  );
}

/** Small persistent recent-message buffer. Corrupt files fail closed and are never overwritten. */
export class MessageBuffer {
  #retryingArchives = false;

  constructor(file, { maxPerChat = 300, archive = null, readerAccount = '' } = {}) {
    this.file = file;
    this.readerAccount = readerAccount;
    this.archive = archive;
    this.maxPerChat = Math.min(1000, Math.max(10, Number(maxPerChat) || 300));
    this.chats = new Map();
    this.pendingReplies = new Map();
    this.replyReceipts = new Map();
    this.mediaReplies = new Map();
    this.contextNotices = new Map();
    this.pendingRequests = new Map();
    this.dshConnection = null;
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.chats || typeof saved.chats !== 'object')
        throw new Error('invalid message buffer');
      if (saved.dshConnection !== undefined && saved.dshConnection !== null) {
        const state = saved.dshConnection;
        if (
          state.version !== 1 ||
          typeof state.ready !== 'boolean' ||
          !Number.isSafeInteger(state.epoch) ||
          state.epoch < 1 ||
          typeof state.instanceId !== 'string' ||
          state.instanceId.length > 100 ||
          !Number.isFinite(state.cutoff) ||
          state.cutoff < 0
        )
          throw Error('invalid DSH connection boundary');
        this.dshConnection = state;
      }
      for (const [key, rows] of Object.entries(saved.chats)) {
        if (!Array.isArray(rows)) throw new Error(`invalid message buffer chat ${key}`);
        if (this.archive) {
          this.archive.backfill(
            key,
            rows.map(row => (row.archiveText === undefined ? row : { ...row, text: row.archiveText })),
          );
          for (const row of rows) {
            delete row.archivePending;
            delete row.archiveText;
          }
        }
        this.chats.set(
          key,
          this.trimRecent(rows).map(row => ({ ...row, id: row.id ?? crypto.randomUUID() })),
        );
      }
      for (const [key, item] of Object.entries(saved.pendingReplies ?? {})) {
        if (!validPendingReply(item, key)) throw Error('invalid reply outbox');
        this.pendingReplies.set(key, item);
      }
      for (const [id, item] of Object.entries(saved.replyReceipts ?? {})) {
        if (
          !validPendingReply(item, item?.key) ||
          item.deliveryId !== id ||
          !item.parts?.length ||
          (item.retiredAt !== undefined && (!Number.isSafeInteger(item.retiredAt) || item.retiredAt < 1)) ||
          item.parts.some(part => part.state !== 'submitted' && !TERMINAL_DELIVERY_STATES.has(part.state))
        )
          throw Error('invalid reply receipt outbox');
        this.replyReceipts.set(id, item);
      }
      for (const [key, item] of Object.entries(saved.contextNotices ?? {})) {
        if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || item.text.length > 1000)
          throw Error('invalid context notice');
        this.contextNotices.set(key, item);
      }
      for (const [key, item] of Object.entries(saved.pendingRequests ?? {})) {
        if (!this.chats.has(key) || !validPendingRequest(item)) throw Error('invalid pending model request');
        this.pendingRequests.set(key, item);
      }
      for (const [id, item] of Object.entries(saved.mediaReplies ?? {})) {
        if (
          !/^[a-f0-9]{64}$/.test(id) ||
          item?.part?.deliveryId !== id ||
          !/^[a-f0-9]{64}$/.test(item.part.stickerId ?? '') ||
          (item.part.quoteEventId !== undefined && !/^[a-f0-9]{64}$/.test(item.part.quoteEventId)) ||
          !['queued', 'sending', 'submitted', 'confirmed'].includes(item.part.state) ||
          (item.observeOnly !== undefined && typeof item.observeOnly !== 'boolean') ||
          (item.retiredAt !== undefined && (!Number.isSafeInteger(item.retiredAt) || item.retiredAt < 1)) ||
          !item.message ||
          (item.naturalGroupEpoch !== undefined && !validGroupWakeEpoch(item.naturalGroupEpoch)) ||
          buildConversationKey(item.message.platform, item.message.kind, item.message.conversation_id) !== item.key ||
          !['createdAt', 'expiresAt'].every(name => Number.isSafeInteger(item[name]) && item[name] >= 0) ||
          item.expiresAt < item.createdAt ||
          item.expiresAt - item.createdAt > 60000 ||
          ['busyAttempts', 'receiptChecks'].some(
            name =>
              item.part[name] !== undefined &&
              (!Number.isSafeInteger(item.part[name]) || item.part[name] < 0 || item.part[name] > 10),
          )
        )
          throw Error('invalid media outbox');
        if (item.part.state === 'confirmed') {
          const receipt = this.findReplyPart(item.key, id);
          if (receipt?.delivery_status !== 'confirmed' || receipt.sticker_id !== item.part.stickerId)
            throw Error('invalid media outbox');
        }
        this.mediaReplies.set(id, item);
      }
      if ([...this.mediaReplies.values()].filter(item => !item.observeOnly).length > 64)
        throw Error('media outbox limit');
    }
  }

  append(message, { outgoing = false, processed = false, skipReason, deferArchive = false } = {}) {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    if (!outgoing) {
      const existing = this.findIncoming(message);
      if (existing) {
        if (!deferArchive && existing.archivePending) this.#archiveRow(key, existing);
        return existing;
      }
    }
    const row = {
      id: crypto.randomUUID(),
      platform: message.platform,
      kind: message.kind,
      conversation_id: String(message.conversation_id),
      sender_id: String(message.sender_id ?? ''),
      conversation_name: String(message.conversation_name ?? message.conversation_id),
      sender_name: String(message.sender_name ?? ''),
      message_id: String(message.message_id ?? ''),
      ...(!outgoing && message.kind === 'group' && /^[a-f0-9]{64}$/.test(message.sender_key ?? '')
        ? { sender_key: message.sender_key }
        : {}),
      ...(typeof message.sender_wxid === 'string' ? { sender_wxid: message.sender_wxid } : {}),
      self_id: String(message.self_id ?? ''),
      ...(message.work_mode ? { work_mode: message.work_mode } : {}),
      ...(message.assistant_chat_only === true ? { assistant_chat_only: true } : {}),
      text: String(message.text ?? '').slice(0, 16000),
      timestamp: Number(message.timestamp) || Date.now() / 1000,
      images: outgoing
        ? []
        : (message.images ?? []).filter(image => /^[a-f0-9]{64}$/.test(image?.id ?? '')).slice(0, 4),
      files: outgoing ? [] : (message.files ?? []).filter(validFileReference).slice(0, 3),
      direct_mention: Boolean(message.direct_mention),
      outgoing,
      processed: outgoing || processed,
      ...(!outgoing && this.archive ? { archivePending: true } : {}),
    };
    if (
      !outgoing &&
      message.platform === 'wechat' &&
      message.kind === 'group' &&
      ['self', 'all'].includes(message.mentionTarget)
    )
      row.mentionTarget = message.mentionTarget;
    if (typeof message.readerGrant === 'string') row.readerGrant = message.readerGrant;
    if (validReaderOrder(message.readerOrder)) row.readerOrder = message.readerOrder;
    if (message.readerReplay === 'context' || message.readerReplay === 'reply') row.readerReplay = message.readerReplay;
    if (message.contextOnly === true) row.contextOnly = true;
    if (message.platform === 'wechat' && message.systemNotice === true) row.systemNotice = true;
    if (message.attachmentUnavailable === true) row.attachmentUnavailable = true;
    if (!outgoing) {
      const quoteKind = nativeQuoteKind(message);
      if (quoteKind) row.quoteKind = quoteKind;
    }
    if (!outgoing && message.interaction === 'pat') row.interaction = 'pat';
    const record = !outgoing && normalizeForwardedRecord(message.forwardedRecord);
    if (record) row.forwardedRecord = record;
    const quoteReply = !outgoing && normalizeQuoteReply(message.quoteReply);
    if (quoteReply) row.quoteReply = quoteReply;
    if (!outgoing && /^[a-f0-9]{64}$/.test(message.voice?.id ?? '')) {
      row.voice = { id: message.voice.id };
      if (message.voiceSource === 'video') row.voiceSource = 'video';
    }
    if (record && Array.isArray(message.forwardedVoices)) {
      const references = message.forwardedVoices
        .filter(
          ref =>
            /^[a-f0-9]{64}$/.test(ref?.id ?? '') &&
            Number.isInteger(ref.index) &&
            ['1', '3', '4'].includes(record.items[ref.index]?.kind),
        )
        .slice(0, 4)
        .map(({ id, index }) => ({ id, index }));
      if (references.length) row.forwardedVoices = references;
    }
    const previousNotice = this.contextNotices.get(key);
    if (!outgoing && skipReason) {
      row.processed = true;
      row.reply_skip_reason = skipReason;
      row.reply_skipped_at = Date.now();
      if (row.work_mode === 'assistant' && skipReason !== 'awaiting_mention') row.reply_review_required = true;
      if (!['context_only', 'awaiting_mention'].includes(skipReason)) {
        this.contextNotices.set(key, {
          id: crypto.randomUUID(),
          text: '离线旧消息仅作为背景，不能逐条补答或自动执行旧任务。请根据恢复后的当前新消息处理。',
        });
      }
    }
    const previous = this.chats.get(key);
    const rows = this.trimRecent([...(previous ?? []), row]);
    this.chats.set(key, rows);
    try {
      // History acts as an intake receipt only after the reply decision can survive a restart.
      this.#save();
    } catch (error) {
      if (previous) this.chats.set(key, previous);
      else this.chats.delete(key);
      if (previousNotice) this.contextNotices.set(key, previousNotice);
      else this.contextNotices.delete(key);
      throw error;
    }
    if (!deferArchive) this.#archiveRow(key, row);
    return row;
  }

  #archiveRow(key, row, options = {}) {
    if (!this.archive) return;
    this.archive.append(key, row, { fullText: row.archiveText ?? row.text, ...options });
    delete row.archivePending;
    delete row.archiveText;
  }

  async retryPendingArchives({ signal, isCurrent = () => true } = {}) {
    if (!this.archive || this.#retryingArchives || signal?.aborted || !isCurrent()) return 0;
    const pending = [...this.chats].flatMap(([key, rows]) =>
      rows.filter(row => row.archivePending).map(row => [key, row]),
    );
    if (!pending.length) return 0;
    this.#retryingArchives = true;
    const recovered = new Set();
    let failures = 0;
    try {
      for (const [key, row] of pending) {
        // Keep intake responsive between synchronous SQLite writes.
        await setImmediate();
        if (signal?.aborted || !isCurrent()) break;
        if (!row.archivePending) continue;
        try {
          this.#archiveRow(key, row, { waitForLock: false });
          recovered.add(key);
        } catch (error) {
          failures++;
          // A busy or locked database cannot accept the remaining writes this pass.
          if (error?.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode & 255)) break;
        }
      }
      if (recovered.size && !signal?.aborted && isCurrent()) {
        for (const key of recovered) this.chats.set(key, this.trimRecent(this.chats.get(key) ?? []));
        this.#save();
      }
      return failures;
    } finally {
      this.#retryingArchives = false;
    }
  }

  updateVoice(key, row, update, { archive = false } = {}) {
    if (!this.chats.get(key)?.includes(row)) return false;
    const previous = Object.fromEntries(Object.keys(update).map(field => [field, row[field]]));
    const willArchive = archive && this.archive;
    if (willArchive) previous.archivePending = row.archivePending;
    Object.assign(row, update);
    if (willArchive) row.archivePending = true;
    try {
      this.#save();
    } catch (error) {
      Object.assign(row, previous);
      throw error;
    }
    if (archive) this.#archiveRow(key, row);
    return true;
  }

  findIncoming(message) {
    if (!message.message_id) return null;
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    return (
      (this.chats.get(key) ?? []).find(
        row =>
          !row.outgoing &&
          row.message_id === String(message.message_id) &&
          row.sender_id === String(message.sender_id ?? ''),
      ) ?? null
    );
  }

  confirmBuffered(message) {
    const row = this.findIncoming(message);
    if (!row) return false;
    if (row.archivePending)
      this.#archiveRow(buildConversationKey(message.platform, message.kind, message.conversation_id), row);
    return true;
  }
  rememberReply(key, item) {
    const message = item.message;
    this.pendingRequests.delete(key);
    this.pendingReplies.set(key, {
      ...item,
      message: {
        platform: message.platform,
        kind: message.kind,
        conversation_id: String(message.conversation_id),
        ...(typeof message.readerGrant === 'string' ? { readerGrant: message.readerGrant } : {}),
        conversation_name: String(message.conversation_name ?? ''),
        self_id: String(message.self_id ?? ''),
        sender_id: String(message.sender_id ?? ''),
        sender_name: String(message.sender_name ?? ''),
        ...(verifiedAssistantSender(message) ? { sender_wxid: message.sender_wxid } : {}),
        ...(message.work_mode ? { work_mode: message.work_mode } : {}),
        ...(message.assistant_chat_only === true ? { assistant_chat_only: true } : {}),
      },
    });
    this.#save();
  }
  forgetReply(key) {
    this.pendingReplies.delete(key);
    this.#save();
  }
  deferReplyReceipt(key, item) {
    const id = item.deliveryId;
    const pending = this.pendingReplies.get(key);
    const rows = this.chats.get(key);
    const processed = rows?.map(row => row.processed);
    const saved = structuredClone({
      ...item,
      key,
      retiredAt: Date.now(),
      message: pending?.deliveryId === id ? pending.message : item.message,
    });
    const previous = [
      [this.pendingReplies, key, pending],
      [this.chats, key, rows],
      [this.contextNotices, key, this.contextNotices.get(key)],
      [this.replyReceipts, id, this.replyReceipts.get(id)],
    ];
    try {
      if (item.deliveryNotice) this.contextNotices.set(key, { id, text: item.deliveryNotice });
      this.replyReceipts.set(id, saved);
      // Publish the receipt-only record and consume the old input in one snapshot.
      this.completeReply(key, item, null);
    } catch (error) {
      for (const [index, row] of rows?.entries() ?? []) row.processed = processed[index];
      for (const [map, entry, value] of previous) {
        if (value === undefined) map.delete(entry);
        else map.set(entry, value);
      }
      throw error;
    }
  }

  rememberReplyReceipt(item) {
    this.replyReceipts.set(item.deliveryId, item);
    this.#save();
  }

  forgetReplyReceipt(id) {
    const previous = this.replyReceipts.get(id);
    this.replyReceipts.delete(id);
    try {
      this.#save();
    } catch (error) {
      if (previous) this.replyReceipts.set(id, previous);
      throw error;
    }
  }

  rememberRequest(key, item) {
    if (!validPendingRequest(item)) throw Error('invalid pending model request');
    this.pendingRequests.set(key, structuredClone(item));
    this.#save();
  }
  forgetRequest(key) {
    this.pendingRequests.delete(key);
    this.#save();
  }
  saveMedia() {
    this.#save();
  }
  retireInputs(key, reasonFor) {
    const retired = [];
    for (const row of this.chats.get(key) ?? []) {
      if (row.outgoing || row.processed) continue;
      const reason = reasonFor(row);
      if (reason)
        retired.push({
          row,
          reason,
          previous: {
            processed: row.processed,
            reply_skip_reason: row.reply_skip_reason,
            reply_skipped_at: row.reply_skipped_at,
            reply_review_required: row.reply_review_required,
          },
        });
    }
    if (!retired.length) return 0;
    const request = this.pendingRequests.get(key);
    const ids = new Set(retired.map(({ row }) => row.id));
    const retireRequest = request?.rowIds.some(id => ids.has(id));
    const at = Date.now();
    try {
      for (const { row, reason } of retired) {
        row.processed = true;
        row.reply_skip_reason = reason;
        row.reply_skipped_at = at;
        if (row.work_mode === 'assistant') row.reply_review_required = true;
      }
      if (retireRequest) this.pendingRequests.delete(key);
      this.#save();
    } catch (error) {
      for (const { row, previous } of retired) Object.assign(row, previous);
      if (retireRequest) this.pendingRequests.set(key, request);
      throw error;
    }
    return retired.length;
  }
  skipOfflineInputs({ before = Infinity, reason = 'dsh_offline' } = {}) {
    let skipped = 0;
    for (const [key, rows] of this.chats) {
      let changed = false;
      for (const row of rows)
        if (!row.outgoing && !row.processed && (before === Infinity || Number(row.timestamp) * 1000 < before)) {
          row.processed = true;
          row.reply_skip_reason = reason;
          row.reply_skipped_at = Date.now();
          if (row.work_mode === 'assistant') row.reply_review_required = true;
          skipped++;
          changed = true;
        }
      const request = this.pendingRequests.get(key);
      if (request && request.rowIds.some(id => rows.some(row => row.id === id && row.processed)))
        this.pendingRequests.delete(key);
      if (changed)
        this.contextNotices.set(key, {
          id: crypto.randomUUID(),
          text: 'DSH 离线或重启期间的旧消息已留作历史，不逐条补答，也不把其中旧任务当成当前授权；只处理恢复后的新消息。旧助手任务请由管理员重新下达或明确继续。',
        });
    }
    this.#save();
    return skipped;
  }
  skipOfflineRow(row, reason = 'dsh_offline') {
    row.processed = true;
    row.reply_skip_reason = reason;
    row.reply_skipped_at = Date.now();
    if (row.work_mode === 'assistant') row.reply_review_required = true;
    this.contextNotices.set(buildConversationKey(row.platform, row.kind, row.conversation_id), {
      id: crypto.randomUUID(),
      text: '离线旧消息仅作为背景，不能逐条补答或自动执行旧任务。请根据恢复后的当前新消息处理。',
    });
    this.#save();
  }
  setContextNotice(key, item) {
    this.contextNotices.set(key, item);
    this.#save();
  }
  findReplyPart(key, deliveryId) {
    return this.chats.get(key)?.find(row => row.outgoing && row.delivery_id === deliveryId);
  }
  recordConfirmedText(message, deliveryId, text, delivery) {
    if (replyDeliveryStatus(delivery) !== 'confirmed') return;
    const at = replySentAt(delivery);
    this.recordReplyPart(
      buildConversationKey(message.platform, message.kind, message.conversation_id),
      { deliveryId },
      { ...message, sender_id: message.self_id, text, timestamp: at / 1000, delivery_status: 'confirmed' },
      { inSendOrder: delivery.sentAt === at, receiptOrder: delivery.readerOrder },
    );
  }
  recordReplyPart(key, item, outgoing, { inSendOrder = false, receiptOrder } = {}) {
    const rows = this.chats.get(key) ?? [];
    if (outgoing) {
      const existing = this.findReplyPart(key, item.deliveryId);
      const messageId = 'out-' + item.deliveryId;
      const fullText = String(outgoing.text);
      const row = existing ?? {
        id: messageId,
        platform: outgoing.platform,
        kind: outgoing.kind,
        conversation_id: String(outgoing.conversation_id),
        conversation_name: String(outgoing.conversation_name ?? ''),
        sender_id: String(outgoing.sender_id ?? ''),
        sender_name: 'AI',
        ...(typeof outgoing.self_id === 'string' ? { self_id: outgoing.self_id } : {}),
        message_id: messageId,
        text: fullText.slice(0, 4000),
        timestamp: outgoing.timestamp,
        images: [],
        direct_mention: false,
        outgoing: true,
        processed: true,
        delivery_id: item.deliveryId,
        delivery_status: outgoing.delivery_status,
        proactive: outgoing.proactive === true,
        ...(outgoing.work_mode ? { work_mode: outgoing.work_mode } : {}),
        ...(/^[a-f0-9]{64}$/.test(outgoing.sticker_id ?? '') ? { sticker_id: outgoing.sticker_id } : {}),
      };
      if (row.readerGrant === undefined && typeof outgoing.readerGrant === 'string')
        row.readerGrant = outgoing.readerGrant;
      const hasReceiptOrder =
        !row.readerOrder &&
        outgoing.delivery_status === 'confirmed' &&
        validReaderOrder(receiptOrder) &&
        Number(receiptOrder.slice(0, 20)) === outgoing.timestamp;
      const readerOrder = hasReceiptOrder ? receiptOrder : row.readerOrder;
      const timestamp = hasReceiptOrder ? outgoing.timestamp : row.timestamp;
      if (this.archive && (row.delivery_status !== 'confirmed' || outgoing.delivery_status === 'confirmed')) {
        try {
          this.archive.append(
            key,
            { ...row, timestamp, readerOrder, delivery_status: outgoing.delivery_status },
            { fullText, waitForLock: false },
          );
          delete row.archivePending;
          delete row.archiveText;
        } catch (error) {
          if (error?.code !== 'ERR_SQLITE_ERROR') throw error;
          // A desktop result remains valid while the history database cannot accept the write.
          row.archivePending = true;
          if (fullText !== row.text) row.archiveText = fullText;
          else delete row.archiveText;
        }
      }

      if (row.delivery_status === 'unconfirmed' && outgoing.delivery_status === 'confirmed') {
        row.delivery_status = 'confirmed';
        row.text = fullText.slice(0, 4000);
      }
      if (!existing || hasReceiptOrder) {
        if (readerOrder) row.readerOrder = readerOrder;
        row.timestamp = timestamp;
        if (existing) rows.splice(rows.indexOf(existing), 1);
        const later =
          inSendOrder || readerOrder
            ? rows.findIndex(
                item =>
                  item.timestamp > row.timestamp ||
                  (item.timestamp === row.timestamp &&
                    readerOrder &&
                    item.readerOrder &&
                    item.readerOrder > readerOrder),
              )
            : -1;
        if (later < 0) rows.push(row);
        else rows.splice(later, 0, row);
      }
    }
    this.chats.set(key, this.trimRecent(rows));
    if (outgoing && item.noticeId && this.contextNotices.get(key)?.id === item.noticeId)
      this.contextNotices.delete(key);
    this.#save();
  }
  completeReply(key, item, outgoing) {
    if (outgoing) this.recordReplyPart(key, item, outgoing);
    const rows = this.chats.get(key) ?? [];
    const through = rows.find(row => row.id === item.throughId);
    if (through)
      for (const row of rows) {
        if ((row.work_mode ?? 'social') === (through.work_mode ?? 'social')) row.processed = true;
        if (row.id === item.throughId) break;
      }
    this.chats.set(key, this.trimRecent(rows));
    this.pendingReplies.delete(key);
    if (item.noticeId && this.contextNotices.get(key)?.id === item.noticeId) this.contextNotices.delete(key);
    this.#save();
  }

  trimRecent(rows) {
    let excess = rows.length - this.maxPerChat;
    if (excess <= 0) return rows;
    const latest = rows.at(-1);
    return rows.filter(row => {
      // Keep unread work and input whose archive write has not succeeded.
      if (row !== latest && excess > 0 && row.processed && !row.archivePending) {
        excess--;
        return false;
      }
      return true;
    });
  }
  recent(key, limit = 50) {
    return (this.chats.get(key) ?? []).slice(-Math.min(this.maxPerChat, Math.max(1, Number(limit) || 50)));
  }
  keys() {
    return [...this.chats.keys()];
  }
  unread(key, limit = 50, accepts = () => true) {
    return (this.chats.get(key) ?? []).filter(row => !row.processed && accepts(row)).slice(0, limit);
  }
  markProcessed(key, throughId = null, noticeId = null) {
    const rows = this.chats.get(key) ?? [];
    if (throughId && !rows.some(row => row.id === throughId)) return;
    const through = throughId ? rows.find(row => row.id === throughId) : null;
    for (const row of rows) {
      if (!through || (row.work_mode ?? 'social') === (through.work_mode ?? 'social')) row.processed = true;
      if (throughId && row.id === throughId) break;
    }
    if (noticeId && this.contextNotices.get(key)?.id === noticeId) this.contextNotices.delete(key);
    this.chats.set(key, this.trimRecent(rows));
    this.pendingRequests.delete(key);
    this.#save();
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const chats = Object.fromEntries(this.chats);
    const readerMedia = new Set();
    if (this.readerAccount) {
      // Save the references with the rows and pending requests in the same
      // atomic write. The Reader can then acknowledge without dropping them.
      const track = ({ images, files, voice, forwardedVoices }) => {
        for (const item of [...(images ?? []), ...(files ?? []), voice, ...(forwardedVoices ?? [])])
          if (/^[a-f0-9]{64}$/.test(item?.id ?? '')) readerMedia.add(item.id);
      };
      for (const rows of this.chats.values()) for (const row of rows) track(row);
      for (const request of this.pendingRequests.values()) track(request.metadata);
    }
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify({
        version: 1,
        chats,
        ...(this.readerAccount ? { readerMediaPins: { account: this.readerAccount, ids: [...readerMedia] } } : {}),
        dshConnection: this.dshConnection,
        pendingReplies: Object.fromEntries(this.pendingReplies),
        replyReceipts: Object.fromEntries(this.replyReceipts),
        mediaReplies: Object.fromEntries(this.mediaReplies),
        contextNotices: Object.fromEntries(this.contextNotices),
        pendingRequests: Object.fromEntries(this.pendingRequests),
      }),
      { mode: 0o600, flush: true },
    );
    // Windows may briefly deny replacement while the Reader loads the snapshot.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, this.file);
        return;
      } catch (error) {
        if (process.platform !== 'win32' || attempt === 5 || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code))
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
      }
    }
  }
}
