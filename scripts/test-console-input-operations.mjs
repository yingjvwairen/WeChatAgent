import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputOperationsApi } from './console-input-operations.mjs';
import { timingMarkup, recoveryMarkup } from '../public/console/input-operations.js';
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
