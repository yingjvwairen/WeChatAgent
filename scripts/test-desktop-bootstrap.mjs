import { QtEditorDraft } from './desktop-sender/qt-editor-draft.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  bootstrapDesktopSender,
  bootstrapBinding,
  checkedSearchPopup,
  createBootstrapAccountProbe,
  defaultSearchPopup,
} from './desktop-sender/bootstrap.mjs';
import { resolveQtBootstrapLayout } from './desktop-sender/qt-auto-layout.mjs';
import { QtActionsClient } from './desktop-sender/qt-visual-driver.mjs';

import { calibrateDesktop } from './desktop-sender/calibrate.mjs';
import { createLayoutAwareQtDriver, saveQtLayoutProfile } from './desktop-sender/qt-layout-profiles.mjs';

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'Weixin.exe');
  fs.writeFileSync(executable, 'fixture');
  const accountDirectory = path.join(root, 'fixture-account');
  fs.mkdirSync(path.join(accountDirectory, 'db_storage'), { recursive: true });
  const readerFile = path.join(root, 'state/weflow/WeFlow-config.json');
  fs.mkdirSync(path.dirname(readerFile), { recursive: true });
  fs.writeFileSync(readerFile, JSON.stringify({ dbPath: accountDirectory, myWxid: 'fixture-account' }));
  const binding = {
    hwnd: '101',
    pid: 123,
    threadId: 124,
    processCreatedFileTimeUtc: '134000000000000000',
    dpi: 120,
    clientRect: { ...rect(0, 0, 1000, 800), width: 1000, height: 800 },
    captureRect: { ...rect(0, 0, 1000, 800), width: 1000, height: 800 },
  };
  const account = {
    readOnly: true,
    account: 'fixture-account',
    accountWxid: 'wxid_fixture',
    accountRef: 'a'.repeat(64),
    accountDirectory,
    dbPath: accountDirectory,
    executable,
    executableVersion: '4.2.0.53',
    executableSha256: crypto.createHash('sha256').update('fixture').digest('hex'),
    binding,
  };
  const settings = { executable, expectedVersion: '4.2.0.53', controlMode: 'uia', idleMs: 2000 };
  const popupEvidence = {
    version: 1,
    source: 'search-results-observation-v1',
    accountRef: account.accountRef,
    executableVersion: account.executableVersion,
    executableSha256: account.executableSha256,
    popup: {
      version: 1,
      kind: 'search',
      className: 'fixture-search-window',
      ownerRelation: 'root-owned',
      ownerDepth: 1,
      style: 0,
      extendedStyle: 0,
    },
  };
  return { root, account, settings, popupEvidence, readerFile };
}
test('UIA bootstrap uses current geometry without aliases or empty-draft hashes', async t => {
  const options = fixture(t);
  let closed = 0,
    inspected = 0,
    probed = 0;
  const provider = {
    async inspectControls(seed, binding) {
      inspected++;
      assert.equal(seed.accountAlias, undefined);
      assert.equal(binding.clientRect.width, undefined);
      return {
        layout: {
          width: 1000,
          height: 800,
          dpi: 120,
          search: rect(60, 10, 250, 40),
          header: rect(300, 50, 900, 100),
          editor: rect(300, 500, 950, 700),
          send: rect(850, 740, 950, 780),
        },
        voice: { recordStartRect: rect(360, 720, 400, 750), toolbarRect: rect(300, 710, 950, 790) },
      };
    },
    async close() {
      closed++;
    },
  };
  const result = await bootstrapDesktopSender({
    ...options,
    createProvider: () => provider,
    nativeProbe: async request => {
      probed++;
      const checked = request.check();
      assert.equal(checked.account.accountRef, options.account.accountRef);
      return { accountRef: options.account.accountRef };
    },
  });
  assert.equal(result.config.layoutMode, 'uia-v1');
  assert.equal(result.config.accountAlias, undefined);
  assert.equal(result.config.layout.emptyEditorSha256, undefined);
  assert.equal(result.health.ready, true);
  assert.equal(inspected, 1);
  assert.equal(probed, 1);
  assert.equal(closed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.configFile, 'utf8')), result.config);
  await result.provider.close();
  assert.equal(closed, 1);
});
test('a new sender requires a search popup matching the active account', async t => {
  const options = fixture(t);
  assert.throws(() => checkedSearchPopup(options.account, undefined), /SEARCH_POPUP_REQUIRED/);
  const measured = defaultSearchPopup(options.account);
  assert.equal(measured.popup.className, 'Qt51514QWindowToolSaveBits');
  assert.equal(measured.popup.style, 369754112);
  assert.equal(measured.popup.extendedStyle, 524416);
  assert.equal(measured.popup.hwnd, undefined);
  assert.equal(measured.popup.rect, undefined);
  assert.throws(
    () => checkedSearchPopup(options.account, { ...options.popupEvidence, executableVersion: '4.1.15.56' }),
    /SEARCH_POPUP_REQUIRED/,
  );
  assert.throws(
    () =>
      checkedSearchPopup(options.account, {
        ...options.popupEvidence,
        popup: { ...options.popupEvidence.popup, ownerDepth: 2 },
      }),
    /SEARCH_POPUP_UNBOUND/,
  );
});
test('account probe binds current Reader directory and notices configuration or executable changes', async t => {
  const options = fixture(t),
    binding = bootstrapBinding(options.account);
  let nativeCalls = 0;
  const probe = createBootstrapAccountProbe({
    ...options,
    nativeProbe: async request => {
      nativeCalls++;
      request.check();
      return { evidence: 'fixture' };
    },
  });
  assert.deepEqual(await probe({ binding }), { evidence: 'fixture' });
  fs.writeFileSync(options.settings.executable, 'changed');
  await assert.rejects(probe({ binding }), /ACCOUNT_CHANGED/);
  assert.equal(nativeCalls, 2);
  await assert.rejects(probe({ binding, expectedAccountRef: 'b'.repeat(64) }), /ACCOUNT_CHANGED/);
});
test('failed native layout closes its own provider and does not save an invented config', async t => {
  const options = fixture(t);
  let closed = false;
  await assert.rejects(
    bootstrapDesktopSender({
      ...options,
      nativeProbe: async () => ({}),
      createProvider: () => ({
        async inspectControls() {
          throw Error('UIA_MODE_CONTROLS_UNAVAILABLE');
        },
        async close() {
          closed = true;
        },
      }),
    }),
    /CONTROLS_UNAVAILABLE/,
  );
  assert.equal(closed, true);
  assert.equal(
    fs.readdirSync(path.join(options.root, 'state/desktop')).some(file => file.startsWith('native-')),
    false,
  );
});
test('OCR bootstrap refuses clients that may send input before any screenshot', () => {
  assert.throws(
    () => resolveQtBootstrapLayout({ config: { sharedDesktop: true }, inspection: {}, client: { enableInput: true } }),
    /BOOTSTRAP_UNVERIFIED/,
  );
});

