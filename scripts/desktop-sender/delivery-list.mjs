import fs from 'node:fs';
import path from 'node:path';
import { deliveryPreview } from '../../packages/dsh-social-bridge-plugin/delivery-preview.mjs';
import { parseChatKey } from '../../packages/wechat-identity.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { deliveryResult, deliverySnapshot, voicePartNeedsReceipt, withDeliveryReview } from './contract.mjs';
import { cancelIdleVoice, readNativeVoiceJob, voiceReceiptMatches } from './native-voice-outbox.mjs';
import { readerVoiceReceipt, voiceReceiptSegment } from './engine-voice.mjs';
import { UiTextOutbox, readUiTextJob } from './ui-text-outbox.mjs';
import { acquireDesktopQueue } from './delivery-lock.mjs';
import { ownsDesktop } from './scheduler.mjs';
import { savedRecovery } from './operations.mjs';
import { savedDesktopReceipt, savedDesktopReceipts } from '../desktop-receipts.mjs';
import { deliveryInHistory } from '../../packages/delivery-contract.mjs';

export function canRefreshReleasedReceipt(job, outcome) {
  return job.operation !== 'voice' && outcome.inputReleased === true && outcome.state === 'unconfirmed';
}

export function withDeliveryReceipt(job, outcome, receipt) {
  if (!receipt || outcome.receipt) return outcome;
  return { ...outcome, ...deliveryResult(job, 'confirmed', { reason: null, receipt }) };
}

function readSavedReceipt(root, job) {
  try {
    return savedDesktopReceipt(root, job);
  } catch {
    // Keep the input checkpoint as the visible status if the evidence cannot be verified.
    return null;
  }
}

function messageReceiptView(job, view, receipt) {
  return receipt?.source === 'wechat-server-id' ? withDeliveryReceipt(job, view, receipt) : view;
}

function savedMessageReceipt(root, job, view) {
  return view.receipt ? view : messageReceiptView(job, view, readSavedReceipt(root, job));
}

export function currentDeliveryResult(root, job, outcome) {
  return canRefreshReleasedReceipt(job, outcome) ? savedMessageReceipt(root, job, outcome) : outcome;
}

function canReadVoiceProgress(job, state, view) {
  return (
    Array.isArray(state?.segments) &&
    Array.isArray(view.segments) &&
    !view.receipt &&
    state.account === job.accountWxid &&
    state.target === job.target
  );
}

function storedVoiceAttempt(directory, job, state, part) {
  if (!voicePartNeedsReceipt(part)) return null;
  const native = state.segments[part.index];
  if (!native || native.id !== part.attemptId) return null;
  const attempt = {
    ...native,
    account: state.account,
    target: state.target,
    voiceId: state.voiceId,
    audioSha256: native.sha256,
    path: path.join(directory, 'voice', job.id, native.file),
  };
  return { native, attempt };
}

function savedVoiceProgress(root, directory, job, state, view) {
  if (!canReadVoiceProgress(job, state, view)) return view;
  let changed = false;
  const segments = view.segments.map(part => {
    const stored = storedVoiceAttempt(directory, job, state, part);
    if (!stored) return part;
    const { native, attempt } = stored;
    const evidence = readSavedReceipt(root, { ...job, segment: voiceReceiptSegment(attempt) });
    if (!evidence) return part;
    const receipt = readerVoiceReceipt(attempt, evidence);
    if (!voiceReceiptMatches(receipt, { ...state, ...native })) return part;
    changed = true;
    return {
      ...part,
      state: 'confirmed',
      serverId: receipt.serverId,
      localId: receipt.localId,
      source: receipt.source,
      receipt,
    };
  });
  if (!changed) return view;
  const updated = { ...view, segments, submitted: true };
  if (
    segments.length === state.segments.length &&
    segments.every((part, index) => part.state === 'confirmed' && part.attemptId === state.segments[index].id)
  )
    return withDeliveryReceipt(job, updated, segments.at(-1).receipt);
  return updated;
}

