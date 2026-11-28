import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopSenderEngine } from './engine.mjs';
import { MAX_ACTIVE_DELIVERIES } from './delivery-store.mjs';
import { recoverOperation, snapshotOperations } from './operations.mjs';
import { voiceInterruptionEvidence, voiceRecordingCancellationEvidence } from './voice-interruption-evidence.mjs';
import crypto from 'node:crypto';
import { beginQuoteDraft, readQuoteDraft } from './quote-draft-state.mjs';
import { DesktopSender } from '../desktop-sender.mjs';
import { DESKTOP_WECHAT_VERSION } from '../desktop-settings.mjs';
import { DesktopReceipts } from '../desktop-receipts.mjs';
import { desktopProcessIdentity } from './account-probe.mjs';
import { NativeVoiceTransport } from './native-voice-transport.mjs';
import { installVoice, voiceRequest } from './engine-voice.mjs';
import { deliverDesktopMessage } from '../desktop-message-delivery.mjs';
import { ReplyMediaCatalog } from '../reply-media-catalog.mjs';
import { TextDeliveryStore } from '../text-delivery-store.mjs';
import { WechatOneBot } from '../wechat-onebot.mjs';
import { VoiceSend } from '../voice-send.mjs';
import { pcmWav } from '../decode-wechat-voice.mjs';
import { selectPluginAccount } from '../test-fixtures/plugin-account.mjs';
import { acquireDeliveryLock, acquireDesktopQueue } from './delivery-lock.mjs';
import { controlSavedChatDelivery, savedChatDeliveries } from './delivery-list.mjs';
import { SocialEngine } from '../../components/qq-bridge/src/core/social-engine.js';
import { MediaOutbox } from '../../components/qq-bridge/src/core/media-outbox.js';
import { MessageBuffer } from '../../components/qq-bridge/src/core/message-buffer.js';
import { WechatOneBotAdapter } from '../../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { ReplyDeliveryControls } from '../../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
import {
  naturalGroupWakeEpoch,
  reconcileGroupWakeEpochs,
} from '../../packages/dsh-social-bridge-plugin/conversation-policy.mjs';

const hex = letter => letter.repeat(64);
function fixture(
  t,
  {
    unknownVoice = false,
    submitThrows = false,
    targetWxid = 'wxid_friend',
    additionalTargets = [],
    now = Date.now,
  } = {},
) {
  const targets = new Set([targetWxid, ...additionalTargets]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-engine-'));
  const config = {
    runtime: { sender: 'wechat-ui' },
    input: {
      controlMode: 'ocr',
      voiceSend: true,
      operationTimeoutMs: 300,
      receiptTimeoutMs: 1000,
      idleMs: 1000,
    },
  };
  const account = {
    account: 'self_account',
    accountWxid: 'wxid_self',
    accountRef: hex('a'),
    accountDirectory: path.join(root, 'db/self_account'),
  };
  const state = {
    draft: '',
    prepared: null,
    pastes: [],
    submits: [],
    callbacks: [],
    segments: [],
    unknownVoice,
    submitThrows,
    refuseSubmit: 0,
    cancelVoiceOnce: false,
    number: 100,
    factories: 0,
    releaseBusy: false,
    releaseFailure: false,
    driverCloses: 0,
  };
  const receipt = async (job, options) => {
    state.callbacks.push({ job, options });
    assert.ok(targets.has(job.target));
    if (options.phase === 'prepare') return { prepared: true, submissionAllowed: true, baselineId: 'fixture' };
    if (options.phase === 'submitted') return { recorded: true };
    if (job.operation === 'file' && state.fileReceipt) return state.fileReceipt.promise;
    if (state.missingReceipt) return { confirmed: false };
    return {
      confirmed: true,
      receipt: {
        localType: job.operation === 'image' ? 3 : job.operation === 'sticker' ? 47 : 1,
        ...(['image', 'sticker'].includes(job.operation)
          ? {
              nativeImageRowConfirmed: true,
              imageContentVerified: false,
              imageContentMatch: 'raster',
              sourceImageSha256: job.sha256,
              sourceImageMd5: job.md5,
              ...(job.operation === 'sticker' ? { gifContentMd5Matched: true } : {}),
            }
          : {}),
        serverId: String(++state.number),
        localId: String(state.number),
        source: job.operation === 'voice' ? 'desktop-acoustic-match' : 'wechat-server-id',
      },
    };
  };
  const options = {
    root,
    config,
    now,
    probeAccount: async () => structuredClone(account),
    authorize: async (job, { preparing } = {}) => ({
      allowed: targets.has(job.target),
      grantId: hex('b'),
      version: 1,
      ...(preparing && job.quote && state.refreshedQuote ? { quote: state.refreshedQuote } : {}),
    }),
    authorizeCurrent: job => targets.has(job.target),
    resolveTarget: async (kind, target) => {
      assert.ok(targets.has(target));
      return { kind, wxid: target, name: 'friend', alias: 'public_friend', uniqueSearchName: true };
    },
    receipt,
    driverFactory: async factory => (
      state.factories++,
      {
        health: async () => ({ ready: true, voiceSend: config.input.voiceSend }),
        applySettings: async () => {
          state.explicitApplies = (state.explicitApplies ?? 0) + 1;
          assert.equal(state.draft, '');
        },
        prepareVoiceHandoff: async () => {
          state.voicePreflights = (state.voicePreflights ?? 0) + 1;
          if (state.preflightError) throw state.preflightError;
          if (state.preflightReason) return { ready: false, reason: state.preflightReason };
          if (state.preflightWaits > 0) {
            state.preflightWaits--;
            return { ready: false, reason: 'QT_ACTIVITY_WARMUP' };
          }
          return { ready: true };
        },
        prepare: async job => {
          await factory.resolveTarget(job);
          if (state.refusePrepareText && job.text === state.refusePrepareText)
            throw Object.assign(Error('QT_UIA_CAPTION_OBSCURED'), {
              code: 'QT_UIA_CAPTION_OBSCURED',
              attempted: false,
            });
          state.prepared = job;
          state.draft = '';
          if (state.failQuote && job.quote) {
            beginQuoteDraft(root, account.accountRef, job.target, job.id, 'ocr');
            throw Object.assign(Error('quote interrupted'), { code: 'QT_HUMAN_ACTIVITY_CHANGED' });
          }
          return { ready: true };
        },
        observe: async job =>
          state.prepared?.id === job.id
            ? {
                ready: true,
                account: job.account,
                target: job.target,
                foreground: true,
                idleMs: state.observedIdle ?? (state.holdAfterType && state.pastes.length ? 0 : 99999),
                draft: state.draft,
                editorToken: 'editor',
                activityRevision: 'activity',
                inputProcess: desktopProcessIdentity(factory.account.binding),
              }
            : { ready: false, reason: 'UI_QT_PREPARATION_REQUIRED' },
        typeGrapheme: async (job, guard, local) => {
          assert.ok(local.canInput());
          state.draft += guard.text;
          state.pastes.push(guard.text);
          return { performed: true, attempted: true };
        },
        pasteText: async (job, guard, local) => {
          assert.ok(local.canInput());
          state.draft += guard.text;
          state.pastes.push(guard.text);
          return { performed: true, attempted: true };
        },
        submit: async (job, guard, local) => {
          assert.ok(local.canSubmit());
          if (state.revokeSubmit && job.target === targetWxid)
            return { performed: false, attempted: false, reason: 'QT_TEXT_STEP_REVOKED', inputReleased: true };
          if (state.refuseSubmit-- > 0)
            return { performed: false, attempted: false, reason: 'QT_HUMAN_ACTIVITY_CHANGED' };
          state.submits.push(job.id);
          state.draft = '';
          if (state.submitThrows) throw Error('response lost');
          return { performed: true, attempted: true };
        },
        pasteImage: async job => {
          state.pastes.push(job.image.path);
          state.fileBodyAtPaste = fs.readFileSync(job.image.path, 'utf8');
          assert.equal(path.basename(job.image.path), state.expectedFileName ?? 'document.txt');
          assert.equal(job.mode, 'file');
          return { performed: true, attempted: true };
        },
        submitImage: async job => {
          state.submits.push(job.id);
          return { performed: true, attempted: true, inputReleased: state.fileInputReleased === true };
        },
        releaseTextFocus: async () => {
          if (state.releaseBusy) throw Error('UI_QT_BUSY');
          state.releaseBusy = true;
          try {
            await new Promise(resolve => setImmediate(resolve));
            if (state.releaseFailure) throw Error('UI_QT_FOCUS_RETURN_UNCONFIRMED');
            return { released: false, skipped: true };
          } finally {
            state.releaseBusy = false;
          }
        },
        close: async () => {
          state.driverCloses++;
        },
        createVoiceTransport: async callbacks => ({
          sendSegment: async job => {
            state.segments.push({ ...job, audio: undefined });
            const receipts = callbacks.receiptsFactory({ job });
            await receipts.prepare(job);
            await receipts.submitted(job, Date.now());
            if (state.focusRecoveryFailure)
              return {
                confirmed: false,
                attempted: false,
                submitAttempted: false,
                recordingPossible: false,
                stopBarrier: false,
                routeSafe: true,
                routeMode: 'unchanged',
                reason: 'VOICE_TARGET_PROOF_INVALID',
                focusRecoveryRequired: true,
                focusRecoveryError: 'QT_RETURN_CAPTION_WARMUP',
              };
            if (state.structuralCancellation)
              return {
                confirmed: false,
                attempted: true,
                submitAttempted: false,
                recordingPossible: false,
                stopBarrier: false,
                routeSafe: true,
                routeMode: 'unchanged',
                reason: 'VOICE_CAPTION_WINDOW_CHANGED',
                recordingCancellation: voiceRecordingCancellationEvidence(
                  {
                    ok: false,
                    reason: 'VOICE_CAPTION_WINDOW_CHANGED',
                    recordingAttempted: true,
                    captureVerified: true,
                    captureSessionBound: true,
                    submitAttempted: false,
                    submitInputApplied: false,
                    cancelAttempted: true,
                    cancelInputApplied: true,
                    recordingEndedObserved: true,
                    recordingPossible: false,
                    stopBarrier: false,
                    systemSettingsChanged: false,
                  },
                  job,
                ),
              };
            if (state.cancelVoiceOnce) {
              state.cancelVoiceOnce = false;
              return {
                confirmed: false,
                attempted: true,
                recordingPossible: false,
                stopBarrier: false,
                routeSafe: true,
                routeMode: 'unchanged',
                reason: 'DRAFT_HUMAN_ACTIVITY_CHANGED',
                interruptionCancellation: voiceInterruptionEvidence(
                  {
                    ok: false,
                    reason: 'DRAFT_HUMAN_ACTIVITY_CHANGED',
                    recordingAttempted: true,
                    captureSessionBound: true,
                    submitAttempted: false,
                    submitInputApplied: false,
                    cancelAttempted: true,
                    cancelInputApplied: true,
                    recordingEndedObserved: true,
                    recordingPossible: false,
                    stopBarrier: false,
                    systemSettingsChanged: false,
                  },
                  job,
                ),
              };
            }
            if (state.unknownVoice)
              return {
                confirmed: false,
                attempted: true,
                recordingPossible: true,
                stopBarrier: true,
                routeSafe: false,
              };
            const result = await receipts.query(job);
            return {
              ...result,
              ...(state.submittedFocusFailure
                ? {
                    focusRecoveryRequired: true,
                    focusRecoveryError: 'VOICE_FOCUS_RETURN_UNCONFIRMED',
                    submitAttempted: true,
                  }
                : {}),
              attempted: true,
              recordingPossible: false,
              stopBarrier: false,
              routeSafe: true,
              routeMode: 'unchanged',
            };
          },
          querySegment: async () => ({
            confirmed: false,
            recordingPossible: true,
            stopBarrier: true,
            routeSafe: false,
          }),
          close() {},
        }),
      }
    ),
  };
  let engine = createDesktopSenderEngine(options);
  t.after(async () => {
    await engine.close();
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(actual), /^desktop-engine-/);
    fs.rmSync(actual, { recursive: true });
  });
  const payload = {
    account: account.account,
    kind: 'private',
    target: targetWxid,
    deliveryId: 'first',
    text: 'hello',
  };
  return {
    root,
    config,
    account,
    state,
    payload,
    get engine() {
      return engine;
    },
    restart: async () => {
      await engine.close();
      engine = createDesktopSenderEngine(options);
      return engine;
    },
  };
}
test('invalid requests cannot poison boot, and pasted tabs keep their original text', async t => {
  const f = fixture(t);
  for (const text of ['bad\0text', 'a'.repeat(10001), '汉'.repeat(6000)]) {
    await assert.rejects(f.engine.sendText({ ...f.payload, text }), { code: 'DESKTOP_TEXT_INVALID', attempted: false });
  }
  await f.restart();
  assert.equal((await f.engine.health()).ready, true);
  f.config.input.typeText = true;
  const result = await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, text: 'code:\r\n\tindent' }));
  assert.equal(result.confirmed, true);
  assert.deepEqual(f.state.pastes, ['code:\n\tindent']);
  const cluster = 'a' + '\u0301'.repeat(65);
  const second = await finalDelivery(
    f.engine,
    f.engine.sendText({ ...f.payload, text: 'x' + cluster, deliveryId: 'large-cluster' }),
  );
  assert.equal(second.confirmed, true);
  assert.equal(f.state.pastes.at(-1), 'x' + cluster);
});

test('OCR types each grapheme and a newline under the original delivery', async t => {
  const f = fixture(t);
  f.config.input.typeText = true;
  const text = '你\n👩‍💻e\u0301😊';
  const sent = await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, text }));
  assert.equal(sent.confirmed, true);
  assert.deepEqual(f.state.pastes, ['你', '\n', '👩‍💻', 'e\u0301', '😊']);
  assert.equal(f.state.submits.length, 1);
});

test('a failed media admission is terminal across restart and cannot block subsequent jobs', async t => {
  const f = fixture(t);
  const source = path.join(f.root, 'invalid.png');
  fs.writeFileSync(source, 'invalid image');
  const result = await f.engine.sendImage({ ...f.payload, deliveryId: 'invalid-image', path: source });
  assert.equal(result.state, 'failed');
  assert.equal(result.inputStarted, false);
  assert.equal(result.submission, 'not-started');
  assert.equal(f.state.pastes.length, 0);
  await f.restart();
  assert.equal((await f.engine.health()).ready, true);
  assert.equal((await f.engine.query('invalid-image')).state, 'failed');
  assert.equal((await finalDelivery(f.engine, f.engine.sendText(f.payload))).confirmed, true);
});

test('interruption before the outbox exists records a rejection without blocking initialization', async t => {
  const f = fixture(t);
  f.config.input.paused = true;
  await f.engine.sendText(f.payload);
  const context = [...f.engine.contexts.values()][0];
  const [row] = context.metadata.values();
  const queueFile = path.join(context.directory, 'text/jobs', row.job.id + '.json');
  fs.unlinkSync(queueFile);
  fs.writeFileSync(
    path.join(context.directory, 'metadata', row.job.id + '.json'),
    JSON.stringify({ ...row, job: { ...row.job, text: 'invalid\0text' } }),
  );
  await f.restart();
  assert.equal((await f.engine.health()).ready, true);
  assert.equal((await f.engine.query(f.payload.deliveryId)).state, 'failed');
  f.config.input.paused = false;
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, deliveryId: 'later' }))).confirmed,
    true,
  );
});

test('canonical WeChat identity is shared by authorization and receipt', async t => {
  const f = fixture(t);
  const result = await finalDelivery(f.engine, f.engine.sendText(f.payload));
  assert.equal(result.confirmed, true);
  assert.deepEqual(f.state.pastes, ['hello']);
  assert.equal(f.state.submits.length, 1);
  assert.equal((await finalDelivery(f.engine, f.engine.sendText(f.payload))).confirmed, true);
  assert.equal(f.state.submits.length, 1);
});
test('concurrent initial health, prepare and send share one native driver', async t => {
  const f = fixture(t);
  const [health, prepared, result] = await Promise.all([
    f.engine.health(),
    f.engine.prepare(),
    finalDelivery(f.engine, f.engine.sendText(f.payload)),
  ]);
  assert.equal(health.ready, true);
  assert.equal(prepared.ready, true);
  assert.equal(result.confirmed, true);
  assert.equal(f.state.factories, 1);
});
test('read-only health closes both queues without racing their shared focus owner', async t => {
  const f = fixture(t);
  await f.engine.health();
  await f.engine.close();
  assert.equal(f.state.driverCloses, 1);
  assert.equal(f.state.pastes.length, 0);
});
test('real focus-return failure still surfaces after the native driver is closed', async t => {
  const f = fixture(t);
  await f.engine.health();
  f.state.releaseFailure = true;
  await assert.rejects(f.engine.close(), /UI_FOCUS_RETURN_UNCONFIRMED/);
  assert.equal(f.state.driverCloses, 1);
  f.state.releaseFailure = false;
  await Promise.all([f.engine.close(), f.engine.close()]);
  assert.equal(f.state.driverCloses, 2);
  assert.equal(f.engine.contexts.size, 0);
});
test('uncertain submit is receipt-only and never sends twice', async t => {
  const f = fixture(t, { submitThrows: true });
  assert.equal((await finalDelivery(f.engine, f.engine.sendText(f.payload))).confirmed, true);
  assert.equal(f.state.submits.length, 1);
  await f.engine.query('first');
  assert.equal(f.state.submits.length, 1);
});
test('a proven pre-Enter refusal releases intent and continues without repasting', async t => {
  const f = fixture(t);
  f.state.refuseSubmit = 1;
  assert.equal((await finalDelivery(f.engine, f.engine.sendText(f.payload))).confirmed, true);
  assert.deepEqual(f.state.pastes, ['hello']);
  assert.equal(f.state.submits.length, 1);
  const released = f.state.callbacks.find(c => c.options.phase === 'not-attempted');
  assert.deepEqual(released.options.proof, { performed: false, attempted: false });
  assert.equal(f.state.callbacks.filter(c => c.options.phase === 'prepare').length, 2);
});
test('resuming a paused draft excludes the identical Reader row already visible before input', async t => {
  let clock = Date.now(),
    rows = [];
  const f = fixture(t, { now: () => clock });
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: f.payload.target, rosterGrant: 'legacy' };
  const payload = { ...f.payload, ...scope };
  const sourceShard = hex('d');
  const baselines = [];
  const receipts = new DesktopReceipts(f.root, {
    now: () => clock,
    authorize: () => true,
    messages: async (_target, { baseline }) => ({
      messages: rows,
      ...(baseline ? { watermarks: rows.length ? { [sourceShard]: String(rows.at(-1).localId) } : {} } : {}),
    }),
  });
  f.engine.receipt = async (job, request) => {
    const result = await receipts.observe(job, request);
    if (request.phase === 'prepare') {
      baselines.push(result.baselineId);
      if (baselines.length === 1) f.config.input.paused = true;
    }
    return result;
  };
  await f.engine.request('text', payload, { admissionOnly: true });
  await until(() => baselines.length === 1 && !f.engine.pumping);
  const current = () => f.engine.listDeliveries(scope)[0];
  assert.equal(current().state, 'paused');
  assert.equal(f.state.submits.length, 0);

  clock += 20000;
  const manual = {
    sourceShard,
    localId: 1,
    serverId: '100',
    createTime: Math.floor(clock / 1000),
    localType: 1,
    isSend: 1,
    fullText: payload.text,
  };
  rows = [manual];
  f.config.input.paused = false;
  f.engine.kick();
  await until(() => ['submitted', 'confirmed'].includes(current().state));
  const lookup = () => f.engine.lookup({ ...payload, observeOnly: true });
  assert.equal((await lookup()).confirmed, false);
  assert.equal(baselines.length, 2);
  assert.notEqual(baselines[1], baselines[0]);
  rows = [manual, { ...manual, localId: 2, serverId: '101' }];
  await until(() => current().confirmed);
  assert.equal((await lookup()).receipt.serverId, '101');
  assert.deepEqual(f.state.pastes, [payload.text]);
  assert.equal(f.state.submits.length, 1);
});

