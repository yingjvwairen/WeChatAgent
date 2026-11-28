import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { UiImageOutbox } from './ui-image-outbox.mjs';

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
    sourceMd5Matched: true,
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
      return { submitted: true };
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
test('foreign receipt or false pixel verification never confirms', async t => {
  for (const patch of [
    { sourceImageSha256: 'e'.repeat(64) },
    { target: 'other' },
    { imageContentVerified: true },
    { sourceMd5Matched: undefined },
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
