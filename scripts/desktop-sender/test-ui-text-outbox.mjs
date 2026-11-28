import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireDeliveryLock } from './delivery-lock.mjs';
import crypto from 'node:crypto';
import { UiTextOutbox } from './ui-text-outbox.mjs';

const firstId = 'a'.repeat(64),
  secondId = 'b'.repeat(64);
const terminal = new Set(['confirmed', 'unconfirmed', 'cancelled', 'failed', 'conflict']);
const clipboardFailure = () => ({
  version: 1,
  phase: 'original',
  stage: 'enumerate',
  failure: 'DRAFT_CLIPBOARD_COMPLEX_FORMAT',
  total: 1,
  truncated: false,
  sequenceBefore: 10,
  sequenceAfter: 10,
  ownerStable: true,
  complete: false,
  formats: [
    {
      id: 0xc001,
      registeredName: 'DataObject',
      backupSupported: false,
      storage: 'unsupported',
      byteLength: null,
      state: 'unsupported',
      error: 'DRAFT_CLIPBOARD_COMPLEX_FORMAT',
    },
  ],
  payloadIncluded: false,
  clipboardModified: false,
});

test('unsupported original clipboard pauses an explicit no-input paste refusal until manual resume', async t => {
  for (const reason of [
    'DRAFT_CLIPBOARD_COMPLEX_FORMAT',
    'DRAFT_CLIPBOARD_DATA_TOO_LARGE',
    'DRAFT_CLIPBOARD_DATA_UNAVAILABLE',
    'DRAFT_CLIPBOARD_FORMAT_INVALID',
  ]) {
    const f = fixture(t);
    f.controls.textEntryMode = 'paste';
    let calls = 0;
    f.driver.pasteText = async () => {
      calls++;
      return { performed: false, attempted: false, reason, clipboardBackup: clipboardFailure() };
    };
    f.enqueue();
    await f.queue.tick();
    const paused = f.queue.get(firstId);
    assert.equal(paused.manualPause, true);
    assert.equal(paused.pendingInput, undefined);
    assert.equal(paused.reason, reason);
    assert.equal(paused.clipboardBackup.formats[0].registeredName, 'DataObject');
    for (let i = 0; i < 3; i++) await f.queue.tick();
    f.create();
    await f.queue.tick();
    assert.equal(calls, 1);
    assert.equal(f.inputs.length, 0);
    f.queue.resume(firstId);
    await f.queue.tick();
    assert.equal(calls, 2);
  }
});
test('a temporary clipboard lock remains automatically resumable', async t => {
  const f = fixture(t);
  f.controls.textEntryMode = 'paste';
  let calls = 0;
  f.driver.pasteText = async (...args) =>
    ++calls === 1
      ? { performed: false, attempted: false, reason: 'DRAFT_CLIPBOARD_BUSY' }
      : f.driver.typeGrapheme(...args);
  f.enqueue();
  await f.queue.tick();
  assert.notEqual(f.queue.get(firstId).manualPause, true);
  await f.queue.tick();
  assert.equal(calls, 2);
  assert.equal(f.inputs.length, 1);
});

test('quote preparation exceptions pause durably instead of repeatedly borrowing focus', async t => {
  const f = fixture(t);
  let calls = 0;
  f.controls.beforeObserve = () => {
    calls++;
    throw Object.assign(Error('menu unavailable'), { code: 'QT_QUOTE_MENU_UNAVAILABLE' });
  };
  const target = 'fixture-chat',
    serverId = '123';
  f.enqueue({
    quote: {
      id: crypto
        .createHash('sha256')
        .update(target + '\0' + serverId)
        .digest('hex'),
      serverId,
      sender: 'fixture-account',
      timestamp: 1700000000,
      text: 'owned source',
    },
  });
  await f.queue.tick();
  assert.equal(f.queue.get(firstId).manualPause, true);
  assert.equal(f.queue.get(firstId).reason, 'QT_QUOTE_MENU_UNAVAILABLE');
  for (let i = 0; i < 5; i++) await f.queue.tick();
  f.create();
  await f.queue.tick();
  assert.equal(calls, 1);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.submissions.length, 0);
  f.queue.resume(firstId);
  await f.queue.tick();
  assert.equal(calls, 2);
  assert.equal(f.queue.get(firstId).manualPause, true);
});

test('structural navigation exceptions pause once across ticks and restart with their original reason', async t => {
  for (const code of [
    'UI_QT_SEARCH_TRANSITION_UNCONFIRMED',
    'QT_FOCUS_TARGET_CHANGED',
    'QT_FOCUS_ACQUIRE_UNCONFIRMED',
    'UIA_MODE_CONTROLS_CHANGED',
    'DRAFT_EXECUTABLE_MISMATCH',
  ]) {
    const f = fixture(t);
    let calls = 0;
    f.controls.beforeObserve = () => {
      calls++;
      throw Object.assign(Error(code), { code });
    };
    f.enqueue();
    await f.queue.tick();
    assert.equal(f.queue.get(firstId).state, 'paused');
    assert.equal(f.queue.get(firstId).manualPause, true);
    assert.equal(f.queue.get(firstId).reason, code);
    for (let i = 0; i < 3; i++) await f.queue.tick();
    f.create();
    await f.queue.tick();
    assert.equal(calls, 1);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.submissions.length, 0);
  }
});

