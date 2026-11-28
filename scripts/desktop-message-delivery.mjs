import crypto from 'node:crypto';
import { validStaticImageReceipt } from './reply-image-format.mjs';
import { wechatServerEventId } from '../packages/wechat-identity.mjs';
import {
  desktopDeliveryStatus,
  desktopQueueFull,
  matchesDesktopDelivery,
  receiptTiming,
} from '../packages/delivery-contract.mjs';

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
  const deliveryId = request.deliveryId ?? crypto.randomBytes(32).toString('hex');
  const key = adapter.textDeliveries.key(kind, target, deliveryId, text);
  const lane = kind + ':' + target;
  const uncertain = () =>
    new AdapterError(media ? 'STICKER_DELIVERY_UNCONFIRMED' : 'TEXT_DELIVERY_UNCONFIRMED', {
      attempted: true,
      delivery_id: deliveryId,
    });
  const pending = (admitted = false) => ({
    delivery_id: deliveryId,
    pending: true,
    delivered: 'unconfirmed',
    ...(admitted ? { admitted: true } : {}),
  });
  const admissionExpired = () =>
    new AdapterError('STICKER_DELIVERY_EXPIRED', { attempted: false, reason: 'DESKTOP_ADMISSION_EXPIRED' });
  const withdrawn = () => new AdapterError('NATIVE_SEND_REJECTED', { rejected: true, attempted: false });
  const rejected = reason => new AdapterError('NATIVE_SEND_REJECTED', { rejected: true, attempted: false, reason });
  const reject = (attempt, code) => {
    const reason = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'DESKTOP_ADMISSION_FAILED';
    adapter.textDeliveries.put({ ...attempt, state: 'rejected', reason });
    return rejected(reason);
  };
  const rosterGrant = () =>
    adapter.allowed(kind, target) ? (adapter.project.wechat.rosterGrants?.['wechat:' + lane] ?? 'legacy') : null;
  let ownsLane = false,
    submittingMedia;
  function acquireLane(scope) {
    if (adapter.targetsSending.has(lane)) return false;
    if (media) {
      submittingMedia = {
        text,
        quoteEventId,
        withdrawn: false,
        accountRef: scope?.accountRef ?? adapter.accountRef,
        grant: scope ? scope.rosterGrant : rosterGrant(),
      };
      (adapter.submittingMedia ??= new Map()).set(key, submittingMedia);
    }
    adapter.targetsSending.add(lane);
    ownsLane = true;
    return true;
  }
  try {
    if (!receiptOnly && !acquireLane()) throw new AdapterError('SENDER_BUSY');
    // A retry can read an existing intent before validating the desktop for new input.
    let attempt = adapter.textDeliveries.get(key);
    const useSavedScope = receiptOnly || !!attempt;
    if (useSavedScope && !attempt && !request.abandon) throw uncertain();
    const { account } = useSavedScope ? adapter.receiptAccount() : await adapter.checkNative();
    if (!useSavedScope) attempt = adapter.textDeliveries.get(key);
    adapter.reload();
    const currentGrant = rosterGrant();
    const flight = request.abandon ? adapter.submittingMedia?.get(key) : null;
    const bound = receiptOnly ? (attempt ?? flight) : null;
    const grant = bound ? bound.grant : currentGrant;
    const hasGrant = currentGrant !== null && grant === currentGrant;
    if (!hasGrant && !bound) throw new AdapterError('CONVERSATION_NOT_ALLOWED');
    if (request.expectedRosterGrant !== undefined && request.expectedRosterGrant !== grant)
      throw new AdapterError('CONVERSATION_GRANT_CHANGED');
    const observeOnly = request.observeOnly || !hasGrant;
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
      const matchingFlight =
        flight &&
        flight.text === text &&
        flight.quoteEventId === quoteEventId &&
        flight.accountRef === scope.accountRef &&
        flight.grant === grant;
      if (flight && !attempt && !matchingFlight) throw new AdapterError('TEXT_DELIVERY_ID_CONFLICT');
      if (matchingFlight) flight.withdrawn = true;
      if (attempt && !['confirmed', 'rejected'].includes(attempt.state))
        adapter.textDeliveries.put({ ...attempt, withdrawn: true });
      return { released: true };
    }
    if (submittingMedia) {
      if (submittingMedia.withdrawn) throw withdrawn();
      submittingMedia.accountRef = scope.accountRef;
      submittingMedia.grant = grant;
    }
    if (attempt?.state === 'confirmed') return { ...attempt.response, reused: true };
    if (attempt?.state === 'rejected') throw rejected(attempt.reason);

    let result = null;
    if (attempt) {
      const lookupOnly = observeOnly || (useSavedScope && (!receiptOnly || attempt.state === 'dispatching'));
      try {
        result = await adapter.desktopSender.request('lookup', {
          ...scope,
          deliveryId: key,
          ...(lookupOnly ? { observeOnly: true } : {}),
        });
      } catch (error) {
        if (attempt.state === 'accepted') return pending(true);
        if (error?.code === 'DESKTOP_CONFIGURATION_BUSY') return pending();
        throw uncertain();
      }
      if (useSavedScope && adapter.receiptAccount().accountRef !== scope.accountRef)
        throw new AdapterError('DESKTOP_ACCOUNT_CHANGED');
      // Only a successful lookup of this account's active AND archived jobs
      // can prove that the executor never admitted the saved intent.
      if (result === null && (attempt.state !== 'dispatching' || !attempt.command)) throw uncertain();
    }
    if (result === null) {
      if (observeOnly) throw uncertain();
      if (attempt?.withdrawn) throw withdrawn();
      if (!ownsLane && !acquireLane(scope)) return pending();
      const admissionDeadlineAt = request.admissionDeadlineAt;
      if (admissionDeadlineAt !== undefined && Date.now() >= admissionDeadlineAt) throw admissionExpired();
      if (useSavedScope) {
        request.reserveAdmission?.();
        const current = await adapter.checkNative();
        if (current.account !== account || adapter.accountRef !== scope.accountRef)
          throw new AdapterError('DESKTOP_ACCOUNT_CHANGED');
        adapter.reload();
        if (rosterGrant() !== grant) throw new AdapterError('CONVERSATION_GRANT_CHANGED');
        const saved = adapter.textDeliveries.get(key);
        if (saved?.state === 'confirmed') return { ...saved.response, reused: true };
        if (saved?.state === 'accepted') return pending(true);
        if (saved?.state === 'rejected' || saved?.withdrawn) throw rejected(saved.reason);
        if (saved?.state !== 'dispatching' || !saved.command) throw uncertain();
        attempt = saved;
      }
      const proactiveContext = attempt ? attempt.proactive : proactive;
      if (proactiveContext)
        adapter.assertProactive(kind, target, await adapter.messages(target), proactiveContext, { account });
      if (attempt?.deadlineAt !== undefined && Date.now() >= attempt.deadlineAt)
        throw reject(attempt, 'DESKTOP_INPUT_EXPIRED');
      const newAttempt = !attempt;
      if (newAttempt) {
        const { operation, body } = await prepare(target);
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
      }
      if (submittingMedia?.withdrawn || (media && !newAttempt && adapter.textDeliveries.get(key)?.withdrawn))
        throw withdrawn();
      if (request.permitInput && request.permitInput() !== true)
        throw new AdapterError('VOICE_TTS_PERMISSION_CHANGED', { attempted: false });
      if (newAttempt) adapter.textDeliveries.put(attempt);
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
          { admissionOnly: true, ...(admissionDeadlineAt !== undefined ? { admissionDeadlineAt } : {}) },
        );
      } catch (error) {
        if (error.attempted === false) {
          const reason = error.senderCode ?? error.code ?? error.message;
          if (reason === 'DESKTOP_ADMISSION_EXPIRED') throw admissionExpired();
          if (desktopQueueFull(error)) throw new AdapterError('SENDER_BUSY', { attempted: false, reason });
          throw reject(attempt, reason);
        }
        // A lost response and a pre-admission interruption are resolved by the
        // same scoped lookup on the next poll. Neither allocates a new ID.
        return pending();
      }
    }
    if (!matchesDesktopDelivery(result, key, attempt.operation)) throw uncertain();
    const latest = adapter.textDeliveries.get(key);
    if (latest?.state === 'confirmed') return { ...latest.response, reused: true };
    if (latest?.state === 'rejected') throw rejected(latest.reason);
    if (latest?.state === 'accepted' || latest?.withdrawn) attempt = latest;
    if (attempt.state === 'dispatching') {
      const { command, ...admitted } = attempt;
      attempt = { ...admitted, state: 'accepted' };
      adapter.textDeliveries.put(attempt);
    }
    const status = desktopDeliveryStatus(result);
    if (status === 'rejected') throw reject(attempt, result.reason);
    if (status === 'pending') return pending(true);
    if (status !== 'confirmed') throw uncertain();
    const receipt = result.receipt;
    const localId = Number(receipt?.localId);
    const receiptQuote =
      receipt?.sourceServerId === undefined ? undefined : wechatServerEventId(target, receipt.sourceServerId);
    if (
      receipt?.source !== 'wechat-server-id' ||
      !/^[1-9]\d{0,31}$/.test(String(receipt.serverId)) ||
      !Number.isSafeInteger(localId) ||
      localId < 1 ||
      (media && receiptQuote !== attempt.quoteEventId) ||
      (attempt.operation === 'image' && !validStaticImageReceipt(receipt))
    )
      throw uncertain();
    const response = {
      message_id: localId,
      server_id: String(receipt.serverId),
      receipt: receipt.source,
      delivered: 'database-confirmed',
      ...receiptTiming(receipt),
    };
    if (media) {
      response.media_type = attempt.operation === 'image' ? 'wechat-image' : 'wechat-sticker';
      if (attempt.operation === 'image') {
        response.imageContentVerified = false;
        response.imageContentMatch = receipt.imageContentMatch;
      }
    }
    adapter.textDeliveries.put({ ...attempt, state: 'confirmed', confirmedAt: Date.now(), response });
    adapter.status.confirmed_sends++;
    adapter.status.last_error = '';
    return response;
  } finally {
    if (submittingMedia) adapter.submittingMedia.delete(key);
    if (ownsLane) adapter.targetsSending.delete(lane);
  }
}
