import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { runLocalApi, withLocalReceiptApi } from './reader-local-api.mjs';
import { UiReaderReceipts } from './ui-reader-receipts.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const protectedFixture = 'userdpapi:' + Buffer.concat([Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex'), Buffer.alloc(40)]).toString('base64');
const workerSource = `
import http from 'node:http';
let pending = '', request, server, timer, reads=0;
const emit = data => process.stdout.write(JSON.stringify(data) + '\\n');
const stop = () => { clearTimeout(timer); if (server) server.close(() => { emit({type:'stopped',ok:true}); process.exit(0); }); else process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  if (request) return;
  pending += data;
  if (!pending.includes('\\n')) return;
  request = JSON.parse(pending.slice(0,pending.indexOf('\\n')));
  if (process.env.FIXTURE_MODE === 'invalid') { process.stdout.write(request.protectedKey+' '+request.dbPath+'\\n'); return; }
  if (process.env.FIXTURE_MODE === 'silent') { timer=setTimeout(stop,60000); return; }
  if (request.mode==='check') {
    process.stderr.write('fixture private log '+request.protectedKey+' '+request.dbPath);
    emit({type:'check',ok:true,databaseVerified:true,contactNamesLoaded:true,filehelperOnly:true,receiptWindowComplete:true,networkStarted:false});
    process.exit(0); return;
  }
  const scope={success:true,backend:'weflow-cli-nt',ownWxid:'fixture-self',accountDirectory:request.myWxid,receiptOnly:true,automaticReplies:false,desktopAccountVerified:false};
  server=http.createServer((req,res)=>{
    const reply=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.headers.authorization!=='Bearer '+request.token) return reply(401,{error:'unauthorized'});
    if(req.method!=='GET') return reply(405,{error:'readonly'});
    const url=new URL(req.url,'http://127.0.0.1');
    if(process.env.FIXTURE_MODE==='bad-boundary' && url.pathname==='/api/v1/push/messages') return reply(200,{bad:true});
    if(url.pathname==='/api/v1/reader/status') return reply(200,scope);
    if(url.pathname!=='/api/v1/messages') return reply(404,{error:'endpoint'});
    if(url.searchParams.get('talker')!=='filehelper') return reply(403,{error:'target'});
    reads++;
    const messages=process.env.FIXTURE_MODE==='receipt' && reads>=3 ? [{sourceShard:'d'.repeat(64),localId:'1',serverId:'42',localType:1,createTime:Math.floor(Date.now()/1000),senderUsername:scope.ownWxid,isSend:1,fullText:'offline receipt fixture'}] : [];
    reply(200,{success:true,scope:{version:1,complete:true,talker:'filehelper',accountWxid:scope.ownWxid,accountDirectory:request.myWxid,fromTime:Number(url.searchParams.get('from_time')),throughTime:Math.floor(Date.now()/1000)},messages});
  });
  server.listen(0,'127.0.0.1',()=>emit({type:'ready',ok:true,port:server.address().port,scope}));
  timer=setTimeout(stop,request.maximumMs);
});
process.stdin.on('end',()=>{ if(process.env.FIXTURE_MODE!=='silent') stop(); });
`;

function fixture(t, workerMode = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-api-node-fixture-'));
  const directory = path.join(root, 'state/reader');
  fs.mkdirSync(directory, { recursive: true });
  const worker = path.join(root, 'mock-worker.mjs');
  fs.writeFileSync(worker, workerSource);
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^reader-api-node-fixture-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const dbPath = path.join(root, 'fixture-account-private');
  const accountRef = crypto.createHash('sha256').update(dbPath.toLowerCase()).digest('hex');
  const binding = { python: 'fixture-python', account: { dbPath, myWxid: path.basename(dbPath), accountRef },
    cached: { schemaVersion: 1, accountRef, protectedKey: protectedFixture, savedAt: new Date().toISOString() } };
  let starts = 0;
  const spawnImpl = (executable, args, options) => {
    starts++;
    assert.equal(executable, 'fixture-python');
    assert.deepEqual(args, ['-I', '-B', path.join(root, 'scripts/reader-local-api.py')]);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(Object.keys(options.env).some(key => ['PYTHONPATH', 'PYTHONHOME'].includes(key.toUpperCase())), false);
    assert.equal(JSON.stringify(args).includes(protectedFixture), false);
    return spawn(process.execPath, [worker], { ...options, env: { ...options.env, FIXTURE_MODE: workerMode } });
  };
  return { root, directory, binding, spawnImpl, check: () => binding, starts: () => starts };
}