test('idle and human-activity observations can still resume automatically', async t => {
  for (const code of ['QT_ACTIVITY_WARMUP', 'QT_USER_ACTIVE', 'DRAFT_HUMAN_ACTIVITY_CHANGED']) {
    const f = fixture(t);
    let calls = 0;
    f.controls.beforeObserve = () => {
      if (++calls === 1) throw Object.assign(Error(code), { code });
    };
    f.enqueue();
    await f.queue.tick();
    assert.notEqual(f.queue.get(firstId).manualPause, true);
    assert.equal(f.queue.get(firstId).reason, code);
    await f.queue.tick();
    assert.equal(calls, 2);
    assert.equal(f.inputs.length, 1);
  }
  const f = fixture(t);
  f.state.ready = false;
  f.state.reason = 'QT_USER_ACTIVE';
  f.enqueue();
  await f.queue.tick();
  assert.notEqual(f.queue.get(firstId).manualPause, true);
  f.state.ready = true;
  await f.queue.tick();
  assert.equal(f.inputs.length, 1);
});

test('shared text keeps focus only while typing and returns it before a receipt query', async t => {
  const f = fixture(t);
  let held = true,
    returns = 0;
  f.driver.releaseTextFocus = async () => {
    held = false;
    returns++;
  };
  f.driver.receipt = async () => {
    assert.equal(held, false);
    return { confirmed: true, receipt: { messageId: 'focus-receipt' } };
  };
  f.enqueue();
  await f.queue.tick();
  assert.equal(returns, 0);
  await f.run();
  assert.equal(f.submissions.length, 1);
  assert.ok(returns >= 1);
});

test('manual pause between ticks releases focus without typing or discarding a partial draft', async t => {
  const f = fixture(t);
  let returns = 0;
  f.driver.releaseTextFocus = async () => {
    returns++;
  };
  f.enqueue();
  await f.queue.tick();
  const draft = f.state.draft,
    inputs = f.inputs.length;
  f.queue.pause();
  await f.queue.drain();
  assert.ok(returns > 0);
  assert.equal(f.state.draft, draft);
  assert.equal(f.inputs.length, inputs);
});

test('uncertain submission returns focus and stays receipt-only', async t => {
  const f = fixture(t);
  let returned = false;
  f.driver.releaseTextFocus = async () => {
    returned = true;
  };
  f.controls.afterSubmit = () => {
    throw Error('response lost');
  };
  f.enqueue();
  for (let i = 0; i < 6 && f.queue.get(firstId).state !== 'submitting'; i++) await f.queue.tick();
  assert.equal(returned, true);
  assert.equal(f.queue.get(firstId).state, 'submitting');
  await f.queue.tick();
  assert.equal(f.submissions.length, 1);
});

test('failed focus cleanup allows only a submitted DB receipt and still makes drain fail', async t => {
  for (const failOnReturn of [1, 2]) {
    const f = fixture(t);
    let returns = 0,
      observations = 0,
      receipts = 0;
    f.driver.releaseTextFocus = async () => {
      if (++returns === failOnReturn) throw Error('return failed');
    };
    const observe = f.driver.observe,
      receipt = f.driver.receipt;
    f.driver.observe = async job => {
      observations++;
      return observe(job);
    };
    f.driver.receipt = async job => {
      receipts++;
      return receipt(job);
    };
    f.enqueue();
    f.enqueue({ deliveryId: secondId });
    let error;
    for (let i = 0; i < 6; i++) {
      try {
        await f.queue.tick();
      } catch (e) {
        error = e;
        break;
      }
    }
    assert.equal(error?.code, 'UI_FOCUS_RETURN_UNCONFIRMED');
    assert.equal(f.queue.get(firstId).state, failOnReturn === 1 ? 'submitting' : 'submitted');
    const inputCount = f.inputs.length,
      observationCount = observations;
    // A separately scheduled cleanup is allowed to settle, but its known
    // failure must not suppress or overwrite a later read-only receipt.
    f.queue.pause();
    f.controls.confirmed = true;
    assert.equal((await f.queue.tick()).state, 'confirmed');
    assert.equal(receipts, 1);
    assert.equal(f.inputs.length, inputCount);
    assert.equal(observations, observationCount);
    assert.equal(returns, failOnReturn);
    assert.equal(f.submissions.length, 1);
    await assert.rejects(f.queue.drain(), { code: 'UI_FOCUS_RETURN_UNCONFIRMED' });
    f.queue.resume();
    await assert.rejects(f.queue.tick(), { code: 'UI_FOCUS_RETURN_UNCONFIRMED' });
    assert.equal(f.queue.get(secondId).state, 'queued');
    assert.equal(f.submissions.length, 1);
  }
});

test('failed focus cleanup can expire an unknown submission without ever resending', async t => {
  const f = fixture(t);
  f.driver.releaseTextFocus = async () => {
    throw Error('return failed');
  };
  f.enqueue();
  for (let i = 0; i < 6; i++) {
    try {
      await f.queue.tick();
    } catch {
      break;
    }
  }
  assert.equal((await f.queue.tick()).state, 'submitting');
  f.advance(1001);
  assert.equal((await f.queue.tick()).state, 'unconfirmed');
  assert.equal(f.enqueue().state, 'unconfirmed');
  assert.equal(f.submissions.length, 1);
  await assert.rejects(f.queue.tick(), { code: 'UI_FOCUS_RETURN_UNCONFIRMED' });
});

