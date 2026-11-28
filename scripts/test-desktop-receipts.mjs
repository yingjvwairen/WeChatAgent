import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DesktopReceipts, savedDesktopReceipt } from './desktop-receipts.mjs';
import { pcmWave } from './desktop-sender/engine-voice.mjs';
import { DeliveryStore } from './desktop-sender/delivery-store.mjs';
import { savedChatDeliveries } from './desktop-sender/delivery-list.mjs';
import { DesktopSenderEngine } from './desktop-sender/engine.mjs';
import { deliveryResult } from './desktop-sender/contract.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-receipts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let now = 1700000000000,
    allowed = true,
    rows = [],
    voiceMatch = null,
    afterRead;
  const requests = [];
  const options = {
    now: () => now,
    authorize: () => allowed,
    messages: async () => {
      afterRead?.();
      const watermarks = {};
      for (const row of rows)
        watermarks[row.sourceShard] = String(Math.max(Number(watermarks[row.sourceShard] ?? 0), Number(row.localId)));
      return { messages: rows, watermarks };
    },
    recordingReceipt: async request => {
      requests.push(request);
      afterRead?.();
      return { success: true, match: voiceMatch };
    },
  };
  const receipts = new DesktopReceipts(root, options);
  const job = {
    id: 'job',
    deliveryId: 'delivery',
    accountRef: 'a'.repeat(64),
    accountWxid: 'self',
    wxid: 'peer',
    kind: 'private',
    target: '123',
    operation: 'text',
    text: '正文',
  };
  const row = (extra = {}) => ({
    sourceShard: 'a'.repeat(64),
    isSend: 1,
    localId: 1,
    serverId: '100',
    createTime: Math.floor(now / 1000),
    localType: 1,
    fullText: '正文',
    ...extra,
  });
  return {
    root,
    receipts,
    job,
    row,
    requests,
    options,
    setRows: value => (rows = value),
    setVoice: value => (voiceMatch = value),
    setAllowed: value => (allowed = value),
    afterRead: fn => (afterRead = fn),
    advance: ms => (now += ms),
    now: () => now,
  };
}
const prepare = async (f, job = f.job) => f.receipts.observe(job, { phase: 'prepare' });
const submit = async (f, job = f.job, extra = {}) =>
  f.receipts.observe(job, { phase: 'submitted', submittedAt: f.now(), ...extra });
const query = (f, job = f.job) => f.receipts.observe(job, { phase: 'query' });

const receiptMd5 = 'b'.repeat(32);
const receiptCases = [
  ['text', {}, {}],
  [
    'quote',
    { deliveryId: 'quote', quote: { serverId: '25' } },
    { localType: 49, quoteSourceServerId: '25', quoteReplyText: '正文' },
  ],
  ['image', { operation: 'image', path: 'fixture.png', md5: receiptMd5 }, { localType: 3, imageMd5: receiptMd5 }],
  ['GIF', { operation: 'sticker', path: 'fixture.gif', md5: receiptMd5 }, { localType: 47, stickerMd5: receiptMd5 }],
  [
    'file',
    { operation: 'file', fileName: 'fixture.txt', size: 10, md5: receiptMd5 },
    { localType: 49, fileKind: 'appmsg-6', fileName: 'fixture.txt', fileSize: 10, fileMd5: receiptMd5 },
  ],
];

test('quoted images and GIFs need both a content match and the exact quoted source', async t => {
  const f = fixture(t);
  for (const [type, operation, field] of [
    [3, 'image', 'imageMd5'],
    [47, 'sticker', 'stickerMd5'],
  ]) {
    const job = {
      ...f.job,
      deliveryId: 'quoted-' + operation,
      operation,
      path: 'fixture',
      md5: receiptMd5,
      quote: { serverId: '555' },
    };
    f.setRows([]);
    await prepare(f, job);
    await submit(f, job);
    const body = { localType: type, [field]: receiptMd5 };
    f.setRows([f.row(body), f.row({ ...body, localId: 2, serverId: '101', quoteSourceServerId: '556' })]);
    assert.equal((await query(f, job)).confirmed, false);
    f.setRows([f.row(body), f.row({ ...body, localId: 3, serverId: String(type + 100), quoteSourceServerId: '555' })]);
    const result = await query(f, job);
    assert.equal(result.confirmed, true);
    assert.equal(result.receipt.sourceServerId, '555');
    assert.equal(result.receipt.localId, '3');
  }
});

