import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { UiImageOutbox } from './ui-image-outbox.mjs';
import { createDesktopRuntimeDriver } from './runtime-driver.mjs';
import { fileDialogSendButton, QtAttachmentSession } from './qt-attachment-session.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const md5 = value => crypto.createHash('md5').update(value).digest('hex');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  'base64',
);
const gif = Buffer.from(
  '47494638396101000100800000000000ffffff2c00000000010001000002024401002c00000000010001000002024c01003b',
  'hex',
);
const id = n => String(n).repeat(64),
  turn = () => new Promise(resolve => setImmediate(resolve));
test('an unsupported clipboard never repeatedly navigates or pastes an image until explicit resume', async t => {
  const f = fixture(t);
  f.driver.pasteImage = async () => {
    f.state.pastes++;
    return { performed: false, attempted: false, reason: 'DRAFT_CLIPBOARD_COMPLEX_FORMAT' };
  };
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  assert.equal(f.outbox.get(id(1)).manualPause, true);
  assert.equal(f.outbox.get(id(1)).reason, 'DRAFT_CLIPBOARD_COMPLEX_FORMAT');
  assert.equal(f.outbox.get(id(1)).inputPending, undefined);
  for (let i = 0; i < 3; i++) await f.outbox.tick();
  const restarted = f.make();
  await restarted.tick();
  assert.equal(f.state.prepares, 1);
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 0);
  restarted.resume(id(1));
  await restarted.tick();
  assert.equal(f.state.pastes, 2);
});
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-outbox-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source.png');
  fs.writeFileSync(source, png);
  const scope = {
    version: 1,
    accountRef: 'a'.repeat(64),
    account: 'fixture-self',
    target: 'fixture-friend',
    eventId: 'fixture-event',
    selectionVersion: 1,
    grantId: 'b'.repeat(64),
    token: 'c'.repeat(64),
  };
  const request = {
    deliveryId: id(1),
    account: scope.account,
    target: scope.target,
    image: { path: source, sha256: sha(png) },
    selectionScope: scope,
  };
  let now = 1700000000000;
  const state = { allowed: true, applied: null, pastes: 0, submits: 0, prepares: 0, returns: 0, confirmed: false },
    events = [];
  const receiptFor = job => ({
    type: 'desktop-reader-media-v1',
    deliveryId: job.id,
    account: job.account,
    accountDirectory: 'fixture-account',
    target: job.target,
    sourceImageSha256: job.sourceImageSha256,
    nativeImageRowConfirmed: true,
    imageContentVerified: false,
    imageContentMatch: 'raster',
    sourceShard: 'd'.repeat(64),
    localId: '1',
    serverId: '500',
    localType: 3,
    createTime: Math.floor(now / 1000),
    observedAt: now,
  });
  const nativeJob = job => {
    assert.equal(Object.hasOwn(job, 'text'), false);
    assert.equal(Object.hasOwn(job, 'pendingInput'), false);
    assert.equal(job.kind, 'image');
    assert.equal(sha(fs.readFileSync(job.image.path)), request.image.sha256);
  };
  const driver = {
    prepare: async job => {
      nativeJob(job);
      state.prepares++;
      events.push('prepare');
      return { ready: true };
    },
    observe: async job => {
      nativeJob(job);
      events.push('observe');
      return {
        ready: true,
        account: job.account,
        target: job.target,
        foreground: true,
        idleMs: 1000,
        editorToken: 'fixture-editor',
        activityRevision: 'fixture-activity',
        appliedImageId: state.applied,
      };
    },
    pasteImage: async (job, guard) => {
      nativeJob(job);
      assert.equal('text' in guard, false);
      assert.equal('expectedDraft' in guard, false);
      assert.equal(guard.canInput(), true);
      state.pastes++;
      state.applied = job.id;
      events.push('paste');
      return { performed: true, attempted: true };
    },
    submitImage: async (job, guard) => {
      nativeJob(job);
      assert.equal(guard.canSubmit(), true);
      state.submits++;
      events.push('submit');
      return { performed: true, attempted: true };
    },
    releaseTextFocus: async () => {
      state.returns++;
      events.push('return');
    },
  };
  let reserved = false;
  const receipts = {
    prepare: async () => {
      events.push('baseline');
      if (reserved) return { prepared: true, submissionAllowed: false };
      reserved = true;
      return { prepared: true, submissionAllowed: true };
    },
    submitted: () => {
      events.push('submit-intent');
      return { recorded: true };
    },
    query: async job => {
      events.push('query');
      return state.confirmed ? { confirmed: true, receipt: receiptFor(job) } : { confirmed: false };
    },
  };
  const config = {
    directory: path.join(directory, 'outbox'),
    driver,
    receipts,
    authorizeScope: () => state.allowed,
    now: () => now,
    settings: { idleMs: 1000, intervalMs: 0, receiptTimeoutMs: 30000 },
    ...options,
  };
  const make = patch => new UiImageOutbox({ ...config, ...patch });
  return {
    directory,
    source,
    scope,
    request,
    state,
    events,
    driver,
    receipts,
    config,
    make,
    outbox: make(),
    receiptFor,
    advance: ms => (now += ms),
  };
}