test('pausing or cancelling a later FIFO item leaves the current typing focus held', async t => {
  for (const action of ['pause', 'cancel']) {
    const f = fixture(t);
    let returns = 0;
    f.driver.releaseTextFocus = async () => {
      returns++;
    };
    f.enqueue();
    f.enqueue({ deliveryId: secondId });
    await f.queue.tick();
    f.queue[action](secondId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returns, 0);
    assert.equal(f.state.draft, '测');
    await f.queue.tick();
    assert.equal(returns, 0);
    assert.equal(f.state.draft, '测试');
    assert.equal(f.queue.get(firstId).state, 'typing');
  }
});

test('queued item controls during an active native input do not schedule current focus release', async t => {
  for (const action of ['pause', 'cancel']) {
    const f = fixture(t);
    let returns = 0,
      finishInput,
      started;
    const inputStarted = new Promise(resolve => {
      started = resolve;
    });
    const inputFinished = new Promise(resolve => {
      finishInput = resolve;
    });
    f.driver.releaseTextFocus = async () => {
      returns++;
    };
    f.controls.afterType = async () => {
      started();
      await inputFinished;
    };
    f.enqueue();
    f.enqueue({ deliveryId: secondId });
    const tick = f.queue.tick();
    await inputStarted;
    f.queue[action](secondId);
    finishInput();
    await tick;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returns, 0);
    assert.equal(f.queue.get(firstId).state, 'typing');
    assert.equal(f.state.draft, '测');
  }
});

test('pausing or cancelling the current FIFO item still releases focus and preserves its draft', async t => {
  for (const action of ['pause', 'cancel']) {
    const f = fixture(t);
    let returns = 0;
    f.driver.releaseTextFocus = async () => {
      returns++;
    };
    f.enqueue();
    f.enqueue({ deliveryId: secondId });
    await f.queue.tick();
    f.queue[action](firstId);
    await f.queue.drain();
    assert.ok(returns > 0);
    assert.equal(f.state.draft, '测');
    assert.deepEqual(f.inputs, ['测']);
  }
});

test('cancelled history no longer exhausts 256 active slots and old IDs remain immutable after restart', t => {
  const f = fixture(t);
  for (let index = 1; index <= 300; index++) {
    const deliveryId = index.toString(16).padStart(64, '0');
    f.enqueue({ deliveryId });
    f.queue.cancel(deliveryId);
  }
  assert.equal(f.queue.prune().archived, 1);
  assert.equal(f.queue.list().length, 0);
  f.create();
  const old = '1'.padStart(64, '0');
  assert.equal(f.enqueue({ deliveryId: old }).state, 'cancelled');
  assert.equal(f.queue.list().length, 0);
  assert.throws(() => f.enqueue({ deliveryId: old, text: 'changed' }), { code: 'UI_OUTBOX_ID_CONFLICT' });
  assert.equal(f.enqueue({ deliveryId: '301'.padStart(64, '0') }).sequence, 301);
  f.queue.resume(old);
  f.queue.pause(old);
  f.queue.cancel(old);
  assert.equal(f.queue.list().length, 1);
});

test('confirmed text receipt survives archival while partial cancelled drafts stay active', async t => {
  const f = fixture(t);
  f.controls.confirmed = true;
  f.enqueue();
  await f.run();
  assert.equal(f.queue.prune().archived, 1);
  assert.equal(f.queue.get(firstId).receipt.messageId, 'fixture-receipt');
  f.enqueue({ deliveryId: secondId });
  await f.queue.tick();
  await f.queue.tick();
  f.queue.cancel(secondId);
  assert.equal(f.queue.prune().archived, 0);
  assert.equal(f.queue.list().length, 1);
  assert.ok(f.queue.get(secondId).index > 0);
});

test('desktop text rejects a background-only observation before any input', async t => {
  const f = fixture(t);
  f.state.foreground = false;
  f.state.inputTransport = 'window-message-background-v1';
  f.controls.confirmed = true;
  f.enqueue();
  assert.equal((await f.run()).state, 'waiting');
  assert.deepEqual(f.inputs, []);
  assert.deepEqual(f.submissions, []);
});

function fixture(t, settings = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-ui-outbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'outbox');
  const state = {
    ready: true,
    account: 'fixture-account',
    target: 'fixture-chat',
    foreground: true,
    idleMs: 10000,
    draft: '',
    editorToken: 'fixture-editor',
    activityRevision: 1,
  };
  let now = 1000;
  const inputs = [],
    submissions = [];
  const controls = {
    confirmed: false,
    beforeObserve: null,
    beforeType: null,
    beforeSubmit: null,
    afterType: null,
    afterSubmit: null,
    textEntryMode: 'humanized',
  };
  let current;
  const driver = {
    async observe(job) {
      if (controls.beforeObserve) await controls.beforeObserve(job);
      return { ...state };
    },
    async typeGrapheme(job, request) {
      assert.equal(
        current.get(job.id).pendingInput.text,
        request.text,
        'input intention must be durable before native input',
      );
      assert.equal(request.expectedDraft, state.draft);
      assert.equal(request.editorToken, state.editorToken);
      assert.equal(request.activityRevision, state.activityRevision);
      if (controls.beforeType) {
        const result = await controls.beforeType(job, request);
        if (result !== undefined) return result;
      }
      inputs.push(request.text);
      state.draft += request.text;
      if (controls.afterType) await controls.afterType(job, request);
    },
    async submit(job, request) {
      assert.equal(current.get(job.id).state, 'submitting', 'submit intention must be durable before the send action');
      assert.equal(request.expectedDraft, state.draft);
      if (controls.beforeSubmit) {
        const result = await controls.beforeSubmit(job, request);
        if (result !== undefined) return result;
      }
      submissions.push(job.id);
      state.draft = '';
      if (controls.afterSubmit) await controls.afterSubmit(job, request);
    },
    async receipt(job) {
      return { confirmed: controls.confirmed, receipt: { messageId: 'fixture-receipt', deliveryId: job.id } };
    },
  };
  const create = () =>
    (current = new UiTextOutbox({
      directory,
      driver,
      settings: { idleMs: 10, intervalMs: 0, punctuationPauseMs: 0, receiptTimeoutMs: 1000, ...settings },
      now: () => now,
      textEntryModeFor: () => controls.textEntryMode,
      ...options,
    }));
  create();
  return {
    root,
    directory,
    state,
    inputs,
    submissions,
    controls,
    driver,
    create,
    get queue() {
      return current;
    },
    advance(ms) {
      now += ms;
    },
    enqueue(extra = {}) {
      return current.enqueue({
        deliveryId: firstId,
        account: state.account,
        target: state.target,
        text: '测试',
        ...extra,
      });
    },
    async run(max = 40) {
      let result;
      for (let index = 0; index < max; index++) {
        result = await current.tick();
        if (!result || terminal.has(result.state)) return result;
      }
      return result;
    },
  };
}