function assertClean(f, result) {
  assert.deepEqual(fs.readdirSync(f.directory), []);
  const output = JSON.stringify(result);
  for (const privateValue of [protectedFixture, f.binding.account.myWxid, f.binding.account.dbPath, 'fixture-self']) assert.equal(output.includes(privateValue), false);
  assert.equal(result.processStopped, true);
  assert.equal(result.liveAccountVerified, false);
}

test('isolated check uses private stdin, suppresses private logs, and cleans temporary configuration', async t => {
  const f = fixture(t);
  const result = await runLocalApi({ mode: 'check', ...f });
  assert.equal(result.databaseVerified, true);
  assert.equal(result.networkStarted, false);
  assert.equal(f.starts(), 1);
  assertClean(f, result);
});

test('bounded probe tests authenticated HTTP and all denied boundaries, then stops on stdin EOF', async t => {
  const f = fixture(t);
  const result = await runLocalApi({ mode: 'probe', ...f });
  for (const key of ['authenticatedStatus', 'readReceiptWindow', 'unauthorizedRejected', 'writeRejected', 'otherEndpointRejected', 'otherTargetRejected']) assert.equal(result[key], true);
  assert.ok(result.port > 0);
  assertClean(f, result);
});

test('private session validates boundaries then supports durable prepare and unique receipt query', async t => {
  const f = fixture(t, 'receipt'); let access, confirmed;
  const report = await withLocalReceiptApi({ ...f, expectedAccountRef: f.binding.account.accountRef, callback: async value => {
    access = value;
    assert.equal(Object.isFrozen(value), true); assert.equal(value.signal.aborted, false);
    assert.equal(value.accountRef, f.binding.account.accountRef); assert.equal(value.accountWxid, 'fixture-self');
    assert.ok(value.expiresAt > Date.now());
    const reader = new UiReaderReceipts({ ...value, directory: path.join(f.root, 'fixture-receipts') });
    assert.equal((await reader.checkBinding({ signal: value.signal })).verified, true);
    const at = Date.now(), job = { id: 'c'.repeat(64), account: value.accountWxid, target: 'filehelper', text: 'offline receipt fixture', submittedAt: at, deadlineAt: at + 10000 };
    assert.equal((await reader.prepare(job, { signal: value.signal })).submissionAllowed, true);
    confirmed = await reader.query(job, { signal: value.signal });
    assert.equal(confirmed.confirmed, true); assert.equal(confirmed.receipt.deliveryId, job.id); assert.equal(confirmed.receipt.target, job.target);
    return { token: value.token, account: value.accountWxid, private: 'do not forward' };
  } });
  assert.equal(report.callbackCompleted, true); assert.equal(report.eventsRejected, true); assert.equal(report.filehelperOnly, true);
  assert.equal(Object.hasOwn(report, 'port'), false); assert.equal(access.signal.aborted, true);
  for (const secret of [access.token, access.accountRef, 'do not forward', access.baseUrl]) assert.equal(JSON.stringify(report).includes(secret), false);
  await assert.rejects(fetch(access.baseUrl + '/api/v1/reader/status', { signal: AbortSignal.timeout(500) }));
  assertClean(f, report);
});

test('callback error is sanitized and still stops the service and removes private state', async t => {
  const f = fixture(t); let access;
  await assert.rejects(withLocalReceiptApi({ ...f, callback: async value => { access = value; throw new Error(value.token + ' PRIVATE CALLBACK'); } }), { code: 'READER_LOCAL_API_CALLBACK_FAILED', message: 'READER_LOCAL_API_CALLBACK_FAILED' });
  assert.equal(access.signal.aborted, true); assert.deepEqual(fs.readdirSync(f.directory), []);
  await assert.rejects(fetch(access.baseUrl + '/api/v1/reader/status', { signal: AbortSignal.timeout(500) }));
});

