import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runSubmitPreview, validateSubmitPreview } from './ui-submit-preview.mjs';
import { UiReaderReceipts } from './ui-reader-receipts.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-submit-preview-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^wechat-submit-preview-/); fs.rmSync(directory, { recursive: true, force: true }); });
  let at = 1800000000000;
  const signal = new AbortController(), calls = [], counts = { submit: 0, prepare: 0, query: 0, marked: 0 };
  const options = { directory, deliveryId: 'a'.repeat(64), accountWxid: 'fixture_account', accountDirectory: 'fixture_account_dir', accountRef: 'fixture-reference',
    accountScopeHash: 'b'.repeat(64), target: 'filehelper', text: '  具体测试文字😀  ', permission: { sendPreview: true, target: 'filehelper' },
    freshSession: async () => { calls.push('fresh'); return fresh(); } };
  options.permission.textSha256 = hash(options.text);
  const fresh = () => ({ session: { target: 'filehelper', accountScopeHash: options.accountScopeHash, pid: 42, processCreatedFileTimeUtc: '12345',
    editorFocusProof: { kind: 'operator-calibrated-edit-region' }, sendButtonRect: { left: 20, top: 20, right: 40, bottom: 40 } },
    accountProof: { accountRef: options.accountRef, accountScopeHash: options.accountScopeHash, evidence: { ok: true, proof: 'process-open-database-v1',
      complete: true, processOpenedExpectedDatabase: true, processId: 42, processCreatedFileTimeUtc: '12345', observedAtUtc: new Date(at).toISOString(),
      maximumEvidenceAgeMs: 500, snapshotAtomic: false, consistentPathScans: 2, accountRootsObserved: 1,
      ready: false, desktopAccountVerified: false, targetVerified: false, draftVerified: false, inputSent: false } } });
  const context = () => ({ accountWxid: options.accountWxid, accountDirectory: options.accountDirectory, accountRef: options.accountRef,
    baseUrl: 'http://127.0.0.1:1234', token: 'PRIVATE-TOKEN', signal: signal.signal, expiresAt: at + 24000 });
  const receipt = job => ({ type: 'wechat-database-text-v1', deliveryId: job.id, account: job.account, accountDirectory: options.accountDirectory,
    target: job.target, textSha256: hash(job.text), sourceShard: 'c'.repeat(64), localId: '23', serverId: '987654321', createTime: Math.floor(job.submittedAt / 1000), observedAt: at });
  const receipts = {
    checkBinding: async () => { calls.push('binding'); return { verified: true, account: options.accountWxid, accountDirectory: options.accountDirectory }; },
    prepare: async () => { calls.push('prepare'); counts.prepare++; return { submissionAllowed: true, preparationToken: 'fixture-token' }; },
    markNotSubmitted: async () => { counts.marked++; return { notSubmitted: true }; },
    query: async job => { calls.push('query'); counts.query++; return { confirmed: true, receipt: receipt(job) }; },
  };
  const dependencies = { now: () => at, wait: async ms => { at += ms; }, withLocalReceiptApi: async ({ callback }) => { await callback(context()); return { processStopped: true }; },
    receiptsFactory: () => receipts, submitDraftPreview: async request => { calls.push('submit'); counts.submit++;
      assert.equal(request.expectedDraft, options.text); assert.equal(request.permission.submitPreview, true); assert.equal(request.session.target, 'filehelper');
      const persisted = JSON.parse(fs.readFileSync(path.join(directory, options.deliveryId + '.json'), 'utf8')); assert.equal(persisted.state, 'submit-intent');
      return { sendInputAttempted: true, submitAttempted: true, submitInputApplied: true, deliveryConfirmed: false }; } };
  return { options, dependencies, counts, calls, receipts, fresh, context, receipt, signal, advance: ms => { at += ms; },
    stored: () => JSON.parse(fs.readFileSync(path.join(directory, options.deliveryId + '.json'), 'utf8')) };
}

test('single preview persists before click and only exact raw receipt confirms; no text/token stored', async t => {
  const f = fixture(t), result = await runSubmitPreview(f.options, f.dependencies);
  assert.equal(result.state, 'confirmed'); assert.equal(result.ready, false); assert.equal(result.unattendedReady, false);
  assert.equal(result.readerSessionStopped, true); assert.equal(result.cleanupUnknown, false);
  assert.deepEqual(f.calls, ['binding', 'prepare', 'fresh', 'submit', 'query']);
  const saved = JSON.stringify(f.stored()); assert.equal(saved.includes(f.options.text), false); assert.equal(saved.includes('PRIVATE-TOKEN'), false);
  assert.equal((await runSubmitPreview(f.options, f.dependencies)).reused, true); assert.equal(f.counts.submit, 1); assert.equal(f.counts.prepare, 1);
});