const readerBaselineCases = [
  ['text'],
  [
    'image',
    'picture.png',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  ],
  ['sticker', 'sticker.gif', 'R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='],
  ['file', 'document.txt', 'aGVsbG8gZmlsZQ=='],
];
for (const [operation, name, data] of readerBaselineCases) {
  test('Reader baseline timeout preserves and retries the original draft for ' + operation, async t => {
    let clock = Date.now();
    const f = fixture(t, { now: () => clock });
    const scope = {
      accountRef: f.account.accountRef,
      kind: 'private',
      target: f.payload.target,
      rosterGrant: 'legacy',
    };
    const payload = { ...f.payload, ...scope };
    if (name) {
      payload.path = path.join(f.root, name);
      fs.writeFileSync(payload.path, Buffer.from(data, 'base64'));
    }
    if (operation === 'image' || operation === 'sticker') {
      const factory = f.engine.driverFactory;
      f.engine.driverFactory = async options => {
        const driver = await factory(options);
        driver.pasteImage = async (job, _guard, local) => {
          assert.equal(local.canInput(), true);
          f.state.pastes.push(job.image.path);
          return { performed: true, attempted: true };
        };
        return driver;
      };
    }
    let available = false,
      baselineReads = 0,
      canonical;
    const phases = [];
    const receipts = new DesktopReceipts(f.root, {
      now: () => clock,
      authorize: () => true,
      messages: async (target, { baseline }) => {
        assert.equal(target, payload.target);
        if (baseline) {
          baselineReads++;
          if (!available) throw new DOMException('Reader timed out', 'TimeoutError');
          return { messages: [], watermarks: {} };
        }
        if (!f.state.submits.length) return { messages: [] };
        const evidence = {
          text: { localType: 1, fullText: canonical.text },
          image: { localType: 3, imageMd5: canonical.md5 },
          sticker: { localType: 47, stickerMd5: canonical.md5 },
          file: {
            localType: 49,
            fileKind: 'appmsg-6',
            fileName: canonical.fileName,
            fileSize: canonical.size,
            fileMd5: canonical.md5,
          },
        }[operation];
        return {
          messages: [
            {
              sourceShard: hex('d'),
              isSend: 1,
              localId: 1,
              serverId: '100',
              createTime: Math.floor(clock / 1000),
              ...evidence,
            },
          ],
        };
      },
    });
    f.engine.receipt = (job, options) => {
      canonical = job;
      phases.push(options.phase);
      return receipts.observe(job, options);
    };
    await f.engine.request(operation, payload, { admissionOnly: true });
    await until(() => baselineReads === 1 && !f.engine.activeJob);
    const [saved] = f.engine.listDeliveries(scope);
    assert.equal(saved.state, 'paused');
    assert.equal(saved.submission, 'not-started');
    assert.equal(saved.reason, 'DESKTOP_RECEIPT_BASELINE_UNAVAILABLE');
    assert.deepEqual(phases, ['prepare']);
    assert.equal(f.state.pastes.length, 1);
    assert.equal(f.state.submits.length, 0);
    available = true;
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(baselineReads, 1);
    assert.equal(f.state.submits.length, 0);

    clock += 1000;
    await until(() => f.engine.listDeliveries(scope)[0]?.confirmed);
    assert.equal(baselineReads, 2);
    assert.equal(phases.filter(phase => phase === 'submitted').length, 1);
    assert.equal(f.state.submits.length, 1);
    assert.equal(f.state.pastes.length, 1);
  });
}

for (const [operation, name, data] of readerBaselineCases) {
  test('saved ' + operation + ' receipts are visible before the input checkpoint is updated', async t => {
    const f = fixture(t);
    const scope = {
      accountRef: f.account.accountRef,
      kind: 'private',
      target: f.payload.target,
      rosterGrant: 'legacy',
    };
    const payload = { ...f.payload, ...scope };
    if (name) {
      payload.path = path.join(f.root, name);
      fs.writeFileSync(payload.path, Buffer.from(data, 'base64'));
    }
    if (operation === 'image' || operation === 'sticker') {
      const factory = f.engine.driverFactory;
      f.engine.driverFactory = async options => {
        const driver = await factory(options);
        driver.pasteImage = async (job, _guard, local) => {
          assert.equal(local.canInput(), true);
          f.state.pastes.push(job.image.path);
          return { performed: true, attempted: true };
        };
        return driver;
      };
    }
    let canonical, committed;
    const receipts = new DesktopReceipts(f.root, {
      authorize: () => true,
      messages: async (_target, { baseline }) => {
        if (baseline) return { messages: [], watermarks: {} };
        assert.equal(f.state.submits.length, 1);
        const evidence = {
          text: { localType: 1, fullText: canonical.text },
          image: { localType: 3, imageMd5: canonical.md5 },
          sticker: { localType: 47, stickerMd5: canonical.md5 },
          file: {
            localType: 49,
            fileKind: 'appmsg-6',
            fileName: canonical.fileName,
            fileSize: canonical.size,
            fileMd5: canonical.md5,
          },
        }[operation];
        return {
          messages: [
            {
              sourceShard: hex('d'),
              isSend: 1,
              localId: 1,
              serverId: '100',
              createTime: Math.floor(Date.now() / 1000),
              ...evidence,
            },
          ],
        };
      },
    });
    f.engine.receipt = async (job, options) => {
      canonical = job;
      const result = await receipts.observe(job, options);
      if (options.phase === 'query' && result.confirmed) {
        committed = result.receipt;
        return { confirmed: false, reason: 'DESKTOP_RECEIPT_PENDING' };
      }
      return result;
    };
    await f.engine.request(operation, payload, { admissionOnly: true });
    await until(() => committed);
    const context = f.engine.contexts.get(scope.accountRef);
    const [row] = context.metadata.values();
    const checkpoint = () => f.engine.state(context, row);
    assert.equal(checkpoint().receipt, undefined);
    assert.notEqual(checkpoint().inputReleased, true);
    assert.deepEqual(f.engine.listDeliveries(scope)[0].receipt, committed);
    assert.deepEqual((await f.engine.lookup({ ...payload, observeOnly: true })).receipt, committed);
    assert.equal(checkpoint().receipt, undefined);
    assert.notEqual(checkpoint().inputReleased, true);

    await f.restart();
    f.engine.probeAccount = async () => assert.fail('saved receipt lookup must not initialize the desktop');
    f.engine.receipt = async () => assert.fail('the evidence is already in the receipt journal');
    const [listed] = savedChatDeliveries(f.root, scope.accountRef, 'wechat:private:' + scope.target, scope.rosterGrant);
    assert.deepEqual(listed.receipt, committed);
    assert.deepEqual((await f.engine.lookup(payload)).receipt, committed);
    assert.equal(f.engine.contexts.size, 0);
    assert.equal(f.state.submits.length, 1);
  });
}

for (const [operation, name, data] of readerBaselineCases) {
  for (const when of operation === 'text'
    ? ['prepare', 'before reservation', 'after reservation']
    : ['before reservation']) {
    const moment = when === 'prepare' ? 'during baseline preparation' : when;
    test('revoking permission ' + moment + ' preserves the unsent ' + operation + ' draft', async t => {
      const f = fixture(t);
      const scope = {
        accountRef: f.account.accountRef,
        kind: 'private',
        target: f.payload.target,
        rosterGrant: 'legacy',
      };
      const payload = { ...f.payload, ...scope };
      if (name) {
        payload.path = path.join(f.root, name);
        fs.writeFileSync(payload.path, Buffer.from(data, 'base64'));
      }
      if (operation === 'image' || operation === 'sticker') {
        const factory = f.engine.driverFactory;
        f.engine.driverFactory = async options => {
          const driver = await factory(options);
          driver.pasteImage = async (job, _guard, local) => {
            assert.equal(local.canInput(), true);
            f.state.pastes.push(job.image.path);
            return { performed: true, attempted: true };
          };
          return driver;
        };
      }

      let allowed = true,
        canonical;
      const phases = [];
      const authorize = (_job, forInput) => forInput === false || allowed;
      const receipts = new DesktopReceipts(f.root, {
        authorize,
        messages: async (_target, window) => {
          if (when === 'prepare' && window.baseline) allowed = false;
          return { messages: [], watermarks: {} };
        },
      });
      f.engine.authorizeCurrent = authorize;
      f.engine.receipt = async (job, options) => {
        canonical = job;
        phases.push(options.phase);
        if (when === 'before reservation' && options.phase === 'submitted') allowed = false;
        const result = await receipts.observe(job, options);
        if (when === 'after reservation' && options.phase === 'submitted') allowed = false;
        return result;
      };

      await f.engine.request(operation, payload, { admissionOnly: true });
      await until(() => !allowed && !f.engine.activeJob);
      const current = () => f.engine.listDeliveries(scope)[0];
      assert.equal(current().state, 'paused');
      assert.equal(current().submission, 'not-started');
      assert.equal(f.state.pastes.length, 1);
      assert.equal(f.state.submits.length, 0);
      await until(() => !f.engine.pumping);
      assert.equal(current().recovery?.kind, 'draft');
      assert.equal(current().reason, 'DESKTOP_PERMISSION_CHANGED');
      assert.equal(phases.includes('not-attempted'), when === 'after reservation');
      if (when === 'prepare')
        await assert.rejects(receipts.observe(canonical, { phase: 'query' }), /BASELINE_REQUIRED/);
      else
        assert.deepEqual(await receipts.observe(canonical, { phase: 'query' }), {
          confirmed: false,
          reason: 'DESKTOP_RECEIPT_NOT_SUBMITTED',
        });
    });
  }
}

const restartSubmissionCases = [
  ...readerBaselineCases.map(([operation]) => [operation, 'unreserved']),
  ['text', 'reserved'],
  ['text', 'missing'],
];
for (const [operation, reservation] of restartSubmissionCases) {
  test(
    'restart reconciles the submit checkpoint for ' + operation + ' with ' + reservation + ' receipt state',
    async t => {
      let clock = Date.now();
      const f = fixture(t, { now: () => clock });
      const [_, name, data] = readerBaselineCases.find(([kind]) => kind === operation);
      const payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'legacy' };
      if (name) {
        payload.path = path.join(f.root, name);
        fs.writeFileSync(payload.path, Buffer.from(data, 'base64'));
      }
      if (operation === 'image' || operation === 'sticker') {
        const factory = f.engine.driverFactory;
        f.engine.driverFactory = async options => {
          const driver = await factory(options);
          driver.pasteImage = async (job, _guard, local) => {
            assert.equal(local.canInput(), true);
            f.state.pastes.push(job.image.path);
            return { performed: true, attempted: true };
          };
          return driver;
        };
      }
      let readerQueries = 0;
      const receipts = new DesktopReceipts(f.root, {
        now: () => clock,
        authorize: () => true,
        messages: async (_target, { baseline }) => {
          if (!baseline) readerQueries++;
          return { messages: [], watermarks: {} };
        },
      });
      f.engine.receipt = async (job, options) => {
        if (reservation === 'missing' && options.phase === 'prepare')
          return { prepared: true, submissionAllowed: true, baselineId: 'fixture' };
        if (options.phase !== 'submitted') return receipts.observe(job, options);
        if (reservation === 'reserved') await receipts.observe(job, options);
        throw Error('interrupted before native submit');
      };
      const { context, row } = await f.engine.admit(operation, payload);
      const id = row.job.id;
      const queueFor = ctx => (operation === 'text' ? ctx.text : ctx.images);
      assert.equal((await queueFor(context).tick(id)).state, 'submitting');
      assert.equal(f.state.submits.length, 0);

      await f.restart();
      f.engine.receipt = (job, options) => receipts.observe(job, options);
      clock += 60000;
      const restored = queueFor(await f.engine.context(payload));
      if (reservation !== 'unreserved') {
        assert.equal((await restored.tick(id)).state, 'unconfirmed');
        assert.equal(f.state.submits.length, 0);
        return;
      }
      if (operation === 'image') {
        const lease = acquireDeliveryLock(restored.queue.directory, 'worker');
        assert.ok(lease);
        try {
          assert.equal((await restored.reconcileReceipt(id)).state, 'submitting');
        } finally {
          lease.release();
        }
      }
      const recovered = operation === 'text' ? await restored.tick(id) : await restored.reconcileReceipt(id);
      assert.equal(recovered.state, 'paused');
      assert.equal(recovered.reason, 'DESKTOP_RECEIPT_NOT_SUBMITTED');
      assert.equal(recovered.submittedAt, undefined);
      assert.equal(recovered.deadlineAt, undefined);
      assert.equal(readerQueries, 0);
      assert.equal(f.state.pastes.length, 1);
      assert.equal(f.state.submits.length, 0);
      assert.equal((await restored.tick(id)).state, 'submitted');
      assert.equal(f.state.pastes.length, 1);
      assert.equal(f.state.submits.length, 1);
    },
  );
}

for (const operation of ['text', 'image', 'sticker', 'voice']) {
  test('lost admission acknowledgement can be recovered for ' + operation, async t => {
    const f = fixture(t);
    f.config.input.paused = true;
    const identity = {
      ...f.account,
      voiceSend: true,
      voiceTransport: 'desktop',
      recordingAccount: f.account.accountWxid,
    };
    let healthy = true,
      calls = 0;
    const adapter = {
      directory: f.root,
      account: f.account.account,
      accountRef: f.account.accountRef,
      ownWxid: f.account.accountWxid,
      targetsSending: new Set(),
      status: { confirmed_sends: 0 },
      reload() {},
      allowed: () => true,
      project: { wechat: { whitelist: { groups: [], private: [f.payload.target] } } },
      textDeliveries: new TextDeliveryStore(path.join(f.root, 'state/text-deliveries')),
      receiptAccount: () => identity,
      checkNative: async () => {
        if (!healthy) throw Object.assign(Error('desktop readiness unavailable'), { code: 'READER_NOT_LISTENING' });
        return identity;
      },
      lookupTarget: async () => {},
      dispatchDesktop: async (op, body, account, options) => {
        calls++;
        await f.engine.request(op, { ...body, account }, options);
        throw Error('lost the admission acknowledgement');
      },
      desktopSender: f.engine,
    };

    let poll;
    if (operation === 'voice') {
      const voice = new VoiceSend(adapter);
      t.after(() => voice.close());
      const selected = { id: 'fixture', generation: '1' };
      voice.synthesis.selected = () => selected;
      voice.synthesis.candidates = () => [selected];
      assert.equal((await voice.send({ ...f.payload, wav: pcmWav(Buffer.alloc(32000)) })).status, 'pending');
      assert.ok(voice.load(f.payload.deliveryId).pendingPcm);
      poll = () => voice.status(voice.load(f.payload.deliveryId), null);
    } else {
      const media = operation !== 'text';
      const [, name, data] = readerBaselineCases.find(([kind]) => kind === operation);
      const source = name && path.join(f.root, name);
      if (source) fs.writeFileSync(source, Buffer.from(data, 'base64'));
      const send = (receiptOnly = false) =>
        deliverDesktopMessage(adapter, { ...f.payload, receiptOnly, media }, async () => ({
          operation,
          body: media ? { path: source } : { text: f.payload.text },
        }));
      assert.equal((await send()).pending, true);
      const key = adapter.textDeliveries.key('private', f.payload.target, f.payload.deliveryId, '');
      assert.equal(adapter.textDeliveries.get(key).state, 'dispatching');
      poll = () => send(true);
    }
    healthy = false;
    const result = await poll();
    assert.equal(result.admitted, true);
    assert.equal(calls, 1);
    assert.deepEqual(f.state.submits, []);
    assert.deepEqual(f.state.segments, []);
  });
}

for (const [operation, name, data] of readerBaselineCases.filter(([operation]) => operation !== 'file')) {
  test('a delayed admission response cannot revive a cancelled ' + operation + ' delivery', async t => {
    const f = fixture(t);
    f.config.input.paused = true;
    const media = operation !== 'text';
    const source = name && path.join(f.root, name);
    if (source) fs.writeFileSync(source, Buffer.from(data, 'base64'));
    const textDeliveries = new TextDeliveryStore(path.join(f.root, 'state/text-deliveries'));
    const key = textDeliveries.key(f.payload.kind, f.payload.target, f.payload.deliveryId, f.payload.text);
    const admitted = Promise.withResolvers();
    const delayResponse = Promise.withResolvers();
    const adapter = {
      accountRef: f.account.accountRef,
      project: { wechat: {} },
      allowed: () => true,
      reload() {},
      targetsSending: new Set(),
      textDeliveries,
      receiptAccount: () => f.account,
      checkNative: async () => f.account,
      desktopSender: f.engine,
      dispatchDesktop: async (op, payload, _account, options) => {
        const result = await f.engine.request(op, payload, options);
        admitted.resolve(result);
        await delayResponse.promise;
        return result;
      },
    };
    const send = (receiptOnly = false) =>
      deliverDesktopMessage(adapter, { ...f.payload, media, receiptOnly, observeOnly: receiptOnly }, async () => ({
        operation,
        body: media ? { path: source } : { text: f.payload.text },
      }));
    const sending = send().then(
      result => ({ result }),
      error => ({ error }),
    );
    try {
      const result = await Promise.race([admitted.promise, sending]);
      assert.equal(result.admitted, true);
      assert.equal(result.pending, true);
      assert.equal(textDeliveries.get(key).state, 'dispatching');

      const cancelled = await f.engine.control({ deliveryId: key, action: 'cancel' });
      assert.equal(cancelled.state, 'cancelled');
      await assert.rejects(send(true), /NATIVE_SEND_REJECTED/);
      assert.equal(textDeliveries.get(key).state, 'rejected');
    } finally {
      delayResponse.resolve();
    }

    const response = await sending;
    assert.equal(textDeliveries.get(key).state, 'rejected');
    assert.equal(response.error?.message, 'NATIVE_SEND_REJECTED');
    assert.deepEqual(f.state.pastes, []);
    assert.deepEqual(f.state.submits, []);
  });
}

test('withdrawing a saved text dispatch during readiness validation prevents its retry', async t => {
  const f = fixture(t);
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const deliveries = new TextDeliveryStore(path.join(f.root, 'state/text-deliveries'));
  const key = deliveries.key(f.payload.kind, f.payload.target, f.payload.deliveryId, f.payload.text);
  deliveries.put({
    ...f.payload,
    version: 1,
    key,
    accountRef: f.account.accountRef,
    grant: 'legacy',
    operation: 'text',
    state: 'dispatching',
    startedAt: Date.now(),
    command: { text: f.payload.text },
  });
  const adapter = {
    accountRef: f.account.accountRef,
    project: { wechat: {} },
    allowed: () => true,
    reload() {},
    targetsSending: new Set(),
    textDeliveries: deliveries,
    receiptAccount: () => f.account,
    desktopSender: { request: async () => null },
    checkNative: async () => {
      started.resolve();
      await gate.promise;
      return f.account;
    },
    dispatchDesktop: async () => assert.fail('the withdrawn intent tried to re-enter the desktop queue'),
  };
  const retry = deliverDesktopMessage(adapter, { ...f.payload, receiptOnly: true }, () => assert.fail('new command'));
  const rejected = assert.rejects(retry, /NATIVE_SEND_REJECTED/);
  try {
    await Promise.race([started.promise, retry]);
    deliveries.put({ ...deliveries.get(key), withdrawn: true });
  } finally {
    gate.resolve();
    await rejected;
  }
});

test('text above native paste size is chunked at grapheme boundaries', async t => {
  const f = fixture(t);
  const text = '字'.repeat(4500);
  const result = await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, text }));
  assert.equal(result.confirmed, true);
  assert.deepEqual(
    f.state.pastes.map(s => s.length),
    [4000, 500],
  );
});
test('ordinary files preserve basename and stage immutable bytes', async t => {
  const f = fixture(t),
    file = path.join(f.root, 'document.txt');
  fs.writeFileSync(file, 'hello file');
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendFile({ ...f.payload, path: file, text: undefined }))).confirmed,
    true,
  );
  assert.equal(f.state.fileBodyAtPaste, 'hello file');
  await until(() => !fs.existsSync(f.state.pastes[0]));
  const callback = f.state.callbacks.find(r => r.options.phase === 'prepare').job;
  assert.equal(callback.size, 10);
  assert.match(callback.md5, /^[a-f0-9]{32}$/);
});
test('each voice bubble passes foreground preflight and gets its own canonical receipt', async t => {
  const f = fixture(t);
  f.config.input.operationTimeoutMs = 3000;
  const pcm = Buffer.alloc(16000 * 2 * 9);
  const result = await finalDelivery(f.engine, f.engine.sendVoice({ ...f.payload, pcmBase64: pcm.toString('base64') }));
  assert.equal(result.confirmed, true);
  assert.equal(result.segments.length, 2);
  assert.equal(f.state.voicePreflights, 2);
  assert.equal(new Set(result.segments.map(p => p.attemptId)).size, 2);
  for (const call of f.state.callbacks.filter(c => c.job.operation === 'voice')) {
    assert.equal(call.job.segment.id, call.job.segment.attemptId);
    assert.equal(fs.readFileSync(call.job.segment.path).toString('ascii', 0, 4), 'RIFF');
  }
  const context = f.engine.contexts.get(f.account.accountRef);
  const [row] = context.metadata.values();
  assert.equal(row.job.pcmBase64, undefined);
  assert.equal(fs.existsSync(context.store.voiceInputFile(row.job.id)), false);
});
test('scoped lookup distinguishes absent jobs from other accounts, grants and durable receipts', async t => {
  const f = fixture(t),
    payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
  assert.equal(await f.engine.lookup(payload), null);
  await assert.rejects(f.engine.lookup({ ...payload, accountRef: hex('b') }), /ACCOUNT_CHANGED/);
  await finalDelivery(f.engine, f.engine.sendText(payload));
  await f.restart();
  assert.equal((await f.engine.lookup(payload)).confirmed, true);
  await assert.rejects(f.engine.lookup({ ...payload, rosterGrant: 'withdrawn' }), /ID_CONFLICT/);
  t.mock.method(f.engine, 'authorizeCurrent', (_job, forInput) => forInput);
  await assert.rejects(f.engine.lookup(payload), /RECEIPT_PERMISSION_CHANGED/);
});
test('read-only lookup can confirm a submitted delivery without an initialized desktop context', async t => {
  const f = fixture(t);
  const payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
  f.state.missingReceipt = true;
  await f.engine.sendText(payload);
  assert.equal(f.state.submits.length, 1);

  await f.restart();
  f.engine.probeAccount = async () => assert.fail('receipt lookup must not probe the desktop');
  const query = { ...payload, observeOnly: true };
  await assert.rejects(f.engine.lookup({ ...query, rosterGrant: 'different' }), /ID_CONFLICT/);
  assert.equal((await f.engine.lookup(query)).confirmed, false);
  f.state.missingReceipt = false;
  assert.equal((await f.engine.lookup(query)).confirmed, true);
  f.engine.probeAccount = async () => {
    throw Object.assign(Error('INPUT_WECHAT_NOT_RUNNING'), { code: 'INPUT_WECHAT_NOT_RUNNING' });
  };
  assert.equal((await f.engine.lookup(payload)).confirmed, true);
  assert.equal(f.engine.contexts.size, 0);
  assert.equal(f.state.submits.length, 1);
});