test('snapshot is admitted before queue work; paste never sends a text marker and submit writes baseline and intent first', async t => {
  const f = fixture(t),
    job = f.outbox.enqueue(f.request);
  assert.equal(job.kind, 'image');
  assert.equal('text' in job, false);
  assert.notEqual(job.image.path, f.source);
  fs.writeFileSync(f.source, 'source changed after admission');
  await f.outbox.tick();
  assert.equal(f.outbox.get(job.id).state, 'submitted');
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 1);
  assert.equal(f.state.prepares, 1);
  assert(f.events.indexOf('baseline') > f.events.indexOf('paste'));
  assert(f.events.indexOf('submit-intent') < f.events.indexOf('submit'));
  assert(f.events.indexOf('return') > f.events.indexOf('submit'));
  f.state.confirmed = true;
  await f.outbox.tick();
  assert.equal(f.outbox.get(job.id).state, 'confirmed');
  assert.equal(f.state.pastes, 1);
  assert.equal(fs.existsSync(job.image.path), false);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'source changed after admission');
  fs.unlinkSync(f.source);
  assert.equal(f.outbox.enqueue(f.request).state, 'confirmed');
});
test('admission interrupted between metadata and queue can resume without desktop input', async t => {
  const f = fixture(t),
    enqueue = f.outbox.queue.enqueue.bind(f.outbox.queue);
  f.outbox.queue.enqueue = () => {
    throw Error('fixture interrupted');
  };
  assert.throws(() => f.outbox.enqueue(f.request));
  assert.equal(f.state.pastes, 0);
  assert.equal(f.state.prepares, 0);
  f.outbox.queue.enqueue = enqueue;
  const restored = f.make();
  restored.enqueue(f.request);
  await restored.tick();
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 1);
});
test('image snapshots require exact hash; malformed GIF, text, changed hash and ID rebinding fail before input', t => {
  const f = fixture(t);
  assert.throws(() => f.outbox.enqueue({ ...f.request, image: { ...f.request.image, sha256: 'f'.repeat(64) } }), {
    code: 'UI_IMAGE_ASSET_CHANGED',
  });
  for (const [bytes, code] of [
    [Buffer.from('GIF89a'), 'UI_IMAGE_FORMAT_INVALID'],
    [Buffer.from('plain text'), 'UI_IMAGE_FORMAT_UNSUPPORTED'],
  ]) {
    fs.writeFileSync(f.source, bytes);
    assert.throws(() => f.outbox.enqueue({ ...f.request, image: { path: f.source, sha256: sha(bytes) } }), { code });
  }
  fs.writeFileSync(f.source, png);
  f.outbox.enqueue(f.request);
  assert.throws(() => f.outbox.enqueue({ ...f.request, image: { ...f.request.image, sha256: 'f'.repeat(64) } }), {
    code: 'UI_IMAGE_ID_CONFLICT',
  });
  assert.equal(f.state.prepares, 0);
});
test('GIF snapshots retain every original byte and persist their computed MD5 through native work and receipt bindings', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, gif);
  f.request.image = { path: f.source, sha256: sha(gif), md5: 'f'.repeat(32) };
  const job = f.outbox.enqueue(f.request);
  assert.equal(path.extname(job.image.path), '.gif');
  assert.deepEqual(fs.readFileSync(job.image.path), gif);
  assert.equal(job.imageFormat, 'gif');
  assert.equal(job.sourceImageMd5, md5(gif));
  assert.equal(job.image.md5, md5(gif));
  assert.equal(job.image.format, 'gif');
  const bindings = [],
    prepare = f.receipts.prepare,
    submitted = f.receipts.submitted;
  const check = job => {
    assert.equal(job.imageFormat, 'gif');
    assert.equal(job.sourceImageMd5, md5(gif));
    assert.equal(job.sourceImageSha256, sha(gif));
  };
  f.receipts.prepare = async job => {
    check(job);
    bindings.push('prepare');
    return prepare(job);
  };
  f.receipts.submitted = (job, now) => {
    check(job);
    bindings.push('submitted');
    return submitted(job, now);
  };
  f.receipts.query = async job => {
    check(job);
    bindings.push('query');
    return {
      confirmed: true,
      receipt: {
        ...f.receiptFor(job),
        type: 'desktop-reader-media-v1',
        sourceImageMd5: md5(gif),
        gifContentMd5Matched: true,
        localType: 47,
      },
    };
  };
  fs.unlinkSync(f.source);
  const restored = f.make();
  assert.equal(restored.get(job.id).sourceImageMd5, md5(gif));
  await restored.tick();
  await restored.tick();
  assert.equal(restored.get(job.id).state, 'confirmed');
  assert.deepEqual(bindings, ['prepare', 'submitted', 'query']);
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 1);
});
test('GIF needs its own receipt protocol and exact source MD5; static image rows cannot confirm animation', async t => {
  for (const patch of [
    { type: 'unrecognized-receipt' },
    { sourceImageMd5: 'e'.repeat(32) },
    { sourceImageMd5: undefined },
    { gifContentMd5Matched: false },
    { localType: 3 },
    { localType: 6 * 2 ** 32 + 49 },
  ]) {
    const f = fixture(t);
    fs.writeFileSync(f.source, gif);
    f.request.image = { path: f.source, sha256: sha(gif) };
    f.outbox.enqueue(f.request);
    await f.outbox.tick();
    f.receipts.query = async job => ({
      confirmed: true,
      receipt: {
        ...f.receiptFor(job),
        type: 'desktop-reader-media-v1',
        sourceImageMd5: md5(gif),
        gifContentMd5Matched: true,
        localType: 47,
        ...patch,
      },
    });
    await f.outbox.tick();
    assert.equal(f.outbox.get(id(1)).state, 'submitted');
    assert.equal(f.state.submits, 1);
  }
});
test('GIF snapshot MD5 metadata is validated before native preparation after restart', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, gif);
  f.request.image = { path: f.source, sha256: sha(gif) };
  f.outbox.enqueue(f.request);
  const file = path.join(f.config.directory, 'metadata', id(1) + '.json'),
    metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...metadata, sourceImageMd5: 'e'.repeat(32) }));
  const restored = f.make();
  await restored.tick();
  assert.equal(f.state.prepares, 0);
  assert.equal(f.state.pastes, 0);
  fs.writeFileSync(file, JSON.stringify({ ...metadata, sourceImageMd5: undefined }));
  assert.throws(() => restored.get(id(1)), { code: 'UI_IMAGE_STATE_INVALID' });
});
test('tampered snapshot cannot reach desktop preparation or paste', async t => {
  const f = fixture(t),
    job = f.outbox.enqueue(f.request);
  fs.writeFileSync(job.image.path, Buffer.alloc(png.length));
  await f.outbox.tick();
  assert.equal(f.state.prepares, 0);
  assert.equal(f.state.pastes, 0);
  assert.equal(f.state.submits, 0);
});
test('uncertain paste is not retried, including after process restart', async t => {
  const f = fixture(t);
  f.driver.pasteImage = async () => {
    f.state.pastes++;
    throw Error('native response lost');
  };
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  assert.equal(f.outbox.get(id(1)).inputPending, true);
  const restored = f.make();
  await restored.tick();
  assert.equal(restored.get(id(1)).state, 'conflict');
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.prepares, 1);
  assert.equal(f.state.submits, 0);
});
test('known applied image resumes in place after pause without another navigation or paste', async t => {
  const f = fixture(t),
    paste = f.driver.pasteImage;
  f.driver.pasteImage = async (job, guard) => {
    const result = await paste(job, guard);
    f.outbox.pause(job.id);
    return result;
  };
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 0);
  await f.outbox.drain();
  const restored = f.make();
  restored.resume(id(1));
  await restored.tick();
  assert.equal(f.state.prepares, 1);
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 1);
});
test('an OCR restart with an applied image requests manual recovery without activating the driver', async t => {
  const f = fixture(t);
  const paste = f.driver.pasteImage;
  f.driver.pasteImage = async (job, guard) => {
    const result = await paste(job, guard);
    f.outbox.pause(job.id);
    return result;
  };
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  await f.outbox.shutdown();

  const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };
  const driver = await createDesktopRuntimeDriver({
    root: f.directory,
    settings: { controlMode: 'ocr', wechatExecutable: path.join(f.directory, 'Weixin.exe') },
    account: {
      readOnly: true,
      accountRef: f.scope.accountRef,
      accountWxid: f.scope.account,
      executableVersion: '4.2.0.53',
      executableSha256: 'f'.repeat(64),
      binding: {
        hwnd: '123',
        pid: 12,
        threadId: 13,
        processCreatedFileTimeUtc: '134000000000000000',
        dpi: 96,
        clientRect: bounds,
        captureRect: bounds,
      },
    },
    bootstrap: async () => assert.fail('restart recovery must not navigate or capture'),
    createOffscreen: () => ({ close: async () => {} }),
  });
  t.after(() => driver.close());
  const restarted = f.make({ driver });
  restarted.resume(id(1));
  await restarted.tick();
  const paused = restarted.get(id(1));
  assert.equal(paused.state, 'paused');
  assert.equal(paused.reason, 'UI_IMAGE_DRAFT_RECOVERY_REQUIRED');
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 0);
  assert.equal(
    restarted.acknowledgeClearedDraft(id(1), {
      expectedRevision: paused.revision,
      acknowledgedCleared: true,
      assertStopped: () => true,
    }).state,
    'cancelled',
  );
});
async function ocrFileDialogScenario(t, refused = false) {
  const f = fixture(t);
  const file = path.join(f.directory, 'note.txt');
  const contents = Buffer.from('file dialog fixture');
  fs.writeFileSync(file, contents);
  const sha256 = sha(contents);
  const titleSha256 = sha('fixture chat');
  const proofId = 'a'.repeat(32);
  const revision = 'activity-1';
  const header = 'b'.repeat(64);
  const screenshotDirectory = path.join(f.directory, 'state/ui-host/qt-frames');
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const screenshot = path.join(screenshotDirectory, 'qt-' + proofId + '.png');
  fs.writeFileSync(screenshot, png);
  const imageSha256 = sha(png);
  const actions = [];
  const released = [];
  if (refused) {
    const prepare = f.receipts.prepare;
    f.receipts.prepare = async job => ({ ...(await prepare(job)), baselineId: 'file-baseline' });
    f.receipts.notAttempted = (job, baseline) => {
      released.push({ id: job.id, baseline });
    };
  }
  let captures = 0;
  const input = {
    root: f.directory,
    config: { ocrBackend: 'rapidocr' },
    async recognize({ file }) {
      assert.equal(file, screenshot);
      return {
        imageSha256,
        width: 300,
        height: 210,
        words: dialogWords(path.basename(input.fileName)),
      };
    },
    current: null,
    allowSubmit: true,
    checkJob() {},
    active() {},
    verifyControlBinding: async () => {},
    rememberImageDraft(previous, update) {
      this.current = { ...previous, ...update };
    },
    beginImageSubmission(job) {
      this.imageSubmitAttempted = job.id;
    },
    refuseImageSubmission(job) {
      assert.equal(this.imageSubmitAttempted, job.id);
      this.imageSubmitAttempted = null;
    },
    discardDraft() {
      this.current = null;
    },
    holdDraft: () => assert.fail('the verified dialog should proceed to submission'),
    async requestNative(operation, args) {
      actions.push(operation);
      if (operation === 'pasteFile') {
        assert.equal(args.imageSha256, sha256);
        assert.equal(args.titleSha256, titleSha256);
        assert.deepEqual(fs.readFileSync(args.imagePath), contents);
        input.fileName = args.imagePath;
        return {
          performed: true,
          attempted: true,
          pasteApplied: true,
          clipboardRestored: true,
          revision,
          imageFormat: 'file',
          originalFilePasted: true,
          imageConsumption: { consumerProcessMatched: true },
          fileDialogProof: { id: proofId, sha256 },
        };
      }
      if (operation === 'captureOcrFileDialog') {
        assert.deepEqual(args, { proofId, sha256 });
        return { width: 300, height: 210, image: { file: screenshot, sha256: imageSha256 } };
      }
      assert.equal(operation, 'submitFileDialog');
      assert.deepEqual(args, { proofId, sha256, buttonRect: { left: 150, top: 170, right: 230, bottom: 184 } });
      if (refused)
        throw Object.assign(Error('file dialog refused before input'), {
          code: 'QT_FILE_DIALOG_CHANGED',
          nativeAction: operation,
          attempted: false,
        });
      return { performed: true, attempted: true, inputQueued: true, dialogClosed: true, revision };
    },
  };
  const frames = {
    config: { layoutMode: 'adaptive-v1', idleMs: 1000, layout: {} },
    async capture() {
      assert.equal(++captures, 1, 'the modal owns the foreground after paste');
      return { regions: [{ rgbaSha256: header }], idleMs: 1000, revision };
    },
    invalidateFrame() {},
  };
  const focus = { preparationLease: () => null, releaseTextFocus: async () => {} };
  const session = new QtAttachmentSession({ input, frames, focus });
  const fileAssetsDirectory = path.join(f.directory, 'file-assets');
  const outbox = f.make({
    fileAssetsDirectory,
    driver: {
      prepare: async job => {
        input.current = {
          jobId: job.id,
          account: job.account,
          target: job.target,
          editorToken: 'editor-1',
          revision,
          header,
          fileTitleSha256: titleSha256,
        };
        return { ready: true };
      },
      observe: async job =>
        session.observeFileDialog(job) ?? {
          ready: true,
          foreground: true,
          account: job.account,
          target: job.target,
          editorToken: 'editor-1',
          activityRevision: revision,
          idleMs: 1000,
        },
      pasteImage: (job, guard) => session.pasteImage(job, guard),
      submitImage: (job, guard) => session.submitImage(job, guard),
    },
  });
  outbox.enqueue({ ...f.request, mode: 'file', image: { path: file, sha256 } });
  await outbox.tick();
  assert.deepEqual(actions, ['pasteFile', 'captureOcrFileDialog', 'submitFileDialog']);
  if (refused) {
    const saved = f.make({ fileAssetsDirectory }).get(id(1));
    assert.equal(saved.state, 'paused');
    assert.equal(saved.submittedAt, undefined);
    assert.equal(saved.imageDraftPresent, true);
    assert.equal(saved.reason, 'QT_FILE_DIALOG_CHANGED');
    assert.equal(input.imageSubmitAttempted, null);
    assert.deepEqual(released, [{ id: id(1), baseline: 'file-baseline' }]);
    assert.equal(f.events.includes('query'), false);
    return;
  }
  assert.equal(outbox.get(id(1)).inputReleased, true);
  f.state.confirmed = true;
  f.advance(500);
  await outbox.tick();
  assert.equal(outbox.get(id(1)).state, 'confirmed');
  assert.deepEqual(actions, ['pasteFile', 'captureOcrFileDialog', 'submitFileDialog']);
}
test(
  'an OCR file dialog reaches durable submission and receipt without clicking the main window',
  ocrFileDialogScenario,
);
test('an OCR file dialog refused before input releases its receipt intent and keeps its draft', async t => {
  await ocrFileDialogScenario(t, true);
});