test('late database rows from the preceding second cannot confirm ordinary sends', async t => {
  const f = fixture(t);
  let nextId = 801;
  for (const [, fields, matching] of receiptCases) {
    const job = { ...f.job, ...fields };
    f.setRows([]);
    await prepare(f, job);
    await submit(f, job);
    const previous = f.row({ ...matching, localId: 11, serverId: '800', createTime: f.now() / 1000 - 1 });
    f.setRows([previous]);
    assert.equal((await query(f, job)).confirmed, false, job.operation);
    const serverId = String(nextId++);
    f.setRows([previous, f.row({ ...matching, localId: 12, serverId })]);
    assert.equal((await query(f, job)).receipt.serverId, serverId, job.operation);
  }
});

test('the baseline alone cannot confirm a manual message, but a persisted native intent survives restart', async t => {
  const f = fixture(t);
  await prepare(f);
  f.setRows([f.row()]);
  assert.equal((await query(f)).confirmed, false);
  await submit(f);
  const restarted = new DesktopReceipts(f.root, f.options);
  assert.equal((await restarted.observe(f.job, { phase: 'prepare' })).submissionAllowed, false);
  assert.equal((await restarted.observe(f.job, { phase: 'query' })).confirmed, true);
});

for (const [name, fields, evidence] of receiptCases) {
  test('a resuming ' + name + ' must not accept an identical row sent before submission', async t => {
    const f = fixture(t);
    const job = { ...f.job, ...fields };
    const beforePause = await prepare(f, job);
    f.advance(20000);
    const manual = f.row(evidence);
    f.setRows([manual]);
    f.receipts = new DesktopReceipts(f.root, f.options);
    const afterPause = await prepare(f, job);
    assert.equal(afterPause.submissionAllowed, true);
    await submit(f, job, { baselineId: afterPause.baselineId });
    const early = await query(f, job);
    assert.equal(early.confirmed, false, 'a row visible before the reservation is not its receipt');
    assert.notEqual(afterPause.baselineId, beforePause.baselineId);
    f.setRows([manual, f.row({ ...evidence, localId: 2, serverId: '101' })]);
    assert.equal((await query(f, job)).receipt.serverId, '101');
  });
}

test('a baseline outage preserves an active reservation and allows new preparation only after release', async t => {
  const f = fixture(t);
  const first = await prepare(f);
  await submit(f, f.job, { baselineId: first.baselineId });
  f.advance(20000);
  const timeout = new DOMException('Reader timed out', 'TimeoutError');
  f.afterRead(() => {
    throw timeout;
  });

  const reserved = await prepare(f);
  assert.deepEqual(reserved, { prepared: true, submissionAllowed: false, baselineId: first.baselineId });
  await assert.rejects(query(f), error => error === timeout);
  await f.receipts.observe(f.job, {
    phase: 'not-attempted',
    baselineId: first.baselineId,
    proof: { performed: false, attempted: false },
  });
  assert.deepEqual(await prepare(f), {
    prepared: false,
    submissionAllowed: false,
    performed: false,
    attempted: false,
    reason: 'DESKTOP_RECEIPT_BASELINE_UNAVAILABLE',
  });
  f.afterRead(undefined);
  const next = await prepare(f);
  assert.equal(next.submissionAllowed, true);
  assert.notEqual(next.baselineId, first.baselineId);
});

test('reservation refusal requires the unused baseline and the saved receipt scope', async t => {
  const f = fixture(t);
  let inputAllowed = true;
  let originalAccount = true;
  f.receipts.authorize = (_job, forInput) => originalAccount && (!forInput || inputAllowed);
  const first = await prepare(f);
  inputAllowed = false;
  await assert.rejects(submit(f, f.job, { baselineId: 'wrong' }), /PERMISSION_CHANGED/);
  assert.deepEqual(await submit(f, f.job, { baselineId: first.baselineId }), {
    recorded: false,
    performed: false,
    attempted: false,
    reason: 'DESKTOP_RECEIPT_PERMISSION_CHANGED',
  });
  originalAccount = false;
  await assert.rejects(submit(f, f.job, { baselineId: first.baselineId }), /PERMISSION_CHANGED/);

  originalAccount = inputAllowed = true;
  const next = await prepare(f);
  await submit(f, f.job, { baselineId: next.baselineId });
  inputAllowed = false;
  await assert.rejects(prepare(f), /PERMISSION_CHANGED/);
  await assert.rejects(submit(f, f.job, { baselineId: next.baselineId }), /PERMISSION_CHANGED/);
  f.setRows([f.row()]);
  assert.equal((await query(f)).receipt.serverId, '100');
});

