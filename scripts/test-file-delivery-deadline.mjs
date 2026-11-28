import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FileTransfers } from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import { FileDeliveryWorker } from './file-delivery-worker.mjs';
import { WechatOneBot } from './wechat-onebot.mjs';
import { createDesktopSenderEngine } from './desktop-sender/engine.mjs';
import { MAX_ACTIVE_DELIVERIES } from './desktop-sender/delivery-store.mjs';
import { DesktopSender } from './desktop-sender.mjs';

async function waitFor(predicate) {
  for (let n = 0; n < 200; n++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail('Desktop queue did not reach the expected state');
}

async function fixture(t, { additionalGroups = [], probeAccount } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-deadline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const key = 'wechat:group:fixture@chatroom',
    sender = 'review_admin',
    accountRef = 'a'.repeat(64);
  const groups = ['fixture@chatroom', ...additionalGroups];
  const keys = groups.map(group => 'wechat:group:' + group);
  const config = {
    runtime: { sender: 'wechat-ui' },
    input: {
      controlMode: 'ocr',
      operationTimeoutMs: 0,
      receiptTimeoutMs: 10000,
      idleMs: 0,
    },
    wechat: {
      whitelist: { groups, private: [] },
      workModes: Object.fromEntries(keys.map(key => [key, 'assistant'])),
      assistant: { administrators: [sender] },
    },
  };
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write(path.join(root, 'config/wechatagent.json'), config);
  write(path.join(root, 'state/weflow/active-account.json'), { id: accountRef });
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'report.txt'), 'deadline fixture');
  const store = new FileTransfers(root);
  const queue = target => store.queue({ key: target, sender, cwd, file: 'report.txt', batchId: 'b'.repeat(64) });
  const { id } = await queue(key);
  const source = store.read(id);
  source.deadlineAt = source.createdAt + 1000;
  store.write(source);
  const state = { now: source.createdAt, ready: false, receipt: false, pastes: 0, submits: 0 };
  const now = () => state.now;
  const account = {
    account: 'fixture_account',
    accountWxid: 'fixture_self',
    accountRef,
    accountDirectory: path.join(root, 'account'),
  };
  let engine;
  const senderBridge = { engine: async () => engine, pending: 0 };
  const adapter = {
    directory: root,
    account: account.account,
    accountRef,
    status: { file_send: true, paused: false, confirmed_sends: 0 },
    checkNative: async () => account,
    receiptAccount: () => WechatOneBot.prototype.receiptAccount.call(adapter),
    lookupTarget: async (_kind, target) => ({ wxid: target }),
    dispatchDesktop: (operation, body, _account, options) =>
      DesktopSender.prototype.request.call(senderBridge, operation, body, options),
    desktopSender: { request: (operation, body) => engine.request(operation, body) },
  };
  const options = {
    root,
    config,
    now,
    probeAccount: async ({ request }) => {
      if (probeAccount) await probeAccount(request);
      return account;
    },
    resolveTarget: async (_kind, target) => ({ wxid: target, name: 'fixture' }),
    authorizeCurrent: (job, forInput) => WechatOneBot.prototype.authorizeDesktopCurrent.call(adapter, job, forInput),
    authorize: async () => ({ allowed: true, grantId: 'c'.repeat(64), version: 1 }),
    receipt: async (_job, request) =>
      request.phase === 'prepare'
        ? { prepared: true, submissionAllowed: true, baselineId: 'fixture' }
        : request.phase === 'submitted'
          ? { recorded: true }
          : state.receipt
            ? {
                confirmed: true,
                receipt: {
                  source: 'wechat-server-id',
                  localId: state.weakReceipt ? '9' : '10',
                  serverId: state.weakReceipt ? '9999' : '10000',
                  fileName: source.name,
                  fileSize: source.size,
                  ...(state.weakReceipt ? {} : { fileMd5: source.md5 }),
                  fileContentMd5Matched: !state.weakReceipt,
                },
              }
            : { confirmed: false },
    driverFactory: async () => ({
      prepare: async () => {
        if (state.expireDuringPrepare) state.now = source.deadlineAt + 1;
        return { ready: state.ready };
      },
      observe: async job => ({
        ready: state.ready,
        account: job.account,
        target: job.target,
        foreground: true,
        idleMs: 9999,
        draft: '',
        editorToken: 'editor',
        activityRevision: 'activity',
      }),
      pasteImage: async (_job, _guard, local) => {
        assert.equal(local.canInput(), true);
        state.pastes++;
        if (state.expireAfterPaste) state.now = source.deadlineAt + 1;
        return { performed: true, attempted: true };
      },
      submitImage: async (_job, _guard, local) => {
        assert.equal(local.canSubmit(), true);
        state.submits++;
        return { performed: true, attempted: true };
      },
      releaseTextFocus: async () => ({ released: false, skipped: true }),
      close: async () => {},
    }),
  };
  engine = createDesktopSenderEngine(options);
  t.after(() => engine.close());
  const worker = new FileDeliveryWorker(adapter, { now });
  const snapshot = () => engine.query(id, true);
  return {
    root,
    config,
    store,
    id,
    adapter,
    queue,
    state,
    source,
    snapshot,
    worker,
    run: () => worker.run(store.read(id)),
    kick: () => engine.kick(),
    nativeContext: () => engine.context(),
    archive: outcome => {
      const [context] = engine.contexts.values();
      const [row] = context.metadata.values();
      context.store.retire(row, outcome);
    },
    restart: async () => {
      await engine.close();
      engine = createDesktopSenderEngine(options);
    },
  };
}

