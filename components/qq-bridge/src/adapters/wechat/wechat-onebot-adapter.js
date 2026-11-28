import { validChatId, validUserId, validReaderOrder } from '../../../../../packages/wechat-identity.mjs';
import { imageContentMatched, replyDeliveryStatus } from '../../../../../packages/delivery-contract.mjs';
import { voiceFallbackId } from '../../../../../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
import crypto from 'node:crypto';
import { BaseAdapter } from '../base-adapter.js';
import { ReverseOneBotServer } from '../../onebot/reverse-ws-server.js';
import { normalizeOneBotEvent } from '../../onebot/normalize.js';

const sentTiming = data =>
  Number.isSafeInteger(data?.sentAt)
    ? { sentAt: data.sentAt, ...(validReaderOrder(data.readerOrder) ? { readerOrder: data.readerOrder } : {}) }
    : {};

export class WechatOneBotAdapter extends BaseAdapter {
  constructor(config = {}, log = () => {}) {
    super('wechat', { mention: true });
    this.log = log;
    this.server = new ReverseOneBotServer(config.server ?? {});
    this.recentOutgoing = new Map();
    this.recentIncoming = new Map();
    this.antiLoopTtlMs = Math.max(1000, Number(config.antiLoopTtlMs) || 60000);
    this.server.on('open', () => {
      this.stats.connected = true;
      this.emit('open');
    });
    this.server.on('close', () => {
      this.stats.connected = false;
      this.selfId = '';
      this.emit('close');
    });
    this.server.on('error', error => {
      this.stats.errors++;
      this.emit('error', error);
    });
    this.server.on('invalid', kind => {
      this.stats.errors++;
      this.log(`[WeChat] ${kind}`);
    });
    this.server.on('event', event => this.#receive(event));
  }

  #fingerprint(kind, target, content) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify([kind, String(target), String(content).trim()]))
      .digest('hex');
  }