function dialogWords(fileName) {
  return ['发送给：fixture chat', fileName, '发送'].map((text, line) => ({
    text,
    line,
    x: 150,
    y: 30 + line * 70,
    width: 80,
    height: 14,
    confidence: 0.99,
  }));
}

test('file dialog OCR requires an exact destination, exact filename and a unique send control', () => {
  const bounds = { left: 0, top: 0, right: 300, bottom: 210 },
    fileName = '说明.txt',
    titleSha256 = sha('fixture chat'),
    words = dialogWords(fileName),
    find = items => fileDialogSendButton({ words: items }, bounds, fileName, titleSha256);
  assert.ok(find(words));
  for (const invalid of [
    [{ ...words[0], text: '发送给：fixture chat 2' }, ...words.slice(1)],
    [{ ...words[1], text: '说明…' }, words[0], words[2]],
    [words[0], words[1], { ...words[2], confidence: 0.7 }],
    [...words, { ...words[2], line: 3, x: 50 }],
    [words[0], words[1], { ...words[2], y: 20 }],
  ])
    assert.equal(find(invalid), null);
});
test('prepare and native callbacks recheck human pause and target authorization after async work', async t => {
  const f = fixture(t);
  let release, entered;
  const waiting = new Promise(resolve => (entered = resolve));
  f.driver.prepare = async (_job, { canInput }) => {
    entered();
    await new Promise(resolve => (release = resolve));
    assert.equal(canInput(), false);
    return { ready: true };
  };
  f.outbox.enqueue(f.request);
  const tick = f.outbox.tick();
  await waiting;
  f.state.allowed = false;
  release();
  await tick;
  assert.equal(f.state.pastes, 0);
  assert.equal(f.state.submits, 0);
});
test('pause before a baseline returns preserves the image for a later submit', async t => {
  const f = fixture(t),
    prepare = f.receipts.prepare;
  let release, entered;
  const waiting = new Promise(resolve => (entered = resolve));
  f.receipts.prepare = async () => {
    entered();
    await new Promise(resolve => (release = resolve));
    return { prepared: true, submissionAllowed: true };
  };
  f.outbox.enqueue(f.request);
  const tick = f.outbox.tick();
  await waiting;
  f.outbox.pause();
  release();
  await tick;
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 0);
  assert.equal(f.outbox.get(id(1)).state, 'paused');
  f.receipts.prepare = prepare;
  f.outbox.resume();
  await f.outbox.tick();
  assert.equal(f.state.submits, 1);
  assert.equal(f.state.pastes, 1);
});
test('uncertain or refused native submit never sends twice and only queries after restart', async t => {
  for (const refused of [false, true]) {
    const f = fixture(t);
    f.driver.submitImage = async () => {
      f.state.submits++;
      if (refused) return { performed: false, attempted: false };
      throw Error('native response lost');
    };
    f.outbox.enqueue(f.request);
    await f.outbox.tick();
    const restored = f.make();
    await restored.tick();
    assert.equal(f.state.submits, 1);
    assert.equal(f.state.pastes, 1);
    f.state.confirmed = true;
    await restored.tick();
    assert.equal(restored.get(id(1)).state, 'confirmed');
  }
});
test('missing or reserved baseline prevents native submit, never reattempts the image', async t => {
  const f = fixture(t);
  f.receipts.prepare = async () => ({ prepared: true, submissionAllowed: false });
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  await f.outbox.tick();
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 0);
  assert.equal(f.outbox.get(id(1)).state, 'submitting');
});
test('missing reservation acknowledgement prevents the native submit', async t => {
  const f = fixture(t);
  f.receipts.submitted = () => ({ recorded: false });
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 0);
  const saved = f.outbox.get(id(1));
  assert.equal(saved.state, 'submitting');
  assert.equal(saved.reason, 'UI_SUBMISSION_UNCERTAIN');
});