for (const expired of [false, true]) {
  test(
    'a file waiting for desktop queue capacity preserves its original scope and deadline, expired=' + expired,
    async t => {
      const f = await fixture(t);
      f.source.deadlineAt = f.source.createdAt + 60000;
      f.store.write(f.source);
      const { store } = await f.nativeContext();
      for (let n = 0; n < MAX_ACTIVE_DELIVERIES; n++) store.activeIds.add(n.toString(16).padStart(64, '0'));

      await f.run();
      const queued = f.store.read(f.id);
      const staged = f.store.staged(queued);
      assert.equal(queued.state, 'queued');
      assert.equal(queued.error, 'DESKTOP_STORAGE_LIMIT');
      assert.equal(queued.deadlineAt, f.source.deadlineAt);
      assert.equal(Boolean(queued.nativeAdmitted), false);
      assert.equal(Boolean(queued.dispatchPending), false);
      assert.equal(f.state.submits, 0);

      if (expired) {
        f.state.now = queued.deadlineAt;
        await f.run();
        assert.equal(f.store.read(f.id).state, 'expired');
        assert.equal(fs.existsSync(staged), false);
        assert.equal(f.state.submits, 0);
        return;
      }

      const control = { id: queued.id, key: queued.key, account: queued.accountScope };
      f.store.controlDelivery({ ...control, revision: 0, operation: 'pause' });
      await f.restart();
      Object.assign(f.state, { ready: true, receipt: true });
      await f.run();
      assert.equal(f.store.read(f.id).queuePaused, true);
      assert.equal(f.state.submits, 0);
      f.store.controlDelivery({ ...control, revision: 1, operation: 'resume' });
      await f.run();
      await waitFor(() => f.state.submits === 1);
      await f.run();
      assert.equal(f.store.read(f.id).state, 'confirmed');
      assert.equal((await f.snapshot()).deliveryId, queued.id);
      assert.equal(f.state.submits, 1);
    },
  );
}

