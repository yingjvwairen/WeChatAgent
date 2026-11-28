import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createDesktopRuntimeDriver,
  inspectCableEndpoints,
  readCableEndpoints,
} from './desktop-sender/runtime-driver.mjs';
import { QtActionsClient } from './desktop-sender/qt-visual-driver.mjs';
import { unborrowedLayoutRefusal } from './desktop-sender/qt-auto-layout.mjs';
import { acquireDesktopQueue } from './desktop-sender/delivery-lock.mjs';
import { DesktopSender } from './desktop-sender.mjs';
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-layout-lazy-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true });
  });
  for (const relative of [
    'Weixin.exe',
    'state/ui-host/WechatQtActions.exe',
    'state/ui-host/WechatAccountProbe.exe',
    'state/ui-host/WechatVisualProbe.exe',
    'state/ui-host/WechatBackgroundControls.exe',
    'state/ui-host/WechatAccessibilityGate42053.exe',
    'state/ocr/venv/Scripts/python.exe',
  ]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  const account = {
    readOnly: true,
    account: 'self',
    accountRef: 'a'.repeat(64),
    accountWxid: 'wxid_self',
    executable: path.join(root, 'Weixin.exe'),
    executableVersion: '4.2.0.53',
    executableSha256: 'b'.repeat(64),
    binding: {
      hwnd: '123',
      pid: 12,
      threadId: 13,
      processCreatedFileTimeUtc: '134000000000000000',
      dpi: 120,
      clientRect: rect(0, 0, 1000, 800),
      captureRect: rect(10, 10, 1010, 810),
    },
  };
  return {
    root,
    account,
    settings: {
      wechatExecutable: account.executable,
      controlMode: 'ocr',
      voiceSend: false,
      expectedVersion: '4.2.0.53',
    },
  };
}
test('OCR health does not acquire focus or require an unobscured screenshot', async t => {
  const f = fixture(t);
  let bootstraps = 0,
    prepares = 0;
  const driver = await createDesktopRuntimeDriver({
    ...f,
    resolveTarget: async () => {},
    recoverOffscreen: async () => {},
    createOffscreen: () => ({ close: async () => {} }),
    bootstrap: async options => {
      bootstraps++;
      assert.equal(options.allowFocusCapture, true);
      assert.equal(options.canCapture(), true);
      return { config: {}, health: { ready: true } };
    },
    createDriver: () => ({
      prepare: async () => {
        prepares++;
        return { ready: true };
      },
      observe: () => ({ ready: true }),
      close: async () => {},
    }),
  });
  assert.equal((await driver.health()).layoutPending, true);
  assert.equal(bootstraps, 0);
  assert.equal(driver.observe({}).ready, false);
  await assert.rejects(driver.prepare({}, {}), /DESKTOP_BOOTSTRAP_CAPTURE_NOT_ALLOWED/);
  assert.equal(bootstraps, 0);
  await driver.prepare({ id: 'own-job' }, { canInput: () => true });
  assert.equal(bootstraps, 1);
  assert.equal(prepares, 1);
  assert.equal((await driver.health()).layoutPending, false);
  await driver.close();
});
test('read-only sender preflight can run while the running service owns the queue', async t => {
  const f = fixture(t);
  const sender = new DesktopSender(f.root);
  sender.config = () => ({ runtime: { sender: 'wechat-ui' }, input: f.settings });
  sender.probeAccount = async () => f.account;
  const lease = acquireDesktopQueue(f.root);
  assert.ok(lease);
  try {
    const result = await sender.request('health', { probeOnly: true, account: f.account.account });
    assert.equal(result.ready, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.layoutPending, true);
    assert.equal(acquireDesktopQueue(f.root), null);
  } finally {
    await sender.close();
    lease.release();
  }
});
test('the explicit layout check reports proof or a refusal without preparing input', async t => {
  const f = fixture(t);
  let reject = true;
  const driver = await createDesktopRuntimeDriver({
    ...f,
    ensureAccessibility: () => assert.fail('a diagnostic never enables accessibility'),
    createDriver: () => assert.fail('a diagnostic must never create the input driver'),
    bootstrap: async options => {
      assert.equal(options.persistLayout, false);
      assert.equal(options.allowFocusCapture, undefined);
      assert.equal(options.ensureAccessibility, undefined);
      if (reject) throw Object.assign(Error(), { code: 'UI_QT_LAYOUT_THEME_UNSUPPORTED' });
      return { layoutSource: 'ocr' };
    },
  });
  try {
    const refused = await driver.health({ verifyLayout: true });
    assert.equal(refused.layoutPending, true);
    assert.deepEqual(refused.layoutCheck, { verified: false, reason: 'UI_QT_LAYOUT_THEME_UNSUPPORTED' });
    reject = false;
    const checked = await driver.health({ verifyLayout: true });
    assert.equal(checked.layoutPending, false);
    assert.deepEqual(checked.layoutCheck, { verified: true, source: 'ocr' });
    assert.equal(driver.observe({}).ready, false);
  } finally {
    await driver.close();
  }
});