test('a unique file receipt completes without MD5 and can only be claimed once', async t => {
  const f = fixture(t);
  const job = { ...f.job, operation: 'file', fileName: 'fixture.txt', size: 7, md5: 'b'.repeat(32) };
  const second = { ...job, deliveryId: 'another-file' };
  for (const item of [job, second]) {
    await prepare(f, item);
    await submit(f, item);
  }
  const row = f.row({ localType: 49, fileKind: 'appmsg-6', fileName: job.fileName, fileSize: job.size });
  f.setRows([{ ...row, fileMd5: 'c'.repeat(32) }]);
  assert.equal((await query(f, job)).confirmed, false);
  f.setRows([row, { ...row, localId: 2, serverId: '0' }]);
  assert.equal((await query(f, job)).reason, 'DESKTOP_RECEIPT_AMBIGUOUS');
  f.setRows([row]);
  const result = await query(f, job);
  assert.equal(result.confirmed, true);
  assert.equal(result.receipt.serverId, row.serverId);
  assert.equal(result.receipt.fileContentMd5Matched, false);
  assert.equal((await query(f, second)).reason, 'DESKTOP_RECEIPT_ALREADY_CLAIMED');
  f.receipts = new DesktopReceipts(f.root, f.options);
  f.setRows([{ ...row, localId: 2, serverId: '200', fileMd5: job.md5 }]);
  assert.deepEqual(await query(f, job), result);
});
test('definite no-input proof releases an intent and refreshes the baseline before continuation', async t => {
  const f = fixture(t),
    reservation = await prepare(f);
  await submit(f);
  await assert.rejects(
    f.receipts.observe(f.job, {
      phase: 'not-attempted',
      baselineId: reservation.baselineId,
      proof: { performed: false, attempted: true },
    }),
    /RELEASE_INVALID/,
  );
  await f.receipts.observe(f.job, {
    phase: 'not-attempted',
    baselineId: reservation.baselineId,
    proof: { performed: false, attempted: false },
  });
  f.setRows([f.row()]);
  f.advance(2000);
  const next = await prepare(f);
  assert.equal(next.submissionAllowed, true);
  assert.notEqual(next.baselineId, reservation.baselineId);
  await submit(f);
  await assert.rejects(
    f.receipts.observe(f.job, {
      phase: 'not-attempted',
      baselineId: reservation.baselineId,
      proof: { performed: false, attempted: false },
    }),
    /RELEASE_INVALID/,
  );
  assert.equal((await query(f)).confirmed, false);
  f.setRows([f.row(), f.row({ localId: 2, serverId: '101' })]);
  assert.equal((await query(f)).receipt.serverId, '101');
});

test('a late observation cannot overwrite a released intent', async t => {
  const f = fixture(t);
  const reservation = await prepare(f);
  await submit(f);
  const started = Promise.withResolvers();
  const result = Promise.withResolvers();
  const observer = new DesktopReceipts(f.root, {
    ...f.options,
    messages: () => {
      started.resolve();
      return result.promise;
    },
  });
  const late = observer.observe(f.job, { phase: 'query' });
  await started.promise;
  await f.receipts.observe(f.job, {
    phase: 'not-attempted',
    baselineId: reservation.baselineId,
    proof: { performed: false, attempted: false },
  });
  result.resolve({ messages: [f.row()] });
  assert.deepEqual(await late, { confirmed: false, reason: 'DESKTOP_RECEIPT_BASELINE_CHANGED' });
  assert.equal(savedDesktopReceipt(f.root, f.job), undefined);
  const next = await prepare(f);
  assert.equal(next.submissionAllowed, true);
  assert.notEqual(next.baselineId, reservation.baselineId);
});

test('concurrent observers return one durable server ID for a delivery', async t => {
  const f = fixture(t);
  await prepare(f);
  await submit(f);
  const started = Promise.withResolvers();
  const result = Promise.withResolvers();
  const observer = new DesktopReceipts(f.root, {
    ...f.options,
    messages: () => {
      started.resolve();
      return result.promise;
    },
  });
  const late = observer.observe(f.job, { phase: 'query' });
  await started.promise;
  f.setRows([f.row()]);
  const first = await query(f);
  result.resolve({ messages: [f.row({ localId: 2, serverId: '101' })] });
  assert.equal(first.receipt.serverId, '100');
  assert.deepEqual(await late, first);
  assert.deepEqual(savedDesktopReceipt(f.root, f.job), first.receipt);
});

