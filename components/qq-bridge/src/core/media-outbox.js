import { boundedTask } from '../../../../packages/dsh-social-bridge-plugin/deadline.mjs';
import {
  replyDeliveryStatus,
  replySentAt,
  TERMINAL_DELIVERY_STATES as finished,
} from '../../../../packages/delivery-contract.mjs';

const withdrawnNotice = '聊天授权已变化，待发配图已停止。';
const laneFor = (key, observeOnly) => (observeOnly ? 'receipt:' + key : key);

function mediaHistory({ status, mediaType }) {
  if (status !== 'confirmed') return { text: '[微信配图送达待核对]', delivery_status: 'unconfirmed' };
  const text = mediaType === 'wechat-image' ? '[已发送微信图片]' : '[已发送微信原生表情包]';
  return { text, delivery_status: 'confirmed' };
}

// Media delivery has its own durable lane. It never owns the model/chat lock.
export class MediaOutbox {
  constructor({
    buffer,
    send,
    policy,
    quota,
    noteOutgoing,
    retry,
    log,
    deliveryControls,
    inspectReceipt,
    naturalReplyAllowed = () => true,
  }) {
    Object.assign(this, {
      buffer,
      send,
      policy,
      quota,
      noteOutgoing,
      retry,
      log,
      deliveryControls,
      inspectReceipt,
      naturalReplyAllowed,
    });
    this.running = new Map();
    this.timers = new Map();
    this.stopped = false;
    for (const item of buffer.mediaReplies.values()) this.wake(item.key, Date.now(), item.observeOnly === true);
  }
  enqueue(key, pending, part) {
    const existing = this.buffer.mediaReplies.get(part.deliveryId);
    if (existing) {
      this.wake(key, Date.now(), existing.observeOnly === true);
      return;
    }
    const grant = pending.rosterGrant ?? pending.message?.readerGrant ?? 'legacy';
    if (this.deliveryControls && !this.deliveryControls.register(key, grant, [part])) return;
    if (pending.naturalGroupEpoch !== undefined)
      this.deliveryControls?.requireNaturalReply(key, grant, [part.deliveryId], pending.naturalGroupEpoch);
    const active = [...this.buffer.mediaReplies.values()].filter(item => !item.observeOnly);
    const peers = active.filter(item => item.key === key);
    if (peers.length >= 3 || active.length >= 64) {
      this.deliveryControls?.update(key, grant, part.deliveryId, 'cancelled');
      this.buffer.setContextNotice(key, {
        id: part.deliveryId,
        text: '本机待发表情队列已满，本轮配图已取消；文字回复继续。',
      });
      return;
    }
    const now = Date.now();
    this.buffer.mediaReplies.set(part.deliveryId, {
      key,
      message: { ...pending.message, readerGrant: grant },
      part: { ...part },
      ...(pending.naturalGroupEpoch ? { naturalGroupEpoch: pending.naturalGroupEpoch } : {}),
      createdAt: now,
      expiresAt: now + this.retry.mediaDeadlineMs,
    });
    this.buffer.saveMedia();
    if (!peers.length) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    this.wake(key);
  }
  wake(key, at = Date.now(), observeOnly = false) {
    const lane = laneFor(key, observeOnly);
    if (this.stopped || this.running.has(lane) || this.timers.has(lane)) return;
    this.timers.set(
      lane,
      setTimeout(
        () => {
          this.timers.delete(lane);
          void this.run(key, observeOnly);
        },
        Math.max(0, at - Date.now()),
      ),
    );
  }
  finish(item, reason, state) {
    if (state !== 'confirmed' && ['sending', 'submitted'].includes(item.part.state)) {
      this.deliveryControls?.withdrawInputs(item.key, item.message.readerGrant ?? 'legacy', [item.part.deliveryId]);
      // Release only the adapter's matching receipt reservation. This RPC has
      // no native-send path and cannot submit the abandoned image again.
      void boundedTask(
        () =>
          this.send(item.message, item.part.stickerId, {
            deliveryId: item.part.deliveryId,
            ...(item.part.quoteEventId ? { quoteEventId: item.part.quoteEventId } : {}),
            receiptOnly: true,
            abandon: true,
          }),
        { timeoutMs: 1000 },
      ).catch(() => {});
    }
    state ??= ['sending', 'submitted'].includes(item.part.state)
      ? 'unconfirmed'
      : item.part.state === 'confirmed'
        ? 'confirmed'
        : 'cancelled';
    this.deliveryControls?.update(item.key, item.message?.readerGrant ?? 'legacy', item.part.deliveryId, state);
    this.buffer.mediaReplies.delete(item.part.deliveryId);
    this.buffer.saveMedia();
    if (reason) this.buffer.setContextNotice(item.key, { id: item.part.deliveryId, text: reason });
  }
  recordReceipt(item, receipt, at) {
    this.buffer.recordReplyPart(
      item.key,
      item.part,
      {
        ...item.message,
        sender_id: item.message.self_id,
        timestamp: at / 1000,
        ...mediaHistory(receipt),
        sticker_id: item.part.stickerId,
      },
      { inSendOrder: item.observeOnly === true || receipt.sentAt === at, receiptOrder: receipt.readerOrder },
    );
    if (receipt.status === 'confirmed') item.part.state = 'confirmed';
  }
  async run(key, observeOnly = false) {
    const lane = laneFor(key, observeOnly);
    if (this.stopped || this.running.has(lane)) return;
    const matches = item => item.key === key && (item.observeOnly === true) === observeOnly;
    const item = [...this.buffer.mediaReplies.values()].find(matches);
    if (!item) return;
    const controller = new AbortController();
    this.running.set(lane, controller);
    if (observeOnly) {
      // An unresolved receipt must leave room for the other retired deliveries.
      this.buffer.mediaReplies.delete(item.part.deliveryId);
      this.buffer.mediaReplies.set(item.part.deliveryId, item);
    }
    let nextAt = Date.now();
    const { part } = item,
      grant = item.message?.readerGrant ?? 'legacy';
    const retireIfGrantChanged = () => {
      if (!this.deliveryControls || this.deliveryControls.scope(key) === grant) return false;
      this.retirePending(item, withdrawnNotice);
      return true;
    };
    let receiptOnly = ['sending', 'submitted'].includes(part.state);
    try {
      const existing = this.buffer.findReplyPart(key, part.deliveryId);
      if (existing?.delivery_status === 'confirmed' && existing.sticker_id === part.stickerId) {
        part.state = 'confirmed';
        this.finish(item);
        return;
      }
      if (!observeOnly && this.deliveryControls && !this.deliveryControls.register(key, grant, [part])) {
        this.retirePending(item, withdrawnNotice);
        return;
      }
      if (!observeOnly && !this.naturalReplyAllowed(key, item.naturalGroupEpoch)) {
        this.retirePending(item, '群聊回复规则已变更，本机已取消这轮自然参与中尚未发送的配图。');
        return;
      }
      if (observeOnly) {
        nextAt = Date.now() + this.retry.receiptDelayMs;
        let receipt = { status: 'unconfirmed' };
        try {
          receipt = await boundedTask(() => this.inspectReceipt(item.message, part), {
            timeoutMs: this.retry.mediaCallTimeoutMs,
            signal: controller.signal,
            code: 'MEDIA_RECEIPT_TIMEOUT',
          });
        } catch (error) {
          if (
            ![
              'CONVERSATION_NOT_ALLOWED',
              'CONVERSATION_GRANT_CHANGED',
              'NATIVE_SEND_REJECTED',
              'TEXT_DELIVERY_ID_CONFLICT',
            ].includes(error.code)
          )
            return;
          if (error.code === 'NATIVE_SEND_REJECTED' && error.data?.attempted === false) {
            this.finish(item, undefined, 'cancelled');
            return;
          }
        }
        if (this.stopped || !this.buffer.mediaReplies.has(part.deliveryId) || receipt.status === 'pending') return;
        const at = replySentAt(receipt, item.retiredAt);
        this.recordReceipt(item, receipt, at);
        const confirmed = receipt.status === 'confirmed';
        this.finish(item, undefined, confirmed ? 'confirmed' : 'unconfirmed');
        if (confirmed && !existing) this.noteOutgoing(key, at);
        return;
      }
      const expired = !part.desktopPending && Date.now() >= item.expiresAt;
      const readStatus = expire =>
        this.deliveryControls?.mediaStatus(key, grant, part.deliveryId, expire) ?? {
          state: expire ? (receiptOnly ? 'unconfirmed' : 'expired') : part.state,
        };
      let queue = readStatus(false);
      receiptOnly ||= ['submitting', 'submitted'].includes(queue.state);
      // The native queue may already own the request even if its response was lost.
      if (expired && !receiptOnly && !queue.retained) queue = readStatus(true);
      if (queue.state === 'cancelled' && retireIfGrantChanged()) return;
      if (finished.has(queue.state)) {
        this.finish(
          item,
          expired && ['expired', 'unconfirmed'].includes(queue.state)
            ? '本机上一轮配图已超过等待时限，不再提交；已提交的图片送达情况未知，不能声称已收到。'
            : undefined,
          queue.state,
        );
        return;
      }
      const admissionDeadlineAt = queue.retained ? undefined : item.expiresAt;
      const limit = part.desktopPending || (expired && receiptOnly) ? Infinity : (admissionDeadlineAt ?? Infinity);
      if (!receiptOnly) {
        const allowed = await boundedTask(() => this.policy(item.message), {
          timeoutMs: 1000,
          signal: controller.signal,
        });
        if (this.stopped || item.observeOnly || !this.buffer.mediaReplies.has(part.deliveryId)) return;
        if (!allowed.enabled) {
          this.finish(item, '本机表情开关关闭，待发配图取消。');
          return;
        }
        const readyAt = this.quota(key);
        if (readyAt >= limit) {
          const result = readStatus(true);
          if (finished.has(result.state)) {
            this.finish(item, '本机发送额度不足，本轮配图已终结，后续文字继续按发送限额处理。', result.state);
            return;
          }
        }
        if (readyAt > Date.now()) {
          nextAt = readyAt;
          return;
        }
      }
      if (!this.buffer.mediaReplies.has(part.deliveryId)) return;
      if (part.retryAt > Date.now()) {
        nextAt = Math.min(part.retryAt, limit);
        return;
      }
      const claim = this.deliveryControls?.claim(key, grant, part.deliveryId) ?? 'send';
      if (claim === 'paused') {
        nextAt = Math.min(limit, Date.now() + 1000);
        return;
      }
      if (claim === 'cancelled' && retireIfGrantChanged()) return;
      if (finished.has(claim)) {
        this.finish(item, undefined, claim);
        return;
      }
      receiptOnly ||= claim === 'submitted';
      if (receiptOnly) part.receiptChecks = (part.receiptChecks ?? 0) + 1;
      part.state = 'sending';
      delete part.retryAt;
      this.buffer.saveMedia();
      let delivery;
      try {
        delivery = await boundedTask(
          () =>
            this.send(item.message, part.stickerId, {
              deliveryId: part.deliveryId,
              ...(part.quoteEventId ? { quoteEventId: part.quoteEventId } : {}),
              ...(receiptOnly ? { receiptOnly: true } : {}),
              ...(admissionDeadlineAt !== undefined ? { admissionDeadlineAt } : {}),
            }),
          {
            timeoutMs: this.retry.mediaCallTimeoutMs,
            signal: controller.signal,
            code: 'MEDIA_DELIVERY_TIMEOUT',
          },
        );
      } catch (error) {
        if (this.stopped || item.observeOnly || !this.buffer.mediaReplies.has(part.deliveryId)) return;
        if (retireIfGrantChanged()) return;
        if (
          receiptOnly &&
          part.desktopPending &&
          (!error.code || ['SENDER_BUSY', 'MEDIA_DELIVERY_TIMEOUT', 'BACKEND_UNAVAILABLE'].includes(error.code))
        ) {
          delivery = { pending: true, admitted: true };
        } else if (error.code === 'STICKER_DELIVERY_EXPIRED' && error.data?.attempted === false) {
          const latest = readStatus(false);
          if (latest.retained && !finished.has(latest.state)) {
            part.state = 'queued';
            part.receiptChecks = 0;
            delete part.desktopPending;
            this.deliveryControls?.update(key, grant, part.deliveryId, 'queued');
            nextAt = Date.now() + this.retry.receiptDelayMs;
          } else {
            const state = finished.has(latest.state) ? latest.state : 'expired';
            this.finish(item, state === 'expired' ? '本机上一轮配图在入队前已过期。' : undefined, state);
          }
          return;
        } else if (error.code === 'SENDER_BUSY') {
          part.state = receiptOnly ? 'submitted' : 'queued';
          if (receiptOnly) part.receiptChecks--;
          this.deliveryControls?.update(key, grant, part.deliveryId, part.state);
          part.busyAttempts = (part.busyAttempts ?? 0) + 1;
          if (part.busyAttempts > this.retry.maxBusyRetries) {
            this.finish(item, '本机发送器持续忙碌，上一轮配图已终结，文字回复继续。');
            return;
          }
          part.retryAt = nextAt = Math.min(
            limit,
            Date.now() + Math.min(5000, this.retry.busyDelayMs * 2 ** (part.busyAttempts - 1)),
          );
          return;
        } else if (error.code && !['STICKER_DELIVERY_UNCONFIRMED', 'MEDIA_DELIVERY_TIMEOUT'].includes(error.code)) {
          this.finish(item, '本机上一轮表情发送失败或未能确认送达，不自动重发，继续回应新消息。');
          this.log(`[Social] ${key} media_failed reason=${error.code}`);
          return;
        } else {
          // A timed-out/lost RPC may already have submitted the sticker.
          delivery = { delivered: 'unconfirmed' };
        }
      }
      if (this.stopped || item.observeOnly || !this.buffer.mediaReplies.has(part.deliveryId)) return;
      const status = replyDeliveryStatus(delivery);
      if (status !== 'confirmed' && retireIfGrantChanged()) return;
      if (status === 'pending') {
        part.state = 'submitted';
        if (delivery.admitted === true) part.desktopPending = true;
        part.receiptChecks = 0;
        this.deliveryControls?.update(key, grant, part.deliveryId, 'submitted');
        nextAt = Date.now() + this.retry.receiptDelayMs;
        return;
      }
      const confirmed = status === 'confirmed',
        at = confirmed ? replySentAt(delivery) : Date.now();
      const receipt = {
        status,
        sentAt: delivery?.sentAt,
        readerOrder: delivery?.readerOrder,
        mediaType: delivery?.data?.media_type,
      };
      // Store the receipt while the outbox entry is still recoverable.
      part.state = 'submitted';
      if (!confirmed) this.deliveryControls?.update(key, grant, part.deliveryId, 'submitted');
      this.recordReceipt(item, receipt, at);
      if (confirmed) this.finish(item);
      if (!existing) this.noteOutgoing(key, at);
      this.log(`[Social] ${key} media_delivery=${receipt.status} operation=${part.deliveryId.slice(0, 12)}`);
      if (confirmed) return;
      if ((part.receiptChecks ?? 0) >= this.retry.maxReceiptChecks) {
        this.finish(item, '本机上一轮表情送达未确认；不重复提交，继续回应新消息。');
        return;
      }
      nextAt = Math.min(limit, Date.now() + this.retry.receiptDelayMs);
    } catch (error) {
      if (!this.stopped && matches(item) && this.buffer.mediaReplies.has(part.deliveryId)) {
        this.finish(item, '本机配图处理异常，本轮配图已终结，文字回复继续。');
        this.log(`[Social] ${key} media_failed reason=${error.code ?? 'MEDIA_PROCESS_FAILED'}`);
      }
    } finally {
      this.running.delete(lane);
      if (!this.stopped && !observeOnly && matches(item) && this.buffer.mediaReplies.has(part.deliveryId))
        this.buffer.saveMedia();
      if (!this.stopped && [...this.buffer.mediaReplies.values()].some(matches)) this.wake(key, nextAt, observeOnly);
    }
  }
  cancelOffline() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const item of [...this.buffer.mediaReplies.values()]) {
      this.retirePending(item, 'DSH 已离线或重启，旧配图不再补发；已提交部分保留送达记录，不视为已确认。');
    }
  }
  retirePending(item, notice) {
    const { part, key } = item;
    const grant = item.message.readerGrant ?? 'legacy';
    this.deliveryControls?.withdrawInputs(key, grant, [part.deliveryId]);
    if (
      this.inspectReceipt &&
      (['sending', 'submitted'].includes(part.state) ||
        (part.state === 'queued' && this.deliveryControls?.hasSubmissionClaim(key, grant, part.deliveryId)))
    ) {
      item.observeOnly = true;
      item.retiredAt ??= Date.now();
      item.part.state = 'submitted';
      this.buffer.saveMedia();
      this.wake(item.key, Date.now(), true);
    } else {
      this.finish(item, notice);
    }
  }
  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.running.values()) controller.abort(new Error('media_stopped'));
  }
}
