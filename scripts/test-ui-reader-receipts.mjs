import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { UiReaderReceipts } from './ui-reader-receipts.mjs';
import { createReceiptUiDriver } from './ui-onebot.mjs';

const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-ui-receipt-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('wechat-ui-receipt-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const clock = { now: 1700000001000 }, state = { rows: [], account: 'fixture_account', complete: true, requests: [] };
  const config = { directory, baseUrl: 'http://127.0.0.1:5031', token: 'fixture-token', accountWxid: 'fixture_account', accountDirectory: 'fixture_account_abcd', now: () => clock.now,
    fetchImpl: async (url, init) => {
      state.requests.push({ url, init }); const address = new URL(url);
      const bound = state.receiptBindingVersion === 1 ? { receiptBindingVersion: 1, backend: 'weflow-cli-nt', ownWxid: state.account, accountDirectory: config.accountDirectory } : {};
      if (address.pathname.endsWith('/status')) return response({ success: true, backend: 'weflow-cli-nt', ownWxid: state.account, accountDirectory: config.accountDirectory, ...bound });
      return response({ success: true, scope: { version: 1, accountWxid: state.account, accountDirectory: config.accountDirectory, talker: address.searchParams.get('talker'),
        fromTime: Number(address.searchParams.get('from_time')), throughTime: Math.floor(clock.now / 1000), complete: state.complete }, messages: state.rows, ...bound });
    }, ...options };
  const client = new UiReaderReceipts(config);
  const job = { id: 'a'.repeat(64), account: config.accountWxid, target: 'filehelper', text: '  exact fixture text\n', submittedAt: clock.now, deadlineAt: clock.now + 30000 };
  const row = (extra = {}) => ({ sourceShard: 'b'.repeat(64), localId: '1', serverId: '123', localType: 1, createTime: Math.floor(clock.now / 1000),
    senderUsername: config.accountWxid, isSend: 1, fullText: job.text, ...extra });
  return { directory, client, config, job, state, clock, row };
}

test('a quoted delivery confirms only a fresh native quote of the expected server message and exact reply', async t=>{
  const f=fixture(t);
  const serverId='9876543210123456789';
  const id=createHash('sha256').update(f.job.target+'\0'+serverId).digest('hex');
  f.job.quote={id,serverId,text:'original',timestamp:100,sender:f.job.target};
  await f.client.prepare(f.job);
  const quoteRow={localType:57*2**32+49,quoteReply:{messageId:serverId,reply:f.job.text}};
  for(const fields of [{},{...quoteRow,quoteReply:{messageId:'11',reply:f.job.text}},{...quoteRow,quoteReply:{messageId:serverId,reply:'other'}}]){
    f.state.rows=[f.row(fields)]; assert.equal((await f.client.query(f.job)).confirmed,false);
  }
  f.state.rows=[f.row(quoteRow)];
  assert.equal((await f.client.query(f.job)).receipt.quoteEventId,id);
  assert.equal((await f.client.query({...f.job,quote:undefined})).confirmed,false);
});

test('media reference requires the selected attachment ID even if nearby messages have the same visible label',async t=>{
  const f=fixture(t), serverId='9007199254740993';
  f.job.quote={serverId,id:createHash('sha256').update(f.job.target+'\0'+serverId).digest('hex'),timestamp:90,
    sender:f.job.target,kind:'voice',text:'[语音]',locator:{rows:[{kind:'voice'},{kind:'voice'}],index:1}};
  await f.client.prepare(f.job);
  const row=f.row({localType:49,quoteReply:{messageId:'9007199254740992',reply:f.job.text}});
  f.state.rows=[row];assert.equal((await f.client.query(f.job)).confirmed,false);
  f.state.rows=[f.row({...row,quoteReply:{messageId:serverId,reply:f.job.text}})];
  assert.equal((await f.client.query(f.job)).receipt.quoteEventId,f.job.quote.id);
});

