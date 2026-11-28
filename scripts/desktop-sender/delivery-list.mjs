import fs from 'node:fs';
import path from 'node:path';
import { deliveryPreview } from '../../packages/dsh-social-bridge-plugin/delivery-preview.mjs';
import { parseChatKey } from '../../packages/wechat-identity.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { deliverySnapshot } from './contract.mjs';
import { cancelIdleVoice, readNativeVoiceJob } from './native-voice-outbox.mjs';
import { UiTextOutbox, readUiTextJob } from './ui-text-outbox.mjs';
import { acquireDesktopQueue } from './delivery-lock.mjs';
import { ownsDesktop } from './scheduler.mjs';
import { savedRecovery } from './operations.mjs';

export function listChatDeliveries(store, { kind, target, rosterGrant }, describe) {
  const matches = row => row.job.kind === kind && row.job.target === target && row.job.rosterGrant === rosterGrant;
  const rows = [...store.rows.values()].filter(matches);
  rows.push(...store.recent(kind, target, rosterGrant).filter(row => !store.rows.has(row.job.id)));
  let completed = 0;
  return rows
    .sort((a, b) => b.sequence - a.sequence)
    .map(row => ({
      ...describe(row),
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
    }))
    .filter(job => {
      const settled =
        job.reviewed ||
        (!job.recovery && !job.focusRecoveryRequired && ['confirmed', 'failed', 'cancelled'].includes(job.state));
      return !settled || ++completed <= 128;
    });
}

function storedDelivery(directory, row) {
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
  const recovery = savedRecovery({ root, accountRef, id });
  const snapshot = row.outcome ?? deliverySnapshot(row, state, recovery?.recovered ? null : recovery);
  const active =
    !row.outcome &&
    !recovery &&
    !snapshot.focusRecoveryRequired &&
    !ownsDesktop(snapshot) &&
    ['queued', 'waiting', 'paused'].includes(snapshot.state);
  return {
    state,
    queueDirectory,
    view: {
      ...snapshot,
      reviewed: recovery?.recovered === true,
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
