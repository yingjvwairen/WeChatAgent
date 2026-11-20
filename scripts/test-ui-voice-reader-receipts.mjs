import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UiVoiceReaderReceipts } from './ui-voice-reader-receipts.mjs';

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-receipt-fixture-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^voice-receipt-fixture-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  let at = 1700000000000;
  const state = { rows: [], account: 'fixture-self', complete: true, fail: false, delay: false, calls: 0 };
  const fetchImpl = async (url, request) => {
    assert.equal(new URL(url).hostname, '127.0.0.1'); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer fixture-token'); state.calls++;
    if (state.delay) await new Promise(resolve => setTimeout(resolve, 30));
    if (state.fail) throw new Error('PRIVATE ERROR');
    const u = new URL(url);
    const data = u.pathname === '/api/v1/reader/status' ? { success: true, backend: 'weflow-cli-nt', ownWxid: state.account, accountDirectory: 'fixture-account' } :
      { success: true, messages: state.rows, scope: { version: 1, accountWxid: state.account, accountDirectory: 'fixture-account', talker: state.scopeTarget ?? u.searchParams.get('talker'), complete: state.complete,
        fromTime: Number(u.searchParams.get('from_time')), throughTime: Math.floor(at / 1000) } };
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const config = { directory, baseUrl: 'http://127.0.0.1:19999', token: 'fixture-token', accountWxid: 'fixture-self', accountDirectory: 'fixture-account', fetchImpl, now: () => at, ...options };
  const reader = new UiVoiceReaderReceipts(config);
  const job = { id: 'a'.repeat(64), account: 'fixture-self', target: 'filehelper', submittedAt: at, deadlineAt: at + 20000, minDurationMs: 4500, maxDurationMs: 5500 };
  const row = (changes = {}) => ({ sourceShard: 'b'.repeat(64), localId: '10', serverId: '500', localType: 34, createTime: at / 1000, senderUsername: 'fixture-self', isSend: 1, voice: { version: 1, durationMs: 5000 }, ...changes });
  return { directory, config, reader, state, job, row, advance: ms => { at += ms; } };
}

test('confirms only a unique new native voice row, with explicit content/timbre limitations', async t => {
  const f = fixture(t);
  assert.equal((await f.reader.checkBinding()).desktopAccountVerified, false);
  assert.equal((await f.reader.prepare(f.job)).submissionAllowed, true);
  f.state.rows = [f.row()];
  const result = await f.reader.query(f.job);
  assert.equal(result.confirmed, true); assert.equal(result.receipt.deliveryId, f.job.id); assert.equal(result.receipt.durationMs, 5000);
  assert.equal(result.receipt.nativeVoiceRowConfirmed, true); assert.equal(result.receipt.audioContentVerified, false); assert.equal(result.receipt.timbreVerified, false);
  assert.equal(result.receipt.type, 'wechat-database-voice-v1'); assert.equal(Object.hasOwn(result.receipt, 'fullText'), false);
  const next = new UiVoiceReaderReceipts({ ...f.config, token: 'different-session-token' });
  assert.deepEqual(await next.query(f.job), result);
  assert.equal((await next.prepare(f.job)).submissionAllowed, false);
});

test('baseline excludes existing shard rows and server IDs, even if their other identity changes', async t => {
  for (const change of [{ serverId: '501' }, { localId: '11' }, { sourceShard: 'c'.repeat(64) }]) {
    const f = fixture(t); f.state.rows = [f.row()]; await f.reader.prepare(f.job);
    f.state.rows = [f.row(change)]; assert.equal((await f.reader.query(f.job)).confirmed, false);
  }
});

test('ambiguity, missing server ID and unparseable competing voice cannot confirm', async t => {
  const cases = [f => [f.row(), f.row({ localId: '11', serverId: '501' })], f => [f.row({ serverId: '0' })],
    f => [f.row(), f.row({ localId: '11', serverId: '501', voice: undefined })]];
  for (const rows of cases) {
    const f = fixture(t); await f.reader.prepare(f.job); f.state.rows = rows(f);
    assert.equal((await f.reader.query(f.job)).confirmed, false);
  }
});

test('sender prefix spoof, incoming row, text, out-of-window time and wrong duration remain pending', async t => {
  for (const changes of [{ senderUsername: 'fixture-self-extra' }, { isSend: 0 }, { localType: 1, fullText: 'voice' },
    { createTime: 1699999999 }, { voice: { version: 1, durationMs: 1000 } }]) {
    const f = fixture(t); await f.reader.prepare(f.job); f.state.rows = [f.row(changes)];
    assert.equal((await f.reader.query(f.job)).confirmed, false);
  }
});

test('unsupported voice metadata or raw XML fields fail closed', async t => {
  for (const changes of [{ voice: { version: 2, durationMs: 5000 } }, { voice: { version: 1, durationMs: 5000, xml: 'private' } },
    { fullText: '<msg>private</msg>' }, { voice: { version: 1, durationMs: 0 } }]) {
    const f = fixture(t); await f.reader.prepare(f.job); f.state.rows = [f.row(changes)];
    assert.equal((await f.reader.query(f.job)).confirmed, false);
  }
});