test('foreign receipt or false pixel verification never confirms', async t => {
  for (const patch of [
    { sourceImageSha256: 'e'.repeat(64) },
    { target: 'other' },
    { imageContentVerified: true },
    { imageContentMatch: undefined },
    { imageContentMatch: false, nativeSubmitVerified: true },
    { localType: 47 },
    { serverId: 'secret1' },
  ]) {
    const f = fixture(t);
    f.outbox.enqueue(f.request);
    await f.outbox.tick();
    f.receipts.query = async job => ({ confirmed: true, receipt: { ...f.receiptFor(job), ...patch } });
    await f.outbox.tick();
    assert.equal(f.outbox.get(id(1)).state, 'submitted');
  }
});
test('a verified cleared editor permits read-only image reconciliation after the receipt deadline', async t => {
  const f = fixture(t);
  f.driver.submitImage = async () => {
    f.state.submits++;
    return { performed: true, attempted: true, inputReleased: true };
  };
  const match = f.receipts.query;
  f.receipts.query = async () => ({ confirmed: false, reason: 'DESKTOP_IMAGE_CONTENT_UNVERIFIED' });
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  assert.equal(f.outbox.get(id(1)).inputReleased, true);
  await f.outbox.tick();
  f.advance(30001);
  await f.outbox.tick();
  const restored = f.make();
  assert.equal(restored.get(id(1)).state, 'unconfirmed');
  assert.equal(restored.get(id(1)).nativeRecoveryRequired, false);
  f.state.confirmed = true;
  f.receipts.query = match;
  const result = await restored.reconcileReceipt(id(1));
  assert.equal(result.state, 'confirmed');
  assert.equal(f.state.submits, 1);
});