test('first OCR layout binds observed image/anchors and never invents an empty-draft hash', async t => {
  const f = fixture(t),
    binding = { ...bootstrapBinding(f.account), foreground: false };
  const seed = {
    version: 1,
    backend: 'qt-visual',
    sharedDesktop: true,
    account: f.account.accountWxid,
    accountRef: f.account.accountRef,
    executable: f.settings.executable,
    executableVersion: '4.2.0.53',
    executableSha256: f.account.executableSha256,
    hwnd: 'auto',
    idleMs: 2000,
    ocrBackend: 'windows',
    searchPopupCalibration: checkedSearchPopup(f.account, f.popupEvidence),
  };
  const directory = path.join(f.root, 'state/ui-host/qt-frames');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'qt-' + '1'.repeat(32) + '.png'),
    bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(1000, 16);
  bytes.writeUInt32BE(800, 20);
  fs.writeFileSync(file, bytes);
  const imageSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const layout = {
    header: rect(310, 40, 850, 90),
    profileOpen: rect(320, 45, 420, 70),
    search: rect(80, 40, 250, 80),
    selfOpen: rect(10, 40, 50, 80),
    editor: rect(303, 603, 977, 730),
    send: rect(910, 730, 970, 760),
    focusActivateRect: rect(500, 8, 560, 22),
  };
  const editorFrame = rect(300, 600, 980, 780),
    recordStartRect = rect(850, 730, 880, 760);
  const evidence = [
    { kind: 'long-navigation-divider', support: 1 },
    { kind: 'long-chat-divider', support: 1 },
    { kind: 'editor-rounded-frame', rect: editorFrame },
    { kind: 'search-label-and-control', confidence: 1 },
    { kind: 'send-label-and-control', confidence: 1 },
    { kind: 'record-template', score: 1 },
    { kind: 'self-avatar-component', rect: layout.selfOpen },
    { kind: 'chat-title-text', rect: layout.profileOpen, confidence: 1 },
  ];
  const inspection = {
    version: 1,
    readOnly: true,
    inputSent: false,
    focusChanged: false,
    clipboardAccessed: false,
    executableVersion: '4.2.0.53',
    executableSha256: f.account.executableSha256,
    binding,
  };
  const client = new QtActionsClient({
    root: f.root,
    config: { executable: f.settings.executable, executableSha256: f.account.executableSha256, hwnd: 'auto' },
    calibration: true,
    enableInput: false,
  });
  const commands = [];
  client.request = async action => {
    commands.push(action);
    if (action === 'inspectLayout') return inspection;
    assert.equal(action, 'captureLayout');
    return {
      readOnly: true,
      inputSent: false,
      focusChanged: false,
      authorizationGranted: false,
      binding,
      executableVersion: '4.2.0.53',
      pixelFormat: 'rgba-row-major-opaque-v1',
      regions: [],
      image: { file, sha256: imageSha256 },
    };
  };
  let pythonCalls = 0;
  const result = await resolveQtBootstrapLayout(
    { root: f.root, config: seed, inspection, client },
    {
      runPython: async request => {
        pythonCalls++;
        assert.equal(request.script, 'locate-wechat-layout.py');
        return {
          version: 1,
          ok: true,
          imageSha256,
          width: 1000,
          height: 800,
          dpi: 120,
          executableVersion: '4.2.0.53',
          readOnly: true,
          inputSent: false,
          emptyDraftAuthorized: false,
          identityVerified: false,
          recordingState: false,
          layout,
          evidence,
          anchors: { editorFrame, toolbar: rect(305, 730, 975, 776), recordStartRect },
        };
      },
    },
  );
  assert.equal(result.verified, true);
  assert.equal(result.config.layoutMode, 'adaptive-v1');
  assert.equal(result.config.layout.emptyEditorSha256, undefined);
  assert.equal(result.config.selfSurface, undefined);
  assert.equal(result.config.accountAlias, undefined);
  assert.equal(pythonCalls, 1);
  assert.deepEqual(commands, ['captureLayout', 'inspectLayout']);
  assert.equal(fs.existsSync(file), false);
});