test('negotiated receipt binding uses one HTTP query per preparation and confirmation without moving submission time', async t => {
  const f = fixture(t); f.state.receiptBindingVersion = 1;
  await f.client.checkBinding(); assert.equal(f.state.requests.length, 1);
  f.state.requests.length = 0; f.state.rows = [f.row()]; f.clock.now += 1001;
  const prepared = await f.client.prepare(f.job);
  assert.equal(prepared.submissionAllowed, true);
  assert.deepEqual(f.state.requests.map(r => new URL(r.url).pathname), ['/api/v1/messages']);
  const saved = JSON.parse(fs.readFileSync(path.join(f.client.directory, f.job.id + '.json')));
  assert.equal(saved.submittedAt, f.job.submittedAt); assert.equal(saved.deadlineAt, f.job.deadlineAt);
  assert.equal(saved.fromTime, Math.floor(f.job.submittedAt / 1000) - 1); assert.equal(saved.preparedAt, f.clock.now);
  assert.equal(saved.baselineRows.length, 1); assert.deepEqual(saved.baselineServerIds, ['123']);
  assert.equal((await f.client.prepare(f.job)).submissionAllowed, false); assert.equal(f.state.requests.length, 1);
  f.state.rows.push(f.row({ localId: '2', serverId: '124' })); f.state.requests.length = 0;
  const confirmed = await f.client.query(f.job);
  assert.equal(confirmed.confirmed, true); assert.equal(confirmed.receipt.serverId, '124');
  assert.deepEqual(f.state.requests.map(r => new URL(r.url).pathname), ['/api/v1/messages']);
});

test('parallel native preflight keeps the original durable baseline and excludes same-second existing text',async t=>{
  const f=fixture(t);f.state.receiptBindingVersion=1;await f.client.checkBinding();f.state.rows=[f.row()];
  let finish,readonlyStarted=false,inputs=0;
  f.client.fetchImpl=async(url,init)=>{assert.equal(readonlyStarted,true);await new Promise(resolve=>{finish=resolve;});return f.config.fetchImpl(url,init);};
  const native={textSubmitPreparationPolicy:'receipt-barrier-v1',async submit(_job,_guard,local){
    readonlyStarted=true;await local.beforeSubmit();assert.equal(local.canSubmit(),true);
    const saved=JSON.parse(fs.readFileSync(path.join(f.client.directory,f.job.id+'.json')));
    assert.equal(saved.state,'prepared');assert.equal(saved.submittedAt,f.job.submittedAt);assert.equal(saved.deadlineAt,f.job.deadlineAt);
    assert.equal(saved.fromTime,Math.floor(f.job.submittedAt/1000)-1);assert.equal(saved.baselineRows.length,1);assert.deepEqual(saved.baselineServerIds,['123']);
    inputs++;return{performed:true,attempted:true};
  }};
  const driver=createReceiptUiDriver({native,receipts:f.client,inputAllowed:()=>true}),pending=driver.submit(f.job,{});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(inputs,0);finish();assert.equal((await pending).performed,true);assert.equal(inputs,1);
  f.client.fetchImpl=f.config.fetchImpl;assert.equal((await f.client.query(f.job)).confirmed,false);
  f.state.rows.push(f.row({localId:'2',serverId:'124'}));assert.equal((await f.client.query(f.job)).receipt.serverId,'124');
  await assert.rejects(driver.submit(f.job,{}),{code:'UI_RECEIPT_ATTEMPT_ALREADY_PREPARED'});assert.equal(inputs,1);
});

test('old Readers retain status/messages/status and an unnegotiated new Reader is checked before its first query', async t => {
  const old = fixture(t); await old.client.prepare(old.job);
  assert.deepEqual(old.state.requests.map(r => new URL(r.url).pathname), ['/api/v1/reader/status', '/api/v1/messages', '/api/v1/reader/status']);
  old.state.requests.length = 0; await old.client.query(old.job);
  assert.deepEqual(old.state.requests.map(r => new URL(r.url).pathname), ['/api/v1/reader/status', '/api/v1/messages', '/api/v1/reader/status']);
  const fresh = fixture(t); fresh.state.receiptBindingVersion = 1; await fresh.client.prepare(fresh.job);
  assert.deepEqual(fresh.state.requests.map(r => new URL(r.url).pathname), ['/api/v1/reader/status', '/api/v1/messages']);
});