test('specific text hash and filehelper permission are mandatory before any filesystem or callback', async t => {
  const f = fixture(t);
  for (const change of [v => { v.target = 'other'; }, v => { v.permission.sendPreview = false; }, v => { v.permission.textSha256 = hash(v.text.trim()); }, v => { v.permission.target = 'other'; }]) {
    const options = { ...f.options, permission: { ...f.options.permission } }; change(options);
    await assert.rejects(runSubmitPreview(options, f.dependencies));
  }
  assert.equal(f.counts.submit, 0); assert.equal(fs.readdirSync(f.options.directory).length, 0);
});

test('lost native response remains unknown; repeated ID queries without prepare or submission', async t => {
  const f = fixture(t); f.dependencies.submitDraftPreview = async () => { f.counts.submit++; throw Error('private raw failure'); };
  f.receipts.query = async () => ({ confirmed: false });
  const first = await runSubmitPreview(f.options, f.dependencies); assert.equal(first.state, 'unknown'); assert.equal(f.counts.marked, 0);
  f.receipts.query = async job => ({ confirmed: true, receipt: f.receipt(job) });
  assert.equal((await runSubmitPreview(f.options, f.dependencies)).confirmed, true);
  assert.equal(f.counts.submit, 1); assert.equal(f.counts.prepare, 1);
});

test('definite pre-click native refusal persists not-submitted and is never automatically retried', async t => {
  const f = fixture(t); f.dependencies.submitDraftPreview = async () => { f.counts.submit++; throw Object.assign(Error('DRAFT_FOCUS_CHANGED'), { code: 'DRAFT_FOCUS_CHANGED', sendInputAttempted: false, submitAttempted: false }); };
  const result = await runSubmitPreview(f.options, f.dependencies);
  assert.equal(result.state, 'not-submitted'); assert.equal(result.nativeReason, 'DRAFT_FOCUS_CHANGED');
  assert.equal(f.counts.marked, 1); assert.equal(f.counts.query, 0);
  await runSubmitPreview(f.options, f.dependencies); assert.equal(f.counts.submit, 1);
});

test('account mismatch, stale evidence and cancelled fresh calibration cannot reach the sender', async t => {
  for (const type of ['reference', 'process', 'stale', 'abort']) {
    const f = fixture(t);
    f.options.freshSession = async () => { const value = f.fresh();
      if (type === 'reference') value.accountProof.accountRef = 'different';
      if (type === 'process') value.accountProof.evidence.processId++;
      if (type === 'stale') f.advance(501);
      if (type === 'abort') f.signal.abort();
      return value; };
    const result = await runSubmitPreview(f.options, f.dependencies);
    assert.equal(result.state, 'not-submitted'); assert.equal(f.counts.submit, 0); assert.equal(f.counts.marked, 1);
  }
});

test('a submitted-looking result does not confirm without a bound receipt', async t => {
  for (const field of ['deliveryId', 'account', 'accountDirectory', 'target', 'textSha256', 'serverId']) {
    const f = fixture(t); f.receipts.query = async job => ({ confirmed: true, receipt: { ...f.receipt(job), [field]: field === 'serverId' ? '0' : 'wrong' } });
    const result = await runSubmitPreview(f.options, f.dependencies);
    assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'UI_PREVIEW_RECEIPT_MISMATCH'); assert.equal(f.counts.submit, 1);
  }
});

test('an existing ID with different content is rejected and a crash before native call cannot replay', async t => {
  const f = fixture(t), binding = validateSubmitPreview(f.options);
  fs.writeFileSync(path.join(f.options.directory, f.options.deliveryId + '.json'), JSON.stringify({ ...binding, state: 'created', createdAt: 1800000000000, updatedAt: 1800000000000 }));
  assert.equal((await runSubmitPreview(f.options, f.dependencies)).reused, true); assert.equal(f.counts.submit, 0);
  const changed = { ...f.options, text: 'changed', permission: { ...f.options.permission, textSha256: hash('changed') } };
  await assert.rejects(runSubmitPreview(changed, f.dependencies), { code: 'UI_PREVIEW_STATE_INVALID' });
});

test('concurrent runs cannot both submit the same delivery ID', async t => {
  const f = fixture(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), paused = new Promise(resolve => { release = resolve; });
  f.options.freshSession = async () => { entered(); await paused; return f.fresh(); };
  const first = runSubmitPreview(f.options, f.dependencies); await ready;
  await assert.rejects(runSubmitPreview(f.options, f.dependencies), { code: 'UI_PREVIEW_BUSY' });
  release(); await first; assert.equal(f.counts.submit, 1);
});