test('measured layout, inactive focus and voice templates are reused by OCR bootstrap for only the same window geometry', async t => {
  const f = fixture(t),
    binding = bootstrapBinding(f.account),
    project = {
      runtime: { sender: 'wechat-ui' },
      input: { wechatExecutable: f.settings.executable, controlMode: 'ocr' },
    };
  fs.mkdirSync(path.join(f.root, 'config'));
  fs.writeFileSync(path.join(f.root, 'config/wechatagent.json'), JSON.stringify(project));
  const layout = {
    header: rect(310, 40, 850, 90),
    profileOpen: rect(320, 45, 420, 70),
    search: rect(80, 40, 250, 80),
    selfOpen: rect(10, 40, 50, 80),
    editor: rect(303, 603, 977, 730),
    send: rect(910, 735, 970, 765),
    pointerParkRect: rect(500, 8, 560, 22),
  };
  const inspection = {
    version: 1,
    readOnly: true,
    inputSent: false,
    focusChanged: false,
    clipboardAccessed: false,
    executableVersion: f.account.executableVersion,
    executableSha256: f.account.executableSha256,
    binding,
  };
  const createClient = options => {
    assert.equal(options.enableInput, false);
    return {
      async request(action, request) {
        if (action === 'inspectLayout') return inspection;
        if (action === 'inspectFocusActivation')
          return {
            readOnly: true,
            inputSent: false,
            focusChanged: false,
            clipboardAccessed: false,
            binding: { ...binding, foreground: false },
            rect: request.rect,
            stableObservations: 2,
            rgbaSha256: 'e'.repeat(64),
          };
        assert.equal(action, 'capture');
        return {
          pixelFormat: 'rgba-row-major-opaque-v1',
          inputSent: false,
          binding: { ...binding, foreground: true },
          executableVersion: f.account.executableVersion,
          regions: request.regions.map(rect => ({ rect, rgbaSha256: 'a'.repeat(64) })),
        };
      },
      close: async () => ({ processStopped: true }),
    };
  };
  const options = {
    root: f.root,
    save: true,
    inspectAccount: async () => f.account,
    createClient,
    nativeProbe: async options => options.check(),
  };
  await calibrateDesktop({ ...options, mode: 'plan', plan: { layout } });
  await assert.rejects(calibrateDesktop({ ...options, mode: 'plan', plan: { layout } }), /CALIBRATION_EXISTS/);
  await assert.rejects(
    calibrateDesktop({ ...options, mode: 'plan', plan: { layout: { ...layout, emptyEditorSha256: 'f'.repeat(64) } } }),
    /PLAN_INVALID/,
  );
  await calibrateDesktop({ ...options, mode: 'focus-plan', plan: { rect: layout.pointerParkRect } });
  const voice = {
    recordStartRect: rect(800, 735, 840, 765),
    mouseParkRect: layout.pointerParkRect,
    cancelRect: rect(380, 740, 410, 765),
    submitRect: rect(880, 740, 910, 765),
  };
  await calibrateDesktop({ ...options, mode: 'voice-plan', plan: voice });
  const boot = () =>
    bootstrapDesktopSender({
      ...f,
      ...options,
      settings: { ...f.settings, controlMode: 'ocr' },
      resolveOcr: async () => {
        throw Error('auto requested');
      },
    });
  const result = await boot();
  assert.equal(result.config.layout.emptyEditorSha256, 'a'.repeat(64));
  assert.deepEqual(result.config.voice.recordingUi.cancel, { rect: voice.cancelRect, rgbaSha256: 'a'.repeat(64) });
  assert.equal(result.config.layout.focusActivateRgbaSha256, 'e'.repeat(64));
  f.account.binding.dpi = 144;
  inspection.binding = { ...binding, dpi: 144 };
  await assert.rejects(boot(), /auto requested/);

  const stored = { ...result.config, layout: { ...result.config.layout, dpi: 144 }, idleMs: 1000 };
  delete stored.voice;
  saveQtLayoutProfile({ root: f.root, config: stored });
  const driver = createLayoutAwareQtDriver({
    root: f.root,
    config: { ...result.config, idleMs: 7000, sendKey: 'ctrl-enter' },
    driverFactory: ({ config }) => ({
      config,
      requestNative: async () => inspection,
      prepare: () => ({ config }),
      close: async () => {},
    }),
  });
  t.after(() => driver.close());
  const { config } = await driver.prepare({});
  assert.equal(config.layout.dpi, 144);
  assert.equal(config.sendKey, 'ctrl-enter');
  assert.equal(config.idleMs, 7000);
});