async function voiceSubmission(root, row, attempt) {
  const { storedVoiceSubmission } = await import('./native-voice-transport.mjs');
  return storedVoiceSubmission(root, { ...attempt, selectionScope: row.scope });
}

export async function canSettleStoredVoiceReceipt(root, directory, row, state, view) {
  if (state?.focusRecoveryRequired) return false;
  const observed = savedVoiceProgress(root, directory, row.job, state, view);
  if (observed === view) return false;
  // Each unresolved recording needs both its receipt and native release evidence.
  for (const part of view.segments.filter(voicePartNeedsReceipt)) {
    const stored = storedVoiceAttempt(directory, row.job, state, part);
    if (!stored || observed.segments[part.index]?.state !== 'confirmed') return false;
    try {
      if (!(await voiceSubmission(root, row, stored.attempt))?.inputReleased) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function refreshStoredVoiceReceipts(root, directory, row, state, view, queryReceipt) {
  const job = row.job;
  if (!canReadVoiceProgress(job, state, view)) return view;
  for (const part of view.segments) {
    const stored = storedVoiceAttempt(directory, job, state, part);
    if (!stored) continue;
    const { attempt } = stored;
    try {
      // A reservation in the receipt journal can precede actual recording and submission.
      const submission = await voiceSubmission(root, row, attempt);
      if (submission)
        await queryReceipt(
          { ...job, segment: voiceReceiptSegment(attempt) },
          { phase: 'query', recording: submission.recording },
        );
    } catch {
      // A missing checkpoint or unavailable Reader leaves the original attempt unresolved.
    }
  }
  return savedVoiceProgress(root, directory, job, state, view);
}

export function savedReceiptView(root, directory, job, state, view) {
  if (job.operation === 'voice') return savedVoiceProgress(root, directory, job, state, view);
  return ['submitting', 'submitted', 'unconfirmed'].includes(view.state) ? savedMessageReceipt(root, job, view) : view;
}

const releasedArchive = row => row.outcome && canRefreshReleasedReceipt(row.job, row.outcome);

function archivedMessageView(row, receipt) {
  const view = withDeliveryReview(messageReceiptView(row.job, row.outcome, receipt));
  return {
    ...view,
    reviewed: view.reviewed === true,
    channel: 'native',
    canPause: false,
    canResume: false,
    canCancel: false,
  };
}

export function listChatDeliveries(store, { kind, target, rosterGrant }, describe) {
  const matches = row => row.job.kind === kind && row.job.target === target && row.job.rosterGrant === rosterGrant;
  const active = [...store.rows.values()].filter(matches);
  const archived = store.recent(kind, target, rosterGrant).filter(row => matches(row) && !store.rows.has(row.job.id));
  const root = path.resolve(store.directory, '../../..');
  const receipts = savedDesktopReceipts(
    root,
    archived.filter(releasedArchive).map(row => row.job),
  );
  const jobs = [];
  let completed = 0;
  for (const row of [...active, ...archived].sort((a, b) => b.sequence - a.sequence)) {
    const view = releasedArchive(row) ? archivedMessageView(row, receipts.get(row.job)) : describe(row);
    if (deliveryInHistory(view) && ++completed > 128) continue;
    jobs.push({
      ...view,
      id: row.job.id,
      parentId: row.job.parentId ?? row.job.fileDeliveryId,
      createdAt: row.createdAt,
      preview: deliveryPreview(row.job),
      name:
        row.job.fileName ??
        {
          text: '文字回复',
          voice: '语音回复',
          sticker: '图片 / GIF / 表情回复',
          image: '图片回复',
          file: '文件',
        }[row.job.operation],
    });
  }
  return jobs;
}

export function storedDelivery(directory, row) {
  const { id, operation, accountRef } = row.job;
  const voice = operation === 'voice';
  const queueDirectory = path.join(directory, operation === 'text' ? 'text' : 'images/queue');
  const state = row.admissionError
    ? { state: 'failed', reason: row.admissionError }
    : voice
      ? readNativeVoiceJob(path.join(directory, 'voice'), id)
      : readUiTextJob(queueDirectory, id);
  if (
    state &&
    !voice &&
    operation !== 'text' &&
    fs.existsSync(path.join(directory, 'images/metadata', id + '.json.application'))
  )
    state.imageDraftPresent = true;
  const root = path.resolve(directory, '../../..');
  const recovery = savedRecovery({ root, accountRef, id, voiceState: voice ? state : undefined });
  const snapshot = withDeliveryReview(
    row.outcome ?? deliverySnapshot(row, state, recovery),
    recovery?.recovered === true,
  );
  const active =
    !row.outcome &&
    !recovery &&
    !snapshot.focusRecoveryRequired &&
    !ownsDesktop(snapshot) &&
    ['queued', 'waiting', 'paused'].includes(snapshot.state);
  // Receipt evidence can advance independently of input checkpoints and recovery controls.
  const observed = savedReceiptView(root, directory, row.job, state, snapshot);
  return {
    state,
    queueDirectory,
    view: {
      ...observed,
      reviewed: observed.reviewed === true,
      channel: 'native',
      canPause: active && !row.paused && !state?.manualPause,
      canResume: active && (row.paused || state?.manualPause),
      canCancel: active,
    },
  };
}

export function savedChatDeliveries(root, accountRef, key, rosterGrant) {
  const chat = parseChatKey(key);
  if (!/^[a-f0-9]{64}$/.test(accountRef) || !chat || !rosterGrant) return [];
  const directory = path.join(root, 'state/desktop-sender', accountRef);
  if (!fs.existsSync(directory)) return [];
  const store = new DeliveryStore(directory, { readOnly: true });
  return listChatDeliveries(
    store,
    { kind: chat.kind, target: chat.id, rosterGrant },
    row => storedDelivery(directory, row).view,
  );
}

export function saveDeliveryControl(store, row, action) {
  row.paused = action !== 'resume';
  if (action === 'cancel') row.cancelled = true;
  row.revision = (row.revision ?? 0) + 1;
  store.save(row);
}

export function controlSavedChatDelivery(root, { account, key, grant, id, revision, operation }) {
  const chat = parseChatKey(key);
  const capability = { pause: 'canPause', resume: 'canResume', cancel: 'canCancel' }[operation];
  const changed = () => Object.assign(Error('DESKTOP_CONTROL_CHANGED'), { code: 'DESKTOP_CONTROL_CHANGED' });
  if (
    !/^[a-f0-9]{64}$/.test(account) ||
    !chat ||
    !grant ||
    !/^[a-f0-9]{64}$/.test(id) ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !capability
  )
    throw changed();
  const lease = acquireDesktopQueue(root);
  if (!lease) throw changed();
  try {
    const directory = path.join(root, 'state/desktop-sender', account);
    const store = new DeliveryStore(directory);
    const row = store.find(id);
    if (
      !row ||
      row.job.accountRef !== account ||
      row.job.kind !== chat.kind ||
      row.job.target !== chat.id ||
      row.job.rosterGrant !== grant
    )
      throw changed();
    const { view, state, queueDirectory } = storedDelivery(directory, row);
    if (view.revision !== revision || !view[capability]) throw changed();
    if (row.job.operation === 'voice') {
      if (operation === 'cancel') cancelIdleVoice(path.join(directory, 'voice'), id, Date.now());
    } else if (state) {
      // The outbox control method never calls a desktop driver on stored jobs.
      const noInput = () => {
        throw Error('DESKTOP_CONTROL_INPUT_FORBIDDEN');
      };
      const outbox = new UiTextOutbox({
        directory: queueDirectory,
        driver: { observe: noInput, typeGrapheme: noInput, submit: noInput, receipt: noInput },
      });
      outbox[operation](id);
    }
    saveDeliveryControl(store, row, operation);
    if (row.cancelled && row.job.operation === 'voice') store.releaseVoiceInput(id);
    return storedDelivery(directory, row).view;
  } finally {
    lease.release();
  }
}