test('pending desktop results and slow file receipts do not use the slots for new files', async t => {
  const f = await fixture(t, { additionalGroups: ['second@chatroom', 'third@chatroom'] });
  f.config.input.operationTimeoutMs = 20000;
  f.source.deadlineAt = f.source.createdAt + 120000;
  f.store.write(f.source);
  const second = await f.queue('wechat:group:second@chatroom');
  const firstTwo = new Set([f.id, second.id]);
  const accepted = id => {
    const job = f.store.read(id);
    return job.nativeAdmitted && !job.dispatchPending;
  };
  f.worker.tick();
  await waitFor(() => [...firstTwo].every(accepted) && f.worker.running.size === 0);

  const receipts = Promise.withResolvers();
  const request = f.adapter.desktopSender.request;
  let checks = 0;
  f.adapter.desktopSender.request = async (operation, body) => {
    if (operation === 'lookup' && firstTwo.has(body.deliveryId)) {
      checks++;
      await receipts.promise;
    }
    return request(operation, body);
  };
  const third = await f.queue('wechat:group:third@chatroom');
  try {
    f.worker.tick();
    await waitFor(() => checks === 2 && accepted(third.id));
    assert.equal(f.worker.receiptChecks.size, 2);
    assert.equal(f.state.pastes, 0);
  } finally {
    receipts.resolve();
    await waitFor(() => f.worker.running.size === 0);
  }
});

test('polling an admitted file can finish during a different chat admission', async t => {
  const other = 'second@chatroom';
  const gate = Promise.withResolvers();
  let blocked = false;
  const f = await fixture(t, {
    additionalGroups: [other],
    probeAccount: async request => {
      if (request.target !== other) return;
      blocked = true;
      await gate.promise;
    },
  });
  await f.run();
  assert.equal(f.store.read(f.id).nativeAdmitted, true);
  assert.equal(f.store.read(f.id).dispatchPending, undefined);
  await waitFor(async () => (await f.snapshot()).state === 'waiting');

  const ready = f.adapter.checkNative;
  f.adapter.checkNative = async () => {
    await f.nativeContext();
    return ready();
  };
  const second = await f.queue('wechat:group:' + other);
  const admission = f.worker.run(f.store.read(second.id));
  let poll;
  try {
    await waitFor(() => blocked);
    poll = f.run();
    const completed = await Promise.race([
      poll.then(() => true),
      new Promise(resolve => setImmediate(() => resolve(false))),
    ]);
    assert.equal(completed, true);
    assert.equal(f.store.read(f.id).nativeState, 'waiting');
    assert.equal(f.store.read(f.id).error, 'UI_DRIVER_UNAVAILABLE');
  } finally {
    gate.resolve();
    await Promise.allSettled([admission, poll]);
  }
  assert.equal(f.state.pastes, 0);
  assert.equal(f.state.submits, 0);
});

test('a lost file acknowledgement can be recovered while desktop readiness is unavailable', async t => {
  const f = await fixture(t);
  const dispatch = f.adapter.dispatchDesktop;
  let attempts = 0;
  f.adapter.dispatchDesktop = async (...args) => {
    attempts++;
    await dispatch(...args);
    throw Error('admission acknowledgement lost');
  };
  try {
    await f.run();
    assert.equal(f.store.read(f.id).dispatchPending, true);
    f.adapter.checkNative = async () => {
      throw Error('READER_NOT_LISTENING');
    };
    await f.run();
    const saved = f.store.read(f.id);
    assert.equal(saved.nativeAdmitted, true);
    assert.equal(saved.dispatchPending, undefined);
    assert.equal(attempts, 1);
    assert.equal(f.state.pastes, 0);
    assert.equal(f.state.submits, 0);
  } finally {
    await f.restart();
  }
});

test('expired admitted files are cancelled without input, including after sender restart', async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.store.read(f.id).nativeAdmitted, true);
  await f.restart();
  f.state.now = f.source.deadlineAt + 1;
  f.state.ready = true;
  await f.run();
  await waitFor(async () => (await f.snapshot()).state === 'cancelled');
  await f.run();
  assert.equal(f.store.read(f.id).state, 'expired');
  assert.equal(f.state.pastes, 0);
  assert.equal(f.state.submits, 0);
});

