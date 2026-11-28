// Desktop execution state is distinct from the evidence of delivery. All
// consumers classify the same scoped result before acting on a receipt.
export const TERMINAL_DELIVERY_STATES = new Set(['confirmed', 'unconfirmed', 'cancelled', 'expired', 'failed']);
export const RECEIPT_BASELINE_UNAVAILABLE = 'DESKTOP_RECEIPT_BASELINE_UNAVAILABLE';
export const imageContentMatched = receipt =>
  receipt?.imageContentMatch === 'source-md5' || receipt?.imageContentMatch === 'raster';
const PENDING_DELIVERY_STATES = new Set([
  'queued',
  'waiting',
  'typing',
  'recording',
  'submitting',
  'submitted',
  'paused',
]);

export const matchesDesktopDelivery = (result, deliveryId, operation) =>
  result?.admitted === true &&
  result.deliveryId === deliveryId &&
  result.operation === operation &&
  typeof result.state === 'string';

export const desktopQueueFull = error =>
  error?.attempted === false && (error.senderCode ?? error.code ?? error.message) === 'DESKTOP_STORAGE_LIMIT';

export function receiptReservationRefusal(result) {
  if (result?.recorded === true) return null;
  if (result?.recorded === false && result.performed === false && result.attempted === false) return result;
  const code = 'DESKTOP_RECEIPT_SUBMISSION_NOT_RECORDED';
  throw Object.assign(Error(code), { code });
}

export function desktopDeliveryStatus(result) {
  if (result?.admitted !== true) return 'unconfirmed';
  const { state, confirmed, pending, submission, inputStarted, recovery, focusRecoveryRequired } = result;
  if (state === 'confirmed' && confirmed === true) return 'confirmed';
  if (['failed', 'cancelled', 'expired'].includes(state) && submission === 'not-started' && !inputStarted)
    return 'rejected';
  if (pending === true && PENDING_DELIVERY_STATES.has(state) && !recovery && !focusRecoveryRequired) return 'pending';
  return 'unconfirmed';
}

// The authenticated OneBot adapter supplies these acknowledgements. An
// absent or incomplete acknowledgement carries no positive evidence.
export function replyDeliveryStatus(result) {
  if (result?.pending === true || result?.status === 'pending') return 'pending';
  if (result?.status === 'rejected') return 'rejected';
  if (result?.delivered === 'unconfirmed' || result?.status === 'unconfirmed') return 'unconfirmed';
  return result?.confirmed === true ||
    result?.delivered === 'database-confirmed' ||
    result?.status === 'confirmed' ||
    result?.data?.receipt === 'wechat-server-id'
    ? 'confirmed'
    : 'unconfirmed';
}

// Use the same database key as Reader intake, even when two rows share a second.
export function receiptTiming(receipt) {
  const seconds = receipt?.createTime;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || !Number.isSafeInteger(seconds * 1000)) return {};
  const sentAt = seconds * 1000;
  const localId = String(receipt.localId ?? '');
  if (!/^[1-9]\d{0,19}$/.test(localId) || !/^[a-f0-9]{64}$/.test(receipt.sourceShard ?? '')) return { sentAt };
  const readerOrder = String(seconds).padStart(20, '0') + '-' + localId.padStart(20, '0') + '-' + receipt.sourceShard;
  return { sentAt, readerOrder };
}

export function replySentAt(receipt, fallback = Date.now()) {
  const at = receipt?.sentAt;
  return Number.isSafeInteger(at) && at > 0 && at <= Date.now() ? at : fallback;
}

export function deliveryInHistory(row) {
  return (
    row.reviewed ||
    (!row.recovery &&
      !row.focusRecoveryRequired &&
      TERMINAL_DELIVERY_STATES.has(row.state) &&
      row.state !== 'unconfirmed')
  );
}