test('concurrent preparation reuses an existing reservation even after submission', async t => {
  for (const alreadyPrepared of [false, true]) {
    const f = fixture(t);
    const old = alreadyPrepared ? await prepare(f) : null;
    const started = Promise.withResolvers();
    const result = Promise.withResolvers();
    const observer = new DesktopReceipts(f.root, {
      ...f.options,
      messages: () => {
        started.resolve(true);
        return result.promise;
      },
    });
    const late = observer.observe(f.job, { phase: 'prepare' });
    let first;
    try {
      assert.equal(await Promise.race([started.promise, late.then(() => false)]), true);
      first = await prepare(f);
      assert.notEqual(first.baselineId, old?.baselineId);
      await submit(f, f.job, { baselineId: first.baselineId });
    } finally {
      result.resolve({ messages: [], watermarks: {} });
    }
    assert.deepEqual(await late, { ...first, submissionAllowed: false });
  }
});
test('a baseline read timeout cannot report an unattempted send after a concurrent reservation', async t => {
  const f = fixture(t);
  const old = await prepare(f);
  const started = Promise.withResolvers();
  const read = Promise.withResolvers();
  const observer = new DesktopReceipts(f.root, {
    ...f.options,
    messages: () => {
      started.resolve(true);
      return read.promise;
    },
  });
  const late = observer.observe(f.job, { phase: 'prepare' });
  let current;
  try {
    assert.equal(await Promise.race([started.promise, late.then(() => false)]), true);
    current = await prepare(f);
    assert.notEqual(current.baselineId, old.baselineId);
    await submit(f, f.job, { baselineId: current.baselineId });
  } finally {
    read.reject(new DOMException('Reader timed out', 'TimeoutError'));
  }
  assert.deepEqual(await late, { ...current, submissionAllowed: false });
});

test('only one ordinary caller can reserve a shared baseline for native input', async t => {
  for (const [, fields] of receiptCases) {
    const f = fixture(t);
    const job = { ...f.job, ...fields };
    const initial = await prepare(f, job);
    const other = new DesktopReceipts(f.root, f.options);
    const request = { phase: 'submitted', baselineId: initial.baselineId, submittedAt: f.now() };
    const results = await Promise.allSettled([f.receipts.observe(job, request), other.observe(job, request)]);
    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.recorded === true).length, 1);
    assert.match(results.find(result => result.status === 'rejected')?.reason.message ?? '', /SUBMISSION_RESERVED/);

    await f.receipts.observe(job, {
      phase: 'not-attempted',
      baselineId: initial.baselineId,
      proof: { performed: false, attempted: false },
    });
    const next = await prepare(f, job);
    assert.notEqual(next.baselineId, initial.baselineId);
    assert.equal((await submit(f, job, { baselineId: next.baselineId })).recorded, true);
  }
});

test('server acknowledgement of a preexisting local row cannot confirm a new send', async t => {
  const f = fixture(t);
  f.setRows([f.row({ localId: 17, serverId: '' })]);
  await prepare(f);
  await submit(f);
  f.setRows([f.row({ localId: 17, serverId: '5001' })]);
  const reopened = new DesktopReceipts(f.root, f.options);
  assert.equal((await reopened.observe(f.job, { phase: 'query' })).confirmed, false);
  f.setRows([
    f.row({ localId: 17, serverId: '5001' }),
    f.row({ localId: 17, sourceShard: 'b'.repeat(64), serverId: '5002' }),
  ]);
  assert.equal((await query(f)).receipt.serverId, '5002');
});

test('one server ID cannot confirm two attempts and each consecutive reply keeps its own baseline', async t => {
  const f = fixture(t),
    second = { ...f.job, id: 'second', deliveryId: 'second' };
  await prepare(f);
  await prepare(f, second);
  await submit(f);
  await submit(f, second);
  f.setRows([f.row()]);
  assert.equal((await query(f)).confirmed, true);
  assert.equal((await query(f, second)).reason, 'DESKTOP_RECEIPT_ALREADY_CLAIMED');
  const third = { ...f.job, id: 'third', deliveryId: 'third' };
  await prepare(f, third);
  await submit(f, third);
  f.setRows([
    f.row(),
    f.row({ sourceShard: 'b'.repeat(64), localId: 1, serverId: '102', createTime: f.now() / 1000 + 1 }),
  ]);
  assert.equal((await query(f, third)).receipt.serverId, '102');
});
test('permission changes after a database read never write a receipt claim', async t => {
  const f = fixture(t);
  await prepare(f);
  await submit(f);
  f.setRows([f.row()]);
  f.afterRead(() => f.setAllowed(false));
  await assert.rejects(query(f), /PERMISSION_CHANGED/);
  assert.equal(savedDesktopReceipt(f.root, f.job), undefined);
});
test('query windows stay fixed and reject incoming, ambiguous or different message text', async t => {
  const f = fixture(t);
  await prepare(f);
  await submit(f);
  for (const rows of [
    [f.row({ isSend: 0 })],
    [f.row({ fullText: '正文 ' })],
    [f.row(), f.row({ serverId: '101', localId: 2 })],
  ]) {
    f.setRows(rows);
    assert.equal((await query(f)).confirmed, false);
  }
  f.advance(120000);
  f.setRows([f.row()]);
  assert.equal((await query(f)).confirmed, false);
});
test('quote receipts bind the original server ID and preserve multiline body text', async t => {
  const f = fixture(t),
    job = { ...f.job, text: '第一行\n第二行', quote: { serverId: '12345' } };
  await prepare(f, job);
  await submit(f, job);
  f.setRows([f.row({ localType: 57 * 2 ** 32 + 49, quoteReplyText: job.text, quoteSourceServerId: 'other' })]);
  assert.equal((await query(f, job)).confirmed, false);
  f.setRows([
    f.row({ localType: 57 * 2 ** 32 + 49, quoteReplyText: '第一行\r\n第二行', quoteSourceServerId: '12345' }),
  ]);
  assert.equal((await query(f, job)).receipt.sourceServerId, '12345');
});