test('never-resolving callback is aborted within the bounded session and resources are removed', async t => {
  const f = fixture(t); let signal;
  const started = Date.now();
  await assert.rejects(withLocalReceiptApi({ ...f, timeoutMs: 4000, callback: value => { signal = value.signal; return new Promise(() => {}); } }), { code: 'READER_LOCAL_API_TIMEOUT' });
  assert.equal(signal.aborted, true); assert.ok(Date.now() - started < 4000);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('boundaries and binding failures never invoke the callback; session is not a CLI mode', async t => {
  let callbacks = 0;
  const bad = fixture(t, 'bad-boundary');
  await assert.rejects(withLocalReceiptApi({ ...bad, callback: () => { callbacks++; } }), { code: 'READER_LOCAL_API_BOUNDARY_FAILED' });
  assert.deepEqual(fs.readdirSync(bad.directory), []);
  const f = fixture(t);
  await assert.rejects(withLocalReceiptApi({ ...f, expectedAccountRef: 'b'.repeat(64), callback: () => { callbacks++; } }), { code: 'READER_LOCAL_API_BINDING_CHANGED' });
  let checks = 0;
  await assert.rejects(withLocalReceiptApi({ ...f, check: () => ++checks === 1 ? f.binding : { ...f.binding, account: { ...f.binding.account, accountRef: 'b'.repeat(64) } }, callback: () => { callbacks++; } }), { code: 'READER_LOCAL_API_BINDING_CHANGED' });
  await assert.rejects(runLocalApi({ ...f, mode: 'session' }), { code: 'READER_LOCAL_API_ARGUMENTS_INVALID' });
  assert.equal(callbacks, 0); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('external cancellation aborts a live private callback then cleans the service', async t => {
  const f = fixture(t), controller = new AbortController(); let live;
  await assert.rejects(withLocalReceiptApi({ ...f, signal: controller.signal, callback: value => {
    live = value.signal; controller.abort(); return new Promise(() => {});
  } }), { code: 'READER_LOCAL_API_CANCELLED' });
  assert.equal(live.aborted, true); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('unconfirmed process cleanup retains lock and private directory', async t => {
  const f = fixture(t); let kills = 0;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { kills++; return false; } });
  await assert.rejects(withLocalReceiptApi({ ...f, timeoutMs: 4000, callback: () => {}, spawnImpl: () => child }), { code: 'READER_LOCAL_API_CLEANUP_UNCONFIRMED' });
  assert.equal(kills, 1); assert.equal(fs.existsSync(path.join(f.directory, 'api.lock')), true);
  assert.equal(fs.readdirSync(f.directory).filter(name => name.startsWith('api-session-')).length, 1);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});

test('killed launcher close without Python stop acknowledgement does not release private session lock', async t => {
  const f = fixture(t); let child;
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { queueMicrotask(() => child.emit('close', 1, null)); return true; } });
  await assert.rejects(withLocalReceiptApi({ ...f, timeoutMs: 4000, callback: () => {}, spawnImpl: () => child }), { code: 'READER_LOCAL_API_CLEANUP_UNCONFIRMED' });
  assert.equal(fs.existsSync(path.join(f.directory, 'api.lock')), true);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});

test('missing cache and existing lock never start a child or modify another lease', async t => {
  const f = fixture(t);
  await assert.rejects(runLocalApi({ mode: 'check', ...f, check: () => ({ ...f.binding, cached: null }) }), { code: 'READER_LOCAL_API_CREDENTIAL_CACHE_REQUIRED' });
  const lock = path.join(f.directory, 'api.lock');
  fs.writeFileSync(lock, '{"lease":"other-owner"}');
  await assert.rejects(runLocalApi({ mode: 'check', ...f }), { code: 'READER_LOCAL_API_BUSY' });
  assert.equal(fs.readFileSync(lock, 'utf8'), '{"lease":"other-owner"}');
  assert.equal(f.starts(), 0);
});

test('private malformed child output produces only a fixed error and releases resources', async t => {
  const f = fixture(t, 'invalid');
  await assert.rejects(runLocalApi({ mode: 'probe', ...f }), error => {
    assert.equal(error.code, 'READER_LOCAL_API_PROTOCOL_INVALID');
    assert.equal(error.message, error.code);
    return true;
  });
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('a linked private directory is rejected before child startup', async t => {
  const f = fixture(t);
  const destination = path.join(f.root, 'fixture-link-destination');
  fs.mkdirSync(destination);
  fs.rmdirSync(f.directory);
  fs.symlinkSync(destination, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runLocalApi({ mode: 'check', ...f }), { code: 'READER_LOCAL_API_LINK_REJECTED' });
  assert.equal(f.starts(), 0);
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('unresponsive child is terminated within bounded lifetime and its owned files are removed', async t => {
  const f = fixture(t, 'silent');
  const start = Date.now();
  await assert.rejects(runLocalApi({ mode: 'probe', ...f, timeoutMs: 4000 }), { code: 'READER_LOCAL_API_TIMEOUT' });
  assert.ok(Date.now() - start < 5000);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('Python mock Reader and loopback HTTP contract tests do not access a real database', t => {
  const python = path.resolve(import.meta.dirname, '../state/reader/venv/Scripts/python.exe');
  if (!fs.existsSync(python)) { t.skip('Optional local Reader Python is unavailable'); return; }
  const result = spawnSync(python, ['-I', '-B', path.join(import.meta.dirname, 'test_reader_local_api.py')], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