for (const operation of ['text', 'voice']) {
  test('scoped lookup reads a finished delivery without opening a desktop context, ' + operation, async t => {
    const f = fixture(t);
    const payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
    const sent = await finalDelivery(
      f.engine,
      operation === 'voice'
        ? f.engine.sendVoice({ ...payload, pcmBase64: Buffer.alloc(32000).toString('base64') })
        : f.engine.sendText(payload),
    );
    assert.equal(sent.confirmed, true);
    const submits = f.state.submits.length;
    const segments = f.state.segments.length;
    await f.restart();
    const probe = t.mock.method(f.engine, 'probeAccount', async () =>
      assert.fail('a saved receipt does not need a desktop probe'),
    );
    assert.equal((await f.engine.lookup(payload)).receipt.serverId, sent.receipt.serverId);
    assert.equal(f.engine.contexts.size, 0);
    t.mock.method(f.engine, 'authorizeCurrent', () => false);
    await assert.rejects(f.engine.lookup(payload), /RECEIPT_PERMISSION_CHANGED/);
    assert.equal(probe.mock.callCount(), 0);
    assert.equal(f.state.submits.length, submits);
    assert.equal(f.state.segments.length, segments);
  });
}

test('scoped lookup preserves a known waiting job during a native outage and resumes it when ready', async t => {
  const f = fixture(t);
  const payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
  f.config.input.paused = true;
  assert.equal((await f.engine.request('text', payload, { admissionOnly: true })).admitted, true);
  await f.restart();
  const probe = t.mock.method(f.engine, 'probeAccount', async () => {
    throw Object.assign(Error('INPUT_WECHAT_NOT_RUNNING'), { code: 'INPUT_WECHAT_NOT_RUNNING' });
  });
  const waiting = await f.engine.lookup(payload);
  assert.equal(waiting.admitted, true);
  assert.equal(waiting.pending, true);
  assert.equal(f.engine.contexts.size, 0);
  assert.equal(f.state.submits.length, 0);
  await assert.rejects(f.engine.lookup({ ...payload, rosterGrant: 'different' }), /ID_CONFLICT/);
  await assert.rejects(f.engine.lookup({ ...payload, deliveryId: 'different-delivery' }), /INPUT_WECHAT_NOT_RUNNING/);

  probe.mock.restore();
  f.config.input.paused = false;
  await f.engine.lookup(payload);
  await until(() => f.state.submits.length === 1);
  assert.equal((await f.engine.lookup(payload)).confirmed, true);
  assert.equal(f.state.submits.length, 1);
});

for (const [seconds, lostIndex, focusRecovery] of [
  [1, 0, true],
  [9, 0, false],
  [9, 1, false],
]) {
  test('cold voice lookup reads committed segment evidence, seconds=' + seconds + ', segment=' + lostIndex, async t => {
    const f = fixture(t);
    f.config.input.operationTimeoutMs = 3000;
    f.state.submittedFocusFailure = focusRecovery;
    const sourceShard = hex('c');
    let messageId = 100;
    const receipts = new DesktopReceipts(f.root, {
      authorize: () => true,
      messages: async () => ({ messages: [], watermarks: { [sourceShard]: '0' } }),
      recordingReceipt: async () => {
        const id = String(++messageId);
        return {
          success: true,
          match: { localId: id, serverId: id, createTime: Math.floor(Date.now() / 1000), sourceShard },
        };
      },
    });
    f.engine.receipt = async (job, options) => {
      const result = await receipts.observe(job, options);
      if (options.phase === 'query' && job.segment.index === lostIndex) {
        assert.equal(result.confirmed, true);
        return { confirmed: false, reason: 'DESKTOP_RECEIPT_PENDING' };
      }
      return result;
    };
    const payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
    const sent = await f.engine.sendVoice({ ...payload, pcmBase64: Buffer.alloc(32000 * seconds).toString('base64') });
    assert.equal(sent.confirmed, false);
    assert.equal(f.state.segments.length, lostIndex + 1);
    const context = f.engine.contexts.get(f.account.accountRef);
    const [row] = context.metadata.values();
    const checkpoint = path.join(context.directory, 'voice', row.job.id, 'job.json');
    const original = fs.readFileSync(checkpoint, 'utf8');
    assert.equal(JSON.parse(original).segments[lostIndex].state, 'unknown');
    const query = { ...payload, observeOnly: true };
    const live = await f.engine.lookup(query);
    assert.equal(live.segments[lostIndex].state, 'confirmed');
    const [liveList] = f.engine.listDeliveries(payload);
    assert.equal(liveList.segments[lostIndex].serverId, live.segments[lostIndex].serverId);
    assert.equal(fs.readFileSync(checkpoint, 'utf8'), original);
    await f.restart();
    f.engine.probeAccount = async () => assert.fail('the cold receipt must not probe the desktop');
    f.engine.receipt = async () => assert.fail('the receipt has already been recorded');
    const recovered = await f.engine.lookup(query);
    const complete = seconds === 1 || lostIndex === 1;
    assert.equal(recovered.confirmed, complete);
    assert.equal(recovered.segments[lostIndex].state, 'confirmed');
    assert.equal(recovered.segments[lostIndex].serverId, String(101 + lostIndex));
    assert.equal(recovered.segments[lostIndex].attemptId, sent.segments[lostIndex].attemptId);
    if (!complete) assert.equal(recovered.segments[1].state, 'prepared');
    if (focusRecovery) assert.equal(recovered.focusRecoveryRequired, true);
    const [listed] = savedChatDeliveries(f.root, f.account.accountRef, 'wechat:private:' + payload.target, 'current');
    assert.equal(listed.segments[lostIndex].serverId, recovered.segments[lostIndex].serverId);
    assert.equal(recovered.canResume, false);
    assert.equal(f.engine.contexts.size, 0);
    assert.equal(fs.readFileSync(checkpoint, 'utf8'), original);
    assert.equal(f.state.segments.length, lostIndex + 1);
  });
}

for (const submission of [
  'recorded',
  'not attempted',
  'unresolved',
  'different attempt',
  'reviewed live',
  'reviewed history',
]) {
  test('voice receipt lookup requires a matching recorded submission, ' + submission, async t => {
    const reviewed = submission.startsWith('reviewed');
    const sentToWechat = submission === 'recorded' || reviewed;
    const f = fixture(t);
    f.config.input.operationTimeoutMs = 3000;
    let uploaded = false,
      submittedWindow,
      reads = 0;
    const receipts = new DesktopReceipts(f.root, {
      authorize: () => true,
      messages: async () => ({ messages: [], watermarks: { [hex('c')]: '0' } }),
      recordingReceipt: async request => {
        if (uploaded) submittedWindow = request;
        reads++;
        return uploaded
          ? {
              success: true,
              match: {
                localId: '101',
                serverId: '101',
                createTime: Math.floor(Date.now() / 1000),
                sourceShard: hex('c'),
              },
            }
          : { success: false };
      },
    });
    f.engine.receipt = (job, request) => receipts.observe(job, request);
    const payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
    const sent = await f.engine.sendVoice({ ...payload, pcmBase64: Buffer.alloc(32000).toString('base64') });
    assert.equal(sent.confirmed, false);
    assert.equal(f.state.segments.length, 1);
    const context = f.engine.contexts.get(f.account.accountRef);
    const [row] = context.metadata.values();
    const outbox = path.join(context.directory, 'voice', row.job.id, 'job.json');
    const checkpoint = fs.readFileSync(outbox, 'utf8');
    const native = JSON.parse(checkpoint);
    const part = native.segments[0];
    assert.equal(part.state, 'unknown');
    const transport = path.join(f.root, 'state/native-voice-transport', part.id + '.json');
    fs.mkdirSync(path.dirname(transport), { recursive: true });
    const submittedAt = Date.now();
    const proof = JSON.stringify({
      version: 1,
      id: part.id,
      account: native.account,
      target: native.target,
      accountRef: row.job.accountRef,
      accountDirectory: row.job.account,
      voiceId: native.voiceId,
      audioSha256: submission === 'different attempt' ? hex('e') : part.sha256,
      durationMs: part.durationMs,
      state: 'finished',
      attempted: true,
      submitAttempted: submission === 'unresolved' ? null : submission !== 'not attempted',
      recordingPossible: false,
      stopBarrier: false,
      routeSafe: true,
      submittedAt,
      deadlineAt: submittedAt + 60000,
      recording: { startedAt: submittedAt, releasedAt: submittedAt },
    });
    fs.writeFileSync(transport, proof);
    if (reviewed) {
      const [recovery] = snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries;
      await f.engine.close();
      await recoverOperation({
        root: f.root,
        accountRef: f.account.accountRef,
        ...recovery,
        acknowledgeRecordingEnded: true,
        acknowledgeOutcomeReviewed: true,
        assertStopped: () => true,
      });
    }
    await f.restart();
    if (reviewed) {
      const live = await f.engine.context(payload);
      t.mock.method(live.driver, 'createVoiceTransport', async () => assert.fail('reviewed attempts need only Reader'));
      if (submission === 'reviewed history') {
        const active = live.store.get(row.job.id);
        live.store.retire(active, {
          ...f.engine.snapshot(live, active),
          reviewed: true,
          recovery: { recovered: true, canRecover: false },
        });
        assert.equal(live.metadata.has(row.job.id), false);
      }
    } else {
      f.engine.probeAccount = async () => assert.fail('receipt recovery must not initialize the desktop');
    }
    f.engine.receipt = (job, request) => receipts.observe(job, request);
    uploaded = true;
    const previousReads = reads;
    const lookedUp = await f.engine.lookup({ ...payload, observeOnly: true });
    assert.equal(lookedUp.confirmed, sentToWechat);
    assert.equal(reads - previousReads, sentToWechat ? 1 : 0);
    if (reviewed) {
      assert.equal(lookedUp.reviewed, true);
      assert.equal(lookedUp.recovery, undefined);
      const [saved] = savedChatDeliveries(f.root, payload.accountRef, 'wechat:private:' + payload.target, 'current');
      assert.equal(saved.reviewed, true);
      assert.equal(saved.recovery, undefined);
      assert.equal(saved.receipt.serverId, '101');
    }
    if (sentToWechat) {
      assert.equal(lookedUp.segments[0].serverId, '101');
      assert.equal(submittedWindow.before, Math.floor(submittedAt / 1000) + 30);
      assert.equal((await f.engine.lookup({ ...payload, observeOnly: true })).receipt.serverId, '101');
      assert.equal(reads - previousReads, 1);
    }
    assert.equal(f.engine.contexts.size, reviewed ? 1 : 0);
    assert.equal(fs.readFileSync(transport, 'utf8'), proof);
    assert.equal(fs.readFileSync(outbox, 'utf8'), checkpoint);
    assert.equal(f.state.segments.length, 1);
  });
}

function setupLateVoiceReceipt(t, { onRead = () => {}, seconds = 1 } = {}) {
  const f = fixture(t);
  const scope = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
  const request = { ...scope, pcmBase64: Buffer.alloc(32000 * seconds).toString('base64') };
  const serverIds = new Map();
  let uploaded = false,
    reads = 0;
  const receipts = new DesktopReceipts(f.root, {
    authorize: () => true,
    messages: async () => ({ messages: [], watermarks: {} }),
    recordingReceipt: async (_request, proof) => {
      const available = uploaded;
      await onRead(++reads);
      if (!serverIds.has(proof)) serverIds.set(proof, String(101 + serverIds.size));
      const serverId = serverIds.get(proof);
      return available
        ? {
            success: true,
            match: {
              serverId,
              localId: serverId,
              sourceShard: hex('c'),
              createTime: Math.floor(Date.now() / 1000),
            },
          }
        : { success: false };
    },
  });
  const useReceipts = () => {
    const original = f.engine.receipt;
    f.engine.receipt = (job, request) =>
      job.operation === 'voice' ? receipts.observe(job, request) : original(job, request);
  };
  useReceipts();
  const checkpoint = (fields = {}) => {
    const context = f.engine.contexts.get(scope.accountRef);
    const [row] = context.metadata.values();
    const file = path.join(context.directory, 'voice', row.job.id, 'job.json');
    const saved = fs.readFileSync(file, 'utf8');
    const job = JSON.parse(saved);
    const part = job.segments[0];
    const destination = path.join(f.root, 'state/native-voice-transport', part.id + '.json');
    const at = Date.now();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const proof = JSON.stringify({
      version: 1,
      id: part.id,
      account: job.account,
      target: job.target,
      accountRef: scope.accountRef,
      accountDirectory: row.job.account,
      voiceId: job.voiceId,
      audioSha256: part.sha256,
      durationMs: part.durationMs,
      state: 'finished',
      attempted: true,
      submitAttempted: true,
      recordingPossible: false,
      stopBarrier: false,
      routeSafe: true,
      submittedAt: at,
      deadlineAt: at + 60000,
      recording: { startedAt: at, releasedAt: at },
      ...fields,
    });
    fs.writeFileSync(destination, proof);
    return { file, saved, destination, proof };
  };
  return { f, scope, request, useReceipts, checkpoint, showReceipt: () => (uploaded = true), reads: () => reads };
}

for (const busy of ['executor', 'voice query']) {
  test('a read-only voice receipt lookup succeeds during a busy ' + busy, async t => {
    const gate = Promise.withResolvers();
    const v = setupLateVoiceReceipt(t, {
      onRead: reads => (busy === 'executor' && reads === 1 ? gate.promise : undefined),
    });
    const { f, scope } = v;
    const lookup = () => f.engine.lookup({ ...scope, observeOnly: true });
    let original;
    try {
      if (busy === 'executor') {
        await f.engine.request('voice', v.request, { admissionOnly: true });
        await until(() => v.reads() === 1);
        assert.ok(f.engine.pumping);
      } else {
        assert.equal((await f.engine.sendVoice(v.request)).state, 'unconfirmed');
        await f.engine.pumping;
        const voice = f.engine.contexts.get(scope.accountRef).voice;
        t.mock.method(voice.transport, 'querySegment', async () => {
          await gate.promise;
          return {
            confirmed: false,
            recordingPossible: false,
            stopBarrier: false,
            routeSafe: true,
            routeMode: 'unchanged',
          };
        });
        original = lookup();
        await until(() => voice.running);
      }
      const { file, saved } = v.checkpoint();
      v.showReceipt();
      const result = await lookup();
      assert.equal(result.confirmed, true);
      assert.equal(result.receipt.serverId, '101');
      assert.equal(fs.readFileSync(file, 'utf8'), saved);
      assert.equal(v.reads(), 2);
      assert.equal(f.state.segments.length, 1);
    } finally {
      gate.resolve();
      await original;
      await f.engine.pumping;
    }
  });
}

function useNativeVoiceQueries(t, f, context) {
  const create = context.driver.createVoiceTransport;
  return t.mock.method(context.driver, 'createVoiceTransport', async callbacks => {
    const sender = await create(callbacks);
    const transport = new NativeVoiceTransport({
      root: f.root,
      driver: { prepareVoiceSession: () => assert.fail('receipt recovery must not prepare input') },
      audioEndpoints: () => assert.fail('receipt recovery must not select audio endpoints'),
      runNative: () => assert.fail('receipt recovery must not start recording'),
      ...callbacks,
    });
    return { ...sender, querySegment: transport.querySegment.bind(transport) };
  });
}

for (const ownership of ['released', 'recording uncertain', 'focus uncertain']) {
  test('the executor settles a saved voice receipt only after verified release, ' + ownership, async t => {
    const v = setupLateVoiceReceipt(t);
    const { f, scope } = v;
    const released = ownership === 'released';
    assert.equal((await f.engine.sendVoice(v.request)).state, 'unconfirmed');
    const fields =
      ownership === 'recording uncertain'
        ? { state: 'unknown', recordingPossible: true, stopBarrier: true, routeSafe: false }
        : ownership === 'focus uncertain'
          ? { focusRecoveryRequired: true, focusRecoveryError: 'VOICE_FOCUS_RETURN_UNCONFIRMED' }
          : {};
    const { file, saved, destination, proof } = v.checkpoint(fields);
    await f.restart();
    v.useReceipts();
    v.showReceipt();
    assert.equal((await f.engine.lookup({ ...scope, observeOnly: true })).receipt.serverId, '101');
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    f.config.input.paused = true;
    const context = await f.engine.context(scope);
    const transport = useNativeVoiceQueries(t, f, context);
    const next = { ...scope, deliveryId: 'after-voice' };
    await f.engine.request('text', next, { admissionOnly: true });
    await f.engine.pumping;
    assert.equal(f.engine.pumpFailure ?? null, null);
    assert.equal(transport.mock.callCount(), released ? 1 : 0);
    const checkpoint = fs.readFileSync(file, 'utf8');
    if (released) {
      assert.equal(JSON.parse(checkpoint).state, 'confirmed');
      assert.deepEqual(snapshotOperations({ root: f.root, accountRef: scope.accountRef }).recoveries, []);
    } else {
      assert.equal(checkpoint, saved);
      assert.equal(snapshotOperations({ root: f.root, accountRef: scope.accountRef }).recoveries.length, 1);
    }
    assert.equal(fs.readFileSync(destination, 'utf8'), proof);
    assert.deepEqual(f.state.pastes, []);
    assert.equal(f.state.segments.length, 1);
    f.config.input.paused = false;
    if (released) {
      assert.equal((await finalDelivery(f.engine, f.engine.sendText(next))).confirmed, true);
      assert.equal(f.state.submits.length, 1);
    } else {
      f.engine.kick();
      await f.engine.pumping;
      assert.equal((await f.engine.lookup({ ...next, observeOnly: true })).state, 'queued');
      assert.deepEqual(f.state.pastes, []);
      assert.deepEqual(f.state.submits, []);
    }
  });
}