test('competing provisional rows block text, quote, file and sticker receipts', async t => {
  const f = fixture(t);
  const md5 = 'b'.repeat(32);
  for (const [index, [operation, jobFields, rowFields]] of [
    ['text', {}, {}],
    ['text', { quote: { serverId: '555' } }, { localType: 49, quoteSourceServerId: '555', quoteReplyText: '正文' }],
    [
      'file',
      { path: 'attachment.gif', fileName: 'attachment.gif', size: 12, md5 },
      {
        localType: 49,
        fileKind: 'appmsg-6',
        fileName: 'attachment.gif',
        fileSize: 12,
        fileMd5: md5,
      },
    ],
    ['sticker', { md5 }, { localType: 47, stickerMd5: md5 }],
  ].entries()) {
    const id = 'attempt-' + operation + (jobFields.quote ? '-quote' : '');
    const job = { ...f.job, id, deliveryId: id, operation, ...jobFields };
    f.setRows([]);
    await prepare(f, job);
    await submit(f, job);
    const acknowledged = f.row({ ...rowFields, serverId: String(200 + index) });
    f.setRows([acknowledged, f.row({ ...rowFields, localId: 2, serverId: '0' })]);
    assert.equal((await query(f, job)).reason, 'DESKTOP_RECEIPT_AMBIGUOUS');
    f.setRows([acknowledged]);
    const result = await query(f, job);
    assert.equal(result.confirmed, true);
    if (operation === 'file') assert.equal(result.receipt.gifContentMd5Matched, undefined);
  }
});
test('file, native GIF and image receipts expose their actual database proof', async t => {
  const f = fixture(t),
    md5 = 'b'.repeat(32);
  const file = {
    ...f.job,
    operation: 'file',
    path: path.join(f.root, 'sha256-staged.bin'),
    fileName: '原文件.pdf',
    size: 125,
    md5,
  };
  await prepare(f, file);
  await submit(f, file);
  f.setRows([
    f.row({ localType: 6 * 2 ** 32 + 49, fileKind: 'appmsg-6', fileName: '原文件.pdf', fileSize: 125, fileMd5: md5 }),
  ]);
  const receipt = (await query(f, file)).receipt;
  assert.equal(receipt.fileName, '原文件.pdf');
  assert.equal(receipt.fileContentMd5Matched, true);
  const gif = { ...f.job, id: 'gif', deliveryId: 'gif', operation: 'sticker', path: 'fixture.gif', md5 };
  await prepare(f, gif);
  await submit(f, gif);
  f.setRows([f.row({ localId: 2, serverId: '102', localType: 1, stickerMd5: md5 })]);
  assert.equal((await query(f, gif)).confirmed, false);
  f.setRows([f.row({ localId: 2, serverId: '102', localType: 47, stickerMd5: md5 })]);
  const proof = (await query(f, gif)).receipt;
  assert.equal(proof.sourceImageMd5, md5);
  assert.equal(proof.gifContentMd5Matched, true);
  const image = { ...f.job, id: 'image', deliveryId: 'image', operation: 'image', path: 'fixture.png', md5 };
  await prepare(f, image);
  await submit(f, image);
  f.setRows([f.row({ localId: 3, serverId: '103', localType: 3 })]);
  assert.equal((await query(f, image)).reason, 'DESKTOP_IMAGE_CONTENT_UNVERIFIED');
  f.setRows([f.row({ localId: 3, serverId: '103', localType: 3, imageMd5: md5 })]);
  assert.equal((await query(f, image)).receipt.imageContentMatch, 'source-md5');
});
test('voice attempts use separate identities and their observed recording end window does not drift', async t => {
  const f = fixture(t),
    file = path.join(f.root, 'audio.wav');
  fs.writeFileSync(file, pcmWave(Buffer.alloc(32000).toString('base64')));
  const job = {
    ...f.job,
    operation: 'voice',
    segment: { id: 'segment', attemptId: 'attempt-a', index: 0, path: file },
  };
  await prepare(f, job);
  await submit(f, job);
  f.advance(3000);
  await submit(f, job, { recording: { startedAt: f.now() - 2000, releasedAt: f.now() } });
  f.setVoice(f.row({ localType: 34, createTime: Math.floor(f.now() / 1000) }));
  assert.equal((await query(f, job)).receipt.source, 'desktop-acoustic-match');
  assert.equal(f.requests[0].before, Math.floor(f.now() / 1000) + 30);
  const retry = { ...job, segment: { ...job.segment, attemptId: 'attempt-b' } };
  assert.notEqual(f.receipts.key(job), f.receipts.key(retry));
  await prepare(f, retry);
  await submit(f, retry);
  assert.equal((await query(f, retry)).reason, 'DESKTOP_RECEIPT_ALREADY_CLAIMED');
  f.advance(120000);
  f.setVoice(f.row({ localId: 2, serverId: '101' }));
  assert.equal((await query(f, retry)).confirmed, false);
});