test('UI outbox binds one durable delivery id to the exact account, chat and text', t => {
  const f = fixture(t);
  const job = f.enqueue();
  assert.equal(job.state, 'queued');
  f.create();
  assert.deepEqual(f.enqueue(), job);
  for (const changed of [{ text: 'changed' }, { account: 'different' }, { target: 'different' }])
    assert.throws(() => f.enqueue(changed), /UI_OUTBOX_ID_CONFLICT/);
  assert.equal(f.queue.list().length, 1);
  job.text = 'caller mutation';
  assert.equal(f.queue.get(firstId).text, '测试');
});

test('graphemes, Chinese, emoji, punctuation and newlines remain intact and submit exactly once', async t => {
  const f = fixture(t);
  const text = '你好👩‍💻，\nA';
  f.enqueue({ text });
  f.controls.confirmed = true;
  const result = await f.run();
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(f.inputs, ['你', '好', '👩‍💻', '，', '\n', 'A']);
  assert.deepEqual(f.submissions, [firstId]);
  assert.equal(f.enqueue({ text }).state, 'confirmed');
  await f.queue.tick();
  assert.equal(f.submissions.length, 1);
});

test('paste writes one bounded remainder intention and confirms exact graphemes before submission', async t => {
  const f = fixture(t),
    text = '你好👩‍💻，\nA';
  f.controls.textEntryMode = 'paste';
  f.driver.pasteText = f.driver.typeGrapheme;
  f.enqueue({ text });
  const typed = await f.queue.tick();
  assert.equal(typed.index, 0);
  assert.equal(typed.pendingInput.count, 6);
  assert.equal(typed.pendingInput.textEntryMode, 'paste');
  assert.equal(typed.pendingInput.text, text);
  assert.deepEqual(f.inputs, [text]);
  assert.equal(f.submissions.length, 0);
  f.controls.confirmed = true;
  assert.equal((await f.run()).state, 'confirmed');
  assert.deepEqual(f.inputs, [text]);
  assert.deepEqual(f.submissions, [firstId]);
});

test('paste recovery reconciles the persisted count after mode changes without retyping or repasting', async t => {
  const f = fixture(t);
  f.controls.textEntryMode = 'paste';
  f.driver.pasteText = f.driver.typeGrapheme;
  f.controls.afterType = () => {
    throw Error('response lost');
  };
  f.enqueue({ text: '整段文字' });
  assert.equal((await f.queue.tick()).reason, 'UI_INPUT_UNCERTAIN');
  assert.equal(f.queue.get(firstId).pendingInput.count, 4);
  f.controls.textEntryMode = 'humanized';
  f.controls.afterType = null;
  f.controls.confirmed = true;
  f.create();
  assert.equal((await f.run()).state, 'confirmed');
  assert.deepEqual(f.inputs, ['整段文字']);
  assert.equal(f.submissions.length, 1);
});

test('paste does not retry delayed, partial or unknown application input after restart', async t => {
  for (const draft of ['', '部分']) {
    const f = fixture(t);
    f.controls.textEntryMode = 'paste';
    let calls = 0;
    f.driver.pasteText = async () => {
      calls++;
      f.state.draft = draft;
      return { attempted: true };
    };
    f.enqueue({ text: '部分完成' });
    await f.queue.tick();
    f.controls.textEntryMode = 'humanized';
    f.create();
    const result = await f.queue.tick();
    assert.equal(result.state, 'conflict');
    assert.equal(result.reason, 'UI_INPUT_OUTCOME_UNKNOWN');
    assert.equal(result.pendingInput.text, '部分完成');
    await f.queue.tick();
    assert.equal(calls, 1);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.submissions.length, 0);
  }
});

test('paste capability, foreground and human idle are required without a typing fallback', async t => {
  const f = fixture(t);
  f.controls.textEntryMode = 'paste';
  f.enqueue();
  assert.equal((await f.queue.tick()).reason, 'UI_PASTE_UNAVAILABLE');
  assert.equal(f.queue.get(firstId).pendingInput, undefined);
  assert.equal(f.inputs.length, 0);
  f.driver.pasteText = f.driver.typeGrapheme;
  f.state.foreground = false;
  assert.equal((await f.queue.tick()).reason, 'UI_FOREGROUND_REQUIRED');
  f.state.foreground = true;
  f.state.idleMs = 0;
  assert.equal((await f.queue.tick()).reason, 'UI_USER_ACTIVE');
  assert.equal(f.inputs.length, 0);
  f.state.idleMs = 100;
  f.controls.beforeType = () => ({ performed: false, attempted: false, reason: 'UI_USER_ACTIVE' });
  await f.queue.tick();
  assert.equal(f.queue.get(firstId).pendingInput, undefined);
  f.controls.beforeType = null;
  await f.queue.tick();
  assert.deepEqual(f.inputs, ['测试']);
});

