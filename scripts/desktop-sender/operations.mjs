// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readForegroundTimings } from './foreground-timing.mjs';
import { createUiaOffscreenManager, recoverUiaOffscreenWindow } from './uia-offscreen.mjs';
import { inspectVoiceOperatorRecovery, recoverVoiceOperatorRecovery } from './voice-operator-recovery.mjs';
import { archiveDelivery, readArchivedDelivery } from './delivery-archive.mjs';
import { confirmQuoteDraftSent, readQuoteDraft } from './quote-draft-state.mjs';
import { acquireDesktopQueue } from './delivery-lock.mjs';
import { voicePartNeedsReceipt } from './contract.mjs';
import { readNativeVoiceJob } from './native-voice-outbox.mjs';
import { probeDesktopAccount } from '../desktop-account.mjs';
import { desktopSettings } from '../desktop-settings.mjs';
import { activeReaderAccount, readerAccountDirectory, readerAccountId } from '../reader-account-state.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fault = code => Object.assign(Error(code), { code });
/** @param {{root?:string, assertStopped?:()=>boolean|Promise<boolean>, signal?:AbortSignal}} options */
export async function restoreWindow({ root, assertStopped, signal } = {}) {
  return withStoppedQueue(root, assertStopped, () => recoverUiaOffscreenWindow({ root, signal }));
}

async function withStoppedQueue(root, assertStopped, operate) {
  if (typeof assertStopped !== 'function' || (await assertStopped()) !== true)
    throw fault('DESKTOP_RECOVERY_STOP_REQUIRED');
  const lease = acquireDesktopQueue(root);
  if (!lease) throw Object.assign(fault('DESKTOP_QUEUE_BUSY'), { status: 409 });
  try {
    if ((await assertStopped()) !== true) throw fault('DESKTOP_RECOVERY_STOP_REQUIRED');
    return await operate();
  } finally {
    lease.release();
  }
}