test('voice upload confirmation may arrive after recording ends without extending its receipt window on later queries', async t => {
  const f = fixture(t),
    file = path.join(f.root, 'late.wav');
  fs.writeFileSync(file, pcmWave(Buffer.alloc(96000).toString('base64')));
  const job = { ...f.job, operation: 'voice', segment: { id: 'late', attemptId: 'late-a', index: 0, path: file } };
  await prepare(f, job);
  await submit(f, job);
  const startedAt = f.now();
  f.advance(4000);
  const releasedAt = f.now();
  await submit(f, job, { recording: { startedAt, releasedAt } });
  const expectedBefore = Math.floor(releasedAt / 1000) + 30;
  f.advance(45000);
  f.setVoice(f.row({ localType: 34 }));
  assert.equal((await query(f, job)).confirmed, false);
  assert.equal(f.requests.at(-1).before, expectedBefore);
  f.setVoice(f.row({ localType: 34, createTime: Math.floor(releasedAt / 1000) + 5 }));
  const restarted = new DesktopReceipts(f.root, f.options);
  assert.equal((await restarted.observe(job, { phase: 'query' })).receipt.source, 'desktop-acoustic-match');
  assert.equal(f.requests.at(-1).before, expectedBefore);
});

test('voice lookup restores a missing recording window only for the original reservation', async t => {
  const f = fixture(t);
  const job = { ...f.job, operation: 'voice', pcmBase64: Buffer.alloc(3200).toString('base64') };
  await prepare(f, job);
  const startedAt = f.now();
  f.advance(4000);
  const releasedAt = f.now();
  const recording = { startedAt, releasedAt };
  const observe = timing => f.receipts.observe(job, { phase: 'query', recording: timing });
  assert.equal((await observe(recording)).reason, 'DESKTOP_RECEIPT_NOT_SUBMITTED');
  assert.equal(f.requests.length, 0);
  await submit(f, job, { submittedAt: startedAt });

  f.advance(35000);
  f.setVoice(f.row({ localType: 34 }));
  assert.equal((await observe(recording)).confirmed, false);
  assert.equal(f.requests[0].before, releasedAt / 1000 + 30);
  assert.equal(
    (await observe({ startedAt, releasedAt: releasedAt + 5000 })).reason,
    'DESKTOP_RECEIPT_RECORDING_CHANGED',
  );
  assert.equal(f.requests.length, 1);
  f.setVoice(f.row({ localType: 34, createTime: releasedAt / 1000 + 5 }));
  assert.equal((await observe(recording)).receipt.source, 'desktop-acoustic-match');
  assert.equal(f.requests[1].before, f.requests[0].before);
});
test('a preexisting row cannot become a new receipt by acquiring a new creation time', async t => {
  const f = fixture(t);
  f.setRows([f.row({ localId: 80, serverId: '', createTime: 12 })]);
  await prepare(f);
  await submit(f);
  f.setRows([f.row({ localId: 75, serverId: '2002' })]);
  assert.equal((await query(f)).confirmed, false);
  f.setRows([f.row({ localId: 81, serverId: '2003' })]);
  assert.equal((await query(f)).receipt.serverId, '2003');
});

