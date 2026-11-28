import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createDesktopRuntimeDriver,
  inspectCableEndpoints,
  readCableEndpoints,
} from './desktop-sender/runtime-driver.mjs';
import { QtActionsClient } from './desktop-sender/qt-visual-driver.mjs';
import { resolveQtBootstrapLayout } from './desktop-sender/qt-auto-layout.mjs';
import { acquireDesktopQueue } from './desktop-sender/delivery-lock.mjs';
import { DesktopSender } from './desktop-sender.mjs';
import { checkedSearchPopup, defaultSearchPopup } from './desktop-sender/bootstrap.mjs';
import { recoverConversationBySearch } from './desktop-sender/qt-search-recovery.mjs';
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

function searchRecovery(f) {
  return {
    binding: f.account.binding,
    config: {
      version: 1,
      backend: 'qt-visual',
      sharedDesktop: true,
      account: f.account.accountWxid,
      accountRef: f.account.accountRef,
      executable: f.account.executable,
      executableVersion: f.account.executableVersion,
      executableSha256: f.account.executableSha256,
      hwnd: f.account.binding.hwnd,
      layoutMode: 'adaptive-v1',
      idleMs: 0,
      ocrBackend: 'windows',
      layout: { width: 1000, height: 800, dpi: 120, search: rect(85, 49, 260, 75) },
      searchPopupCalibration: checkedSearchPopup(f.account, defaultSearchPopup(f.account)),
    },
  };
}

function unavailableLayout(recovery) {
  return Object.assign(Error('UI_QT_CONVERSATION_LAYOUT_REQUIRED'), {
    code: 'UI_QT_CONVERSATION_LAYOUT_REQUIRED',
    searchRecovery: recovery,
  });
}

for (const mode of ['ocr', 'uia']) {
  test(mode + ' searches after a layout failure and prepares input only with a fresh full layout', async t => {
    const f = fixture(t);
    f.settings.controlMode = mode;
    const recovery = searchRecovery(f);
    const calls = [];
    const job = { id: 'fixture-job', account: f.account.accountWxid, target: 'wxid_fixture' };
    const driver = await createDesktopRuntimeDriver({
      ...f,
      resolveTarget: async native => ({
        wxid: native.target,
        name: 'Fixture target',
        uniqueSearchName: true,
        uniqueTitle: true,
      }),
      createOffscreen: () => ({ close: async () => {} }),
      bootstrap: async () => {
        calls.push('layout');
        if (!calls.includes('search')) throw unavailableLayout(recovery);
        return { config: { fullLayout: true }, health: { ready: true } };
      },
      recoverSearch: async ({ recovery: plan, job: target, canInput, resolveTarget }) => {
        calls.push('search');
        assert.equal(plan, recovery);
        assert.equal(target, job);
        assert.equal(canInput(), true);
        assert.equal((await resolveTarget(job)).wechatId, job.target);
      },
      createDriver: ({ config }) => {
        assert.equal(config.fullLayout, true);
        return {
          prepare: async target => {
            assert.equal(target, job);
            calls.push('prepare');
            return { ready: true };
          },
          close: async () => {},
        };
      },
    });
    try {
      assert.equal((await driver.prepare(job, { canInput: () => true })).ready, true);
      assert.deepEqual(calls, ['layout', 'search', 'layout', 'prepare']);
      await driver.prepare(job, { canInput: () => true });
      assert.deepEqual(calls, ['layout', 'search', 'layout', 'prepare', 'prepare']);
    } finally {
      await driver.close();
    }
  });
}

