// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readForegroundTimings } from './foreground-timing.mjs';
import { recoverUiaOffscreenWindow } from './uia-offscreen.mjs';
import { inspectVoiceOperatorRecovery, recoverVoiceOperatorRecovery } from './voice-operator-recovery.mjs';
import { archiveDelivery, readArchivedDelivery } from './delivery-archive.mjs';
import { confirmQuoteDraftSent, readQuoteDraft } from './quote-draft-state.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fault = code => Object.assign(Error(code), { code });
/** @param {{root?:string, assertStopped?:()=>boolean|Promise<boolean>, signal?:AbortSignal}} options */
export async function restoreWindow({ root, assertStopped, signal } = {}) {
  if (typeof assertStopped !== 'function' || (await assertStopped()) !== true)
    throw fault('DESKTOP_RECOVERY_STOP_REQUIRED');
  return recoverUiaOffscreenWindow({ root, signal });
}
function fileFor(root, accountRef, id) {
  if (!path.isAbsolute(root ?? '') || !digest(accountRef) || !digest(id)) throw fault('DESKTOP_RECOVERY_INVALID');
  return path.join(root, 'state/desktop-sender', accountRef, 'recovery', id + '.json');
}
const archiveFor = (root, accountRef) => path.join(root, 'state/desktop-sender', accountRef, 'recovery-archive');
function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fault('DESKTOP_RECOVERY_STATE_INVALID');
  }
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}
export function publishRecovery({ root, accountRef, id, kind, reason, state }) {
  if (!['draft', 'recording'].includes(kind)) throw fault('DESKTOP_RECOVERY_INVALID');
  const file = fileFor(root, accountRef, id),
    revision = hash(JSON.stringify(state)),
    prior = read(file) ?? readArchivedDelivery(archiveFor(root, accountRef), id, 16384);
  if (prior?.recovered) return prior;
  if (prior?.revision === revision) return prior;
  const focusMessage = state.segments?.some(part => part.state === 'confirmed')
    ? '语音已确认送达，但窗口焦点未能确认归还。'
    : state.segments?.some(part => ['submitted', 'unknown', 'record-intent'].includes(part.state))
      ? '语音提交结果仍需核对，窗口焦点也未能确认归还。'
      : state.segments?.some(part => part.recordingCancellation)
        ? '本段录音已取消且未提交，但窗口焦点未能确认归还。'
        : '本段语音没有开始录音，但窗口焦点未能确认归还。';
  const value = {
    id,
    revision,
    kind,
    reason,
    canRecover: true,
    recovered: false,
    ...(state.focusRecoveryRequired
      ? { focusRecoveryRequired: true, message: focusMessage + '请停止服务，并确认微信窗口及键盘焦点正常。' }
      : {}),
  };
  write(file, value);
  return value;
}
function archiveResolved(root, accountRef, id, value) {
  archiveDelivery(archiveFor(root, accountRef), id, value, 16384);
  const file = fileFor(root, accountRef, id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
export function savedRecovery({ root, accountRef, id }) {
  return read(fileFor(root, accountRef, id)) ?? readArchivedDelivery(archiveFor(root, accountRef), id, 16384);
}
export function reviewedRecovery(scope) {
  return savedRecovery(scope)?.recovered === true;
}
export function resolveRecovery({ root, accountRef, id }) {
  const file = fileFor(root, accountRef, id),
    value = read(file);
  if (value && !value.recovered)
    archiveResolved(root, accountRef, id, {
      ...value,
      recovered: true,
      resolvedByReceipt: true,
      canRecover: false,
    });
}
export function snapshotOperations({ root, accountRef }) {
  const timings = readForegroundTimings({ root }),
    recoveries = [];
  if (digest(accountRef)) {
    const directory = path.dirname(fileFor(root, accountRef, '0'.repeat(64)));
    if (fs.existsSync(directory))
      for (const name of fs.readdirSync(directory).slice(0, 512)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const value = read(path.join(directory, name));
        if (
          value &&
          !value.recovered &&
          digest(value.id) &&
          digest(value.revision) &&
          ['draft', 'recording'].includes(value.kind)
        )
          recoveries.push(value);
      }
  }
  return { ...timings, recoveries };
}
/** Releases only an operator-reviewed barrier. It never changes a receipt or
 * makes an old delivery id replayable. The stopped executor must be restarted. */
export async function recoverOperation({
  root,
  accountRef,
  id,
  revision,
  acknowledgeDraftCleared,
  acknowledgeRecordingEnded,
  acknowledgeOutcomeReviewed,
  assertStopped,
}) {
  if (typeof assertStopped !== 'function' || (await assertStopped()) !== true)
    throw fault('DESKTOP_RECOVERY_STOP_REQUIRED');
  const file = fileFor(root, accountRef, id),
    value = read(file);
  if (!value || value.revision !== revision || value.recovered) throw fault('DESKTOP_RECOVERY_CHANGED');
  if (
    acknowledgeOutcomeReviewed !== true ||
    (value.kind === 'draft' && acknowledgeDraftCleared !== true) ||
    (value.kind === 'recording' && acknowledgeRecordingEnded !== true)
  )
    throw fault('DESKTOP_RECOVERY_CONFIRMATION_REQUIRED');
  if (value.kind === 'recording') {
    const options = { root, accountScopeHash: accountRef, assertStopped };
    const native = await inspectVoiceOperatorRecovery(options);
    if (native.required)
      await recoverVoiceOperatorRecovery({
        ...options,
        expectedRevision: native.revision,
        acknowledgeRecordingEnded: true,
        acknowledgeMessageOutcomeReviewed: true,
      });
  }
  if ((await assertStopped()) !== true) throw fault('DESKTOP_RECOVERY_STOP_REQUIRED');
  const directory = path.join(root, 'state/desktop-sender', accountRef);
  const metadata =
    read(path.join(directory, 'metadata', id + '.json')) ??
    readArchivedDelivery(path.join(directory, 'metadata-archive'), id, 64 * 1024 * 1024);
  if (metadata?.job.quote) {
    if (metadata.job.id !== id || metadata.job.accountRef !== accountRef) throw fault('DESKTOP_RECOVERY_CHANGED');
    confirmQuoteDraftSent(root, accountRef, metadata.job.target, id);
  }
  archiveResolved(root, accountRef, id, {
    ...value,
    recovered: true,
    canRecover: false,
    recoveredAt: Date.now(),
  });
  return {
    recovered: true,
    id,
    revision,
    inputSent: false,
    deliveryConfirmed: false,
    originalIdReplayable: false,
  };
}

/** @param {{job: import('./contract.mjs').DesktopJob, revoked?:boolean}} row */
export function deliveryRecovery(root, row, state, activeJob) {
  if (!state) return null;
  const voice = row.job.operation === 'voice';
  if (state.focusRecoveryRequired)
    return publishRecovery({
      root,
      accountRef: row.job.accountRef,
      id: row.job.id,
      kind: 'draft',
      reason: state.focusRecoveryError ?? 'DESKTOP_FOCUS_RECOVERY_REQUIRED',
      state,
    });
  if (state.state === 'confirmed') {
    if (row.job.quote) confirmQuoteDraftSent(root, row.job.accountRef, row.job.target, row.job.id);
    resolveRecovery({ root, accountRef: row.job.accountRef, id: row.job.id });
    return null;
  }
  const quoteDraft = row.job.quote && readQuoteDraft(root, row.job.accountRef, row.job.target);
  if (quoteDraft?.id === row.job.id && (state.manualPause || ['cancelled', 'failed', 'conflict'].includes(state.state)))
    return publishRecovery({
      root,
      accountRef: row.job.accountRef,
      id: row.job.id,
      kind: 'draft',
      reason: state.reason ?? 'UI_QT_QUOTE_DRAFT_CONFLICT',
      state: { ...state, quoteDraft },
    });
  if (voice && activeJob === row.job.id && state.segments.some(part => part.state === 'record-intent')) return null;
  const uncertain = voice
    ? state.segments.some(part => ['record-intent', 'submitted', 'unknown'].includes(part.state))
    : (row.revoked || ['conflict', 'unconfirmed', 'cancelled', 'failed'].includes(state.state)) &&
      Boolean(
        state.index > 0 ||
        state.pendingInput ||
        state.inputPending ||
        state.imageDraftPresent ||
        state.nativeRecoveryRequired ||
        state.submittedAt,
      );
  return uncertain
    ? publishRecovery({
        root,
        accountRef: row.job.accountRef,
        id: row.job.id,
        kind: voice ? 'recording' : 'draft',
        reason: state.reason ?? 'DESKTOP_INPUT_OUTCOME_UNKNOWN',
        state,
      })
    : null;
}