test('switching from typing to paste affects only the remaining exact text and preserves legacy intentions', async t => {
  const f = fixture(t);
  f.enqueue({ text: '甲乙丙' });
  await f.queue.tick();
  const file = path.join(f.directory, 'jobs', firstId + '.json'),
    legacy = JSON.parse(fs.readFileSync(file));
  delete legacy.pendingInput.count;
  delete legacy.pendingInput.textEntryMode;
  fs.writeFileSync(file, JSON.stringify(legacy));
  f.controls.textEntryMode = 'paste';
  f.driver.pasteText = f.driver.typeGrapheme;
  f.create();
  const next = await f.queue.tick();
  assert.equal(next.index, 1);
  assert.equal(next.pendingInput.count, 2);
  assert.equal(next.pendingInput.text, '乙丙');
  f.controls.confirmed = true;
  assert.equal((await f.run()).state, 'confirmed');
  assert.deepEqual(f.inputs, ['甲', '乙丙']);
});

test('paste splits oversized remainders and rejects malformed persisted batch counts', async t => {
  const f = fixture(t, { maxTextChars: 10000 });
  f.controls.textEntryMode = 'paste';
  f.driver.pasteText = f.driver.typeGrapheme;
  f.enqueue({ text: 'A'.repeat(4001) });
  await f.queue.tick();
  assert.equal(f.inputs[0].length, 4000);
  assert.equal(f.queue.get(firstId).pendingInput.count, 4000);
  await f.queue.tick();
  assert.deepEqual(
    f.inputs.map(value => value.length),
    [4000, 1],
  );
  const g = fixture(t);
  g.controls.textEntryMode = 'paste';
  g.driver.pasteText = g.driver.typeGrapheme;
  g.enqueue();
  await g.queue.tick();
  const file = path.join(g.directory, 'jobs', firstId + '.json'),
    original = JSON.parse(fs.readFileSync(file));
  for (const patch of [
    { count: null },
    { count: 0 },
    { count: 3 },
    { count: 1 },
    { textEntryMode: 'humanized' },
    { textEntryMode: null },
    { text: '不同' },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, pendingInput: { ...original.pendingInput, ...patch } }));
    assert.throws(() => g.queue.get(firstId), { code: 'UI_OUTBOX_STATE_INVALID' });
  }
});

test('paste never inherits the per-character interval or punctuation delay', async t => {
  const f = fixture(t, { intervalMs: 100, punctuationPauseMs: 500 });
  f.controls.textEntryMode = 'paste';
  f.driver.pasteText = f.driver.typeGrapheme;
  f.enqueue({ text: '整段文字。' });
  await f.queue.tick();
  assert.equal(f.submissions.length, 0);
  assert.equal(f.queue.get(firstId).nextActionAt, 1000);
  await f.queue.tick();
  assert.deepEqual(f.inputs, ['整段文字。']);
  assert.equal(f.submissions.length, 1);
});
function appliedPaste(f) {
  f.controls.textEntryMode = 'paste';
  f.driver.pasteText = async (...args) =>
    (await f.driver.typeGrapheme(...args)) ?? { performed: true, attempted: true };
}
test('explicit applied paste submits in the same worker tick with durable pending and submitting boundaries', async t => {
  const f = fixture(t, { intervalMs: 120, punctuationPauseMs: 500 });
  appliedPaste(f);
  f.enqueue({ text: '整段👩‍💻文字。' });
  let returned = 0;
  f.driver.releaseTextFocus = async () => {
    returned++;
  };
  f.controls.beforeSubmit = job => {
    const disk = f.queue.get(job.id);
    assert.equal(disk.state, 'submitting');
    assert.equal(disk.pendingInput, undefined);
    assert.equal(disk.index, 6);
  };
  const result = await f.queue.tick();
  assert.equal(result.state, 'submitted');
  assert.deepEqual(f.inputs, ['整段👩‍💻文字。']);
  assert.deepEqual(f.submissions, [firstId]);
  assert.equal(result.submittedAt, 1000);
  assert.ok(returned > 0);
  f.controls.confirmed = true;
  f.create();
  assert.equal((await f.queue.tick()).state, 'confirmed');
  assert.equal(f.submissions.length, 1);
});
test('same-tick paste continuation respects human activity, focus changes and local pause/stop/cancel', async t => {
  for (const interruption of ['activity', 'focus', 'pause', 'stop', 'cancel']) {
    const f = fixture(t, { intervalMs: 120 });
    appliedPaste(f);
    f.enqueue();
    f.enqueue({ deliveryId: secondId });
    let releases = 0;
    f.driver.releaseTextFocus = async () => {
      releases++;
    };
    f.controls.afterType = () => {
      if (interruption === 'activity') f.state.idleMs = 0;
      else if (interruption === 'focus') f.state.foreground = false;
      else if (interruption === 'stop') f.queue.stop();
      else f.queue[interruption](firstId);
    };
    await f.queue.tick();
    assert.deepEqual(f.inputs, ['测试']);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.queue.get(secondId).state, 'queued');
    assert.ok(f.queue.get(firstId).pendingInput);
    await f.queue.drain();
    assert.ok(releases > 0);
  }
});
test('same-tick paste submits only after the native final guard and definite refusal resumes without repasting', async t => {
  const f = fixture(t);
  appliedPaste(f);
  f.enqueue();
  f.controls.beforeSubmit = () => ({ performed: false, attempted: false, reason: 'UI_USER_ACTIVE' });
  const paused = await f.queue.tick();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.index, 2);
  assert.equal(paused.submittedAt, undefined);
  assert.equal(f.submissions.length, 0);
  f.controls.beforeSubmit = null;
  assert.equal((await f.queue.tick()).state, 'submitted');
  assert.deepEqual(f.inputs, ['测试']);
  assert.equal(f.submissions.length, 1);
});
test('lost same-tick submit response stays receipt-only after restart', async t => {
  const f = fixture(t);
  appliedPaste(f);
  f.enqueue();
  f.controls.afterSubmit = () => {
    throw Error('lost submit response');
  };
  assert.equal((await f.queue.tick()).state, 'submitting');
  assert.equal(f.submissions.length, 1);
  f.create();
  f.controls.confirmed = true;
  assert.equal((await f.queue.tick()).state, 'confirmed');
  assert.deepEqual(f.inputs, ['测试']);
  assert.equal(f.submissions.length, 1);
});
test('an incomplete applied-paste acknowledgement never takes the same-tick submit shortcut', async t => {
  for (const acknowledgement of [
    undefined,
    { performed: true },
    { attempted: true },
    { performed: false, attempted: true },
  ]) {
    const f = fixture(t);
    f.controls.textEntryMode = 'paste';
    f.driver.pasteText = async (...args) => {
      await f.driver.typeGrapheme(...args);
      return acknowledgement;
    };
    f.enqueue();
    assert.equal((await f.queue.tick()).state, 'typing');
    assert.ok(f.queue.get(firstId).pendingInput);
    assert.equal(f.submissions.length, 0);
  }
});