test('layout recovery waits for an authorized task and retries inspection without a second search', async t => {
  const f = fixture(t);
  f.settings.controlMode = 'uia';
  const recovery = searchRecovery(f);
  let searches = 0;
  const driver = await createDesktopRuntimeDriver({
    ...f,
    bootstrap: async () => {
      throw unavailableLayout(recovery);
    },
    recoverSearch: async () => {
      searches++;
    },
    recoverOffscreen: async () => {},
    createOffscreen: () => ({ setEnabled: async () => ({}), close: async () => {} }),
    createDriver: () => assert.fail('there is no fully verified input layout'),
  });
  try {
    assert.equal((await driver.applySettings()).applied, true);
    assert.equal((await driver.health({ verifyLayout: true })).layoutCheck.verified, false);
    await assert.rejects(
      driver.prepare({ id: 'fixture-job' }, { canInput: () => false }),
      /UI_QT_CONVERSATION_LAYOUT_REQUIRED/,
    );
    await assert.rejects(
      driver.prepare({ id: 'fixture-job', index: 1 }, { canInput: () => true }),
      /UI_QT_LAYOUT_CHANGED_WITH_DRAFT/,
    );
    assert.equal(searches, 0);
    await assert.rejects(
      driver.prepare({ id: 'fixture-job' }, { canInput: () => true }),
      /UI_QT_SEARCH_TRANSITION_UNCONFIRMED/,
    );
    assert.equal(searches, 1);
  } finally {
    await driver.close();
  }
});

test('the fallback search enters a verified query without enabling the message editor', async t => {
  const f = fixture(t);
  const recovery = searchRecovery(f);
  const binding = { ...recovery.binding, foreground: true };
  const query = 'fixture-target';
  const querySha256 = crypto.createHash('sha256').update(query).digest('hex');
  const actions = [];
  const frame = (token, popup) => ({
    pixelFormat: 'rgba-row-major-opaque-v1',
    epoch: '1'.repeat(32),
    revision: 1,
    idleMs: 100,
    token: token.repeat(32),
    binding,
    regions: [{ rect: recovery.config.layout.search, rgbaSha256: 'c'.repeat(64) }],
    ...(popup && {
      popup: {
        hwnd: '456',
        surfaceId: 'search',
        kind: 'search',
        ownerRelation: 'root-owned',
        stableObservations: 2,
        geometryMode: 'observed-v1',
        dpi: 120,
        clientRect: rect(0, 0, 200, 120),
        clientRectInRoot: rect(82, 44, 282, 164),
        windowRect: rect(92, 54, 292, 174),
      },
    }),
  });
  recovery.accountProbe = async ({ binding: observed }) => assert.equal(observed.hwnd, binding.hwnd);
  const prepareJob = { id: 'fixture-job', account: f.account.accountWxid, target: 'wxid_fixture' };
  await recoverConversationBySearch({
    root: f.root,
    recovery,
    job: prepareJob,
    resolveTarget: async () => ({
      wechatId: prepareJob.target,
      name: 'Fixture target',
      alias: query,
      ambiguous: false,
    }),
    canInput: () => true,
    createClient: ({ searchOnly, canNavigate }) => {
      assert.equal(searchOnly, true);
      assert.equal(canNavigate(), true);
      return {
        request: async (action, values) => {
          actions.push(action);
          switch (action) {
            case 'inspectFocusHandoff':
              return {
                ready: false,
                reason: 'QT_FOCUS_RETURN_WINDOW_REQUIRED',
                inputSent: false,
                clipboardAccessed: false,
                focusChanged: false,
              };
            case 'capture':
              return values.surface === 'main' ? frame('2') : frame('3', true);
            case 'chord':
              assert.equal(values.key, 'Control+F');
              assert.equal(values.token, '2'.repeat(32));
              return { performed: true, attempted: true, revision: 1 };
            case 'paste':
              assert.equal(values.scope, 'search');
              assert.equal(values.expectedText, query);
              return {
                performed: true,
                attempted: true,
                pasteApplied: true,
                readbackPerformed: false,
                intendedText: query,
                clipboardRestored: true,
                clipboardConsumerConfirmed: true,
                interrupted: false,
                revision: 1,
                postPasteFrame: frame('4', true),
                searchEnterProof: { version: 1, id: '5'.repeat(32), querySha256 },
              };
            case 'searchEnter':
              assert.equal(values.searchEnterProofId, '5'.repeat(32));
              assert.equal(values.querySha256, querySha256);
              return { performed: true, attempted: true, searchAccepted: true, revision: 1 };
            default:
              assert.fail('unexpected recovery action: ' + action);
          }
        },
        close: async () => {
          actions.push('close');
        },
      };
    },
  });
  assert.deepEqual(actions, ['inspectFocusHandoff', 'capture', 'chord', 'capture', 'paste', 'searchEnter', 'close']);
});