test('a fixed CABLE pair detects re-enumerated endpoints and still requires all default roles', async () => {
  const pair = { renderId: 'fixture-render', captureId: 'fixture-capture' };
  const report = {
    ok: true,
    mode: 'list',
    audioStarted: false,
    devices: [
      { flow: 'render', eligible: true, id: pair.renderId },
      { flow: 'capture', eligible: true, id: pair.captureId },
    ],
    defaultCapture: Object.fromEntries(
      ['console', 'multimedia', 'communications'].map(role => [role, { device: { id: pair.captureId } }]),
    ),
  };
  const executeImpl = async (_program, args) => {
    assert.deepEqual(args, ['--list']);
    return { stdout: JSON.stringify(report) };
  };
  assert.deepEqual(await inspectCableEndpoints('fixture', { executeImpl }), { pair, defaultsReady: true });
  assert.deepEqual(await readCableEndpoints('fixture', { executeImpl, binding: pair }), pair);
  await assert.rejects(
    readCableEndpoints('fixture', { executeImpl, binding: { ...pair, renderId: 'old-render' } }),
    /DESKTOP_CABLE_BINDING_CHANGED/,
  );
  report.defaultCapture.communications.device.id = 'fixture-microphone';
  await assert.rejects(readCableEndpoints('fixture', { executeImpl }), /AUDIO_DEFAULT_CAPTURE_NOT_CABLE/);
  report.devices.push({ flow: 'render', eligible: true, id: 'ambiguous-render' });
  await assert.rejects(readCableEndpoints('fixture', { executeImpl }), /DESKTOP_CABLE_ENDPOINT_REQUIRED/);
});
test('a layout-only calibration client refuses every message/clipboard action before starting', async t => {
  const f = fixture(t);
  let spawned = 0;
  const client = new QtActionsClient({
    root: f.root,
    config: { executable: f.account.executable, executableSha256: f.account.executableSha256, hwnd: 'auto' },
    calibration: true,
    enableInput: false,
    layoutOnlyFocus: true,
    canCapture: () => true,
    spawnImpl: () => {
      spawned++;
      throw Error('must not start');
    },
  });
  for (const action of [
    'paste',
    'pasteFile',
    'typeText',
    'click',
    'chord',
    'beginFocusHandoff',
    'readDraft',
    'submitTextEnter',
  ])
    await assert.rejects(client.request(action), /UI_QT_LAYOUT_ONLY/);
  assert.equal(spawned, 0);
  await client.close();
});
test('revoked capture authorization refuses even a layout request without touching native state', async t => {
  const f = fixture(t);
  const client = new QtActionsClient({
    root: f.root,
    config: { executable: f.account.executable, executableSha256: f.account.executableSha256, hwnd: 'auto' },
    calibration: true,
    enableInput: false,
    layoutOnlyFocus: true,
    canCapture: () => false,
  });
  await assert.rejects(client.request('captureLayoutHandoff'), /UI_TARGET_NOT_ALLOWED/);
  assert.equal(client.child, null);
  await client.close();
});
test('File Transfer voice uses authorized preparation like private and group targets', async t => {
  const f = fixture(t);
  let initialized = 0;
  const prepared = [];
  const driver = await createDesktopRuntimeDriver({
    ...f,
    resolveTarget: async () => {},
    recoverOffscreen: async () => {},
    createOffscreen: () => ({ close: async () => {} }),
    bootstrap: async () => {
      initialized++;
      return { config: {}, health: { ready: true } };
    },
    createDriver: () => ({
      prepareVoiceHandoff: async job => {
        prepared.push(job.target);
        return { ready: true };
      },
      prepareVoiceSession: async job => ({ target: job.target }),
      close: async () => {},
    }),
  });
  await driver.health();
  assert.equal(initialized, 0);
  await assert.rejects(
    driver.prepareVoiceHandoff({ target: 'filehelper' }, { canInput: () => false }),
    /DESKTOP_BOOTSTRAP_CAPTURE_NOT_ALLOWED/,
  );
  for (const target of ['filehelper', 'wxid_friend', 'room@chatroom'])
    assert.equal((await driver.prepareVoiceHandoff({ target }, { canInput: () => true })).ready, true);
  assert.deepEqual(await driver.prepareVoiceSession({ target: 'filehelper' }, { canInput: () => true }), {
    target: 'filehelper',
  });
  assert.equal(initialized, 1);
  assert.deepEqual(prepared, ['filehelper', 'wxid_friend', 'room@chatroom']);
  await driver.close();
});
test('layout visibility fallback requires a proven no-input, unborrowed API refusal', () => {
  const error = {
    code: 'QT_FOCUS_ACQUIRE_UNCONFIRMED',
    attempted: false,
    focusConfirmation: { attempted: true, accepted: false, confirmed: false, reason: 'request-rejected' },
    focusRestoreOutcome: {
      reason: 'foreground-not-wechat',
      foregroundOwnedByWechat: false,
      restored: false,
      skipped: true,
      identitiesUnchanged: true,
      activityUnchanged: true,
      keysReleased: true,
    },
  };
  assert.equal(unborrowedLayoutRefusal(error), true);
  for (const changed of [
    { attempted: true },
    { code: 'QT_HUMAN_ACTIVITY_CHANGED' },
    { focusConfirmation: { ...error.focusConfirmation, accepted: true } },
    { focusRestoreOutcome: { ...error.focusRestoreOutcome, activityUnchanged: false } },
    { focusRestoreOutcome: { ...error.focusRestoreOutcome, identitiesUnchanged: false } },
    { focusRestoreOutcome: { ...error.focusRestoreOutcome, restored: true } },
  ])
    assert.equal(unborrowedLayoutRefusal({ ...error, ...changed }), false);
});