test('unready, wrong-target, unfocused and active-user observations never inject input', async t => {
  for (const change of [
    { ready: false, reason: 'UI_BINDING_REQUIRED' },
    { target: 'other' },
    { account: 'other' },
    { foreground: false },
    { idleMs: 0 },
    { editorToken: null },
  ]) {
    const f = fixture(t);
    f.enqueue();
    Object.assign(f.state, change);
    const result = await f.queue.tick();
    assert.equal(result.state, 'waiting');
    assert.equal(f.inputs.length, 0);
    assert.equal(f.submissions.length, 0);
  }
});

test('global manual pause survives restart, and user activity pauses partially typed text', async t => {
  const f = fixture(t);
  f.enqueue();
  await f.queue.tick();
  assert.equal(f.state.draft, '测');
  f.queue.pause();
  f.create();
  assert.equal(f.queue.control().paused, true);
  assert.equal((await f.queue.tick()).state, 'paused');
  assert.equal(f.inputs.length, 1);
  f.queue.resume();
  f.state.idleMs = 0;
  f.state.activityRevision++;
  assert.equal((await f.queue.tick()).reason, 'UI_USER_ACTIVE');
  assert.equal(f.inputs.length, 1);
  f.state.idleMs = 100;
  f.controls.confirmed = true;
  assert.equal((await f.run()).state, 'confirmed');
  assert.deepEqual(f.inputs, ['测', '试']);
});

test('an existing or manually changed draft is preserved and blocks all later UI jobs', async t => {
  const f = fixture(t);
  f.enqueue();
  f.enqueue({ deliveryId: secondId, target: 'second-chat' });
  f.state.draft = 'personal draft';
  assert.equal((await f.queue.tick()).state, 'conflict');
  assert.throws(() => f.queue.resume(firstId), /UI_DRAFT_CONFLICT/);
  await f.queue.tick();
  assert.equal(f.state.draft, 'personal draft');
  assert.equal(f.inputs.length, 0);
  assert.equal(f.queue.get(secondId).state, 'queued');
  f.queue.cancel(firstId);
  assert.equal(f.state.draft, 'personal draft');
  assert.equal(f.queue.get(firstId).state, 'cancelled');
});

test('manual edits after a typing pause are never overwritten or appended to', async t => {
  const f = fixture(t);
  f.enqueue();
  await f.queue.tick();
  f.queue.pause(firstId);
  f.state.draft += '我补充的内容';
  f.state.activityRevision++;
  f.queue.resume(firstId);
  f.create();
  const result = await f.queue.tick();
  assert.equal(result.state, 'conflict');
  assert.equal(f.state.draft, '测我补充的内容');
  assert.deepEqual(f.inputs, ['测']);
  assert.equal(f.submissions.length, 0);
});

test('restart reconciles a character written before the driver failed without typing it twice', async t => {
  const f = fixture(t);
  f.enqueue();
  f.controls.afterType = () => {
    throw new Error('fixture lost response');
  };
  assert.equal((await f.queue.tick()).reason, 'UI_INPUT_UNCERTAIN');
  assert.equal(f.state.draft, '测');
  f.create();
  f.controls.afterType = null;
  f.controls.confirmed = true;
  assert.equal((await f.run()).state, 'confirmed');
  assert.deepEqual(f.inputs, ['测', '试']);
});