test('real loopback HTTP observes one negotiated request versus three legacy requests per receipt operation', { timeout: 10000 }, async t => {
  for (const modern of [false, true]) {
    const f = fixture(t), requests = [];
    const identity = { backend: 'weflow-cli-nt', ownWxid: f.config.accountWxid, accountDirectory: f.config.accountDirectory };
    const binding = modern ? { ...identity, receiptBindingVersion: 1 } : {};
    const server = http.createServer((request, reply) => {
      const url = new URL(request.url, 'http://127.0.0.1'); requests.push(url.pathname);
      if (request.headers.authorization !== 'Bearer ' + f.config.token) { reply.writeHead(401).end(); return; }
      const data = url.pathname.endsWith('/status') ? { success: true, ...identity, ...binding } : {
        success: true, ...binding, scope: { version: 1, complete: true, accountWxid: f.config.accountWxid,
          accountDirectory: f.config.accountDirectory, talker: url.searchParams.get('talker'),
          fromTime: Number(url.searchParams.get('from_time')), throughTime: Math.floor(f.clock.now / 1000) }, messages: f.state.rows };
      const body = JSON.stringify(data);
      reply.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
      reply.end(body);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const client = new UiReaderReceipts({ ...f.config, fetchImpl: fetch, baseUrl: 'http://127.0.0.1:' + server.address().port });
      await client.checkBinding(); assert.deepEqual(requests, ['/api/v1/reader/status']); requests.length = 0;
      assert.equal((await client.prepare(f.job)).submissionAllowed, true);
      const expected = modern ? ['/api/v1/messages'] : ['/api/v1/reader/status', '/api/v1/messages', '/api/v1/reader/status'];
      assert.deepEqual(requests, expected); requests.length = 0;
      f.state.rows = [f.row()]; assert.equal((await client.query(f.job)).confirmed, true); assert.deepEqual(requests, expected);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

test('negotiated evidence cannot downgrade or accept wrong identities, scope or incomplete responses', async t => {
  const variants = [
    [data => { delete data.receiptBindingVersion; }, 'UI_RECEIPT_ACCOUNT_MISMATCH'],
    [data => { data.receiptBindingVersion = 2; }, 'UI_RECEIPT_ACCOUNT_MISMATCH'],
    [data => { data.backend = 'other'; }, 'UI_RECEIPT_ACCOUNT_MISMATCH'],
    [data => { data.ownWxid = 'other'; }, 'UI_RECEIPT_ACCOUNT_MISMATCH'],
    [data => { data.accountDirectory = 'other'; }, 'UI_RECEIPT_ACCOUNT_MISMATCH'],
    [data => { data.scope.accountWxid = 'other'; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.scope.accountDirectory = 'other'; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.scope.talker = 'other'; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.scope.fromTime++; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.scope.throughTime += 2; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.scope.throughTime = data.scope.fromTime - 1; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.scope.complete = false; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.scope = null; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.messages = null; }, 'UI_RECEIPT_SCOPE_INVALID'],
    [data => { data.success = false; }, 'UI_RECEIPT_RESPONSE_INVALID'],
  ];
  for (const [mutate, code] of variants) {
    const f = fixture(t); f.state.receiptBindingVersion = 1; await f.client.checkBinding(); f.state.requests.length = 0;
    f.client.fetchImpl = async (url, init) => { const data = await (await f.config.fetchImpl(url, init)).json(); mutate(data); return response(data); };
    await assert.rejects(f.client.prepare(f.job), { code });
    assert.equal(f.state.requests.length, 1); assert.deepEqual(fs.readdirSync(f.client.directory), []);
  }
});

test('negotiated empty, corrupt and failed HTTP responses leave no baseline', async t => {
  for (const makeResponse of [() => response(null), () => response({}),
    () => new Response('', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })]) {
    const f = fixture(t); f.state.receiptBindingVersion = 1; await f.client.checkBinding();
    let calls = 0; f.client.fetchImpl = async () => { calls++; return makeResponse(); };
    await assert.rejects(f.client.prepare(f.job), error => /^UI_RECEIPT_(RESPONSE_INVALID|HTTP_FAILED)$/.test(error.code));
    assert.equal(calls, 1); assert.deepEqual(fs.readdirSync(f.client.directory), []);
  }
});

test('negotiated preparation cannot persist after expiry, cancellation or a late response', async t => {
  const expired = fixture(t); expired.state.receiptBindingVersion = 1; await expired.client.checkBinding();
  expired.client.fetchImpl = async (url, init) => { expired.clock.now = expired.job.deadlineAt + 1; return expired.config.fetchImpl(url, init); };
  await assert.rejects(expired.client.prepare(expired.job), { code: 'UI_RECEIPT_PREPARATION_EXPIRED' });
  assert.deepEqual(fs.readdirSync(expired.client.directory), []);
  for (const abort of [false, true]) {
    const f = fixture(t, { timeoutMs: 25 }); f.state.receiptBindingVersion = 1; await f.client.checkBinding();
    let release, entered; const started = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
    f.client.fetchImpl = async (url, init) => { const data = await f.config.fetchImpl(url, init); entered(); return new Promise(resolve => { release = () => resolve(data); }); };
    const pending = f.client.prepare(f.job, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: abort ? 'UI_RECEIPT_ABORTED' : 'UI_RECEIPT_TIMEOUT' });
    await started; if (abort) controller.abort(); await rejected; release(); await delay(10);
    assert.deepEqual(fs.readdirSync(f.client.directory), []);
  }
});

test('first preparation persists an account-scoped baseline; repeated ID cannot grant submission twice', async t => {
  const f = fixture(t); f.state.rows = [f.row()];
  const first = await f.client.prepare(f.job);
  assert.equal(first.prepared, true); assert.equal(first.submissionAllowed, true); assert.match(first.preparationToken, /^[a-f0-9-]{36}$/);
  const requests = f.state.requests.length;
  assert.equal((await f.client.prepare(f.job)).submissionAllowed, false);
  assert.equal(f.state.requests.length, requests);
  const bytes = fs.readFileSync(path.join(f.client.directory, f.job.id + '.json'), 'utf8');
  assert.equal(bytes.includes(f.job.text.trim()), false); assert.equal(bytes.includes(f.config.token), false);
  await assert.rejects(f.client.prepare({ ...f.job, text: 'changed' }), { code: 'UI_RECEIPT_BINDING_MISMATCH' });
  await assert.rejects(f.client.prepare({ ...f.job, target: 'changed-target' }), { code: 'UI_RECEIPT_BINDING_MISMATCH' });
});

test('only a new unique exact-sender exact-text row with positive server ID confirms', async t => {
  const f = fixture(t); f.state.rows = [f.row({ localId: '10', serverId: '777' })]; await f.client.prepare(f.job);
  f.state.rows.push(f.row({ localId: '11', serverId: '888' }));
  const result = await f.client.query(f.job);
  assert.equal(result.confirmed, true); assert.equal(result.receipt.deliveryId, f.job.id);
  assert.equal(result.receipt.account, f.job.account); assert.equal(result.receipt.target, f.job.target); assert.equal(result.receipt.serverId, '888');
  const resumed = new UiReaderReceipts({ ...f.config, fetchImpl: async () => { throw Error('offline'); } });
  assert.deepEqual(await resumed.query(f.job), result);
});

test('reader database binding is explicit and never claims foreground desktop identity', async t => {
  const f = fixture(t); const binding = await f.client.checkBinding();
  assert.equal(binding.verified, true); assert.equal(binding.desktopAccountVerified, false);
  f.state.account += '_wrong';
  await assert.rejects(f.client.checkBinding(), { code: 'UI_RECEIPT_ACCOUNT_MISMATCH' });
  await assert.rejects(f.client.prepare(f.job), { code: 'UI_RECEIPT_ACCOUNT_MISMATCH' });
});

test('old local rows, delayed server IDs and copied old server IDs cannot confirm again', async t => {
  const f = fixture(t); f.state.rows = [f.row({ serverId: '0' }), f.row({ localId: '2', serverId: '444' })]; await f.client.prepare(f.job);
  f.state.rows = [f.row({ serverId: '555' }), f.row({ sourceShard: 'c'.repeat(64), localId: '77', serverId: '444' })];
  assert.equal((await f.client.query(f.job)).confirmed, false);
});

test('prefix-spoof sender, whitespace changes and missing type never count as exact receipts', async t => {
  const f = fixture(t); await f.client.prepare(f.job);
  for (const extra of [{ senderUsername: f.job.account + '_other' }, { fullText: f.job.text.trim() }, { localType: 34 }, { isSend: 0 }, { serverId: '0' }]) {
    f.state.rows = [f.row(extra)]; assert.equal((await f.client.query(f.job)).confirmed, false);
  }
});

test('multiple candidates across shards remain ambiguous even when only one has a server ID', async t => {
  const f = fixture(t); await f.client.prepare(f.job);
  f.state.rows = [f.row(), f.row({ sourceShard: 'c'.repeat(64), serverId: '0' })];
  assert.deepEqual(await f.client.query(f.job), { confirmed: false, reason: 'UI_RECEIPT_AMBIGUOUS' });
});

test('incomplete or wrong-account scope rejects evidence, including account changes during query', async t => {
  const f = fixture(t); await f.client.prepare(f.job);
  f.state.rows = [f.row()]; f.state.complete = false;
  assert.deepEqual(await f.client.query(f.job), { confirmed: false, reason: 'UI_RECEIPT_SCOPE_INVALID' });
  let statusCalls = 0;
  const switched = new UiReaderReceipts({ ...f.config, fetchImpl: async (url, init) => {
    if (new URL(url).pathname.endsWith('/status') && ++statusCalls === 2) f.state.account = 'switched';
    return f.config.fetchImpl(url, init);
  } });
  f.state.complete = true;
  assert.deepEqual(await switched.query(f.job), { confirmed: false, reason: 'UI_RECEIPT_ACCOUNT_MISMATCH' });
});

test('rows outside the submission window and excessively old recovery are never confirmed', async t => {
  const f = fixture(t); await f.client.prepare(f.job);
  f.state.rows = [f.row({ createTime: Math.floor(f.job.submittedAt / 1000) - 1 })];
  assert.equal((await f.client.query(f.job)).confirmed, false);
  f.clock.now += 31000;
  f.state.rows = [f.row()]; assert.equal((await f.client.query(f.job)).confirmed, false);
  f.clock.now += 300000;
  assert.deepEqual(await f.client.query(f.job), { confirmed: false, reason: 'UI_RECEIPT_QUERY_EXPIRED' });
});

test('concurrent preparations serialize; timeout cannot write a late baseline after releasing the lock', async t => {
  let resolve;
  const f = fixture(t, { timeoutMs: 25, fetchImpl: () => new Promise(done => { resolve = done; }) });
  const pending = f.client.prepare(f.job);
  await assert.rejects(f.client.prepare(f.job), { code: 'UI_RECEIPT_BUSY' });
  await assert.rejects(pending, { code: 'UI_RECEIPT_TIMEOUT' });
  resolve(response({ success: true })); await delay(10);
  assert.equal(fs.readdirSync(f.client.directory).length, 0);
  assert.deepEqual(await f.client.query(f.job), { confirmed: false, reason: 'UI_RECEIPT_BASELINE_MISSING' });
});

test('HTTP, malformed JSON and abort failures never become confirmation', async t => {
  const f = fixture(t); await f.client.prepare(f.job);
  for (const fetchImpl of [async () => new Response('bad', { status: 500 }), async () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } })]) {
    const failed = new UiReaderReceipts({ ...f.config, fetchImpl }); assert.equal((await failed.query(f.job)).confirmed, false);
  }
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await f.client.query(f.job, { signal: abort.signal }), { confirmed: false, reason: 'UI_RECEIPT_ABORTED' });
  const activeAbort = new AbortController();
  const waiting = new UiReaderReceipts({ ...f.config, timeoutMs: 1000, fetchImpl: () => new Promise(() => {}) });
  const pending = waiting.query(f.job, { signal: activeAbort.signal });
  activeAbort.abort();
  assert.deepEqual(await pending, { confirmed: false, reason: 'UI_RECEIPT_ABORTED' });
});