test('a mismatched or missing image digest never claims a server row, even after restart', async t => {
  const f = fixture(t),
    image = { ...f.job, operation: 'image', path: 'fixture.png', md5: 'b'.repeat(32) };
  const other = { ...image, deliveryId: 'another-image', md5: 'c'.repeat(32) };
  await prepare(f, image);
  await prepare(f, other);
  await submit(f, image);
  await submit(f, other);
  const unrelated = f.row({ localType: 3, imageMd5: other.md5 });
  for (const imageMd5 of [undefined, other.md5]) {
    f.setRows([{ ...unrelated, imageMd5 }]);
    assert.deepEqual(await query(f, image), { confirmed: false, reason: 'DESKTOP_IMAGE_CONTENT_UNVERIFIED' });
    assert.equal(savedDesktopReceipt(f.root, image), undefined);
  }

  const restarted = new DesktopReceipts(f.root, f.options);
  assert.equal((await restarted.observe(other, { phase: 'query' })).receipt.serverId, unrelated.serverId);
  const exact = f.row({ localType: 3, localId: 2, serverId: '200', imageMd5: image.md5 });
  f.setRows([unrelated, exact, { ...exact, localId: 3, serverId: '0' }]);
  assert.equal((await restarted.observe(image, { phase: 'query' })).reason, 'DESKTOP_RECEIPT_AMBIGUOUS');
  f.setRows([unrelated, exact]);
  const result = await restarted.observe(image, { phase: 'query' });
  assert.equal(result.receipt.serverId, '200');
  assert.equal(result.receipt.imageContentMatch, 'source-md5');
});

test('an archived image uses the durable Reader record for both lookup and stopped queue display', async t => {
  const f = fixture(t);
  const job = {
    ...f.job,
    id: 'a'.repeat(64),
    operation: 'image',
    path: 'fixture.png',
    md5: 'b'.repeat(32),
    rosterGrant: 'grant',
  };
  const row = { job, fingerprint: 'fixture', sequence: 1, createdAt: f.now() };
  const store = new DeliveryStore(path.join(f.root, 'state/desktop-sender', job.accountRef));
  store.save(row);
  store.retire(row, deliveryResult(job, 'unconfirmed', { inputReleased: true, inputStarted: true }));
  const list = () => savedChatDeliveries(f.root, job.accountRef, 'wechat:private:' + job.target, 'grant');
  assert.equal(list()[0].state, 'unconfirmed');
  await prepare(f, job);
  await submit(f, job);
  f.setRows([f.row({ localType: 3 })]);
  const archived = store.find(job.id);
  const engine = Object.assign(Object.create(DesktopSenderEngine.prototype), {
    root: f.root,
    authorizeCurrent: () => true,
    receipt: (source, operation) => f.receipts.observe(source, operation),
  });
  assert.equal((await engine.observe({ store }, archived, true)).state, 'unconfirmed');
  assert.equal(list()[0].state, 'unconfirmed');
  f.setRows([f.row({ localType: 3, localId: 2, serverId: '101', imageMd5: job.md5 })]);
  const result = await engine.observe({ store }, archived, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.receipt.serverId, '101');
  assert.equal(list()[0].state, 'confirmed');
  assert.equal(list()[0].receipt.serverId, '101');
  assert.equal(list()[0].receipt.imageContentMatch, 'source-md5');
});

test('a reencoded image requires local content evidence and an unambiguous server acknowledgement', async t => {
  const f = fixture(t);
  const image = {
    ...f.job,
    operation: 'image',
    path: 'fixture.png',
    md5: 'b'.repeat(32),
    sha256: 'c'.repeat(64),
    imageFingerprint: { width: 100, height: 100, pixels: 'd'.repeat(64), sample: 'A'.repeat(4096) },
  };
  await prepare(f, image);
  await submit(f, image);
  const reencoded = f.row({ localType: 3, imageMd5: 'e'.repeat(32), localId: 2 });
  const competing = { ...reencoded, localId: 3, serverId: '0' };
  f.setRows([reencoded]);
  assert.equal((await query(f, image)).reason, 'DESKTOP_IMAGE_CONTENT_UNVERIFIED');
  f.setRows([{ ...reencoded, imageRasterMatched: true }, competing]);
  assert.equal((await query(f, image)).reason, 'DESKTOP_RECEIPT_AMBIGUOUS');
  f.setRows([
    { ...reencoded, imageRasterMatched: true },
    { ...competing, imageRasterMatched: false },
  ]);
  const restart = new DesktopReceipts(f.root, f.options);
  const result = await restart.observe(image, { phase: 'query' });
  assert.equal(result.receipt.serverId, reencoded.serverId);
  assert.equal(result.receipt.imageContentMatch, 'raster');
  assert.equal(result.receipt.sourceImageSha256, image.sha256);
  assert.equal(result.receipt.imageContentVerified, false);
});

