import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { bindReaderTarget, startTargetReader, readSelectableContacts } from './reader-target-service.mjs';
import { TargetSelectionStore } from './target-selection.mjs';

const protectedFixture = 'userdpapi:' + Buffer.concat([Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex'), Buffer.alloc(40)]).toString('base64');
const workerSource = `
import fs from 'node:fs';import http from 'node:http';import crypto from 'node:crypto';
let input='',request,server,ended=false;const sockets=new Set();
const emit=data=>process.stdout.write(JSON.stringify(data)+'\\n');
const stop=()=>{if(ended)return;ended=true;for(const socket of sockets)socket.destroy();const finish=()=>{if(process.env.MODE!=='no-ack')emit({ok:true,type:'stopped',automaticReplies:false});process.exit(0);};if(server)server.close(finish);else finish();};
process.stdin.on('data',chunk=>{input+=chunk.toString();if(request||!input.includes('\\n'))return;request=JSON.parse(input.slice(0,input.indexOf('\\n')));
if(request.operation==='catalog'){
const values=request.targetWxids.length?request.targetWxids:['fixture-target'],mode=process.env.MODE;
const metadata=mode?.startsWith('name-')?{searchName:'Unique fixture nickname',uniqueSearchName:true}:{};
if(mode==='name-collision'){metadata.searchName='';metadata.uniqueSearchName=false;}
if(mode==='name-missing-proof')delete metadata.uniqueSearchName;
if(mode==='name-boolean')metadata.uniqueSearchName='true';
if(mode==='name-trailing')metadata.searchName+=' ';
if(mode==='name-control')metadata.searchName+=String.fromCharCode(0);
if(mode==='name-surrogate')metadata.searchName=String.fromCharCode(0xd800);
if(mode==='name-too-long')metadata.searchName='x'.repeat(129);
if(mode==='name-room')metadata.searchName='room@chatroom';
if(mode==='name-extra')metadata.extra=true;
if(mode==='name-unverified')metadata.uniqueSearchName=false;
emit({ok:true,type:'catalog',accountRef:request.accountRef,truncated:false,contacts:values.map(wechatId=>({wechatId,id:String(Number(crypto.createHash('sha256').update(wechatId).digest().readBigUInt64BE(0)%2147483647n+1n)),name:'Fixture',alias:'',ambiguous:false,...(wechatId.endsWith('@chatroom')?{kind:'group',groupName:'Fixture',uniqueSearchName:true}:metadata)}))});process.exit(0);return;}
if(request.operation==='bind'){const target='fixture-target',targetId=String(Number(crypto.createHash('sha256').update(target).digest().readBigUInt64BE(0)%2147483647n+1n));
emit({ok:true,type:'binding',accountRef:request.accountRef,...(process.env.MODE==='ambiguous'?{matched:false,reason:'ambiguous'}:{matched:true,binding:{version:1,accountRef:request.accountRef,targetWxid:target,targetId,alias:'fixture-alias',displayName:request.displayName,matchedFields:['remark'],boundAt:Date.now(),autoSend:false,onScreenVerified:false}})});process.exit(0);return;}
if(process.env.MODE==='private-error'){process.stdout.write(request.protectedKey+' '+request.dbPath+'\\n');return;}
if(process.env.MODE==='event-gap'){emit({ok:true,type:'stopped',automaticReplies:false,reason:'READER_TARGET_EVENT_GAP'});process.exit(0);return;}
const allowed=request.selection?request.selection.targets.map(value=>value.wxid):[request.binding.targetWxid];
const cursor='c'.repeat(32)+':0',scope={success:true,backend:'weflow-cli-nt',ownWxid:'fixture-self',accountDirectory:request.myWxid,allowedTalkers:allowed,cursor,pollHealthy:true,readOnly:true,automaticReplies:false,desktopAccountVerified:false,...(request.selection?{selectionVersion:request.selection.version}:{})};
server=http.createServer((req,res)=>{const reply=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
if(req.headers.origin)return reply(403,{});if(req.headers.authorization!=='Bearer '+request.token)return reply(401,{});if(req.method!=='GET')return reply(405,{});
const url=new URL(req.url,'http://127.0.0.1');if(url.pathname==='/api/v1/reader/status')return reply(200,scope);
if(url.pathname==='/api/v1/push/messages'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\\n\\n');return;}
if(url.pathname!=='/api/v1/messages')return reply(process.env.MODE==='bad-boundary'?200:404,{});
if(!allowed.includes(url.searchParams.get('talker')))return reply(403,{});
reply(200,{success:true,scope:{version:1,complete:true,talker:url.searchParams.get('talker'),accountWxid:scope.ownWxid,accountDirectory:request.myWxid,fromTime:Number(url.searchParams.get('from_time')),throughTime:Math.floor(Date.now()/1000)},messages:[]});});
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
server.listen(request.port,'127.0.0.1',()=>emit({ok:true,type:'ready',port:request.port,scope,initialCursor:cursor}));
});process.stdin.on('end',stop);
`;

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t, mode = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-target-node-fixture-'));
  const directory = path.join(root, 'state/reader-service'); fs.mkdirSync(directory, { recursive: true });
  const dbPath = path.join(root, 'fixture-account-private'), accountRef = crypto.createHash('sha256').update(dbPath.toLowerCase()).digest('hex');
  const binding = { python: 'fixture-python', account: { dbPath, myWxid: path.basename(dbPath), accountRef },
    cached: { schemaVersion: 1, accountRef, protectedKey: protectedFixture, savedAt: new Date().toISOString() } };
  const worker = path.join(root, 'worker.mjs'); fs.writeFileSync(worker, workerSource);
  const target = 'fixture-target', targetId = String(Number(crypto.createHash('sha256').update(target).digest().readBigUInt64BE(0) % 2147483647n + 1n));
  const value = { version: 1, accountRef, targetWxid: target, targetId, alias: 'fixture-alias', displayName: 'fixture chosen', matchedFields: ['remark'], boundAt: Date.now(), autoSend: false, onScreenVerified: false };
  const bindingFile = path.join(directory, 'target.json'); fs.writeFileSync(bindingFile, JSON.stringify(value));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('close', resolve)); }
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^reader-target-node-fixture-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const spawnImpl = (executable, args, options) => {
    assert.equal(executable, 'fixture-python');
    assert.deepEqual(args, ['-I','-B',path.join(root, 'scripts/reader-target-service.py')]);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(JSON.stringify(args).includes(protectedFixture), false);
    const child = spawn(process.execPath, [worker], { ...options, env: { ...options.env, MODE: mode } }); children.push(child); return child;
  };
  return { root, directory, bindingFile, binding, target: value, port: await freePort(), check: () => binding, spawnImpl, bindingCheckMs: 50 };
}
function clean(f) { assert.deepEqual(fs.readdirSync(f.directory), ['target.json']); }