test('only explicit HTTP IPv4 loopback reader URLs are accepted', t => {
  const f = fixture(t);
  for (const baseUrl of ['https://127.0.0.1:5031', 'http://localhost:5031', 'http://192.0.2.1', 'http://user@127.0.0.1', 'http://127.0.0.1/path']) {
    assert.throws(() => new UiReaderReceipts({ ...f.config, baseUrl }), { code: 'UI_RECEIPT_CONFIG_INVALID' });
  }
});

test('exact native pre-input refusal is durable and permits a new preparation after pause', async t => {
  const f = fixture(t), first = await f.client.prepare(f.job);
  const proof = { preparationToken: first.preparationToken, nativeResult: { performed: false, attempted: false, reason: 'UI_USER_ACTIVE' } };
  assert.deepEqual(await f.client.markNotSubmitted(f.job, proof), { notSubmitted: true, reused: false });
  assert.deepEqual(await f.client.markNotSubmitted(f.job, proof), { notSubmitted: true, reused: true });
  f.state.rows = [f.row()];
  assert.deepEqual(await f.client.query(f.job), { confirmed: false, reason: 'UI_RECEIPT_NOT_SUBMITTED' });
  f.clock.now += 10000;
  f.state.rows = []; // The old row is outside the new bounded Reader window.
  const resumedJob = { ...f.job, submittedAt: f.clock.now, deadlineAt: f.clock.now + 30000 };
  const resumed = await new UiReaderReceipts(f.config).prepare(resumedJob);
  assert.equal(resumed.submissionAllowed, true); assert.notEqual(resumed.preparationToken, first.preparationToken);
  const saved = JSON.parse(fs.readFileSync(path.join(f.client.directory, f.job.id + '.json')));
  assert.equal(saved.attempt, 2); assert.equal(saved.history.length, 1); assert.equal(saved.history[0].reason, 'UI_USER_ACTIVE');
  assert.equal(saved.history[0].preparationToken, first.preparationToken); assert.match(saved.history[0].baselineSha256, /^[a-f0-9]{64}$/);
});