test('account mismatch, incomplete scope and query failures never confirm or permit reprepare', async t => {
  const f = fixture(t); await f.reader.prepare(f.job); f.state.rows = [f.row()];
  f.state.account = 'wrong-account'; assert.equal((await f.reader.query(f.job)).confirmed, false);
  f.state.account = 'fixture-self'; f.state.complete = false; assert.equal((await f.reader.query(f.job)).confirmed, false);
  f.state.complete = true; f.state.fail = true; assert.equal((await f.reader.query(f.job)).reason, 'UI_VOICE_RECEIPT_UNAVAILABLE');
  assert.equal((await f.reader.prepare(f.job)).submissionAllowed, false);
});

test('delivery ID reuse with changed scope, range or timestamp is rejected', async t => {
  const f = fixture(t); await f.reader.prepare(f.job);
  for (const changes of [{ minDurationMs: 4000 }, { submittedAt: f.job.submittedAt + 1 }, { deadlineAt: f.job.deadlineAt + 1 }]) {
    await assert.rejects(f.reader.prepare({ ...f.job, ...changes }), { code: 'UI_VOICE_RECEIPT_BINDING_MISMATCH' });
    assert.equal((await f.reader.query({ ...f.job, ...changes })).confirmed, false);
  }
  for (const changes of [{ target: 'other' }, { account: 'wrong' }, { minDurationMs: 0 }, { maxDurationMs: 100000 }])
    await assert.rejects(f.reader.prepare({ ...f.job, ...changes }), { code: 'UI_VOICE_RECEIPT_JOB_INVALID' });
});

test('preparation timeout and cancellation cannot write a late baseline', async t => {
  const f = fixture(t, { timeoutMs: 10 }); f.state.delay = true;
  await assert.rejects(f.reader.prepare(f.job), { code: 'UI_VOICE_RECEIPT_TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(fs.readdirSync(f.reader.directory), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.reader.prepare(f.job, { signal: controller.signal }), { code: 'UI_VOICE_RECEIPT_ABORTED' });
  assert.deepEqual(fs.readdirSync(f.reader.directory), []);
});

test('pending state persists across sessions without query success or duplicate preparation', async t => {
  const f = fixture(t); await f.reader.prepare(f.job);
  assert.equal((await f.reader.query(f.job)).confirmed, false);
  const next = new UiVoiceReaderReceipts(f.config); assert.equal((await next.prepare(f.job)).submissionAllowed, false);
  f.advance(301000); assert.equal((await next.query(f.job)).reason, 'UI_VOICE_RECEIPT_QUERY_EXPIRED');
  const saved = fs.readFileSync(path.join(f.reader.directory, f.job.id + '.json'), 'utf8');
  assert.equal(saved.includes('fixture-token'), false); assert.equal(saved.includes('http:'), false);
});

test('private target receipt scope is explicit and cannot bleed into another chat', async t => {
  const f = fixture(t, { allowedTargets: ['fixture-friend'] }); f.job.target = 'fixture-friend';
  assert.equal((await f.reader.prepare(f.job)).submissionAllowed, true);
  f.state.rows = [f.row()]; assert.equal((await f.reader.query(f.job)).confirmed, true);
  await assert.rejects(f.reader.prepare({ ...f.job, id: 'c'.repeat(64), target: 'filehelper' }), { code: 'UI_VOICE_RECEIPT_JOB_INVALID' });
  const g = fixture(t, { allowedTargets: ['fixture-friend'] }); g.job.target = 'fixture-friend'; g.state.scopeTarget = 'other';
  await assert.rejects(g.reader.prepare(g.job), { code: 'UI_VOICE_RECEIPT_SCOPE_INVALID' });
});
test('group voice receipt uses the exact selected room and refuses another room',async t=>{
  const f=fixture(t,{allowedTargets:['fixture-room@chatroom']});f.job.target='fixture-room@chatroom';
  assert.equal((await f.reader.prepare(f.job)).submissionAllowed,true);
  f.state.rows=[f.row()];assert.equal((await f.reader.query(f.job)).confirmed,true);
  await assert.rejects(f.reader.prepare({...f.job,id:'d'.repeat(64),target:'other-room@chatroom'}),{code:'UI_VOICE_RECEIPT_JOB_INVALID'});
});

test('self and duplicate receipt target configurations are rejected', t => {
  const f = fixture(t);
  for (const allowedTargets of [['fixture-self'], ['friend', 'friend'], []])
    assert.throws(() => new UiVoiceReaderReceipts({ ...f.config, allowedTargets }), { code: 'UI_VOICE_RECEIPT_CONFIG_INVALID' });
});

test('voice XML parser tests run with local in-memory fixtures only', t => {
  const python = path.resolve(import.meta.dirname, '../state/reader/venv/Scripts/python.exe');
  if (!fs.existsSync(python)) { t.skip('Reader Python unavailable'); return; }
  const result = spawnSync(python, ['-I', '-B', path.join(import.meta.dirname, 'test-voice-reader-receipts.py')], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
