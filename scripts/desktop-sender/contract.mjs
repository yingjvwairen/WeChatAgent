import { validChatId } from '../../packages/wechat-identity.mjs';
/** Public boundary of the desktop sender. The authorized peer must match the exact WeChat target.
 *
 * createDesktopSenderEngine({root, config, authorize, authorizeCurrent,
 *   resolveTarget, probeAccount, receipt, ensureAccessibility, driverFactory?})
 *
 * All platform callbacks receive the canonical job below. authorize(job, {preparing, signal}?) may
 * be async and returns {allowed,grantId:<64hex>,version:<positive integer>,quote?}.
 * A verified quote locator can change between admission and native preparation.
 * authorizeCurrent(job) is a synchronous boolean checked at native boundaries.
 * resolveTarget(kind,target) returns {wxid,name,alias,kind,uniqueSearchName}.
 * probeAccount(options) supplies {account,accountDirectory,accountWxid,
 *   accountRef,dbPath,executable,executableSha256,executableVersion}; when passed
 * a native binding it may supply {accountRef,accountScopeHash,evidence} instead.
 * receipt(job,{phase:'prepare'|'submitted'|'image-input-applied'|'not-attempted'|'query',signal,...}) prepares a durable
 * baseline, records submission or queries it. prepare returns
 * {prepared:true,submissionAllowed:true,baselineId}; query returns
 * {confirmed:false,reason?} or {confirmed:true,receipt:{serverId,...}}.
 * submitted reserves an input intent, not a delivery confirmation. Only a
 * native performed:false+attempted:false result can release it through
 * not-attempted with {baselineId,proof:{performed:false,attempted:false}}.
 * Voice queries include job.segment={id,attemptId,index,audioSha256,durationMs,path} so
 * each split part has its own baseline and server receipt.
 * inputDeadlineAt optionally stops further text/attachment input. Submitted
 * attempts keep their independent receipt window; partial drafts require review.
 * ensureAccessibility({root,binding,config,signal}) prepares UIA for the bound client version.
 */
export const DESKTOP_OPERATIONS = Object.freeze([
  'health',
  'prepare',
  'text',
  'image',
  'sticker',
  'file',
  'voice',
  'query',
  'lookup',
  'control',
  'close',
]);
export const TERMINAL_STATES = new Set(['confirmed', 'unconfirmed', 'cancelled', 'failed']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/u.test(value);
/**
 * @typedef {{id:string, operation:string, deliveryId:string, kind:string, target:string,
 * account:string, accountRef:string, accountWxid:string, quote?:{id:string, serverId:string}}} DesktopJob
 * @returns {Readonly<DesktopJob>}
 */
export function canonicalJob(payload, { id, operation, account, recipient, segment } = {}) {
  if (
    !object(payload) ||
    !text(payload.deliveryId) ||
    !validChatId(payload.kind, payload.target) ||
    payload.target !== recipient?.wxid ||
    !text(payload.account) ||
    !account ||
    !recipient ||
    !text(account.accountWxid) ||
    !/^([a-f0-9]{64})$/.test(account.accountRef ?? '') ||
    (payload.inputDeadlineAt !== undefined &&
      (!['file', 'image', 'sticker', 'text'].includes(operation) ||
        !Number.isSafeInteger(payload.inputDeadlineAt) ||
        payload.inputDeadlineAt < 1))
  )
    throw Object.assign(Error('DESKTOP_JOB_INVALID'), { code: 'DESKTOP_JOB_INVALID' });
  return Object.freeze({
    ...structuredClone(payload),
    id,
    operation,
    deliveryId: payload.deliveryId,
    kind: payload.kind,
    target: payload.target,
    name: recipient.name,
    alias: recipient.alias ?? '',
    account: payload.account,
    accountDirectory: account.accountDirectory ?? payload.account,
    accountWxid: account.accountWxid,
    accountRef: account.accountRef,
    ...(segment ? { segment: structuredClone(segment) } : {}),
  });
}
export function deliveryResult(job, state, extra = {}) {
  const terminal = TERMINAL_STATES.has(state),
    confirmed = state === 'confirmed';
  return {
    version: 1,
    deliveryId: job.deliveryId,
    operation: job.operation,
    state,
    admitted: true,
    pending: !terminal,
    confirmed,
    submitted: confirmed || state === 'submitted',
    submission: confirmed
      ? 'confirmed'
      : state === 'submitted'
        ? 'submitted'
        : state === 'submitting'
          ? 'attempted'
          : state === 'unconfirmed'
            ? 'unknown'
            : 'not-started',
    ...extra,
  };
}

const publicStates = { unknown: 'unconfirmed', sending: 'recording', prepared: 'queued' };

function voiceOutcome(job, state) {
  const states = new Set(job.segments.map(part => part.state));
  const sent = states.has('confirmed') || states.has('submitted');
  let submission = 'not-started';
  if (state === 'confirmed') submission = 'confirmed';
  else if (states.has('unknown')) submission = 'unknown';
  else if (sent) submission = 'submitted';
  else if (states.has('record-intent')) submission = 'attempted';

  const segments = job.segments.map(({ id, index, state, durationMs, receipt }) => ({
    id,
    attemptId: id,
    index,
    state,
    durationMs,
    ...(receipt ? { serverId: receipt.serverId, localId: receipt.localId, source: receipt.source, receipt } : {}),
  }));
  return {
    segments,
    submission,
    submitted: sent || states.has('unknown'),
    ...(state === 'confirmed' ? { receipt: segments.at(-1)?.receipt } : {}),
  };
}

export function deliverySnapshot(row, job, recovery) {
  if (!job) {
    const state = row.cancelled ? 'cancelled' : row.paused ? 'paused' : 'queued';
    return deliveryResult(row.job, state, {
      reason: row.reason ?? null,
      inputStarted: false,
      revision: row.revision ?? 0,
    });
  }
  const voice = row.job.operation === 'voice';
  const inputStarted = voice
    ? job.segments.some(part => !['prepared', 'retry-wait', 'cancelled'].includes(part.state))
    : Boolean(job.index > 0 || job.pendingInput || job.inputPending || job.imageDraftPresent);
  const betweenBubbles =
    voice &&
    job.state === 'sending' &&
    !job.segments.some(part => ['record-intent', 'submitted', 'unknown'].includes(part.state));
  let state = publicStates[job.state] ?? job.state;
  if (row.cancelled && !inputStarted) state = 'cancelled';
  else if (row.paused && (betweenBubbles || job.state === 'prepared' || ['queued', 'waiting'].includes(state)))
    state = 'paused';
  else if (betweenBubbles) state = 'waiting';
  const reason = row.revoked
    ? row.reason
    : (job.reason ?? job.segments?.find(part => part.reason)?.reason ?? row.reason);
  return deliveryResult(row.job, state, {
    // Operator commands version the metadata; native revisions only guard input.
    // Progress and repeated observations must not invalidate a displayed command.
    reason: reason ?? null,
    inputStarted,
    revision: row.revision ?? 0,
    ...(recovery ? { recovery } : {}),
    ...(job.focusRecoveryRequired ? { focusRecoveryRequired: true } : {}),
    ...(job.receipt ? { receipt: job.receipt } : {}),
    ...(voice ? voiceOutcome(job, state) : {}),
  });
}