  #prune(now) {
    for (const cache of [this.recentOutgoing, this.recentIncoming]) {
      for (const [key, expires] of cache) if (expires <= now) cache.delete(key);
      while (cache.size > 1000) cache.delete(cache.keys().next().value);
    }
  }

  #receive(event) {
    if (event?.post_type === 'meta_event') {
      if (!validUserId(event.self_id)) return;
      this.selfId = event.self_id;
      this.emit('meta', event);
      return;
    }
    const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
    if (!message) return;
    if (
      !['text', 'image', 'file', 'record'].includes(message.message_type) ||
      (message.message_type === 'record' && !message.voice) ||
      (message.message_type === 'file' && !message.files.length) ||
      (message.message_type === 'image' && !message.images.length)
    ) {
      this.log(`[WeChat] unsupported_message_type=${message.message_type}`);
      return;
    }
    if (!message.text) return;
    const now = Date.now();
    this.#prune(now);
    const key = this.#fingerprint(message.kind, message.conversation_id, message.text);
    const selfId = message.self_id;
    if (selfId) this.selfId = selfId;
    if (selfId && (message.sender_id === selfId || String(event.user_id ?? '') === selfId)) return;
    const intake = event.wechatagent?.readerIntake;
    if (intake !== undefined) {
      if (
        intake?.version !== 1 ||
        intake.rawid !== message.message_id ||
        !/^[a-f0-9]{64}$/.test(intake.token) ||
        typeof this.acceptPersisted !== 'function'
      )
        return;
      void Promise.resolve()
        .then(() => this.acceptPersisted(message, intake))
        .then(accepted => {
          if (!accepted) return;
          return this.server.action('ack_wechatagent_intake', {
            rawid: intake.rawid,
            token: intake.token,
            self_id: selfId,
          });
        })
        .catch(() => this.log('[WeChat] durable admission will retry'));
      return;
    }
    if (this.recentOutgoing.has(key)) return;
    const incomingKey = `${message.message_id}:${key}`;
    if (this.recentIncoming.has(incomingKey)) return;
    this.recentIncoming.set(incomingKey, now + this.antiLoopTtlMs);
    this.stats.messages++;
    this.emit('message', message);
  }

  async start() {
    await this.server.start();
  }
  async stop() {
    await this.server.stop();
  }
  async inspectReplyReceipt(message, part) {
    const scope = {
      kind: message.kind,
      target: message.conversation_id,
      rosterGrant: message.readerGrant,
      deliveryId: part.deliveryId,
      receiptOnly: true,
      observeOnly: true,
    };
    if (part.stickerId) {
      const result = await this.sendSticker({ ...scope, id: part.stickerId, quoteEventId: part.quoteEventId });
      if (replyDeliveryStatus(result) === 'pending') return { status: 'pending' };
      return {
        status: replyDeliveryStatus(result),
        mediaType: result.data?.media_type,
        ...sentTiming(result),
      };
    }
    if (part.voiceText && !part.voiceFallback) {
      const result = await this.sendVoiceText({ ...scope, text: part.voiceText });
      return { status: result.status, ...sentTiming(result) };
    }
    if (part.voiceFallback) scope.deliveryId = voiceFallbackId(part.deliveryId);
    const result = await this.sendText({
      ...scope,
      text: part.text ?? part.voiceText,
      quoteEventId: part.quoteEventId,
    });
    return { status: replyDeliveryStatus(result), ...sentTiming(result) };
  }
  async sendText({
    kind,
    target,
    text,
    deliveryId,
    source,
    contextId,
    expiresAt,
    quoteEventId,
    rosterGrant,
    receiptOnly = false,
    observeOnly = false,
  }) {
    if (kind !== 'private' && kind !== 'group') throw new TypeError('invalid WeChat kind');
    const content = String(text ?? '').trim();
    if (!content) throw new TypeError('empty WeChat message');
    if (!validChatId(kind, target)) throw new TypeError('invalid WeChat target');
    if (!receiptOnly) deliveryId ??= crypto.randomBytes(32).toString('hex');
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = {
      [kind === 'group' ? 'group_id' : 'user_id']: target,
      message: [
        ...(quoteEventId ? [{ type: 'reply', data: { id: quoteEventId } }] : []),
        { type: 'text', data: { text: content } },
      ],
      ...(deliveryId ? { wechatagent_delivery_id: deliveryId } : {}),
      ...(rosterGrant === undefined ? {} : { wechatagent_roster_grant: rosterGrant }),
      ...(source === 'proactive'
        ? {
            wechatagent_source: 'proactive',
            wechatagent_context_id: contextId,
            wechatagent_proactive_expires_at: expiresAt,
          }
        : {}),
    };
    let result;
    try {
      result = await this.server.action(receiptOnly ? 'get_text_delivery' : action, {
        ...params,
        ...(receiptOnly ? { kind, target } : {}),
        ...(observeOnly ? { wechatagent_observe_only: true } : {}),
      });
    } catch (error) {
      if (error.code !== 'TEXT_DELIVERY_UNCONFIRMED' || error.data?.attempted !== true) throw error;
      this.#prune(Date.now());
      this.recentOutgoing.set(this.#fingerprint(kind, target, content), Date.now() + this.antiLoopTtlMs);
      this.log(`[WeChat] text_delivery_unconfirmed operation=${String(deliveryId ?? '').slice(0, 12)}`);
      return { accepted: false, attempted: true, confirmed: false, delivered: 'unconfirmed', deliveryId };
    }
    if (result.data?.pending === true && result.data.delivery_id === deliveryId) {
      return {
        pending: true,
        confirmed: false,
        delivered: 'unconfirmed',
        deliveryId,
        ...(result.data.admitted === true ? { admitted: true } : {}),
      };
    }
    // The I/O service acknowledges only after a new matching server receipt.
    if (result.data?.receipt !== 'wechat-server-id')
      throw new Error('WeChat send response has no verified server receipt');
    this.#prune(Date.now());
    this.recentOutgoing.set(this.#fingerprint(kind, target, content), Date.now() + this.antiLoopTtlMs);
    this.stats.sends++;
    return {
      accepted: true,
      confirmed: true,
      response: result,
      delivered: 'database-confirmed',
      deliveryId,
      ...sentTiming(result.data),
    };
  }
  // Whether WCA can send a native voice reply to this chat right now.
  async voiceCapability({ kind, target, rosterGrant }) {
    if (!validChatId(kind, target)) throw new TypeError('invalid WeChat kind');
    const result = await this.server.action('get_voice_capability', {
      kind,
      target: String(target),
      ...(rosterGrant === undefined ? {} : { wechatagent_roster_grant: rosterGrant }),
    });
    return { voice: result.data?.voice === true };
  }
  // A reply chosen as voice: WCA synthesizes and sends it once per delivery ID;
  // repeating the call only reports that delivery's status.
  async sendVoiceText({ kind, target, text, deliveryId, rosterGrant, receiptOnly = false, observeOnly = false }) {
    if (!validChatId(kind, target) || !/^[a-f0-9]{64}$/.test(deliveryId ?? ''))
      throw new TypeError('invalid voice reply target');
    const content = String(text ?? '').trim();
    if (!content) throw new TypeError('empty WeChat voice reply');
    const result = await this.server.action(receiptOnly ? 'get_voice_delivery' : 'send_voice_text', {
      kind,
      target: String(target),
      text: content,
      wechatagent_delivery_id: deliveryId,
      ...(rosterGrant === undefined ? {} : { wechatagent_roster_grant: rosterGrant }),
      ...(observeOnly ? { wechatagent_observe_only: true } : {}),
    });
    const data = result.data ?? {};
    if (data.status === 'confirmed') this.stats.sends++;
    return {
      status: data.status,
      fallback: data.fallback === true,
      ...(data.admitted === true ? { admitted: true } : {}),
      ...(typeof data.error === 'string' ? { error: data.error } : {}),
      ...(data.status === 'confirmed' ? sentTiming(data) : {}),
    };
  }
  async stickerChoices({ kind, target, query }) {
    const result = await this.server.action('get_sticker_list', {
      kind,
      target: String(target),
      ...(typeof query === 'string' && query.trim() ? { query: query.slice(0, 500) } : {}),
    });
    return result.data?.enabled ? (result.data.stickers ?? []) : [];
  }
  async sendSticker({
    kind,
    target,
    id,
    quoteEventId,
    deliveryId,
    rosterGrant,
    receiptOnly = false,
    deadlineAt,
    admissionDeadlineAt,
    abandon = false,
    observeOnly = false,
  }) {
    if (!validChatId(kind, target) || !/^[a-f0-9]{64}$/.test(id)) throw new TypeError('invalid sticker target');
    if (quoteEventId !== undefined && (!deliveryId || !/^[a-f0-9]{64}$/.test(quoteEventId)))
      throw new TypeError('invalid quote source');
    let result;
    try {
      result = await this.server.action(kind === 'group' ? 'send_group_msg' : 'send_private_msg', {
        [kind === 'group' ? 'group_id' : 'user_id']: target,
        message: [
          ...(quoteEventId ? [{ type: 'reply', data: { id: quoteEventId } }] : []),
          { type: 'wechat_sticker', data: { id } },
        ],
        ...(deliveryId ? { wechatagent_delivery_id: deliveryId } : {}),
        ...(rosterGrant === undefined ? {} : { wechatagent_roster_grant: rosterGrant }),
        ...(receiptOnly ? { wechatagent_receipt_only: true } : {}),
        ...(abandon ? { wechatagent_abandon_delivery: true } : {}),
        ...(observeOnly ? { wechatagent_observe_only: true } : {}),
        ...(deadlineAt !== undefined ? { wechatagent_deadline_at: deadlineAt } : {}),
        ...(admissionDeadlineAt !== undefined ? { wechatagent_admission_deadline_at: admissionDeadlineAt } : {}),
      });
    } catch (error) {
      if (error.code !== 'STICKER_DELIVERY_UNCONFIRMED' || error.data?.attempted !== true) throw error;
      this.log(`[WeChat] sticker_delivery_unconfirmed operation=${String(deliveryId ?? '').slice(0, 12)}`);
      return { accepted: false, attempted: true, delivered: 'unconfirmed', deliveryId };
    }
    if (abandon && result.data?.released === true) return result.data;
    if (result.data?.pending === true && result.data.delivery_id === deliveryId) {
      return {
        pending: true,
        confirmed: false,
        delivered: 'unconfirmed',
        deliveryId,
        ...(result.data.admitted === true ? { admitted: true } : {}),
      };
    }
    if (
      result.data?.receipt !== 'wechat-server-id' ||
      !['wechat-sticker', 'wechat-image'].includes(result.data?.media_type)
    )
      throw new Error('Sticker send has no server receipt');
    if (result.data.media_type === 'wechat-image' && !imageContentMatched(result.data))
      return { accepted: false, attempted: true, delivered: 'unconfirmed', deliveryId };
    const status = replyDeliveryStatus({ ...result, delivered: result.data.delivered });
    if (status === 'confirmed') this.stats.sends++;
    return {
      ...result,
      delivered: status === 'confirmed' ? 'database-confirmed' : status,
      ...(status === 'confirmed' ? sentTiming(result.data) : {}),
    };
  }
  async stickerLabels({ kind, target, ids }) {
    return (await this.server.action('get_sticker_labels', { kind, target: String(target), ids })).data?.labels ?? [];
  }
  async saveStickerLabels({ kind, target, labels }) {
    return this.server.action('save_sticker_labels', { kind, target: String(target), labels });
  }
  async sendPrivateMessage(target, text) {
    return this.sendText({ kind: 'private', target, text });
  }
  async sendGroupMessage(target, text) {
    return this.sendText({ kind: 'group', target, text });
  }
  async reply() {
    throw new Error('unsupported_capability: nativeReply');
  }
  getCapabilities() {
    return this.capabilities;
  }
}