test(
  'first-use OCR measures a fresh editor and verifies it through the existing native draft protocol',
  { skip: !process.env.WECHATAGENT_TEST_PYTHON },
  async t => {
    const { root } = fixture(t);
    const stage = path.join(root, 'state/ui-host/qt-frames');
    const configDir = path.join(root, 'config');
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'distribution.json'),
      JSON.stringify({
        installed: true,
        desktopRuntime: true,
        ocrPython: process.env.WECHATAGENT_TEST_PYTHON,
      }),
    );
    const header = rect(200, 10, 700, 70),
      editor = rect(200, 430, 700, 540);
    const file = path.join(stage, 'qt-' + 'a'.repeat(32) + '.png');
    const { default: sharp } = await import('sharp');
    const color = [240, 240, 240, 255];
    const png = await sharp({
      create: { width: 800, height: 600, channels: 4, background: { r: 240, g: 240, b: 240, alpha: 1 } },
    })
      .png()
      .toBuffer();
    fs.writeFileSync(file, png);
    const region = bounds => ({
      rect: bounds,
      rgbaSha256: crypto
        .createHash('sha256')
        .update(Buffer.alloc((bounds.right - bounds.left) * (bounds.bottom - bounds.top) * 4, Buffer.from(color)))
        .digest('hex'),
    });
    const frame = {
      token: 'fixture',
      epoch: 'fixture',
      revision: 1,
      binding: {
        hwnd: '1',
        pid: 9,
        threadId: 3,
        processCreatedFileTimeUtc: '123',
        dpi: 120,
        clientRect: rect(0, 0, 800, 600),
        captureRect: rect(0, 0, 800, 600),
      },
      regions: [region(header), region(editor)],
    };
    const hashes = [frame.regions[1].rgbaSha256];
    const frames = {
      config: { layoutMode: 'adaptive-v1', layout: { header, editor }, idleMs: 0 },
      capture: async (_roles, withImage) =>
        withImage
          ? { ...frame, image: { file, sha256: crypto.createHash('sha256').update(png).digest('hex') } }
          : frame,
      transaction: { revision: 1 },
      invalidateFrame() {},
      regionDigest: value => value.regions[0].rgbaSha256,
    };
    const draft = new QtEditorDraft(
      frames,
      { preparationLease: () => null },
      {
        root,
        discardNativeFrameImage: () => fs.unlinkSync(file),
        requestNative: async (action, values) => {
          assert.equal(action, 'readDraft');
          assert.equal(values.emptyEditorSha256, hashes[0]);
          assert.deepEqual(values.emptyEditorSha256s, hashes);
          return {
            draft: '',
            draftVerified: true,
            emptyTemplateMatched: true,
            richContentVerified: true,
            clipboardRestored: true,
            revision: 1,
            emptyDraftPhaseProof: { version: 1, id: '1'.repeat(32), editorRect: editor, knownEmptySha256s: hashes },
          };
        },
        async verifyControlBinding() {},
      },
    );
    const verified = { draft: '', frame };
    await draft.verifyNew({ mode: 'text' }, verified);
    assert.deepEqual(verified.verifiedEmptyHashes, hashes);
    assert.equal(fs.existsSync(file), false);
  },
);