test('global pause still expires an admitted file without starting desktop input', async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.store.read(f.id).nativeAdmitted, true);
  await f.restart();
  f.config.input.paused = true;
  f.state.now = f.source.deadlineAt + 1;
  f.state.ready = true;
  await f.run();
  await waitFor(async () => (await f.snapshot()).state === 'cancelled');
  await f.run();
  assert.equal(f.store.read(f.id).state, 'expired');
  assert.equal(f.state.pastes, 0);
  assert.equal(f.state.submits, 0);
});

test('a submitted file can confirm after the input deadline without another submission', async t => {
  const f = await fixture(t);
  f.state.ready = true;
  await f.run();
  await waitFor(() => f.state.submits === 1);
  f.state.now = f.source.deadlineAt + 1;
  f.state.receipt = true;
  await f.run();
  await waitFor(async () => (await f.snapshot()).confirmed);
  await f.run();
  assert.equal(f.store.read(f.id).state, 'confirmed');
  assert.equal(f.store.read(f.id).receipt.serverId, '10000');
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 1);
});

test('file delivery waits for a receipt with server evidence under the same id', async t => {
  const f = await fixture(t);
  f.state.ready = true;
  await f.run();
  await waitFor(() => f.state.submits === 1);
  f.state.receipt = true;
  await waitFor(async () => (await f.snapshot()).confirmed);

  const request = f.adapter.desktopSender.request;
  f.adapter.desktopSender.request = async (...args) => {
    const result = await request(...args);
    return { ...result, receipt: { ...result.receipt, source: 'local-preview' } };
  };
  await f.run();
  const saved = f.store.read(f.id);
  assert.equal(saved.nativeAdmitted, true);
  assert.notEqual(saved.state, 'confirmed');
  assert.equal(saved.receipt, undefined);
  assert.equal(saved.error, 'FILE_NATIVE_RECEIPT_INVALID');
  f.adapter.desktopSender.request = request;
  await f.restart();
  await f.run();
  assert.equal(f.store.read(f.id).receipt.serverId, '10000');
  assert.equal(f.store.read(f.id).state, 'confirmed');
  assert.equal(f.state.submits, 1);
});

test('the real file worker and archived desktop queue retain the unique file receipt without MD5', async t => {
  const f = await fixture(t);
  Object.assign(f.state, { ready: true, receipt: true, weakReceipt: true });
  await f.run();
  await waitFor(async () => (await f.snapshot()).confirmed);
  await f.run();
  const record = f.store.read(f.id);
  assert.equal(record.state, 'confirmed');
  assert.equal(record.receipt.fileContentMd5Matched, false);
  f.archive(await f.snapshot());
  await f.restart();
  f.state.weakReceipt = false;
  await f.run();
  assert.deepEqual(f.store.read(f.id).receipt, record.receipt);
  const archived = await f.snapshot();
  assert.equal(archived.receipt.serverId, '9999');
  assert.equal(archived.receipt.fileContentMd5Matched, false);
  assert.equal(f.state.submits, 1);
});

test('expiration during focus preparation refuses the first paste', async t => {
  const f = await fixture(t);
  f.state.ready = true;
  f.state.expireDuringPrepare = true;
  await f.run();
  await waitFor(async () => (await f.snapshot()).state === 'cancelled');
  await f.run();
  assert.equal(f.store.read(f.id).state, 'expired');
  assert.equal(f.state.pastes, 0);
});

test('expiration with an applied file draft preserves recovery and never submits or pastes again', async t => {
  const f = await fixture(t);
  f.state.ready = true;
  f.state.expireAfterPaste = true;
  await f.run();
  await waitFor(async () => (await f.snapshot()).recovery);
  const blocked = await f.snapshot();
  assert.equal(blocked.reason, 'DESKTOP_INPUT_EXPIRED');
  assert.equal(blocked.inputStarted, true);
  await f.restart();
  await f.run();
  await delay(50);
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 0);
  assert.ok(f.store.read(f.id).nativeRecovery);
});