test('unknown input outcome plus intervening user activity requires manual resolution', async t => {
  const f = fixture(t);
  f.enqueue();
  f.controls.beforeType = () => {
    throw new Error('fixture failure before input');
  };
  await f.queue.tick();
  f.create();
  f.state.activityRevision++;
  f.controls.beforeType = null;
  assert.equal((await f.queue.tick()).state, 'conflict');
  assert.equal(f.inputs.length, 0);
});

test('an accepted input that is not yet visible is never replayed when the application lags', async t => {
  const f = fixture(t);
  f.enqueue({ text: 'A' });
  let accepted = 0;
  f.driver.typeGrapheme = async () => {
    accepted++;
    return { attempted: true };
  };
  await f.queue.tick();
  assert.equal(accepted, 1);
  assert.equal(f.state.draft, '');
  assert.equal((await f.queue.tick()).reason, 'UI_INPUT_OUTCOME_UNKNOWN');
  assert.equal(f.queue.get(firstId).state, 'conflict');
  f.state.draft = 'A'; // The application's delayed input queue finally runs.
  await f.queue.tick();
  assert.equal(accepted, 1);
  assert.equal(f.state.draft, 'A');
  assert.equal(f.submissions.length, 0);
});

test('an uncertain input with unchanged draft and activity is preserved rather than retried', async t => {
  const f = fixture(t);
  f.enqueue({ text: 'A' });
  let attempted = 0;
  f.driver.typeGrapheme = async () => {
    attempted++;
    throw Error('fixture response lost');
  };
  await f.queue.tick();
  f.create();
  const result = await f.queue.tick();
  assert.equal(result.state, 'conflict');
  assert.equal(result.reason, 'UI_INPUT_OUTCOME_UNKNOWN');
  assert.equal(result.pendingInput.text, 'A');
  await f.queue.tick();
  assert.equal(attempted, 1);
  assert.equal(f.state.draft, '');
  assert.equal(f.submissions.length, 0);
});

test('submission uncertainty survives restart and is resolved only through receipt lookup', async t => {
  const f = fixture(t);
  f.enqueue({ text: 'A' });
  await f.queue.tick();
  f.controls.afterSubmit = () => {
    throw new Error('fixture lost submission response');
  };
  assert.equal((await f.queue.tick()).state, 'submitting');
  assert.equal(f.submissions.length, 1);
  f.create();
  f.controls.confirmed = true;
  assert.equal((await f.queue.tick()).state, 'confirmed');
  assert.equal(f.submissions.length, 1);
  assert.equal(f.inputs.join(''), 'A');
});

test('a lost send response with no receipt expires without retrying the send action', async t => {
  const f = fixture(t);
  f.enqueue({ text: 'A' });
  await f.queue.tick();
  f.controls.afterSubmit = () => {
    throw new Error('fixture network error');
  };
  await f.queue.tick();
  f.advance(1001);
  f.create();
  assert.equal((await f.queue.tick()).state, 'unconfirmed');
  await f.queue.tick();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.inputs.length, 1);
});

test('a hanging receipt query is bounded and late confirmation cannot alter timed-out state', async t => {
  const f = fixture(t, { receiptQueryTimeoutMs: 10 });
  f.enqueue({ text: 'A' });
  await f.queue.tick();
  await f.queue.tick();
  let resolveLate,
    queryCount = 0,
    aborted = false;
  f.driver.receipt = (_job, { signal }) =>
    new Promise(resolve => {
      queryCount++;
      resolveLate = resolve;
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
    });
  const result = await f.queue.tick();
  assert.equal(result.state, 'submitted');
  assert.equal(aborted, true);
  assert.equal(queryCount, 1);
  acquireDeliveryLock(f.directory, 'worker').release();
  f.advance(1001);
  assert.equal((await f.queue.tick()).state, 'unconfirmed');
  assert.equal(queryCount, 1, 'expired jobs do not start another query');
  resolveLate({ confirmed: true, receipt: { messageId: 'late-fixture-receipt' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.queue.get(firstId).state, 'unconfirmed');
  assert.equal(f.submissions.length, 1);
});

test('receipt query timeout is capped by the remaining total deadline', async t => {
  const f = fixture(t, { receiptQueryTimeoutMs: 5000, receiptTimeoutMs: 100 });
  f.enqueue({ text: 'A' });
  await f.queue.tick();
  await f.queue.tick();
  f.advance(90);
  let aborted = false;
  f.driver.receipt = (_job, { signal }) =>
    new Promise(() => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
    });
  const started = performance.now();
  await f.queue.tick();
  assert.equal(aborted, true);
  assert(performance.now() - started < 1000, 'query must use the remaining 10 ms rather than its configured 5 seconds');
  assert.throws(
    () => new UiTextOutbox({ directory: f.directory, driver: f.driver, settings: { receiptQueryTimeoutMs: 5001 } }),
    /UI_OUTBOX_SETTINGS_INVALID/,
  );
});

test('definite pre-input refusal pauses without poisoning the submission state', async t => {
  const f = fixture(t);
  f.enqueue({ text: 'A' });
  f.controls.beforeType = () => ({ performed: false, attempted: false, reason: 'UI_USER_ACTIVE' });
  let result = await f.queue.tick();
  assert.equal(result.state, 'paused');
  assert.equal(result.pendingInput, undefined);
  f.controls.beforeType = null;
  await f.queue.tick();
  f.controls.beforeSubmit = () => ({ performed: false, attempted: false, reason: 'UI_USER_ACTIVE' });
  result = await f.queue.tick();
  assert.equal(result.state, 'paused');
  assert.equal(result.submittedAt, undefined);
  assert.equal(f.submissions.length, 0);
  f.controls.beforeSubmit = null;
  f.controls.confirmed = true;
  assert.equal((await f.run()).state, 'confirmed');
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.inputs, ['A']);
});