test('explicit settings apply parks only a fresh UIA executor; health and lazy OCR do not acquire input', async t => {
  const f = fixture(t),
    moves = [],
    client = { child: null };
  let bootstraps = 0,
    recoveries = 0;
  const options = {
    ...f,
    resolveTarget: async () => {},
    recoverOffscreen: async () => {
      recoveries++;
    },
    createOffscreen: () => ({
      setEnabled: async request => {
        moves.push(request.enabled);
        return { parked: request.enabled };
      },
      close: async () => {},
    }),
    bootstrap: async () => {
      bootstraps++;
      return { config: { fixture: true }, health: { ready: true } };
    },
    createDriver: () => ({
      get nativeRunning() {
        return !!client.child;
      },
      close: async () => {},
    }),
  };
  const uia = await createDesktopRuntimeDriver({
    ...options,
    settings: { ...f.settings, controlMode: 'uia', offscreen: true },
  });
  assert.equal((await uia.health()).ready, true);
  assert.deepEqual(moves, []);
  assert.equal(recoveries, 0);
  assert.equal(bootstraps, 0);
  assert.equal((await uia.applySettings()).applied, true);
  assert.deepEqual(moves, [true]);
  client.child = {};
  await assert.rejects(uia.applySettings(), /DESKTOP_CONFIGURATION_BUSY/);
  assert.deepEqual(moves, [true]);
  await uia.close();
  const ocr = await createDesktopRuntimeDriver(options);
  await ocr.health();
  await ocr.applySettings();
  assert.deepEqual(moves, [true, false]);
  assert.equal(bootstraps, 1);
  assert.equal(recoveries, 2);
  await ocr.close();
});
