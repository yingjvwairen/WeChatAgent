import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DesktopReceipts } from './desktop-receipts.mjs';
import { pcmWave } from './desktop-sender/engine-voice.mjs';

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

test('late database rows from the preceding second cannot confirm ordinary sends', async t => {
  const f = fixture(t);
  const md5 = 'b'.repeat(32);
  let nextId = 801;
  for (const [job, matching] of [
    [f.job, {}],
    [
      { ...f.job, operation: 'text', deliveryId: 'quote', quote: { serverId: '25' } },
      { localType: 49, quoteSourceServerId: '25', quoteReplyText: f.job.text },
    ],
    [
      { ...f.job, operation: 'image', path: 'fixture.png', md5 },
      { localType: 3, imageMd5: md5 },
    ],
    [
      { ...f.job, operation: 'sticker', path: 'fixture.gif', md5 },
      { localType: 47, stickerMd5: md5 },
    ],
    [
      { ...f.job, operation: 'file', fileName: 'fixture.txt', size: 10, md5 },
      { localType: 49, fileKind: 'appmsg-6', fileName: 'fixture.txt', fileSize: 10 },
    ],
  ]) {
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
  assert.equal(fs.existsSync(path.join(f.root, 'state/desktop/receipt-claims')), false);
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
  assert.equal((await query(f, image)).receipt.sourceMd5Matched, true);
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

test('re-encoded static images require applied native input and a unique new server row', async t => {
  const f = fixture(t),
    image = { ...f.job, operation: 'image', path: 'fixture.png', md5: 'b'.repeat(32) };
  const { baselineId } = await prepare(f, image);
  await submit(f, image);
  const row = f.row({ localType: 3, imageMd5: 'c'.repeat(32) });
  f.setRows([row]);
  assert.equal((await query(f, image)).confirmed, false);
  await f.receipts.observe(image, { phase: 'image-input-applied', baselineId });
  f.setRows([row, { ...row, localId: 2, serverId: '0' }]);
  assert.equal((await query(f, image)).reason, 'DESKTOP_RECEIPT_AMBIGUOUS');
  f.setRows([{ ...row, createTime: row.createTime + 10 }]);
  assert.equal((await query(f, image)).confirmed, false);
  f.setRows([row]);
  const proof = (await query(f, image)).receipt;
  assert.deepEqual(
    [proof.nativeImageRowConfirmed, proof.nativeSubmitVerified, proof.sourceMd5Matched, proof.imageContentVerified],
    [true, true, false, false],
  );
});