test('a UIA mode revocation after receipt preparation persists its exact refusal and can be read after restart',async t=>{
  const f=fixture(t);let checks=0,nativeCalls=0;
  const driver=createReceiptUiDriver({native:{submit:async()=>{nativeCalls++;throw Error('must not submit');}},receipts:f.client,
    inputAllowed:()=>{if(++checks>1)throw Object.assign(Error('private configuration detail'),{code:'UIA_MODE_STATE_CHANGED'});return true;}});
  assert.deepEqual(await driver.submit(f.job,{}),{performed:false,attempted:false,reason:'UIA_MODE_STATE_CHANGED'});assert.equal(nativeCalls,0);
  const restarted=new UiReaderReceipts(f.config);assert.deepEqual(await restarted.query(f.job),{confirmed:false,reason:'UI_RECEIPT_NOT_SUBMITTED'});
  const saved=JSON.parse(fs.readFileSync(path.join(f.client.directory,f.job.id+'.json')));assert.equal(saved.history[0].reason,'UIA_MODE_STATE_CHANGED');assert.equal(JSON.stringify(saved).includes('private configuration detail'),false);
  assert.equal((await restarted.prepare(f.job)).submissionAllowed,true);
});

test('UIA refusal codes never release uncertain input and reject arbitrary or malformed reasons',async t=>{
  const f=fixture(t),first=await f.client.prepare(f.job);
  for(const nativeResult of [{performed:false,attempted:true,reason:'UIA_MODE_GEOMETRY_CHANGED'},{performed:false,attempted:null,reason:'UIA_MODE_GEOMETRY_CHANGED'},
    {performed:false,attempted:false,reason:'UIA_GEOMETRY_CHANGED'},{performed:false,attempted:false,reason:'UIA_MODE_private detail'}]){
    await assert.rejects(f.client.markNotSubmitted(f.job,{preparationToken:first.preparationToken,nativeResult}),{code:'UI_RECEIPT_REJECTION_PROOF_REQUIRED'});
    assert.equal((await new UiReaderReceipts(f.config).prepare(f.job)).submissionAllowed,false);
  }
  await f.client.markNotSubmitted(f.job,{preparationToken:first.preparationToken,nativeResult:{performed:false,attempted:false,reason:'UIA_MODE_GEOMETRY_CHANGED'}});
  assert.equal((await new UiReaderReceipts(f.config).prepare(f.job)).submissionAllowed,true);
});