for (const inputAllowed of [true, false]) {
  test(
    'a late receipt settles the first voice segment before the unsent tail, input allowed=' + inputAllowed,
    async t => {
      const v = setupLateVoiceReceipt(t, { seconds: 13 });
      const { f, scope } = v;
      const submitted = await f.engine.sendVoice(v.request);
      assert.deepEqual(
        submitted.segments.map(part => part.state),
        ['unknown', 'prepared'],
      );
      const { file, saved, destination, proof } = v.checkpoint();
      await f.restart();
      v.useReceipts();
      v.showReceipt();
      const lookup = () => f.engine.lookup({ ...scope, observeOnly: true });
      const observed = await lookup();
      assert.deepEqual(
        observed.segments.map(part => part.state),
        ['confirmed', 'prepared'],
      );
      assert.equal(observed.confirmed, false);
      assert.equal(fs.readFileSync(file, 'utf8'), saved);

      f.config.input.paused = true;
      const context = await f.engine.context(scope);
      useNativeVoiceQueries(t, f, context);
      f.engine.kick();
      await f.engine.pumping;
      const partial = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(
        partial.segments.map(part => part.state),
        ['confirmed', 'prepared'],
      );
      assert.equal(f.state.segments.length, 1);
      assert.equal(partial.segments[0].receipt.serverId, '101');
      const [listed] = f.engine.listDeliveries(scope);
      assert.equal(listed.state, 'waiting');
      assert.equal(listed.canCancel, true);
      assert.equal(listed.reviewed, undefined);
      assert.deepEqual(snapshotOperations({ root: f.root, accountRef: scope.accountRef }).recoveries, []);

      f.engine.authorizeCurrent = (_job, forInput) => !forInput || inputAllowed;
      f.config.input.paused = false;
      f.engine.kick();
      await f.engine.pumping;
      const final = await lookup();
      assert.equal(final.confirmed, inputAllowed);
      assert.deepEqual(
        final.segments.map(part => part.state),
        ['confirmed', inputAllowed ? 'confirmed' : 'cancelled'],
      );
      assert.equal(final.segments[0].serverId, '101');
      if (inputAllowed) assert.equal(final.segments[1].serverId, '102');
      assert.deepEqual(
        f.state.segments.map(part => part.index),
        inputAllowed ? [0, 1] : [0],
      );
      assert.equal(fs.readFileSync(destination, 'utf8'), proof);
    },
  );
}

test('a stopped queue ignores the old recovery form after a voice segment checkpoint was settled', async t => {
  const v = setupLateVoiceReceipt(t, { seconds: 13 });
  const { f, scope } = v;
  assert.equal((await f.engine.sendVoice(v.request)).state, 'unconfirmed');
  v.checkpoint();
  const inspect = () => snapshotOperations({ root: f.root, accountRef: scope.accountRef }).recoveries;
  const [recovery] = inspect();
  await f.restart();
  v.useReceipts();
  v.showReceipt();
  const context = await f.engine.context(scope);
  const row = context.store.get(recovery.id);
  useNativeVoiceQueries(t, f, context);
  const voice = await installVoice(f.engine, context);
  const settled = await voice.query(voiceRequest(row));
  assert.deepEqual(
    settled.segments.map(part => part.state),
    ['confirmed', 'prepared'],
  );
  await f.engine.close();

  const recoveries = path.join(context.directory, 'recovery', row.job.id + '.json');
  assert.equal(fs.existsSync(recoveries), true);
  assert.deepEqual(inspect(), []);
  const readSaved = () =>
    savedChatDeliveries(f.root, scope.accountRef, 'wechat:private:' + scope.target, scope.rosterGrant)[0];
  const saved = readSaved();
  assert.equal(saved.state, 'waiting');
  assert.equal(saved.canCancel, true);
  assert.equal(saved.recovery, undefined);
  const original = fs.readFileSync(recoveries, 'utf8');
  const unrelated = { ...JSON.parse(original), recordingAttempts: [hex('f')] };
  fs.writeFileSync(recoveries, JSON.stringify(unrelated));
  try {
    assert.deepEqual(inspect(), [unrelated]);
    assert.deepEqual(readSaved().recovery, unrelated);
    assert.equal(readSaved().canCancel, false);
  } finally {
    fs.writeFileSync(recoveries, original);
  }
  await assert.rejects(
    recoverOperation({
      root: f.root,
      accountRef: scope.accountRef,
      ...recovery,
      acknowledgeRecordingEnded: true,
      acknowledgeOutcomeReviewed: true,
      assertStopped: () => true,
    }),
    { code: 'DESKTOP_RECOVERY_CHANGED' },
  );

  await f.restart();
  f.config.input.paused = true;
  await f.engine.context(scope);
  f.engine.kick();
  await f.engine.pumping;
  assert.equal(fs.existsSync(recoveries), false);
  assert.equal(readSaved().segments[0].serverId, '101');
  assert.equal(f.state.segments.length, 1);
});

test('focus recovery for a split voice describes the unconfirmed segment despite an earlier receipt', async t => {
  const f = fixture(t);
  const create = f.engine.driverFactory;
  f.engine.driverFactory = async options => {
    const driver = await create(options);
    const preflight = driver.prepareVoiceHandoff;
    driver.prepareVoiceHandoff = (...args) => {
      if (f.state.segments.length === 1) {
        f.state.submittedFocusFailure = true;
        f.state.missingReceipt = true;
      }
      return preflight(...args);
    };
    return driver;
  };
  const result = await f.engine.sendVoice({ ...f.payload, pcmBase64: Buffer.alloc(32000 * 13).toString('base64') });
  assert.deepEqual(
    result.segments.map(part => part.state),
    ['confirmed', 'unknown'],
  );
  const [recovery] = snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries;
  assert.equal(recovery.focusRecoveryRequired, true);
  assert.match(recovery.message, /语音提交结果仍需核对/u);
});

for (const restart of [false, true]) {
  const context = restart ? 'after restart' : 'with an active context';
  test(`read-only lookup finds a saved job during another admission ${context}`, async t => {
    const other = 'wxid_other';
    const f = fixture(t, { additionalTargets: [other] });
    const payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
    if (restart) {
      assert.equal((await finalDelivery(f.engine, f.engine.sendText(payload))).confirmed, true);
      await f.restart();
    } else {
      f.config.input.paused = true;
      await f.engine.request('text', payload, { admissionOnly: true });
    }
    f.config.input.paused = true;

    const blocker = Promise.withResolvers();
    let held = false;
    if (restart) {
      const probe = f.engine.probeAccount.bind(f.engine);
      f.engine.probeAccount = async (...args) => {
        held = true;
        await blocker.promise;
        return probe(...args);
      };
    } else {
      const authorize = f.engine.authorize.bind(f.engine);
      f.engine.authorize = async (job, options) => {
        if (job.target === other) {
          held = true;
          await blocker.promise;
        }
        return authorize(job, options);
      };
    }
    const next = { ...payload, target: other, deliveryId: 'later', text: 'fixture later delivery' };
    const admission = f.engine.request('text', next, { admissionOnly: true });
    let known, missing;
    let absenceSettled = false;
    try {
      await until(() => held);
      known = f.engine.lookup({ ...payload, observeOnly: true });
      missing = f.engine.lookup({ ...next, observeOnly: true }).then(result => {
        absenceSettled = true;
        return result;
      });
      const first = await Promise.race([known, new Promise(resolve => setImmediate(() => resolve(null)))]);
      assert.equal(first?.deliveryId, payload.deliveryId);
      if (restart) assert.equal(first.confirmed, true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(absenceSettled, false, 'an in-flight job must not look absent');
    } finally {
      blocker.resolve();
      await Promise.allSettled([admission, known, missing]);
    }
    assert.equal((await admission).deliveryId, next.deliveryId);
    assert.equal((await missing).deliveryId, next.deliveryId);
    assert.equal(f.state.submits.length, restart ? 1 : 0);
  });
}

test('read-only lookup waits for an admission held by a settings change', async t => {
  const f = fixture(t);
  f.config.input.paused = true;
  const payload = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
  await f.engine.request('text', payload, { admissionOnly: true });

  const gate = Promise.withResolvers();
  const factory = f.engine.driverFactory;
  let applying = false;
  f.engine.driverFactory = async options => {
    const driver = await factory(options);
    const apply = driver.applySettings;
    driver.applySettings = async () => {
      applying = true;
      await gate.promise;
      return apply();
    };
    return driver;
  };
  f.config.input.controlMode = 'uia';

  const next = { ...payload, deliveryId: 'after-configuration' };
  const waiting = Symbol('waiting');
  let admission, lookup, existing;
  try {
    assert.equal(f.engine.applyConfiguration().pending, true);
    await until(() => applying);
    admission = f.engine.request(
      'voice',
      { ...next, pcmBase64: Buffer.alloc(32000).toString('base64') },
      {
        admissionOnly: true,
      },
    );
    lookup = f.engine.lookup({ ...next, observeOnly: true });
    existing = f.engine.lookup({ ...payload, observeOnly: true });
    const nextTurn = new Promise(resolve => setImmediate(() => resolve(waiting)));
    const [saved, inFlight] = await Promise.all([Promise.race([existing, nextTurn]), Promise.race([lookup, nextTurn])]);
    assert.equal(saved?.deliveryId, payload.deliveryId);
    assert.equal(inFlight, waiting, 'waiting for configuration must not look like an absent job');
  } finally {
    gate.resolve();
    await Promise.allSettled([admission, lookup, existing]);
  }
  const accepted = await admission;
  assert.equal(accepted.deliveryId, next.deliveryId);
  assert.equal(accepted.state, 'queued');
  assert.deepEqual(await lookup, accepted);
  assert.equal(f.state.submits.length, 0);
  assert.equal(f.state.segments.length, 0);
});

for (const operation of ['text', 'image', 'sticker', 'dsh voice', 'api voice']) {
  test('polling an admitted reply can finish during a different chat admission, ' + operation, async t => {
    const other = 'wxid_other';
    const f = fixture(t, { additionalTargets: [other] });
    f.config.input.paused = true;
    const identity = {
      ...f.account,
      voiceSend: true,
      voiceTransport: 'desktop',
      recordingAccount: f.account.accountWxid,
    };
    const adapter = {
      directory: f.root,
      account: identity.account,
      accountRef: identity.accountRef,
      ownWxid: identity.accountWxid,
      receiptAccount: () => identity,
      targetsSending: new Set(),
      status: { confirmed_sends: 0 },
      reload() {},
      allowed: () => true,
      project: { wechat: { whitelist: { groups: [], private: [f.payload.target] } } },
      textDeliveries: new TextDeliveryStore(path.join(f.root, 'state/text-deliveries')),
      checkNative: async () => {
        await f.engine.health({ account: identity.account });
        return identity;
      },
      lookupTarget: async () => {},
      dispatchDesktop: (op, payload, account, options) => f.engine.request(op, { ...payload, account }, options),
      desktopSender: f.engine,
    };
    let poll;
    if (operation.endsWith('voice')) {
      const voice = new VoiceSend(adapter);
      t.after(() => voice.close());
      const plugin = { id: 'fixture-voice', generation: hex('b') };
      voice.synthesis.selected = () => plugin;
      voice.synthesis.candidates = () => [plugin];
      if (operation === 'api voice') {
        const deliveryId = 'audit-voice';
        assert.equal(
          (await voice.send({ ...f.payload, deliveryId, wav: pcmWav(Buffer.alloc(32000)) })).status,
          'pending',
        );
        poll = () => voice.status(voice.load(deliveryId), null);
      } else {
        voice.synthesis.generate = async () => ({ wav: pcmWav(Buffer.alloc(32000)), allowed: () => true });
        const deliveryId = hex('7');
        assert.equal(voice.speakReply({ ...f.payload, deliveryId }).status, 'pending');
        const id = 'dsh-' + deliveryId;
        await voice.runReply(id, false);
        assert.equal(voice.load(id).nativeStatus, 'pending');
        poll = () => voice.status(voice.load(id), null);
      }
    } else {
      const media = operation !== 'text';
      const source = path.join(f.root, operation === 'sticker' ? 'poll.gif' : 'poll.png');
      if (media)
        fs.writeFileSync(
          source,
          Buffer.from(
            operation === 'sticker'
              ? 'R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
              : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
            'base64',
          ),
        );
      const send = (receiptOnly = false) =>
        deliverDesktopMessage(adapter, { ...f.payload, receiptOnly, media }, async () => ({
          operation,
          body: media ? { path: source } : { text: f.payload.text },
        }));
      assert.equal((await send()).admitted, true);
      poll = () => send(true);
    }

    const lookup = f.engine.lookup.bind(f.engine);
    let observed;
    f.engine.lookup = async query => {
      observed = await lookup(query);
      return observed;
    };
    const gate = Promise.withResolvers();
    const probe = f.engine.probeAccount;
    let blocked = false;
    f.engine.probeAccount = async args => {
      if (args.request.target === other) {
        blocked = true;
        await gate.promise;
      }
      return probe(args);
    };
    const admitting = f.engine.request(
      'text',
      { ...f.payload, accountRef: identity.accountRef, target: other, deliveryId: 'audit-later' },
      { admissionOnly: true },
    );
    let result;
    try {
      await until(() => blocked);
      result = poll();
      const res = await Promise.race([result, new Promise(resolve => setImmediate(() => resolve(null)))]);
      assert.ok(res, 'a known task should not have to wait for another chat to admit a job');
      assert.equal(observed?.operation, operation.endsWith('voice') ? 'voice' : operation);
      assert.equal(observed.pending, true);
      if (operation.endsWith('voice')) assert.equal(res.status, 'pending');
      else assert.equal(res.admitted, true);
    } finally {
      gate.resolve();
      await Promise.allSettled([admitting, result]);
    }
    assert.equal(f.state.submits.length, 0);
    assert.equal(f.state.segments.length, 0);
  });
}

test('two minutes of PCM reach the normal desktop queue and retain per-segment receipts', async t => {
  const f = fixture(t);
  f.config.input.operationTimeoutMs = 10000;
  const pcm = Buffer.alloc(120 * 32000, 3);
  const result = await finalDelivery(f.engine, f.engine.sendVoice({ ...f.payload, pcmBase64: pcm.toString('base64') }));
  assert.equal(result.confirmed, true);
  assert.equal(
    result.segments.reduce((n, s) => n + s.durationMs, 0),
    120000,
  );
  assert.equal(new Set(result.segments.map(s => s.serverId)).size, result.segments.length);
});

test('maximum-duration audio enters the desktop engine with every segment bound to one delivery', async t => {
  const f = fixture(t, { unknownVoice: true });
  f.config.input.operationTimeoutMs = 10000;
  const encoded = Buffer.alloc(1024 * 32000, 3).toString('base64');
  const result = await finalDelivery(f.engine, f.engine.sendVoice({ ...f.payload, pcmBase64: encoded }));
  assert.equal(
    result.segments.reduce((ms, part) => ms + part.durationMs, 0),
    1024000,
  );
  assert.ok(result.segments.length > 128);
  assert.equal(f.state.segments.length, 1);
});

test('File Transfer voice uses the normal queue and acoustic receipt without duplicate admission', async t => {
  const f = fixture(t, { targetWxid: 'filehelper' }),
    payload = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  const result = await finalDelivery(f.engine, f.engine.sendVoice(payload));
  assert.equal(result.confirmed, true);
  assert.equal(result.segments[0].source, 'desktop-acoustic-match');
  assert.equal((await finalDelivery(f.engine, f.engine.sendVoice(payload))).confirmed, true);
  assert.equal(f.state.segments.length, 1);
  assert.equal(f.state.pastes.length, 0);
  assert.ok(f.state.callbacks.filter(c => c.job.operation === 'voice').every(c => c.job.target === 'filehelper'));
  assert.deepEqual(snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries, []);
});
test('a previously uncertain File Transfer delivery is not relabelled as never attempted', async t => {
  const f = fixture(t, { targetWxid: 'filehelper', unknownVoice: true }),
    payload = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  assert.equal((await f.engine.sendVoice(payload)).state, 'unconfirmed');
  await f.restart();
  const same = await f.engine.sendVoice(payload);
  assert.equal(same.state, 'unconfirmed');
  assert.equal(same.submission, 'unknown');
  assert.equal(same.submitted, true);
  assert.equal(f.state.segments.length, 1);
});
test('paused File Transfer voice resumes normally after restart and releases the next job', async t => {
  const f = fixture(t, { targetWxid: 'filehelper' });
  f.config.input.paused = true;
  const payload = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  assert.equal((await f.engine.sendVoice(payload)).state, 'queued');
  await f.restart();
  f.config.input.paused = false;
  await f.engine.query('first');
  await until(() => !f.engine.pumping);
  const result = await f.engine.query('first');
  assert.equal(result.state, 'confirmed');
  assert.equal(result.submission, 'confirmed');
  assert.equal(result.recovery, undefined);
  assert.equal(f.state.segments.length, 1);
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, deliveryId: 'after-voice' }))).confirmed,
    true,
  );
});
test('a fully cancelled recording retries under a fresh attempt baseline', async t => {
  const f = fixture(t);
  f.config.input.operationTimeoutMs = 2000;
  f.state.cancelVoiceOnce = true;
  const result = await finalDelivery(
    f.engine,
    f.engine.sendVoice({
      ...f.payload,
      pcmBase64: Buffer.alloc(32000).toString('base64'),
    }),
  );
  assert.equal(result.confirmed, true);
  const prepared = f.state.callbacks.filter(c => c.options.phase === 'prepare').map(c => c.job.segment.attemptId);
  assert.equal(prepared.length, 2);
  assert.notEqual(prepared[0], prepared[1]);
  assert.equal(result.segments[0].attemptId, prepared[1]);
  assert.equal(result.segments[0].source, 'desktop-acoustic-match');
});
test('unknown voice holds later text until explicit stopped recovery; old id stays nonreplayable', async t => {
  const f = fixture(t, { unknownVoice: true });
  const voice = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  assert.equal((await f.engine.sendVoice(voice)).state, 'unconfirmed');
  assert.equal((await f.engine.sendText({ ...f.payload, deliveryId: 'later' })).state, 'queued');
  assert.equal(f.state.pastes.length, 0);
  const [record] = snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries;
  assert.equal(record.kind, 'recording');
  await f.engine.close();
  await recoverOperation({
    root: f.root,
    accountRef: f.account.accountRef,
    ...record,
    acknowledgeRecordingEnded: true,
    acknowledgeOutcomeReviewed: true,
    assertStopped: () => true,
  });
  await f.restart();
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, deliveryId: 'later' }))).confirmed,
    true,
  );
  assert.equal((await f.engine.sendVoice(voice)).state, 'unconfirmed');
  assert.equal(f.state.segments.length, 1);
});

async function finalDelivery(engine, request) {
  let result = await request;
  await until(async () => {
    if (result.pending && !result.recovery) result = await engine.query(result.deliveryId);
    return !result.pending || result.recovery;
  });
  return result;
}

async function until(check) {
  for (let n = 0; n < 1000; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('control fixture timeout');
}
test('a revoked text proof keeps only its own chat on hold after confirmed cleanup', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  f.state.revokeSubmit = true;
  const isolated = await finalDelivery(f.engine, f.engine.sendText(f.payload));
  assert.equal(isolated.state, 'conflict');
  assert.equal(isolated.inputReleased, true);
  assert.equal(isolated.reason, 'QT_TEXT_STEP_REVOKED');
  assert.ok(isolated.recovery);
  assert.equal(f.state.draft, f.payload.text);

  const sameChat = await f.engine.send('text', { ...f.payload, deliveryId: 'same-chat' }, { admissionOnly: true });
  const other = await finalDelivery(
    f.engine,
    f.engine.sendText({
      ...f.payload,
      deliveryId: 'other-chat',
      target: 'wxid_other',
    }),
  );
  assert.equal(other.confirmed, true);
  assert.equal((await f.engine.query(sameChat.deliveryId, true)).inputStarted, false);
  assert.deepEqual(f.state.submits, [(await f.engine.find(other.deliveryId)).row.job.id]);
});