/** Apply placement without creating the input executor or starting Reader. */
export async function applyStoppedOffscreen({
  root,
  config,
  assertStopped,
  signal,
  probe = probeDesktopAccount,
  createOffscreen = createUiaOffscreenManager,
  restore = recoverUiaOffscreenWindow,
}) {
  return withStoppedQueue(root, assertStopped, async () => {
    const settings = desktopSettings(config, root, { requireClient: false });
    if (config.input?.offscreen !== true) {
      const result = await restore({ root, signal });
      return { available: true, applied: true, windowState: result.state };
    }
    const { id } = activeReaderAccount(root);
    if (!settings.executable || !id) return { available: false };

    const readerState = path.join(root, 'state/weflow/WeFlow-config.json');
    const source = read(readerState);
    const accountDirectory = readerAccountDirectory(root, source);
    if (!accountDirectory || readerAccountId(root, source) !== id) throw fault('DESKTOP_ACCOUNT_CHANGED');
    const voice = await inspectVoiceOperatorRecovery({ root, accountScopeHash: id, assertStopped });
    if (snapshotOperations({ root, accountRef: id }).recoveries.length || voice.required || voice.interruptedRecovery)
      throw fault('DESKTOP_CONFIGURATION_INPUT_PENDING');
    let account;
    try {
      account = await probe(root, config);
    } catch (error) {
      if (['INPUT_WECHAT_NOT_RUNNING', 'INPUT_ACCOUNT_UNVERIFIED'].includes(error.code)) return { available: false };
      throw error;
    }
    if (
      account.readOnly !== true ||
      account.version !== settings.expectedVersion ||
      account.databaseAccounts?.length !== 1 ||
      account.databaseAccounts[0].toLowerCase() !== path.basename(accountDirectory).toLowerCase()
    )
      throw fault('DESKTOP_ACCOUNT_CHANGED');
    if (
      (await assertStopped()) !== true ||
      activeReaderAccount(root).id !== id ||
      readerAccountId(root, read(readerState)) !== id
    )
      throw fault('DESKTOP_ACCOUNT_CHANGED');
    const offscreen = createOffscreen({ root });
    try {
      const windowState = await offscreen.parkVerifiedWindow({
        executable: settings.executable,
        binding: account,
        signal,
      });
      if (windowState.parked) {
        if ((await assertStopped()) !== true) throw fault('DESKTOP_RECOVERY_STOP_REQUIRED');
        await offscreen.handoffOffline();
      }
      return { available: true, applied: true, windowState };
    } finally {
      await offscreen.close();
    }
  });
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
  const recordingAttempts =
    kind === 'recording' ? state.segments?.filter(voicePartNeedsReceipt).map(part => part.id) : undefined;
  const file = fileFor(root, accountRef, id),
    revision = hash(JSON.stringify({ kind, state, recordingAttempts })),
    prior = read(file) ?? readArchivedDelivery(archiveFor(root, accountRef), id, 16384);
  if (prior?.recovered) return prior;
  if (prior?.revision === revision) return prior;
  const focusMessage =
    state.segments?.length && state.segments.every(part => part.state === 'confirmed')
      ? '语音已确认送达，但窗口焦点未能确认归还。'
      : state.segments?.some(voicePartNeedsReceipt)
        ? '语音提交结果仍需核对，窗口焦点也未能确认归还。'
        : state.segments?.some(part => part.recordingCancellation)
          ? '本段录音已取消且未提交，但窗口焦点未能确认归还。'
          : state.segments?.some(part => part.state === 'confirmed')
            ? '已有部分语音确认送达，窗口焦点仍需核对。'
            : '本段语音没有开始录音，但窗口焦点未能确认归还。';
  const value = {
    id,
    revision,
    kind,
    reason,
    canRecover: true,
    recovered: false,
    ...(recordingAttempts?.length ? { recordingAttempts } : {}),
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
function recordingRecoveryAttempts(value) {
  return value?.kind === 'recording' && !value.recovered && Array.isArray(value.recordingAttempts)
    ? value.recordingAttempts
    : [];
}

function recordingRecoverySettled(value, state) {
  const attempts = recordingRecoveryAttempts(value);
  if (
    !attempts.length ||
    !Array.isArray(state?.segments) ||
    state.focusRecoveryRequired ||
    state.segments.some(voicePartNeedsReceipt)
  )
    return false;
  const finished = new Set(
    state.segments.flatMap(part => [
      ...(part.state === 'confirmed' || part.recordingCancellation ? [part.id] : []),
      ...(part.cancelledAttempts ?? []).map(attempt => attempt.id),
    ]),
  );
  return attempts.every(id => finished.has(id));
}

function storedRecordingRecoverySettled(root, accountRef, value) {
  if (!recordingRecoveryAttempts(value).length) return false;
  try {
    const state = readNativeVoiceJob(path.join(root, 'state/desktop-sender', accountRef, 'voice'), value.id);
    return recordingRecoverySettled(value, state);
  } catch {
    return false;
  }
}

export function savedRecovery({ root, accountRef, id, voiceState = undefined }) {
  const active = read(fileFor(root, accountRef, id));
  return active && !recordingRecoverySettled(active, voiceState)
    ? active
    : readArchivedDelivery(archiveFor(root, accountRef), id, 16384);
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
          ['draft', 'recording'].includes(value.kind) &&
          !storedRecordingRecoverySettled(root, accountRef, value)
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
  return withStoppedQueue(root, assertStopped, async () => {
    const file = fileFor(root, accountRef, id),
      value = read(file);
    if (
      !value ||
      value.id !== id ||
      value.revision !== revision ||
      value.recovered ||
      storedRecordingRecoverySettled(root, accountRef, value)
    )
      throw fault('DESKTOP_RECOVERY_CHANGED');
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
  });
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
  if (state.inputReleased === true) return null;
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
  if (
    activeJob === row.job.id &&
    (voice
      ? state.segments.some(part => part.state === 'record-intent')
      : state.state === 'cancelled' && (state.pendingInput || state.inputPending))
  )
    return null;
  const uncertain = voice
    ? state.segments.some(voicePartNeedsReceipt)
    : (row.revoked || ['conflict', 'unconfirmed', 'cancelled', 'failed'].includes(state.state)) &&
      Boolean(
        state.index > 0 ||
        state.pendingInput ||
        state.inputPending ||
        state.imageDraftPresent ||
        state.nativeRecoveryRequired ||
        state.submittedAt,
      );
  if (voice && !uncertain) {
    const file = fileFor(root, row.job.accountRef, row.job.id);
    const previous = read(file);
    if (recordingRecoveryAttempts(previous).length) {
      if (!recordingRecoverySettled(previous, state)) return previous;
      // The reviewed-delivery archive would retire the whole ID, including its unsent tail.
      fs.rmSync(file, { force: true });
    }
  }
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
