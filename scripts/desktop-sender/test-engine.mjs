import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopSenderEngine } from './engine.mjs';
import { recoverOperation, snapshotOperations } from './operations.mjs';
import { voiceInterruptionEvidence, voiceRecordingCancellationEvidence } from './voice-interruption-evidence.mjs';
import crypto from 'node:crypto';
import { beginQuoteDraft, readQuoteDraft } from './quote-draft-state.mjs';
import { DesktopSender } from '../desktop-sender.mjs';
import { DESKTOP_WECHAT_VERSION } from '../desktop-settings.mjs';
import { deliverDesktopMessage } from '../desktop-message-delivery.mjs';
import { ReplyMediaCatalog } from '../reply-media-catalog.mjs';
import { TextDeliveryStore } from '../text-delivery-store.mjs';
import { WechatOneBot } from '../wechat-onebot.mjs';
import { acquireDesktopQueue } from './delivery-lock.mjs';
import { controlSavedChatDelivery, savedChatDeliveries } from './delivery-list.mjs';
import { SocialEngine } from '../../components/qq-bridge/src/core/social-engine.js';
import { ReplyDeliveryControls } from '../../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';

const hex = letter => letter.repeat(64);
function fixture(
  t,
  { unknownVoice = false, submitThrows = false, targetWxid = 'wxid_friend', additionalTargets = [] } = {},
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
    if (state.missingReceipt) return { confirmed: false };
    return {
      confirmed: true,
      receipt: {
        localType: job.operation === 'image' ? 3 : job.operation === 'sticker' ? 47 : 1,
        ...(['image', 'sticker'].includes(job.operation)
          ? {
              nativeImageRowConfirmed: true,
              imageContentVerified: false,
              sourceMd5Matched: true,
              sourceImageMd5: job.md5,
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
    probeAccount: async () => account,
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
          if (state.preflightWaits > 0) {
            state.preflightWaits--;
            return { ready: false, reason: 'QT_ACTIVITY_WARMUP' };
          }
          return { ready: true };
        },
        prepare: async job => {
          await factory.resolveTarget(job);
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
          return { performed: true, attempted: true };
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
  assert.equal(fs.existsSync(f.state.pastes[0]), false);
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
});
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
  assert.equal((await finalDelivery(f.engine, f.engine.sendVoice(voice))).confirmed, true);
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
  const request = { ...f.payload, quote };
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

test('global pause admits voice without preflight and resumes that logical job', async t => {
  const f = fixture(t);
  f.config.input.paused = true;
  assert.equal((await f.engine.health()).voiceSend, true);
  const voice = f.engine.sendVoice({ ...f.payload, pcmBase64: Buffer.alloc(32000).toString('base64') });
  assert.equal((await voice).state, 'queued');
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

test('OneBot persists a reply during global pause and resumes the same native job', async t => {
  const f = fixture(t);
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
  const receipt = await adapter.action({
    action: 'get_text_delivery',
    params: { kind: 'private', target: f.payload.target, message, wechatagent_delivery_id: deliveryId },
  });
  assert.equal(receipt.data.receipt, 'wechat-server-id');
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