test('a newly verified WeChat process detaches an old draft even after the sender service restarts', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  f.account.binding = { pid: 10, processCreatedFileTimeUtc: '134000000000000000' };
  f.state.holdAfterType = true;
  const first = await f.engine.send('text', f.payload, { admissionOnly: true });
  await until(async () => (await f.engine.query(first.deliveryId, true)).inputStarted);
  assert.deepEqual(f.state.submits, []);
  await f.restart();

  await f.engine.health();
  const unchanged = await f.engine.query(first.deliveryId, true);
  assert.notEqual(unchanged.inputReleased, true);

  f.account.binding = { pid: 11, processCreatedFileTimeUtc: '134000000100000000' };
  await f.engine.health();
  const detached = await f.engine.query(first.deliveryId, true);
  assert.equal(detached.state, 'conflict');
  assert.equal(detached.inputReleased, true);
  assert.equal(detached.reason, 'UI_WECHAT_PROCESS_RESTARTED');
  assert.ok(detached.recovery);
  f.state.holdAfterType = false;
  const next = await finalDelivery(
    f.engine,
    f.engine.sendText({
      ...f.payload,
      deliveryId: 'next-after-restart',
      target: 'wxid_other',
    }),
  );
  assert.equal(next.confirmed, true);
  assert.deepEqual(f.state.submits, [(await f.engine.find(next.deliveryId)).row.job.id]);
});
test('a client restart releases an uncertain submit while allowing a late receipt for its original ID', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'], submitThrows: true });
  f.account.binding = { pid: 10, processCreatedFileTimeUtc: '134000000000000000' };
  f.state.missingReceipt = true;
  const first = await finalDelivery(f.engine, f.engine.sendText(f.payload));
  assert.equal(first.state, 'unconfirmed');
  assert.ok(first.recovery);
  f.account.binding = { pid: 11, processCreatedFileTimeUtc: '134000000100000000' };
  await f.engine.health();
  const waiting = await f.engine.query(first.deliveryId, true);
  assert.equal(waiting.state, 'unconfirmed');
  assert.equal(waiting.inputReleased, true);
  assert.equal(waiting.recovery, undefined);
  assert.notEqual(waiting.reviewed, true);
  assert.equal(f.state.submits.length, 1);

  f.state.missingReceipt = false;
  f.state.submitThrows = false;
  const next = await finalDelivery(
    f.engine,
    f.engine.sendText({
      ...f.payload,
      deliveryId: 'continues',
      target: 'wxid_other',
    }),
  );
  const late = await f.engine.query(first.deliveryId, true);
  assert.equal(next.confirmed, true);
  assert.equal(late.confirmed, true);
  assert.equal(late.deliveryId, first.deliveryId);
  assert.deepEqual(f.state.submits, [
    (await f.engine.find(first.deliveryId)).row.job.id,
    (await f.engine.find(next.deliveryId)).row.job.id,
  ]);
});
test('mode and offscreen changes replace an idle context without any input and typing preference needs no rebuild', async t => {
  const f = fixture(t);
  await f.engine.health();
  f.config.input.controlMode = 'uia';
  f.config.input.offscreen = true;
  assert.equal(f.engine.applyConfiguration().accepted, true);
  await until(() => !f.engine.configurationPending && !f.engine.applying);
  assert.equal(f.state.factories, 2);
  assert.equal(f.state.driverCloses, 1);
  assert.equal(f.state.pastes.length, 0);
  assert.equal(f.state.explicitApplies, 1);
  assert.equal([...f.engine.contexts.values()][0].settings.offscreen, true);
  f.config.input.typeText = true;
  assert.equal(f.engine.applyConfiguration().applied, true);
  assert.equal(f.state.factories, 2);
});

test('saving a second mode during driver construction applies the latest settings before reporting success', async t => {
  const f = fixture(t);
  await f.engine.health();
  const factory = f.engine.driverFactory;
  const buildingUia = Promise.withResolvers();
  const finishUia = Promise.withResolvers();
  const applied = [];
  f.engine.driverFactory = async options => {
    const { controlMode, offscreen } = options.settings;
    const driver = await factory(options);
    if (controlMode === 'uia') {
      buildingUia.resolve();
      await finishUia.promise;
    }
    driver.applySettings = async () => applied.push({ controlMode, offscreen });
    return driver;
  };

  Object.assign(f.config.input, { controlMode: 'uia', offscreen: true });
  assert.equal(f.engine.configurationStatus().applied, false);
  f.engine.applyConfiguration();
  await buildingUia.promise;
  try {
    Object.assign(f.config.input, { controlMode: 'ocr', offscreen: false });
    assert.equal(f.engine.applyConfiguration().applied, false);
  } finally {
    finishUia.resolve();
  }
  await until(() => !f.engine.configurationPending && !f.engine.applying);
  assert.deepEqual(applied, [{ controlMode: 'ocr', offscreen: false }]);
  assert.deepEqual(f.engine.configurationStatus(), {
    pending: false,
    applied: true,
    error: null,
    controlMode: 'ocr',
    offscreen: false,
  });
});

test('service startup applies an already-saved offscreen setting after read-only health without waiting for a message', async t => {
  const f = fixture(t);
  f.config.input.controlMode = 'uia';
  f.config.input.offscreen = true;
  await f.engine.health();
  assert.equal(f.state.explicitApplies, undefined);
  const sender = new DesktopSender(f.root);
  sender.loading = Promise.resolve(f.engine);
  const state = await sender.resumePending();
  assert.equal(state.applied, true);
  assert.equal(f.state.explicitApplies, 1);
  assert.equal(f.state.pastes.length, 0);
  assert.equal([...f.engine.contexts.values()][0].settings.offscreen, true);
});

test('a failed explicit window apply remains retryable even when the replacement context already has the new configuration', async t => {
  const f = fixture(t);
  await f.engine.health();
  const factory = f.engine.driverFactory;
  let reject = true;
  f.engine.driverFactory = async options => {
    const driver = await factory(options),
      apply = driver.applySettings;
    driver.applySettings = async () => {
      if (reject) throw Object.assign(Error('OFFSCREEN_KEYS_HELD'), { code: 'OFFSCREEN_KEYS_HELD' });
      return apply();
    };
    return driver;
  };
  f.config.input.controlMode = 'uia';
  f.config.input.offscreen = true;
  f.engine.applyConfiguration();
  await until(() => !f.engine.applying && f.engine.configurationError === 'OFFSCREEN_KEYS_HELD');
  reject = false;
  assert.equal(f.engine.applyConfiguration().pending, true);
  await until(() => !f.engine.applying && !f.engine.configurationPending);
  assert.equal(f.engine.configurationError, null);
  assert.equal(f.state.explicitApplies, 1);
});
test('a failed account probe during a settings change rebuilds and applies on retry', async t => {
  const f = fixture(t);
  await f.engine.health();
  const probe = f.engine.probeAccount;
  f.engine.probeAccount = async () => {
    throw Object.assign(Error('INPUT_ACCOUNT_UNVERIFIED'), { code: 'INPUT_ACCOUNT_UNVERIFIED' });
  };
  f.config.input.controlMode = 'uia';
  f.config.input.offscreen = true;
  f.engine.applyConfiguration();
  await until(() => !f.engine.applying && f.engine.configurationError === 'INPUT_ACCOUNT_UNVERIFIED');
  assert.equal(f.engine.configurationStatus().applied, false);
  assert.equal(f.engine.contexts.size, 0);

  f.engine.probeAccount = probe;
  f.engine.applyConfiguration();
  await until(() => !f.engine.applying && !f.engine.configurationPending);
  assert.equal(f.engine.configurationStatus().applied, true);
  assert.equal(f.engine.contexts.size, 1);
  assert.equal(f.state.explicitApplies, 1);
});
test('an entered text can pause and resume while a strategy change waits for its existing checkpoint to finish', async t => {
  const f = fixture(t);
  f.config.input.typeText = true;
  f.state.holdAfterType = true;
  const sending = f.engine.sendText({ ...f.payload, text: 'ab', rosterGrant: 'legacy' });
  await until(() => f.state.pastes.length === 1 && !f.engine.activeJob);
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: 'wxid_friend', rosterGrant: 'legacy' };
  let [row] = f.engine.listDeliveries(scope);
  assert.equal(row.inputStarted, true);
  assert.equal(row.canCancel, true);
  await f.engine.control({ ...scope, id: row.id, revision: row.revision, action: 'pause' });
  await sending;
  [row] = f.engine.listDeliveries(scope);
  assert.equal(row.state, 'paused');
  assert.equal(row.canResume, true);
  f.config.input.controlMode = 'uia';
  const applied = f.engine.applyConfiguration();
  assert.equal(applied.pending, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.state.driverCloses, 0);
  f.state.holdAfterType = false;
  await f.engine.control({ ...scope, id: row.id, revision: row.revision, action: 'resume' });
  await until(() => !f.engine.configurationPending && !f.engine.applying && f.state.submits.length === 1);
  assert.deepEqual(f.state.pastes, ['a', 'b']);
  assert.equal(f.state.factories, 2);
  assert.equal(f.state.explicitApplies, 1);
  [row] = f.engine.listDeliveries(scope);
  assert.equal(row.state, 'confirmed');
  assert.equal(row.canCancel, false);
});
test('operator versions survive waiting polls but reject an already applied command', async t => {
  const f = fixture(t);
  f.state.observedIdle = 0;
  const { context, row } = await f.engine.admit('text', { ...f.payload, rosterGrant: 'legacy' });
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: 'wxid_friend', rosterGrant: 'legacy' };
  await context.text.tick();
  const shown = f.engine.listDeliveries(scope)[0];
  const nativeRevision = context.text.get(row.job.id).revision;
  for (let n = 0; n < 5; n++) await context.text.tick();
  assert.equal(context.text.get(row.job.id).revision, nativeRevision);
  assert.equal(f.engine.listDeliveries(scope)[0].revision, shown.revision);
  const paused = await f.engine.control({ ...scope, id: shown.id, revision: shown.revision, action: 'pause' });
  assert.equal(paused.state, 'paused');
  await assert.rejects(
    f.engine.control({ ...scope, id: shown.id, revision: shown.revision, action: 'resume' }),
    /CONTROL_CHANGED/,
  );
  assert.equal(f.state.pastes.length, 0);
});

test('receipt timeout applies to new submissions while a submitted deadline remains fixed', async t => {
  const f = fixture(t);
  f.state.missingReceipt = true;
  const { context, row } = await f.engine.admit('text', f.payload);
  await until(async () => {
    await context.text.tick();
    return context.text.get(row.job.id).state === 'submitted';
  });
  const deadline = context.text.get(row.job.id).deadlineAt;
  f.config.input.receiptTimeoutMs = 30000;
  assert.equal(f.engine.applyConfiguration().pending, true);
  assert.equal(context.text.get(row.job.id).deadlineAt, deadline);
  f.state.missingReceipt = false;
  await until(() => !f.engine.configurationPending && !f.engine.applying);
  const replacement = await f.engine.context();
  assert.equal(replacement.text.settings.receiptTimeoutMs, 30000);
  const second = await f.engine.admit('text', { ...f.payload, deliveryId: 'new-timeout' });
  await until(async () => {
    await second.context.text.tick();
    return second.context.text.get(second.row.job.id).state === 'submitted';
  });
  const job = second.context.text.get(second.row.job.id);
  assert.equal(job.deadlineAt - job.submittedAt, 30000);
});

test('native queue controls reject stale revisions and different conversation scopes', async t => {
  const f = fixture(t);
  f.config.input.paused = true;
  await f.engine.sendText({ ...f.payload, rosterGrant: 'legacy' });
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: 'wxid_friend', rosterGrant: 'legacy' },
    [row] = f.engine.listDeliveries(scope);
  await assert.rejects(
    f.engine.control({ ...scope, id: row.id, revision: row.revision, target: 'wxid_other', action: 'pause' }),
    /SCOPE_CHANGED/,
  );
  const paused = await f.engine.control({ ...scope, id: row.id, revision: row.revision, action: 'pause' });
  await assert.rejects(
    f.engine.control({ ...scope, id: row.id, revision: row.revision, action: 'cancel' }),
    /CONTROL_CHANGED/,
  );
  const cancelled = await f.engine.control({
    ...scope,
    id: row.id,
    revision: paused.revision,
    action: 'cancel',
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(f.state.pastes.length, 0);
});

const refusedInputCases = [
  ['text', 'typeGrapheme', 'pause'],
  ['text', 'pasteText', 'cancel'],
  [
    'image',
    'pasteImage',
    'cancel',
    'picture.png',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  ],
  ['sticker', 'pasteImage', 'cancel', 'sticker.gif', 'R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='],
  ['file', 'pasteImage', 'cancel', 'document.txt', 'ZmlsZSBmaXh0dXJl'],
];
for (const [operation, method, action, name, data] of refusedInputCases) {
  test(`a definitive ${method} refusal survives ${action} and restart for ${operation}`, async t => {
    const other = 'wxid_other';
    const f = fixture(t, { additionalTargets: [other] });
    f.config.input.typeText = method === 'typeGrapheme';
    const scope = {
      accountRef: f.account.accountRef,
      kind: 'private',
      target: f.payload.target,
      rosterGrant: 'legacy',
    };
    const payload = { ...f.payload, ...scope, text: 'A' };
    if (name) {
      payload.path = path.join(f.root, name);
      fs.writeFileSync(payload.path, Buffer.from(data, 'base64'));
    }

    const gate = Promise.withResolvers();
    const factory = f.engine.driverFactory;
    let entered = false,
      recoveriesDuring;
    f.engine.driverFactory = async options => {
      const driver = await factory(options);
      driver[method] = async (_job, _guard, local) => {
        entered = true;
        await gate.promise;
        assert.equal(local.canInput(), false);
        return { performed: false, attempted: false, reason: 'QT_HUMAN_ACTIVITY_CHANGED' };
      };
      return driver;
    };
    const current = () => f.engine.listDeliveries(scope)[0];
    const control = action => f.engine.control({ ...scope, id: current().id, revision: current().revision, action });
    try {
      await f.engine.request(operation, payload, { admissionOnly: true });
      await until(() => entered);
      assert.equal(current().inputStarted, true);
      assert.equal((await control(action)).state, action === 'pause' ? 'paused' : 'cancelled');
      recoveriesDuring = f.engine.operationsSnapshot(scope.accountRef).recoveries;
    } finally {
      gate.resolve();
      await f.engine.pumping;
    }
    assert.equal(current().inputStarted, false, 'a definitive refusal must clear the pending input');
    assert.equal(current().reason, action === 'pause' ? 'UI_USER_PAUSED' : 'UI_USER_CANCELLED');
    assert.deepEqual(recoveriesDuring, []);
    assert.deepEqual(f.engine.operationsSnapshot(scope.accountRef).recoveries, []);
    assert.deepEqual(f.state.pastes, []);
    assert.deepEqual(f.state.submits, []);

    await f.restart();
    const restored = await f.engine.request(operation, payload, { admissionOnly: true });
    assert.equal(restored.state, action === 'pause' ? 'paused' : 'cancelled');
    assert.equal(restored.inputStarted, false);
    if (action === 'pause') {
      await control('resume');
      assert.equal((await finalDelivery(f.engine, f.engine.query(payload.deliveryId))).confirmed, true);
      assert.deepEqual(f.state.pastes, ['A']);
    } else {
      const next = { ...f.payload, target: other, deliveryId: 'other' };
      assert.equal((await finalDelivery(f.engine, f.engine.sendText(next))).confirmed, true);
      assert.deepEqual(f.state.pastes, [f.payload.text]);
    }
    assert.equal(f.state.submits.length, 1);
    assert.deepEqual(f.engine.operationsSnapshot(scope.accountRef).recoveries, []);
  });
}

test('cancelling an unresolved input retains its recovery when the sender stops', async t => {
  const f = fixture(t);
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: f.payload.target, rosterGrant: 'legacy' };
  const payload = { ...f.payload, ...scope };
  const gate = Promise.withResolvers();
  const factory = f.engine.driverFactory;
  let entered = false;
  f.engine.driverFactory = async options => {
    const driver = await factory(options);
    driver.pasteText = async () => {
      entered = true;
      await gate.promise;
      return { performed: false, attempted: true, reason: 'UI_INPUT_UNCERTAIN' };
    };
    return driver;
  };
  let stopping;
  try {
    await f.engine.request('text', payload, { admissionOnly: true });
    await until(() => entered);
    const [row] = f.engine.listDeliveries(scope);
    await f.engine.control({ ...scope, id: row.id, revision: row.revision, action: 'cancel' });
    assert.deepEqual(f.engine.operationsSnapshot(scope.accountRef).recoveries, []);
    stopping = f.engine.close();
  } finally {
    gate.resolve();
    await stopping;
  }
  const [recovery] = f.engine.operationsSnapshot(scope.accountRef).recoveries;
  assert.equal(recovery?.kind, 'draft');
  await f.restart();
  const restored = await f.engine.request('text', payload, { admissionOnly: true });
  assert.equal(restored.state, 'cancelled');
  assert.equal(restored.inputStarted, true);
  assert.equal(restored.recovery?.id, recovery.id);
  assert.deepEqual(f.state.pastes, []);
  assert.deepEqual(f.state.submits, []);
});

test('revoking an unentered head job retires it and lets the next allowed target advance', async t => {
  const f = fixture(t),
    allowed = new Set(['wxid_friend', 'wxid_second']);
  f.config.input.paused = true;
  f.engine.authorizeCurrent = job => allowed.has(job.target);
  f.engine.authorize = async job => ({ allowed: allowed.has(job.target), grantId: hex('b'), version: 1 });
  f.engine.resolveTarget = async (kind, target) => ({
    kind,
    wxid: target,
    name: 'fixture',
    alias: 'fixture',
    uniqueSearchName: true,
  });
  f.engine.receipt = async (_job, options) =>
    options.phase === 'prepare'
      ? { prepared: true, submissionAllowed: true, baselineId: 'fixture' }
      : options.phase === 'submitted'
        ? { recorded: true }
        : { confirmed: true, receipt: { serverId: '1001', localId: '1' } };
  await f.engine.sendText(f.payload);
  await f.engine.sendText({
    ...f.payload,
    target: 'wxid_second',
    deliveryId: 'next',
    text: 'next',
  });
  allowed.delete('wxid_friend');
  f.config.input.paused = false;
  f.engine.kick();
  await until(() => f.state.submits.length === 1 && !f.engine.pumping);
  assert.equal((await f.engine.query('first')).state, 'cancelled');
  assert.equal((await finalDelivery(f.engine, f.engine.query('next'))).confirmed, true);
  assert.deepEqual(f.state.pastes, ['next']);
});

test('revoking a partial draft creates a review barrier instead of resending or discarding its checkpoint', async t => {
  const f = fixture(t);
  f.config.input.typeText = true;
  f.state.holdAfterType = true;
  let allowed = true;
  f.engine.authorizeCurrent = () => allowed;
  const pending = f.engine.sendText({ ...f.payload, text: 'ab' });
  await until(() => f.state.pastes.length === 1 && !f.engine.activeJob);
  allowed = false;
  f.engine.kick();
  await pending;
  await until(() => snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries.length === 1);
  const [recovery] = snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries;
  assert.equal(recovery.kind, 'draft');
  allowed = true;
  f.state.holdAfterType = false;
  f.engine.kick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(f.state.pastes, ['a']);
  assert.equal(f.state.submits.length, 0);
});

test('a proven unrecorded voice with failed focus return blocks later work without claiming a submitted recording', async t => {
  const f = fixture(t);
  f.state.focusRecoveryFailure = true;
  f.state.preflightWaits = 1;
  const result = await f.engine.sendVoice({
    ...f.payload,
    pcmBase64: Buffer.alloc(32000).toString('base64'),
  });
  assert.equal(result.state, 'cancelled');
  assert.equal(result.submitted, false);
  assert.equal(result.submission, 'not-started');
  assert.equal(result.focusRecoveryRequired, true);
  assert.equal(result.reason, 'VOICE_TARGET_PROOF_INVALID');
  const [recovery] = snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries;
  assert.equal(recovery.kind, 'draft');
  assert.equal((await f.engine.sendText({ ...f.payload, deliveryId: 'after-focus-failure' })).state, 'queued');
  assert.deepEqual(f.state.pastes, []);
  f.config.input.controlMode = 'uia';
  assert.equal(f.engine.applyConfiguration().pending, true);
  assert.equal(f.state.driverCloses, 0);
  await f.engine.close();
  await recoverOperation({
    root: f.root,
    accountRef: f.account.accountRef,
    ...recovery,
    acknowledgeDraftCleared: true,
    acknowledgeOutcomeReviewed: true,
    assertStopped: () => true,
  });
  await f.restart();
  f.state.focusRecoveryFailure = false;
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, deliveryId: 'after-focus-failure' }))).confirmed,
    true,
  );
  assert.equal(f.state.segments.length, 1);
});

test('a structural recording cancellation is terminal and lets later text proceed without another recording', async t => {
  const f = fixture(t);
  f.state.structuralCancellation = true;
  const voice = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  const result = await f.engine.sendVoice(voice);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.submitted, false);
  assert.equal(result.recovery, undefined);
  assert.deepEqual(snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries, []);
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, deliveryId: 'following-text' }))).confirmed,
    true,
  );
  assert.equal((await f.engine.query('first')).state, 'cancelled');
  assert.equal(f.state.segments.length, 1);
});

test('a closed file dialog frees the desktop while the file worker waits for the receipt', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  const file = path.join(f.root, 'document.txt');
  fs.writeFileSync(file, 'fixture');
  f.state.fileInputReleased = true;
  f.config.input.operationTimeoutMs = 0;
  const delayed = (f.state.fileReceipt = Promise.withResolvers());
  const request = { ...f.payload, path: file, text: undefined };
  // The file worker keeps polling after an admission response returns pending.
  const admitted = await f.engine.sendFile(request);
  assert.equal(admitted.pending, true);
  const first = finalDelivery(f.engine, admitted);
  try {
    await until(() => f.state.callbacks.some(c => c.job.operation === 'file' && c.options.phase === 'query'));
    const text = await finalDelivery(
      f.engine,
      f.engine.sendText({ ...f.payload, target: 'wxid_other', deliveryId: 'other-chat-text' }),
    );
    assert.equal(text.confirmed, true);
    assert.equal(f.state.submits.length, 2);
  } finally {
    delayed.resolve({ confirmed: true, receipt: { source: 'wechat-server-id', serverId: '910', localId: '10' } });
    await first;
  }
  assert.equal((await first).confirmed, true);
  assert.deepEqual(snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries, []);
});