test('unknown, attempted, missing-token and wrong-token results cannot release a preparation', async t => {
  const f = fixture(t), first = await f.client.prepare(f.job);
  for (const proof of [undefined, { nativeResult: { performed: false, attempted: false } },
    { preparationToken: first.preparationToken, nativeResult: { performed: false } },
    { preparationToken: first.preparationToken, nativeResult: { performed: false, attempted: true } },
    { preparationToken: first.preparationToken, nativeResult: { performed: true, attempted: false } }]) {
    await assert.rejects(f.client.markNotSubmitted(f.job, proof), { code: 'UI_RECEIPT_REJECTION_PROOF_REQUIRED' });
  }
  await assert.rejects(f.client.markNotSubmitted(f.job, { preparationToken: 'b'.repeat(8) + '-bbbb-bbbb-bbbb-' + 'b'.repeat(12), nativeResult: { performed: false, attempted: false } }), { code: 'UI_RECEIPT_REJECTION_MISMATCH' });
  assert.equal((await new UiReaderReceipts(f.config).prepare(f.job)).submissionAllowed, false);
  await assert.rejects(f.client.prepare({ ...f.job, submittedAt: f.job.submittedAt + 1 }), { code: 'UI_RECEIPT_BINDING_MISMATCH' });
});

test('late rejection from an earlier attempt cannot clear a new attempt even in the same millisecond', async t => {
  const f = fixture(t), first = await f.client.prepare(f.job);
  const oldProof = { preparationToken: first.preparationToken, nativeResult: { performed: false, attempted: false } };
  await f.client.markNotSubmitted(f.job, oldProof);
  const second = await f.client.prepare(f.job);
  assert.notEqual(second.preparationToken, first.preparationToken);
  await assert.rejects(f.client.markNotSubmitted(f.job, oldProof), { code: 'UI_RECEIPT_REJECTION_MISMATCH' });
  assert.equal((await new UiReaderReceipts(f.config).prepare(f.job)).submissionAllowed, false);
});

