import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInputOperationsApi } from './console-input-operations.mjs';
import { timingMarkup, recoveryMarkup } from '../public/console/input-operations.js';
import { readerAccountId } from './reader-account-state.mjs';
import { applyStoppedOffscreen, publishRecovery } from './desktop-sender/operations.mjs';
import { createUiaOffscreenManager } from './desktop-sender/uia-offscreen.mjs';
import { acquireDesktopQueue } from './desktop-sender/delivery-lock.mjs';
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

test('operations remain account-bound and delegate recovery to the stopped-service backend', async () => {
  let account = 'one',
    stopped = false,
    recovered = 0;
  const api = createInputOperationsApi({
    root: 'fixture',
    account: () => account,
    assertStopped: () => {
      if (!stopped) throw Error('services active');
    },
    operations: {
      snapshotOperations: async ({ accountRef }) => ({
        measurements: [],
        recoveries: [{ id: 'draft-one', revision: 'r1', kind: 'draft', canRecover: stopped, accountRef }],
      }),
      recoverOperation: async request => {
        request.assertStopped();
        assert.equal(request.accountRef, 'one');
        assert.equal(request.acknowledgeDraftCleared, true);
        assert.equal(request.acknowledgeOutcomeReviewed, true);
        recovered++;
      },
    },
  });
  const state = await api.snapshot();
  assert.equal(state.account, 'one');
  assert.equal(recovered, 0);
  const request = {
    account: 'one',
    id: 'draft-one',
    revision: 'r1',
    acknowledgeDraftCleared: true,
    acknowledgeOutcomeReviewed: true,
  };
  await assert.rejects(api.recover(request), /services active/);
  assert.equal(recovered, 0);
  stopped = true;
  await api.recover(request);
  assert.equal(recovered, 1);
  account = 'two';
  await assert.rejects(api.recover(request), { status: 409 });
  assert.equal(recovered, 1);
  await assert.rejects(api.recover({ ...request, account: 'two', arbitraryPath: 'fixture' }), { status: 400 });
});

test('a snapshot cannot cross an account change during backend inspection', async () => {
  let account = 'one';
  const api = createInputOperationsApi({
    root: 'fixture',
    account: () => account,
    assertStopped() {},
    operations: {
      snapshotOperations: async () => {
        account = 'two';
        return { measurements: [], recoveries: [] };
      },
    },
  });
  await assert.rejects(api.snapshot(), { status: 409 });
});

test('stopped placement verifies the logged-in account and hands off the existing native window lease', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-stopped-placement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { dbPath: path.join(root, 'fixture'), myWxid: 'fixture' };
  const accountRef = readerAccountId(root, source);
  const state = path.join(root, 'state/weflow');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'WeFlow-config.json'), JSON.stringify(source));
  fs.writeFileSync(path.join(state, 'active-account.json'), JSON.stringify({ id: accountRef }));
  const binding = { hwnd: '101', pid: 500, processCreatedFileTimeUtc: '12345678901234567' };
  const calls = [];
  let databaseAccounts = ['fixture'];
  const config = {
    runtime: { sender: 'wechat-ui' },
    input: { controlMode: 'uia', offscreen: true, wechatExecutable: path.join(root, 'Weixin.exe') },
  };
  const options = {
    root,
    config,
    assertStopped: () => true,
    probe: async () => {
      assert.equal(acquireDesktopQueue(root), null);
      return { readOnly: true, version: '4.2.0.53', databaseAccounts, ...binding };
    },
    createOffscreen: placementOptions =>
      createUiaOffscreenManager({
        ...placementOptions,
        createHost: () => ({
          request: async (action, values) => {
            calls.push(action);
            if (action === 'park-explicit') {
              assert.deepEqual(values.binding, {
                version: 1,
                executable: config.input.wechatExecutable,
                ...binding,
              });
            }
            return { parked: true, binding };
          },
          close: async () => calls.push('close'),
        }),
      }),
  };
  const parked = await applyStoppedOffscreen(options);
  assert.equal(parked.windowState.parked, true);
  assert.deepEqual(calls, ['park-explicit', 'handoff-offline', 'close']);
  databaseAccounts = ['different-fixture'];
  await assert.rejects(applyStoppedOffscreen(options), /DESKTOP_ACCOUNT_CHANGED/);
  const lease = acquireDesktopQueue(root);
  try {
    await assert.rejects(applyStoppedOffscreen(options), /DESKTOP_QUEUE_BUSY/);
  } finally {
    lease.release();
  }
  publishRecovery({
    root,
    accountRef,
    id: 'c'.repeat(64),
    kind: 'draft',
    reason: 'FIXTURE_DRAFT',
    state: { entered: true },
  });
  await assert.rejects(applyStoppedOffscreen(options), /DESKTOP_CONFIGURATION_INPUT_PENDING/);
  assert.equal(calls.length, 3);
});

test('foreground display reports each uninterrupted phase rather than cumulative occupation', () => {
  const html = timingMarkup(
    [
      {
        operation: 'voice',
        complete: true,
        maxContinuousForegroundMs: 720,
        includesContactNavigation: true,
        intervals: [
          { phase: 'contact-navigation', durationMs: 720, complete: true },
          { phase: 'record-start', durationMs: 320, complete: true },
          { phase: 'record-submit', durationMs: 490, complete: false },
        ],
      },
    ],
    esc,
  );
  assert.match(html, /最长一次 0.720 秒（含联系人切换）/);
  assert.match(html, /切换联系人 · 0.720 秒/);
  assert.match(html, /开始录音 · 0.320 秒/);
  assert.match(html, /发送语音 · 0.490 秒（记录不完整）/);
  assert.doesNotMatch(html, /1.530/);
});

test('draft and recording recovery expose separate acknowledgements and escape backend reasons', () => {
  const html = recoveryMarkup(
    [
      { id: 'draft', kind: 'draft', canRecover: true, reason: '<fixture>' },
      { id: 'voice', kind: 'recording', canRecover: true },
      { id: 'running', kind: 'draft', canRecover: false },
    ],
    esc,
  );
  assert.match(html, /&lt;fixture&gt;/);
  assert.match(html, /data-operation-ack="draft"/);
  assert.match(html, /data-operation-ack="recording"/);
  assert.equal([...html.matchAll(/data-operation-recover=/g)].length, 2);
  assert.match(html, /停止后台发送服务/);
});

test('a proven non-recording focus failure asks about window ownership rather than an open recorder', () => {
  const html = recoveryMarkup(
    [
      {
        id: 'focus',
        kind: 'draft',
        canRecover: true,
        focusRecoveryRequired: true,
        message: '本段未录音，焦点需恢复。',
      },
    ],
    esc,
  );
  assert.match(html, /窗口焦点待恢复/);
  assert.match(html, /键盘焦点正常/);
  assert.doesNotMatch(html, /录音界面已关闭|清理.*草稿/);
});