test('file focus cleanup failure preserves the submission and fences other chats', async t => {
  const other = 'wxid_other';
  const f = fixture(t, { additionalTargets: [other] });
  const file = path.join(f.root, 'document.txt');
  fs.writeFileSync(file, 'fixture');
  f.state.fileInputReleased = true;
  f.state.missingReceipt = true;
  const factory = f.engine.driverFactory;
  f.engine.driverFactory = async options => {
    const driver = await factory(options);
    const submit = driver.submitImage;
    driver.submitImage = async (job, guard, local) => {
      assert.equal(local.deferFocusRelease, true);
      const result = await submit(job, guard, local);
      f.state.releaseFailure = true;
      return result;
    };
    return driver;
  };
  const scope = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'legacy' };
  const next = { ...scope, target: other, deliveryId: 'other-after-focus-failure' };
  try {
    await f.engine.request('file', { ...scope, path: file, text: undefined }, { admissionOnly: true });
    await until(() => f.engine.pumpFailure === 'UI_FOCUS_RETURN_UNCONFIRMED');
    const saved = await f.engine.lookup({ ...scope, observeOnly: true });
    assert.equal(saved.state, 'submitted');
    assert.equal(saved.inputReleased, true);
    assert.equal(f.state.submits.length, 1);
    await f.engine.request('text', next, { admissionOnly: true });
    await f.engine.pumping;
    assert.equal(f.state.pastes.length, 1);
    f.state.missingReceipt = false;
    assert.equal((await f.engine.lookup({ ...scope, observeOnly: true })).confirmed, true);
    f.engine.kick();
    await f.engine.pumping;
    assert.equal(f.state.pastes.length, 1);
    assert.equal(f.state.submits.length, 1);
  } finally {
    f.state.releaseFailure = false;
  }
  await f.restart();
  assert.equal((await finalDelivery(f.engine, f.engine.sendText(next))).confirmed, true);
  assert.equal(f.state.submits.length, 2);
});

test('reviewed file delivery releases the image queue but never replays its old id', async t => {
  const f = fixture(t),
    file = path.join(f.root, 'document.txt');
  fs.writeFileSync(file, 'fixture');
  f.state.missingReceipt = true;
  f.config.input.operationTimeoutMs = 1500;
  const request = { ...f.payload, path: file, text: undefined };
  assert.equal((await f.engine.sendFile(request)).state, 'unconfirmed');
  const [recovery] = snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries;
  await f.engine.close();
  await recoverOperation({
    root: f.root,
    accountRef: f.account.accountRef,
    ...recovery,
    acknowledgeDraftCleared: true,
    acknowledgeOutcomeReviewed: true,
    assertStopped: () => true,
  });
  f.state.missingReceipt = false;
  await f.restart();
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendFile({ ...request, deliveryId: 'after-review' }))).confirmed,
    true,
  );
  assert.equal((await f.engine.sendFile(request)).state, 'unconfirmed');
  assert.equal(f.state.pastes.length, 2);
  assert.equal(f.state.submits.length, 2);
});

test('confirmed voice retains a failed focus barrier through restart and reviewed recovery', async t => {
  const f = fixture(t);
  f.state.submittedFocusFailure = true;
  const voice = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  const result = await finalDelivery(f.engine, f.engine.sendVoice(voice));
  assert.equal(result.confirmed, true);
  assert.equal(result.focusRecoveryRequired, true);
  await f.restart();
  assert.equal((await f.engine.sendText({ ...f.payload, deliveryId: 'following' })).state, 'queued');
  const [recovery] = snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries;
  assert.match(recovery.message, /已确认送达/);
  await f.engine.close();
  await recoverOperation({
    root: f.root,
    accountRef: f.account.accountRef,
    ...recovery,
    acknowledgeDraftCleared: true,
    acknowledgeOutcomeReviewed: true,
    assertStopped: () => true,
  });
  await f.restart();
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, deliveryId: 'following' }))).confirmed,
    true,
  );
  const reviewed = await finalDelivery(f.engine, f.engine.sendVoice(voice));
  assert.equal(reviewed.confirmed, true);
  assert.deepEqual(reviewed.receipt, result.receipt);
  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.focusRecoveryRequired, undefined);
  assert.equal(reviewed.recovery, undefined);
  assert.equal(f.state.segments.length, 1);
});

test('reviewed OCR quote preparation clears only the original draft and permits a new delivery', async t => {
  const f = fixture(t);
  f.state.failQuote = true;
  const serverId = '123',
    quote = {
      id: crypto
        .createHash('sha256')
        .update(f.payload.target + '\0' + serverId)
        .digest('hex'),
      serverId,
      sender: 'wxid_friend',
      timestamp: 1700000000,
      text: 'source',
    };
  const request = { ...f.payload, quote, accountRef: f.account.accountRef, rosterGrant: 'current' };
  assert.equal((await f.engine.sendText(request)).state, 'paused');
  assert.equal(readQuoteDraft(f.root, f.account.accountRef, f.payload.target).bound, false);
  const [recovery] = snapshotOperations({ root: f.root, accountRef: f.account.accountRef }).recoveries;
  await f.engine.close();
  await recoverOperation({
    root: f.root,
    accountRef: f.account.accountRef,
    ...recovery,
    acknowledgeDraftCleared: true,
    acknowledgeOutcomeReviewed: true,
    assertStopped: () => true,
  });
  assert.equal(readQuoteDraft(f.root, f.account.accountRef, f.payload.target), null);
  f.state.failQuote = false;
  await f.restart();
  const checkReview = result => {
    assert.equal(result.reviewed, true);
    assert.equal(result.state, 'unconfirmed');
    assert.equal(result.pending, false);
    assert.equal(result.confirmed, false);
    assert.equal(result.recovery, undefined);
  };
  const query = { ...request, observeOnly: true };
  const probe = t.mock.method(f.engine, 'probeAccount', async () => assert.fail('reviewed history needs no desktop'));
  checkReview(await f.engine.lookup(query));
  checkReview(await f.engine.lookup(request));
  assert.equal(probe.mock.callCount(), 0);
  probe.mock.restore();
  const [offline] = savedChatDeliveries(f.root, request.accountRef, 'wechat:private:' + request.target, 'current');
  checkReview(offline);
  assert.equal(offline.canResume, false);
  await f.engine.context(request);
  const [live] = f.engine.listDeliveries(request);
  checkReview(live);
  assert.equal(live.canResume, false);
  checkReview(await f.engine.lookup(query));
  checkReview(await f.engine.sendText(request));
  assert.equal(f.state.submits.length, 0);
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendText({ ...request, deliveryId: 'new-quote' }))).confirmed,
    true,
  );
  assert.equal(f.state.submits.length, 1);
});

test('zero idle preference reaches the text and image queues without an added second', async t => {
  const f = fixture(t);
  f.config.input.idleMs = 0;
  // Observed idle stays at zero. A positive threshold cannot pass even on a slow runner.
  f.config.input.operationTimeoutMs = 3000;
  f.state.observedIdle = 0;
  assert.equal((await finalDelivery(f.engine, f.engine.sendText(f.payload))).confirmed, true);
  const file = path.join(f.root, 'document.txt');
  fs.writeFileSync(file, 'fixture');
  assert.equal(
    (await f.engine.sendFile({ ...f.payload, deliveryId: 'zero-idle-file', text: undefined, path: file })).confirmed,
    true,
  );
});