test('older archived native deliveries stay visible until their own receipt or review is recorded', async t => {
  const f = fixture(t);
  const account = f.job.accountRef;
  const directory = path.join(f.root, 'state/desktop-sender', account);
  fs.mkdirSync(directory, { recursive: true });
  const store = new DeliveryStore(directory);
  const archive = (sequence, operation, state = 'unconfirmed', jobFields = {}, outcomeFields = {}) => {
    const id = sequence.toString(16).padStart(64, '0');
    const job = { ...f.job, id, deliveryId: 'archive-' + sequence, operation, rosterGrant: 'grant', ...jobFields };
    const row = { job, fingerprint: id, sequence, createdAt: f.now() + sequence };
    store.retire(row, deliveryResult(job, state, { inputReleased: true, inputStarted: true, ...outcomeFields }));
    return job;
  };
  const text = archive(1, 'text');
  const image = archive(2, 'image', 'unconfirmed', { path: 'fixture.png', md5: 'b'.repeat(32) });
  const sticker = archive(3, 'sticker', 'unconfirmed', { path: 'fixture.gif', md5: 'c'.repeat(32) });
  const withLateReceipt = archive(4, 'text');
  const differentText = archive(5, 'text', 'unconfirmed', { text: 'surviving input checkpoint' });
  archive(6, 'image', 'unconfirmed', { path: 'fixture.png', rosterGrant: 'revoked' });
  archive(7, 'text', 'unconfirmed', { target: '456' });
  const reviewed = archive(8, 'text', 'unconfirmed', {}, { reviewed: true });
  const file = archive(9, 'file', 'unconfirmed', { path: 'fixture.txt', fileName: 'fixture.txt' });
  for (let sequence = 20; sequence < 151; sequence++) archive(sequence, 'text', 'confirmed');

  for (const [job, message] of [
    [withLateReceipt, 101],
    [{ ...differentText, text: 'different receipt binding' }, 102],
  ]) {
    f.setRows([]);
    await prepare(f, job);
    await submit(f, job);
    f.setRows([f.row({ fullText: job.text, localId: message, serverId: String(message) })]);
    assert.equal((await query(f, job)).receipt.serverId, String(message));
  }

  const context = { account: { accountRef: account }, directory, store, chatControls: { heldChats: () => [] } };
  const engine = Object.assign(Object.create(DesktopSenderEngine.prototype), {
    root: f.root,
    contexts: new Map([[account, context]]),
  });
  const scope = { accountRef: account, kind: 'private', target: f.job.target, rosterGrant: 'grant' };
  const expected = new Set([text.id, image.id, sticker.id, file.id, differentText.id]);
  for (const jobs of [
    savedChatDeliveries(f.root, account, 'wechat:private:' + f.job.target, 'grant'),
    engine.listDeliveries(scope),
  ]) {
    assert.deepEqual(new Set(jobs.filter(job => job.state === 'unconfirmed').map(job => job.id)), expected);
    assert.equal(jobs.filter(job => job.state === 'confirmed').length, 128);
    assert.equal(
      jobs.some(job => job.id === withLateReceipt.id || job.id === reviewed.id),
      false,
    );
    assert.ok(jobs.every(job => !job.canCancel && !job.canPause && !job.canResume));
  }
  assert.equal(store.find(withLateReceipt.id).outcome.state, 'unconfirmed');
  assert.equal(savedDesktopReceipt(f.root, withLateReceipt).serverId, '101');
});

for (const [operation, evidence] of [
  ['text', { localType: 1, fullText: 'late receipt' }],
  ['sticker', { localType: 47, stickerMd5: 'b'.repeat(32) }],
]) {
  test('archived ' + operation + ' confirms a late receipt without reopening input', async t => {
    const f = fixture(t);
    const job = {
      ...f.job,
      id: 'b'.repeat(64),
      operation,
      text: 'late receipt',
      md5: 'b'.repeat(32),
      rosterGrant: 'grant',
    };
    const row = { job, fingerprint: 'fixture', sequence: 1, createdAt: f.now() };
    const store = new DeliveryStore(path.join(f.root, 'state/desktop-sender', job.accountRef));
    store.save(row);
    store.retire(row, deliveryResult(job, 'unconfirmed', { inputReleased: true, inputStarted: true }));
    await prepare(f, job);
    await submit(f, job);
    const engine = Object.assign(Object.create(DesktopSenderEngine.prototype), {
      root: f.root,
      authorizeCurrent: (_job, input) => input === false,
      receipt: (source, options) => {
        assert.equal(options.phase, 'query');
        return f.receipts.observe(source, options);
      },
    });
    const archived = store.find(job.id);
    assert.equal((await engine.observe({ store }, archived, true)).state, 'unconfirmed');
    f.setRows([f.row({ localId: 2, serverId: '101', ...evidence })]);
    const confirmed = await engine.observe({ store }, archived, true);
    assert.equal(confirmed.state, 'confirmed');
    assert.equal(confirmed.receipt.serverId, '101');
    const saved = savedChatDeliveries(f.root, job.accountRef, 'wechat:private:' + job.target, 'grant')[0];
    assert.equal(saved.state, 'confirmed');
    assert.equal(saved.canResume, false);
  });
}