test('simultaneous ticks share one operation and another worker cannot use the same desktop queue', async t => {
  const f = fixture(t);
  f.enqueue();
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  f.controls.beforeObserve = () => gate;
  const old = f.queue;
  const first = old.tick(),
    again = old.tick();
  assert.equal(first, again);
  const other = new UiTextOutbox({ directory: f.directory, driver: f.driver });
  assert.deepEqual(await other.tick(), { busy: true });
  release();
  await first;
  assert.deepEqual(f.inputs, ['测']);
});

test('same-millisecond arrivals keep persisted FIFO order while the older draft is being typed', async t => {
  const f = fixture(t);
  f.enqueue({ deliveryId: secondId, text: 'BC' });
  await f.queue.tick();
  f.enqueue({ deliveryId: firstId, text: 'A' });
  f.create();
  assert.deepEqual(
    f.queue.list().map(job => job.id),
    [secondId, firstId],
  );
  await f.queue.tick();
  assert.deepEqual(f.inputs, ['B', 'C']);
  await f.queue.tick();
  assert.deepEqual(f.submissions, [secondId]);
  assert.equal(f.queue.get(firstId).state, 'queued');
});

test('a live worker or state transaction excludes another owner until release', async t => {
  const f = fixture(t);
  f.enqueue();
  const worker = acquireDeliveryLock(f.directory, 'worker');
  assert.deepEqual(await f.queue.tick(), { busy: true });
  worker.release();
  const state = acquireDeliveryLock(f.directory, 'state');
  assert.throws(() => f.queue.pause(), /UI_OUTBOX_BUSY/);
  state.release();
  assert.equal(f.inputs.length, 0);
  assert.equal(f.submissions.length, 0);
});

test('manual pause while observation is pending prevents the subsequent native input', async t => {
  const f = fixture(t);
  f.enqueue();
  let release;
  f.controls.beforeObserve = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const pending = f.queue.tick();
  f.queue.pause();
  release();
  await pending;
  assert.equal(f.inputs.length, 0);
  assert.equal(f.submissions.length, 0);
});

test('pacing is persisted and punctuation adds a pause without holding the worker', async t => {
  const f = fixture(t, { intervalMs: 100, punctuationPauseMs: 200 });
  f.enqueue({ text: 'A，B' });
  await f.queue.tick();
  await f.queue.tick();
  assert.deepEqual(f.inputs, ['A']);
  f.advance(100);
  await f.queue.tick();
  assert.deepEqual(f.inputs, ['A', '，']);
  f.advance(299);
  f.create();
  await f.queue.tick();
  assert.equal(f.inputs.length, 2);
  f.advance(1);
  await f.queue.tick();
  assert.deepEqual(f.inputs, ['A', '，', 'B']);
});

test('cancellation preserves partial text, and cannot pretend an attempted send was cancelled', async t => {
  const f = fixture(t);
  f.enqueue();
  await f.queue.tick();
  f.queue.cancel(firstId);
  await f.queue.tick();
  assert.equal(f.state.draft, '测');
  assert.equal(f.inputs.length, 1);
  const g = fixture(t);
  g.enqueue({ text: 'A' });
  await g.queue.tick();
  await g.queue.tick();
  assert.throws(() => g.queue.cancel(firstId), /UI_SUBMISSION_ALREADY_STARTED/);
  assert.equal(g.queue.get(firstId).state, 'submitted');
});

test('malformed state, unsafe text, invalid settings and linked directories fail closed', async t => {
  const f = fixture(t);
  for (const text of ['', ' ', 'A\u0000B', '\ud800', 'A'.repeat(4001)])
    assert.throws(() => f.enqueue({ text }), /UI_OUTBOX_REQUEST_INVALID/);
  assert.throws(
    () => new UiTextOutbox({ directory: f.directory, driver: f.driver, settings: { idleMs: -1 } }),
    /UI_OUTBOX_SETTINGS_INVALID/,
  );
  f.enqueue();
  fs.writeFileSync(path.join(f.directory, 'jobs', firstId + '.json'), '{"version":1}');
  await assert.rejects(f.queue.tick(), /UI_OUTBOX_STATE_INVALID/);
  assert.equal(f.inputs.length, 0);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  const link = path.join(f.root, 'link');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new UiTextOutbox({ directory: link, driver: f.driver }), /UI_OUTBOX_LINK_NOT_ALLOWED/);
});

test('reviewed uncertain deliveries move to history and release every admission slot', t => {
  const f = fixture(t, {}, { isRetired: () => true });
  const sample = f.enqueue({ text: 'x' }),
    folder = path.join(f.directory, 'jobs');
  fs.rmSync(path.join(folder, sample.id + '.json'));
  for (let n = 0; n < 256; n++) {
    const id = n.toString(16).padStart(64, '0');
    fs.writeFileSync(
      path.join(folder, id + '.json'),
      JSON.stringify({
        ...sample,
        id,
        sequence: n + 1,
        state: 'unconfirmed',
        index: 1,
        submittedAt: sample.createdAt,
        deadlineAt: sample.createdAt + 1000,
      }),
    );
  }
  assert.equal(f.queue.prune().archived, 256);
  assert.equal(f.enqueue().state, 'queued');
  assert.equal(f.queue.get('0'.repeat(64)).state, 'unconfirmed');
});