test('a search-only native client rejects editor actions and revoked navigation before spawning', async t => {
  const f = fixture(t);
  let approved = true;
  const client = new QtActionsClient({
    root: f.root,
    config: searchRecovery(f).config,
    enableInput: true,
    searchOnly: true,
    canNavigate: () => approved,
    spawnImpl: () => assert.fail('rejected requests cannot start a native process'),
  });
  try {
    await assert.rejects(client.request('paste', { scope: 'editor' }), /UI_QT_SEARCH_INPUT_NOT_AUTHORIZED/);
    await assert.rejects(client.request('submitTextEnter'), /UI_QT_SEARCH_INPUT_NOT_AUTHORIZED/);
    approved = false;
    await assert.rejects(client.request('chord', { key: 'Control+F' }), /UI_QT_SEARCH_INPUT_NOT_AUTHORIZED/);
  } finally {
    await client.close();
  }
});

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
test('an obscured OCR layout is exposed without a foreground handoff', async t => {
  const { root, account } = fixture(t);
  const logs = path.join(root, 'state/logs');
  fs.mkdirSync(logs);
  const { executable, executableVersion, binding, accountRef } = account;
  const executableSha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  const config = { executable, executableSha256, executableVersion, accountRef, sharedDesktop: true, idleMs: 1000 };
  const inspection = {
    version: 1,
    readOnly: true,
    focusChanged: false,
    inputSent: false,
    clipboardAccessed: false,
    executableVersion,
    executableSha256,
    binding,
  };
  const actions = [];
  const client = new QtActionsClient({
    root,
    config: { executable, executableSha256, hwnd: 'auto' },
    calibration: true,
    enableInput: false,
    layoutOnlyFocus: true,
    canCapture: () => true,
    spawnImpl: () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      child.stdin.on('data', data => {
        const { id, action } = JSON.parse(data);
        actions.push(action);
        queueMicrotask(() => {
          if (action === 'stop') {
            child.stdout.write(JSON.stringify({ id, ok: true, result: { stopped: true } }) + '\n');
            child.emit('close', 0, null);
          } else {
            const code = action === 'captureLayout' ? 'QT_WINDOW_OBSCURED' : 'QT_LAYOUT_SOURCE_ORDER_UNAVAILABLE';
            child.stdout.write(JSON.stringify({ id, ok: false, error: { code, attempted: false } }) + '\n');
          }
        });
      });
      return child;
    },
  });
  try {
    await assert.rejects(resolveQtBootstrapLayout({ root, config, inspection, client, allowFocusCapture: true }), {
      code: 'QT_LAYOUT_SOURCE_ORDER_UNAVAILABLE',
    });
  } finally {
    await client.close();
  }
  assert.deepEqual(actions, ['captureLayout', 'captureLayoutRaised', 'stop']);
  const diagnostic = path.join(logs, 'wechat-foreground.log');
  let rows = [];
  for (let n = 0; n < 100 && rows.length < 2; n++) {
    await delay(15);
    if (fs.existsSync(diagnostic))
      rows = fs
        .readFileSync(diagnostic, 'utf8')
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
  }
  assert.deepEqual(
    rows.map(row => [row.action, row.code]),
    [
      ['captureLayout', 'QT_WINDOW_OBSCURED'],
      ['captureLayoutRaised', 'QT_LAYOUT_SOURCE_ORDER_UNAVAILABLE'],
    ],
  );
  assert.equal(rows[0].client, rows[1].client);
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