test('unconfirmed submission blocks later queued images and cannot be cancelled into retry', async t => {
  const f = fixture(t);
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  f.outbox.enqueue({ ...f.request, deliveryId: id(2) });
  f.advance(30001);
  await f.outbox.tick();
  assert.equal(f.outbox.get(id(1)).state, 'unconfirmed');
  const result = await f.outbox.tick();
  assert.equal(result.blocked, true);
  assert.equal(f.state.pastes, 1);
  assert.equal(f.state.submits, 1);
  assert.equal(f.outbox.enqueue(f.request).state, 'unconfirmed');
});
test('cancelled pasted draft retains a barrier while untouched queued cancellation permits later work', async t => {
  const f = fixture(t),
    paste = f.driver.pasteImage;
  f.driver.pasteImage = async (job, guard) => {
    const result = await paste(job, guard);
    f.outbox.pause(job.id);
    return result;
  };
  f.outbox.enqueue(f.request);
  await f.outbox.tick();
  f.outbox.cancel(id(1));
  f.outbox.enqueue({ ...f.request, deliveryId: id(2) });
  assert.equal((await f.outbox.tick()).blocked, true);
  assert.equal(f.state.pastes, 1);
  const g = fixture(t);
  g.outbox.enqueue(g.request);
  g.outbox.cancel(id(1));
  g.outbox.enqueue({ ...g.request, deliveryId: id(2) });
  await g.outbox.tick();
  assert.equal(g.state.pastes, 1);
  assert.equal(g.state.submits, 1);
});
test('shutdown waits for pending native input and focus return without sending afterward', async t => {
  const f = fixture(t);
  let finish, entered;
  const waiting = new Promise(resolve => (entered = resolve));
  f.driver.pasteImage = async (_job, guard) => {
    f.state.pastes++;
    entered();
    await new Promise(resolve => (finish = resolve));
    assert.equal(guard.signal.aborted, true);
    assert.equal(guard.canInput(), false);
    return { performed: false, attempted: false };
  };
  f.outbox.enqueue(f.request);
  const tick = f.outbox.tick();
  await waiting;
  let stopped = false;
  const stop = f.outbox.shutdown().then(() => (stopped = true));
  await turn();
  assert.equal(stopped, false);
  finish();
  await tick;
  await stop;
  assert.equal(stopped, true);
  assert.equal(f.state.submits, 0);
  assert(f.state.returns > 0);
});
