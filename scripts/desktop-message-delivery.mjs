import crypto from 'node:crypto';

export class AdapterError extends Error {
  constructor(code, data) {
    super(code);
    this.name = 'AdapterError';
    this.data = data;
  }
}

// Keep the bridge identity for recovery and proactive replies. The desktop
// executor owns submission, server-record matching and exclusive receipt claims.
export async function deliverDesktopMessage(adapter, request, prepare) {
  const { kind, target, text, quoteEventId, receiptOnly, proactive, media } = request;
  const deliveryId = request.deliveryId || crypto.randomUUID();
  const key = adapter.textDeliveries.key(kind, target, deliveryId, text);
  const lane = kind + ':' + target;
  const uncertain = () =>
    new AdapterError(media ? 'STICKER_DELIVERY_UNCONFIRMED' : 'TEXT_DELIVERY_UNCONFIRMED', {
      attempted: true,
      delivery_id: deliveryId,
    });
  const pending = () => ({ delivery_id: deliveryId, pending: true, delivered: 'unconfirmed' });
  let ownsLane = false,
    submittingMedia;
  function acquireLane() {
    if (adapter.targetsSending.has(lane)) return false;
    adapter.targetsSending.add(lane);
    if (media) {
      submittingMedia = { text, withdrawn: false };
      (adapter.submittingMedia ??= new Map()).set(key, submittingMedia);
    }
    ownsLane = true;
    return true;
  }
  if (!receiptOnly && !acquireLane()) throw new AdapterError('SENDER_BUSY');
  try {
    const { account } = await adapter.checkNative();
    let attempt = adapter.textDeliveries.get(key);
    if (receiptOnly && !attempt && !request.abandon) throw uncertain();
    adapter.reload();
    if (!adapter.allowed(kind, target)) throw new AdapterError('CONVERSATION_NOT_ALLOWED');
    const grant = adapter.project.wechat.rosterGrants?.['wechat:' + lane] ?? 'legacy';
    const scope = { account, accountRef: adapter.accountRef, kind, target, rosterGrant: grant };
    const plugin = request.voicePlugin;
    if (
      plugin &&
      (plugin.account !== account ||
        plugin.accountRef !== scope.accountRef ||
        plugin.target !== target ||
        plugin.rosterGrant !== grant)
    )
      throw new AdapterError('VOICE_TTS_PERMISSION_CHANGED');
    if (
      attempt &&
      (attempt.account !== account ||
        attempt.accountRef !== scope.accountRef ||
        attempt.target !== target ||
        attempt.grant !== grant ||
        attempt.text !== text ||
        attempt.quoteEventId !== quoteEventId ||
        (media ? !['image', 'sticker'].includes(attempt.operation) : attempt.operation !== 'text'))
    )
      throw new AdapterError('TEXT_DELIVERY_ID_CONFLICT');
    if (request.abandon) {
      const flight = adapter.submittingMedia?.get(key);
      if (flight?.text === text) flight.withdrawn = true;
      if (attempt && !['confirmed', 'rejected'].includes(attempt.state))
        adapter.textDeliveries.put({ ...attempt, withdrawn: true });
      return { released: true };
    }
    if (attempt?.state === 'confirmed') return { ...attempt.response, reused: true };
    if (attempt?.state === 'rejected')
      throw new AdapterError('NATIVE_SEND_REJECTED', { rejected: true, attempted: false, reason: attempt.reason });

    let result = null;
    if (attempt) {
      try {
        result = await adapter.desktopSender.request('lookup', {
          ...scope,
          deliveryId: key,
          ...(request.observeOnly ? { observeOnly: true } : {}),
        });
      } catch (error) {
        if (error?.code === 'DESKTOP_CONFIGURATION_BUSY') return pending();
        throw uncertain();
      }
      // Only a successful lookup of this account's active AND archived jobs
      // can prove that the executor never admitted the saved intent.
      if (result === null && (attempt.state !== 'dispatching' || !attempt.command)) throw uncertain();
    }
    if (result === null) {
      if (request.observeOnly) throw uncertain();
      if (attempt?.withdrawn) throw new AdapterError('NATIVE_SEND_REJECTED', { rejected: true, attempted: false });
      if (!ownsLane && !acquireLane()) return pending();
      if (adapter.status.paused) {
        if (attempt) return pending();
        throw new AdapterError('INPUT_PAUSED');
      }
      const proactiveContext = attempt ? attempt.proactive : proactive;
      if (proactiveContext)
        adapter.assertProactive(kind, target, await adapter.messages(target), proactiveContext, { account });
      if (attempt?.deadlineAt !== undefined && Date.now() >= attempt.deadlineAt) {
        adapter.textDeliveries.put({ ...attempt, state: 'rejected' });
        throw new AdapterError('NATIVE_SEND_REJECTED', { rejected: true, attempted: false });
      }
      if (!attempt) {
        const { operation, body } = await prepare(target);
        if (submittingMedia?.withdrawn)
          throw new AdapterError('NATIVE_SEND_REJECTED', { rejected: true, attempted: false });
        attempt = {
          version: 1,
          key,
          deliveryId,
          account,
          accountRef: scope.accountRef,
          grant,
          target,
          text,
          quoteEventId,
          operation,
          command: plugin ? { ...body, voicePlugin: plugin } : body,
          proactive,
          deadlineAt: request.deadlineAt ?? proactive?.expiresAt,
          startedAt: Date.now(),
          state: 'dispatching',
        };
        adapter.textDeliveries.put(attempt);
      }
      try {
        result = await adapter.dispatchDesktop(
          attempt.operation,
          {
            ...attempt.command,
            ...scope,
            deliveryId: key,
            parentId: deliveryId,
            ...(attempt.proactive ? { proactive: attempt.proactive } : {}),
            ...(attempt.deadlineAt !== undefined ? { inputDeadlineAt: attempt.deadlineAt } : {}),
          },
          account,
          { admissionOnly: true },
        );
      } catch (error) {
        if (error.attempted === false) {
          const code = error.senderCode ?? error.code ?? error.message;
          const reason = /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'DESKTOP_ADMISSION_FAILED';
          adapter.textDeliveries.put({ ...attempt, state: 'rejected', reason });
          throw new AdapterError('NATIVE_SEND_REJECTED', { rejected: true, attempted: false, reason });
        }
        // A lost response and a pre-admission interruption are resolved by the
        // same scoped lookup on the next poll. Neither allocates a new ID.
        return pending();
      }
    }
    if (result?.deliveryId !== key || result.operation !== attempt.operation || result.admitted !== true)
      throw uncertain();
    const latest = adapter.textDeliveries.get(key);
    if (latest?.state === 'confirmed') return { ...latest.response, reused: true };
    if (latest?.state === 'accepted' || latest?.withdrawn) attempt = latest;
    if (attempt.state === 'dispatching') {
      const { command, ...admitted } = attempt;
      attempt = { ...admitted, state: 'accepted' };
      adapter.textDeliveries.put(attempt);
    }
    if (['failed', 'cancelled'].includes(result.state) && result.submission === 'not-started' && !result.inputStarted) {
      adapter.textDeliveries.put({ ...attempt, state: 'rejected' });
      throw new AdapterError('NATIVE_SEND_REJECTED', { rejected: true, attempted: false });
    }
    if (result.state !== 'confirmed' || result.confirmed !== true) {
      if (result.pending === true && result.state !== 'conflict' && !result.recovery) {
        return { delivery_id: deliveryId, pending: true, delivered: 'unconfirmed' };
      }
      throw uncertain();
    }
    const receipt = result.receipt;
    const localId = Number(receipt?.localId);
    if (
      receipt?.source !== 'wechat-server-id' ||
      !/^[1-9]\d{0,31}$/.test(String(receipt.serverId)) ||
      !Number.isSafeInteger(localId) ||
      localId < 1
    )
      throw uncertain();
    const response = {
      message_id: localId,
      server_id: String(receipt.serverId),
      receipt: receipt.source,
      delivered: 'database-confirmed',
    };
    if (media) {
      response.media_type = attempt.operation === 'image' ? 'wechat-image' : 'wechat-sticker';
      if (attempt.operation === 'image') response.imageContentVerified = false;
    }
    if (adapter.textDeliveries.get(key)?.state !== 'confirmed') {
      adapter.textDeliveries.put({ ...attempt, state: 'confirmed', confirmedAt: Date.now(), response });
      adapter.status.confirmed_sends++;
    }
    adapter.status.last_error = '';
    return response;
  } finally {
    if (submittingMedia) adapter.submittingMedia.delete(key);
    if (ownsLane) adapter.targetsSending.delete(lane);
  }
}