test('a chat hold saved while stopped governs admitted and new jobs without resuming individual pauses', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  const write = (name, value) => {
    const file = path.join(f.root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const key = 'wechat:private:wxid_friend',
    grant = 'grant-A';
  write('state/weflow/active-account.json', { id: f.account.accountRef });
  write('config/wechatagent.json', {
    wechat: { whitelist: { private: ['wxid_friend', 'wxid_other'], groups: [] }, rosterGrants: { [key]: grant } },
  });
  const controls = new ReplyDeliveryControls(f.root, f.account.accountRef);
  const heldJob = { ...f.payload, rosterGrant: grant };
  await f.engine.admit('text', heldJob);
  await f.engine.admit('text', { ...heldJob, deliveryId: 'explicit-pause' });
  f.config.input.paused = true;
  await f.engine.control({ deliveryId: 'explicit-pause', action: 'pause' });
  await f.engine.close();
  controls.control({ key, grant, operation: 'pause', revision: 0 });
  await f.restart();
  f.config.input.paused = false;
  f.config.input.operationTimeoutMs = 1500;
  const other = await f.engine.sendText({
    ...f.payload,
    target: 'wxid_other',
    deliveryId: 'other',
    text: 'other chat',
  });
  assert.equal(other.confirmed, true);
  assert.deepEqual(f.state.pastes, ['other chat']);
  controls.control({ key, grant, operation: 'resume', revision: 1 });
  await finalDelivery(f.engine, f.engine.query('first'));
  assert.equal((await f.engine.query('explicit-pause')).state, 'paused');
  assert.deepEqual(f.state.pastes, ['other chat', 'hello']);
});

test('a read-only voice preflight wait leaves other chats runnable and preserves the waiting chat FIFO', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  f.state.preflightWaits = 9999;
  await f.engine.admit('voice', { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') });
  await f.engine.admit('text', { ...f.payload, deliveryId: 'later', text: 'behind voice' });
  const other = await finalDelivery(
    f.engine,
    f.engine.sendText({
      ...f.payload,
      target: 'wxid_other',
      deliveryId: 'other',
      text: 'other chat',
    }),
  );
  assert.equal(other.confirmed, true);
  assert.deepEqual(f.state.pastes, ['other chat']);
  assert.equal((await f.engine.query('later')).state, 'queued');
});

test('turning off voice before recording leaves another chat runnable', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  f.state.preflightWaits = 9999;
  f.config.input.operationTimeoutMs = 80;
  const voice = await f.engine.sendVoice({ ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') });
  assert.equal(voice.inputStarted, false);
  f.config.input.voiceSend = false;
  f.engine.applyConfiguration();
  await until(() => !f.engine.configurationPending && !f.engine.applying);
  f.config.input.operationTimeoutMs = 1500;
  const other = await f.engine.sendText({
    ...f.payload,
    target: 'wxid_other',
    deliveryId: 'other',
  });
  assert.equal(other.confirmed, true);
  assert.equal(f.state.segments.length, 0);
});

test('a thrown read-only voice preflight waits in its chat while a second chat sends', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  f.state.preflightError = Object.assign(Error('UI_QT_FOCUS_PREFLIGHT_INVALID'), {
    code: 'UI_QT_FOCUS_PREFLIGHT_INVALID',
    attempted: false,
  });
  await f.engine.admit('voice', { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') });
  const other = await finalDelivery(
    f.engine,
    f.engine.sendText({ ...f.payload, target: 'wxid_other', deliveryId: 'other' }),
  );
  assert.equal(other.confirmed, true);
  assert.equal((await f.engine.query(f.payload.deliveryId)).reason, 'UI_QT_FOCUS_PREFLIGHT_INVALID');
  assert.equal(f.state.segments.length, 0);
  assert.equal(f.engine.pumpFailure, undefined);
});

test('an unverified focus return during voice preflight still blocks further desktop work', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  f.state.preflightError = Object.assign(Error('UI_QT_LAYOUT_FOCUS_RETURN_UNVERIFIED'), {
    code: 'UI_QT_LAYOUT_FOCUS_RETURN_UNVERIFIED',
    attempted: false,
  });
  await f.engine.admit('voice', { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') });
  const other = await f.engine.sendText({ ...f.payload, target: 'wxid_other', deliveryId: 'other' });
  assert.equal(other.reason, 'UI_QT_LAYOUT_FOCUS_RETURN_UNVERIFIED');
  assert.deepEqual(f.state.pastes, []);
});

for (const waiting of ['earlier admission', 'authorization']) {
  test('voice admission expires before native persistence while waiting for ' + waiting, async t => {
    let clock = Date.now();
    const f = fixture(t, { now: () => clock });
    f.config.input.paused = true;
    const admissionDeadlineAt = clock + 1000;
    const gate = Promise.withResolvers();
    const authorize = f.engine.authorize.bind(f.engine);
    let blocked = false,
      voiceChecks = 0;
    f.engine.authorize = async (job, options) => {
      if (job.operation === 'voice') voiceChecks++;
      if (job.operation === (waiting === 'authorization' ? 'voice' : 'text')) {
        blocked = true;
        await gate.promise;
      }
      return authorize(job, options);
    };
    const earlier =
      waiting === 'earlier admission'
        ? f.engine.request('text', { ...f.payload, deliveryId: 'earlier' }, { admissionOnly: true })
        : null;
    try {
      if (earlier) await until(() => blocked);
      const pcmBase64 = Buffer.alloc(32000).toString('base64');
      const expiry = assert.rejects(
        f.engine.request('voice', { ...f.payload, pcmBase64 }, { admissionOnly: true, admissionDeadlineAt }),
        { code: 'DESKTOP_ADMISSION_EXPIRED', attempted: false },
      );
      if (!earlier) await until(() => blocked);
      clock = admissionDeadlineAt;
      gate.resolve();
      await expiry;
    } finally {
      gate.resolve();
      await earlier;
    }
    const { store } = await f.engine.context(f.payload);
    assert.equal(
      [...store.rows.values()].some(row => row.job.operation === 'voice'),
      false,
    );
    assert.equal(voiceChecks, waiting === 'authorization' ? 1 : 0);
    assert.equal(f.state.segments.length, 0);
  });
}

test('a voice admitted during global pause resumes after its admission deadline', async t => {
  let clock = Date.now();
  const f = fixture(t, { now: () => clock });
  f.config.input.paused = true;
  assert.equal((await f.engine.health()).voiceSend, true);
  const payload = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  const options = { admissionOnly: true, admissionDeadlineAt: clock + 1000 };
  const admitted = await f.engine.request('voice', payload, options);
  assert.equal(admitted.state, 'queued');
  clock = options.admissionDeadlineAt + 1;
  const reused = await f.engine.request('voice', payload, options);
  assert.equal(reused.deliveryId, admitted.deliveryId);
  assert.equal(reused.state, 'queued');
  assert.equal(f.state.voicePreflights ?? 0, 0);
  f.config.input.paused = false;
  const result = await finalDelivery(f.engine, f.engine.query(f.payload.deliveryId));
  assert.equal(result.confirmed, true);
  assert.equal(f.state.segments.length, 1);
});

test('a paused untouched chat preserves its FIFO while another chat sends, including after restart', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  f.config.input.paused = true;
  await f.engine.sendText(f.payload);
  await f.engine.sendText({ ...f.payload, deliveryId: 'same-chat-later', text: 'later in first chat' });
  await f.engine.control({ deliveryId: 'first', action: 'pause' });
  await f.restart();
  f.config.input.paused = false;
  const other = await finalDelivery(
    f.engine,
    f.engine.sendText({
      ...f.payload,
      target: 'wxid_other',
      deliveryId: 'other',
      text: 'second chat',
    }),
  );
  assert.equal(other.state, 'confirmed');
  assert.deepEqual(f.state.pastes, ['second chat']);
  assert.equal((await f.engine.query('first')).inputStarted, false);
  assert.equal((await f.engine.query('same-chat-later')).state, 'queued');
  await f.engine.control({ deliveryId: 'first', action: 'resume' });
  const resumed = await finalDelivery(f.engine, f.engine.query('same-chat-later'));
  assert.equal(resumed.confirmed, true);
  assert.deepEqual(f.state.pastes, ['second chat', 'hello', 'later in first chat']);
});

for (const pausedOperation of ['text', 'file'])
  test(`a paused ${pausedOperation} does not choose work for the other media queue`, async t => {
    const f = fixture(t, { additionalTargets: ['wxid_other'] });
    const file = path.join(f.root, 'document.txt');
    fs.writeFileSync(file, 'fixture');
    const attachment = { path: file, fileName: 'document.txt' };
    const send = (operation, body) =>
      operation === 'file' ? f.engine.sendFile({ ...body, ...attachment }) : f.engine.sendText(body);
    f.config.input.paused = true;
    await send(pausedOperation, f.payload);
    await f.engine.control({ deliveryId: 'first', action: 'pause' });
    f.config.input.paused = false;
    const other = await finalDelivery(
      f.engine,
      send(pausedOperation === 'file' ? 'text' : 'file', {
        ...f.payload,
        target: 'wxid_other',
        deliveryId: 'other',
      }),
    );
    assert.equal(other.confirmed, true);
    assert.equal((await f.engine.query('first')).state, 'paused');
    assert.equal((await f.engine.query('first')).inputStarted, false);
  });

test('a paused chat with actual draft input remains an exclusive desktop barrier', async t => {
  const f = fixture(t, { additionalTargets: ['wxid_other'] });
  f.state.holdAfterType = true;
  const first = await f.engine.sendText(f.payload);
  assert.equal(first.inputStarted, true);
  await f.engine.control({ deliveryId: 'first', action: 'pause' });
  const other = await f.engine.sendText({
    ...f.payload,
    target: 'wxid_other',
    deliveryId: 'other',
    text: 'second chat',
  });
  assert.equal(other.state, 'queued');
  assert.deepEqual(f.state.pastes, ['hello']);
  assert.equal(f.state.submits.length, 0);
});

test('cancelling voice before recording frees capacity and an archived ID stays cancelled after restart', async t => {
  const f = fixture(t);
  f.config.input.paused = true;
  const payload = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  assert.equal((await f.engine.sendVoice(payload)).state, 'queued');
  const result = await f.engine.control({ action: 'cancel', deliveryId: payload.deliveryId });
  assert.equal(result.inputStarted, false);
  assert.equal(result.state, 'cancelled');
  const context = await f.engine.context();
  const original = [...context.metadata.values()][0];
  for (let i = 1; i < 128; i++) {
    const job = {
      ...original.job,
      id: crypto
        .createHash('sha256')
        .update('cancelled-' + i)
        .digest('hex'),
    };
    context.store.save({ ...original, job });
  }
  f.engine.prune(context);
  assert.equal(context.store.activeIds.size, 0);
  await f.restart();
  assert.equal((await f.engine.sendVoice(payload)).state, 'cancelled');
  assert.equal((await f.engine.context()).metadata.size, 0);
  assert.equal(f.state.segments.length, 0);
});

test('a queued proactive send rechecks the original admission before first input after restart', async t => {
  const f = fixture(t);
  const intent = { contextId: 'c'.repeat(64), expiresAt: Date.now() + 60000 };
  const { row } = await f.engine.admit('text', { ...f.payload, proactive: intent, inputDeadlineAt: intent.expiresAt });
  await f.restart();
  const engine = f.engine;
  const original = engine.authorize.bind(engine);
  engine.authorize = async job =>
    job.proactive ? { allowed: false, reason: 'PROACTIVE_CONTEXT_CHANGED' } : original(job);
  const result = await finalDelivery(engine, engine.query(row.job.deliveryId));
  assert.equal(result.state, 'cancelled');
  assert.equal(result.reason, 'PROACTIVE_CONTEXT_CHANGED');
  assert.deepEqual(f.state.pastes, []);
  assert.deepEqual(f.state.submits, []);
});

test('a withdrawn proactive admission stays cancelled after restarting the desktop', async t => {
  const f = fixture(t);
  const controls = savedReplyControls(f);
  const key = 'wechat:private:' + f.payload.target;
  const parentId = hex('b');
  const proactive = { contextId: hex('c'), expiresAt: Date.now() + 60000 };
  f.config.input.paused = true;
  const pending = await f.engine.sendText({
    ...f.payload,
    parentId,
    rosterGrant: 'legacy',
    proactive,
    inputDeadlineAt: proactive.expiresAt,
  });
  assert.equal(pending.inputStarted, false);
  controls.withdrawInputs(key, 'legacy', [parentId]);
  await f.restart();
  f.config.input.paused = false;
  const result = await finalDelivery(f.engine, f.engine.query(f.payload.deliveryId, true));
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(f.state.pastes, []);
  assert.deepEqual(f.state.submits, []);
});

test('renaming a peer or removing the original staged file cannot break an idempotent retry', async t => {
  const f = fixture(t);
  const file = path.join(f.root, 'document.txt');
  fs.writeFileSync(file, 'fixture');
  const payload = {
    ...f.payload,
    path: file,
    expectedSha256: crypto.createHash('sha256').update('fixture').digest('hex'),
  };
  assert.equal((await finalDelivery(f.engine, f.engine.sendFile(payload))).confirmed, true);
  fs.unlinkSync(file);
  f.engine.resolveTarget = async () => {
    throw Error('The saved result must not need contact discovery');
  };
  assert.equal((await f.engine.sendFile(payload)).confirmed, true);
  await assert.rejects(
    f.engine.sendFile({ ...payload, expectedSha256: 'c'.repeat(64) }),
    /DESKTOP_DELIVERY_ID_CONFLICT/,
  );
  assert.equal(f.state.submits.length, 1);
});

test('ordinary files keep their full Unicode filename through admission and staging', async t => {
  const f = fixture(t);
  const file = path.join(f.root, 'source.staged');
  fs.writeFileSync(file, 'fixture');
  for (const count of [110, 125]) {
    const fileName = '\u{1F4C1}'.repeat(count) + '.pdf';
    f.state.expectedFileName = fileName;
    const payload = { ...f.payload, deliveryId: 'unicode-file-' + count, path: file, fileName };
    const result = await finalDelivery(f.engine, f.engine.sendFile(payload));
    assert.equal(result.confirmed, true, result.reason);
    assert.equal(path.basename(f.state.pastes.at(-1)), fileName);
    assert.equal(f.state.fileBodyAtPaste, 'fixture');
  }
  assert.equal(f.state.submits.length, 2);
});

test('a late receipt confirms the original text after restart without another input', async t => {
  const f = fixture(t);
  f.state.missingReceipt = true;
  f.config.input.operationTimeoutMs = 2500;
  assert.equal((await f.engine.sendText(f.payload)).state, 'unconfirmed');
  await f.restart();
  f.state.missingReceipt = false;
  const result = await f.engine.query(f.payload.deliveryId, true);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.recovery, undefined);
  assert.equal(f.state.submits.length, 1);
});
test('unstarted queued text follows the current UIA paste policy', async t => {
  const f = fixture(t);
  f.config.input.paused = true;
  f.config.input.typeText = true;
  await f.engine.sendText(f.payload);
  await f.restart();
  f.config.input.controlMode = 'uia';
  f.config.input.paused = false;
  await finalDelivery(f.engine, f.engine.query(f.payload.deliveryId));
  assert.deepEqual(f.state.pastes, ['hello']);
});

test('DSH disconnect withdraws a desktop admission that has not started typing', async t => {
  const f = fixture(t);
  f.state.observedIdle = 0;
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: f.payload.target, rosterGrant: 'g' };
  const key = 'wechat:private:' + f.payload.target,
    id = '9'.repeat(64);
  const result = await f.engine.sendText({ ...f.payload, rosterGrant: 'g', parentId: id });
  assert.equal(result.inputStarted, false);
  const item = { message: { readerGrant: 'g' }, parts: [{ state: 'submitted', deliveryId: id, text: f.payload.text }] };
  SocialEngine.prototype.suspendConnection.call({
    timers: new Map(),
    dirty: new Set(),
    pendingDirect: new Set(),
    decisions: new Map(),
    buffer: { pendingReplies: new Map([[key, item]]), rememberReply() {} },
    replay() {},
    inspectReceipt() {},
    deliveryControls: new ReplyDeliveryControls(f.root, scope.accountRef),
  });
  f.state.observedIdle = 99999;
  f.engine.kick();
  await until(() => f.engine.listDeliveries(scope)[0]?.state === 'cancelled');
  assert.deepEqual(f.state.pastes, []);
  assert.deepEqual(f.state.submits, []);
});

test('a group wake change retires admitted natural replies across restart and preserves mentioned replies', async t => {
  const f = fixture(t, { targetWxid: '12345@chatroom' });
  const key = 'wechat:group:' + f.payload.target;
  const file = path.join(f.root, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let wechat = { wake_mode: 'hybrid', whitelist: { private: [], groups: [f.payload.target] } };
  const mode = nextMode => {
    const next = { ...wechat, wake_mode: nextMode };
    reconcileGroupWakeEpochs(wechat, next);
    wechat = next;
    fs.writeFileSync(file, JSON.stringify({ wechat }));
  };
  mode('hybrid');
  const controls = new ReplyDeliveryControls(f.root, f.account.accountRef);
  const natural = { ...f.payload, kind: 'group', parentId: hex('e'), rosterGrant: 'legacy' };
  const direct = { ...natural, text: 'a direct mention', parentId: hex('f'), deliveryId: hex('d') };
  controls.requireNaturalReply(key, natural.rosterGrant, [natural.parentId], naturalGroupWakeEpoch(wechat, key));
  f.config.input.paused = true;
  assert.equal((await f.engine.sendText(natural)).inputStarted, false);
  assert.equal((await f.engine.sendText(direct)).inputStarted, false);
  await f.restart();
  mode('mention');
  mode('hybrid');
  f.config.input.paused = false;
  assert.equal((await finalDelivery(f.engine, f.engine.query(direct.deliveryId))).state, 'confirmed');
  assert.equal((await f.engine.query(natural.deliveryId, true)).state, 'cancelled');
  assert.deepEqual(f.state.pastes, [direct.text]);
});

function savedReplyControls(f) {
  const accountFile = path.join(f.root, 'state/weflow/active-account.json');
  const configFile = path.join(f.root, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(accountFile), { recursive: true });
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(accountFile, JSON.stringify({ id: f.account.accountRef }));
  fs.writeFileSync(configFile, JSON.stringify({ wechat: { whitelist: { private: [f.payload.target], groups: [] } } }));
  return new ReplyDeliveryControls(f.root, f.account.accountRef);
}

test('a saved foreground refusal ends the untouched automatic reply and releases later input', async t => {
  const f = fixture(t),
    controls = savedReplyControls(f),
    key = 'wechat:private:' + f.payload.target,
    parentId = hex('f');
  f.state.refusePrepareText = f.payload.text;
  const paused = await f.engine.sendText({ ...f.payload, parentId, rosterGrant: 'legacy' });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.inputStarted, false);
  assert.equal(paused.reason, 'QT_UIA_CAPTION_OBSCURED');
  assert.deepEqual(f.state.pastes, []);

  controls.register(key, 'legacy', [{ deliveryId: parentId, text: f.payload.text, state: 'queued' }]);
  assert.equal(controls.claim(key, 'legacy', parentId), 'send');
  await f.restart();
  const stopped = await finalDelivery(f.engine, f.engine.query(f.payload.deliveryId));
  assert.equal(stopped.state, 'cancelled');
  assert.equal(stopped.reason, 'QT_UIA_CAPTION_OBSCURED');
  assert.equal(stopped.submission, 'not-started');
  assert.equal(stopped.inputStarted, false);
  const next = await finalDelivery(
    f.engine,
    f.engine.sendText({ ...f.payload, deliveryId: 'new-reply', text: 'next' }),
  );
  assert.equal(next.state, 'confirmed');
  assert.deepEqual(f.state.pastes, ['next']);
});

test('stop split withdraws a text segment already queued in the paused desktop', async t => {
  const f = fixture(t);
  const controls = savedReplyControls(f);
  const buffer = new MessageBuffer(path.join(f.root, 'buffer.json'));
  const key = 'wechat:private:' + f.payload.target;
  const notices = [];
  const admissions = [];
  const observed = [];
  f.config.input.paused = true;
  const social = new SocialEngine({
    buffer,
    deliveryControls: controls,
    batchMs: 1,
    privateMinIntervalMs: 0,
    maxTextPartsFor: () => 2,
    stickerPolicyFor: () => ({ enabled: false }),
    deliveryRetry: { receiptDelayMs: 10 },
    decide: async () => 'RESPOND: first fragment\n\nsecond fragment',
    send: async (_target, text, { deliveryId, receiptOnly }) => {
      if (text.startsWith('已停止本次回复')) {
        notices.push(text);
        return {};
      }
      assert.equal(receiptOnly, false);
      const result = await f.engine.sendText({ ...f.payload, text, parentId: deliveryId, deliveryId });
      assert.equal(result.inputStarted, false);
      admissions.push(deliveryId);
      return { pending: true };
    },
    inspectReceipt: async (_target, part) => {
      observed.push(part.deliveryId);
      const job = await f.engine.query(part.deliveryId, true);
      return { status: job.state === 'cancelled' ? 'cancelled' : 'pending' };
    },
  });
  t.after(() => social.stop());
  const message = {
    platform: 'wechat',
    kind: 'private',
    conversation_id: f.payload.target,
    self_id: f.account.accountWxid,
    sender_id: f.payload.target,
    timestamp: Date.now() / 1000,
    message_id: 'stop-fixture-input',
    text: 'fixture prompt',
  };
  social.receive(message);
  await until(() => buffer.pendingReplies.get(key)?.parts[0]?.state === 'submitted');
  social.receive({ ...message, message_id: 'stop-fixture-command', text: '停止分段' });
  assert.equal(controls.inputWithdrawn(key, 'legacy', admissions[0]), true);
  f.config.input.paused = false;
  f.engine.kick();
  await until(() => notices.length === 1 && buffer.pendingReplies.size === 0 && buffer.replyReceipts.size === 0);
  assert.equal((await f.engine.query(admissions[0], true)).state, 'cancelled');
  assert.equal(admissions.length, 1);
  assert.ok(observed.length && observed.every(id => id === admissions[0]));
  assert.deepEqual(f.state.pastes, []);
  assert.deepEqual(f.state.submits, []);
});

test('DSH disconnect withdraws queued desktop media and keeps its receipt lookup read-only', async t => {
  const f = fixture(t);
  const controls = savedReplyControls(f);
  const buffer = new MessageBuffer(path.join(f.root, 'buffer.json'));
  const key = 'wechat:private:' + f.payload.target;
  const id = hex('c');
  const file = path.join(f.root, 'fixture.gif');
  fs.writeFileSync(file, Buffer.from('R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  f.config.input.paused = true;
  const media = new MediaOutbox({
    buffer,
    deliveryControls: controls,
    policy: async () => ({ enabled: true }),
    quota: Date.now,
    noteOutgoing() {},
    log() {},
    retry: { mediaDeadlineMs: 30000, mediaCallTimeoutMs: 3000, receiptDelayMs: 10 },
    send: async (_message, _sticker, options) => {
      if (options.abandon) return {};
      assert.equal(options.receiptOnly, undefined);
      const result = await f.engine.sendImage({
        ...f.payload,
        text: undefined,
        operation: 'sticker',
        deliveryId: id,
        parentId: id,
        path: file,
        inputDeadlineAt: options.deadlineAt,
      });
      assert.equal(result.inputStarted, false);
      return { pending: true };
    },
    inspectReceipt: async (_message, part) => {
      const result = await f.engine.query(part.deliveryId, true);
      if (result.state === 'cancelled')
        throw Object.assign(Error('cancelled'), { code: 'NATIVE_SEND_REJECTED', data: { attempted: false } });
      return { status: 'pending' };
    },
  });
  t.after(() => media.stop());
  media.enqueue(
    key,
    { message: { platform: 'wechat', kind: 'private', conversation_id: f.payload.target } },
    { deliveryId: id, stickerId: hex('d'), state: 'queued' },
  );
  await media.run(key);
  assert.equal(buffer.mediaReplies.get(id).part.state, 'submitted');
  media.cancelOffline();
  assert.equal(controls.inputWithdrawn(key, 'legacy', id), true);
  f.config.input.paused = false;
  f.engine.kick();
  await until(() => buffer.mediaReplies.size === 0);
  assert.equal((await f.engine.query(id, true)).state, 'cancelled');
  assert.deepEqual(f.state.pastes, []);
  assert.deepEqual(f.state.submits, []);
});

test('global pause still confirms submitted text and stopped queue uses the same scoped preview', async t => {
  const f = fixture(t);
  f.state.missingReceipt = true;
  const args = { ...f.payload, rosterGrant: 'g' };
  assert.equal((await f.engine.sendText(args)).state, 'submitted');
  f.config.input.paused = true;
  f.state.missingReceipt = false;
  f.engine.kick();
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: f.payload.target, rosterGrant: 'g' };
  await until(() => f.engine.listDeliveries(scope)[0]?.confirmed);
  await f.engine.close();
  const key = 'wechat:private:' + args.target;
  const [job] = savedChatDeliveries(f.root, scope.accountRef, key, 'g');
  assert.equal(job.preview, args.text);
  assert.equal(job.state, 'confirmed');
  assert.equal(job.canCancel, false);
  assert.deepEqual(savedChatDeliveries(f.root, scope.accountRef, key, 'other-grant'), []);
  assert.equal(f.state.submits.length, 1);
});

test('missing voice calibration gives the bridge a definitive pre-input text fallback', async t => {
  const f = fixture(t);
  f.state.preflightReason = 'UI_QT_VOICE_CALIBRATION_REQUIRED';
  const voice = new VoiceSend({
    directory: f.root,
    account: f.account.account,
    accountRef: f.account.accountRef,
    ownWxid: f.account.accountWxid,
    receiptAccount: () => f.account,
    project: { wechat: { whitelist: { groups: [], private: [f.payload.target] } } },
    status: { confirmed_sends: 0 },
    reload() {},
    allowed: () => true,
    checkNative: async () => ({
      ...f.account,
      voiceSend: true,
      voiceTransport: 'desktop',
      recordingAccount: f.account.accountWxid,
    }),
    lookupTarget: async () => {},
    desktopSender: f.engine,
    dispatchDesktop: (operation, payload, account, options) =>
      f.engine.send(operation, { ...payload, account }, options),
  });
  t.after(() => voice.close());
  const plugin = { id: 'speech-fixture', generation: hex('a') };
  voice.synthesis.selected = () => plugin;
  voice.synthesis.candidates = () => [plugin];
  voice.synthesis.generate = async () => ({ wav: pcmWav(Buffer.alloc(32000)), allowed: () => true });
  const request = { kind: 'private', target: f.payload.target, text: 'fixture text', deliveryId: hex('a') };
  assert.equal(voice.speakReply(request).status, 'pending');
  let rejected;
  await until(() => {
    voice.tickReplies();
    rejected = voice.speakReply({ ...request, receiptOnly: true });
    return rejected.status !== 'pending';
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.error, f.state.preflightReason);
  assert.equal(rejected.fallback, true);
  assert.equal((await voice.speakReply({ ...request, receiptOnly: true })).fallback, true);
  assert.equal(f.state.segments.length, 0);
  assert.equal(f.state.voicePreflights, 1);
  assert.equal((await finalDelivery(f.engine, f.engine.sendText(f.payload))).confirmed, true);
});

test('a preflight wait keeps its deadline across restart and releases the next reply', async t => {
  let elapsed = 0;
  const f = fixture(t, { now: () => Date.now() + elapsed });
  f.state.preflightReason = 'QT_ACTIVITY_WARMUP';
  const request = { ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') };
  const pending = await f.engine.sendVoice(request);
  assert.equal(pending.pending, true);
  assert.equal(pending.reason, f.state.preflightReason);
  await f.restart();
  elapsed = 31000;
  const expired = await finalDelivery(f.engine, f.engine.sendVoice(request));
  assert.equal(expired.state, 'cancelled');
  assert.equal(expired.reason, 'DESKTOP_VOICE_PREFLIGHT_TIMEOUT');
  assert.equal(expired.submission, 'not-started');
  assert.equal(expired.inputStarted, false);
  assert.equal(f.state.segments.length, 0);
  assert.equal(
    (await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, deliveryId: 'after-voice-wait' }))).confirmed,
    true,
  );
});

test('operators can pause, resume and cancel the unsent tail of a voice between bubbles', async t => {
  const f = fixture(t),
    create = f.engine.driverFactory;
  f.engine.driverFactory = async options => {
    const driver = await create(options);
    const prepare = driver.prepareVoiceHandoff;
    driver.prepareVoiceHandoff = async (...args) =>
      f.state.segments.length ? { ready: false, reason: 'QT_ACTIVITY_WARMUP' } : prepare(...args);
    return driver;
  };
  const payload = { ...f.payload, rosterGrant: 'g', pcmBase64: Buffer.alloc(32000 * 13).toString('base64') };
  await f.engine.sendVoice(payload);
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: f.payload.target, rosterGrant: 'g' };
  const current = () => f.engine.listDeliveries(scope)[0];
  const control = action => f.engine.control({ ...scope, id: current().id, revision: current().revision, action });
  assert.deepEqual(
    current().segments.map(part => part.state),
    ['confirmed', 'prepared'],
  );
  assert.equal(current().canPause, true);
  await control('pause');
  assert.equal(current().canResume, true);
  await control('resume');
  await control('cancel');
  assert.deepEqual(
    current().segments.map(part => part.state),
    ['confirmed', 'cancelled'],
  );
  assert.equal(current().confirmed, false);
  await f.restart();
  const replay = await f.engine.sendVoice(payload);
  assert.equal(replay.state, 'cancelled');
  assert.equal(f.state.segments.length, 1);
});

test('a pre-admission target error is definitive and leaves no native job to poll', async t => {
  const f = fixture(t);
  let resolutions = 0;
  f.engine.resolveTarget = async () => {
    resolutions++;
    throw Error('DESKTOP_TARGET_AMBIGUOUS');
  };
  const adapter = {
    targetsSending: new Set(),
    delivery: {},
    status: {},
    reload() {},
    allowed: () => true,
    project: { wechat: {} },
    accountRef: f.account.accountRef,
    textDeliveries: new TextDeliveryStore(path.join(f.root, 'state/text-deliveries')),
    checkNative: async () => ({ account: f.account.account }),
    receiptAccount: () => ({ account: f.account.account, accountRef: f.account.accountRef }),
    dispatchDesktop: (op, payload) => f.engine.request(op, payload),
    desktopSender: f.engine,
  };
  for (const receiptOnly of [false, true]) {
    await assert.rejects(
      deliverDesktopMessage(adapter, { ...f.payload, receiptOnly }, async () => ({
        operation: 'text',
        body: { text: f.payload.text },
      })),
      e =>
        e.message === 'NATIVE_SEND_REJECTED' &&
        e.data?.attempted === false &&
        e.data.reason === 'DESKTOP_TARGET_AMBIGUOUS',
    );
  }
  assert.equal(resolutions, 1);
  assert.equal(await f.engine.lookup({ ...f.payload, accountRef: f.account.accountRef }), null);
});

test('reader timeouts before admission leave the same delivery resumable', async t => {
  const f = fixture(t);
  const resolve = f.engine.resolveTarget;
  let resolutions = 0;
  f.engine.resolveTarget = (kind, target) => {
    if (++resolutions === 1) throw new DOMException('temporary reader timeout', 'TimeoutError');
    return resolve(kind, target);
  };
  const adapter = {
    targetsSending: new Set(),
    delivery: {},
    status: { confirmed_sends: 0 },
    reload() {},
    allowed: () => true,
    project: { wechat: {} },
    accountRef: f.account.accountRef,
    textDeliveries: new TextDeliveryStore(path.join(f.root, 'state/text-deliveries')),
    checkNative: async () => ({ account: f.account.account }),
    receiptAccount: () => ({ account: f.account.account, accountRef: f.account.accountRef }),
    dispatchDesktop: (op, payload) => f.engine.request(op, payload),
    desktopSender: f.engine,
  };
  const send = (receiptOnly = false) =>
    deliverDesktopMessage(adapter, { ...f.payload, receiptOnly }, async () => ({
      operation: 'text',
      body: { text: f.payload.text },
    }));
  assert.equal((await send()).pending, true);
  const key = adapter.textDeliveries.key('private', f.payload.target, f.payload.deliveryId, '');
  assert.equal(adapter.textDeliveries.get(key).state, 'dispatching');
  assert.equal(f.state.submits.length, 0);

  let result;
  for (let i = 0; i < 100; i++) {
    result = await send(true);
    if (!result.pending) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.delivered, 'database-confirmed');
  assert.equal(f.state.submits.length, 1);
  assert.equal((await send(true)).reused, true);
});

for (const operation of ['text', 'image', 'sticker']) {
  test('OneBot reports a full native queue as busy and retries the original delivery, ' + operation, async t => {
    const f = fixture(t);
    const { store, driver } = await f.engine.context(f.payload);
    for (let index = 0; index < MAX_ACTIVE_DELIVERIES; index++)
      store.activeIds.add(index.toString(16).padStart(64, '0'));
    const media = operation !== 'text';
    const source = path.join(f.root, operation === 'sticker' ? 'capacity.gif' : 'capacity.png');
    if (media) {
      fs.writeFileSync(
        source,
        Buffer.from(
          operation === 'sticker'
            ? 'R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
            : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
          'base64',
        ),
      );
      driver.pasteImage = async job => {
        f.state.pastes.push(job.image.path);
        return { performed: true, attempted: true };
      };
    }
    const adapter = {
      targetsSending: new Set(),
      status: { confirmed_sends: 0 },
      reload() {},
      allowed: () => true,
      project: { wechat: {} },
      accountRef: f.account.accountRef,
      textDeliveries: new TextDeliveryStore(path.join(f.root, 'state/text-deliveries')),
      checkNative: async () => ({ account: f.account.account }),
      receiptAccount: () => f.account,
      dispatchDesktop: (op, payload, _account, options) => f.engine.request(op, payload, options),
      desktopSender: f.engine,
    };
    const send = (receiptOnly = false) =>
      deliverDesktopMessage(adapter, { ...f.payload, receiptOnly, media }, async () => ({
        operation,
        body: media ? { path: source } : { text: f.payload.text },
      }));
    for (const receiptOnly of [false, true])
      await assert.rejects(send(receiptOnly), {
        message: 'SENDER_BUSY',
        data: { attempted: false, reason: 'DESKTOP_STORAGE_LIMIT' },
      });
    assert.deepEqual(f.state.submits, []);
    store.activeIds.delete('0'.repeat(64));
    let result = await send();
    for (let index = 0; index < 100 && result.pending; index++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      result = await send(true);
    }
    assert.equal(result.delivered, 'database-confirmed');
    assert.equal(f.state.submits.length, 1);
  });
}

test('a held OneBot image leaves another chat free to queue and confirm a reply', async t => {
  const other = 'wxid_other';
  const f = fixture(t, { additionalTargets: [other] });
  const held = { accountRef: f.account.accountRef, kind: 'private', target: f.payload.target, rosterGrant: 'legacy' };
  f.config.input.operationTimeoutMs = 30000;
  f.config.wechat = { whitelist: { private: [held.target, other], groups: [] } };
  for (const [relative, value] of [
    ['config/wechatagent.json', f.config],
    ['state/weflow/active-account.json', { id: held.accountRef }],
    ['state/wechat-io-config.json', {}],
  ]) {
    const file = path.join(f.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }
  new ReplyDeliveryControls(f.root, held.accountRef).control({
    key: 'wechat:private:' + held.target,
    grant: held.rosterGrant,
    operation: 'pause',
    revision: 0,
  });
  const media = path.join(f.root, 'media');
  fs.mkdirSync(media);
  fs.writeFileSync(
    path.join(media, 'picture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const catalog = new ReplyMediaCatalog({ root: f.root });
  catalog.importDirectory({ directory: media, expectedRevision: catalog.snapshot().revision });
  const desktopSender = new DesktopSender(f.root);
  desktopSender.loading = Promise.resolve(f.engine);
  const adapter = new WechatOneBot({ directory: f.root, desktopSender });
  adapter.account = f.account.account;
  adapter.accountRef = held.accountRef;
  adapter.ownWxid = f.account.accountWxid;
  adapter.checkNative = async () => ({ account: adapter.account });
  Object.assign(adapter.status, { version: DESKTOP_WECHAT_VERSION, native_sticker_send: true });
  const imageRequest = {
    action: 'send_private_msg',
    params: {
      user_id: held.target,
      message: [{ type: 'wechat_sticker', data: { id: catalog.list()[0].id } }],
      wechatagent_delivery_id: hex('a'),
    },
  };
  let imageAdmission;
  const image = adapter.action(imageRequest).then(result => {
    imageAdmission = result;
  });
  await until(() => f.engine.listDeliveries(held).length === 1);
  const message = [{ type: 'text', data: { text: 'other chat' } }];
  const text = await adapter.action({
    action: 'send_private_msg',
    params: { user_id: other, message, wechatagent_delivery_id: hex('b') },
  });
  assert.equal(text.status, 'ok', text.message);
  assert.equal(text.data.pending, true);
  assert.equal(imageAdmission?.data.pending, true, 'image admission completed while its chat was held');
  await image;
  assert.equal((await adapter.action(imageRequest)).data.pending, true);
  assert.equal(f.engine.listDeliveries(held).length, 1);
  assert.equal(f.engine.listDeliveries(held)[0].state, 'paused');

  const query = {
    action: 'get_text_delivery',
    params: { kind: 'private', target: other, message, wechatagent_delivery_id: hex('b') },
  };
  await until(async () => (await adapter.action(query)).data.receipt === 'wechat-server-id');
  assert.equal((await adapter.action(query)).data.reused, true);
  assert.deepEqual(f.state.pastes, ['other chat']);
  assert.equal(f.state.submits.length, 1);
});

for (const scenario of [
  'image expires',
  'GIF expires',
  'unacknowledged pending',
  'response lost',
  'retained during admission',
]) {
  test('automatic media uses the original admission window and preserves the saved operation, ' + scenario, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fixture(t, { now: () => Date.now() });
    const target = f.payload.target,
      key = 'wechat:private:' + target,
      id = hex('a');
    f.config.input.paused = true;
    f.config.input.operationTimeoutMs = 30000;
    f.config.wechat = { whitelist: { private: [target], groups: [] } };
    const save = (relative, value) => {
      const file = path.join(f.root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    };
    save('config/wechatagent.json', f.config);
    save('state/weflow/active-account.json', { id: f.account.accountRef });
    save('state/wechat-io-config.json', {});
    const directory = path.join(f.root, 'media');
    fs.mkdirSync(directory);
    const gif = scenario === 'GIF expires';
    fs.writeFileSync(
      path.join(directory, gif ? 'picture.gif' : 'picture.png'),
      Buffer.from(
        gif
          ? 'R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
          : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const catalog = new ReplyMediaCatalog({ root: f.root });
    const imported = catalog.importDirectory({ directory, expectedRevision: catalog.snapshot().revision });
    assert.equal(imported.added, 1);
    const desktop = new DesktopSender(f.root);
    desktop.loading = Promise.resolve(f.engine);
    const adapter = new WechatOneBot({ directory: f.root, desktopSender: desktop });
    Object.assign(adapter, {
      account: f.account.account,
      accountRef: f.account.accountRef,
      ownWxid: f.account.accountWxid,
    });
    adapter.checkNative = async () => ({ account: adapter.account });
    Object.assign(adapter.status, { version: DESKTOP_WECHAT_VERSION, native_sticker_send: true });
    const bridge = new WechatOneBotAdapter();
    bridge.server.action = async (action, params) => {
      const response = await adapter.action({ action, params });
      if (response.status !== 'ok')
        throw Object.assign(Error(response.message), { code: response.message, data: response.data });
      if (scenario === 'response lost' && !params.wechatagent_receipt_only && response.data.pending)
        throw Error('fixture lost the admission response');
      return response;
    };
    const buffer = new MessageBuffer(path.join(f.root, 'state/media-deadline-buffer.json'));
    const controls = new ReplyDeliveryControls(f.root, f.account.accountRef);
    const box = new MediaOutbox({
      buffer,
      send: (message, id, options) =>
        bridge.sendSticker({ kind: message.kind, target: message.conversation_id, id, ...options }),
      policy: async () => ({ enabled: true }),
      quota: () => 0,
      noteOutgoing() {},
      log() {},
      deliveryControls: controls,
      retry: { mediaDeadlineMs: 45000, mediaCallTimeoutMs: 1000, maxReceiptChecks: 3, receiptDelayMs: 10 },
    });
    box.wake = () => {};
    t.after(() => box.stop());
    box.enqueue(
      key,
      {
        message: {
          platform: 'wechat',
          kind: 'private',
          conversation_id: target,
          self_id: f.account.accountWxid,
          readerGrant: 'legacy',
        },
      },
      { deliveryId: id, stickerId: imported.items[0].id, state: 'queued' },
    );
    const deadline = buffer.mediaReplies.get(id).expiresAt;
    const scope = { accountRef: f.account.accountRef, kind: 'private', target, rosterGrant: 'legacy' };
    const control = { key, grant: 'legacy' };
    const authorize = f.engine.authorize.bind(f.engine);
    let checked = false;
    f.engine.authorize = async (job, options) => {
      const result = await authorize(job, options);
      if (!checked && ['image', 'sticker'].includes(job.operation)) {
        checked = true;
        if (scenario === 'unacknowledged pending')
          throw Object.assign(Error('temporary admission failure'), { code: 'DESKTOP_CONFIGURATION_BUSY' });
        if (scenario === 'retained during admission') controls.control({ ...control, operation: 'pause', revision: 0 });
        if (scenario !== 'response lost') t.mock.timers.tick(deadline - Date.now());
      }
      return result;
    };

    await box.run(key);
    assert.equal(checked, true);
    if (scenario === 'unacknowledged pending' || scenario === 'response lost') {
      assert.equal(buffer.mediaReplies.get(id).part.desktopPending, undefined);
      assert.equal(f.engine.listDeliveries(scope).length, scenario === 'response lost' ? 1 : 0);
      t.mock.timers.tick(deadline - Date.now() + 1);
      await box.run(key);
    }
    if (scenario === 'retained during admission') {
      assert.equal(f.engine.listDeliveries(scope).length, 0);
      await box.run(key);
      assert.equal(f.engine.listDeliveries(scope).length, 0);
      controls.control({ ...control, operation: 'resume', revision: 1 });
      await box.run(key);
    }

    if (scenario !== 'response lost' && scenario !== 'retained during admission') {
      assert.equal(f.engine.listDeliveries(scope).length, 0);
      assert.equal(f.state.submits.length, 0);
      assert.equal(buffer.mediaReplies.has(id), false);
      assert.equal(controls.list(key).replies.find(row => row.id === id).state, 'expired');
      return;
    }
    assert.equal(f.engine.listDeliveries(scope).length, 1);
    assert.equal(buffer.mediaReplies.get(id).part.desktopPending, true);
    const { driver } = await f.engine.context(f.payload);
    driver.pasteImage = async () => ({ performed: true, attempted: true });
    f.config.input.paused = false;
    save('config/wechatagent.json', f.config);
    f.engine.applyConfiguration();
    await until(async () => f.engine.listDeliveries(scope).some(row => row.confirmed));
    await box.run(key);
    assert.equal(f.state.submits.length, 1);
    assert.equal(buffer.mediaReplies.has(id), false);
    assert.equal(buffer.recent(key).find(row => row.delivery_id === id).delivery_status, 'confirmed');
  });
}

test('OneBot persists a reply during global pause and resumes the same native job', async t => {
  const f = fixture(t);
  selectPluginAccount(f.root, f.account.accountRef);
  Object.assign(f.config, { wechat: { whitelist: { private: [f.payload.target], groups: [] } } });
  f.config.input.paused = true;
  const configFile = path.join(f.root, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(configFile));
  fs.writeFileSync(configFile, JSON.stringify(f.config));
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    directory: f.root,
    targetsSending: new Set(),
    activeActions: 0,
    delivery: {},
    status: { paused: true },
    reload() {},
    project: f.config,
    ownWxid: f.account.accountWxid,
    account: f.account.account,
    accountRef: f.account.accountRef,
    textDeliveries: new TextDeliveryStore(path.join(f.root, 'state/text-deliveries')),
    checkNative: async () => ({ account: f.account.account }),
    desktopSender: f.engine,
  });
  f.engine.authorizeCurrent = (job, forInput) => adapter.authorizeDesktopCurrent(job, forInput);
  f.engine.authorize = (job, options) => adapter.authorizeDesktop(job, options);
  const message = [{ type: 'text', data: { text: f.payload.text } }];
  const { data: sent } = await adapter.action({
    action: 'send_private_msg',
    params: { user_id: f.payload.target, message },
  });
  assert.equal(sent.pending, true);
  const deliveryId = sent.delivery_id;
  assert.match(deliveryId, /^[a-f0-9]{64}$/u);
  const attempt = adapter.textDeliveries.get(adapter.textDeliveries.key('private', f.payload.target, deliveryId, ''));
  assert.equal(attempt.state, 'accepted');
  assert.deepEqual(f.state.pastes, []);
  f.config.input.paused = false;
  fs.writeFileSync(configFile, JSON.stringify(f.config));
  f.engine.applyConfiguration();
  for (let i = 0; i < 100 && !f.state.submits.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  let receipt;
  for (let i = 0; i < 100; i++) {
    receipt = await adapter.action({
      action: 'get_text_delivery',
      params: { kind: 'private', target: f.payload.target, message, wechatagent_delivery_id: deliveryId },
    });
    assert.equal(receipt.status, 'ok');
    if (!receipt.data.pending) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(receipt.data.receipt, 'wechat-server-id');
  assert.equal(f.state.submits.length, 1);
});

test('revoking the original roster grant still permits the submitted reply receipt', async t => {
  const f = fixture(t);
  const chat = 'wechat:private:' + f.payload.target;
  Object.assign(f.config, {
    wechat: { whitelist: { private: [f.payload.target], groups: [] }, rosterGrants: { [chat]: 'g' } },
  });
  f.state.missingReceipt = true;
  const configFile = path.join(f.root, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(configFile));
  const save = () => fs.writeFileSync(configFile, JSON.stringify(f.config));
  save();
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    directory: f.root,
    targetsSending: new Set(),
    activeActions: 0,
    delivery: {},
    status: { confirmed_sends: 0, failed_sends: 0 },
    reload() {},
    project: f.config,
    ownWxid: f.account.accountWxid,
    account: f.account.account,
    accountRef: f.account.accountRef,
    textDeliveries: new TextDeliveryStore(path.join(f.root, 'state/text-deliveries')),
    checkNative: async () => ({ account: f.account.account }),
    desktopSender: f.engine,
  });
  f.engine.authorizeCurrent = (job, forInput) => adapter.authorizeDesktopCurrent(job, forInput);
  f.engine.authorize = (job, options) => adapter.authorizeDesktop(job, options);
  const message = [{ type: 'text', data: { text: f.payload.text } }];
  const deliveryId = hex('f');
  const input = {
    action: 'send_private_msg',
    params: { user_id: f.payload.target, message, wechatagent_delivery_id: deliveryId },
  };
  const first = await adapter.action(input);
  assert.equal(first.status, 'ok');
  assert.equal(first.data.pending, true);
  const scope = { accountRef: f.account.accountRef, kind: 'private', target: f.payload.target, rosterGrant: 'g' };
  await until(() => f.engine.listDeliveries(scope)[0]?.state === 'submitted');
  assert.equal(f.state.submits.length, 1);

  const activeAccountFile = path.join(f.root, 'state/weflow/active-account.json');
  fs.mkdirSync(path.dirname(activeAccountFile), { recursive: true });
  fs.writeFileSync(activeAccountFile, JSON.stringify({ id: f.account.accountRef }));
  f.config.wechat.whitelist.private = [];
  delete f.config.wechat.rosterGrants[chat];
  save();
  adapter.checkNative = async () => assert.fail('receipt lookup must not probe the desktop');
  f.engine.probeAccount = async () => assert.fail('receipt lookup must not bind a desktop context');
  const query = {
    action: 'get_text_delivery',
    params: {
      kind: 'private',
      target: f.payload.target,
      message,
      wechatagent_delivery_id: deliveryId,
      wechatagent_roster_grant: 'g',
    },
  };
  assert.equal((await adapter.action(input)).message, 'CONVERSATION_NOT_ALLOWED');
  assert.equal(
    (await adapter.action({ ...query, params: { ...query.params, wechatagent_roster_grant: 'other' } })).message,
    'CONVERSATION_GRANT_CHANGED',
  );

  f.state.missingReceipt = false;
  const receipt = await adapter.action(query);
  assert.equal(receipt.data.receipt, 'wechat-server-id');
  f.config.wechat.whitelist.private = [f.payload.target];
  f.config.wechat.rosterGrants[chat] = 'new';
  save();
  assert.equal((await adapter.action(query)).data.reused, true);
  fs.writeFileSync(activeAccountFile, JSON.stringify({ id: hex('d') }));
  assert.equal((await adapter.action(query)).message, 'DESKTOP_ACCOUNT_CHANGED');
  assert.equal(f.state.submits.length, 1);
});

test('plain text quotes are rechecked before taking over the editor', async () => {
  const quote = { id: hex('a'), sender: 'fixture-peer', serverId: '512', timestamp: 1700000000, text: 'same text' };
  const job = { target: 'fixture-peer', quote };
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    authorizeDesktopCurrent: () => true,
    quoteSource: async (target, id) => {
      assert.equal(target, job.target);
      assert.equal(id, quote.id);
      return { ...quote };
    },
  });
  assert.equal((await adapter.authorizeDesktop(job, { preparing: true })).allowed, true);
  adapter.quoteSource = async () => {
    throw Error('QUOTE_SOURCE_AMBIGUOUS');
  };
  await assert.rejects(adapter.authorizeDesktop(job, { preparing: true }), {
    message: 'INPUT_QUOTE_SOURCE_UNVERIFIED',
  });
});

test('rich quotes keep the original server identity and use refreshed UI neighbors', async t => {
  const f = fixture(t);
  const serverId = '512';
  const quote = {
    id: crypto
      .createHash('sha256')
      .update(f.payload.target + '\0' + serverId)
      .digest('hex'),
    sender: 'fixture-peer',
    serverId,
    timestamp: 1700000000,
    text: '[图片]',
    kind: 'image',
    locator: { index: 0, rows: [{ kind: 'image' }] },
  };
  const fresh = { ...quote, locator: { index: 1, rows: [{ kind: 'text', text: 'anchor' }, { kind: 'image' }] } };
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    authorizeDesktopCurrent: () => true,
    quoteSource: async () => fresh,
  });
  const job = { target: f.payload.target, quote };
  f.state.refreshedQuote = (await adapter.authorizeDesktop(job, { preparing: true })).quote;
  assert.equal((await finalDelivery(f.engine, f.engine.sendText({ ...f.payload, quote }))).confirmed, true);
  assert.deepEqual(f.state.prepared.quote, fresh);
  assert.deepEqual(f.state.callbacks.find(item => item.options.phase === 'prepare').job.quote, quote);
  adapter.quoteSource = async () => ({ ...fresh, serverId: '513' });
  await assert.rejects(adapter.authorizeDesktop(job, { preparing: true }), /INPUT_QUOTE_SOURCE_UNVERIFIED/);
  adapter.quoteSource = async () => null;
  await assert.rejects(adapter.authorizeDesktop(job, { preparing: true }), /INPUT_QUOTE_SOURCE_UNVERIFIED/);
});

