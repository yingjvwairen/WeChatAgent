import { QtEditorDraft } from './desktop-sender/qt-editor-draft.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QtActionsClient,
  QtVisualDriver,
  validForegroundSession,
  validForegroundSessionRelease,
} from './desktop-sender/qt-visual-driver.mjs';

const r = (left, top, right, bottom) => ({ left, top, right, bottom });
const session = () => ({
  version: 1,
  inPlace: true,
  sessionId: 'a'.repeat(32),
  window: { hwnd: '100', pid: 42, processCreatedFileTimeUtc: '12345' },
  revision: 2,
  activated: false,
  inputSent: false,
  focusChanged: false,
  clipboardAccessed: false,
});
const released = () => ({
  version: 1,
  inPlace: true,
  sessionId: 'a'.repeat(32),
  released: true,
  restored: false,
  skipped: true,
  inputSent: false,
  focusChanged: false,
  clipboardAccessed: false,
  identitiesUnchanged: true,
  foregroundOwnedByWechat: true,
  activityUnchanged: true,
});
function fixture(t, { recording = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uia-inplace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const config = {
    version: 1,
    backend: 'qt-visual',
    account: 'wxid_self',
    accountRef: 'a'.repeat(64),
    executable: path.resolve('Weixin.exe'),
    executableVersion: '4.2.0.53',
    executableSha256: 'b'.repeat(64),
    hwnd: '100',
    idleMs: 1000,
    ocrBackend: 'windows',
    layoutMode: 'uia-v1',
    focusActivationMode: 'uia-caption-v1',
    searchPopupCalibration: {
      version: 1,
      kind: 'search',
      className: 'QtFixtureWindow',
      ownerRelation: 'same-thread-unowned',
      ownerDepth: 0,
      style: -2147483648,
      extendedStyle: 128,
    },
    layout: {
      width: 800,
      height: 600,
      dpi: 96,
      header: r(310, 20, 600, 60),
      search: r(80, 20, 260, 60),
      editor: r(300, 450, 780, 550),
      send: r(700, 560, 780, 590),
    },
  };
  if (recording)
    config.voice = {
      recordStartRect: r(380, 400, 410, 424),
      recordingUi: { focusHwnd: 'same', uia: { version: 1, executableVersion: '4.2.0.53' } },
    };
  const binding = {
    hwnd: '100',
    pid: 42,
    threadId: 43,
    processCreatedFileTimeUtc: '12345',
    dpi: 96,
    clientRect: r(0, 0, 800, 600),
    captureRect: r(100, 100, 900, 700),
    foreground: true,
  };
  const fingerprint = {
    version: 1,
    scope: 'chat-title-text-v1',
    sha256: 'b'.repeat(64),
    headerRuntimeIdSha256: 'c'.repeat(64),
    titleRuntimeIdSha256: 'd'.repeat(64),
    textNodeCount: 1,
    targetVerified: false,
  };
  const actions = [],
    client = {
      enableInput: true,
      closed: false,
      request: async (action, body) => {
        actions.push({ action, body });
        if (action === 'inspectFocusHandoff')
          return {
            ready: false,
            reason: 'QT_FOCUS_RETURN_WINDOW_REQUIRED',
            inputSent: false,
            clipboardAccessed: false,
            focusChanged: false,
          };
        if (action === 'checkClearMessageQuote') return { clear: true };
        if (action === 'attachMessageQuote')
          return { attached: true, quoteToken: 'e'.repeat(32), editorRect: config.layout.editor };
        if (action === 'inspectLayout')
          return {
            readOnly: true,
            inputSent: false,
            focusChanged: false,
            clipboardAccessed: false,
            executableVersion: config.executableVersion,
            executableSha256: config.executableSha256,
            binding,
          };
        if (action === 'beginForegroundSession') return session();
        if (action === 'releaseFocusHandoff') return released();
        if (action === 'captureUiaNavigation') return frame(['header'], { navigationOnly: true });
        if (action === 'captureUiaControls') return frame(['header', 'editor'], { uiaControlFrame: true });
        if (action === 'resumeUiaImage')
          return {
            resumed: true,
            readOnly: true,
            inputSent: false,
            focusChanged: false,
            clipboardAccessed: false,
            imagePasteProof: driver.textResume.uiaImageProof,
            frame: frame(['header', 'editor', 'send'], { uiaControlFrame: true }),
          };
        throw Error('unexpected native action ' + action);
      },
      close: async () => {
        client.closed = true;
      },
    };
  const driver = new QtVisualDriver({
    root,
    config,
    client,
    clientFactory: () => ({
      request: async (action, body) => {
        assert.equal(action, 'restoreTransferredFocus');
        actions.push({ action, body });
        return { restored: true, skipped: false };
      },
      close: async () => {},
    }),
    probeAccount: async () => {
      throw Error('missing synthetic account observation');
    },
    verifyControls: async () => ({ verified: true, proof: 'uia-controls-v1', conversationFingerprint: fingerprint }),
    controlVerificationPolicy: 'input-boundaries-v1',
    navigationPolicy: 'uia-controls-v1',
    resolveTarget: async job => ({
      wechatId: job.target,
      name: 'Fixture peer',
      searchName: 'Fixture peer',
      alias: 'peer123',
      uniqueSearchName: true,
      uniqueTitle: true,
      ambiguous: false,
    }),
    now: () => 1700000000000,
  });
  const frame = (roles = ['header', 'editor'], extra = {}) => ({
    token: 'f'.repeat(32),
    epoch: 'e'.repeat(32),
    revision: 2,
    idleMs: 99999,
    binding,
    inputSent: false,
    observationKind: 'uia-metadata-v1',
    pixelsRead: false,
    baselinePixelStable: false,
    regions: roles.map(role => ({ role, rect: config.layout[role], controlSha256: 'c'.repeat(64) })),
    ...extra,
  });
  // The window-bound control reader is mocked; the production prepare/release
  // orchestration and constructor policies run unchanged.
  driver.navigation.warmUiaLocators = async () => {};
  driver.freshAccount = async () => ({
    evidence: {
      ok: true,
      proof: 'process-open-database-v1',
      complete: true,
      processOpenedExpectedDatabase: true,
      processId: 42,
      processCreatedFileTimeUtc: '12345',
      observedAtUtc: new Date(driver.now()).toISOString(),
      maximumEvidenceAgeMs: 500,
      snapshotAtomic: false,
      accountRootsObserved: 1,
      consistentPathScans: 2,
      expectedDatabaseHandles: 1,
      ready: false,
      desktopAccountVerified: false,
      targetVerified: false,
      draftVerified: false,
      inputSent: false,
    },
  });
  driver.navigation.uiaConversationReady = async () => ({
    ready: true,
    proof: { conversationFingerprint: fingerprint },
  });
  driver.sharedAction = async action => {
    assert.equal(action, 'focusUiaEditor');
    assert.equal(driver.preparationLease().inPlace, true);
    return {
      performed: true,
      attempted: true,
      editorFocused: true,
      postFocusFrame: frame(['header', 'editor'], { uiaControlFrame: true }),
    };
  };
  driver.verifyControlBinding = async () => ({ conversationFingerprint: fingerprint });
  return {
    root,
    config,
    client,
    driver,
    actions,
    frame,
    binding,
    fingerprint,
    job: { id: 'd'.repeat(64), account: config.account, target: 'wxid_peer', text: 'hello', index: 0 },
  };
}

test('UIA already-foreground text, image, file and quote preparation owns a real in-place session without borrowing focus', async t => {
  for (const mode of ['text', 'image', 'file', 'quote']) {
    const f = fixture(t),
      job = {
        ...f.job,
        ...(mode === 'quote'
          ? { quote: { id: 'source', serverId: '1234', sender: 'wxid_peer', text: 'original' } }
          : { mode }),
      };
    assert.equal(
      (await f.driver.prepare(job, { interactionPlan: { executionMode: 'focus-handoff' }, textEntryMode: 'paste' }))
        .ready,
      true,
    );
    assert.equal(f.driver.textFocusLease.inPlace, true);
    assert.equal(f.driver.textFocusLease.handoff, undefined);
    const result = await f.driver.releaseTextFocus();
    assert.equal(result.inPlace, true);
    assert.equal(result.restored, false);
    assert.equal(result.foregroundIntervals, undefined);
    assert.equal(f.driver.foregroundIntervalsInvalid, false);
    assert.deepEqual(
      f.actions
        .filter(item => !['captureUiaNavigation', 'captureUiaControls'].includes(item.action))
        .map(item => item.action),
      [
        'inspectFocusHandoff',
        'inspectLayout',
        'beginForegroundSession',
        'checkClearMessageQuote',
        ...(mode === 'quote' ? ['attachMessageQuote'] : []),
        'releaseFocusHandoff',
      ],
    );
  }
});

test('the current sender refuses a retired foreground plan before any native operation', async t => {
  const f = fixture(t);
  await assert.rejects(f.driver.prepare(f.job, { interactionPlan: { executionMode: 'foreground' } }), {
    code: 'UI_QT_CONTROLS_POLICY_INVALID',
  });
  assert.deepEqual(f.actions, []);
});

test('only the driver owns mutable input state and finishing an old operation cannot unlock a newer one', t => {
  const { driver } = fixture(t);
  for (const field of [
    'busy',
    'current',
    'transaction',
    'nativeOwner',
    'textResume',
    'textFocusLease',
    'voiceFocusLease',
  ])
    assert.throws(() => {
      driver[field] = null;
    }, TypeError);
  assert.equal('client' in driver, false);
  assert.equal('request' in driver.nativeOwner, false);
  assert.equal(Object.isFrozen(driver.nativeOwner), true);
  const first = driver.beginOperation();
  assert.throws(() => driver.beginOperation(), { code: 'UI_QT_BUSY' });
  first();
  const second = driver.beginOperation();
  first();
  assert.equal(driver.busy, true);
  second();
  assert.equal(driver.busy, false);
});
test('an in-place session cannot park or transfer and retains no return-window capability in its protocol', () => {
  assert(validForegroundSession(session()));
  assert(validForegroundSessionRelease(released(), session().sessionId));
  for (const changed of [
    { activated: true },
    { focusChanged: true },
    { returnWindow: session().window },
    { revision: -1 },
  ])
    assert.equal(validForegroundSession({ ...session(), ...changed }), false);
  assert.equal(validForegroundSessionRelease({ ...released(), focusChanged: true }, session().sessionId), false);
  assert.equal(validForegroundSessionRelease(released(), 'b'.repeat(32)), false);
});
test('in-place background preparation stays in the same session without issuing a park or resume action', async t => {
  const f = fixture(t);
  await f.driver.prepare(f.job, { interactionPlan: { executionMode: 'focus-handoff' }, textEntryMode: 'paste' });
  const before = f.actions.length;
  assert.equal(await f.driver.withPreparationFocusParked(async () => 42), 42);
  assert.equal(f.actions.length, before);
  f.client.request = async action => {
    assert.equal(action, 'releaseFocusHandoff');
    return { ...released(), activityUnchanged: false, foregroundOwnedByWechat: false };
  };
  assert.equal((await f.driver.releaseTextFocus()).inPlace, true);
  assert.equal(f.driver.textFocusLease, null);
});
test('a read-only or layout-only native client cannot begin an input session', async t => {
  const f = fixture(t),
    client = new QtActionsClient({
      root: f.root,
      config: f.config,
      enableInput: false,
      spawnImpl: () => assert.fail('must not spawn'),
    });
  await assert.rejects(client.request('beginForegroundSession', { uiaMode: true }), /UI_QT_INPUT_DISABLED/);
  assert.equal(client.child, null);
});

test('an already-pasted UIA image or file resumes its native proof under an in-place session without pasting again', async t => {
  for (const format of ['static', 'gif', 'file']) {
    const f = fixture(t),
      job = {
        ...f.job,
        mode: format === 'file' ? 'file' : 'image',
        image: { path: 'fixture', sha256: 'b'.repeat(64), ...(format === 'static' ? {} : { format }) },
      };
    const proof = { version: 1, id: 'b'.repeat(32), imageSha256: job.image.sha256, imageFormat: format };
    f.driver.rememberPausedImage(
      {
        jobId: job.id,
        account: job.account,
        target: job.target,
        shared: true,
        draftPolicy: 'unchecked',
        imageApplied: job.id,
        imageSha256: job.image.sha256,
        binding: f.binding,
        epoch: 'e'.repeat(32),
        revision: 2,
        uiaImageProof: proof,
        uiaConversationFingerprint: f.fingerprint,
      },
      f.driver.nativeOwner,
    );
    assert.equal((await f.driver.resumeImage(job, { canInput: () => true })).ready, true);
    assert.equal(f.driver.textFocusLease.inPlace, true);
    assert.equal(f.driver.current.uiaImageProof.id, proof.id);
    assert.deepEqual(
      f.actions.map(item => item.action),
      ['inspectLayout', 'inspectFocusHandoff', 'beginForegroundSession', 'resumeUiaImage'],
    );
    await f.driver.releaseTextFocus();
  }
});

test('ordinary UIA borrowed-focus preparation retains the original handoff and return behavior', async t => {
  const f = fixture(t),
    request = f.client.request;
  f.driver.sharedAction = async action => {
    assert.equal(action, 'focusUiaEditor');
    assert.equal(f.driver.preparationLease().handoff.returnWindow.hwnd, '200');
    return {
      performed: true,
      attempted: true,
      editorFocused: true,
      postFocusFrame: f.frame(['header', 'editor'], { uiaControlFrame: true }),
    };
  };
  f.client.request = async (action, body) => {
    if (action === 'inspectFocusHandoff') {
      f.actions.push({ action, body });
      return { ready: true, reason: null, inputSent: false, focusChanged: false, clipboardAccessed: false };
    }
    if (action === 'beginFocusHandoff') {
      f.actions.push({ action, body });
      return {
        activated: true,
        focusHandoff: { version: 1, returnWindow: { hwnd: '200', pid: 99, processCreatedFileTimeUtc: '67890' } },
      };
    }
    if (action === 'releaseFocusHandoff') {
      f.actions.push({ action, body });
      return {
        restored: true,
        skipped: false,
        foregroundInterval: { phase: 'preparation', durationMs: 350, complete: true, includesContactNavigation: false },
      };
    }
    return request(action, body);
  };
  assert.equal(
    (await f.driver.prepare(f.job, { interactionPlan: { executionMode: 'focus-handoff' }, textEntryMode: 'paste' }))
      .ready,
    true,
  );
  assert.equal(f.driver.textFocusLease.inPlace, undefined);
  assert.equal(f.driver.textFocusLease.handoff.returnWindow.hwnd, '200');
  const result = await f.driver.releaseTextFocus();
  assert.equal(result.restored, true);
  assert.equal(result.foregroundIntervals[0].durationMs, 350);
  assert(!f.actions.some(row => row.action === 'beginForegroundSession'));
});

function recordingFixture(t, confirmed) {
  const f = fixture(t, { recording: true }),
    original = f.client.request;
  const returned = { hwnd: '200', pid: 99, processCreatedFileTimeUtc: '67890' };
  f.binding.focusHwnd = '101';
  f.binding.lastInputTick = 7;
  const handoff = { version: 1, returnWindow: returned };
  const owner = f.driver.nativeOwner;
  f.driver.probeAccount = async () => ({
    ...(await f.driver.freshAccount()),
    accountRef: f.config.accountRef,
    accountScopeHash: f.config.accountRef,
  });
  f.driver.sharedAction = async action => {
    assert.equal(action, 'focusUiaEditor');
    assert.equal(f.driver.voiceFocusLease.owner, owner);
    return {
      performed: true,
      attempted: true,
      editorFocused: true,
      postFocusFrame: f.frame(['header', 'editor'], { uiaControlFrame: true }),
    };
  };
  f.client.request = async (action, body) => {
    if (action === 'beginFocusHandoff') {
      f.actions.push({ action, body });
      return { activated: true, focusHandoff: handoff };
    }
    if (action === 'restoreTransferredFocus') {
      f.actions.push({ action, body, owner: 'original' });
      return { restored: true, skipped: false };
    }
    if (action === 'transferFocusHandoff') {
      f.actions.push({ action, body });
      return {
        transferred: true,
        revision: 2,
        focusHandoff: handoff,
        cleanup: {
          version: 1,
          wechatWindow: {
            hwnd: f.binding.hwnd,
            pid: f.binding.pid,
            processCreatedFileTimeUtc: f.binding.processCreatedFileTimeUtc,
          },
          returnWindow: returned,
          lastInputTick: 8,
          issuedAtMs: f.driver.now(),
        },
      };
    }
    return original(action, body);
  };
  f.client.release = async () => {
    f.actions.push({ action: 'release' });
    return { processStopped: confirmed };
  };
  const prepare = () =>
    f.driver.prepareVoiceSession({ ...f.job, mode: 'voice' }, { interactionPlan: { executionMode: 'focus-handoff' } });
  return { f, owner, handoff, prepare };
}

test('the real UIA recording preparation hands off its verified owner and returns focus through cleanup only', async t => {
  const { f, owner, handoff, prepare } = recordingFixture(t, true);
  const out = await prepare();
  assert.equal(out.session.lastInputTick, 8);
  assert.equal(out.session.target, f.job.target);
  assert.deepEqual(out.focusHandoff, handoff);
  assert.notEqual(f.driver.nativeOwner, owner);
  assert.equal(f.driver.voiceFocusLease, null);
  await Promise.all([out.releaseFocus(), out.releaseFocus()]);
  assert.deepEqual(
    f.actions
      .map(x => x.action)
      .filter(a => ['transferFocusHandoff', 'release', 'restoreTransferredFocus'].includes(a)),
    ['transferFocusHandoff', 'release', 'restoreTransferredFocus'],
  );
});

test('an unconfirmed voice release keeps the original input checkpoint and returns focus on the same helper', async t => {
  const { f, owner, prepare } = recordingFixture(t, false);
  await assert.rejects(prepare(), { code: 'UI_QT_STOP_UNCONFIRMED' });
  assert.equal(f.driver.nativeOwner, owner);
  assert.equal(f.driver.current.jobId, f.job.id);
  assert.equal(f.driver.voiceFocusLease, null);
  await assert.rejects(f.driver.requestNative('inspectLayout'), { code: 'UI_QT_CLIENT_CHANGED', attempted: false });
  assert.deepEqual(
    f.actions.filter(item => item.action === 'restoreTransferredFocus').map(item => item.owner),
    ['original'],
  );
});

test('a fresh editor with an existing user draft refuses both paste and submit', async t => {
  const f = fixture(t),
    request = f.client.request;
  f.client.request = async (action, body) =>
    action === 'checkClearMessageQuote' ? { clear: false } : request(action, body);
  await assert.rejects(f.driver.prepare(f.job, { textEntryMode: 'paste' }), { code: 'UI_QT_EXISTING_DRAFT' });
  assert.equal(
    f.actions.some(item => ['paste', 'submitTextEnter', 'attachMessageQuote'].includes(item.action)),
    false,
  );
});

test('OCR reads the editor before first input and keeps a bound continuation', async () => {
  const reader = new QtEditorDraft(
    { config: { layoutMode: 'adaptive-v1' }, regionDigest: () => 'same' },
    {},
    {
      verifyControlBinding: async () => {},
    },
  );
  let reads = 0,
    draft = 'operator text';
  reader.readDraft = async () => {
    reads++;
    return { draft, frame: {} };
  };
  await assert.rejects(reader.verifyNew({}, { draft: '', frame: {} }), { code: 'UI_QT_EXISTING_DRAFT' });
  draft = '';
  await reader.verifyNew({}, { draft: '', frame: {} });
  await reader.verifyNew({ index: 3 }, { draft: 'own', frame: {} });
  assert.equal(reads, 2);
});