test('rejection persistence failure leaves the attempt reserved across restart', async t => {
  const f = fixture(t), first = await f.client.prepare(f.job);
  const rename = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); });
  await assert.rejects(f.client.markNotSubmitted(f.job, { preparationToken: first.preparationToken, nativeResult: { performed: false, attempted: false } }), { code: 'EACCES' });
  rename.mock.restore();
  assert.equal((await new UiReaderReceipts(f.config).prepare(f.job)).submissionAllowed, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.client.directory, f.job.id + '.json'))).state, 'prepared');
});

test('an in-flight receipt query cannot confirm after proven rejection or a replacement preparation', async t => {
  for (const replace of [false, true]) {
    const f = fixture(t), first = await f.client.prepare(f.job);
    let release, entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    f.state.rows = [f.row()];
    const queryClient = new UiReaderReceipts({ ...f.config, fetchImpl: async (url, init) => {
      if (new URL(url).pathname.endsWith('/messages')) {
        const snapshot = await f.config.fetchImpl(url, init); entered();
        return new Promise(resolve => { release = () => resolve(snapshot); });
      }
      return f.config.fetchImpl(url, init);
    } });
    const pending = queryClient.query(f.job); await enteredPromise;
    await f.client.markNotSubmitted(f.job, { preparationToken: first.preparationToken, nativeResult: { performed: false, attempted: false } });
    if (replace) await f.client.prepare(f.job);
    release();
    assert.deepEqual(await pending, { confirmed: false, reason: replace ? 'UI_RECEIPT_PREPARATION_CHANGED' : 'UI_RECEIPT_NOT_SUBMITTED' });
  }
});

test('a confirmed receipt cannot be cleared by a later no-input claim', async t => {
  const f = fixture(t), first = await f.client.prepare(f.job); f.state.rows = [f.row()];
  assert.equal((await f.client.query(f.job)).confirmed, true);
  await assert.rejects(f.client.markNotSubmitted(f.job, { preparationToken: first.preparationToken, nativeResult: { performed: false, attempted: false } }), { code: 'UI_RECEIPT_REJECTION_MISMATCH' });
  assert.equal((await f.client.query(f.job)).confirmed, true);
});

const runtimeConfig = path.resolve(import.meta.dirname, '../state/ui-runtime.json');
const configuredPython = fs.existsSync(runtimeConfig) ? JSON.parse(fs.readFileSync(runtimeConfig, 'utf8')).pythonBase : undefined;
test('Reader receipt queries preserve exact shard data using in-memory SQLite only', { skip: !configuredPython && 'Local Python runtime not configured', timeout: 15000 }, () => {
  const result = spawnSync(configuredPython, ['-B', path.join(import.meta.dirname, 'test-ui-reader-receipts.py')], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
});