test('local API timeout cannot leave a delayed calibration able to invoke native input', async t => {
  const f = fixture(t); let release, entered, callbackRun;
  const ready = new Promise(resolve => { entered = resolve; }), paused = new Promise(resolve => { release = resolve; });
  f.options.freshSession = async () => { entered(); await paused; return f.fresh(); };
  f.dependencies.withLocalReceiptApi = async ({ callback }) => { callbackRun = callback(f.context()).catch(() => {}); await ready; throw Error('timeout'); };
  assert.equal((await runSubmitPreview(f.options, f.dependencies)).state, 'unknown');
  release(); await callbackRun; assert.equal(f.counts.submit, 0); assert.equal(f.stored().state, 'unknown');
});

test('real receipt client with fake HTTP proves a post-click new server receipt without network access', async t => {
  const f = fixture(t); let sent = false, baselines = 0;
  f.dependencies.receiptsFactory = config => new UiReaderReceipts({ ...config, fetchImpl: async url => {
    const address = new URL(url), data = address.pathname.endsWith('/status')
      ? { success: true, backend: 'weflow-cli-nt', ownWxid: f.options.accountWxid, accountDirectory: f.options.accountDirectory }
      : { success: true, scope: { version: 1, complete: true, accountWxid: f.options.accountWxid, accountDirectory: f.options.accountDirectory,
        talker: 'filehelper', fromTime: Number(address.searchParams.get('from_time')), throughTime: Math.floor(f.dependencies.now() / 1000) },
        messages: sent ? [{ sourceShard: 'c'.repeat(64), localId: '23', serverId: '987654321', localType: 1, createTime: Math.floor(f.dependencies.now() / 1000),
          senderUsername: f.options.accountWxid, isSend: 1, fullText: f.options.text }] : [] };
    if (!address.pathname.endsWith('/status') && !sent) baselines++;
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  } });
  const submit = f.dependencies.submitDraftPreview;
  f.dependencies.submitDraftPreview = async request => { const value = await submit(request); sent = true; return value; };
  const result = await runSubmitPreview(f.options, f.dependencies);
  assert.equal(result.confirmed, true); assert.equal(result.receipt.serverId, '987654321'); assert.equal(baselines, 1); assert.equal(f.counts.submit, 1);
});

test('conflicting or incomplete native false flags are unknown, not proof of no click', async t => {
  for (const submitAttempted of [true, undefined, null]) {
    const f = fixture(t); f.dependencies.submitDraftPreview = async () => ({ sendInputAttempted: false, submitAttempted });
    f.receipts.query = async () => ({ confirmed: false });
    assert.equal((await runSubmitPreview(f.options, f.dependencies)).state, 'unknown'); assert.equal(f.counts.marked, 0);
  }
});

test('cleanup failure stays visible even when the message already has a confirmed receipt', async t => {
  const f = fixture(t);
  f.dependencies.withLocalReceiptApi = async ({ callback }) => { await callback(f.context()); throw Object.assign(Error('private failure detail'), { code: 'READER_LOCAL_API_CLEANUP_UNCONFIRMED' }); };
  const result = await runSubmitPreview(f.options, f.dependencies);
  assert.equal(result.confirmed, true); assert.equal(result.readerSessionStopped, false); assert.equal(result.cleanupUnknown, true);
  assert.equal(result.cleanupReason, 'READER_LOCAL_API_CLEANUP_UNCONFIRMED'); assert.equal(JSON.stringify(result).includes('private failure'), false);
  assert.equal((await runSubmitPreview(f.options, f.dependencies)).cleanupUnknown, true); assert.equal(f.counts.submit, 1);
});

test('native reasons retain only bounded DRAFT codes and never private exception text', async t => {
  for (const code of ['DRAFT_EDITOR_FOCUS_CHANGED', 'PRIVATE draft content', 'DRAFT_' + 'X'.repeat(81)]) {
    const f = fixture(t); f.dependencies.submitDraftPreview = async () => { throw Object.assign(Error('PRIVATE draft content'), { code, sendInputAttempted: false, submitAttempted: false }); };
    const result = await runSubmitPreview(f.options, f.dependencies);
    assert.equal(result.nativeReason, code === 'DRAFT_EDITOR_FOCUS_CHANGED' ? code : null);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(JSON.stringify(f.stored()).includes('PRIVATE'), false);
  }
});