test('private long-lived handle verifies boundaries; default is receive only and explicit stop cleans', async t => {
  const f = await fixture(t), handle = await startTargetReader(f);
  assert.equal(handle.accountWxid, 'fixture-self'); assert.equal(handle.targetWxid, f.target.targetWxid);
  assert.equal(handle.baseUrl, `http://127.0.0.1:${f.port}`); assert.match(handle.token, /^[a-f0-9]{64}$/);
  assert.equal(handle.automaticReplies, false); assert.match(handle.initialCursor, /^[a-f0-9]{32}:0$/);
  const publicResult = JSON.stringify(handle);
  for (const privateValue of [handle.token, handle.accountWxid, handle.targetWxid, handle.accountDirectory, protectedFixture]) assert.equal(publicResult.includes(privateValue), false);
  await assert.rejects(startTargetReader(f), { code: 'READER_TARGET_BUSY' });
  const result = await handle.stop(); assert.equal(result.processStopped, true); assert.equal(handle.signal.aborted, true);
  assert.equal(await handle.done, result); clean(f);
});
test('ambiguous exact display selection writes no target; unique binding remains private and disables auto send', async t => {
  const ambiguous = await fixture(t, 'ambiguous'); fs.unlinkSync(ambiguous.bindingFile);
  assert.deepEqual(await bindReaderTarget({ ...ambiguous, displayName: 'chosen' }), { matched: false, reason: 'ambiguous', inputSent: false });
  assert.equal(fs.existsSync(ambiguous.bindingFile), false);
  const good = await fixture(t); fs.unlinkSync(good.bindingFile);
  const result = await bindReaderTarget({ ...good, displayName: 'chosen' });
  assert.equal(result.unique, true); assert.equal(result.bindingFile, good.bindingFile);
  const stored = JSON.parse(fs.readFileSync(result.bindingFile, 'utf8'));
  assert.equal(stored.targetWxid, 'fixture-target'); assert.equal(stored.autoSend, false);
  assert.equal(JSON.stringify(result).includes('fixture-target'), false);
  assert.equal(fs.readFileSync(result.bindingFile, 'utf8').includes(protectedFixture), false);
});
test('changed explicit account binding stops the running reader and revokes access', async t => {
  const f = await fixture(t); let changed = false;
  const handle = await startTargetReader({ ...f, check: () => changed ? { ...f.binding, account: { ...f.binding.account, accountRef: 'e'.repeat(64) }, cached: { ...f.binding.cached, accountRef: 'e'.repeat(64) } } : f.binding });
  changed = true;
  await assert.rejects(handle.done, { code: 'READER_TARGET_ACCOUNT_CHANGED' });
  assert.equal(handle.signal.aborted, true); clean(f);
});
test('cancellation closes listener and process instead of starting a replacement', async t => {
  const f = await fixture(t), controller = new AbortController();
  const handle = await startTargetReader({ ...f, signal: controller.signal });
  controller.abort();
  await assert.rejects(handle.done, { code: 'READER_TARGET_CANCELLED' }); clean(f);
});
test('invalid HTTP scope prevents ready and still waits for acknowledged cleanup', async t => {
  const f = await fixture(t, 'bad-boundary');
  await assert.rejects(startTargetReader(f), { code: 'READER_TARGET_HTTP_BOUNDARY_FAILED' }); clean(f);
});
test('hung startup verification is bounded, stops child and cannot later grant access', async t => {
  const f = await fixture(t);
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true }));
  await assert.rejects(startTargetReader({ ...f, fetchImpl, startupTimeoutMs: 500 }), { code: 'READER_TARGET_START_TIMEOUT' }); clean(f);
});
test('normal child exit without explicit stopped acknowledgement retains service lock', async t => {
  const f = await fixture(t, 'no-ack'), handle = await startTargetReader(f);
  await assert.rejects(handle.stop(), { code: 'READER_TARGET_CLEANUP_UNCONFIRMED' });
  assert.equal(fs.existsSync(path.join(f.directory, 'service.lock')), true);
});
test('an acknowledged startup history gap releases its lease and remains a distinct recovery error', async t => {
  const f = await fixture(t, 'event-gap');
  await assert.rejects(startTargetReader(f), { code: 'READER_TARGET_EVENT_GAP' }); clean(f);
});
test('unexpected child output never leaks private credentials through errors', async t => {
  const f = await fixture(t, 'private-error');
  await assert.rejects(startTargetReader(f), error => {
    assert.equal(String(error).includes(protectedFixture), false); assert.equal(String(error).includes(f.binding.account.dbPath), false);
    return /^READER_TARGET_/.test(error.code);
  });
});
test('existing Python Reader reused under scoped facade and localhost fixture checks', { timeout: 20000 }, () => {
  const python = process.env.WECHATAGENT_TEST_PYTHON ?? path.resolve('state/reader/venv/Scripts/python.exe');
  assert.equal(fs.existsSync(python), true, 'local Reader test runtime required');
  const result = spawnSync(python, ['-I','-B',path.resolve('scripts/test-reader-target-service.py')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('restricted Reader media keeps SQLite identity, real pixels, HTTP authorization and restart references', { timeout: 20000 }, () => {
  const python = process.env.WECHATAGENT_TEST_PYTHON ?? path.resolve('state/reader/venv/Scripts/python.exe');
  const result = spawnSync(python, ['-I','-B',path.resolve('scripts/test-reader-incoming-media.py')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('private contact picker and multi-target selection retain exact IDs; a newer version stops old access', async t => {
  const f = await fixture(t);
  const contacts = await readSelectableContacts({ ...f, expectedAccountRef: f.binding.account.accountRef, targetWxids: ['fixture-target', 'fixture-second'] });
  assert.equal(contacts.contacts.length, 2);
  const store = new TargetSelectionStore({ root: f.root, accountRef: f.binding.account.accountRef, resolveTargets: async () => contacts.contacts });
  const initial = store.get();
  const next = await store.replace({ expectedVersion: initial.version, targetWxids: ['fixture-target', 'fixture-second'] });
  const { bindingFile, ...options } = f;
  const handle = await startTargetReader({ ...options, selectionFile: store.file });
  assert.deepEqual(handle.targets, ['fixture-target', 'fixture-second']); assert.equal(handle.selectionVersion, next.version);
  await store.replace({ expectedVersion: next.version, targetWxids: [] });
  await assert.rejects(handle.done, { code: 'READER_TARGET_SELECTION_CHANGED' });
  assert.equal(handle.signal.aborted, true);
  assert.equal(fs.existsSync(path.join(f.directory, 'service.lock')), false);
});
test('group metadata crosses the catalog protocol and starts a reader bound to the room ID',async t=>{
  const f=await fixture(t),room='fixture-room@chatroom';
  const catalog=await readSelectableContacts({...f,expectedAccountRef:f.binding.account.accountRef,targetWxids:[room]});
  assert.equal(catalog.contacts[0].kind,'group');assert.equal(catalog.contacts[0].uniqueSearchName,true);assert.equal(catalog.contacts[0].groupName,'Fixture');
  const store=new TargetSelectionStore({root:f.root,accountRef:f.binding.account.accountRef,resolveTargets:async()=>catalog.contacts});
  const selected=await store.replace({expectedVersion:store.get().version,targetWxids:[room]});
  const {bindingFile,...options}=f;const handle=await startTargetReader({...options,selectionFile:store.file});
  assert.deepEqual(handle.targets,[room]);assert.equal(handle.selectionVersion,selected.version);await handle.stop();
});
test('fresh unique private search names cross the protocol while selection retains only the stable target',async t=>{
  for(const mode of ['name-search','name-collision']){
    const f=await fixture(t,mode),target='wxid_fixture';
    const catalog=await readSelectableContacts({...f,expectedAccountRef:f.binding.account.accountRef,targetWxids:[target]});
    const contact=catalog.contacts[0];assert.equal(contact.searchName,mode==='name-search'?'Unique fixture nickname':'');
    assert.equal(contact.uniqueSearchName,mode==='name-search');assert.equal(contact.ambiguous,false);assert.equal(contact.wechatId,target);
    const store=new TargetSelectionStore({root:f.root,accountRef:f.binding.account.accountRef,resolveTargets:async()=>catalog.contacts});
    const selected=await store.replace({expectedVersion:store.get().version,targetWxids:[target]});
    assert.equal(selected.targets[0].wxid,target);assert.equal(selected.targets[0].label,'Fixture');
    assert.equal('searchName' in selected.targets[0],false);assert.equal('uniqueSearchName' in selected.targets[0],false);
  }
});
test('partial or malformed private name-search evidence is rejected at the Reader protocol',async t=>{
  for(const mode of ['name-missing-proof','name-boolean','name-trailing','name-control','name-surrogate','name-too-long','name-room','name-extra','name-unverified']){
    const f=await fixture(t,mode);
    await assert.rejects(readSelectableContacts({...f,expectedAccountRef:f.binding.account.accountRef,targetWxids:['wxid_fixture']}),{code:'READER_TARGET_PROTOCOL_INVALID'});
  }
});