test('the quote source request allows the Reader cold-lookup budget', async () => {
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    api: { reader_base_url: 'http://127.0.0.1:1', reader_token: 'fixture' },
    fetch: async (_url, { signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 4200);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return Response.json({ quote: { serverId: '512' } });
    },
  });
  assert.deepEqual(await adapter.quoteSource('fixture-peer', hex('a')), { serverId: '512' });
});

test('a connected sender can list saved jobs before its native context opens', async t => {
  const f = fixture(t);
  f.config.input.paused = true;
  const scope = { ...f.payload, accountRef: f.account.accountRef, rosterGrant: 'current' };
  assert.equal((await f.engine.sendText(scope)).admitted, true);
  await f.restart();
  const probe = t.mock.method(f.engine, 'probeAccount', async () => assert.fail('a list must not probe the desktop'));
  const { jobs } = await f.engine.request('control', { ...scope, action: 'list' });
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.deliveryId, scope.deliveryId);
  assert.equal(job.canPause, false);
  assert.equal(job.canResume, false);
  assert.equal(job.canCancel, false);
  assert.equal(probe.mock.callCount(), 0);
  assert.deepEqual(f.engine.listDeliveries({ ...scope, rosterGrant: 'other-grant' }), []);
  assert.deepEqual(f.engine.listDeliveries({ ...scope, accountRef: hex('c') }), []);
  probe.mock.restore();
  await f.engine.context(scope);
  assert.equal(f.engine.listDeliveries(scope)[0].canCancel, true);
  assert.deepEqual(f.state.submits, []);
});

test('stopped desktop queue can pause, resume and cancel an untouched delivery under the engine lease', async t => {
  const f = fixture(t);
  f.config.input.paused = true;
  const args = { ...f.payload, rosterGrant: 'fixture-grant' };
  const admitted = await f.engine.sendText(args);
  await f.engine.close();
  const scope = { account: f.account.accountRef, key: 'wechat:private:' + args.target, grant: args.rosterGrant };
  const saved = () => savedChatDeliveries(f.root, scope.account, scope.key, scope.grant)[0];
  const control = (operation, revision = saved().revision) =>
    controlSavedChatDelivery(f.root, { ...scope, id: saved().id, operation, revision });
  const lease = acquireDesktopQueue(f.root);
  try {
    assert.throws(() => control('pause'), { code: 'DESKTOP_CONTROL_CHANGED' });
  } finally {
    lease.release();
  }
  const queued = saved();
  assert.equal(queued.canCancel, true);
  assert.equal(control('pause').state, 'paused');
  assert.throws(() => control('resume', queued.revision), { code: 'DESKTOP_CONTROL_CHANGED' });
  assert.equal(control('resume').state, 'waiting');
  assert.equal(control('cancel').state, 'cancelled');
  assert.equal(saved().canCancel, false);
  assert.equal(admitted.admitted, true);
  assert.deepEqual(f.state.submits, []);
});
